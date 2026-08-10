import path from 'node:path';
import { AppDatabase, DatabaseOptions } from './database.js';
import { AgentKind, SessionRecord, SessionStorageScope, TerminalOptions } from '../types.js';
import {
  SessionPersistenceDatabase,
  RuntimeSessionOperationalState,
  WorkspaceArchiveTrust,
  WorkspaceSessionDatabase,
} from './workspace-session-database.js';
import type { WorkspaceStorageIdentity } from './workspace-session-storage.js';
import { readDraft } from '../chat/drafts.js';
import type { ChatDraft } from '../../shared/chat-events.js';

export interface SessionMetadata {
  exists: boolean;
  savedAt?: string;
  sessionCount?: number;
  fileSize?: number;
  version?: string;
  error?: string;
}

export interface SessionStoreOptions extends DatabaseOptions {
  /** Existing installation-wide persistence. Kept for incremental rollout. */
  database?: SessionPersistenceDatabase;
  /** Production coordinator: the installation database is import-only. */
  workspaceCoordinator?: boolean;
  /** Opt in to `.cc-web/session-state.sqlite` below this checkout. */
  workspaceRoot?: string;
  /** Stable opaque account namespace for workspace-local state. */
  ownerKey?: string;
  /** One-time source used to move old app.sqlite rows safely. */
  legacyDatabase?: AppDatabase;
  legacyOwnerUserId?: number;
  archiveTrust?: WorkspaceArchiveTrust;
  /** Exact `.cc-web` inode required before the bound SQLite file is opened. */
  expectedStorageIdentity?: WorkspaceStorageIdentity;
}

interface RuntimeSessionRow extends RuntimeSessionOperationalState {
  id: string;
  rollback_recovery_pending: number | null;
  owner_user_id: number;
  name: string;
  created_at: string;
  last_activity: string;
  active: number;
  agent: AgentKind | null;
  last_agent: AgentKind | null;
  runtime_label: string | null;
  terminal_options_json: string | null;
  working_dir: string;
  output_buffer_json: string;
  session_start_time: string | null;
  session_usage_json: string;
  max_buffer_size: number;
  last_accessed: number;
  surface: string | null;
  native_chat_session_id: string | null;
  owner_session_id: string | null;
  chat_bypass_permissions: number | null;
  chat_model_override: string | null;
  chat_model_pinned: string | null;
  chat_effort_override: string | null;
  chat_plan_mode: number | null;
  chat_draft_json: string | null;
  custom_name: string | null;
  tab_open: number | null;
  tab_order: number | null;
  project_id: string | null;
  project_working_dir_kind: string | null;
  operational_envelope: string | null;
}

