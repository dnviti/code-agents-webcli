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

import { TurnOutcome } from './turn-outcome.js';

export type { TurnOutcome };

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
  notice: 'compacted' | 'cleared' | 'interrupted' | 'branched';
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
   * `unknown` — nobody could, and the reading has no ceiling in it.
   *
   * The first two are kept because they are not equally authoritative and the
   * difference is measurable: grok reports 512,000 tokens for `grok-build`,
   * while the nearest entry in a provider catalogue says 256,000. Half. An
   * agent's own figure always wins, and this field is what lets a reader see
   * which one they got.
   *
   * The third exists because a ceiling sometimes has to come *down*. Switch to
   * a model neither the agent nor the catalogue can size and the previous
   * model's figure would otherwise stand there being read as this one's — the
   * bar, the percentage, the "N left" warning, all describing a conversation
   * the user has left. Leaving `contextWindow` out cannot say that: every merge
   * here reads an absent number as "this report is silent about it", which is
   * exactly what keeps a streaming patch from blanking the figures beside it.
   * So the retraction is spoken, and `mergeUsage` is the one place that acts on
   * it.
   *
   * Absent alongside a `contextWindow` should not happen; absent alongside no
   * `contextWindow` is the ordinary "nobody has said yet" case, which the UI
   * states in words rather than drawing a bar against a guess.
   */
  contextWindowSource?: ContextWindowSource;
  /**
   * Which model the window above is about.
   *
   * An agent states its ceiling for the model it is running, and that statement
   * reaches the session *before* the first message that names the model — a
   * switch is confirmed on its own channel and the naming message belongs to
   * the next turn. Unattributed, the session reads the new model's figure as
   * the old one's, then asks a catalogue about an id no catalogue has heard of
   * and takes the agent's own answer down as unknown.
   *
   * Absent means nobody said, which is the ordinary case: a runtime whose model
   * cannot change mid-conversation has nothing to disambiguate.
   */
  contextWindowModel?: string;
}

/**
 * What one model did during a turn, as the runtime itself reported it.
 *
 * The distinction this exists to keep is between the model that was *asked
 * for* and the model that *ran*. A requested model is a fact about this app; a
 * reported one is a fact about the work, and only the second belongs in a spend
 * record. Nothing here is ever filled in from `options.model`.
 *
 * A list rather than a field because a turn can legitimately involve more than
 * one: a subagent runs on a different model, a runtime falls back after a
 * failure. Claude and grok both report exactly this, keyed by model, and
 * folding it back into one name would be the misattribution the whole record
 * exists to avoid.
 *
 * `calls` is the runtime's own count of round trips to that model — grok's
 * `modelCalls`. It is the only per-model measure of effort any of them give;
 * tool calls are never attributed to a model by anybody, so they are not
 * attributed here either.
 */
export interface TurnModelUsage {
  model: string;
  calls?: number;
  usage?: ChatUsage;
}

export type ContextWindowSource = 'agent' | 'provider' | 'unknown';

/** A message as the reducer assembles it. */
/**
 * One turn as the recorded conversation has it, for the index beside it.
 *
 * Sent whole rather than paged: it is the index of the conversation, and an
 * index that begins where the last page happened to stop is not one (#86).
 * Thin enough that "whole" stays cheap — a turn contributes one line of it.
 */
