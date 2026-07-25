import { ChatEvent, ChatMessage, ChatRole, NO_CHAT_CAPABILITIES } from '../../shared/chat-events.js';
import { applyAll, createTranscript, messageText } from '../../shared/chat-reducer.js';
import { ChatPage, ChatSessionRef } from './store.js';

/**
 * Full-text search across one user's chat sessions.
 *
 * A scan, not an index: chat logs are already bounded per session (see
 * ChatStore's trimming), so walking every retained event is bounded work on
 * its own, and a real search index would be a second source of truth to keep
 * consistent with the log for a feature that a scan already answers
 * correctly. `listSessions` returns most-recently-active first, so a `limit`
 * that truncates the scan still favours what the user is likely looking for.
 */

export interface ChatSearchHit {
  sessionId: string;
  seq: number;
  role: ChatRole;
  snippet: string;
}

export interface ChatSearchOptions {
  /** Max hits returned across every session. */
  limit?: number;
  /** Max events replayed per session, so one huge log cannot starve the rest of the scan. */
  perSessionEventCap?: number;
  /** Characters of context kept on each side of a match. */
  snippetRadius?: number;
}

/** The slice of ChatStore this needs - kept narrow so a test double is trivial to write. */
export interface ChatSearchStore {
  listSessions(ownerUserId: number): Promise<string[]>;
  read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage>;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_PER_SESSION_CAP = 5_000;
const DEFAULT_SNIPPET_RADIUS = 60;
/** Page size used while paging a session for search; independent of the store's own cap. */
const PAGE_SIZE = 500;

export async function searchChatSessions(
  store: ChatSearchStore,
  ownerUserId: number,
  query: string,
  options: ChatSearchOptions = {},
): Promise<ChatSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const perSessionCap = options.perSessionEventCap ?? DEFAULT_PER_SESSION_CAP;
  const radius = options.snippetRadius ?? DEFAULT_SNIPPET_RADIUS;

  const hits: ChatSearchHit[] = [];
  const sessionIds = await store.listSessions(ownerUserId);

  for (const sessionId of sessionIds) {
    if (hits.length >= limit) {
      break;
    }

    const messages = await collectMessages(store, { id: sessionId, ownerUserId }, perSessionCap);
    for (const message of messages) {
      const text = messageText(message);
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) {
        continue;
      }

      hits.push({
        sessionId,
        seq: message.seq,
        role: message.role,
        snippet: buildSnippet(text, at, needle.length, radius),
      });
      if (hits.length >= limit) {
        break;
      }
    }
  }

  return hits;
}

/** Replay one session up to `cap` events, paging so a huge log is never loaded whole. */
async function collectMessages(
  store: ChatSearchStore,
  session: ChatSessionRef,
  cap: number,
): Promise<ChatMessage[]> {
  const transcript = createTranscript(NO_CHAT_CAPABILITIES);
  let fromSeq = 0;
  let scanned = 0;

  while (scanned < cap) {
    const page = await store.read(session, fromSeq, Math.min(PAGE_SIZE, cap - scanned));
    if (page.events.length === 0) {
      break;
    }

    applyAll(transcript, page.events);
    scanned += page.events.length;

    const last: ChatEvent = page.events[page.events.length - 1];
    if (last.seq >= page.cursor) {
      // Caught up to the end of what is stored; nothing more to page.
      break;
    }
    fromSeq = last.seq + 1;
  }

  return transcript.messages;
}

function buildSnippet(text: string, matchIndex: number, matchLength: number, radius: number): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${prefix}${slice}${suffix}`;
}
