/**
 * The chat event model: one vocabulary every runtime is translated into.
 *
 * Terminal mode carries PTY bytes. Chat mode cannot — scraping a TUI's ANSI
 * repaints back into structure is a losing game, and every runtime we launch
 * already ships a structured non-TUI mode. So chat mode is a second data path:
 * each runtime's native protocol is normalised by an adapter into the events
 * below, and nothing else crosses the boundary.
 *
 * Four native protocols feed this file today (captured under `.work/probes/`):
 *
 *   - Anthropic streaming JSON  (claude)
 *   - Agent Client Protocol     (kimi, omp, opencode — one adapter, three CLIs)
 *   - Codex app-server JSON-RPC (codex)
 *   - Session-event JSONL       (pi)
 *
 * They disagree about almost everything except the shape of the conversation
 * underneath, which is what this file names. Adapters own the disagreement;
 * the store, the socket and the UI only ever see what is here.
 *
 * Deliberately provider-agnostic, in the same spirit as runtime-profiles: a
 * model is an opaque string, a tool name is whatever the runtime called it. The
 * app's job is to carry structure faithfully, not to rewrite it into a taxonomy
 * that goes stale the week it ships.
 */

/**
 * Which surface a session is driven through.
 *
 * A session picks one at launch and keeps it: the two modes spawn the runtime
 * differently (PTY versus stdio protocol) and cannot be swapped underneath a
 * live process.
 */
export type ChatSurface = 'terminal' | 'chat';

export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * Lifecycle of a single tool call.
 *
 * `denied` is distinct from `failed` on purpose: the UI says "you refused this"
 * rather than "this broke", and a denial is not an error to retry.
 */
export type ToolStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'canceled';

/**
 * Coarse tool category, used only to pick an icon and a verb.
 *
 * Every runtime names its tools differently (`Read` / `read_file` / `fs.read`),
 * so adapters map onto this small set and keep the original name in `name` for
 * display. `other` is always acceptable — an unmapped tool must still render.
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'task'
  | 'todo'
  | 'other';

/** One contiguous changed region of a file, in unified-diff terms. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw unified-diff body lines, each still carrying its ' ', '-' or '+'. */
  lines: string[];
}

/**
 * A file change proposed or performed by a tool call.
 *
 * Carries hunks rather than whole contents so a large edit stays cheap to send
 * and to store, and so the UI can offer per-hunk review.
 */
export interface FileDiff {
  path: string;
  /** Set only for renames, where the change also moves the file. */
  oldPath?: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the file has no textual diff to show (images, archives). */
  binary?: boolean;
}

/** One entry in an agent's plan / todo list. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Optional runtime-supplied priority; purely presentational. */
  priority?: string;
}

export interface TextBlock {
  kind: 'text';
  text: string;
}

/**
 * Extended reasoning, shown collapsed by default.
 *
 * Separate from `text` because it is the model thinking rather than the model
 * answering, and conflating them makes transcripts unreadable.
 */
export interface ThinkingBlock {
  kind: 'thinking';
  text: string;
  /** Some runtimes stream a signature alongside; kept for fidelity, unused in UI. */
  signature?: string;
}

export interface ToolBlock {
  kind: 'tool';
  /** Runtime-assigned id. Unique within a session; how later updates find it. */
  toolId: string;
  /** The runtime's own tool name, shown verbatim. */
  name: string;
  /** Human phrasing when the runtime supplies one ("Reading hello.txt"). */
  title?: string;
  toolKind: ToolKind;
  status: ToolStatus;
  /**
   * Arguments as the runtime reported them.
   *
   * Held as a string while a runtime streams them (Anthropic sends tool input
   * as incremental JSON fragments that are not parseable until complete), then
   * replaced with the parsed object once the block closes.
   */
  input?: unknown;
  /** Partial JSON accumulated while `input` is still streaming in. */
  inputPartial?: string;
  output?: string;
  /** File changes attributed to this call, when the runtime reports them. */
  diffs?: FileDiff[];
  /** Paths this call touched, for the "files changed" affordance. */
  locations?: string[];
  /** Set when status is `failed`. */
  error?: string;
  durationMs?: number;
}

export interface ImageBlock {
  kind: 'image';
  mime: string;
  /** Server-relative URL. Image bytes never travel inside an event. */
  url: string;
  alt?: string;
}

export interface PlanBlock {
  kind: 'plan';
  items: PlanItem[];
}

