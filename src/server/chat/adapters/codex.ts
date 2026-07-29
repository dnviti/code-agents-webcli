import { spawn } from 'child_process';
import {
  ChatCapabilities,
  ChatUsage,
  DiffHunk,
  EffortChoice,
  ModelChoice,
  FileDiff,
  NO_CHAT_CAPABILITIES,
  PermissionOption,
  PlanItem,
  ToolKind,
  ToolStatus,
  UserTurn,
  classifyTool,
  defaultPermissionOptions,
  rankedEfforts,
} from '../../../shared/chat-events.js';
import { blockDraws } from '../../../shared/chat-visibility.js';
import { AccountLimitTracker, resetIsoFromEpochSeconds } from '../account-limits.js';
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
      // Not filtered for blankness here: this same mapper opens the block that
      // the streaming deltas are then addressed into by index, and a reply that
      // is empty when it starts is every reply. The blank guard for #132 is at
      // the two places a block is opened for an item that is already finished —
      // see `onItem` and the exec adapter — where the text is final.
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

/**
 * How big codex says the window is, and how much of it the last request filled.
 *
 * Occupancy comes from `last` rather than `total` where codex offers both:
 * `total` is everything the turn spent across its round trips, which is a
 * larger number than anything that was ever in the window at one time and
 * would have the bar filling several times faster than the truth.
 */
function contextReading(
  usage: Record<string, unknown>,
  total: Record<string, unknown>,
  model: string | undefined,
): ChatUsage {
  const window = num(usage.modelContextWindow);
  const last = record(usage.last) ?? total;
  const used = num(last.totalTokens);
  return {
    ...(window !== undefined
      ? {
          contextWindow: window,
          contextWindowSource: 'agent' as const,
          // `thread/tokenUsage/updated` says how big the window is and never
          // which model it belongs to, so the name comes from the thread this
          // adapter is holding. Unnamed, a mid-session model change makes the
          // session read codex's own ceiling as the previous model's.
          contextWindowModel: model,
        }
      : {}),
    ...(used !== undefined ? { contextUsed: used } : {}),
  };
}

// ------------------------------------------------------------ effort ladder

/**
 * One `model/list` entry's reasoning-effort ladder, as codex published it.
 *
 * Read off a live `model/list` against codex-cli 0.145.0 rather than inferred
 * from the vendored schema: every entry came back carrying
 * `supportedReasoningEfforts: Array<{ reasoningEffort, description }>` next to a
 * `defaultReasoningEffort`, and the arrays arrived cheapest-first —
 * `low, medium, high, xhigh, max, ultra` for gpt-5.6-terra, the same list
 * stopping at `xhigh` for gpt-5.5. That order *is* the ladder, so it is kept
 * exactly as sent and `rankedEfforts` spaces the ranks along whatever length it
 * turns out to be.
 *
 * Which is also why the offered levels come from here and not from the
 * `ReasoningEffort` union in `.work/probes/raw/codex-ts/ReasoningEffort.ts`:
 * that enum stops at `xhigh`, while the running build offers `max` and `ultra`
 * on its newer models. Where the generated schema and the process disagree
 * about what the process accepts, the process wins.
 *
 * The descriptions are codex's own, verbatim ("Balances speed and reasoning
 * depth for everyday tasks"), and so are the names: there is no table here
 * turning `xhigh` into "Extra high", because the value is the exact string that
 * gets handed back to codex and a label that differs from it only makes a
 * mismatch harder to see.
 *
 * Undefined rather than an empty array when the field is missing, so a build
 * that predates it leaves the control saying this runtime publishes no ladder
 * instead of opening an empty menu.
 */
