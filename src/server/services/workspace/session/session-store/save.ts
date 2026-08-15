import type { SessionRecord, SessionStorageScope } from '../../../../types.js';
import { cloneSessionMap, scopeKey, toIsoString } from './helpers.js';
import { SessionStoreLoad } from './load.js';

/**
 * Persisting sessions: the coordinator-wide transaction-orchestrating save and
 * the single-store write path, plus the active-flag write-throughs they share.
 */
export abstract class SessionStoreSave extends SessionStoreLoad {
  async saveSessions(
    sessions: Map<string, SessionRecord>,
    options: { pruneMissing?: boolean } = {},
  ): Promise<boolean> {
    // Legacy callers still use one installation database. Once callers attach
    // immutable scopes to records, this same method becomes a coordinator: one
    // transaction/prune per workspace+owner instead of a dangerous global
    // delete followed by a set of unrelated writes.
    if (
      !this.ownerKey
      && this.workspaceCoordinator
    ) {
      const input = this.workspaceCoordinator ? cloneSessionMap(sessions) : sessions;
      const persist = async (): Promise<boolean> => {
        const grouped = new Map<string, { scope: SessionStorageScope; sessions: Map<string, SessionRecord> }>();
        const legacy = new Map<string, SessionRecord>();
        // Unavailable workspace rows are intentionally omitted from the upsert,
        // but their omission is not a deletion signal. Remember every affected
        // scope so neither a mixed save nor the "scope disappeared" pass can
        // prune the authoritative row while a lifecycle/storage gate is live.
        const withheldScopeKeys = new Set<string>();
        for (const [id, session] of input) {
          // A blocked row remains visible read-only while its source stays
          // authoritative. It must neither be written globally nor materialised
          // as a partial workspace record by an unrelated autosave. Lifecycle
          // callers that temporarily gate an otherwise healthy workspace provide
          // an explicit pre-gate snapshot for their final flush.
          if (session.persistenceUnavailable) {
            if (session.storageScope) withheldScopeKeys.add(scopeKey(session.storageScope));
            continue;
          }
          if (!session.storageScope) {
            legacy.set(id, session);
            continue;
          }
          const key = scopeKey(session.storageScope);
          let group = grouped.get(key);
          if (!group) {
            group = { scope: session.storageScope, sessions: new Map() };
            grouped.set(key, group);
          }
          group.sessions.set(id, session);
        }
        // Once scoped records are in play, deliberately do not create/update
        // installation-global rows for the unscoped remainder. Refuse the whole
        // save before touching any workspace so a caller's in-memory rollback
        // cannot disagree with an archive which already committed.
        if (legacy.size > 0) {
          console.error('Refusing to persist unscoped sessions beside workspace-local state');
          return false;
        }

        const operations: Array<{
          key: string;
          store: SessionStoreSave;
          next: Map<string, SessionRecord>;
          pruneMissing: boolean;
          previous?: Map<string, SessionRecord>;
        }> = [];
        let failedKey: string | null = null;
        try {
          for (const [key, group] of grouped) {
            failedKey = key;
            if (this.suspendedWorkspaceScopes.has(key)) {
              throw new Error(`workspace save refused while ${key} is suspended`);
            }
            operations.push({
              key,
              store: this.openWorkspace(group.scope),
              next: group.sessions,
              pruneMissing: !this.workspacePublicationHolds.has(key)
                && !withheldScopeKeys.has(key),
            });
          }
          // A previously opened scope absent from the current live map means all
          // its sessions were removed; prune only that owner namespace.
          for (const [key, store] of this.workspaceStores) {
            if (
              !grouped.has(key)
              && !withheldScopeKeys.has(key)
              && this.publishedWorkspaceScopes.has(key)
            ) {
              operations.push({ key, store, next: new Map(), pruneMissing: true });
            }
          }

          // SQLite cannot give us one transaction over unrelated filesystems.
          // Snapshot every owner-scoped state before the first commit, then use
          // compensating transactions if any later workspace fails.
          for (const operation of operations) {
            failedKey = operation.key;
            operation.previous = await operation.store.loadSessions({ preserveActive: true });
          }
          for (const operation of operations) {
            failedKey = operation.key;
            if (!(await operation.store.saveSessions(operation.next, {
              pruneMissing: operation.pruneMissing,
            }))) {
              throw new Error(`workspace save failed for ${operation.key}`);
            }
          }
          // A successful write publishes new workspace state too.  From this
          // point a later complete live map which omits the scope is an explicit
          // deletion rather than a loader race.
          for (const key of grouped.keys()) {
            if (!this.workspacePublicationHolds.has(key) && !withheldScopeKeys.has(key)) {
              this.publishedWorkspaceScopes.add(key);
            }
          }
          for (const operation of operations) this.workspaceSaveErrors.delete(operation.key);
          failedKey = null;
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (failedKey) this.workspaceSaveErrors.set(failedKey, detail);
          let rolledBack = true;
          for (const operation of operations) {
            if (!operation.previous) continue;
            // `previous` is a complete snapshot of this owner namespace, so an
            // exact rollback is safe even while ordinary partial saves are held.
            const restored = await operation.store.saveSessions(operation.previous, {
              pruneMissing: true,
            });
            if (!restored) {
              this.workspaceSaveErrors.set(
                operation.key,
                `rollback failed after workspace save error: ${detail}`,
              );
            }
            rolledBack = restored && rolledBack;
          }
          if (!rolledBack) {
            console.error('Failed to restore every workspace after a cross-workspace save error');
          }
          console.error('Failed to save workspace session state:', error);
          return false;
        }
      };
      return this.workspaceCoordinator
        ? this.enqueueWorkspaceMutation(persist)
        : persist();
    }
    try {
      if (!this.ownerKey && this.scopedGlobalStore
        && Array.from(sessions.values()).some((session) => !session.storageScope)) {
        console.error('Refusing to persist a session without an immutable workspace scope');
        return false;
      }
      const db = this.database.raw;
      const ownerColumn = this.ownerKey ? 'owner_key,' : '';
      const ownerValue = this.ownerKey ? '@owner_key,' : '';
      const envelopeColumn = this.ownerKey ? 'operational_envelope,' : '';
      const envelopeValue = this.ownerKey ? '@operational_envelope,' : '';
      const scopeColumns = this.ownerKey ? '' : 'storage_workspace_root, storage_owner_key,';
      const scopeValues = this.ownerKey ? '' : '@storage_workspace_root, @storage_owner_key,';
      const insert = db.prepare(`
        INSERT OR REPLACE INTO runtime_sessions (
          ${ownerColumn}
          ${envelopeColumn}
          ${scopeColumns}
          chat_draft_json,
          id,
          owner_user_id,
          name,
          created_at,
          last_activity,
          active,
          agent,
          last_agent,
          runtime_label,
          terminal_options_json,
          working_dir,
          output_buffer_json,
          session_start_time,
          session_usage_json,
          max_buffer_size,
          last_accessed,
          surface,
          native_chat_session_id,
          owner_session_id,
          chat_bypass_permissions,
          chat_model_override,
          chat_model_pinned,
          chat_effort_override,
          chat_plan_mode,
          custom_name,
          tab_open,
          tab_order,
          project_id,
          project_working_dir_kind,
          rollback_recovery_pending
        )
        VALUES (
          ${ownerValue}
          ${envelopeValue}
          ${scopeValues}
          @chat_draft_json,
          @id,
          @owner_user_id,
          @name,
          @created_at,
          @last_activity,
          @active,
          @agent,
          @last_agent,
          @runtime_label,
          @terminal_options_json,
          @working_dir,
          @output_buffer_json,
          @session_start_time,
          @session_usage_json,
          @max_buffer_size,
          @last_accessed,
          @surface,
          @native_chat_session_id,
          @owner_session_id,
          @chat_bypass_permissions,
          @chat_model_override,
          @chat_model_pinned,
          @chat_effort_override,
          @chat_plan_mode,
          @custom_name,
          @tab_open,
          @tab_order,
          @project_id,
          @project_working_dir_kind,
          @rollback_recovery_pending
        )
      `);

      // Upsert the current rows, then delete only the ids that are genuinely
      // gone. The previous DELETE-everything-then-reinsert meant any save with
      // a partial or empty in-memory map destroyed every other persisted
      // session.
      const deleteMissing = db.prepare(this.ownerKey
        ? 'DELETE FROM runtime_sessions WHERE owner_key = ? AND id NOT IN (SELECT value FROM json_each(?))'
        : this.scopedGlobalStore
          ? `DELETE FROM runtime_sessions
               WHERE storage_workspace_root IS NOT NULL
                 AND storage_owner_key IS NOT NULL
                 AND id NOT IN (SELECT value FROM json_each(?))`
          : 'DELETE FROM runtime_sessions WHERE id NOT IN (SELECT value FROM json_each(?))');

      // A scoped global store is the sole metadata authority. Until one full
      // read has succeeded, an empty or partial caller map cannot prove that a
      // missing row was deleted rather than simply never restored. Upserts are
      // still safe before that point; inferred deletion is not.
      const mayPruneGlobal = !this.scopedGlobalStore
        || (this.hasLoaded && options.pruneMissing !== false);

      const replaceAll = db.transaction((sessionRows: Array<Record<string, unknown>>) => {
        for (const row of sessionRows) {
          insert.run(row);
        }
        if (this.ownerKey && this.hasLoaded && options.pruneMissing !== false) {
          deleteMissing.run(this.ownerKey, JSON.stringify(sessionRows.map((row) => row.id)));
        } else if (!this.ownerKey && mayPruneGlobal) {
          deleteMissing.run(JSON.stringify(sessionRows.map((row) => row.id)));
        }
      });

      const rows = Array.from(sessions.values()).map((session) => {
        const row = {
        ...(this.ownerKey ? { owner_key: this.ownerKey } : {}),
        ...(!this.ownerKey ? {
          storage_workspace_root: session.storageScope?.workspaceRoot ?? null,
          storage_owner_key: session.storageScope?.ownerKey ?? null,
        } : {}),
        chat_draft_json: session.chatDraft ? JSON.stringify(session.chatDraft) : null,
        id: session.id,
        owner_user_id: session.ownerUserId,
        name: session.name || 'Unnamed Session',
        created_at: toIsoString(session.created),
        last_activity: toIsoString(session.lastActivity),
        // The database is the run-limit authority. Keeping this in step with
        // the runtime record also means an ordinary autosave cannot erase a
        // live flag written by `setActive` between two ticks. (#168)
        active: session.active ? 1 : 0,
        agent: null,
        last_agent: session.lastAgent,
        runtime_label: session.runtimeLabel,
        terminal_options_json: session.terminalOptions
          ? JSON.stringify(session.terminalOptions)
          : null,
        working_dir: session.workingDir,
        // Terminal history is project-local in the transcript store. A bound
        // compatibility store retains its historic buffer field; app.sqlite
        // keeps no duplicate project output payload.
        output_buffer_json: this.scopedGlobalStore
          ? '[]'
          : JSON.stringify((session.outputBuffer || []).slice(-1000)),
        session_start_time: session.sessionStartTime
          ? toIsoString(session.sessionStartTime)
          : null,
        session_usage_json: JSON.stringify(
          session.sessionUsage || {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalCost: 0,
            models: {},
          },
        ),
        max_buffer_size: session.maxBufferSize || 1000,
        last_accessed: session.lastAccessed || Date.now(),
        // Persisted so a restart does not show an empty terminal as the whole
        // history of what was a conversation.
        surface: session.surface || null,
        // Without this a restart can still show the conversation but not
        // continue it: the agent would come back with no memory of a transcript
        // the user is looking at.
        native_chat_session_id: session.nativeChatSessionId || null,
        // Which conversation owns this shell, so a restart can tell a session
        // the user can reach from one that nothing on screen refers to any more.
        owner_session_id: session.ownerSessionId || null,
        // The approval mode this conversation was granted. Persisted so a
        // restart brings it back rather than quietly dropping to manual — and so
        // the header can state the mode of a conversation with nothing running.
        //
        // Three values, not two, and the third is what stops the rule in
        // shared/user-preferences.ts from widening a conversation behind the
        // user's back: 0 means "this conversation was granted approvals", which
        // is a decision to keep, while NULL means "nothing was ever granted",
        // which is every row written before the column existed.
        chat_bypass_permissions:
          session.chatBypassPermissions === true
            ? 1
            : session.chatBypassPermissions === false
              ? 0
              : null,
        // The conversation-scoped model override, if the user has set one.
        // Persisted so a restart still prefers it over the profile default the
        // next time a session starts for this conversation.
        chat_model_override: session.chatModelOverride || null,
        // The model this conversation is fixed to, from what its last launch
        // actually used. This is the half that has to survive a restart or the
        // guarantee is empty: a server restart is precisely the moment every
        // conversation gets relaunched, and a pin held only in memory would be
        // gone exactly when it is needed (#135).
        //
        // An empty string, not a null, for "launched with no flag at all": null
        // is reserved for "nothing recorded", which is what a row written before
        // this column existed carries and which still reads as the profile.
        chat_model_pinned:
          session.chatModelPinned === undefined ? null : session.chatModelPinned ?? '',
        // The conversation-scoped effort level, if one was chosen. Persisted for
        // the same reason and read back the same way: without it, a rejoin after
        // a server restart shows the chip at the runtime default while the
        // process it describes is still running at the level the user picked.
        chat_effort_override: session.chatEffortOverride || null,
        chat_plan_mode: session.chatPlanMode === true ? 1 : 0,
        // The label the user chose. Without this a restart brings a session back
        // under the name it was created with, which is the one thing the user
        // renamed it to get away from.
        custom_name: session.customName || null,
        // Closing a conversation is a tab operation, not deletion. Persist the
        // account-owned visibility so every device and the next server process
        // agree. NULL remains distinct from an explicit open: it marks a row
        // written before account-wide tabs existed, which lets the one-time
        // browser migration apply an old local close exactly once without a
        // stale browser later overriding a newer reopen.
        tab_open:
          session.tabOpen === true ? 1 : session.tabOpen === false ? 0 : null,
        // Null preserves the stable load order of rows written before shared
        // ordering existed. Every explicit reorder writes compact ordinals.
        tab_order: Number.isFinite(session.tabOrder) ? session.tabOrder : null,
        // The project this session was created against, if any. Project-less
        // sessions keep today's behaviour. (#168)
        project_id: session.projectId ?? null,
        // Absolute host and container paths share one string field, so this
        // discriminator is the only safe way to interpret it after restart.
        // A null remains the legacy host meaning for older rows.
        project_working_dir_kind:
          session.projectId
          && (session.projectWorkingDirKind === 'host'
            || session.projectWorkingDirKind === 'container')
            ? session.projectWorkingDirKind
            : null,
        rollback_recovery_pending: session.rollbackRecoveryPending === true ? 1 : 0,
        };
        return {
          ...row,
          ...(this.ownerKey ? {
            operational_envelope:
              this.database.sealRuntimeSessionRecord?.(row) ?? null,
          } : {}),
        };
      });

      replaceAll(rows);
      this.database.setSetting('runtime_sessions.saved_at', new Date().toISOString());
      this.database.setSetting(
        'runtime_sessions.version',
        this.ownerKey ? '3' : this.scopedGlobalStore ? '4' : '2',
      );
      this.database.markArchiveTrusted?.();
      return true;
    } catch (error) {
      console.error('Failed to save sessions:', error);
      return false;
    }
  }

