/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this file only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import { AppDatabase } from '../database.js';
import type { SqliteDatabase } from '../sqlite.js';
import type {
  RuntimeSessionOperationalState,
  SessionPersistenceDatabase,
} from './types.js';
import { operationalStateFromDatabaseRow } from './types.js';
import { WorkspaceSessionDatabaseTrust } from './trusted.js';

/** A workspace-local state file, shared safely by accounts through owner_key. */
export class WorkspaceSessionDatabase
  extends WorkspaceSessionDatabaseTrust
  implements SessionPersistenceDatabase {
  /**
   * Move rows only after they have been copied and counted in this file.
   *
   * There is no transaction spanning the installation and workspace files.
   * Holding an IMMEDIATE transaction on the source is therefore load-bearing:
   * it prevents a legacy writer from committing a newer row after our SELECT
   * but before cleanup.  The destination commits first, so a crash can still
   * duplicate a row (the primary keys make that harmless) but cannot lose the
   * only copy or delete an update which was never verified.
   */
  migrateLegacySessions(
    legacy: AppDatabase,
    legacyOwnerUserId: number,
    sessionIds: Iterable<string>,
  ): boolean {
    const ids = [...new Set(Array.from(sessionIds, String).filter(Boolean))];
    if (ids.length === 0) return true;
    const source = legacy.raw;
    try {
      this.withLegacyWriteLock(source, () => {
        const requested = new Set(ids);
        const requestedSlots = ids.map(() => '?').join(', ');
        const sessions = source.prepare(
          `SELECT * FROM runtime_sessions WHERE owner_user_id = ? AND id IN (${requestedSlots})`,
        ).all(legacyOwnerUserId, ...ids) as Array<Record<string, unknown>>;
        const sourceIds = new Set(sessions.map((row) => String(row.id)));
        const targetExists = this.db.prepare(
          'SELECT 1 AS present FROM runtime_sessions WHERE owner_key = ? AND id = ? LIMIT 1',
        );
        // A retry can legitimately name members whose source rows disappeared
        // after an earlier successful cutover. Treat them as complete only
        // when this exact owner archive already contains their destination.
        for (const id of ids) {
          if (!sourceIds.has(id) && !targetExists.get(this.ownerKey, id)) {
            throw new Error('legacy session source changed before migration');
          }
        }

        const dependencyRows = source.prepare(`
          SELECT id, owner_session_id
          FROM runtime_sessions
          WHERE owner_user_id = ?
        `).all(legacyOwnerUserId) as Array<{ id: string; owner_session_id: string | null }>;
        const sourceDependencies = new Map(
          dependencyRows.map((row) => [String(row.id), row.owner_session_id || null]),
        );

        // Enforce the unit boundary while the source writer reservation is
        // held. The orchestrator is not a security boundary: no direct caller
        // may cut over a child without naming its parent, or a parent while
        // leaving any transitive descendant in app.sqlite.
        for (const row of sessions) {
          let currentId = String(row.id);
          const seen = new Set<string>();
          for (;;) {
            if (seen.has(currentId)) {
              throw new Error('legacy session ownership contains a cycle');
            }
            seen.add(currentId);
            const parentId = sourceDependencies.get(currentId);
            if (!parentId) break;
            if (!requested.has(parentId)) {
              throw new Error('legacy migration unit omitted a parent session');
            }
            if (!sourceDependencies.has(parentId) && !targetExists.get(this.ownerKey, parentId)) {
              throw new Error('legacy migration unit parent is unavailable');
            }
            currentId = parentId;
          }
        }
        for (const row of dependencyRows) {
          if (requested.has(String(row.id))) continue;
          let parentId = row.owner_session_id || null;
          const seen = new Set<string>([String(row.id)]);
          while (parentId) {
            if (seen.has(parentId)) {
              // An unrelated corrupt unit must not block an independent one.
              // Cycles intersecting the requested unit are rejected above.
              break;
            }
            seen.add(parentId);
            if (requested.has(parentId)) {
              throw new Error('legacy migration unit omitted a descendant session');
            }
            parentId = sourceDependencies.get(parentId) ?? null;
          }
        }

        // Every requested member is already authoritative locally.
        if (sessions.length === 0) return;
        const remainingIds = sessions.map((row) => String(row.id));
        const slots = remainingIds.map(() => '?').join(', ');
        // Usage follows the application session id, not the native runtime id:
        // clearing/compacting a chat replaces the latter but it is still one
        // workspace record and must move with it.
        const jobs = source.prepare(
          `SELECT * FROM usage_jobs WHERE user_id = ? AND session_id IN (${slots})`,
        ).all(legacyOwnerUserId, ...remainingIds) as Array<Record<string, unknown>>;
        const copy = this.db.transaction(() => {
          for (const row of sessions) this.copyLegacySession(row);
          for (const row of jobs) this.copyLegacyJob(source, row);
        });
        copy();
        const copiedSessions = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM runtime_sessions WHERE owner_key = ? AND id IN (${slots})`,
        ).get(this.ownerKey, ...remainingIds) as { n: number }).n);
        const jobIds = jobs.map((row) => String(row.id));
        const copiedJobs = jobIds.length === 0 ? 0 : Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_jobs WHERE owner_key = ? AND id IN (${jobIds.map(() => '?').join(', ')})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        if (copiedSessions !== sessions.length || copiedJobs !== jobs.length) {
          throw new Error('workspace copy verification did not find every legacy row');
        }
        // Seal the already-verified destination before releasing the source
        // lock. If the source COMMIT fails, both copies remain and retry is
        // idempotent; if sealing fails, the source transaction rolls back.
        this.markArchiveTrusted();
        // Verification succeeded. Delete only this owner's records; settings
        // and other accounts remain in the installation database.
        source.prepare(`DELETE FROM runtime_sessions WHERE owner_user_id = ? AND id IN (${slots})`)
          .run(legacyOwnerUserId, ...remainingIds);
        source.prepare(`DELETE FROM usage_jobs WHERE user_id = ? AND session_id IN (${slots})`)
          .run(legacyOwnerUserId, ...remainingIds);
      });
      return true;
    } catch (error) {
      // The source deliberately remains intact. A later construction retries
      // the idempotent inserts and gets another opportunity to verify.
      console.error('Workspace session migration did not complete:', error);
      return false;
    }
  }

  /**
   * Preserve usage whose conversation row was deleted by an older release.
   * Those rows no longer carry a recoverable workspace path, so the caller
   * selects one authorised owner archive explicitly; they are never guessed
   * into a project and never left invisible in the global database.
   */
  migrateLegacyOrphanUsage(legacy: AppDatabase, legacyOwnerUserId: number): boolean {
    const source = legacy.raw;
    try {
      this.withLegacyWriteLock(source, () => {
        const jobs = source.prepare(`
          SELECT usage_jobs.*
          FROM usage_jobs
          LEFT JOIN runtime_sessions
            ON runtime_sessions.id = usage_jobs.session_id
           AND runtime_sessions.owner_user_id = usage_jobs.user_id
          WHERE usage_jobs.user_id = ? AND runtime_sessions.id IS NULL
        `).all(legacyOwnerUserId) as Array<Record<string, unknown>>;
        if (jobs.length === 0) return;

        const copy = this.db.transaction(() => {
          for (const row of jobs) this.copyLegacyJob(source, row);
        });
        copy();

        const jobIds = jobs.map((row) => String(row.id));
        const slots = jobIds.map(() => '?').join(', ');
        const copiedJobs = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_jobs WHERE owner_key = ? AND id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        const sourceModels = Number((source.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_models WHERE job_id IN (${slots})`,
        ).get(...jobIds) as { n: number }).n);
        const copiedModels = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_models WHERE owner_key = ? AND job_id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        const sourceTools = Number((source.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_tools WHERE job_id IN (${slots})`,
        ).get(...jobIds) as { n: number }).n);
        const copiedTools = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_tools WHERE owner_key = ? AND job_id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        if (
          copiedJobs !== jobs.length
          || copiedModels !== sourceModels
          || copiedTools !== sourceTools
        ) {
          throw new Error('orphan usage copy verification did not match source rows');
        }

        source.prepare(
          `DELETE FROM usage_jobs WHERE user_id = ? AND id IN (${slots})`,
        ).run(legacyOwnerUserId, ...jobIds);
      });
      return true;
    } catch (error) {
      console.error('Legacy orphan usage migration did not complete:', error);
      return false;
    }
  }

  /**
   * Acquire SQLite's writer reservation before the first legacy SELECT.
   * A deferred transaction would only pin a read snapshot; in WAL mode a
   * second connection could still commit an update and our later DELETE would
   * either erase unseen data or strand a stale destination collision.
   */
  private withLegacyWriteLock<Result>(source: SqliteDatabase, operation: () => Result): Result {
    source.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      source.exec('COMMIT');
      return result;
    } catch (error) {
      try { source.exec('ROLLBACK'); } catch { /* Preserve the cutover error. */ }
      throw error;
    }
  }

  private copyLegacySession(row: Record<string, unknown>): void {
    const cols = [
      'id', 'owner_user_id', 'name', 'created_at', 'last_activity', 'active', 'agent', 'last_agent',
      'runtime_label', 'terminal_options_json', 'working_dir', 'output_buffer_json',
      'session_start_time', 'session_usage_json', 'max_buffer_size', 'last_accessed', 'surface',
      'native_chat_session_id', 'owner_session_id', 'chat_bypass_permissions', 'chat_model_override',
      'chat_model_pinned', 'chat_effort_override', 'chat_plan_mode', 'custom_name', 'tab_open',
      'tab_order', 'project_id', 'project_working_dir_kind',
    ];
    const values = cols.map((key) => row[key] ?? null);
    const envelope = this.sealRuntimeSessionRecord({
      ...operationalStateFromDatabaseRow(row),
      // Legacy installation rows cannot be rollback anchors. The workspace
      // target column is additive and defaults to the only safe legacy value.
      rollback_recovery_pending: 0,
    });
    this.db.prepare(`INSERT OR IGNORE INTO runtime_sessions
      (owner_key, ${cols.join(', ')}, operational_envelope)
      VALUES (${['?'].concat(cols.map(() => '?'), ['?']).join(', ')})`)
      .run(this.ownerKey, ...values, envelope);
    const target = this.db.prepare(
      `SELECT ${cols.join(', ')} FROM runtime_sessions WHERE owner_key = ? AND id = ?`,
    ).get(this.ownerKey, row.id) as Record<string, unknown> | undefined;
    this.assertEquivalentLegacyRow('session', row, target, cols, new Set(['owner_user_id']));
    // INSERT OR IGNORE makes crash recovery idempotent; refresh the envelope
    // only after the pre-existing row has been proven equivalent to source.
    this.db.prepare(`UPDATE runtime_sessions SET operational_envelope = ?
      WHERE owner_key = ? AND id = ?`).run(envelope, this.ownerKey, row.id);
  }

  private copyLegacyJob(source: SqliteDatabase, row: Record<string, unknown>): void {
    // Derived compatibility fields used to be backfilled in app.sqlite on
    // every boot. The installation database is now import-only: preserve its
    // exact row and apply the historical normalisation solely to the verified
    // workspace destination.
    const normalized: Record<string, unknown> = { ...row };
    if (normalized.project !== null && normalized.project !== undefined
      && (normalized.project_source === null || normalized.project_source === undefined)) {
      normalized.project_source = 'observed';
    }
    if (normalized.total_tokens === null || normalized.total_tokens === undefined) {
      const tokenParts = [
        normalized.input_tokens,
        normalized.output_tokens,
        normalized.cache_read_tokens,
        normalized.cache_write_tokens,
      ];
      if (tokenParts.some((value) => value !== null && value !== undefined)) {
        normalized.total_tokens = tokenParts.reduce<number>(
          (sum, value) => sum + (typeof value === 'number' ? value : 0),
          0,
        );
      } else if (typeof normalized.reasoning_tokens === 'number') {
        normalized.total_tokens = normalized.reasoning_tokens;
      }
    }
    const cols = [
      'id', 'session_id', 'native_session_id', 'turn_id', 'user_id', 'user_login', 'agent', 'model',
      'project', 'project_source', 'started_at', 'ended_at', 'duration_ms', 'outcome', 'turns',
      'model_turns', 'tool_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens',
      'cache_write_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'reports_usage', 'reports_cost',
    ];
    this.db.prepare(`INSERT OR IGNORE INTO usage_jobs (owner_key, ${cols.join(', ')})
      VALUES (${['?'].concat(cols.map(() => '?')).join(', ')})`).run(
      this.ownerKey, ...cols.map((key) => normalized[key] ?? null),
    );
    const id = String(row.id);
    const selectTarget = this.db.prepare(
      `SELECT ${cols.join(', ')} FROM usage_jobs WHERE owner_key = ? AND id = ?`,
    );
    let target = selectTarget.get(this.ownerKey, id) as Record<string, unknown> | undefined;
    try {
      this.assertEquivalentLegacyRow(
        'usage job',
        normalized,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
    } catch {
      // A crash from a build predating destination-only normalisation can
      // leave an otherwise exact local row with the two source-null fields.
      // Prove that raw equivalence before upgrading only this workspace copy;
      // an unrelated collision still fails the raw comparison and is never
      // overwritten.
      this.assertEquivalentLegacyRow(
        'usage job',
        row,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
      this.db.prepare(`UPDATE usage_jobs
        SET project_source = ?, total_tokens = ?
        WHERE owner_key = ? AND id = ?`).run(
        normalized.project_source ?? null,
        normalized.total_tokens ?? null,
        this.ownerKey,
        id,
      );
      target = selectTarget.get(this.ownerKey, id) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow(
        'usage job',
        normalized,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
    }
    const models = source.prepare('SELECT * FROM usage_job_models WHERE job_id = ?').all(id) as Array<Record<string, unknown>>;
    const modelCols = [
      'job_id', 'model', 'calls', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
    ];
    for (const model of models) {
      this.db.prepare(`INSERT OR IGNORE INTO usage_job_models
        (owner_key, ${modelCols.join(', ')}) VALUES (?, ${modelCols.map(() => '?').join(', ')})`)
        .run(this.ownerKey, ...modelCols.map((key) => model[key] ?? null));
      const copied = this.db.prepare(`SELECT ${modelCols.join(', ')} FROM usage_job_models
        WHERE owner_key = ? AND job_id = ? AND model = ?`)
        .get(this.ownerKey, model.job_id, model.model) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow('usage model', model, copied, modelCols);
    }
    const tools = source.prepare('SELECT * FROM usage_job_tools WHERE job_id = ?').all(id) as Array<Record<string, unknown>>;
    const toolCols = ['job_id', 'tool', 'calls'];
    for (const tool of tools) {
      this.db.prepare('INSERT OR IGNORE INTO usage_job_tools (owner_key, job_id, tool, calls) VALUES (?, ?, ?, ?)')
        .run(this.ownerKey, tool.job_id, tool.tool, tool.calls);
      const copied = this.db.prepare(`SELECT ${toolCols.join(', ')} FROM usage_job_tools
        WHERE owner_key = ? AND job_id = ? AND tool = ?`)
        .get(this.ownerKey, tool.job_id, tool.tool) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow('usage tool', tool, copied, toolCols);
    }
    const targetModels = Number((this.db.prepare(
      'SELECT COUNT(*) AS n FROM usage_job_models WHERE owner_key = ? AND job_id = ?',
    ).get(this.ownerKey, id) as { n: number }).n);
    const targetTools = Number((this.db.prepare(
      'SELECT COUNT(*) AS n FROM usage_job_tools WHERE owner_key = ? AND job_id = ?',
    ).get(this.ownerKey, id) as { n: number }).n);
    if (targetModels !== models.length || targetTools !== tools.length) {
      throw new Error(`legacy usage child collision for ${id}`);
    }
  }

  private assertEquivalentLegacyRow(
    label: string,
    source: Record<string, unknown>,
    target: Record<string, unknown> | undefined,
    columns: string[],
    ignored = new Set<string>(),
  ): void {
    if (!target) throw new Error(`legacy ${label} copy is missing`);
    for (const column of columns) {
      if (ignored.has(column)) continue;
      const expected = source[column] ?? null;
      const actual = target[column] ?? null;
      if (!Object.is(actual, expected)) {
        throw new Error(`legacy ${label} collision in ${column}`);
      }
    }
  }
}
