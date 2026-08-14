/**
 * Abstract partial of {@link CodexAppServerAdapter}.
 *
 * Holds the app-server adapter's shared incoming/notification state (sub-agent
 * rows, item-block indexing, streaming channels, account and skill registries)
 * and the methods that drive them. Splitting the concrete adapter across this
 * abstract base + the leaf in codex-app-server.ts keeps every file under the
 * line budget while preserving the exact public surface of codex.ts.
 */
import type { ChatCapabilities, ChatUsage, PlanItem, SlashCommand, ToolBlock, ToolStatus } from '../../../../shared/chat-events.js';
import type { CodexTokenInput } from '../../../../shared/codex-pricing.js';
import { blockHasContent } from '../../../../shared/chat-visibility.js';
import { mergeSlashCommands } from '../../../../shared/slash-commands.js';
import { AccountLimitTracker, resetIsoFromEpochSeconds } from '../../account-limits.js';
import { JsonRpcChatAdapter } from '../../adapter.js';
import { record, str, num, list } from './codex-utils.js';
import {
  BufferedSubAgentNotification,
  CodexSubAgent,
  MAX_BUFFERED_SUB_AGENT_EVENTS,
  MAX_BUFFERED_SUB_AGENT_THREADS,
  TERMINAL_AGENT_STATUS,
  BUFFERED_SUB_AGENT_METHODS,
  childTurnStatus,
  codexSubAgentToolId,
  collabAgentStateStatus,
  subAgentActivityLabel,
  subAgentActivityStatus,
  subAgentStatusLabel,
  subAgentToolBlock,
  threadStatus,
} from './codex-subagent.js';
import { agentStepFrom, isToolItemType, itemToBlock } from './codex-mapping.js';
import { contextReading } from './codex-context.js';
import { CODEX_APP_COMMANDS, SKILLS_LIST_TIMEOUT_MS, initialCodexSkills } from './codex-launch.js';

export abstract class CodexAppServerAgentBase extends JsonRpcChatAdapter {
  protected threadId: string | null = null;
  protected model?: string;
  /**
   * The level codex itself said this thread opened at.
   *
   * `thread/start` and `thread/resume` both answer with a top-level
   * `reasoningEffort`, whether or not anything was asked for — with no config
   * at all a live probe came back `"xhigh"`, which is what this machine's own
   * codex configuration defaults to rather than anything this app chose. So it
   * is the runtime describing itself, and the only thing the `effort` event is
   * ever emitted on at launch.
   */
  protected reportedEffort: string | null = null;
  /**
   * The level to hang on every `turn/start` from here, once someone has asked
   * for one. Null until `setEffort` is called.
   *
   * Deliberately a second field rather than reusing `reportedEffort`. That one
   * is codex's word about the thread; this one is this app's standing request
   * for it. Folded together, either the launch level would be re-asserted on
   * every turn — pinning a level nobody picked onto a request codex does not
   * validate — or the record of what codex actually said would be overwritten
   * the first time the control was touched.
   */
  protected turnEffort: string | null = null;
  protected turnId: string | null = null;
  protected assistantMsgId: string | null = null;
  protected blockIndex = 0;
  /** itemId -> block index, for the item kinds `block_end` must address by position. */
  protected readonly itemBlockIndex = new Map<string, number>();
  protected readonly planText = new Map<string, string>();
  /** itemId -> which of a reasoning item's two channels is filling its block. */
  protected readonly reasoningChannel = new Map<string, 'content' | 'summary'>();
  /** Child thread id -> the one synthetic Agent block shown in the rail. */
  protected readonly subAgents = new Map<string, CodexSubAgent>();
  /**
   * A child starts running before its parent receives the activity item that
   * names it. Hold the small, structural part of that early stream until the
   * row exists; prose and deltas are deliberately not buffered.
   */
  protected readonly bufferedSubAgentNotifications = new Map<string, BufferedSubAgentNotification[]>();
  /** What codex has said about the account behind this thread. See `loadRateLimits`. */
  protected readonly account = new AccountLimitTracker();
  /** Skill names are public capabilities; their absolute manifest paths stay on the adapter. */
  protected skillPaths = initialCodexSkills(this.options);
  /** Latest request wins if a filesystem invalidation races launch-time discovery. */
  protected skillListGeneration = 0;

