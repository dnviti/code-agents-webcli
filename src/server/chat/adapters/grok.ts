// Processes are launched through BaseChatAdapter.launchChild, which decides
// between this host and the owner's container.
import {
  ChatBlock,
  ChatCapabilities,
  ChatUsage,
  UserTurn,
} from '../../../shared/chat-events.js';
import { AdapterEvent, BaseChatAdapter, ChatAdapterOptions } from '../adapter.js';

/**
 * Grok Build headless mode (`grok -p <prompt> --output-format streaming-json`).
 *
 * CONFIRMED, from the CLI's own shipped docs (~/.grok/docs/user-guide/14-headless-mode.md)
 * and from live invocations against the installed binary (probe hit the account's rate
 * limit, but that is itself a real `error` event, captured below):
 *   - Event types `text`, `thought`, `end`, `error` and their field names.
 *   - Headless mode is one-shot: a `-p <prompt>` invocation runs exactly one turn and the
 *     process exits. Confirmed by running `grok --output-format streaming-json` with no
 *     prompt and non-tty stdin: it does not idle waiting for input, it errors trying to
 *     open a terminal. The docs independently confirm "Headless mode does not read piped
 *     stdin into the prompt."
 *   - `-r/--resume <ID>` continues a session across separate invocations; `end` returns
 *     the `sessionId` to resume with.
 *   - SIGINT/SIGTERM produce documented exit codes (130/143) and Grok saves state up to
 *     the last completed tool call, which is the only confirmed cancel channel.
 *
 * NOT CONFIRMED — a later probe with working quota should re-check these:
 *   - Any tool-call event. The streaming-json table in the docs lists only
 *     text/thought/end/error; it does not document how (or whether) tool execution is
 *     surfaced in this format, unlike Grok's separate ACP-style `agent stdio` protocol
 *     (`tool_call`/`tool_call_update`, see 15-agent-mode.md) which is a different
 *     subsystem entirely. Reusing those names here would be guessing, so `toolCalls` is
 *     false and no tool block is ever produced by this adapter.
 *   - The payload shape of `max_turns_reached` and the `auto_compact_*` family: the docs
 *     name them as existing ("Grok may also emit...") but give no example line for either.
 *   - Whether `-p`/`--prompt-json` can carry attachments in headless mode.
 *
 * ARCHITECTURAL CONSEQUENCE: BaseChatAdapter assumes one long-lived child that a session
 * feeds turns over stdin. Grok's headless mode cannot do that (see above), so this adapter
 * spawns a fresh child per turn instead of using the single spawn in `start()`. `start()`
 * is overridden to do nothing but announce the session; `buildArgs()` still exists (it is
 * abstract) and returns the flags every turn shares, with `-p`/`--resume` appended by
 * `send()` for the turn currently running.
 */
export class GrokChatAdapter extends BaseChatAdapter {
  readonly runtime = 'grok';

  readonly capabilities: ChatCapabilities = {
    streaming: true, // confirmed: `text`/`thought` arrive as incremental chunks
    thinking: true, // confirmed: dedicated `thought` event type
    toolCalls: false, // not confirmed for this wire format -- see class doc comment
    diffs: false, // no diff structure documented anywhere in streaming-json
    permissions: false, // headless is bypass-or-not (`--always-approve`); no approval event exists
    interrupt: true, // confirmed: SIGINT/SIGTERM have documented exit codes and save state
    resume: true, // confirmed: `-r/--resume <ID>` plus the `sessionId` `end` returns for it
    fork: false, // `--fork-session` forks a whole session id, not a point in this transcript
    attachments: false, // no evidence `-p` accepts anything but plain text
    usage: true, // confirmed: `end` carries `usage`/`num_turns`
    cost: true, // confirmed: `end` carries `total_cost_usd` (absent when the server reports partial cost)
    plan: false, // no plan/todo event documented for this format
  };

  /** Learned from the first `end`, or seeded from a prior log; feeds the next `--resume`. */
  private nativeSessionId?: string;
  private currentModel?: string;

  private turnCounter = 0;
  private turnId: string | null = null;
  private msgId: string | null = null;
  private blockIndex = 0;
  private openBlockKind: 'text' | 'thinking' | null = null;
  private messageStarted = false;
  /** Set by a JSON `end` or `error` line, so a following process exit is not misreported. */
  private sawTerminalEvent = false;

