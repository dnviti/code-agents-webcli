import path from 'node:path';
import type { CodexCostEstimator } from '../../../shared/codex-pricing.js';
import { ChatUsage } from '../../../shared/chat-events.js';
import {
  EMPTY_TOTALS,
  UNATTRIBUTED,
  UsageBreakdown,
  UsageBurn,
  UsageConversationSummary,
  UsageDashboard,
  UsageEffort,
  UsageFilters,
  UsageJobRecord,
  UsageJobSummary,
  UsageToolUse,
  UsageTotals,
} from '../../../shared/usage-records.js';
import { SessionStorageScope } from '../../types.js';
import { SessionPersistenceDatabase } from '../workspace/session/workspace-session-database.js';
import {
  UsageHistoryQuery,
  UsageJobInput,
  UsageQuery,
  UsageRangeQuery,
  UsageStore,
  windowFor,
} from './usage-store.js';

const HISTORY_PAGE = 500;
const MAX_EXPORT_ROWS = 50_000;

interface WorkspaceUsageEntry {
  readonly key: string;
  readonly scope: Readonly<SessionStorageScope>;
  readonly database: SessionPersistenceDatabase;
  readonly store: UsageStore;
}

interface LocatedJob {
  readonly entry: WorkspaceUsageEntry;
  readonly job: UsageJobSummary;
}

/**
 * Usage accounting over the workspace state files the server has explicitly
 * authorised and registered.
 *
 * There is deliberately no installation database in this class. Registration
 * binds a store to both a canonical workspace path and an opaque owner key;
 * every read keeps the UsageStore's owner predicate in place and then combines
 * the independently authorised answers. Pagination is applied only after that
 * combination, so opening a second workspace cannot create gaps or duplicates
 * between pages.
 */
export class WorkspaceUsageCoordinator {
  private readonly entries = new Map<string, WorkspaceUsageEntry>();
  /**
   * The codex list-price estimator (issue #182), attached once the server has
   * one. Any workspace registered after this is backfilled as it opens, not
   * only at server boot — otherwise history in a workspace that was not open
   * at startup would never be priced.
   */
  private codexEstimator: CodexCostEstimator | null = null;
  /** Which workspace keys have already had their codex history backfilled. */
  private readonly backfilled = new Set<string>();

  register(scope: SessionStorageScope, database: SessionPersistenceDatabase): UsageStore {
    const boundScope = freezeScope(scope);
    assertDatabaseScope(boundScope, database);
    const key = scopeKey(boundScope);
    const existing = this.entries.get(key);
    if (existing) return existing.store;

    const store = new UsageStore({ database, ownerKey: boundScope.ownerKey });
    this.entries.set(key, { key, scope: boundScope, database, store });
    // Price eligible codex history the moment this workspace is opened (once).
    // The pass is guarded and idempotent, so re-registration is a no-op.
    if (this.codexEstimator && !this.backfilled.has(key)) {
      this.backfilled.add(key);
      try {
        store.backfillCodexEstimates(this.codexEstimator);
      } catch {
        // A backfill failure must not block workspace registration.
      }
    }
    return store;
  }

  /**
   * Stop aggregating one scope. Externally owned database handles (notably a
   * SessionStore handle during project rebuild) are intentionally left open;
   * registering the restored scope later creates a fresh owner-bound store.
   */
  unregister(scope: SessionStorageScope): boolean {
    return this.entries.delete(scopeKey(freezeScope(scope)));
  }

  /** File a turn in the immutable workspace scope supplied by its session. */
  record(scope: SessionStorageScope, job: UsageJobInput): string {
    const entry = this.entryFor(scope);
    if (!entry) {
      throw new Error('Workspace usage scope must be authorised and registered before recording');
    }
    this.assertSessionScope(entry, job.sessionId);
    return entry.store.record(job);
  }

