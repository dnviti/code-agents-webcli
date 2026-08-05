import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ChatAttachment } from '../../shared/chat-events.js';
import type { SessionStorageScope } from '../types.js';
import { sniffImageType, type ImageKind } from './paste-store.js';
import {
  resolveWorkspaceEntryMutationPolicy,
  workspaceDescriptorRoot,
  workspacePathMutationsAreHandlePinned,
  workspaceSessionAccessDirectory,
  type WorkspaceEntryMutationPolicy,
} from './workspace-session-storage.js';

/**
 * Files and images attached to a chat turn.
 *
 * Sibling of the paste store rather than an extension of it, and deliberately
 * so: that one exists to put a *pasted image* into a terminal and proves the
 * bytes really are an image before it writes them. This one accepts a
 * spreadsheet, a log, a PDF — anything the user drags onto the composer — so it
 * cannot make that promise, and folding the two together would have quietly
 * removed a check the terminal path depends on.
 *
 * Files land inside the immutable workspace assigned to the session, under an
 * owner- and session-scoped directory. `ChatAttachment.path` is what the
 * Claude and pi adapters actually hand to the runtime, while the two namespace
 * components prevent another session in the same checkout from sharing its
 * quota or resolving its files.
 *
 * Unlike a paste, an attachment is **not** cleaned up when the session ends.
 * It is referenced by a durable transcript — an image block in a conversation
 * you can still scroll back through months later — and deleting it would turn
 * that history into broken thumbnails. The bound on it is a per-session quota,
 * not a lifetime.
 *
 * What is deliberately not attempted: deciding what a non-image file "is".
 * The browser's `File.type` is an extension lookup on someone else's machine
 * and the `Content-Type` header is whatever the client felt like sending, so
 * neither is ever echoed back as a response content type — see `serveKind`.
 */

export const ATTACHMENT_DIR = '.cc-web';
export const ATTACHMENT_SUBDIR = 'attachments';

/** Per file. The route enforces the same number at the body-parser level. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Per session, so dragging a folder of videos in cannot fill the disk. */
export const DEFAULT_ATTACHMENT_QUOTA_BYTES = 400 * 1024 * 1024;
/** Also per session: a quota alone still allows a million one-byte files. */
export const DEFAULT_MAX_ATTACHMENTS = 500;

const IMAGE_MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * A stored name, as this module writes them: 12 hex characters, a dash, then a
 * sanitised original name. Used to validate a name coming back off a URL, so it
 * is anchored and character-classed rather than merely "does not contain ..".
 */
const STORED_NAME = /^[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/;

/** A media type shaped like one. Not a claim that it is accurate — see above. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;

export interface AttachmentSessionRef {
  id: string;
  ownerUserId: number;
  workingDir: string;
  /** Required explicitly so a caller cannot accidentally erase the namespace while reshaping a record. */
  projectId: string | null | undefined;
  /** Project paths use a different namespace and need a container-aware store. */
  projectWorkingDirKind: 'host' | 'container' | undefined;
  /** Immutable workspace that owns both metadata and attachment bytes. */
  storageScope?: SessionStorageScope;
  persistenceUnavailable?: string;
}

export interface StoredAttachment {
  /** The name the user's file had, sanitised. What the UI shows. */
  name: string;
  /** The name on disk, which is also the URL segment. Unguessable prefix. */
  storedName: string;
  absolutePath: string;
  /** Relative to the working directory, for prompts that quote a path. */
  relativePath: string;
  mime: string;
  bytes: number;
}

export interface AttachmentInput {
  filename: string;
  /** What the browser claimed. Trusted for display only, never for serving. */
  declaredMime: string;
  bytes: Buffer;
}

export interface AttachmentDeleteOptions {
  /** The caller already owns the ProjectManager lifecycle gate. */
  projectLifecycleExclusive?: boolean;
}

