import { spawn } from 'child_process';
import {
  ChatCapabilities,
  DiffHunk,
  FileDiff,
  NO_CHAT_CAPABILITIES,
  PermissionOption,
  PlanItem,
  ToolKind,
  ToolStatus,
  UserTurn,
  classifyTool,
  defaultPermissionOptions,
} from '../../../shared/chat-events.js';
import {
  AdapterChild,
  AdapterEvent,
  BaseChatAdapter,
  ChatAdapter,
  ChatAdapterOptions,
  JsonRpcChatAdapter,
  permissionRequest,
} from '../adapter.js';

/**
 * Codex app-server (`codex app-server`, JSON-RPC 2.0 over stdio) and its
 * fallback, `codex exec --json`.
 *
 * Verified against the generated bindings the CLI itself ships
 * (`.work/probes/raw/codex-ts`), not against a live capture — app-server
 * has no recorded traffic in this repo, only the schema. Field names and
 * notification methods below are taken from those `.ts` files verbatim;
 * where the schema left something ambiguous (reasoning's multi-part content,
 * the aggregate turn diff) the choice made is called out inline.
 *
 * Two turn-lifecycle notifications carry the same information over two
 * channels: `turn/start`'s own RPC response and the `turn/started`
 * notification. `ensureAssistantMessage` treats both as the same trigger so
 * whichever arrives first opens the message and the second is a no-op.
 *
 * codex-rs appears to share one `ThreadItem` enum between app-server and
 * `exec --json` (both entry points sit on the same core crate), so
 * `itemToBlock` is shared between the two adapters below on that assumption.
 * It is the one thing in this file not directly confirmed by a fixture for
 * the exec path — see the class comment on `CodexExecAdapter`.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --------------------------------------------------------------- diffs

/**
 * Parse a unified diff body into hunks.
 *
 * Only the `@@ ... @@` header and the lines between headers are meaningful;
 * `--- a/x` / `+++ b/x` file headers (when present) sit before the first
 * header and are skipped because `current` is still null at that point.
 */
function parseUnifiedDiff(text: string): { hunks: DiffHunk[]; added: number; removed: number } {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let current: DiffHunk | null = null;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of text.split('\n')) {
    const match = header.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] !== undefined ? Number(match[2]) : 1,
        newStart: Number(match[3]),
        newLines: match[4] !== undefined ? Number(match[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  return { hunks, added, removed };
}

/** A whole file rendered as one hunk, for approvals where codex sends raw content instead of a diff. */
function wholeFileHunk(content: string, sign: '+' | '-'): DiffHunk {
  const lines = content.length ? content.split('\n') : [];
  // The file's own trailing newline is a terminator, not an extra line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `${sign}${line}`);
  return sign === '+'
    ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: body.length, lines: body }
    : { oldStart: 1, oldLines: body.length, newStart: 0, newLines: 0, lines: body };
}

/**
 * `ApplyPatchApprovalParams.fileChanges[path]` -> FileDiff.
 *
 * This is the *approval-time* shape (`FileChange`), distinct from the
 * *item* shape below (`FileUpdateChange`): `add`/`delete` here carry whole
 * file content, not a diff, because the user is being asked to approve a
 * patch that has not run yet.
 */
function fileChangeToFileDiff(path: string, change: Record<string, unknown>): FileDiff {
  const type = str(change.type);
  if (type === 'add') {
    const hunk = wholeFileHunk(str(change.content) || '', '+');
    return { path, kind: 'create', hunks: [hunk], added: hunk.lines.length, removed: 0 };
  }
  if (type === 'delete') {
    const hunk = wholeFileHunk(str(change.content) || '', '-');
    return { path, kind: 'delete', hunks: [hunk], added: 0, removed: hunk.lines.length };
  }
  const movePath = str(change.move_path);
  const { hunks, added, removed } = parseUnifiedDiff(str(change.unified_diff) || '');
  return {
    path: movePath || path,
    oldPath: movePath ? path : undefined,
    kind: movePath ? 'rename' : 'update',
    hunks,
    added,
    removed,
  };
}

/**
 * A `fileChange` item's own `changes[]` -> FileDiff.
 *
 * Unlike the approval shape above, every `FileUpdateChange` (add, delete or
 * update) carries a `diff` string, so one parse path covers all three kinds.
 */