  /** All registered jobs, newest first, under one global pagination window. */
  history(query: UsageHistoryQuery): { jobs: UsageJobSummary[]; total: number } {
    const all = this.allHistory(query);
    all.sort(compareLocatedNewest);
    const offset = nonNegativeInteger(query.offset, 0);
    const limit = clampInteger(query.limit, 50, 1, HISTORY_PAGE);
    return { jobs: all.slice(offset, offset + limit).map(({ job }) => job), total: all.length };
  }

  /** One globally paged conversation list across the registered workspaces. */
  conversations(query: UsageHistoryQuery): {
    conversations: UsageConversationSummary[];
    total: number;
  } {
    const all: Array<{ entry: WorkspaceUsageEntry; conversation: UsageConversationSummary }> = [];
    for (const entry of this.entries.values()) {
      let offset = 0;
      let total = 0;
      do {
        const page = entry.store.conversations({ ...query, limit: HISTORY_PAGE, offset });
        total = page.total;
        all.push(...page.conversations.map((conversation) => ({ entry, conversation })));
        offset += page.conversations.length;
        if (page.conversations.length === 0) break;
      } while (offset < total);
    }

    all.sort((a, b) =>
      b.conversation.lastActiveAt.localeCompare(a.conversation.lastActiveAt)
      || b.conversation.sessionId.localeCompare(a.conversation.sessionId)
      || a.entry.key.localeCompare(b.entry.key));
    const offset = nonNegativeInteger(query.offset, 0);
    const limit = clampInteger(query.limit, 50, 1, HISTORY_PAGE);
    return {
      conversations: all.slice(offset, offset + limit).map(({ conversation }) => conversation),
      total: all.length,
    };
  }

  /**
   * Resolve an unqualified route id only when it names exactly one visible
   * workspace row. Ambiguity is treated like not-found instead of choosing a
   * workspace by registration order.
   */
  job(id: string, query: UsageQuery): UsageJobRecord | null {
    const matches = this.entriesWithJob(id, query);
    return matches.length === 1 ? matches[0].record : null;
  }

  /** Scope-qualified counterpart used by session-aware internal callers. */
  jobInScope(scope: SessionStorageScope, id: string, query: UsageQuery): UsageJobRecord | null {
    return this.entryFor(scope)?.store.job(id, query) ?? null;
  }

  /**
   * Attribute only an unambiguous visible target. A colliding session id in
   * two workspaces changes neither, which prevents a route-level id from
   * mutating a neighbouring checkout by accident.
   */
  attributeProject(
    target: { jobId?: string; sessionId?: string },
    project: string | null,
    query: UsageQuery,
  ): number {
    if (target.jobId) {
      const matches = this.entriesWithJob(target.jobId, query);
      return matches.length === 1
        ? matches[0].entry.store.attributeProject(target, project, query)
        : 0;
    }
    if (!target.sessionId) return 0;
    const matches = this.entriesWithSession(target.sessionId, query);
    return matches.length === 1
      ? matches[0].store.attributeProject(target, project, query)
      : 0;
  }

  attributeProjectInScope(
    scope: SessionStorageScope,
    target: { jobId?: string; sessionId?: string },
    project: string | null,
    query: UsageQuery,
  ): number {
    return this.entryFor(scope)?.store.attributeProject(target, project, query) ?? 0;
  }

  facets(query: UsageQuery): { agents: string[]; models: string[]; projects: string[] } {
    const agents = new Set<string>();
    const models = new Set<string>();
    const projects = new Set<string>();
    for (const entry of this.entries.values()) {
      const facets = entry.store.facets(query);
      facets.agents.forEach((value) => agents.add(value));
      facets.models.forEach((value) => models.add(value));
      facets.projects.forEach((value) => projects.add(value));
    }
    return {
      agents: [...agents].sort(),
      models: [...models].sort(),
      projects: [...projects].sort(),
    };
  }

  /** Every matching job, oldest first, with one cap over the combined result. */
  export(query: UsageHistoryQuery): { jobs: UsageJobSummary[]; truncated: boolean } {
    const all = this.allHistory(query);
    all.sort((a, b) =>
      a.job.endedAt.localeCompare(b.job.endedAt)
      || a.job.id.localeCompare(b.job.id)
      || a.entry.key.localeCompare(b.entry.key));
    return {
      jobs: all.slice(0, MAX_EXPORT_ROWS).map(({ job }) => job),
      truncated: all.length > MAX_EXPORT_ROWS,
    };
  }

