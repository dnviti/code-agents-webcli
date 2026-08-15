/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this file only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 *
 * Implementation lives in ./workspace-session-database/ (types, storage
 * authority, and the session-database class split across an inheritance
 * chain).  This module is a thin facade preserving the original export
 * surface.
 */
export { WorkspaceSessionDatabase } from './workspace-session-database/database.js';
export type {
  WorkspaceSessionDatabaseOptions,
  WorkspaceArchiveTrust,
  RuntimeSessionOperationalState,
  SessionPersistenceDatabase,
} from './workspace-session-database/types.js';
