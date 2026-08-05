import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  workspaceSessionFileParentLease,
  type WorkspaceSessionFileParentLease,
} from './workspace-session-storage.js';

/**
 * Exact-component file operations for artefacts below a pinned session
 * directory.  The directory resolver prevents ancestor traversal; these
 * helpers close the remaining gap where a pre-existing final component could
 * be a symlink (or another non-regular filesystem object).
 */

const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const NON_BLOCK = (fs.constants as unknown as Record<string, number>).O_NONBLOCK ?? 0;
const READ_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK;
const WRITE_FLAGS = fs.constants.O_WRONLY | NO_FOLLOW | NON_BLOCK;

function unsafe(file: string, detail = 'is not a private regular file', cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`Unsafe workspace session file ${file}: ${detail}`), {
    code: 'UNSAFE_WORKSPACE_SESSION_FILE',
    cause,
  });
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

function assertPrivateRegular(stat: fs.Stats, file: string): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw unsafe(file);
  }
}

type ParentLease = WorkspaceSessionFileParentLease | null;

function bindParent(file: string): ParentLease {
  return workspaceSessionFileParentLease(file);
}

function verifyParent(file: string, lease: ParentLease): void {
  if (!lease) return;
  try {
    lease.verify();
  } catch (error) {
    throw unsafe(file, 'parent directory changed while it was in use', error);
  }
}

/** Resolve a direct child through the pinned descriptor whenever available. */
function boundPath(file: string, lease: ParentLease): string {
  if (!lease || lease.pathFallback) return file;
  return `${lease.accessPath}/${pathComponent(file)}`;
}

function pathComponent(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  if (!base || base === '.' || base === '..' || base.includes('/') || base.includes('\\')) {
    throw unsafe(file, 'is not a direct child of its leased directory');
  }
  return base;
}

function requireEntryMutation(file: string, lease: ParentLease): void {
  if (lease?.entryMutationPolicy === 'deny') {
    // Checking a pathname before and after a syscall does not catch a parent
    // that is exchanged only for the duration of O_CREAT, unlink, or rename.
    // Without an openat/unlinkat-style namespace, mutating a directory entry
    // cannot be made safe and must fail closed.
    throw unsafe(file, 'entry mutation requires descriptor-relative access');
  }
}

