import fs from 'node:fs';
import path from 'node:path';
import {
  workspaceSessionAccessDirectory,
  workspaceSessionDirectory,
} from '../../services/workspace-session-storage.js';
import {
  appendSessionFile,
  openSessionFileForRead,
  prepareSessionFile,
  publishPreparedSessionFile,
  replaceSessionFile,
  statSessionFile,
  truncateSessionFile,
} from '../../services/safe-session-file.js';
import {
  AccountLimits,
  ChatCapabilities,
  ChatEvent,
  ChatUsage,
  NO_CHAT_CAPABILITIES,
  QuestionContinuation,
  QuestionRequest,
} from '../../../shared/chat-events.js';
import { foldCapabilities, foldSessionUsage } from '../../../shared/chat-reducer.js';
import { TurnBoundary, openTurnAfter } from '../../../shared/turn-boundaries.js';
import {
  ChatDescription,
  ChatSessionRef,
  ChatStats,
  ChatStoreOptions,
  SessionState,
  ENTRY_BYTES,
  firstSeqInLog,
  FORMAT_VERSION,
  headerBuffer,
  HEADER_BYTES,
  MAGIC,
  MESSAGE_SCOPED,
  MAX_LOG_BYTES,
  SESSION_ID_PATTERN,
  TRIM_CHUNK_BYTES,
  visitLine,
  foldQuestionContinuation,
  foldPendingQuestion,
} from './store-types.js';

export abstract class ChatStoreBase {
  readonly storageDir: string;
  readonly maxEvents: number;
  readonly trimChunkEvents: number;
  readonly maxPageEvents: number;
  readonly snapshotReplayEvents: number;
  readonly snapshotMinMessages: number;
  readonly snapshotMaxScanEvents: number;

  protected readonly states = new Map<string, SessionState>();
  protected readonly queues = new Map<string, Promise<unknown>>();
  protected readonly writeErrors = new Map<string, unknown>();
  /**
   * Openings already read, so listing every conversation is not a scan per row.
   *
   * A log is append-only, so once both facts in a `ChatDescription` have been
   * found they cannot change: the first `session` event stays first and the first
   * user message stays first however much is written after them. That makes this
   * a cache with no staleness to manage in the ordinary case — and it is the
   * difference between a conversation list costing one bounded read per
   * conversation every time it opens and costing it once per process.
   *
   * Only a *settled* answer is kept — see `describe` — and the two operations
   * that genuinely rewrite the head of a log, a `/clear` and a retention trim,
   * both drop the entry.
   */
  protected readonly descriptions = new Map<string, ChatDescription>();

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
  protected basePath(session: ChatSessionRef, establishWorkspace = true): string {
    const id = String(session.id);
    if (!SESSION_ID_PATTERN.test(id) || id === '.' || id === '..') {
      throw new Error(`Refusing unsafe session id for chat storage: ${JSON.stringify(id)}`);
    }

    if (!Number.isSafeInteger(session.ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for chat storage: ${session.ownerUserId}`);
    }

    const workspaceDir = establishWorkspace ? workspaceSessionAccessDirectory(session) : workspaceSessionDirectory(session);
    return workspaceDir ? path.join(workspaceDir, 'chat') : path.join(this.storageDir, String(session.ownerUserId), id);
  }

  /** Serialise every operation per session: a reader must not see a half-written index. */
  protected enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  protected async loadState(base: string): Promise<SessionState> {
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
      capabilitySeq: 0,
      questionContinuationSeq: 0,
      pendingQuestionSeq: 0,
    };

    // Sized before the index is read, and unconditionally: it is what tells
    // repairIndex there is a log to rebuild from when the index cannot be
    // trusted. Reading it only inside the happy path is what made a bad index
    // hide the entire conversation instead of triggering a repair.
    const logStat = await statSessionFile(`${base}.jsonl`);
    state.logSize = logStat ? logStat.size : 0;

    // A retention swap commits JSONL first and its derived index second. If
    // only the prepared index remains, JSONL already crossed that boundary;
    // finish the idempotent second rename before reading either generation.
    // When both temp files remain, the canonical log was never replaced and
    // the old canonical pair is still the right one.
    const [preparedIndex, preparedLog] = await Promise.all([
      statSessionFile(`${base}.idx.tmp`),
      statSessionFile(`${base}.jsonl.tmp`),
    ]);
    if (logStat && preparedIndex?.isFile() && !preparedLog) {
      try {
        await publishPreparedSessionFile(`${base}.idx.tmp`, `${base}.idx`);
        console.warn(`Completed interrupted chat retention index swap for ${base}.`);
      } catch (error) {
        console.warn(`Could not complete interrupted chat retention index swap for ${base}:`, error);
      }
    }

    let usable = false;
    let truncateIndexTo: number | null = null;
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const handle = await openSessionFileForRead(`${base}.idx`);
      try {
        const { size } = await handle.stat();
        if (size >= HEADER_BYTES) {
          await handle.read(header, 0, HEADER_BYTES, 0);
          if (header.readUInt32BE(0) === MAGIC && header.readUInt16BE(4) === FORMAT_VERSION) {
            state.firstSeq = Number(header.readBigUInt64BE(8));
            state.turnsDropped = Number(header.readBigUInt64BE(16));
            state.count = Math.floor((size - HEADER_BYTES) / ENTRY_BYTES);
            if ((size - HEADER_BYTES) % ENTRY_BYTES !== 0) {
              truncateIndexTo = HEADER_BYTES + state.count * ENTRY_BYTES;
            }
            usable = true;
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'UNSAFE_WORKSPACE_SESSION_FILE') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to read chat index ${base}.idx:`, error);
      }
    }

