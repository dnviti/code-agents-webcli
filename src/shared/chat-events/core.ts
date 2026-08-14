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
  | 'canceled'
  /**
   * The call never reported an ending and nothing can report one any more.
   *
   * Distinct from `canceled`, which says somebody stopped it, and from
   * `failed`, which says it broke: nobody stopped this and nothing is known to
   * have gone wrong — the runtime simply stopped talking about it and the turn
   * it belonged to is over. No adapter ever emits it; the reducer sets it when
   * it reconciles a finished turn against the calls still open inside it
   * (#139). A spinner that will never stop is a worse answer than this one.
   */
  | 'unknown';

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

/** The latest complete plan submitted for a conversation. */
export interface PlanDocument {
  /** Complete markdown, never a patch against an earlier revision. */
  markdown: string;
  /** Monotonically increasing within one conversation. */
  revision: number;
  /** When this revision was submitted, in milliseconds since the epoch. */
  ts: number;
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
  /**
   * How much reasoning the runtime said this block holds, in its own estimate.
   *
   * The field exists for the runtimes that report *that* the model reasoned
   * without handing over a word of it. Claude Code is the one measured here: as
   * of 2.1.220 every `thinking` block on the wire carries `"thinking": ""` and a
   * signature, and the only description of what was thought is a running token
   * estimate on the side. So a reasoning entry either has text or has this, and
   * the UI renders whichever it was given rather than an empty box (#120).
   *
   * An estimate, and named as one: measured against the same turn's billed
   * `thinking_tokens` it runs high (114 reported against 71 billed, 152 against
   * 118), because it is a live count made while the block is still open. Shown
   * with a `~` for that reason. It is never a substitute for the usage figures —
   * those come from the runtime's own accounting and are what the meter reads.
   */
  tokens?: number;
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
  /**
   * Set when `output` is a launch acknowledgement rather than a result.
   *
   * A workflow started in the background answers its caller in seconds with
   * "Workflow launched in background. Task ID: …" and then works for minutes.
   * That sentence is a receipt, and captioning it as the run's final output
   * offers it as the answer to a question that has not been answered yet
   * (#116). The run's real result replaces it when it arrives.
   */
  launchReceipt?: boolean;
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
  /** The run's own name, when it has one of its own. See `WorkflowRun`. */
  workflowName?: string;
  /** The phases and agents inside a workflow. Absent for a plain delegation. */
  workflow?: WorkflowRun;
}

/**
 * One named phase of a workflow run.
 *
 * `index` is the run's own numbering, one-based and assigned in the order the
 * phases were declared or first entered; it is the phase's identity, and how a
 * later report finds the row it belongs to.
 *
 * No state of its own, deliberately. The runtime reports a phase once, when it
 * is registered, and never again — whether it is waiting, working or finished
 * is a fact about the agents inside it, and deriving it from them is the only
 * reading that cannot disagree with the rows underneath.
 */
export interface WorkflowPhase {
  index: number;
  title: string;
  /** Carried rather than interpreted: the runtime does not populate it yet. */
  kind?: string;
}

/**
 * How far one agent inside a workflow has got.
 *
 * Four words, mapped from the runtime's own (`start` / `progress` / `done` /
 * `error`), because a fifth spelling of "running" across this codebase is a
 * fifth thing to keep in step with `ToolStatus`.
 */
export type WorkflowAgentState = 'queued' | 'running' | 'done' | 'failed';

/**
 * One agent a workflow started, as the run reports it while it works.
 *
 * Keyed by `index` — the run's own agent number, one-based and stable across
 * every report about that agent, including a retry. `agentId` changes when an
 * agent is respawned, so it identifies an attempt rather than a row.
 */
export interface WorkflowAgent {
  index: number;
  /** The label the script gave it, e.g. `review:bugs`. */
  label: string;
  state: WorkflowAgentState;
  /** Which phase it belongs to. Absent for an agent started outside any. */
  phaseIndex?: number;
  phaseTitle?: string;
  /** The runtime's id for this attempt, not for the row. */
  agentId?: string;
  /** A named subagent type, when the script asked for one. */
  agentType?: string;
  model?: string;
  /** Set when the runtime answered on a different model than it was asked for. */
  fallbackModel?: string;
  /** `worktree` or `remote`, when the agent runs somewhere of its own. */
  isolation?: string;
  /** The opening of what it was asked to do; the run truncates this itself. */
  prompt?: string;
  /** The tool it last reached for, and that call in one line. */
  lastTool?: string;
  lastToolDetail?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
  queuedAt?: number;
  /** Which try this is; above 1 the run retried it. */
  attempt?: number;
  /** Why the last attempt ended, when it ended in a retry. */
  lastAttemptReason?: string;
  /** True when the result came from the run's journal, not a fresh agent. */
  cached?: boolean;
  /** True when a safety classifier refused to start it. */
  blocked?: boolean;
  /** The opening of what it returned. */
  result?: string;
  error?: string;
}

/**
 * The shape of a workflow run: its phases, and the agents inside them.
 *
 * Reported continuously on the same channel as `AgentRun` (see above), as a
 * complete snapshot each time rather than a delta — which is why the reducer
 * upserts by index instead of appending. The runtime sends it on some progress
 * reports and not others, so an absent list means "nothing new to say", never
 * "the run has no phases".
 */
export interface WorkflowRun {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
}

export interface ImageBlock {
  kind: 'image';
  mime: string;
  /** Server-relative URL. Image bytes never travel inside an event. */
  url: string;
  alt?: string;
}

/**
 * A file uploaded with a user turn.
 *
 * Kept distinct from an image emitted by a runtime: an attachment is a stored
 * workspace artefact the user can fetch back, regardless of its media type.
 * The bytes remain in `.cc-web`; only their canonical session URL is recorded.
 */
export interface AttachmentBlock {
  kind: 'attachment';
  mime: string;
  url: string;
  name: string;
  size: number;
}

export interface PlanBlock {
  kind: 'plan';
  items: PlanItem[];
}

export interface ErrorBlock {
  kind: 'error';
  text: string;
  /**
   * True when this is the error the turn died of, rather than one it read and
   * moved past.
   *
   * The distinction is the whole of issue #74: a runtime that reports "could
   * not read that file" mid-turn and carries on has not failed the turn, and a
   * runtime whose process went away has. Recorded on the block because that is
   * what survives into a snapshot — a turn cut short this way never reaches the
   * `turn_end` that would otherwise say how it ended.
   */
  fatal?: boolean;
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
  notice: 'compacted' | 'cleared' | 'interrupted' | 'branched' | 'model';
  text: string;
  /** Optional detail — how much was reclaimed, what the summary covers. */
  detail?: string;
}

