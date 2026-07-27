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
  /** Set on a delegation: what the agent behind this call did. See `AgentRun`. */
  agent?: AgentRun;
}

/**
 * One action a delegated agent took inside its own work.
 *
 * Deliberately not a `ToolBlock`: a step is keyed by the *inner* tool id, which
 * lives in the sub-agent's own namespace and must never be reachable through
 * the transcript's `toolIndex` — a patch aimed at the parent conversation and
 * one aimed at a step would otherwise collide on the same key.
 */
export interface AgentStep {
  /** The inner call's own id, so its result can find the step it belongs to. */
  id: string;
  name: string;
  toolKind: ToolKind;
  status: ToolStatus;
  input?: unknown;
  output?: string;
  /** Set when the step itself failed, which is not the same as the run failing. */
  error?: string;
  ts: number;
}

/**
 * A step as it arrives on the wire: always identified, otherwise partial.
 *
 * A step is reported twice — once when the agent calls the tool and once when
 * the result comes back — and the second report knows only the id, the outcome
 * and the output. Sending a whole `AgentStep` both times would mean the closing
 * half overwriting the tool's name with a placeholder, so only what is actually
 * known is sent and the reducer merges it.
 */
export type AgentStepPatch = Partial<AgentStep> & { id: string };

/**
 * What a delegated agent is doing inside a single delegation.
 *
 * The runtime reports this out of band from the tool call that started it
 * (`task_started` / `task_progress` / `task_updated` alongside messages tagged
 * with a `parent_tool_use_id`), so it hangs off the tool block rather than
 * being folded into its `output` — which only ever holds the final summary.
 */
export interface AgentRun {
  steps: AgentStep[];
  /** The agent's own description of what it is doing right now. */
  activity?: string;
  /** Name of the most recent tool it reached for. */
  lastTool?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  /** The run's own outcome, which can fail while individual steps succeeded. */
  status?: ToolStatus;
  error?: string;
  /** What it was asked to do. */
  prompt?: string;
  subagentType?: string;
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
  /**
   * Who said the window is that big.
   *
   * `agent` — the runtime reported it about the model it is running.
   * `provider` — the agent said nothing, so the model's provider was asked.
   *
   * Kept because the two are not equally authoritative and the difference is
   * measurable: grok reports 512,000 tokens for `grok-build`, while the nearest
   * entry in a provider catalogue says 256,000. Half. An agent's own figure
   * always wins, and this field is what lets a reader see which one they got.
   *
   * Absent alongside a `contextWindow` should not happen; absent alongside no
   * `contextWindow` is the ordinary "nobody could say" case, which the UI
   * states in words rather than drawing a bar against a guess.
   */
  contextWindowSource?: ContextWindowSource;
}

export type ContextWindowSource = 'agent' | 'provider';

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

/**
 * One selectable answer to a question the model asked.
 *
 * `optionId` is minted by this app rather than taken from the model, which only
 * ever supplies a label: two options can legitimately carry the same words
 * ("Yes, and stop" / "Yes, and stop") and an id derived from the text would make
 * them the same button.
 */
export interface QuestionOption {
  optionId: string;
  label: string;
  /** The model's own gloss on what picking this means. */
  description?: string;
}

/**
 * A question the model asked, waiting on a person.
 *
 * Deliberately *not* a `PermissionRequest`. An approval is the app gating the
 * agent — the options are always some arrangement of allow and deny, and the
 * answer's meaning is known before it is given. A question is the agent asking
 * the user something the app has no opinion about, the options are whatever the
 * model wrote, and the answer is content rather than a decision. Folding the two
 * together would mean either teaching the approval card to render arbitrary
 * options or teaching `isAllowOption` to answer for text it cannot interpret.
 */
