/**
 * The durable side of usage accounting: the `UsageStore` class on the app.s own
 * SQLite file. The query interfaces, the row-mapping/filter layer and the
 * range/window helpers live in sibling modules; this file is the class itself.
 */


import { ChatUsage } from '../../../../shared/chat-events.js';
import type { CodexCostEstimator } from '../../../../shared/codex-pricing.js';
import { AppDatabase } from '../../persistence/app/database.js';
import { SessionPersistenceDatabase } from '../../workspace/session/workspace-session-database.js';
import {
  EMPTY_TOTALS,
  UNATTRIBUTED,
  UsageBreakdown,
  UsageBucket,
  UsageConversationSummary,
  UsageDashboard,
  UsageEffort,
  UsageJobRecord,
  UsageJobSummary,
  UsageProjectSource,
  UsageScope,
  UsageToolUse,
  UsageBurn,
} from '../../../../shared/usage-records.js';
import type {
  UsageHistoryQuery,
  UsageJobInput,
  UsageQuery,
  UsageRangeQuery,
  UsageStoreOptions,
} from './usage-store-types.js';
import {
  JobRow,
  TotalsRow,
  activeFilters,
  filterClause,
  mapJob,
  mapTotals,
  safeParseEstimate,
} from './usage-store-mappers.js';
import { clamp, round2, windowFor } from './usage-store-window.js';

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
  private readonly database: AppDatabase | SessionPersistenceDatabase;
  private readonly ownerKey: string | null;

  /** `new UsageStore(appDb)` remains valid; workspace callers pass `{ database, ownerKey }`. */
  constructor(database: AppDatabase | SessionPersistenceDatabase | UsageStoreOptions, options: { ownerKey?: string } = {}) {
    const configured = 'database' in database ? database as UsageStoreOptions : null;
    this.database = configured
      ? configured.database
      : database as AppDatabase | SessionPersistenceDatabase;
    this.ownerKey = configured ? configured.ownerKey ?? null : options.ownerKey ?? null;
  }

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
    const ownerColumn = this.ownerKey ? 'owner_key, ' : '';
    const ownerValues: unknown[] = this.ownerKey ? [this.ownerKey] : [];
    const write = db.transaction(() => {
      db.prepare(`
        INSERT OR REPLACE INTO usage_jobs (
          ${ownerColumn}id, session_id, native_session_id, turn_id, user_id, user_login,
          agent, model, project, project_source, started_at, ended_at, duration_ms, outcome,
          turns, model_turns, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, cost_usd, cost_estimate,
          reports_usage, reports_cost
        ) VALUES (${Array.from({ length: 27 + ownerValues.length }, () => '?').join(', ')})
      `).run(
        ...ownerValues,
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
        // NOT NULL and a build from before #86 opening this same file still reads
        // it. The nearest honest thing to put there is the figure that replaced it.
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
        job.costEstimate ? JSON.stringify(job.costEstimate) : null,
        job.reportsUsage ? 1 : 0,
        job.reportsCost ? 1 : 0,
      );

      db.prepare(this.ownerKey
        ? 'DELETE FROM usage_job_models WHERE owner_key = ? AND job_id = ?'
        : 'DELETE FROM usage_job_models WHERE job_id = ?').run(...ownerValues, id);
      const insertModel = db.prepare(`
        INSERT INTO usage_job_models (
          ${ownerColumn}job_id, model, calls, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd
        ) VALUES (${Array.from({ length: 8 + ownerValues.length }, () => '?').join(', ')})
      `);
      for (const split of job.models ?? []) {
        if (!split.model) continue;
        insertModel.run(
          ...ownerValues,
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

      db.prepare(this.ownerKey
        ? 'DELETE FROM usage_job_tools WHERE owner_key = ? AND job_id = ?'
        : 'DELETE FROM usage_job_tools WHERE job_id = ?').run(...ownerValues, id);
      const insertTool = db.prepare(
        `INSERT INTO usage_job_tools (${ownerColumn}job_id, tool, calls) VALUES (${Array.from({ length: 3 + ownerValues.length }, () => '?').join(', ')})`,
      );
      for (const tool of job.tools) {
        if (!tool.tool || tool.calls <= 0) continue;
        insertTool.run(...ownerValues, id, tool.tool, tool.calls);
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
        FROM usage_jobs WHERE native_session_id = ?${this.ownerKey ? ' AND owner_key = ?' : ''}
      `)
      .get(nativeSessionId, ...(this.ownerKey ? [this.ownerKey] : [])) as { rows: number; total: number | null } | undefined;
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
        FROM usage_jobs WHERE native_session_id = ?${this.ownerKey ? ' AND owner_key = ?' : ''}
      `)
      .get(nativeSessionId, ...(this.ownerKey ? [this.ownerKey] : [])) as Record<string, number | null> | undefined;
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
   * What each turn of one conversation cost, by turn id.
   *
   * The figure the dashboard shows, read back beside the conversation it came
   * from — deliberately the same number and not a second calculation of it. A
   * browser can add up the tokens on the messages it holds, but not the money:
   * the runtimes that report a running total rather than a per-turn one need
   * the difference taken against where the turn started, which is exactly what
   * the accountant did when it filed this row.
   *
   * Scoped to the owner like every other read here. A turn with no row is a
   * turn that has not ended yet, or one whose runtime reported nothing.
   */
  spendByTurn(sessionId: string, userId: number): Map<string, ChatUsage> {
    const rows = this.database.raw
      .prepare(`
        SELECT turn_id, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, reasoning_tokens, total_tokens, cost_usd, cost_estimate
        FROM usage_jobs WHERE session_id = ? AND user_id = ?${this.ownerKey ? ' AND owner_key = ?' : ''}
      `)
      .all(sessionId, userId, ...(this.ownerKey ? [this.ownerKey] : [])) as Array<Record<string, number | string | null>>;

    const spend = new Map<string, ChatUsage>();
    for (const row of rows) {
      // A null is a fact here as everywhere else on this table: the runtime
      // reported nothing on that channel, which is not the same as zero, and
      // the surface showing it says "not reported" rather than "$0.00".
      const figure = (value: number | string | null): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const estimateRaw = typeof row.cost_estimate === 'string' ? row.cost_estimate : null;
      const estimate = estimateRaw ? safeParseEstimate(estimateRaw) : null;
      spend.set(String(row.turn_id), {
        inputTokens: figure(row.input_tokens),
        outputTokens: figure(row.output_tokens),
        cacheReadTokens: figure(row.cache_read_tokens),
        cacheWriteTokens: figure(row.cache_write_tokens),
        reasoningTokens: figure(row.reasoning_tokens),
        totalTokens: figure(row.total_tokens),
        costUsd: figure(row.cost_usd),
        // An estimated figure still needs its provenance label on the turn row.
        ...(estimate ? { costEstimate: estimate, costSource: 'estimated' as const } : {}),
      });
    }
    return spend;
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

  /**
   * One-time retrospective backfill of codex cost estimates (issue #182).
   *
   * Every codex row that has a confirmed model, sufficient token detail and
   * *no* cost figure yet is priced at the official list rate the estimator
   * holds, marked `retrospective` and stamped with the date the estimate was
   * made. The guards are the whole of the "never overwrite" contract:
   *
   *   - `cost_estimate IS NULL` keeps a later price change from rewriting a
   *     live or previously backfilled estimate (acceptance: "A later price
   *     change does not rewrite a previously recorded live or retrospective
   *     estimate");
   *   - `cost_usd IS NULL` leaves a runtime-reported figure alone and never
   *     prices a row whose runtime already priced it;
   *   - `agent = 'codex'` confines the pass to the one runtime this app prices.
   *
   * Rows without a confirmable rate (or without token detail) stay unpriced —
   * "price unavailable" — and are left for a later run once a price exists.
   * Idempotent: re-running touches only rows still missing an estimate.
   */
  backfillCodexEstimates(estimator: CodexCostEstimator): number {
    if (!estimator || typeof estimator.estimate !== 'function') return 0;
    const rows = this.database.raw
      .prepare(`
        SELECT id, model, input_tokens, cache_read_tokens, output_tokens
        FROM usage_jobs
        WHERE agent = 'codex'
          AND cost_estimate IS NULL
          AND cost_usd IS NULL
          AND model IS NOT NULL
          AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL)
      `)
      .all() as Array<{
        id: string;
        model: string;
        input_tokens: number | null;
        cache_read_tokens: number | null;
        output_tokens: number | null;
      }>;

    let updated = 0;
    const update = this.database.raw.prepare(
      'UPDATE usage_jobs SET cost_usd = ?, cost_estimate = ? WHERE id = ?',
    );
    const write = this.database.raw.transaction(() => {
      for (const row of rows) {
        const estimate = estimator.estimate(
          {
            inputTokens: row.input_tokens ?? undefined,
            cacheReadTokens: row.cache_read_tokens ?? undefined,
            outputTokens: row.output_tokens ?? undefined,
          },
          row.model,
          { retrospective: true },
        );
        // No rate for this model: leave it unpriced rather than guessing.
        if (!estimate) continue;
        update.run(estimate.costUsd, JSON.stringify(estimate), row.id);
        updated += 1;
      }
    });
    write();
    return updated;
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
      .prepare(`SELECT tool, calls FROM usage_job_tools WHERE job_id = ?${this.ownerKey ? ' AND owner_key = ?' : ''} ORDER BY calls DESC, tool ASC`)
      .all(id, ...(this.ownerKey ? [this.ownerKey] : [])) as Array<{ tool: string; calls: number }>;
    const models = this.database.raw
      .prepare(`
        SELECT model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
        FROM usage_job_models WHERE job_id = ?${this.ownerKey ? ' AND owner_key = ?' : ''}
        ORDER BY COALESCE(cost_usd, 0) DESC, model ASC
      `)
      .all(id, ...(this.ownerKey ? [this.ownerKey] : [])) as Array<Record<string, string | number | null>>;
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
        SELECT id, name, custom_name FROM runtime_sessions WHERE id IN (${slots})${this.ownerKey ? ' AND owner_key = ?' : ''}
      `)
      .all(...ids, ...(this.ownerKey ? [this.ownerKey] : [])) as Array<{ id: string; name: string | null; custom_name: string | null }>;
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
    const narrow = filterClause(query, '', Boolean(this.ownerKey));
    const where = `WHERE ended_at >= ? AND ended_at < ?${base.and}${narrow.and}`;
    // The same predicate, qualified, for the one query that joins. Built rather
    // than rewritten out of the string above: a regex over SQL is a bug waiting
    // for the first column name that contains another one.
    const joinedNarrow = filterClause(query, 'j.', Boolean(this.ownerKey));
    const joined = `WHERE j.ended_at >= ? AND j.ended_at < ?${base.and.replace('user_id', 'j.user_id').replace('owner_key', 'j.owner_key')}${joinedNarrow.and}`;
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
   * What this app measured for one user on one agent over a recent window.
   *
   * The only burn rate this app can honestly offer. The one it used to draw was
   * a projection against a hand-written plan ceiling; this is the app's own
   * record of turns that actually ran — scoped to the person asking and to the
   * agent they are looking at, so a status panel over a Codex conversation does
   * not report what somebody's Claude sessions spent.
   *
   * `UsageTotals` is returned whole rather than pre-divided because it carries
   * the `*ReportedTurns` counters, and a rate computed over turns that reported
   * nothing is the same "zero means silence" bug in a new place. The caller
   * divides once it knows how many turns stood behind the figure.
   *
   * Always this user's own rows: there is no `everyone` scope here. A burn rate
   * is a personal question.
   */
  burn(userId: number, agent: string, hours: number, now = new Date()): UsageBurn {
    const span = Math.max(1, Math.trunc(hours));
    const from = new Date(now.getTime() - span * 3_600_000);
    const row = this.database.raw
      .prepare(`
        SELECT ${TOTALS_COLUMNS} FROM usage_jobs
        WHERE ended_at >= ? AND ended_at < ? AND user_id = ? AND agent = ?${this.ownerKey ? ' AND owner_key = ?' : ''}
      `)
      .get(from.toISOString(), now.toISOString(), userId, agent, ...(this.ownerKey ? [this.ownerKey] : [])) as TotalsRow;
    return {
      from: from.toISOString(),
      to: now.toISOString(),
      hours: span,
      totals: mapTotals(row),
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
        JOIN usage_jobs ON usage_jobs.id = m.job_id${this.ownerKey ? ' AND usage_jobs.owner_key = m.owner_key' : ''}${clause ? `${clause.replace(' WHERE', ' AND').replace(/owner_key/g, 'usage_jobs.owner_key')}` : ''}
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
    const narrow = filterClause(query, '', Boolean(this.ownerKey));
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
        LEFT JOIN usage_job_models m ON m.job_id = j.id${this.ownerKey ? ' AND m.owner_key = j.owner_key' : ''}
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
        JOIN usage_jobs j ON j.id = t.job_id${this.ownerKey ? ' AND j.owner_key = t.owner_key' : ''}
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
    const parts: string[] = this.ownerKey ? ['owner_key = ?'] : [];
    const params: unknown[] = this.ownerKey ? [this.ownerKey] : [];
    if (query.scope !== 'everyone') {
      parts.push('user_id = ?');
      params.push(query.userId);
    }
    return { parts, and: parts.map((part) => ` AND ${part}`).join(''), params };
  }
}
