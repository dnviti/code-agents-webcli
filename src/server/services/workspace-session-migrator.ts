import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeWorkspaceSessionDirectoryLease,
  ensureWorkspaceSessionDirectory,
  openCanonicalDirectoryLeaseSync,
  openWorkspaceAttachmentDirectorySync,
  openWorkspaceAttachmentRootDirectorySync,
  openWorkspacePasteDirectorySync,
  workspaceSessionAccessDirectory,
  workspaceDescriptorRoot,
  WorkspaceSessionIdentity,
  type WorkspaceStorageDirectoryLease,
  workspaceSessionDirectory,
  workspaceSessionFileParentLease,
} from './workspace-session-storage.js';
import { openWorkspaceCwdFileForRead, unlinkSessionEntry } from './safe-session-file.js';
import {
  fingerprintWorkspaceCwdFile,
  inspectWorkspaceCwdDirectory,
  publishLargeWorkspaceCwdFile,
  publishNewLargeWorkspaceCwdFile,
  publishNewWorkspaceCwdFile,
  removeWorkspaceCwdEntry,
  recoverMigrationWorkspaceCwdRetirement,
  recoverWorkspaceCwdPublication,
  retireMigrationWorkspaceCwdEntry,
  readWorkspaceCwdFile,
  listWorkspaceCwdEntries,
  migrationWorkspaceCwdRetirementPrefix,
  statWorkspaceCwdFile,
} from './workspace-cwd-helper.js';
import {
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENTS,
} from './attachment-store.js';
import {
  DEFAULT_MAX_BYTES as DEFAULT_MAX_PASTE_BYTES,
  DEFAULT_SESSION_QUOTA_BYTES as DEFAULT_PASTE_SESSION_QUOTA_BYTES,
} from './paste-store.js';

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

