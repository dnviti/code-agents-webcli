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
}

/** One buffered build event, persisted so a reopened tab rejoins the build. */
export interface BuildEvent {
  t: 'step' | 'progress' | 'state' | 'error' | 'preserve';
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
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  ownerUserId: number;
  name: string;
  repoUrl?: string | null;
  repoHost?: string | null;
  targetId?: string | null;
  tierId?: string | null;
}

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
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How many build events a project row keeps; older ones drop off the front. */
const BUILD_LOG_LIMIT = 200;

const SETTING_RUN_LIMIT = 'deploy.runLimitPerUser';
const SETTING_IDLE_STOP = 'deploy.idleStopMinutes';
const SETTING_IDLE_RECLAIM = 'deploy.idleReclaimMinutes';

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
          id, owner_user_id, name, repo_url, repo_host, target_id, tier_id,
          state, state_detail, container_json, rebuild_required, build_log_json,
          last_activity_at, last_preserved_commit, last_preserved_branch, composition_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', 'created, not built yet', NULL, 0, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.ownerUserId,
        input.name,
        input.repoUrl ?? null,
        input.repoHost ?? null,
        input.targetId ?? null,
        input.tierId ?? null,
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
      this.db.raw
        .prepare(
          `UPDATE projects SET state = ?, state_detail = NULL, last_activity_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.toState, now, now, input.projectId);
      return { ok: true };
    });
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
  }): LifecycleClaim {
    return immediateTransaction(this.db.raw, (): LifecycleClaim => {
      const project = this.getProjectForUser(input.projectId, input.ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running') return { ok: false, reason: 'invalid_state' };
      if (input.idleBefore && project.lastActivityAt > input.idleBefore.toISOString()) {
        return { ok: false, reason: 'not_idle' };
      }
      if (this.projectHasActiveSessions(project.id)) return { ok: false, reason: 'active_work' };
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
    return rows.map(toConnectedHost);
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
          scopes_json, expires_at, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'token', NULL, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(user_id, host, kind) DO UPDATE SET
          credential_encrypted = excluded.credential_encrypted,
          updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), userId, normalized, encrypted, now, now);
    const row = this.db.raw
      .prepare('SELECT * FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
      .get(userId, normalized, 'token') as ConnectedHostRow;
    return toConnectedHost(row);
  }

  deleteConnectedHost(userId: number, host: string, kind = 'token'): boolean {
    const result = this.db.raw
      .prepare('DELETE FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?')
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
  credentialFor(userId: number, host: string, kind = 'token'): string | null {
    const row = this.db.raw
      .prepare(
        'SELECT credential_encrypted FROM connected_hosts WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .get(userId, host.trim().toLowerCase(), kind) as
      | { credential_encrypted: string | null }
      | undefined;
    if (!row?.credential_encrypted) {
      return null;
    }
    const token = this.keyRing.decrypt(row.credential_encrypted);
    this.db.raw
      .prepare(
        'UPDATE connected_hosts SET last_used_at = ? WHERE user_id = ? AND host = ? AND kind = ?',
      )
      .run(new Date().toISOString(), userId, host.trim().toLowerCase(), kind);
    return token;
  }

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

interface ProjectRow {
  id: string;
  owner_user_id: number;
  name: string;
  repo_url: string | null;
  repo_host: string | null;
  target_id: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ConnectedHostRow {
  id: string;
  user_id: number;
  host: string;
  kind: string;
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
    scopes: parseJson<string[]>(row.scopes_json, []),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
