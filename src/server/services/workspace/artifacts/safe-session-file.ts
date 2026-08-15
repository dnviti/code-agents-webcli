import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  workspaceSessionFileParentLease,
  type WorkspaceSessionFileParentLease,
  type WorkspaceStorageDirectoryLease,
} from '../session/workspace-session-storage.js';
import {
  readWorkspaceCwdFile,
  runWorkspaceCwdHelperAsync,
  statWorkspaceCwdFile,
  type WorkspaceCwdHelperResult,
} from '../session/io/workspace-cwd-helper.js';

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

async function statWorkspaceCwdFileAsync(
  lease: WorkspaceSessionFileParentLease,
  name: string,
  expectedEntry?: { dev: bigint; ino: bigint },
): Promise<WorkspaceCwdHelperResult> {
  const result = await runWorkspaceCwdHelperAsync(lease, {
    operation: 'stat', name, ...(expectedEntry ? { expectedEntry } : {}),
  });
  if (typeof result.size !== 'string' || typeof result.nlink !== 'string'
    || typeof result.mode !== 'string') throw unsafe(name, 'helper returned an invalid stat response');
  return result;
}

async function appendWorkspaceCwdFileAsync(
  lease: WorkspaceSessionFileParentLease,
  name: string,
  data: Uint8Array,
  expectedEntry?: { dev: bigint; ino: bigint },
): Promise<void> {
  await runWorkspaceCwdHelperAsync(lease, {
    operation: 'append', name, data, mode: 0o600,
    ...(expectedEntry ? { expectedEntry } : {}),
  });
}

/** Rename an exact inode and normalize a success whose transport reply was lost. */
async function renameWorkspaceCwdFileAsync(
  lease: WorkspaceSessionFileParentLease,
  temporary: string,
  target: string,
  expectedEntry: { dev: bigint; ino: bigint },
): Promise<void> {
  try {
    await runWorkspaceCwdHelperAsync(lease, {
      operation: 'rename', name: temporary, target, expectedEntry,
    });
  } catch (error) {
    try {
      await runWorkspaceCwdHelperAsync(lease, {
        operation: 'reconcile-rename', name: temporary, target, expectedEntry,
      });
      return;
    } catch { /* Preserve the original mutation failure. */ }
    throw error;
  }
}

/** Remove an exact inode and accept a lost reply only after proving it absent. */
async function removeWorkspaceCwdEntryAsync(
  lease: WorkspaceSessionFileParentLease,
  name: string,
  expectedEntry: { dev: bigint; ino: bigint },
): Promise<void> {
  try {
    await runWorkspaceCwdHelperAsync(lease, { operation: 'unlink', name, expectedEntry });
  } catch (error) {
    try {
      await runWorkspaceCwdHelperAsync(lease, {
        operation: 'verify-absent', name, expectedEntry,
      });
      return;
    } catch { /* Preserve the original mutation failure. */ }
    throw error;
  }
}