async function lstatOrNull(file: string, lease: ParentLease = bindParent(file)): Promise<fs.Stats | null> {
  verifyParent(file, lease);
  try {
    const stat = await fs.promises.lstat(boundPath(file, lease));
    verifyParent(file, lease);
    return stat;
  } catch (error) {
    verifyParent(file, lease);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function verifyOpened(
  file: string,
  handle: fs.promises.FileHandle,
  before: fs.Stats | null,
  lease: ParentLease,
): Promise<fs.Stats> {
  // On the path fallback this check happens immediately after open and before
  // callers read, write, chmod, or truncate the opened inode.
  verifyParent(file, lease);
  const opened = await handle.stat();
  assertPrivateRegular(opened, file);
  const visible = await lstatOrNull(file, lease).catch((error: NodeJS.ErrnoException) => {
    throw unsafe(file, 'changed while it was being opened', error);
  });
  if (!visible) throw unsafe(file, 'changed while it was being opened');
  if (visible.isSymbolicLink()) throw unsafe(file, 'is a symbolic link');
  assertPrivateRegular(visible, file);
  if (!sameIdentity(visible, opened) || (before && !sameIdentity(before, opened))) {
    throw unsafe(file, 'changed while it was being opened');
  }
  verifyParent(file, lease);
  return opened;
}

async function harden(handle: fs.promises.FileHandle): Promise<void> {
  try {
    await handle.chmod(0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

async function openExisting(
  file: string,
  flags: number,
  lease: ParentLease = bindParent(file),
): Promise<fs.promises.FileHandle> {
  const before = await lstatOrNull(file, lease);
  if (!before) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
  if (before.isSymbolicLink()) throw unsafe(file, 'is a symbolic link');
  assertPrivateRegular(before, file);

  let handle: fs.promises.FileHandle;
  try {
    verifyParent(file, lease);
    handle = await fs.promises.open(boundPath(file, lease), flags);
  } catch (error) {
    verifyParent(file, lease);
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw unsafe(file, 'is a symbolic link', error);
    }
    throw error;
  }
  try {
    await verifyOpened(file, handle, before, lease);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function openSessionFileForRead(file: string): Promise<fs.promises.FileHandle> {
  return openExisting(file, READ_FLAGS);
}

export async function openSessionFileForAppend(file: string): Promise<fs.promises.FileHandle> {
  const lease = bindParent(file);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await openExisting(file, WRITE_FLAGS | fs.constants.O_APPEND, lease);
      try {
        await harden(handle);
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    let handle: fs.promises.FileHandle;
    try {
      requireEntryMutation(file, lease);
      verifyParent(file, lease);
      handle = await fs.promises.open(
        boundPath(file, lease),
        WRITE_FLAGS | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      verifyParent(file, lease);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe(file, 'is a symbolic link', error);
      throw error;
    }
    try {
      await verifyOpened(file, handle, null, lease);
      await harden(handle);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  throw unsafe(file, 'changed repeatedly while it was being created');
}

export async function appendSessionFile(
  file: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const handle = await openSessionFileForAppend(file);
  try {
    if (typeof data === 'string') await handle.writeFile(data, { encoding: encoding ?? 'utf8' });
    else await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function statSessionFile(file: string): Promise<fs.Stats | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await openSessionFileForRead(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

export async function truncateSessionFile(file: string, length: number): Promise<void> {
  const handle = await openExisting(file, WRITE_FLAGS);
  try {
    await harden(handle);
    await handle.truncate(length);
  } finally {
    await handle.close();
  }
}

async function openExclusive(
  file: string,
  lease: ParentLease = bindParent(file),
): Promise<fs.promises.FileHandle> {
  let handle: fs.promises.FileHandle;
  try {
    requireEntryMutation(file, lease);
    verifyParent(file, lease);
    handle = await fs.promises.open(
      boundPath(file, lease),
      WRITE_FLAGS | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
  } catch (error) {
    verifyParent(file, lease);
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe(file, 'is a symbolic link', error);
    throw error;
  }
  try {
    await verifyOpened(file, handle, null, lease);
    await harden(handle);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Prepare a deterministic crash-recovery file without ever opening an existing entry. */
export async function prepareSessionFile(file: string): Promise<fs.promises.FileHandle> {
  const lease = bindParent(file);
  const existing = await lstatOrNull(file, lease);
  if (existing) {
    if (existing.isSymbolicLink()) throw unsafe(file, 'is a symbolic link');
    assertPrivateRegular(existing, file);
    requireEntryMutation(file, lease);
    verifyParent(file, lease);
    await fs.promises.unlink(boundPath(file, lease));
    verifyParent(file, lease);
  }
  return openExclusive(file, lease);
}

export async function writePreparedSessionFile(
  file: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const handle = await prepareSessionFile(file);
  try {
    if (typeof data === 'string') await handle.writeFile(data, { encoding: encoding ?? 'utf8' });
    else await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Publish a checked prepared regular file over an absent or checked regular target. */
export async function publishPreparedSessionFile(prepared: string, target: string): Promise<void> {
  const sourceLease = bindParent(prepared);
  const targetLease = bindParent(target);
  if ((sourceLease === null) !== (targetLease === null)) {
    throw unsafe(target, 'cannot publish across a workspace session boundary');
  }
  if (sourceLease && targetLease && sourceLease.canonicalPath !== targetLease.canonicalPath) {
    throw unsafe(target, 'cannot publish across workspace session directories');
  }
  requireEntryMutation(prepared, sourceLease);
  requireEntryMutation(target, targetLease);
  const source = await openSessionFileForRead(prepared);
  try {
    const targetStat = await lstatOrNull(target, targetLease);
    if (targetStat) {
      if (targetStat.isSymbolicLink()) throw unsafe(target, 'is a symbolic link');
      assertPrivateRegular(targetStat, target);
    }
    verifyParent(prepared, sourceLease);
    verifyParent(target, targetLease);
    try {
      await fs.promises.rename(boundPath(prepared, sourceLease), boundPath(target, targetLease));
    } finally {
      verifyParent(prepared, sourceLease);
      verifyParent(target, targetLease);
    }
    await verifyOpened(target, source, null, targetLease);
  } finally {
    await source.close().catch(() => undefined);
  }
}

/** Atomically replace a final component through a random O_EXCL sibling. */
export async function replaceSessionFile(
  target: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const handle = await openExclusive(temporary);
    try {
      if (typeof data === 'string') await handle.writeFile(data, { encoding: encoding ?? 'utf8' });
      else await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await publishPreparedSessionFile(temporary, target);
  } catch (error) {
    await unlinkSessionEntry(temporary).catch(() => undefined);
    throw error;
  }
}

/** Unlink exactly one entry. Symlinks are removed themselves and never followed. */
export async function unlinkSessionEntry(file: string): Promise<void> {
  const lease = bindParent(file);
  const existing = await lstatOrNull(file, lease);
  if (!existing) return;
  if (!existing.isSymbolicLink() && !existing.isFile()) {
    throw unsafe(file, 'is not a removable file entry');
  }
  requireEntryMutation(file, lease);
  verifyParent(file, lease);
  try {
    await fs.promises.unlink(boundPath(file, lease)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  } finally {
    verifyParent(file, lease);
  }
}
