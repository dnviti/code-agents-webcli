/**
 * The durable side of usage accounting: writing job records and asking questions of them.
 *
 * Sits on the app's own SQLite file next to the session store, and follows the
 * same shape — one class, one method per operation, positional parameters, rows
 * cast at the boundary. It owns three tables (`usage_jobs`, `usage_job_tools`
 * and `usage_job_models`) whose schema is declared with all the others in
 * `database.ts`.
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
  UNATTRIBUTED,
  UsageBreakdown,
  UsageBucket,
  UsageBucketUnit,
  UsageConversationSummary,
  UsageDashboard,
  UsageEffort,
  UsageFilters,
  UsageJobRecord,
  UsageJobSummary,
  UsageOutcome,
  UsagePeriod,
  UsageProjectSource,
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
  project: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  outcome: UsageOutcome;
  /** The runtime's own round-trip count, null where it does not report one. */
  modelTurns: number | null;
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
  /**
   * How the spend divided between models, where the runtime divided it.
   *
   * Empty for the ordinary case. `model` above still names the model that
   * answered, so nothing that reads one row is affected; these exist so that a
   * turn a subagent ran on another model is not filed as though the answering
   * model did all of it.
   */
  models?: Array<{
    model: string;
    calls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
  }>;
}

/** Who is asking, and for whose figures. */
export interface UsageQuery {
  userId: number;
  scope: UsageScope;
}

export interface UsageRangeQuery extends UsageQuery, UsageFilters {
  period: UsagePeriod;
  /** The instant the period is anchored on. Defaults to now. */
  anchor?: Date;
  /** Minutes to add to UTC to reach the viewer's clock, so "today" means their today. */
  tzOffsetMinutes?: number;
}

export interface UsageHistoryQuery extends UsageQuery, UsageFilters {
  limit?: number;
  offset?: number;
  /** Narrow to one conversation. Not a dashboard filter — there is no such breakdown. */
  sessionId?: string;
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
  reports_usage: number;
  reports_cost: number;
}