  private enqueueWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.workspaceMutationTail.then(operation, operation);
    this.workspaceMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Write-through for the runtime's active flag.
   *
   * In-memory `active` is the runtime signal; the database copy is what the
   * run-limit sweep reads inside its transaction, so every start/stop/exit
   * must write through. Fire-and-forget: the WS flow never blocks on SQLite.
   * (#168)
   */
  async setActive(id: string, active: boolean, scope?: SessionStorageScope): Promise<void> {
    if (!this.ownerKey && scope && this.workspaceCoordinator) {
      const writeThrough = () => this.openWorkspace(scope).setActive(id, active);
      if (this.workspaceCoordinator) {
        await this.enqueueWorkspaceMutation(writeThrough);
      } else {
        await writeThrough();
      }
      return;
    }
    if (!this.ownerKey && this.workspaceCoordinator) {
      console.error(`Refusing to update unscoped legacy active flag for session ${id}`);
      return;
    }
    try {
      this.database.raw
        .prepare(this.ownerKey
          ? 'UPDATE runtime_sessions SET active = @active WHERE id = @id AND owner_key = @owner_key'
          : this.scopedGlobalStore
            ? `UPDATE runtime_sessions SET active = @active
                 WHERE id = @id
                   AND storage_workspace_root IS NOT NULL
                   AND storage_owner_key IS NOT NULL`
            : 'UPDATE runtime_sessions SET active = @active WHERE id = @id')
        .run(this.ownerKey
          ? { active: active ? 1 : 0, id, owner_key: this.ownerKey }
          : { active: active ? 1 : 0, id });
    } catch (error) {
      console.error(`Failed to set active flag for session ${id}:`, error);
    }
  }
}
