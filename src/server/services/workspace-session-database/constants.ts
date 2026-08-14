/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this module only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import fs from 'node:fs';
import type { SqliteDatabase } from '../sqlite.js';
import type { WorkspaceStorageDirectoryLease } from '../workspace-session-storage.js';

export const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
export const MAX_SERIALIZED_DATABASE_BYTES = 384 * 1024 * 1024;
export const WRITER_LEASE_NAME = '.session-state.writer';
export const WRITER_GUARD_NAME = '.session-state.writer.guard';
export const WRITER_GUARD_CLAIM_NAME = '.session-state.writer.guard.claim';
export const WRITER_LEASE_CLAIM_NAME = '.session-state.writer.claim';
export const WRITER_RETIRE_RECOVERY_A = '.session-state.writer.retire-recovery-a';
export const WRITER_RETIRE_RECOVERY_B = '.session-state.writer.retire-recovery-b';
export const RENAME_RECOVERY_A = '.session-state.rename-recovery-a';
export const RENAME_RECOVERY_B = '.session-state.rename-recovery-b';

export interface SharedSerializedWorkspaceDatabase {
  readonly db: SqliteDatabase;
  readonly storageLease: WorkspaceStorageDirectoryLease;
  readonly token: string;
  refs: number;
  poisoned: unknown | null;
  readonly serialized: boolean;
}

export const sharedSerializedDatabases = new Map<string, SharedSerializedWorkspaceDatabase>();
