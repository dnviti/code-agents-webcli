import type { DatabaseOptions, AppDatabase } from '../database.js';
import type { AgentKind } from '../../types.js';
import type {
  RuntimeSessionOperationalState,
  SessionPersistenceDatabase,
  WorkspaceArchiveTrust,
} from '../workspace-session-database.js';
import type { WorkspaceStorageIdentity } from '../workspace-session-storage.js';

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
  /** Shared app.sqlite authority; only rows with immutable artifact scopes are live. */
  scopedGlobalStore?: boolean;
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

/** A raw `runtime_sessions` row as read back from any of the backing stores. */
export interface RuntimeSessionRow extends RuntimeSessionOperationalState {
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
  storage_workspace_root: string | null;
  storage_owner_key: string | null;
  operational_envelope: string | null;
}
