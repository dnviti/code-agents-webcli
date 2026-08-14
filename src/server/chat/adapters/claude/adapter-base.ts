import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BaseChatAdapter } from '../../adapter.js';
import {
  defaultSlashCommands,
  mergeSlashCommands,
} from '../../../../shared/slash-commands.js';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatUsage,
  UserTurn,
  rankedEfforts,
} from '../../../../shared/chat-events.js';
import { AccountLimitTracker } from '../../account-limits.js';

/**
 * The first, most-derived-implementation partial of the Claude adapter's
 * inheritance chain: every instance field plus the launch, session and
 * capability methods nobody else depends on. Everything later in the chain
 * (`…Effort`, `…Accounting`, `…Messages`) reads these protected members
 * through `this`.
 *
 * The protocol runs two tracks that this adapter has to reconcile into one
 * transcript: `stream_event` carries the live token-by-token deltas (the
 * source of everything the UI animates), while `assistant`/`user` carry
 * complete snapshots that arrive slightly after the stream events they
 * describe. Snapshots are used only to patch what streaming already built
 * (tool input, tool results) — treating them as new messages would double
 * every turn.
 *
 * A `turnId` is minted once per `send()` and reused for every assistant
 * message that follows, because Claude's own agentic loop can round-trip
 * through the model more than once (tool call, then a second response) for
 * a single user prompt, and all of that belongs to one turn from the UI's
 * point of view. It is retired when `result` arrives.
 */
export abstract class ClaudeChatAdapterBase extends BaseChatAdapter {
  readonly runtime = 'claude';

