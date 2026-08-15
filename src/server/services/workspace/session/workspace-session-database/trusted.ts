/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this file only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import type { RuntimeSessionOperationalState } from './types.js';
import { normalizeRuntimeSessionOperationalState } from './types.js';
import { WorkspaceSessionDatabaseBase } from './base.js';
export abstract class WorkspaceSessionDatabaseTrust extends WorkspaceSessionDatabaseBase {
  sealRuntimeSessionRecord(record: RuntimeSessionOperationalState): string | null {
    if (!this.archiveTrust) return null;
    return this.archiveTrust.seal(this.runtimeSessionTrustPayload(record));
  }

  verifyRuntimeSessionRecord(
    record: RuntimeSessionOperationalState,
    envelope: string | null,
  ): boolean {
    // A bound/custom backend without installation key material cannot prove a
    // portable row's execution authority. History remains readable, but every
    // runtime/resume/approval control must fail closed just as an invalid
    // envelope does. Production supplies archiveTrust through the coordinator;
    // keeping this branch strict prevents a future composition omission from
    // silently turning a workspace-controlled SQLite row into authority.
    if (!this.archiveTrust) return false;
    if (!envelope) return false;
    try {
      const opened = this.archiveTrust.open(envelope);
      const current = this.runtimeSessionTrustPayload(record, 2);
      if (opened === current) return true;

      const normalized = normalizeRuntimeSessionOperationalState(record);
      // Version 1 predates rollback anchors, so it cannot authenticate a true
      // recovery bit. It remains a valid authority only for an ordinary row;
      // immediately replace it with v2 so the compatibility path is one-shot.
      if (
        normalized.rollback_recovery_pending !== 1
        && opened === this.runtimeSessionTrustPayload(record, 1)
      ) {
        const resealed = this.archiveTrust.seal(current);
        const updated = this.db.prepare(`UPDATE runtime_sessions
          SET operational_envelope = ?
          WHERE owner_key = ? AND id = ? AND operational_envelope = ?`)
          .run(resealed, this.ownerKey, normalized.id, envelope);
        return Number(updated.changes ?? 0) === 1;
      }
      return false;
    } catch {
      return false;
    }
  }

  private runtimeSessionTrustPayload(
    record: RuntimeSessionOperationalState,
    version: 1 | 2 = 2,
  ): string {
    const normalized = normalizeRuntimeSessionOperationalState(record);
    return JSON.stringify({
      version,
      ownerKey: this.ownerKey,
      workspaceRoot: this.workspaceRoot,
      sessionId: normalized.id,
      operational: {
        ...(version === 2 ? {
          rollbackRecoveryPending: normalized.rollback_recovery_pending,
        } : {}),
        workingDir: normalized.working_dir,
        surface: normalized.surface,
        lastAgent: normalized.last_agent,
        runtimeLabel: normalized.runtime_label,
        terminalOptionsJson: normalized.terminal_options_json,
        sessionStartTime: normalized.session_start_time,
        maxBufferSize: normalized.max_buffer_size,
        nativeChatSessionId: normalized.native_chat_session_id,
        ownerSessionId: normalized.owner_session_id,
        chatBypassPermissions: normalized.chat_bypass_permissions,
        chatModelOverride: normalized.chat_model_override,
        chatModelPinned: normalized.chat_model_pinned,
        chatEffortOverride: normalized.chat_effort_override,
        chatPlanMode: normalized.chat_plan_mode,
        projectId: normalized.project_id,
        projectWorkingDirKind: normalized.project_working_dir_kind,
      },
    });
  }

  /** Refresh installation-local ids after an authorised owner-key match. */
  rebindOwnerIdentity(ownerUserId: number, ownerLogin: string): void {
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0 || !ownerLogin) {
      throw new Error('Workspace owner identity is invalid');
    }
    const rebind = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE runtime_sessions SET owner_user_id = ? WHERE owner_key = ?',
      ).run(ownerUserId, this.ownerKey);
      this.db.prepare(
        'UPDATE usage_jobs SET user_id = ?, user_login = ? WHERE owner_key = ?',
      ).run(ownerUserId, ownerLogin, this.ownerKey);
    });
    rebind();
  }
}