  /** Merge all dashboard components without losing reporting/null counters. */
  dashboard(query: UsageRangeQuery, canSeeEveryone: boolean): UsageDashboard {
    const dashboards = [...this.entries.values()].map((entry) =>
      entry.store.dashboard(query, canSeeEveryone));
    const base = dashboards[0] ?? emptyDashboard(query, canSeeEveryone);
    if (dashboards.length === 0) return base;

    const totals = dashboards.reduce((sum, dashboard) => addTotals(sum, dashboard.totals), emptyTotals());
    const series = base.series.map(({ key }) => ({
      key,
      totals: dashboards.reduce((sum, dashboard) => {
        const bucket = dashboard.series.find((candidate) => candidate.key === key);
        return bucket ? addTotals(sum, bucket.totals) : sum;
      }, emptyTotals()),
    }));
    const effectiveQuery: UsageHistoryQuery = {
      userId: query.userId,
      scope: base.scope,
      agent: query.agent,
      model: query.model,
      project: query.project,
      user: query.user,
      from: base.from,
      to: base.to,
    };
    const matchingJobs = this.allHistory(effectiveQuery);
    const effortByAgent = effortFor(matchingJobs, (job) => job.agent);
    const effortByModel = effortFor(matchingJobs, (job) => job.model ?? UNATTRIBUTED);
    const tools = toolsFor(matchingJobs, { userId: query.userId, scope: base.scope });

    return {
      ...base,
      totals,
      series,
      byAgent: mergeBreakdowns(dashboards.flatMap((dashboard) => dashboard.byAgent)),
      byModel: mergeBreakdowns(dashboards.flatMap((dashboard) => dashboard.byModel)),
      byProject: mergeBreakdowns(dashboards.flatMap((dashboard) => dashboard.byProject)),
      byUser: base.scope === 'everyone'
        ? mergeBreakdowns(dashboards.flatMap((dashboard) => dashboard.byUser ?? []))
        : undefined,
      effortByAgent,
      effortByModel,
      topTools: tools.overall,
      topToolsByAgent: tools.byAgent,
    };
  }

  burn(userId: number, agent: string, hours: number, now = new Date()): UsageBurn {
    const span = Math.max(1, Math.trunc(hours));
    const to = now.toISOString();
    const from = new Date(now.getTime() - span * 3_600_000).toISOString();
    const totals = [...this.entries.values()].reduce(
      (sum, entry) => addTotals(sum, entry.store.burn(userId, agent, span, now).totals),
      emptyTotals(),
    );
    return { from, to, hours: span, totals };
  }

  costBaselineFor(scope: SessionStorageScope, nativeSessionId: string): number | null;
  costBaselineFor(nativeSessionId: string): number | null;
  costBaselineFor(
    scopeOrNativeId: SessionStorageScope | string,
    maybeNativeId?: string,
  ): number | null {
    if (typeof scopeOrNativeId !== 'string') {
      return this.entryFor(scopeOrNativeId)?.store.costBaselineFor(String(maybeNativeId ?? '')) ?? null;
    }
    const matches = this.entriesForNativeId(scopeOrNativeId);
    return matches.length === 1 ? matches[0].store.costBaselineFor(scopeOrNativeId) : null;
  }

  consumedFor(scope: SessionStorageScope, nativeSessionId: string): ChatUsage;
  consumedFor(nativeSessionId: string): ChatUsage;
  consumedFor(
    scopeOrNativeId: SessionStorageScope | string,
    maybeNativeId?: string,
  ): ChatUsage {
    if (typeof scopeOrNativeId !== 'string') {
      return this.entryFor(scopeOrNativeId)?.store.consumedFor(String(maybeNativeId ?? '')) ?? {};
    }
    const matches = this.entriesForNativeId(scopeOrNativeId);
    return matches.length === 1 ? matches[0].store.consumedFor(scopeOrNativeId) : {};
  }