  protected withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`codex app-server: ${label} timed out`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Fold a rate-limit snapshot in, from either the request or the notification.
   *
   * Accepts the envelope or the snapshot itself because the two channels were
   * not both captured: the request answers `{ rateLimits: {...} }` and the
   * notification's shape is declared but unprobed, so the wrapper is unwrapped
   * when it is there and the payload used as-is when it is not.
   */
  protected onRateLimits(payload: Record<string, unknown>): void {
    const snapshot = payload.rateLimits === undefined ? payload : record(payload.rateLimits);
    let changed = this.account.notePlanName(str(snapshot.planType));
    for (const [key, kind] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
      // `secondary` is explicitly null in the captured reply, and null is not a
      // window. `record()` answers `{}` for it, so the presence of the key has
      // to be checked rather than the truthiness of what it maps to.
      if (!snapshot[key]) continue;
      const window = record(snapshot[key]);
      // `usedPercent` is a percentage where Claude's `utilization` is a
      // fraction, and the event carries fractions. Converted here rather than
      // at the surface so one renderer can draw both.
      const usedPercent = Number(window.usedPercent);
      const duration = Number(window.windowDurationMins);
      const resetsAt = resetIsoFromEpochSeconds(window.resetsAt);
      changed = this.account.noteWindow({
        kind,
        ...(Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
          ? { utilization: usedPercent / 100 }
          : {}),
        ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      }) || changed;
    }
    if (changed) this.emit({ t: 'limits', limits: this.account.snapshot() });
  }

  /**
   * Ask Codex for the enabled skills it can actually use from this cwd.
   *
   * This is a real v2 app-server request, not a guessed RPC. A live 0.135.0
   * response contains the shared `.agents` catalogue, plugin skills and Codex
   * system skills as well as the ordinary user directory. Only public names
   * and descriptions are emitted; manifest paths remain private here so they
   * can be attached to `turn/start` when a person selects a skill.
   */
  protected async loadSkillList(forceReload = false): Promise<void> {
    const generation = ++this.skillListGeneration;
    try {
      const params: Record<string, unknown> = { cwds: [this.runtimeWorkingDir] };
      if (forceReload) params.forceReload = true;
      const response = record(
        await this.withTimeout(
          this.call('skills/list', params),
          SKILLS_LIST_TIMEOUT_MS,
          'skills/list',
        ),
      );
      if (generation !== this.skillListGeneration) return;

      const commands: SlashCommand[] = [];
      const paths = new Map<string, { name: string; path: string }>();
      for (const rawEntry of list(response.data)) {
        for (const rawSkill of list(record(rawEntry).skills)) {
          const skill = record(rawSkill);
          if (skill.enabled !== true) continue;
          const name = str(skill.name)?.trim();
          const manifest = str(skill.path)?.trim();
          if (!name || !manifest) continue;
          const description =
            str(skill.description)
            || str(skill.shortDescription)
            || str(record(skill.interface).shortDescription);
          commands.push({ name, ...(description ? { description } : {}) });
          if (!paths.has(name.toLowerCase())) {
            paths.set(name.toLowerCase(), { name, path: manifest });
          }
        }
      }

      // A successful response is authoritative and replaces the disk stand-in:
      // among other things this takes disabled skills and removed legacy
      // prompts back off the menu. The app-owned reset commands remain because
      // they never travel to Codex in the first place.
      const available = mergeSlashCommands(CODEX_APP_COMMANDS, commands);
      this.skillPaths = paths;
      this.capabilities.commands = available;
      this.emit({ t: 'capabilities', capabilities: { commands: available } });
    } catch {
      // Old app-server builds have no method; slow ones may miss the timeout.
      // Both keep the initial disk stand-in, with no protocol error in chat.
    }
  }

  // ------------------------------------------------------------- incoming
  private ensureAssistantMessage(turnId: string): string {
    if (this.assistantMsgId && this.turnId === turnId) return this.assistantMsgId;
    this.turnId = turnId;
    this.assistantMsgId = `a_${turnId}`;
    this.blockIndex = 0;
    this.itemBlockIndex.clear();
    this.emit({ t: 'msg_start', id: this.assistantMsgId, role: 'assistant', turnId, model: this.model });
    return this.assistantMsgId;
  }

