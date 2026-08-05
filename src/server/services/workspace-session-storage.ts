import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An optional, immutable location for artefacts which belong to one workspace.
 *
 * This deliberately lives beside the stores rather than on SessionRecord: a
 * session row remains portable, while the process that starts it can attach a
 * workspace location to the in-memory ref it hands to the stores.
 */
export interface WorkspaceSessionStorageRef {
  /** Absolute workspace root chosen when the session is created. */
  storageRoot?: string;
  /** Stable owner namespace. Defaults to the numeric owner id for old callers. */
  ownerKey?: string;
  /** SessionRecord-compatible form; immutable after the record is created. */
  storageScope?: {
    readonly workspaceRoot: string;
    readonly ownerKey: string;
  };
  /** Live admission gate used while an owning project workspace is replaced. */
  persistenceUnavailable?: string;
}

export interface WorkspaceSessionIdentity extends WorkspaceSessionStorageRef {
  id: string;
  ownerUserId: number;
}

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const GITIGNORE_BODY = '# Written by code-agents-webcli. Workspace session artefacts are local.\n*\n';
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const NON_BLOCK = (fs.constants as unknown as Record<string, number>).O_NONBLOCK ?? 0;
const DIRECTORY = (fs.constants as unknown as Record<string, number>).O_DIRECTORY ?? 0;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY;
interface SessionDirectoryLeaseRecord {
  readonly fd: number;
  readonly accessPath: string;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceEntryMutationPolicy;
}

const sessionDirectoryLeases = new Map<string, SessionDirectoryLeaseRecord>();
let descriptorRootCache: string | null | undefined;
const handlePinCapabilityCache = new Map<string, boolean>();

interface OpenDirectory {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
}

export interface WorkspaceStorageDirectoryLease {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
  /** True when child lookups can only use the canonical pathname. */
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceEntryMutationPolicy;
  verify(): void;
  close(): void;
}

/** Exact inode authority retained by an already-open workspace storage lease. */
export interface WorkspaceStorageIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Pinned parent for one of the direct files in a workspace session directory.
 *
 * File stores retain this lease across the path-based fallback's unavoidable
 * name lookup. Verifying it before and after each lookup prevents a renamed
 * session directory from silently rebinding an operation to another inode.
 */
export interface WorkspaceSessionFileParentLease {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceEntryMutationPolicy;
  verify(): void;
}

export interface WorkspaceStorageOpenOptions {
  /** Exercise the strict pathname backend; entry mutations fail closed in this test seam. */
  forcePathFallback?: boolean;
  /** Open an existing hierarchy without creating any missing component. */
  createIfMissing?: boolean;
  /** Require `.cc-web` to be the inode authorised before lifecycle suspension. */
  expectedIdentity?: WorkspaceStorageIdentity;
}

/**
 * How direct child entry mutations are bound to their parent.
 *
 * `handle-pinned-path` is selected only after a Windows volume probe proves
 * that the handles Node opens deny both ancestor rename and directory deletion
 * while live. A pathname verified before and after a syscall cannot detect a
 * swap restored during that syscall, so every other fallback fails closed for
 * create, unlink and rename.
 */
export type WorkspaceEntryMutationPolicy =
  | 'descriptor'
  | 'handle-pinned-path'
  | 'deny';

function unsafe(message: string): Error {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE' });
}

function safeComponent(value: unknown, name: string): string {
  const text = String(value);
  if (!SAFE_COMPONENT.test(text) || text === '.' || text === '..') {
    throw unsafe(`Refusing unsafe ${name} for workspace storage: ${JSON.stringify(text)}`);
  }
  return text;
}

/** True when a ref opts in to workspace-local artefacts. */
export function hasWorkspaceSessionStorage(ref: WorkspaceSessionStorageRef): boolean {
  return ref.storageRoot !== undefined || ref.storageScope !== undefined;
}

/**
 * The location is a directory, not a filename namespace. This keeps the
 * store-specific filenames out of the public session layout and gives future
 * artefacts one well-defined home.
 */
