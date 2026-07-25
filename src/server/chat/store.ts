import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';
import { ChatEvent, ChatSnapshot, NO_CHAT_CAPABILITIES } from '../../shared/chat-events.js';
import { applyAll, createTranscript } from '../../shared/chat-reducer.js';

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
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const ENTRY_BYTES = 4;

/** uint32 offsets cap the log; trimming keeps it far below this. */
const MAX_LOG_BYTES = 0xffffffff;

/** Copy buffer used when trimming, so a rewrite never scales with the log. */
const TRIM_CHUNK_BYTES = 1024 * 1024;

/** Same character class history-store enforces, plus the same two named exceptions. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ChatStoreOptions {
  storageDir: string;
  /** Retained events per session before the oldest are dropped. */
  maxEvents?: number;
  /** How many events to drop at once, so trimming is amortised. */
  trimChunkEvents?: number;
  /** Upper bound on events served in one read(). */
  maxPageEvents?: number;
  /** How far back snapshot() replays before leaving the rest to paging. */
  snapshotReplayEvents?: number;
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
}

export interface ChatSnapshotOptions {
  /** The log never names its own runtime; the caller supplies it. */
  runtime?: string;
  /** Whether the adapter process is alive right now - a live-process fact the log can't know. */
  live?: boolean;
  bypassPermissions?: boolean;
}

export type ChatSessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'>;

interface SessionState {
  firstSeq: number;
  count: number;
  logSize: number;
}

export interface ChatStoreLike {
  append(session: ChatSessionRef, events: ChatEvent[]): void;
  stat(session: ChatSessionRef): Promise<ChatStats>;
  read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage>;
  snapshot(session: ChatSessionRef, options?: ChatSnapshotOptions): Promise<ChatSnapshot>;
  listSessions(ownerUserId: number): Promise<string[]>;
  deleteChat(session: ChatSessionRef): Promise<void>;
}

export class ChatStore implements ChatStoreLike {
  readonly storageDir: string;
  readonly maxEvents: number;
  readonly trimChunkEvents: number;
  readonly maxPageEvents: number;
  readonly snapshotReplayEvents: number;

  private readonly states = new Map<string, SessionState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ChatStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.maxEvents = options.maxEvents ?? 50_000;
    this.trimChunkEvents = options.trimChunkEvents ?? 5_000;
    this.maxPageEvents = options.maxPageEvents ?? 500;
    this.snapshotReplayEvents = options.snapshotReplayEvents ?? 1_000;
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
    let state: SessionState = { firstSeq: 1, count: 0, logSize: 0 };

    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const handle = await fs.promises.open(`${base}.idx`, 'r');
      try {
        const { size } = await handle.stat();
        if (size >= HEADER_BYTES) {
          await handle.read(header, 0, HEADER_BYTES, 0);
          if (header.readUInt32BE(0) === MAGIC && header.readUInt16BE(4) === FORMAT_VERSION) {
            const logStat = await fs.promises.stat(`${base}.jsonl`).catch(() => ({ size: 0 }));
            state = {
              firstSeq: Number(header.readBigUInt64BE(8)),
              count: Math.floor((size - HEADER_BYTES) / ENTRY_BYTES),
              logSize: logStat.size,
            };
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

    const existed = this.states.has(base);
    const state = await this.loadState(base);

    if (!existed && state.count === 0 && state.logSize === 0) {
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

    if (state.count > this.maxEvents || state.logSize > MAX_LOG_BYTES / 2) {
      await this.trimHead(base, state);
    }
  }

  /**
   * Drop the oldest `trimChunkEvents` events by rewriting both files.
   *
   * The surviving log is copied in fixed-size chunks rather than read into one
   * buffer: at the retention cap that buffer would be tens of megabytes, so a
   * routine trim would spike memory by more than the whole rest of the server
   * uses. Both files are replaced via rename, so a crash mid-trim leaves the
   * previous consistent pair in place.
   */
  private async trimHead(base: string, state: SessionState): Promise<void> {
    const drop = Math.min(this.trimChunkEvents, state.count);
    if (drop <= 0) {
      return;
    }

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
      Buffer.concat([headerBuffer(state.firstSeq + drop), remaining]),
    );
    await fs.promises.rename(`${base}.jsonl.tmp`, `${base}.jsonl`);
    await fs.promises.rename(`${base}.idx.tmp`, `${base}.idx`);

    state.firstSeq += drop;
    state.count -= drop;
    state.logSize = keptBytes;
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

  async read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats = this.statsOf(state);

      const wanted = Math.max(0, Math.min(Math.floor(count) || 0, this.maxPageEvents));
      const start = Math.max(state.firstSeq, Math.floor(fromSeq) || 0);
      const end = Math.min(stats.cursor + 1, start + wanted);

      if (wanted === 0 || end <= start) {
        return { ...stats, events: [] };
      }

      const events = await this.readSlice(base, state, start, end);
      return { ...stats, events };
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
   * Replay of a session, capped to its most recent events.
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

      const windowStart = Math.max(state.firstSeq, stats.cursor - this.snapshotReplayEvents + 1);
      const events =
        stats.cursor >= windowStart ? await this.readSlice(base, state, windowStart, stats.cursor + 1) : [];

      const transcript = createTranscript(NO_CHAT_CAPABILITIES);
      applyAll(transcript, events);

      return {
        sessionId: session.id,
        runtime: options.runtime ?? '',
        messages: transcript.messages,
        state: transcript.state,
        capabilities: transcript.capabilities,
        usage: transcript.usage,
        plan: transcript.plan,
        pendingPermissions: transcript.pendingPermissions,
        firstSeq: stats.firstSeq,
        cursor: stats.cursor,
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

function headerBuffer(firstSeq: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt16BE(FORMAT_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(firstSeq), 8);
  return header;
}

export default ChatStore;
