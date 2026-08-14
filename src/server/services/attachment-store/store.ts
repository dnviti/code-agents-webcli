import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { ChatAttachment } from '../../../shared/chat-events.js';
import { workspaceDescriptorRoot } from '../workspace-session-storage.js';

import {
  ATTACHMENT_DIR,
  ATTACHMENT_SUBDIR,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_MAX_ATTACHMENTS,
  STORED_NAME,
  attachmentUrlFor,
  displayMime,
  safeName,
  storedAttachmentNameFromUrl,
} from './names.js';
import { resolveAttachmentDirectoryBackend } from './resolver.js';
import {
  assertHostAttachmentSession,
  attachmentStorageIdentity,
  deletedAttachmentNamespaces,
  serializeAttachmentNamespace,
} from './namespace.js';
import {
  openAttachmentDirectory,
  openLegacyAttachmentDirectory,
  verifyVisibleDirectory,
} from './directory.js';
import {
  attachmentFileVersion,
  closeAttachmentDirectory,
  closeReadableAttachmentDirectory,
  createAttachmentFile,
  cwdAttachmentStat,
  cwdAttachmentVersion,
  deleteAttachmentNamespace,
  inspectStoredAttachment,
  legacyAttachmentIsReferenced,
  removeCreatedAttachment,
  usage,
  verifyCwdAttachmentFile,
  verifyVisibleFile,
} from './files.js';
import { errno } from './util.js';
import type {
  AttachmentDeleteOptions,
  AttachmentInput,
  AttachmentSessionRef,
  AttachmentStoreLike,
  AttachmentStoreOptions,
  CwdAttachmentStat,
  OpenAttachmentDirectory,
  ReadableAttachmentDirectory,
  ResolvedAttachmentDirectoryBackend,
  ServeKind,
  StoredAttachment,
} from './types.js';

export class AttachmentStore implements AttachmentStoreLike {
  private readonly maxBytes: number;
  private readonly quotaBytes: number;
  private readonly maxFiles: number;
  private readonly randomId: () => string;
  private readonly directoryBackend: ResolvedAttachmentDirectoryBackend;
  private readonly descriptorRoot: string | null;
  private readonly allowCwdHelper: boolean;
  private readonly testHooks: AttachmentStoreOptions['testHooks'];

  constructor(options: AttachmentStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_ATTACHMENT_QUOTA_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_ATTACHMENTS;
    this.randomId = options.randomId ?? (() => randomBytes(6).toString('hex'));
    const descriptorRoot = workspaceDescriptorRoot();
    this.directoryBackend = resolveAttachmentDirectoryBackend(
      options.directoryBackend,
      process.platform,
      descriptorRoot !== null,
    );
    this.descriptorRoot = this.directoryBackend === 'descriptor' ? descriptorRoot : null;
    this.allowCwdHelper = options.directoryBackend !== 'path'
      && this.directoryBackend === 'path';
    this.testHooks = options.testHooks;
  }

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    if (session.persistenceUnavailable) {
      throw errno('SESSION_PERSISTENCE_UNAVAILABLE', session.persistenceUnavailable);
    }
    assertHostAttachmentSession(session);
    if (!input.bytes || input.bytes.length === 0) {
      throw errno('EMPTY_BODY', 'the upload had no body');
    }
    if (input.bytes.length > this.maxBytes) {
      throw errno('FILE_TOO_LARGE', `over the ${this.maxBytes} byte limit`);
    }

