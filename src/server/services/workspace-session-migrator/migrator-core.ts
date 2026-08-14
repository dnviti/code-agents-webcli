import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type WorkspaceSessionIdentity,
  type WorkspaceStorageDirectoryLease,
} from '../workspace-session-storage.js';
import { DEFAULT_MAX_ATTACHMENTS } from '../attachment-store.js';

/**
 * The files written by the global stores before session data became
 * workspace-local. Keep this list here, beside the migration, so retiring a
 * legacy store cannot silently make one of its files undiscoverable.
 *
 * Chat snapshots in current releases are reconstructed from the JSONL log and
 * have no separate file. Two defensive historic aliases are nevertheless
 * recognised so an installation which contains either shape does not strand
 * data the migrator can safely preserve.
 */
export type LegacySessionArtifact =
  | 'chat_log'
  | 'chat_index'
  | 'chat_snapshot'
  | 'chat_snapshot_json'
  | 'chat_opening_context'
  | 'chat_plan'
  | 'transcript'
  | 'history_log'
  | 'history_index'
  | 'paste_manifest'
  | 'attachment_file'
  | 'paste_file';

export type LegacyArtifactState = 'absent' | 'migrated' | 'already_migrated' | 'blocked';

export type LegacyArtifactBlockReason =
  | 'unsafe_legacy_storage'
  | 'unsafe_workspace_storage'
  | 'unsafe_source'
  | 'unsafe_target'
  | 'target_conflict'
  | 'source_changed'
  | 'io_error';

export interface LegacyArtifactMigrationEntry {
  artifact: LegacySessionArtifact;
  /** Present for one member of a multi-file binary artifact kind. */
  key?: string;
  state: LegacyArtifactState;
  bytes?: number;
  sha256?: string;
  reason?: LegacyArtifactBlockReason;
}

export interface LegacySessionArtifactMigrationResult {
  status: 'complete' | 'partial' | 'blocked';
  artifacts: LegacyArtifactMigrationEntry[];
}

export interface LegacySessionMigrationRef extends WorkspaceSessionIdentity {
  /** Last host cwd recorded by the legacy row; project sessions may use a secondary checkout path. */
  workingDir?: string;
  projectId?: string | null;
  projectWorkingDirKind?: 'host' | 'container';
  /** Draft attachments are referenced only by SQLite until the turn is sent. */
  chatDraft?: {
    attachments?: ReadonlyArray<{ url?: unknown }>;
  };
}

export interface WorkspaceSessionArtifactMigratorOptions {
  /** AppDatabase.storageDir from releases which stored session files globally. */
  legacyStorageDir: string;
  /** Deterministic fault-injection/observability seams used by migration tests. */
  hooks?: WorkspaceSessionArtifactMigratorHooks;
}

export interface WorkspaceSessionArtifactMigratorHooks {
  afterDirectorySync?(event: {
    directory: string;
    reason: DirectorySyncReason;
  }): Promise<void> | void;
  beforeLegacyUnlink?(event: {
    artifact: LegacySessionArtifact;
    key: string;
    kind: 'source' | 'backup';
  }): Promise<void> | void;
  afterConfirmArtifact?(event: {
    artifact: LegacySessionArtifact;
    key: string;
  }): Promise<void> | void;
}

export interface ArtifactPaths {
  artifact: LegacySessionArtifact;
  /** Stable marker identity; dynamic binary artifacts may share one public kind. */
  key: string;
  source: string;
  /** Root against which every legacy source component is checked. */
  sourceRoot: string;
  target: string;
  /** Canonical visible destination, distinct from a descriptor-relative I/O path. */
  canonicalTarget: string;
  backup: string;
  /** A canonical file already in its final namespace is verified but never retired as legacy. */
  sourceIsTarget?: boolean;
  /** Normalised target bytes, used for the workspace-local paste manifest. */
  targetContents?: Buffer;
  /** A referenced binary must exist either at source or at its canonical target. */
  required?: boolean;
  /** Paste manifests record the exact byte count and migration verifies it. */
  expectedSourceBytes?: number;
  /** Canonical per-file limit, checked before hashing, copying, or backup I/O. */
  maximumBytes?: number;
  /** The pinned legacy parent did not exist when this migration pass began. */
  sourceDirectoryMissing?: boolean;
  /** Revalidate a pathname fallback or the visible binding around source I/O. */
  verifySourceDirectory?: () => void;
  /** Exact destination namespace for cwd-helper publication outside session-file leases. */
  targetLease?: WorkspaceStorageDirectoryLease;
  /** Exact source namespace for cwd-helper backup and retirement mutations. */
  sourceLease?: WorkspaceStorageDirectoryLease;
}

