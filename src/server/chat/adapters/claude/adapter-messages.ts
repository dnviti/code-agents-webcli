import { randomUUID } from 'node:crypto';
import { describeSlashCommand } from '../../../../shared/slash-commands.js';
import { TERMINAL_TOOL } from '../../../../shared/agent-activity.js';
import {
  ChatBlock,
  ToolStatus,
  WorkflowAgent,
  WorkflowPhase,
  classifyTool,
} from '../../../../shared/chat-events.js';
import { describeFrom } from '../../installed-commands.js';
import { resetIsoFromEpochSeconds } from '../../account-limits.js';
import { ClaudeChatAdapterAccounting } from './adapter-accounting.js';
import { CONFIGURED_KEY_SOURCES, TOKEN_FIELDS } from './constants.js';
import { mapUsage } from './usage.js';
import {
  agentState,
  failureReason,
  num,
  record,
  str,
  toolResultText,
  toolStatus,
} from './util.js';

/**
 * The message-decoding half of the Claude adapter chain: routing each parsed
 * stdout line to a handler, and translating the run's `stream_event`,
 * `assistant`/`user` snapshot, task and rate-limit channels into transcript
 * events. This is where `handleMessage` — the dispatch entry point — lives,
 * above the accounting and effort partials whose `result`/`effort` handling it
 * forwards to.
 */
