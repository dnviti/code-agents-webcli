import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentSessionRef, AttachmentStorageIdentity } from './types.js';
import { errno } from './util.js';

/** One in-process writer at a time may account and mutate a session namespace. */
const attachmentNamespaceTails = new Map<string, Promise<void>>();
/** A late upload admitted before DELETE must not recreate a retired namespace. */
export const deletedAttachmentNamespaces = new Set<string>();

async function attachmentNamespaceKey(identity: AttachmentStorageIdentity): Promise<string> {
  const canonicalRoot = await fsp.realpath(identity.workspaceRoot)
    .catch(() => path.resolve(identity.workspaceRoot));
  return `${canonicalRoot}\0${identity.ownerKey}\0${identity.sessionId}`;
}

export async function serializeAttachmentNamespace<T>(
  identity: AttachmentStorageIdentity,
  operation: (namespaceKey: string) => Promise<T>,
): Promise<T> {
  const key = await attachmentNamespaceKey(identity);
  const previous = attachmentNamespaceTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  attachmentNamespaceTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation(key);
  } finally {
    release();
    if (attachmentNamespaceTails.get(key) === tail) attachmentNamespaceTails.delete(key);
  }
}

/** Resolve and validate the exact owner/session namespace for this operation. */
export function attachmentStorageIdentity(session: AttachmentSessionRef): AttachmentStorageIdentity {
  const candidate = session.storageScope
    ? session.storageScope.workspaceRoot
    : session.workingDir;
  if (!candidate || !path.isAbsolute(candidate)) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment workspace must be absolute');
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'filesystem root cannot own attachments');
  }

  // New records use the opaque stable owner key. Numeric ids are intentionally
  // only a compatibility namespace for records created before storageScope.
  const ownerKey = session.storageScope
    ? safeNamespaceComponent(session.storageScope.ownerKey, 'attachment owner key')
    : safeNamespaceComponent(session.ownerUserId, 'legacy attachment owner id');
  const sessionId = safeNamespaceComponent(session.id, 'attachment session id');
  return { workspaceRoot: resolved, ownerKey, sessionId };
}

function safeNamespaceComponent(value: unknown, label: string): string {
  const component = String(value);
  if (!/^[A-Za-z0-9._-]+$/.test(component) || component === '.' || component === '..') {
    throw errno('UNSAFE_ATTACHMENT_DIR', `unsafe ${label}`);
  }
  return component;
}

/** Refuse namespaces this host-filesystem store cannot represent safely. */
export function assertHostAttachmentSession(session: AttachmentSessionRef): void {
  if (
    (session.projectId !== undefined && session.projectId !== null)
    || session.projectWorkingDirKind !== undefined
  ) {
    throw errno(
      'UNSUPPORTED_ATTACHMENT_NAMESPACE',
      'project attachments require a container-aware attachment store',
    );
  }
  if (!Number.isSafeInteger(session.ownerUserId)) {
    throw errno('INVALID_SESSION', 'attachment owner must be an integer');
  }
  const id = String(session.id);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw errno('INVALID_SESSION', 'unsafe attachment session id');
  }
}