export interface AttachmentStoreLike {
  save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment>;
  flush?(session: AttachmentSessionRef): Promise<void>;
  /**
   * Copy one durable source attachment into a freshly-created branch namespace.
   *
   * Only the canonical source URL is used to select bytes. In particular,
   * `attachment.path` is never consulted: it came over the websocket and is
   * not authority for either workspace. The returned metadata is rebuilt from
   * the verified source inode and the newly-created target file.
   */
  cloneForBranch(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment>;
  /** Remove only this owner/session namespace after a definitive session delete. */
  deleteSessionAttachments(
    session: AttachmentSessionRef,
    options?: AttachmentDeleteOptions,
  ): Promise<void>;
  resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }>;
  /** Resolve wire metadata to the server-owned file it names; never accepts `attachment.path`. */
  resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment>;
  /** Open the verified inode the response will stream; callers must not reopen `absolutePath`. */
  openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }>;
}

/**
 * How a stored file may be handed back to a browser.
 *
 * Two outcomes only. A file whose bytes really are an image gets that image's
 * own type and renders inline, because a transcript with a picture in it is the
 * entire point of attaching one. Everything else is an opaque download, whatever
 * the uploader called it — serving a user-supplied `text/html` from the app's
 * own origin would be a stored XSS with a file picker in front of it.
 */
export interface ServeKind {
  contentType: string;
  inline: boolean;
  filename: string;
}

export interface AttachmentStoreOptions {
  maxBytes?: number;
  quotaBytes?: number;
  maxFiles?: number;
  randomId?: () => string;
  /** Force a backend in tests; pathname traversal remains read-only unless its handles pin names. */
  directoryBackend?: AttachmentDirectoryBackend;
  /** Deterministic race injection for security tests; never set by production composition. */
  testHooks?: {
    afterDirectoryOpened?(operation: 'save' | 'resolve' | 'download' | 'delete'): void | Promise<void>;
    afterUsageScanned?(usage: { files: number; bytes: number }): void | Promise<void>;
    afterBranchCloneChunk?(pass: 'copy' | 'verify', bytesRead: number): void | Promise<void>;
    afterBranchCloneRead?(pass: 'copy' | 'verify'): void | Promise<void>;
  };
}

export type AttachmentDirectoryBackend = 'auto' | 'descriptor' | 'path';

type ResolvedAttachmentDirectoryBackend = Exclude<AttachmentDirectoryBackend, 'auto'>;

/**
 * Keep platform selection pure and injectable so macOS/BSD and Windows policy
 * are covered on Linux CI. Descriptor traversal is selected only after the
 * shared resolver has proved real child create/rename/unlink through procfs or
 * fdescfs. Windows always uses its separately-probed handle-pinned path mode.
 */
export function resolveAttachmentDirectoryBackend(
  requested: AttachmentDirectoryBackend = 'auto',
  platform: NodeJS.Platform = process.platform,
  descriptorNamespaceAvailable = workspaceDescriptorRoot() !== null,
): ResolvedAttachmentDirectoryBackend {
  if (requested === 'path') return requested;
  if (requested === 'descriptor') {
    if (platform === 'win32' || !descriptorNamespaceAvailable) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'secure descriptor traversal is unavailable');
    }
    return requested;
  }
  return platform !== 'win32' && descriptorNamespaceAvailable
    ? 'descriptor'
    : 'path';
}

/** One in-process writer at a time may account and mutate a session namespace. */
const attachmentNamespaceTails = new Map<string, Promise<void>>();
/** A late upload admitted before DELETE must not recreate a retired namespace. */
const deletedAttachmentNamespaces = new Set<string>();