export function workspaceSessionDirectory(ref: WorkspaceSessionIdentity): string | null {
  if (!hasWorkspaceSessionStorage(ref)) {
    return null;
  }
  const storageRoot = ref.storageRoot ?? ref.storageScope?.workspaceRoot;
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw unsafe('Refusing a non-absolute workspace storage root');
  }
  const root = path.resolve(storageRoot);
  if (root === path.parse(root).root) {
    throw unsafe('Refusing a filesystem root as workspace storage');
  }
  const ownerKey = safeComponent(ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId, 'owner key');
  const id = safeComponent(ref.id, 'session id');
  return path.join(root, '.cc-web', 'sessions', ownerKey, id);
}

function fdRoot(): string | null {
  if (descriptorRootCache !== undefined) return descriptorRootCache;
  // Probe actual child traversal instead of platform names. `/proc/self/fd`
  // is usual on Linux and `/dev/fd` on macOS/BSD, but either can exist without
  // permitting `<fd>/child` mutations in the current runtime/container.
  for (const candidate of ['/proc/self/fd', '/dev/fd']) {
    let probeFd: number | null = null;
    let probeFileFd: number | null = null;
    let probeDirectory: string | null = null;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      probeDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-fd-probe-')));
      const child = path.join(probeDirectory, 'child');
      fs.mkdirSync(child, { mode: 0o700 });
      probeFd = fs.openSync(probeDirectory, DIRECTORY_FLAGS);
      const accessPath = fdAccessPath(probeFd, candidate);
      const traversed = fs.statSync(path.join(accessPath, 'child'));
      const expectedChild = fs.statSync(child);
      const created = path.join(accessPath, 'created');
      const renamed = path.join(accessPath, 'renamed');
      const createdDirectory = path.join(accessPath, 'created-directory');
      const renamedDirectory = path.join(accessPath, 'renamed-directory');
      probeFileFd = fs.openSync(
        created,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      fs.closeSync(probeFileFd);
      probeFileFd = null;
      fs.renameSync(created, renamed);
      fs.unlinkSync(renamed);
      fs.mkdirSync(createdDirectory, { mode: 0o700 });
      fs.renameSync(createdDirectory, renamedDirectory);
      fs.rmdirSync(renamedDirectory);
      if (
        traversed.isDirectory()
        && sameDirectoryIdentity(traversed, expectedChild)
        && !sameDirectoryIdentity(traversed, fs.fstatSync(probeFd))
        && fs.realpathSync(accessPath) === probeDirectory
      ) {
        descriptorRootCache = candidate;
        return candidate;
      }
    } catch {
      // Try the next platform fd namespace.
    } finally {
      if (probeFileFd !== null) {
        try { fs.closeSync(probeFileFd); } catch { /* Probe cleanup is best effort. */ }
      }
      if (probeFd !== null) fs.closeSync(probeFd);
      if (probeDirectory !== null) {
        for (const name of ['created', 'renamed']) {
          try { fs.unlinkSync(path.join(probeDirectory, name)); } catch { /* Already absent. */ }
        }
        for (const name of ['created-directory', 'renamed-directory']) {
          try { fs.rmdirSync(path.join(probeDirectory, name)); } catch { /* Never recurse. */ }
        }
        try { fs.rmdirSync(path.join(probeDirectory, 'child')); } catch { /* Never recurse. */ }
        try { fs.rmdirSync(probeDirectory); } catch { /* Leave unexpected contents untouched. */ }
      }
    }
  }
  descriptorRootCache = null;
  return null;
}

/** A descriptor namespace is returned only after real child create/rename/unlink succeeds. */
export function workspaceDescriptorRoot(): string | null {
  return fdRoot();
}

function fdAccessPath(fd: number, descriptorRoot: string): string {
  return path.join(descriptorRoot, String(fd));
}

function sameDirectoryIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev !== right.dev) return false;
  // Node exposes the Windows file index as `ino` on supported filesystems.
  // Retain a conservative birth-time fallback for providers which report 0.
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && sameDirectoryIdentity(left, right);
}

function hardenMode(fd: number, mode: number): void {
  try {
    fs.fchmodSync(fd, mode);
  } catch (error) {
    // Windows has no POSIX mode model and some providers reject fchmod even
    // though the already-open handle remains private to this process. Unix
    // permission failures are security failures and remain fail-closed.
    if (process.platform !== 'win32') throw error;
  }
}

