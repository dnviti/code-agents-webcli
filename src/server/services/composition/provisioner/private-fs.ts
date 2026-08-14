import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSharedQueue, sharedPublicationLocks } from './locks.js';

const OPEN_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const OPEN_PRIVATE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const OPEN_PRIVATE_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT
  | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const DESCRIPTOR_ROOT = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';

export interface PrivateFile {
  bytes: Uint8Array | null;
  mode: number;
}

export class AnchoredPrivateDirectory {
  private closed = false;

  constructor(readonly handle: FileHandle, readonly displayPath: string) {}

  entry(name: string): string {
    validatePrivateName(name);
    return `${DESCRIPTOR_ROOT}/${this.handle.fd}/${name}`;
  }

  displayEntry(name: string): string {
    validatePrivateName(name);
    return path.join(this.displayPath, name);
  }

  /** The user-visible path must still name the exact directory inode we opened. */
  async assertReachable(): Promise<void> {
    const visible = await openDirectoryNoFollow(this.displayPath);
    try {
      const [anchoredStat, visibleStat] = await Promise.all([this.handle.stat(), visible.stat()]);
      if (!sameInode(anchoredStat, visibleStat)) {
        throw new Error('private directory changed during publication');
      }
    } finally {
      await visible.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/**
 * Create/open a 0700 directory chain by walking from opened directory handles.
 * Every child lookup after the root is relative to `/proc/self/fd/<dirfd>` and
 * opened with O_NOFOLLOW, so replacing a checked pathname cannot redirect a
 * privileged server write outside the owner's mounted root.
 */
export async function privateDirectory(
  root: string,
  segments: readonly string[],
): Promise<AnchoredPrivateDirectory> {
  const rootPath = path.resolve(root);
  try {
    await fsp.mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let current = await openDirectoryNoFollow(rootPath);
  let displayPath = rootPath;
  try {
    await current.chmod(0o700);
    for (const segment of segments) {
      validatePrivateName(segment);
      const child = descriptorEntry(current, segment);
      try {
        await fsp.mkdir(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const next = await openDirectoryNoFollow(child);
      try {
        await next.chmod(0o700);
        await current.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      current = next;
      displayPath = path.join(displayPath, segment);
    }
    const directory = new AnchoredPrivateDirectory(current, displayPath);
    await directory.assertReachable();
    return directory;
  } catch (error) {
    try {
      await current.close();
    } catch {
      // Preserve the path-safety error that caused the walk to fail.
    }
    throw error;
  }
}

async function openDirectoryNoFollow(candidate: string): Promise<FileHandle> {
  const handle = await fsp.open(candidate, OPEN_DIRECTORY_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error('private path is not a directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readPrivateFile(
  directory: AnchoredPrivateDirectory,
  name: string,
  maxBytes: number,
): Promise<PrivateFile | null> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(directory.entry(name), OPEN_PRIVATE_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('private entry is not a regular file');
    const mode = stat.mode & 0o777;
    if (stat.size > maxBytes) return { bytes: null, mode };
    return { bytes: new Uint8Array(await handle.readFile()), mode };
  } finally {
    await handle.close();
  }
}

/** Publish a complete inode with one anchored rename; readers see old or new. */
export async function atomicPublish(
  directory: AnchoredPrivateDirectory,
  name: string,
  contents: Uint8Array | string,
  mode: number,
): Promise<void> {
  validatePrivateName(name);
  await withSharedQueue(
    sharedPublicationLocks,
    path.resolve(directory.displayEntry(name)),
    async () => {
      const temporaryName = `.${name}-${randomUUID()}.tmp`;
      const temporary = directory.entry(temporaryName);
      const destination = directory.entry(name);
      let handle: FileHandle | null = null;
      let published = false;
      try {
        handle = await fsp.open(temporary, OPEN_PRIVATE_WRITE_FLAGS, mode);
        if (typeof contents === 'string') await handle.writeFile(contents, 'utf8');
        else await handle.writeFile(contents);
        await handle.chmod(mode);
        await handle.sync();
        const sourceStat = await handle.stat();
        await fsp.rename(temporary, destination);
        published = true;

        const visible = await fsp.open(destination, OPEN_PRIVATE_READ_FLAGS);
        try {
          const visibleStat = await visible.stat();
          if (!visibleStat.isFile() || !sameInode(sourceStat, visibleStat)
            || (visibleStat.mode & 0o777) !== mode) {
            throw new Error('private file publication changed unexpectedly');
          }
        } finally {
          await visible.close();
        }
        await directory.assertReachable();
      } finally {
        if (handle) await handle.close();
        if (!published) {
          try {
            await fsp.unlink(temporary);
          } catch {
            // O_EXCL plus a random name prevents our own writers from colliding;
            // cleanup must never follow or recursively remove an attacker entry.
          }
        }
      }
    },
  );
}

function descriptorEntry(directory: FileHandle, name: string): string {
  validatePrivateName(name);
  return `${DESCRIPTOR_ROOT}/${directory.fd}/${name}`;
}

function validatePrivateName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
    || name.includes('\0')) {
    throw new Error('invalid private directory component');
  }
}

function sameInode(
  left: Pick<Awaited<ReturnType<FileHandle['stat']>>, 'dev' | 'ino'>,
  right: Pick<Awaited<ReturnType<FileHandle['stat']>>, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