function fileUpdateChangeToFileDiff(change: Record<string, unknown>): FileDiff {
  const path = str(change.path) || '';
  const kind = record(change.kind);
  const kindType = str(kind.type);
  const movePath = kindType === 'update' ? str(kind.move_path) || '' : '';
  const { hunks, added, removed } = parseUnifiedDiff(str(change.diff) || '');
  return {
    path: movePath || path,
    oldPath: movePath ? path : undefined,
    kind: kindType === 'add' ? 'create' : kindType === 'delete' ? 'delete' : movePath ? 'rename' : 'update',
    hunks,
    added,
    removed,
  };
}

function fileChangeTitle(changes: unknown[]): string {
  if (changes.length === 1) return str(record(changes[0]).path) || 'a file';
  return `${changes.length} files`;
}

// ------------------------------------------------------------ item mapping

/** codex-rs's four-state statuses (commandExecution, fileChange) and its three-state ones share this. */
function toolStatus(value: unknown): ToolStatus {
  switch (str(value)) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'denied';
    default:
      return 'pending';
  }
}

const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'collabAgentToolCall',
]);

function isToolItemType(type: string): boolean {
  return TOOL_ITEM_TYPES.has(type);
}

/** Anything this adapter has no dedicated rendering for, described rather than dropped. */
function describeUnmappedItem(item: Record<string, unknown>): string {
  switch (str(item.type)) {
    case 'imageView':
      return `[viewed image: ${str(item.path) || '?'}]`;
    case 'imageGeneration':
      return `[generated image${item.revisedPrompt ? `: ${str(item.revisedPrompt)}` : ''}]`;
    case 'enteredReviewMode':
      return `[entered review mode: ${str(item.review) || ''}]`;
    case 'exitedReviewMode':
      return `[exited review mode: ${str(item.review) || ''}]`;
    case 'contextCompaction':
      // Kept as text for the summary path below; the adapter also emits a
      // `marker` so the transcript draws the line rather than printing a
      // sentence that reads like something the agent said.
      return '[context compacted]';
    default:
      return `[unhandled codex item: ${str(item.type) || 'unknown'}]`;
  }
}

/**
 * One `ThreadItem` -> one `ChatBlock`, or null for items that are not
 * user-facing content (`userMessage` is represented by `send()` itself;
 * `hookPrompt` is internal prompt injection, not something the user typed
 * or the agent said).
 *
 * Shared between `CodexAppServerAdapter` and `CodexExecAdapter` on the
 * assumption in the file-level doc comment that both entry points emit the
 * same item shape.
 */
function itemToBlock(item: Record<string, unknown>) {
  const type = str(item.type);
  const id = str(item.id) || '';

  switch (type) {
    case 'userMessage':
    case 'hookPrompt':
      return null;

    case 'agentMessage':
      return { kind: 'text' as const, text: str(item.text) || '' };

    case 'reasoning': {
      // `content` is an array of parts (ReasoningTextDeltaNotification streams
      // them by `contentIndex`, which this adapter does not track separately);
      // joined here into the single string ThinkingBlock expects. `summary`
      // is used only when content is empty -- some turns reason without ever
      // populating the full trace, only its summary.
      const content = list(item.content).filter((entry): entry is string => typeof entry === 'string');
      const summary = list(item.summary).filter((entry): entry is string => typeof entry === 'string');
      return { kind: 'thinking' as const, text: (content.length ? content : summary).join('\n\n') };
    }

    case 'plan':
      return { kind: 'plan' as const, items: [{ text: str(item.text) || '', status: 'in_progress' as const }] };

    case 'commandExecution': {
      const status = toolStatus(item.status);
      const output = str(item.aggregatedOutput);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'shell',
        title: str(item.command),
        toolKind: 'execute' as ToolKind,
        status,
        input: { command: item.command, cwd: item.cwd },
        output,
        error: status === 'failed' ? output || 'command failed' : undefined,
        durationMs: num(item.durationMs),
      };
    }

    case 'fileChange': {
      const changes = list(item.changes);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'apply_patch',
        title: fileChangeTitle(changes),
        toolKind: 'edit' as ToolKind,
        status: toolStatus(item.status),
        diffs: changes.map((change) => fileUpdateChangeToFileDiff(record(change))),
        locations: changes.map((change) => str(record(change).path) || '').filter(Boolean),
      };
    }

    case 'mcpToolCall': {
      const tool = str(item.tool) || 'tool';
      const server = str(item.server) || '';
      const error = record(item.error);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: server ? `${server}.${tool}` : tool,
        toolKind: classifyTool(tool),
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.result !== null && item.result !== undefined ? safeJson(item.result) : undefined,
        error: str(error.message),
        durationMs: num(item.durationMs),
      };
    }

    case 'dynamicToolCall': {
      const tool = str(item.tool) || 'tool';
      return {
        kind: 'tool' as const,
        toolId: id,
        name: tool,
        toolKind: classifyTool(tool),
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.contentItems ? safeJson(item.contentItems) : undefined,
        error: item.success === false ? 'the tool call did not succeed' : undefined,
        durationMs: num(item.durationMs),
      };
    }

    case 'webSearch':
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'web_search',
        title: str(item.query),
        toolKind: 'fetch' as ToolKind,
        status: 'completed' as ToolStatus,
        input: { query: item.query, action: item.action },
      };

    case 'collabAgentToolCall':
      return {
        kind: 'tool' as const,
        toolId: id,
        name: `collab.${str(item.tool) || 'agent'}`,
        toolKind: 'task' as ToolKind,
        status: toolStatus(item.status),
        input: { prompt: item.prompt, model: item.model },
      };

    default:
      return { kind: 'text' as const, text: describeUnmappedItem(item) };
  }
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise unserialisable; the tool card survives without it.
    return undefined;
  }
}