interface TotalsRow {
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
 * The aggregate columns, written once.
 *
 * `SUM(COALESCE(x, 0))` rather than `SUM(x)` because SQLite's SUM over all-null
 * input is null, and a null total would have to be defended against at every
 * call site. The `*_reported_jobs` counters are what keeps that COALESCE honest:
 * they say how many of the rows in the sum had anything to contribute.
 *
 * `turns` is `COUNT(*)`, not a sum of anything: one row is one turn (#86). It is
 * the only figure here that cannot be under-reported, because no runtime has to
 * volunteer it.
 */
const TOTALS_COLUMNS = `
  COUNT(*) AS turns,
  SUM(COALESCE(model_turns, 0)) AS model_turns,
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
  SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_jobs,
  SUM(CASE WHEN model_turns IS NOT NULL THEN 1 ELSE 0 END) AS model_turns_reported_jobs
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
          agent, model, project, project_source, started_at, ended_at, duration_ms, outcome,
          turns, model_turns, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, cost_usd,
          reports_usage, reports_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        job.sessionId,
        job.nativeSessionId,
        job.turnId,
        job.userId,
        job.userLogin,
        job.agent,
        job.model,
        job.project ?? null,
        // Recorded, not asserted: this came off the session as the work ran.
        job.project ? 'observed' : null,
        job.startedAt,
        job.endedAt,
        job.durationMs,
        job.outcome,
        // The superseded column, kept satisfiable rather than meaningful: it is
        // NOT NULL and a build from before #86 opening this file still reads it.
        // The nearest honest thing to put there is the figure that replaced it.
        job.modelTurns ?? 0,
        job.modelTurns ?? null,
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

      db.prepare('DELETE FROM usage_job_models WHERE job_id = ?').run(id);
      const insertModel = db.prepare(`
        INSERT INTO usage_job_models (
          job_id, model, calls, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const split of job.models ?? []) {
        if (!split.model) continue;
        insertModel.run(
          id,
          split.model,
          split.calls,
          split.inputTokens,
          split.outputTokens,
          split.cacheReadTokens,
          split.cacheWriteTokens,
          split.costUsd,
        );
      }

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

  /**
   * Attribute work by hand to a project, for jobs nobody recorded one for.
   *
   * The one write on this table that is not a measurement, and it is fenced
   * accordingly:
   *
   * - **An observed project is never overwritten.** It is what the session was
   *   actually pointed at while the work ran. A person who disagrees with it is
   *   disagreeing with a fact, and letting them edit it would make every other
   *   project figure a claim rather than a record.
   * - **A manual one can be corrected or withdrawn**, by anyone who could have
   *   made it — a typo that can never be fixed is worse than no attribution.
   * - **Scope is the same parameter every read takes**, so this cannot reach a
   *   job the caller is not allowed to see, let alone one they cannot see at
   *   all.
   *
   * Returns how many rows actually changed, which is not the same as how many
   * were asked for: a caller that names a session with nine jobs, six of them
   * already observed, is told three. Silently reporting nine would read as
   * "done" for work that was deliberately left alone.
   */
  attributeProject(
    target: { jobId?: string; sessionId?: string },
    project: string | null,
    query: UsageQuery,
  ): number {
    const scope = this.scopeClause(query);
    const where: string[] = [...scope.parts];
    const whereParams: unknown[] = [...scope.params];

    if (target.jobId) {
      where.push('id = ?');
      whereParams.push(target.jobId);
    } else if (target.sessionId) {
      where.push('session_id = ?');
      whereParams.push(target.sessionId);
    } else {
      // No target is not "every job I own". Refusing beats guessing at a scope
      // this wide.
      return 0;
    }
    // The fence. Both halves matter: the first admits work nobody attributed,
    // the second admits corrections to work somebody attributed by hand.
    where.push("(project IS NULL OR project_source = 'manual')");

    // The source is derived here rather than passed in, so "cleared" cannot be
    // recorded as a manual attribution to nothing — a row with a null project
    // and a source is a state nothing else in this file knows how to read.
    const source: UsageProjectSource = project ? 'manual' : null;
    const result = this.database.raw
      .prepare(`UPDATE usage_jobs SET project = ?, project_source = ? WHERE ${where.join(' AND ')}`)
      .run(project, source, ...whereParams);
    return result.changes ?? 0;
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
    const models = this.database.raw
      .prepare(`
        SELECT model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
        FROM usage_job_models WHERE job_id = ?
        ORDER BY COALESCE(cost_usd, 0) DESC, model ASC
      `)
      .all(id) as Array<Record<string, string | number | null>>;
    return {
      ...mapJob(row),
      tools,
      models: models.map((split) => ({
        model: String(split.model),
        calls: split.calls as number | null,
        inputTokens: split.input_tokens as number | null,
        outputTokens: split.output_tokens as number | null,
        cacheReadTokens: split.cache_read_tokens as number | null,
        cacheWriteTokens: split.cache_write_tokens as number | null,
        costUsd: split.cost_usd as number | null,
      })),
    };
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
    const { clause, params } = this.historyClause(query);
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

  /**
   * Past conversations, most recently active first — one row per chat tab.
   *
   * The unit of accounting (#88). Everything spent in a tab sums into one entry
   * for as long as the tab exists, across compaction, clearing, and starting a
   * new conversation inside it: those replace the *runtime's* conversation, and
   * this groups on ours. `native_session_id` is the one that changes there, and
   * `costBaselineFor` a few methods up is built on exactly that difference.
   *
   * Nothing is recorded to make this work and nothing is backfilled. The column
   * has been written since the table existed, so grouping on it reaches back
   * over the whole history rather than dividing it into a before and an after.
   *
   * Takes the same scope and the same filters as every other read, for the same
   * reason: a conversation list narrowed differently from the charts above it
   * is two views disagreeing about what is on screen. And because it is a
   * grouping of the same rows under the same predicate, the entries add up to
   * the headline totals by construction — there is no second tally to keep in
   * step.
   */
  conversations(query: UsageHistoryQuery): {
    conversations: UsageConversationSummary[];
    total: number;
  } {
    const { clause, params } = this.historyClause(query);
    const db = this.database.raw;

    const total = (
      db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM usage_jobs${clause}`)
        .get(...params) as { n: number }
    ).n;

    const limit = clamp(query.limit ?? HISTORY_PAGE, 1, MAX_HISTORY_PAGE);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const rows = db
      .prepare(`
        SELECT session_id,
               MIN(started_at) AS started_at,
               MAX(ended_at) AS last_active_at,
               ${TOTALS_COLUMNS}
        FROM usage_jobs${clause}
        GROUP BY session_id
        -- The id breaks ties, so paging is stable when a burst of conversations
        -- shares a last-active instant: an unstable sort repeats one row on page
        -- two and drops another entirely.
        ORDER BY last_active_at DESC, session_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as Array<
        TotalsRow & { session_id: string; started_at: string; last_active_at: string }
      >;
    if (rows.length === 0) return { conversations: [], total };

    const ids = rows.map((row) => row.session_id);
    const slots = ids.map(() => '?').join(', ');
    // The same predicate the totals were computed under, extended to this page.
    // Scope is a parameter here as everywhere else — narrowing an already
    // narrowed set of ids would read as safe and would still be the one query
    // in this file that could name another user's model. And the filters are
    // here for a plainer reason: an entry whose figures are for one project
    // must not list the agents it used on another.
    const pageWhere = `${clause ? `${clause} AND` : ' WHERE'} session_id IN (${slots})`;
    const pageParams = [...params, ...ids];

    // Three lists per conversation, read as distinct rows rather than through
    // GROUP_CONCAT(DISTINCT ...): that form takes no separator argument, so it
    // would hide a conversation's models behind a comma — a character a model
    // name is perfectly entitled to contain.
    const distinct = (column: string): Map<string, string[]> => {
      const found = db
        .prepare(`
          SELECT DISTINCT session_id, ${column} AS value FROM usage_jobs
          ${pageWhere} AND ${column} IS NOT NULL
          ORDER BY value ASC
        `)
        .all(...pageParams) as Array<{ session_id: string; value: string }>;
      const bySession = new Map<string, string[]>();
      for (const row of found) {
        const list = bySession.get(row.session_id);
        if (list) list.push(row.value);
        else bySession.set(row.session_id, [row.value]);
      }
      return bySession;
    };
    const agents = distinct('agent');
    const models = distinct('model');
    const projects = distinct('project');

    // The tab's own name, when the tab is still there. A separate read rather
    // than a join, and a LEFT one in spirit: a job outlives its conversation —
    // which is most of what a permanent history means here — so a missing row
    // must leave the entry standing without a name, not remove it.
    const named = new Map<string, string>();
    const sessionRows = db
      .prepare(`
        SELECT id, name, custom_name FROM runtime_sessions WHERE id IN (${slots})
      `)
      .all(...ids) as Array<{ id: string; name: string | null; custom_name: string | null }>;
    for (const row of sessionRows) {
      const label = row.custom_name?.trim() || row.name?.trim();
      if (label) named.set(row.id, label);
    }

    return {
      total,
      conversations: rows.map((row) => ({
        sessionId: row.session_id,
        name: named.get(row.session_id) ?? null,
        agents: agents.get(row.session_id) ?? [],
        models: models.get(row.session_id) ?? [],
        projects: projects.get(row.session_id) ?? [],
        startedAt: row.started_at,
        lastActiveAt: row.last_active_at,
        totals: mapTotals(row),
      })),
    };
  }

  /** Everything the dashboard draws for one range, one scope and one narrowing. */
  dashboard(query: UsageRangeQuery, canSeeEveryone: boolean): UsageDashboard {
    const tz = Number.isFinite(query.tzOffsetMinutes) ? Math.trunc(query.tzOffsetMinutes as number) : 0;
    const scope: UsageScope = query.scope === 'everyone' && canSeeEveryone ? 'everyone' : 'self';
    const { from, to, buckets, format, unit, windowed } = windowFor(
      query.period,
      query.anchor ?? new Date(),
      tz,
      query.from,
      query.to,
    );
    const base = this.scopeClause({ userId: query.userId, scope });
    // Every breakdown the dashboard draws reads this one predicate, which is
    // what makes "narrow to a project" narrow the totals, the trend, the effort
    // figures and the tool counts together. A filter applied to some of them
    // and not the rest is a dashboard whose parts disagree about what is on
    // screen.
    const narrow = filterClause(query);
    const where = `WHERE ended_at >= ? AND ended_at < ?${base.and}${narrow.and}`;
    // The same predicate, qualified, for the one query that joins. Built rather
    // than rewritten out of the string above: a regex over SQL is a bug waiting
    // for the first column name that contains another one.
    const joinedNarrow = filterClause(query, 'j.');
    const joined = `WHERE j.ended_at >= ? AND j.ended_at < ?${base.and.replace('user_id', 'j.user_id')}${joinedNarrow.and}`;
    const params = [from.toISOString(), to.toISOString(), ...base.params, ...narrow.params];
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
      bucket: unit,
      // Echoed back rather than assumed: the client draws a "clear this filter"
      // control from it, and a control that clears something the server never
      // applied is worse than no control at all. Which is exactly why the
      // window is reported as the one that was *used* — a half or inverted
      // range is ignored above, and echoing it back verbatim would advertise a
      // narrowing that never happened.
      filters: {
        ...activeFilters({ ...query, from: undefined, to: undefined }),
        ...(windowed ? { from: from.toISOString(), to: to.toISOString() } : {}),
      },
      totals: mapTotals(totalsRow),
      series,
      byAgent: this.breakdown('agent', where, params),
      byModel: this.modelBreakdown(joined, params),
      byProject: this.breakdown('project', where, params),
      byUser: scope === 'everyone' ? this.breakdown('user_login', where, params) : undefined,
      effortByAgent: this.effort('agent', where, params),
      effortByModel: this.effort('model', where, params),
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
    const { clause, params } = this.historyClause(query);
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

  /** The agents, models and projects seen in the record, for filter menus. */
  facets(query: UsageQuery): { agents: string[]; models: string[]; projects: string[] } {
    const scope = this.scopeClause(query);
    const clause = scope.parts.length ? ` WHERE ${scope.parts.join(' AND ')}` : '';
    const distinct = (column: string): string[] => {
      const rows = this.database.raw
        .prepare(
          `SELECT DISTINCT ${column} AS value FROM usage_jobs${clause}`
            + `${clause ? ' AND' : ' WHERE'} ${column} IS NOT NULL ORDER BY value ASC`,
        )
        .all(...scope.params) as Array<{ value: string }>;
      return rows.map((row) => row.value);
    };
    const agents = this.database.raw
      .prepare(`SELECT DISTINCT agent FROM usage_jobs${clause} ORDER BY agent ASC`)
      .all(...scope.params) as Array<{ agent: string }>;
    // Projects the viewer may not see are not merely hidden from the figures —
    // they are absent from the menu too. A filter list is a directory of what
    // exists, and one that named every project in the installation would leak
    // the shape of everyone else's work to a viewer scoped to their own.
    // Models include the ones a turn was split across, not only the ones that
    // answered. The breakdown shows those rows and the filter matches them, so
    // leaving them out of the menu would offer a narrowing for every model
    // except the ones only a subagent ever ran.
    const splitModels = this.database.raw
      .prepare(`
        SELECT DISTINCT m.model AS value
        FROM usage_job_models m
        JOIN usage_jobs ON usage_jobs.id = m.job_id${clause ? `${clause.replace(' WHERE', ' AND')}` : ''}
      `)
      .all(...scope.params) as Array<{ value: string }>;
    const models = [...new Set([...distinct('model'), ...splitModels.map((row) => row.value)])].sort();

    return { agents: agents.map((r) => r.agent), models, projects: distinct('project') };
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Scope plus every filter a history query can carry. Shared by `history()`
   * and `export()` so the two cannot disagree about what a filter means — an
   * export that quietly ignored `agent` would hand back more rows than the
   * screen it was exported from.
   */
  private historyClause(query: UsageHistoryQuery): { clause: string; params: unknown[] } {
    const scope = this.scopeClause(query);
    const narrow = filterClause(query);
    const where: string[] = [...scope.parts, ...narrow.parts];
    const params: unknown[] = [...scope.params, ...narrow.params];

    if (query.sessionId) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    // The window, which `filterClause` leaves out because the dashboard folds
    // it into its own range instead. Here it is an ordinary predicate.
    if (query.from) {
      where.push('ended_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('ended_at < ?');
      params.push(query.to);
    }

    return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  }

  /**
   * Spend per model, honouring a turn that ran on more than one.
   *
   * A LEFT JOIN rather than a `GROUP BY model`, and the whole method exists for
   * the difference. A job with no split joins to one null row and contributes
   * exactly what it always did, under its own model. A job with a split
   * contributes one row per model, each carrying that model's own figures as
   * the runtime reported them — so a turn where a subagent ran on something
   * else stops being filed as though the answering model did all of it.
   *
   * What each column can honestly say differs, and the CASE expressions are
   * where that is decided:
   *
   *   - `turns` counts distinct turns, so a split turn counts once against each
   *     model it touched. It is "turns that used this model", which is the
   *     reading the number is put to — and the one place a turn is deliberately
   *     counted more than once, because the column it sits under is the model
   *     rather than the work.
   *   - `model_turns` takes the runtime's own per-model round-trip count where
   *     there is one. That is a measurement, not a division of the job's total,
   *     and a split row with no `calls` contributes nothing rather than a zero.
   *   - `tool_calls` is left to the unsplit rows alone. No runtime says which
   *     model asked for which tool, and spreading a job's count across its
   *     models would invent the one figure nobody reported.
   *   - tokens and cost come from the split row when it has them, and are zero
   *     when it does not — never the job's own totals, which belong to the
   *     whole turn and would be counted once per model. A split row's
   *     `total_tokens` is added up from its own four fields, which is that
   *     total's definition rather than an estimate of it; reasoning tokens
   *     nobody breaks down stay at zero rather than being apportioned.
   */
  private modelBreakdown(joined: string, params: unknown[]): UsageBreakdown[] {
    const split = (column: string): string =>
      `SUM(CASE WHEN m.model IS NULL THEN COALESCE(j.${column}, 0) ELSE COALESCE(m.${column}, 0) END)`;
    const reported = (column: string): string =>
      `CASE WHEN m.model IS NULL THEN j.${column} ELSE m.${column} END`;

    const rows = this.database.raw
      .prepare(`
        SELECT COALESCE(m.model, j.model) AS key,
          COUNT(DISTINCT j.id) AS turns,
          SUM(CASE WHEN m.model IS NULL THEN COALESCE(j.model_turns, 0)
                   ELSE COALESCE(m.calls, 0) END) AS model_turns,
          SUM(CASE WHEN (CASE WHEN m.model IS NULL THEN j.model_turns ELSE m.calls END)
                        IS NOT NULL THEN 1 ELSE 0 END) AS model_turns_reported_jobs,
          SUM(CASE WHEN m.model IS NULL THEN j.tool_calls ELSE 0 END) AS tool_calls,
          ${split('input_tokens')} AS input_tokens,
          ${split('output_tokens')} AS output_tokens,
          ${split('cache_read_tokens')} AS cache_read_tokens,
          ${split('cache_write_tokens')} AS cache_write_tokens,
          SUM(CASE WHEN m.model IS NULL THEN COALESCE(j.reasoning_tokens, 0) ELSE 0 END) AS reasoning_tokens,
          SUM(CASE WHEN m.model IS NULL THEN COALESCE(j.total_tokens, 0)
                   ELSE COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)
                        + COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0)
              END) AS total_tokens,
          ${split('cost_usd')} AS cost_usd,
          SUM(CASE WHEN ${reported('input_tokens')} IS NOT NULL
                     OR ${reported('output_tokens')} IS NOT NULL
                     OR ${reported('cache_read_tokens')} IS NOT NULL
                     OR ${reported('cache_write_tokens')} IS NOT NULL
                   THEN 1 ELSE 0 END) AS tokens_reported_jobs,
          SUM(CASE WHEN ${reported('cost_usd')} IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_jobs
        FROM usage_jobs j
        LEFT JOIN usage_job_models m ON m.job_id = j.id
        ${joined}
        GROUP BY key
        ORDER BY cost_usd DESC, total_tokens DESC, turns DESC
      `)
      .all(...params) as Array<TotalsRow & { key: string | null }>;
    return rows.map((row) => ({ key: row.key ?? UNATTRIBUTED, totals: mapTotals(row) }));
  }

  private breakdown(column: string, where: string, params: unknown[]): UsageBreakdown[] {
    const rows = this.database.raw
      .prepare(`
        SELECT ${column} AS key, ${TOTALS_COLUMNS}
        FROM usage_jobs ${where}
        GROUP BY key
        ORDER BY cost_usd DESC, total_tokens DESC, turns DESC
      `)
      .all(...params) as Array<TotalsRow & { key: string | null }>;
    // A null groups under the sentinel, not under `''`. Both would render the
    // same, but only one of them survives a round trip through a query string
    // when the viewer clicks that row to filter by it.
    return rows.map((row) => ({ key: row.key ?? UNATTRIBUTED, totals: mapTotals(row) }));
  }

  /**
   * Effort per group, as counts rather than percentiles.
   *
   * Only completed turns count: a turn the process died in the middle of took
   * exactly as many round trips as it got to, which is a fact about the crash
   * and not about the agent.
   *
   * `AVG` and `MAX` over `model_turns` skip nulls, which is what makes this
   * table honest now that most runtimes report nothing: the average is over the
   * turns that answered, and `model_turns_reported` says how many those were.
   * The histogram counts the same rows. Reading a silent runtime as zero would
   * have put it at the top of every efficiency comparison on the page — for
   * having reported nothing at all.
   */
  private effort(column: string, where: string, params: unknown[]): UsageEffort[] {
    const rows = this.database.raw
      .prepare(`
        SELECT ${column} AS key,
          COUNT(*) AS turns,
          SUM(CASE WHEN model_turns IS NOT NULL THEN 1 ELSE 0 END) AS model_turns_reported,
          AVG(model_turns) AS model_turns_avg,
          MAX(model_turns) AS model_turns_max,
          AVG(tool_calls) AS tools_avg,
          MAX(tool_calls) AS tools_max,
          SUM(CASE WHEN model_turns <= 1 THEN 1 ELSE 0 END) AS t0,
          SUM(CASE WHEN model_turns = 2 THEN 1 ELSE 0 END) AS t1,
          SUM(CASE WHEN model_turns BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS t2,
          SUM(CASE WHEN model_turns BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS t3,
          SUM(CASE WHEN model_turns > 10 THEN 1 ELSE 0 END) AS t4,
          SUM(CASE WHEN tool_calls = 0 THEN 1 ELSE 0 END) AS c0,
          SUM(CASE WHEN tool_calls BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS c1,
          SUM(CASE WHEN tool_calls BETWEEN 3 AND 5 THEN 1 ELSE 0 END) AS c2,
          SUM(CASE WHEN tool_calls BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS c3,
          SUM(CASE WHEN tool_calls > 10 THEN 1 ELSE 0 END) AS c4
        FROM usage_jobs ${where} AND outcome = 'completed'
        GROUP BY key
        ORDER BY turns DESC
      `)
      .all(...params) as Array<Record<string, number | string | null>>;

    return rows.map((row) => ({
      key: row.key === null || row.key === undefined ? UNATTRIBUTED : String(row.key),
      turns: Number(row.turns ?? 0),
      modelTurnsReportedTurns: Number(row.model_turns_reported ?? 0),
      // Null rather than 0 from SQLite when every row in the group was silent,
      // and 0 is the right thing to send then: the count beside it is what says
      // the average is of nothing, so the figure itself never has to.
      modelTurnsAvg: round2(Number(row.model_turns_avg ?? 0)),
      modelTurnsMax: Number(row.model_turns_max ?? 0),
      toolCallsAvg: round2(Number(row.tools_avg ?? 0)),
      toolCallsMax: Number(row.tools_max ?? 0),
      modelTurnsHistogram: [
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
               SUM(t.calls) AS calls, COUNT(DISTINCT t.job_id) AS turns
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
      .all(...params) as Array<{ tool: string; agent_key: string; calls: number; turns: number }>;
    return rows.map((row) => ({
      tool: row.tool,
      agent: perAgent ? row.agent_key : null,
      calls: row.calls,
      turns: row.turns,
    }));
  }

  /**
   * The scope, as SQL.
   *
   * Returns a clause rather than a boolean the caller then acts on, so that
   * "everyone" and "this user" are produced by the same code path and a new
   * query cannot accidentally get the wide one by omission.
   */
  private scopeClause(query: UsageQuery): { parts: string[]; and: string; params: unknown[] } {
    if (query.scope === 'everyone') return { parts: [], and: '', params: [] };
    return { parts: ['user_id = ?'], and: ' AND user_id = ?', params: [query.userId] };
  }
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
function filterClause(
  filters: UsageFilters,
  prefix = '',
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
    parts.push(
      `(${prefix}model = ? OR EXISTS (`
        + `SELECT 1 FROM usage_job_models mm WHERE mm.job_id = ${prefix}id AND mm.model = ?))`,
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
function activeFilters(filters: UsageFilters): UsageFilters {
  const out: UsageFilters = {};
  for (const key of ['agent', 'model', 'project', 'user', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
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
    reportsUsage: row.reports_usage === 1,
    reportsCost: row.reports_cost === 1,
  };
}

function mapTotals(row: TotalsRow): UsageTotals {
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
): { from: Date; to: Date; buckets: string[]; format: string; unit: UsageBucketUnit } {
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
    return { from: toUtc(start), to: toUtc(start + 24 * 3_600_000), buckets, format: '%Y-%m-%dT%H:00', unit: 'hour' };
  }

  if (period === 'week') {
    // Monday-first: a spending week that starts on Sunday reads as two
    // half-weeks to everyone who works Monday to Friday.
    const weekday = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, d - weekday);
    for (let i = 0; i < 7; i += 1) buckets.push(iso(new Date(start + i * 86_400_000), 'day'));
    return { from: toUtc(start), to: toUtc(start + 7 * 86_400_000), buckets, format: '%Y-%m-%d', unit: 'day' };
  }

  if (period === 'month') {
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(y, m + 1, 1);
    for (let t = start; t < end; t += 86_400_000) buckets.push(iso(new Date(t), 'day'));
    return { from: toUtc(start), to: toUtc(end), buckets, format: '%Y-%m-%d', unit: 'day' };
  }

  const start = Date.UTC(y, 0, 1);
  for (let i = 0; i < 12; i += 1) buckets.push(iso(new Date(Date.UTC(y, i, 1)), 'month'));
  return { from: toUtc(start), to: toUtc(Date.UTC(y + 1, 0, 1)), buckets, format: '%Y-%m', unit: 'month' };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Two years. A window wider than this is a mistake or an attempt, not a question. */
const MAX_WINDOW_MS = 2 * 366 * DAY_MS;
/** More bars than this is a smear, and more rows than a browser should be handed. */
const MAX_BUCKETS = 800;

/**
 * The range the dashboard covers, whether it came from a period or from a
 * viewer clicking one bar of the trend.
 *
 * Granularity is derived from how wide the window is, not from which period
 * button is lit. That is the whole of what makes drilling in work: click a
 * month and you get its days, click one of those days and you get its hours,
 * with no second notion of "zoom level" to keep in step with the first. The
 * thresholds are chosen so an unnarrowed period lands exactly where it used to
 * — a day on hours, a week and a month on days, a year on months.
 */
export function windowFor(
  period: UsagePeriod,
  anchor: Date,
  tzOffsetMinutes: number,
  fromISO?: string,
  toISO?: string,
): { from: Date; to: Date; buckets: string[]; format: string; unit: UsageBucketUnit; windowed: boolean } {
  const from = parseInstant(fromISO);
  const to = parseInstant(toISO);
  // Both ends or neither. One end alone leaves the other implied by the period,
  // and a window whose start and end were decided by two different mechanisms
  // is the kind of thing that reads correctly right up until a month boundary.
  if (!from || !to || to.getTime() <= from.getTime()) {
    return { ...rangeFor(period, anchor, tzOffsetMinutes), windowed: false };
  }

  const span = Math.min(to.getTime() - from.getTime(), MAX_WINDOW_MS);
  const end = new Date(from.getTime() + span);
  const unit: UsageBucketUnit = span > 62 * DAY_MS ? 'month' : span > 36 * HOUR_MS ? 'day' : 'hour';
  const shift = tzOffsetMinutes * 60_000;
  const local = new Date(from.getTime() + shift);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  // Aligned down to the unit boundary in the viewer's own frame, so the first
  // bar is a whole hour or a whole day rather than a stub starting at 09:37.
  let cursor =
    unit === 'hour'
      ? Date.UTC(y, m, d, local.getUTCHours())
      : unit === 'day'
        ? Date.UTC(y, m, d)
        : Date.UTC(y, m, 1);
  const localEnd = end.getTime() + shift;
  const buckets: string[] = [];
  let months = 0;
  while (cursor < localEnd && buckets.length < MAX_BUCKETS) {
    buckets.push(iso(new Date(cursor), unit));
    if (unit === 'hour') cursor += HOUR_MS;
    else if (unit === 'day') cursor += DAY_MS;
    else {
      months += 1;
      cursor = Date.UTC(y, m + months, 1);
    }
  }

  return {
    from,
    to: end,
    buckets,
    format: unit === 'hour' ? '%Y-%m-%dT%H:00' : unit === 'day' ? '%Y-%m-%d' : '%Y-%m',
    unit,
    windowed: true,
  };
}

function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
