/**
 * Project persistence: the rows, the states, and the one number that must
 * never be wrong.
 *
 * The store owns everything that is pure data — CRUD, owner scoping, the
 * connected-host credentials, the build-event ring buffer — and exactly one
 * piece of policy: the run-limit check-and-transition, which lives here
 * because it is only meaningful inside a single `BEGIN IMMEDIATE`
 * transaction. A check in one statement and a transition in another would
 * let two concurrent starts both pass the count; holding the write lock from
 * the count to the update is what makes the limit real.
 */

import { randomUUID } from 'node:crypto';
import { AppDatabase } from '../database.js';
import { EncryptionKeyRing } from '../encryption.js';
import { SqliteDatabase } from '../sqlite.js';

/** Every state a project row can be in. `blocked` means preservation failed
 * and the rebuild or reclaim that needed it is held until the user decides. */
export type ProjectState =
  | 'inspecting'
  | 'composition_pending'
  | 'building'
  | 'running'
  | 'stopped'
  | 'reclaiming'
  | 'failed'
  | 'unavailable'
  | 'blocked';

/** The states that count against a user's run limit. */
export const COUNTED_STATES: ProjectState[] = ['building', 'running', 'reclaiming'];

/** What a restart needs to find a project's container again. */
export interface ProjectContainerInfo {
  name: string;
  image?: string;
  shells?: string[];
  /**
   * A boot scan found a same-project runtime which could not be safely
   * adopted. Its name is retained solely to block destructive lifecycle work
   * until a later complete scan proves that runtime is gone.
   */
  reconciliationConflict?: 'unverified_runtime';
}

/** One buffered build event, persisted so a reopened tab rejoins the build. */
export interface BuildEvent {
  t: 'step' | 'progress' | 'state' | 'error' | 'preserve' | 'partial_install';
  step?: string;
  message?: string;
  percent?: number;
  state?: ProjectState;
  branch?: string;
  commit?: string;
  at: string;
}

export interface Project {
  id: string;
  ownerUserId: number;
  name: string;
  repoUrl: string | null;
  repoHost: string | null;
  /** The deploy target it was placed on; null means the legacy engine. */
  targetId: string | null;
  /** Host projects are ordinary local workspaces; container is the legacy/default placement. */
  executionKind: 'host' | 'container';
  tierId: string | null;
  state: ProjectState;
  stateDetail: string | null;
  container: ProjectContainerInfo | null;
  /** True only when retained workspace bytes must be replaced on next build. */
  rebuildRequired: boolean;
  buildLog: BuildEvent[];
  lastActivityAt: string;
  lastPreservedCommit: string | null;
  lastPreservedBranch: string | null;
  compositionRevision: string | null;
  /** Revision applied to the currently retained runtime; null for legacy rows. */
  appliedCompositionRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  ownerUserId: number;
  name: string;
  repoUrl?: string | null;
  repoHost?: string | null;
  targetId?: string | null;
  executionKind?: 'host' | 'container';
  tierId?: string | null;
  /** Opt-in so existing callers retain the historical stopped-on-create contract. */
  initialState?: Extract<ProjectState, 'inspecting' | 'composition_pending' | 'stopped'>;
}

export type CompositionInstallationStatus = 'pending' | 'installing' | 'installed' | 'failed';

export interface ProjectComposition {
  id: string;
  projectId: string;
  userId: number;
  catalogVersion: string;
  detected: unknown;
  chosen: unknown;
  sourceOid: string | null;
  sourceRef: string | null;
  forgeKind: string | null;
  forgeHost: string | null;
  createdAt: string;
}

export interface CompositionInstallation {
  id: string;
  compositionId: string;
  itemId: string;
  status: CompositionInstallationStatus;
  attempts: number;
  installedVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitIdentity {
  id: string;
  userId: number;
  projectId: string | null;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageUsageSnapshot {
  id: string;
  userId: number | null;
  totalBytes: number;
  breakdown: StorageUsageBreakdown;
  errors: string[];
  freeBytes: number | null;
  createdAt: string;
}
/** Scanner-owned category map.  Unknown categories survive a round trip so
 * future scanner versions do not need a schema migration merely to report. */
export interface StorageUsageBreakdown {
  [category: string]: StorageUsageValue;
}
export type StorageUsageValue = number | string | boolean | null | StorageUsageBreakdown | StorageUsageValue[];

/** One row of the running list a 409 `run_limit` answer carries. */
export interface RunningProjectInfo {
  id: string;
  name: string;
  state: ProjectState;
  lastActivityAt: string;
  /** Active sessions in it — the signal that a swap must never stop it. */
  hasActiveWork: boolean;
}

export type StartAttempt =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_state'
        | 'composition_conflict'
        | 'stop_candidate_invalid'
        | 'stop_candidate_busy'
        | 'run_limit';
      /** Present when reason is `run_limit`: what the user is running now. */
      running?: RunningProjectInfo[];
    };

export type LifecycleClaim =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'active_work' | 'not_idle' };

export type SessionLeaseAttempt =
  | { ok: true; leaseId: string }
  | { ok: false; reason: 'not_found' | 'invalid_state' };