/** codex's `ReviewDecision` for the two option kinds this adapter offers; anything else means "no". */
function reviewDecisionFor(optionId: string): string {
  if (optionId === 'allow_once') return 'approved';
  if (optionId === 'allow_always') return 'approved_for_session';
  return 'denied';
}

const CLIENT_INFO = { name: 'code-agents-webcli', title: 'Code Agents Web CLI', version: '1.0.0' };

/**
 * How long the handshake waits before giving up on a build that never
 * responds.
 *
 * BaseChatAdapter's own `exit` handler never rejects a pending JSON-RPC
 * call -- it only emits an `error`/`state` event -- so a codex old enough to
 * reject `app-server` outright (and exit without ever writing a line) would
 * otherwise leave `start()` hanging forever instead of letting
 * `CodexChatAdapter` fall back to `exec --json`.
 */
const INIT_TIMEOUT_MS = 8_000;
const THREAD_START_TIMEOUT_MS = 15_000;

// ------------------------------------------------------------- app-server

export class CodexAppServerAdapter extends JsonRpcChatAdapter {
  readonly runtime = 'codex';

  readonly capabilities: ChatCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    diffs: true,
    permissions: true,
    interrupt: true,
    resume: true,
    // No capture or schema note shows a fork-then-continue call keyed to a
    // specific earlier point; `thread/fork` forks the thread's current head
    // only, which is not what this capability promises the UI.
    fork: false,
    attachments: true,
    usage: true,
    // Tokens only -- nothing in the generated schema prices a turn.
    cost: false,
    plan: true,
  };

  private threadId: string | null = null;
  private model?: string;
  private turnId: string | null = null;
  private assistantMsgId: string | null = null;
  private blockIndex = 0;
  /** itemId -> block index, for the item kinds `block_end` must address by position. */
  private readonly itemBlockIndex = new Map<string, number>();
  private readonly planText = new Map<string, string>();

  protected buildArgs(): string[] {
    return ['app-server', ...(this.options.extraArgs || [])];
  }

  protected async handshake(): Promise<void> {
    await this.withTimeout(
      this.call('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false },
      }),
      INIT_TIMEOUT_MS,
      'initialize',
    );
    // Required before any other request; app-server accepts nothing sent
    // ahead of it, which reads as a silent hang rather than a rejection.
    this.notify('initialized');

    const params: Record<string, unknown> = { cwd: this.options.workingDir };
    if (this.options.model) params.model = this.options.model;
    if (this.options.bypassPermissions) {
      // Belt-and-braces alongside handleServerRequest's own auto-approve:
      // this asks codex not to send approval requests at all, but the
      // interception below is what actually holds if a build ignores it.
      params.approvalPolicy = 'never';
    }

    const response = record(
      await this.withTimeout(
        this.options.resumeSessionId
          ? this.call('thread/resume', { threadId: this.options.resumeSessionId, ...params })
          : this.call('thread/start', params),
        THREAD_START_TIMEOUT_MS,
        this.options.resumeSessionId ? 'thread/resume' : 'thread/start',
      ),
    );

    const thread = record(response.thread);
    this.threadId = str(thread.id) || null;
    this.model = str(response.model);

    this.emit({
      t: 'session',
      nativeSessionId: this.threadId || undefined,
      model: this.model,
      cwd: str(response.cwd) || this.options.workingDir,
      capabilities: this.capabilities,
    });
    this.emit({ t: 'state', state: 'idle' });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

  // ------------------------------------------------------------- outgoing

  async send(turn: UserTurn): Promise<void> {
    if (!this.threadId) {
      this.emit({ t: 'error', message: 'codex: no active thread, so the turn was not sent' });
      return;
    }

    const input: Array<Record<string, unknown>> = [{ type: 'text', text: turn.text, text_elements: [] }];
    for (const attachment of turn.attachments || []) {
      input.push(
        attachment.path ? { type: 'localImage', path: attachment.path } : { type: 'image', url: attachment.url },
      );
    }

    const response = record(await this.call('turn/start', { threadId: this.threadId, input }));
    const turnId = str(record(response.turn).id) || `turn-${Date.now()}`;

    this.turnId = turnId;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.itemBlockIndex.clear();
    this.planText.clear();

    const userMsgId = `u_${turnId}`;
    this.emit({ t: 'msg_start', id: userMsgId, role: 'user', turnId });
    this.emit({ t: 'block_start', msgId: userMsgId, index: 0, block: { kind: 'text', text: turn.text } });
    this.emit({ t: 'msg_end', msgId: userMsgId });
    this.emit({ t: 'state', state: 'thinking' });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return; // nothing running
    try {
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // The turn may already have finished between the click and this
      // landing; that races turn_end harmlessly and is not worth surfacing.
    }
  }

  respondPermission(requestId: string, optionId: string): void {
    const id = this.permissionWaiters.get(requestId);
    if (id === undefined) return; // already answered, or an id we never issued
    this.permissionWaiters.delete(requestId);
    this.respond(id, reviewDecisionFor(optionId));
    this.emit({
      t: 'permission_resolved',
      requestId,
      optionId,
      allowed: optionId === 'allow_once' || optionId === 'allow_always',
    });
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
        this.onTextDelta(str(params.itemId) || '', str(params.delta) || '');
        return;
      case 'item/plan/delta':
        this.onPlanDelta(str(params.itemId) || '', str(params.delta) || '');
        return;
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params);
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
        // skills/mcp status/hooks/account/... are not chat content this
        // adapter has scope to render. Dropping is correct, throwing is not.
        return;
    }
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
      // streaming, so open and close it in the same breath.
      const fresh = this.blockIndex++;
      this.itemBlockIndex.set(itemId, fresh);
      this.emit({ t: 'block_start', msgId, index: fresh, block });
      return;
    }
    this.emit({ t: 'block_end', msgId, index, block });
  }

  private onTextDelta(itemId: string, delta: string): void {
    if (!delta || !this.assistantMsgId) return;
    const index = this.itemBlockIndex.get(itemId);
    if (index === undefined) return; // a delta before its item opened; drop rather than guess a position
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
    this.emit({
      t: 'usage',
      usage: {
        inputTokens: num(total.inputTokens),
        outputTokens: num(total.outputTokens),
        cacheReadTokens: num(total.cachedInputTokens),
        reasoningTokens: num(total.reasoningOutputTokens),
        totalTokens: num(total.totalTokens),
        contextWindow: num(usage.modelContextWindow),
      },
    });
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
  }

  protected handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.handleApproval(id, method, params);
      return;
    }
    // Every other server request (elicitations, dynamic tool calls, auth
    // token refresh, ...) is outside this adapter's scope. Declining rather
    // than staying silent keeps the agent's turn moving instead of stalling
    // on an answer that will never come.
    this.respondError(id, -32601, `codex adapter does not handle ${method}`);
  }

  private handleApproval(id: number | string, method: string, params: Record<string, unknown>): void {
    const requestId = String(id);
    const callId = str(params.callId) || undefined;

    if (this.options.bypassPermissions) {
      // Pre-answered by the bypass setting; nothing is asked and nothing
      // waits, so there is no `permission` event to pair this with.
      this.respond(id, 'approved_for_session');
      this.emit({
        t: 'permission_resolved',
        requestId,
        optionId: 'allow_always',
        allowed: true,
        automatic: true,
      });
      return;
    }

    const options: PermissionOption[] = defaultPermissionOptions();
    let request;
    if (method === 'execCommandApproval') {
      const command = list(params.command).map(String);
      request = permissionRequest({
        requestId,
        toolId: callId,
        title: command.length ? `Run: ${command.join(' ')}` : 'Run a command',
        toolKind: 'execute',
        input: { command, cwd: str(params.cwd), reason: str(params.reason) },
        reason: str(params.reason),
        options,
      });
    } else {
      const fileChanges = record(params.fileChanges);
      const diffs = Object.entries(fileChanges).map(([path, change]) =>
        fileChangeToFileDiff(path, record(change)),
      );
      request = permissionRequest({
        requestId,
        toolId: callId,
        title: diffs.length === 1 ? `Apply patch: ${diffs[0].path}` : `Apply patch to ${diffs.length} files`,
        toolKind: 'edit',
        diffs,
        reason: str(params.reason),
        options,
      });
    }

    this.permissionWaiters.set(requestId, id);
    this.emit({ t: 'permission', request });
  }
}

