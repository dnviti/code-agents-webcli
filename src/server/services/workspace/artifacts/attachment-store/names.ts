import { sniffImageType, type ImageKind } from '../paste-store.js';

import type { ServeKind } from './types.js';

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
export const STORED_NAME = /^[0-9a-f]{12}-[A-Za-z0-9._-]{1,120}$/;

/** A media type shaped like one. Not a claim that it is accurate — see above. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;

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