export interface ConnectedHost {
  id: string;
  userId: number;
  host: string;
  kind: string;
  forgeKind: string | null;
  credentialKind: 'token' | 'oauth' | null;
  validationStatus: ConnectedHostValidationStatus | null;
  lastValidatedAt: string | null;
  validationErrorCode: string | null;
  validationErrorMessage: string | null;
  credentialRevision: number;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConnectedHostValidationStatus = 'unvalidated' | 'valid' | 'invalid';

/** One decrypted credential bound to the durable generation that produced it. */
export interface ConnectedCredential {
  token: string;
  kind: 'token' | 'oauth';
  revision: number;
}

/** How many build events a project row keeps; older ones drop off the front. */
const BUILD_LOG_LIMIT = 200;

const SETTING_RUN_LIMIT = 'deploy.runLimitPerUser';
const SETTING_IDLE_STOP = 'deploy.idleStopMinutes';
const SETTING_IDLE_RECLAIM = 'deploy.idleReclaimMinutes';
const SETTING_USAGE_WARN_USER = 'deploy.usageWarnUserBytes';
const SETTING_USAGE_WARN_ADMIN = 'deploy.usageWarnAdminBytes';

export const DEFAULT_RUN_LIMIT_PER_USER = 3;
export const DEFAULT_IDLE_STOP_MINUTES = 60;
/** Seven days: long enough that only a genuinely forgotten project is reclaimed. */
export const DEFAULT_IDLE_RECLAIM_MINUTES = 10080;

/**
 * `BEGIN IMMEDIATE`, commit or rollback as a unit.
 *
 * The shared `SqliteDatabase.transaction` opens a deferred transaction, which
 * is right for everything that only writes: the lock arrives with the first
 * write. The run-limit check reads first and writes second, and a deferred
 * transaction would let another connection's writer slip in between the two.
 * IMMEDIATE takes the write lock up front, so the count and the transition
 * are one indivisible observation.
 */
function immediateTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the one that explains what happened.
    }
    throw error;
  }
}

export class ProjectStore {
  private readonly db: AppDatabase;
  private readonly keyRing: EncryptionKeyRing;

  constructor(options: { database: AppDatabase; keyRing: EncryptionKeyRing }) {
    this.db = options.database;
    this.keyRing = options.keyRing;
  }

