import path from 'node:path';
import type { SessionRecord, TerminalOptions } from '../../types.js';
import type { SessionMetadata, RuntimeSessionRow } from './types.js';
import { parseJson, parseStoredDraft } from './helpers.js';
import { SessionStoreCoordinator } from './coordinator.js';

/**
 * Reading sessions back from the backing stores: single-store and merged
 * loads, metadata, pruning, and the legacy read helpers that ride on them.
 */
export abstract class SessionStoreLoad extends SessionStoreCoordinator {
  /**
   * Compatibility-only read of installation-global session rows. Production
   * startup and workspace loading never call this method; it remains available
   * only to isolated tooling that explicitly handles the old layout.
   */
  async loadLegacySessions(ownerUserId?: number): Promise<Map<string, SessionRecord>> {
    if (this.ownerKey) {
      throw new Error('A workspace-bound SessionStore has no legacy authority');
    }
    const sessions = await this.loadOwnSessions();
    if (ownerUserId === undefined) return sessions;
    return new Map(
      Array.from(sessions).filter(([, session]) => session.ownerUserId === ownerUserId),
    );
  }

  /** Explicit name for restoring the set of workspaces the caller opened. */
  async loadOpenedSessions(): Promise<Map<string, SessionRecord>> {
    return this.loadSessions();
  }

  async loadSessions(
    options: { preserveActive?: boolean } = {},
  ): Promise<Map<string, SessionRecord>> {
    if (!this.ownerKey && this.workspaceStores.size > 0) {
      const merged = await this.loadOwnSessions(options);
      const origin = new Map<string, string>();
      for (const id of merged.keys()) origin.set(id, 'installation database');
      for (const store of this.workspaceStores.values()) {
        const scope = store.workspaceRoot && store.ownerKey
          ? `${store.workspaceRoot} (${store.ownerKey})`
          : 'workspace';
        for (const [id, session] of await store.loadOwnSessions(options)) {
          const previous = origin.get(id);
          if (previous) {
            throw new Error(`Session id collision for ${id} between ${previous} and ${scope}`);
          }
          merged.set(id, session);
          origin.set(id, scope);
        }
      }
      return merged;
    }
    return this.loadOwnSessions(options);
  }

