import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '../types.js';

/**
 * Append-only store of finalised scrollback lines, addressable by absolute line
 * number.
 *
 * Two files per session:
 *   `<id>.log` — the lines themselves, newline-delimited.
 *   `<id>.idx` — a fixed-width index: a header plus one uint32 byte offset per
 *                retained line.
 *
 * The fixed width is the point. Serving "give me lines 812,340 to 812,390" is
 * two positioned reads — one into the index, one into the log — with no scan of
 * either file, so paging cost is independent of how long the session has run.
 *
 * Line numbers are absolute and never reused. Trimming the oldest lines moves
 * `firstLine` forward; it never renumbers what is left, so a client holding a
 * line number can always tell whether it fell off the back.
 */

const MAGIC = 0x43415748; // "CAWH"
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const ENTRY_BYTES = 4;

/** uint32 offsets cap the log; trimming keeps it far below this. */
const MAX_LOG_BYTES = 0xffffffff;

/** Copy buffer used when trimming, so a rewrite never scales with the log. */
const TRIM_CHUNK_BYTES = 1024 * 1024;

export interface HistoryStoreOptions {
  storageDir: string;
  /** Retained lines per session before the oldest are dropped. */
  maxLines?: number;
  /** How many lines to drop at once, so trimming is amortised. */
  trimChunkLines?: number;
  /** Upper bound on lines served in one request. */
  maxPageLines?: number;
}

export interface HistoryStats {
  /** Absolute number of the oldest retained line. */
  firstLine: number;
  /** Absolute number one past the newest line. */
  totalLines: number;
}

export interface HistoryPage extends HistoryStats {
  fromLine: number;
  lines: string[];
}

export type HistorySessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'>;

interface SessionState {
  firstLine: number;
  count: number;
  logSize: number;
}

export interface HistoryStoreLike {
  append(session: HistorySessionRef, lines: string[]): void;
  stat(session: HistorySessionRef): Promise<HistoryStats>;
  read(session: HistorySessionRef, fromLine: number, count: number): Promise<HistoryPage>;
  deleteHistory(session: HistorySessionRef): Promise<void>;
}

export class HistoryStore implements HistoryStoreLike {
  readonly storageDir: string;
  readonly historyDir: string;
  readonly maxLines: number;
  readonly trimChunkLines: number;
  readonly maxPageLines: number;

