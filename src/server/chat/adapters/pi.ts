import { spawn } from 'child_process';
import { AdapterChild, BaseChatAdapter } from '../adapter.js';
import {
  ChatCapabilities,
  ChatUsage,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  TurnModelUsage,
  UserTurn,
  classifyTool,
  mergeUsage,
  rankedEfforts,
} from '../../../shared/chat-events.js';

/**
 * pi's session-event protocol (`--mode json`).
 *
 * Two things make this adapter shaped differently from the other three:
 *
 * 1. `--mode json -p <prompt>` is one-shot: pi processes exactly one prompt
 *    and exits. There is no persistent stdio pipe to hold a session open and
 *    write a second turn into it (checked against `pi --help`; no such flag
 *    exists — `--mode rpc` is undocumented beyond its name and untested here,
 *    so it is not used). Multi-turn is implemented by respawning pi once per
 *    `send()`, passing `--session-id` so pi resumes its own on-disk session
 *    and keeps the conversation pi itself is tracking. This means `start()`
 *    launches nothing — there is nothing to launch without a prompt — and
 *    every `send()` spawns and tears down its own child, which is why this
 *    class does not use `buildArgs()`/`start()` the way the base class
 *    expects a persistent-process adapter to.
 *
 * 2. pi's `message_update` events carry the *cumulative* content of the
 *    message so far, not a delta — the `assistantMessageEvent.delta` field
 *    that looks like one is not reliable (observed empty while the
 *    cumulative content it supposedly describes had in fact grown, and
 *    observed repeated on a line where the cumulative content had not grown
 *    at all). Every block below is therefore driven by diffing the
 *    cumulative string against the length already emitted, never by
 *    forwarding `delta` verbatim. Re-sending the cumulative text as if it
 *    were new would both duplicate the transcript and make the UI re-render
 *    the whole message on every token.
 *
 * A single `-p` invocation can itself contain several of pi's own
 * `turn_start`/`turn_end` pairs — one per model round-trip needed to resolve
 * one prompt (e.g. a tool-using turn followed by the turn that reads the
 * result and answers). Those are an implementation detail of pi's own agent
 * loop, not something the user asked for separately, so they are not surfaced
 * as separate ChatEvent turns: everything from one `send()` shares one turnId,
 * closed out by `agent_settled` — the one signal that fires exactly once per
 * invocation, once pi has nothing left to do.
 */
export class PiChatAdapter extends BaseChatAdapter {
  readonly runtime = 'pi';