  protected async loadOwnSessions(
    options: { preserveActive?: boolean } = {},
  ): Promise<Map<string, SessionRecord>> {
    try {
      const rows = this.database.raw
        .prepare(`
          SELECT
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
            chat_draft_json,
            custom_name,
            tab_open,
            tab_order,
            project_id,
            project_working_dir_kind,
            rollback_recovery_pending,
            ${this.ownerKey ? 'NULL AS storage_workspace_root' : 'storage_workspace_root'},
            ${this.ownerKey ? 'NULL AS storage_owner_key' : 'storage_owner_key'},
            ${this.ownerKey ? 'operational_envelope' : 'NULL AS operational_envelope'}
          FROM runtime_sessions
          ${this.ownerKey
            ? 'WHERE owner_key = ?'
            : this.scopedGlobalStore
              ? 'WHERE storage_workspace_root IS NOT NULL AND storage_owner_key IS NOT NULL'
              : ''}
          ORDER BY created_at ASC
        `)
        .all(...(this.ownerKey ? [this.ownerKey] : [])) as RuntimeSessionRow[];

      const sessions = new Map<string, SessionRecord>();
      for (const row of rows) {
        // Workspace rows are never admitted by an archive-wide marker alone:
        // a bound/custom backend without the per-record verifier fails closed.
        // The installation database is not portable input. Unscoped stores
        // remain trusted only for isolated compatibility utilities; the
        // production coordinator never restores their runtime-session rows.
        const trustedOperationalState = this.ownerKey
          ? this.database.verifyRuntimeSessionRecord?.(row, row.operational_envelope) === true
          : true;
        const globalScope = !this.ownerKey
          && typeof row.storage_workspace_root === 'string'
          && path.isAbsolute(row.storage_workspace_root)
          && typeof row.storage_owner_key === 'string'
          && /^[A-Za-z0-9._-]+$/.test(row.storage_owner_key)
          ? {
              workspaceRoot: path.resolve(row.storage_workspace_root),
              ownerKey: row.storage_owner_key,
            }
          : null;
        sessions.set(row.id, {
          id: row.id,
          rollbackRecoveryPending:
            trustedOperationalState && row.rollback_recovery_pending === 1
              ? true
              : undefined,
          ...(this.workspaceRoot && this.ownerKey
            ? { storageScope: { workspaceRoot: this.workspaceRoot, ownerKey: this.ownerKey } }
            : globalScope ? { storageScope: globalScope } : {}),
          ownerUserId: row.owner_user_id,
          name: row.name,
          created: new Date(row.created_at),
          lastActivity: new Date(row.last_activity),
          // Startup restore is intentionally inert. Compensating snapshots are
          // the sole caller allowed to retain the durable run-limit bit.
          active: options.preserveActive === true && row.active === 1,
          agent: null,
          lastAgent: trustedOperationalState ? row.last_agent : null,
          runtimeLabel: trustedOperationalState ? row.runtime_label : null,
          terminalOptions: trustedOperationalState
            ? parseJson<TerminalOptions | null>(row.terminal_options_json, null)
            : null,
          stopRequested: false,
          workingDir: trustedOperationalState
            ? row.working_dir
            : this.workspaceRoot
              ? path.resolve(this.workspaceRoot)
              : row.working_dir,
          connections: new Set(),
          outputBuffer: parseJson<string[]>(row.output_buffer_json, []),
          // Geometry is runtime state, not persisted: the next client resize
          // re-establishes it before the recorder sees any output.
          termCols: 80,
          termRows: 24,
          sessionStartTime:
            trustedOperationalState && row.session_start_time
              ? new Date(row.session_start_time)
              : null,
          sessionUsage: parseJson(row.session_usage_json, {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalCost: 0,
            models: {},
          }),
          maxBufferSize: trustedOperationalState ? row.max_buffer_size || 1000 : 1000,
          lastAccessed: row.last_accessed || Date.now(),
          surface: trustedOperationalState && row.surface === 'chat' ? 'chat' : undefined,
          nativeChatSessionId:
            trustedOperationalState ? row.native_chat_session_id || undefined : undefined,
          ownerSessionId: trustedOperationalState ? row.owner_session_id || undefined : undefined,
          // Only a stored 1 restores the bypass. A null — the value every row
          // written before this column existed carries — reads as "nothing was
          // granted", so a missing answer can never grant a standing permission.
          // A stored 0 is the conversation's own answer of "ask", which is a
          // grant like any other and outranks a preference set afterwards.
          chatBypassPermissions:
            !trustedOperationalState
              ? undefined
              : row.chat_bypass_permissions === 1
              ? true
              : row.chat_bypass_permissions === 0
                ? false
                : undefined,
          // A stored empty string never happens — the write side always writes
          // null for "no override" — but an empty string reading as "no
          // override" rather than a call to switch to nothing is the safe
          // direction regardless.
          chatModelOverride:
            trustedOperationalState ? row.chat_model_override || undefined : undefined,
          // The opposite treatment, deliberately: here an empty string is a
          // recorded fact — "this conversation launched with no model flag" —
          // and only a null means nothing was ever written down. Reading the
          // empty string as absent would let a profile configured after the
          // launch re-model a conversation that had run bare.
          chatModelPinned:
            !trustedOperationalState
              || row.chat_model_pinned === null
              || row.chat_model_pinned === undefined
              ? undefined
              : row.chat_model_pinned || null,
          // Same treatment, same reason: an empty string reads as "no level
          // chosen" rather than as an instruction to pass the runtime an empty
          // `--effort`, which every one of them would refuse.
          chatEffortOverride:
            trustedOperationalState ? row.chat_effort_override || undefined : undefined,
          chatPlanMode: trustedOperationalState && row.chat_plan_mode === 1,
          // Drafts are content, not launch authority, so an invalid operational
          // envelope does not hide them.  They are nevertheless parsed through
          // the same bounded attachment validator used for WebSocket input.
          chatDraft: parseStoredDraft(row.chat_draft_json, row.id),
          // An empty string reads as "never renamed" for the same reason: the
          // write side only ever stores a trimmed non-empty name or null.
          customName: row.custom_name || undefined,
          // Preserve the migration marker. Everywhere that renders the strip
          // treats undefined as open; only the conditional legacy-close route
          // needs to distinguish it from a tab explicitly reopened later.
          tabOpen:
            row.tab_open === 1 ? true : row.tab_open === 0 ? false : undefined,
          tabOrder: row.tab_order ?? undefined,
          // Project-less sessions keep today's behaviour. (#168)
          projectId: trustedOperationalState ? row.project_id ?? undefined : undefined,
          projectWorkingDirKind:
            !trustedOperationalState
              ? undefined
              : row.project_working_dir_kind === 'container'
              ? 'container'
              : row.project_working_dir_kind === 'host'
                ? 'host'
                : undefined,
        });
      }

      if (sessions.size > 0) {
        console.log(
          `Restored ${sessions.size} sessions from ${
            this.ownerKey ? 'workspace SQLite compatibility storage' : 'shared app SQLite'
          }`,
        );
      }

      this.hasLoaded = true;

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      // Bound compatibility stores remain fail-closed. The shared AppDatabase
      // retains the historical best-effort return contract only for unscoped
      // compatibility callers. The scoped global database is authoritative: a
      // read failure must revoke pruning and reach the composition root.
      if (this.ownerKey || this.scopedGlobalStore) {
        if (this.scopedGlobalStore) this.hasLoaded = false;
        throw error;
      }
      return new Map();
    }
  }

