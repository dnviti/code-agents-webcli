import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BaseChatAdapter } from '../adapter.js';
import {
  defaultSlashCommands,
  describeSlashCommand,
  mergeSlashCommands,
} from '../../../shared/slash-commands.js';
import { describeFrom } from '../installed-commands.js';
import { mapModelUsage } from './model-usage.js';
import {
  ChatAttachment,
  ChatBlock,
  ChatCapabilities,
  ChatUsage,
  ToolStatus,
  UserTurn,
  WorkflowAgent,
  WorkflowAgentState,
  WorkflowPhase,
  classifyTool,
  rankedEfforts,
} from '../../../shared/chat-events.js';

/**
 * Anthropic streaming-JSON adapter (`claude -p --output-format stream-json`).
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
export class ClaudeChatAdapter extends BaseChatAdapter {
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

  /** Session id we generated for a fresh launch, before init echoes it back. */
  private freshSessionId?: string;
  private nativeSessionId?: string;
  private activeTurnId: string | null = null;
  /**
   * The highest cumulative cost this conversation has reported so far.
   *
   * Seeded from what the conversation was already billed, because the CLI's own
   * counter survives a `--resume` into a new process. See `turnCost`.
   */
  private costWatermark = this.options.costBaselineUsd ?? 0;
  /**
   * True while the conversation's already-spent total is unknown.
   *
   * Set for a resume with nothing on record — see `costBaselineUsd`. The first
   * reading becomes the watermark and is reported as no cost at all, rather
   * than as a turn that somehow cost everything the conversation ever did.
   */
  private costBaselineUnknown = this.options.costBaselineUsd === null;
  /** Id of the assistant message currently streaming, or null between turns. */
  private currentMsgId: string | null = null;
  /** Captured from message_delta, applied when message_stop closes the message. */
  private pendingStopReason?: string;
  private pendingUsage?: ChatUsage;
  /**
   * The token fields this turn's own messages have already reported.
   *
   * The watermark `turnTokensLeft` subtracts, so the aggregate on the turn's
   * `result` is not counted a second time. Per turn rather than per session:
   * the aggregate describes the turn.
   */
  private turnTokensEmitted: ChatUsage = {};
  /** Indices of open tool_use blocks in the current message, cleared per message. */
  private readonly openToolIndices = new Set<number>();
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
  private openThinking: { index: number; counted: number } | null = null;
  /**
   * `task_id` → the `tool_use_id` of the call that started it.
   *
   * `task_updated` identifies the run only by `task_id`, so the pairing seen on
   * `task_started` is what lets its closing status reach the right delegation.
   */
  private readonly tasksByTaskId = new Map<string, string>();
  /**
   * The `/effort` turn in flight, or null when none is.
   *
   * Set for the few milliseconds between writing the command and the `result`
   * that answers it. While it is set this adapter is deliberately deaf: see
   * `setEffort`, which is the only thing that sets it and the only place the
   * whole arrangement is explained.
   */
  private pendingEffort: {
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
  private staleEffortResults = 0;
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
  private streamedThisTurn = false;

  /**
   * The level, when this build of Claude is known to have one by that name.
   *
   * Checked against `capabilities.efforts` rather than a second list kept in
   * step by hand. Anything else comes back as nothing, because passing it would
   * mean the flag warned on a stream nobody reads and the conversation ran at
   * Claude's default while the chip reported the level that was asked for.
   */
  private knownLevel(effort: string | undefined): string | undefined {
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

  private attachmentBlock(attachment: ChatAttachment): Record<string, unknown> {
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
   * Change the reasoning level of a session that is already running.
   *
   * There is no control request for this, and that was not assumed — it was
   * probed. Every plausible spelling was written to the running CLI's stdin in
   * bidirectional stream-json mode (`set_effort`, `effort`,
   * `set_reasoning_effort`) and all three came back
   * `{"subtype":"error","error":"Unsupported control request subtype: set_effort"}`,
   * on the same socket where `set_model` and `set_permission_mode` answered
   * `{"subtype":"success"}`. So the road `interrupt()` takes is closed here.
   *
   * The road that is open is the slash command, sent down the ordinary *user*
   * channel. Claude advertises it — the `init` message's `slash_commands` array
   * contains `"effort"` alongside `"model"` — and writing the line below
   * produced an assistant message and then
   * `{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":0,
   * "result":"Set effort level to xhigh (this session only): ..."}`. Zero
   * dollars and zero model round trips: the CLI answers it locally. That is what
   * makes spending a turn on a button press affordable at all.
   *
   * It is nonetheless a *turn*, and everything this app knows about a
   * conversation is derived from turn structure — where one begins, what it
   * cost, how many round trips it took. So two things follow, and they are the
   * whole of why this method is longer than a write:
   *
   * First, it refuses to interleave. A control turn written while the agent is
   * working would fold a message the user never typed into a turn they did,
   * taking its costs and its round-trip count with it. `pending` is the honest
   * answer there, and a throw is how the caller is told to give it.
   *
   * Second, everything the runtime says while it is in flight is dropped on the
   * floor — the echo of the command, the assistant turn answering it, the
   * streamed tokens of that answer (see the guards in `handleStatus`,
   * `handleStreamEvent`, `handleAssistantSnapshot` and `handleUserEcho`). The
   * user pressed a button; they did not type a command. A user message they did
   * not write, answered by an assistant message about a setting, is a lie in the
   * transcript and a phantom turn in the accounting — one that would sit in the
   * turn index with its own row and its own zero-cost bill.
   *
   * The promise resolves only on Claude's own confirmation, because the caller
   * reports `live` to the user on the strength of it.
   */
  async setEffort(effort: string): Promise<void> {
    if (this.activeTurnId !== null) {
      throw new Error(
        'claude is mid-turn, and a control turn sent now would be folded into it',
      );
    }
    if (!this.alive) {
      throw new Error('claude is not running, so there is no session to change the level of');
    }
    if (this.pendingEffort) {
      throw new Error('claude is already being asked to change effort level');
    }

    // The whole state goes up before the write, not after: `handleResult` runs
    // off a stdout `data` event and cannot land inside the synchronous body of
    // the executor below, but ordering it this way means there is no
    // arrangement of the event loop in which an answer arrives with nothing
    // here to receive it.
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const settled = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.abandonEffort(
        new Error(`claude did not confirm the effort level within ${EFFORT_TIMEOUT_MS}ms`),
      );
    }, EFFORT_TIMEOUT_MS);
    this.pendingEffort = { level: effort, resolve, reject, timer, settled };
    this.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] },
    });
    return settled;
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
  private abandonEffort(error: Error): void {
    const pending = this.pendingEffort;
    if (!pending) return;
    this.pendingEffort = null;
    clearTimeout(pending.timer);
    // The command is already on its way to Claude and will still be answered.
    // See `staleEffortResults` for what that answer would otherwise do.
    this.staleEffortResults += 1;
    pending.reject(error);
  }

  protected handleMessage(message: unknown): void {
    const raw = record(message);
    if (!raw) return;

    switch (str(raw.type)) {
      case 'system':
        this.handleSystem(raw);
        return;
      case 'stream_event':
        this.handleStreamEvent(raw);
        return;
      case 'assistant':
        this.handleAssistantSnapshot(raw);
        return;
      case 'user':
        this.handleUserEcho(raw);
        return;
      case 'result':
        this.handleResult(raw);
        return;
      case 'rate_limit_event':
        // Quota telemetry with nothing in the chat model to hold it; treating
        // it as an error would alarm the user over something that has not
        // actually failed.
        return;
      default:
        return;
    }
  }

  private handleSystem(raw: Record<string, unknown>): void {
    const subtype = str(raw.subtype);
    if (subtype === 'init') {
      this.handleInit(raw);
      return;
    }
    if (subtype === 'status') {
      this.handleStatus(raw);
      return;
    }
    if (subtype === 'compact_boundary') {
      // The one system event that is genuinely about the conversation rather
      // than about the plumbing: everything before this point is no longer in
      // the model's context, and the transcript has to say so.
      const meta = raw.compact_metadata as Record<string, unknown> | undefined;
      const trigger = str(meta?.trigger);
      const before = Number(meta?.pre_tokens);
      this.emit({
        t: 'marker',
        kind: 'compacted',
        detail: [
          trigger === 'auto' ? 'ran automatically' : trigger === 'manual' ? 'requested' : '',
          Number.isFinite(before) && before > 0 ? `${Math.round(before / 1000)}k tokens summarised` : '',
        ].filter(Boolean).join(' · ') || undefined,
      });
      return;
    }
    if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated') {
      this.handleTask(subtype, raw);
      return;
    }
    if (subtype === 'thinking_tokens') {
      this.handleThinkingTokens(raw);
      return;
    }
    // hook_started / hook_response / anything else is session-internal
    // plumbing a transcript viewer has no use for.
  }

  /**
   * The size of a reasoning block Claude will not show the contents of.
   *
   * Attributed to the open thinking block, and dropped when there is none: the
   * line names no block of its own, and guessing which one it meant would put a
   * figure on the wrong row. Its counter restarts per block, so a smaller
   * reading than the last one is a new block being counted rather than the
   * model un-thinking — hence the clamp, which also keeps a negative token
   * count out of the transcript if the ordering ever changes.
   */
  private handleThinkingTokens(raw: Record<string, unknown>): void {
    const open = this.openThinking;
    if (!open || !this.currentMsgId) return;
    const cumulative = num(raw.estimated_tokens);
    if (cumulative === undefined) return;
    const added = cumulative - open.counted;
    if (added <= 0) return;
    open.counted = cumulative;
    this.emit({ t: 'block_delta', msgId: this.currentMsgId, index: open.index, tokens: added });
  }

  /**
   * What a delegated agent is doing, reported beside the call that started it.
   *
   * `task_started` and `task_progress` carry `tool_use_id` directly;
   * `task_updated` carries only its own `task_id`, so the id seen at start is
   * remembered to route the closing patch. Without that the run would never be
   * marked finished and its detail view would claim it was still working.
   */
  private handleTask(subtype: string, raw: Record<string, unknown>): void {
    const taskId = str(raw.task_id);
    const direct = str(raw.tool_use_id);
    if (direct && taskId) this.tasksByTaskId.set(taskId, direct);
    const parentToolId = direct ?? (taskId ? this.tasksByTaskId.get(taskId) : undefined);
    if (!parentToolId) return;

    if (subtype === 'task_updated') {
      const patch = record(raw.patch);
      const status = str(patch?.status);
      this.emit({
        t: 'agent_progress',
        parentToolId,
        patch: { status: status ? toolStatus(status) : undefined, error: str(patch?.error) },
      });
      return;
    }

    const usage = record(raw.usage);
    this.emit({
      t: 'agent_progress',
      parentToolId,
      patch: {
        // `description` is the agent's own phrasing of the moment ("Reading
        // hello.txt"), which is the whole point of the progress channel.
        activity: str(raw.description),
        lastTool: str(raw.last_tool_name),
        subagentType: str(raw.subagent_type),
        // The workflow's own name, which the tool call itself need not carry:
        // a run started from an inline `{script}` has no name anywhere in its
        // arguments, and every one of them was titled "Workflow".
        workflowName: str(raw.workflow_name),
        prompt: subtype === 'task_started' ? str(raw.prompt) : undefined,
        toolUses: num(usage?.tool_uses),
        totalTokens: num(usage?.total_tokens),
        durationMs: num(usage?.duration_ms),
        status: subtype === 'task_started' ? 'running' : undefined,
      },
    });

    this.emitWorkflowProgress(parentToolId, raw.workflow_progress);
  }

  /**
   * The phases and agents a workflow reports about itself, forwarded.
   *
   * This is the channel issue #45 left unwired for want of a recorded run.
   * What a run actually sends (captured in test/fixtures/chat/claude-workflow
   * .jsonl) is a complete snapshot of every phase and agent so far, on *some*
   * `task_progress` reports and not others — four of ten in that capture carry
   * no `workflow_progress` key at all. So an absent list is passed on as
   * absent, and never as an empty one: the reducer would otherwise be asked to
   * choose between "no phases" and "nothing new", which are opposite facts.
   */
  private emitWorkflowProgress(parentToolId: string, reported: unknown): void {
    if (!Array.isArray(reported)) return;

    const phases: WorkflowPhase[] = [];
    const agents: WorkflowAgent[] = [];

    for (const raw of reported) {
      const entry = record(raw);
      const index = num(entry?.index);
      if (!entry || index === undefined) continue;

      if (entry.type === 'workflow_phase') {
        phases.push({ index, title: str(entry.title) ?? `Phase ${index}`, kind: str(entry.kind) });
        continue;
      }
      if (entry.type !== 'workflow_agent') continue;

      agents.push({
        index,
        // A label is what the agent is called everywhere it appears; a run
        // that omitted one would otherwise put a nameless row on the screen.
        label: str(entry.label) ?? `Agent ${index}`,
        state: agentState(str(entry.state)),
        phaseIndex: num(entry.phaseIndex),
        phaseTitle: str(entry.phaseTitle),
        agentId: str(entry.agentId),
        agentType: str(entry.agentType),
        model: str(entry.model),
        fallbackModel: str(entry.fallbackModel),
        isolation: str(entry.isolation),
        prompt: str(entry.promptPreview),
        lastTool: str(entry.lastToolName),
        lastToolDetail: str(entry.lastToolSummary),
        tokens: num(entry.tokens),
        toolCalls: num(entry.toolCalls),
        durationMs: num(entry.durationMs),
        startedAt: num(entry.startedAt),
        queuedAt: num(entry.queuedAt),
        attempt: num(entry.attempt),
        lastAttemptReason: str(entry.lastAttemptReason),
        cached: entry.cached === true ? true : undefined,
        blocked: entry.blocked === true ? true : undefined,
        result: str(entry.resultPreview),
        error: str(entry.error),
      });
    }

    // `workflow_log` entries travel in the same array and are dropped: they are
    // the run narrating to itself ("throttled response, sleeping 45s"), the
    // runtime trims the oldest of them away as the list grows, and the popup
    // already has the run's own log underneath. Nothing here needs a fourth
    // list that silently loses its head.
    if (phases.length === 0 && agents.length === 0) return;
    this.emit({ t: 'workflow_progress', parentToolId, phases, agents });
  }

  private handleInit(raw: Record<string, unknown>): void {
    const sessionId = str(raw.session_id) ?? this.freshSessionId ?? this.options.resumeSessionId;
    this.nativeSessionId = sessionId;

    // Claude reports its commands as bare names — every skill and every project
    // command among them, and not a word about any of it. The picker has a
    // column for a description and would otherwise show a list of
    // indistinguishable slashes, so each name is looked up: first in the shared
    // table of built-ins, then in the frontmatter of what is installed on disk.
    //
    // Which list is shown is not in question. This one is Claude's, entire, and
    // it replaces whatever stood in for it; only the descriptions are borrowed,
    // from the only place the authors' own words exist.
    const describeInstalled = describeFrom(this.options.installedCommands ?? []);
    const slashCommands = Array.isArray(raw.slash_commands) ? (raw.slash_commands as unknown[]) : [];
    const commands = slashCommands
      .map((entry) => {
        if (typeof entry === 'string') {
          const description = describeSlashCommand(entry) ?? describeInstalled(entry);
          return description ? { name: entry, description } : { name: entry };
        }
        return null;
      })
      .filter((c): c is { name: string; description?: string } => c !== null);

    if (commands.length > 0) this.capabilities.commands = commands;

    this.emit({
      t: 'session',
      nativeSessionId: sessionId,
      model: str(raw.model),
      cwd: str(raw.cwd),
      capabilities: this.capabilities,
    });
    // What level this session is running at, as far as anyone here can honestly
    // say. `init` carries the model, the cwd and the command list and says
    // nothing whatever about effort — checked against 2.1.220's own init line,
    // `{"model":"claude-opus-5[1m]","slash_commands":["effort","model",...]}`,
    // which advertises that the *command* exists without ever reporting the
    // level it is currently on. So the only fact available at launch is the flag
    // this adapter passed a moment ago in `buildArgs`, and that is what is
    // reported.
    //
    // `null` when no flag was passed, and it means "whatever Claude's own
    // default is" rather than the bottom of the ladder. The CLI has never told
    // us which of its five that is, so naming one would be a guess — and the
    // chip renders what arrives here as the agent's own word for what it is
    // doing.
    this.emit({ t: 'effort', effort: this.options.effort ?? null });
    // Nothing is running yet; the first `system/status: requesting` (sent
    // once a prompt actually lands) is what moves this on to `thinking`.
    this.emit({ t: 'state', state: 'idle' });
  }

  private handleStatus(raw: Record<string, unknown>): void {
    // Whether the CLI reports a status at all for a command it answers locally
    // was never established — the capture in `setEffort` shows an assistant
    // message and a result, and nothing was written down about what came
    // between. Which is exactly why this is guarded: if it does say
    // `requesting`, the session would move to `thinking` and stay there, because
    // the only thing that ever moves it back is the `turn_end` that the
    // suppressed result never produces. Saying nothing leaves the session idle,
    // which is the truth — no work was ever requested of the model.
    if (this.pendingEffort) return;
    const status = str(raw.status);
    if (status === 'requesting') {
      this.emit({ t: 'state', state: 'thinking' });
      return;
    }
    // Other status strings are not documented by --help and are not
    // exercised by the recorded traffic; skipping is safer than guessing a
    // ChatState for them.
  }

  private handleStreamEvent(raw: Record<string, unknown>): void {
    // Tokens belonging to the answer to a command nobody typed (see
    // `setEffort`). Dropped at the top rather than filtered later, because
    // `handleMessageStart` opens a message — and mints a turn id for it if none
    // is running — so a single delta let through here would put a message in the
    // transcript and a turn in the index that the rest of this arrangement then
    // has nothing to close.
    if (this.pendingEffort) return;
    const event = record(raw.event);
    if (!event) return;
    // A partial belonging to a sub-agent, if the runtime ever streams one.
    // These carry the sub-agent's own message and block indices, so letting
    // them through would open blocks in — and interleave tokens into — the
    // main conversation as though the top-level agent had said them. The
    // delegation's own steps come from the snapshots instead.
    if (str(raw.parent_tool_use_id)) return;

    switch (str(event.type)) {
      case 'message_start':
        this.handleMessageStart(event);
        return;
      case 'content_block_start':
        this.handleContentBlockStart(event);
        return;
      case 'content_block_delta':
        this.handleContentBlockDelta(event);
        return;
      case 'content_block_stop':
        this.handleContentBlockStop(event);
        return;
      case 'message_delta':
        this.handleMessageDelta(event);
        return;
      case 'message_stop':
        this.handleMessageStop();
        return;
      default:
        // `ping` and any future event type need no translation.
        return;
    }
  }

  private handleMessageStart(event: Record<string, unknown>): void {
    const message = record(event.message);
    this.currentMsgId = (message && str(message.id)) || randomUUID();
    this.openToolIndices.clear();
    this.openThinking = null;
    this.streamedThisTurn = true;

    if (!this.activeTurnId) {
      // A message_start with no turn in flight means send() was never
      // called for it -- better to invent a turnId than to drop the message.
      this.activeTurnId = randomUUID();
    }

    this.emit({
      t: 'msg_start',
      id: this.currentMsgId,
      role: 'assistant',
      turnId: this.activeTurnId,
      model: message ? str(message.model) : undefined,
    });
  }

  private handleContentBlockStart(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    const contentBlock = record(event.content_block);
    if (index === undefined || !contentBlock) return;

    let block: ChatBlock;
    const kind = str(contentBlock.type);
    if (kind === 'text') {
      block = { kind: 'text', text: str(contentBlock.text) ?? '' };
    } else if (kind === 'thinking') {
      block = { kind: 'thinking', text: str(contentBlock.thinking) ?? '', signature: str(contentBlock.signature) };
      // From here on, the thinking_tokens line running beside the stream is
      // describing *this* block, counting from zero again. Replacing the whole
      // record rather than moving an index is what makes the restart safe: a
      // second block counting up from 50 against the first block's watermark
      // of 114 would report nothing until it passed it. See `openThinking`.
      this.openThinking = { index, counted: 0 };
    } else if (kind === 'tool_use') {
      const toolId = str(contentBlock.id);
      if (!toolId) return; // no way to route later patches without one
      const name = str(contentBlock.name) ?? 'tool';
      this.openToolIndices.add(index);
      block = {
        kind: 'tool',
        toolId,
        name,
        toolKind: classifyTool(name),
        status: 'pending',
        // `input` stays unset: Claude streams it as input_json_delta
        // fragments that only parse once the block closes, and
        // content_block.input here is just the {} snapshot at announce time.
        // Setting it now would make the reducer skip the real parse later.
      };
    } else {
      // Anthropic has added block types before without documenting them
      // anywhere --help reaches; render as empty text so later deltas
      // addressed to this index still land somewhere instead of vanishing.
      block = { kind: 'text', text: '' };
    }

    this.emit({ t: 'block_start', msgId: this.currentMsgId, index, block });
  }

  private handleContentBlockDelta(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    const delta = record(event.delta);
    if (index === undefined || !delta) return;

    switch (str(delta.type)) {
      case 'text_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, text: str(delta.text) ?? '' });
        return;
      case 'thinking_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, text: str(delta.thinking) ?? '' });
        return;
      case 'input_json_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, json: str(delta.partial_json) ?? '' });
        return;
      default:
        // signature_delta and anything else carries no renderable content.
        return;
    }
  }

  private handleContentBlockStop(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    if (index === undefined) return;

    // A tool_use block closing means its arguments finished streaming and
    // the call is about to run, not that the runtime is done with it -- the
    // result lands later, out of band, as a `user` tool_result message.
    const wasTool = this.openToolIndices.delete(index);
    // A closing thinking block deliberately leaves `openThinking` alone: the
    // next one replaces it with its own watermark, and a `thinking_tokens`
    // line that trails the stop still belongs to the block it was counting.
    this.emit({
      t: 'block_end',
      msgId: this.currentMsgId,
      index,
      ...(wasTool ? { block: { status: 'running' } } : {}),
    });
  }

  private handleMessageDelta(event: Record<string, unknown>): void {
    const delta = record(event.delta);
    this.pendingStopReason = delta ? str(delta.stop_reason) : undefined;
    const usageRaw = record(event.usage);
    this.pendingUsage = usageRaw ? mapUsage(usageRaw) : undefined;
  }

  private handleMessageStop(): void {
    if (!this.currentMsgId) return;
    if (this.pendingUsage) {
      for (const field of TOKEN_FIELDS) {
        const value = this.pendingUsage[field];
        if (typeof value === 'number') {
          this.turnTokensEmitted[field] = (this.turnTokensEmitted[field] ?? 0) + value;
        }
      }
    }
    this.emit({
      t: 'msg_end',
      msgId: this.currentMsgId,
      stopReason: this.pendingStopReason,
      usage: this.pendingUsage,
    });
    this.currentMsgId = null;
    this.pendingStopReason = undefined;
    this.pendingUsage = undefined;
    this.openToolIndices.clear();
  }

  /**
   * The complete message, arriving just after the stream events that built
   * it. Used only to reconcile tool input in case reassembling the streamed
   * fragments ever disagrees with what Claude actually sent (a fragment
   * boundary landing inside a multi-byte escape, say) -- never to create a
   * second copy of the message.
   */
  /**
   * Turn an unstreamed assistant snapshot into a message of its own.
   *
   * Only ever reached for a turn in which streaming opened nothing at all, so
   * there is no message for this to duplicate — that condition, rather than the
   * shape of the snapshot, is what makes it safe. Marks the turn as streamed on
   * the way out so a second snapshot for the same answer cannot build it twice.
   *
   * Text blocks only. A locally-handled command has no tools and no reasoning,
   * and the loop below this still handles `tool_use` for every other case.
   */
  private materialiseSnapshot(
    raw: Record<string, unknown>,
    message: Record<string, unknown> | undefined,
    content: unknown[],
  ): void {
    const text = content
      .map((entry) => record(entry))
      .filter((block): block is Record<string, unknown> => Boolean(block) && str(block!.type) === 'text')
      .map((block) => str(block.text) ?? '')
      .join('');
    if (!text) return;

    this.streamedThisTurn = true;
    if (!this.activeTurnId) this.activeTurnId = randomUUID();
    const msgId = (message && str(message.id)) || randomUUID();
    this.emit({
      t: 'msg_start',
      id: msgId,
      role: 'assistant',
      turnId: this.activeTurnId,
      model: message ? str(message.model) : undefined,
    });
    this.emit({ t: 'block_start', msgId, index: 0, block: { kind: 'text', text } });
    this.emit({ t: 'msg_end', msgId, stopReason: str(raw.stop_reason) });
  }

  private handleAssistantSnapshot(raw: Record<string, unknown>): void {
    // The snapshot of that same unasked-for answer (see `setEffort`). Nothing
    // it could patch exists — the streaming half was dropped above — so at best
    // this emits patches addressed to blocks nobody ever opened.
    if (this.pendingEffort) return;
    const message = record(raw.message);
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const parent = str(raw.parent_tool_use_id);
    // An answer nothing streamed, which means the CLI produced it without going
    // near the model — a slash command it handles itself. This is the only
    // carrier that reply has, so it is built into a real message here rather
    // than used to patch one that was never opened. See `streamedThisTurn`.
    if (!parent && !this.streamedThisTurn) this.materialiseSnapshot(raw, message, content);
    for (const entry of content) {
      const block = record(entry);
      if (!block || str(block.type) !== 'tool_use') continue;
      const toolId = str(block.id);
      if (!toolId) continue;

      // A sub-agent's own call. Its id belongs to the sub-agent's namespace,
      // not this transcript's, so it becomes a step on the delegation rather
      // than a `tool` patch — which is what used to happen, and which the
      // reducer could only file away as an orphan nobody ever rendered.
      if (parent) {
        this.emit({
          t: 'agent_step',
          parentToolId: parent,
          step: {
            id: toolId,
            name: str(block.name) ?? 'tool',
            toolKind: classifyTool(str(block.name) ?? ''),
            status: 'running',
            input: block.input,
            ts: Date.now(),
          },
        });
        continue;
      }
      // This snapshot arrives before content_block_stop (verified against
      // the fixture), so the reducer's own inputPartial cleanup -- which
      // only runs when `input` is still unset at block_end -- never fires.
      // Clearing it here too avoids leaving a stale fragment string sitting
      // next to the now-correct parsed input.
      this.emit({ t: 'tool', toolId, patch: { input: block.input, inputPartial: undefined } });
    }
  }

  /** A `user` message here is Claude echoing tool results, never a human turn. */
  private handleUserEcho(raw: Record<string, unknown>): void {
    // The echo of the `/effort` line itself, among anything else the CLI sends
    // back on the user channel while it is answering it (see `setEffort`). The
    // user pressed a button and never typed a command; a message in their own
    // voice that they did not write is the one thing a transcript must never
    // contain.
    if (this.pendingEffort) return;
    const message = record(raw.message);
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const parent = str(raw.parent_tool_use_id);
    for (const entry of content) {
      const block = record(entry);
      if (!block || str(block.type) !== 'tool_result') continue;
      const toolId = str(block.tool_use_id);
      if (!toolId) continue;

      const failed = block.is_error === true;
      const output = toolResultText(block.content);

      // The result of a step inside a delegation, closing the row its
      // `tool_use` opened. `is_error` here is the *step* failing, which the
      // detail view shows without the run itself having failed.
      if (parent) {
        this.emit({
          t: 'agent_step',
          parentToolId: parent,
          step: {
            id: toolId,
            status: failed ? 'failed' : 'completed',
            output,
            error: failed ? output : undefined,
          },
        });
        continue;
      }

      this.emit({
        t: 'tool',
        toolId,
        patch: failed ? { status: 'failed', output, error: output } : { status: 'completed', output },
      });
    }
  }

  /**
   * This turn's own cost, from the running total the CLI reports.
   *
   * `total_cost_usd` on a `result` message is cumulative for the conversation,
   * not for the turn — probed against 2.1.220 by running two prompts through
   * one process (0.1286 then 0.1790, while the token counts stayed at 2 in / 6
   * out both times) and then a third through a `--resume` in a *new* process,
   * which continued from 0.1790 rather than restarting. Its sibling `usage`
   * object is per-turn; only the money is cumulative.
   *
   * Everything downstream sums what a turn reports, so left alone this charged
   * every conversation its own history again on every turn — the second turn of
   * a chat showed roughly triple its real cost, the tenth far worse. The
   * subtraction lives here because this is the one place that knows the
   * convention; `costBaselineUsd` carries the watermark across a restart, since
   * the CLI's counter survives one and an in-process variable does not.
   */
  private turnCost(reported: number | undefined): number | undefined {
    if (reported === undefined) return undefined;
    if (this.costBaselineUnknown) {
      this.costBaselineUnknown = false;
      this.costWatermark = reported;
      return undefined;
    }
    const spent = reported - this.costWatermark;
    this.costWatermark = Math.max(this.costWatermark, reported);
    // Clamped: a counter that went backwards means the baseline was wrong, and
    // a negative cost is not a measurement anyone can use.
    return spent > 0 ? spent : 0;
  }

  /**
   * The part of the `result` usage this turn has not already reported.
   *
   * Its sibling `total_cost_usd` is cumulative for the conversation and is
   * corrected in `turnCost`; the `usage` object beside it is per-turn, and
   * therefore repeats — field for field — what the turn's own messages already
   * reported on their `message_delta`. Everything downstream sums what a turn
   * reports, so passing it through unchanged counted every Claude token twice:
   * the live session readout, the meter and the recorded history all showed
   * double, consistently enough that nothing looked broken. Measured on the
   * `claude-oneshot` capture, where the two messages report 4 / 97 / 16402 /
   * 47287 between them and the result reports exactly 4 / 97 / 16402 / 47287.
   *
   * The remainder rather than nothing at all, because a turn whose messages
   * reported no usage — an error before the first `message_delta`, a shape a
   * future CLI invents — has nothing to have counted twice, and dropping the
   * result's figures there would lose the turn's only reading of itself.
   */
  private turnTokensLeft(reported: ChatUsage): ChatUsage | undefined {
    const left: ChatUsage = {};
    let any = false;
    for (const field of TOKEN_FIELDS) {
      const value = reported[field];
      if (typeof value !== 'number') continue;
      const already = this.turnTokensEmitted[field] ?? 0;
      // Clamped: a result that reports less than its own messages did means the
      // two are counting different things, and a negative token count is not a
      // measurement. Zero is, and it is the honest one — the tokens are already
      // on the messages.
      const remainder = value - already;
      left[field] = remainder > 0 ? remainder : 0;
      any = true;
    }
    this.turnTokensEmitted = {};
    return any ? left : undefined;
  }

  /**
   * The per-model breakdown, with its money put on the same footing as the turn.
   *
   * `modelUsage.*.costUSD` is a slice of `total_cost_usd`, and that counter is
   * cumulative over the conversation (see `turnCost` above — the reason this
   * adapter exists in the shape it does). Passing those figures straight
   * through would put a per-turn cost on the job and a whole-conversation cost
   * on the models inside it, and the by-model view would climb past the total
   * it is a breakdown of, turn after turn.
   *
   * So the *shares* are taken from the report and the turn's own cost is what
   * is divided by them. That is the one thing that stays true whichever way the
   * counter behaves: a runtime reporting per-turn figures gives shares of a
   * total equal to the turn's cost, which divides back to exactly what it
   * reported. Nothing is scaled up — the sum is the turn's own measured cost,
   * always.
   *
   * Tokens are left alone. Claude's `usage` is per-turn, not cumulative, and
   * the per-model token fields track it.
   */
  private modelBreakdown(raw: Record<string, unknown>, turnCostUsd: number | undefined) {
    const models = mapModelUsage(raw);
    if (!models) return undefined;

    const reported = models.reduce((total, entry) => total + (entry.usage?.costUsd ?? 0), 0);
    if (turnCostUsd === undefined || reported <= 0) {
      // No cost to divide, or nothing to divide it by. The models are still
      // named — which is the fact this exists for — and carry no money rather
      // than a made-up share of one.
      return models.map((entry) => {
        if (entry.usage?.costUsd === undefined) return entry;
        const { costUsd, ...rest } = entry.usage;
        return Object.keys(rest).length > 0 ? { ...entry, usage: rest } : { model: entry.model, calls: entry.calls };
      });
    }

    return models.map((entry) => {
      const share = entry.usage?.costUsd;
      if (share === undefined) return entry;
      return { ...entry, usage: { ...entry.usage, costUsd: (share / reported) * turnCostUsd } };
    });
  }

  /**
   * The `result` that closes a `/effort` turn, consumed instead of reported.
   *
   * Everything below this line in `handleResult` is skipped deliberately, and
   * each omission is the point rather than an oversight. No `turn_end`, because
   * no turn began — the user's own last turn ended long before this one was
   * written, and `activeTurnId` is left exactly as it was found. No usage, and
   * above all no visit to `turnCost`: that method moves a watermark on every
   * reading, and letting a turn Claude itself billed at `total_cost_usd: 0` and
   * `num_turns: 0` through it would consume a reading the *next* real turn needs
   * to measure itself against.
   *
   * What is taken is the level, and it is taken from Claude's own sentence:
   * "Set effort level to xhigh (this session only): ...". Reading it back rather
   * than echoing the level asked for is the difference between reporting what
   * the runtime did and reporting what this app requested — and they are the
   * same only until the day the CLI normalises a level, or accepts an alias, or
   * quietly clamps one. The level asked for is the fallback for a build that
   * words its confirmation differently, which is a small guess on top of a
   * success the runtime did report, and nothing like a guess on top of silence.
   *
   * A failed result is not a level at all. It rejects, emits nothing, and the
   * caller says `pending` — the same as never having been answered, which is
   * what it amounts to.
   */
  private consumeEffortResult(raw: Record<string, unknown>): void {
    const pending = this.pendingEffort;
    if (!pending) return;
    this.pendingEffort = null;
    clearTimeout(pending.timer);

    const text = str(raw.result) ?? '';
    // A refusal does not look like a failure, which is the trap this reads
    // around. Asked for a level it does not have, 2.1.220 answers
    // `{"is_error":false,"subtype":"success","result":"Invalid argument: ultra.
    // Valid options are: low, medium, high, xhigh, max, ultracode, auto"}` —
    // a *successful* result whose text is a rejection. Keying off `is_error`
    // alone reported that to the user as "Now thinking at ultra."
    //
    // So the confirmation sentence is the only thing that counts as one. There
    // is no falling back to the level that was asked for: the whole reason this
    // waits for an answer at all is to report what Claude did rather than what
    // this app requested, and a fallback would quietly undo that in exactly the
    // case where the two differ.
    const confirmed = /set effort level to (\w+)/i.exec(text)?.[1];
    if (raw.is_error === true || !confirmed) {
      pending.reject(new Error(text || `claude did not confirm the effort level ${pending.level}`));
      return;
    }

    this.emit({ t: 'effort', effort: confirmed });
    pending.resolve();
  }

  private handleResult(raw: Record<string, unknown>): void {
    if (this.pendingEffort) {
      this.consumeEffortResult(raw);
      return;
    }

    // The answer to a switch that was given up on. Dropped rather than reported:
    // nobody is waiting for it, the level it names may or may not have taken,
    // and letting it through here would close whatever turn is running now. See
    // `staleEffortResults`; `num_turns: 0` is Claude's own mark of a command it
    // answered without going near the model, which is what makes this safe to
    // key on rather than a guess at which result belongs to what.
    if (this.staleEffortResults > 0 && num(raw.num_turns) === 0) {
      this.staleEffortResults -= 1;
      return;
    }

    const subtype = str(raw.subtype);
    const isError = raw.is_error === true;

    const usageRaw = record(raw.usage);
    const costUsd = this.turnCost(num(raw.total_cost_usd));
    // The tokens this turn has not already reported (see `turnTokensLeft`),
    // the turn's own share of the cumulative cost, and the reading of how full
    // the window is — which is the last request's own figures, not the turn's
    // totals, so it is taken from `raw` rather than from what is emitted here.
    const tokens = usageRaw ? this.turnTokensLeft(mapUsage(usageRaw)) : undefined;
    const context = contextReading(raw);
    const usage: ChatUsage | undefined =
      tokens || costUsd !== undefined || Object.keys(context).length > 0
        ? {
            ...(tokens ?? {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...context,
          }
        : undefined;

    const sessionId = str(raw.session_id);
    if (sessionId) this.nativeSessionId = sessionId;

    if (isError) {
      // turn_end has no field for "why" -- surface the failure as its own
      // event so it actually lands in the transcript, the same path a
      // mid-stream error already takes.
      this.emit({
        t: 'error',
        message: str(raw.result) || `claude ended the turn as ${subtype ?? 'an error'}`,
      });
    }

    // `num_turns` is Claude's own count of the round trips this turn took, and
    // it now has somewhere to go (#86). It is not the turn count — the turn is
    // the whole of what this event ends — which is why it travels under its own
    // name, as the one figure here nobody had to infer.
    this.emit({
      t: 'turn_end',
      turnId: this.activeTurnId ?? randomUUID(),
      stopReason: str(raw.stop_reason) ?? subtype,
      usage,
      durationMs: num(raw.duration_ms),
      ...(() => {
        const modelTurns = num(raw.num_turns);
        return modelTurns === undefined ? {} : { modelTurns };
      })(),
      ...(() => {
        const models = this.modelBreakdown(raw, costUsd);
        return models ? { models } : {};
      })(),
      // `modelUsage` is where a Task subagent's spend surfaces: it runs on
      // whatever model it was launched with and appears here as a second key,
      // while the assistant messages in the transcript only ever carry the
      // main agent's. Without this a turn that delegated is filed entirely
      // against the model that did the delegating. Spread above rather than
      // assigned here, so a turn that reported none carries no key at all.
    });
    this.activeTurnId = null;
    this.currentMsgId = null;
  }
}

/**
 * How long a `/effort` turn may go unanswered before it is given up on.
 *
 * Generous by an order of magnitude, on purpose. The CLI answers this one in
 * milliseconds because no model is involved — `total_cost_usd: 0`,
 * `num_turns: 0`, handled locally — so anything approaching eight seconds is not
 * a slow answer but a CLI that never understood the question, and every one of
 * those seconds is spent with this adapter deaf to its own runtime (see the
 * suppression `setEffort` describes). Long enough that a machine under load
 * never trips it; short enough that a session which does is usable again well
 * before anybody reaches for the reload button.
 */
const EFFORT_TIMEOUT_MS = 8000;

/**
 * A task's own status word, mapped onto the transcript's tool statuses.
 *
 * Anything unrecognised becomes `running` rather than a guess at a terminal
 * state: showing a finished agent as still working is a cosmetic lag the next
 * event corrects, while showing a working agent as finished stops its detail
 * view updating for good.
 */
function toolStatus(value: string): ToolStatus {
  switch (value) {
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'denied':
      return 'denied';
    case 'pending':
    case 'queued':
      return 'pending';
    default:
      return 'running';
  }
}

/**
 * A workflow agent's reported state, in this app's words.
 *
 * The runtime's four are `start` (queued or just spawned), `progress`, `done`
 * and `error`. Anything else becomes `running` for the same reason `toolStatus`
 * does: an unknown word that settled a row would stop it ever updating again,
 * while one that leaves it working is corrected by the next report.
 */
function agentState(value: string | undefined): WorkflowAgentState {
  switch (value) {
    case 'start':
      return 'queued';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    default:
      return 'running';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The token fields this adapter maps. Cost is not one: it is cumulative.
 *
 * Spelled out rather than `keyof ChatUsage`, which stopped being a list of
 * token counts the moment that type grew a context reading — one of whose
 * fields is a word (`contextWindowSource`), and none of which is a quantity
 * this adds up.
 */
type TokenField = 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens';

const TOKEN_FIELDS: TokenField[] = [
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheReadTokens',
];

function mapUsage(raw: Record<string, unknown>): ChatUsage {
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
  };
}

/**
 * How big claude says the window is, and how much of it the last request filled.
 *
 * The capacity comes from claude's own `modelUsage` block, keyed by the model
 * as it ran — `claude-opus-5[1m]` reports 1,000,000 while the plain model does
 * not, so the bracketed suffix is load-bearing and the key is used verbatim
 * rather than canonicalised.
 *
 * Occupancy is the *last* iteration's figures, not the turn's totals. A turn
 * with four round trips reports four iterations, and adding their inputs
 * together describes work done rather than anything that was ever in the
 * window at one time — the last one is what actually sat there.
 */
function contextReading(raw: Record<string, unknown>): ChatUsage {
  const reading: ChatUsage = {};

  const modelUsage = record(raw.model_usage) ?? record(raw.modelUsage);
  if (modelUsage) {
    for (const value of Object.values(modelUsage)) {
      const window = num(record(value)?.contextWindow);
      if (window !== undefined && window > 0) {
        reading.contextWindow = window;
        reading.contextWindowSource = 'agent';
        break;
      }
    }
  }

  const usage = record(raw.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  const last = record(iterations[iterations.length - 1]) ?? usage;
  if (last) {
    const parts = [
      num(last.input_tokens),
      num(last.cache_read_input_tokens),
      num(last.cache_creation_input_tokens),
      num(last.output_tokens),
    ].filter((n): n is number => n !== undefined);
    if (parts.length > 0) {
      reading.contextUsed = parts.reduce((sum, n) => sum + n, 0);
    }
  }

  return reading;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = record(part);
        return p ? str(p.text) ?? '' : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export default ClaudeChatAdapter;