function helperStats(
  result: WorkspaceCwdHelperResult,
  bigint = false,
): fs.Stats | fs.BigIntStats {
  const value = (text: string | undefined): bigint => BigInt(text ?? '0');
  const dev = value(result.dev?.toString());
  const ino = value(result.ino?.toString());
  const size = value(result.size);
  const nlink = value(result.nlink);
  const mode = value(result.mode);
  const mtimeNs = value(result.mtimeNs);
  const ctimeNs = value(result.ctimeNs);
  const birthtimeNs = value(result.birthtimeNs);
  const methods = {
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false,
    isSocket: () => false,
  };
  if (bigint) return {
    ...methods, dev, ino, size, nlink, mode, mtimeNs, ctimeNs, birthtimeNs,
    uid: 0n, gid: 0n, rdev: 0n, blksize: 0n, blocks: 0n,
    atimeMs: 0n, mtimeMs: mtimeNs / 1_000_000n, ctimeMs: ctimeNs / 1_000_000n,
    birthtimeMs: birthtimeNs / 1_000_000n,
    atime: new Date(0), mtime: new Date(Number(mtimeNs / 1_000_000n)),
    ctime: new Date(Number(ctimeNs / 1_000_000n)), birthtime: new Date(Number(birthtimeNs / 1_000_000n)),
  } as fs.BigIntStats;
  return {
    ...methods, dev: Number(dev), ino: Number(ino), size: Number(size), nlink: Number(nlink), mode: Number(mode),
    uid: 0, gid: 0, rdev: 0, blksize: 0, blocks: 0, atimeMs: 0,
    mtimeMs: Number(mtimeNs) / 1e6, ctimeMs: Number(ctimeNs) / 1e6,
    birthtimeMs: Number(birthtimeNs) / 1e6, atime: new Date(0),
    mtime: new Date(Number(mtimeNs) / 1e6), ctime: new Date(Number(ctimeNs) / 1e6),
    birthtime: new Date(Number(birthtimeNs) / 1e6),
  } as fs.Stats;
}

class CwdHelperReadHandle {
  private closed = false;
  private position = 0;
  private readonly expected: { dev: bigint; ino: bigint };
  constructor(
    private readonly lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
    private readonly name: string,
    private readonly initial: WorkspaceCwdHelperResult,
    private readonly offThread: boolean,
  ) {
    if (initial.dev === undefined || initial.ino === undefined) throw unsafe(name, 'helper omitted its identity');
    this.expected = { dev: initial.dev, ino: initial.ino };
  }
  private assertStable(result: WorkspaceCwdHelperResult): void {
    if (result.dev !== this.expected.dev || result.ino !== this.expected.ino
      || result.size !== this.initial.size || result.mtimeNs !== this.initial.mtimeNs
      || result.ctimeNs !== this.initial.ctimeNs) throw unsafe(this.name, 'changed while its helper handle was open');
  }
  async stat(options?: { bigint?: boolean }): Promise<fs.Stats | fs.BigIntStats> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    const result = this.offThread
      ? await statWorkspaceCwdFileAsync(
        this.lease as WorkspaceSessionFileParentLease,
        this.name,
        this.expected,
      )
      : statWorkspaceCwdFile(this.lease, this.name, this.expected);
    this.assertStable(result);
    return helperStats(result, options?.bigint === true);
  }
  async read(
    buffer: Buffer,
    offset = 0,
    length = buffer.length - offset,
    position: number | null = null,
  ): Promise<{ bytesRead: number; buffer: Buffer }> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    const at = position ?? this.position;
    const result = this.offThread
      ? await runWorkspaceCwdHelperAsync(this.lease as WorkspaceSessionFileParentLease, {
        operation: 'read', name: this.name, offset: at, length, expectedEntry: this.expected,
      })
      : readWorkspaceCwdFile(this.lease, this.name, at, length, this.expected);
    if (typeof result.data !== 'string' || typeof result.size !== 'string') {
      throw unsafe(this.name, 'helper returned an invalid read response');
    }
    this.assertStable(result);
    const bytes = Buffer.from(result.data, 'base64');
    if (bytes.length > length || bytes.toString('base64') !== result.data) {
      throw unsafe(this.name, 'helper returned invalid read bytes');
    }
    bytes.copy(buffer, offset);
    if (position === null) this.position += bytes.length;
    return { bytesRead: bytes.length, buffer };
  }
  async readFile(options?: BufferEncoding | { encoding?: BufferEncoding | null }): Promise<Buffer | string> {
    const stat = await this.stat({ bigint: true }) as fs.BigIntStats;
    if (stat.size > 512n * 1024n * 1024n) throw unsafe(this.name, 'exceeds the bounded helper read limit');
    const output = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await this.read(output, offset, Math.min(24 * 1024 * 1024, output.length - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== output.length) throw unsafe(this.name, 'changed while it was read');
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? output.toString(encoding) : output;
  }
  async close(): Promise<void> { this.closed = true; }
}