export interface QuestionRequest {
  requestId: string;
  /**
   * The tool call that asked, when it could be identified.
   *
   * Present so the card can be drawn where the question was actually asked
   * rather than in a tray at the bottom. Optional because correlation is
   * best-effort and an uncorrelated question must still be answerable — an
   * agent blocked on a question with no button anywhere is a hung session.
   */
  toolId?: string;
  question: string;
  /** A short label for the question, when the model supplied one. */
  header?: string;
  /** True when more than one option may be picked before confirming. */
  multiSelect: boolean;
  options: QuestionOption[];
  ts: number;
}

/** What a chat session is doing right now, for the header indicator. */
export type ChatState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'running'
  | 'awaiting_permission'
  /** Blocked on a question the model asked, which only a person can answer. */
  | 'awaiting_answer'
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
  /**
   * The model can put a multiple-choice question to the user and wait for it.
   *
   * Optional rather than required so a stored snapshot written before this
   * existed still parses; absent reads as false everywhere it is consulted.
   */
  questions?: boolean;
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
  /**
   * One step a delegated agent took, addressed to the delegation that owns it.
   *
   * Separate from `tool` because it is keyed twice over: `parentToolId` finds
   * the delegation's block, and `step.id` finds (or creates) the step inside
   * it. Routing this through `tool` would put sub-agent tool ids into the
   * transcript's own index, where a later top-level patch could hit them.
   */
  | { t: 'agent_step'; seq: number; ts: number; parentToolId: string; step: AgentStepPatch }
  /** Progress for the run as a whole, merged over whatever is already known. */
  | {
      t: 'agent_progress';
      seq: number;
      ts: number;
      parentToolId: string;
      patch: Partial<Omit<AgentRun, 'steps'>>;
    }
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
  | { t: 'question'; seq: number; ts: number; request: QuestionRequest }
  | {
      t: 'question_resolved';
      seq: number;
      ts: number;
      requestId: string;
      /**
       * The tool call that asked, repeated from the request.
       *
       * Carried on the resolution as well so a card rebuilt from the log alone
       * can find its own answer: the request is dropped from the pending list
       * the moment it resolves, and the id would otherwise go with it.
       */
      toolId?: string;
      /** Every option the user picked, in the order the question offered them. */
      optionIds: string[];
      /**
       * True when the user chose to answer nothing.
       *
       * The model is still told — it is blocked and something has to come back —
       * but the transcript says "skipped" rather than inventing a selection.
       */
      skipped?: boolean;
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
   * Questions still waiting on an answer.
   *
   * Optional for the same reason `queued` is: a snapshot replayed by a server
   * that predates this should read as "none pending", not as malformed.
   */
  pendingQuestions?: QuestionRequest[];
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
  questions: false,
};

/** The MCP server this app exposes to the runtimes it launches. */
export const ASK_MCP_SERVER = 'ccweb';

/** The one tool that server offers: put a multiple-choice question to the user. */
export const ASK_QUESTION_TOOL = 'ask_user_question';

/**
 * What the tool is called once a runtime has namespaced it.
 *
 * Claude prefixes MCP tools as `mcp__<server>__<tool>`, and that prefixed name
 * is what shows up in the transcript — so this is the string the UI matches on
 * to draw a question card instead of a generic tool row.
 */
export const ASK_QUESTION_TOOL_NAME = `mcp__${ASK_MCP_SERVER}__${ASK_QUESTION_TOOL}`;

/**
 * Whether a tool name refers to this app's question tool.
 *
 * Suffix rather than equality: runtimes namespace MCP tools differently (and
 * have changed the separator before), so the bare name is the part that can be
 * relied on. Nothing else in the transcript is called this.
 */
/**
 * Turn whatever a model passed as `options` into answerable choices.
 *
 * Shared rather than implemented on each side, and that is the whole point: the
 * server mints the ids it will later be answered with, and the browser mints the
 * same ids again when it rebuilds a card from the tool call in a replayed
 * transcript. Two copies of this that drifted by one dropped entry would put the
 * tick on the wrong option, which is a lie about what the user chose.
 *
 * Ids are positional rather than derived from the labels: two options may
 * legitimately read the same, and a label-derived id would collapse them into
 * one button that answers for both. Anything unusable is dropped instead of
 * rendered as an empty choice, and a bare string is accepted as its own label
 * because that is what a model reaches for when the schema slips its mind.
 */
