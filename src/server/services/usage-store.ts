/**
 * The durable side of usage accounting: writing job records and asking questions of them.
 *
 * Sits on the app's own SQLite file next to the session store, and follows the
 * same shape — one class, one method per operation, positional parameters, rows
 * cast at the boundary. It owns two tables (`usage_jobs`, `usage_job_tools`)
 * whose schema is declared with all the others in `database.ts`.
 *
 * Two rules run through everything here:
 *
 * 1. **A null is a fact.** `cost_usd IS NULL` means the runtime reported no
 *    cost; `cost_usd = 0` means it reported zero. Every aggregate therefore
 *    carries the number of rows that actually contributed, so a caller can say
 *    "$4.10 across 28 of 40 jobs" instead of quietly averaging in twelve zeros
 *    nobody measured.
 * 2. **Scope is a parameter, not a filter applied afterwards.** Every query
 *    takes the user it is for, and the "everyone" scope is a distinct value
 *    rather than a missing one — so a caller cannot reach the cross-user view by
 *    forgetting to pass something.
 */

import { ChatUsage } from '../../shared/chat-events.js';
import { AppDatabase } from './database.js';
import {
  EMPTY_TOTALS,
  UsageBreakdown,
  UsageBucket,
  UsageDashboard,
  UsageEffort,
  UsageJobRecord,
  UsageJobSummary,
  UsageOutcome,
  UsagePeriod,
  UsageScope,
  UsageToolUse,
  UsageTotals,
} from '../../shared/usage-records.js';

/** A job on its way into the table. */
export interface UsageJobInput {
  sessionId: string;
  nativeSessionId: string | null;
  turnId: string;
  userId: number;
  userLogin: string;
  agent: string;
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
  reportsUsage: boolean;
  reportsCost: boolean;
  tools: Array<{ tool: string; calls: number }>;
}

/** Who is asking, and for whose figures. */
export interface UsageQuery {
  userId: number;
  scope: UsageScope;
}

export interface UsageRangeQuery extends UsageQuery {
  period: UsagePeriod;
  /** The instant the period is anchored on. Defaults to now. */
  anchor?: Date;
  /** Minutes to add to UTC to reach the viewer's clock, so "today" means their today. */
  tzOffsetMinutes?: number;
}

export interface UsageHistoryQuery extends UsageQuery {
  limit?: number;
  offset?: number;
  /** Narrow to one agent, one model, or one conversation. */
  agent?: string;
  model?: string;
  sessionId?: string;
  from?: string;
  to?: string;
}

interface JobRow {
  id: string;
  session_id: string;
  native_session_id: string | null;
  turn_id: string;
  user_id: number;
  user_login: string;
  agent: string;
  model: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  outcome: string;
  turns: number;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  reports_usage: number;
  reports_cost: number;
}

interface TotalsRow {
  jobs: number;
  turns: number | null;
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
}

/**
 * The aggregate columns, written once.
 *
 * `SUM(COALESCE(x, 0))` rather than `SUM(x)` because SQLite's SUM over all-null
 * input is null, and a null total would have to be defended against at every
 * call site. The `*_reported_jobs` counters are what keeps that COALESCE honest:
 * they say how many of the rows in the sum had anything to contribute.
 */
const TOTALS_COLUMNS = `
  COUNT(*) AS jobs,
  SUM(turns) AS turns,
  SUM(tool_calls) AS tool_calls,
  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
  SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
  SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
  SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
  SUM(COALESCE(total_tokens, 0)) AS total_tokens,
  SUM(COALESCE(cost_usd, 0)) AS cost_usd,
  SUM(CASE WHEN input_tokens IS NOT NULL
             OR output_tokens IS NOT NULL
             OR cache_read_tokens IS NOT NULL
             OR cache_write_tokens IS NOT NULL
             OR reasoning_tokens IS NOT NULL
             OR total_tokens IS NOT NULL
           THEN 1 ELSE 0 END) AS tokens_reported_jobs,
  SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_jobs
`;

const HISTORY_PAGE = 50;
const MAX_HISTORY_PAGE = 500;
/** As many rows as one export response may carry. See `export`. */
const MAX_EXPORT_ROWS = 50_000;

export class UsageStore {
  constructor(private readonly database: AppDatabase) {}

  // ------------------------------------------------------------------ writing

