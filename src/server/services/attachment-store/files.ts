import { constants as fsConstants, type BigIntStats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  workspaceSessionAccessDirectory,
  workspaceSessionFileParentLease,
} from '../workspace-session-storage.js';
import {
  createTemporaryWorkspaceCwdFile,
  listWorkspaceCwdEntries,
  readCompleteWorkspaceCwdFile,
  readWorkspaceCwdFile,
  removeWorkspaceCwdEntry,
  statWorkspaceCwdFile,
} from '../workspace-cwd-helper.js';

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  STORED_NAME,
  attachmentUrlFor,
  serveKind,
} from './names.js';
import {
  attachmentDirectoryAccessPath,
  descriptorAccessPath,
  requireAttachmentEntryMutation,
  syncDirectoryLease,
  verifyPathBinding,
  verifyVisibleDirectory,
} from './directory.js';
import type {
  AttachmentFileDirectory,
  AttachmentSessionRef,
  AttachmentStoreOptions,
  CwdAttachmentStat,
  OpenAttachmentDirectory,
  ReadableAttachmentDirectory,
  ServeKind,
} from './types.js';
import { errno, optionalFlag } from './util.js';

/** Identity and mutation signal for one still-open attachment inode. */
export function attachmentFileVersion(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

export function cwdAttachmentVersion(stat: CwdAttachmentStat): string {
  return [
    stat.identity.dev,
    stat.identity.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

export async function inspectStoredAttachment(
  directory: ReadableAttachmentDirectory,
  storedName: string,
  operation: 'resolve' | 'download',
  testHooks: AttachmentStoreOptions['testHooks'],
): Promise<{
  directory: ReadableAttachmentDirectory;
  handle: FileHandle | null;
  data: Buffer | null;
  cwdStat: CwdAttachmentStat | null;
  serve: ServeKind;
  bytes: number;
}> {
  let handle: FileHandle | null = null;
  try {
    await testHooks?.afterDirectoryOpened?.(operation);
    if (directory.mutationPolicy === 'cwd-helper') {
      const initial = cwdAttachmentStat(directory, storedName);
      const read = readCompleteCwdAttachment(directory, storedName, initial);
      return {
        directory,
        handle: null,
        data: read.data,
        cwdStat: read.stat,
        bytes: read.stat.size,
        serve: serveKind(read.data.subarray(0, 64), storedName),
      };
    }
    handle = await openAttachmentFile(directory, storedName);
    const stat = await handle.stat();
    if (!stat.isFile()) throw errno('NOT_FOUND', 'no such attachment');
    const buffer = Buffer.alloc(Math.min(64, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (operation === 'resolve') await verifyVisibleDirectory(directory);
    return {
      directory,
      handle,
      data: null,
      cwdStat: null,
      bytes: stat.size,
      serve: serveKind(buffer.subarray(0, bytesRead), storedName),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

/**
 * A legacy flat file has no owner metadata.  Its durable chat URL does: only
 * the owner/session archive containing that exact URL may opt into fallback.
 */
export async function legacyAttachmentIsReferenced(
  session: AttachmentSessionRef,
  storedName: string,
): Promise<boolean> {
  if (!session.storageScope) return false;
  const accessDir = workspaceSessionAccessDirectory(session);
  if (!accessDir) return false;
  const needle = Buffer.from(attachmentUrlFor(session.id, storedName));
  const candidates = [
    'chat.jsonl',
    'chat.snapshot',
    'chat.snapshot.json',
    'transcript.md',
    'chat.ctx',
    'chat.plan',
  ];
  for (const name of candidates) {
    const helperLease = workspaceSessionFileParentLease(path.join(accessDir, name));
    if (helperLease?.entryMutationPolicy === 'cwd-helper') {
      try {
        if (await cwdFileContains(helperLease, name, needle)) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    const handle = await fsp.open(
      path.join(accessDir, name),
      fsConstants.O_RDONLY | optionalFlag(fsConstants.O_NOFOLLOW),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
      throw error;
    });
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (await handleContains(handle, needle)) return true;
    } finally {
      await handle.close();
    }
  }
  return false;
}

function cwdAttachmentLease(dir: AttachmentFileDirectory) {
  return syncDirectoryLease(dir.visibleDir, dir.attachments);
}

export function cwdAttachmentStat(
  dir: AttachmentFileDirectory,
  storedName: string,
  expected?: { dev: bigint; ino: bigint },
): CwdAttachmentStat {
  const result = statWorkspaceCwdFile(cwdAttachmentLease(dir), storedName, expected);
  if (result.dev === undefined || result.ino === undefined
    || result.mtimeNs === undefined || result.ctimeNs === undefined || result.birthtimeNs === undefined) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper omitted file identity');
  }
  const size = Number(result.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper returned an invalid file size');
  }
  return {
    identity: { dev: result.dev, ino: result.ino }, size,
    nlink: BigInt(result.nlink), mode: BigInt(result.mode),
    mtimeNs: BigInt(result.mtimeNs), ctimeNs: BigInt(result.ctimeNs), birthtimeNs: BigInt(result.birthtimeNs),
  };
}

function sameCwdAttachmentVersion(left: CwdAttachmentStat, right: CwdAttachmentStat): boolean {
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function readCompleteCwdAttachment(
  dir: AttachmentFileDirectory,
  storedName: string,
  initial?: CwdAttachmentStat,
): { data: Buffer; stat: CwdAttachmentStat } {
  const before = initial ?? cwdAttachmentStat(dir, storedName);
  if (before.size > DEFAULT_MAX_ATTACHMENT_BYTES) {
    throw errno('FILE_TOO_LARGE', 'attachment exceeds the supported size');
  }
  const read = readCompleteWorkspaceCwdFile(cwdAttachmentLease(dir), storedName, DEFAULT_MAX_ATTACHMENT_BYTES);
  if (read.identity.dev !== before.identity.dev || read.identity.ino !== before.identity.ino) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment changed while helper read it');
  }
  const after = cwdAttachmentStat(dir, storedName, before.identity);
  if (!sameCwdAttachmentVersion(before, after) || read.data.length !== before.size) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment changed while helper read it');
  }
  return { data: read.data, stat: after };
}

async function cwdFileContains(
  lease: ReturnType<typeof workspaceSessionFileParentLease> & {},
  name: string,
  needle: Buffer,
): Promise<boolean> {
  if (!lease) return false;
  const initial = statWorkspaceCwdFile(lease, name);
  if (initial.dev === undefined || initial.ino === undefined) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'workspace helper omitted legacy file identity');
  }
  const size = Number(initial.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'workspace helper returned an invalid legacy file size');
  }
  let carry = Buffer.alloc(0);
  for (let offset = 0; offset < size;) {
    const response = readWorkspaceCwdFile(
      lease, name, offset, Math.min(64 * 1024, size - offset), { dev: initial.dev, ino: initial.ino },
    );
    if (response.size !== initial.size || response.mtimeNs !== initial.mtimeNs || response.ctimeNs !== initial.ctimeNs) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'legacy attachment reference changed while reading');
    }
    const chunk = Buffer.from(response.data, 'base64');
    if (chunk.length === 0 || chunk.length > size - offset) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'workspace helper returned an invalid legacy read');
    }
    const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    if (combined.includes(needle)) return true;
    carry = combined.subarray(Math.max(0, combined.length - needle.length + 1));
    offset += chunk.length;
  }
  return false;
}

