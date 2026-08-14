import { ChatBlock, ChatUsage, ToolBlock } from '../../../../shared/chat-events.js';
import {
  isAutoDenial,
  num,
  pathsFrom,
  record,
  refusalText,
  str,
  titleFor,
  toolKindFor,
} from './helpers.js';
import { translateUsage } from './usage.js';
import { AntigravityWire } from './wire.js';

/**
 * The concrete end of the chain and the only exported adapter. The wire's
 * tool, subagent and result events — and the shared turn-end bookkeeping —
 * close out what `AntigravityBase` (state and picker), `AntigravityTurn`
 * (process lifecycle) and `AntigravityWire` (message plumbing) opened.
 */
export class AntigravityChatAdapter extends AntigravityWire {
  protected onToolStep(index: number, state: string, step: Record<string, unknown>): void {
    const info = record(step.tool_info);
    const name = str(step.tool_name) || str(info.name) || 'tool';
    const parameters = record(info.parameters);
    const toolId = this.openTool(index, {
      kind: 'tool',
      toolId: '',
      name,
      ...(titleFor(name, parameters) ? { title: titleFor(name, parameters) } : {}),
      toolKind: toolKindFor(name),
      status: 'running',
      input: parameters,
      ...(pathsFrom(parameters).length ? { locations: pathsFrom(parameters) } : {}),
    });
    if (state === 'ACTIVE') {
      this.emit({ t: 'state', state: 'running' });
      return;
    }

    const durationMs = this.durationOf(step);
    const error = record(info.error);
    const message = str(error.message);

    if (state === 'ERROR' || message) {
      const detail = message || 'the tool call failed';
      const denied = isAutoDenial(detail);
      this.emit({
        t: 'tool',
        toolId,
        patch: {
          status: denied ? 'denied' : 'failed',
          error: detail,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
      if (denied) {
        // The card can say "denied"; only the transcript can say by whom, and
        // the answer — nobody — is the part that needs explaining.
        this.emit({
          t: 'permission_resolved',
          requestId: toolId,
          optionId: 'reject_once',
          allowed: false,
          automatic: true,
        });
        this.emitBlock({ kind: 'error', text: refusalText(titleFor(name, parameters) || name, detail), fatal: false });
      }
      return;
    }

    this.emit({
      t: 'tool',
      toolId,
      patch: {
        status: 'completed',
        ...(str(info.output) !== undefined ? { output: str(info.output) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    });
  }

  /**
   * Work agy handed to an agent of its own.
   *
   * `subagent_info.subagents[]` is agy's own shape, captured live:
   * `{type_name, role, initial_prompt, conversation_id, log_uri,
   * workspace_uris}`. Rendered as a tool call named `subagent` because that is
   * the name the delegation panel matches on — one vocabulary for "an agent ran
   * an agent" across every runtime, rather than a second list of tool names to
   * keep in step (see shared/agent-activity.ts).
   */
  protected onSubagentStep(index: number, state: string, step: Record<string, unknown>): void {
    const info = record(step.subagent_info);
    const entries = Array.isArray(info.subagents) ? info.subagents.map(record) : [];
    const first = entries[0] ?? {};
    const role = str(first.role);
    const prompt = str(first.initial_prompt);
    const type = str(first.type_name);

    const toolId = this.openTool(index, {
      kind: 'tool',
      toolId: '',
      name: 'subagent',
      ...(role ? { title: role } : {}),
      toolKind: 'task',
      status: 'running',
      input: { subagents: entries },
      agent: {
        steps: [],
        status: 'running',
        ...(prompt ? { prompt } : {}),
        ...(type ? { subagentType: type } : {}),
      },
    });
    if (state === 'ACTIVE') {
      this.emit({ t: 'state', state: 'running' });
      return;
    }

    const durationMs = this.durationOf(step);
    const failed = state === 'ERROR';
    this.emit({
      t: 'tool',
      toolId,
      patch: {
        status: failed ? 'failed' : 'completed',
        ...(durationMs !== undefined ? { durationMs } : {}),
        agent: {
          steps: [],
          status: failed ? 'failed' : 'completed',
          ...(prompt ? { prompt } : {}),
          ...(type ? { subagentType: type } : {}),
        },
      },
    });
  }

  /**
   * Open a card for this step if it has not been opened, and answer with its id.
   *
   * agy reports a step twice — `ACTIVE` then `DONE`/`ERROR` — but a reconnect or
   * a very fast tool can leave only the second, so the block is opened from
   * whichever report arrives first and patched by id afterwards.
   */
  private openTool(index: number, block: ToolBlock): string {
    const existing = this.toolIds.get(index);
    if (existing) return existing;
    const toolId = `agy-${this.currentTurnId ?? 't0'}-s${index}`;
    this.toolIds.set(index, toolId);
    const msgId = this.ensureMessage();
    this.emit({ t: 'block_start', msgId, index: this.blockIndex++, block: { ...block, toolId } });
    return toolId;
  }

  /** A block of this turn's own, appended after whatever is already there. */
  private emitBlock(block: ChatBlock): void {
    const msgId = this.ensureMessage();
    this.emit({ t: 'block_start', msgId, index: this.blockIndex++, block });
  }

  private durationOf(step: Record<string, unknown>): number | undefined {
    const seconds = num(step.duration_seconds);
    return seconds === undefined ? undefined : Math.round(seconds * 1000);
  }

  protected onResult(result: Record<string, unknown>): void {
    this.sawResult = true;
    const conversationId = str(result.conversation_id);
    if (conversationId) this.conversationId = conversationId;

    const status = str(result.status) || 'SUCCESS';
    const failure = str(result.error);
    if (status !== 'SUCCESS' || failure) {
      // agy's own sentence, verbatim: a bad model id answers "model zzz is not
      // recognized…" and goes on to list the ones it has, which is exactly what
      // somebody needs to fix it.
      const detail = failure || `antigravity reported ${status}`;
      this.emit({ t: 'error', message: `antigravity: ${detail}`, fatal: false });
      this.emitBlock({ kind: 'error', text: detail, fatal: false });
    }

    this.closeTurn(status === 'SUCCESS' && !failure ? 'completed' : 'failed', {
      usage: translateUsage(record(result.usage)),
      durationMs: this.durationOf(result),
      modelTurns: num(result.num_turns),
    });
  }

  protected closeTurn(
    stopReason: string,
    extra: { usage?: ChatUsage; durationMs?: number; modelTurns?: number } = {},
  ): void {
    this.turnInFlight = false;
    if (this.assistantMsgId) {
      this.emit({ t: 'msg_end', msgId: this.assistantMsgId, stopReason });
    }
    if (this.currentTurnId) {
      this.emit({
        t: 'turn_end',
        turnId: this.currentTurnId,
        stopReason,
        ...(extra.usage ? { usage: extra.usage } : {}),
        ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
        ...(extra.modelTurns !== undefined ? { modelTurns: extra.modelTurns } : {}),
        ...(this.reportedModel && extra.usage
          ? { models: [{ model: this.reportedModel, usage: extra.usage }] }
          : {}),
      });
    }
    this.currentTurnId = null;
    this.assistantMsgId = null;
    this.emit({ t: 'state', state: 'idle' });
  }
}

export default AntigravityChatAdapter;
