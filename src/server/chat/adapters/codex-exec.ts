/**
 * Codex `exec --json` one-shot-process fallback.
 *
 * Kept alongside the app-server adapter; see the original class comment below.
 */
import { BaseChatAdapter } from '../adapter.js';
import type { AdapterChild } from '../adapter.js';
import type { ChatCapabilities, UserTurn } from '../../../shared/chat-events.js';
import { blockHasContent } from '../../../shared/chat-visibility.js';
import { record, str } from './codex-utils.js';
import { itemToBlock } from './codex-mapping.js';
import type { CodexSubAgent } from './codex-subagent.js';
import { codexSubAgentToolId, subAgentActivityStatus, subAgentToolBlock } from './codex-subagent.js';
import { codexSkillInvocation, initialCodexCommands, initialCodexSkills } from './codex-launch.js';

export class CodexExecAdapter extends BaseChatAdapter {
  readonly runtime = 'codex';

  readonly capabilities: ChatCapabilities = {
    streaming: false,
    thinking: false,
    toolCalls: true,
    diffs: true,
    permissions: false,
    interrupt: false,
    resume: false,
    fork: false,
    attachments: false,
    usage: false,
    cost: false,
    plan: false,
    commands: initialCodexCommands(this.options),
  };

  private turnId: string | null = null;
  private assistantMsgId: string | null = null;
  private blockIndex = 0;
  private sawTerminalEvent = false;
  /** Coalesce the activity call ids for one child into one Agents-panel row. */
  private readonly subAgents = new Map<string, CodexSubAgent>();
  private readonly installedSkills = initialCodexSkills(this.options);

  /** "Alive" means the adapter has not been stopped, not that a child is currently running. */
  get alive(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    // No handshake exists in this mode; a turn either runs or its spawn
    // fails, and either way that surfaces from send(), not from here.
    this.emit({ t: 'session', cwd: this.runtimeWorkingDir, capabilities: this.capabilities });
    this.emit({ t: 'state', state: 'idle' });
  }

  /** Flags every turn shares; the prompt itself is appended by send(). */
  protected buildArgs(): string[] {
    // Unconditional, unlike the bypass flag on the regular (terminal-mode)
    // codex bridge: this mode has no stdin the user can answer an approval
    // prompt on, so without this a turn that hits one would simply hang
    // forever with nothing on either side able to unblock it.
    return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', ...(this.options.extraArgs || [])];
  }

  /**
   * The same condition `send()` throws on, asked in advance (#89).
   *
   * `closeTurn` runs off a stdout event, so the turn ends — and the session
   * goes idle — while this process is still exiting.
   */
  get readyForTurn(): boolean {
    return (!this.child || this.exited) && !this.childNeedsVerifiedClose();
  }

  async send(turn: UserTurn): Promise<void> {
    if ((this.child && !this.exited) || this.childNeedsVerifiedClose()) {
      // One process serves exactly one turn; the session layer is expected
      // to await each send()'s turn_end before starting the next.
      throw new Error('codex exec: a turn is already running');
    }

    const turnId = `t_${Date.now()}`;
    this.turnId = turnId;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.sawTerminalEvent = false;
    this.subAgents.clear();

    // The user's own message is not written here. `ChatSession.deliver` has
    // already put it in the transcript, with the turn id it minted and the text
    // the user actually typed — a copy from this side is a second bubble in the
    // same turn (#129), and on a branched conversation it is the briefing glued
    // in front of the prompt rather than the prompt.
    this.emit({ t: 'state', state: 'thinking' });

    // Every call is independent: nothing in the confirmed fixture shows a
    // resume syntax for this mode, so multi-turn context is a known
    // regression versus app-server -- exactly why capabilities.resume is
    // false here.
    this.spawnTurn([...this.buildArgs(), codexSkillInvocation(turn.text, this.installedSkills).text]);
  }

  private spawnTurn(args: string[]): void {
    this.exited = false;
    this.resetStdoutFraming();

    // Closed, not piped: the prompt is the last argv entry and nothing is
    // ever written here. Left as an open pipe, `codex exec` announces
    // "Reading additional input from stdin..." and waits on it forever —
    // measured at no exit after 40s with no output, against 111ms once
    // closed. The turn would simply never come back.
    const child = this.launchChild(args, ['ignore', 'pipe', 'pipe']) as AdapterChild;
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.feedStdout(chunk, 'codex exec'));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('error', (error: Error) => {
      void this.finishChild(child, async () => {
        this.emit({ t: 'error', message: `codex exec: ${error.message}`, fatal: false });
        this.closeTurn('error');
      });
    });