async function handleContains(handle: FileHandle, needle: Buffer): Promise<boolean> {
  const chunk = Buffer.alloc(64 * 1024 + Math.max(0, needle.length - 1));
  let carry = 0;
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, carry, 64 * 1024, offset);
    if (bytesRead === 0) return false;
    const length = carry + bytesRead;
    if (chunk.subarray(0, length).includes(needle)) return true;
    carry = Math.min(needle.length - 1, length);
    if (carry > 0) chunk.copy(chunk, 0, length - carry, length);
    offset += bytesRead;
  }
}

export async function usage(dir: OpenAttachmentDirectory): Promise<{ files: number; bytes: number }> {
  if (dir.mutationPolicy === 'cwd-helper') {
    let files = 0;
    let bytes = 0;
    for (const entry of listWorkspaceCwdEntries(cwdAttachmentLease(dir))) {
      if (entry.type !== 'file') continue;
      if (entry.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper returned an oversized file');
      }
      files += 1;
      bytes += Number(entry.size);
      if (!Number.isSafeInteger(bytes)) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment usage exceeds a safe integer');
      }
    }
    return { files, bytes };
  }
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  const root = attachmentDirectoryAccessPath(dir);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const handle = await fsp.open(
      path.join(root, entry.name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    ).catch(() => null);
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
    } finally {
      await handle.close();
    }
  }
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  return { files, bytes };
}

export async function createAttachmentFile(
  dir: OpenAttachmentDirectory,
  storedName: string,
  bytes: Buffer,
): Promise<FileHandle | null> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  if (dir.mutationPolicy === 'cwd-helper') {
    const expected = createTemporaryWorkspaceCwdFile(
      syncDirectoryLease(dir.visibleDir, dir.attachments), storedName, bytes,
    );
    verifyCwdAttachmentFile(dir, storedName, expected);
    return null;
  }
  const handle = await fsp.open(
    path.join(attachmentDirectoryAccessPath(dir), storedName),
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | optionalFlag(fsConstants.O_NOFOLLOW),
    0o600,
  );
  try {
    await verifyVisibleFile(dir, storedName, handle);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeCreatedAttachment(dir, storedName).catch(() => undefined);
    throw error;
  }
}