    // A crash can tear the fixed-width derived index just as it can the log.
    // Keeping the stray bytes would shift every recovered entry and make the
    // next cold read interpret a hybrid offset as real. Drop only the partial
    // entry; the complete JSONL records below rebuild what is missing.
    if (truncateIndexTo !== null) {
      await truncateSessionFile(`${base}.idx`, truncateIndexTo);
    }

    // Retention commits the canonical JSONL and its derived index with two
    // renames. A crash between them leaves a valid old index beside the new,
    // shortened log. The first retained event is an inexpensive, authoritative
    // generation check: if it disagrees with the header, discard the derived
    // offsets and rebuild them from JSONL instead of serving ranges through a
    // mismatched pair.
    if (usable && state.logSize > 0) {
      const loggedFirstSeq = await firstSeqInLog(base);
      if (loggedFirstSeq !== null && loggedFirstSeq !== state.firstSeq) {
        console.warn(
          `Chat index for ${base} starts at ${state.firstSeq}, but the log starts at ${loggedFirstSeq}; rebuilding.`,
        );
        state.firstSeq = loggedFirstSeq;
        state.count = 0;
        // The interrupted replacement's header may be unavailable, so the
        // exact number trimmed cannot be reconstructed from JSONL alone.
        state.turnsDropped = 0;
        await replaceSessionFile(
          `${base}.idx`,
          headerBuffer(state.firstSeq, state.turnsDropped),
        );
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
      await replaceSessionFile(
        `${base}.idx`,
        headerBuffer(state.firstSeq, state.turnsDropped),
      );
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
  protected async repairIndex(base: string, state: SessionState): Promise<void> {
    if (state.logSize === 0) {
      if (state.count !== 0) {
        console.warn(`Chat index for ${base} describes events an empty log does not have; resetting.`);
        await replaceSessionFile(
          `${base}.idx`,
          headerBuffer(state.firstSeq),
        ).catch(() => undefined);
        state.count = 0;
      }
      return;
    }

    let scanFrom = 0;
    if (state.count > 0) {
      const entry = Buffer.alloc(ENTRY_BYTES);
      const handle = await openSessionFileForRead(`${base}.idx`);
      try {
        await handle.read(entry, 0, ENTRY_BYTES, HEADER_BYTES + (state.count - 1) * ENTRY_BYTES);
      } finally {
        await handle.close();
      }
      scanFrom = entry.readUInt32LE(0);
    }

    if (scanFrom >= state.logSize) {
      console.warn(`Chat index for ${base} points past the end of the log; rebuilding it.`);
      state.firstSeq = (await firstSeqInLog(base)) ?? 1;
      state.count = 0;
      state.turnsDropped = 0;
      await replaceSessionFile(
        `${base}.idx`,
        headerBuffer(state.firstSeq, state.turnsDropped),
      );
      await this.repairIndex(base, state);
      return;
    }

    const tail = Buffer.alloc(state.logSize - scanFrom);
    if (tail.length > 0) {
      const handle = await openSessionFileForRead(`${base}.jsonl`);
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
      await truncateSessionFile(`${base}.jsonl`, keep);
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
    await appendSessionFile(`${base}.idx`, entries);
    state.count += recovered.length;
    console.warn(`Recovered ${recovered.length} unindexed chat event(s) for ${base}.`);
  }

  /** Whether the log ends with every byte of the attempted append batch. */
  protected async logEndsWith(base: string, payload: string): Promise<boolean> {
    const expected = Buffer.from(payload, 'utf8');
    if (expected.length === 0) return false;

    const handle = await openSessionFileForRead(`${base}.jsonl`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return false;

    try {
      const { size } = await handle.stat();
      if (size < expected.length) return false;

      const actual = Buffer.allocUnsafe(expected.length);
      let read = 0;
      while (read < actual.length) {
        const result = await handle.read(
          actual,
          read,
          actual.length - read,
          size - actual.length + read,
        );
        if (result.bytesRead === 0) return false;
        read += result.bytesRead;
      }
      return actual.equals(expected);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  protected async copyLogTail(base: string, from: number, length: number): Promise<void> {
    const source = await openSessionFileForRead(`${base}.jsonl`);
    let target: fs.promises.FileHandle | null = null;
    try {
      target = await prepareSessionFile(`${base}.jsonl.tmp`);
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
      await target?.close();
    }
  }

  protected statsOf(state: SessionState): ChatStats {
    return {
      firstSeq: state.firstSeq,
      cursor: state.count > 0 ? state.firstSeq + state.count - 1 : state.firstSeq - 1,
    };
  }

  /**
   * Walk every event in the log, oldest first, one line at a time.
   *
   * Streamed rather than read whole: a long conversation's log is tens of
   * megabytes, and the caller here keeps one small row per turn out of it. The
   * point of this method is that it never holds the log in memory.
   */
  protected async scanLog(
    base: string,
    state: SessionState,
    visit: (event: ChatEvent) => void,
  ): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await openSessionFileForRead(`${base}.jsonl`);
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

  /**
   * Read the half-open seq range [start, end) as parsed events.
   *
   * One read for the offsets (including the following event's start, which is
   * where our slice ends), one read for the bytes - the same two-read shape
   * history-store uses, so paging cost stays independent of how far back the
   * request reaches.
   */
  protected async readSlice(base: string, state: SessionState, start: number, end: number): Promise<ChatEvent[]> {
    const relStart = start - state.firstSeq;
    const relEnd = end - state.firstSeq;

    const spanEntries = relEnd - relStart + 1;
    const offsets = Buffer.alloc(spanEntries * ENTRY_BYTES);
    const idxHandle = await openSessionFileForRead(`${base}.idx`);
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
    const logHandle = await openSessionFileForRead(`${base}.jsonl`);
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
  protected async replayTail(
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
  protected async sessionUsage(
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
   * What the runtime told this conversation it could do, over all of it.
   *
   * Read from the whole log, and it has to be: the tail is a window over the
   * last forty messages, and the single event carrying a runtime's capabilities
   * is emitted when that runtime *starts* — for claude, in the `init` of its
   * first turn, which on a conversation of any length is hundreds of events
   * above the window. Taken from the replay alone, a resumed conversation of
   * twenty-odd exchanges came back with no slash commands, no attachment
   * control, no model or effort menu and a stop button that could not stop a
   * running turn, while the same conversation ten messages shorter came back
   * whole — a failure with no explanation the user could see (#30).
   *
   * The fold is the reducer's, not a second reading of it: a `session` event is
   * a runtime introducing itself and replaces the set, a `capabilities` event
   * adds to it. That matters on a conversation that has been resumed under a
   * runtime whose command list has changed since, where a merge would go on
   * offering commands the process no longer has.
   *
   * Cached exactly like `sessionUsage`, with the same limit: a log whose head
   * has been trimmed cannot report what a runtime said before the trim, so a
   * conversation first opened after its own head was dropped has only what it
   * said since.
   */
  protected async sessionRuntimeReports(
    base: string,
    state: SessionState,
    stats: ChatStats,
  ): Promise<{ capabilities: ChatCapabilities; limits?: AccountLimits }> {
    if (state.capabilities && state.capabilitySeq >= stats.cursor) {
      return { capabilities: state.capabilities, limits: state.limits ?? undefined };
    }

    let capabilities: ChatCapabilities = { ...NO_CHAT_CAPABILITIES };
    // Gathered in the same pass rather than in one of its own: the scan is a
    // streamed read of the whole log, and a third of them for one field would
    // be a third read of every conversation that is opened.
    let limits: AccountLimits | null = null;
    let seq = 0;
    await this.scanLog(base, state, (event) => {
      capabilities = foldCapabilities(capabilities, event);
      if (event.t === 'limits') limits = event.limits;
      if (event.seq > seq) seq = event.seq;
    });

    state.capabilities = capabilities;
    state.limits = limits;
    state.capabilitySeq = Math.max(seq, stats.cursor);
    return { capabilities, limits: limits ?? undefined };
  }

  /**
   * Durable structured-answer outbox over the whole retained log.
   *
   * Unlike a card, a continuation may remain pending while several process
   * lifecycle events are appended, so the tail replay is not an authority for
   * whether it still needs delivery. The first snapshot scans once; later
   * appends keep the small map current.
   */
  protected async recoverableQuestionState(
    base: string,
    state: SessionState,
    stats: ChatStats,
  ): Promise<{
    pendingQuestions: QuestionRequest[];
    continuations: QuestionContinuation[];
  }> {
    if (
      state.questionContinuations
      && state.pendingQuestions
      && state.questionContinuationSeq >= stats.cursor
      && state.pendingQuestionSeq >= stats.cursor
    ) {
      return {
        pendingQuestions: [...state.pendingQuestions.values()],
        continuations: [...state.questionContinuations.values()],
      };
    }

    const continuations = new Map<string, QuestionContinuation>();
    const pendingQuestions = new Map<string, QuestionRequest>();
    let seq = 0;
    await this.scanLog(base, state, (event) => {
      foldQuestionContinuation(continuations, event);
      foldPendingQuestion(pendingQuestions, event);
      if (event.seq > seq) seq = event.seq;
    });
    state.questionContinuations = continuations;
    state.pendingQuestions = pendingQuestions;
    state.questionContinuationSeq = Math.max(seq, stats.cursor);
    state.pendingQuestionSeq = Math.max(seq, stats.cursor);
    return {
      pendingQuestions: [...pendingQuestions.values()],
      continuations: [...continuations.values()],
    };
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
  protected async turnBoundaries(
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

}