  spendByTurn(scope: SessionStorageScope, sessionId: string, userId: number): Map<string, ChatUsage>;
  spendByTurn(sessionId: string, userId: number): Map<string, ChatUsage>;
  spendByTurn(
    scopeOrSessionId: SessionStorageScope | string,
    sessionIdOrUserId: string | number,
    maybeUserId?: number,
  ): Map<string, ChatUsage> {
    if (typeof scopeOrSessionId !== 'string') {
      const entry = this.entryFor(scopeOrSessionId);
      return entry
        ? entry.store.spendByTurn(String(sessionIdOrUserId), Number(maybeUserId))
        : new Map();
    }
    const userId = Number(sessionIdOrUserId);
    const matches = this.entriesWithSession(scopeOrSessionId, { userId, scope: 'self' });
    return matches.length === 1
      ? matches[0].store.spendByTurn(scopeOrSessionId, userId)
      : new Map();
  }

  /**
   * Retrospective codex cost backfill (issue #182), across every registered
   * workspace. Returns how many rows gained an estimate.
   */
  backfillCodex(estimator: CodexCostEstimator): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.store.backfillCodexEstimates(estimator);
    }
    return total;
  }

  /**
   * Bind the codex list-price estimator (issue #182) and invalidate the
   * per-workspace "already backfilled" marks, so workspaces registered from
   * here on — and any already registered — have their eligible codex history
   * priced.
   */
  attachCodexEstimator(estimator: CodexCostEstimator): void {
    this.codexEstimator = estimator;
    this.backfilled.clear();
  }

  close(): void {
    this.entries.clear();
  }

  private allHistory(query: UsageHistoryQuery): LocatedJob[] {
    const jobs: LocatedJob[] = [];
    for (const entry of this.entries.values()) {
      let offset = 0;
      let total = 0;
      do {
        const page = entry.store.history({ ...query, limit: HISTORY_PAGE, offset });
        total = page.total;
        jobs.push(...page.jobs.map((job) => ({ entry, job })));
        offset += page.jobs.length;
        if (page.jobs.length === 0) break;
      } while (offset < total);
    }
    return jobs;
  }

  private entriesWithJob(
    id: string,
    query: UsageQuery,
  ): Array<{ entry: WorkspaceUsageEntry; record: UsageJobRecord }> {
    const matches: Array<{ entry: WorkspaceUsageEntry; record: UsageJobRecord }> = [];
    for (const entry of this.entries.values()) {
      const record = entry.store.job(id, query);
      if (record) matches.push({ entry, record });
    }
    return matches;
  }

  private entriesWithSession(sessionId: string, query: UsageQuery): WorkspaceUsageEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.store.history({ ...query, sessionId, limit: 1, offset: 0 }).total > 0);
  }

  private entriesForNativeId(nativeSessionId: string): WorkspaceUsageEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.store.costBaselineFor(nativeSessionId) !== null);
  }

  private entryFor(scope: SessionStorageScope): WorkspaceUsageEntry | undefined {
    return this.entries.get(scopeKey(freezeScope(scope)));
  }

  private assertSessionScope(target: WorkspaceUsageEntry, sessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.key === target.key || entry.scope.ownerKey !== target.scope.ownerKey) continue;
      const usageRows = entry.store.history({ userId: 0, scope: 'everyone', sessionId, limit: 1 }).total;
      // Existing usage is enough to prove the session was already bound. The
      // runtime_sessions check below covers a newly created session before its
      // first turn without relying on a global id catalogue.
      const sessionRow = entry.database.raw.prepare(
        'SELECT 1 AS present FROM runtime_sessions WHERE owner_key = ? AND id = ? LIMIT 1',
      ).get(entry.scope.ownerKey, sessionId) as { present: number } | undefined;
      if (usageRows > 0 || sessionRow) {
        throw new Error(`Session ${sessionId} is already bound to another workspace scope`);
      }
    }
  }
}