export abstract class ClaudeChatAdapterMessages extends ClaudeChatAdapterAccounting {
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
        this.handleRateLimit(raw);
        return;
      default:
        return;
    }
  }

  protected handleSystem(raw: Record<string, unknown>): void {
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
    if (
      subtype === 'task_started'
      || subtype === 'task_progress'
      || subtype === 'task_updated'
      || subtype === 'task_notification'
    ) {
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
  protected handleThinkingTokens(raw: Record<string, unknown>): void {
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
   *
   * `task_notification` is the run's last word — a status and a sentence about
   * how it went, on the same `tool_use_id`. It used to be dropped with the
   * hooks and the other session plumbing, which is why a workflow could fail
   * and say so nowhere (#140).
   */
  protected handleTask(subtype: string, raw: Record<string, unknown>): void {
    const taskId = str(raw.task_id);
    const direct = str(raw.tool_use_id);
    if (direct && taskId) this.tasksByTaskId.set(taskId, direct);
    const parentToolId = direct ?? (taskId ? this.tasksByTaskId.get(taskId) : undefined);
    if (!parentToolId) return;

    // `local_workflow` is the only thing that separates a workflow from an
    // ordinary delegation here, and it is said once, on the report that opens
    // the run. See `workflowTasks`.
    if (subtype === 'task_started' && str(raw.task_type) === 'local_workflow') {
      this.workflowTasks.set(parentToolId, str(raw.workflow_name));
    }

    if (subtype === 'task_notification') {
      // The runtime's other way of saying the same thing, and the only one that
      // arrives if `task_updated` does not. It does *not* win where both do:
      // `task_updated` is a line earlier in the capture and carries the error
      // itself, where this wraps it in the run's own description sentence —
      // which names the workflow by something no other surface calls it.
      // `announceWorkflowFailure` is first-wins, so whichever lands is the one.
      const reported = str(raw.status);
      if (reported === 'failed') {
        this.announceWorkflowFailure(parentToolId, str(raw.summary));
      } else if (reported && TERMINAL_TOOL.has(toolStatus(reported))) {
        // The fallback channel for the ending, as it is for the failure: this
        // is the one that arrives when `task_updated` does not (#116).
        this.settleWorkflow(parentToolId, toolStatus(reported));
      }
      return;
    }

    if (subtype === 'task_updated') {
      const patch = record(raw.patch);
      const status = str(patch?.status);
      this.emit({
        t: 'agent_progress',
        parentToolId,
        patch: { status: status ? toolStatus(status) : undefined, error: str(patch?.error) },
      });
      if (status && toolStatus(status) === 'failed') {
        this.announceWorkflowFailure(parentToolId, str(patch?.error));
      } else if (status && TERMINAL_TOOL.has(toolStatus(status))) {
        // How the run itself ended — done, or cancelled. Until this, the only
        // ending that ever reached the launching call was the launch (#116).
        this.settleWorkflow(parentToolId, toolStatus(status), str(patch?.error));
      }
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
   * A workflow run failed, said once and out loud.
   *
   * Only for a workflow. An ordinary delegation that fails is already reported
   * by the tool result that closes it, and how it reports is out of #140's
   * scope — where a workflow's launching call closes on the *launch*, four
   * seconds and an entire run before there is anything to be right about.
   *
   * Both halves of the runtime's terminal report can reach here — the
   * `task_updated` patch, which carries the raw error, and the
   * `task_notification`, which carries a sentence — and in the captured run
   * both do. The first one wins and the second is dropped: they describe one
   * failure, and two would read as two.
   */
  protected announceWorkflowFailure(parentToolId: string, reason: string | undefined): void {
    if (!this.workflowTasks.has(parentToolId)) return;
    if (this.failedWorkflows.has(parentToolId)) return;
    this.failedWorkflows.add(parentToolId);
    this.emit({
      t: 'workflow_failed',
      parentToolId,
      name: this.workflowTasks.get(parentToolId),
      reason: failureReason(reason),
    });
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
  protected emitWorkflowProgress(parentToolId: string, reported: unknown): void {
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

  /**
   * The only account figures Anthropic gives a client, and the app used to drop
   * them on the floor while drawing a meter against a table of guesses (#137).
   *
   * What arrives is a status word, a reset time and a window name; `utilization`
   * turns up only once a warning threshold has been passed — four of the five
   * recorded events carry no percentage at all. So the percentage is copied
   * when present and left out otherwise, and the surface shows a reset time on
   * its own rather than a bar that reads 0%.
   *
   * Never an error, whatever the status says: `allowed_warning` is a warning
   * about the account, not a failure of this turn, and the turn carries on.
   */
  protected handleRateLimit(raw: Record<string, unknown>): void {
    const info = record(raw.rate_limit_info);
    if (!info) return;
    const kind = str(info.rateLimitType);
    if (!kind) return;

    // Claude reports this as a fraction — `utilization: 0.96` alongside
    // `surpassedThreshold: 0.75`, both of them fractions in the same line — and
    // that is what `AccountLimitWindow.utilization` means. Anything outside 0..1
    // is a units change nobody has verified, and is dropped rather than drawn.
    const utilization = Number(info.utilization);
    const changed = this.account.noteWindow({
      kind,
      ...(Number.isFinite(utilization) && utilization >= 0 && utilization <= 1
        ? { utilization }
        : {}),
      ...(str(info.status) ? { status: str(info.status) as string } : {}),
      ...(resetIsoFromEpochSeconds(info.resetsAt)
        ? { resetsAt: resetIsoFromEpochSeconds(info.resetsAt) as string }
        : {}),
    });
    if (changed) this.emit({ t: 'limits', limits: this.account.snapshot() });
  }

  protected handleInit(raw: Record<string, unknown>): void {
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
    // How this conversation is billed, in Claude's own words. `apiKeySource` is
    // `'none'` when the CLI is running on a signed-in subscription and names
    // the variable or helper when it is running on a key.
    //
    // Absent is its own answer and the common one — half the recorded init
    // lines have no such field — so it becomes `unknown` rather than
    // `subscription`. Guessing here would put a claim about somebody's billing
    // on screen that nobody ever made (#137).
    //
    // An allow-list rather than "anything that is not `none`", because the CLI
    // has a fourth answer that is neither. Read off 2.1.220's own resolver:
    // `ZO()` returns `ANTHROPIC_API_KEY`, `apiKeyHelper`, `none`, or the
    // `eRt()` fallback `{key: config.primaryApiKey, source: "/login managed
    // key"}` — a key `/login` provisioned into `~/.claude.json`, which the same
    // build groups with a claude.ai login rather than with a configured key
    // (`if (t === "claude.ai" || o === "/login managed key")` when it looks up
    // the organisation and the email address). That is an ambiguous source, and
    // this change's whole rule is that an ambiguous source reads `unknown`
    // instead of becoming a confident claim (#137).
    const apiKeySource = str(raw.apiKeySource);
    const billing = apiKeySource === undefined
      ? 'unknown'
      : apiKeySource === 'none'
        ? 'subscription'
        : CONFIGURED_KEY_SOURCES[apiKeySource] ? 'api-key' : 'unknown';
    if (this.account.noteBilling(billing)) {
      this.emit({ t: 'limits', limits: this.account.snapshot() });
    }
    this.emit({ t: 'effort', effort: this.options.effort ?? null });
    // Nothing is running yet; the first `system/status: requesting` (sent
    // once a prompt actually lands) is what moves this on to `thinking`.
    this.emit({ t: 'state', state: 'idle' });
  }

  protected handleStatus(raw: Record<string, unknown>): void {
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

  protected handleStreamEvent(raw: Record<string, unknown>): void {
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

  protected handleMessageStart(event: Record<string, unknown>): void {
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

  protected handleContentBlockStart(event: Record<string, unknown>): void {
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

  protected handleContentBlockDelta(event: Record<string, unknown>): void {
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

  protected handleContentBlockStop(event: Record<string, unknown>): void {
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

  protected handleMessageDelta(event: Record<string, unknown>): void {
    const delta = record(event.delta);
    this.pendingStopReason = delta ? str(delta.stop_reason) : undefined;
    const usageRaw = record(event.usage);
    this.pendingUsage = usageRaw ? mapUsage(usageRaw) : undefined;
  }

  protected handleMessageStop(): void {
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
  protected materialiseSnapshot(
    raw: Record<string, unknown>,
    message: Record<string, unknown> | undefined,
    content: unknown[],
  ): void {
    const text = content
      .map((entry) => record(entry))
      .filter((block): block is Record<string, unknown> => Boolean(block) && str(block!.type) === 'text')
      .map((block) => str(block.text) ?? '')
      .join('');
    // Not `!text`: a reply that is only whitespace is a reply that says
    // nothing, and recorded as content it earns the step a bordered row with
    // nothing to read in it (#132). This is a whole snapshot rather than a
    // stream, so there is no open block for a lone space to belong to.
    if (!text.trim()) return;

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

  protected handleAssistantSnapshot(raw: Record<string, unknown>): void {
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
  protected handleUserEcho(raw: Record<string, unknown>): void {
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

      // A background workflow's `tool_result` is a receipt, not a result (#116).
      //
      // It comes back seconds after the launch — "Workflow launched in
      // background. Task ID: …" — while the run itself goes on for minutes, and
      // filing it as the call's completion is what put a green **done** badge on
      // a workflow that was still working, took it out of the Agents panel's
      // running count, and captioned the acknowledgement as the run's final
      // output. The call stays running and is settled by the run's own report
      // instead; see `settleWorkflow`.
      //
      // A refusal is left alone: `failed` here means the launch itself did not
      // happen, which really is how that call ended.
      if (!failed && this.isWorkflowLaunch(toolId, output)) {
        this.emit({
          t: 'tool',
          toolId,
          patch: { status: 'running', output, launchReceipt: true },
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
   * Whether this tool result is a background workflow's launch acknowledgement.
   *
   * Two ways of knowing, because either alone has a hole. `task_started` names
   * the run a workflow and arrives before the result in both recordings — but
   * only if that line was seen at all, which a reconnect mid-turn does not
   * guarantee. The acknowledgement also says what it is, in the sentence the
   * issue quotes, so a run whose opening report was missed is still recognised.
   */
  protected isWorkflowLaunch(toolId: string, output: string): boolean {
    if (this.workflowTasks.has(toolId)) return true;
    return /^Workflow launched in background\b/.test(output.trimStart());
  }

  /**
   * The run itself ended, so the call that launched it ends with it (#116).
   *
   * Said once, first report wins, in the same shape as `announceWorkflowFailure`
   * and for the same reason: both of the runtime's terminal channels can reach
   * here and in the captured run both do.
   *
   * Only for a workflow. An ordinary delegation's launching call already closes
   * on its own result, and changing that is explicitly not what this is for.
   * Failure is left to `workflow_failed`, which does more than set a status —
   * it also puts the reason in the conversation.
   */
  protected settleWorkflow(parentToolId: string, status: ToolStatus, error?: string): void {
    if (status === 'failed') return;
    if (!this.workflowTasks.has(parentToolId)) return;
    if (this.settledWorkflows.has(parentToolId)) return;
    this.settledWorkflows.add(parentToolId);
    this.emit({
      t: 'tool',
      toolId: parentToolId,
      patch: { status, ...(error ? { error } : {}) },
    });
  }
}