  readonly capabilities: ChatCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    // No structured diff has been observed from a tool result; pi's `edit`
    // and `write` tools return prose, not a hunk list.
    diffs: false,
    // No approval channel found in --help or the fixture: pi's --approve
    // trusts project-local extension/skill files for the run, it does not
    // gate individual tool calls.
    permissions: false,
    interrupt: true,
    // `--session-id <id>` (creating it if missing) is exactly a resume handle.
    resume: true,
    // `--fork <path|id>` forks a whole session, not a point within one; the
    // `fork(atMessageId)` contract asks for the latter, which this CLI has no
    // flag for, so the capability stays honest rather than approximate.
    fork: false,
    // `pi @file "prompt"` attaches files by path, which is exactly the shape
    // ChatAttachment.path exists for.
    attachments: true,
    usage: true,
    cost: true,
    // No plan/todo tool in pi's built-in tool list (read, bash, edit, write,
    // grep, find, ls).
    plan: false,
    // pi's thinking ladder, in the order its own `--help` prints it:
    // `--thinking <level>   Set thinking level: off, minimal, low, medium,
    // high, xhigh, max`. That order is the ranking, so `rankedEfforts` spaces
    // the seven evenly from `off` at 0 to `max` at 1.
    //
    // Confirmed a second time, and more strongly, by handing pi a level it does
    // not have: `--thinking bogus_xyz` put `Warning: Invalid thinking level
    // "bogus_xyz". Valid values: off, minimal, low, medium, high, xhigh, max`
    // on stderr. That is pi enumerating its own vocabulary while refusing a
    // word — the set it will actually accept, rather than the set someone wrote
    // down once and may not have kept up with.
    //
    // Getting the spelling exactly right matters more than it looks, because
    // that message is only a *warning*: pi carried on and answered the prompt
    // at its default level. A level this app gets wrong does not fail loudly,
    // it quietly thinks at an amount nobody chose while the UI reports the
    // level as live. Nothing outside this list ever reaches the command line
    // (see `knownLevel`).
    //
    // `off` is one of the seven, not a way of spelling "no override". Asking pi
    // for `off` is asking it not to think, which is a decision someone made;
    // leaving the level alone entirely is a different thing, and the control's
    // own "use the runtime default" row is where that one lives.
    efforts: rankedEfforts([
      { value: 'off', name: 'Off', description: 'No thinking at all — a level in its own right.' },
      { value: 'minimal', name: 'Minimal', description: 'The least that is still thinking.' },
      { value: 'low', name: 'Low', description: 'A little, for work that barely needs it.' },
      { value: 'medium', name: 'Medium', description: 'The middle of the seven.' },
      { value: 'high', name: 'High', description: 'Enough for work with steps in it.' },
      { value: 'xhigh', name: 'Extra high', description: 'Past high, short of the ceiling.' },
      { value: 'max', name: 'Max', description: 'Everything pi will spend on thinking.' },
    ]),
  };

  private turnCounter = 0;
  private msgCounter = 0;
  private turnInFlight = false;
  private turnInterrupted = false;
  private currentTurnId: string | null = null;
  private currentTurnUsage: ChatUsage = {};
  private nativeSessionId: string | undefined;
  private sessionEventEmitted = false;
  private currentAssistantMsgId: string | null = null;
  private blockState: BlockTrack[] | null = null;
  private readonly toolStartedAt = new Map<string, number>();
  /**
   * What each model did this turn, accumulated from the messages themselves.
   *
   * pi has no `modelUsage` summary the way claude and grok do — but it names
   * the model on every assistant message and carries that message's own usage
   * beside it, which is the same fact arriving in instalments. One turn can
   * hold several messages, and pi will switch model between them (a fallback
   * after a provider error is the case seen in practice), so this is a map
   * rather than a field.
   */
  private readonly turnModels = new Map<string, { calls: number; usage: ChatUsage }>();
  /** The last model pi said it used, for the session line. Never the requested one. */
  private reportedModel: string | undefined;
  /**
   * The thinking level every future spawn is launched at.
   *
   * Seeded from the launch option and then owned here, rather than written back
   * into `this.options.effort`, for two reasons. `options` is the caller's
   * object — the session built it and still reads it to decide what a relaunch
   * would look like — so mutating it would quietly rewrite the request the
   * session believes it made. And keeping the two apart preserves a distinction
   * the rest of this class is careful about: `options.effort` is what this
   * conversation was started with, this is what the next `pi` will actually be
   * handed. `buildArgs()` reads this one.
   *
   * Seeded through the same membership check `setEffort` uses, so a launch
   * option pi has no such level for is dropped here rather than reported as
   * running. Declared after `capabilities` because it reads that list; class
   * fields initialise top to bottom.
   */
  private effort: string | undefined = this.knownLevel(this.options.effort);

  /** The adapter stays usable across turns even with no child running between them. */
  override get alive(): boolean {
    return !this.stopped;
  }

  /**
   * This turn's models, or nothing at all if pi named none.
   *
   * Spread into the event rather than assigned, so a turn pi named no model
   * for carries no `models` key at all — an explicit `undefined` is a
   * different object to anything comparing events, and these are compared.
   *
   * Nothing rather than an empty list, and never the requested model: a turn
   * that died before pi produced a message reached no model that anybody can
   * name, and `--model` is a request this app made, not an observation it took.
   */
  private reportedTurnModels(): { models?: TurnModelUsage[] } {
    if (this.turnModels.size === 0) return {};
    return {
      models: [...this.turnModels].map(([model, seen]) => ({
        model,
        calls: seen.calls,
        ...(Object.keys(seen.usage).length > 0 ? { usage: seen.usage } : {}),
      })),
    };
  }

  /**
   * Static flags shared by every invocation. Not called by the base class
   * (see the class comment) — `send()` calls it directly to build one turn's
   * full argv.
   */
  protected buildArgs(): string[] {
    const args = ['--mode', 'json'];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.effort) {
      // The whole of the effort mechanism, for this runtime. One turn is one
      // process (see the class comment) and this builder runs fresh inside
      // every `send()`, so a level changed between turns is simply on the
      // command line of the next child: nothing to restart, no protocol to
      // speak, and no running pi to be out of step with.
      //
      // Never a value this app invented: an unrecognised level does not fail
      // the turn, it warns on stderr and runs at pi's default (the capture is
      // quoted beside `capabilities.efforts`), so a wrong word here reads to
      // the user as a level that is live and is not. Both ways in — the launch
      // option and `setEffort` — go through `knownLevel` first.
      args.push('--thinking', this.effort);
    }
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }
    return args;
  }

  async start(): Promise<void> {
    if (this.options.resumeSessionId) {
      this.nativeSessionId = this.options.resumeSessionId;
      this.sessionEventEmitted = true;
      this.emit({
        t: 'session',
        // Deliberately not `options.model`: resuming a session says nothing
        // about which model answered in it, and the flag is only a request.
        // pi names the model on its first message and the turn's report
        // confirms it; until then the conversation shows none.
        model: this.reportedModel,
        nativeSessionId: this.nativeSessionId,
        cwd: this.options.workingDir,
        capabilities: this.capabilities,
      });
    }
    // The level the next turn will spawn at — and, unlike the model just above,
    // this genuinely is the flag we are about to pass rather than something pi
    // said. The difference is worth being blunt about. The `session` event
    // reports `reportedModel` because pi names its model on every message, so
    // there a request and an observation are two separate facts and only the
    // second is worth showing. Thinking has no second fact: pi never names its
    // level on the wire — not on the `session` line, not on a message, not in
    // the usage — so the argv is the only place the level exists at all.
    // Reporting it is reporting the one thing anybody knows, not dressing a
    // request up as an answer.
    //
    // What makes that safe enough to show is that nothing off pi's own ladder
    // ever reaches the command line (`knownLevel` gates both ways in), so the
    // one way this could be a lie — pi warning about an unknown level and
    // running at its default — cannot arise.
    //
    // Emitted whether or not there is a session to resume: the level belongs to
    // the next spawn rather than to the session being resumed, and pi's own
    // `session` line carries nothing about thinking to hang it off instead.
    this.emit({ t: 'effort', effort: this.effort ?? null });
    this.emit({ t: 'state', state: 'idle' });
  }

  /**
   * The level, when pi is known to have one by that name.
   *
   * Membership is checked against `capabilities.efforts`, which is the set pi
   * itself named while refusing a bad value, so this answers the question with
   * pi's own vocabulary rather than a second copy of the ladder kept in step by
   * hand. Anything else comes back as nothing, because the alternative is
   * passing a word pi warns about and then ignores — thinking at a level nobody
   * chose while the app displays one it never got.
   */
  private knownLevel(effort: string | undefined): string | undefined {
    if (!effort) return undefined;
    return this.capabilities.efforts?.some((level) => level.value === effort) ? effort : undefined;
  }

  /**
   * Switch thinking level, which for a spawn-per-turn adapter costs nothing.
   *
   * There is no live process to convince. `buildArgs()` runs inside every
   * `send()`, so setting the field *is* the change: the next pi is spawned with
   * `--thinking <level>` and starts there, with no relaunch, no protocol
   * message and nothing to acknowledge. That is why this resolves at once and
   * still honours what the contract asks of it — resolving means the runtime
   * took the level, and the only window in which pi has not taken it is the
   * window in which no pi is running. A turn already in flight keeps the level
   * it was spawned with, which is the only thing it could do.
   *
   * The event is emitted here because nothing else ever will: no later line of
   * pi's output mentions the level (see `start()`), so a caller waiting for the
   * runtime to confirm would wait for the life of the session.
   *
   * A level pi does not have is rejected rather than stored, and it has to be:
   * accepting one would put a `--thinking` pi warns about and ignores on the
   * next command line while this event told the user it was live. The caller's
   * failure path — reporting that the level could not be switched — is a far
   * better outcome than a chip that quietly means nothing.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.knownLevel(effort)) {
      throw new Error(`pi: no thinking level called "${effort}"`);
    }
    this.effort = effort;
    this.emit({ t: 'effort', effort });
  }

  /**
   * The same condition `send()` throws on, asked in advance (#89).
   *
   * `turnInFlight` is cleared by the child's `exit`, but the turn is declared
   * over by `onAgentSettled` — a line of stdout that arrives first.
   */
  get readyForTurn(): boolean {
    return !this.turnInFlight;
  }

  async send(turn: UserTurn): Promise<void> {
    if (this.stopped) {
      throw new Error('pi chat adapter is stopped');
    }
    if (this.turnInFlight) {
      throw new Error('pi: a turn is already running on this session');
    }

    this.turnInFlight = true;
    this.turnInterrupted = false;
    this.currentTurnId = `t${++this.turnCounter}`;
    this.currentTurnUsage = {};
    this.turnModels.clear();
    this.emit({ t: 'state', state: 'running' });

    const args = this.buildTurnArgs(turn);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: this.options.workingDir,
        env: {
          ...process.env,
          ...(this.options.env || {}),
          // Same reasoning as the base class: no TUI, no ANSI in the stream.
          NO_COLOR: '1',
          TERM: 'dumb',
          FORCE_COLOR: '0',
        },
        // stdin is closed, not piped. The prompt arrives in argv via `-p`, so
        // nothing is ever written here — and pi waits on stdin when it is a
        // pipe that stays open, producing no output at all and never exiting.
        // Measured: an open empty stdin yields 0 bytes and no exit; 'ignore'
        // completes the same prompt in ~8s. A turn that never answers is
        // exactly what this looked like from the browser.
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as AdapterChild;

      this.child = child;
      this.exited = false;
      this.stdoutBuffer = '';
      this.stderrTail = '';

      let settled = false;
      const accept = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.feedStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      });

      // "Accepted" for a spawn-per-turn adapter means the process actually
      // started, not that pi replied — matching what `send()` promises.
      child.on('spawn', accept);

      child.on('error', (error: Error) => {
        this.exited = true;
        this.turnInFlight = false;
        this.emit({ t: 'error', message: `pi: ${error.message}` });
        this.emit({ t: 'state', state: 'idle' });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on('exit', (code, signal) => this.onTurnExit(code, signal));
    });
  }

  async interrupt(): Promise<void> {
    if (!this.child || this.exited) return;
    // pi's one-shot process has no cancel message; killing it is the only
    // way to stop mid-turn, and it ends only this turn — the session stays
    // usable for the next send(), which spawns a fresh process.
    this.turnInterrupted = true;
    this.child.kill('SIGINT');
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // capabilities.permissions is false: nothing is ever pending to answer.
  }

  private onTurnExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.turnInFlight = false;

    if (this.stopped) {
      this.emit({ t: 'state', state: 'exited' });
      return;
    }

    if (this.turnInterrupted) {
      if (this.currentTurnId) {
        this.emit({
          t: 'turn_end',
          turnId: this.currentTurnId,
          stopReason: 'interrupted',
          usage: this.currentTurnUsage,
        });
      }
      this.currentTurnId = null;
      this.emit({ t: 'state', state: 'idle' });
      return;
    }

    // currentTurnId is cleared by onAgentSettled on a normal completion, so
    // still being set here means the process went away before pi told us it
    // was done — a crash, not a finished turn.
    if (this.currentTurnId) {
      const detail = this.stderrTail.trim();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.emit({
        t: 'error',
        message: detail ? `pi exited (${how}): ${detail}` : `pi exited (${how})`,
      });
      this.emit({
        t: 'turn_end',
        turnId: this.currentTurnId,
        stopReason: 'error',
        usage: this.currentTurnUsage,
        ...this.reportedTurnModels(),
      });
      this.currentTurnId = null;
      this.emit({ t: 'state', state: 'idle' });
    }
  }

  private buildTurnArgs(turn: UserTurn): string[] {
    const args = this.buildArgs();
    if (this.nativeSessionId) {
      // Second and later turns: pin pi to the session it already opened so
      // it resumes its own history instead of starting fresh each respawn.
      args.push('--session-id', this.nativeSessionId);
    }
    for (const attachment of turn.attachments || []) {
      if (attachment.path) {
        args.push(`@${attachment.path}`);
      }
    }
    args.push('-p', turn.text);
    return args;
  }

  /** Mirrors the base class's line framing; not reusable from here (private there, see class comment). */
  private feedStdout(chunk: string): void {
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
        continue;
      }

      try {
        this.handleMessage(parsed);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `pi adapter failed to handle a message: ${message}` });
      }
    }

    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.emit({ t: 'error', message: 'pi sent an oversized line; discarded the buffer' });
    }
  }

  protected handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const event = raw as PiRawEvent;

    switch (event.type) {
      case 'session':
        this.onSession(event);
        break;
      case 'message_start':
        this.onMessageStart(event);
        break;
      case 'message_update':
        this.onMessageUpdate(event);
        break;
      case 'message_end':
        this.onMessageEnd(event);
        break;
      case 'tool_execution_start':
        this.onToolExecutionStart(event);
        break;
      case 'tool_execution_end':
        this.onToolExecutionEnd(event);
        break;
      case 'agent_settled':
        this.onAgentSettled();
        break;
      // turn_start/turn_end are pi's own agent-loop steps within one prompt
      // (see class comment), agent_end repeats the whole history we already
      // streamed, and entry_appended is pi's own checkpoint bookkeeping —
      // none of them have a corresponding ChatEvent.
      default:
        break;
    }
  }

  private onSession(event: PiRawEvent): void {
    if (typeof event.id === 'string') {
      this.nativeSessionId = event.id;
    }
    if (this.sessionEventEmitted) return;
    this.sessionEventEmitted = true;
    this.emit({
      t: 'session',
      nativeSessionId: this.nativeSessionId,
      // Same as in `start()`: what pi reported, which at this point is nothing.
      model: this.reportedModel,
      cwd: typeof event.cwd === 'string' ? event.cwd : this.options.workingDir,
      capabilities: this.capabilities,
    });
  }

  private onMessageStart(event: PiRawEvent): void {
    const message = event.message;
    if (!message || message.role !== 'assistant') {
      // user/toolResult message_start: the user's turn is already known to
      // the caller (it is what was passed to send()), and tool results are
      // surfaced via tool_execution_end below instead, so pi's echo of both
      // is redundant here.
      return;
    }
    this.openAssistantMessage(message);
  }

  private onMessageUpdate(event: PiRawEvent): void {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;
    if (!this.currentAssistantMsgId) {
      // An update with no preceding start (should not happen, but a missed
      // start must not drop the content it carries).
      this.openAssistantMessage(message);
      return;
    }
    this.syncContent(message.content || []);
  }

  private onMessageEnd(event: PiRawEvent): void {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;
    if (!this.currentAssistantMsgId) return;

    // Final diff in case content only settled on this line.
    this.syncContent(message.content || []);

    const usage = translateUsage(message.usage);
    this.emit({
      t: 'msg_end',
      msgId: this.currentAssistantMsgId,
      stopReason: message.stopReason,
      usage,
    });
    if (usage) {
      this.currentTurnUsage = mergeUsage(this.currentTurnUsage, usage);
    }
    if (message.model) {
      // One message is one round trip to the model, which makes counting them
      // the same measure grok reports as `modelCalls`.
      const seen = this.turnModels.get(message.model) ?? { calls: 0, usage: {} };
      seen.calls += 1;
      if (usage) seen.usage = mergeUsage(seen.usage, usage);
      this.turnModels.set(message.model, seen);
      this.reportedModel = message.model;
    }
    this.currentAssistantMsgId = null;
    this.blockState = null;
  }

  private openAssistantMessage(message: PiAssistantMessage): void {
    this.currentAssistantMsgId = `pi-${this.turnCounter}-${++this.msgCounter}`;
    this.blockState = [];
    this.emit({
      t: 'msg_start',
      id: this.currentAssistantMsgId,
      role: 'assistant',
      turnId: this.currentTurnId ?? `t${this.turnCounter}`,
      model: message.model,
    });
    this.syncContent(message.content || []);
  }

  private onAgentSettled(): void {
    if (!this.currentTurnId) return;
    this.emit({
      t: 'turn_end',
      turnId: this.currentTurnId,
      usage: this.currentTurnUsage,
      ...this.reportedTurnModels(),
    });
    this.emit({ t: 'state', state: 'idle' });
    this.currentTurnId = null;
  }

  private onToolExecutionStart(event: PiRawEvent): void {
    const toolId = event.toolCallId;
    if (!toolId) return;
    this.toolStartedAt.set(toolId, Date.now());
    this.emit({ t: 'tool', toolId, patch: { status: 'running' } });
  }

  private onToolExecutionEnd(event: PiRawEvent): void {
    const toolId = event.toolCallId;
    if (!toolId) return;
    const startedAt = this.toolStartedAt.get(toolId);
    this.toolStartedAt.delete(toolId);

    const isError = Boolean(event.isError);
    const output = extractResultText(event.result);
    const patch: Partial<ToolBlock> = {
      status: isError ? 'failed' : 'completed',
      output,
    };
    if (isError && output) patch.error = output;
    if (startedAt !== undefined) patch.durationMs = Date.now() - startedAt;
    this.emit({ t: 'tool', toolId, patch });
  }

  /**
   * Walk the cumulative content array pi just sent, opening any block seen
   * for the first time and emitting only the growth since the last time this
   * index was synced. This is the diff described in the class comment: the
   * whole point is that a no-op update (cumulative text unchanged from last
   * time) emits nothing at all.
   */
  private syncContent(content: PiContentItem[]): void {
    if (!this.currentAssistantMsgId || !this.blockState) return;
    const msgId = this.currentAssistantMsgId;
    for (let index = 0; index < content.length; index++) {
      const item = content[index];
      let track = this.blockState[index];
      if (!track) {
        track = this.openBlock(msgId, index, item);
        this.blockState[index] = track;
      }
      this.advanceBlock(msgId, index, item, track);
    }
  }

  /**
   * The empty block a stream opens before its first delta.
   *
   * Deliberately still emitted, unlike the whole-message paths in the ACP,
   * claude-snapshot and codex adapters, which now refuse to record a reply that
   * is only whitespace (#132). This protocol addresses its deltas by index, so
   * the block has to exist before they arrive; there is no text to judge yet,
   * and refusing to open it would drop the reply, not tidy it. A block that
   * ends up with nothing in it draws nothing — that is the display rule's job,
   * and this is the correct division between the two.
   */
  private openBlock(msgId: string, index: number, item: PiContentItem): BlockTrack {
    if (item.type === 'thinking') {
      const block: ThinkingBlock = { kind: 'thinking', text: '', signature: item.thinkingSignature };
      this.emit({ t: 'block_start', msgId, index, block });
      return { kind: 'thinking', len: 0 };
    }
    if (item.type === 'text') {
      const block: TextBlock = { kind: 'text', text: '' };
      this.emit({ t: 'block_start', msgId, index, block });
      return { kind: 'text', len: 0 };
    }
    const block: ToolBlock = {
      kind: 'tool',
      toolId: item.id,
      name: item.name,
      toolKind: classifyTool(item.name),
      status: 'pending',
    };
    this.emit({ t: 'block_start', msgId, index, block });
    return { kind: 'tool', len: 0, closed: false };
  }

  private advanceBlock(msgId: string, index: number, item: PiContentItem, track: BlockTrack): void {
    if (item.type === 'thinking' && track.kind === 'thinking') {
      this.emitGrowth(msgId, index, item.thinking, track);
      return;
    }
    if (item.type === 'text' && track.kind === 'text') {
      this.emitGrowth(msgId, index, item.text, track);
      return;
    }
    if (item.type === 'toolCall' && track.kind === 'tool' && !track.closed) {
      if (item.partialArgs !== undefined) {
        if (item.partialArgs.length > track.len) {
          this.emit({ t: 'block_delta', msgId, index, json: item.partialArgs.slice(track.len) });
          track.len = item.partialArgs.length;
        }
        return;
      }
      // partialArgs has dropped out of the content item: pi has finished
      // streaming the call and handed us the parsed object directly, which
      // is more reliable than re-parsing whatever fragment arrived last.
      // inputPartial is cleared explicitly: the reducer only auto-clears it
      // when `input` arrives via its own JSON.parse fallback, not when a
      // block_end supplies `input` directly, as this one does.
      this.emit({
        t: 'block_end',
        msgId,
        index,
        block: { input: item.arguments ?? {}, inputPartial: undefined },
      });
      track.closed = true;
    }
  }

  private emitGrowth(msgId: string, index: number, text: string, track: BlockTrack): void {
    if (text.length > track.len) {
      this.emit({ t: 'block_delta', msgId, index, text: text.slice(track.len) });
      track.len = text.length;
    }
    // A shorter cumulative string than last time has not been observed; if it
    // happened, this silently stops advancing rather than slicing negative.
  }
}

