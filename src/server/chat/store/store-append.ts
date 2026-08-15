import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkspaceSessionDirectory,
  workspaceSessionFileParentLease,
} from '../../services/workspace/session/workspace-session-storage.js';
import {
  appendSessionFile,
  openSessionFileForRead,
  publishPreparedSessionFile,
  replaceSessionFile,
  statSessionFile,
  truncateSessionFile,
  writePreparedSessionFile,
} from '../../services/workspace/artifacts/safe-session-file.js';
import { ChatEvent, ChatCapabilities, ChatUsage } from '../../../shared/chat-events.js';
import { foldCapabilities, foldSessionUsage } from '../../../shared/chat-reducer.js';
import { openTurnAfter } from '../../../shared/turn-boundaries.js';
import {
  ChatSessionRef,
  ChatStats,
  ChatStoreAppendError,
  SessionState,
  ENTRY_BYTES,
  foldPendingQuestion,
  foldQuestionContinuation,
  headerBuffer,
  HEADER_BYTES,
  MAX_LOG_BYTES,
  TRIM_CHUNK_BYTES,
} from './store-types.js';
import { ChatStoreBase } from './store-core.js';

export abstract class ChatStoreAppend extends ChatStoreBase {
  append(session: ChatSessionRef, events: ChatEvent[]): Promise<void> {
    if (events.length === 0) {
      return Promise.resolve();
    }
    if (session.persistenceUnavailable) {
      const error = Object.assign(new Error(session.persistenceUnavailable), {
        code: 'SESSION_PERSISTENCE_UNAVAILABLE',
      });
      const rejected = Promise.reject(error);
      void rejected.catch(() => undefined);
      return rejected;
    }

    // This runs on the event emission path and never throws synchronously. Its
    // returned promise is normally fire-and-forget, but durable protocol
    // transitions await it before they are broadcast or acknowledged.
    let base: string;
    try {
      base = this.basePath(session, false);
    } catch (error) {
      console.error('Refusing to store chat events:', error);
      const rejected = Promise.reject(error);
      // Most events deliberately retain the historical fire-and-forget path.
      // Attach a handler here so callers that do not need a durability barrier
      // do not create an unhandled rejection; callers that await the original
      // promise still observe the failure.
      void rejected.catch(() => undefined);
      return rejected;
    }

    const write = this.enqueue(base, async () => {
      let payload: string | null = null;
      const attempt = {
        logStart: null as number | null,
        logRebaseStarted: false,
        logRebased: false,
      };
      try {
        await ensureWorkspaceSessionDirectory(session);
        // Keep the exact bytes handed to appendFile. If the derived index write
        // fails after these bytes land, the JSONL suffix is the authoritative
        // commit record and the caller must not retry the same durable event.
        const records = events.map((event) => `${JSON.stringify(event)}\n`);
        payload = records.join('');
        await this.appendNow(base, events, records, payload, attempt);
      } catch (error) {
        // The write may have half-landed. Drop the cached state so the next
        // operation re-reads from disk and reconciles, instead of computing
        // new offsets from a size that never happened.
        this.states.delete(base);

        // The JSONL log is the durable artefact; the index is rebuilt from it.
        // appendNow writes the whole batch to the log in one append before it
        // touches the index, so an exact complete suffix means the transition
        // committed even when the index append (or a later derived operation)
        // reported failure. Resolving here prevents a durability-sensitive
        // caller from retrying an event that recovery will subsequently see.
        let committed = false;
        let verificationError: unknown;
        try {
          committed = payload !== null && await this.logEndsWith(base, payload);
        } catch (caught) {
          verificationError = caught;
          console.error(
            `Failed to verify the chat log suffix for session ${session.id}:`,
            caught,
          );
        }
        if (committed) {
          console.warn(
            `Chat events for session ${session.id} reached the log despite a later append failure; `
            + 'the index will be reconciled on the next operation.',
          );
          return;
        }

        // Retention rewrites the canonical JSONL and therefore invalidates the
        // pre-append byte offset. Once that rename completed, the append is
        // part of the new log generation even if the derived index rename (or
        // suffix verification) failed afterward. Never truncate or reclaim it
        // using an offset from the old generation.
        if (attempt.logRebased) {
          console.warn(
            `Chat events for session ${session.id} committed through a retention log swap; `
            + 'the index will be reconciled on the next operation.',
          );
          return;
        }
        if (attempt.logRebaseStarted) {
          throw new ChatStoreAppendError(
            'unknown',
            error,
            'chat store: append outcome is ambiguous because a retention log swap did not settle',
          );
        }

        // A failed append may still have closed one or more complete JSON
        // lines from this batch. Recovery quite correctly preserves complete
        // records, but a durability barrier is all-or-nothing to its caller:
        // retaining a prefix and then rejecting would make an exact batch retry
        // out of order. Rewind to the pre-batch offset before reporting failure.
        if (attempt.logStart !== null) {
          let size: number;
          try {
            size = (await statSessionFile(`${base}.jsonl`))?.size ?? 0;
          } catch (statError: unknown) {
            throw new ChatStoreAppendError(
              'unknown',
              error,
              `chat store: append outcome is ambiguous because the log could not be inspected (${String(statError)})`,
            );
          }
          if (size > attempt.logStart) {
            try {
              await truncateSessionFile(`${base}.jsonl`, attempt.logStart);
            } catch (truncateError: unknown) {
              // A transient verifier failure followed by a transient rollback
              // failure used to report an unknown outcome even when the whole
              // JSONL record had landed. Re-check before escalating: a caller
              // can then treat this as committed and repair the derived index.
              try {
                if (payload !== null && await this.logEndsWith(base, payload)) {
                  console.warn(
                    `Chat events for session ${session.id} reached the log while rollback failed; `
                    + 'the index will be reconciled on the next operation.',
                  );
                  return;
                }
              } catch (retryVerificationError: unknown) {
                verificationError = verificationError ?? retryVerificationError;
              }
              throw new ChatStoreAppendError(
                'unknown',
                error,
                `chat store: append outcome is ambiguous and the partial batch could not be rolled back (${String(truncateError)}${verificationError ? `; verification failed: ${String(verificationError)}` : ''})`,
              );
            }
          } else if (verificationError !== undefined) {
            // A failed verifier cannot establish that the unchanged-looking
            // size belongs to the same file generation. Conservatively retain
            // the sequence reservation rather than risk reusing a durable seq.
            throw new ChatStoreAppendError(
              'unknown',
              error,
              `chat store: append outcome is ambiguous because the log could not be verified (${String(verificationError)})`,
            );
          }
        } else if (verificationError !== undefined) {
          // This invocation did not reach its append, but it may be an exact
          // retry after an earlier ambiguous invocation. Until the canonical
          // log can be inspected, neither success nor sequence reuse is safe.
          throw new ChatStoreAppendError(
            'unknown',
            error,
            `chat store: append outcome is ambiguous because the log could not be verified (${String(verificationError)})`,
          );
        }

        console.error(`Failed to append chat events for session ${session.id}:`, error);
        throw new ChatStoreAppendError('not_committed', error);
      }
    });
    void write.then(
      () => this.writeErrors.delete(base),
      (error) => this.writeErrors.set(base, error),
    );
    return write;
  }