export class SessionStore {
  readonly database: SessionPersistenceDatabase;
  readonly storageDir: string;
  readonly dbPath: string;
  readonly workspaceRoot: string | null;
  readonly ownerKey: string | null;
  /** Stores opened through this coordinator, keyed by immutable storage scope. */
  private readonly workspaceStores = new Map<string, SessionStore>();
  /** Scopes whose checkout is being replaced; autosave must not recreate them. */
  private readonly suspendedWorkspaceScopes = new Set<string>();
  /** Recovery authority applied before constructing a replacement database handle. */
  private readonly workspaceResumeAuthorities = new Map<string, WorkspaceStorageIdentity>();
  /**
   * Archives whose complete restored state has been published to the live map.
   *
   * `SessionStore.loadSessions()` necessarily marks the bound store readable,
   * but the composition root still has asynchronous migration confirmation to
   * perform before those rows are authoritative in memory.  Keeping that
   * distinction here prevents an autosave in that interval from interpreting
   * an absent row as a deletion and pruning the archive it is still loading.
   */
  private readonly publishedWorkspaceScopes = new Set<string>();
  /**
   * Workspaces whose local archive is only a verified prefix of a legacy
   * migration. Saves may update rows in these archives, but must never infer
   * deletions from the necessarily incomplete live map.
   */
  private readonly workspacePublicationHolds = new Set<string>();
  /** Last failed live write per opened scope, cleared by the next successful save. */
  private readonly workspaceSaveErrors = new Map<string, string>();
  /** A workspace may be upserted immediately, but only a restored/migrated one may be pruned. */
  private hasLoaded = false;
  private readonly workspaceCoordinator: boolean;
  private readonly archiveTrust: WorkspaceArchiveTrust | undefined;
  private workspaceMutationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ? requireAbsoluteWorkspace(options.workspaceRoot) : null;
    this.ownerKey = options.ownerKey ?? null;
    this.workspaceCoordinator = options.workspaceCoordinator === true;
    this.archiveTrust = options.archiveTrust;
    this.database = options.database || (this.workspaceRoot
      ? new WorkspaceSessionDatabase({
        workspaceRoot: this.workspaceRoot,
        ownerKey: requireOwnerKey(this.ownerKey),
        legacyDatabase: options.legacyDatabase,
        legacyOwnerUserId: options.legacyOwnerUserId,
        archiveTrust: options.archiveTrust,
        expectedStorageIdentity: options.expectedStorageIdentity,
      })
      : new AppDatabase(options));
    this.storageDir = this.database.storageDir;
    this.dbPath = this.database.dbPath;
  }

  /**
   * Register one workspace for restore and write-through operations.
   *
   * Keeping this explicit is important: opening arbitrary paths while loading
   * a global session list would turn a corrupt row into filesystem access.
   */
  openWorkspace(scope: SessionStorageScope): SessionStore {
    if (this.ownerKey) {
      if (this.workspaceRoot !== scope.workspaceRoot || this.ownerKey !== scope.ownerKey) {
        throw new Error('A workspace-bound SessionStore cannot open another storage scope');
      }
      return this;
    }
    const key = scopeKey(scope);
    if (this.suspendedWorkspaceScopes.has(key)) {
      throw new Error('Workspace session storage is temporarily suspended');
    }
    let store = this.workspaceStores.get(key);
    if (!store) {
      store = new SessionStore({
        workspaceRoot: scope.workspaceRoot,
        ownerKey: scope.ownerKey,
        archiveTrust: this.archiveTrust,
        expectedStorageIdentity: this.workspaceResumeAuthorities.get(key),
      });
      this.workspaceStores.set(key, store);
    } else {
      const expected = this.workspaceResumeAuthorities.get(key);
      const database = store.database;
      if (expected && database instanceof WorkspaceSessionDatabase) {
        const actual = database.storageIdentity();
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
          throw new Error('Opened workspace session storage is not the authorised inode');
        }
      }
    }
    return store;
  }

  /** Flush happens at the composition root before this call. Close the inode before wipe. */
  suspendWorkspace(scope: SessionStorageScope): void {
    if (this.ownerKey) throw new Error('Only the workspace coordinator can suspend a scope');
    const key = scopeKey(scope);
    const store = this.workspaceStores.get(key);
    store?.database.close();
    this.workspaceStores.delete(key);
    this.publishedWorkspaceScopes.delete(key);
    this.workspaceSaveErrors.delete(key);
    this.suspendedWorkspaceScopes.add(key);
  }

  /** Exact `.cc-web` inode held by the currently-open workspace database. */
  workspaceStorageIdentity(scope: SessionStorageScope): WorkspaceStorageIdentity | null {
    if (this.ownerKey) throw new Error('Only the workspace coordinator resolves storage authority');
    const key = scopeKey(scope);
    if (this.suspendedWorkspaceScopes.has(key)) {
      throw new Error('Workspace session storage is temporarily suspended');
    }
    const store = this.workspaceStores.get(key);
    if (!store || !(store.database instanceof WorkspaceSessionDatabase)) return null;
    return store.database.storageIdentity();
  }

  /** Drop a failed/unadmitted archive so a later prune cannot treat it as loaded. */
  closeWorkspace(scope: SessionStorageScope): void {
    if (this.ownerKey) throw new Error('Only the workspace coordinator can close a scope');
    const key = scopeKey(scope);
    const store = this.workspaceStores.get(key);
    store?.database.close();
    this.workspaceStores.delete(key);
    this.publishedWorkspaceScopes.delete(key);
    this.workspaceSaveErrors.delete(key);
  }

  resumeWorkspace(scope: SessionStorageScope, expected?: WorkspaceStorageIdentity): void {
    if (this.ownerKey) throw new Error('Only the workspace coordinator can resume a scope');
    const key = scopeKey(scope);
    if (expected) this.workspaceResumeAuthorities.set(key, expected);
    this.suspendedWorkspaceScopes.delete(key);
  }

  /** Reverify the live lease before retiring lifecycle recovery authority. */
  completeWorkspaceResume(
    scope: SessionStorageScope,
    expected: WorkspaceStorageIdentity,
  ): WorkspaceStorageIdentity {
    if (this.ownerKey) throw new Error('Only the workspace coordinator completes a scope resume');
    const actual = this.workspaceStorageIdentity(scope);
    if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('Reopened workspace session storage is not the authorised inode');
    }
    this.workspaceResumeAuthorities.delete(scopeKey(scope));
    return actual;
  }

  /** Close every workspace database owned by this coordinator at shutdown. */
  closeWorkspaces(): void {
    if (this.ownerKey) {
      this.database.close();
      return;
    }
    let failure: unknown = null;
    for (const [key, store] of this.workspaceStores) {
      try {
        store.database.close();
        this.workspaceStores.delete(key);
        this.suspendedWorkspaceScopes.delete(key);
        this.workspaceResumeAuthorities.delete(key);
        this.publishedWorkspaceScopes.delete(key);
        this.workspacePublicationHolds.delete(key);
        this.workspaceSaveErrors.delete(key);
      } catch (error) {
        if (failure === null) failure = error;
      }
    }
    if (failure === null) {
      this.suspendedWorkspaceScopes.clear();
      this.workspaceResumeAuthorities.clear();
      this.publishedWorkspaceScopes.clear();
      this.workspacePublicationHolds.clear();
      this.workspaceSaveErrors.clear();
    }
    if (failure) throw failure;
  }

  /**
   * Admit one fully restored archive as a source for deletion decisions.
   * Callers must publish its complete top-level session set first.
   */
  markWorkspacePublished(scope: SessionStorageScope): void {
    if (this.ownerKey) throw new Error('Only the workspace coordinator can publish a scope');
    const key = scopeKey(scope);
    if (!this.workspaceStores.has(key) || this.suspendedWorkspaceScopes.has(key)) {
      throw new Error('Cannot publish a workspace archive that is not open');
    }
    this.workspacePublicationHolds.delete(key);
    this.publishedWorkspaceScopes.add(key);
  }

  /** Keep a partially migrated archive readable without making it prune-authoritative. */
  holdWorkspacePublication(scope: SessionStorageScope): void {
    if (this.ownerKey) throw new Error('Only the workspace coordinator can hold a scope');
    const key = scopeKey(scope);
    this.workspacePublicationHolds.add(key);
    this.publishedWorkspaceScopes.delete(key);
  }

  isWorkspacePublicationHeld(scope: SessionStorageScope): boolean {
    if (this.ownerKey) throw new Error('Only the workspace coordinator tracks publication holds');
    return this.workspacePublicationHolds.has(scopeKey(scope));
  }

  /** Move only records whose workspace has already been resolved by the caller. */
  migrateLegacySessions(
    scope: SessionStorageScope,
    legacyDatabase: AppDatabase,
    legacyOwnerUserId: number,
    sessionIds: Iterable<string>,
  ): boolean {
    const store = this.openWorkspace(scope);
    if (!(store.database instanceof WorkspaceSessionDatabase)) {
      return false;
    }
    return store.database.migrateLegacySessions(legacyDatabase, legacyOwnerUserId, sessionIds);
  }

  rebindWorkspaceOwner(ownerUserId: number, ownerLogin: string): void {
    if (!this.ownerKey || !(this.database instanceof WorkspaceSessionDatabase)) {
      throw new Error('Only a workspace-bound SessionStore can rebind its owner');
    }
    this.database.rebindOwnerIdentity(ownerUserId, ownerLogin);
  }

  migrateLegacyOrphanUsage(
    scope: SessionStorageScope,
    legacyDatabase: AppDatabase,
    legacyOwnerUserId: number,
  ): boolean {
    const store = this.openWorkspace(scope);
    if (!(store.database instanceof WorkspaceSessionDatabase)) return false;
    return store.database.migrateLegacyOrphanUsage(legacyDatabase, legacyOwnerUserId);
  }

  /**
   * Read only the installation database even after workspace stores are open.
   * Live migration retry must not call the coordinator-wide loader: that would
   * merge the same destination rows it is about to reconcile with their legacy
   * source and report a false cross-archive collision.
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

  /** Aggregate diagnostics without opening or probing any additional path. */
  async getOpenedSessionMetadata(): Promise<{
    sessionCount: number;
    scopes: Array<{ scope: SessionStorageScope; metadata: SessionMetadata }>;
  }> {
    const scopes: Array<{ scope: SessionStorageScope; metadata: SessionMetadata }> = [];
    let sessionCount = 0;
    for (const store of this.workspaceStores.values()) {
      const metadata = await store.getSessionMetadata();
      sessionCount += metadata.sessionCount ?? 0;
      if (store.workspaceRoot && store.ownerKey) {
        const scope = { workspaceRoot: store.workspaceRoot, ownerKey: store.ownerKey };
        const writeError = this.workspaceSaveErrors.get(scopeKey(scope));
        scopes.push({
          scope,
          metadata: writeError ? { ...metadata, error: writeError } : metadata,
        });
      }
    }
    return { sessionCount, scopes };
  }

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
      && (this.workspaceCoordinator || Array.from(sessions.values()).some((session) => session.storageScope))
    ) {
      const input = this.workspaceCoordinator ? cloneSessionMap(sessions) : sessions;
      const persist = async (): Promise<boolean> => {
      const grouped = new Map<string, { scope: SessionStorageScope; sessions: Map<string, SessionRecord> }>();
      const legacy = new Map<string, SessionRecord>();
      // Unavailable workspace rows are intentionally omitted from the upsert,
      // but their omission is not a deletion signal. Remember every affected
      // scope so neither a mixed save nor the "scope disappeared" pass can
      // prune the authoritative row while a lifecycle/migration gate is live.
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
        store: SessionStore;
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
      const db = this.database.raw;
      const ownerColumn = this.ownerKey ? 'owner_key,' : '';
      const ownerValue = this.ownerKey ? '@owner_key,' : '';
      const envelopeColumn = this.ownerKey ? 'operational_envelope,' : '';
      const envelopeValue = this.ownerKey ? '@operational_envelope,' : '';
      const draftColumn = this.ownerKey ? 'chat_draft_json,' : '';
      const draftValue = this.ownerKey ? '@chat_draft_json,' : '';
      const insert = db.prepare(`
        INSERT OR REPLACE INTO runtime_sessions (
          ${ownerColumn}
          ${envelopeColumn}
          ${draftColumn}
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
          ${draftValue}
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
        : 'DELETE FROM runtime_sessions WHERE id NOT IN (SELECT value FROM json_each(?))');

      const replaceAll = db.transaction((sessionRows: Array<Record<string, unknown>>) => {
        for (const row of sessionRows) {
          insert.run(row);
        }
        if (this.ownerKey && this.hasLoaded && options.pruneMissing !== false) {
          deleteMissing.run(this.ownerKey, JSON.stringify(sessionRows.map((row) => row.id)));
        } else {
          if (!this.ownerKey) deleteMissing.run(JSON.stringify(sessionRows.map((row) => row.id)));
        }
      });

      const rows = Array.from(sessions.values()).map((session) => {
        const row = {
        ...(this.ownerKey ? { owner_key: this.ownerKey } : {}),
        ...(this.ownerKey ? {
          // Composer contents are session data.  Keep them beside the session
          // instead of in Electron/Chromium Web Storage, which lives in the
          // installation profile rather than in the opened workspace.
          chat_draft_json: session.chatDraft ? JSON.stringify(session.chatDraft) : null,
        } : {}),
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
        output_buffer_json: JSON.stringify((session.outputBuffer || []).slice(-1000)),
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
      this.database.setSetting('runtime_sessions.version', this.ownerKey ? '3' : '2');
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

  private async loadOwnSessions(
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
            ${this.ownerKey ? 'chat_draft_json' : 'NULL AS chat_draft_json'},
            custom_name,
            tab_open,
            tab_order,
            project_id,
            project_working_dir_kind,
            rollback_recovery_pending,
            ${this.ownerKey ? 'operational_envelope' : 'NULL AS operational_envelope'}
          FROM runtime_sessions
          ${this.ownerKey ? 'WHERE owner_key = ?' : ''}
          ORDER BY created_at ASC
        `)
        .all(...(this.ownerKey ? [this.ownerKey] : [])) as RuntimeSessionRow[];

      const sessions = new Map<string, SessionRecord>();
      for (const row of rows) {
        // Workspace rows are never admitted by an archive-wide marker alone:
        // a bound/custom backend without the per-record verifier fails closed.
        // The installation database is not portable input and remains the
        // trusted legacy import source.
        const trustedOperationalState = this.ownerKey
          ? this.database.verifyRuntimeSessionRecord?.(row, row.operational_envelope) === true
          : true;
        sessions.set(row.id, {
          id: row.id,
          rollbackRecoveryPending:
            trustedOperationalState && row.rollback_recovery_pending === 1
              ? true
              : undefined,
          ...(this.workspaceRoot && this.ownerKey ? {
            storageScope: { workspaceRoot: this.workspaceRoot, ownerKey: this.ownerKey },
          } : {}),
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
        console.log(`Restored ${sessions.size} sessions from SQLite`);
      }

      this.hasLoaded = true;

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      // A workspace database is the sole authority for its sessions. Masking
      // a read failure as an empty archive could make the next successful
      // autosave look like permission to prune it. Legacy installation reads
      // retain their historical best-effort behaviour for migration startup.
      if (this.ownerKey) throw error;
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
          : 'SELECT COUNT(*) AS count FROM runtime_sessions')
        .get(...(this.ownerKey ? [this.ownerKey] : [])) as { count: number };
      const savedAt = this.database.getSetting('runtime_sessions.saved_at') || undefined;
      const version = this.database.getSetting('runtime_sessions.version')
        || (this.ownerKey ? '3' : '2');

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
   * Write-through for the runtime's active flag.
   *
   * In-memory `active` is the runtime signal; the database copy is what the
   * run-limit sweep reads inside its transaction, so every start/stop/exit
   * must write through. Fire-and-forget: the WS flow never blocks on SQLite.
   * (#168)
   */
  async setActive(id: string, active: boolean, scope?: SessionStorageScope): Promise<void> {
    if (!this.ownerKey && scope) {
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
          : 'UPDATE runtime_sessions SET active = @active WHERE id = @id')
        .run(this.ownerKey
          ? { active: active ? 1 : 0, id, owner_key: this.ownerKey }
          : { active: active ? 1 : 0, id });
    } catch (error) {
      console.error(`Failed to set active flag for session ${id}:`, error);
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
        : 'UPDATE runtime_sessions SET active = 0').run(...(this.ownerKey ? [this.ownerKey] : []));
    } catch (error) {
      console.error('Failed to reset active flags:', error);
    }
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Read an untrusted portable draft without letting its JSON bypass wire limits. */
function parseStoredDraft(value: string | null, sessionId: string): ChatDraft | undefined {
  const parsed = parseJson<Record<string, unknown> | null>(value, null);
  if (!parsed) return undefined;
  const input = readDraft(parsed.text, parsed.attachments, sessionId);
  if (!input) return undefined;
  const revision = Number(parsed.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { ...input, revision };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireAbsoluteWorkspace(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('workspaceRoot must be absolute');
  return value;
}

function requireOwnerKey(value: string | null): string {
  if (!value) throw new Error('ownerKey is required with workspaceRoot');
  return value;
}

function scopeKey(scope: SessionStorageScope): string {
  return `${scope.workspaceRoot}\u0000${scope.ownerKey}`;
}

/** Freeze one autosave epoch before it waits behind an earlier disk mutation. */
function cloneSessionMap(sessions: Map<string, SessionRecord>): Map<string, SessionRecord> {
  return new Map(Array.from(sessions, ([id, session]) => [id, {
    ...session,
    storageScope: session.storageScope ? { ...session.storageScope } : undefined,
    connections: new Set(session.connections),
    outputBuffer: [...(session.outputBuffer || [])],
    terminalOptions: session.terminalOptions ? { ...session.terminalOptions } : null,
    chatDraft: session.chatDraft ? {
      ...session.chatDraft,
      attachments: session.chatDraft.attachments.map((attachment) => ({ ...attachment })),
    } : undefined,
    sessionUsage: {
      ...session.sessionUsage,
      models: { ...(session.sessionUsage?.models || {}) },
    },
  }]));
}

export default SessionStore;