function freezeScope(scope: SessionStorageScope): Readonly<SessionStorageScope> {
  if (!scope || !path.isAbsolute(scope.workspaceRoot) || !scope.ownerKey) {
    throw new Error('Workspace usage requires an absolute workspace root and owner key');
  }
  return Object.freeze({
    workspaceRoot: path.resolve(scope.workspaceRoot),
    ownerKey: scope.ownerKey,
  });
}

function assertDatabaseScope(scope: Readonly<SessionStorageScope>, database: SessionPersistenceDatabase): void {
  const expectedPath = path.join(scope.workspaceRoot, '.cc-web', 'session-state.sqlite');
  if (path.resolve(database.dbPath) !== expectedPath) {
    throw new Error('Usage coordinator accepts only the workspace-local session database');
  }
  const described = database as SessionPersistenceDatabase & {
    workspaceRoot?: string;
    ownerKey?: string;
  };
  if (described.workspaceRoot && path.resolve(described.workspaceRoot) !== scope.workspaceRoot) {
    throw new Error('Usage database does not belong to the registered workspace root');
  }
  if (described.ownerKey && described.ownerKey !== scope.ownerKey) {
    throw new Error('Usage database does not belong to the registered owner');
  }
}

function scopeKey(scope: Readonly<SessionStorageScope>): string {
  return `${scope.workspaceRoot}\u0000${scope.ownerKey}`;
}

function compareLocatedNewest(a: LocatedJob, b: LocatedJob): number {
  return b.job.endedAt.localeCompare(a.job.endedAt)
    || b.job.id.localeCompare(a.job.id)
    || a.entry.key.localeCompare(b.entry.key);
}

function emptyTotals(): UsageTotals {
  return { ...EMPTY_TOTALS };
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    turns: left.turns + right.turns,
    modelTurns: left.modelTurns + right.modelTurns,
    toolCalls: left.toolCalls + right.toolCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
    tokensReportedTurns: left.tokensReportedTurns + right.tokensReportedTurns,
    costReportedTurns: left.costReportedTurns + right.costReportedTurns,
    modelTurnsReportedTurns: left.modelTurnsReportedTurns + right.modelTurnsReportedTurns,
  };
}

function mergeBreakdowns(rows: UsageBreakdown[]): UsageBreakdown[] {
  const byKey = new Map<string, UsageTotals>();
  for (const row of rows) {
    byKey.set(row.key, addTotals(byKey.get(row.key) ?? emptyTotals(), row.totals));
  }
  return [...byKey].map(([key, totals]) => ({ key, totals })).sort((a, b) =>
    b.totals.costUsd - a.totals.costUsd
    || b.totals.totalTokens - a.totals.totalTokens
    || b.totals.turns - a.totals.turns
    || a.key.localeCompare(b.key));
}

interface MutableEffort {
  key: string;
  turns: number;
  modelTurnsReportedTurns: number;
  modelTurnsTotal: number;
  modelTurnsMax: number;
  toolCallsTotal: number;
  toolCallsMax: number;
  modelTurnsHistogram: [number, number, number, number, number];
  toolCallsHistogram: [number, number, number, number, number];
}