class CwdHelperWriteHandle {
  private closed = false;
  private position = 0;
  constructor(
    private readonly lease: WorkspaceSessionFileParentLease,
    private readonly name: string,
    private readonly expected: { dev: bigint; ino: bigint },
  ) {}
  async write(
    buffer: Buffer | Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null,
  ): Promise<{ bytesWritten: number; buffer: Buffer | Uint8Array }> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    const bytes = Buffer.from(buffer).subarray(offset, offset + length);
    const at = position ?? this.position;
    await runWorkspaceCwdHelperAsync(this.lease, {
      operation: 'write', name: this.name, offset: at, data: bytes,
      expectedEntry: this.expected, mode: 0o600,
    });
    if (position === null) this.position += bytes.length;
    return { bytesWritten: bytes.length, buffer };
  }
  async writeFile(data: string | Uint8Array, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<void> {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : Buffer.from(data);
    await this.write(bytes, 0, bytes.length, null);
  }
  async stat(options?: { bigint?: boolean }): Promise<fs.Stats | fs.BigIntStats> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    return helperStats(
      await statWorkspaceCwdFileAsync(this.lease, this.name, this.expected),
      options?.bigint === true,
    );
  }
  async truncate(length = 0): Promise<void> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    await runWorkspaceCwdHelperAsync(this.lease, {
      operation: 'truncate', name: this.name, length,
      expectedEntry: this.expected, mode: 0o600,
    });
  }
  async chmod(_mode: number): Promise<void> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    /* Child hardens every write. */
  }
  async sync(): Promise<void> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    /* Child fsyncs every write. */
  }
  async close(): Promise<void> { this.closed = true; }
}

class CwdHelperAppendHandle {
  private closed = false;
  constructor(
    private readonly lease: WorkspaceSessionFileParentLease,
    private readonly name: string,
    private readonly expected: { dev: bigint; ino: bigint },
  ) {}
  async writeFile(data: string | Uint8Array, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<void> {
    if (this.closed) throw Object.assign(new Error('FileHandle is closed'), { code: 'EBADF' });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : Buffer.from(data);
    await appendWorkspaceCwdFileAsync(this.lease, this.name, bytes, this.expected);
  }
  async stat(options?: { bigint?: boolean }): Promise<fs.Stats | fs.BigIntStats> {
    return helperStats(
      await statWorkspaceCwdFileAsync(this.lease, this.name, this.expected),
      options?.bigint === true,
    );
  }
  async chmod(_mode: number): Promise<void> { /* Child hardens every append. */ }
  async close(): Promise<void> { this.closed = true; }
}

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

async function exactEntryIdentity(
  file: string,
  lease: ParentLease,
  allowSymlink = false,
): Promise<{ dev: bigint; ino: bigint }> {
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    if (allowSymlink) {
      const result = await runWorkspaceCwdHelperAsync(lease, { operation: 'list', name: '.list' });
      let entries: unknown;
      try { entries = JSON.parse(result.entries ?? ''); } catch (error) {
        throw unsafe(file, 'helper returned invalid directory entries', error);
      }
      if (!Array.isArray(entries) || entries.length > 10_000) {
        throw unsafe(file, 'helper returned invalid directory entries');
      }
      const entry = entries.find((candidate: unknown) => (
        typeof candidate === 'object' && candidate !== null
        && (candidate as Record<string, unknown>).name === pathComponent(file)
      )) as Record<string, unknown> | undefined;
      if (!entry || (entry.type !== 'file' && entry.type !== 'symlink')
        || typeof entry.dev !== 'string' || !/^\d+$/.test(entry.dev)
        || typeof entry.ino !== 'string' || !/^\d+$/.test(entry.ino)
        || typeof entry.nlink !== 'string' || !/^\d+$/.test(entry.nlink)
        || (entry.type === 'file' && BigInt(entry.nlink) !== 1n)) throw unsafe(file);
      return { dev: BigInt(entry.dev), ino: BigInt(entry.ino) };
    }
    const stat = await statWorkspaceCwdFileAsync(lease, pathComponent(file));
    if (stat.dev === undefined || stat.ino === undefined
      || typeof stat.nlink !== 'string' || BigInt(stat.nlink) !== 1n) throw unsafe(file);
    return { dev: stat.dev, ino: stat.ino };
  }
  verifyParent(file, lease);
  const stat = await fs.promises.lstat(boundPath(file, lease), { bigint: true });
  if ((!stat.isFile() && !(allowSymlink && stat.isSymbolicLink()))
    || (stat.isFile() && stat.nlink !== 1n)) throw unsafe(file);
  verifyParent(file, lease);
  return { dev: stat.dev, ino: stat.ino };
}