// ------------------------------------------------------------------- exec

/**
 * Fallback for codex builds old enough to lack `app-server`.
 *
 * `exec --json` is a one-shot CLI: one process runs one turn to completion
 * and exits. There is no persistent RPC channel to ask permission on or to
 * interrupt mid-turn, and nothing survives between turns but what this
 * adapter chooses to remember -- so each turn spawns its own process rather
 * than reusing one across `send()` calls, the same shape `GrokChatAdapter`
 * uses for the same reason (see its class comment).
 *
 * Confirmed by `.work/probes/raw/codex-exec.jsonl`: the envelope is
 * `{"type": "thread.started"|"turn.started"|"turn.completed"|"turn.failed"|"error", ...}`,
 * dot-separated rather than app-server's slash methods. That probe hit a
 * usage limit before a turn produced any items, so `item.started` /
 * `item.completed` here reuse `itemToBlock` on the assumption (see the
 * file-level doc comment) that codex-rs shares one item shape across both
 * entry points -- not independently confirmed for this specific envelope.
 * Because this mode is not streaming-confirmed either, an item is rendered
 * only once, from `item.completed`; `item.started` is a no-op so a shape
 * that turns out to fire both does not render the same content twice.
 */
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
  };

  private turnId: string | null = null;
  private assistantMsgId: string | null = null;
  private blockIndex = 0;
  private sawTerminalEvent = false;

  /** "Alive" means the adapter has not been stopped, not that a child is currently running. */
  get alive(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    // No handshake exists in this mode; a turn either runs or its spawn
    // fails, and either way that surfaces from send(), not from here.
    this.emit({ t: 'session', cwd: this.options.workingDir, capabilities: this.capabilities });
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
    return !(this.child && !this.exited);
  }

  async send(turn: UserTurn): Promise<void> {
    if (this.child && !this.exited) {
      // One process serves exactly one turn; the session layer is expected
      // to await each send()'s turn_end before starting the next.
      throw new Error('codex exec: a turn is already running');
    }

    const turnId = `t_${Date.now()}`;
    this.turnId = turnId;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.sawTerminalEvent = false;

    const userMsgId = `u_${turnId}`;
    this.emit({ t: 'msg_start', id: userMsgId, role: 'user', turnId });
    this.emit({ t: 'block_start', msgId: userMsgId, index: 0, block: { kind: 'text', text: turn.text } });
    this.emit({ t: 'msg_end', msgId: userMsgId });
    this.emit({ t: 'state', state: 'thinking' });

    // Every call is independent: nothing in the confirmed fixture shows a
    // resume syntax for this mode, so multi-turn context is a known
    // regression versus app-server -- exactly why capabilities.resume is
    // false here.
    this.spawnTurn([...this.buildArgs(), turn.text]);
  }

  private spawnTurn(args: string[]): void {
    this.exited = false;
    this.stdoutBuffer = '';

    const child = spawn(this.options.command, args, {
      cwd: this.options.workingDir,
      env: {
        ...process.env,
        ...(this.options.env || {}),
        NO_COLOR: '1',
        TERM: 'dumb',
        FORCE_COLOR: '0',
      },
      // Closed, not piped: the prompt is the last argv entry and nothing is
      // ever written here. Left as an open pipe, `codex exec` announces
      // "Reading additional input from stdin..." and waits on it forever —
      // measured at no exit after 40s with no output, against 111ms once
      // closed. The turn would simply never come back.
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as AdapterChild;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onTurnStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('error', (error: Error) => {
      this.exited = true;
      this.emit({ t: 'error', message: `codex exec: ${error.message}`, fatal: false });
      this.closeTurn('error');
    });

    child.on('exit', () => {
      this.exited = true;
      if (this.stopped || this.sawTerminalEvent) return;
      const detail = this.stderrTail.trim();
      this.emit({
        t: 'error',
        message: detail ? `codex exec exited unexpectedly: ${detail}` : 'codex exec exited unexpectedly',
      });
      this.closeTurn('exited');
    });
  }

  /**
   * Not a call into BaseChatAdapter's own (private) line framing: that
   * method is wired to the single child from `start()`, which this adapter
   * never spawns -- see the class doc comment on the per-turn spawn.
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
        continue; // banner output, same tolerance as every other adapter here
      }

      try {
        this.handleMessage(parsed);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `codex exec adapter failed to handle a message: ${message}` });
      }
    }

    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.emit({ t: 'error', message: 'codex exec sent an oversized line; discarded the buffer' });
    }
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
        const block = itemToBlock(item);
        if (!block) return;
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
    if (this.child && !this.exited) this.child.kill('SIGTERM');
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // Nothing is ever pending here: capabilities.permissions is false.
  }
}

// ---------------------------------------------------------------- router

/**
 * The adapter callers actually construct.
 *
 * Tries the app-server protocol first and only falls back to `exec --json`
 * when the handshake itself fails -- a hang, a rejected `app-server`
 * subcommand, or a codex old enough not to speak JSON-RPC at all. The
 * events a doomed probe attempt emits (a spawn error, an "exited" state)
 * are buffered rather than forwarded, so a build too old for app-server
 * shows a transcript that only ever ran in exec mode, not one with a
 * confusing failed attempt at its head.
 */
export class CodexChatAdapter implements ChatAdapter {
  readonly runtime = 'codex';
  private delegate: ChatAdapter | null = null;
  private sink: (event: AdapterEvent) => void = () => {};

  constructor(private readonly options: ChatAdapterOptions) {}

  get capabilities(): ChatCapabilities {
    return this.delegate?.capabilities ?? NO_CHAT_CAPABILITIES;
  }

  get alive(): boolean {
    return this.delegate?.alive ?? false;
  }

  async start(): Promise<void> {
    const buffered: AdapterEvent[] = [];
    this.sink = (event) => buffered.push(event);
    const probeOptions: ChatAdapterOptions = { ...this.options, emit: (event) => this.sink(event) };

    const primary = new CodexAppServerAdapter(probeOptions);
    try {
      await primary.start();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`codex: app-server handshake failed, falling back to exec --json: ${message}`);
      await primary.stop().catch(() => undefined);
      this.sink = this.options.emit; // discard the buffered probe noise; nothing is replayed
      const fallback = new CodexExecAdapter(this.options);
      await fallback.start();
      this.delegate = fallback;
      return;
    }

    this.delegate = primary;
    this.sink = this.options.emit;
    for (const event of buffered) this.options.emit(event);
  }

  async send(turn: UserTurn): Promise<void> {
    if (!this.delegate) throw new Error('codex adapter not started');
    return this.delegate.send(turn);
  }

  async interrupt(): Promise<void> {
    await this.delegate?.interrupt();
  }

  respondPermission(requestId: string, optionId: string): void {
    this.delegate?.respondPermission(requestId, optionId);
  }

  async stop(): Promise<void> {
    await this.delegate?.stop();
  }
}

export default CodexChatAdapter;
