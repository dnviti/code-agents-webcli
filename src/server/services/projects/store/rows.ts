/** Row-shape interfaces, row→domain mappers, and small setting/credential helpers. */

import type { AppDatabase } from '../../persistence/app/database.js';
import type {
  BuildEvent,
  CompositionInstallation,
  CompositionInstallationStatus,
  ConnectedHost,
  ConnectedHostValidationStatus,
  GitIdentity,
  Project,
  ProjectComposition,
  ProjectContainerInfo,
  ProjectState,
  StorageUsageBreakdown,
  StorageUsageSnapshot,
} from './types.js';

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface ProjectRow {
  id: string;
  owner_user_id: number;
  name: string;
  repo_url: string | null;
  repo_host: string | null;
  target_id: string | null;
  execution_kind: string | null;
  tier_id: string | null;
  state: string;
  state_detail: string | null;
  container_json: string | null;
  rebuild_required: number | null;
  build_log_json: string | null;
  last_activity_at: string;
  last_preserved_commit: string | null;
  last_preserved_branch: string | null;
  composition_revision: string | null;
  applied_composition_revision: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    repoUrl: row.repo_url,
    repoHost: row.repo_host,
    targetId: row.target_id,
    executionKind: row.execution_kind === 'host' ? 'host' : 'container',
    tierId: row.tier_id,
    state: row.state as ProjectState,
    stateDetail: row.state_detail,
    container: parseJson<ProjectContainerInfo | null>(row.container_json, null),
    rebuildRequired: Boolean(row.rebuild_required),
    buildLog: parseJson<BuildEvent[]>(row.build_log_json, []),
    lastActivityAt: row.last_activity_at,
    lastPreservedCommit: row.last_preserved_commit,
    lastPreservedBranch: row.last_preserved_branch,
    compositionRevision: row.composition_revision,
    appliedCompositionRevision: row.applied_composition_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ConnectedHostRow {
  id: string;
  user_id: number;
  host: string;
  kind: string;
  forge_kind: string | null;
  credential_kind: string | null;
  validation_status: string | null;
  last_validated_at: string | null;
  validation_error_code: string | null;
  validation_error_message: string | null;
  credential_revision: number | null;
  credential_encrypted: string | null;
  scopes_json: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function toConnectedHost(row: ConnectedHostRow): ConnectedHost {
  return {
    id: row.id,
    userId: row.user_id,
    host: row.host,
    kind: row.kind,
    forgeKind: row.forge_kind,
    credentialKind: row.credential_kind as ConnectedHost['credentialKind'],
    validationStatus: row.validation_status as ConnectedHostValidationStatus | null,
    lastValidatedAt: row.last_validated_at,
    validationErrorCode: row.validation_error_code,
    validationErrorMessage: row.validation_error_message,
    credentialRevision: row.credential_revision ?? 0,
    scopes: parseJson<string[]>(row.scopes_json, []),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CompositionRow {
  id: string; project_id: string; user_id: number; catalog_version: string; detected_json: string;
  chosen_json: string; source_oid: string | null; source_ref: string | null; forge_kind: string | null;
  forge_host: string | null; created_at: string;
}
function toComposition(row: CompositionRow): ProjectComposition {
  return { id: row.id, projectId: row.project_id, userId: row.user_id, catalogVersion: row.catalog_version,
    detected: parseJson(row.detected_json, {}), chosen: parseJson(row.chosen_json, {}), sourceOid: row.source_oid,
    sourceRef: row.source_ref, forgeKind: row.forge_kind, forgeHost: row.forge_host, createdAt: row.created_at };
}

interface CompositionInstallationRow {
  id: string; composition_id: string; item_id: string; status: string; attempts: number; installed_version: string | null;
  error_code: string | null; error_message: string | null; created_at: string; updated_at: string;
}
function toCompositionInstallation(row: CompositionInstallationRow): CompositionInstallation {
  return { id: row.id, compositionId: row.composition_id, itemId: row.item_id, status: row.status as CompositionInstallationStatus,
    attempts: row.attempts, installedVersion: row.installed_version, errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

interface GitIdentityRow { id: string; user_id: number; project_id: string | null; name: string; email: string; created_at: string; updated_at: string; }
function toGitIdentity(row: GitIdentityRow): GitIdentity { return { id: row.id, userId: row.user_id, projectId: row.project_id, name: row.name, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at }; }

interface StorageUsageSnapshotRow { id: string; user_id: number | null; total_bytes: number; breakdown_json: string; errors_json: string | null; free_bytes: number | null; created_at: string; }
function toStorageUsageSnapshot(row: StorageUsageSnapshotRow): StorageUsageSnapshot { return { id: row.id, userId: row.user_id, totalBytes: row.total_bytes, breakdown: parseJson<StorageUsageBreakdown>(row.breakdown_json, {}), errors: parseJson<string[]>(row.errors_json, []), freeBytes: row.free_bytes, createdAt: row.created_at }; }

export {
  parseJson,
  toProject,
  toConnectedHost,
  toComposition,
  toCompositionInstallation,
  toGitIdentity,
  toStorageUsageSnapshot,
};
export type { ProjectRow, ConnectedHostRow, CompositionRow, CompositionInstallationRow, GitIdentityRow, StorageUsageSnapshotRow };

function positiveIntSetting(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntSetting(raw: string | null): number | null {
  if (raw === null || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function setOptionalByteSetting(db: AppDatabase, key: string, bytes: number | null): void { if (bytes == null) db.deleteSetting(key); else if (Number.isFinite(bytes) && bytes >= 0) db.setSetting(key, String(Math.floor(bytes))); else throw new Error('usage warning must be a non-negative number'); }

function credentialExpired(value: string | null): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function usableCredentialRow(row: {
  credential_encrypted: string | null;
  validation_status: string | null;
  expires_at: string | null;
}): boolean {
  return Boolean(row.credential_encrypted)
    && row.validation_status !== 'invalid'
    && !credentialExpired(row.expires_at);
}

export {
  positiveIntSetting,
  nonNegativeIntSetting,
  setOptionalByteSetting,
  credentialExpired,
  usableCredentialRow,
};
