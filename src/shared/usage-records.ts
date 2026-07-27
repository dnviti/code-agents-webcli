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
 * `turns` is the number of times the model spoke inside that unit — the same
 * quantity Claude reports as `num_turns` — so "how many exchanges did this take"
 * is answerable per job and comparable across runtimes that have no such field
 * of their own. `toolCalls` is the number of tool blocks the transcript opened.
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
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  outcome: UsageOutcome;
  turns: number;
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
}

/** A job as the history list shows it — the record without its tool breakdown. */
export type UsageJobSummary = Omit<UsageJobRecord, 'tools'>;

/**
 * A set of jobs added up.
 *
 * The `*ReportedJobs` counters are the honesty mechanism: `costUsd` of 0 across
 * 40 jobs means something entirely different depending on whether
 * `costReportedJobs` is 40 or 0, and no consumer of this type can render the
 * total without having been handed that distinction.
 */
export interface UsageTotals {
  jobs: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Jobs that contributed at least one token figure. */
  tokensReportedJobs: number;
  /** Jobs that contributed a cost figure. */
  costReportedJobs: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  jobs: 0,
  turns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  tokensReportedJobs: 0,
  costReportedJobs: 0,
};

/** The periods the dashboard answers for. */
export type UsagePeriod = 'day' | 'week' | 'month' | 'year';

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
 * How much work a job took, as opposed to what it cost.
 *
 * A histogram rather than percentiles: the question a dashboard actually
 * answers here is "does this agent usually finish in one round trip or does it
 * flail", and a shape shows that where a p90 does not. Buckets are fixed so two
 * agents can be read side by side.
 */
export interface UsageEffort {
  key: string;
  jobs: number;
  turnsAvg: number;
  turnsMax: number;
  toolCallsAvg: number;
  toolCallsMax: number;
  /** Job counts for turns in 1 / 2 / 3-5 / 6-10 / 11+. */
  turnsHistogram: [number, number, number, number, number];
  /** Job counts for tool calls in 0 / 1-2 / 3-5 / 6-10 / 11+. */
  toolCallsHistogram: [number, number, number, number, number];
}

/** A tool, how often it was called, and by whom. */
export interface UsageToolUse {
  tool: string;
  /** Null on the overall list; set on the per-agent one. */
  agent: string | null;
  calls: number;
  jobs: number;
}

/** Whose figures a request is asking for. */
export type UsageScope = 'self' | 'everyone';

/** Everything the dashboard draws, for one range and one scope. */
export interface UsageDashboard {
  scope: UsageScope;
  /** True when this viewer is allowed to ask for `everyone`. */
  canSeeEveryone: boolean;
  period: UsagePeriod;
  /** Inclusive start and exclusive end of the range, ISO. */
  from: string;
  to: string;
  totals: UsageTotals;
  /** The trend within the range: hours for a day, days for a week or month, months for a year. */
  series: UsageBucket[];
  byAgent: UsageBreakdown[];
  byModel: UsageBreakdown[];
  /** Only present when the scope is `everyone`. */
  byUser?: UsageBreakdown[];
  effortByAgent: UsageEffort[];
  effortByModel: UsageEffort[];
  topTools: UsageToolUse[];
  topToolsByAgent: UsageToolUse[];
}

/**
 * Add a job into a running total.
 *
 * Exported rather than inlined into the store because the client adds the same
 * way when it re-totals a filtered view, and two implementations of "what counts
 * as reported" would drift apart on the first edit.
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
    jobs: totals.jobs + 1,
    turns: totals.turns + job.turns,
    toolCalls: totals.toolCalls + job.toolCalls,
    inputTokens: totals.inputTokens + (job.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (job.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (job.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (job.cacheWriteTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (job.reasoningTokens ?? 0),
    totalTokens: totals.totalTokens + (job.totalTokens ?? 0),
    costUsd: totals.costUsd + (job.costUsd ?? 0),
    tokensReportedJobs: totals.tokensReportedJobs + (tokenFields.some((v) => v !== null) ? 1 : 0),
    costReportedJobs: totals.costReportedJobs + (job.costUsd !== null ? 1 : 0),
  };
}
