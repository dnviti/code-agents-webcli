import { ChatAttachment, ChatDraft } from '../../shared/chat-events.js';
import { storedAttachmentNameFromUrl } from '../services/workspace/artifacts/attachment-store.js';
import { SessionRecord } from '../types.js';

/**
 * The unsent composer, shared between a person's screens.
 *
 * A conversation is one thing; the browsers looking at it are several. Every
 * other fact about a session already reaches all of them — the transcript, the
 * queue, the model, whether it is working — and the one that did not was the
 * sentence being typed into it. Start a prompt on a laptop, pick up a phone, and
 * the phone offered an empty box (#163).
 *
 * This is the server's copy of that box: the text, the files already uploaded to
 * it, and a revision so a client can tell an arriving draft that is newer than
 * what it holds from an echo of what it just sent. Everything here is
 * deliberately small and dumb — last write wins, no merging, no character-level
 * anything. Two people typing into one composer at the same instant is not a
 * case this is trying to be clever about; two screens belonging to *one* person,
 * only one of which is being typed into, is the case it exists for, and there
 * the last write is simply the write.
 */

/**
 * How much typing is carried between screens.
 *
 * Not a limit on what can be typed or sent — the composer is untouched by this
 * and a turn of any size still goes. It is the point past which a draft stops
 * being a draft: 64 kB is about ten thousand words, and a socket frame of that
 * size every time somebody pauses is a cost paid by every screen on the account.
 * Past it the text simply stops being announced, so the screen holding it keeps
 * working exactly as it did before any of this existed.
 */
export const MAX_DRAFT_TEXT_BYTES = 64 * 1024;

/**
 * How many attachments ride along.
 *
 * Well above any real composer — the point is that a hand-written socket frame
 * cannot make the server hold an unbounded list, not to tell anyone how many
 * files they may attach.
 */
export const MAX_DRAFT_ATTACHMENTS = 64;

/**
 * How long any one string on an attachment may be.
 *
 * The count above bounds the list and the cap above bounds the prose, and
 * between them they still left a frame free to carry sixty-four names of a
 * megabyte each — which the server would then hold for as long as the session
 * lived. A stored name is capped at 120 characters where it is written
 * (attachment-store.ts), so this is generous by an order of magnitude and refuses
 * only what could not have come from an upload.
 */
const MAX_ATTACHMENT_FIELD = 4096;

/** What a client sent up, once it has been read rather than trusted. */
export interface DraftInput {
  text: string;
  attachments: ChatAttachment[];
}

/**
 * Read an attachment off the wire, field by field.
 *
 * Never a cast. What arrives here is broadcast to the account's other screens
 * and then travels back as part of a turn, where `path` is handed to a runtime
 * as a file to read — so the shape has to be the shape, and the extra keys a
 * hand-made frame might carry have no business surviving the trip. This is not a
 * privilege boundary (a socket that can write a draft can already send a turn,
 * and both are the owner's own), it is the difference between a list of
 * attachments and a list of whatever.
 */
function readAttachment(raw: unknown, sessionId: string): ChatAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const url = text(value.url);
  const name = text(value.name);
  if (!url || !name) return null;
  // This conversation's exact upload URL and one canonical stored-name segment,
  // not merely a matching prefix. The store will resolve that identity again
  // before a turn reaches a runtime.
  if (!storedAttachmentNameFromUrl(url, sessionId)) return null;
  return {
    url,
    name,
    mime: text(value.mime) || 'application/octet-stream',
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : 0,
  };
}

/** A string field of an attachment, or '' for anything that is not one. */
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_ATTACHMENT_FIELD ? '' : value;
}

/**
 * Read a whole draft off the wire, or refuse it.
 *
 * Null means "this is not a draft and nothing should happen", which is a
 * different outcome from an empty draft: an empty draft is a real thing to say —
 * it is what a screen says when the composer has just been cleared — and it must
 * still be announced, or a message sent on one device would leave the text
 * standing on every other.
 */
export function readDraft(
  text: unknown,
  attachments: unknown,
  sessionId: string,
): DraftInput | null {
  if (typeof text !== 'string') return null;
  // Bytes, not characters. A draft of emoji is three or four times the length
  // its `.length` reports, and the cost this guards is what goes over the wire.
  if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_TEXT_BYTES) return null;

  const read = readAttachments(attachments, sessionId);
  if (!read) return null;

  return { text, attachments: read };
}

/**
 * Sanitize attachments on both draft and send frames.
 *
 * Most importantly, `path` never survives this boundary. A path is derived
 * server-side from the owned URL immediately before the turn is sent; accepting
 * the browser's copy would let a forged `/etc/passwd` reach an adapter.
 */
export function readAttachments(
  attachments: unknown,
  sessionId: string,
): ChatAttachment[] | null {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length > MAX_DRAFT_ATTACHMENTS) return null;

  const read: ChatAttachment[] = [];
  for (const item of list) {
    const attachment = readAttachment(item, sessionId);
    if (attachment) read.push(attachment);
  }
  return read;
}

/** What this conversation's composer holds, or null if nothing has been typed. */
export function draftOf(session: SessionRecord): ChatDraft | null {
  return session.chatDraft ?? null;
}

/**
 * Record a new draft against the session and hand back what to announce.
 *
 * The revision is the session's own count and is never taken from the client:
 * two screens each keeping their own numbering would collide on the first
 * simultaneous edit, and the whole use of the number is to be an order that both
 * of them agree on.
 */
export function applyDraft(session: SessionRecord, input: DraftInput): ChatDraft {
  const draft: ChatDraft = {
    text: input.text,
    attachments: input.attachments,
    revision: (session.chatDraft?.revision ?? 0) + 1,
  };
  session.chatDraft = draft;
  return draft;
}

/**
 * Empty the composer — the turn it held has been sent.
 *
 * Returns the announcement, or null when there was nothing in it to clear. The
 * null case is what keeps a conversation that is only ever typed into on one
 * screen from broadcasting an empty draft after every single turn.
 *
 * The revision still advances, because "now empty" is a newer fact than the text
 * it replaces and every screen has to be able to see that it is.
 */
export function clearDraft(session: SessionRecord): ChatDraft | null {
  const held = session.chatDraft;
  if (!held) return null;
  if (!held.text && held.attachments.length === 0) return null;
  const draft: ChatDraft = { text: '', attachments: [], revision: held.revision + 1 };
  session.chatDraft = draft;
  return draft;
}
