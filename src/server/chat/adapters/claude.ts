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
  classifyTool,
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
  /** Indices of open tool_use blocks in the current message, cleared per message. */
  private readonly openToolIndices = new Set<number>();
  /**
   * `task_id` → the `tool_use_id` of the call that started it.
   *
   * `task_updated` identifies the run only by `task_id`, so the pairing seen on
   * `task_started` is what lets its closing status reach the right delegation.
   */
  private readonly tasksByTaskId = new Map<string, string>();

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
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    return args;
  }

  async send(turn: UserTurn): Promise<void> {
    this.activeTurnId = randomUUID();
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
    // hook_started / hook_response / anything else is session-internal
    // plumbing a transcript viewer has no use for.
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
        prompt: subtype === 'task_started' ? str(raw.prompt) : undefined,
        toolUses: num(usage?.tool_uses),
        totalTokens: num(usage?.total_tokens),
        durationMs: num(usage?.duration_ms),
        status: subtype === 'task_started' ? 'running' : undefined,
      },
    });
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
    // Nothing is running yet; the first `system/status: requesting` (sent
    // once a prompt actually lands) is what moves this on to `thinking`.
    this.emit({ t: 'state', state: 'idle' });
  }

  private handleStatus(raw: Record<string, unknown>): void {
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
  private handleAssistantSnapshot(raw: Record<string, unknown>): void {
    const message = record(raw.message);
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const parent = str(raw.parent_tool_use_id);
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

  private handleResult(raw: Record<string, unknown>): void {
    const subtype = str(raw.subtype);
    const isError = raw.is_error === true;

    const usageRaw = record(raw.usage);
    const costUsd = this.turnCost(num(raw.total_cost_usd));
    const usage: ChatUsage | undefined =
      usageRaw || costUsd !== undefined
        ? { ...(usageRaw ? mapUsage(usageRaw) : {}), ...(costUsd !== undefined ? { costUsd } : {}) }
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

    // num_turns (the internal round-trip count for this turn) has nowhere
    // to go: turn_end carries stopReason/usage/durationMs only. Dropped
    // rather than misfiled into one of those.
    this.emit({
      t: 'turn_end',
      turnId: this.activeTurnId ?? randomUUID(),
      stopReason: str(raw.stop_reason) ?? subtype,
      usage,
      durationMs: num(raw.duration_ms),
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapUsage(raw: Record<string, unknown>): ChatUsage {
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
  };
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
