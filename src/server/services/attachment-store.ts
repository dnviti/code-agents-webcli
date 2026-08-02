import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ChatAttachment } from '../../shared/chat-events.js';
import { sniffImageType, type ImageKind } from './paste-store.js';

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
 * Files land inside the session's own working directory for the same reason
 * pastes do: it is the only place all of these agent CLIs can read without
 * asking first, and `ChatAttachment.path` is what the Claude and pi adapters
 * actually hand to the runtime.
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

export interface AttachmentStoreLike {
  save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment>;
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
  /** Deterministic race injection for security tests; never set by production composition. */
  testHooks?: {
    afterDirectoryOpened?(operation: 'save' | 'resolve' | 'download'): void | Promise<void>;
  };
}

export class AttachmentStore implements AttachmentStoreLike {
  private readonly maxBytes: number;
  private readonly quotaBytes: number;
  private readonly maxFiles: number;
  private readonly randomId: () => string;
  private readonly testHooks: AttachmentStoreOptions['testHooks'];

  constructor(options: AttachmentStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_ATTACHMENT_QUOTA_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_ATTACHMENTS;
    this.randomId = options.randomId ?? (() => randomBytes(6).toString('hex'));
    this.testHooks = options.testHooks;
  }

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    assertHostAttachmentSession(session);
    if (!input.bytes || input.bytes.length === 0) {
      throw errno('EMPTY_BODY', 'the upload had no body');
    }
    if (input.bytes.length > this.maxBytes) {
      throw errno('FILE_TOO_LARGE', `over the ${this.maxBytes} byte limit`);
    }

