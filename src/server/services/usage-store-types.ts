import type { CodexCostEstimate } from '../../shared/codex-pricing.js';
import type { AppDatabase } from './database.js';
import type { SessionPersistenceDatabase } from './workspace-session-database.js';
import type {
  UsageFilters,
  UsageOutcome,
  UsagePeriod,
  UsageScope,
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
  /** issue #182: the full provenance of a codex estimate, when one was computed. */
  costEstimate?: CodexCostEstimate | null;
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

export interface UsageStoreOptions {
  database: AppDatabase | SessionPersistenceDatabase;
  /** Required when the database is a shared workspace state file. */
  ownerKey?: string;
}