  private readonly states = new Map<string, SessionState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: HistoryStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.historyDir = path.join(this.storageDir, 'history');
    this.maxLines = options.maxLines ?? 200_000;
    this.trimChunkLines = options.trimChunkLines ?? 20_000;
    this.maxPageLines = options.maxPageLines ?? 500;
  }

  /**
   * Build the on-disk path for a session, refusing anything that could escape
   * the history directory.
   *
   * Session ids are server-generated UUIDs today, so nothing user-controlled
   * reaches here — but that is an invariant of the call sites, not of this
   * function. A future caller that passes an id straight from a request would
   * otherwise turn a path join into a write anywhere on disk.
   */
  private basePath(session: HistorySessionRef): string {
    const id = String(session.id);
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(`Refusing unsafe session id for history storage: ${JSON.stringify(id)}`);
    }

    if (!Number.isSafeInteger(session.ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for history storage: ${session.ownerUserId}`);
    }

    return path.join(this.historyDir, String(session.ownerUserId), id);
  }

  /** Serialise every operation per session: reads must not see a half-written index. */
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

    let state: SessionState = { firstLine: 0, count: 0, logSize: 0 };

    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const handle = await fs.promises.open(`${base}.idx`, 'r');
      try {
        const { size } = await handle.stat();
        if (size >= HEADER_BYTES) {
          await handle.read(header, 0, HEADER_BYTES, 0);
          if (header.readUInt32BE(0) === MAGIC && header.readUInt16BE(4) === FORMAT_VERSION) {
            const logStat = await fs.promises.stat(`${base}.log`).catch(() => ({ size: 0 }));
            state = {
              firstLine: Number(header.readBigUInt64BE(8)),
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
        console.error(`Failed to read history index ${base}.idx:`, error);
      }
    }

    await this.repairIndex(base, state);
    this.states.set(base, state);
    return state;
  }

  /**
   * Reconcile the index with the log.
   *
   * The two files are appended separately, so a crash or a failed write can
   * leave the log ahead of the index. Nothing detects that at read time — the
   * reader trusts the offsets — so the extra lines would be unreachable
   * forever and, worse, the *next* append would compute its offsets from a
   * stale size and shadow them with misaligned data.
   *
   * The scan starts at the last indexed record, so in the healthy case it
   * reads one line and stops.
   */
  private async repairIndex(base: string, state: SessionState): Promise<void> {
    if (state.logSize === 0) {
      if (state.count !== 0) {
        console.warn(`History index for ${base} describes lines an empty log does not have; resetting.`);
        await fs.promises.writeFile(`${base}.idx`, headerBuffer(state.firstLine)).catch(() => undefined);
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
      console.warn(`History index for ${base} points past the end of the log; keeping the log.`);
      return;
    }

    const tail = Buffer.alloc(state.logSize - scanFrom);
    if (tail.length > 0) {
      const handle = await fs.promises.open(`${base}.log`, 'r');
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
    // rather than serve half a line.
    const lastNewline = newlines.length > 0 ? newlines[newlines.length - 1] : -1;
    if (lastNewline < tail.length - 1) {
      const keep = scanFrom + lastNewline + 1;
      await fs.promises.truncate(`${base}.log`, keep);
      state.logSize = keep;
    }

    // Every newline closes a record, so every newline but the last also starts
    // the next one. The first record in the scanned region is the one the index
    // already knows about — unless the index is empty, in which case none of
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
    console.warn(`Recovered ${recovered.length} unindexed history line(s) for ${base}.`);
  }

  append(session: HistorySessionRef, lines: string[]): void {
    if (lines.length === 0) {
      return;
    }

    // This runs inside the PTY output callback and returns nothing, so it must
    // never throw: a rejected path or a full disk has to cost the history, not
    // the session's output.
    let base: string;
    try {
      base = this.basePath(session);
    } catch (error) {
      console.error('Refusing to store history:', error);
      return;
    }

    void this.enqueue(base, async () => {
      try {
        await this.appendNow(base, lines);
      } catch (error) {
        console.error(`Failed to append history for session ${session.id}:`, error);
        // The write may have half-landed. Drop the cached offsets so the next
        // operation re-reads from disk and reconciles, instead of computing
        // new offsets from a size that never happened.
        this.states.delete(base);
      }
    });
  }

  private async appendNow(base: string, lines: string[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(base), { recursive: true });

    const existed = this.states.has(base);
    const state = await this.loadState(base);

    if (!existed && state.count === 0 && state.logSize === 0) {
      // Fresh (or unreadable) index: lay down a header we can update in place.
      await fs.promises.writeFile(`${base}.idx`, headerBuffer(state.firstLine));
      await fs.promises.writeFile(`${base}.log`, '');
    }

    const entries = Buffer.alloc(lines.length * ENTRY_BYTES);
    const payload: string[] = [];
    let offset = state.logSize;

    for (let index = 0; index < lines.length; index++) {
      entries.writeUInt32LE(offset, index * ENTRY_BYTES);
      const record = `${lines[index]}\n`;
      payload.push(record);
      offset += Buffer.byteLength(record, 'utf8');
    }

    await fs.promises.appendFile(`${base}.log`, payload.join(''), 'utf8');
    await fs.promises.appendFile(`${base}.idx`, entries);

    state.count += lines.length;
    state.logSize = offset;

    if (state.count > this.maxLines || state.logSize > MAX_LOG_BYTES / 2) {
      await this.trimHead(base, state);
    }
  }

  /**
   * Drop the oldest `trimChunkLines` lines by rewriting both files.
   *
   * The surviving log is copied in fixed-size chunks rather than read into one
   * buffer: at the retention cap that buffer would be tens of megabytes, so a
   * routine trim would spike memory by more than the whole rest of the server
   * uses. Both files are replaced via rename, so a crash mid-trim leaves the
   * previous consistent pair in place.
   */
  private async trimHead(base: string, state: SessionState): Promise<void> {
    const drop = Math.min(this.trimChunkLines, state.count);
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
      Buffer.concat([headerBuffer(state.firstLine + drop), remaining]),
    );
    await fs.promises.rename(`${base}.log.tmp`, `${base}.log`);
    await fs.promises.rename(`${base}.idx.tmp`, `${base}.idx`);

    state.firstLine += drop;
    state.count -= drop;
    state.logSize = keptBytes;
  }

  private async copyLogTail(base: string, from: number, length: number): Promise<void> {
    const source = await fs.promises.open(`${base}.log`, 'r');
    const target = await fs.promises.open(`${base}.log.tmp`, 'w');
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

  async stat(session: HistorySessionRef): Promise<HistoryStats> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      return { firstLine: state.firstLine, totalLines: state.firstLine + state.count };
    });
  }

  async read(
    session: HistorySessionRef,
    fromLine: number,
    count: number,
  ): Promise<HistoryPage> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats: HistoryStats = {
        firstLine: state.firstLine,
        totalLines: state.firstLine + state.count,
      };

      const wanted = Math.max(0, Math.min(Math.floor(count) || 0, this.maxPageLines));
      const start = Math.max(state.firstLine, Math.floor(fromLine) || 0);
      const end = Math.min(stats.totalLines, start + wanted);

      if (wanted === 0 || end <= start) {
        return { ...stats, fromLine: start, lines: [] };
      }

      const relStart = start - state.firstLine;
      const relEnd = end - state.firstLine;

      // One read for the offsets (including the following line's start, which
      // is where our slice ends), one read for the bytes.
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
        return { ...stats, fromLine: start, lines: [] };
      }

      const sliceStart = offsets.readUInt32LE(0);
      // The last requested line has no following entry when it is the newest
      // line in the log; its slice ends at end-of-file.
      const sliceEnd =
        available > relEnd - relStart
          ? offsets.readUInt32LE((relEnd - relStart) * ENTRY_BYTES)
          : state.logSize;

      const length = Math.max(0, Math.min(sliceEnd, state.logSize) - sliceStart);
      if (length === 0) {
        return { ...stats, fromLine: start, lines: [] };
      }

      const buffer = Buffer.alloc(length);
      const logHandle = await fs.promises.open(`${base}.log`, 'r');
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

      return { ...stats, fromLine: start, lines: lines.slice(0, end - start) };
    });
  }

  async deleteHistory(session: HistorySessionRef): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      this.states.delete(base);
      await Promise.all(
        ['.log', '.idx', '.log.tmp', '.idx.tmp'].map((suffix) =>
          fs.promises.rm(`${base}${suffix}`, { force: true }).catch(() => undefined),
        ),
      );
    });
    this.queues.delete(base);
  }
}

function headerBuffer(firstLine: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt16BE(FORMAT_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(firstLine), 8);
  return header;
}

export default HistoryStore;