  protected handleNotification(method: string, params: Record<string, unknown>): void {
    const item = record(params.item);
    if (
      (method === 'item/started' || method === 'item/completed')
      && str(item.type) === 'subAgentActivity'
    ) {
      // Codex opens and completes this item immediately. Its completion means
      // "the activity was recorded", not "the child finished", so consume the
      // durable half once and let child turn/status notifications own liveness.
      if (method === 'item/completed') this.onSubAgentActivity(params, item);
      return;
    }

    const sourceThreadId = str(params.threadId);
    if (sourceThreadId && this.threadId && sourceThreadId !== this.threadId) {
      this.onForeignThreadNotification(sourceThreadId, method, params);
      return;
    }

    switch (method) {
      case 'turn/started':
        this.ensureAssistantMessage(str(record(params.turn).id) || str(params.turnId) || '');
        return;
      case 'item/started':
        this.onItem(params, false);
        return;
      case 'item/completed':
        this.onItem(params, true);
        return;
      case 'item/agentMessage/delta':
        this.onTextDelta(str(params.itemId) || '', str(params.delta) || '');
        return;
      case 'item/reasoning/textDelta':
        this.onReasoningDelta(str(params.itemId) || '', 'content', str(params.delta) || '');
        return;
      case 'item/reasoning/summaryTextDelta':
        // The other half of codex's reasoning channel, and for a model whose
        // raw trace is encrypted it is the only half that carries words. Both
        // are declared in codex's own schema export
        // (ReasoningTextDeltaNotification / ReasoningSummaryTextDeltaNotification)
        // and `item/completed` already prefers `content` over `summary`, so
        // the same precedence is applied to the live stream — see
        // `onReasoningDelta`. Dropping this was why a codex turn that only
        // ever summarised its reasoning streamed an empty panel (#120).
        this.onReasoningDelta(str(params.itemId) || '', 'summary', str(params.delta) || '');
        return;
      case 'item/plan/delta':
        this.onPlanDelta(str(params.itemId) || '', str(params.delta) || '');
        return;
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params);
        return;
      case 'account/rateLimits/updated':
        // Codex re-states the whole snapshot when it changes, so this is the
        // same payload the request answers with and goes through the same
        // mapper. Two readings of one window is also what turns a percentage
        // into a burn rate, which is why the update is worth listening for
        // rather than reading once at launch.
        this.onRateLimits(params);
        return;
      case 'skills/changed':
        // Codex defines this as an invalidation signal, not a delta. Re-read
        // the effective catalogue so installs, removals and enablement changes
        // are reflected without restarting the conversation.
        void this.loadSkillList(true);
        return;
      case 'turn/completed':
        this.onTurnCompleted(params);
        return;
      case 'error': {
        const error = record(params.error);
        this.emit({ t: 'error', message: str(error.message) || 'codex reported an error', fatal: false });
        return;
      }
      case 'turn/diff/updated':
        // Aggregates every file change in the turn into one combined diff.
        // ChatEvent has no turn-level diff slot (turn_end carries only
        // stopReason/usage/durationMs), and each fileChange item already
        // reports its own diff at item/completed, so this notification is
        // intentionally dropped rather than forced into a shape the shared
        // vocabulary does not have.
        return;
      default:
        // mcp status/hooks/account/... are not chat content this
        // adapter has scope to render. Dropping is correct, throwing is not.
        return;
    }
  }

  /**
   * One activity item becomes one durable delegation row.
   *
   * `started`, `interacted` and `interrupted` each have their own item id. The
   * child thread id is the only stable identity, so later activity patches the
   * first row instead of adding one row for every message sent to the child.
   */
  private onSubAgentActivity(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
  ): void {
    const threadId = str(item.agentThreadId);
    if (!threadId) return;

    const kind = str(item.kind) || '';
    const path = str(item.agentPath) || '';
    let agent = this.subAgents.get(threadId);
    if (!agent) {
      agent = {
        threadId,
        toolId: codexSubAgentToolId(threadId),
        path,
        status: subAgentActivityStatus(kind) || 'pending',
        announced: false,
        startedAt: num(params.completedAtMs) || num(params.startedAtMs),
        toolUses: 0,
        stepIds: new Set<string>(),
      };
      this.subAgents.set(threadId, agent);
    } else if (path) {
      agent.path = path;
    }

    const activityStatus = subAgentActivityStatus(kind);
    if (activityStatus) agent.status = activityStatus;

    if (kind === 'started' && !agent.announced) {
      const emittingThreadId = str(params.threadId);
      const rootEvent = !emittingThreadId || !this.threadId || emittingThreadId === this.threadId;
      const turnId = rootEvent ? str(params.turnId) || this.turnId : this.turnId;
      const msgId = this.assistantMsgId || (turnId ? this.ensureAssistantMessage(turnId) : null);
      if (msgId) {
        this.emit({
          t: 'block_start',
          msgId,
          index: this.blockIndex++,
          block: subAgentToolBlock(agent),
        });
        agent.announced = true;
      }
    }

    // An interrupt is the final word even when an older idle notification was
    // waiting for registration. For starts, the opposite is true: a very fast
    // child may already have completed, and that buffered outcome must win over
    // the merely historical fact that it started.
    if (kind === 'interrupted') this.drainBufferedSubAgentNotifications(agent);

    const label = agent.path || 'Codex agent';
    const input = {
      name: label,
      agentThreadId: threadId,
      activityId: str(item.id),
      ...(agent.prompt ? { description: agent.prompt } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    };
    const toolPatch: Partial<ToolBlock> = { input };
    if (activityStatus) {
      toolPatch.status = activityStatus;
      if (activityStatus === 'running' || activityStatus === 'pending') toolPatch.error = '';
    }
    this.emit({ t: 'tool', toolId: agent.toolId, patch: toolPatch });

    const progress: Record<string, unknown> = {
      activity: subAgentActivityLabel(kind, agent.path),
      subagentType: label,
    };
    if (activityStatus) {
      progress.status = activityStatus;
      if (activityStatus === 'running' || activityStatus === 'pending') progress.error = '';
    }
    this.emit({
      t: 'agent_progress',
      parentToolId: agent.toolId,
      patch: progress,
    });

    if (kind !== 'interrupted') this.drainBufferedSubAgentNotifications(agent);
  }

  /** Never let another Codex thread borrow the parent chat's message state. */
  private onForeignThreadNotification(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const agent = this.subAgents.get(threadId);
    if (agent) {
      this.onSubAgentNotification(agent, method, params);
      return;
    }

    // A spawned thread can announce its turn before spawn_agent has returned
    // the activity item to the parent. Buffer only bounded, final-shape events:
    // item completions contain aggregate output, so high-volume deltas add no
    // fidelity here and would make an unrecognised internal thread unbounded.
    if (!BUFFERED_SUB_AGENT_METHODS.has(method)) return;
    let buffered = this.bufferedSubAgentNotifications.get(threadId);
    if (!buffered) {
      if (this.bufferedSubAgentNotifications.size >= MAX_BUFFERED_SUB_AGENT_THREADS) return;
      buffered = [];
      this.bufferedSubAgentNotifications.set(threadId, buffered);
    }
    if (buffered.length < MAX_BUFFERED_SUB_AGENT_EVENTS) buffered.push({ method, params });
  }

  private drainBufferedSubAgentNotifications(agent: CodexSubAgent): void {
    const buffered = this.bufferedSubAgentNotifications.get(agent.threadId);
    if (!buffered) return;
    this.bufferedSubAgentNotifications.delete(agent.threadId);
    for (const notification of buffered) {
      this.onSubAgentNotification(agent, notification.method, notification.params);
    }
  }

  private onSubAgentNotification(
    agent: CodexSubAgent,
    method: string,
    params: Record<string, unknown>,
  ): void {
    switch (method) {
      case 'turn/started': {
        const turn = record(params.turn);
        const startedAt = num(turn.startedAt);
        if (startedAt !== undefined) agent.startedAt = startedAt * 1000;
        this.updateSubAgentStatus(agent, 'running', { activity: `Running ${agent.path || 'agent'}` });
        return;
      }

      case 'item/started':
        this.onSubAgentItem(agent, record(params.item), false);
        return;

      case 'item/completed':
        this.onSubAgentItem(agent, record(params.item), true);
        return;

      case 'turn/completed': {
        const turn = record(params.turn);
        const status = childTurnStatus(turn.status);
        if (!status) return;
        if (
          status === 'completed'
          && (agent.status === 'canceled' || agent.status === 'failed' || agent.status === 'denied')
        ) return;
        const error = str(record(turn.error).message);
        this.updateSubAgentStatus(agent, status, {
          activity:
            status === 'completed'
              ? `Completed ${agent.path || 'agent'}`
              : status === 'canceled'
                ? `Interrupted ${agent.path || 'agent'}`
                : status === 'failed'
                  ? `Failed ${agent.path || 'agent'}`
                  : `Running ${agent.path || 'agent'}`,
          durationMs: num(turn.durationMs),
          error,
        });
        return;
      }

      case 'thread/status/changed': {
        const status = threadStatus(params.status);
        if (!status) return;
        // Idle/unloaded is coarser than the child's own terminal verdict. It
        // may close a running child, but must not turn a known failure or
        // interruption into an apparent success.
        if (
          status === 'completed'
          && (agent.status === 'canceled' || agent.status === 'failed' || agent.status === 'denied')
        ) return;
        this.updateSubAgentStatus(agent, status, {
          activity:
            status === 'running'
              ? `Running ${agent.path || 'agent'}`
              : status === 'completed'
                ? `Completed ${agent.path || 'agent'}`
                : status === 'failed'
                  ? `Failed ${agent.path || 'agent'}`
                  : `No longer reporting ${agent.path || 'agent'}`,
        });
        return;
      }

      case 'error': {
        const message = str(record(params.error).message) || 'Codex subagent failed';
        this.updateSubAgentStatus(agent, 'failed', {
          activity: `Failed ${agent.path || 'agent'}`,
          error: message,
        });
        return;
      }

      default:
        return;
    }
  }

  private onSubAgentItem(
    agent: CodexSubAgent,
    item: Record<string, unknown>,
    completed: boolean,
  ): void {
    const block = itemToBlock(item);
    if (!block) return;

    if (block.kind === 'tool') {
      const first = !agent.stepIds.has(block.toolId);
      if (first) {
        agent.stepIds.add(block.toolId);
        agent.toolUses += 1;
      }
      this.emit({
        t: 'agent_step',
        parentToolId: agent.toolId,
        step: agentStepFrom(block),
      });
      this.emit({
        t: 'agent_progress',
        parentToolId: agent.toolId,
        patch: {
          activity: completed ? `Finished ${block.name}` : `Using ${block.name}`,
          lastTool: block.name,
          toolUses: agent.toolUses,
        },
      });
      return;
    }

    if (!completed) return;
    if (block.kind === 'text' && block.text.trim()) {
      this.emit({ t: 'tool', toolId: agent.toolId, patch: { output: block.text } });
      this.emit({
        t: 'agent_progress',
        parentToolId: agent.toolId,
        patch: { activity: `Reported back from ${agent.path || 'agent'}` },
      });
      return;
    }
    if (block.kind === 'plan') {
      const plan = block.items.map((entry) => entry.text).find((text) => text.trim());
      if (plan) {
        this.emit({
          t: 'agent_progress',
          parentToolId: agent.toolId,
          patch: { activity: plan.replace(/\s+/g, ' ').trim().slice(0, 140) },
        });
      }
    }
  }

  private updateSubAgentStatus(
    agent: CodexSubAgent,
    status: ToolStatus,
    details: { activity?: string; durationMs?: number; error?: string } = {},
  ): void {
    agent.status = status;
    // A retained child can receive a later follow-up after failing. Empty is
    // intentional rather than undefined: events cross JSON boundaries, and
    // the reducer only assigns defined progress fields, so this is the one
    // serialisable way to clear the previous run's error on a genuine reopen.
    const error = details.error ?? (status === 'running' || status === 'pending' ? '' : undefined);
    const durationMs = details.durationMs
      ?? (TERMINAL_AGENT_STATUS.has(status) && agent.startedAt !== undefined
        ? Math.max(0, Date.now() - agent.startedAt)
        : undefined);
    this.emit({
      t: 'tool',
      toolId: agent.toolId,
      patch: {
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    });
    this.emit({
      t: 'agent_progress',
      parentToolId: agent.toolId,
      patch: {
        status,
        ...(details.activity ? { activity: details.activity } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    });
  }

  private onItem(params: Record<string, unknown>, completed: boolean): void {
    const item = record(params.item);
    const type = str(item.type);
    if (!type) return;
    if (type === 'userMessage' || type === 'hookPrompt') return; // send() already represented the user's turn

    const itemId = str(item.id) || '';
    const turnId = str(params.turnId) || this.turnId || itemId;
    const msgId = this.ensureAssistantMessage(turnId);

    if (isToolItemType(type)) {
      const block = itemToBlock(item);
      if (!block) return;
      if (!completed) {
        this.emit({ t: 'block_start', msgId, index: this.blockIndex++, block });
        this.emit({ t: 'state', state: 'running' });
        return;
      }
      // Completion patches by toolId wherever the block landed -- the same
      // channel a delayed result would use, so a completed item whose
      // "started" notification a reconnect missed still renders.
      if (block.kind === 'tool') this.emit({ t: 'tool', toolId: itemId, patch: block });
      if (type === 'collabAgentToolCall') {
        this.onLegacyCollabAgentActivity(params, item, msgId);
      }
      return;
    }

    // Non-tool items (agentMessage, reasoning, plan, and the unmapped
    // fallback) need block_end addressing by position: only a ToolBlock can
    // be patched by id after the fact.
    if (!completed) {
      const block = itemToBlock(item);
      if (!block) return;
      const index = this.blockIndex++;
      this.itemBlockIndex.set(itemId, index);
      this.emit({ t: 'block_start', msgId, index, block });
      return;
    }

    const block = itemToBlock(item);
    if (!block) return;
    const index = this.itemBlockIndex.get(itemId);
    if (index === undefined) {
      // item/completed with no matching item/started: nothing was
      // streaming, so open and close it in the same breath. This is the one
      // place the text is final at the moment the block is opened, so it is
      // where a reply that says nothing is refused rather than recorded — a
      // blank one would make the step "a step that spoke" and earn it a
      // bordered row with nothing to read (#132).
      //
      // `blockHasContent` and not `blockDraws`: what is refused here is a block
      // with nothing in it, never a block that merely earns no row. A tool call
      // and a reasoning block both draw nothing on their own and both have to be
      // written down anyway — the display fold takes the row away afterwards,
      // from the record, and the trace keeps them either way.
      if (!blockHasContent(block)) return;
      const fresh = this.blockIndex++;
      this.itemBlockIndex.set(itemId, fresh);
      this.emit({ t: 'block_start', msgId, index: fresh, block });
      return;
    }
    this.emit({ t: 'block_end', msgId, index, block });
  }

  /**
   * Older Codex collaboration calls carry target state on the management tool
   * item instead of publishing `subAgentActivity`. Keep the management call in
   * the trace, and additionally project each target child onto the same stable
   * Agent row the newer protocol uses.
   */
  private onLegacyCollabAgentActivity(
    params: Record<string, unknown>,
    item: Record<string, unknown>,
    msgId: string,
  ): void {
    const states = record(item.agentsStates);
    const receiverIds = new Set(
      [
        ...list(item.receiverThreadIds).filter((entry): entry is string => typeof entry === 'string'),
        ...Object.keys(states),
      ].filter(Boolean),
    );
    if (receiverIds.size === 0) return;

    const prompt = str(item.prompt);
    const model = str(item.model);
    const callFailed = str(item.status) === 'failed';
    for (const threadId of receiverIds) {
      const reported = collabAgentStateStatus(states[threadId]);
      let agent = this.subAgents.get(threadId);
      if (!agent) {
        agent = {
          threadId,
          toolId: codexSubAgentToolId(threadId),
          path: '',
          status: reported || (callFailed ? 'failed' : 'running'),
          announced: false,
          startedAt: num(params.completedAtMs) || num(params.startedAtMs),
          toolUses: 0,
          stepIds: new Set<string>(),
          prompt,
          model,
        };
        this.subAgents.set(threadId, agent);
      } else {
        if (prompt) agent.prompt = prompt;
        if (model) agent.model = model;
      }

      if (!agent.announced) {
        this.emit({
          t: 'block_start',
          msgId,
          index: this.blockIndex++,
          block: subAgentToolBlock(agent),
        });
        agent.announced = true;
      }

      const status = reported || (callFailed ? 'failed' : undefined);
      if (status) {
        const message = str(record(states[threadId]).message);
        this.updateSubAgentStatus(agent, status, {
          activity: subAgentStatusLabel(status, agent.path),
          ...(status === 'failed' && message ? { error: message } : {}),
        });
        if (status === 'completed' && message) {
          this.emit({ t: 'tool', toolId: agent.toolId, patch: { output: message } });
        }
      }
      this.drainBufferedSubAgentNotifications(agent);
    }
  }

  private onTextDelta(itemId: string, delta: string): void {
    if (!delta || !this.assistantMsgId) return;
    const index = this.itemBlockIndex.get(itemId);
    if (index === undefined) return; // a delta before its item opened; drop rather than guess a position
    this.emit({ t: 'block_delta', msgId: this.assistantMsgId, index, text: delta });
  }

  /**
   * A reasoning item growing, from whichever of its two channels is speaking.
   *
   * Codex streams the trace and the summary of the same item down separate
   * notifications, and appending both would interleave two accounts of one
   * thought. `content` wins where it is offered — the same precedence
   * `itemToBlock` applies when the item completes — and a summary already
   * streamed is cleared out of the way rather than left with the trace
   * appended to its tail.
   */
  private onReasoningDelta(itemId: string, channel: 'content' | 'summary', delta: string): void {
    if (!delta || !this.assistantMsgId) return;
    const index = this.itemBlockIndex.get(itemId);
    if (index === undefined) return;
    const current = this.reasoningChannel.get(itemId);
    if (current === 'content' && channel === 'summary') return;
    if (current !== channel) {
      this.reasoningChannel.set(itemId, channel);
      // Only reachable when a summary was streaming and the trace arrived
      // after it: replace rather than append, so the panel holds one of them.
      if (current === 'summary') {
        this.emit({
          t: 'block_end',
          msgId: this.assistantMsgId,
          index,
          block: { kind: 'thinking', text: '' },
        });
      }
    }
    this.emit({ t: 'block_delta', msgId: this.assistantMsgId, index, text: delta });
  }

  private onPlanDelta(itemId: string, delta: string): void {
    if (!delta) return;
    const text = (this.planText.get(itemId) || '') + delta;
    this.planText.set(itemId, text);
    const items: PlanItem[] = [{ text, status: 'in_progress' }];
    this.emit({ t: 'plan', items });

    const index = this.itemBlockIndex.get(itemId);
    if (index !== undefined && this.assistantMsgId) {
      // block_delta only appends for text/thinking blocks; a plan block's
      // items[] is instead overwritten wholesale on every delta, which
      // block_end already supports without any special-casing.
      this.emit({ t: 'block_end', msgId: this.assistantMsgId, index, block: { items } });
    }
  }

  private onTokenUsage(params: Record<string, unknown>): void {
    const usage = record(params.tokenUsage);
    const total = record(usage.total);
    if (!Object.keys(total).length) return;
    // `total` is already a cumulative absolute figure, which is exactly what
    // the standalone `usage` event expects (it overwrites rather than
    // sums). Attaching it to msg_end/turn_end as well -- which merge
    // *additively* -- would double-count on top of this on every turn, so
    // this is the only channel usage travels on for this adapter.
    const emitted: ChatUsage = {
      inputTokens: num(total.inputTokens),
      outputTokens: num(total.outputTokens),
      cacheReadTokens: num(total.cachedInputTokens),
      reasoningTokens: num(total.reasoningOutputTokens),
      totalTokens: num(total.totalTokens),
      ...contextReading(usage, total, this.model),
    };

    // Price the cumulative usage this report describes against the confirmed
    // model, when there is an estimator to ask. The figure is a cumulative
    // estimate (like the tokens beside it), labelled 'estimated' so every
    // surface that shows money knows it was computed, not reported. Absent an
    // estimator or a rate for the model, the event stays tokens-only and the
    // client shows price-unavailable rather than a guessed number.
    if (this.options.codexPricing) {
      const estimate = this.options.codexPricing.estimate(
        emitted as CodexTokenInput,
        this.model,
      );
      if (estimate) {
        emitted.costUsd = estimate.costUsd;
        emitted.costSource = 'estimated';
        emitted.costEstimate = estimate;
      }
    }

    this.emit({ t: 'usage', usage: emitted });
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    const turn = record(params.turn);
    const turnId = str(turn.id) || this.turnId || '';
    const status = str(turn.status);
    const durationMs = num(turn.durationMs);

    if (this.assistantMsgId) {
      this.emit({ t: 'msg_end', msgId: this.assistantMsgId, stopReason: status });
    }
    if (status === 'failed') {
      const error = record(turn.error);
      this.emit({ t: 'error', message: str(error.message) || 'codex turn failed', fatal: false });
    }
    this.emit({ t: 'turn_end', turnId, stopReason: status, durationMs });

    this.turnId = null;
    this.assistantMsgId = null;
    this.itemBlockIndex.clear();
    this.planText.clear();
    this.reasoningChannel.clear();
  }
}