  constructor(options: ChatAdapterOptions) {
    super(options);
    this.nativeSessionId = options.resumeSessionId;
    this.currentModel = options.model;
  }

  /**
   * "Alive" here means the session has not been torn down, not that a child is
   * currently running -- between turns there usually isn't one, which is normal for
   * this runtime rather than a crash. Overrides BaseChatAdapter's child-presence check.
   */
  get alive(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    // No handshake and nothing to spawn yet: the first process only exists once a user
    // turn gives it something to run (see the class doc comment on the per-turn spawn).
    this.emit({
      t: 'session',
      nativeSessionId: this.nativeSessionId,
      model: this.currentModel,
      cwd: this.options.workingDir,
      capabilities: this.capabilities,
    });
    this.emit({ t: 'state', state: 'idle' });
  }

  /** Flags every turn shares. Turn-specific `-p`/`--resume` are appended in `send`. */
  protected buildArgs(): string[] {
    const args = ['--output-format', 'streaming-json'];
    if (this.options.bypassPermissions) args.push('--always-approve');
    if (this.currentModel) args.push('--model', this.currentModel);
    args.push(...(this.options.extraArgs || []));
    return args;
  }

  async send(turn: UserTurn): Promise<void> {
    if (this.stopped) {
      throw new Error('grok adapter: session already stopped');
    }
    if (this.child && !this.exited) {
      // One process serves exactly one turn; a second turn while one is still running
      // would race both on stdout framing and on which reply belongs to which prompt.
      // The session layer is expected to await each `send()`'s `turn_end` before the next.
      throw new Error('grok adapter: a turn is already in flight');
    }

    this.turnCounter += 1;
    this.turnId = `t${this.turnCounter}`;
    this.msgId = `m${this.turnCounter}`;
    this.blockIndex = 0;
    this.openBlockKind = null;
    this.messageStarted = false;
    this.sawTerminalEvent = false;

    // turn.attachments has no home here: nothing in --help or the docs documents an
    // attachment channel for headless `-p`, matching capabilities.attachments = false.
    const args = [
      ...this.buildArgs(),
      '-p',
      turn.text,
      ...(this.nativeSessionId ? ['--resume', this.nativeSessionId] : []),
    ];

    this.spawnTurn(args);
    // Adapter-owned bookkeeping, not something the CLI reports: 'running' while a turn's
    // process is alive, 'idle' again once closeTurn() fires below.
    this.emit({ t: 'state', state: 'running' });
  }

  private spawnTurn(args: string[]): void {
    this.exited = false;
    this.stdoutBuffer = '';

    const child = this.launchChild(args, ['pipe', 'pipe', 'pipe']);
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onTurnStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('error', (error: Error) => {
      this.exited = true;
      this.child = null;
      this.emit({ t: 'error', message: `grok: ${error.message}`, fatal: true });
      this.emit({ t: 'state', state: 'error' });
    });

    child.on('exit', () => {
      this.exited = true;
      this.child = null;
      if (this.stopped || this.sawTerminalEvent) return;
      // Exited without an `end` or `error` line -- a crash, an auth failure before the
      // model was ever reached, or similar. Non-fatal: the adapter is still usable for
      // the next turn, unlike a fatal spawn error above.
      const detail = this.stderrTail.trim();
      this.emit({
        t: 'error',
        message: detail ? `grok exited unexpectedly: ${detail}` : 'grok exited unexpectedly',
      });
      this.closeTurn('exited');
    });
  }

