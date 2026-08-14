import type { CodexCostEstimate } from '../../../shared/codex-pricing.js';
import { UNATTRIBUTED } from '../../../shared/usage-records.js';
import type {
  UsageFilters,
  UsageJobSummary,
  UsageOutcome,
  UsageProjectSource,
  UsageTotals,
} from '../../../shared/usage-records.js';

export interface JobRow {
  id: string;
  session_id: string;
  native_session_id: string | null;
  turn_id: string;
  user_id: number;
  user_login: string;
  agent: string;
  model: string | null;
  project: string | null;
  project_source: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  outcome: string;
  /** The superseded column. Written for older builds, read by nothing. */
  turns: number;
  model_turns: number | null;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_estimate: string | null;
  reports_usage: number;
  reports_cost: number;
}

export interface TotalsRow {
  turns: number;
  model_turns: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  tokens_reported_jobs: number | null;
  cost_reported_jobs: number | null;
  model_turns_reported_jobs: number | null;
}

/**
 * The narrowing a query carries, as SQL predicates.
 *
 * Shared by the dashboard and the job history so a filter cannot mean one thing
 * on a chart and another in the list that chart drills into. `from`/`to` are
 * deliberately absent here — the dashboard folds them into its own window,
 * and applying them twice would produce an empty range whenever the two
 * disagreed.
 *
 * The sentinel is spelled `IS NULL` rather than `= ' unattributed'`: the
 * grouping key is a rendering decision, the null is the stored fact, and a
 * filter that matched the rendering would find nothing at all.
 */
export function filterClause(
  filters: UsageFilters,
  prefix = '',
  ownerScoped = false,
): { parts: string[]; and: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const nullable = (column: string, value: string | undefined): void => {
    if (value === undefined || value === '') return;
    if (value === UNATTRIBUTED) {
      parts.push(`${prefix}${column} IS NULL`);
      return;
    }
    parts.push(`${prefix}${column} = ?`);
    params.push(value);
  };

  if (filters.agent) {
    parts.push(`${prefix}agent = ?`);
    params.push(filters.agent);
  }
  if (filters.model && filters.model !== UNATTRIBUTED) {
    // Either the model that answered, or one the turn was split across. A job
    // whose subagent ran on the model being asked about is a job that used it,
    // and narrowing to only the answering model would hide exactly the work
    // the per-model breakdown exists to make visible — click the row, and the
    // spend it stands for is gone.
    const outerOwnerColumn = prefix ? `${prefix}owner_key` : 'usage_jobs.owner_key';
    parts.push(
      `(${prefix}model = ? OR EXISTS (`
        + `SELECT 1 FROM usage_job_models mm WHERE mm.job_id = ${prefix}id`
        + `${ownerScoped ? ` AND mm.owner_key = ${outerOwnerColumn}` : ''}`
        + ` AND mm.model = ?))`,
    );
    params.push(filters.model, filters.model);
  } else {
    // Unattributed stays literal: a job with no model at all, which no split
    // row can rescue — a job that has split rows has models by definition.
    nullable('model', filters.model);
  }
  nullable('project', filters.project);
  if (filters.user) {
    parts.push(`${prefix}user_login = ?`);
    params.push(filters.user);
  }

  return { parts, and: parts.map((p) => ` AND ${p}`).join(''), params };
}

/** The filters that are actually doing something, for echoing back to the client. */
export function activeFilters(filters: UsageFilters): UsageFilters {
  const out: UsageFilters = {};
  for (const key of ['agent', 'model', 'project', 'user', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

export function mapJob(row: JobRow): UsageJobSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    nativeSessionId: row.native_session_id,
    turnId: row.turn_id,
    userId: row.user_id,
    userLogin: row.user_login,
    agent: row.agent,
    model: row.model,
    project: row.project,
    projectSource: (row.project_source as UsageProjectSource) ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    outcome: row.outcome as UsageOutcome,
    // `row.turns` is deliberately not read: it holds the superseded quantity.
    modelTurns: row.model_turns,
    toolCalls: row.tool_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    costEstimate: row.cost_estimate ? safeParseEstimate(row.cost_estimate) : null,
    reportsUsage: row.reports_usage === 1,
    reportsCost: row.reports_cost === 1,
  };
}

/** Parse a stored estimate leniently: a corrupt row must not break the history. */
export function safeParseEstimate(raw: string): CodexCostEstimate | null {
  try {
    const parsed = JSON.parse(raw) as CodexCostEstimate;
    if (parsed && typeof parsed.costUsd === 'number' && typeof parsed.model === 'string') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export function mapTotals(row: TotalsRow): UsageTotals {
  return {
    turns: row.turns ?? 0,
    modelTurns: row.model_turns ?? 0,
    toolCalls: row.tool_calls ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
    tokensReportedTurns: row.tokens_reported_jobs ?? 0,
    costReportedTurns: row.cost_reported_jobs ?? 0,
    modelTurnsReportedTurns: row.model_turns_reported_jobs ?? 0,
  };
}
