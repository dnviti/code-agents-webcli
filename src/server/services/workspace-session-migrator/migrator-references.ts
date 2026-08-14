import fs from 'node:fs';
import path from 'node:path';
import {
  openWorkspaceAttachmentDirectorySync,
  workspaceSessionFileParentLease,
  type WorkspaceStorageDirectoryLease,
} from '../workspace-session-storage.js';
import { openWorkspaceCwdFileForRead } from '../safe-session-file.js';
import {
  listWorkspaceCwdEntries,
  recoverWorkspaceCwdPublication,
} from '../workspace-cwd-helper.js';
import {
  DEFAULT_MAX_BYTES as DEFAULT_MAX_PASTE_BYTES,
  DEFAULT_SESSION_QUOTA_BYTES as DEFAULT_PASTE_SESSION_QUOTA_BYTES,
} from '../paste-store.js';
import {
  MAX_ATTACHMENT_DIRECTORY_ENTRIES,
  MAX_ATTACHMENT_FILES,
  MAX_PASTE_MANIFEST_ENTRIES,
  PASTED_IMAGE_NAME,
  READ_FLAGS,
  STORED_ATTACHMENT_NAME,
  sameFileIdentity,
  stableFile,
} from './migrator-core.js';
import type {
  ArtifactDirectoryLease,
  ArtifactPaths,
  LegacyArtifactBlockReason,
  PasteManifest,
  PasteManifestEntry,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';
import {
  fingerprintPublishedFile,
  leaseAwareFileStatOrNull,
} from './migrator-fs.js';
import { recoverLegacyRetirement } from './migrator-recovery.js';

export function attachmentNameFromUrl(url: unknown, sessionId: string): string | null {
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

export async function collectAttachmentReferencesFromFile(
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

export async function namespacedAttachmentNames(
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

export function parsePasteManifest(buffer: Buffer): PasteManifest {
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

export async function sourceOrBackup(definition: ArtifactPaths): Promise<string | null> {
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
