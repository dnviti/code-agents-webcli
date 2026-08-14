import { num, record, str } from './helpers.js';
import { AntigravityTurn } from './turn.js';

/**
 * The third link of `AntigravityChatAdapter`: reading the wire. `handleMessage`
 * is fed one line-delimited JSON envelope at a time by the stdout framing in
 * `BaseChatAdapter` and dispatched to the per-event handlers that live here or
 * in the concrete leaf. This link owns the message plumbing — opening the
 * assistant message and its text/thinking blocks.
 */
export abstract class AntigravityWire extends AntigravityTurn {
  /** The wire's tool, subagent and result events, implemented in the leaf. */
  protected abstract onToolStep(
    index: number,
    state: string,
    step: Record<string, unknown>,
  ): void;
  protected abstract onSubagentStep(
    index: number,
    state: string,
    step: Record<string, unknown>,
  ): void;
  protected abstract onResult(result: Record<string, unknown>): void;

  protected handleMessage(raw: unknown): void {
    const envelope = record(raw);
    switch (str(envelope.event)) {
      case 'init':
        this.onInit(record(envelope.init), str(envelope.conversation_id));
        return;
      case 'step_update':
        this.onStep(record(envelope.step_update));
        return;
      case 'result':
        this.onResult(record(envelope.result));
        return;
      default:
        // An envelope this adapter has not seen. Dropping is correct; throwing
        // would take the turn down over a line nobody needed.
        return;
    }
  }

  private onInit(init: Record<string, unknown>, conversationId: string | undefined): void {
    if (conversationId) this.conversationId = conversationId;
    // Present only when `--model` was passed: a run with no model flag reports
    // no model at all, so this is agy confirming what it was given rather than
    // naming the default it picked.
    this.reportedModel = str(init.model) ?? this.reportedModel;

    if (this.sessionAnnounced) return;
    this.sessionAnnounced = true;
    // A second `session` line, and the one that matters: it carries the id the
    // conversation is resumed by, which is the only thing that lets this
    // conversation come back with its history after the server restarts.
    this.emit({
      t: 'session',
      ...(this.conversationId ? { nativeSessionId: this.conversationId } : {}),
      ...(this.reportedModel ? { model: this.reportedModel } : {}),
      cwd: str(init.cwd) || this.runtimeWorkingDir,
      capabilities: this.capabilities,
    });
  }

  private onStep(step: Record<string, unknown>): void {
    const index = num(step.step_index);
    if (index === undefined) return;
    const state = str(step.state) || '';
    const type = str(step.step_type) || '';

    switch (type) {
      case 'agent_response':
        this.onAgentResponse(index, step);
        return;
      case 'tool':
        this.onToolStep(index, state, step);
        return;
      case 'subagent':
        this.onSubagentStep(index, state, step);
        return;
      case 'checkpoint':
        // agy's own bookkeeping between steps. It carries a handful of tokens,
        // which `result.usage` already includes, and nothing to render.
        return;
      case 'user_input':
      case 'system_message':
      case 'unknown':
        // `user_input` is the prompt the session already wrote down;
        // `system_message` and `unknown` arrive with no payload at all — no
        // text, no tool, no usage — so there is nothing to draw for them.
        return;
      default:
        return;
    }
  }

  /** The assistant message this turn's blocks hang off, opened on first need. */
  protected ensureMessage(): string {
    if (this.assistantMsgId) return this.assistantMsgId;
    this.assistantMsgId = `a_${this.currentTurnId ?? `t${this.turnCounter}`}`;
    this.emit({
      t: 'msg_start',
      id: this.assistantMsgId,
      role: 'assistant',
      turnId: this.currentTurnId ?? `t${this.turnCounter}`,
      ...(this.reportedModel ? { model: this.reportedModel } : {}),
    });
    return this.assistantMsgId;
  }

  private onAgentResponse(index: number, step: Record<string, unknown>): void {
    const usage = record(step.usage);
    const thinking = num(usage.thinking_tokens) ?? 0;
    if (thinking > 0) this.addThinking(thinking);

    const delta = str(step.text_delta);
    if (!delta) return;

    const msgId = this.ensureMessage();
    let block = this.textBlocks.get(index);
    if (block === undefined) {
      block = this.blockIndex++;
      this.textBlocks.set(index, block);
      this.emit({ t: 'block_start', msgId, index: block, block: { kind: 'text', text: '' } });
    }
    // A true append: the `ACTIVE` half and the `DONE` half of one step
    // concatenate into `result.response`. See property 2 in the class comment.
    this.emit({ t: 'block_delta', msgId, index: block, text: delta });
  }

  /**
   * Record that the model thought, and how much, since agy will not say what.
   *
   * One block per message rather than one per step: the size is the only thing
   * on offer, and half a dozen entries each reading "~318 tokens" is a worse
   * account of one turn's reasoning than a single running total. `block_delta`
   * carries `tokens` for exactly this.
   */
  private addThinking(tokens: number): void {
    const msgId = this.ensureMessage();
    if (this.thinkingBlock === null) {
      this.thinkingBlock = this.blockIndex++;
      this.emit({
        t: 'block_start',
        msgId,
        index: this.thinkingBlock,
        block: { kind: 'thinking', text: '', tokens },
      });
      return;
    }
    this.emit({ t: 'block_delta', msgId, index: this.thinkingBlock, tokens });
  }
}
