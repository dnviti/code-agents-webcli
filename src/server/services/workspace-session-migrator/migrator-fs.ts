import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  workspaceDescriptorRoot,
  workspaceSessionFileParentLease,
  type WorkspaceStorageDirectoryLease,
} from '../workspace-session-storage.js';
import { openWorkspaceCwdFileForRead } from '../safe-session-file.js';
import {
  fingerprintWorkspaceCwdFile,
  publishNewLargeWorkspaceCwdFile,
  publishNewWorkspaceCwdFile,
  readWorkspaceCwdFile,
  recoverWorkspaceCwdPublication,
  statWorkspaceCwdFile,
} from '../workspace-cwd-helper.js';
import {
  COPY_CHUNK_BYTES,
  DIRECTORY,
  NO_FOLLOW,
  READ_FLAGS,
  WRITE_FLAGS,
  lstatOrNull,
  sameFileIdentity,
  sameFingerprint,
  stableFile,
} from './migrator-core.js';
import type {
  ArtifactDirectoryLease,
  BigFileStat,
  DirectorySyncReason,
  Fingerprint,
  LegacyArtifactBlockReason,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';

export async function leaseAwareFileStatOrNull(
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

export async function syncDirectory(
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

export async function removeTemporaryAndSync(
  temporary: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const existed = await lstatOrNull(temporary).catch(() => null);
  await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  if (existed) {
    await syncDirectory(path.dirname(temporary), hooks, 'temporary_cleanup');
  }
}

export async function fingerprintHandle(
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

export async function fingerprintFile(
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

export function controlledPublishTemporaryStem(target: string): string {
  const basename = path.basename(target);
  if (Buffer.byteLength(basename, 'utf8') <= 120) return `.${basename}.ccweb-migrate`;
  return `.ccweb-migrate-${createHash('sha256').update(basename).digest('hex').slice(0, 24)}`;
}

export function controlledPublishTemporaryPattern(target: string): RegExp {
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
export async function fingerprintPublishedFile(
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

export async function writeAll(
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
export async function copyAndPublish(
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

export function fingerprintBuffer(buffer: Buffer): Fingerprint {
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** Publish generated metadata with the same no-clobber and fsync rules as copied files. */
export async function publishBuffer(
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

export async function readBoundedStableFile(
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

export async function copyVerifiedFile(
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