export interface ChatTurnIndexEntry {
  /** The opening message's id, which is what a client scrolls to. */
  id: string;
  turnId: string;
  /** 1-based over the whole conversation, not over what is loaded. */
  index: number;
  /**
   * Where this turn opens in the log, so a reader can cut the conversation at
   * it — which is what branching from a turn needs and nothing else has.
   *
   * Optional because it rides on the wire: a browser talking to a server that
   * predates it must read "not stated" rather than zero, which would name the
   * head of the log as every turn's start.
   */
  startSeq?: number;
  /** The user's first line, or null for a turn nobody prompted. */
  label: string | null;
  startedAt: number;
  /** How the turn ended, or null while it is still running. */
  outcome: TurnOutcome | null;
  /**
   * What this one turn cost, as the accounting recorded it.
   *
   * From the accounting rather than added up from the messages, because the
   * money cannot be added up from the messages: half the runtimes here report a
   * running total rather than a per-turn figure, and turning that into "what
   * this turn cost" means taking the difference against where the turn started
   * — which is what the accountant did when it filed the row this reads back.
   * Taking it from the same place is also the only way the figure beside a turn
   * and the figure on the dashboard can be relied on to agree.
   *
   * Absent for a turn still running, and for one whose runtime reported
   * nothing — which is a different thing from zero, and says so on screen.
   */
  usage?: ChatUsage;
}

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
  /**
   * How the turn this message belongs to ended, stamped at `turn_end`.
   *
   * On the messages rather than beside the transcript because the messages are
   * what survives: a browser rebuilds a conversation from `ChatSnapshot`, which
   * carries the message list and the session's own fields and nothing else, and
   * history paging prepends messages alone. Absent means the turn has not ended
   * — which is a different thing from a turn that ended without saying why, and
   * the reason this is an outcome and not a raw stop reason.
   */
  turnOutcome?: TurnOutcome;
  usage?: ChatUsage;
  /** Model that produced this message, when reported. */
  model?: string;
  /** True while the runtime is still appending to this message. */
  streaming?: boolean;
  /**
   * Set on a user message delivered into the turn that was already running.
   *
   * It shares that turn's `turnId`, so it is grouped into it rather than
   * starting one — see the event of the same name.
   */
  steer?: true;
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
  /**
   * Reasoning-effort levels this runtime will accept, cheapest first.
   *
   * Absent means the runtime has no effort knob anyone has watched working, and
   * the control says so instead of offering levels that would be rejected. Every
   * list here came from the runtime itself — either published in its handshake
   * (codex, grok, kimi, omp) or read off its own `--help` and confirmed by
   * feeding it a bad value and reading the complaint (claude, pi).
   *
   * The ladders are not comparable across runtimes: `high` is the top of grok's
   * and the middle of pi's. That is what `rank` is for.
   */
  efforts?: EffortChoice[];
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
 * One reasoning-effort level, as the runtime that offers it named it.
 *
 * `value` is sent back to that runtime verbatim, so it is never a word this app
 * invented: kimi answers `on`/`off`, pi answers `xhigh`, codex answers `ultra`,
 * and a level spelled any other way is refused by name.
 */
export interface EffortChoice {
  value: string;
  name: string;
  description?: string;
  /**
   * Where this level sits on its own runtime's ladder — 0 is the least thinking
   * on offer, 1 the most.
   *
   * Carried rather than derived from list order because the UI colours by it,
   * and a colour derived from position in a list would make kimi's `on` (of two)
   * a different weight from pi's `max` (of seven) when both are that runtime's
   * ceiling. It also gives the levels that are not points on a ladder somewhere
   * honest to sit: omp's `auto` picks per prompt, so it ranks mid.
   */
  rank: number;
}

/**
 * Evenly-spaced ranks for a ladder given cheapest-first.
 *
 * The common case — a runtime whose levels really are a straight line — so the
 * adapters that have one do not each write the same division out.
 */
