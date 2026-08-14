import { WorkspaceSessionDatabase } from '../workspace-session-database.js';
import type { WorkspaceStorageIdentity } from '../workspace-session-storage.js';
import type { AppDatabase } from '../database.js';
import type { SessionStorageScope } from '../../types.js';
import type { SessionStoreOptions, SessionMetadata } from './types.js';
import { scopeKey } from './helpers.js';
import { SessionStoreBase } from './base.js';
import type { SessionStore } from './session-store.js';

/**
 * Workspace-coordinator lifecycle: opening, suspending, resuming, closing and
 * publishing per-scope stores, plus their legacy migration entry points.
 *
 * A full concrete `SessionStore` is (re)constructed via `this.constructor` so
 * this module never depends on the leaf class at runtime.
 */
export abstract class SessionStoreCoordinator extends SessionStoreBase {
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
      // The bound store is always the full concrete class; this narrows the
      // coordinator-typed `this` without a runtime import of the leaf class.
      return this as unknown as SessionStore;
    }
    const key = scopeKey(scope);
    if (this.suspendedWorkspaceScopes.has(key)) {
      throw new Error('Workspace session storage is temporarily suspended');
    }
    let store = this.workspaceStores.get(key);
    if (!store) {
      const Ctor = this.constructor as new (options: SessionStoreOptions) => SessionStore;
      store = new Ctor({
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

  /** Keep a partially published archive readable without making it prune-authoritative. */
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
}
