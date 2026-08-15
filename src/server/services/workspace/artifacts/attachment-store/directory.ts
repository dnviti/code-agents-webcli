import fsSync, { constants as fsConstants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  openCanonicalDirectoryLeaseSync,
  resolveWorkspaceEntryMutationPolicy,
  workspacePathMutationsAreHandlePinned,
  type WorkspaceEntryMutationPolicy,
} from '../../session/workspace-session-storage.js';
import {
  ensureWorkspaceCwdDirectory,
  inspectWorkspaceCwdDirectory,
} from '../../session/io/workspace-cwd-helper.js';

import { ATTACHMENT_DIR, ATTACHMENT_SUBDIR } from './names.js';
import type {
  AttachmentFileDirectory,
  AttachmentStorageIdentity,
  OpenAttachmentDirectory,
  OpenLegacyAttachmentDirectory,
  ResolvedAttachmentDirectoryBackend,
} from './types.js';
import { errno, optionalFlag, sameCanonicalPath, sameFileIdentity } from './util.js';

/**
 * Open the whole directory chain one inode at a time.
 *
 * Node has no public openat(2), so a capability-probed
 * `/proc/self/fd/<n>/child` or `/dev/fd/<n>/child` is the Unix equivalent.
 * Path traversal remains useful for inode-verified reads; on Windows and
 * pathname-only POSIX hosts, entry mutations are delegated to the cwd helper.
 * An explicitly requested path fallback remains read-only.
 */
