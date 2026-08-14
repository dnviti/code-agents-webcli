/** Partial class: session leases, atomic lifecycle claims, and the run-limit start. */

import { randomUUID } from 'node:crypto';
import type {
  LifecycleClaim,
  ProjectState,
  SessionLeaseAttempt,
  StartAttempt,
} from './types.js';
import { immediateTransaction } from './immediate-transaction.js';
import { ProjectStoreReporting } from './reporting.js';

export abstract class ProjectStoreLifecycle extends ProjectStoreReporting {
  /** Whether this process holds any atomic admission lease for the project. */
  projectHasActiveSessions(projectId: string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT 1 AS x WHERE EXISTS(
           SELECT 1 FROM project_session_leases WHERE project_id = ?
         )`,
      )
      .get(projectId) as { x: number } | undefined;
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
}