    const dir = await openAttachmentDirectory(session.workingDir, true);
    let storedName: string | null = null;
    let created = false;
    try {
      await this.testHooks?.afterDirectoryOpened?.('save');

      // Counted before the write, not after: a quota checked afterwards is a
      // quota that has already been exceeded.
      const { files, bytes } = await usage(dir.attachments);
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

      // The parent is an already-open directory inode, not the visible path.
      // Exchanging `.cc-web` for a symlink after admission cannot redirect this
      // create. O_EXCL and O_NOFOLLOW protect the final component too.
      const target = path.join(fdAccessPath(dir.attachments), storedName);
      const handle = await fsp.open(
        target,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        await handle.writeFile(input.bytes);
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
        relativePath: path.join(ATTACHMENT_DIR, ATTACHMENT_SUBDIR, storedName),
        mime: displayMime(input.bytes, input.declaredMime),
        bytes: input.bytes.length,
      };
    } catch (error) {
      if (storedName && created) {
        // If the visible directory was exchanged after the write, remove the
        // file through the still-bound directory fd, never through that path.
        await fsp.rm(path.join(fdAccessPath(dir.attachments), storedName), { force: true })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await closeAttachmentDirectory(dir);
    }
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
      await closeAttachmentDirectory(opened.directory);
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
    await closeAttachmentDirectory(opened.directory);
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
    directory: OpenAttachmentDirectory;
    handle: FileHandle;
    serve: ServeKind;
    bytes: number;
  }> {
    assertHostAttachmentSession(session);
    if (!STORED_NAME.test(storedName)) {
      throw errno('NOT_FOUND', 'no such attachment');
    }

    const directory = await openAttachmentDirectory(session.workingDir, false)
      .catch(() => null);
    if (!directory) throw errno('NOT_FOUND', 'no such attachment');

    let handle: FileHandle | null = null;
    try {
      await this.testHooks?.afterDirectoryOpened?.(operation);
      handle = await fsp.open(
        path.join(fdAccessPath(directory.attachments), storedName),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw errno('NOT_FOUND', 'no such attachment');

      // Only the head is read, and only to classify: this decides a response
      // header, and reading a 20 MB file into memory to pick one is wasteful.
      const buffer = Buffer.alloc(Math.min(64, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

      // `resolve` returns a path to a host runtime, so it needs this additional
      // binding check. `download` returns the already-open handle and never
      // reopens by path.
      if (operation === 'resolve') await verifyVisibleDirectory(directory);

      return {
        directory,
        handle,
        bytes: stat.size,
        serve: serveKind(buffer.subarray(0, bytesRead), storedName),
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await closeAttachmentDirectory(directory);
      throw Object.assign(errno('NOT_FOUND', 'no such attachment'), { cause: error });
    }
  }
}

/** The one canonical browser URL for a stored attachment. */
export function attachmentUrlFor(sessionId: string, storedName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/${encodeURIComponent(storedName)}`;
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

async function usage(dir: FileHandle): Promise<{ files: number; bytes: number }> {
  const root = fdAccessPath(dir);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
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
  return { files, bytes };
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

interface OpenAttachmentDirectory {
  working: FileHandle;
  container: FileHandle;
  attachments: FileHandle;
  visibleDir: string;
}

/**
 * Open the whole directory chain one inode at a time.
 *
 * Node has no public openat(2), so `/proc/self/fd/<n>/child` is the Linux
 * equivalent: every next component is resolved beneath an already-open parent
 * inode. O_NOFOLLOW is then sufficient because each untrusted component is the
 * final component of its own open. On platforms without a usable fd namespace
 * this fails closed instead of falling back to a race-prone path walk.
 */
async function openAttachmentDirectory(
  workingDir: string,
  create: boolean,
): Promise<OpenAttachmentDirectory> {
  const resolvedWorkingDir = path.resolve(workingDir);
  if (resolvedWorkingDir === path.parse(resolvedWorkingDir).root) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'refusing an attachment directory at filesystem root');
  }

  const realWorkingDir = await fsp.realpath(resolvedWorkingDir).catch(() => '');
  if (!realWorkingDir) {
    throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment working directory does not exist');
  }
  let working: FileHandle | null = null;
  let container: FileHandle | null = null;
  let attachments: FileHandle | null = null;
  try {
    working = await openDirectory(realWorkingDir);
    const openedPath = await fsp.realpath(fdAccessPath(working)).catch(() => '');
    if (openedPath !== realWorkingDir) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'working directory changed while it was opened');
    }

    container = await openChildDirectory(working, ATTACHMENT_DIR, create);
    attachments = await openChildDirectory(container, ATTACHMENT_SUBDIR, create);
    return {
      working,
      container,
      attachments,
      visibleDir: path.join(realWorkingDir, ATTACHMENT_DIR, ATTACHMENT_SUBDIR),
    };
  } catch (error) {
    if (attachments) await attachments.close().catch(() => undefined);
    if (container) await container.close().catch(() => undefined);
    if (working) await working.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectory(target: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
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
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment path component is not a directory');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openChildDirectory(
  parent: FileHandle,
  name: string,
  create: boolean,
): Promise<FileHandle> {
  const target = path.join(fdAccessPath(parent), name);
  try {
    return await openDirectory(target);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fsp.mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return openDirectory(target);
}

function fdAccessPath(handle: FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  // Several BSDs expose the same stable directory-fd view here. If this host
  // does not, the next open fails and the operation remains fail-closed.
  return `/dev/fd/${handle.fd}`;
}

async function verifyVisibleDirectory(dir: OpenAttachmentDirectory): Promise<void> {
  let visible: FileHandle | null = null;
  try {
    visible = await openDirectory(dir.visibleDir);
    const [boundStat, visibleStat] = await Promise.all([
      dir.attachments.stat(),
      visible.stat(),
    ]);
    if (boundStat.dev !== visibleStat.dev || boundStat.ino !== visibleStat.ino) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory changed during the operation');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'UNSAFE_ATTACHMENT_DIR') throw error;
    throw Object.assign(
      errno('UNSAFE_ATTACHMENT_DIR', 'attachment directory changed during the operation'),
      { cause: error },
    );
  } finally {
    await visible?.close().catch(() => undefined);
  }
}

async function closeAttachmentDirectory(dir: OpenAttachmentDirectory): Promise<void> {
  await dir.attachments.close().catch(() => undefined);
  await dir.container.close().catch(() => undefined);
  await dir.working.close().catch(() => undefined);
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
