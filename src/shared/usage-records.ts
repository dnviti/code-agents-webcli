/**
 * The accounting vocabulary: what one piece of agent work cost, durably.
 *
 * Separate from `chat-events.ts` on purpose. That file describes a conversation
 * as it happens and is thrown away when the session is; this one describes work
 * that has already finished and is kept forever. The two overlap on numbers and
 * on nothing else — nothing here carries a word anybody typed, because an
 * accounting record that quotes the conversation is a transcript wearing a
 * different name, and it would outlive every rule that protects the real one.
 *
 * The distinction this whole file is built around is **null versus zero**. An
 * agent that reports no cost and an agent that reports a cost of zero are not
 * the same fact, and a dashboard that renders both as "$0.00" is lying about
 * one of them. Every measured field is therefore nullable, and every total
 * carries the count of records that actually contributed to it.
 */

/** How a job stopped. */
export type UsageOutcome =
  /** The runtime ended the turn of its own accord. */
  | 'completed'
  /** The process died, or the session was stopped, with a turn still open. */
  | 'interrupted'
  /** The runtime reported an error on the turn. */
  | 'error';

/** One tool, and how many times a job called it. */
export interface UsageToolCount {
  tool: string;
  calls: number;
}

/**
 * One unit of agent work: a prompt, and everything the agent did to answer it.
 *
 * **This is a turn.** Not a synonym for one — the same thing, and the reason
 * there is no turn count stored on it: a turn is one of these rows, so counting
 * turns is counting rows, and a stored figure would be a second copy of a fact
 * the table already states, free to disagree with it. It disagreed for a year
 * (#86): the old `turns` column held the number of assistant *messages* inside
 * the unit, which is a property of how an agent chops up its output rather than
 * of the work, so the same job filed 1 under one agent and 6 under another.
 *
 * What a mid-work message belongs to is decided where the work runs, not here,
 * and it decides the count: a message delivered into the turn that is running
 * continues that turn and files into this same row, while one that waited for
 * the turn to finish gets a row of its own. See `UsageAccountant`.
 *
 * `toolCalls` is the number of tool blocks the transcript opened.
 */
export interface UsageJobRecord {
  /** `<sessionId>:<turnId>`. Stable, so re-recording a job replaces it. */
  id: string;
  sessionId: string;
  /** The runtime's own conversation id, when it has one. */
  nativeSessionId: string | null;
  turnId: string;
  userId: number;
  /**
   * The login as it was when the work ran.
   *
   * Denormalised deliberately: the history is meant to outlive the account, and
   * a foreign key to `users` would either cascade the record away or leave a
   * number nobody can read.
   */
  userLogin: string;
  agent: string;
  /** Null when the runtime never said which model it used. */
  model: string | null;
  /**
   * The folder the work ran in, by name — the thing everyone here already calls
   * "the project", and the same label the session tab and header carry.
   *
   * Nullable, and a null is again a fact rather than a default: every row
   * written before this column existed ran in *some* folder that nobody
   * recorded, and inventing one for it would put fabricated figures under a
   * real project's name. Those rows group under "unattributed" instead.
   *
   * A name, not a path. Grouping "what am I spending on this project" by
   * absolute path splits one project across every machine and every checkout
   * it was ever opened from; the cost is that two folders sharing a name in
   * different parents merge, which is stated in the docs rather than hidden.
   */
  project: string | null;
  /**
   * Where that project name came from.
   *
   * `observed` is what the session was actually pointed at when the work ran —
   * a measurement, and treated as one: nothing overwrites it. `manual` is a
   * person's assertion, made after the fact about work nobody recorded a folder
   * for, and it can be corrected or withdrawn by the same person. `null` means
   * there is no project, so there is nothing to have a provenance.
   *
   * The distinction is on the record rather than inferred because it is the
   * same question this whole file is built around, asked of a different field:
   * a figure somebody typed and a figure something measured are not the same
   * fact, and a dashboard that renders them identically is lying about one.
   */
  projectSource: UsageProjectSource;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  outcome: UsageOutcome;
  /**
   * How many round trips to the model the runtime says this turn took.
   *
   * A different quantity from the turn itself, under its own name so the two
   * cannot be confused again, and null where nobody could say. Only a runtime's
   * own figure goes here — Claude's `num_turns`, or a per-model `calls` — never
   * a count of the messages that came out, which is what made the old figure
   * incomparable between agents. Null for every row recorded before #86, and for
   * every runtime that does not report it: "not measured" and "measured as few"
   * are different facts, and this file exists to keep them apart.
   */
  modelTurns: number | null;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  /**
   * What the runtime *claims* it can report, from its adapter capabilities.
   *
   * Kept alongside the figures so a null can be explained rather than merely
   * displayed: "codex does not report cost" and "this job reported no cost even
   * though the agent can" are different stories, and only the first one is
   * uninteresting.
   */
  reportsUsage: boolean;
  reportsCost: boolean;
  tools: UsageToolCount[];
  /**
   * How this job's spend divided between models.
   *
   * Empty in the ordinary case, where `model` above already says everything
   * there is to say. A non-empty list means the turn genuinely ran on more
   * than one — a subagent, a fallback — and these are the runtime's own
   * figures for each.
   */
  models: UsageModelUse[];
}

