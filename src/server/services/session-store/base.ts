import { AppDatabase } from '../database.js';
import { WorkspaceSessionDatabase } from '../workspace-session-database.js';
import type {
  SessionPersistenceDatabase,
  WorkspaceArchiveTrust,
} from '../workspace-session-database.js';
import type { WorkspaceStorageIdentity } from '../workspace-session-storage.js';
import type { SessionStoreOptions } from './types.js';
import { requireAbsoluteWorkspace, requireOwnerKey } from './helpers.js';
import type { SessionStore } from './session-store.js';

/**
 * Shared fields and construction for the SessionStore inheritance chain.
 *
 * `SessionStore` is referenced here only as a type so the coordinator can hold
 * and (re)construct full instances without a runtime import cycle.
 */
export abstract class SessionStoreBase {
  readonly database: SessionPersistenceDatabase;
  readonly storageDir: string;
  readonly dbPath: string;
  readonly workspaceRoot: string | null;
  readonly ownerKey: string | null;
  /** Stores opened through this coordinator, keyed by immutable storage scope. */
  protected readonly workspaceStores = new Map<string, SessionStore>();
  /** Scopes whose checkout is being replaced; autosave must not recreate them. */
  protected readonly suspendedWorkspaceScopes = new Set<string>();
  /** Recovery authority applied before constructing a replacement database handle. */
  protected readonly workspaceResumeAuthorities = new Map<string, WorkspaceStorageIdentity>();
  /**
   * Archives whose complete restored state has been published to the live map.
   *
   * `SessionStore.loadSessions()` necessarily marks the bound store readable,
   * but the composition root must validate and publish the complete archive
   * before those rows are authoritative in memory. Keeping that distinction
   * prevents an autosave in that interval from interpreting an absent row as
   * a deletion and pruning the archive it is still loading.
   */
  protected readonly publishedWorkspaceScopes = new Set<string>();
  /**
   * Workspaces temporarily held from deletion-authoritative publication.
   * Saves may update rows in these archives, but must never infer deletions
   * from an intentionally incomplete live map.
   */
  protected readonly workspacePublicationHolds = new Set<string>();
  /** Last failed live write per opened scope, cleared by the next successful save. */
  protected readonly workspaceSaveErrors = new Map<string, string>();
  /** A workspace may be upserted immediately, but only a fully restored one may be pruned. */
  protected hasLoaded = false;
  protected readonly workspaceCoordinator: boolean;
  protected readonly scopedGlobalStore: boolean;
  protected readonly archiveTrust: WorkspaceArchiveTrust | undefined;
  protected workspaceMutationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ? requireAbsoluteWorkspace(options.workspaceRoot) : null;
    this.ownerKey = options.ownerKey ?? null;
    this.workspaceCoordinator = options.workspaceCoordinator === true;
    this.scopedGlobalStore = options.scopedGlobalStore === true;
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
}