/**
 * Validate the existing workspace ignore marker without ever reopening it by
 * its untrusted canonical path after validation. `container.accessPath` is
 * descriptor-relative whenever the host exposes a proven fd namespace; the
 * pathname fallback retains the pinned parent checks on both sides.
 *
 * No contents are read or rewritten. The only mutation is fchmod(0600) on the
 * exact regular-file descriptor whose identity is checked before and after.
 */
function hardenExistingWorkspaceGitignore(container: OpenDirectory, ignorePath: string): void {
  verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(ignorePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw unsafe('Workspace .gitignore changed while it was being validated');
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw unsafe('Workspace .gitignore must be a private regular non-symlink file');
  }

  let fd: number | null = null;
  try {
    try {
      // O_NONBLOCK prevents a regular-file-to-FIFO race from hanging startup.
      fd = fs.openSync(ignorePath, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EISDIR') {
        throw unsafe('Workspace .gitignore changed while it was being opened');
      }
      throw error;
    }

    const opened = fs.fstatSync(fd);
    const afterOpen = fs.lstatSync(ignorePath);
    if (
      afterOpen.isSymbolicLink()
      || !sameFileIdentity(before, opened)
      || !sameFileIdentity(opened, afterOpen)
      || opened.nlink !== 1
      || afterOpen.nlink !== 1
    ) {
      throw unsafe('Workspace .gitignore changed while it was being opened');
    }
    verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);

    hardenMode(fd, 0o600);

    const hardened = fs.fstatSync(fd);
    const afterHarden = fs.lstatSync(ignorePath);
    if (
      afterHarden.isSymbolicLink()
      || !sameFileIdentity(opened, hardened)
      || !sameFileIdentity(hardened, afterHarden)
      || hardened.nlink !== 1
      || afterHarden.nlink !== 1
    ) {
      throw unsafe('Workspace .gitignore changed while it was being hardened');
    }
    if (process.platform !== 'win32' && (hardened.mode & 0o7777) !== 0o600) {
      throw unsafe('Workspace .gitignore permissions could not be hardened to 0600');
    }
    verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EISDIR') {
      throw unsafe('Workspace .gitignore changed while it was being validated');
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Confirm that a just-created marker still owns its descriptor-relative name. */
function verifyCreatedWorkspaceGitignore(
  container: OpenDirectory,
  ignorePath: string,
  fd: number,
): void {
  const opened = fs.fstatSync(fd);
  const visible = fs.lstatSync(ignorePath);
  if (
    visible.isSymbolicLink()
    || !sameFileIdentity(opened, visible)
    || opened.nlink !== 1
    || visible.nlink !== 1
  ) {
    throw unsafe('Workspace .gitignore changed while it was being created');
  }
  if (process.platform !== 'win32' && (opened.mode & 0o7777) !== 0o600) {
    throw unsafe('Workspace .gitignore permissions could not be hardened to 0600');
  }
  verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);
}

/**
 * Windows can make the pathname fallback safe only when Node's real handle
 * flags deny FILE_SHARE_DELETE. Probe both namespace operations on the actual
 * workspace volume instead of assuming libuv's CreateFile sharing mode:
 *
 * - a live descendant handle must prevent its ancestor from being renamed;
 * - a live directory handle must prevent that directory from being removed.
 *
 * Each operation must become possible immediately after close, which separates
 * handle pinning from an ACL, read-only mount, antivirus lock or other failure.
 */