export class AttachmentStore implements AttachmentStoreLike {
  private readonly maxBytes: number;
  private readonly quotaBytes: number;
  private readonly maxFiles: number;
  private readonly randomId: () => string;
  private readonly directoryBackend: ResolvedAttachmentDirectoryBackend;
  private readonly descriptorRoot: string | null;
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
        const handle = await createAttachmentFile(dir, storedName);
        created = true;
        try {
          await handle.writeFile(input.bytes);
          await verifyVisibleFile(dir, storedName, handle);
        } finally {
          await handle.close();
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
      const before = await opened.handle.stat({ bigint: true });
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
      const stream = opened.handle.createReadStream({ autoClose: false, start: 0 });
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
      const after = await opened.handle.stat({ bigint: true });
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
      await opened.handle.close().catch(() => undefined);
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
      await opened.handle.close();
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
      stream: opened.handle.createReadStream({ autoClose: true, start: 0 }),
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
    handle: FileHandle;
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

/** Identity and mutation signal for one still-open attachment inode. */
function attachmentFileVersion(stat: BigIntStats): string {
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

/** The one canonical browser URL for a stored attachment. */
export function attachmentUrlFor(sessionId: string, storedName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/${encodeURIComponent(storedName)}`;
}

async function inspectStoredAttachment(
  directory: ReadableAttachmentDirectory,
  storedName: string,
  operation: 'resolve' | 'download',
  testHooks: AttachmentStoreOptions['testHooks'],
): Promise<{
  directory: ReadableAttachmentDirectory;
  handle: FileHandle;
  serve: ServeKind;
  bytes: number;
}> {
  let handle: FileHandle | null = null;
  try {
    await testHooks?.afterDirectoryOpened?.(operation);
    handle = await openAttachmentFile(directory, storedName);
    const stat = await handle.stat();
    if (!stat.isFile()) throw errno('NOT_FOUND', 'no such attachment');
    const buffer = Buffer.alloc(Math.min(64, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (operation === 'resolve') await verifyVisibleDirectory(directory);
    return {
      directory,
      handle,
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
async function legacyAttachmentIsReferenced(
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

/**
 * Recover a stored identity only from the exact URL shape this server emits.
 *
 * Prefix checks are insufficient here: they also accept nested path segments,
 * query strings and percent-encoded separators. Re-encoding the decoded name
 * gives a cheap canonical-form check and the stored-name grammar supplies the
 * final namespace boundary.
 */
export function storedAttachmentNameFromUrl(url: string, sessionId: string): string | null {
  if (typeof url !== 'string') return null;
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/`;
  if (!url.startsWith(prefix)) return null;
  const encoded = url.slice(prefix.length);
  if (!encoded || encoded.includes('/') || encoded.includes('?') || encoded.includes('#')) {
    return null;
  }

  try {
    const storedName = decodeURIComponent(encoded);
    if (!STORED_NAME.test(storedName)) return null;
    return encodeURIComponent(storedName) === encoded ? storedName : null;
  } catch {
    return null;
  }
}

/**
 * A filename that cannot be anything but a filename.
 *
 * Takes the basename in both separator styles first — a browser on Windows
 * hands over `C:\Users\me\notes.txt` for a drag-and-drop — then reduces what is
 * left to a character class with no separators, no control bytes and no leading
 * dot, so the result can never climb out of the directory it is joined to or
 * hide once it is there.
 */
export function safeName(filename: string): string {
  const raw = String(filename || '');
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * The type recorded on the turn.
 *
 * The sniff wins wherever it fires, because "is this an image" is the one
 * question the rest of the system asks of this field — the composer draws a
 * thumbnail, the session writes an image block, Claude's adapter inlines the
 * bytes as an image content block — and the answer has to come from the file
 * rather than from its name.
 */
export function displayMime(bytes: Buffer, declared: string): string {
  const image = sniffImageType(bytes);
  if (image) return IMAGE_MIME[image];

  const claim = String(declared || '').split(';')[0].trim().toLowerCase();
  // An `image/*` claim the sniff just refused is a lie or a format nothing
  // here handles; either way, letting it through would put a broken <img> in
  // the transcript and tell Claude to base64 a file that is not a picture.
  if (!MIME_SHAPE.test(claim) || claim.startsWith('image/')) return 'application/octet-stream';
  return claim;
}

/** See ServeKind: real images inline, everything else an opaque download. */
export function serveKind(head: Buffer, storedName: string): ServeKind {
  const image = sniffImageType(head);
  const filename = storedName.replace(/^[0-9a-f]{12}-/, '') || 'attachment';
  if (image) return { contentType: IMAGE_MIME[image], inline: true, filename };
  return { contentType: 'application/octet-stream', inline: false, filename };
}

async function usage(dir: OpenAttachmentDirectory): Promise<{ files: number; bytes: number }> {
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

interface AttachmentStorageIdentity {
  workspaceRoot: string;
  ownerKey: string;
  sessionId: string;
}

async function attachmentNamespaceKey(identity: AttachmentStorageIdentity): Promise<string> {
  const canonicalRoot = await fsp.realpath(identity.workspaceRoot)
    .catch(() => path.resolve(identity.workspaceRoot));
  return `${canonicalRoot}\0${identity.ownerKey}\0${identity.sessionId}`;
}

async function serializeAttachmentNamespace<T>(
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
function attachmentStorageIdentity(session: AttachmentSessionRef): AttachmentStorageIdentity {
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
function assertHostAttachmentSession(session: AttachmentSessionRef): void {
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

interface AttachmentFileDirectory {
  backend: ResolvedAttachmentDirectoryBackend;
  descriptorRoot: string | null;
  mutationPolicy: WorkspaceEntryMutationPolicy;
  attachments: FileHandle;
  visibleDir: string;
}

interface OpenAttachmentDirectory extends AttachmentFileDirectory {
  working: FileHandle;
  container: FileHandle;
  attachmentRoot: FileHandle;
  owner: FileHandle;
}

interface OpenLegacyAttachmentDirectory extends AttachmentFileDirectory {
  working: FileHandle;
  container: FileHandle;
}

type ReadableAttachmentDirectory = OpenAttachmentDirectory | OpenLegacyAttachmentDirectory;

/**
 * Open the whole directory chain one inode at a time.
 *
 * Node has no public openat(2), so a capability-probed
 * `/proc/self/fd/<n>/child` or `/dev/fd/<n>/child` is the Unix equivalent.
 * Path traversal remains useful for inode-verified reads; entry mutations use
 * it only on Windows volumes where the shared probe proves live handles deny
 * both rename and removal. Every other pathname fallback is read-only.
 */
async function openAttachmentDirectory(
  identity: AttachmentStorageIdentity,
  create: boolean,
  backend: ResolvedAttachmentDirectoryBackend,
  descriptorRoot: string | null,
): Promise<OpenAttachmentDirectory> {
  const resolvedWorkingDir = path.resolve(identity.workspaceRoot);
  if (resolvedWorkingDir === path.parse(resolvedWorkingDir).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'refusing an attachment directory at filesystem root');
  }

  const realWorkingDir = await fsp.realpath(resolvedWorkingDir).catch(() => '');
  if (!realWorkingDir) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment working directory does not exist');
  }
  let working: FileHandle | null = null;
  let container: FileHandle | null = null;
  let attachmentRoot: FileHandle | null = null;
  let owner: FileHandle | null = null;
  let attachments: FileHandle | null = null;
  try {
    working = await openDirectory(realWorkingDir, realWorkingDir);
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
async function openLegacyAttachmentDirectory(
  identity: AttachmentStorageIdentity,
  backend: ResolvedAttachmentDirectoryBackend,
  descriptorRoot: string | null,
): Promise<OpenLegacyAttachmentDirectory> {
  const resolvedWorkingDir = path.resolve(identity.workspaceRoot);
  if (resolvedWorkingDir === path.parse(resolvedWorkingDir).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'refusing an attachment directory at filesystem root');
  }
  const realWorkingDir = await fsp.realpath(resolvedWorkingDir).catch(() => '');
  if (!realWorkingDir) throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment workspace does not exist');

  let working: FileHandle | null = null;
  let container: FileHandle | null = null;
  let attachments: FileHandle | null = null;
  try {
    working = await openDirectory(realWorkingDir, realWorkingDir);
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
  try {
    const before = await fsp.lstat(target);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment path component is not a real directory');
    }
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
    await verifyPathBinding(expectedRealPath, handle, 'directory');
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
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
): Promise<FileHandle> {
  const opened = await openDirectory(target, visibleTarget);
  try {
    await verifyPathBinding(visibleParent, parent, 'directory');
    return opened;
  } catch (error) {
    await opened.close().catch(() => undefined);
    throw error;
  }
}

function optionalFlag(value: number | undefined): number {
  return typeof value === 'number' ? value : 0;
}

function requireAttachmentEntryMutation(
  policy: WorkspaceEntryMutationPolicy,
  target: string,
): void {
  if (policy !== 'deny') return;
  throw errno(
    'UNSAFE_ATTACHMENT_DIR',
    `attachment entry mutation requires descriptor-relative or handle-pinned access: ${target}`,
  );
}

function descriptorAccessPath(handle: FileHandle, descriptorRoot: string | null): string {
  if (!descriptorRoot) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'descriptor namespace is unavailable');
  }
  return path.join(descriptorRoot, String(handle.fd));
}

function attachmentDirectoryAccessPath(dir: AttachmentFileDirectory): string {
  return dir.backend === 'descriptor'
    ? descriptorAccessPath(dir.attachments, dir.descriptorRoot)
    : dir.visibleDir;
}

async function verifyVisibleDirectory(dir: AttachmentFileDirectory): Promise<void> {
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

async function verifyPathBinding(
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

function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFileIdentity(left: Awaited<ReturnType<FileHandle['stat']>>, right: typeof left): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  // Some Windows filesystem providers report a zero inode. Birth time is the
  // conservative file-id fallback; accepting every entry on the same volume
  // would make the pathname swap checks meaningless there.
  return left.birthtimeMs === right.birthtimeMs;
}

async function createAttachmentFile(
  dir: OpenAttachmentDirectory,
  storedName: string,
): Promise<FileHandle> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
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

async function openAttachmentFile(
  dir: AttachmentFileDirectory,
  storedName: string,
): Promise<FileHandle> {
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  const handle = await fsp.open(
    path.join(attachmentDirectoryAccessPath(dir), storedName),
    fsConstants.O_RDONLY | optionalFlag(fsConstants.O_NOFOLLOW),
  );
  try {
    if (dir.backend === 'path') await verifyVisibleFile(dir, storedName, handle);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyVisibleFile(
  dir: AttachmentFileDirectory,
  storedName: string,
  handle: FileHandle,
): Promise<void> {
  await verifyVisibleDirectory(dir);
  await verifyPathBinding(path.join(dir.visibleDir, storedName), handle, 'file');
  await verifyVisibleDirectory(dir);
}

async function removeCreatedAttachment(
  dir: OpenAttachmentDirectory,
  storedName: string,
): Promise<void> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
  await fsp.rm(path.join(attachmentDirectoryAccessPath(dir), storedName), { force: true });
  if (dir.backend === 'path') await verifyVisibleDirectory(dir);
}

async function deleteAttachmentNamespace(dir: OpenAttachmentDirectory): Promise<void> {
  requireAttachmentEntryMutation(dir.mutationPolicy, dir.visibleDir);
  await verifyVisibleDirectory(dir);
  const accessRoot = attachmentDirectoryAccessPath(dir);
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
      const stat = await handle.stat();
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

  await verifyVisibleDirectory(dir);
  const visibleOwner = path.dirname(dir.visibleDir);
  await verifyPathBinding(visibleOwner, dir.owner, 'directory');
  // Windows will not remove a directory while its validation handle is open.
  // Closing only the exact session handle leaves the owner/sibling binding in
  // place for the rmdir and its post-check.
  await dir.attachments.close().catch(() => undefined);
  const target = dir.backend === 'descriptor'
    ? path.join(descriptorAccessPath(dir.owner, dir.descriptorRoot), path.basename(dir.visibleDir))
    : dir.visibleDir;
  await fsp.rmdir(target);
  await verifyPathBinding(visibleOwner, dir.owner, 'directory');
}

async function closeAttachmentDirectory(dir: OpenAttachmentDirectory): Promise<void> {
  await dir.attachments.close().catch(() => undefined);
  await dir.owner.close().catch(() => undefined);
  await dir.attachmentRoot.close().catch(() => undefined);
  await dir.container.close().catch(() => undefined);
  await dir.working.close().catch(() => undefined);
}

async function closeReadableAttachmentDirectory(dir: ReadableAttachmentDirectory): Promise<void> {
  if ('owner' in dir) {
    await closeAttachmentDirectory(dir);
    return;
  }
  await dir.attachments.close().catch(() => undefined);
  await dir.container.close().catch(() => undefined);
  await dir.working.close().catch(() => undefined);
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