  /**
   * File one job.
   *
   * `INSERT OR REPLACE` keyed on `<session>:<turn>`: recording the same job
   * twice — a crash between the write and the acknowledgement, a replayed log —
   * must leave one row rather than double somebody's bill. The tool rows are
   * rewritten with it, inside one transaction, so a job can never be visible
   * with half its tools attached.
   */
  record(job: UsageJobInput): string {
    const db = this.database.raw;
    const id = `${job.sessionId}:${job.turnId}`;
    const write = db.transaction(() => {
      db.prepare(`
        INSERT OR REPLACE INTO usage_jobs (
          id, session_id, native_session_id, turn_id, user_id, user_login,
          agent, model, started_at, ended_at, duration_ms, outcome,
          turns, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, cost_usd,
          reports_usage, reports_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        job.sessionId,
        job.nativeSessionId,
        job.turnId,
        job.userId,
        job.userLogin,
        job.agent,
        job.model,
        job.startedAt,
        job.endedAt,
        job.durationMs,
        job.outcome,
        job.turns,
        job.toolCalls,
        job.inputTokens,
        job.outputTokens,
        job.cacheReadTokens,
        job.cacheWriteTokens,
        job.reasoningTokens,
        job.totalTokens,
        job.costUsd,
        job.reportsUsage ? 1 : 0,
        job.reportsCost ? 1 : 0,
      );

      db.prepare('DELETE FROM usage_job_tools WHERE job_id = ?').run(id);
      const insertTool = db.prepare(
        'INSERT INTO usage_job_tools (job_id, tool, calls) VALUES (?, ?, ?)',
      );
      for (const tool of job.tools) {
        if (!tool.tool || tool.calls <= 0) continue;
        insertTool.run(id, tool.tool, tool.calls);
      }
    });
    write();
    return id;
  }

  /**
   * What a conversation has been billed so far, for a runtime that reports a
   * running total rather than a per-turn one.
   *
   * Keyed on the *runtime's* conversation id, not ours: the figure being
   * reconstructed is the runtime's own counter, and that counter is reset by
   * starting a new conversation — which is exactly when a new native id
   * appears. Keying on our session id instead would carry a cleared
   * conversation's total into the one that replaced it.
   */
  costBaselineFor(nativeSessionId: string): number | null {
    const row = this.database.raw
      .prepare(`
        SELECT COUNT(*) AS rows, SUM(COALESCE(cost_usd, 0)) AS total
        FROM usage_jobs WHERE native_session_id = ?
      `)
      .get(nativeSessionId) as { rows: number; total: number | null } | undefined;
    // Null, not zero, when this conversation has no record at all. It is a
    // conversation that ran before any of this existed, and its counter is
    // already somewhere well above zero — so a baseline of zero would charge
    // its entire history to whichever turn happens to come next. Null tells the
    // adapter to take the first figure it sees as the watermark and report that
    // turn's cost as unknown, which is the only true answer available.
    if (!row || row.rows === 0) return null;
    return row.total ?? 0;
  }

  /**
   * What a conversation has already been recorded as consuming.
   *
   * The evidence a resumed session uses to tell a running counter that carried
   * its history from one that restarted. Summed over the fields that count;
   * `costUsd` is here too, so a caller that wants only the money can take it
   * from the same place.
   */
  consumedFor(nativeSessionId: string): ChatUsage {
    const row = this.database.raw
      .prepare(`
        SELECT
          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
          SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
          SUM(COALESCE(reasoning_tokens, 0)) AS reasoning_tokens,
          SUM(COALESCE(total_tokens, 0)) AS total_tokens,
          SUM(COALESCE(cost_usd, 0)) AS cost_usd
        FROM usage_jobs WHERE native_session_id = ?
      `)
      .get(nativeSessionId) as Record<string, number | null> | undefined;
    if (!row) return {};
    return {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
    };
  }

  // ------------------------------------------------------------------ reading

  /** One job with its tool breakdown, or null if it is not this viewer's to see. */
  job(id: string, query: UsageQuery): UsageJobRecord | null {
    const scope = this.scopeClause(query);
    const row = this.database.raw
      .prepare(`SELECT * FROM usage_jobs WHERE id = ?${scope.and}`)
      .get(id, ...scope.params) as JobRow | undefined;
    if (!row) return null;

    const tools = this.database.raw
      .prepare('SELECT tool, calls FROM usage_job_tools WHERE job_id = ? ORDER BY calls DESC, tool ASC')
      .all(id) as Array<{ tool: string; calls: number }>;
    return { ...mapJob(row), tools };
  }

  /**
   * Past jobs, newest first.
   *
   * Deliberately does not join the sessions table. A job outlives the
   * conversation it ran in — that is most of what "permanent history" means
   * here — and a join would quietly drop every record whose session has since
   * been deleted, which is the exact set of rows this view exists for.
   */
  history(query: UsageHistoryQuery): { jobs: UsageJobSummary[]; total: number } {
    const scope = this.scopeClause(query);
    const where: string[] = [scope.and.replace(/^ AND /, '')].filter(Boolean);
    const params: unknown[] = [...scope.params];

    if (query.agent) {
      where.push('agent = ?');
      params.push(query.agent);
    }
    if (query.model) {
      where.push('model = ?');
      params.push(query.model);
    }
    if (query.sessionId) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (query.from) {
      where.push('ended_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('ended_at < ?');
      params.push(query.to);
    }

    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.database.raw.prepare(`SELECT COUNT(*) AS n FROM usage_jobs${clause}`).get(...params) as {
        n: number;
      }
    ).n;

    const limit = clamp(query.limit ?? HISTORY_PAGE, 1, MAX_HISTORY_PAGE);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const rows = this.database.raw
      .prepare(`SELECT * FROM usage_jobs${clause} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as JobRow[];

    return { jobs: rows.map(mapJob), total };
  }

  /** Everything the dashboard draws for one range and one scope. */
  dashboard(query: UsageRangeQuery, canSeeEveryone: boolean): UsageDashboard {
    const tz = Number.isFinite(query.tzOffsetMinutes) ? Math.trunc(query.tzOffsetMinutes as number) : 0;
    const scope: UsageScope = query.scope === 'everyone' && canSeeEveryone ? 'everyone' : 'self';
    const { from, to, buckets, format } = rangeFor(query.period, query.anchor ?? new Date(), tz);
    const base = this.scopeClause({ userId: query.userId, scope });
    const where = `WHERE ended_at >= ? AND ended_at < ?${base.and}`;
    // The same predicate, qualified, for the one query that joins. Built rather
    // than rewritten out of the string above: a regex over SQL is a bug waiting
    // for the first column name that contains another one.
    const joined = `WHERE j.ended_at >= ? AND j.ended_at < ?${base.and.replace('user_id', 'j.user_id')}`;
    const params = [from.toISOString(), to.toISOString(), ...base.params];
    const shift = `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes`;

    const totalsRow = this.database.raw
      .prepare(`SELECT ${TOTALS_COLUMNS} FROM usage_jobs ${where}`)
      .get(...params) as TotalsRow;

    const seriesRows = this.database.raw
      .prepare(`
        SELECT strftime(?, datetime(ended_at, ?)) AS bucket, ${TOTALS_COLUMNS}
        FROM usage_jobs ${where}
        GROUP BY bucket
      `)
      .all(format, shift, ...params) as Array<TotalsRow & { bucket: string }>;
    const byBucket = new Map(seriesRows.map((row) => [row.bucket, mapTotals(row)]));
    const series: UsageBucket[] = buckets.map((key) => ({
      key,
      totals: byBucket.get(key) ?? { ...EMPTY_TOTALS },
    }));

    return {
      scope,
      canSeeEveryone,
      period: query.period,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: mapTotals(totalsRow),
      series,
      byAgent: this.breakdown('agent', where, params),
      byModel: this.breakdown("COALESCE(model, '')", where, params),
      byUser: scope === 'everyone' ? this.breakdown('user_login', where, params) : undefined,
      effortByAgent: this.effort('agent', where, params),
      effortByModel: this.effort("COALESCE(model, '')", where, params),
      topTools: this.tools(joined, params, false),
      topToolsByAgent: this.tools(joined, params, true),
    };
  }

  /**
   * Every job in a range as flat rows, for export. Ordered oldest first.
   *
   * Capped, and the caller is told when the cap bit. The whole point of an
   * export is that it is complete, so silently truncating it would be worse
   * than refusing — but building an unbounded response in memory from a table
   * that grows forever is not an option either. A caller that hits the ceiling
   * narrows the range and exports again.
   */
  export(query: UsageHistoryQuery): { jobs: UsageJobSummary[]; truncated: boolean } {
    const scope = this.scopeClause(query);
    const where: string[] = [scope.and.replace(/^ AND /, '')].filter(Boolean);
    const params: unknown[] = [...scope.params];
    if (query.from) {
      where.push('ended_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('ended_at < ?');
      params.push(query.to);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    // One more than the cap, so hitting it is detectable rather than inferred
    // from a suspiciously round number of rows.
    const rows = this.database.raw
      .prepare(`SELECT * FROM usage_jobs${clause} ORDER BY ended_at ASC, id ASC LIMIT ?`)
      .all(...params, MAX_EXPORT_ROWS + 1) as JobRow[];
    return {
      jobs: rows.slice(0, MAX_EXPORT_ROWS).map(mapJob),
      truncated: rows.length > MAX_EXPORT_ROWS,
    };
  }

  /** The agents and models seen in the record, for filter menus. */
  facets(query: UsageQuery): { agents: string[]; models: string[] } {
    const scope = this.scopeClause(query);
    const clause = scope.and ? ` WHERE ${scope.and.replace(/^ AND /, '')}` : '';
    const agents = this.database.raw
      .prepare(`SELECT DISTINCT agent FROM usage_jobs${clause} ORDER BY agent ASC`)
      .all(...scope.params) as Array<{ agent: string }>;
    const models = this.database.raw
      .prepare(
        `SELECT DISTINCT model FROM usage_jobs${clause}${clause ? ' AND' : ' WHERE'} model IS NOT NULL ORDER BY model ASC`,
      )
      .all(...scope.params) as Array<{ model: string }>;
    return { agents: agents.map((r) => r.agent), models: models.map((r) => r.model) };
  }

  // ------------------------------------------------------------------ helpers

  private breakdown(column: string, where: string, params: unknown[]): UsageBreakdown[] {
    const rows = this.database.raw
      .prepare(`
        SELECT ${column} AS key, ${TOTALS_COLUMNS}
        FROM usage_jobs ${where}
        GROUP BY key
        ORDER BY cost_usd DESC, total_tokens DESC, jobs DESC
      `)
      .all(...params) as Array<TotalsRow & { key: string | null }>;
    return rows.map((row) => ({ key: row.key ?? '', totals: mapTotals(row) }));
  }

  /**
   * Effort per group, as counts rather than percentiles.
   *
   * Only completed jobs count: a turn the process died in the middle of took
   * exactly as many round trips as it got to, which is a fact about the crash
   * and not about the agent.
   */
  private effort(column: string, where: string, params: unknown[]): UsageEffort[] {
    const rows = this.database.raw
      .prepare(`
        SELECT ${column} AS key,
          COUNT(*) AS jobs,
          AVG(turns) AS turns_avg,
          MAX(turns) AS turns_max,
          AVG(tool_calls) AS tools_avg,
          MAX(tool_calls) AS tools_max,
          SUM(CASE WHEN turns <= 1 THEN 1 ELSE 0 END) AS t0,
          SUM(CASE WHEN turns = 2 THEN 1 ELSE 0 END) AS t1,
          SUM(CASE WHEN turns BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS t2,
          SUM(CASE WHEN turns BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS t3,
          SUM(CASE WHEN turns > 10 THEN 1 ELSE 0 END) AS t4,
          SUM(CASE WHEN tool_calls = 0 THEN 1 ELSE 0 END) AS c0,
          SUM(CASE WHEN tool_calls BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS c1,
          SUM(CASE WHEN tool_calls BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS c2,
          SUM(CASE WHEN tool_calls BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS c3,
          SUM(CASE WHEN tool_calls > 10 THEN 1 ELSE 0 END) AS c4
        FROM usage_jobs ${where} AND outcome = 'completed'
        GROUP BY key
        ORDER BY jobs DESC
      `)
      .all(...params) as Array<Record<string, number | string | null>>;

    return rows.map((row) => ({
      key: String(row.key ?? ''),
      jobs: Number(row.jobs ?? 0),
      turnsAvg: round2(Number(row.turns_avg ?? 0)),
      turnsMax: Number(row.turns_max ?? 0),
      toolCallsAvg: round2(Number(row.tools_avg ?? 0)),
      toolCallsMax: Number(row.tools_max ?? 0),
      turnsHistogram: [
        Number(row.t0 ?? 0),
        Number(row.t1 ?? 0),
        Number(row.t2 ?? 0),
        Number(row.t3 ?? 0),
        Number(row.t4 ?? 0),
      ],
      toolCallsHistogram: [
        Number(row.c0 ?? 0),
        Number(row.c1 ?? 0),
        Number(row.c2 ?? 0),
        Number(row.c3 ?? 0),
        Number(row.c4 ?? 0),
      ],
    }));
  }

  private tools(where: string, params: unknown[], perAgent: boolean): UsageToolUse[] {
    const key = perAgent ? 'j.agent' : "''";
    const rows = this.database.raw
      .prepare(`
        SELECT t.tool AS tool, ${key} AS agent_key,
               SUM(t.calls) AS calls, COUNT(DISTINCT t.job_id) AS jobs
        FROM usage_job_tools t
        JOIN usage_jobs j ON j.id = t.job_id
        ${where}
        -- Not "GROUP BY agent": usage_jobs has a column by that name, and
        -- SQLite binds it in preference to the alias above — which silently
        -- split the overall list per agent and made it a duplicate of the
        -- per-agent one.
        GROUP BY tool, agent_key
        ORDER BY calls DESC, tool ASC
        LIMIT 100
      `)
      .all(...params) as Array<{ tool: string; agent_key: string; calls: number; jobs: number }>;
    return rows.map((row) => ({
      tool: row.tool,
      agent: perAgent ? row.agent_key : null,
      calls: row.calls,
      jobs: row.jobs,
    }));
  }

  /**
   * The scope, as SQL.
   *
   * Returns a clause rather than a boolean the caller then acts on, so that
   * "everyone" and "this user" are produced by the same code path and a new
   * query cannot accidentally get the wide one by omission.
   */
  private scopeClause(query: UsageQuery): { and: string; params: unknown[] } {
    if (query.scope === 'everyone') return { and: '', params: [] };
    return { and: ' AND user_id = ?', params: [query.userId] };
  }
}

function mapJob(row: JobRow): UsageJobSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    nativeSessionId: row.native_session_id,
    turnId: row.turn_id,
    userId: row.user_id,
    userLogin: row.user_login,
    agent: row.agent,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    outcome: row.outcome as UsageOutcome,
    turns: row.turns,
    toolCalls: row.tool_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    reportsUsage: row.reports_usage === 1,
    reportsCost: row.reports_cost === 1,
  };
}

function mapTotals(row: TotalsRow): UsageTotals {
  return {
    jobs: row.jobs ?? 0,
    turns: row.turns ?? 0,
    toolCalls: row.tool_calls ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    reasoningTokens: row.reasoning_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
    tokensReportedJobs: row.tokens_reported_jobs ?? 0,
    costReportedJobs: row.cost_reported_jobs ?? 0,
  };
}

/**
 * The range a period covers, and the buckets to draw inside it.
 *
 * Computed against the viewer's own offset rather than the server's, because
 * "what did I spend today" is a question about their day. The bucket keys are
 * generated here rather than taken from whatever the query happened to return,
 * so a quiet hour still appears on the trend line as a gap instead of closing
 * up and making the shape a lie.
 */
export function rangeFor(
  period: UsagePeriod,
  anchor: Date,
  tzOffsetMinutes: number,
): { from: Date; to: Date; buckets: string[]; format: string } {
  const shift = tzOffsetMinutes * 60_000;
  const local = new Date(anchor.getTime() + shift);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const toUtc = (ms: number): Date => new Date(ms - shift);
  const buckets: string[] = [];

  if (period === 'day') {
    const start = Date.UTC(y, m, d);
    for (let h = 0; h < 24; h += 1) buckets.push(iso(new Date(start + h * 3_600_000), 'hour'));
    // The minutes are not decoration. `2026-07-27T09` is not a parseable
    // instant — `new Date` on it returns Invalid Date — and the key is
    // documented as an ISO one, so anything that formats it for an axis label
    // would print exactly that.
    return { from: toUtc(start), to: toUtc(start + 24 * 3_600_000), buckets, format: '%Y-%m-%dT%H:00' };
  }

  if (period === 'week') {
    // Monday-first: a spending week that starts on Sunday reads as two
    // half-weeks to everyone who works Monday to Friday.
    const weekday = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, d - weekday);
    for (let i = 0; i < 7; i += 1) buckets.push(iso(new Date(start + i * 86_400_000), 'day'));
    return { from: toUtc(start), to: toUtc(start + 7 * 86_400_000), buckets, format: '%Y-%m-%d' };
  }

  if (period === 'month') {
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(y, m + 1, 1);
    for (let t = start; t < end; t += 86_400_000) buckets.push(iso(new Date(t), 'day'));
    return { from: toUtc(start), to: toUtc(end), buckets, format: '%Y-%m-%d' };
  }

  const start = Date.UTC(y, 0, 1);
  for (let i = 0; i < 12; i += 1) buckets.push(iso(new Date(Date.UTC(y, i, 1)), 'month'));
  return { from: toUtc(start), to: toUtc(Date.UTC(y + 1, 0, 1)), buckets, format: '%Y-%m' };
}

function iso(date: Date, unit: 'hour' | 'day' | 'month'): string {
  const text = date.toISOString();
  if (unit === 'hour') return `${text.slice(0, 13)}:00`;
  if (unit === 'day') return text.slice(0, 10);
  return text.slice(0, 7);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