function probeHandlePinsMutationNamespace(parent: OpenDirectory): boolean {
  const token = randomBytes(12).toString('hex');
  const renameParent = path.join(parent.accessPath, `.cc-web-pin-rename-${token}`);
  const renameChild = path.join(renameParent, 'child');
  const movedParent = `${renameParent}.moved`;
  const deleteTarget = path.join(parent.accessPath, `.cc-web-pin-delete-${token}`);
  let pinFd: number | null = null;
  let currentRenameParent = renameParent;
  let deleteTargetExists = false;
  try {
    verifyDirectoryBinding(parent.canonicalPath, parent.fd, parent.accessPath);
    fs.mkdirSync(renameParent, { mode: 0o700 });
    fs.mkdirSync(renameChild, { mode: 0o700 });
    pinFd = fs.openSync(renameChild, DIRECTORY_FLAGS);
    const childStat = fs.fstatSync(pinFd);
    if (!childStat.isDirectory()) return false;

    let renameBlockedWhileOpen = false;
    try {
      fs.renameSync(renameParent, movedParent);
      currentRenameParent = movedParent;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') return false;
      renameBlockedWhileOpen = true;
    }
    fs.closeSync(pinFd);
    pinFd = null;

    if (!renameBlockedWhileOpen) return false;
    // Distinguish a handle sharing denial from ACL/read-only failures: the
    // exact rename must become possible as soon as the child handle closes.
    fs.renameSync(renameParent, movedParent);
    currentRenameParent = movedParent;
    fs.renameSync(movedParent, renameParent);
    currentRenameParent = renameParent;

    fs.mkdirSync(deleteTarget, { mode: 0o700 });
    deleteTargetExists = true;
    pinFd = fs.openSync(deleteTarget, DIRECTORY_FLAGS);
    let deleteBlockedWhileOpen = false;
    try {
      fs.rmdirSync(deleteTarget);
      deleteTargetExists = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') return false;
      deleteBlockedWhileOpen = true;
    }
    fs.closeSync(pinFd);
    pinFd = null;
    if (!deleteBlockedWhileOpen) return false;
    fs.rmdirSync(deleteTarget);
    deleteTargetExists = false;

    verifyDirectoryBinding(parent.canonicalPath, parent.fd, parent.accessPath);
    return true;
  } catch {
    return false;
  } finally {
    if (pinFd !== null) {
      try { fs.closeSync(pinFd); } catch { /* Probe cleanup is best effort. */ }
    }
    if (deleteTargetExists) {
      try { fs.rmdirSync(deleteTarget); } catch { /* Never recurse over an unexpected entry. */ }
    }
    const child = path.join(currentRenameParent, 'child');
    try { fs.rmdirSync(child); } catch { /* Never recurse over an unexpected entry. */ }
    try { fs.rmdirSync(currentRenameParent); } catch { /* Never recurse over an unexpected entry. */ }
    if (currentRenameParent !== renameParent) {
      try { fs.rmdirSync(renameParent); } catch { /* Already moved or occupied. */ }
    }
  }
}

function handlePinsMutationNamespace(parent: OpenDirectory): boolean {
  if (process.platform !== 'win32') return false;
  const stat = fs.fstatSync(parent.fd);
  // Filesystem filters and network providers can change sharing semantics even
  // under one drive letter. Cache per canonical workspace, not merely per
  // volume root, so a successful NTFS probe never blesses an unrelated mount.
  const key = `${stat.dev}:${parent.canonicalPath.toLowerCase()}`;
  const cached = handlePinCapabilityCache.get(key);
  if (cached !== undefined) return cached;
  const supported = probeHandlePinsMutationNamespace(parent);
  handlePinCapabilityCache.set(key, supported);
  return supported;
}

/**
 * Run the real rename+rmdir probe without consulting platform/cache.
 * Exported so security tests can deterministically model Windows sharing
 * errors on non-Windows CI; production should use the cached wrapper below.
 */
export function probeWorkspacePathMutationPin(canonicalPath: string, fd: number): boolean {
  return probeHandlePinsMutationNamespace({ canonicalPath, accessPath: canonicalPath, fd });
}

/** Pure selector used by both workspace artefacts and attachment storage. */
export function resolveWorkspaceEntryMutationPolicy(
  descriptorRoot: string | null,
  platform: NodeJS.Platform,
  windowsHandlePinned: boolean,
): WorkspaceEntryMutationPolicy {
  if (descriptorRoot) return 'descriptor';
  if (platform === 'win32' && windowsHandlePinned) return 'handle-pinned-path';
  return 'deny';
}

/** Probe the real workspace volume before allowing any pathname entry mutation. */
export function workspacePathMutationsAreHandlePinned(canonicalPath: string, fd: number): boolean {
  if (process.platform !== 'win32') return false;
  return handlePinsMutationNamespace({ canonicalPath, accessPath: canonicalPath, fd });
}

function verifyDirectoryBinding(target: string, fd: number, accessPath: string): void {
  const visible = fs.lstatSync(target);
  const opened = fs.fstatSync(fd);
  if (
    visible.isSymbolicLink()
    || !visible.isDirectory()
    || !opened.isDirectory()
    || fs.realpathSync(target) !== target
    || !sameDirectoryIdentity(visible, opened)
  ) {
    throw unsafe(`Workspace directory changed while it was open: ${target}`);
  }
  if (accessPath !== target && fs.realpathSync(accessPath) !== target) {
    throw unsafe(`Workspace descriptor no longer names its directory: ${target}`);
  }
}