interface ArtifactPaths {
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

interface Fingerprint {
  bytes: number;
  sha256: string;
}

interface MigrationMarkerArtifact {
  artifact: LegacySessionArtifact;
  key?: string;
  present: boolean;
  bytes?: number;
  sha256?: string;
  sourceBytes?: number;
  sourceSha256?: string;
}

interface MigrationMarker {
  version: 1;
  ownerKey: string;
  /** Diagnostic only; ownerKey is the portable authorisation identity. */
  ownerUserId: number;
  sessionId: string;
  phase: 'verified' | 'complete';
  artifacts: MigrationMarkerArtifact[];
}

interface PreparedArtifact {
  definition: ArtifactPaths;
  entry: LegacyArtifactMigrationEntry;
  targetFingerprint?: Fingerprint;
  sourceFingerprint?: Fingerprint;
}

type BigFileStat = fs.BigIntStats;
type ArtifactDirectoryLease = Pick<WorkspaceStorageDirectoryLease,
  'canonicalPath' | 'accessPath' | 'fd' | 'pathFallback' | 'entryMutationPolicy' | 'verify'>;

type DirectorySyncReason =
  | 'publish'
  | 'temporary_cleanup'
  | 'quarantine_publish'
  | 'source_unlink'
  | 'backup_unlink'
  | 'marker_publish'
  | 'marker_unlink';

interface PinnedLegacyDirectoryLease {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceStorageDirectoryLease['entryMutationPolicy'];
  verify(): void;
  close(): void;
}

interface PinnedFixedArtifactPlan {
  definitions: ArtifactPaths[];
  leases: PinnedLegacyDirectoryLease[];
}

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const COPY_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const DIRECTORY = (fs.constants as unknown as Record<string, number>).O_DIRECTORY ?? 0;
const READ_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;
const MARKER_FILE = '.legacy-artifact-migration.v1.json';
const MAX_MARKER_BYTES = 4 * 1024 * 1024;
const MAX_PASTE_MANIFEST_BYTES = 1024 * 1024;
const MAX_PASTE_MANIFEST_ENTRIES = 4096;
const MAX_PASTE_ROOTS = 128;
const MAX_ATTACHMENT_FILES = DEFAULT_MAX_ATTACHMENTS;
const MAX_ATTACHMENT_DIRECTORY_ENTRIES = 1024;
const MAX_LEGACY_WORKSPACE_ROOTS = 2;
const MAX_ATTACHMENT_SOURCE_NAMESPACES_PER_ROOT = 3;
const FIXED_ARTIFACT_COUNT = 10;
const MAX_MARKER_ARTIFACT_KEY_LENGTH = 384;
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
const STORED_ATTACHMENT_NAME = /^[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/;
const PASTED_IMAGE_NAME = /^[A-Za-z0-9._-]+\.(?:png|jpg|gif|webp|bmp)$/;

function safeComponent(value: unknown, label: string): string {
  const text = String(value);
  if (!SAFE_COMPONENT.test(text) || text === '.' || text === '..') {
    throw Object.assign(new Error(`Unsafe ${label}`), { migrationReason: 'unsafe_source' });
  }
  return text;
}

function migrationReason(error: unknown): LegacyArtifactBlockReason {
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

function blocked(
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

function artifactEntry(
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

function blockedArtifact(
  definition: ArtifactPaths,
  reason: LegacyArtifactBlockReason,
): LegacyArtifactMigrationEntry {
  return blocked(definition.artifact, reason, definition.key);
}

function stableFile(before: BigFileStat, after: BigFileStat): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function stableFileAcrossRename(before: BigFileStat, after: BigFileStat): boolean {
  // rename(2) may legitimately advance ctime while leaving the opened inode
  // and its bytes untouched. The post-rename fingerprint closes that gap.
  return sameFileIdentity(before, after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs;
}

function sameFileIdentity(left: BigFileStat, right: BigFileStat): boolean {
  // A zero inode cannot prove a hard-link relationship on a platform/filesystem
  // which does not expose file ids. Recovery must fail closed in that case.
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

async function lstatOrNull(target: string): Promise<BigFileStat | null> {
  return fs.promises.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function leaseAwareFileStatOrNull(
  target: string,
  lease: ArtifactDirectoryLease | undefined,
  unsafeReason: LegacyArtifactBlockReason,
): Promise<BigFileStat | null> {
  if (lease?.entryMutationPolicy !== 'cwd-helper') return lstatOrNull(target);
  if (path.dirname(target) !== lease.accessPath && path.dirname(target) !== lease.canonicalPath) {
    throw Object.assign(new Error('Portable migration file is outside its pinned namespace'), {
      migrationReason: unsafeReason,
    });
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = openWorkspaceCwdFileForRead(lease, path.basename(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Object.assign(error as object, { migrationReason: unsafeReason });
  }
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Object.assign(error as object, { migrationReason: unsafeReason });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function boundedMigrationFileBytes(
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

async function syncDirectory(
  directory: string,
  hooks: WorkspaceSessionArtifactMigratorHooks | undefined,
  reason: DirectorySyncReason,
): Promise<void> {
  if (process.platform === 'win32') {
    // Every Windows namespace mutation is already performed by the cwd helper.
    // Win32 pins that cwd for containment, while Node cannot FlushFileBuffers
    // on directory handles. Revalidate the visible directory and preserve the
    // durability hook without turning that documented limitation into failure.
    const opened = await fs.promises.lstat(directory, { bigint: true });
    if (opened.isSymbolicLink() || !opened.isDirectory()) {
      throw Object.assign(new Error('Migration durability target is not a directory'), {
        migrationReason: 'io_error',
      });
    }
    await hooks?.afterDirectorySync?.({ directory, reason });
    return;
  }
  const descriptorRoot = workspaceDescriptorRoot();
  const descriptorRelative = descriptorRoot
    ? path.relative(descriptorRoot, directory)
    : null;
  if (descriptorRelative && /^[0-9]+$/.test(descriptorRelative)) {
    const fd = Number(descriptorRelative);
    await new Promise<void>((resolve, reject) => {
      fs.fsync(fd, (error) => {
        if (error) reject(Object.assign(error, { migrationReason: 'io_error' }));
        else resolve();
      });
    });
    await hooks?.afterDirectorySync?.({ directory, reason });
    return;
  }
  const handle = await fs.promises.open(
    directory,
    fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY,
  ).catch((error: NodeJS.ErrnoException) => {
    throw Object.assign(error, { migrationReason: 'io_error' });
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()) {
      throw Object.assign(new Error('Migration durability target is not a directory'), {
        migrationReason: 'io_error',
      });
    }
    await handle.sync();
    await hooks?.afterDirectorySync?.({ directory, reason });
  } finally {
    await handle.close();
  }
}

async function removeTemporaryAndSync(
  temporary: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const existed = await lstatOrNull(temporary).catch(() => null);
  await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  if (existed) {
    await syncDirectory(path.dirname(temporary), hooks, 'temporary_cleanup');
  }
}

function sameDirectoryIdentity(left: BigFileStat, right: BigFileStat): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino !== 0n
    && left.ino === right.ino;
}

function unsafePinnedLegacyDirectory(message: string): Error {
  return Object.assign(new Error(message), { migrationReason: 'unsafe_legacy_storage' });
}

function openPinnedLegacyRoot(canonicalPath: string): PinnedLegacyDirectoryLease {
  try {
    return openCanonicalDirectoryLeaseSync(canonicalPath);
  } catch (error) {
    throw Object.assign(error as object, { migrationReason: 'unsafe_legacy_storage' });
  }
}

function openPinnedLegacyChild(
  parent: PinnedLegacyDirectoryLease,
  component: string,
): PinnedLegacyDirectoryLease | null {
  parent.verify();
  safeComponent(component, 'legacy directory component');
  const canonicalPath = path.join(parent.canonicalPath, component);
  const lookupPath = path.join(parent.accessPath, component);
  let helperIdentity: { dev: bigint; ino: bigint } | undefined;
  let visible: BigFileStat | undefined;
  if (parent.entryMutationPolicy === 'cwd-helper') {
    try {
      helperIdentity = inspectWorkspaceCwdDirectory(parent, component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  } else {
    try {
      visible = fs.lstatSync(canonicalPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (visible.isSymbolicLink() || !visible.isDirectory()) {
      throw unsafePinnedLegacyDirectory('Legacy storage component is not a real directory');
    }
  }
  const fd = fs.openSync(lookupPath, fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY);
  const descriptorRoot = workspaceDescriptorRoot();
  const accessPath = descriptorRoot ? path.join(descriptorRoot, String(fd)) : canonicalPath;
  let closed = false;
  const verify = (): void => {
    if (closed) throw unsafePinnedLegacyDirectory('Legacy storage descriptor is closed');
    parent.verify();
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(canonicalPath, { bigint: true });
    if (
      current.isSymbolicLink()
      || fs.realpathSync(canonicalPath) !== canonicalPath
      || (helperIdentity
        ? opened.dev !== helperIdentity.dev || opened.ino !== helperIdentity.ino
        : !sameDirectoryIdentity(visible!, opened))
      || !sameDirectoryIdentity(opened, current)
      || (accessPath !== canonicalPath && fs.realpathSync(accessPath) !== canonicalPath)
    ) {
      throw unsafePinnedLegacyDirectory('Legacy storage component changed while pinned');
    }
  };
  try {
    verify();
    return {
      canonicalPath,
      accessPath,
      fd,
      pathFallback: accessPath === canonicalPath,
      entryMutationPolicy: parent.entryMutationPolicy,
      verify,
      close(): void {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    closed = true;
    fs.closeSync(fd);
    throw error;
  }
}

function pinFixedArtifactDefinitions(
  legacyRoot: string,
  definitions: ArtifactPaths[],
): PinnedFixedArtifactPlan {
  const leases: PinnedLegacyDirectoryLease[] = [];
  const cache = new Map<string, PinnedLegacyDirectoryLease | null>();
  try {
    const root = openPinnedLegacyRoot(legacyRoot);
    leases.push(root);
    cache.set(legacyRoot, root);

    const openDirectory = (canonicalDirectory: string): PinnedLegacyDirectoryLease | null => {
      const cached = cache.get(canonicalDirectory);
      if (cached !== undefined || cache.has(canonicalDirectory)) return cached ?? null;
      const relative = path.relative(legacyRoot, canonicalDirectory);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw unsafePinnedLegacyDirectory('Legacy artifact parent leaves the pinned root');
      }
      let current: PinnedLegacyDirectoryLease | null = root;
      let canonicalCursor = legacyRoot;
      for (const component of relative.split(path.sep).filter(Boolean)) {
        canonicalCursor = path.join(canonicalCursor, component);
        const known = cache.get(canonicalCursor);
        if (known !== undefined || cache.has(canonicalCursor)) {
          current = known ?? null;
          if (!current) break;
          continue;
        }
        if (!current) {
          cache.set(canonicalCursor, null);
          continue;
        }
        const child = openPinnedLegacyChild(current, component);
        cache.set(canonicalCursor, child);
        if (child) leases.push(child);
        current = child;
      }
      return current;
    };

    return {
      definitions: definitions.map((definition) => {
        const canonicalParent = path.dirname(definition.source);
        const parent = openDirectory(canonicalParent);
        if (!parent) return { ...definition, sourceDirectoryMissing: true };
        const source = path.join(parent.accessPath, path.basename(definition.source));
        return {
          ...definition,
          source,
          sourceRoot: parent.accessPath,
          backup: backupPath(source),
          sourceLease: parent,
          verifySourceDirectory: parent.verify,
        };
      }),
      leases,
    };
  } catch (error) {
    for (const lease of leases.reverse()) lease.close();
    throw error;
  }
}

async function fingerprintHandle(
  handle: fs.promises.FileHandle,
  maximumBytes?: number,
  unsafeReason: LegacyArtifactBlockReason = 'unsafe_source',
): Promise<Fingerprint> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let offset = 0;

  for (;;) {
    const remaining = maximumBytes === undefined
      ? chunk.length
      : Math.min(chunk.length, maximumBytes + 1 - offset);
    if (remaining <= 0) {
      throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
        migrationReason: unsafeReason,
      });
    }
    const { bytesRead } = await handle.read(chunk, 0, remaining, offset);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
    if (maximumBytes !== undefined && offset > maximumBytes) {
      throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
        migrationReason: unsafeReason,
      });
    }
  }

  return { bytes: offset, sha256: hash.digest('hex') };
}

async function fingerprintFile(
  target: string,
  unsafeReason: LegacyArtifactBlockReason,
  expectedLinks?: bigint,
  maximumBytes?: number,
): Promise<Fingerprint> {
  const stat = await lstatOrNull(target);
  if (
    !stat
    || stat.isSymbolicLink()
    || !stat.isFile()
    || (expectedLinks !== undefined && stat.nlink !== expectedLinks)
    || (maximumBytes !== undefined && stat.size > BigInt(maximumBytes))
  ) {
    throw Object.assign(new Error('Expected a regular file'), { migrationReason: unsafeReason });
  }
  const handle = await fs.promises.open(target, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
    throw Object.assign(error, { migrationReason: unsafeReason });
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || !sameFileIdentity(stat, before)
      || (expectedLinks !== undefined && before.nlink !== expectedLinks)
      || (maximumBytes !== undefined && before.size > BigInt(maximumBytes))
    ) {
      throw Object.assign(new Error('Expected a regular file'), { migrationReason: unsafeReason });
    }
    const fingerprint = await fingerprintHandle(handle, maximumBytes, unsafeReason);
    const after = await handle.stat({ bigint: true });
    const visibleAfter = await lstatOrNull(target);
    if (
      !visibleAfter
      || visibleAfter.isSymbolicLink()
      || !visibleAfter.isFile()
      || !sameFileIdentity(after, visibleAfter)
      || !stableFile(before, after)
      || !stableFile(after, visibleAfter)
      || (expectedLinks !== undefined
        && (after.nlink !== expectedLinks || visibleAfter.nlink !== expectedLinks))
      || (maximumBytes !== undefined
        && (after.size > BigInt(maximumBytes) || visibleAfter.size > BigInt(maximumBytes)))
      || BigInt(fingerprint.bytes) !== after.size
    ) {
      throw Object.assign(new Error('File changed while it was being read'), {
        migrationReason: unsafeReason === 'unsafe_source' ? 'source_changed' : unsafeReason,
      });
    }
    return fingerprint;
  } finally {
    await handle.close();
  }
}

function controlledPublishTemporaryStem(target: string): string {
  const basename = path.basename(target);
  if (Buffer.byteLength(basename, 'utf8') <= 120) return `.${basename}.ccweb-migrate`;
  return `.ccweb-migrate-${createHash('sha256').update(basename).digest('hex').slice(0, 24)}`;
}

function controlledPublishTemporaryPattern(target: string): RegExp {
  const escaped = controlledPublishTemporaryStem(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-[0-9]+-[a-f0-9]{16}\\.tmp$`);
}

/**
 * Verify a published destination is an isolated inode. The only multi-link
 * state we repair is the exact state left by a crash between link(temp,
 * target) and unlink(temp): one controlled sibling name, the same inode, two
 * links total and byte-identical contents. Anything else is ambiguous and
 * must retain the legacy source.
 */
async function fingerprintPublishedFile(
  target: string,
  unsafeReason: LegacyArtifactBlockReason,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  maximumBytes?: number,
  targetLease?: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify' | 'entryMutationPolicy'>,
): Promise<Fingerprint> {
  const helperLease = targetLease ?? workspaceSessionFileParentLease(target);
  if (helperLease?.entryMutationPolicy === 'cwd-helper') {
    recoverWorkspaceCwdPublication(helperLease, path.basename(target));
    try {
      return fingerprintWorkspaceCwdFile(helperLease, path.basename(target), maximumBytes);
    } catch (error) {
      throw Object.assign(error as object, { migrationReason: unsafeReason });
    }
  }
  const targetStat = await lstatOrNull(target);
  if (
    !targetStat
    || targetStat.isSymbolicLink()
    || !targetStat.isFile()
    || (maximumBytes !== undefined && targetStat.size > BigInt(maximumBytes))
  ) {
    throw Object.assign(new Error('Expected a published regular file'), {
      migrationReason: unsafeReason,
    });
  }
  if (targetStat.nlink === 1n) {
    return fingerprintFile(target, unsafeReason, 1n, maximumBytes);
  }
  if (targetStat.nlink !== 2n) {
    throw Object.assign(new Error('Published file has an ambiguous hard-link count'), {
      migrationReason: unsafeReason,
    });
  }

  const pattern = controlledPublishTemporaryPattern(target);
  const siblingNames = await fs.promises.readdir(path.dirname(target));
  const linkedTemporaries: Array<{ path: string; stat: BigFileStat }> = [];
  for (const name of siblingNames) {
    if (!pattern.test(name)) continue;
    const candidatePath = path.join(path.dirname(target), name);
    const candidate = await lstatOrNull(candidatePath);
    if (
      candidate
      && !candidate.isSymbolicLink()
      && candidate.isFile()
      && sameFileIdentity(targetStat, candidate)
    ) {
      linkedTemporaries.push({ path: candidatePath, stat: candidate });
    }
  }
  if (linkedTemporaries.length !== 1 || linkedTemporaries[0].stat.nlink !== 2n) {
    throw Object.assign(new Error('Published file has no unique controlled crash link'), {
      migrationReason: unsafeReason,
    });
  }

  const linkedTemporary = linkedTemporaries[0];
  const targetFingerprint = await fingerprintFile(target, unsafeReason, 2n, maximumBytes);
  const temporaryFingerprint = await fingerprintFile(
    linkedTemporary.path,
    unsafeReason,
    2n,
    maximumBytes,
  );
  if (!sameFingerprint(targetFingerprint, temporaryFingerprint)) {
    throw Object.assign(new Error('Controlled crash link differs from its target'), {
      migrationReason: unsafeReason,
    });
  }

  await fs.promises.unlink(linkedTemporary.path);
  await syncDirectory(path.dirname(linkedTemporary.path), hooks, 'temporary_cleanup');
  const isolated = await lstatOrNull(target);
  if (
    !isolated
    || !isolated.isFile()
    || isolated.isSymbolicLink()
    || isolated.nlink !== 1n
    || !sameFileIdentity(targetStat, isolated)
  ) {
    throw Object.assign(new Error('Published file was not isolated after crash recovery'), {
      migrationReason: unsafeReason,
    });
  }
  const isolatedFingerprint = await fingerprintFile(target, unsafeReason, 1n, maximumBytes);
  if (!sameFingerprint(targetFingerprint, isolatedFingerprint)) {
    throw Object.assign(new Error('Published file changed during crash recovery'), {
      migrationReason: unsafeReason,
    });
  }
  return isolatedFingerprint;
}

async function assertSafeDirectoryTree(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Path leaves legacy storage'), {
      migrationReason: 'unsafe_source',
    });
  }

  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw Object.assign(new Error('Unsafe legacy storage component'), {
        migrationReason: 'unsafe_source',
      });
    }
  }
}

async function writeAll(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (result.bytesWritten <= 0) throw new Error('Short write while migrating an artifact');
    written += result.bytesWritten;
  }
}

/**
 * Copy into the destination directory, then publish with a no-clobber hard
 * link. The link gives the same crash property as a temp-file rename (readers
 * see either no file or the complete file) while also refusing to overwrite a
 * target which appeared after the caller's conflict check. Source and temp are
 * never on different filesystems because the temp is a sibling of the target.
 */
async function copyAndPublish(
  sourceHandle: fs.promises.FileHandle,
  sourceBefore: BigFileStat,
  target: string,
  unsafeReason: LegacyArtifactBlockReason,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  maximumBytes?: number,
  targetLease?: ArtifactDirectoryLease,
  sourceLease?: WorkspaceStorageDirectoryLease,
  sourceName?: string,
): Promise<Fingerprint> {
  const helperLease = targetLease ?? workspaceSessionFileParentLease(target) ?? undefined;
  if (helperLease?.entryMutationPolicy === 'cwd-helper') {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    publishNewLargeWorkspaceCwdFile(helperLease, path.basename(target), (writeTargetChunk) => {
      for (;;) {
        const remaining = maximumBytes === undefined
          ? chunk.length
          : Math.min(chunk.length, maximumBytes + 1 - offset);
        if (remaining <= 0) throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
          migrationReason: unsafeReason,
        });
        let bytesRead: number;
        if (sourceLease?.entryMutationPolicy === 'cwd-helper') {
          if (!sourceName) throw Object.assign(new Error('Portable migration source name is missing'), {
            migrationReason: 'unsafe_source',
          });
          const result = readWorkspaceCwdFile(
            sourceLease,
            sourceName,
            offset,
            remaining,
            { dev: sourceBefore.dev, ino: sourceBefore.ino },
          );
          const bytes = Buffer.from(result.data, 'base64');
          if (
            bytes.length > remaining
            || bytes.toString('base64') !== result.data
            || result.dev !== sourceBefore.dev
            || result.ino !== sourceBefore.ino
            || BigInt(result.size) !== sourceBefore.size
            || result.nlink === undefined || BigInt(result.nlink) !== sourceBefore.nlink
            || result.mtimeNs === undefined || BigInt(result.mtimeNs) !== sourceBefore.mtimeNs
            || result.ctimeNs === undefined || BigInt(result.ctimeNs) !== sourceBefore.ctimeNs
          ) {
            throw Object.assign(new Error('Portable migration source changed while it was copied'), {
              migrationReason: 'source_changed',
            });
          }
          bytes.copy(chunk, 0);
          bytesRead = bytes.length;
        } else {
          bytesRead = fs.readSync(sourceHandle.fd, chunk, 0, remaining, offset);
        }
        if (bytesRead === 0) break;
        writeTargetChunk(chunk.subarray(0, bytesRead), offset);
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
        if (maximumBytes !== undefined && offset > maximumBytes) {
          throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
            migrationReason: unsafeReason,
          });
        }
      }
      let sourceStayedStable: boolean;
      let sourceAfterSize: bigint;
      if (sourceLease?.entryMutationPolicy === 'cwd-helper') {
        const sourceAfter = statWorkspaceCwdFile(
          sourceLease,
          sourceName!,
          { dev: sourceBefore.dev, ino: sourceBefore.ino },
        );
        sourceAfterSize = BigInt(sourceAfter.size);
        sourceStayedStable = sourceAfter.mtimeNs !== undefined
          && sourceAfter.ctimeNs !== undefined
          && sourceAfter.dev === sourceBefore.dev
          && sourceAfter.ino === sourceBefore.ino
          && sourceAfterSize === sourceBefore.size
          && BigInt(sourceAfter.nlink) === sourceBefore.nlink
          && BigInt(sourceAfter.mtimeNs) === sourceBefore.mtimeNs
          && BigInt(sourceAfter.ctimeNs) === sourceBefore.ctimeNs;
      } else {
        const sourceAfter = fs.fstatSync(sourceHandle.fd, { bigint: true });
        sourceAfterSize = sourceAfter.size;
        sourceStayedStable = stableFile(sourceBefore, sourceAfter);
      }
      if (!sourceStayedStable || BigInt(offset) !== sourceAfterSize) {
        throw Object.assign(new Error('Source changed while it was copied'), {
          migrationReason: 'source_changed',
        });
      }
    });
    const expected = { bytes: offset, sha256: hash.digest('hex') };
    const published = await fingerprintPublishedFile(target, unsafeReason, hooks, maximumBytes, helperLease);
    if (!sameFingerprint(expected, published)) throw Object.assign(
      new Error('Published file changed before isolation'), { migrationReason: unsafeReason },
    );
    return published;
  }
  const temporary = path.join(
    path.dirname(target),
    `${controlledPublishTemporaryStem(target)}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let tempHandle: fs.promises.FileHandle | null = null;
  try {
    tempHandle = await fs.promises.open(temporary, WRITE_FLAGS, 0o600);
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const remaining = maximumBytes === undefined
        ? chunk.length
        : Math.min(chunk.length, maximumBytes + 1 - offset);
      if (remaining <= 0) {
        throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
          migrationReason: unsafeReason,
        });
      }
      const { bytesRead } = await sourceHandle.read(chunk, 0, remaining, offset);
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      await writeAll(tempHandle, slice, offset);
      hash.update(slice);
      offset += bytesRead;
      if (maximumBytes !== undefined && offset > maximumBytes) {
        throw Object.assign(new Error('Migration artifact exceeds its per-file limit'), {
          migrationReason: unsafeReason,
        });
      }
    }
    await tempHandle.sync();
    const tempStat = await tempHandle.stat({ bigint: true });
    const sourceAfter = await sourceHandle.stat({ bigint: true });
    if (
      !stableFile(sourceBefore, sourceAfter)
      || BigInt(offset) !== sourceAfter.size
      || tempStat.size !== sourceAfter.size
    ) {
      throw Object.assign(new Error('Source changed while it was copied'), {
        migrationReason: 'source_changed',
      });
    }
    await tempHandle.close();
    tempHandle = null;

    // link(2) is the portable no-replace publication primitive exposed by
    // Node. It cannot expose a partially-written destination and returns
    // EEXIST instead of replacing a concurrent target.
    await fs.promises.link(temporary, target);
    const linkedTemporaryStat = await lstatOrNull(temporary);
    const linkedTargetStat = await lstatOrNull(target);
    if (
      !linkedTemporaryStat
      || !linkedTargetStat
      || linkedTemporaryStat.nlink !== 2n
      || linkedTargetStat.nlink !== 2n
      || !sameFileIdentity(linkedTemporaryStat, linkedTargetStat)
    ) {
      throw Object.assign(new Error('Published hard link is ambiguous'), {
        migrationReason: unsafeReason,
      });
    }
    const expected = { bytes: offset, sha256: hash.digest('hex') };
    const linkedFingerprint = await fingerprintFile(target, unsafeReason, 2n, maximumBytes);
    if (!sameFingerprint(expected, linkedFingerprint)) {
      throw Object.assign(new Error('Published hard link differs from copied bytes'), {
        migrationReason: unsafeReason,
      });
    }
    await fs.promises.unlink(temporary);
    await syncDirectory(path.dirname(target), hooks, 'publish');
    const published = await fingerprintPublishedFile(target, unsafeReason, hooks, maximumBytes);
    if (!sameFingerprint(expected, published)) {
      throw Object.assign(new Error('Published file changed before isolation'), {
        migrationReason: unsafeReason,
      });
    }
    return published;
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => undefined);
    await removeTemporaryAndSync(temporary, hooks).catch(() => undefined);
  }
}

function fingerprintBuffer(buffer: Buffer): Fingerprint {
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** Publish generated metadata with the same no-clobber and fsync rules as copied files. */
async function publishBuffer(
  buffer: Buffer,
  target: string,
  unsafeReason: LegacyArtifactBlockReason,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  targetLease?: ArtifactDirectoryLease,
): Promise<Fingerprint> {
  const helperLease = targetLease ?? workspaceSessionFileParentLease(target) ?? undefined;
  if (helperLease?.entryMutationPolicy === 'cwd-helper') {
    publishNewWorkspaceCwdFile(helperLease, path.basename(target), buffer);
    const expected = fingerprintBuffer(buffer);
    const published = await fingerprintPublishedFile(target, unsafeReason, hooks, undefined, helperLease);
    if (!sameFingerprint(expected, published)) throw Object.assign(
      new Error('Generated artifact changed before isolation'), { migrationReason: unsafeReason },
    );
    return published;
  }
  const temporary = path.join(
    path.dirname(target),
    `${controlledPublishTemporaryStem(target)}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, WRITE_FLAGS, 0o600);
    await writeAll(handle, buffer, 0);
    await handle.sync();
    const temporaryStat = await handle.stat({ bigint: true });
    if (!temporaryStat.isFile() || temporaryStat.size !== BigInt(buffer.length)) {
      throw Object.assign(new Error('Generated migration artifact was truncated'), {
        migrationReason: unsafeReason,
      });
    }
    await handle.close();
    handle = null;

    await fs.promises.link(temporary, target);
    const linkedTemporary = await lstatOrNull(temporary);
    const linkedTarget = await lstatOrNull(target);
    if (
      !linkedTemporary
      || !linkedTarget
      || linkedTemporary.nlink !== 2n
      || linkedTarget.nlink !== 2n
      || !sameFileIdentity(linkedTemporary, linkedTarget)
    ) {
      throw Object.assign(new Error('Published generated artifact is ambiguous'), {
        migrationReason: unsafeReason,
      });
    }
    const expected = fingerprintBuffer(buffer);
    const linkedFingerprint = await fingerprintFile(target, unsafeReason, 2n);
    if (!sameFingerprint(expected, linkedFingerprint)) {
      throw Object.assign(new Error('Published generated artifact differs from its bytes'), {
        migrationReason: unsafeReason,
      });
    }
    await fs.promises.unlink(temporary);
    await syncDirectory(path.dirname(target), hooks, 'publish');
    const published = await fingerprintPublishedFile(target, unsafeReason, hooks);
    if (!sameFingerprint(expected, published)) {
      throw Object.assign(new Error('Generated artifact changed before isolation'), {
        migrationReason: unsafeReason,
      });
    }
    return published;
  } finally {
    await handle?.close().catch(() => undefined);
    await removeTemporaryAndSync(temporary, hooks).catch(() => undefined);
  }
}

function artifactDefinitions(
  legacyRoot: string,
  owner: string,
  id: string,
  targetDir: string,
  canonicalTargetDir = targetDir,
): ArtifactPaths[] {
  const chatBase = path.join(legacyRoot, owner, id);
  const transcriptBase = path.join(legacyRoot, 'transcripts', owner, id);
  const historyBase = path.join(legacyRoot, 'history', owner, id);
  const pasteBase = path.join(legacyRoot, 'pastes', owner, id);
  const definitions: Array<Pick<ArtifactPaths, 'artifact' | 'source' | 'target' | 'canonicalTarget'>> = [
    { artifact: 'chat_log', source: `${chatBase}.jsonl`, target: path.join(targetDir, 'chat.jsonl'), canonicalTarget: path.join(canonicalTargetDir, 'chat.jsonl') },
    { artifact: 'chat_index', source: `${chatBase}.idx`, target: path.join(targetDir, 'chat.idx'), canonicalTarget: path.join(canonicalTargetDir, 'chat.idx') },
    { artifact: 'chat_snapshot', source: `${chatBase}.snapshot`, target: path.join(targetDir, 'chat.snapshot'), canonicalTarget: path.join(canonicalTargetDir, 'chat.snapshot') },
    { artifact: 'chat_snapshot_json', source: `${chatBase}.snapshot.json`, target: path.join(targetDir, 'chat.snapshot.json'), canonicalTarget: path.join(canonicalTargetDir, 'chat.snapshot.json') },
    { artifact: 'chat_opening_context', source: `${chatBase}.ctx`, target: path.join(targetDir, 'chat.ctx'), canonicalTarget: path.join(canonicalTargetDir, 'chat.ctx') },
    { artifact: 'chat_plan', source: `${chatBase}.plan`, target: path.join(targetDir, 'chat.plan'), canonicalTarget: path.join(canonicalTargetDir, 'chat.plan') },
    { artifact: 'transcript', source: `${transcriptBase}.md`, target: path.join(targetDir, 'transcript.md'), canonicalTarget: path.join(canonicalTargetDir, 'transcript.md') },
    { artifact: 'history_log', source: `${historyBase}.log`, target: path.join(targetDir, 'history.log'), canonicalTarget: path.join(canonicalTargetDir, 'history.log') },
    { artifact: 'history_index', source: `${historyBase}.idx`, target: path.join(targetDir, 'history.idx'), canonicalTarget: path.join(canonicalTargetDir, 'history.idx') },
    { artifact: 'paste_manifest', source: `${pasteBase}.json`, target: path.join(targetDir, 'paste-manifest.json'), canonicalTarget: path.join(canonicalTargetDir, 'paste-manifest.json') },
  ];
  return definitions.map((definition) => ({
    ...definition,
    key: definition.artifact,
    sourceRoot: legacyRoot,
    // A deterministic sibling backup makes an interrupted multi-file cleanup
    // recoverable even when the workspace target is temporarily unavailable.
    backup: path.join(
      path.dirname(definition.source),
      `.${path.basename(definition.source)}.ccweb-session-migration.bak`,
    ),
  }));
}

interface PasteManifestEntry {
  path: string;
  root: string;
  bytes: number;
}

interface PasteManifest {
  version: 1;
  entries: PasteManifestEntry[];
}

interface BinaryArtifactPlan {
  definitions: ArtifactPaths[];
  leases: WorkspaceStorageDirectoryLease[];
}

function backupPath(source: string): string {
  const basename = path.basename(source);
  const backupName = Buffer.byteLength(basename, 'utf8') <= 180
    ? `.${basename}.ccweb-session-migration.bak`
    : `.ccweb-session-migration-${createHash('sha256').update(basename).digest('hex').slice(0, 32)}.bak`;
  return path.join(
    path.dirname(source),
    backupName,
  );
}

function dynamicArtifactKey(kind: 'attachment_file' | 'paste_file', source: string): string {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 24);
  return `${kind}:${digest}:${path.basename(source)}`;
}

function distinctLegacyWorkspaceRoots(
  ref: LegacySessionMigrationRef,
  canonicalRoot: string,
): string[] {
  const roots = new Set([canonicalRoot]);
  if (
    ref.projectWorkingDirKind !== 'container'
    && typeof ref.workingDir === 'string'
    && path.isAbsolute(ref.workingDir)
  ) {
    const workingDir = path.resolve(ref.workingDir);
    const relative = path.relative(canonicalRoot, workingDir);
    const secondaryIsConfined = !path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`);
    if (workingDir !== path.parse(workingDir).root && secondaryIsConfined) {
      roots.add(workingDir);
    }
  }
  const result = [...roots];
  if (result.length > MAX_LEGACY_WORKSPACE_ROOTS) {
    throw Object.assign(new Error('Legacy session names too many authorised workspace roots'), {
      migrationReason: 'unsafe_source',
    });
  }
  return result;
}

async function assertCanonicalSourceRoot(root: string): Promise<'available' | 'absent'> {
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw Object.assign(new Error('Unsafe legacy workspace root'), {
      migrationReason: 'unsafe_source',
    });
  }
  let lease: WorkspaceStorageDirectoryLease;
  try {
    lease = openCanonicalDirectoryLeaseSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw Object.assign(error as object, { migrationReason: 'unsafe_source' });
  }
  try { lease.verify(); return 'available'; } finally { lease.close(); }
}

async function readBoundedStableFile(
  target: string,
  maximumBytes: number,
  unsafeReason: LegacyArtifactBlockReason,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  targetLease?: ArtifactDirectoryLease,
): Promise<Buffer | null> {
  const helperLease = targetLease ?? workspaceSessionFileParentLease(target) ?? undefined;
  if (helperLease?.entryMutationPolicy === 'cwd-helper' && unsafeReason === 'unsafe_target') {
    recoverWorkspaceCwdPublication(helperLease, path.basename(target));
  }
  const visible = await leaseAwareFileStatOrNull(target, helperLease, unsafeReason);
  if (!visible) return null;
  if (visible.nlink !== 1n && unsafeReason === 'unsafe_target') {
    await fingerprintPublishedFile(target, unsafeReason, hooks, maximumBytes, helperLease);
    return readBoundedStableFile(target, maximumBytes, unsafeReason, hooks, helperLease);
  }
  if (
    visible.isSymbolicLink()
    || !visible.isFile()
    || visible.nlink !== 1n
    || visible.size > BigInt(maximumBytes)
  ) {
    throw Object.assign(new Error('Expected a bounded regular migration source'), {
      migrationReason: unsafeReason,
    });
  }
  const handle = helperLease?.entryMutationPolicy === 'cwd-helper'
    ? openWorkspaceCwdFileForRead(helperLease, path.basename(target))
    : await fs.promises.open(target, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(error, { migrationReason: unsafeReason });
    });
  try {
    const before = await handle.stat({ bigint: true });
    if (
      before.nlink !== 1n
      || !sameFileIdentity(visible, before)
      || !stableFile(visible, before)
    ) {
      throw Object.assign(new Error('Migration source changed while opening'), {
        migrationReason: unsafeReason,
      });
    }
    // A hostile writer can grow the file after the bounded stat. Read through
    // a fixed cap + 1 window so growth is detected without allowing readFile()
    // to allocate from the new size.
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const visibleAfter = await leaseAwareFileStatOrNull(target, helperLease, unsafeReason);
    if (
      offset > maximumBytes
      || offset !== Number(before.size)
      || !visibleAfter
      || !sameFileIdentity(after, visibleAfter)
      || !stableFile(before, after)
      || !stableFile(after, visibleAfter)
      || after.nlink !== 1n
      || visibleAfter.nlink !== 1n
    ) {
      throw Object.assign(new Error('Migration source changed while reading'), {
        migrationReason: unsafeReason === 'unsafe_source' ? 'source_changed' : unsafeReason,
      });
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function attachmentNameFromUrl(url: unknown, sessionId: string): string | null {
  if (typeof url !== 'string') return null;
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/`;
  if (!url.startsWith(prefix)) return null;
  const encoded = url.slice(prefix.length);
  if (!encoded || encoded.includes('/') || encoded.includes('?') || encoded.includes('#')) return null;
  try {
    const name = decodeURIComponent(encoded);
    if (!STORED_ATTACHMENT_NAME.test(name) || encodeURIComponent(name) !== encoded) return null;
    return name;
  } catch {
    return null;
  }
}

async function collectAttachmentReferencesFromFile(
  target: string,
  sessionId: string,
  names: Set<string>,
  unsafeReason: LegacyArtifactBlockReason,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  targetLease?: ArtifactDirectoryLease,
): Promise<void> {
  const helperLease = targetLease ?? workspaceSessionFileParentLease(target) ?? undefined;
  if (helperLease?.entryMutationPolicy === 'cwd-helper' && unsafeReason === 'unsafe_target') {
    recoverWorkspaceCwdPublication(helperLease, path.basename(target));
  }
  const visible = await leaseAwareFileStatOrNull(target, helperLease, unsafeReason);
  if (!visible) return;
  if (visible.nlink !== 1n && unsafeReason === 'unsafe_target') {
    await fingerprintPublishedFile(target, unsafeReason, hooks, undefined, helperLease);
    return collectAttachmentReferencesFromFile(
      target,
      sessionId,
      names,
      unsafeReason,
      hooks,
      helperLease,
    );
  }
  if (visible.isSymbolicLink() || !visible.isFile() || visible.nlink !== 1n) {
    throw Object.assign(new Error('Unsafe attachment-reference source'), {
      migrationReason: unsafeReason,
    });
  }
  const handle = helperLease?.entryMutationPolicy === 'cwd-helper'
    ? openWorkspaceCwdFileForRead(helperLease, path.basename(target))
    : await fs.promises.open(target, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(error, { migrationReason: unsafeReason });
    });
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/`;
  const overlap = prefix.length + 140;
  const chunk = Buffer.alloc(64 * 1024);
  let carry = '';
  let offset = 0;
  try {
    const before = await handle.stat({ bigint: true });
    if (
      before.nlink !== 1n
      || !sameFileIdentity(visible, before)
      || !stableFile(visible, before)
    ) {
      throw Object.assign(new Error('Attachment-reference source changed while opening'), {
        migrationReason: unsafeReason,
      });
    }
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      const text = carry + chunk.toString('latin1', 0, bytesRead);
      let cursor = 0;
      for (;;) {
        const found = text.indexOf(prefix, cursor);
        if (found < 0) break;
        const tail = text.slice(found + prefix.length);
        const match = /^[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}/.exec(tail);
        if (match && STORED_ATTACHMENT_NAME.test(match[0]) && !names.has(match[0])) {
          if (names.size >= MAX_ATTACHMENT_FILES) {
            throw Object.assign(new Error('Legacy attachment reference count exceeds its bound'), {
              migrationReason: 'unsafe_source',
            });
          }
          names.add(match[0]);
        }
        cursor = found + prefix.length;
      }
      carry = text.slice(-overlap);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const visibleAfter = await leaseAwareFileStatOrNull(target, helperLease, unsafeReason);
    if (
      !visibleAfter
      || !sameFileIdentity(after, visibleAfter)
      || !stableFile(before, after)
      || !stableFile(after, visibleAfter)
      || after.nlink !== 1n
      || visibleAfter.nlink !== 1n
    ) {
      throw Object.assign(new Error('Attachment-reference source changed while reading'), {
        migrationReason: unsafeReason === 'unsafe_source' ? 'source_changed' : unsafeReason,
      });
    }
  } finally {
    await handle.close();
  }
}

async function namespacedAttachmentNames(
  workspaceRoot: string,
  ownerNamespace: string,
  sessionId: string,
): Promise<string[]> {
  let lease: WorkspaceStorageDirectoryLease;
  try {
    lease = openWorkspaceAttachmentDirectorySync(
      workspaceRoot,
      ownerNamespace,
      sessionId,
      { createIfMissing: false },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      migrationReason: 'unsafe_source',
    });
  }
  const names: string[] = [];
  let scanned = 0;
  try {
    lease.verify();
    if (lease.entryMutationPolicy === 'cwd-helper') {
      const entries = listWorkspaceCwdEntries(lease);
      scanned = entries.length;
      if (scanned > MAX_ATTACHMENT_DIRECTORY_ENTRIES) {
        throw Object.assign(new Error('Legacy attachment directory exceeds its scan bound'), {
          migrationReason: 'unsafe_source',
        });
      }
      for (const entry of entries) {
        if (entry.type !== 'file' || !STORED_ATTACHMENT_NAME.test(entry.name)) continue;
        names.push(entry.name);
        if (names.length > MAX_ATTACHMENT_FILES) {
          throw Object.assign(new Error('Legacy attachment namespace exceeds its bound'), {
            migrationReason: 'unsafe_source',
          });
        }
      }
      lease.verify();
      return names;
    }
    const opened = await fs.promises.opendir(lease.accessPath);
    try {
      for await (const entry of opened) {
        scanned += 1;
        if (scanned > MAX_ATTACHMENT_DIRECTORY_ENTRIES) {
          throw Object.assign(new Error('Legacy attachment directory exceeds its scan bound'), {
            migrationReason: 'unsafe_source',
          });
        }
        if (!STORED_ATTACHMENT_NAME.test(entry.name)) continue;
        names.push(entry.name);
        if (names.length > MAX_ATTACHMENT_FILES) {
          throw Object.assign(new Error('Legacy attachment namespace exceeds its bound'), {
            migrationReason: 'unsafe_source',
          });
        }
      }
    } finally {
      await opened.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    lease.verify();
  } finally {
    lease.close();
  }
  return names;
}

function parsePasteManifest(buffer: Buffer): PasteManifest {
  let parsed: Partial<PasteManifest>;
  try {
    parsed = JSON.parse(buffer.toString('utf8')) as Partial<PasteManifest>;
  } catch (error) {
    throw Object.assign(new Error('Legacy paste manifest is not valid JSON'), {
      cause: error,
      migrationReason: 'unsafe_source',
    });
  }
  if (
    parsed.version !== 1
    || !Array.isArray(parsed.entries)
    || parsed.entries.length > MAX_PASTE_MANIFEST_ENTRIES
  ) {
    throw Object.assign(new Error('Legacy paste manifest has an unsupported shape'), {
      migrationReason: 'unsafe_source',
    });
  }
  const entries: PasteManifestEntry[] = [];
  let sessionBytes = 0;
  for (const value of parsed.entries) {
    if (
      !value
      || typeof value.path !== 'string'
      || typeof value.root !== 'string'
      || !Number.isSafeInteger(value.bytes)
      || value.bytes < 0
      || value.bytes > DEFAULT_MAX_PASTE_BYTES
      || !path.isAbsolute(value.path)
      || !path.isAbsolute(value.root)
    ) {
      throw Object.assign(new Error('Legacy paste manifest contains an invalid entry'), {
        migrationReason: 'unsafe_source',
      });
    }
    if (value.bytes > DEFAULT_PASTE_SESSION_QUOTA_BYTES - sessionBytes) {
      throw Object.assign(new Error('Legacy paste manifest exceeds the session quota'), {
        migrationReason: 'unsafe_source',
      });
    }
    sessionBytes += value.bytes;
    const root = path.resolve(value.root);
    const source = path.resolve(value.path);
    const name = path.basename(source);
    if (
      value.root !== root
      || value.path !== source
      || path.dirname(source) !== root
      || path.basename(root) !== 'pasted'
      || path.basename(path.dirname(root)) !== '.cc-web'
      || !PASTED_IMAGE_NAME.test(name)
    ) {
      throw Object.assign(new Error('Legacy paste manifest entry leaves its paste root'), {
        migrationReason: 'unsafe_source',
      });
    }
    entries.push({ path: source, root, bytes: value.bytes });
  }
  return { version: 1, entries };
}

async function sourceOrBackup(definition: ArtifactPaths): Promise<string | null> {
  if (definition.sourceDirectoryMissing) return null;
  definition.verifySourceDirectory?.();
  await recoverLegacyRetirement(definition, definition.source);
  await recoverLegacyRetirement(definition, definition.backup);
  if (await leaseAwareFileStatOrNull(
    definition.source,
    definition.sourceLease,
    'unsafe_source',
  )) return definition.source;
  const backup = definition.backup;
  return await leaseAwareFileStatOrNull(backup, definition.sourceLease, 'unsafe_source')
    ? backup
    : null;
}

async function buildBinaryArtifactPlan(
  ref: LegacySessionMigrationRef,
  fixed: ArtifactPaths[],
  canonicalRoot: string,
  ownerKey: string,
  sessionId: string,
  createTargets: boolean,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<BinaryArtifactPlan> {
  const leases: WorkspaceStorageDirectoryLease[] = [];
  try {
    const roots = distinctLegacyWorkspaceRoots(ref, canonicalRoot);
    for (const root of roots) {
      const state = await assertCanonicalSourceRoot(root);
      if (state === 'absent' && root === canonicalRoot) {
        throw Object.assign(new Error('Canonical workspace disappeared during migration'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
    }

    const attachmentNames = new Set<string>();
    const draftAttachments = ref.chatDraft?.attachments ?? [];
    if (draftAttachments.length > MAX_ATTACHMENT_FILES) {
      throw Object.assign(new Error('Legacy draft attachment count exceeds its bound'), {
        migrationReason: 'unsafe_source',
      });
    }
    for (const attachment of draftAttachments) {
      const name = attachmentNameFromUrl(attachment.url, sessionId);
      if (name) attachmentNames.add(name);
    }
    if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
      throw Object.assign(new Error('Legacy attachment reference count exceeds its bound'), {
        migrationReason: 'unsafe_source',
      });
    }
    const referenceArtifacts = new Set<LegacySessionArtifact>([
      'chat_log',
      'chat_snapshot',
      'chat_snapshot_json',
      'chat_opening_context',
      'chat_plan',
      'transcript',
    ]);
    for (const definition of fixed) {
      if (!referenceArtifacts.has(definition.artifact)) continue;
      const legacyReference = await sourceOrBackup(definition);
      if (legacyReference) {
        await collectAttachmentReferencesFromFile(
          legacyReference,
          sessionId,
          attachmentNames,
          'unsafe_source',
          hooks,
          definition.sourceLease,
        );
      }
      await collectAttachmentReferencesFromFile(
        definition.target,
        sessionId,
        attachmentNames,
        'unsafe_target',
        hooks,
        definition.targetLease,
      );
      if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
        throw Object.assign(new Error('Legacy attachment reference count exceeds its bound'), {
          migrationReason: 'unsafe_source',
        });
      }
    }

    for (const root of roots) {
      if (await assertCanonicalSourceRoot(root) === 'absent') continue;
      for (const namespace of new Set([ownerKey, String(ref.ownerUserId)])) {
        for (const name of await namespacedAttachmentNames(root, namespace, sessionId)) {
          attachmentNames.add(name);
          if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
            throw Object.assign(new Error('Legacy attachment namespace exceeds its bound'), {
              migrationReason: 'unsafe_source',
            });
          }
        }
      }
    }

    const definitions: ArtifactPaths[] = [];
    let attachmentLease: WorkspaceStorageDirectoryLease | null = null;
    if (attachmentNames.size > 0) {
      attachmentLease = openWorkspaceAttachmentDirectorySync(
        canonicalRoot,
        ownerKey,
        sessionId,
        { createIfMissing: createTargets },
      );
      leases.push(attachmentLease);
    }
    const sourceAttachmentLeases = new Map<string, WorkspaceStorageDirectoryLease>();
    let attachmentSessionBytes = 0;

    for (const name of [...attachmentNames].sort()) {
      const canonicalTarget = path.join(
        canonicalRoot,
        '.cc-web',
        'attachments',
        ownerKey,
        sessionId,
        name,
      );
      const target = path.join(attachmentLease!.accessPath, name);
      const candidates = new Map<string, {
        canonical: string;
        root: string;
        namespace: string | null;
      }>();
      for (const root of roots) {
        const flat = path.join(root, '.cc-web', 'attachments', name);
        candidates.set(flat, { canonical: flat, root, namespace: null });
        for (const namespace of new Set([String(ref.ownerUserId), ownerKey])) {
          const canonical = path.join(
            root,
            '.cc-web',
            'attachments',
            namespace,
            sessionId,
            name,
          );
          candidates.set(canonical, { canonical, root, namespace });
        }
      }
      candidates.delete(canonicalTarget);
      const existingSources: Array<{
        canonical: string;
        source: string;
        sourceRoot: string;
        backup: string;
        lease: WorkspaceStorageDirectoryLease;
        verifySourceDirectory: () => void;
      }> = [];
      for (const candidate of [...candidates.values()].sort(
        (left, right) => left.canonical.localeCompare(right.canonical),
      )) {
        const canonicalDirectory = path.dirname(candidate.canonical);
        let sourceLease = sourceAttachmentLeases.get(canonicalDirectory);
        if (!sourceLease) {
          try {
            sourceLease = candidate.namespace === null
              ? openWorkspaceAttachmentRootDirectorySync(candidate.root, { createIfMissing: false })
              : openWorkspaceAttachmentDirectorySync(
                candidate.root,
                candidate.namespace,
                sessionId,
                { createIfMissing: false },
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (sourceLease.canonicalPath !== canonicalDirectory) {
            sourceLease.close();
            throw Object.assign(new Error('Legacy attachment source did not match its pinned namespace'), {
              migrationReason: 'unsafe_source',
            });
          }
          sourceAttachmentLeases.set(canonicalDirectory, sourceLease);
          leases.push(sourceLease);
        }
        const source = path.join(sourceLease.accessPath, name);
        const backup = backupPath(source);
        const hasAuthority = sourceLease.entryMutationPolicy === 'cwd-helper'
          ? (() => {
            const entries = new Set(listWorkspaceCwdEntries(sourceLease!).map((entry) => entry.name));
            const exactNames = [
              source,
              backup,
              legacyRetirementDirectory(source),
              legacyRetirementDirectory(backup),
            ].map((entry) => path.basename(entry));
            const taggedPrefixes = [path.basename(source), path.basename(backup)]
              .map((entry) => migrationWorkspaceCwdRetirementPrefix(entry));
            return exactNames.some((entry) => entries.has(entry))
              || [...entries].some((entry) => taggedPrefixes.some((prefix) => entry.startsWith(prefix)));
          })()
          : (await lstatOrNull(source)) !== null
            || (await lstatOrNull(backup)) !== null
            || (await lstatOrNull(legacyRetirementDirectory(source))) !== null
            || (await lstatOrNull(legacyRetirementDirectory(backup))) !== null;
        if (!hasAuthority) continue;
        existingSources.push({
          canonical: candidate.canonical,
          source,
          sourceRoot: sourceLease.accessPath,
          backup,
          lease: sourceLease,
          verifySourceDirectory: sourceLease.verify,
        });
      }

      // Quota is defined over logical attachment names. A legacy file may be
      // duplicated across flat/numeric/owner-key layouts, but those aliases
      // must neither multiply quota nor bypass the per-file bound. Inspect all
      // candidate authorities before any of them is hashed or copied, then
      // account the largest candidate exactly once for this name.
      let logicalBytes = 0;
      const targetStat = await leaseAwareFileStatOrNull(target, attachmentLease!, 'unsafe_target');
      if (targetStat) {
        logicalBytes = Math.max(logicalBytes, boundedMigrationFileBytes(
          targetStat,
          DEFAULT_MAX_ATTACHMENT_BYTES,
          'unsafe_target',
        ));
      }
      for (const existing of existingSources) {
        existing.verifySourceDirectory();
        const retirementDefinition: ArtifactPaths = {
          artifact: 'attachment_file',
          key: dynamicArtifactKey('attachment_file', existing.canonical),
          source: existing.source,
          sourceRoot: existing.sourceRoot,
          target,
          canonicalTarget,
          targetLease: attachmentLease!,
          sourceLease: existing.lease,
          backup: existing.backup,
          verifySourceDirectory: existing.verifySourceDirectory,
          required: true,
          maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        };
        // A cold crash may have durably moved the only source or backup into
        // its deterministic retirement directory. Restore that descriptor-
        // pinned authority before quota accounting so it cannot count as zero.
        await recoverLegacyRetirement(retirementDefinition, existing.source, hooks);
        await recoverLegacyRetirement(retirementDefinition, existing.backup, hooks);
        const sourceStat = await leaseAwareFileStatOrNull(
          existing.source,
          existing.lease,
          'unsafe_source',
        );
        const authorityPath = sourceStat ? existing.source : existing.backup;
        const authorityStat = sourceStat ?? await leaseAwareFileStatOrNull(
          authorityPath,
          existing.lease,
          'unsafe_source',
        );
        if (!authorityStat) continue;
        logicalBytes = Math.max(logicalBytes, boundedMigrationFileBytes(
          authorityStat,
          DEFAULT_MAX_ATTACHMENT_BYTES,
          'unsafe_source',
        ));
      }
      if (logicalBytes > DEFAULT_ATTACHMENT_QUOTA_BYTES - attachmentSessionBytes) {
        throw Object.assign(new Error('Legacy attachments exceed the session quota'), {
          migrationReason: 'unsafe_source',
        });
      }
      attachmentSessionBytes += logicalBytes;

      if (existingSources.length === 0) {
        if (await leaseAwareFileStatOrNull(target, attachmentLease!, 'unsafe_target')) {
          definitions.push({
            artifact: 'attachment_file',
            key: dynamicArtifactKey('attachment_file', canonicalTarget),
            source: target,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: attachmentLease!,
            sourceLease: attachmentLease!,
            backup: backupPath(canonicalTarget),
            sourceIsTarget: true,
            required: true,
            maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
          });
        } else {
          const source = path.join(canonicalRoot, '.cc-web', 'attachments', name);
          definitions.push({
            artifact: 'attachment_file',
            key: dynamicArtifactKey('attachment_file', source),
            source,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: attachmentLease!,
            backup: backupPath(source),
            required: true,
            maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
          });
        }
        continue;
      }
      for (const existing of existingSources) {
        definitions.push({
          artifact: 'attachment_file',
          key: dynamicArtifactKey('attachment_file', existing.canonical),
          source: existing.source,
          sourceRoot: existing.sourceRoot,
          target,
          canonicalTarget,
          targetLease: attachmentLease!,
          sourceLease: existing.lease,
          backup: existing.backup,
          verifySourceDirectory: existing.verifySourceDirectory,
          required: true,
          maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        });
      }
    }

    const pasteManifestDefinition = fixed.find((definition) => definition.artifact === 'paste_manifest')!;
    const manifestSource = await sourceOrBackup(pasteManifestDefinition);
    const manifestReadPath = manifestSource
      ?? (await leaseAwareFileStatOrNull(
        pasteManifestDefinition.target,
        pasteManifestDefinition.targetLease,
        'unsafe_target',
      ) ? pasteManifestDefinition.target : null);
    if (manifestReadPath) {
      const manifestIsTarget = manifestReadPath === pasteManifestDefinition.target;
      const manifestBuffer = await readBoundedStableFile(
        manifestReadPath,
        MAX_PASTE_MANIFEST_BYTES,
        manifestIsTarget ? 'unsafe_target' : 'unsafe_source',
        hooks,
        manifestIsTarget
          ? pasteManifestDefinition.targetLease
          : pasteManifestDefinition.sourceLease,
      );
      const manifest = parsePasteManifest(manifestBuffer!);
      let pasteLease: WorkspaceStorageDirectoryLease | null = null;
      if (manifest.entries.length > 0) {
        pasteLease = openWorkspacePasteDirectorySync(canonicalRoot, {
          createIfMissing: createTargets,
        });
        leases.push(pasteLease);
      }
      const canonicalPasteRoot = path.join(canonicalRoot, '.cc-web', 'pasted');
      const normalized: PasteManifest = { version: 1, entries: [] };
      const sourcePasteLeases = new Map<string, WorkspaceStorageDirectoryLease>();
      const seenPasteSources = new Set<string>();
      const seenPasteTargets = new Set<string>();
      for (const entry of manifest.entries) {
        const name = path.basename(entry.path);
        const canonicalTarget = path.join(canonicalPasteRoot, name);
        if (seenPasteSources.has(entry.path) || seenPasteTargets.has(canonicalTarget)) {
          throw Object.assign(new Error('Legacy paste manifest contains a duplicate binary'), {
            migrationReason: 'unsafe_source',
          });
        }
        seenPasteSources.add(entry.path);
        seenPasteTargets.add(canonicalTarget);
        const target = path.join(pasteLease!.accessPath, name);
        normalized.entries.push({ path: canonicalTarget, root: canonicalPasteRoot, bytes: entry.bytes });
        if (entry.path === canonicalTarget) {
          definitions.push({
            artifact: 'paste_file',
            key: dynamicArtifactKey('paste_file', canonicalTarget),
            source: target,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: pasteLease!,
            sourceLease: pasteLease!,
            backup: backupPath(canonicalTarget),
            sourceIsTarget: true,
            required: true,
            expectedSourceBytes: entry.bytes,
            maximumBytes: DEFAULT_MAX_PASTE_BYTES,
          });
          continue;
        }
        const sourceRoot = path.dirname(path.dirname(entry.root));
        if (!roots.includes(sourceRoot)) {
          throw Object.assign(new Error('Paste manifest names an unauthorised workspace root'), {
            migrationReason: 'unsafe_source',
          });
        }
        const sourceAvailability = await assertCanonicalSourceRoot(sourceRoot);
        let source = entry.path;
        let safeSourceRoot = sourceRoot;
        let backup = backupPath(entry.path);
        if (sourceAvailability === 'available') {
          let sourceLease = sourcePasteLeases.get(sourceRoot);
          if (!sourceLease) {
            if (sourcePasteLeases.size >= MAX_PASTE_ROOTS) {
              throw Object.assign(new Error('Legacy paste manifest spans too many workspace roots'), {
                migrationReason: 'unsafe_source',
              });
            }
            sourceLease = openWorkspacePasteDirectorySync(sourceRoot, {
              createIfMissing: false,
            });
            if (sourceLease.canonicalPath !== entry.root) {
              sourceLease.close();
              throw Object.assign(new Error('Manifest paste root does not match its pinned directory'), {
                migrationReason: 'unsafe_source',
              });
            }
            sourcePasteLeases.set(sourceRoot, sourceLease);
            leases.push(sourceLease);
          }
          source = path.join(sourceLease.accessPath, name);
          safeSourceRoot = sourceLease.accessPath;
          backup = backupPath(source);
        }
        definitions.push({
          artifact: 'paste_file',
          key: dynamicArtifactKey('paste_file', entry.path),
          source,
          sourceRoot: safeSourceRoot,
          target,
          canonicalTarget,
          targetLease: pasteLease!,
          backup,
          ...(sourceAvailability === 'available' ? {
            sourceLease: sourcePasteLeases.get(sourceRoot)!,
            verifySourceDirectory: sourcePasteLeases.get(sourceRoot)!.verify,
          } : {}),
          required: true,
          expectedSourceBytes: entry.bytes,
          maximumBytes: DEFAULT_MAX_PASTE_BYTES,
        });
      }
      pasteManifestDefinition.targetContents = Buffer.from(JSON.stringify(normalized), 'utf8');
    }

    return { definitions, leases };
  } catch (error) {
    for (const lease of leases.reverse()) lease.close();
    throw error;
  }
}

/**
 * After a rebuild the secondary cwd (and its rollback siblings) may no longer
 * exist, while the verified canonical binaries intentionally survive.  The
 * completed marker still carries one key per original source. Rebind only
 * those recorded keys to the same already-enumerated canonical target; never
 * invent a path or accept a target absent from the current archive.
 */
function alignCompletedBinaryDefinitions(
  definitions: ArtifactPaths[],
  marker: MigrationMarker,
): ArtifactPaths[] {
  const fixed = definitions.filter((definition) => (
    definition.artifact !== 'attachment_file' && definition.artifact !== 'paste_file'
  ));
  const dynamic = definitions.filter((definition) => (
    definition.artifact === 'attachment_file' || definition.artifact === 'paste_file'
  ));
  const aligned: ArtifactPaths[] = [];

  for (const artifact of ['attachment_file', 'paste_file'] as const) {
    const markerEntries = marker.artifacts.filter((entry) => entry.artifact === artifact);
    const candidates = dynamic.filter((definition) => definition.artifact === artifact);
    const markerTargets = new Set<string>();
    for (const entry of markerEntries) {
      const key = entry.key ?? entry.artifact;
      const name = key.slice(key.lastIndexOf(':') + 1);
      const validName = artifact === 'attachment_file'
        ? STORED_ATTACHMENT_NAME.test(name)
        : PASTED_IMAGE_NAME.test(name);
      if (!validName) return definitions;
      const exact = candidates.find((candidate) => candidate.key === key);
      if (exact) {
        aligned.push(exact);
        markerTargets.add(exact.canonicalTarget);
        continue;
      }
      const canonical = candidates.find(
        (candidate) => path.basename(candidate.canonicalTarget) === name,
      );
      if (!canonical || !canonical.sourceIsTarget) return definitions;
      aligned.push({ ...canonical, key, source: canonical.target });
      markerTargets.add(canonical.canonicalTarget);
    }

    // A real legacy source which appeared after the marker remains a conflict.
    // Only discard the synthetic target-only entry used to rediscover a marker
    // key whose secondary source disappeared during rebuild.
    for (const candidate of candidates) {
      if (markerEntries.some((entry) => (entry.key ?? entry.artifact) === candidate.key)) continue;
      if (candidate.sourceIsTarget && markerTargets.has(candidate.canonicalTarget)) continue;
      aligned.push(candidate);
    }
  }
  return [...fixed, ...aligned];
}

function overallStatus(entries: LegacyArtifactMigrationEntry[]): LegacySessionArtifactMigrationResult['status'] {
  const failures = entries.filter((entry) => entry.state === 'blocked').length;
  if (failures === 0) return 'complete';
  const progress = entries.some(
    (entry) => entry.state === 'migrated' || entry.state === 'already_migrated',
  );
  return progress ? 'partial' : 'blocked';
}

async function validateLegacyRoot(legacyRoot: string): Promise<'available' | 'absent'> {
  if (legacyRoot === path.parse(legacyRoot).root) {
    throw Object.assign(new Error('Filesystem root cannot be legacy storage'), {
      migrationReason: 'unsafe_legacy_storage',
    });
  }
  let lease: WorkspaceStorageDirectoryLease;
  try {
    lease = openCanonicalDirectoryLeaseSync(legacyRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw Object.assign(error as object, { migrationReason: 'unsafe_legacy_storage' });
  }
  try { lease.verify(); return 'available'; } finally { lease.close(); }
}

async function prepareArtifact(
  definition: ArtifactPaths,
  previousMarker: MigrationMarker | null,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<PreparedArtifact> {
  try {
    const markerArtifact = previousMarker?.artifacts.find(
      (artifact) => (artifact.key ?? artifact.artifact) === definition.key,
    );
    const targetHelperLease = definition.targetLease
      ?? workspaceSessionFileParentLease(definition.target);
    if (targetHelperLease?.entryMutationPolicy === 'cwd-helper') {
      recoverWorkspaceCwdPublication(targetHelperLease, path.basename(definition.target));
    }

    if (definition.sourceIsTarget) {
      const targetStat = await leaseAwareFileStatOrNull(
        definition.target,
        definition.targetLease,
        'unsafe_target',
      );
      if (!targetStat) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
      }
      if (
        definition.maximumBytes !== undefined
        && targetStat.size > BigInt(definition.maximumBytes)
      ) {
        return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
      }
      const target = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      if (
        definition.targetContents
        && !sameFingerprint(target, fingerprintBuffer(definition.targetContents))
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        markerArtifact?.present
        && (markerArtifact.bytes !== target.bytes || markerArtifact.sha256 !== target.sha256)
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        definition.expectedSourceBytes !== undefined
        && target.bytes !== definition.expectedSourceBytes
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'already_migrated', target),
        sourceFingerprint: target,
        targetFingerprint: target,
      };
    }

    if (!definition.sourceDirectoryMissing) {
      definition.verifySourceDirectory?.();
      await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
      await recoverLegacyRetirement(definition, definition.source, hooks);
      await recoverLegacyRetirement(definition, definition.backup, hooks);
    }
    const sourceStat = definition.sourceDirectoryMissing
      ? null
      : await leaseAwareFileStatOrNull(
        definition.source,
        definition.sourceLease,
        'unsafe_source',
      );
    const targetStat = await leaseAwareFileStatOrNull(
      definition.target,
      definition.targetLease,
      'unsafe_target',
    );

    if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
    }
    if (
      targetStat
      && definition.maximumBytes !== undefined
      && targetStat.size > BigInt(definition.maximumBytes)
    ) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
    }
    if (!sourceStat) {
      if (!targetStat) {
        if (markerArtifact?.present) {
          return { definition, entry: blockedArtifact(definition, 'target_conflict') };
        }
        if (definition.required) {
          return { definition, entry: blockedArtifact(definition, 'source_changed') };
        }
        return { definition, entry: artifactEntry(definition, 'absent') };
      }
      const target = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      if (
        definition.targetContents
        && !sameFingerprint(target, fingerprintBuffer(definition.targetContents))
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        markerArtifact?.present
        && (markerArtifact.bytes !== target.bytes || markerArtifact.sha256 !== target.sha256)
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        definition.expectedSourceBytes !== undefined
        && target.bytes !== definition.expectedSourceBytes
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'already_migrated', target),
        ...(markerArtifact?.sourceBytes !== undefined ? {
          sourceFingerprint: {
            bytes: markerArtifact.sourceBytes,
            sha256: markerArtifact.sourceSha256!,
          },
        } : {}),
        targetFingerprint: target,
      };
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1n) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_source') };
    }
    if (
      definition.maximumBytes !== undefined
      && sourceStat.size > BigInt(definition.maximumBytes)
    ) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_source') };
    }

    const sourceHandle = definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
      ? openWorkspaceCwdFileForRead(definition.sourceLease, path.basename(definition.source))
      : await fs.promises.open(definition.source, READ_FLAGS).catch(
        (error: NodeJS.ErrnoException) => {
          throw Object.assign(error, { migrationReason: 'unsafe_source' });
        },
      );
    try {
      const sourceBefore = await sourceHandle.stat({ bigint: true });
      definition.verifySourceDirectory?.();
      if (
        !sourceBefore.isFile()
        || sourceBefore.nlink !== 1n
        || !stableFile(sourceStat, sourceBefore)
        || (definition.maximumBytes !== undefined
          && sourceBefore.size > BigInt(definition.maximumBytes))
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }

      const sourceFingerprint = await fingerprintHandle(sourceHandle, definition.maximumBytes);
      const sourceAfterFingerprint = await sourceHandle.stat({ bigint: true });
      if (
        !stableFile(sourceBefore, sourceAfterFingerprint)
        || sourceAfterFingerprint.nlink !== 1n
        || BigInt(sourceFingerprint.bytes) !== sourceAfterFingerprint.size
        || (
          definition.expectedSourceBytes !== undefined
          && sourceFingerprint.bytes !== definition.expectedSourceBytes
        )
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      const desiredTarget = definition.targetContents
        ? fingerprintBuffer(definition.targetContents)
        : sourceFingerprint;

      if (targetStat) {
        const targetFingerprint = await fingerprintPublishedFile(
          definition.target,
          'unsafe_target',
          hooks,
          definition.maximumBytes,
          definition.targetLease,
        );
        if (!sameFingerprint(desiredTarget, targetFingerprint)) {
          return { definition, entry: blockedArtifact(definition, 'target_conflict') };
        }
      } else {
        try {
          if (definition.targetContents) {
            await publishBuffer(
              definition.targetContents,
              definition.target,
              'unsafe_target',
              hooks,
              definition.targetLease,
            );
          } else {
            await copyAndPublish(
              sourceHandle,
              sourceBefore,
              definition.target,
              'unsafe_target',
              hooks,
              definition.maximumBytes,
              definition.targetLease,
              definition.sourceLease,
              path.basename(definition.source),
            );
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // A concurrent migration may have published the same bytes. It is a
          // successful resume only after an independent target verification.
          const sourceAfter = await sourceHandle.stat({ bigint: true });
          if (!stableFile(sourceBefore, sourceAfter)) {
            return { definition, entry: blockedArtifact(definition, 'source_changed') };
          }
          const targetFingerprint = await fingerprintPublishedFile(
            definition.target,
            'unsafe_target',
            hooks,
            definition.maximumBytes,
            definition.targetLease,
          );
          if (!sameFingerprint(desiredTarget, targetFingerprint)) {
            return { definition, entry: blockedArtifact(definition, 'target_conflict') };
          }
        }
      }

      const targetFingerprint = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      const sourceAfterPublish = await sourceHandle.stat({ bigint: true });
      definition.verifySourceDirectory?.();
      if (!stableFile(sourceBefore, sourceAfterPublish) || sourceAfterPublish.nlink !== 1n) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      if (!sameFingerprint(desiredTarget, targetFingerprint)) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'migrated', targetFingerprint),
        sourceFingerprint,
        targetFingerprint,
      };
    } finally {
      await sourceHandle.close();
    }
  } catch (error) {
    return { definition, entry: blockedArtifact(definition, migrationReason(error)) };
  }
}

function markerPath(targetDir: string): string {
  return path.join(targetDir, MARKER_FILE);
}

function isMarkerArtifact(
  value: unknown,
  definitions?: ArtifactPaths[],
): value is MigrationMarkerArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Record<string, unknown>;
  const key = typeof artifact.key === 'string' ? artifact.key : artifact.artifact;
  if (
    typeof key !== 'string'
    || key.length > MAX_MARKER_ARTIFACT_KEY_LENGTH
    || !/^[A-Za-z0-9._:-]+$/.test(key)
  ) return false;
  if (definitions) {
    const definition = definitions.find((candidate) => candidate.key === key);
    if (!definition || definition.artifact !== artifact.artifact) return false;
  } else if (![
    'chat_log',
    'chat_index',
    'chat_snapshot',
    'chat_snapshot_json',
    'chat_opening_context',
    'chat_plan',
    'transcript',
    'history_log',
    'history_index',
    'paste_manifest',
    'attachment_file',
    'paste_file',
  ].includes(String(artifact.artifact))) {
    return false;
  }
  if (typeof artifact.present !== 'boolean') return false;
  if (!artifact.present) {
    return artifact.bytes === undefined
      && artifact.sha256 === undefined
      && artifact.sourceBytes === undefined
      && artifact.sourceSha256 === undefined;
  }
  const targetValid = Number.isSafeInteger(artifact.bytes)
    && Number(artifact.bytes) >= 0
    && typeof artifact.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.sha256);
  const sourceAbsent = artifact.sourceBytes === undefined && artifact.sourceSha256 === undefined;
  const sourceValid = Number.isSafeInteger(artifact.sourceBytes)
    && Number(artifact.sourceBytes) >= 0
    && typeof artifact.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.sourceSha256);
  return targetValid && (sourceAbsent || sourceValid);
}

async function readMarker(
  targetDir: string,
  ownerKey: string,
  sessionId: string,
  ownerUserId: number,
  definitions?: ArtifactPaths[],
): Promise<MigrationMarker | null> {
  const target = markerPath(targetDir);
  try {
    const markerBuffer = await readBoundedStableFile(
      target,
      MAX_MARKER_BYTES,
      'unsafe_target',
    );
    if (!markerBuffer) return null;
    const parsed = JSON.parse(markerBuffer.toString('utf8')) as Partial<MigrationMarker>;
    // Validate the collection shape and exact global bound before constructing
    // any derived Set/map from untrusted JSON.
    if (
      parsed.version !== 1
      || parsed.ownerKey !== ownerKey
      || parsed.ownerUserId !== ownerUserId
      || parsed.sessionId !== sessionId
      || (parsed.phase !== 'verified' && parsed.phase !== 'complete')
      || !Number.isSafeInteger(parsed.ownerUserId)
      || Number(parsed.ownerUserId) < 0
      || !Array.isArray(parsed.artifacts)
      || parsed.artifacts.length > MAX_MIGRATION_MARKER_ARTIFACTS
    ) {
      throw Object.assign(new Error('Invalid legacy migration marker'), {
        migrationReason: 'target_conflict',
      });
    }
    const uniqueArtifacts = new Set(parsed.artifacts.map(
      (artifact) => artifact?.key ?? artifact?.artifact,
    ));
    if (
      uniqueArtifacts.size !== parsed.artifacts.length
      || (definitions !== undefined && parsed.artifacts.length !== definitions.length)
      || !parsed.artifacts.every((artifact) => isMarkerArtifact(artifact, definitions))
    ) {
      throw Object.assign(new Error('Invalid legacy migration marker'), {
        migrationReason: 'target_conflict',
      });
    }
    return parsed as MigrationMarker;
  } catch (error) {
    if ((error as { migrationReason?: unknown }).migrationReason) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      migrationReason: 'target_conflict',
    });
  }
}

async function writeMarker(
  targetDir: string,
  marker: MigrationMarker,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const target = markerPath(targetDir);
  const existing = await lstatOrNull(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1n)) {
    throw Object.assign(new Error('Unsafe legacy migration marker target'), {
      migrationReason: 'unsafe_target',
    });
  }
  const temporary = path.join(
    targetDir,
    `.${MARKER_FILE}.${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    if (marker.artifacts.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
      throw Object.assign(new Error('Legacy migration marker exceeds its artifact bound'), {
        migrationReason: 'unsafe_target',
      });
    }
    const serialized = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (serialized.length > MAX_MARKER_BYTES) {
      throw Object.assign(new Error('Legacy migration marker exceeds its bounded size'), {
        migrationReason: 'unsafe_target',
      });
    }
    const helperLease = workspaceSessionFileParentLease(target);
    if (helperLease?.entryMutationPolicy === 'cwd-helper') {
      publishLargeWorkspaceCwdFile(helperLease, path.basename(target), serialized);
      await syncDirectory(targetDir, hooks, 'marker_publish');
      return;
    }
    handle = await fs.promises.open(temporary, WRITE_FLAGS, 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, target);
    await syncDirectory(targetDir, hooks, 'marker_publish');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await removeTemporaryAndSync(temporary, hooks).catch(() => undefined);
  }
}

/**
 * Retire the completed marker through the pinned session-directory lease.
 *
 * `unlink` is the atomic cutover: once it is durable, later live writes no
 * longer have to match the migration-time fingerprints.  Synchronising the
 * containing directory keeps a crash from resurrecting the stale marker after
 * the legacy rollback copies have already been removed.
 */
async function removeMarker(
  targetDir: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  await unlinkSessionEntry(markerPath(targetDir));
  await syncDirectory(targetDir, hooks, 'marker_unlink');
}

function markerFromPrepared(
  ownerKey: string,
  ownerUserId: number,
  sessionId: string,
  phase: MigrationMarker['phase'],
  prepared: PreparedArtifact[],
): MigrationMarker {
  if (prepared.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
    throw Object.assign(new Error('Migration plan exceeds its marker artifact bound'), {
      migrationReason: 'unsafe_target',
    });
  }
  return {
    version: 1,
    ownerKey,
    ownerUserId,
    sessionId,
    phase,
    artifacts: prepared.map(({ definition, sourceFingerprint, targetFingerprint }) => {
      if (!targetFingerprint) {
        return {
          artifact: definition.artifact,
          ...(definition.key !== definition.artifact ? { key: definition.key } : {}),
          present: false,
        };
      }
      return {
        artifact: definition.artifact,
        ...(definition.key !== definition.artifact ? { key: definition.key } : {}),
        present: true,
        ...targetFingerprint,
        ...(sourceFingerprint && !definition.sourceIsTarget ? {
          sourceBytes: sourceFingerprint.bytes,
          sourceSha256: sourceFingerprint.sha256,
        } : {}),
      };
    }),
  };
}

async function copyVerifiedFile(
  source: string,
  target: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
  maximumBytes?: number,
  targetLease?: WorkspaceStorageDirectoryLease,
): Promise<Fingerprint> {
  const helperSourceLease = targetLease?.entryMutationPolicy === 'cwd-helper'
    && (path.dirname(source) === targetLease.accessPath
      || path.dirname(source) === targetLease.canonicalPath)
    ? targetLease
    : undefined;
  const handle = helperSourceLease
    ? openWorkspaceCwdFileForRead(helperSourceLease, path.basename(source))
    : await fs.promises.open(source, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(error, { migrationReason: 'unsafe_source' });
    });
  const sourceStat = helperSourceLease
    ? await handle.stat({ bigint: true })
    : await lstatOrNull(source);
  if (
    !sourceStat
    || sourceStat.isSymbolicLink()
    || !sourceStat.isFile()
    || sourceStat.nlink !== 1n
    || (maximumBytes !== undefined && sourceStat.size > BigInt(maximumBytes))
  ) {
    await handle.close().catch(() => undefined);
    throw Object.assign(new Error('Expected a safe source file'), {
      migrationReason: 'unsafe_source',
    });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      before.nlink !== 1n
      || !stableFile(sourceStat, before)
      || (maximumBytes !== undefined && before.size > BigInt(maximumBytes))
    ) {
      throw Object.assign(new Error('Source changed before backup'), {
        migrationReason: 'source_changed',
      });
    }
    try {
      return await copyAndPublish(
        handle,
        before,
        target,
        'unsafe_source',
        hooks,
        maximumBytes,
        targetLease,
        helperSourceLease,
        path.basename(source),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const sourceFingerprint = await fingerprintHandle(handle, maximumBytes);
      const after = await handle.stat({ bigint: true });
      if (!stableFile(before, after) || after.nlink !== 1n) {
        throw Object.assign(new Error('Source changed while verifying backup'), {
          migrationReason: 'source_changed',
        });
      }
      const targetFingerprint = await fingerprintPublishedFile(
        target,
        'unsafe_source',
        hooks,
        maximumBytes,
        targetLease,
      );
      if (!sameFingerprint(sourceFingerprint, targetFingerprint)) {
        throw Object.assign(new Error('Migration backup conflicts with source'), {
          migrationReason: 'source_changed',
        });
      }
      return targetFingerprint;
    }
  } finally {
    await handle.close();
  }
}

async function recoverBackup(
  definition: ArtifactPaths,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  if (definition.sourceIsTarget) return;
  if (definition.sourceDirectoryMissing) return;
  definition.verifySourceDirectory?.();
  await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
  await recoverLegacyRetirement(definition, definition.source, hooks);
  await recoverLegacyRetirement(definition, definition.backup, hooks);
  const backupStat = await leaseAwareFileStatOrNull(
    definition.backup,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!backupStat) return;
  if (backupStat.isSymbolicLink() || !backupStat.isFile()) {
    throw Object.assign(new Error('Unsafe legacy migration backup'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && backupStat.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy migration backup exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  const backupFingerprint = await fingerprintPublishedFile(
    definition.backup,
    'unsafe_source',
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
  const sourceStat = await leaseAwareFileStatOrNull(
    definition.source,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!sourceStat) {
    const restored = await copyVerifiedFile(
      definition.backup,
      definition.source,
      hooks,
      definition.maximumBytes,
      definition.sourceLease,
    );
    if (!sameFingerprint(backupFingerprint, restored)) {
      throw Object.assign(new Error('Restored source differs from migration backup'), {
        migrationReason: 'source_changed',
      });
    }
    return;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1n) {
    throw Object.assign(new Error('Unsafe source beside migration backup'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && sourceStat.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy source exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  const sourceFingerprint = await fingerprintPublishedFile(
    definition.source,
    'unsafe_source',
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
  if (!sameFingerprint(sourceFingerprint, backupFingerprint)) {
    throw Object.assign(new Error('Source conflicts with migration backup'), {
      migrationReason: 'source_changed',
    });
  }
}

async function ensureBackup(
  definition: ArtifactPaths,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<Fingerprint | null> {
  if (definition.sourceIsTarget) return null;
  if (definition.sourceDirectoryMissing) return null;
  definition.verifySourceDirectory?.();
  await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
  await recoverLegacyRetirement(definition, definition.source, hooks);
  await recoverLegacyRetirement(definition, definition.backup, hooks);
  const source = await leaseAwareFileStatOrNull(
    definition.source,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!source) return null;
  if (source.isSymbolicLink() || !source.isFile() || source.nlink !== 1n) {
    throw Object.assign(new Error('Unsafe legacy source before cutover'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && source.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy source exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  return copyVerifiedFile(
    definition.source,
    definition.backup,
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
}

async function restorePreparedSources(
  prepared: PreparedArtifact[],
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  for (const item of prepared) {
    await recoverBackup(item.definition, hooks);
  }
}

function legacyRetirementDirectory(legacyPath: string): string {
  const identity = createHash('sha256')
    .update(path.basename(legacyPath))
    .digest('hex')
    .slice(0, 32);
  return path.join(path.dirname(legacyPath), `.ccweb-retire-${identity}`);
}

/**
 * Reconcile the only two crash states emitted by the identity-bound unlink:
 * one quarantined name, or the exact two-link state after the no-clobber
 * restore link was published. Unexpected entries are retained and fail closed.
 */
async function recoverLegacyRetirement(
  definition: ArtifactPaths,
  legacyPath: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const directory = legacyRetirementDirectory(legacyPath);
  const visibleDirectory = await lstatOrNull(directory);
  if (!visibleDirectory) return;
  if (definition.sourceLease?.entryMutationPolicy === 'cwd-helper') {
    throw Object.assign(new Error('Portable legacy retirement state requires manual recovery'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (visibleDirectory.isSymbolicLink() || !visibleDirectory.isDirectory()) {
    throw Object.assign(new Error('Legacy retirement path is not a private directory'), {
      migrationReason: 'unsafe_source',
    });
  }
  const directoryHandle = await fs.promises.open(
    directory,
    fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY,
  );
  let empty = false;
  try {
    const openedDirectory = await directoryHandle.stat({ bigint: true });
    if (!sameDirectoryIdentity(visibleDirectory, openedDirectory)) {
      throw Object.assign(new Error('Legacy retirement directory changed while opening'), {
        migrationReason: 'unsafe_source',
      });
    }
    const descriptorRoot = workspaceDescriptorRoot();
    const accessDirectory = descriptorRoot
      ? path.join(descriptorRoot, String(directoryHandle.fd))
      : directory;
    const entries = await fs.promises.readdir(accessDirectory);
    if (entries.length === 0) {
      empty = true;
      return;
    }
    if (entries.length !== 1 || entries[0] !== 'artifact') {
      throw Object.assign(new Error('Legacy retirement directory contains unexpected entries'), {
        migrationReason: 'unsafe_source',
      });
    }
    const quarantinedPath = path.join(accessDirectory, 'artifact');
    const quarantined = await lstatOrNull(quarantinedPath);
    if (
      !quarantined
      || quarantined.isSymbolicLink()
      || !quarantined.isFile()
      || (definition.maximumBytes !== undefined
        && quarantined.size > BigInt(definition.maximumBytes))
    ) {
      throw Object.assign(new Error('Legacy retirement entry is unsafe'), {
        migrationReason: 'unsafe_source',
      });
    }
    const current = await lstatOrNull(legacyPath);
    if (current) {
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || current.nlink !== 2n
        || quarantined.nlink !== 2n
        || !sameFileIdentity(current, quarantined)
      ) {
        throw Object.assign(new Error('Legacy retirement conflicts with the visible artifact'), {
          migrationReason: 'source_changed',
        });
      }
    } else {
      if (quarantined.nlink !== 1n) {
        throw Object.assign(new Error('Legacy retirement entry has an ambiguous link count'), {
          migrationReason: 'source_changed',
        });
      }
      await fs.promises.link(quarantinedPath, legacyPath);
      const restored = await lstatOrNull(legacyPath);
      const linked = await lstatOrNull(quarantinedPath);
      if (
        !restored
        || !linked
        || restored.nlink !== 2n
        || linked.nlink !== 2n
        || !sameFileIdentity(restored, linked)
      ) {
        throw Object.assign(new Error('Legacy retirement restore could not be verified'), {
          migrationReason: 'source_changed',
        });
      }
    }
    await fs.promises.unlink(quarantinedPath);
    await directoryHandle.sync();
    empty = true;
    const restoredAfter = await lstatOrNull(legacyPath);
    if (
      !restoredAfter
      || restoredAfter.isSymbolicLink()
      || !restoredAfter.isFile()
      || restoredAfter.nlink !== 1n
    ) {
      throw Object.assign(new Error('Recovered legacy artifact is not isolated'), {
        migrationReason: 'source_changed',
      });
    }
  } finally {
    await directoryHandle.close();
    if (empty) {
      await fs.promises.rmdir(directory);
      await syncDirectory(path.dirname(legacyPath), hooks, 'temporary_cleanup');
    }
  }
}

async function unlinkVerifiedLegacyFile(
  definition: ArtifactPaths,
  legacyPath: string,
  kind: 'source' | 'backup',
  expected: Fingerprint,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  definition.verifySourceDirectory?.();
  await recoverLegacyRetirement(definition, legacyPath, hooks);
  const helperSourceLease = definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
    && (path.dirname(legacyPath) === definition.sourceLease.accessPath
      || path.dirname(legacyPath) === definition.sourceLease.canonicalPath)
    ? definition.sourceLease
    : undefined;
  const handle = helperSourceLease
    ? openWorkspaceCwdFileForRead(helperSourceLease, path.basename(legacyPath))
    : await fs.promises.open(legacyPath, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(error, { migrationReason: 'source_changed' });
    });
  const visible = helperSourceLease
    ? await handle.stat({ bigint: true })
    : await lstatOrNull(legacyPath);
  if (
    !visible
    || visible.isSymbolicLink()
    || !visible.isFile()
    || visible.nlink !== 1n
  ) {
    await handle.close().catch(() => undefined);
    throw Object.assign(new Error('Legacy artifact is not an isolated regular file'), {
      migrationReason: 'source_changed',
    });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.nlink !== 1n
      || !sameFileIdentity(visible, opened)
      || !stableFile(visible, opened)
    ) {
      throw Object.assign(new Error('Legacy artifact changed while it was opened'), {
        migrationReason: 'source_changed',
      });
    }
    const openedFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
    const afterFingerprint = await handle.stat({ bigint: true });
    if (
      afterFingerprint.nlink !== 1n
      || !stableFile(opened, afterFingerprint)
      || !sameFingerprint(openedFingerprint, expected)
    ) {
      throw Object.assign(new Error('Legacy artifact changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }

    await hooks?.beforeLegacyUnlink?.({
      artifact: definition.artifact,
      key: definition.key,
      kind,
    });
    definition.verifySourceDirectory?.();

    const finalVisible = helperSourceLease ? null : await lstatOrNull(legacyPath);
    const finalOpened = await handle.stat({ bigint: true });
    if (
      finalOpened.nlink !== 1n
      || (!helperSourceLease && (
        !finalVisible
        || finalVisible.isSymbolicLink()
        || !finalVisible.isFile()
        || finalVisible.nlink !== 1n
        || !sameFileIdentity(finalVisible, finalOpened)
      ))
      || !stableFile(afterFingerprint, finalOpened)
    ) {
      throw Object.assign(new Error('Legacy artifact name changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }
    const finalFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
    const immediatelyBeforeUnlink = await handle.stat({ bigint: true });
    if (
      immediatelyBeforeUnlink.nlink !== 1n
      || !stableFile(finalOpened, immediatelyBeforeUnlink)
      || !sameFingerprint(finalFingerprint, expected)
    ) {
      throw Object.assign(new Error('Legacy artifact bytes changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }

    if (helperSourceLease) {
      const expectedParent = helperSourceLease;
      const basename = path.basename(legacyPath);
      if (path.dirname(legacyPath) !== expectedParent.accessPath
        && path.dirname(legacyPath) !== expectedParent.canonicalPath) {
        throw Object.assign(new Error('Portable legacy source is outside its pinned namespace'), {
          migrationReason: 'unsafe_source',
        });
      }
      retireMigrationWorkspaceCwdEntry(
        expectedParent,
        basename,
        { dev: immediatelyBeforeUnlink.dev, ino: immediatelyBeforeUnlink.ino },
      );
      await syncDirectory(path.dirname(legacyPath), hooks, 'temporary_cleanup');
      return;
    }

    // Node does not expose an unlink-by-file-descriptor primitive. Never
    // unlink the attacker-visible legacy name directly: move that directory
    // entry into a fresh private directory, verify that the moved name is the
    // still-open inode, and only then retire the quarantined name. If the
    // source is replaced inside the rename syscall seam, the replacement is
    // moved rather than deleted and is restored with a no-clobber hard link.
    const legacyDirectory = path.dirname(legacyPath);
    const quarantineDirectory = legacyRetirementDirectory(legacyPath);
    await fs.promises.mkdir(quarantineDirectory, { mode: 0o700 });
    const quarantineVisible = await fs.promises.lstat(quarantineDirectory, { bigint: true });
    const quarantineHandle = await fs.promises.open(
      quarantineDirectory,
      fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY,
    );
    let quarantineEmpty = false;
    try {
      const quarantineOpened = await quarantineHandle.stat({ bigint: true });
      if (!sameDirectoryIdentity(quarantineVisible, quarantineOpened)) {
        throw Object.assign(new Error('Legacy artifact quarantine changed while opening'), {
          migrationReason: 'source_changed',
        });
      }
      const descriptorRoot = workspaceDescriptorRoot();
      const quarantineAccessDirectory = descriptorRoot
        ? path.join(descriptorRoot, String(quarantineHandle.fd))
        : quarantineDirectory;
      const quarantinedPath = path.join(quarantineAccessDirectory, 'artifact');
      const restoreQuarantinedName = async (): Promise<boolean> => {
        const quarantined = await lstatOrNull(quarantinedPath);
        if (!quarantined) return false;
        if (quarantined.isSymbolicLink() || !quarantined.isFile()) return false;
        if (await lstatOrNull(legacyPath)) return false;
        try {
          // link(2) is the no-clobber primitive available in Node. It restores
          // whichever entry rename moved (including a concurrent replacement)
          // without overwriting a newer legacy name.
          await fs.promises.link(quarantinedPath, legacyPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        const restored = await lstatOrNull(legacyPath);
        const linked = await lstatOrNull(quarantinedPath);
        if (
          !restored
          || !linked
          || !sameFileIdentity(restored, linked)
          || restored.nlink < 2n
          || linked.nlink < 2n
        ) {
          throw Object.assign(new Error('Could not verify restored legacy artifact name'), {
            migrationReason: 'source_changed',
          });
        }
        await fs.promises.unlink(quarantinedPath);
        await quarantineHandle.sync();
        quarantineEmpty = true;
        const restoredAfter = await lstatOrNull(legacyPath);
        if (
          !restoredAfter
          || restoredAfter.isSymbolicLink()
          || !restoredAfter.isFile()
          || !sameFileIdentity(restored, restoredAfter)
        ) {
          throw Object.assign(new Error('Restored legacy artifact changed during quarantine cleanup'), {
            migrationReason: 'source_changed',
          });
        }
        return true;
      };

      if (await lstatOrNull(quarantinedPath)) {
        throw Object.assign(new Error('Legacy artifact quarantine was not empty'), {
          migrationReason: 'source_changed',
        });
      }
      // Persist the private directory before placing the only visible legacy
      // name inside it, then persist the rename itself. A cold process can
      // therefore deterministically restore either crash cutpoint.
      await syncDirectory(legacyDirectory, hooks, 'quarantine_publish');
      await fs.promises.rename(legacyPath, quarantinedPath);
      await syncDirectory(legacyDirectory, hooks, 'quarantine_publish');
      definition.verifySourceDirectory?.();

      try {
        const quarantined = await lstatOrNull(quarantinedPath);
        const movedOpened = await handle.stat({ bigint: true });
        if (
          !quarantined
          || quarantined.isSymbolicLink()
          || !quarantined.isFile()
          || quarantined.nlink !== 1n
          || movedOpened.nlink !== 1n
          || !sameFileIdentity(quarantined, movedOpened)
          || !stableFileAcrossRename(immediatelyBeforeUnlink, movedOpened)
        ) {
          throw Object.assign(new Error('Legacy artifact name changed during quarantine rename'), {
            migrationReason: 'source_changed',
          });
        }
        const quarantinedFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
        const beforeQuarantineUnlink = await handle.stat({ bigint: true });
        if (
          beforeQuarantineUnlink.nlink !== 1n
          || !stableFile(movedOpened, beforeQuarantineUnlink)
          || !sameFingerprint(quarantinedFingerprint, expected)
          || await lstatOrNull(legacyPath)
        ) {
          throw Object.assign(new Error('Legacy artifact changed inside quarantine'), {
            migrationReason: 'source_changed',
          });
        }

        await fs.promises.unlink(quarantinedPath);
        await quarantineHandle.sync();
        quarantineEmpty = true;
        const afterUnlink = await handle.stat({ bigint: true });
        const visibleAfterUnlink = await lstatOrNull(quarantinedPath);
        if (afterUnlink.nlink !== 0n || visibleAfterUnlink || await lstatOrNull(legacyPath)) {
          throw Object.assign(new Error('Legacy artifact quarantine did not retire the opened inode'), {
            migrationReason: 'source_changed',
          });
        }
      } catch (error) {
        // A mismatching entry is still user data. Restore it to the source name
        // when that can be done without clobbering another concurrent entry;
        // otherwise leave the private quarantine intact and fail closed.
        await restoreQuarantinedName();
        throw error;
      }
    } finally {
      await quarantineHandle.close();
      if (quarantineEmpty) {
        await fs.promises.rmdir(quarantineDirectory);
        await syncDirectory(
          legacyDirectory,
          hooks,
          kind === 'source' ? 'source_unlink' : 'backup_unlink',
        );
      }
    }
  } finally {
    await handle.close();
  }
}

async function commitPreparedSources(
  prepared: PreparedArtifact[],
  backups: Map<string, Fingerprint>,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  for (const item of prepared) {
    const expectedSource = backups.get(item.definition.key);
    if (!expectedSource || item.definition.sourceIsTarget) continue;
    const expectedTarget = item.targetFingerprint;
    item.definition.verifySourceDirectory?.();
    const source = await fingerprintFile(
      item.definition.source,
      'unsafe_source',
      1n,
      item.definition.maximumBytes,
    );
    const backup = await fingerprintPublishedFile(
      item.definition.backup,
      'unsafe_source',
      hooks,
      item.definition.maximumBytes,
      item.definition.sourceLease,
    );
    const target = expectedTarget
      ? await fingerprintPublishedFile(
        item.definition.target,
        'unsafe_target',
        hooks,
        item.definition.maximumBytes,
        item.definition.targetLease,
      )
      : null;
    if (
      !sameFingerprint(source, expectedSource)
      || !sameFingerprint(backup, expectedSource)
      || !target
      || !expectedTarget
      || !sameFingerprint(target, expectedTarget)
    ) {
      throw Object.assign(new Error('Artifact changed before session cutover'), {
        migrationReason: 'source_changed',
        migrationArtifact: item.definition.artifact,
      });
    }
    try {
      await unlinkVerifiedLegacyFile(
        item.definition,
        item.definition.source,
        'source',
        expectedSource,
        hooks,
      );
      // Detect a link added in the narrow interval after the pre-cutover
      // verification. The caller still has a verified backup and will restore
      // the source if this postcondition fails.
      const committedTarget = await fingerprintPublishedFile(
        item.definition.target,
        'unsafe_target',
        hooks,
        item.definition.maximumBytes,
        item.definition.targetLease,
      );
      if (!sameFingerprint(committedTarget, expectedTarget)) {
        throw Object.assign(new Error('Workspace target changed during session cutover'), {
          migrationReason: 'target_conflict',
        });
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        migrationReason: migrationReason(error),
        migrationArtifact: item.definition.artifact,
      });
    }
  }
}

function blockedCutoverEntries(
  prepared: PreparedArtifact[],
  reason: LegacyArtifactBlockReason,
  artifact?: LegacySessionArtifact,
): LegacyArtifactMigrationEntry[] {
  return prepared.map((item) => {
    if (item.entry.state === 'absent') return item.entry;
    if (!artifact || item.definition.artifact === artifact) {
      return blockedArtifact(item.definition, reason);
    }
    return item.entry;
  });
}

/**
 * Per-session, restartable migration of legacy file artefacts.
 *
 * This service intentionally does not migrate SQLite rows and does not decide
 * a session's workspace. The caller must resolve and authorise that immutable
 * scope first, serialise live store activity for the session, and only mark its
 * database import complete when this result is `complete`.
 */
export class WorkspaceSessionArtifactMigrator {
  readonly legacyStorageDir: string;
  private readonly queues = new Map<string, Promise<LegacySessionArtifactMigrationResult>>();
  private readonly hooks?: WorkspaceSessionArtifactMigratorHooks;

  constructor(options: WorkspaceSessionArtifactMigratorOptions) {
    this.legacyStorageDir = path.resolve(options.legacyStorageDir);
    this.hooks = options.hooks;
  }

  migrate(ref: LegacySessionMigrationRef): Promise<LegacySessionArtifactMigrationResult> {
    const queueKey = `${ref.storageRoot ?? ref.storageScope?.workspaceRoot ?? ''}\0${ref.ownerKey ?? ref.storageScope?.ownerKey ?? ''}\0${ref.id}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve(null);
    const run = async (): Promise<LegacySessionArtifactMigrationResult> => {
      try {
        return await this.migrateNow(ref);
      } finally {
        try { closeWorkspaceSessionDirectoryLease(ref); } catch { /* Invalid refs were already blocked. */ }
      }
    };
    const next = previous.then(run, run);
    this.queues.set(queueKey, next);
    void next.finally(() => {
      if (this.queues.get(queueKey) === next) this.queues.delete(queueKey);
    }).catch(() => undefined);
    return next;
  }