    const identity = attachmentStorageIdentity(session);
    return serializeAttachmentNamespace(identity, async (namespaceKey) => {
      if (deletedAttachmentNamespaces.has(namespaceKey)) {
        throw errno('SESSION_DELETED', 'attachment session has been deleted');
      }
      const dir = await openAttachmentDirectory(
        identity,
        true,
        this.directoryBackend,
        this.descriptorRoot,
        this.allowCwdHelper,
      );
      let storedName: string | null = null;
      let created = false;
      try {
        await this.testHooks?.afterDirectoryOpened?.('save');

        // The namespace lock spans accounting, creation, writing and rollback.
        // Without that boundary two Promise.all uploads can both admit against
        // the same old total and oversubscribe the quota.
        const currentUsage = await usage(dir);
        await this.testHooks?.afterUsageScanned?.(currentUsage);
        const { files, bytes } = currentUsage;
        if (files >= this.maxFiles) {
          throw errno('QUOTA_EXCEEDED', `this session already holds ${files} attachments`);
        }
        if (bytes + input.bytes.length > this.quotaBytes) {
          throw errno('QUOTA_EXCEEDED', 'this session is at its attachment quota');
        }

        const safe = safeName(input.filename);
        storedName = `${this.randomId()}-${safe}`;
        if (!STORED_NAME.test(storedName)) {
          throw errno('INVALID_STORED_NAME', 'refusing an invalid generated attachment name');
        }

        // O_EXCL protects collisions. The portable backend additionally binds
        // the zero-byte inode to the validated parent before any user bytes are
        // written, then verifies both bindings again afterwards.
        const handle = await createAttachmentFile(dir, storedName, input.bytes);
        created = true;
        try {
          if (dir.mutationPolicy === 'cwd-helper') {
            verifyCwdAttachmentFile(dir, storedName);
          } else {
            await handle!.writeFile(input.bytes);
            await verifyVisibleFile(dir, storedName, handle!);
          }
        } finally {
          await handle?.close();
        }

        // A runtime still consumes an ordinary path. Do not return one unless it
        // currently names the exact directory inode used for the write.
        await verifyVisibleDirectory(dir);

        return {
          name: safe,
          storedName,
          absolutePath: path.join(dir.visibleDir, storedName),
          relativePath: path.join(
            ATTACHMENT_DIR,
            ATTACHMENT_SUBDIR,
            identity.ownerKey,
            identity.sessionId,
            storedName,
          ),
          mime: displayMime(input.bytes, input.declaredMime),
          bytes: input.bytes.length,
        };
      } catch (error) {
        if (storedName && created) {
          await removeCreatedAttachment(dir, storedName).catch(() => undefined);
        }
        throw error;
      } finally {
        await closeAttachmentDirectory(dir);
      }
    });
  }

  async flush(session: AttachmentSessionRef): Promise<void> {
    assertHostAttachmentSession(session);
    const identity = attachmentStorageIdentity(session);
    await serializeAttachmentNamespace(identity, async () => undefined);
  }

  async cloneForBranch(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    assertHostAttachmentSession(source);
    assertHostAttachmentSession(target);
    assertBranchCloneOwners(source, target);
    const storedName = storedAttachmentNameFromUrl(attachment.url, source.id);
    if (!storedName) {
      throw errno('NOT_FOUND', 'attachment URL does not belong to the source session');
    }

    const copied = await this.readStableBranchSource(source, storedName, 'copy');
    await this.testHooks?.afterBranchCloneRead?.('copy');
    const verified = await this.readStableBranchSource(source, storedName, 'verify');
    await this.testHooks?.afterBranchCloneRead?.('verify');
    if (
      copied.version !== verified.version
      || copied.bytes.length !== verified.bytes.length
      || copied.digest !== verified.digest
      || copied.serve.filename !== verified.serve.filename
      || copied.serve.contentType !== verified.serve.contentType
      || copied.serve.inline !== verified.serve.inline
    ) {
      throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment changed while it was copied');
    }

    const stored = await this.save(target, {
      filename: copied.serve.filename,
      declaredMime: attachment.mime,
      bytes: copied.bytes,
    });
    return {
      url: attachmentUrlFor(target.id, stored.storedName),
      name: stored.name,
      mime: stored.mime,
      size: stored.bytes,
      path: stored.absolutePath,
    };
  }

  private async readStableBranchSource(
    source: AttachmentSessionRef,
    storedName: string,
    pass: 'copy' | 'verify',
  ): Promise<{ bytes: Buffer; digest: string; serve: ServeKind; version: string }> {
    const opened = await this.openStored(source, storedName, 'download');
    try {
      if (opened.data && opened.cwdStat) {
        const before = opened.cwdStat;
        if (before.nlink !== 1n) {
          throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment identity is unsafe');
        }
        if (before.size <= 0 || before.size > this.maxBytes) {
          throw errno('FILE_TOO_LARGE', 'source attachment exceeds the branch copy limit');
        }
        const version = cwdAttachmentVersion(before);
        const chunks: Buffer[] = [];
        const hash = createHash('sha256');
        let bytes = 0;
        for (let offset = 0; offset < opened.data.length; offset += 64 * 1024) {
          const value = opened.data.subarray(offset, Math.min(offset + 64 * 1024, opened.data.length));
          bytes += value.length;
          hash.update(value);
          chunks.push(value);
          await this.testHooks?.afterBranchCloneChunk?.(pass, bytes);
        }
        const after = cwdAttachmentStat(opened.directory, storedName, before.identity);
        if (bytes !== before.size || cwdAttachmentVersion(after) !== version) {
          throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment changed while it was copied');
        }
        return {
          bytes: Buffer.concat(chunks, bytes), digest: hash.digest('hex'), serve: opened.serve, version,
        };
      }
      const handle = opened.handle;
      if (!handle) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment helper did not provide source data');
      }
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment identity is unsafe');
      }
      if (before.size <= 0n || before.size > BigInt(this.maxBytes)) {
        throw errno('FILE_TOO_LARGE', 'source attachment exceeds the branch copy limit');
      }
      const version = attachmentFileVersion(before);
      const chunks: Buffer[] = [];
      const hash = createHash('sha256');
      let bytes = 0;
      const stream = handle.createReadStream({ autoClose: false, start: 0 });
      try {
        for await (const chunk of stream) {
          const value = Buffer.from(chunk);
          bytes += value.length;
          if (bytes > this.maxBytes) {
            stream.destroy();
            throw errno('FILE_TOO_LARGE', 'source attachment exceeds the branch copy limit');
          }
          hash.update(value);
          chunks.push(value);
          await this.testHooks?.afterBranchCloneChunk?.(pass, bytes);
        }
      } catch (error) {
        stream.destroy();
        throw error;
      }
      const after = await handle.stat({ bigint: true });
      if (bytes !== Number(before.size) || attachmentFileVersion(after) !== version) {
        throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment changed while it was copied');
      }
      return {
        bytes: Buffer.concat(chunks, bytes),
        digest: hash.digest('hex'),
        serve: opened.serve,
        version,
      };
    } finally {
      await opened.handle?.close().catch(() => undefined);
      await closeReadableAttachmentDirectory(opened.directory).catch(() => undefined);
    }
  }

  async deleteSessionAttachments(
    session: AttachmentSessionRef,
    _options: AttachmentDeleteOptions = {},
  ): Promise<void> {
    assertHostAttachmentSession(session);
    const identity = attachmentStorageIdentity(session);
    await serializeAttachmentNamespace(identity, async (namespaceKey) => {
      // Set under the same namespace turn as save accounting. A save already
      // writing finishes first and is removed below; a save queued behind this
      // delete observes the tombstone before it can recreate the directory.
      deletedAttachmentNamespaces.add(namespaceKey);
      let deleted = false;
      let dir: OpenAttachmentDirectory;
      try {
        dir = await openAttachmentDirectory(
          identity,
          false,
          this.directoryBackend,
          this.descriptorRoot,
          this.allowCwdHelper,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          deleted = true;
          return;
        }
        deletedAttachmentNamespaces.delete(namespaceKey);
        throw error;
      }
      try {
        await this.testHooks?.afterDirectoryOpened?.('delete');
        await deleteAttachmentNamespace(dir);
        deleted = true;
      } finally {
        try {
          await closeAttachmentDirectory(dir);
        } finally {
          if (!deleted) deletedAttachmentNamespaces.delete(namespaceKey);
        }
      }
    });
  }

  async resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    assertHostAttachmentSession(session);
    if (!STORED_NAME.test(storedName)) {
      throw errno('NOT_FOUND', 'no such attachment');
    }

    const opened = await this.openStored(session, storedName, 'resolve');
    try {
      return {
        absolutePath: path.join(opened.directory.visibleDir, storedName),
        bytes: opened.bytes,
        serve: opened.serve,
      };
    } finally {
      await opened.handle?.close();
      await closeReadableAttachmentDirectory(opened.directory);
    }
  }

  async resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    // This gate deliberately precedes URL parsing and every filesystem call.
    // A container path such as /tmp must never alias the host's /tmp merely
    // because both strings are absolute.
    assertHostAttachmentSession(session);

    const storedName = storedAttachmentNameFromUrl(attachment.url, session.id);
    if (!storedName) {
      throw errno('NOT_FOUND', 'attachment URL does not belong to this session');
    }

    const resolved = await this.resolve(session, storedName);
    return {
      url: attachmentUrlFor(session.id, storedName),
      name: resolved.serve.filename,
      mime: resolved.serve.contentType,
      size: resolved.bytes,
      path: resolved.absolutePath,
    };
  }

  async openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }> {
    const opened = await this.openStored(session, storedName, 'download');
    // The file handle is the authority from here on. Parent directory handles
    // can close because renames and symlink swaps cannot redirect an open inode.
    await closeReadableAttachmentDirectory(opened.directory);
    return {
      stream: opened.data
        ? Readable.from(opened.data)
        : opened.handle!.createReadStream({ autoClose: true, start: 0 }),
      serve: opened.serve,
      bytes: opened.bytes,
    };
  }

  private async openStored(
    session: AttachmentSessionRef,
    storedName: string,
    operation: 'resolve' | 'download',
  ): Promise<{
    directory: ReadableAttachmentDirectory;
    handle: FileHandle | null;
    data: Buffer | null;
    cwdStat: CwdAttachmentStat | null;
    serve: ServeKind;
    bytes: number;
  }> {
    assertHostAttachmentSession(session);
    if (!STORED_NAME.test(storedName)) {
      throw errno('NOT_FOUND', 'no such attachment');
    }

    const identity = attachmentStorageIdentity(session);
    let directory: ReadableAttachmentDirectory | null = null;
    try {
      directory = await openAttachmentDirectory(
        identity,
        false,
        this.directoryBackend,
        this.descriptorRoot,
        this.allowCwdHelper,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw Object.assign(errno('NOT_FOUND', 'no such attachment'), { cause: error });
      }
    }

    if (directory) {
      try {
        return await inspectStoredAttachment(directory, storedName, operation, this.testHooks);
      } catch (error) {
        await closeReadableAttachmentDirectory(directory);
        directory = null;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw Object.assign(errno('NOT_FOUND', 'no such attachment'), { cause: error });
        }
      }
    }

    // Releases before owner/session namespacing stored attachment bytes flat
    // under `.cc-web/attachments`.  Serve those durable transcript references
    // only when this session's own migrated artifacts contain the exact URL;
    // an unguessable filename alone is not authority across owners.
    if (!await legacyAttachmentIsReferenced(session, storedName)) {
      throw errno('NOT_FOUND', 'no such attachment');
    }
    try {
      directory = await openLegacyAttachmentDirectory(
        identity,
        this.directoryBackend,
        this.descriptorRoot,
      );
      return await inspectStoredAttachment(directory, storedName, operation, this.testHooks);
    } catch (error) {
      if (directory) await closeReadableAttachmentDirectory(directory).catch(() => undefined);
      throw Object.assign(errno('NOT_FOUND', 'no such attachment'), { cause: error });
    }
  }
}

function assertBranchCloneOwners(
  source: AttachmentSessionRef,
  target: AttachmentSessionRef,
): void {
  if (source.ownerUserId !== target.ownerUserId) {
    throw errno('OWNER_MISMATCH', 'branch attachments cannot cross owners');
  }
  const sourceOwnerKey = source.storageScope?.ownerKey;
  const targetOwnerKey = target.storageScope?.ownerKey;
  if (
    (sourceOwnerKey !== undefined || targetOwnerKey !== undefined)
    && sourceOwnerKey !== targetOwnerKey
  ) {
    throw errno('OWNER_MISMATCH', 'branch attachment owner scope changed');
  }
  if (source.id === target.id) {
    throw errno('INVALID_TARGET', 'branch attachment target must be a new session');
  }
}