  async flush(session: ChatSessionRef): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => undefined);
    const failed = this.writeErrors.get(base);
    if (failed) throw failed;
  }

  protected async appendNow(
    base: string,
    events: ChatEvent[],
    records: string[],
    payload: string,
    attempt: {
      logStart: number | null;
      logRebaseStarted: boolean;
      logRebased: boolean;
    },
  ): Promise<void> {
    if (!workspaceSessionFileParentLease(`${base}.jsonl`)) {
      await fs.promises.mkdir(path.dirname(base), { recursive: true });
    }

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
      await replaceSessionFile(`${base}.idx`, headerBuffer(state.firstSeq));
      await replaceSessionFile(`${base}.jsonl`, '');
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
    let offset = state.logSize;

    for (let index = 0; index < events.length; index++) {
      entries.writeUInt32LE(offset, index * ENTRY_BYTES);
      offset += Buffer.byteLength(records[index], 'utf8');
    }

    attempt.logStart = state.logSize;
    await appendSessionFile(`${base}.jsonl`, payload, 'utf8');
    await appendSessionFile(`${base}.idx`, entries);

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

    // And what the runtime says it can do, on the same terms: a relaunch
    // introduces itself again part way down the log, and the alternative is
    // re-reading everything above it to learn what it just said.
    if (state.capabilities) {
      for (const event of events) {
        if (event.seq <= state.capabilitySeq) continue;
        state.capabilities = foldCapabilities(state.capabilities, event);
        if (event.t === 'limits') state.limits = event.limits;
        state.capabilitySeq = event.seq;
      }
    }

    if (state.questionContinuations) {
      for (const event of events) {
        if (event.seq <= state.questionContinuationSeq) continue;
        foldQuestionContinuation(state.questionContinuations, event);
        state.questionContinuationSeq = event.seq;
      }
    }
    if (state.pendingQuestions) {
      for (const event of events) {
        if (event.seq <= state.pendingQuestionSeq) continue;
        foldPendingQuestion(state.pendingQuestions, event);
        state.pendingQuestionSeq = event.seq;
      }
    }

    if (state.count > this.maxEvents || state.logSize > MAX_LOG_BYTES / 2) {
      await this.trimHead(base, state, attempt);
    }
  }

  /**
   * Drop the oldest `trimChunkEvents` events, once the log is over its cap.
   *
   * A pending structured question and an undelivered answer outbox are durable
   * protocol state, not replay history. Keep the record that establishes each
   * unresolved fact on disk: the warm cache can remember it after a blind trim,
   * but a restarted process cannot. Once the matching resolution/terminal
   * record exists the pin disappears and ordinary retention can advance again.
   */
  protected async trimHead(
    base: string,
    state: SessionState,
    attempt?: { logRebaseStarted: boolean; logRebased: boolean },
  ): Promise<void> {
    const questionFloor = await this.questionRetentionFloor(base, state);
    const beforeQuestion = questionFloor === null
      ? this.trimChunkEvents
      : Math.max(0, questionFloor - state.firstSeq);
    await this.dropOldest(
      base,
      state,
      Math.min(this.trimChunkEvents, beforeQuestion),
      attempt,
    );
  }

  /** Lowest log seq still needed to reconstruct a live question or outbox. */
  protected async questionRetentionFloor(base: string, state: SessionState): Promise<number | null> {
    const questions = new Map<string, number>();
    const continuations = new Map<string, number>();

    await this.scanLog(base, state, (event) => {
      if (event.t === 'question') {
        questions.set(event.request.requestId, event.seq);
        return;
      }
      if (event.t === 'question_resolved') {
        questions.delete(event.requestId);
        if (event.continuation && !event.abandoned) {
          continuations.set(event.continuation.continuationId, event.seq);
        }
        return;
      }
      if (event.t === 'question_continuation') {
        continuations.delete(event.continuationId);
        return;
      }
      if (event.t === 'marker' && event.kind === 'cleared') {
        questions.clear();
        continuations.clear();
      }
    });

    let floor: number | null = null;
    for (const seq of questions.values()) floor = floor === null ? seq : Math.min(floor, seq);
    for (const seq of continuations.values()) floor = floor === null ? seq : Math.min(floor, seq);
    return floor;
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
  protected async dropOldest(
    base: string,
    state: SessionState,
    count: number,
    attempt?: { logRebaseStarted: boolean; logRebased: boolean },
  ): Promise<void> {
    const drop = Math.min(count, state.count);
    if (drop <= 0) {
      return;
    }

    // The head of the log is about to be a different head. This is the one thing
    // that invalidates a description — the opening message may be among the
    // events going away — and it covers both callers: a `/clear`, where the
    // conversation genuinely opens somewhere else now, and a retention trim,
    // where the opening is simply gone.
    this.descriptions.delete(base);

    // Counted before the log loses them, because afterwards nothing can. A turn
    // is numbered by how many came before it in the conversation, and reading
    // that off the position of a row in what survives renumbers every trimmed
    // conversation from 1 — so the index, the header's count and the spend
    // record disagree about the same turn (#86).
    const dropped = state.turnsDropped + (await this.turnsBelow(base, state, state.firstSeq + drop));

    const idxHandle = await openSessionFileForRead(`${base}.idx`);
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

    await writePreparedSessionFile(
      `${base}.idx.tmp`,
      Buffer.concat([headerBuffer(state.firstSeq + drop, dropped), remaining]),
    );
    if (attempt) attempt.logRebaseStarted = true;
    await publishPreparedSessionFile(`${base}.jsonl.tmp`, `${base}.jsonl`);
    if (attempt) attempt.logRebased = true;
    await publishPreparedSessionFile(`${base}.idx.tmp`, `${base}.idx`);

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
  protected async turnsBelow(base: string, state: SessionState, seq: number): Promise<number> {
    const stats: ChatStats = {
      firstSeq: state.firstSeq,
      cursor: state.count > 0 ? state.firstSeq + state.count - 1 : 0,
    };
    const boundaries = await this.turnBoundaries(base, state, stats);
    return boundaries.filter((boundary) => boundary.seq < seq && boundary.turnId !== null).length;
  }

}