/** A job as the history list shows it — the record without its tool breakdown. */
export type UsageJobSummary = Omit<UsageJobRecord, 'tools' | 'models'>;

/**
 * What one model did inside a job that used more than one.
 *
 * Present only where the runtime broke its own spend down that way — claude
 * and grok do, on the line that ends a turn. Every field is nullable for the
 * usual reason: a model the runtime named but reported no figures for is a
 * different fact from one it reported zeros for.
 *
 * `calls` is the runtime's own round-trip count. There is no tool count,
 * because nobody reports one per model.
 */
export interface UsageModelUse {
  model: string;
  calls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

/**
 * A set of turns added up.
 *
 * `turns` is the count of records, for the reason given on `UsageJobRecord`:
 * one record is one turn, so this is a measurement rather than a sum of stored
 * figures, and it means the same thing whichever agent ran the work.
 *
 * The `*ReportedTurns` counters are the honesty mechanism: `costUsd` of 0 across
 * 40 turns means something entirely different depending on whether
 * `costReportedTurns` is 40 or 0, and no consumer of this type can render the
 * total without having been handed that distinction. `modelTurns` carries one of
 * its own, because most runtimes never report it at all.
 */
export interface UsageTotals {
  turns: number;
  /** Summed over the turns whose runtime reported it; see `modelTurnsReportedTurns`. */
  modelTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Turns that contributed at least one token figure. */
  tokensReportedTurns: number;
  /** Turns that contributed a cost figure. */
  costReportedTurns: number;
  /** Turns whose runtime reported a round-trip count. */
  modelTurnsReportedTurns: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  tokensReportedTurns: 0,
  costReportedTurns: 0,
  modelTurnsReportedTurns: 0,
};

/** The periods the dashboard answers for. */
export type UsagePeriod = 'day' | 'week' | 'month' | 'year';

/** How wide one point on the trend line is. */
export type UsageBucketUnit = 'hour' | 'day' | 'month';

/** One point on the trend line: a bucket of time, and what it cost. */
export interface UsageBucket {
  /** The bucket's first instant, ISO, in the viewer's own offset. */
  key: string;
  totals: UsageTotals;
}

/** One row of a by-agent / by-model / by-user table. */
export interface UsageBreakdown {
  key: string;
  totals: UsageTotals;
}

/**
 * How much work a turn took, as opposed to what it cost.
 *
 * A histogram rather than percentiles: the question a dashboard actually
 * answers here is "does this agent usually finish in one round trip or does it
 * flail", and a shape shows that where a p90 does not. Buckets are fixed so two
 * agents can be read side by side.
 *
 * The model-turn figures cover `modelTurnsReportedTurns` only, which is why that
 * count travels with them. An average over the turns that answered is a real
 * average of a smaller sample; an average over all of them, with the silent ones
 * read as zero, is the shape of a lie — and it is exactly the comparison between
 * agents this table exists for, so a runtime that never reports would have come
 * out looking like the most efficient one on the page.
 */
export interface UsageEffort {
  key: string;
  turns: number;
  /** Of those turns, how many had a runtime round-trip count to average. */
  modelTurnsReportedTurns: number;
  modelTurnsAvg: number;
  modelTurnsMax: number;
  toolCallsAvg: number;
  toolCallsMax: number;
  /** Reporting-turn counts for modelTurns in 1 / 2 / 3-5 / 6-10 / 11+. */
  modelTurnsHistogram: [number, number, number, number, number];
  /** Turn counts for tool calls in 0 / 1-2 / 3-5 / 6-10 / 11+. */
  toolCallsHistogram: [number, number, number, number, number];
}

/** A tool, how often it was called, and by whom. */
export interface UsageToolUse {
  tool: string;
  /** Null on the overall list; set on the per-agent one. */
  agent: string | null;
  calls: number;
  /** How many turns called it at least once. */
  turns: number;
}

/**
 * One conversation — one chat tab — and everything spent in it.
 *
 * The unit anybody actually thinks in. A tab is one stretch of work on one
 * thing, and the requests inside it are how that work went, not separate pieces
 * of work: filing them separately turns a morning into forty fragments none of
 * which answers "what did this cost".
 *
 * Keyed on the tab's own id, which is durable and is not the runtime's id. That
 * distinction is the whole of why compacting, clearing, or starting a new
 * conversation in the same tab does not split the entry — those replace the
 * runtime's conversation, and the tab goes on being the tab.
 *
 * `agents`, `models` and `projects` are lists rather than single values because
 * a conversation is allowed to have changed any of them mid-way, and naming one
 * of two would be a claim rather than a record. Each is sorted and free of
 * duplicates; `models` may contain nothing at all when no runtime ever said.
 */
export interface UsageConversationSummary {
  /** The tab's id — `usage_jobs.session_id`. */
  sessionId: string;
  /**
   * What the tab is called, or null when the conversation has since been
   * deleted. A job outlives its conversation, so this is missing rather than
   * wrong, and an entry without it still has its project and its agent.
   */
  name: string | null;
  /** Every agent used over the conversation's life, sorted. */
  agents: string[];
  /** Every model any of them reported, sorted. Empty when none ever did. */
  models: string[];
  /** Every project the work ran in, sorted. Empty when none was recorded. */
  projects: string[];
  /** When the earliest recorded job in it started. */
  startedAt: string;
  /** When the latest recorded job in it ended. */
  lastActiveAt: string;
  totals: UsageTotals;
}

/** Whether a job's project was measured or asserted. See `UsageJobRecord.project`. */
export type UsageProjectSource = 'observed' | 'manual' | null;

/** Whose figures a request is asking for. */
export type UsageScope = 'self' | 'everyone';

/**
 * The key a breakdown row uses for work with nothing to group it under.
 *
 * A sentinel rather than an empty string, because it travels back as a *filter*
 * — "show me only the unattributed work" is a real question, and an empty
 * filter value is indistinguishable from no filter at all on a query string.
 * The store turns it back into `IS NULL`.
 *
 * Two slashes because this value goes into a URL and into JSON, so it has to be
 * both impossible and printable. Impossible: a project is a path's last
 * segment, and a segment cannot contain a separator, so no folder can ever be
 * named this. Printable: the first attempt at "impossible" here was a leading
 * control character, which is a thing a query string, a proxy and a CSV cell
 * each mangle in their own way, and which reads as an empty label in every log
 * that touches it.
 */
export const UNATTRIBUTED = '//unattributed';

/**
 * What a dashboard or job list has been narrowed to.
 *
 * One type, shared by the request the browser sends and the query the store
 * runs, so a filter cannot mean one thing on the dashboard and another on the
 * job list it drills into — which is exactly how an export ends up
 * disagreeing with the screen it was exported from.
 */
export interface UsageFilters {
  agent?: string;
  model?: string;
  project?: string;
  /** By login, matching the key of a `byUser` row. */
  user?: string;
  /** Inclusive start / exclusive end of an explicit window, ISO. */
  from?: string;
  to?: string;
}

/** The measures the trend chart can plot. */
export type UsageMeasure = 'costUsd' | 'totalTokens' | 'turns' | 'modelTurns' | 'toolCalls';

/** Everything the dashboard draws, for one range and one scope. */
export interface UsageDashboard {
  scope: UsageScope;
  /** True when this viewer is allowed to ask for `everyone`. */
  canSeeEveryone: boolean;
  period: UsagePeriod;
  /** Inclusive start and exclusive end of the range, ISO. */
  from: string;
  to: string;
  /**
   * How wide one bucket of `series` is.
   *
   * Sent rather than inferred from the period, because a range narrowed to one
   * bucket is re-bucketed at the next granularity down — drill into a month
   * and you get days — and a client that guessed from the period would label
   * every one of those days as a month.
   */
  bucket: UsageBucketUnit;
  /** What this view was narrowed to, echoed back so a client can trust it was applied. */
  filters: UsageFilters;
  totals: UsageTotals;
  /** The trend within the range, one point per `bucket`. */
  series: UsageBucket[];
  byAgent: UsageBreakdown[];
  byModel: UsageBreakdown[];
  byProject: UsageBreakdown[];
  /** Only present when the scope is `everyone`. */
  byUser?: UsageBreakdown[];
  effortByAgent: UsageEffort[];
  effortByModel: UsageEffort[];
  topTools: UsageToolUse[];
  topToolsByAgent: UsageToolUse[];
}

/**
 * What this client measured for one user on one agent, over a recent window.
 *
 * The honest half of the status panel. The other half is what the provider says
 * about the account, and the two are shown apart on purpose: this one counts
 * only the turns that ran through this app, prices them at list rates, and says
 * so — it is not, and cannot be, the account's bill.
 */
export interface UsageBurn {
  /** Inclusive start and exclusive end of the window, ISO. */
  from: string;
  to: string;
  /** Width of the window in hours, so a rate can be derived without parsing dates. */
  hours: number;
  totals: UsageTotals;
}

/**
 * The project a working directory belongs to: its last path segment.
 *
 * Trailing separators are dropped first, so `/srv/work/api/` and `/srv/work/api`
 * are one project rather than two — a session started from a folder picker and
 * one started from a typed path would otherwise never add up together.
 * The filesystem root has no segment to take, and reports itself as `/`.
 */
export function projectNameFor(workingDir: string | null | undefined): string | null {
  if (!workingDir) return null;
  const trimmed = workingDir.replace(/[\\/]+$/, '');
  if (!trimmed) return '/';
  const segment = trimmed.split(/[\\/]/).pop();
  return segment || '/';
}

/**
 * Add one turn into a running total.
 *
 * Exported rather than inlined into the store because the client adds the same
 * way when it re-totals a filtered view, and two implementations of "what counts
 * as reported" would drift apart on the first edit.
 *
 * `turns` goes up by one per record and by nothing else. That is the whole of
 * the corrected figure: it cannot be inflated by an agent that answers in six
 * pieces or deflated by one that answers in a single stretch, because neither
 * of those is being looked at.
 */
export function addJobToTotals(totals: UsageTotals, job: UsageJobSummary): UsageTotals {
  const tokenFields = [
    job.inputTokens,
    job.outputTokens,
    job.cacheReadTokens,
    job.cacheWriteTokens,
    job.reasoningTokens,
    job.totalTokens,
  ];
  return {
    turns: totals.turns + 1,
    modelTurns: totals.modelTurns + (job.modelTurns ?? 0),
    toolCalls: totals.toolCalls + job.toolCalls,
    inputTokens: totals.inputTokens + (job.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (job.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (job.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (job.cacheWriteTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (job.reasoningTokens ?? 0),
    totalTokens: totals.totalTokens + (job.totalTokens ?? 0),
    costUsd: totals.costUsd + (job.costUsd ?? 0),
    tokensReportedTurns: totals.tokensReportedTurns + (tokenFields.some((v) => v !== null) ? 1 : 0),
    costReportedTurns: totals.costReportedTurns + (job.costUsd !== null ? 1 : 0),
    modelTurnsReportedTurns: totals.modelTurnsReportedTurns + (job.modelTurns !== null ? 1 : 0),
  };
}

/** The token counts a figure can be built from, however they were reported. */
export interface TokenCounts {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}

/**
 * How many tokens a piece of work consumed, or null if nobody said.
 *
 * One function, because a job's figure in the live chat and its figure in the
 * historical dashboard have to be the same number — they were not, and that is
 * issue #80. The dashboard read the runtime's pre-summed total and nothing
 * else, so every Claude job in the history said "not reported" beside a cost
 * that was reported fine: Claude sends the four buckets and never a total.
 *
 * A total the runtime gave is always preferred. Only when there is none are
 * the parts added, and only these parts:
 *
 * - **cache tokens count.** For every runtime here that omits a total they are
 *   their own billed bucket, on top of the input. Measured, not assumed: grok
 *   sends 7210 in + 1893 out + 41000 cache read and calls the total 50103, and
 *   an ACP agent's 28234 + 147 + 27136 is exactly its 55517. Anthropic bills
 *   the same way, and Claude is the runtime this is for.
 * - **reasoning tokens do not.** They are a slice of the output rather than an
 *   addition to it — grok's 412 reasoning tokens are inside its 1893 output,
 *   or its own total would not add up — so counting them would bill part of
 *   the answer twice.
 *
 * The two runtimes that break either rule (codex counts cached input *inside*
 * its input; opencode counts thinking on top of its output) both report a
 * total, so neither ever reaches the sum.
 *
 * Null when every field is missing, and that null is the whole point of the
 * file: it means the runtime said nothing, which is not a measured zero. A
 * runtime that reports a genuine zero reports it as a number and gets one back.
 */
export function tokenTotal(usage: TokenCounts | null | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  let sum: number | null = null;
  for (const part of parts) {
    if (typeof part !== 'number') continue;
    sum = (sum ?? 0) + part;
  }
  // Reasoning alone, with no input or output beside it, is still evidence that
  // something was consumed — a null there would read as "reported nothing"
  // about a runtime that plainly reported something.
  if (sum === null && typeof usage.reasoningTokens === 'number') return usage.reasoningTokens;
  return sum;
}