async function lstatOrNull(file: string, lease: ParentLease = bindParent(file)): Promise<fs.Stats | null> {
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    try {
      return helperStats(await statWorkspaceCwdFileAsync(lease, pathComponent(file))) as fs.Stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
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
  expected?: { dev?: bigint; ino?: bigint },
): Promise<fs.Stats> {
  // On the path fallback this check happens immediately after open and before
  // callers read, write, chmod, or truncate the opened inode.
  verifyParent(file, lease);
  const opened = await handle.stat();
  assertPrivateRegular(opened, file);
  if (expected?.dev !== undefined && expected.ino !== undefined) {
    const exact = await handle.stat({ bigint: true });
    if (exact.dev !== expected.dev || exact.ino !== expected.ino) {
      throw unsafe(file, 'does not match the entry created by the workspace helper');
    }
  }
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
  expected?: { dev?: bigint; ino?: bigint },
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
    await verifyOpened(file, handle, before, lease, expected);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function openSessionFileForRead(file: string): Promise<fs.promises.FileHandle> {
  const lease = bindParent(file);
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    // Stat through the pinned child before returning the range-read facade so
    // ENOENT and unsafe final components retain the ordinary open contract.
    const initial = await statWorkspaceCwdFileAsync(lease, pathComponent(file));
    return new CwdHelperReadHandle(
      lease, pathComponent(file), initial, true,
    ) as unknown as fs.promises.FileHandle;
  }
  return openExisting(file, READ_FLAGS);
}

export function openWorkspaceCwdFileForRead(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
): fs.promises.FileHandle {
  const initial = statWorkspaceCwdFile(lease, name);
  return new CwdHelperReadHandle(lease, name, initial, false) as unknown as fs.promises.FileHandle;
}

export async function openSessionFileForAppend(file: string): Promise<fs.promises.FileHandle> {
  const lease = bindParent(file);
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    let identity: { dev: bigint; ino: bigint };
    try {
      const stat = await statWorkspaceCwdFileAsync(lease, pathComponent(file));
      if (stat.dev === undefined || stat.ino === undefined) throw unsafe(file, 'helper omitted identity');
      identity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const created = await runWorkspaceCwdHelperAsync(lease, {
          operation: 'create', name: pathComponent(file), data: Buffer.alloc(0), mode: 0o600,
        });
        if (created.dev === undefined || created.ino === undefined) throw unsafe(file, 'helper omitted identity');
        identity = { dev: created.dev, ino: created.ino };
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        const raced = await statWorkspaceCwdFileAsync(lease, pathComponent(file));
        if (raced.dev === undefined || raced.ino === undefined) throw unsafe(file, 'helper omitted identity');
        identity = { dev: raced.dev, ino: raced.ino };
      }
    }
    return new CwdHelperAppendHandle(lease, pathComponent(file), identity) as unknown as fs.promises.FileHandle;
  }
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
  const lease = bindParent(file);
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : Buffer.from(data);
    const name = pathComponent(file);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await statWorkspaceCwdFileAsync(lease, name);
        if (current.dev === undefined || current.ino === undefined) throw unsafe(file, 'helper omitted identity');
        await appendWorkspaceCwdFileAsync(lease, name, bytes, { dev: current.dev, ino: current.ino });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        const created = await runWorkspaceCwdHelperAsync(lease, {
          operation: 'create', name, data: Buffer.alloc(0), mode: 0o600,
        });
        if (created.dev === undefined || created.ino === undefined) throw unsafe(file, 'helper omitted created identity');
        await appendWorkspaceCwdFileAsync(lease, name, bytes, { dev: created.dev, ino: created.ino });
        return;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      }
    }
    throw unsafe(file, 'changed repeatedly while it was being appended');
  }
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
  const lease = bindParent(file);
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    const name = pathComponent(file);
    const current = await statWorkspaceCwdFileAsync(lease, name);
    if (current.dev === undefined || current.ino === undefined) throw unsafe(file, 'helper omitted identity');
    await runWorkspaceCwdHelperAsync(lease, {
      operation: 'truncate', name, length,
      expectedEntry: { dev: current.dev, ino: current.ino }, mode: 0o600,
    });
    return;
  }
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
    if (lease?.entryMutationPolicy === 'cwd-helper') {
      const expected = await runWorkspaceCwdHelperAsync(lease, {
        operation: 'create', name: pathComponent(file), data: Buffer.alloc(0), mode: 0o600,
      });
      if (expected.dev === undefined || expected.ino === undefined) throw unsafe(file, 'helper omitted identity');
      return new CwdHelperWriteHandle(
        lease, pathComponent(file), { dev: expected.dev, ino: expected.ino },
      ) as unknown as fs.promises.FileHandle;
    }
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
    if (lease?.entryMutationPolicy === 'cwd-helper') {
      const expectedEntry = await exactEntryIdentity(file, lease);
      await removeWorkspaceCwdEntryAsync(lease, pathComponent(file), expectedEntry);
    } else {
      await fs.promises.unlink(boundPath(file, lease));
    }
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
    const sourceIdentity = await source.stat({ bigint: true });
    const targetStat = await lstatOrNull(target, targetLease);
    if (targetStat) {
      if (targetStat.isSymbolicLink()) throw unsafe(target, 'is a symbolic link');
      assertPrivateRegular(targetStat, target);
    }
    verifyParent(prepared, sourceLease);
    verifyParent(target, targetLease);
    try {
      if (sourceLease?.entryMutationPolicy === 'cwd-helper') {
        await renameWorkspaceCwdFileAsync(
          sourceLease,
          pathComponent(prepared),
          pathComponent(target),
          { dev: sourceIdentity.dev, ino: sourceIdentity.ino },
        );
      } else {
        await fs.promises.rename(boundPath(prepared, sourceLease), boundPath(target, targetLease));
      }
    } finally {
      verifyParent(prepared, sourceLease);
      verifyParent(target, targetLease);
    }
    if (targetLease?.entryMutationPolicy === 'cwd-helper') {
      await statWorkspaceCwdFileAsync(targetLease, pathComponent(target), {
        dev: sourceIdentity.dev, ino: sourceIdentity.ino,
      });
    } else {
      await verifyOpened(target, source, null, targetLease);
    }
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
  const lease = bindParent(target);
  if (lease?.entryMutationPolicy === 'cwd-helper') {
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : Buffer.from(data);
    await runWorkspaceCwdHelperAsync(lease, {
      operation: 'replace', name: pathComponent(target), data: bytes, mode: 0o600,
    });
    return;
  }
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
    if (lease?.entryMutationPolicy === 'cwd-helper') {
      const expectedEntry = await exactEntryIdentity(file, lease, true);
      await removeWorkspaceCwdEntryAsync(lease, pathComponent(file), expectedEntry);
    } else {
      await fs.promises.unlink(boundPath(file, lease)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } finally {
    verifyParent(file, lease);
  }
}