  async clearOldSessions(): Promise<boolean> {
    if (!this.ownerKey && this.workspaceCoordinator) {
      console.error('Refusing to clear legacy sessions from a workspace coordinator');
      return false;
    }
    try {
      this.database.raw.prepare(this.ownerKey
        ? 'DELETE FROM runtime_sessions WHERE owner_key = ?'
        : this.scopedGlobalStore
          ? 'DELETE FROM runtime_sessions WHERE storage_workspace_root IS NOT NULL AND storage_owner_key IS NOT NULL'
          : 'DELETE FROM runtime_sessions').run(...(this.ownerKey ? [this.ownerKey] : []));
      return true;
    } catch (error) {
      console.error('Failed to clear sessions:', error);
      return false;
    }
  }

  async getSessionMetadata(): Promise<SessionMetadata> {
    try {
      const row = this.database.raw
        .prepare(this.ownerKey
          ? 'SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_key = ?'
          : this.scopedGlobalStore
            ? `SELECT COUNT(*) AS count FROM runtime_sessions
                 WHERE storage_workspace_root IS NOT NULL AND storage_owner_key IS NOT NULL`
            : 'SELECT COUNT(*) AS count FROM runtime_sessions')
        .get(...(this.ownerKey ? [this.ownerKey] : [])) as { count: number };
      const savedAt = this.database.getSetting('runtime_sessions.saved_at') || undefined;
      const version = this.database.getSetting('runtime_sessions.version')
        || (this.ownerKey ? '3' : this.scopedGlobalStore ? '4' : '2');

      return {
        exists: true,
        savedAt,
        sessionCount: row.count,
        version,
      };
    } catch (error) {
      return {
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reset every active flag at boot. A restart leaves no live processes, so
   * any `active = 1` rows are stale. (#168)
   */
  async resetActiveFlags(): Promise<void> {
    if (!this.ownerKey && this.workspaceStores.size > 0) {
      await Promise.all(Array.from(this.workspaceStores.values(), (store) => store.resetActiveFlags()));
      // The installation database is an import source only once workspace
      // stores are active.  Do not keep touching its legacy session table.
      return;
    }
    if (!this.ownerKey && this.workspaceCoordinator) return;
    try {
      this.database.raw.prepare(this.ownerKey
        ? 'UPDATE runtime_sessions SET active = 0 WHERE owner_key = ?'
        : this.scopedGlobalStore
          ? `UPDATE runtime_sessions SET active = 0
               WHERE storage_workspace_root IS NOT NULL AND storage_owner_key IS NOT NULL`
          : 'UPDATE runtime_sessions SET active = 0').run(...(this.ownerKey ? [this.ownerKey] : []));
    } catch (error) {
      console.error('Failed to reset active flags:', error);
      if (this.scopedGlobalStore) {
        // Startup must not proceed as though the authoritative session table
        // was read successfully after its prerequisite reset failed.
        this.hasLoaded = false;
        throw error;
      }
    }
  }
}
