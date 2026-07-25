import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
}

export class AttachmentStore implements AttachmentStoreLike {
  private readonly maxBytes: number;
  private readonly quotaBytes: number;
  private readonly maxFiles: number;
  private readonly randomId: () => string;

  constructor(options: AttachmentStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_ATTACHMENT_QUOTA_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_ATTACHMENTS;
    this.randomId = options.randomId ?? (() => randomBytes(6).toString('hex'));
  }

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    if (!input.bytes || input.bytes.length === 0) {
      throw errno('EMPTY_BODY', 'the upload had no body');
    }
    if (input.bytes.length > this.maxBytes) {
      throw errno('FILE_TOO_LARGE', `over the ${this.maxBytes} byte limit`);
    }

    const dir = attachmentDir(session.workingDir);
    await fsp.mkdir(dir, { recursive: true });

    // Counted before the write, not after: a quota checked afterwards is a
    // quota that has already been exceeded.
    const { files, bytes } = await usage(dir);
    if (files >= this.maxFiles) {
      throw errno('QUOTA_EXCEEDED', `this session already holds ${files} attachments`);
    }
    if (bytes + input.bytes.length > this.quotaBytes) {
      throw errno('QUOTA_EXCEEDED', 'this session is at its attachment quota');
    }

    const safe = safeName(input.filename);
    const storedName = `${this.randomId()}-${safe}`;
    const absolutePath = path.join(dir, storedName);

    // `wx` rather than `w`: the random prefix makes a collision improbable
    // rather than impossible, and overwriting somebody's earlier attachment on
    // the unlucky draw is not a failure mode worth allowing.
    const handle = await fsp.open(absolutePath, 'wx', 0o600);
    try {
      await handle.writeFile(input.bytes);
    } finally {
      await handle.close();
    }

    return {
      name: safe,
      storedName,
      absolutePath,
      relativePath: path.join(ATTACHMENT_DIR, ATTACHMENT_SUBDIR, storedName),
      mime: displayMime(input.bytes, input.declaredMime),
      bytes: input.bytes.length,
    };
  }

  async resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    if (!STORED_NAME.test(storedName)) {
      throw errno('NOT_FOUND', 'no such attachment');
    }

    const absolutePath = path.join(attachmentDir(session.workingDir), storedName);
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw errno('NOT_FOUND', 'no such attachment');
    }

    // Only the head is read, and only to classify: this decides a response
    // header, and reading a 20 MB file into memory to pick one is wasteful.
    const handle = await fsp.open(absolutePath, 'r');
    let head: Buffer;
    try {
      const buffer = Buffer.alloc(Math.min(64, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    return { absolutePath, bytes: stat.size, serve: serveKind(head, storedName) };
  }
}

export function attachmentDir(workingDir: string): string {
  return path.join(path.resolve(workingDir), ATTACHMENT_DIR, ATTACHMENT_SUBDIR);
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

async function usage(dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
    if (stat) bytes += stat.size;
  }
  return { files, bytes };
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
