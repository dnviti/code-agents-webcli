/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this module only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import { AppDatabase } from '../../../persistence/app/database.js';
import type {
  SqliteDatabase,
  SqliteOpenFileBinding,
} from '../../../persistence/app/sqlite.js';
import type {
  WorkspaceStorageIdentity,
  WorkspaceStorageOpenOptions,
} from '../workspace-session-storage.js';

export interface WorkspaceSessionDatabaseOptions {
  workspaceRoot: string;
  /** A stable, non-reversible account identity (normally SHA-256 of github id). */
  ownerKey: string;
  /** Optional source for the one-time move from pre-workspace storage. */
  legacyDatabase?: AppDatabase;
  legacyOwnerUserId?: number;
  /** Installation-owned authenticated envelope for sensitive restored state. */
  archiveTrust?: WorkspaceArchiveTrust;
  /** Deterministic SQLite pathname-swap seam for security tests only. */
  sqliteOpenTestHooks?: SqliteOpenFileBinding['testHooks'];
  /** Deterministic descriptor-capability seam for security tests only. */
  workspaceStorageOpenOptions?: WorkspaceStorageOpenOptions;
  /** Lifecycle authority captured from the previously-open database lease. */
  expectedStorageIdentity?: WorkspaceStorageIdentity;
}

export interface WorkspaceArchiveTrust {
  seal(value: string): string;
  open(envelope: string): string;
}

/**
 * The subset of a runtime row which can influence what is launched or resumed.
 *
 * Workspace databases are portable user-controlled files.  These values must
 * therefore be authenticated by the installation before they are allowed back
 * into a live SessionRecord.  Keep the keys explicit and ordered: the JSON
 * representation is the authenticated wire format, not a convenience dump of
 * an arbitrary SQLite row.
 */
export interface RuntimeSessionOperationalState {
  id: string;
  rollback_recovery_pending?: number | null;
  working_dir: string;
  surface: string | null;
  last_agent: string | null;
  runtime_label: string | null;
  terminal_options_json: string | null;
  session_start_time: string | null;
  max_buffer_size: number;
  native_chat_session_id: string | null;
  owner_session_id: string | null;
  chat_bypass_permissions: number | null;
  chat_model_override: string | null;
  chat_model_pinned: string | null;
  chat_effort_override: string | null;
  chat_plan_mode: number | null;
  project_id: string | null;
  project_working_dir_kind: string | null;
}

export interface SessionPersistenceDatabase {
  readonly storageDir: string;
  readonly dbPath: string;
  readonly raw: SqliteDatabase;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  close(): void;
  readonly trustedArchive?: boolean;
  markArchiveTrusted?(): void;
  sealRuntimeSessionRecord?(record: RuntimeSessionOperationalState): string | null;
  verifyRuntimeSessionRecord?(
    record: RuntimeSessionOperationalState,
    envelope: string | null,
  ): boolean;
}

export function normalizeRuntimeSessionOperationalState(
  record: RuntimeSessionOperationalState,
): RuntimeSessionOperationalState {
  const nullableText = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value);
  const nullableInteger = (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(record.id),
    rollback_recovery_pending: nullableInteger(record.rollback_recovery_pending),
    working_dir: String(record.working_dir),
    surface: nullableText(record.surface),
    last_agent: nullableText(record.last_agent),
    runtime_label: nullableText(record.runtime_label),
    terminal_options_json: nullableText(record.terminal_options_json),
    session_start_time: nullableText(record.session_start_time),
    max_buffer_size: Number(record.max_buffer_size),
    native_chat_session_id: nullableText(record.native_chat_session_id),
    owner_session_id: nullableText(record.owner_session_id),
    chat_bypass_permissions: nullableInteger(record.chat_bypass_permissions),
    chat_model_override: nullableText(record.chat_model_override),
    chat_model_pinned: nullableText(record.chat_model_pinned),
    chat_effort_override: nullableText(record.chat_effort_override),
    chat_plan_mode: nullableInteger(record.chat_plan_mode),
    project_id: nullableText(record.project_id),
    project_working_dir_kind: nullableText(record.project_working_dir_kind),
  };
}

export function operationalStateFromDatabaseRow(
  row: Record<string, unknown>,
): RuntimeSessionOperationalState {
  const text = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  const integer = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return normalizeRuntimeSessionOperationalState({
    id: String(row.id),
    rollback_recovery_pending: integer('rollback_recovery_pending'),
    working_dir: String(row.working_dir),
    surface: text('surface'),
    last_agent: text('last_agent'),
    runtime_label: text('runtime_label'),
    terminal_options_json: text('terminal_options_json'),
    session_start_time: text('session_start_time'),
    max_buffer_size: Number(row.max_buffer_size),
    native_chat_session_id: text('native_chat_session_id'),
    owner_session_id: text('owner_session_id'),
    chat_bypass_permissions: integer('chat_bypass_permissions'),
    chat_model_override: text('chat_model_override'),
    chat_model_pinned: text('chat_model_pinned'),
    chat_effort_override: text('chat_effort_override'),
    chat_plan_mode: integer('chat_plan_mode'),
    project_id: text('project_id'),
    project_working_dir_kind: text('project_working_dir_kind'),
  });
}