function effortFor(
  jobs: LocatedJob[],
  keyFor: (job: UsageJobSummary) => string,
): UsageEffort[] {
  const groups = new Map<string, MutableEffort>();
  for (const { job } of jobs) {
    if (job.outcome !== 'completed') continue;
    const key = keyFor(job);
    const current = groups.get(key) ?? {
      key,
      turns: 0,
      modelTurnsReportedTurns: 0,
      modelTurnsTotal: 0,
      modelTurnsMax: 0,
      toolCallsTotal: 0,
      toolCallsMax: 0,
      modelTurnsHistogram: [0, 0, 0, 0, 0],
      toolCallsHistogram: [0, 0, 0, 0, 0],
    };
    current.turns += 1;
    current.toolCallsTotal += job.toolCalls;
    current.toolCallsMax = Math.max(current.toolCallsMax, job.toolCalls);
    current.toolCallsHistogram[toolHistogramIndex(job.toolCalls)] += 1;
    if (job.modelTurns !== null) {
      current.modelTurnsReportedTurns += 1;
      current.modelTurnsTotal += job.modelTurns;
      current.modelTurnsMax = Math.max(current.modelTurnsMax, job.modelTurns);
      current.modelTurnsHistogram[modelHistogramIndex(job.modelTurns)] += 1;
    }
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    turns: group.turns,
    modelTurnsReportedTurns: group.modelTurnsReportedTurns,
    modelTurnsAvg: round2(group.modelTurnsReportedTurns
      ? group.modelTurnsTotal / group.modelTurnsReportedTurns
      : 0),
    modelTurnsMax: group.modelTurnsMax,
    toolCallsAvg: round2(group.turns ? group.toolCallsTotal / group.turns : 0),
    toolCallsMax: group.toolCallsMax,
    modelTurnsHistogram: group.modelTurnsHistogram,
    toolCallsHistogram: group.toolCallsHistogram,
  })).sort((a, b) => b.turns - a.turns || a.key.localeCompare(b.key));
}

function toolsFor(
  jobs: LocatedJob[],
  query: UsageQuery,
): { overall: UsageToolUse[]; byAgent: UsageToolUse[] } {
  const overall = new Map<string, UsageToolUse>();
  const byAgent = new Map<string, UsageToolUse>();
  for (const { entry, job } of jobs) {
    const record = entry.store.job(job.id, query);
    if (!record) continue;
    for (const tool of record.tools) {
      const total = overall.get(tool.tool) ?? { tool: tool.tool, agent: null, calls: 0, turns: 0 };
      total.calls += tool.calls;
      total.turns += 1;
      overall.set(tool.tool, total);

      const agentKey = `${record.agent}\u0000${tool.tool}`;
      const perAgent = byAgent.get(agentKey) ?? {
        tool: tool.tool,
        agent: record.agent,
        calls: 0,
        turns: 0,
      };
      perAgent.calls += tool.calls;
      perAgent.turns += 1;
      byAgent.set(agentKey, perAgent);
    }
  }
  const sort = (a: UsageToolUse, b: UsageToolUse): number =>
    b.calls - a.calls || a.tool.localeCompare(b.tool) || String(a.agent).localeCompare(String(b.agent));
  return {
    overall: [...overall.values()].sort(sort).slice(0, 100),
    byAgent: [...byAgent.values()].sort(sort).slice(0, 100),
  };
}

function emptyDashboard(query: UsageRangeQuery, canSeeEveryone: boolean): UsageDashboard {
  const tz = Number.isFinite(query.tzOffsetMinutes) ? Math.trunc(query.tzOffsetMinutes as number) : 0;
  const scope = query.scope === 'everyone' && canSeeEveryone ? 'everyone' : 'self';
  const window = windowFor(query.period, query.anchor ?? new Date(), tz, query.from, query.to);
  const filters = activeFilters({ ...query, from: undefined, to: undefined });
  if (window.windowed) {
    filters.from = window.from.toISOString();
    filters.to = window.to.toISOString();
  }
  return {
    scope,
    canSeeEveryone,
    period: query.period,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    bucket: window.unit,
    filters,
    totals: emptyTotals(),
    series: window.buckets.map((key) => ({ key, totals: emptyTotals() })),
    byAgent: [],
    byModel: [],
    byProject: [],
    byUser: scope === 'everyone' ? [] : undefined,
    effortByAgent: [],
    effortByModel: [],
    topTools: [],
    topToolsByAgent: [],
  };
}

function activeFilters(filters: UsageFilters): UsageFilters {
  const out: UsageFilters = {};
  for (const key of ['agent', 'model', 'project', 'user', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

function modelHistogramIndex(value: number): number {
  if (value <= 1) return 0;
  if (value === 2) return 1;
  if (value <= 5) return 2;
  if (value <= 10) return 3;
  return 4;
}

function toolHistogramIndex(value: number): number {
  if (value === 0) return 0;
  if (value <= 2) return 1;
  if (value <= 5) return 2;
  if (value <= 10) return 3;
  return 4;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, number));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