  readonly capabilities: ChatCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    // Claude reports edits as free-form tool input, not a structured diff;
    // deriving one is a later phase's job.
    diffs: false,
    // The MCP permission bridge that would make an allow/deny button do
    // something has not landed yet.
    permissions: false,
    interrupt: true,
    resume: true,
    fork: false,
    attachments: true,
    usage: true,
    cost: true,
    plan: false,
    // The real list only arrives with the first turn's `init` (see
    // handleInit below); until then this is what makes the command menu and
    // its composer button available from the moment the session opens,
    // rather than staying empty until a message has already been sent. The
    // built-ins are this app's own knowledge of what a fresh Claude accepts;
    // the rest is what the session found installed for this person.
    commands: mergeSlashCommands(defaultSlashCommands(), this.options.installedCommands),
    // Claude's own ladder, in its own words. Nothing in the protocol publishes
    // it — `init` names the model and the slash commands and stops there — so
    // this was assembled from the runtime describing itself in two places, and
    // the two do not agree.
    //
    // `--help` documents five: `--effort <level>  Effort level for the current
    // session (low, medium, high, xhigh, max)`. But `/effort` with no argument
    // answers `Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>`, and
    // of those two extras exactly one is also a launch flag. Probed against
    // 2.1.220: `--effort ultracode` is accepted in silence, while `--effort
    // auto` prints `Warning: Unknown --effort value 'auto' — ignoring it`. The
    // CLI's own discrimination between the two is what puts `ultracode` on this
    // list and keeps `auto` off it — a level that worked live and then vanished
    // at the next launch would be worse than one never offered.
    //
    // Evenly ranked. `ultracode` sits at the top because that is where Claude's
    // own usage line puts it and because it is unmistakably the most expensive
    // thing here — though its gloss is worth reading before assuming it is
    // simply "more than max": the reasoning depth is xhigh, and what it adds is
    // breadth, fanning the work out across orchestrated agents. Every
    // description below is Claude's own sentence where it gives one, read back
    // off the confirmation it sends when the level is set.
    //
    // A build that does not know a level does NOT refuse it, which is the whole
    // reason `knownLevel` gates the flag in `buildArgs`. Probed: `claude --effort
    // auto --version` prints `Warning: Unknown --effort value 'auto' — ignoring
    // it and using the default effort` and exits 0. So the failure is the quiet
    // one — the conversation runs at Claude's default while everything upstream
    // reports the level that was asked for — and nothing off this list is ever
    // allowed onto the command line.
    efforts: rankedEfforts([
      { value: 'low', name: 'Low', description: 'the least thinking on offer, for mechanical work' },
      { value: 'medium', name: 'Medium', description: 'a middling amount of thought' },
      { value: 'high', name: 'High', description: 'more thought, for work that needs turning over' },
      { value: 'xhigh', name: 'Extra high', description: 'deeper reasoning than high, just below maximum' },
      { value: 'max', name: 'Max', description: 'maximum capability and the deepest reasoning; slow, and easy to overthink with' },
      { value: 'ultracode', name: 'Ultracode', description: 'xhigh reasoning plus dynamic workflow orchestration' },
    ]),
  };

  /**
   * What Claude has said about the account this conversation is spending from.
   *
   * The two halves arrive on different lines — the billing mode on `init`, the
   * windows on `rate_limit_event` — and the panel needs both at once, so they
   * are accumulated here and re-published whole.
   */
  protected readonly account = new AccountLimitTracker();

  /** Session id we generated for a fresh launch, before init echoes it back. */
  protected freshSessionId?: string;
  protected nativeSessionId?: string;
  protected activeTurnId: string | null = null;
  /**
   * The highest cumulative cost this conversation has reported so far.
   *
   * Seeded from what the conversation was already billed, because the CLI's own
   * counter survives a `--resume` into a new process. See `turnCost`.
   */
  protected costWatermark = this.options.costBaselineUsd ?? 0;
  /**
   * True while the conversation's already-spent total is unknown.
   *
   * Set for a resume with nothing on record — see `costBaselineUsd`. The first
   * reading becomes the watermark and is reported as no cost at all, rather
   * than as a turn that somehow cost everything the conversation ever did.
   */
  protected costBaselineUnknown = this.options.costBaselineUsd === null;
  /** Id of the assistant message currently streaming, or null between turns. */
  protected currentMsgId: string | null = null;
  /** Captured from message_delta, applied when message_stop closes the message. */
  protected pendingStopReason?: string;
  protected pendingUsage?: ChatUsage;
  /**
   * The token fields this turn's own messages have already reported.
   *
   * The watermark `turnTokensLeft` subtracts, so the aggregate on the turn's
   * `result` is not counted a second time. Per turn rather than per session:
   * the aggregate describes the turn.
   */
  protected turnTokensEmitted: ChatUsage = {};
  /** Indices of open tool_use blocks in the current message, cleared per message. */
  protected readonly openToolIndices = new Set<number>();
  /**
   * The thinking block currently open, and how much of its size is reported.
   *
   * Claude never sends the words. Probed against 2.1.220 with `--effort high`
   * on a turn that reasoned twice: every `content_block_start` announced
   * `{"type":"thinking","thinking":"","signature":""}`, every `thinking_delta`
   * carried `"thinking":""`, and the closing snapshot in the `assistant`
   * message carried an empty `thinking` beside a full signature. The reasoning
   * is real — it is billed on `output_tokens_details.thinking_tokens` — and the
   * only account of it on the wire is the `system`/`thinking_tokens` line
   * running alongside, which reports a cumulative estimate *per block* (50 then
   * 114 for the first, restarting at 50 then 152 for the second).
   *
   * So this pairs that side channel with the block it belongs to: `counted` is
   * how much of the running estimate has already been emitted, and the
   * difference goes out as a `block_delta`. Cumulative-minus-counted rather
   * than the `estimated_tokens_delta` sitting next to it, because the two agree
   * where both are present and this one also survives a line going missing.
   */
  protected openThinking: { index: number; counted: number } | null = null;
  /**
   * `task_id` → the `tool_use_id` of the call that started it.
   *
   * `task_updated` identifies the run only by `task_id`, so the pairing seen on
   * `task_started` is what lets its closing status reach the right delegation.
   */
  protected readonly tasksByTaskId = new Map<string, string>();
  /**
   * The `tool_use_id` of every task that is a *workflow*, and the run's name.
   *
   * A workflow and a plain sub-agent arrive on the same channel and differ only
   * by the `task_type` on the report that opens them, which is why this is
   * remembered rather than looked for later: the report that says the run
   * failed does not say what kind of run it was. Only workflows settle their
   * launching tool call from this channel — how an ordinary delegation reports
   * its status is deliberately untouched (#140).
   */
  protected readonly workflowTasks = new Map<string, string | undefined>();
  /** Workflows already announced as failed, so a second report is not a second failure. */
  protected readonly failedWorkflows = new Set<string>();
  /** Workflows whose launching call has already been settled, for the same reason. */
  protected readonly settledWorkflows = new Set<string>();
  /**
   * The `/effort` turn in flight, or null when none is.
   *
   * Set for the few milliseconds between writing the command and the `result`
   * that answers it. While it is set this adapter is deliberately deaf: see
   * `setEffort`, which is the only thing that sets it and the only place the
   * whole arrangement is explained.
   */
  protected pendingEffort: {
    level: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    /**
     * The same promise `setEffort` handed its caller.
     *
     * Held so `send()` can wait on it without a second one to keep in step. It
     * is always awaited with a `.catch`, because a rejection here belongs to
     * whoever asked for the level and has already been given it once — an
     * unhandled one on this copy would take the process down over a failure
     * somebody is already reporting.
     */
    settled: Promise<void>;
  } | null = null;
  /**
   * How many `/effort` answers are still owed by a switch nobody is waiting for.
   *
   * Incremented whenever a pending switch is abandoned — a timeout, the child
   * exiting, or a message typed over the top of it. The command was written to
   * stdin and Claude will answer it whenever it gets there; by then
   * `pendingEffort` is null, so `handleResult`'s guard no longer recognises the
   * line and it fell through into the ordinary turn-closing path. What that did
   * was end the user's *next* real turn the moment the stale answer arrived —
   * at zero cost, before it had produced anything — leaving the reply that
   * followed to open a turn of its own with nobody's question in it.
   *
   * Claude's own figures are what tell the two apart: it answers this command
   * locally, so the result carries `num_turns: 0`, which no turn that reached
   * the model ever does.
   */
  protected staleEffortResults = 0;
  /**
   * True once streaming has opened an assistant message for the current turn.
   *
   * The whole of this adapter's snapshot handling rests on streaming having
   * built the message first — snapshots only ever patch what is already there.
   * That holds for anything the model answered, because a model answer always
   * arrives as deltas.
   *
   * It does not hold for a command the CLI answers by itself. `/effort auto`
   * and `/model x` are handled locally, and locally-handled commands emit no
   * `stream_event` whatsoever: verified against 2.1.220, which for one of them
   * sends exactly two lines, an `assistant` snapshot and a `result` with
   * `num_turns: 0`. So the reply had nothing to patch and was dropped on the
   * floor — the transcript showed the command, a turn, `$0`, and no answer.
   *
   * Reset per turn rather than per message so a turn with several assistant
   * messages in it still only materialises a snapshot when the *first* one
   * never streamed.
   */
  protected streamedThisTurn = false;

  /**
   * The level, when this build of Claude is known to have one by that name.
   *
   * Checked against `capabilities.efforts` rather than a second list kept in
   * step by hand. Anything else comes back as nothing, because passing it would
   * mean the flag warned on a stream nobody reads and the conversation ran at
   * Claude's default while the chip reported the level that was asked for.
   */
  protected knownLevel(effort: string | undefined): string | undefined {
    if (!effort) return undefined;
    return this.capabilities.efforts?.some((level) => level.value === effort) ? effort : undefined;
  }

  protected buildArgs(): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    if (this.options.resumeSessionId) {
      args.push('--resume', this.options.resumeSessionId);
    } else {
      // Generated here rather than reusing options.sessionId: that id is
      // this app's own session identifier, and --session-id rejects
      // anything that is not a UUID.
      this.freshSessionId = randomUUID();
      args.push('--session-id', this.freshSessionId);
    }

    if (this.options.bypassPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    const effort = this.knownLevel(this.options.effort);
    if (effort) {
      // Documented by 2.1.220's own `--help`: `--effort <level>  Effort level
      // for the current session (low, medium, high, xhigh, max)`.
      //
      // Filtered rather than passed through, and the reason is a correction to
      // what this comment used to claim. An unrecognised value is NOT refused:
      // `claude --effort auto --version` prints `Warning: Unknown --effort value
      // 'auto' — ignoring it and using the default effort` and exits 0. So this
      // fails exactly the way pi's does — silently, at the runtime's own default,
      // while everything upstream goes on reporting the level that was asked for.
      //
      // Three real ways a level that is not on this ladder reaches here: a
      // `/effort` typed into the composer, whose accepted set is wider than the
      // flag's by exactly one word — `auto`, which the command takes and the
      // flag warns about; a conversation whose record was written while it ran
      // on another runtime; and a record written by a future build with a
      // longer ladder.
      //
      // Placed beside `--model` rather than among `extraArgs`, which go on
      // staying last: both are the session's own choice, and whatever a profile
      // spells out for itself is still written after them.
      args.push('--effort', effort);
    }
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    return args;
  }

  async start(): Promise<void> {
    await super.start();
    // A `/effort` turn waiting for its answer is a promise somebody upstream is
    // holding, and the only thing that ever settles it is a `result` line from
    // this child. If the child goes away first — a crash, a `stop()`, the user
    // closing the session — no such line is coming, and without this the caller
    // would sit on it until the timeout in `setEffort` expired. The timeout is
    // the backstop; this is the truthful answer, available immediately.
    this.child?.on('exit', () => {
      this.abandonEffort(new Error('claude exited before it confirmed the effort level'));
    });
  }

  async send(turn: UserTurn): Promise<void> {
    // Give up on any `/effort` still in flight rather than waiting for it. The
    // suppression `setEffort` installs would otherwise swallow this turn's own
    // opening events — the user's message would simply never appear — and the
    // first version of this waited on the pending promise to avoid that.
    //
    // Waiting was the wrong trade. It held a typed message for as long as the
    // switch took to answer, up to the whole 8-second ceiling if the answer
    // never came, and a composer that swallows a keystroke for eight seconds is
    // a worse failure than a level that did not change. The person typing has
    // said what they want; the button press is the thing to drop.
    //
    // `abandonEffort` rejects the switch — which the caller reports honestly as
    // "saved, not applied" — and leaves the answer owed. `staleEffortResults`
    // is what stops that answer, when it does arrive, being mistaken for the end
    // of this turn.
    if (this.pendingEffort) {
      this.abandonEffort(new Error('a message was sent before the effort level was confirmed'));
    }
    this.activeTurnId = randomUUID();
    this.turnTokensEmitted = {};
    this.streamedThisTurn = false;
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: turn.text }];
    for (const attachment of turn.attachments ?? []) {
      content.push(this.attachmentBlock(attachment));
    }
    this.writeLine({ type: 'user', message: { role: 'user', content } });
  }

  protected attachmentBlock(attachment: ChatAttachment): Record<string, unknown> {
    if (attachment.mime.startsWith('image/') && attachment.path) {
      try {
        const data = readFileSync(attachment.path).toString('base64');
        return { type: 'image', source: { type: 'base64', media_type: attachment.mime, data } };
      } catch {
        // Fall through to the text reference below: a moved or unreadable
        // path must not stop the rest of the turn from reaching the runtime.
      }
    }
    // Non-image attachments, and images we could not read ourselves: point
    // Claude at the file so its own Read tool can pull it in, rather than
    // guessing at a document content-block shape nothing here confirms.
    const where = attachment.path || attachment.url;
    return { type: 'text', text: `[attached file: ${attachment.name} at ${where}]` };
  }

  async interrupt(): Promise<void> {
    // Verified against the installed CLI's own bundle, not just --help
    // (which only documents flags, never the stdin wire protocol): the
    // compiled client sends exactly this shape for its own stop button.
    this.writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // capabilities.permissions is false, so the UI has no button that calls
    // this yet; kept as a no-op until the MCP permission bridge lands.
  }

  /**
   * Give up on a `/effort` turn that will never be answered.
   *
   * Rejecting rather than resolving quietly, and emitting no `effort` event at
   * all, because the level was never confirmed by anybody: the caller turns this
   * into `pending`, which says "asked, not seen to take" — where a resolve would
   * put a level on the chip on the strength of this app having asked for it.
   * Also the one thing that lifts the suppression above, so a session that
   * outlives a failed switch is not left deaf to its own runtime.
   */
  protected abandonEffort(error: Error): void {
    const pending = this.pendingEffort;
    if (!pending) return;
    this.pendingEffort = null;
    clearTimeout(pending.timer);
    // The command is already on its way to Claude and will still be answered.
    // See `staleEffortResults` for what that answer would otherwise do.
    this.staleEffortResults += 1;
    pending.reject(error);
  }
}