function effortLadder(model: Record<string, unknown> | undefined): EffortChoice[] | undefined {
  const levels: Array<{ value: string; description?: string }> = [];
  for (const raw of list(model?.supportedReasoningEfforts)) {
    const option = record(raw);
    const value = str(option.reasoningEffort);
    if (!value) continue;
    const description = str(option.description);
    levels.push({ value, ...(description ? { description } : {}) });
  }
  return levels.length ? rankedEfforts(levels) : undefined;
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
/** Short on purpose: the picker is worth waiting for, but not worth a delayed session. */
const MODEL_LIST_TIMEOUT_MS = 5_000;
/**
 * How long to wait for `account/rateLimits/read`.
 *
 * It has a timer of its own because `call()` has none: an app-server old enough
 * not to implement the method may simply never answer, and an unanswered
 * request sits in the pending map until the session stops.
 */
const RATE_LIMITS_TIMEOUT_MS = 5_000;

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
  private reportedEffort: string | null = null;
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
  private turnEffort: string | null = null;
  private turnId: string | null = null;
  private assistantMsgId: string | null = null;
  private blockIndex = 0;
  /** itemId -> block index, for the item kinds `block_end` must address by position. */
  private readonly itemBlockIndex = new Map<string, number>();
  private readonly planText = new Map<string, string>();
  /** itemId -> which of a reasoning item's two channels is filling its block. */
  private readonly reasoningChannel = new Map<string, 'content' | 'summary'>();
  /** What codex has said about the account behind this thread. See `loadRateLimits`. */
  private readonly account = new AccountLimitTracker();

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
    if (this.options.effort) {
      // There is no `effort` parameter on `thread/start`; the level travels in
      // the free-form `config` map, under the same key codex's own
      // `-c model_reasoning_effort=…` writes into. Probed live against
      // codex-cli 0.145.0 by opening three threads on gpt-5.5 and reading the
      // reply back each time: no `config` answered `reasoningEffort: "xhigh"`
      // (the configured default on this machine), `{"model_reasoning_effort":
      // "low"}` answered `"low"` and `{"model_reasoning_effort":"xhigh"}`
      // answered `"xhigh"`. So the key is read, and read at thread start rather
      // than accepted and ignored.
      //
      // That this lands in `thread/resume` too — `params` is spread into both —
      // is wanted, and the schema agrees: `ThreadResumeParams` carries the same
      // optional `config` map, documented there as "configuration overrides for
      // the resumed thread". A conversation deliberately moved off the default
      // level should come back on the level it was left on, not silently revert
      // to whatever the profile says.
      params.config = { model_reasoning_effort: this.options.effort };
    }
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
    // Not what was asked for — what codex says it got. The two differ whenever
    // nothing was asked for at all, and the reply is the only place the answer
    // appears: `reasoningEffort` sits at the top level of both the
    // `thread/start` and the `thread/resume` response, alongside `model` and
    // `cwd`, in the schema and in the live capture both.
    this.reportedEffort = str(response.reasoningEffort) ?? null;
    // Not awaited. The picker's menu is worth having but not worth holding a
    // conversation open for, and the answer arrives on its own event whenever
    // it arrives — `capabilities` exists for exactly this, a runtime revising
    // what it can do after it has introduced itself.
    void this.loadModelList();
    // Same treatment, for the same reason: worth having, not worth holding a
    // conversation open for. It is also the only account figure any runtime
    // here reports at launch rather than mid-turn.
    void this.loadRateLimits();

    this.emit({
      t: 'session',
      nativeSessionId: this.threadId || undefined,
      model: this.model,
      cwd: str(response.cwd) || this.options.workingDir,
      capabilities: this.capabilities,
    });
    // After `session`, because that event is what introduces the runtime and a
    // level arriving ahead of it has nothing to be shown against. `null` here
    // is codex's own answer rather than a hole in ours: `reasoningEffort` is
    // `ReasoningEffort | null` in the generated reply type, and null means the
    // thread is running on the model's own default with nothing overriding it —
    // which is exactly what the event's null already means.
    this.emit({ t: 'effort', effort: this.reportedEffort });
    this.emit({ t: 'state', state: 'idle' });
  }

  /**
   * Ask codex which models it will accept, and how hard each will think.
   *
   * `model/list` is a real request on this protocol — confirmed against the
   * running app-server, which rejects an unknown method by name and answers
   * this one with `{ data: [{ id, displayName, description, isDefault, hidden }] }`.
   * So codex's picker offers what codex says, rather than asking somebody to
   * remember a model id and type it correctly.
   *
   * The same entries carry the effort ladder, which is why one call feeds both
   * controls: a live `model/list` on codex-cli 0.145.0 returned
   * `supportedReasoningEfforts` and `defaultReasoningEffort` per model, and the
   * ladders are genuinely per model — gpt-5.6-terra offers six levels up to
   * `ultra`, gpt-5.5 four stopping at `xhigh`. Publishing a union of them all
   * would offer levels the running model refuses, so only the current model's
   * ladder is published: the entry matching what `thread/start` said is running,
   * and failing that the one codex flagged `isDefault`, which is the model that
   * same thread would have been given.
   *
   * Best-effort by construction: a build that does not have the method, or is
   * slow to answer it, must not stop a conversation opening. The catch leaves
   * `capabilities.models` and `capabilities.efforts` unset, which is the same
   * state as a runtime that publishes nothing — and both controls already say so
   * rather than showing an empty menu. The same guard applies field by field
   * within a successful answer: a build old enough to list models without
   * listing their efforts publishes the models and stays quiet about the rest.
   */
  private async loadModelList(): Promise<void> {
    try {
      const response = record(
        await this.withTimeout(this.call('model/list', {}), MODEL_LIST_TIMEOUT_MS, 'model/list'),
      );
      const entries = Array.isArray(response.data) ? response.data : [];
      const models: ModelChoice[] = [];
      let running: Record<string, unknown> | undefined;
      let byDefault: Record<string, unknown> | undefined;
      for (const entry of entries) {
        const item = record(entry);
        // Matched ahead of the `hidden` filter, and on both spellings. Ahead of
        // it because hidden means "do not offer this in the picker", not "this
        // cannot be what the thread is running" — and if it is what the thread
        // is running, its ladder is the one that applies. Both spellings because
        // the entry carries `id` and `model` separately and they are not always
        // the same string; matching on one alone would quietly fall through to
        // the default entry's ladder for a model that has its own.
        if (this.model && (str(item.id) === this.model || str(item.model) === this.model)) {
          running = item;
        }
        if (!byDefault && item.isDefault === true) byDefault = item;

        if (!item || item.hidden === true) continue;
        const value = str(item.id) || str(item.model);
        if (!value) continue;
        models.push({
          value,
          name: str(item.displayName) || value,
          ...(str(item.description) ? { description: str(item.description) as string } : {}),
        });
      }

      const efforts = effortLadder(running || byDefault);
      const patch: Partial<ChatCapabilities> = {};
      if (models.length > 0) {
        this.capabilities.models = models;
        patch.models = models;
      }
      if (efforts) {
        this.capabilities.efforts = efforts;
        patch.efforts = efforts;
      }
      if (Object.keys(patch).length > 0) {
        this.emit({ t: 'capabilities', capabilities: patch });
      }
    } catch {
      // Deliberately silent: nothing about a missing menu is worth an error
      // event in a transcript, and the conversation is about to start fine.
    }
  }

  /**
   * Ask codex where the account stands, which it will actually tell you.
   *
   * Probed live against codex-cli 0.146.0 on 2026-07-29: `account/rateLimits/read`
   * (no params) answers with `rateLimits: { limitId, limitName, primary,
   * secondary, credits, planType, spendControlReached, rateLimitReachedType }`,
   * where each window is `{ usedPercent, windowDurationMins, resetsAt }` and
   * `resetsAt` is epoch seconds. The captured reply is
   * `test/fixtures/chat/codex-appserver-ratelimits.jsonl`.
   *
   * That `planType` is the reason this app never reads `~/.codex/auth.json`:
   * the plan name is also inside the id_token there, but that file holds the
   * access and refresh tokens beside it, and a status readout is not worth
   * teaching this server to open a credentials file. Codex volunteers the same
   * fact over a protocol it already speaks.
   *
   * Best-effort by construction, like `loadModelList`: a build without the
   * method must not stop a conversation opening, and a silent one must not hold
   * the pending map open — hence the timeout.
   */
  private async loadRateLimits(): Promise<void> {
    try {
      const response = record(
        await this.withTimeout(
          this.call('account/rateLimits/read', {}),
          RATE_LIMITS_TIMEOUT_MS,
          'account/rateLimits/read',
        ),
      );
      this.onRateLimits(response);
    } catch {
      // Deliberately silent. "Codex would not say" is a state the panel already
      // renders in words; an error event would put a protocol detail in a
      // transcript over something nobody asked for.
    }
  }

  /**
   * Fold a rate-limit snapshot in, from either the request or the notification.
   *
   * Accepts the envelope or the snapshot itself because the two channels were
   * not both captured: the request answers `{ rateLimits: {...} }` and the
   * notification's shape is declared but unprobed, so the wrapper is unwrapped
   * when it is there and the payload used as-is when it is not.
   */
  private onRateLimits(payload: Record<string, unknown>): void {
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

    const params: Record<string, unknown> = { threadId: this.threadId, input };
    if (this.turnEffort) {
      // Only ever a level `setEffort` was given, and `setEffort` is only ever
      // given one off the menu `model/list` published. That chain matters here
      // rather than at the far end of it, because `turn/start` does not check
      // this field: a probe sent a level codex has never heard of and got back
      // `OK` with a perfectly ordinary turn object. A typo would therefore not
      // fail — it would run the whole turn at some level nobody can name.
      params.effort = this.turnEffort;
    }

    const response = record(await this.call('turn/start', params));
    const turnId = str(record(response.turn).id) || `turn-${Date.now()}`;

    this.turnId = turnId;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.itemBlockIndex.clear();
    this.planText.clear();
    this.reasoningChannel.clear();

    // The user's own message is not written here. `ChatSession.deliver` has
    // already put it in the transcript, with the turn id it minted and the text
    // the user actually typed — a copy from this side is a second bubble in the
    // same turn (#129), and on a branched conversation it is the briefing glued
    // in front of the prompt rather than the prompt.
    this.emit({ t: 'state', state: 'thinking' });
  }

  /**
   * Move this thread onto a different reasoning-effort level.
   *
   * There is no method for it. Nothing in the vendored bindings is shaped like
   * `thread/set_effort`, and guessing an RPC name to see whether it answers
   * only puts a `-32601` in somebody's transcript. What does exist is
   * `turn/start`'s own `effort`, documented in
   * `.work/probes/raw/codex-ts/v2/TurnStartParams.ts` as "Override the
   * reasoning effort for this turn and subsequent turns" — the same wording its
   * neighbours `model`, `cwd` and `approvalPolicy` carry, all of which are
   * thread-level settings reached through a turn. So the level is remembered
   * here and attached to every turn from now on, which `send()` does.
   *
   * That is also why this resolves at once instead of waiting for a turn to
   * prove it. Resolving is a claim about what happens next, and what happens
   * next is that the very next `turn/start` carries the new level: the
   * parameter rides on the request that *begins* a turn, so there is no window
   * in which a turn could still run at the old one. The alternative — staying
   * silent until the user happens to send a message — would leave the control
   * showing a level the session is no longer going to use, for as long as they
   * did not, and a control that lies for an unbounded stretch is worse than one
   * that admits it cannot switch at all.
   *
   * The `effort` event is emitted from here on the same footing, and it is
   * worth being exact about what it claims. Codex has not been asked anything
   * yet and has not answered; what is being reported is not "codex confirmed"
   * but "this is the level the next turn runs at", which this adapter is the
   * thing that decides. There is no later confirmation to wait for either:
   * `TurnStartResponse` is `{ turn }` and nothing else, so a turn that accepts
   * the override says nothing about it.
   */
  async setEffort(effort: string): Promise<void> {
    this.turnEffort = effort;
    this.emit({ t: 'effort', effort });
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
      // streaming, so open and close it in the same breath. This is the one
      // place the text is final at the moment the block is opened, so it is
      // where a reply that says nothing is refused rather than recorded — a
      // blank one would make the step "a step that spoke" and earn it a
      // bordered row with nothing to read (#132).
      if (!blockDraws(block)) return;
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
    this.emit({
      t: 'usage',
      usage: {
        inputTokens: num(total.inputTokens),
        outputTokens: num(total.outputTokens),
        cacheReadTokens: num(total.cachedInputTokens),
        reasoningTokens: num(total.reasoningOutputTokens),
        totalTokens: num(total.totalTokens),
        ...contextReading(usage, total, this.model),
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
    this.reasoningChannel.clear();
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
 * than reusing one across `send()` calls. Grok's headless mode had the same
 * shape for the same reason until #73 moved it onto ACP, and it is worth
 * knowing why that happened before reaching for this pattern again: a one-shot
 * process reports only what its output format carries, and grok's carried no
 * tool calls at all.
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
        // Exec mode reports each item once, already finished, so this is the
        // only chance to refuse one that would paint nothing (#132).
        if (!blockDraws(block)) return;
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

  /**
   * Forwarded, or the readiness gate is dead for codex.
   *
   * Only the exec fallback answers this — it spawns a child per turn, and a
   * turn sent while the previous child is still exiting is refused. Left off
   * this facade, `ChatSession` read "ready" unconditionally for codex, so the
   * session wrote the user's message into the conversation and moved to
   * thinking before the send that was going to throw (#89).
   */
  get readyForTurn(): boolean {
    return this.delegate?.readyForTurn !== false;
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

  /**
   * Handed straight to whichever adapter is actually running.
   *
   * This is not ceremony: callers reach codex through this class and nothing
   * else, so a router that did not forward would leave `setEffort` implemented
   * on an object nobody holds, and the control would report "this runtime
   * cannot change level" about a runtime that plainly can.
   *
   * The rejection is the honest half. `setEffort` is optional on the interface
   * and its absence is how a runtime says it has no such knob — but a router
   * cannot make a method vanish when the delegate it happens to have chosen
   * lacks one, and `exec --json` lacks one for a good reason: it spawns a
   * process per turn with the prompt in argv and has no live session to change
   * anything on. So a fallback session rejects rather than resolving on a
   * promise it cannot keep. Nothing reaches this in practice — the effort menu
   * is published by the app-server adapter alone, so an exec session offers no
   * levels to pick from — which is precisely why it must not resolve if it ever
   * does.
   */
  async setEffort(effort: string): Promise<void> {
    const delegate = this.delegate;
    if (!delegate?.setEffort) {
      throw new Error('codex: this session cannot change reasoning effort without a relaunch');
    }
    await delegate.setEffort(effort);
  }

  async stop(): Promise<void> {
    await this.delegate?.stop();
  }
}

export default CodexChatAdapter;