  /**
   * Drop rollback copies only after the SQLite row/usage cutover succeeded.
   * Keeping them through that second verification is what makes migration
   * atomic across the file archive and the separate installation database.
   */
  async confirm(ref: LegacySessionMigrationRef): Promise<void> {
    const id = safeComponent(ref.id, 'session id');
    if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) {
      throw Object.assign(new Error('Unsafe owner id while confirming migration'), {
        migrationReason: 'unsafe_source',
      });
    }
    const ownerKey = safeComponent(
      ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
      'owner key',
    );
    const canonicalTarget = workspaceSessionDirectory(ref);
    if (!canonicalTarget) {
      throw Object.assign(new Error('Workspace target is unavailable while confirming migration'), {
        migrationReason: 'unsafe_workspace_storage',
      });
    }
    const targetDir = workspaceSessionAccessDirectory(ref);
    let binaryPlan: BinaryArtifactPlan | null = null;
    let fixedPlan: PinnedFixedArtifactPlan | null = null;
    try {
      const targetLease = targetDir
        ? workspaceSessionFileParentLease(path.join(targetDir, MARKER_FILE))
        : null;
      if (!targetDir || !targetLease || targetLease.canonicalPath !== canonicalTarget) {
        throw Object.assign(new Error('Workspace target is unavailable while confirming migration'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      targetLease.verify();
      const markerEnvelope = await readMarker(targetDir, ownerKey, id, ref.ownerUserId);
      if (!markerEnvelope || markerEnvelope.phase !== 'complete') return;

      const rawDefinitions = artifactDefinitions(
        this.legacyStorageDir,
        String(ref.ownerUserId),
        id,
        targetDir,
        canonicalTarget,
      );
      const legacyAvailability = await validateLegacyRoot(this.legacyStorageDir);
      fixedPlan = legacyAvailability === 'available'
        ? pinFixedArtifactDefinitions(this.legacyStorageDir, rawDefinitions)
        : {
          definitions: rawDefinitions.map((definition) => ({
            ...definition,
            sourceDirectoryMissing: true,
          })),
          leases: [],
        };
      const definitions = fixedPlan.definitions;
      binaryPlan = await buildBinaryArtifactPlan(
        ref,
        definitions,
        ref.storageRoot ?? ref.storageScope!.workspaceRoot,
        ownerKey,
        id,
        false,
        this.hooks,
      );
      definitions.push(...binaryPlan.definitions);
      const alignedDefinitions = alignCompletedBinaryDefinitions(definitions, markerEnvelope);
      definitions.splice(0, definitions.length, ...alignedDefinitions);
      const marker = await readMarker(
        targetDir,
        ownerKey,
        id,
        ref.ownerUserId,
        definitions,
      );
      if (!marker || marker.phase !== 'complete') return;

      const cleanupDefinitions = [...definitions].sort((left, right) => {
        const priority = (definition: ArtifactPaths): number => {
          if (definition.artifact === 'paste_file') return 0;
          if (definition.artifact === 'attachment_file') return 1;
          if (definition.artifact === 'paste_manifest') return 3;
          return 2;
        };
        return priority(left) - priority(right);
      });
      for (const definition of cleanupDefinitions) {
        const recorded = marker.artifacts.find(
          (item) => (item.key ?? item.artifact) === definition.key,
        )!;
        if (!recorded.present) continue;
        const expectedTarget = { bytes: recorded.bytes!, sha256: recorded.sha256! };
        const expectedSource = recorded.sourceBytes !== undefined
          ? { bytes: recorded.sourceBytes, sha256: recorded.sourceSha256! }
          : expectedTarget;
        // The marker was written only after every target matched. Require that
        // same verified target before discarding the last global rollback copy.
        const target = await fingerprintPublishedFile(
          definition.target,
          'unsafe_target',
          this.hooks,
          definition.maximumBytes,
          definition.targetLease,
        );
        if (!sameFingerprint(target, expectedTarget)) {
          throw Object.assign(new Error('Workspace artifact changed before migration confirmation'), {
            migrationReason: 'target_conflict',
          });
        }
        if (definition.sourceIsTarget) continue;
        if (definition.sourceDirectoryMissing) {
          throw Object.assign(new Error('Legacy artifact parent disappeared before confirmation'), {
            migrationReason: 'unsafe_source',
          });
        }
        definition.verifySourceDirectory?.();
        await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
        for (const [legacyPath, published, kind] of [
          [definition.source, false, 'source'],
          [definition.backup, true, 'backup'],
        ] as const) {
          if (definition.sourceLease?.entryMutationPolicy === 'cwd-helper') {
            recoverMigrationWorkspaceCwdRetirement(
              definition.sourceLease,
              path.basename(legacyPath),
              expectedSource,
            );
          }
          await recoverLegacyRetirement(definition, legacyPath, this.hooks);
          const stat = await leaseAwareFileStatOrNull(
            legacyPath,
            definition.sourceLease,
            'unsafe_source',
          );
          if (!stat) continue;
          const fingerprint = published || definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
            ? await fingerprintPublishedFile(
              legacyPath,
              'unsafe_source',
              this.hooks,
              definition.maximumBytes,
              definition.sourceLease,
            )
            : await fingerprintFile(
              legacyPath,
              'unsafe_source',
              1n,
              definition.maximumBytes,
            );
          if (!sameFingerprint(fingerprint, expectedSource)) {
            throw Object.assign(new Error('Legacy artifact changed before migration confirmation'), {
              migrationReason: 'source_changed',
            });
          }
          await unlinkVerifiedLegacyFile(
            definition,
            legacyPath,
            kind,
            expectedSource,
            this.hooks,
          );
        }
        await this.hooks?.afterConfirmArtifact?.({
          artifact: definition.artifact,
          key: definition.key,
        });
      }
      await removeMarker(targetDir, this.hooks);
    } finally {
      for (const lease of binaryPlan?.leases.reverse() ?? []) lease.close();
      for (const lease of fixedPlan?.leases.reverse() ?? []) lease.close();
      closeWorkspaceSessionDirectoryLease(ref);
    }
  }

  /**
   * A completed/verified marker with a copied binary still references rollback
   * data outside the durable project archive. Lifecycle replacement must keep
   * the checkout intact until confirm has retired that authority.
   */
  async hasPendingBinaryCleanup(ref: LegacySessionMigrationRef): Promise<boolean> {
    let ownerKey: string;
    let id: string;
    let canonicalTarget: string | null;
    try {
      id = safeComponent(ref.id, 'session id');
      ownerKey = safeComponent(
        ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
        'owner key',
      );
      canonicalTarget = workspaceSessionDirectory(ref);
    } catch {
      return true;
    }
    if (!canonicalTarget) return true;
    try {
      const targetDir = workspaceSessionAccessDirectory(ref);
      if (!targetDir) return true;
      const markerLease = workspaceSessionFileParentLease(markerPath(targetDir));
      if (!markerLease || markerLease.canonicalPath !== canonicalTarget) return true;
      markerLease.verify();
      if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) return true;
      const marker = await readMarker(targetDir, ownerKey, id, ref.ownerUserId);
      if (!marker) return false;
      return marker.artifacts.some((artifact) => (
        (artifact.artifact === 'attachment_file' || artifact.artifact === 'paste_file')
        && artifact.present
        && artifact.sourceBytes !== undefined
      ));
    } catch {
      // A malformed or temporarily unreadable marker is not evidence that the
      // secondary checkout is disposable. Replacement retries after repair.
      return true;
    } finally {
      closeWorkspaceSessionDirectoryLease(ref);
    }
  }

  private async migrateNow(ref: LegacySessionMigrationRef): Promise<LegacySessionArtifactMigrationResult> {
    let id: string;
    let owner: string;
    let ownerKey: string;
    try {
      id = safeComponent(ref.id, 'session id');
      if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) {
        throw Object.assign(new Error('Unsafe owner id'), { migrationReason: 'unsafe_source' });
      }
      owner = String(ref.ownerUserId);
      ownerKey = safeComponent(
        ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
        'owner key',
      );
    } catch (error) {
      const entries = artifactDefinitions(
        this.legacyStorageDir,
        Number.isSafeInteger(ref.ownerUserId) ? String(ref.ownerUserId) : 'invalid',
        SAFE_COMPONENT.test(String(ref.id)) ? String(ref.id) : 'invalid',
        path.join(this.legacyStorageDir, '.invalid-target'),
      ).map((entry) => blockedArtifact(entry, 'unsafe_source'));
      return { status: 'blocked', artifacts: entries };
    }

    const recoveryDefinitions = artifactDefinitions(
      this.legacyStorageDir,
      owner,
      id,
      path.join(this.legacyStorageDir, '.unused-target'),
    );
    let legacyAvailability: 'available' | 'absent';
    try {
      legacyAvailability = await validateLegacyRoot(this.legacyStorageDir);
    } catch (error) {
      const reason = migrationReason(error);
      const entries = recoveryDefinitions.map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    }
    const recoverLegacy = async (): Promise<void> => {
      if (legacyAvailability !== 'available') return;
      const recoveryPlan = pinFixedArtifactDefinitions(
        this.legacyStorageDir,
        recoveryDefinitions,
      );
      try {
        for (const definition of recoveryPlan.definitions) {
          await recoverBackup(definition, this.hooks);
        }
      } finally {
        for (const lease of recoveryPlan.leases.reverse()) lease.close();
      }
    };

    let targetDir: string;
    let canonicalTarget: string;
    try {
      const resolvedTarget = workspaceSessionDirectory(ref);
      if (!resolvedTarget) {
        throw Object.assign(new Error('Workspace scope is required'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      canonicalTarget = resolvedTarget;
      await ensureWorkspaceSessionDirectory(ref);
      const accessTarget = workspaceSessionAccessDirectory(ref);
      if (!accessTarget) throw new Error('Workspace session access path is unavailable');
      targetDir = accessTarget;
      // `accessTarget` may intentionally be `/proc/self/fd/<n>`; validate the
      // canonical path while retaining the pinned descriptor path for I/O.
      const targetStat = await lstatOrNull(canonicalTarget);
      if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw Object.assign(new Error('Unsafe target session directory'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      if (await fs.promises.realpath(targetDir) !== canonicalTarget) {
        throw Object.assign(new Error('Target session directory is reached through a symlink'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
    } catch (error) {
      let reason: LegacyArtifactBlockReason = 'unsafe_workspace_storage';
      try {
        // If the workspace disappeared after a prior file cutover, restore
        // every original source from its retained rollback sibling before
        // reporting the blocked migration.
        await recoverLegacy();
      } catch (recoveryError) {
        reason = migrationReason(recoveryError);
      }
      const entries = artifactDefinitions(
        this.legacyStorageDir,
        owner,
        id,
        path.join(this.legacyStorageDir, '.invalid-target'),
      ).map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    }

    const rawDefinitions = artifactDefinitions(
      this.legacyStorageDir,
      owner,
      id,
      targetDir,
      canonicalTarget,
    );
    let definitions = rawDefinitions;
    let binaryPlan: BinaryArtifactPlan | null = null;
    let fixedPlan: PinnedFixedArtifactPlan | null = null;
    try {
      fixedPlan = legacyAvailability === 'available'
        ? pinFixedArtifactDefinitions(this.legacyStorageDir, rawDefinitions)
        : {
          definitions: rawDefinitions.map((definition) => ({
            ...definition,
            sourceDirectoryMissing: true,
          })),
          leases: [],
        };
      definitions = fixedPlan.definitions;
      const workspaceRoot = ref.storageRoot ?? ref.storageScope?.workspaceRoot;
      if (!workspaceRoot) {
        throw Object.assign(new Error('Workspace scope is required'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      binaryPlan = await buildBinaryArtifactPlan(
        ref,
        definitions,
        workspaceRoot,
        ownerKey,
        id,
        true,
        this.hooks,
      );
      definitions.push(...binaryPlan.definitions);
      if (definitions.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
        throw Object.assign(new Error('Migration plan exceeds its marker artifact bound'), {
          migrationReason: 'unsafe_source',
        });
      }

      const recoverAll = async (): Promise<void> => {
        for (const definition of definitions) await recoverBackup(definition, this.hooks);
      };
      let previousMarker: MigrationMarker | null;
      try {
        previousMarker = await readMarker(
          targetDir,
          ownerKey,
          id,
          ref.ownerUserId,
          definitions,
        );
      } catch (error) {
        try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
        const reason = migrationReason(error);
        const entries = definitions.map((entry) => blockedArtifact(entry, reason));
        return { status: 'blocked', artifacts: entries };
      }

      let prepared: PreparedArtifact[] = [];
      // The preparation pass may publish verified targets, but never removes a
      // source. A later conflict therefore cannot leave a partially-cut legacy
      // session behind.
      for (const definition of definitions) {
        prepared.push(await prepareArtifact(definition, previousMarker, this.hooks));
      }
      let entries = prepared.map((item) => item.entry);
      if (entries.some((entry) => entry.state === 'blocked')) {
        try { await recoverAll(); } catch { /* The blocked entries remain authoritative. */ }
        return { status: overallStatus(entries), artifacts: entries };
      }

      const backups = new Map<string, Fingerprint>();
      for (const item of prepared) {
        if (item.entry.state !== 'migrated') continue;
        try {
          const backup = await ensureBackup(item.definition, this.hooks);
          if (!backup || !item.sourceFingerprint) {
            throw Object.assign(new Error('Legacy source disappeared before cutover'), {
              migrationReason: 'source_changed',
            });
          }
          if (!sameFingerprint(backup, item.sourceFingerprint)) {
            throw Object.assign(new Error('Legacy backup differs from its source'), {
              migrationReason: 'source_changed',
            });
          }
          backups.set(item.definition.key, backup);
        } catch (error) {
          try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
          entries = blockedCutoverEntries(prepared, migrationReason(error), item.definition.artifact);
          return { status: overallStatus(entries), artifacts: entries };
        }
      }

      // Verify the complete set once more after creating the rollback backups.
      // This closes the window in which a live legacy writer could mutate one
      // member between its initial copy and the session-wide commit.
      const reverified: PreparedArtifact[] = [];
      for (const definition of definitions) {
        reverified.push(await prepareArtifact(definition, previousMarker, this.hooks));
      }
      prepared = reverified;
      entries = prepared.map((item) => item.entry);
      if (entries.some((entry) => entry.state === 'blocked')) {
        try { await recoverAll(); } catch { /* The blocked entries remain authoritative. */ }
        return { status: overallStatus(entries), artifacts: entries };
      }
      for (const item of prepared) {
        const expectedSource = backups.get(item.definition.key);
        if (
          expectedSource
          && (
            !item.sourceFingerprint
            || !sameFingerprint(expectedSource, item.sourceFingerprint)
            || !item.targetFingerprint
          )
        ) {
          try { await recoverAll(); } catch { /* Report the verified mismatch below. */ }
          entries = blockedCutoverEntries(prepared, 'source_changed', item.definition.artifact);
          return { status: overallStatus(entries), artifacts: entries };
        }
      }

      const verifiedMarker = markerFromPrepared(ownerKey, ref.ownerUserId, id, 'verified', prepared);
      try {
        await writeMarker(targetDir, verifiedMarker, this.hooks);
      } catch (error) {
        try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
        entries = blockedCutoverEntries(prepared, migrationReason(error));
        return { status: overallStatus(entries), artifacts: entries };
      }

      try {
        await commitPreparedSources(prepared, backups, this.hooks);
        await writeMarker(targetDir, { ...verifiedMarker, phase: 'complete' }, this.hooks);
      } catch (error) {
        try {
          await restorePreparedSources(prepared, this.hooks);
        } catch (restoreError) {
          entries = blockedCutoverEntries(prepared, migrationReason(restoreError));
          return { status: overallStatus(entries), artifacts: entries };
        }
        entries = blockedCutoverEntries(
          prepared,
          migrationReason(error),
          (error as { migrationArtifact?: LegacySessionArtifact }).migrationArtifact,
        );
        return { status: overallStatus(entries), artifacts: entries };
      }

      // Backups intentionally survive until the caller confirms that the
      // workspace-local SQLite rows and usage were copied and their legacy rows
      // removed. `confirm()` then removes the final global artifacts.
      return { status: 'complete', artifacts: entries };
    } catch (error) {
      try {
        for (const definition of definitions) await recoverBackup(definition, this.hooks);
      } catch (recoveryError) {
        error = recoveryError;
      }
      const reason = migrationReason(error);
      const entries = definitions.map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    } finally {
      for (const lease of binaryPlan?.leases.reverse() ?? []) lease.close();
      for (const lease of fixedPlan?.leases.reverse() ?? []) lease.close();
    }
  }
}

export default WorkspaceSessionArtifactMigrator;