function verifiedDirectory(target: string, descriptorRoot: string | null): OpenDirectory {
  const before = fs.lstatSync(target);
  if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(target) !== target) {
    throw unsafe(`Workspace path is not a canonical directory: ${target}`);
  }
  const fd = fs.openSync(target, DIRECTORY_FLAGS);
  const accessPath = descriptorRoot ? fdAccessPath(fd, descriptorRoot) : target;
  try {
    verifyDirectoryBinding(target, fd, accessPath);
    if (!sameDirectoryIdentity(before, fs.fstatSync(fd))) {
      throw unsafe(`Workspace directory changed while opening: ${target}`);
    }
    return { canonicalPath: target, accessPath, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openChildDirectory(
  parent: OpenDirectory,
  name: string,
  descriptorRoot: string | null,
  createIfMissing = true,
  allowPathMutation = false,
  expectedIdentity?: WorkspaceStorageIdentity,
): OpenDirectory {
  verifyDirectoryBinding(parent.canonicalPath, parent.fd, parent.accessPath);
  const component = safeComponent(name, 'directory component');
  const target = path.join(parent.accessPath, component);
  const canonicalPath = path.join(parent.canonicalPath, component);
  let exists = true;
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    if (!createIfMissing) {
      throw Object.assign(new Error(`ENOENT: no such workspace directory: ${canonicalPath}`), {
        code: 'ENOENT',
      });
    }
    if (descriptorRoot === null && !allowPathMutation) {
      // A pathname-only mkdir cannot be bound to the already-open parent. An
      // attacker could exchange the parent for a symlink for exactly the
      // duration of mkdir and restore it before either identity check. Hosts
      // without an openat-like descriptor namespace therefore require the
      // hierarchy to be provisioned by a trusted operation first.
      throw unsafe(`Creating workspace directory ${canonicalPath} requires descriptor-relative access`);
    }
    fs.mkdirSync(target, { mode: 0o700 });
  }
  let fd: number;
  try {
    fd = fs.openSync(target, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw unsafe(`Workspace ${component} storage path must be a real directory (not a symlink)`);
    }
    throw error;
  }
  const accessPath = descriptorRoot ? fdAccessPath(fd, descriptorRoot) : canonicalPath;
  try {
    verifyDirectoryBinding(canonicalPath, fd, accessPath);
    // In the path-based Windows backend the parent handle is the stable
    // reference. Checking it again after the child open detects a directory
    // exchange during the operation; the opened child is never used on fail.
    verifyDirectoryBinding(parent.canonicalPath, parent.fd, parent.accessPath);
    if (expectedIdentity) {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (
        !opened.isDirectory()
        || opened.dev !== expectedIdentity.dev
        || opened.ino !== expectedIdentity.ino
      ) {
        throw unsafe(`Workspace ${component} storage is not the authorised inode`);
      }
    }
    hardenMode(fd, 0o700);
    return { canonicalPath, accessPath, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** Open `.cc-web` beneath a verified root inode and keep that inode pinned. */
export function openWorkspaceStorageDirectorySync(
  workspaceRoot: string,
  options: WorkspaceStorageOpenOptions = {},
): WorkspaceStorageDirectoryLease {
  if (!path.isAbsolute(workspaceRoot)) throw unsafe('Workspace root must be absolute');
  const root = path.resolve(workspaceRoot);
  if (root === path.parse(root).root) throw unsafe('Refusing a filesystem root as workspace storage');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw unsafe('Workspace storage requires a real canonical non-symlink root');
  }
  const descriptorRoot = options.forcePathFallback ? null : fdRoot();
  const createIfMissing = options.expectedIdentity ? false : options.createIfMissing !== false;
  const rootDirectory = verifiedDirectory(root, descriptorRoot);
  const entryMutationPolicy = resolveWorkspaceEntryMutationPolicy(
    descriptorRoot,
    process.platform,
    !options.forcePathFallback && handlePinsMutationNamespace(rootDirectory),
  );
  let container: OpenDirectory | null = null;
  try {
    container = openChildDirectory(
      rootDirectory,
      '.cc-web',
      descriptorRoot,
      createIfMissing,
      entryMutationPolicy === 'handle-pinned-path',
      options.expectedIdentity,
    );
    const accessPath = container.accessPath;
    const ignorePath = path.join(accessPath, '.gitignore');
    let ignoreFd: number | null = null;
    let existingIgnore = false;
    if (createIfMissing && entryMutationPolicy !== 'deny') {
      try {
        verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);
        ignoreFd = fs.openSync(
          ignorePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        fs.writeFileSync(ignoreFd, GITIGNORE_BODY);
        hardenMode(ignoreFd, 0o600);
        verifyCreatedWorkspaceGitignore(container, ignorePath, ignoreFd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        existingIgnore = true;
      } finally {
        if (ignoreFd !== null) fs.closeSync(ignoreFd);
      }
    }
    if (!existingIgnore) {
      try {
        existingIgnore = fs.lstatSync(ignorePath) !== undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (existingIgnore) hardenExistingWorkspaceGitignore(container, ignorePath);
    verifyDirectoryBinding(container.canonicalPath, container.fd, container.accessPath);
    const pinned = container;
    container = null;
    let closed = false;
    return {
      canonicalPath: path.join(root, '.cc-web'),
      accessPath,
      fd: pinned.fd,
      pathFallback: descriptorRoot === null,
      entryMutationPolicy,
      verify: () => verifyDirectoryBinding(pinned.canonicalPath, pinned.fd, pinned.accessPath),
      close: () => {
        if (closed) return;
        closed = true;
        fs.closeSync(pinned.fd);
      },
    };
  } finally {
    if (container !== null) fs.closeSync(container.fd);
    fs.closeSync(rootDirectory.fd);
  }
}

/**
 * Pin the shared paste directory below `.cc-web` for one bounded operation.
 *
 * When descriptor traversal is available, `accessPath` remains attached to the
 * opened inode even if the visible workspace path is exchanged. Otherwise the
 * lease reports an explicit handle-pinned or deny mutation policy.
 */
export function openWorkspacePasteDirectorySync(
  workspaceRoot: string,
  options: WorkspaceStorageOpenOptions = {},
): WorkspaceStorageDirectoryLease {
  const container = openWorkspaceStorageDirectorySync(workspaceRoot, options);
  const descriptorRoot = container.pathFallback ? null : fdRoot();
  let pasted: OpenDirectory | null = null;
  try {
    const containerDirectory: OpenDirectory = {
      canonicalPath: container.canonicalPath,
      accessPath: container.accessPath,
      fd: container.fd,
    };
    pasted = openChildDirectory(
      containerDirectory,
      'pasted',
      descriptorRoot,
      options.createIfMissing !== false,
      container.entryMutationPolicy === 'handle-pinned-path',
    );
    const pinned = pasted;
    pasted = null;
    let closed = false;
    return {
      canonicalPath: pinned.canonicalPath,
      accessPath: pinned.accessPath,
      fd: pinned.fd,
      pathFallback: descriptorRoot === null,
      entryMutationPolicy: container.entryMutationPolicy,
      verify: () => verifyDirectoryBinding(pinned.canonicalPath, pinned.fd, pinned.accessPath),
      close: () => {
        if (closed) return;
        closed = true;
        fs.closeSync(pinned.fd);
      },
    };
  } finally {
    if (pasted !== null) fs.closeSync(pasted.fd);
    container.close();
  }
}

/** Pin the flat attachment directory used by pre-namespace releases. */
export function openWorkspaceAttachmentRootDirectorySync(
  workspaceRoot: string,
  options: WorkspaceStorageOpenOptions = {},
): WorkspaceStorageDirectoryLease {
  const container = openWorkspaceStorageDirectorySync(workspaceRoot, options);
  const descriptorRoot = container.pathFallback ? null : fdRoot();
  let attachments: OpenDirectory | null = null;
  try {
    attachments = openChildDirectory(
      {
        canonicalPath: container.canonicalPath,
        accessPath: container.accessPath,
        fd: container.fd,
      },
      'attachments',
      descriptorRoot,
      options.createIfMissing !== false,
      container.entryMutationPolicy === 'handle-pinned-path',
    );
    const pinned = attachments;
    attachments = null;
    let closed = false;
    return {
      canonicalPath: pinned.canonicalPath,
      accessPath: pinned.accessPath,
      fd: pinned.fd,
      pathFallback: descriptorRoot === null,
      entryMutationPolicy: container.entryMutationPolicy,
      verify: () => verifyDirectoryBinding(pinned.canonicalPath, pinned.fd, pinned.accessPath),
      close: () => {
        if (closed) return;
        closed = true;
        fs.closeSync(pinned.fd);
      },
    };
  } finally {
    if (attachments !== null) fs.closeSync(attachments.fd);
    container.close();
  }
}

/**
 * Pin the owner/session attachment namespace below the immutable workspace.
 *
 * Migration uses the same hierarchy as AttachmentStore, but it has to keep
 * the destination directory open while publishing several legacy files.  A
 * dedicated lease prevents that bulk copy from falling back to recursive
 * pathname creation or from silently rebinding after a directory exchange.
 */
export function openWorkspaceAttachmentDirectorySync(
  workspaceRoot: string,
  ownerKey: string,
  sessionId: string,
  options: WorkspaceStorageOpenOptions = {},
): WorkspaceStorageDirectoryLease {
  const container = openWorkspaceStorageDirectorySync(workspaceRoot, options);
  const descriptorRoot = container.pathFallback ? null : fdRoot();
  const createIfMissing = options.createIfMissing !== false;
  const components = [
    safeComponent(ownerKey, 'attachment owner key'),
    safeComponent(sessionId, 'attachment session id'),
  ];
  let current: OpenDirectory | null = null;
  const opened: OpenDirectory[] = [];
  try {
    current = {
      canonicalPath: container.canonicalPath,
      accessPath: container.accessPath,
      fd: container.fd,
    };
    for (const component of ['attachments', ...components]) {
      const child = openChildDirectory(
        current,
        component,
        descriptorRoot,
        createIfMissing,
        container.entryMutationPolicy === 'handle-pinned-path',
      );
      opened.push(child);
      current = child;
    }

    const pinned = opened.pop()!;
    let closed = false;
    return {
      canonicalPath: pinned.canonicalPath,
      accessPath: pinned.accessPath,
      fd: pinned.fd,
      pathFallback: descriptorRoot === null,
      entryMutationPolicy: container.entryMutationPolicy,
      verify: () => verifyDirectoryBinding(pinned.canonicalPath, pinned.fd, pinned.accessPath),
      close: () => {
        if (closed) return;
        closed = true;
        fs.closeSync(pinned.fd);
      },
    };
  } finally {
    for (const directory of opened.reverse()) fs.closeSync(directory.fd);
    container.close();
  }
}

/** Stable descriptor-relative path used by every live artifact store. */
export function workspaceSessionAccessDirectory(
  ref: WorkspaceSessionIdentity,
  options: WorkspaceStorageOpenOptions = {},
): string | null {
  const canonical = workspaceSessionDirectory(ref);
  if (!canonical) return null;
  const cached = sessionDirectoryLeases.get(canonical);
  if (cached) {
    try {
      verifyDirectoryBinding(canonical, cached.fd, cached.accessPath);
      const forcedPolicy = options.forcePathFallback ? 'deny' : null;
      if (
        forcedPolicy === null
        || (cached.pathFallback && cached.entryMutationPolicy === forcedPolicy)
      ) return cached.accessPath;
    } catch (error) {
      // Never silently rebind a live session to whatever now occupies the
      // canonical name. The explicit lease close APIs are the only operation
      // allowed to retire this inode and permit a later fresh session.
      throw unsafe(`Workspace session directory changed while leased: ${canonical}: ${String(error)}`);
    }
    // A test may deliberately select the conservative path backend after a
    // verified descriptor-backed lease was opened. This synchronous switch is
    // safe because the directory identity was just checked above.
    try { fs.closeSync(cached.fd); } catch { /* Already invalidated. */ }
    sessionDirectoryLeases.delete(canonical);
  }

  const storageRoot = ref.storageRoot ?? ref.storageScope?.workspaceRoot;
  if (!storageRoot) throw unsafe('Workspace storage root is unavailable');
  const container = openWorkspaceStorageDirectorySync(storageRoot, {
    forcePathFallback: options.forcePathFallback,
  });
  const pathFallback = container.pathFallback;
  const descriptorRoot = pathFallback ? null : fdRoot();
  let sessions: OpenDirectory | null = null;
  let owner: OpenDirectory | null = null;
  let session: OpenDirectory | null = null;
  try {
    const containerDirectory: OpenDirectory = {
      canonicalPath: container.canonicalPath,
      accessPath: container.accessPath,
      fd: container.fd,
    };
    sessions = openChildDirectory(
      containerDirectory,
      'sessions',
      descriptorRoot,
      true,
      container.entryMutationPolicy === 'handle-pinned-path',
    );
    owner = openChildDirectory(
      sessions,
      safeComponent(ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId, 'owner key'),
      descriptorRoot,
      true,
      container.entryMutationPolicy === 'handle-pinned-path',
    );
    session = openChildDirectory(
      owner,
      safeComponent(ref.id, 'session id'),
      descriptorRoot,
      true,
      container.entryMutationPolicy === 'handle-pinned-path',
    );
    verifyDirectoryBinding(canonical, session.fd, session.accessPath);
    const accessPath = session.accessPath;
    sessionDirectoryLeases.set(canonical, {
      fd: session.fd,
      accessPath,
      pathFallback,
      entryMutationPolicy: container.entryMutationPolicy,
    });
    session = null;
    return accessPath;
  } finally {
    if (session !== null) fs.closeSync(session.fd);
    if (owner !== null) fs.closeSync(owner.fd);
    if (sessions !== null) fs.closeSync(sessions.fd);
    container.close();
  }
}

/**
 * Return the pinned lease only when `file` is an exact direct child of a live
 * workspace session directory. Legacy global-store paths deliberately return
 * null and keep their existing path semantics.
 */
export function workspaceSessionFileParentLease(file: string): WorkspaceSessionFileParentLease | null {
  if (!path.isAbsolute(file)) return null;
  const parent = path.dirname(file);
  for (const [canonicalPath, lease] of sessionDirectoryLeases) {
    if (parent !== canonicalPath && parent !== lease.accessPath) continue;
    return {
      canonicalPath,
      accessPath: lease.accessPath,
      fd: lease.fd,
      pathFallback: lease.pathFallback,
      entryMutationPolicy: lease.entryMutationPolicy,
      verify: () => verifyDirectoryBinding(canonicalPath, lease.fd, lease.accessPath),
    };
  }
  return null;
}

/** Release one cached session inode after its final artifact cleanup. */
export function closeWorkspaceSessionDirectoryLease(ref: WorkspaceSessionIdentity): void {
  const canonical = workspaceSessionDirectory(ref);
  if (!canonical) return;
  const lease = sessionDirectoryLeases.get(canonical);
  if (!lease) return;
  sessionDirectoryLeases.delete(canonical);
  try { fs.closeSync(lease.fd); } catch { /* Idempotent teardown. */ }
}

/** Release every cached session inode before a workspace is explicitly deleted. */
export function closeWorkspaceSessionDirectoryLeasesForScope(scope: {
  workspaceRoot: string;
  ownerKey: string;
}): void {
  const ownerRoot = path.join(
    path.resolve(scope.workspaceRoot),
    '.cc-web',
    'sessions',
    safeComponent(scope.ownerKey, 'owner key'),
  );
  const prefix = `${ownerRoot}${path.sep}`;
  for (const [canonical, lease] of sessionDirectoryLeases) {
    if (!canonical.startsWith(prefix)) continue;
    sessionDirectoryLeases.delete(canonical);
    try { fs.closeSync(lease.fd); } catch { /* Idempotent teardown. */ }
  }
}

export function closeWorkspaceSessionDirectoryLeases(): void {
  for (const lease of sessionDirectoryLeases.values()) {
    try { fs.closeSync(lease.fd); } catch { /* Already closed during teardown. */ }
  }
  sessionDirectoryLeases.clear();
}

/**
 * Create a workspace session directory one level at a time. `mkdir -p` is
 * intentionally avoided: it follows a pre-existing `.cc-web` symlink before
 * a later check can catch it.
 */
export async function ensureWorkspaceSessionDirectory(ref: WorkspaceSessionIdentity): Promise<string | null> {
  const sessionDir = workspaceSessionDirectory(ref);
  if (!sessionDir) return null;

  // Descriptor-relative creation pins every component and fails closed when a
  // parent is exchanged concurrently. The older path walk below remains only
  // for legacy refs without workspace storage.
  workspaceSessionAccessDirectory(ref);
  return sessionDir;
}