  /* ------------------------------------------------------------------ */
  /* Projects                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Insert a project in `stopped` state with no container.
   *
   * A fresh project is deliberately indistinguishable from a reclaimed one:
   * both have no container and both are built by the same start path, which
   * is also where the run limit is enforced. Creation itself is unlimited.
   */
  createProject(input: CreateProjectInput): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO projects (
          id, owner_user_id, name, repo_url, repo_host, target_id, execution_kind, tier_id,
          state, state_detail, container_json, rebuild_required, build_log_json,
          last_activity_at, last_preserved_commit, last_preserved_branch, composition_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.ownerUserId,
        input.name,
        input.repoUrl ?? null,
        input.repoHost ?? null,
        input.targetId ?? null,
        input.executionKind ?? 'container',
        input.tierId ?? null,
        input.initialState ?? 'stopped',
        input.initialState ? 'awaiting composition' : 'created, not built yet',
        now,
        now,
        now,
      );
    return this.getProject(id) as Project;
  }

  /** One project by id, whoever owns it. Callers scope; this does not. */
  getProject(id: string): Project | null {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : null;
  }

  /** One project by id, or null when it is not this user's — the 404 shape. */
  getProjectForUser(id: string, ownerUserId: number): Project | null {
    const row = this.db.raw
      .prepare('SELECT * FROM projects WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  listProjectsForUser(ownerUserId: number): Project[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM projects WHERE owner_user_id = ? ORDER BY created_at ASC')
      .all(ownerUserId) as ProjectRow[];
    return rows.map(toProject);
  }

  /** All projects in any of the given states, across users — the sweep's view. */
  listProjectsInState(...states: ProjectState[]): Project[] {
    if (!states.length) {
      return [];
    }
    const marks = states.map(() => '?').join(', ');
    const rows = this.db.raw
      .prepare(`SELECT * FROM projects WHERE state IN (${marks})`)
      .all(...states) as ProjectRow[];
    return rows.map(toProject);
  }

  /** Every project whose recorded container must be checked during boot recovery. */
  listProjectsWithContainers(): Project[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM projects WHERE container_json IS NOT NULL')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  /** Project ids retaining a target, used to guard admin edits/deletion. */
  projectIdsForTarget(targetId: string): string[] {
    const rows = this.db.raw
      .prepare('SELECT id FROM projects WHERE target_id = ? ORDER BY created_at ASC')
      .all(targetId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** Display fields only; state and placement are not editable here. */
  updateProject(
    id: string,
    patch: { name?: string; repoUrl?: string | null; repoHost?: string | null; tierId?: string | null },
  ): void {
    const existing = this.getProject(id);
    if (!existing) {
      throw new Error(`project "${id}" not found`);
    }
    this.db.raw
      .prepare(
        `UPDATE projects SET name = ?, repo_url = ?, repo_host = ?, tier_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.repoUrl !== undefined ? patch.repoUrl : existing.repoUrl,
        patch.repoHost !== undefined ? patch.repoHost : existing.repoHost,
        patch.tierId !== undefined ? patch.tierId : existing.tierId,
        new Date().toISOString(),
        id,
      );
  }

  setState(id: string, state: ProjectState, detail: string | null = null): void {
    this.db.raw
      .prepare('UPDATE projects SET state = ?, state_detail = ?, updated_at = ? WHERE id = ?')
      .run(state, detail, new Date().toISOString(), id);
  }

  setContainer(id: string, container: ProjectContainerInfo | null): void {
    this.db.raw
      .prepare('UPDATE projects SET container_json = ?, updated_at = ? WHERE id = ?')
      .run(container ? JSON.stringify(container) : null, new Date().toISOString(), id);
  }

  /** Mark (or clear) a true workspace replacement requirement durably. */
  setRebuildRequired(id: string, required: boolean): void {
    this.db.raw
      .prepare('UPDATE projects SET rebuild_required = ?, updated_at = ? WHERE id = ?')
      .run(required ? 1 : 0, new Date().toISOString(), id);
  }

  /**
   * Record activity. Activity is what keeps a project out of the idle sweep,
   * and the sweep is the only reason this timestamp exists.
   */
  touchActivity(id: string, when?: Date): void {
    this.db.raw
      .prepare('UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?')
      .run((when ?? new Date()).toISOString(), new Date().toISOString(), id);
  }

  recordPreservation(id: string, branch: string, commit: string): void {
    this.db.raw
      .prepare('UPDATE projects SET last_preserved_branch = ?, last_preserved_commit = ?, updated_at = ? WHERE id = ?')
      .run(branch, commit, new Date().toISOString(), id);
  }

  /* ------------------------------------------------------------------ */
  /* Immutable composition revisions                                     */
  /* ------------------------------------------------------------------ */

  createCompositionDraft(input: {
    projectId: string; userId: number; catalogVersion: string; detected: unknown; chosen: unknown;
    sourceOid?: string | null; sourceRef?: string | null; forgeKind?: string | null; forgeHost?: string | null;
    installations?: Array<{ itemId: string; status?: CompositionInstallationStatus }>;
  }): ProjectComposition | null {
    return immediateTransaction(this.db.raw, () => {
      if (!this.getProjectForUser(input.projectId, input.userId)) return null;
      const id = randomUUID(); const now = new Date().toISOString();
      this.db.raw.prepare(`INSERT INTO project_compositions (id, project_id, user_id, catalog_version, detected_json, chosen_json, source_oid, source_ref, forge_kind, forge_host, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.userId, input.catalogVersion, JSON.stringify(input.detected), JSON.stringify(input.chosen), input.sourceOid ?? null, input.sourceRef ?? null, input.forgeKind ?? null, input.forgeHost ?? null, now);
      for (const item of input.installations ?? []) this.upsertCompositionInstallation(id, item.itemId, { status: item.status ?? 'pending' });
      return this.getCompositionForUser(id, input.userId);
    });
  }

  /** Name used by route/provisioning callers: every save creates a new immutable revision. */
  saveCompositionDraft(input: {
    projectId: string; userId: number; catalogVersion: string; detected: unknown; chosen: unknown;
    sourceOid?: string | null; sourceRef?: string | null; forgeKind?: string | null; forgeHost?: string | null;
    installations?: Array<{ itemId: string; status?: CompositionInstallationStatus }>;
  }): ProjectComposition | null { return this.createCompositionDraft(input); }

  getCompositionForUser(compositionId: string, userId: number): ProjectComposition | null {
    const row = this.db.raw.prepare('SELECT * FROM project_compositions WHERE id = ? AND user_id = ?').get(compositionId, userId) as CompositionRow | undefined;
    return row ? toComposition(row) : null;
  }

  getProjectComposition(projectId: string, userId: number, revision?: string | null): ProjectComposition | null {
    const row = revision
      ? this.db.raw.prepare('SELECT * FROM project_compositions WHERE id = ? AND project_id = ? AND user_id = ?').get(revision, projectId, userId)
      : this.db.raw.prepare('SELECT * FROM project_compositions WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId, userId);
    return row ? toComposition(row as CompositionRow) : null;
  }

  /** Activate only if the project still points at the revision the editor read. */
  activateComposition(input: { projectId: string; userId: number; expectedCurrentRevision: string | null; revision: string; applyNow?: boolean }): boolean {
    return immediateTransaction(this.db.raw, () => {
      const revision = this.db.raw.prepare('SELECT 1 FROM project_compositions WHERE id = ? AND project_id = ? AND user_id = ?').get(input.revision, input.projectId, input.userId);
      if (!revision) return false;
      const result = this.db.raw.prepare(`UPDATE projects SET composition_revision = ?, applied_composition_revision = CASE WHEN ? THEN ? ELSE applied_composition_revision END, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND composition_revision IS ?`).run(input.revision, input.applyNow ? 1 : 0, input.revision, new Date().toISOString(), input.projectId, input.userId, input.expectedCurrentRevision);
      return result.changes > 0;
    });
  }

  markCompositionApplied(projectId: string, userId: number, revision: string): boolean {
    const result = this.db.raw.prepare('UPDATE projects SET applied_composition_revision = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND composition_revision = ?').run(revision, new Date().toISOString(), projectId, userId, revision);
    return result.changes > 0;
  }

  listCompositionInstallations(compositionId: string, userId: number): CompositionInstallation[] {
    const rows = this.db.raw.prepare(`SELECT i.* FROM composition_installations i INNER JOIN project_compositions c ON c.id = i.composition_id WHERE i.composition_id = ? AND c.user_id = ? ORDER BY i.created_at, i.rowid`).all(compositionId, userId) as CompositionInstallationRow[];
    return rows.map(toCompositionInstallation);
  }

  /** Recipes with work currently inside the shared owner/tool/version lock. */
  listInstallingCompositionsForUser(userId: number): ProjectComposition[] {
    const rows = this.db.raw.prepare(`SELECT DISTINCT c.*
      FROM project_compositions c
      INNER JOIN composition_installations i ON i.composition_id = c.id
      WHERE c.user_id = ? AND i.status = 'installing'`).all(userId) as CompositionRow[];
    return rows.map(toComposition);
  }

  /** A process restart is the only way an installation can stay `installing`. */
  failInterruptedCompositionInstallations(): number {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(`UPDATE composition_installations
      SET status = 'failed', installed_version = NULL,
          error_code = 'INSTALL_INTERRUPTED',
          error_message = 'Installation was interrupted by a server restart',
          updated_at = ?
      WHERE status = 'installing'`).run(now);
    return result.changes;
  }

  upsertCompositionInstallation(compositionId: string, itemId: string, patch: Partial<Pick<CompositionInstallation, 'status' | 'installedVersion' | 'errorCode' | 'errorMessage'>> & { incrementAttempts?: boolean }): CompositionInstallation | null {
    const now = new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO composition_installations (id, composition_id, item_id, status, attempts, installed_version, error_code, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(composition_id, item_id) DO UPDATE SET status = COALESCE(excluded.status, composition_installations.status), attempts = composition_installations.attempts + ?, installed_version = excluded.installed_version, error_code = excluded.error_code, error_message = excluded.error_message, updated_at = excluded.updated_at`)
      .run(randomUUID(), compositionId, itemId, patch.status ?? 'pending', patch.incrementAttempts ? 1 : 0, patch.installedVersion ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, now, now, patch.incrementAttempts ? 1 : 0);
    const row = this.db.raw.prepare('SELECT * FROM composition_installations WHERE composition_id = ? AND item_id = ?').get(compositionId, itemId) as CompositionInstallationRow | undefined;
    return row ? toCompositionInstallation(row) : null;
  }

  updateCompositionInstallationForUser(input: { compositionId: string; userId: number; itemId: string; patch: Partial<Pick<CompositionInstallation, 'status' | 'installedVersion' | 'errorCode' | 'errorMessage'>> & { incrementAttempts?: boolean } }): CompositionInstallation | null {
    if (!this.getCompositionForUser(input.compositionId, input.userId)) return null;
    return this.upsertCompositionInstallation(input.compositionId, input.itemId, input.patch);
  }

  deleteProject(id: string): void {
    this.db.raw.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /**
   * How many of this user's projects count against the run limit right now.
   *
   * Only meaningful outside a start decision; the start path counts inside
   * its own transaction instead.
   */
  countRunning(ownerUserId: number): number {
    const marks = COUNTED_STATES.map(() => '?').join(', ');
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS c FROM projects WHERE owner_user_id = ? AND state IN (${marks})`,
      )
      .get(ownerUserId, ...COUNTED_STATES) as { c: number };
    return row.c;
  }

  /** What this user is running, longest-idle first — the swap offer's order. */
  runningProjects(ownerUserId: number): RunningProjectInfo[] {
    const marks = COUNTED_STATES.map(() => '?').join(', ');
    const rows = this.db.raw
      .prepare(
        `SELECT p.id, p.name, p.last_activity_at,
           p.state,
           (EXISTS(
             SELECT 1 FROM runtime_sessions s
             WHERE s.project_id = p.id AND s.active = 1
           ) OR EXISTS(
             SELECT 1 FROM project_session_leases l
             WHERE l.project_id = p.id
           )) AS has_active_work
         FROM projects p
         WHERE p.owner_user_id = ? AND p.state IN (${marks})
         ORDER BY p.last_activity_at ASC`,
      )
      .all(ownerUserId, ...COUNTED_STATES) as Array<{
      id: string;
      name: string;
      state: ProjectState;
      last_activity_at: string;
      has_active_work: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      state: row.state,
      lastActivityAt: row.last_activity_at,
      hasActiveWork: Boolean(row.has_active_work),
    }));
  }

  /**
   * Count and transition as one indivisible step.
   *
   * This is the only way a project enters a counted state. Optionally stops
   * another project of the same user inside the same transaction (the swap):
   * the stop lands before the count, so swapping at the limit always fits.
   *
   * The active-work check on the stop candidate runs against the sessions
   * table *inside* the lock: "has an agent working" is precisely the fact
   * that must not change between the check and the stop.
   */
  tryStartCounted(input: {
    projectId: string;
    ownerUserId: number;
    toState: ProjectState;
    fromStates: ProjectState[];
    limit: number;
    stopProjectId?: string;
    /**
     * Confirming a recipe and reserving its runtime slot are one decision.
     * Keeping the CAS in this transaction prevents a rejected start from
     * leaving a newly selected recipe active on an unstarted project.
     */
    activateComposition?: {
      revision: string;
      expectedCurrentRevision: string | null;
    };
  }): StartAttempt {
    return immediateTransaction(this.db.raw, (): StartAttempt => {
      const row = this.db.raw
        .prepare('SELECT state FROM projects WHERE id = ? AND owner_user_id = ?')
        .get(input.projectId, input.ownerUserId) as { state: ProjectState } | undefined;
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      if (!input.fromStates.includes(row.state)) {
        return { ok: false, reason: 'invalid_state' };
      }

      if (input.activateComposition) {
        const revision = this.db.raw
          .prepare(
            `SELECT 1 FROM project_compositions
             WHERE id = ? AND project_id = ? AND user_id = ?`,
          )
          .get(input.activateComposition.revision, input.projectId, input.ownerUserId);
        const current = this.db.raw
          .prepare('SELECT composition_revision FROM projects WHERE id = ? AND owner_user_id = ?')
          .get(input.projectId, input.ownerUserId) as { composition_revision: string | null } | undefined;
        if (!revision || !current
          || current.composition_revision !== input.activateComposition.expectedCurrentRevision) {
          return { ok: false, reason: 'composition_conflict' };
        }
      }

      let stopCandidate: string | null = null;
      if (input.stopProjectId) {
        const candidate = this.db.raw
          .prepare('SELECT state FROM projects WHERE id = ? AND owner_user_id = ?')
          .get(input.stopProjectId, input.ownerUserId) as { state: ProjectState } | undefined;
        // Only a running project frees a slot, and only one with nothing
        // working in it may be stopped out from under its owner.
        if (!candidate || candidate.state !== 'running') {
          return { ok: false, reason: 'stop_candidate_invalid' };
        }
        const busy = this.projectHasActiveSessions(input.stopProjectId);
        if (busy) {
          return { ok: false, reason: 'stop_candidate_busy' };
        }
        stopCandidate = input.stopProjectId;
      }

      // Do not stop the candidate until every condition has passed.  A lowered
      // limit can leave a user already over quota; a swap must not silently
      // take one project down merely to return the same run-limit error.
      const count = this.countRunning(input.ownerUserId) - (stopCandidate ? 1 : 0);
      if (count >= input.limit) {
        return { ok: false, reason: 'run_limit', running: this.runningProjects(input.ownerUserId) };
      }

      if (stopCandidate) {
        this.setState(stopCandidate, 'stopped');
        this.touchActivity(stopCandidate);
      }

      const now = new Date().toISOString();
      if (input.activateComposition) {
        this.db.raw
          .prepare(
            `UPDATE projects
             SET state = ?, state_detail = NULL, composition_revision = ?,
                 last_activity_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.toState, input.activateComposition.revision, now, now, input.projectId);
      } else {
        this.db.raw
          .prepare(
            `UPDATE projects SET state = ?, state_detail = NULL, last_activity_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.toState, now, now, input.projectId);
      }
      return { ok: true };
    });
  }

  /** Best-effort CAS used only when the physical half of a reserved swap fails. */
  restoreCompositionActivation(input: {
    projectId: string;
    userId: number;
    expectedRevision: string;
    previousRevision: string | null;
  }): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE projects SET composition_revision = ?, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND composition_revision = ?`,
      )
      .run(
        input.previousRevision,
        new Date().toISOString(),
        input.projectId,
        input.userId,
        input.expectedRevision,
      );
    return result.changes > 0;
  }

  /** Whether any session row says work is live in this project. */
  projectHasActiveSessions(projectId: string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT 1 AS x
           WHERE EXISTS(
             SELECT 1 FROM runtime_sessions WHERE project_id = ? AND active = 1
           ) OR EXISTS(
             SELECT 1 FROM project_session_leases WHERE project_id = ?
           )`,
      )
      .get(projectId, projectId) as { x: number } | undefined;
    return Boolean(row);
  }

  /**
   * Atomically admit one runtime/attachment while the project is runnable.
   * A stop/swap transaction either observes this row and refuses, or changes
   * state first so this acquisition refuses; there is no observation gap.
   */
  tryAcquireSessionLease(projectId: string, ownerUserId: number): SessionLeaseAttempt {
    return immediateTransaction(this.db.raw, (): SessionLeaseAttempt => {
      const project = this.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running') return { ok: false, reason: 'invalid_state' };
      const leaseId = randomUUID();
      this.db.raw
        .prepare(
          `INSERT INTO project_session_leases (id, project_id, owner_user_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(leaseId, projectId, ownerUserId, new Date().toISOString());
      this.touchActivity(projectId);
      return { ok: true, leaseId };
    });
  }

  /** Release is exact and idempotent, suitable for both detach and exit finalizers. */
  releaseSessionLease(projectId: string, ownerUserId: number, leaseId: string): boolean {
    return immediateTransaction(this.db.raw, () => {
      const result = this.db.raw
        .prepare(
          `DELETE FROM project_session_leases
           WHERE id = ? AND project_id = ? AND owner_user_id = ?`,
        )
        .run(leaseId, projectId, ownerUserId);
      if (result.changes > 0) this.touchActivity(projectId);
      return result.changes > 0;
    });
  }

  /**
   * Leases describe this server process's live runtimes/connections. Call only
   * during boot recovery, after old runtimes are known dead and before new
   * project session admission opens.
   */
  clearSessionLeases(): number {
    return this.db.raw.prepare('DELETE FROM project_session_leases').run().changes;
  }

  /**
   * Atomically close admission for a stop before the engine is touched.
   * `reclaiming` doubles as the short-lived stopping claim: it remains counted,
   * and session creation cannot mistake it for a runnable project.
   */
  tryClaimStop(input: {
    projectId: string;
    ownerUserId: number;
    idleBefore?: Date;
    /** An explicit user stop may close admission before attached sessions drain. */
    allowActiveWork?: boolean;
  }): LifecycleClaim {
    return immediateTransaction(this.db.raw, (): LifecycleClaim => {
      const project = this.getProjectForUser(input.projectId, input.ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running') return { ok: false, reason: 'invalid_state' };
      if (input.idleBefore && project.lastActivityAt > input.idleBefore.toISOString()) {
        return { ok: false, reason: 'not_idle' };
      }
      if (!input.allowActiveWork && this.projectHasActiveSessions(project.id)) {
        return { ok: false, reason: 'active_work' };
      }
      this.setState(project.id, 'reclaiming', 'Stopping project environment');
      return { ok: true, project };
    });
  }

  /** Claim an idle stopped row so a stale sweep snapshot cannot reclaim a restart. */
  tryClaimIdleReclaim(input: {
    projectId: string;
    ownerUserId: number;
    idleBefore: Date;
  }): LifecycleClaim {
    return immediateTransaction(this.db.raw, (): LifecycleClaim => {
      const project = this.getProjectForUser(input.projectId, input.ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'stopped') return { ok: false, reason: 'invalid_state' };
      if (project.lastActivityAt > input.idleBefore.toISOString()) return { ok: false, reason: 'not_idle' };
      if (this.projectHasActiveSessions(project.id)) return { ok: false, reason: 'active_work' };
      this.setState(project.id, 'reclaiming', 'Reclaiming idle project workspace');
      this.setRebuildRequired(project.id, true);
      return { ok: true, project };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Build event ring buffer                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Start a new build's buffer. A reopened tab replays exactly one build —
   * the current one — so the previous build's events are replaced, not
   * appended to.
   */
  resetBuildLog(id: string): void {
    this.db.raw
      .prepare('UPDATE projects SET build_log_json = ? WHERE id = ?')
      .run(JSON.stringify([]), id);
  }

  /** Append one event, keeping at most the most recent BUILD_LOG_LIMIT. */
  appendBuildEvent(id: string, event: BuildEvent): void {
    const project = this.getProject(id);
    if (!project) {
      return;
    }
    const log = [...project.buildLog, event].slice(-BUILD_LOG_LIMIT);
    this.db.raw
      .prepare('UPDATE projects SET build_log_json = ? WHERE id = ?')
      .run(JSON.stringify(log), id);
  }

  /* ------------------------------------------------------------------ */
  /* Connected hosts                                                     */
  /* ------------------------------------------------------------------ */

  /** Every host this user has connected, never with the credential. */
  listConnectedHosts(userId: number): ConnectedHost[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM connected_hosts WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as ConnectedHostRow[];
    const byHost = new Map<string, ConnectedHost>();
    for (const row of rows.map(toConnectedHost)) {
      const prior = byHost.get(row.host);
      // A user-supplied token is the visible/preferred record; the sign-in
      // credential remains a fallback and is never allowed to overwrite it.
      if (!prior || (prior.credentialKind === 'oauth' && row.credentialKind === 'token')) {
        byHost.set(row.host, row);
      }
    }
    return [...byHost.values()];
  }

  /**
   * Store (or replace) a personal access token for a host.
   *
   * Encrypted before it touches the database: the plaintext exists in this
   * process and nowhere else, and the unique (user, host, kind) key makes a
   * repeat submission a replacement rather than a second row.
   */
  upsertConnectedHostToken(userId: number, host: string, token: string): ConnectedHost {
    const normalized = (host || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('connected host requires a host');
    }
    if (!token) {
      throw new Error('connected host requires a token');
    }
    const now = new Date().toISOString();
    const encrypted = this.keyRing.encrypt(token);
    this.db.raw
      .prepare(
        `INSERT INTO connected_hosts (
          id, user_id, host, kind, identity_id, credential_encrypted,
          scopes_json, expires_at, last_used_at, forge_kind, credential_kind,
          validation_status, credential_revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'token', NULL, ?, NULL, NULL, NULL, NULL, 'token', 'unvalidated', 1, ?, ?)
        ON CONFLICT(user_id, host, kind) DO UPDATE SET
          credential_encrypted = excluded.credential_encrypted,
          credential_kind = excluded.credential_kind,
          forge_kind = NULL, scopes_json = NULL, expires_at = NULL,
          last_validated_at = NULL, validation_status = 'unvalidated', validation_error_code = NULL,
          validation_error_message = NULL,
          credential_revision = COALESCE(connected_hosts.credential_revision, 0) + 1,
          updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), userId, normalized, encrypted, now, now);
    const row = this.db.raw
      .prepare('SELECT * FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
      .get(userId, normalized, 'token') as ConnectedHostRow;
    return toConnectedHost(row);
  }

  /** GitHub sign-in fallback, kept separate so it never replaces an owner's PAT. */
  upsertConnectedHostOAuth(userId: number, host: string, token: string): ConnectedHost {
    const normalized = (host || '').trim().toLowerCase();
    if (!normalized || !token) throw new Error('connected host requires a host and credential');
    const now = new Date().toISOString();
    const encrypted = this.keyRing.encrypt(token);
    this.db.raw.prepare(`INSERT INTO connected_hosts (
      id, user_id, host, kind, identity_id, credential_encrypted,
      scopes_json, expires_at, last_used_at, forge_kind, credential_kind,
      validation_status, credential_revision, created_at, updated_at
    ) VALUES (?, ?, ?, 'oauth', NULL, ?, NULL, NULL, NULL, 'github', 'oauth', 'valid', 1, ?, ?)
    ON CONFLICT(user_id, host, kind) DO UPDATE SET credential_encrypted = excluded.credential_encrypted,
      forge_kind = 'github', credential_kind = 'oauth', validation_status = 'valid',
      scopes_json = NULL, expires_at = NULL, last_validated_at = NULL,
      validation_error_code = NULL, validation_error_message = NULL,
      credential_revision = COALESCE(connected_hosts.credential_revision, 0) + 1,
      updated_at = excluded.updated_at`).run(randomUUID(), userId, normalized, encrypted, now, now);
    const row = this.db.raw.prepare('SELECT * FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
      .get(userId, normalized, 'oauth') as ConnectedHostRow;
    return toConnectedHost(row);
  }

  /** Store only safe validation metadata; token material never leaves credentialFor. */
  setConnectedHostValidation(input: { userId: number; host: string; kind?: 'token' | 'oauth'; expectedCredentialRevision?: number; forgeKind?: string | null; status: ConnectedHostValidationStatus; errorCode?: string | null; errorMessage?: string | null; scopes?: string[]; expiresAt?: string | null }): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw.prepare(`UPDATE connected_hosts SET
      forge_kind = CASE WHEN ? THEN ? ELSE forge_kind END,
      validation_status = ?, last_validated_at = ?, validation_error_code = ?, validation_error_message = ?,
      scopes_json = CASE WHEN ? THEN ? ELSE scopes_json END,
      expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
      updated_at = ? WHERE user_id = ? AND host = ? AND kind = ?
      AND (? = 0 OR credential_revision = ?)`)
      .run(input.forgeKind !== undefined ? 1 : 0, input.forgeKind ?? null, input.status, now, input.errorCode ?? null, input.errorMessage ?? null,
        input.scopes !== undefined ? 1 : 0, input.scopes === undefined ? null : JSON.stringify(input.scopes),
        input.expiresAt !== undefined ? 1 : 0, input.expiresAt ?? null,
        now, input.userId, input.host.trim().toLowerCase(), input.kind ?? 'token',
        input.expectedCredentialRevision === undefined ? 0 : 1,
        input.expectedCredentialRevision ?? -1);
    return result.changes > 0;
  }

  deleteConnectedHost(userId: number, host: string, kind = 'token'): boolean {
    const result = kind === 'token'
      ? this.db.raw.prepare('DELETE FROM connected_hosts WHERE user_id = ? AND host = ?')
        .run(userId, host.trim().toLowerCase())
      : this.db.raw.prepare('DELETE FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
        .run(userId, host.trim().toLowerCase(), kind);
    return result.changes > 0;
  }

  /**
   * The plaintext credential for clone and push, or null when none is stored.
   *
   * The only method that decrypts: credentials exist to be used in exactly
   * two places (clone, preservation push), and both ask for one host's token
   * at the moment they need it.
   */
  credentialKindFor(userId: number, host: string): 'token' | 'oauth' | null {
    const rows = this.db.raw.prepare(`SELECT kind FROM connected_hosts
      WHERE user_id = ? AND host = ? AND credential_encrypted IS NOT NULL
      ORDER BY CASE kind WHEN 'token' THEN 0 WHEN 'oauth' THEN 1 ELSE 2 END
      LIMIT 1`).get(userId, host.trim().toLowerCase()) as { kind: string } | undefined;
    return rows?.kind === 'token' || rows?.kind === 'oauth' ? rows.kind : null;
  }

  credentialRecordFor(userId: number, host: string, kind = 'token'): ConnectedCredential | null {
    type CredentialRow = {
      credential_encrypted: string | null;
      validation_status: string | null;
      expires_at: string | null;
      credential_revision: number;
    };
    const normalized = host.trim().toLowerCase();
    let row = this.db.raw
      .prepare(
        'SELECT credential_encrypted, validation_status, expires_at, credential_revision FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .get(userId, normalized, kind) as CredentialRow | undefined;
    let usedKind = kind;
    // A present manual credential is the owner's explicit choice. If it is
    // known bad, do not silently substitute the sign-in credential.
    if (row && !usableCredentialRow(row)) {
      if (credentialExpired(row.expires_at)) this.markCredentialExpired(userId, normalized, kind, row.credential_revision);
      return null;
    }
    if (!row?.credential_encrypted && kind === 'token') {
      row = this.db.raw.prepare(
        'SELECT credential_encrypted, validation_status, expires_at, credential_revision FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?',
      ).get(userId, normalized, 'oauth') as CredentialRow | undefined;
      usedKind = 'oauth';
    }
    if (!row?.credential_encrypted || !usableCredentialRow(row)) {
      if (row && credentialExpired(row.expires_at)) this.markCredentialExpired(userId, normalized, usedKind, row.credential_revision);
      return null;
    }
    const token = this.keyRing.decrypt(row.credential_encrypted);
    this.db.raw
      .prepare(
        'UPDATE connected_hosts SET last_used_at = ? WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .run(new Date().toISOString(), userId, normalized, usedKind);
    return {
      token,
      kind: usedKind as 'token' | 'oauth',
      revision: row.credential_revision,
    };
  }

  credentialFor(userId: number, host: string, kind = 'token'): string | null {
    return this.credentialRecordFor(userId, host, kind)?.token || null;
  }

  private markCredentialExpired(userId: number, host: string, kind: string, revision: number): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`UPDATE connected_hosts SET validation_status = 'invalid',
      last_validated_at = ?, validation_error_code = 'credential_expired',
      validation_error_message = 'The stored credential has expired', updated_at = ?
      WHERE user_id = ? AND host = ? AND kind = ? AND credential_revision = ?`)
      .run(now, now, userId, host, kind, revision);
  }

  /* ------------------------------------------------------------------ */
  /* Git identities and storage reporting                                */
  /* ------------------------------------------------------------------ */

  upsertGitIdentity(input: { userId: number; projectId?: string | null; name: string; email: string }): GitIdentity {
    if (!input.name.trim() || !input.email.trim()) throw new Error('git identity requires a name and email');
    if (input.projectId && !this.getProjectForUser(input.projectId, input.userId)) throw new Error('project not found');
    const now = new Date().toISOString(); const projectId = input.projectId ?? null;
    const existing = this.db.raw.prepare('SELECT id FROM git_identities WHERE user_id = ? AND project_id IS ?').get(input.userId, projectId) as { id: string } | undefined;
    if (existing) this.db.raw.prepare('UPDATE git_identities SET name = ?, email = ?, updated_at = ? WHERE id = ?').run(input.name.trim(), input.email.trim(), now, existing.id);
    else this.db.raw.prepare('INSERT INTO git_identities (id, user_id, project_id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), input.userId, projectId, input.name.trim(), input.email.trim(), now, now);
    return this.getGitIdentity(input.userId, projectId) as GitIdentity;
  }

  getGitIdentity(userId: number, projectId: string | null = null): GitIdentity | null {
    const row = this.db.raw.prepare('SELECT * FROM git_identities WHERE user_id = ? AND project_id IS ?').get(userId, projectId) as GitIdentityRow | undefined;
    return row ? toGitIdentity(row) : null;
  }

  /** Project override, then global override, then caller-provided provider default. */
  resolveGitIdentity(input: { userId: number; projectId?: string | null; providerDefault?: { name: string; email: string } | null }): { identity: GitIdentity | { name: string; email: string; source: 'provider' } | null; source: 'project' | 'global' | 'provider' | 'incomplete' } {
    const project = input.projectId ? this.getGitIdentity(input.userId, input.projectId) : null;
    if (project) return { identity: project, source: 'project' };
    const global = this.getGitIdentity(input.userId);
    if (global) return { identity: global, source: 'global' };
    if (input.providerDefault?.name.trim() && input.providerDefault.email.trim()) return { identity: { ...input.providerDefault, source: 'provider' }, source: 'provider' };
    return { identity: null, source: 'incomplete' };
  }

  recordStorageUsageSnapshot(input: { userId?: number | null; totalBytes: number; breakdown: StorageUsageBreakdown; errors?: string[]; freeBytes?: number | null }): StorageUsageSnapshot {
    if (!Number.isFinite(input.totalBytes) || input.totalBytes < 0) throw new Error('storage total must be a non-negative number');
    return immediateTransaction(this.db.raw, () => {
      const id = randomUUID(); const now = new Date().toISOString(); const userId = input.userId ?? null;
      this.db.raw.prepare('INSERT INTO storage_usage_snapshots (id, user_id, total_bytes, breakdown_json, errors_json, free_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, Math.max(0, Math.floor(input.totalBytes)), JSON.stringify(input.breakdown), JSON.stringify(input.errors ?? []), input.freeBytes ?? null, now);
      // Refresh is user-triggerable. Retain useful history without allowing a
      // caller to grow the application database indefinitely.
      this.db.raw.prepare(`DELETE FROM storage_usage_snapshots
        WHERE user_id IS ? AND rowid NOT IN (
          SELECT rowid FROM storage_usage_snapshots
          WHERE user_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 100
        )`).run(userId, userId);
      return this.getStorageUsageSnapshot(id) as StorageUsageSnapshot;
    });
  }

  getStorageUsageSnapshot(id: string): StorageUsageSnapshot | null {
    const row = this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE id = ?').get(id) as StorageUsageSnapshotRow | undefined;
    return row ? toStorageUsageSnapshot(row) : null;
  }

  latestStorageUsageSnapshot(userId?: number | null): StorageUsageSnapshot | null {
    const row = userId == null ? this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get() : this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId);
    return row ? toStorageUsageSnapshot(row as StorageUsageSnapshotRow) : null;
  }

  listStorageUsageSnapshots(userId?: number | null, limit = 50): StorageUsageSnapshot[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = userId == null
      ? this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(safeLimit)
      : this.db.raw.prepare('SELECT * FROM storage_usage_snapshots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, safeLimit);
    return (rows as StorageUsageSnapshotRow[]).map(toStorageUsageSnapshot);
  }

  usageWarnUserBytes(): number | null { return nonNegativeIntSetting(this.db.getSetting(SETTING_USAGE_WARN_USER)); }
  usageWarnAdminBytes(): number | null { return nonNegativeIntSetting(this.db.getSetting(SETTING_USAGE_WARN_ADMIN)); }
  setUsageWarnUserBytes(bytes: number | null): void { setOptionalByteSetting(this.db, SETTING_USAGE_WARN_USER, bytes); }
  setUsageWarnAdminBytes(bytes: number | null): void { setOptionalByteSetting(this.db, SETTING_USAGE_WARN_ADMIN, bytes); }

  /* ------------------------------------------------------------------ */
  /* Policy settings (admin-editable app_settings, with defaults)        */
  /* ------------------------------------------------------------------ */

  runLimitPerUser(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_RUN_LIMIT), DEFAULT_RUN_LIMIT_PER_USER);
  }

  idleStopMinutes(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_IDLE_STOP), DEFAULT_IDLE_STOP_MINUTES);
  }

  idleReclaimMinutes(): number {
    return positiveIntSetting(this.db.getSetting(SETTING_IDLE_RECLAIM), DEFAULT_IDLE_RECLAIM_MINUTES);
  }
}