    child.on('exit', () => {
      void this.finishChild(child, async () => {
        if (this.stopped || this.sawTerminalEvent) return;
        const detail = this.stderrTail.trim();
        this.emit({
          t: 'error',
          message: detail ? `codex exec exited unexpectedly: ${detail}` : 'codex exec exited unexpectedly',
        });
        this.closeTurn('exited');
      });
    });
  }

  private async finishChild(
    child: AdapterChild,
    finish: () => Promise<void>,
  ): Promise<void> {
    try {
      await this.waitForVerifiedClose(child);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ t: 'error', message: `codex exec: ${message}`, fatal: true });
      return;
    }
    if (this.child !== child || this.exited) return;
    this.exited = true;
    await finish();
  }

  protected handleMessage(message: unknown): void {
    const envelope = record(message);
    const type = str(envelope.type);
    if (!type) return;

    switch (type) {
      case 'thread.started':
      case 'turn.started':
        return; // nothing to render; the user message was already emitted by send()

      case 'item.started':
        return; // see the class doc comment: rendered once, from item.completed

      case 'item.completed': {
        const item = record(envelope.item);
        const itemType = str(item.type);
        if (!itemType || itemType === 'userMessage' || itemType === 'hookPrompt') return;
        if (itemType === 'subAgentActivity') {
          this.onSubAgentActivity(item);
          return;
        }
        const block = itemToBlock(item);
        if (!block) return;
        // Exec mode reports each item once, already finished, so this is the
        // only chance to refuse one that is empty (#132) — and, being the only
        // gate, the only place where refusing too much cannot be undone later.
        // `blockHasContent` and not `blockDraws`: a blank reply is still turned
        // away, while a command, a diff or a reasoning block is written down
        // whether or not it would earn a row of its own.
        if (!blockHasContent(block)) return;
        if (!this.assistantMsgId) {
          this.assistantMsgId = `a_${this.turnId}`;
          this.emit({ t: 'msg_start', id: this.assistantMsgId, role: 'assistant', turnId: this.turnId || '' });
        }
        this.emit({ t: 'block_start', msgId: this.assistantMsgId, index: this.blockIndex++, block });
        return;
      }

      case 'turn.completed':
        this.closeTurn('completed');
        return;

      case 'turn.failed': {
        const error = record(envelope.error);
        this.emit({ t: 'error', message: str(error.message) || 'codex turn failed', fatal: false });
        this.closeTurn('failed');
        return;
      }

      case 'error':
        this.emit({ t: 'error', message: str(envelope.message) || 'codex reported an error', fatal: false });
        return;

      default:
        // Every event type this adapter has not seen -- exec's schema is
        // reconstructed from the app-server bindings, not from a fixture
        // covering the full set (see the class doc comment).
        return;
    }
  }

  /**
   * Exec has no child-thread stream, but it may still report several activity
   * items for one child. Open that child once and patch its stable thread id;
   * otherwise the panel keeps the first stale row when an interrupt follows.
   */
  private onSubAgentActivity(item: Record<string, unknown>): void {
    const threadId = str(item.agentThreadId);
    if (!threadId) return;

    const kind = str(item.kind) || '';
    const path = str(item.agentPath) || '';
    const reported = subAgentActivityStatus(kind);
    let agent = this.subAgents.get(threadId);
    if (!agent) {
      agent = {
        threadId,
        toolId: codexSubAgentToolId(threadId),
        path,
        status: reported || 'running',
        announced: true,
        toolUses: 0,
        stepIds: new Set<string>(),
      };
      this.subAgents.set(threadId, agent);
      if (!this.assistantMsgId) {
        this.assistantMsgId = `a_${this.turnId}`;
        this.emit({ t: 'msg_start', id: this.assistantMsgId, role: 'assistant', turnId: this.turnId || '' });
      }
      // No AgentRun here: exec cannot hear the child complete, so turn_end is
      // allowed to settle an otherwise-open activity as unknown.
      this.emit({
        t: 'block_start',
        msgId: this.assistantMsgId,
        index: this.blockIndex++,
        block: subAgentToolBlock(agent, false),
      });
    } else {
      if (path) agent.path = path;
      if (reported) agent.status = reported;
    }

    const input = {
      name: agent.path || 'Codex agent',
      agentThreadId: threadId,
      activityId: str(item.id),
    };
    this.emit({
      t: 'tool',
      toolId: agent.toolId,
      patch: {
        input,
        ...(reported ? { status: reported } : {}),
      },
    });
  }

  private closeTurn(stopReason: string): void {
    this.sawTerminalEvent = true;
    if (this.assistantMsgId) {
      this.emit({ t: 'msg_end', msgId: this.assistantMsgId, stopReason });
    }
    if (this.turnId) {
      this.emit({ t: 'turn_end', turnId: this.turnId, stopReason });
    }
    this.turnId = null;
    this.assistantMsgId = null;
    this.emit({ t: 'state', state: 'idle' });
  }

  async interrupt(): Promise<void> {
    // No cancel channel exists in this mode (capabilities.interrupt is
    // false); killing the in-flight process is the only lever available if
    // something calls this anyway.
    const child = this.child;
    if (child && this.childNeedsVerifiedClose(child)) {
      await this.terminateChild(child, 'SIGTERM');
    }
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // Nothing is ever pending here: capabilities.permissions is false.
  }
}