export async function openAttachmentDirectory(
  identity: AttachmentStorageIdentity,
  create: boolean,
  backend: ResolvedAttachmentDirectoryBackend,
  descriptorRoot: string | null,
  allowCwdHelper: boolean,
): Promise<OpenAttachmentDirectory> {
  const resolvedWorkingDir = path.resolve(identity.workspaceRoot);
  if (resolvedWorkingDir === path.parse(resolvedWorkingDir).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'refusing an attachment directory at filesystem root');
  }

  const useCwdProof = allowCwdHelper && backend === 'path';
  const rootProof = useCwdProof
    ? openCanonicalDirectoryLeaseSync(resolvedWorkingDir, { forceCwdHelper: true })
    : null;
  const realWorkingDir = rootProof
    ? rootProof.canonicalPath
    : await fsp.realpath(resolvedWorkingDir).catch(() => '');
  if (!realWorkingDir) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment working directory does not exist');
  }
  let working: FileHandle | null = null;
  let container: FileHandle | null = null;
  let attachmentRoot: FileHandle | null = null;
  let owner: FileHandle | null = null;
  let attachments: FileHandle | null = null;
  try {
    working = rootProof ? directoryProofFileHandle(rootProof) : await openDirectory(realWorkingDir, realWorkingDir);
    const mutationPolicy = !allowCwdHelper && backend === 'path'
      ? 'deny'
      : resolveWorkspaceEntryMutationPolicy(
      descriptorRoot,
      process.platform,
      backend === 'path'
        && workspacePathMutationsAreHandlePinned(realWorkingDir, working.fd),
      );
    container = await openChildDirectory(
      working,
      realWorkingDir,
      ATTACHMENT_DIR,
      create,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    const containerPath = path.join(realWorkingDir, ATTACHMENT_DIR);
    attachmentRoot = await openChildDirectory(
      container,
      containerPath,
      ATTACHMENT_SUBDIR,
      create,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    const attachmentRootPath = path.join(containerPath, ATTACHMENT_SUBDIR);
    owner = await openChildDirectory(
      attachmentRoot,
      attachmentRootPath,
      identity.ownerKey,
      create,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    const ownerPath = path.join(attachmentRootPath, identity.ownerKey);
    attachments = await openChildDirectory(
      owner,
      ownerPath,
      identity.sessionId,
      create,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    return {
      backend,
      descriptorRoot,
      mutationPolicy,
      working,
      container,
      attachmentRoot,
      owner,
      attachments,
      visibleDir: path.join(
        realWorkingDir,
        ATTACHMENT_DIR,
        ATTACHMENT_SUBDIR,
        identity.ownerKey,
        identity.sessionId,
      ),
    };
  } catch (error) {
    if (attachments) await attachments.close().catch(() => undefined);
    if (owner) await owner.close().catch(() => undefined);
    if (attachmentRoot) await attachmentRoot.close().catch(() => undefined);
    if (container) await container.close().catch(() => undefined);
    if (working) await working.close().catch(() => undefined);
    throw error;
  }
}

/** Open the flat layout used before owner/session attachment namespaces. */
export async function openLegacyAttachmentDirectory(
  identity: AttachmentStorageIdentity,
  backend: ResolvedAttachmentDirectoryBackend,
  descriptorRoot: string | null,
): Promise<OpenLegacyAttachmentDirectory> {
  const resolvedWorkingDir = path.resolve(identity.workspaceRoot);
  if (resolvedWorkingDir === path.parse(resolvedWorkingDir).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'refusing an attachment directory at filesystem root');
  }
  const useCwdProof = backend === 'path';
  const rootProof = useCwdProof
    ? openCanonicalDirectoryLeaseSync(resolvedWorkingDir, { forceCwdHelper: true })
    : null;
  const realWorkingDir = rootProof
    ? rootProof.canonicalPath
    : await fsp.realpath(resolvedWorkingDir).catch(() => '');
  if (!realWorkingDir) throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment workspace does not exist');

  let working: FileHandle | null = null;
  let container: FileHandle | null = null;
  let attachments: FileHandle | null = null;
  try {
    working = rootProof ? directoryProofFileHandle(rootProof) : await openDirectory(realWorkingDir, realWorkingDir);
    const mutationPolicy = resolveWorkspaceEntryMutationPolicy(
      descriptorRoot,
      process.platform,
      backend === 'path'
        && workspacePathMutationsAreHandlePinned(realWorkingDir, working.fd),
    );
    container = await openChildDirectory(
      working,
      realWorkingDir,
      ATTACHMENT_DIR,
      false,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    const containerPath = path.join(realWorkingDir, ATTACHMENT_DIR);
    attachments = await openChildDirectory(
      container,
      containerPath,
      ATTACHMENT_SUBDIR,
      false,
      backend,
      descriptorRoot,
      mutationPolicy,
    );
    return {
      backend,
      descriptorRoot,
      mutationPolicy,
      working,
      container,
      attachments,
      visibleDir: path.join(containerPath, ATTACHMENT_SUBDIR),
    };
  } catch (error) {
    if (attachments) await attachments.close().catch(() => undefined);
    if (container) await container.close().catch(() => undefined);
    if (working) await working.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectory(target: string, expectedRealPath: string): Promise<FileHandle> {
  let handle: FileHandle;
  let beforeIdentity: { dev: bigint; ino: bigint };
  try {
    const before = await fsp.lstat(target, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment path component is not a real directory');
    }
    beforeIdentity = { dev: before.dev, ino: before.ino };
    handle = await fsp.open(
      target,
      fsConstants.O_RDONLY | optionalFlag(fsConstants.O_DIRECTORY) | optionalFlag(fsConstants.O_NOFOLLOW),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw Object.assign(
        errno('UNSAFE_ATTACHMENT_DIR', 'refusing a symlinked attachment directory'),
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== beforeIdentity!.dev || opened.ino !== beforeIdentity!.ino) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory changed while opening');
    }
    await verifyPathBinding(expectedRealPath, handle, 'directory');
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function directoryProofFileHandle(
  proof: ReturnType<typeof openCanonicalDirectoryLeaseSync>,
): FileHandle {
  return {
    fd: proof.fd,
    stat: async (options?: { bigint?: boolean }) => fsSync.fstatSync(
      proof.fd,
      options?.bigint ? { bigint: true } : undefined,
    ),
    close: async () => { proof.close(); },
  } as unknown as FileHandle;
}

async function openChildDirectory(
  parent: FileHandle,
  visibleParent: string,
  name: string,
  create: boolean,
  backend: ResolvedAttachmentDirectoryBackend,
  descriptorRoot: string | null,
  mutationPolicy: WorkspaceEntryMutationPolicy,
): Promise<FileHandle> {
  await verifyPathBinding(visibleParent, parent, 'directory');
  const visibleTarget = path.join(visibleParent, name);
  const target = backend === 'descriptor'
    ? path.join(descriptorAccessPath(parent, descriptorRoot), name)
    : visibleTarget;
  if (mutationPolicy === 'cwd-helper') {
    const lease = syncDirectoryLease(visibleParent, parent);
    const identity = create
      ? ensureWorkspaceCwdDirectory(lease, name, true)
      : inspectWorkspaceCwdDirectory(lease, name);
    return openVerifiedChild(target, visibleTarget, parent, visibleParent, identity);
  }
  try {
    return await openVerifiedChild(target, visibleTarget, parent, visibleParent);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  requireAttachmentEntryMutation(mutationPolicy, visibleTarget);
  await fsp.mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return openVerifiedChild(target, visibleTarget, parent, visibleParent);
}

async function openVerifiedChild(
  target: string,
  visibleTarget: string,
  parent: FileHandle,
  visibleParent: string,
  expected?: { dev?: bigint; ino?: bigint },
): Promise<FileHandle> {
  const opened = await openDirectory(target, visibleTarget);
  try {
    if (expected?.dev !== undefined && expected.ino !== undefined) {
      const identity = await opened.stat({ bigint: true });
      if (identity.dev !== expected.dev || identity.ino !== expected.ino) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment child does not match helper-created inode');
      }
    }
    await verifyPathBinding(visibleParent, parent, 'directory');
    return opened;
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
}

export function syncDirectoryLease(visiblePath: string, handle: FileHandle): {
  canonicalPath: string; fd: number; verify(): void;
} {
  return {
    canonicalPath: visiblePath,
    fd: handle.fd,
    verify: () => {
      const visible = fsSync.lstatSync(visiblePath, { bigint: true });
      const opened = fsSync.fstatSync(handle.fd, { bigint: true });
      if (visible.isSymbolicLink() || !visible.isDirectory() || !opened.isDirectory()
        || visible.dev !== opened.dev || visible.ino !== opened.ino
        || fsSync.realpathSync(visiblePath) !== visiblePath) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper parent changed');
      }
    },
  };
}

export function requireAttachmentEntryMutation(
  policy: WorkspaceEntryMutationPolicy,
  target: string,
): void {
  if (policy !== 'deny') return;
  throw errno(
    'UNSAFE_ATTACHMENT_DIR',
    `attachment entry mutation requires descriptor-relative or cwd-bound helper access: ${target}`,
  );
}

export function descriptorAccessPath(handle: FileHandle, descriptorRoot: string | null): string {
  if (!descriptorRoot) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'descriptor namespace is unavailable');
  }
  return path.join(descriptorRoot, String(handle.fd));
}

export function attachmentDirectoryAccessPath(dir: AttachmentFileDirectory): string {
  return dir.backend === 'descriptor'
    ? descriptorAccessPath(dir.attachments, dir.descriptorRoot)
    : dir.visibleDir;
}

export async function verifyVisibleDirectory(dir: AttachmentFileDirectory): Promise<void> {
  try {
    await verifyPathBinding(dir.visibleDir, dir.attachments, 'directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'UNSAFE_ATTACHMENT_DIR') throw error;
    throw Object.assign(
      errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory changed during the operation'),
      { cause: error },
    );
  }
}

export async function verifyPathBinding(
  visiblePath: string,
  handle: FileHandle,
  kind: 'directory' | 'file',
): Promise<void> {
  const before = await fsp.lstat(visiblePath);
  if (before.isSymbolicLink() || (kind === 'directory' ? !before.isDirectory() : !before.isFile())) {
    throw errno('UNSAFE_ATTACHMENT_DIR', `attachment ${kind} changed during the operation`);
  }
  const canonical = await fsp.realpath(visiblePath);
  if (!sameCanonicalPath(canonical, visiblePath)) {
    throw errno('UNSAFE_ATTACHMENT_DIR', `attachment ${kind} escaped its canonical path`);
  }
  const [boundStat, visibleStat] = await Promise.all([handle.stat(), fsp.stat(visiblePath)]);
  if (
    (kind === 'directory' ? !boundStat.isDirectory() : !boundStat.isFile())
    || !sameFileIdentity(boundStat, visibleStat)
  ) {
    throw errno('UNSAFE_ATTACHMENT_DIR', `attachment ${kind} changed during the operation`);
  }
  const after = await fsp.lstat(visiblePath);
  if (after.isSymbolicLink() || !sameFileIdentity(before, after)) {
    throw errno('UNSAFE_ATTACHMENT_DIR', `attachment ${kind} changed during the operation`);
  }
}