export function normalizeQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    let label = '';
    let description: string | undefined;
    if (typeof entry === 'string') {
      label = entry.trim();
    } else if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      const text = object.label ?? object.name ?? object.value ?? object.title;
      if (typeof text === 'string') label = text.trim();
      if (typeof object.description === 'string' && object.description.trim()) {
        description = object.description.trim();
      }
    }
    if (!label) continue;
    options.push({ optionId: `opt-${options.length}`, label, description });
  }
  return options;
}

export function isAskQuestionTool(name: string | undefined): boolean {
  if (!name) return false;
  // Suffix match on a separator of either width. Claude namespaces MCP tools as
  // `mcp__<server>__<tool>`; omp reports the same tool as
  // `mcp__ccweb_ask_user_question`, with one underscore. Both were observed —
  // an exact-name table would have silently failed for one of them.
  return name === ASK_QUESTION_TOOL || /(^|_)ask_user_question$/.test(name);
}

/**
 * Whether a tool block is this app's question tool, however the runtime named it.
 *
 * The name alone is not enough. ACP has no separate tool-name field at all: the
 * adapter uses the agent's own title for the block ("Asking tabs vs spaces
 * preference"), and the real tool name turns up inside the arguments instead
 * (omp puts it in `rawInput.path`). So the arguments are consulted too.
 */
export function looksLikeAskCall(name: string | undefined, input: unknown): boolean {
  if (isAskQuestionTool(name)) return true;
  if (input === undefined || input === null) return false;
  try {
    return JSON.stringify(input).includes(ASK_QUESTION_TOOL);
  } catch {
    return false;
  }
}

/** A question as it can be read back out of the call that asked it. */
export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * Read a question back out of a tool call's arguments.
 *
 * Shared between the session — which pairs an incoming question with the call
 * that asked it — and the browser, which rebuilds the card from a replayed
 * transcript. Two implementations that disagreed about which options survive
 * would put the tick on an option the user did not choose.
 *
 * Two shapes are accepted because two were observed: the arguments themselves,
 * and an envelope carrying them as a JSON string (omp reports the call as
 * `{ path: 'xd://mcp__ccweb_ask_user_question', content: '{...}' }`). Tolerant
 * by contract — `input` is `unknown` everywhere else in this file for good
 * reason, and a malformed call should render as nothing rather than throw.
 */
export function askedQuestionFrom(input: unknown): AskedQuestion | null {
  const object = asRecord(input);
  if (!object) return null;

  const direct = readQuestion(object);
  if (direct) return direct;

  // An envelope. `content` is the field omp uses; the others cost nothing to
  // accept and save a second round of probing if another agent picks one.
  for (const key of ['content', 'arguments', 'input', 'params']) {
    const inner = object[key];
    if (typeof inner === 'string') {
      try {
        const parsed = readQuestion(asRecord(JSON.parse(inner)));
        if (parsed) return parsed;
      } catch {
        // Not JSON, so not a question. Keep looking.
      }
    } else if (inner && typeof inner === 'object') {
      const parsed = readQuestion(asRecord(inner));
      if (parsed) return parsed;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readQuestion(object: Record<string, unknown> | undefined): AskedQuestion | null {
  if (!object) return null;
  const question = typeof object.question === 'string' ? object.question.trim() : '';
  if (!question) return null;
  const options = normalizeQuestionOptions(object.options);
  if (options.length === 0) return null;
  return {
    question,
    header:
      typeof object.header === 'string' && object.header.trim() ? object.header.trim() : undefined,
    multiSelect: object.multiSelect === true,
    options,
  };
}

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
    // Travels with the window it describes rather than being picked
    // independently, or a later turn that only refreshed the occupancy would
    // leave an older window labelled with the newer one's provenance.
    contextWindowSource:
      b.contextWindow !== undefined ? b.contextWindowSource : a.contextWindowSource,
  };
}