/** State kept per open content-array index of the message currently streaming in. */
type BlockTrack =
  | { kind: 'text'; len: number }
  | { kind: 'thinking'; len: number }
  | { kind: 'tool'; len: number; closed: boolean };

interface PiUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: PiUsageCost;
}

interface PiThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
}

interface PiTextContent {
  type: 'text';
  text: string;
}

interface PiToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  /** Present while pi is still streaming the arguments; gone once finalised. */
  partialArgs?: string;
}

type PiContentItem = PiThinkingContent | PiTextContent | PiToolCallContent;

interface PiAssistantMessage {
  role: string;
  content?: PiContentItem[];
  model?: string;
  stopReason?: string;
  usage?: PiUsage;
}

/** The union of every top-level line this adapter reads, narrowed by `type`. */
interface PiRawEvent {
  type?: string;
  id?: string;
  cwd?: string;
  message?: PiAssistantMessage;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
}

function translateUsage(usage: PiUsage | undefined): ChatUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost?.total,
    // One pi message is one request, so its own total is what sat in the
    // window for it. `mergeUsage` keeps the latest rather than adding these
    // up, which is what makes a per-message figure usable as an occupancy.
    //
    // pi says nothing about how large the window is; it does report the
    // provider and the model id, and the session asks that provider.
    contextUsed: usage.totalTokens,
  };
}

/** pi's tool result shape is `{ content: [{ type: 'text', text }, ...] }`; join the text parts. */
function extractResultText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.length ? parts.join('\n') : undefined;
}

export default PiChatAdapter;

// Re-exported so a test can construct events with the same narrowing this
// file uses, without duplicating the shape by hand.
export type { PiRawEvent, PiAssistantMessage, PiContentItem };
