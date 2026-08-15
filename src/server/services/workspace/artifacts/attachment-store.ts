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
export {
  ATTACHMENT_DIR,
  ATTACHMENT_SUBDIR,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_MAX_ATTACHMENTS,
  attachmentUrlFor,
  displayMime,
  safeName,
  serveKind,
  storedAttachmentNameFromUrl,
} from './attachment-store/names.js';
export { resolveAttachmentDirectoryBackend } from './attachment-store/resolver.js';
export { AttachmentStore } from './attachment-store/store.js';
export type {
  AttachmentDeleteOptions,
  AttachmentDirectoryBackend,
  AttachmentInput,
  AttachmentSessionRef,
  AttachmentStoreLike,
  AttachmentStoreOptions,
  ServeKind,
  StoredAttachment,
} from './attachment-store/types.js';