export interface ErrorBlock {
  kind: 'error';
  text: string;
}

/**
 * A line across the conversation marking something that happened *to* it.
 *
 * Not something anyone said, which is why it is its own block kind rather than
 * a system message with prose in it: compaction rewrote the context the agent
 * is working from, and everything above the line is no longer what it can see.
 * That is a fact about the conversation, and it has to be visible in the
 * conversation — an agent that quietly forgets the first hour and gives a
 * different answer for it is a confusing agent.
 */
export interface NoticeBlock {
  kind: 'notice';
  notice: 'compacted' | 'cleared';
  text: string;
  /** Optional detail — how much was reclaimed, what the summary covers. */
  detail?: string;
}

export type ChatBlock =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | ImageBlock
  | PlanBlock
  | ErrorBlock
  | NoticeBlock;

/**
 * Token and cost accounting for a message, turn or session.
 *
 * Every field is optional because runtimes report wildly different subsets —
 * some give cost, some only totals, some nothing at all. The UI shows what it
 * has and stays silent about the rest rather than rendering confident zeroes.
 */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Context window size, when known, so the UI can show how full it is. */
  contextWindow?: number;
  /** Context currently occupied, when the runtime reports it directly. */
  contextUsed?: number;
}

/** A message as the reducer assembles it. */
export interface ChatMessage {
  id: string;
  /** Monotonic per session. Orders messages and anchors history paging. */
  seq: number;
  turnId: string;
  role: ChatRole;
  ts: number;
  blocks: ChatBlock[];
  /** Set once the message completes. */
  stopReason?: string;
  usage?: ChatUsage;
  /** Model that produced this message, when reported. */
  model?: string;
  /** True while the runtime is still appending to this message. */
  streaming?: boolean;
}

/**
 * One option offered for a pending approval.
 *
 * Mirrors ACP's shape because it is the most expressive of the four: the others
 * collapse onto it (an allow/deny pair) without losing anything.
 */
export interface PermissionOption {
  optionId: string;
  name: string;
  /** How the UI should weight the button. */
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  requestId: string;
  /** Tool call this approval gates, when it gates one. */
  toolId?: string;
  title: string;
  toolKind: ToolKind;
  /** Command, path or arguments the user is being asked to approve. */
  input?: unknown;
  /** Populated for patch approvals, so the user reviews the actual change. */
  diffs?: FileDiff[];
  reason?: string;
  options: PermissionOption[];
  ts: number;
}

/** What a chat session is doing right now, for the header indicator. */
export type ChatState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'running'
  | 'awaiting_permission'
  | 'exited'
  | 'error';

/**
 * What a runtime can actually do in chat mode.
 *
 * Published by each adapter and carried to the UI, which hides or disables what
 * a runtime lacks. This is what keeps "chat works for every runtime" honest:
 * a CLI with no approval channel says so, and the UI stops pretending it has a
 * deny button that would do nothing.
 */
