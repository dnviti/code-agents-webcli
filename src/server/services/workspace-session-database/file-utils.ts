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
import path from 'node:path';
import type { WorkspaceStorageDirectoryLease } from '../workspace-session-storage.js';
import { statWorkspaceCwdFile } from '../workspace-cwd-helper.js';
import { NO_FOLLOW, MAX_SERIALIZED_DATABASE_BYTES } from './constants.js';

export function unsafeWorkspaceFile(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE', cause });
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

export function verifyWorkspaceFileBinding(visible: string, fd: number): void {
  const before = fs.lstatSync(visible);
  const openedBefore = fs.fstatSync(fd);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !openedBefore.isFile()
    || before.nlink !== 1
    || openedBefore.nlink !== 1
    || fs.realpathSync(visible) !== visible
    || !sameFileIdentity(before, openedBefore)
  ) {
    throw unsafeWorkspaceFile(`Workspace database component is unsafe: ${visible}`);
  }
  const after = fs.lstatSync(visible);
  const openedAfter = fs.fstatSync(fd);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || !openedAfter.isFile()
    || after.nlink !== 1
    || openedAfter.nlink !== 1
    || !sameFileIdentity(before, after)
  ) {
    throw unsafeWorkspaceFile(`Workspace database component changed while opening: ${visible}`);
  }
}

export function hardenWorkspaceFile(fd: number): void {
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

export function openExistingWorkspaceFile(
  lease: WorkspaceStorageDirectoryLease,
  visible: string,
): number {
  lease.verify();
  const access = path.join(lease.accessPath, path.basename(visible));
  let fd: number;
  try {
    fd = fs.openSync(access, fs.constants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw unsafeWorkspaceFile(`Refusing a symlinked workspace database component: ${visible}`, error);
    }
    throw error;
  }
  try {
    verifyWorkspaceFileBinding(visible, fd);
    lease.verify();
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function openWorkspaceDatabaseFile(
  lease: WorkspaceStorageDirectoryLease,
  visible: string,
): { fd: number; created: boolean } {
  lease.verify();
  const access = path.join(lease.accessPath, path.basename(visible));
  try {
    const fd = fs.openSync(
      access,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      verifyWorkspaceFileBinding(visible, fd);
      lease.verify();
      return { fd, created: true };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { fd: openExistingWorkspaceFile(lease, visible), created: false };
  }
}

export function rejectUnsafeDatabaseCompanions(
  lease: WorkspaceStorageDirectoryLease,
  dbPath: string,
): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let fd: number | null = null;
    try {
      fd = openExistingWorkspaceFile(lease, `${dbPath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}

export function rejectSerializedDatabaseCompanions(
  lease: WorkspaceStorageDirectoryLease,
  dbPath: string,
): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const visible = `${dbPath}${suffix}`;
    if (lease.entryMutationPolicy === 'cwd-helper') {
      try {
        statWorkspaceCwdFile(lease, path.basename(visible));
        throw unsafeWorkspaceFile(
          `Serialized workspace database refuses an existing SQLite companion: ${visible}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    try {
      const fd = openExistingWorkspaceFile(lease, visible);
      fs.closeSync(fd);
      throw unsafeWorkspaceFile(
        `Serialized workspace database refuses an existing SQLite companion: ${visible}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