export interface Fingerprint {
  bytes: number;
  sha256: string;
}

export interface MigrationMarkerArtifact {
  artifact: LegacySessionArtifact;
  key?: string;
  present: boolean;
  bytes?: number;
  sha256?: string;
  sourceBytes?: number;
  sourceSha256?: string;
}

export interface MigrationMarker {
  version: 1;
  ownerKey: string;
  /** Diagnostic only; ownerKey is the portable authorisation identity. */
  ownerUserId: number;
  sessionId: string;
  phase: 'verified' | 'complete';
  artifacts: MigrationMarkerArtifact[];
}

export interface PreparedArtifact {
  definition: ArtifactPaths;
  entry: LegacyArtifactMigrationEntry;
  targetFingerprint?: Fingerprint;
  sourceFingerprint?: Fingerprint;
}

export type BigFileStat = fs.BigIntStats;
export type ArtifactDirectoryLease = Pick<WorkspaceStorageDirectoryLease,
  'canonicalPath' | 'accessPath' | 'fd' | 'pathFallback' | 'entryMutationPolicy' | 'verify'>;

export type DirectorySyncReason =
  | 'publish'
  | 'temporary_cleanup'
  | 'quarantine_publish'
  | 'source_unlink'
  | 'backup_unlink'
  | 'marker_publish'
  | 'marker_unlink';

export interface PinnedLegacyDirectoryLease {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceStorageDirectoryLease['entryMutationPolicy'];
  verify(): void;
  close(): void;
}

export interface PinnedFixedArtifactPlan {
  definitions: ArtifactPaths[];
  leases: PinnedLegacyDirectoryLease[];
}

export const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
export const COPY_CHUNK_BYTES = 64 * 1024;
export const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
export const DIRECTORY = (fs.constants as unknown as Record<string, number>).O_DIRECTORY ?? 0;
export const READ_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW;
export const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;
export const MARKER_FILE = '.legacy-artifact-migration.v1.json';
export const MAX_MARKER_BYTES = 4 * 1024 * 1024;
export const MAX_PASTE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PASTE_MANIFEST_ENTRIES = 4096;
export const MAX_PASTE_ROOTS = 128;
export const MAX_ATTACHMENT_FILES = DEFAULT_MAX_ATTACHMENTS;
export const MAX_ATTACHMENT_DIRECTORY_ENTRIES = 1024;
export const MAX_LEGACY_WORKSPACE_ROOTS = 2;
export const MAX_ATTACHMENT_SOURCE_NAMESPACES_PER_ROOT = 3;
export const FIXED_ARTIFACT_COUNT = 10;
export const MAX_MARKER_ARTIFACT_KEY_LENGTH = 384;
/**
 * Ten fixed files, every permitted paste entry, and for each attachment the
 * flat plus two owner-scoped candidates in each of the two authorised roots,
 * minus the canonical target candidate. Keep reads and writes on this exact
 * same bound so a valid maximum-size plan is always confirmable.
 */
export const MAX_MIGRATION_MARKER_ARTIFACTS = FIXED_ARTIFACT_COUNT
  + MAX_PASTE_MANIFEST_ENTRIES
  + MAX_ATTACHMENT_FILES
    * (MAX_LEGACY_WORKSPACE_ROOTS * MAX_ATTACHMENT_SOURCE_NAMESPACES_PER_ROOT - 1);