export interface ChatCapabilities {
  /** Text arrives incrementally rather than only at end of turn. */
  streaming: boolean;
  /** Reasoning is exposed separately from the answer. */
  thinking: boolean;
  toolCalls: boolean;
  /** File changes arrive as structured diffs rather than prose. */
  diffs: boolean;
  /** The runtime can ask before acting, and honour a refusal. */
  permissions: boolean;
  interrupt: boolean;
  /** A session can be resumed after the process is gone. */
  resume: boolean;
  /** A session can be branched from an earlier point. */
  fork: boolean;
  /** Images or files can be attached to a user turn. */
  attachments: boolean;
  /** Token counts are reported. */
  usage: boolean;
  /** Money is reported, not just tokens. */
  cost: boolean;
  /** The runtime emits a plan / todo list. */
  plan: boolean;
  /** Slash commands the runtime accepts, when it advertises them. */
  commands?: SlashCommand[];
  /** Selectable models, when the runtime advertises a list. */
  models?: ModelChoice[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  /** Hint for the argument, e.g. "[on|off|status]". */
  hint?: string;
}

export interface ModelChoice {
  value: string;
  name: string;
  description?: string;
}

/**
 * The event union adapters emit.
 *
 * Deltas rather than snapshots: a turn can run for minutes and re-sending the
 * whole transcript per token would be untenable. `seq` is assigned by the
 * session (not the adapter) and is the ordering authority — it numbers the
 * event log, drives history paging, and lets a reconnecting browser say
 * exactly how much it already has.
 */
export type ChatEvent =
  /** Emitted once the runtime is up; carries what it told us about itself. */
  | {
      t: 'session';
      seq: number;
      ts: number;
      /** The runtime's own session id, needed to resume it later. */
      nativeSessionId?: string;
      model?: string;
      cwd?: string;
      capabilities: ChatCapabilities;
    }
  | { t: 'msg_start'; seq: number; ts: number; id: string; role: ChatRole; turnId: string; model?: string }
  | { t: 'block_start'; seq: number; ts: number; msgId: string; index: number; block: ChatBlock }
  /**
   * Append to an open block. `text` extends a text/thinking block; `json`
   * extends a tool block's streaming arguments.
   */
  | { t: 'block_delta'; seq: number; ts: number; msgId: string; index: number; text?: string; json?: string }
  | { t: 'block_end'; seq: number; ts: number; msgId: string; index: number; block?: Partial<ChatBlock> }
  | { t: 'msg_end'; seq: number; ts: number; msgId: string; stopReason?: string; usage?: ChatUsage }
  /**
   * Patch a tool block found by `toolId`, wherever it sits in the transcript.
   *
   * Tool results arrive out of band in every protocol here — after the message
   * that opened the call has already closed — so they cannot be a block_delta.
   */
  | { t: 'tool'; seq: number; ts: number; toolId: string; patch: Partial<ToolBlock> }
  | { t: 'plan'; seq: number; ts: number; items: PlanItem[] }
  | { t: 'usage'; seq: number; ts: number; usage: ChatUsage }
  | { t: 'permission'; seq: number; ts: number; request: PermissionRequest }
  | {
      t: 'permission_resolved';
      seq: number;
      ts: number;
      requestId: string;
      optionId: string;
      /** True when the choice let the tool run. */
      allowed: boolean;
      /** Set when the decision came from the bypass setting, not a person. */
      automatic?: boolean;
    }
  | { t: 'state'; seq: number; ts: number; state: ChatState }
  | { t: 'error'; seq: number; ts: number; message: string; fatal?: boolean }
  | {
      t: 'turn_end';
      seq: number;
      ts: number;
      turnId: string;
      stopReason?: string;
      usage?: ChatUsage;
      durationMs?: number;
    }
  /** The runtime revised what it can do — new slash commands, a model switch. */
  | { t: 'capabilities'; seq: number; ts: number; capabilities: Partial<ChatCapabilities> }
  /**
   * Something happened to the conversation itself.
   *
   * `compacted` leaves a marker in place and keeps the transcript: what was
   * said still happened and is still worth scrolling back to, even though the
   * agent can no longer see it. `cleared` empties the transcript, because that
   * is what the user asked for — `/clear` means "start again", and a window
   * still full of the previous conversation would be the opposite of that.
   */
  | {
      t: 'marker';
      seq: number;
      ts: number;
      kind: 'compacted' | 'cleared';
      detail?: string;
    };

/** An attachment on an outgoing user turn. */
export interface ChatAttachment {
  /** Server-relative URL of the stored file. Bytes never ride on the socket. */
  url: string;
  mime: string;
  name: string;
  size: number;
  /** Absolute path on the server, for runtimes that take a path not a blob. */
  path?: string;
}

/** A user turn on its way to the runtime. */
export interface UserTurn {
  text: string;
  attachments?: ChatAttachment[];
}

/**
 * A turn typed while the agent was still working, waiting its place in line.
 *
 * Deliberately not a transcript event. The log is the record of what happened,
 * and a queued turn has not happened yet — it can still be cancelled, and if
 * the server goes down it is gone along with the process it was queued for.
 * It rides on the snapshot and on its own broadcast instead, which is what
 * lets a second browser (or the same one after a reload) see the same line.
 */
export interface QueuedTurn {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  ts: number;
}

/**
 * How many turns may wait at once.
 *
 * A ceiling rather than a policy: the queue is held in memory on behalf of a
 * browser that may never come back, and "type as much as you like" is not a
 * promise this server should make with someone else's RAM.
 */
export const MAX_QUEUED_TURNS = 20;

/**
 * The rolling view a client holds.
 *
 * `cursor` is the highest seq the client has applied, so a reconnect asks for
 * exactly what it missed instead of refetching a transcript it already has.
 */
export interface ChatSnapshot {
  sessionId: string;
  runtime: string;
  messages: ChatMessage[];
  state: ChatState;
  capabilities: ChatCapabilities;
  usage?: ChatUsage;
  plan?: PlanItem[];
  pendingPermissions: PermissionRequest[];
  /**
   * Turns typed ahead, still waiting. Optional so a snapshot replayed from the
   * store — which knows nothing about a live process — is not obliged to
   * invent one; the session fills it in.
   */
  queued?: QueuedTurn[];
  /** Lowest seq still on disk; below this the log has been trimmed. */
  firstSeq: number;
  /**
   * Lowest seq actually folded into `messages`.
   *
   * A snapshot replays only the tail of a long session, so `firstSeq` alone
   * cannot tell a client whether there is anything above what it was given —
   * and comparing it against zero says "yes" for every session ever created,
   * because seq numbering starts at one. This is the honest floor: there is
   * more to page in exactly when `firstSeq < replayFrom`.
   *
   * Optional so a client can tell a server that predates it apart from one
   * reporting a fully-replayed session, and default to offering no paging.
   */
  replayFrom?: number;
  /** Highest seq written. */
  cursor: number;
  /** True when the runtime process is alive. */
  live: boolean;
  /**
   * The runtime's own id for this conversation, when one was recorded.
   *
   * Only interesting alongside `live: false`, where it is the difference
   * between offering to *continue* the conversation on screen and offering
   * only to start over: with it the agent comes back knowing what was said,
   * without it a restart is a stranger reading someone else's transcript.
   */
  nativeSessionId?: string;
  bypassPermissions: boolean;
}

/** Capabilities for a runtime with no chat adapter at all. */
export const NO_CHAT_CAPABILITIES: ChatCapabilities = {
  streaming: false,
  thinking: false,
  toolCalls: false,
  diffs: false,
  permissions: false,
  interrupt: false,
  resume: false,
  fork: false,
  attachments: false,
  usage: false,
  cost: false,
  plan: false,
};

/**
 * Tool-name → kind mapping shared by every adapter.
 *
 * Substring matching on a lowercased name, because the four protocols spell the
 * same operation a dozen ways and an exact-match table would need editing every
 * time a CLI renames a tool. Order matters: the first hit wins, so the more
 * specific prefixes are listed before the generic ones.
 */
const TOOL_KIND_PATTERNS: Array<[RegExp, ToolKind]> = [
  [/todo|task_?list|plan/, 'todo'],
  [/multi_?edit|edit|write|patch|apply|create_?file/, 'edit'],
  [/delete|remove|rm\b/, 'delete'],
  [/move|rename/, 'move'],
  [/grep|glob|search|find|list_?dir|ls\b/, 'search'],
  [/bash|shell|exec|command|terminal|run\b/, 'execute'],
  [/fetch|http|web|url|browser/, 'fetch'],
  [/think|reason/, 'think'],
  [/agent|task|subagent|dispatch/, 'task'],
  [/read|cat|view|open/, 'read'],
];

/** Best-effort category for a runtime's tool name. Never throws, never guesses wildly. */
export function classifyTool(name: string): ToolKind {
  const lowered = String(name || '').toLowerCase();
  for (const [pattern, kind] of TOOL_KIND_PATTERNS) {
    if (pattern.test(lowered)) {
      return kind;
    }
  }
  return 'other';
}

/** The allow/deny pair used when a runtime offers no options of its own. */
export function defaultPermissionOptions(): PermissionOption[] {
  return [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ];
}

/** Whether an option id means "let it run". Used by the bypass path too. */
export function isAllowOption(option: PermissionOption | undefined): boolean {
  return option?.kind === 'allow_once' || option?.kind === 'allow_always';
}

/** Sum two usage records, tolerating the many fields runtimes omit. */
export function mergeUsage(base: ChatUsage | undefined, next: ChatUsage | undefined): ChatUsage {
  const a = base || {};
  const b = next || {};
  const add = (x?: number, y?: number): number | undefined => {
    if (x === undefined && y === undefined) return undefined;
    return (x || 0) + (y || 0);
  };
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    costUsd: add(a.costUsd, b.costUsd),
    // Not additive: these describe the window, not consumption within it.
    contextWindow: b.contextWindow ?? a.contextWindow,
    contextUsed: b.contextUsed ?? a.contextUsed,
  };
}