export async function openAttachmentFile(
  dir: AttachmentFileDirectory,
  storedName: string,
  expected?: { dev?: bigint; ino?: bigint },
): Promise<FileHandle> {
  if (dir.mutationPolicy === 'cwd-helper') {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'cwd-helper attachment reads must stay in the helper');
  }
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  const handle = await fsp.open(
    path.join(attachmentDirectoryAccessPath(dir), storedName),
    fsConstants.O_RDONLY | optionalFlag(fsConstants.O_NOFOLLOW),
  );
  try {
    if (expected?.dev !== undefined && expected.ino !== undefined) {
      const identity = await handle.stat({ bigint: true });
      if (identity.dev !== expected.dev || identity.ino !== expected.ino) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment file does not match helper-created inode');
      }
    }
    if (dir.backend === 'path') await verifyVisibleFile(dir, storedName, handle);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function verifyCwdAttachmentFile(
  dir: AttachmentFileDirectory,
  storedName: string,
  expected?: { dev?: bigint; ino?: bigint },
): CwdAttachmentStat {
  const identity = expected?.dev !== undefined && expected.ino !== undefined
    ? { dev: expected.dev, ino: expected.ino }
    : undefined;
  const stat = cwdAttachmentStat(dir, storedName, identity);
  if (stat.nlink !== 1n) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper file has an unsafe link count');
  }
  return stat;
}

export async function verifyVisibleFile(
  dir: AttachmentFileDirectory,
  storedName: string,
  handle: FileHandle,
): Promise<void> {
  await verifyVisibleDirectory(dir);
  await verifyPathBinding(path.join(dir.visibleDir, storedName), handle, 'file');
  await verifyVisibleDirectory(dir);
}

export async function removeCreatedAttachment(
  dir: OpenAttachmentDirectory,
  storedName: string,
): Promise<void> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  if (dir.mutationPolicy === 'cwd-helper') {
    const entry = verifyCwdAttachmentFile(dir, storedName);
    removeWorkspaceCwdEntry(
      syncDirectoryLease(dir.visibleDir, dir.attachments),
      storedName,
      entry.identity,
    );
  } else {
    await fsp.rm(path.join(attachmentDirectoryAccessPath(dir), storedName), { force: true });
  }
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
}

export async function deleteAttachmentNamespace(dir: OpenAttachmentDirectory): Promise<void> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  await verifyVisibleDirectory(dir);
  const accessRoot = attachmentDirectoryAccessPath(dir);
  if (dir.mutationPolicy === 'cwd-helper') {
    const entries = listWorkspaceCwdEntries(cwdAttachmentLease(dir));
    if (entries.some((entry) => entry.type !== 'file' || !STORED_NAME.test(entry.name))) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment namespace contains an unsafe entry');
    }
    for (const entry of entries) {
      const expected = { dev: entry.dev, ino: entry.ino };
      const current = verifyCwdAttachmentFile(dir, entry.name, expected);
      removeWorkspaceCwdEntry(
        cwdAttachmentLease(dir), entry.name, current.identity,
      );
    }
  } else {
    const entries = await fsp.readdir(accessRoot, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !STORED_NAME.test(entry.name))) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment namespace contains an unsafe entry');
    }
    for (const entry of entries) {
      // This namespace is application-owned, but fail closed on an unexpected
      // directory, symlink or filename rather than turning session deletion into
      // an arbitrary recursive remover.
    const handle = await openAttachmentFile(dir, entry.name);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment changed during session deletion');
      }
      if (dir.backend === 'descriptor') {
        // The parent inode remains authoritative even if the visible workspace
        // is exchanged while teardown is running.
        await fsp.rm(path.join(accessRoot, entry.name), { force: false });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (dir.backend === 'path') {
      await verifyVisibleDirectory(dir);
      await fsp.rm(path.join(dir.visibleDir, entry.name), { force: false });
      await verifyVisibleDirectory(dir);
    }
  }
  }

  await verifyVisibleDirectory(dir);
  const visibleOwner = path.dirname(dir.visibleDir);
  await verifyPathBinding(visibleOwner, dir.owner, 'directory');
  const helperDirectoryIdentity = await dir.attachments.stat({ bigint: true });
  // Windows will not remove the process cwd used by the helper. Close this
  // separate validation handle before asking that child to perform rmdir.
  await dir.attachments.close().catch(() => undefined);
  const target = dir.backend === 'descriptor'
    ? path.join(descriptorAccessPath(dir.owner, dir.descriptorRoot), path.basename(dir.visibleDir))
    : dir.visibleDir;
  if (dir.mutationPolicy === 'cwd-helper') {
    removeWorkspaceCwdEntry(
      syncDirectoryLease(visibleOwner, dir.owner),
      path.basename(dir.visibleDir),
      { dev: helperDirectoryIdentity.dev, ino: helperDirectoryIdentity.ino },
      true,
    );
  } else {
    await fsp.rmdir(target);
  }
  await verifyPathBinding(visibleOwner, dir.owner, 'directory');
}

export async function closeAttachmentDirectory(dir: OpenAttachmentDirectory): Promise<void> {
  await dir.attachments.close().catch(() => undefined);
  await dir.owner.close().catch(() => undefined);
  await dir.attachmentRoot.close().catch(() => undefined);
  await dir.container.close().catch(() => undefined);
  await dir.working.close().catch(() => undefined);
}

export async function closeReadableAttachmentDirectory(dir: ReadableAttachmentDirectory): Promise<void> {
  if ('owner' in dir) {
    await closeAttachmentDirectory(dir);
    return;
  }
  await dir.attachments.close().catch(() => undefined);
  await dir.container.close().catch(() => undefined);
  await dir.working.close().catch(() => undefined);
}