  /**
   * Duplicates BaseChatAdapter's private onStdout line-framing rather than reusing it:
   * that method is wired to the single child from start(), which this adapter never
   * spawns (see the class doc comment), so there is nothing to call into.
   */
  private onTurnStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // grok can print non-protocol lines (update notices etc.) even in streaming-json
        // mode; dropping what does not parse is correct, not an error worth surfacing.
        continue;
      }

      try {
        this.handleMessage(parsed);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `grok adapter failed to handle a message: ${message}` });
      }
    }

    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.emit({ t: 'error', message: 'grok sent an oversized line; discarded the buffer' });
    }
  }

  protected handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const data = message as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : undefined;
    if (!type) return;

    switch (type) {
      case 'text': {
        const chunk = typeof data.data === 'string' ? data.data : '';
        if (!chunk) return;
        this.ensureMessageStarted();
        this.appendToBlock('text', chunk);
        return;
      }

      case 'thought': {
        const chunk = typeof data.data === 'string' ? data.data : '';
        if (!chunk) return;
        this.ensureMessageStarted();
        this.appendToBlock('thinking', chunk);
        return;
      }

      case 'end': {
        const stopReason = typeof data.stopReason === 'string' ? data.stopReason : undefined;
        const usage = this.mapUsage(data);
        if (this.messageStarted) {
          this.emit({ t: 'msg_end', msgId: this.msgId as string, stopReason, usage });
        }
        if (typeof data.sessionId === 'string') {
          // Learned only once a turn completes; kept for the *next* spawn's --resume,
          // not re-broadcast as a ChatEvent (the 'session' event fires once, at start,
          // before this is known).
          this.nativeSessionId = data.sessionId;
        }
        this.closeTurn(stopReason, usage);
        return;
      }

      case 'error': {
        const msg = typeof data.message === 'string' ? data.message : 'grok reported an error';
        this.emit({ t: 'error', message: msg, fatal: false });
        // Confirmed live (rate-limit probe): an `error` line is terminal -- the process
        // exits right after with no `end` line, so close the turn now rather than wait
        // for one that will not arrive.
        this.closeTurn('error');
        return;
      }

      case 'max_turns_reached': {
        // Name confirmed by the docs; no example payload was ever shown for it, so this
        // is treated as a bare turn-ending signal rather than a guess at extra fields.
        this.emit({ t: 'error', message: 'grok stopped: maximum turns reached', fatal: false });
        this.closeTurn('max_turns_reached');
        return;
      }

      default:
        // Covers the documented-but-unshaped `auto_compact_*` family and anything else
        // a newer CLI adds: named as existing by the docs, never given a payload shape,
        // so it is dropped rather than guessed at. Never throws either way.
        return;
    }
  }

  private ensureMessageStarted(): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.emit({
      t: 'msg_start',
      id: this.msgId as string,
      role: 'assistant',
      turnId: this.turnId as string,
      model: this.currentModel,
    });
  }

  private appendToBlock(kind: 'text' | 'thinking', text: string): void {
    if (this.openBlockKind !== kind) {
      // Switching kind (or the very first block): advance the index. block_end is
      // optional in the contract, so the previous block is simply left as last written.
      if (this.openBlockKind !== null) this.blockIndex += 1;
      this.openBlockKind = kind;
      const block: ChatBlock = kind === 'text' ? { kind: 'text', text: '' } : { kind: 'thinking', text: '' };
      this.emit({ t: 'block_start', msgId: this.msgId as string, index: this.blockIndex, block });
    }
    this.emit({ t: 'block_delta', msgId: this.msgId as string, index: this.blockIndex, text });
  }

  private mapUsage(data: Record<string, unknown>): ChatUsage | undefined {
    const raw = data.usage as Record<string, unknown> | undefined;
    const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
    if (!raw && typeof data.total_cost_usd !== 'number') return undefined;
    return {
      inputTokens: num(raw?.input_tokens),
      outputTokens: num(raw?.output_tokens),
      cacheReadTokens: num(raw?.cache_read_input_tokens),
      reasoningTokens: num(raw?.reasoning_tokens),
      totalTokens: num(raw?.total_tokens),
      costUsd: num(data.total_cost_usd),
    };
  }

  private closeTurn(stopReason?: string, usage?: ChatUsage): void {
    this.sawTerminalEvent = true;
    if (this.turnId) {
      this.emit({ t: 'turn_end', turnId: this.turnId, stopReason, usage });
    }
    this.turnId = null;
    this.msgId = null;
    this.emit({ t: 'state', state: 'idle' });
  }

  async interrupt(): Promise<void> {
    // No cancel message exists in this protocol; SIGINT is the only confirmed channel
    // (the docs give its exit code, 130, and say state is saved up to the last completed
    // tool call). The `exit` handler in spawnTurn takes it from there.
    if (this.child && !this.exited) {
      this.child.kill('SIGINT');
    }
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // No approval channel exists in this protocol (capabilities.permissions is false
    // above), so there is never a pending request for this to answer.
  }

  async setModel(model: string): Promise<void> {
    // Model is a per-invocation flag (`-m/--model`), not a mid-session control message,
    // so "switching" just changes what the next spawned turn uses.
    this.currentModel = model;
  }
}

export default GrokChatAdapter;

// Re-exported so tests can construct AdapterEvent-shaped fixtures without reaching into
// the adapter module's internals.
export type { AdapterEvent };