export const STORED_ATTACHMENT_NAME = /^[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/;
export const PASTED_IMAGE_NAME = /^[A-Za-z0-9._-]+\.(?:png|jpg|gif|webp|bmp)$/;

export function safeComponent(value: unknown, label: string): string {
  const text = String(value);
  if (!SAFE_COMPONENT.test(text) || text === '.' || text === '..') {
    throw Object.assign(new Error(`Unsafe ${label}`), { migrationReason: 'unsafe_source' });
  }
  return text;
}


export function migrationReason(error: unknown): LegacyArtifactBlockReason {
  const reason = (error as { migrationReason?: unknown } | null)?.migrationReason;
  if (
    reason === 'unsafe_legacy_storage'
    || reason === 'unsafe_workspace_storage'
    || reason === 'unsafe_source'
    || reason === 'unsafe_target'
    || reason === 'target_conflict'
    || reason === 'source_changed'
    || reason === 'io_error'
  ) {
    return reason;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ELOOP') return 'unsafe_source';
  return 'io_error';
}

export function blocked(
  artifact: LegacySessionArtifact,
  reason: LegacyArtifactBlockReason,
  key?: string,
): LegacyArtifactMigrationEntry {
  return {
    artifact,
    ...(key && key !== artifact ? { key } : {}),
    state: 'blocked',
    reason,
  };
}

export function artifactEntry(
  definition: ArtifactPaths,
  state: LegacyArtifactState,
  fingerprint?: Fingerprint,
): LegacyArtifactMigrationEntry {
  return {
    artifact: definition.artifact,
    ...(definition.key !== definition.artifact ? { key: definition.key } : {}),
    state,
    ...fingerprint,
  };
}

export function blockedArtifact(
  definition: ArtifactPaths,
  reason: LegacyArtifactBlockReason,
): LegacyArtifactMigrationEntry {
  return blocked(definition.artifact, reason, definition.key);
}

export function stableFile(before: BigFileStat, after: BigFileStat): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

export function stableFileAcrossRename(before: BigFileStat, after: BigFileStat): boolean {
  // rename(2) may legitimately advance ctime while leaving the opened inode
  // and its bytes untouched. The post-rename fingerprint closes that gap.
  return sameFileIdentity(before, after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
}

export function sameFileIdentity(left: BigFileStat, right: BigFileStat): boolean {
  // A zero inode cannot prove a hard-link relationship on a platform/filesystem
  // which does not expose file ids. Recovery must fail closed in that case.
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

export function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

export async function lstatOrNull(target: string): Promise<BigFileStat | null> {
  return fs.promises.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export function boundedMigrationFileBytes(
  stat: BigFileStat,
  maximumBytes: number,
  unsafeReason: LegacyArtifactBlockReason,
): number {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size < 0n
    || stat.size > BigInt(maximumBytes)
  ) {
    throw Object.assign(new Error('Migration artifact exceeds its canonical file bound'), {
      migrationReason: unsafeReason,
    });
  }
  return Number(stat.size);
}

export function sameDirectoryIdentity(left: BigFileStat, right: BigFileStat): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino !== 0n
    && left.ino === right.ino;
}

export interface PasteManifestEntry {
  path: string;
  root: string;
  bytes: number;
}

export interface PasteManifest {
  version: 1;
  entries: PasteManifestEntry[];
}

export interface BinaryArtifactPlan {
  definitions: ArtifactPaths[];
  leases: WorkspaceStorageDirectoryLease[];
}

export function backupPath(source: string): string {
  const basename = path.basename(source);
  const backupName = Buffer.byteLength(basename, 'utf8') <= 180
    ? `.${basename}.ccweb-session-migration.bak`
    : `.ccweb-session-migration-${createHash('sha256').update(basename).digest('hex').slice(0, 32)}.bak`;
  return path.join(
    path.dirname(source),
    backupName,
  );
}

export function dynamicArtifactKey(kind: 'attachment_file' | 'paste_file', source: string): string {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 24);
  return `${kind}:${digest}:${path.basename(source)}`;
}