export function rankedEfforts(
  levels: Array<{ value: string; name?: string; description?: string }>,
): EffortChoice[] {
  const last = Math.max(1, levels.length - 1);
  return levels.map((level, index) => ({
    value: level.value,
    name: level.name ?? level.value,
    ...(level.description ? { description: level.description } : {}),
    rank: index / last,
  }));
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
  | {
      t: 'msg_start';
      seq: number;
      ts: number;
      id: string;
      role: ChatRole;
      turnId: string;
      model?: string;
      /**
       * Set on a user message that was delivered *into* the turn already
       * running, rather than waiting for its own (#86).
       *
       * Recorded rather than worked out later, because it cannot be worked out
       * later: two messages typed while the agent was busy look identical
       * afterwards, and which of them steered the running work and which waited
       * its turn is the whole of what decides the turn count. A steer carries
       * the running turn's own `turnId`, so the transcript and the accounting
       * both fold it into the turn it belongs to; this flag is what says that
       * was deliberate.
       */
      steer?: true;
    }
  | { t: 'block_start'; seq: number; ts: number; msgId: string; index: number; block: ChatBlock }
  /**
   * Append to an open block. `text` extends a text/thinking block; `json`
   * extends a tool block's streaming arguments; `tokens` adds to a thinking
   * block's reported size, for a runtime that reports the size of reasoning it
   * will not show (see `ThinkingBlock.tokens`).
   */
  | {
      t: 'block_delta';
      seq: number;
      ts: number;
      msgId: string;
      index: number;
      text?: string;
      json?: string;
      tokens?: number;
    }
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
  /**
   * The structure of a workflow run, addressed to the call that started it.
   *
   * Separate from `agent_progress` because the merge is different: that patch
   * is a shallow assign over the run, and these are lists whose rows have to
   * survive a report that does not mention them. See `WorkflowRun`.
   */
  | {
      t: 'workflow_progress';
      seq: number;
      ts: number;
      parentToolId: string;
      phases?: WorkflowPhase[];
      agents?: WorkflowAgent[];
    }
  /**
   * A workflow run ended badly, addressed to the call that started it.
   *
   * Its own event rather than an `error` or a `tool` patch, because it is one
   * fact with three consequences and they have to happen together: the call
   * that launched the run is no longer a success, the conversation has to say
   * so where the person will read it, and somebody who is not looking has to be
   * told. Sending three events would let a replay apply two of them.
   *
   * Raised only for the run's *own* verdict. Agents inside a workflow fail
   * routinely and by design — `parallel()` resolves a thrown agent to `null`
   * rather than rejecting — so a failed agent is counted (see
   * `summarizeWorkflow`) and never announced as the run failing (#140).
   */
  | {
      t: 'workflow_failed';
      seq: number;
      ts: number;
      /** The tool call that launched the run. */
      parentToolId: string;
      /** The run's own name, when it has one. */
      name?: string;
      /** Why it ended, in the runtime's own words. */
      reason?: string;
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
      /**
       * How many round trips to the model the turn took, where the runtime
       * counts them itself — Claude's `num_turns`.
       *
       * Only ever the runtime's own figure. Counting the messages that came out
       * instead is what made this number mean a different thing per agent, so
       * there is nowhere here for a derived one to go: a runtime that does not
       * report it leaves this unset, and every surface downstream says "not
       * reported" rather than showing a count it inferred (#86).
       */
      modelTurns?: number;
      /**
       * Which models actually ran this turn, when the runtime said.
       *
       * Late by nature: a runtime that breaks its spend down per model does it
       * at the end, once it knows. So this is a correction as much as a
       * report — it is what lets a conversation that opened with no model at
       * all end the turn naming the one that answered.
       */
      models?: TurnModelUsage[];
      /**
       * The runtime letting go of work that was cut short, not a turn ending.
       *
       * Sending a message ahead of the queue interrupts the agent, and every
       * runtime here answers an interrupt by ending its own run — but the turn
       * is not over: the message was delivered *into* it and the agent carries
       * straight on with it. Left unmarked, that acknowledgement closed the
       * turn a moment before the redirected work began, so the answer to the
       * correction arrived in a turn of its own with nobody's question in it.
       *
       * What it still carries is what the cut-short half spent, which is real
       * money and stays on the turn's bill. Only the ending is suppressed.
       */
      stale?: true;
    }
  /** The runtime revised what it can do — new slash commands, a model switch. */
  | { t: 'capabilities'; seq: number; ts: number; capabilities: Partial<ChatCapabilities> }
  /**
   * The runtime said which reasoning-effort level it is now running.
   *
   * Emitted only where the runtime itself reported the level — at a handshake
   * that names it, or after a change the runtime acknowledged. Nothing emits
   * this on the strength of having *asked*: the whole point of a separate event
   * is that the chip shows what the agent said it is doing, not what this app
   * requested and hopes it got. A request that was accepted but not confirmed
   * travels the same road a model switch does, as `applied: 'sent'`.
   *
   * `null` means the runtime is back on its own default.
   */
  | { t: 'effort'; seq: number; ts: number; effort: string | null }
  /**
   * Something happened to the conversation itself.
   *
   * `compacted` leaves a marker in place and keeps the transcript: what was
   * said still happened and is still worth scrolling back to, even though the
   * agent can no longer see it. `cleared` empties the transcript, because that
   * is what the user asked for — `/clear` means "start again", and a window
   * still full of the previous conversation would be the opposite of that.
   * `interrupted` records a turn cut short so the message waiting behind it
   * could be answered first: without it the transcript reads as an agent that
   * stopped for no reason, and the message that follows looks unrelated to the
   * work that stopped. `detail` carries what that message was.
   *
   * `branched` closes the history a new conversation was started from. What is
   * above it was said somewhere else and copied here to be read; what is below
   * it is this conversation's own. The agent is handed the same history as its
   * opening context, and the line is where a reader is told so — a branch that
   * looked like an ordinary transcript would be claiming the agent lived
   * through it (#34).
   */
  | {
      t: 'marker';
      seq: number;
      ts: number;
      kind: 'compacted' | 'cleared' | 'interrupted' | 'branched';
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
  /**
   * Why the last attempt to hand this turn over failed.
   *
   * A turn that could not be delivered stays in line with this set rather than
   * being dropped: the whole point of queueing is to walk away and trust it,
   * and a queue that discards work silently is worse than no queue (#89). The
   * text is still here, so it is recoverable without retyping.
   */
  error?: string;
  /** How many times delivery has been attempted. Absent means not yet tried. */
  attempts?: number;
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
  /**
   * The turn still open where the replay ended, or null when none is.
   *
   * A snapshot is a window, and a browser that joins mid-turn has to know which
   * turn the next event belongs to. Without it the first message to arrive
   * after the join opens a turn of its own under the runtime's id — a row in
   * the index with no prompt to name it by, spinning next to the turn it is
   * actually part of.
   *
   * Optional so a snapshot from a server that predates it reads as "nothing
   * open", which is the behaviour this replaces rather than a wrong claim.
   */
  currentTurnId?: string | null;
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
  /**
   * The reasoning-effort level the runtime last reported, when it reported one.
   *
   * Replayed like everything else here, and needed for the same reason the
   * transcript keeps it at all: an `effort` event is the runtime describing
   * itself, and a browser rejoining a live conversation has no other way to
   * learn what it is thinking at. Without it, a reload of a codex session that
   * opened at `xhigh` — and is still running at `xhigh` — showed the control
   * blank, because the conversation had never *chosen* a level and so the record
   * had nothing to send either.
   *
   * Optional so a snapshot written before this existed reads as "nobody said",
   * which is exactly what it is.
   */
  effort?: string;
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
  // The one report that takes a figure away instead of contributing one: the
  // conversation moved to a model nobody can size, and the ceiling that is up
  // belongs to the model it left. Said out loud precisely because `??` below
  // would otherwise keep the old number — an omitted field means "no news"
  // everywhere else here, and has to go on meaning that.
  const retracted = b.contextWindowSource === 'unknown';
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    costUsd: add(a.costUsd, b.costUsd),
    // Not additive: these describe the window, not consumption within it.
    contextWindow: retracted ? undefined : (b.contextWindow ?? a.contextWindow),
    contextUsed: b.contextUsed ?? a.contextUsed,
    // Travels with the window it describes rather than being picked
    // independently, or a later turn that only refreshed the occupancy would
    // leave an older window labelled with the newer one's provenance.
    contextWindowSource:
      retracted || b.contextWindow !== undefined ? b.contextWindowSource : a.contextWindowSource,
    contextWindowModel:
      retracted || b.contextWindow !== undefined ? b.contextWindowModel : a.contextWindowModel,
  };
}