function positiveIntSetting(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntSetting(raw: string | null): number | null {
  if (raw === null || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function setOptionalByteSetting(db: AppDatabase, key: string, bytes: number | null): void { if (bytes == null) db.deleteSetting(key); else if (Number.isFinite(bytes) && bytes >= 0) db.setSetting(key, String(Math.floor(bytes))); else throw new Error('usage warning must be a non-negative number'); }

function credentialExpired(value: string | null): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function usableCredentialRow(row: {
  credential_encrypted: string | null;
  validation_status: string | null;
  expires_at: string | null;
}): boolean {
  return Boolean(row.credential_encrypted)
    && row.validation_status !== 'invalid'
    && !credentialExpired(row.expires_at);
}

interface ProjectRow {
  id: string;
  owner_user_id: number;
  name: string;
  repo_url: string | null;
  repo_host: string | null;
  target_id: string | null;
  execution_kind: string | null;
  tier_id: string | null;
  state: string;
  state_detail: string | null;
  container_json: string | null;
  rebuild_required: number | null;
  build_log_json: string | null;
  last_activity_at: string;
  last_preserved_commit: string | null;
  last_preserved_branch: string | null;
  composition_revision: string | null;
  applied_composition_revision: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    repoUrl: row.repo_url,
    repoHost: row.repo_host,
    targetId: row.target_id,
    executionKind: row.execution_kind === 'host' ? 'host' : 'container',
    tierId: row.tier_id,
    state: row.state as ProjectState,
    stateDetail: row.state_detail,
    container: parseJson<ProjectContainerInfo | null>(row.container_json, null),
    rebuildRequired: Boolean(row.rebuild_required),
    buildLog: parseJson<BuildEvent[]>(row.build_log_json, []),
    lastActivityAt: row.last_activity_at,
    lastPreservedCommit: row.last_preserved_commit,
    lastPreservedBranch: row.last_preserved_branch,
    compositionRevision: row.composition_revision,
    appliedCompositionRevision: row.applied_composition_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ConnectedHostRow {
  id: string;
  user_id: number;
  host: string;
  kind: string;
  forge_kind: string | null;
  credential_kind: string | null;
  validation_status: string | null;
  last_validated_at: string | null;
  validation_error_code: string | null;
  validation_error_message: string | null;
  credential_revision: number | null;
  credential_encrypted: string | null;
  scopes_json: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function toConnectedHost(row: ConnectedHostRow): ConnectedHost {
  return {
    id: row.id,
    userId: row.user_id,
    host: row.host,
    kind: row.kind,
    forgeKind: row.forge_kind,
    credentialKind: row.credential_kind as ConnectedHost['credentialKind'],
    validationStatus: row.validation_status as ConnectedHostValidationStatus | null,
    lastValidatedAt: row.last_validated_at,
    validationErrorCode: row.validation_error_code,
    validationErrorMessage: row.validation_error_message,
    credentialRevision: row.credential_revision ?? 0,
    scopes: parseJson<string[]>(row.scopes_json, []),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CompositionRow {
  id: string; project_id: string; user_id: number; catalog_version: string; detected_json: string;
  chosen_json: string; source_oid: string | null; source_ref: string | null; forge_kind: string | null;
  forge_host: string | null; created_at: string;
}
function toComposition(row: CompositionRow): ProjectComposition {
  return { id: row.id, projectId: row.project_id, userId: row.user_id, catalogVersion: row.catalog_version,
    detected: parseJson(row.detected_json, {}), chosen: parseJson(row.chosen_json, {}), sourceOid: row.source_oid,
    sourceRef: row.source_ref, forgeKind: row.forge_kind, forgeHost: row.forge_host, createdAt: row.created_at };
}

interface CompositionInstallationRow {
  id: string; composition_id: string; item_id: string; status: string; attempts: number; installed_version: string | null;
  error_code: string | null; error_message: string | null; created_at: string; updated_at: string;
}
function toCompositionInstallation(row: CompositionInstallationRow): CompositionInstallation {
  return { id: row.id, compositionId: row.composition_id, itemId: row.item_id, status: row.status as CompositionInstallationStatus,
    attempts: row.attempts, installedVersion: row.installed_version, errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

interface GitIdentityRow { id: string; user_id: number; project_id: string | null; name: string; email: string; created_at: string; updated_at: string; }
function toGitIdentity(row: GitIdentityRow): GitIdentity { return { id: row.id, userId: row.user_id, projectId: row.project_id, name: row.name, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at }; }

interface StorageUsageSnapshotRow { id: string; user_id: number | null; total_bytes: number; breakdown_json: string; errors_json: string | null; free_bytes: number | null; created_at: string; }
function toStorageUsageSnapshot(row: StorageUsageSnapshotRow): StorageUsageSnapshot { return { id: row.id, userId: row.user_id, totalBytes: row.total_bytes, breakdown: parseJson<StorageUsageBreakdown>(row.breakdown_json, {}), errors: parseJson<string[]>(row.errors_json, []), freeBytes: row.free_bytes, createdAt: row.created_at }; }

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
