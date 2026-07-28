import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';
import {
  ChatEvent,
  ChatSnapshot,
  ChatTurnIndexEntry,
  ChatUsage,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { applyChatEvent, createTranscript, foldSessionUsage } from '../../shared/chat-reducer.js';
import { TurnOutcome, turnOutcomeOf } from '../../shared/turn-outcome.js';
import { TurnBoundary, openTurnAfter, openTurnBefore } from '../../shared/turn-boundaries.js';

/**
 * Append-only store of a chat session's normalized event log.
 *
 * The sibling of history-store.ts, solving the same problem for the second
 * data path: a PTY session persists ANSI lines, a chat session persists
 * ChatEvents, and both need "give me from N" to be a positioned read rather
 * than a scan so a browser can rejoin a long-running session without paying
 * for its whole past.
 *
 * Two files per session:
 *   `<id>.jsonl` — one ChatEvent per line, in seq order.
 *   `<id>.idx`   — a fixed-width index: a header plus one uint32 byte offset
 *                  per retained event.
 *
 * Unlike history-store's line numbers, `seq` is not this store's own counter —
 * it already lives inside every event, stamped by the session before append()
 * is ever called (see chat-events.ts). This store trusts that numbering and
 * only enforces that it stays contiguous, because the position math ("event
 * seq N is index entry N - firstSeq") depends on it never having gaps.
 *
 * Event seq numbers are absolute and never reused. Trimming the oldest events
 * moves `firstSeq` forward; it never renumbers what is left, so a client
 * holding a seq can always tell whether it fell off the back.
 */

const MAGIC = 0x43414348; // "CACH" - distinct from history-store's "CAWH" so the two
// index formats can never be cross-read by mistake if a path is ever confused.
const FORMAT_VERSION = 2;
// Version 2 widened the header by one 64-bit field: how many turns the log has
// dropped, which is the only thing a trimmed conversation cannot work out for
// itself. An index written by version 1 fails the check and is rebuilt from the
// log, which is a path this file already has and already exercises.
const HEADER_BYTES = 24;
const ENTRY_BYTES = 4;

/** uint32 offsets cap the log; trimming keeps it far below this. */
const MAX_LOG_BYTES = 0xffffffff;

/** Copy buffer used when trimming, so a rewrite never scales with the log. */
const TRIM_CHUNK_BYTES = 1024 * 1024;

/** Same character class history-store enforces, plus the same two named exceptions. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * How a conversation's opening is read: in chunks, up to a ceiling.
 *
 * The two facts wanted are at very different depths. The runtime's session id
 * is in the first event; the first thing the *user* said can be a long way
 * down, because some runtimes open by announcing everything they can do — Oh
 * My Pi's first event is 48 kB of command list, and a `capabilities` event
 * after it another 44 kB, which puts the opening message past 90 kB in a
 * perfectly ordinary conversation. A single small read found the id and
 * silently missed the message, and the list then had nothing to label a
 * conversation with but its timestamp.
 *
 * So: read a chunk at a time and stop the moment both are found, which for
 * most logs is the first one. The ceiling is what keeps a pathological file
 * from being read in full to answer a question about its first line.
 */
const HEAD_SCAN_CHUNK = 64 * 1024;
const HEAD_SCAN_LIMIT = 1024 * 1024;

/**
 * Events that belong to one message, and are meaningless without the
 * `msg_start` that opened it. Everything not listed here describes the session
 * rather than a message, and is replayed however far back it was emitted.
 */
const MESSAGE_SCOPED: ReadonlySet<string> = new Set([
  'msg_start',
  'block_start',
  'block_delta',
  'block_end',
  'msg_end',
]);

export interface ChatStoreOptions {
  storageDir: string;
  /** Retained events per session before the oldest are dropped. */
  maxEvents?: number;
  /** How many events to drop at once, so trimming is amortised. */
  trimChunkEvents?: number;
  /** Upper bound on events served in one read(). */
  maxPageEvents?: number;
  /** Chunk size used while walking back for a message boundary. */
  snapshotReplayEvents?: number;
  /** Messages a freshly opened conversation shows before it has to page. */
  snapshotMinMessages?: number;
  /** Hard cap on how far back the boundary search will read. */
  snapshotMaxScanEvents?: number;
}

export interface ChatStats {
  /** Lowest seq still on disk. */
  firstSeq: number;
  /**
   * Highest seq written. Mirrors chat-reducer's TranscriptState.cursor: 0
   * means nothing has been applied (or, here, written) yet.
   */
  cursor: number;
}

export interface ChatPage extends ChatStats {
  events: ChatEvent[];
  /**
   * The turn open where this page starts, or null when it starts between two.
   *
   * A page is a slice out of the middle of the log and the client replays it
   * through the reducer, which has no way to know what was open before the
   * first event it is handed. Without this, every page that begins inside a
   * turn files its messages under the runtime's own id for that turn — a row
   * in the index with no prompt to name it by, and no match against the
   * recorded turn it is half of.
   */
  openTurnId?: string | null;
  /**
   * Lowest seq this page covers, after clamping the request to what is on
   * disk. The client folds it into its own paging floor; without it a client
   * cannot tell a page that reached the head of the log from one that did not,
   * and keeps asking for the same range.
   */
  from: number;
}

/**
 * One turn as the log has it. The wire shape, so the server cannot describe a
 * turn one way and the browser read it another.
 */
export type PersistedTurn = ChatTurnIndexEntry;

export interface ChatTurnIndex {
  turns: PersistedTurn[];
  /** Lowest seq still on disk, so a caller can explain a list that starts late. */
  firstSeq: number;
  /** False when the head of the log has been trimmed and turns are missing. */
  complete: boolean;
}

export interface ChatSnapshotOptions {
  /** The log never names its own runtime; the caller supplies it. */
  runtime?: string;
  /** Whether the adapter process is alive right now - a live-process fact the log can't know. */
  live?: boolean;
  bypassPermissions?: boolean;
}

export type ChatSessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'>;

/** What a conversation can be listed and resumed by, read from its first lines. */
export interface ChatDescription {
  /** The runtime's own id, or null when it never reported one. */
  nativeSessionId: string | null;
  /** How the conversation opened, so a list of them can be read. */
  firstMessage: string | null;
}

interface SessionState {
  firstSeq: number;
  count: number;
  logSize: number;
  /**
   * Turns that were trimmed off the head, so the ones left keep their numbers.
   *
   * Persisted in the index header because it is the one fact about a
   * conversation that its surviving log cannot reconstruct. Zero for a
   * conversation that has never been trimmed, and reset by a `/clear`, which
   * genuinely does start the numbering again.
   */
  turnsDropped: number;
  /**
   * What the whole conversation has spent, kept beside the log's geometry.
   *
   * Undefined means "not read yet", not "nothing": the first snapshot that
   * needs it scans the log once and every append after that folds itself in,
   * so a conversation costs one pass however many times it is rejoined.
   */
  usage?: ChatUsage;
  /** Highest seq already folded into `usage`. */
  usageSeq: number;
  /**
   * Every point at which the open turn changed, kept beside the log's geometry
   * for the same reason `usage` is: it is read from the whole log, and a
   * windowed read must not pay for that more than once per conversation.
   *
   * Undefined means "not read yet". A handful of rows per turn — it is the
   * turn boundaries, not the turns' contents.
   */
  turnBoundaries?: TurnBoundary[];
  /** Highest seq already folded into `turnBoundaries`. */
  turnBoundarySeq: number;
}

export interface ChatStoreLike {
  append(session: ChatSessionRef, events: ChatEvent[]): void;
  stat(session: ChatSessionRef): Promise<ChatStats>;
  read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage>;
  turnIndex(session: ChatSessionRef): Promise<ChatTurnIndex>;
  snapshot(session: ChatSessionRef, options?: ChatSnapshotOptions): Promise<ChatSnapshot>;
  /** Drop everything before `seq`, so a cleared conversation cannot be paged back into. */
  truncateBefore(session: ChatSessionRef, seq: number): Promise<void>;
  listSessions(ownerUserId: number): Promise<string[]>;
  deleteChat(session: ChatSessionRef): Promise<void>;
}

export class ChatStore implements ChatStoreLike {
  readonly storageDir: string;
  readonly maxEvents: number;
  readonly trimChunkEvents: number;
  readonly maxPageEvents: number;
  readonly snapshotReplayEvents: number;
  readonly snapshotMinMessages: number;
  readonly snapshotMaxScanEvents: number;

  private readonly states = new Map<string, SessionState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ChatStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.maxEvents = options.maxEvents ?? 50_000;
    this.trimChunkEvents = options.trimChunkEvents ?? 5_000;
    this.maxPageEvents = options.maxPageEvents ?? 500;
    this.snapshotReplayEvents = options.snapshotReplayEvents ?? 1_000;
    // Enough to fill a tall window and leave something to scroll, without
    // making a rejoin pay for a whole conversation.
    this.snapshotMinMessages = options.snapshotMinMessages ?? 40;
    this.snapshotMaxScanEvents = options.snapshotMaxScanEvents ?? 40_000;
  }

  /**
   * Build the on-disk path for a session, refusing anything that could escape
   * the storage directory.
   *
   * Session ids are server-generated UUIDs today, so nothing user-controlled
   * reaches here - but that is an invariant of the call sites, not of this
   * function. A future caller that passes an id straight from a request would
   * otherwise turn a path join into a write anywhere on disk.
   */
  private basePath(session: ChatSessionRef): string {
    const id = String(session.id);
    if (!SESSION_ID_PATTERN.test(id) || id === '.' || id === '..') {
      throw new Error(`Refusing unsafe session id for chat storage: ${JSON.stringify(id)}`);
    }

    if (!Number.isSafeInteger(session.ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for chat storage: ${session.ownerUserId}`);
    }

    return path.join(this.storageDir, String(session.ownerUserId), id);
  }

  /**
   * The runtime's own id for a conversation, read from the head of its log.
   *
   * Backfill for sessions recorded before the id was kept on the session row.
   * Bounded on purpose: a runtime names its conversation in the first thing it
   * says, so the answer is in the first few lines — and these logs reach tens
   * of megabytes, which is a size worth never reading to learn one field.
   *
   * Returns null for "not in the head", which the caller reads as "cannot be
   * resumed". That is the safe direction to be wrong in: it offers a fresh
   * start rather than a resume that would silently produce a stranger.
   */
  async nativeSessionId(session: ChatSessionRef): Promise<string | null> {
    return (await this.describe(session)).nativeSessionId;
  }

  /**
   * Enough about a conversation to list it: what it can be resumed as, and how
   * it opened.
   *
   * Both facts are in the first few lines, so one bounded read answers both.
   * The opening line is what makes a list of past conversations usable at all:
   * a column of "Session 25/07/2026, 21:35" tells a person nothing about which
   * one they were looking for, and the question they asked tells them
   * immediately.
   */
  async describe(session: ChatSessionRef): Promise<ChatDescription> {
    const found: ChatDescription = { nativeSessionId: null, firstMessage: null };
    const base = this.basePath(session);
    const handle = await fs.promises.open(`${base}.jsonl`, 'r').catch(() => null);
    if (!handle) return found;

    // The id of the message the *user* opened with, so a block belonging to the
    // agent's reply is never mistaken for the question.
    let firstUserMessage: string | null = null;
    let remainder = '';
    let offset = 0;

    const take = (line: string): void => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A line this cannot parse is not a reason to abandon the read.
        return;
      }

      if (event.t === 'session' && typeof event.nativeSessionId === 'string') {
        found.nativeSessionId ??= event.nativeSessionId;
      }
      if (event.t === 'msg_start' && event.role === 'user' && !firstUserMessage) {
        firstUserMessage = String(event.id || '');
      }
      if (
        event.t === 'block_start'
        && firstUserMessage
        && event.msgId === firstUserMessage
        && !found.firstMessage
      ) {
        const block = event.block as { kind?: string; text?: unknown } | undefined;
        if (block?.kind === 'text' && typeof block.text === 'string' && block.text.trim()) {
          found.firstMessage = block.text.trim().slice(0, 300);
        }
      }
    };

    try {
      const buffer = Buffer.alloc(HEAD_SCAN_CHUNK);
      while (offset < HEAD_SCAN_LIMIT && !(found.nativeSessionId && found.firstMessage)) {
        const { bytesRead } = await handle.read(buffer, 0, HEAD_SCAN_CHUNK, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;

        const lines = (remainder + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        // The last piece is whatever the chunk cut in half; it is carried into
        // the next read rather than parsed, because half an event is not one.
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          if (line) take(line);
          if (found.nativeSessionId && found.firstMessage) break;
        }
      }

      return found;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Serialise every operation per session: a reader must not see a half-written index. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async loadState(base: string): Promise<SessionState> {
    const cached = this.states.get(base);
    if (cached) {
      return cached;
    }

    // 1 rather than 0: chat-reducer treats cursor 0 as "nothing applied yet",
    // so an empty store reporting firstSeq 1 / cursor 0 reads the same way a
    // freshly created transcript does.
    const state: SessionState = {
      firstSeq: 1,
      count: 0,
      logSize: 0,
      turnsDropped: 0,
      usageSeq: 0,
      turnBoundarySeq: 0,
    };

    // Sized before the index is read, and unconditionally: it is what tells
    // repairIndex there is a log to rebuild from when the index cannot be
    // trusted. Reading it only inside the happy path is what made a bad index
    // hide the entire conversation instead of triggering a repair.
    const logStat = await fs.promises.stat(`${base}.jsonl`).catch(() => null);
    state.logSize = logStat ? logStat.size : 0;

    let usable = false;
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const handle = await fs.promises.open(`${base}.idx`, 'r');
      try {
        const { size } = await handle.stat();
        if (size >= HEADER_BYTES) {
          await handle.read(header, 0, HEADER_BYTES, 0);
          if (header.readUInt32BE(0) === MAGIC && header.readUInt16BE(4) === FORMAT_VERSION) {
            state.firstSeq = Number(header.readBigUInt64BE(8));
            state.turnsDropped = Number(header.readBigUInt64BE(16));
            state.count = Math.floor((size - HEADER_BYTES) / ENTRY_BYTES);
            usable = true;
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to read chat index ${base}.idx:`, error);
      }
    }

    if (!usable && state.logSize > 0) {
      // An index that does not start with our header cannot be read at all:
      // every offset lookup is measured from HEADER_BYTES, so a header-less
      // file silently returns the wrong records. The log is the durable
      // artefact and it is intact, so the index is thrown away and rebuilt
      // from it — which is also the recovery path for any session written by
      // the build that never wrote a header in the first place.
      console.warn(`Chat index ${base}.idx is unreadable; rebuilding it from the log.`);
      state.firstSeq = (await firstSeqInLog(base)) ?? 1;
      state.count = 0;
      // Rebuilt from a log whose head may be long gone: how many turns went
      // with it is not in the log, so the count starts again from what is left.
      // The numbers a rebuilt conversation shows are its own, and they are at
      // least self-consistent from here on.
      state.turnsDropped = 0;
      await fs.promises.writeFile(`${base}.idx`, headerBuffer(state.firstSeq, state.turnsDropped));
    }

    await this.repairIndex(base, state);
    this.states.set(base, state);
    return state;
  }

  /**
   * Reconcile the index with the log.
   *
   * appendNow() writes the log before the index (see below), so a crash
   * between those two writes leaves the log ahead of the index. Nothing
   * detects that at read time - the reader trusts the offsets - so the extra
   * events would be unreachable forever and, worse, the *next* append would
   * compute its offsets from a stale size and shadow them with misaligned
   * data.
   *
   * The scan starts at the last indexed record, so in the healthy case it
   * reads one line and stops.
   */
  private async repairIndex(base: string, state: SessionState): Promise<void> {
    if (state.logSize === 0) {
      if (state.count !== 0) {
        console.warn(`Chat index for ${base} describes events an empty log does not have; resetting.`);
        await fs.promises.writeFile(`${base}.idx`, headerBuffer(state.firstSeq)).catch(() => undefined);
        state.count = 0;
      }
      return;
    }

    let scanFrom = 0;
    if (state.count > 0) {
      const entry = Buffer.alloc(ENTRY_BYTES);
      const handle = await fs.promises.open(`${base}.idx`, 'r');
      try {
        await handle.read(entry, 0, ENTRY_BYTES, HEADER_BYTES + (state.count - 1) * ENTRY_BYTES);
      } finally {
        await handle.close();
      }
      scanFrom = entry.readUInt32LE(0);
    }

    if (scanFrom > state.logSize) {
      console.warn(`Chat index for ${base} points past the end of the log; keeping the log.`);
      return;
    }

    const tail = Buffer.alloc(state.logSize - scanFrom);
    if (tail.length > 0) {
      const handle = await fs.promises.open(`${base}.jsonl`, 'r');
      try {
        await handle.read(tail, 0, tail.length, scanFrom);
      } finally {
        await handle.close();
      }
    }

    const newlines: number[] = [];
    for (let index = 0; index < tail.length; index++) {
      if (tail[index] === 0x0a) {
        newlines.push(index);
      }
    }

    // A record with no terminator was torn mid-write: drop the partial bytes
    // rather than hand a caller a line that JSON.parse will choke on.
    const lastNewline = newlines.length > 0 ? newlines[newlines.length - 1] : -1;
    if (lastNewline < tail.length - 1) {
      const keep = scanFrom + lastNewline + 1;
      await fs.promises.truncate(`${base}.jsonl`, keep);
      state.logSize = keep;
    }

    // Every newline closes a record, so every newline but the last also starts
    // the next one. The first record in the scanned region is the one the index
    // already knows about - unless the index is empty, in which case none of
    // them are known.
    const starts = [scanFrom];
    for (let index = 0; index < newlines.length - 1; index++) {
      starts.push(scanFrom + newlines[index] + 1);
    }

    const alreadyIndexed = state.count > 0 ? 1 : 0;
    const recovered = starts.slice(alreadyIndexed, newlines.length);
    if (recovered.length === 0) {
      return;
    }

    const entries = Buffer.alloc(recovered.length * ENTRY_BYTES);
    recovered.forEach((offset, index) => entries.writeUInt32LE(offset, index * ENTRY_BYTES));
    await fs.promises.appendFile(`${base}.idx`, entries);
    state.count += recovered.length;
    console.warn(`Recovered ${recovered.length} unindexed chat event(s) for ${base}.`);
  }

  append(session: ChatSessionRef, events: ChatEvent[]): void {
    if (events.length === 0) {
      return;
    }

    // This runs on the event emission path and returns nothing, so it must
    // never throw: a rejected path or a full disk has to cost persistence,
    // not the live conversation the browser is watching.
    let base: string;
    try {
      base = this.basePath(session);
    } catch (error) {
      console.error('Refusing to store chat events:', error);
      return;
    }

    void this.enqueue(base, async () => {
      try {
        await this.appendNow(base, events);
      } catch (error) {
        console.error(`Failed to append chat events for session ${session.id}:`, error);
        // The write may have half-landed. Drop the cached state so the next
        // operation re-reads from disk and reconciles, instead of computing
        // new offsets from a size that never happened.
        this.states.delete(base);
      }
    });
  }

  private async appendNow(base: string, events: ChatEvent[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(base), { recursive: true });

    const state = await this.loadState(base);

    // "Is this log empty?" is a question about the log, not about whether this
    // process happens to have a cached state for it. It used to be the latter
    // — and `ChatSession.start()` calls `stat()` before the first append, so
    // the cache was *always* warm by then and the header was *never* written.
    // Every index this store had ever produced was therefore header-less, and
    // since every offset lookup is measured from HEADER_BYTES, rejoining a
    // conversation silently dropped its first few events and a restart lost
    // the whole thing.
    if (state.count === 0 && state.logSize === 0) {
      // The session assigns seq, not this store; a brand-new log adopts
      // wherever the caller started numbering rather than assuming 1, so the
      // store is never coupled to a convention that lives one layer up.
      state.firstSeq = events[0].seq;
      await fs.promises.writeFile(`${base}.idx`, headerBuffer(state.firstSeq));
      await fs.promises.writeFile(`${base}.jsonl`, '');
    }

    // seq is stamped by the caller, not assigned here, so a gap or reorder
    // means something upstream is broken. Writing it anyway would silently
    // desync the position math every positioned read after this depends on -
    // better to fail this batch and let it be retried than to corrupt paging
    // for everything already on disk.
    const expectedFirst = state.firstSeq + state.count;
    events.forEach((event, position) => {
      const expected = expectedFirst + position;
      if (event.seq !== expected) {
        throw new Error(
          `chat store: out-of-order append for ${base} - expected seq ${expected}, got ${event.seq}`,
        );
      }
    });

    const entries = Buffer.alloc(events.length * ENTRY_BYTES);
    const payload: string[] = [];
    let offset = state.logSize;

    for (let index = 0; index < events.length; index++) {
      entries.writeUInt32LE(offset, index * ENTRY_BYTES);
      const record = `${JSON.stringify(events[index])}\n`;
      payload.push(record);
      offset += Buffer.byteLength(record, 'utf8');
    }

    await fs.promises.appendFile(`${base}.jsonl`, payload.join(''), 'utf8');
    await fs.promises.appendFile(`${base}.idx`, entries);

    state.count += events.length;
    state.logSize = offset;

    // Kept current here so the running total never has to be re-scanned: the
    // events are already in hand, and the alternative is reading a
    // tens-of-megabytes log again on every rejoin. Only extended when it has
    // been read at all — before that there is nothing to keep current, and the
    // first snapshot that asks will scan.
    if (state.usage) {
      for (const event of events) {
        if (event.seq <= state.usageSeq) continue;
        state.usage = foldSessionUsage(state.usage, event);
        state.usageSeq = event.seq;
      }
    }

    // The turn boundaries the same way, and for the same reason: they are read
    // from the whole log, and a browser rejoining mid-turn asks for them on
    // every snapshot.
    const boundaries = state.turnBoundaries;
    if (boundaries) {
      let open = boundaries.length > 0 ? boundaries[boundaries.length - 1].turnId : null;
      // The last turn the conversation had, which is where an agent speaking
      // again with nothing asked of it goes back to.
      let previous: string | null = null;
      for (let i = boundaries.length - 1; i >= 0; i--) {
        if (boundaries[i].turnId !== null) {
          previous = boundaries[i].turnId;
          break;
        }
      }
      for (const event of events) {
        if (event.seq <= state.turnBoundarySeq) continue;
        const next = openTurnAfter(event, open, previous);
        if (next !== open) {
          boundaries.push({ seq: event.seq, turnId: next });
          open = next;
        }
        // See `turnBoundaries`: a `/clear` leaves nothing to carry on from.
        previous = event.t === 'marker' && event.kind === 'cleared' ? null : next ?? previous;
        state.turnBoundarySeq = event.seq;
      }
    }

    if (state.count > this.maxEvents || state.logSize > MAX_LOG_BYTES / 2) {
      await this.trimHead(base, state);
    }
  }

  /** Drop the oldest `trimChunkEvents` events, once the log is over its cap. */
  private async trimHead(base: string, state: SessionState): Promise<void> {
    await this.dropOldest(base, state, this.trimChunkEvents);
  }

  /**
   * Everything before `seq` is gone: the log now begins there.
   *
   * What `/clear` means on disk. Emptying the window was never enough — the
   * events were still on the log, so a reload replayed the tail from before
   * the clear and the conversation the user had just ended came back, one
   * scrolled page at a time. Nothing downstream needed teaching about the
   * boundary, because everything downstream — the replay, the pages, the turn
   * index, the conversation's own description — is read from the log, and the
   * head is no longer there to be read.
   *
   * Irreversible, deliberately: "start a new conversation" is a promise about
   * what is left behind, not a view over it. What each turn cost is recorded
   * separately, in the usage store, and is not touched here.
   */
  async truncateBefore(session: ChatSessionRef, seq: number): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      const state = await this.loadState(base);
      await this.dropOldest(base, state, seq - state.firstSeq);
    });
  }

  /**
   * Drop the oldest `count` events by rewriting both files.
   *
   * The surviving log is copied in fixed-size chunks rather than read into one
   * buffer: at the retention cap that buffer would be tens of megabytes, so a
   * routine trim would spike memory by more than the whole rest of the server
   * uses. Both files are replaced via rename, so a crash mid-trim leaves the
   * previous consistent pair in place.
   */
  private async dropOldest(base: string, state: SessionState, count: number): Promise<void> {
    const drop = Math.min(count, state.count);
    if (drop <= 0) {
      return;
    }

    // Counted before the log loses them, because afterwards nothing can. A turn
    // is numbered by how many came before it in the conversation, and reading
    // that off the position of a row in what survives renumbers every trimmed
    // conversation from 1 — so the index, the header's count and the spend
    // record disagree about the same turn (#86).
    const dropped = state.turnsDropped + (await this.turnsBelow(base, state, state.firstSeq + drop));

    const idxHandle = await fs.promises.open(`${base}.idx`, 'r');
    let cutOffset = 0;
    let remaining: Buffer;
    try {
      const cut = Buffer.alloc(ENTRY_BYTES);
      await idxHandle.read(cut, 0, ENTRY_BYTES, HEADER_BYTES + drop * ENTRY_BYTES);
      cutOffset = cut.readUInt32LE(0);

      const remainingCount = state.count - drop;
      remaining = Buffer.alloc(remainingCount * ENTRY_BYTES);
      if (remainingCount > 0) {
        await idxHandle.read(remaining, 0, remaining.length, HEADER_BYTES + drop * ENTRY_BYTES);
      }
    } finally {
      await idxHandle.close();
    }

    for (let index = 0; index < remaining.length; index += ENTRY_BYTES) {
      remaining.writeUInt32LE(remaining.readUInt32LE(index) - cutOffset, index);
    }

    const keptBytes = Math.max(0, state.logSize - cutOffset);
    await this.copyLogTail(base, cutOffset, keptBytes);

    await fs.promises.writeFile(
      `${base}.idx.tmp`,
      Buffer.concat([headerBuffer(state.firstSeq + drop, dropped), remaining]),
    );
    await fs.promises.rename(`${base}.jsonl.tmp`, `${base}.jsonl`);
    await fs.promises.rename(`${base}.idx.tmp`, `${base}.idx`);

    state.firstSeq += drop;
    state.count -= drop;
    state.turnsDropped = dropped;
    state.logSize = keptBytes;
  }

  /**
   * How many turns opened below `seq`.
   *
   * The boundaries are already tracked for the turn index, so this is a read of
   * something the store knows rather than another pass over the log — and it is
   * only ever asked at a trim, which is rare and already rewriting two files.
   * A boundary with no turn id is the gap between two turns, not a turn.
   */
  private async turnsBelow(base: string, state: SessionState, seq: number): Promise<number> {
    const stats: ChatStats = {
      firstSeq: state.firstSeq,
      cursor: state.count > 0 ? state.firstSeq + state.count - 1 : 0,
    };
    const boundaries = await this.turnBoundaries(base, state, stats);
    return boundaries.filter((boundary) => boundary.seq < seq && boundary.turnId !== null).length;
  }

  private async copyLogTail(base: string, from: number, length: number): Promise<void> {
    const source = await fs.promises.open(`${base}.jsonl`, 'r');
    const target = await fs.promises.open(`${base}.jsonl.tmp`, 'w');
    try {
      const chunk = Buffer.alloc(Math.min(length, TRIM_CHUNK_BYTES) || 1);
      let copied = 0;
      while (copied < length) {
        const want = Math.min(chunk.length, length - copied);
        const { bytesRead } = await source.read(chunk, 0, want, from + copied);
        if (bytesRead <= 0) {
          break;
        }
        await target.write(chunk, 0, bytesRead);
        copied += bytesRead;
      }
    } finally {
      await source.close();
      await target.close();
    }
  }

  private statsOf(state: SessionState): ChatStats {
    return {
      firstSeq: state.firstSeq,
      cursor: state.count > 0 ? state.firstSeq + state.count - 1 : state.firstSeq - 1,
    };
  }

  async stat(session: ChatSessionRef): Promise<ChatStats> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => this.statsOf(await this.loadState(base)));
  }

  /**
   * Every turn of a conversation, from the first one still on disk.
   *
   * The index beside a conversation used to be built from whatever the browser
   * was holding, so a long conversation's index quietly started part way
   * through — the very case where an index is the only practical way to
   * navigate (#86). It is a property of the recorded conversation, so it is read
   * from the recorded conversation.
   *
   * A full scan of the log, deliberately: the whole point is that it does not
   * stop at a window. It is cheap because it reads one field per line and keeps
   * one small row per turn, and it is asked for once when a conversation is
   * opened rather than as anybody scrolls.
   *
   * "From the first one still on disk" is the one limit worth stating plainly:
   * the head of a very long log is trimmed, and turns that were trimmed away
   * cannot be listed. `firstSeq` is returned so a caller can say so rather than
   * present a partial list as a whole one.
   */
  async turnIndex(session: ChatSessionRef): Promise<ChatTurnIndex> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats = this.statsOf(state);
      const turns: PersistedTurn[] = [];
      let openTurnId: string | null = null;

      // The same grouping rule the browser applies to the messages it holds:
      // consecutive events sharing a turn id are one turn, and a turn id that
      // comes back after another has intervened is a second one. Two
      // implementations of that rule would be two answers to "how many turns",
      // which is the disagreement this whole change removes.
      //
      // Against the last turn in the list rather than against the one currently
      // open, because those differ in the case this exists for: an agent that
      // picks its own work back up after ending a turn — a background job it
      // was waiting on finishing — has no turn open and is still in the turn it
      // was working on. Comparing against `openTurnId` alone filed that as a
      // second row carrying the same id.
      const openTurn = (turnId: string, ts: number, id: string): PersistedTurn => {
        const current = turns[turns.length - 1];
        if (current && current.turnId === turnId) {
          openTurnId = turnId;
          return current;
        }
        const turn: PersistedTurn = {
          id,
          turnId,
          index: numberFrom + turns.length + 1,
          label: null,
          startedAt: ts,
          outcome: null,
        };
        turns.push(turn);
        openTurnId = turnId;
        return turn;
      };

      let pending: { turn: PersistedTurn; msgId: string } | null = null;
      // Set once a `/clear` has cut the log: what is left starts at turn 1 by
      // construction, so nothing is missing however far back the log was
      // trimmed.
      let cleared = false;
      // What a turn is numbered from. Trimming the head does not renumber what
      // is left; a `/clear` does, because it genuinely starts a conversation
      // over in the same tab and nothing above it is reachable any more.
      let numberFrom = state.turnsDropped;
      await this.scanLog(base, state, (event) => {
        switch (event.t) {
          case 'msg_start': {
            // Everything said while a turn is open belongs to it, whatever id
            // it arrived with — the reducer's rule, word for word, because a
            // second reading of it is a second answer.
            //
            // Applied here rather than only in the browser, the alignment
            // reaches every conversation already on disk: the index is read
            // from the log each time it is asked for, so an old conversation is
            // re-read under the settled rule rather than left as it was filed.
            // Nothing has to be migrated, and nothing was recorded wrongly —
            // the events were always right, it was the reading of them that
            // split a request from its answer.
            const turnId = openTurnAfter(
              event,
              openTurnId,
              turns[turns.length - 1]?.turnId,
            ) as string;
            const turn = openTurn(turnId, event.ts, event.id);
            // Only the user's own words may name a turn, and only the first of
            // them. Anything else is the model titling the reader's question
            // for them — see `labelFor` on the browser's side.
            if (event.role === 'user' && turn.label === null) {
              pending = { turn, msgId: event.id };
            }
            return;
          }
          case 'block_start': {
            if (!pending || pending.msgId !== event.msgId) return;
            if (event.block.kind !== 'text') return;
            const line = event.block.text.trim().split('\n')[0].trim();
            if (!line) return;
            pending.turn.label = line;
            pending = null;
            return;
          }
          case 'marker': {
            // `/clear` starts a new conversation in the same tab, and the log
            // is append-only — everything before this belongs to the one the
            // user left. The transcript stops paging back here, so the index
            // has to start again here too, or it would list forty turns a
            // browser can never be shown (#86, #43).
            if (event.kind === 'cleared') {
              turns.length = 0;
              openTurnId = null;
              pending = null;
              cleared = true;
              numberFrom = 0;
            }
            return;
          }
          case 'state': {
            // A runtime that died did not end its turn and nothing else will,
            // so whatever comes next is a new one. Again the reducer's rule: a
            // turn left open here would swallow the first thing the user typed
            // after the crash.
            openTurnId = openTurnAfter(event, openTurnId);
            return;
          }
          case 'turn_end': {
            // Against whatever is open, not against the event's own id: a
            // runtime ends the turn under its own name for it, which is never
            // the name this app opened it by.
            // The runtime letting go of work that was interrupted to redirect
            // it ends nothing: the turn is running again, on the correction.
            if (event.stale) return;
            const turn = openTurnId === null ? null : turns[turns.length - 1];
            if (turn) turn.outcome = turnOutcomeOf(event.stopReason);
            // Whatever comes next belongs to a turn that has not started yet —
            // unless it is the agent picking this same work back up, which is
            // not something anybody asked for and so not a turn. See
            // `openTurnAfter`.
            openTurnId = null;
            return;
          }
          default:
            return;
        }
      });

      return { turns, firstSeq: stats.firstSeq, complete: cleared || stats.firstSeq <= 1 };
    });
  }

  /**
   * Walk every event in the log, oldest first, one line at a time.
   *
   * Streamed rather than read whole: a long conversation's log is tens of
   * megabytes, and the caller here keeps one small row per turn out of it. The
   * point of this method is that it never holds the log in memory.
   */
  private async scanLog(
    base: string,
    state: SessionState,
    visit: (event: ChatEvent) => void,
  ): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(`${base}.jsonl`, 'r');
    } catch {
      // No log is an empty conversation, not a failure.
      return;
    }
    try {
      const CHUNK = 1 << 16;
      const buffer = Buffer.alloc(CHUNK);
      let carry = '';
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const lines = (carry + buffer.toString('utf8', 0, bytesRead)).split('\n');
        // The last piece is whatever fell across the chunk boundary; it is only
        // a whole line once the next read confirms it, or once the file ends.
        carry = lines.pop() ?? '';
        for (const line of lines) visitLine(line, visit);
        if (position >= state.logSize) break;
      }
      if (carry) visitLine(carry, visit);
    } finally {
      await handle.close();
    }
  }

  async read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats = this.statsOf(state);

      const wanted = Math.max(0, Math.min(Math.floor(count) || 0, this.maxPageEvents));
      const start = Math.max(state.firstSeq, Math.floor(fromSeq) || 0);
      const end = Math.min(stats.cursor + 1, start + wanted);

      if (wanted === 0 || end <= start) {
        return { ...stats, events: [], from: start, openTurnId: null };
      }

      const events = await this.readSlice(base, state, start, end);
      const boundaries = await this.turnBoundaries(base, state, stats);
      return { ...stats, events, from: start, openTurnId: openTurnBefore(boundaries, start) };
    });
  }

  /**
   * Read the half-open seq range [start, end) as parsed events.
   *
   * One read for the offsets (including the following event's start, which is
   * where our slice ends), one read for the bytes - the same two-read shape
   * history-store uses, so paging cost stays independent of how far back the
   * request reaches.
   */
  private async readSlice(base: string, state: SessionState, start: number, end: number): Promise<ChatEvent[]> {
    const relStart = start - state.firstSeq;
    const relEnd = end - state.firstSeq;

    const spanEntries = relEnd - relStart + 1;
    const offsets = Buffer.alloc(spanEntries * ENTRY_BYTES);
    const idxHandle = await fs.promises.open(`${base}.idx`, 'r');
    let read = 0;
    try {
      const result = await idxHandle.read(
        offsets,
        0,
        offsets.length,
        HEADER_BYTES + relStart * ENTRY_BYTES,
      );
      read = result.bytesRead;
    } finally {
      await idxHandle.close();
    }

    const available = Math.floor(read / ENTRY_BYTES);
    if (available === 0) {
      return [];
    }

    const sliceStart = offsets.readUInt32LE(0);
    // The last requested event has no following entry when it is the newest
    // event in the log; its slice ends at end-of-file.
    const sliceEnd =
      available > relEnd - relStart
        ? offsets.readUInt32LE((relEnd - relStart) * ENTRY_BYTES)
        : state.logSize;

    const length = Math.max(0, Math.min(sliceEnd, state.logSize) - sliceStart);
    if (length === 0) {
      return [];
    }

    const buffer = Buffer.alloc(length);
    const logHandle = await fs.promises.open(`${base}.jsonl`, 'r');
    try {
      await logHandle.read(buffer, 0, length, sliceStart);
    } finally {
      await logHandle.close();
    }

    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // The slice always ends just past a terminating newline, so the split
    // leaves a trailing empty element that is not a real line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const events: ChatEvent[] = [];
    for (const line of lines.slice(0, end - start)) {
      try {
        events.push(JSON.parse(line) as ChatEvent);
      } catch (error) {
        // A single corrupted record must not take the rest of the page down
        // with it; skip it and keep serving what parses.
        console.error(`Skipping unparseable chat event in ${base}.jsonl:`, error);
      }
    }
    return events;
  }

  /**
   * The tail of a session, cut at a message boundary rather than an event count.
   *
   * A fixed event window is the obvious implementation and it is wrong for
   * exactly the sessions that need it most. Streaming turns emit an event per
   * token, so in a long conversation the last thousand events are routinely all
   * `block_delta`s belonging to one message whose `msg_start` fell outside the
   * window — and the reducer, correctly, has nowhere to put them. A 42,000-event
   * transcript opened completely blank.
   *
   * So the search walks backwards in chunks until it has seen enough *messages*,
   * and replays from the `msg_start` of the oldest one it wants. Bounded twice
   * over: it stops at the head of the log, and it stops after
   * `snapshotMaxScanEvents` however few messages it has found, so a pathological
   * log cannot turn opening a session into a full replay.
   */
  private async replayTail(
    base: string,
    state: SessionState,
    stats: ChatStats,
  ): Promise<{ from: number; events: ChatEvent[] }> {
    const floor = state.firstSeq;
    if (stats.cursor < floor) {
      return { from: floor, events: [] };
    }

    const chunkSize = Math.max(this.snapshotReplayEvents, 1);
    const chunks: ChatEvent[][] = [];
    let starts: number[] = [];
    let scanned = 0;
    let end = stats.cursor + 1;

    while (end > floor && scanned < this.snapshotMaxScanEvents) {
      const start = Math.max(floor, end - chunkSize);
      const events = await this.readSlice(base, state, start, end);
      chunks.unshift(events);
      scanned += end - start;

      const found: number[] = [];
      for (const event of events) {
        if ((event as { t?: string }).t === 'msg_start') found.push(event.seq);
      }
      starts = found.concat(starts);

      end = start;
      if (starts.length >= this.snapshotMinMessages) break;
    }

    const all = chunks.flat();
    if (all.length === 0) {
      return { from: floor, events: [] };
    }

    // The whole log is in hand and it is shorter than the cap: replay all of
    // it, and say so, or the client would be told there is older history to
    // page for a conversation it already holds in full.
    const reachedHead = end <= floor;
    if (reachedHead && starts.length < this.snapshotMinMessages) {
      return { from: floor, events: all };
    }

    // No message boundary within reach — a single enormous message, or a log
    // of nothing but session-level events. Replaying what was read is still
    // better than nothing: it carries the state, plan and pending approvals.
    const from =
      starts.length > 0
        ? starts[Math.max(0, starts.length - this.snapshotMinMessages)]
        : all[0].seq;

    // Only *message* events are cut at the boundary. Everything else in the
    // scanned window is session-level — the capabilities a runtime reported,
    // the plan, the running usage, an unanswered approval — and it lives at
    // whatever seq it happened to be emitted at, which is routinely older than
    // the newest forty messages. Dropping those alongside the messages is how
    // a rejoin came back with no slash commands and a blank state.
    return {
      from,
      events: all.filter((event) => event.seq >= from || !MESSAGE_SCOPED.has(event.t)),
    };
  }

  /**
   * What the conversation has spent, over all of it.
   *
   * Read from the log for the same reason the turn index is (#86): it is a
   * property of the recorded conversation, so nothing that happens to be in a
   * browser's window may decide it. The full pass costs one streamed read of
   * the log, once per process per conversation — every append after it folds
   * itself in — against the alternative of a figure that silently shrinks.
   *
   * The one limit worth stating: a log whose head has been trimmed cannot
   * report what the trimmed turns cost. A total already in hand is kept across
   * a trim rather than recomputed, so that only shows up on a conversation
   * first opened after its own head was dropped.
   */
  private async sessionUsage(
    base: string,
    state: SessionState,
    stats: ChatStats,
  ): Promise<ChatUsage> {
    if (state.usage && state.usageSeq >= stats.cursor) return state.usage;

    let usage: ChatUsage = {};
    let seq = 0;
    await this.scanLog(base, state, (event) => {
      usage = foldSessionUsage(usage, event);
      if (event.seq > seq) seq = event.seq;
    });

    state.usage = usage;
    state.usageSeq = Math.max(seq, stats.cursor);
    return usage;
  }

  /**
   * Every point in the log at which the open turn changed.
   *
   * What a windowed read needs and cannot work out for itself: a snapshot
   * replays the tail and a page is a slice of the middle, so both routinely
   * start inside a turn whose opening message is nowhere in what they hold.
   * Replayed from a standing start, that turn's messages are filed under the
   * runtime's own name for it rather than the conversation's — an index row
   * reading "no prompt" beside a question that was asked, and one the recorded
   * index cannot be matched against to repair it.
   *
   * A full scan, cached exactly like `sessionUsage`: once per conversation per
   * process, with every append folding itself in. What it keeps is a few rows
   * per turn — where each one opened and where it closed — never the log.
   */
  private async turnBoundaries(
    base: string,
    state: SessionState,
    stats: ChatStats,
  ): Promise<TurnBoundary[]> {
    if (state.turnBoundaries && state.turnBoundarySeq >= stats.cursor) {
      return state.turnBoundaries;
    }

    const boundaries: TurnBoundary[] = [];
    let open: string | null = null;
    let previous: string | null = null;
    let seq = 0;
    await this.scanLog(base, state, (event) => {
      const next = openTurnAfter(event, open, previous);
      if (next !== open) {
        boundaries.push({ seq: event.seq, turnId: next });
        open = next;
      }
      // `/clear` is a new conversation in the same tab, so there is nothing
      // left to carry on from: the turns above it belong to the one the user
      // walked away from.
      previous = event.t === 'marker' && event.kind === 'cleared' ? null : next ?? previous;
      if (event.seq > seq) seq = event.seq;
    });

    state.turnBoundaries = boundaries;
    state.turnBoundarySeq = Math.max(seq, stats.cursor);
    return boundaries;
  }

  /**
   * Replay of a session, capped to its most recent messages.
   *
   * A month-long session must not cost a full replay on every browser join,
   * so this only walks the tail; a client that scrolls past what comes back
   * pages further with read(), independent of this cap. `firstSeq` on the
   * returned snapshot is still the full disk-retained range, not the replay
   * window - a client asking read() for anything back to there gets an
   * answer even though this snapshot didn't include it.
   */
  async snapshot(session: ChatSessionRef, options: ChatSnapshotOptions = {}): Promise<ChatSnapshot> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats = this.statsOf(state);

      const { from: windowStart, events } = await this.replayTail(base, state, stats);

      // Which turn is open is told to the replay rather than worked out by it.
      //
      // A tail cannot work it out. It routinely begins inside a turn whose
      // opening message the window cut, so replayed cold that turn's messages
      // are filed under the runtime's own id for it — a row in the index with
      // no prompt to name it by, and one the recorded index cannot be matched
      // against to repair. Nor is a single seed at the edge enough: the events
      // carried from before the window include a compaction or interruption
      // line, which *is* a message, and the turns opened between them were cut
      // away, so a fold across that stretch loses the thread again.
      //
      // The boundaries are the whole log's answer for every seq, so each event
      // is applied against the turn that was open when it happened, and the
      // replay lands exactly where a full one would.
      const boundaries = await this.turnBoundaries(base, state, stats);
      const transcript = createTranscript(NO_CHAT_CAPABILITIES);
      let at = 0;
      let open: string | null = null;
      for (const event of events) {
        while (at < boundaries.length && boundaries[at].seq < event.seq) {
          open = boundaries[at].turnId;
          at += 1;
        }
        transcript.currentTurnId = open;
        applyChatEvent(transcript, event);
      }

      return {
        sessionId: session.id,
        runtime: options.runtime ?? '',
        messages: transcript.messages,
        state: transcript.state,
        capabilities: transcript.capabilities,
        // From the whole conversation, not from the replayed tail. What a
        // session has spent is a property of the session, and the tail is a
        // window over its last forty messages: taking it from the transcript
        // meant a long chat's meter fell to whatever the window happened to
        // contain the moment the browser reconnected, switched tab or
        // reloaded — a total that only ever went *down* while the user was
        // still in the same conversation.
        usage: await this.sessionUsage(base, state, stats),
        plan: transcript.plan,
        pendingPermissions: transcript.pendingPermissions,
        firstSeq: stats.firstSeq,
        replayFrom: windowStart,
        cursor: stats.cursor,
        // Where the replay left off, so live events arriving after this join
        // continue the turn they belong to instead of opening one of their own
        // under the runtime's name for it.
        currentTurnId: transcript.currentTurnId,
        // Replayed out of the log along with everything else, so a rejoin knows
        // what the runtime said it was thinking at even when nobody ever chose
        // a level for this conversation.
        effort: transcript.effort,
        live: options.live ?? false,
        bypassPermissions: options.bypassPermissions ?? false,
      };
    });
  }

  /**
   * Session ids a user has a chat log for, most recently active first.
   *
   * Ordered by mtime rather than left to the caller to sort: a bounded
   * search or listing that has to truncate should favour what the user is
   * actually likely to be looking for.
   */
  async listSessions(ownerUserId: number): Promise<string[]> {
    if (!Number.isSafeInteger(ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for chat storage: ${ownerUserId}`);
    }

    const dir = path.join(this.storageDir, String(ownerUserId));
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const candidates = entries
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((id) => SESSION_ID_PATTERN.test(id) && id !== '.' && id !== '..');

    const withStats = await Promise.all(
      candidates.map(async (id) => {
        const stat = await fs.promises.stat(path.join(dir, `${id}.jsonl`)).catch(() => null);
        return { id, mtimeMs: stat?.mtimeMs ?? 0 };
      }),
    );

    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats.map((entry) => entry.id);
  }

  async deleteChat(session: ChatSessionRef): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      this.states.delete(base);
      await Promise.all(
        ['.jsonl', '.idx', '.jsonl.tmp', '.idx.tmp'].map((suffix) =>
          fs.promises.rm(`${base}${suffix}`, { force: true }).catch(() => undefined),
        ),
      );
    });
    this.queues.delete(base);
  }
}

/**
 * The seq of the first record in a log, so a rebuilt index can restore the
 * numbering the session actually used rather than assuming it started at 1.
 *
 * Reads a bounded prefix: the first line is all that is wanted, and a log whose
 * first record is enormous must not be pulled into memory to find its number.
 */
/**
 * Parse one log line and hand it on, skipping anything unreadable.
 *
 * A single corrupted record must not take a whole index down with it — the same
 * rule `readSlice` applies to a page, for the same reason.
 */
function visitLine(line: string, visit: (event: ChatEvent) => void): void {
  const text = line.trim();
  if (!text) return;
  try {
    visit(JSON.parse(text) as ChatEvent);
  } catch {
    // Deliberately silent: an index is asked for on every open, and one bad
    // line would otherwise log on every one of them forever.
  }
}

async function firstSeqInLog(base: string): Promise<number | null> {
  const buffer = Buffer.alloc(64 * 1024);
  let read = 0;
  try {
    const handle = await fs.promises.open(`${base}.jsonl`, 'r');
    try {
      ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, 0));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const text = buffer.subarray(0, read).toString('utf8');
  const newline = text.indexOf('\n');
  if (newline < 0) return null;

  try {
    const seq = (JSON.parse(text.slice(0, newline)) as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

function headerBuffer(firstSeq: number, turnsDropped = 0): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt16BE(FORMAT_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(firstSeq), 8);
  header.writeBigUInt64BE(BigInt(turnsDropped), 16);
  return header;
}

export default ChatStore;
