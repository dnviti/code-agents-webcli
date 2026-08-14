/** Base partial class: core project CRUD, state, build-log and run-count queries. */

import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../database.js';
import type { EncryptionKeyRing } from '../../encryption.js';
import {
  BUILD_LOG_LIMIT,
  COUNTED_STATES,
  type BuildEvent,
  type CreateProjectInput,
  type Project,
  type ProjectContainerInfo,
  type ProjectState,
  type RunningProjectInfo,
} from './types.js';
import { toProject, type ProjectRow } from './rows.js';

export abstract class ProjectStoreCore {
  protected readonly db: AppDatabase;
  protected readonly keyRing: EncryptionKeyRing;

  constructor(options: { database: AppDatabase; keyRing: EncryptionKeyRing }) {
    this.db = options.database;
    this.keyRing = options.keyRing;
  }

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
           EXISTS(
             SELECT 1 FROM project_session_leases l
             WHERE l.project_id = p.id
           ) AS has_active_work
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
}
