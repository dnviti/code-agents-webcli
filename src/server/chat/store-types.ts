import { openSessionFileForRead } from '../services/safe-session-file.js';
import { SessionRecord } from '../types.js';
import { WorkspaceSessionStorageRef } from '../services/workspace-session-storage.js';
import {
  AccountLimits,
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatTurnIndexEntry,
  ChatUsage,
  PlanDocument,
  QuestionContinuation,
  QuestionRequest,
} from '../../shared/chat-events.js';
import { TurnBoundary } from '../../shared/turn-boundaries.js';

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

export const MAGIC = 0x43414348; // "CACH" - distinct from history-store's "CAWH" so the two
// index formats can never be cross-read by mistake if a path is ever confused.
export const FORMAT_VERSION = 2;
// Version 2 widened the header by one 64-bit field: how many turns the log has
// dropped, which is the only thing a trimmed conversation cannot work out for
// itself. An index written by version 1 fails the check and is rebuilt from the
// log, which is a path this file already has and already exercises.
export const HEADER_BYTES = 24;
export const ENTRY_BYTES = 4;

/** uint32 offsets cap the log; trimming keeps it far below this. */
export const MAX_LOG_BYTES = 0xffffffff;

/** Copy buffer used when trimming, so a rewrite never scales with the log. */
export const TRIM_CHUNK_BYTES = 1024 * 1024;

/** Same character class history-store enforces, plus the same two named exceptions. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Third file, written only for a conversation branched from another: the
 * history its agent is to be handed when the first message goes.
 *
 * Not a log record, deliberately. The log is what was said in this
 * conversation, and this is a message that has not been sent yet.
 */
export const CONTEXT_SUFFIX = '.ctx';

/** Latest complete Plan-mode document for the conversation. */
export const PLAN_SUFFIX = '.plan';

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
export const HEAD_SCAN_CHUNK = 64 * 1024;
export const HEAD_SCAN_LIMIT = 1024 * 1024;

/**
 * Events that belong to one message, and are meaningless without the
 * `msg_start` that opened it. Everything not listed here describes the session
 * rather than a message, and is replayed however far back it was emitted.
 */
export const MESSAGE_SCOPED: ReadonlySet<string> = new Set([
  'msg_start',
  'block_start',
  'block_delta',
  'block_end',
  'msg_end',
  // A workflow failing writes a message of its own (#140), which makes it one
  // of these and not a session-level fact. Left out, a failure from hours
  // earlier replayed into every rejoin and was redrawn at the top of the
  // window, in a turn of its own, above the conversation it happened inside.
  'workflow_failed',
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

/** One conversation cut at a turn, and what the whole of it has spent. */
export interface TurnCut {
  /** Every event from the head of the log through the end of that turn. */
  events: ChatEvent[];
  turn: PersistedTurn;
  /** False when the head of the log was trimmed, so the cut starts late. */
  complete: boolean;
  /**
   * The session's own running usage, which is where the model's context window
   * is recorded — the one figure a branch has to be measured against.
   */
  usage: ChatUsage;
}

export interface ChatSnapshotOptions {
  /** The log never names its own runtime; the caller supplies it. */
  runtime?: string;
  /** Whether the adapter process is alive right now - a live-process fact the log can't know. */
  live?: boolean;
  bypassPermissions?: boolean;
}

export type ChatSessionRef = Pick<SessionRecord, 'id' | 'ownerUserId'> & WorkspaceSessionStorageRef;

/** What a conversation can be listed and resumed by, read from its first lines. */
export interface ChatDescription {
  /** The runtime's own id, or null when it never reported one. */
  nativeSessionId: string | null;
  /** How the conversation opened, so a list of them can be read. */
  firstMessage: string | null;
}

export interface SessionState {
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
  /**
   * What the runtime said it could do, kept here for the same reason `usage`
   * is: it is a fact about the conversation, and it is recorded at the top of
   * one rather than anywhere near its end.
   *
   * Undefined means "not read yet".
   */
  capabilities?: ChatCapabilities;
  /**
   * The last account reading the provider stated, from the same full pass.
   *
   * Here for exactly the reason `capabilities` is: Claude states its rate-limit
   * window on the first turn and then only when it changes, so on a long
   * conversation the statement sits hundreds of events above the replayed tail
   * (#137). Null once read and nothing was ever said.
   */
  limits?: AccountLimits | null;
  /** Highest seq already folded into `capabilities` and `limits`. */
  capabilitySeq: number;
  /** Answered structured handoffs not yet terminally delivered/abandoned. */
  questionContinuations?: Map<string, QuestionContinuation>;
  /** Highest seq already folded into `questionContinuations`. */
  questionContinuationSeq: number;
  /** Unresolved question requests over the whole retained log. */
  pendingQuestions?: Map<string, QuestionRequest>;
  /** Highest seq already folded into `pendingQuestions`. */
  pendingQuestionSeq: number;
}

export interface ChatStoreLike {
  /**
   * Queue events for persistence. Real stores return the exact write promise
   * so durability-sensitive protocol transitions can wait for it; legacy
   * embedders may keep the original fire-and-forget `void` contract.
   */
  append(session: ChatSessionRef, events: ChatEvent[]): void | Promise<void>;
  /** Wait for every operation admitted before a workspace lifecycle gate. */
  flush?(session: ChatSessionRef): Promise<void>;
  stat(session: ChatSessionRef): Promise<ChatStats>;
  read(session: ChatSessionRef, fromSeq: number, count: number): Promise<ChatPage>;
  turnIndex(session: ChatSessionRef): Promise<ChatTurnIndex>;
  snapshot(session: ChatSessionRef, options?: ChatSnapshotOptions): Promise<ChatSnapshot>;
  /** Drop everything before `seq`, so a cleared conversation cannot be paged back into. */
  truncateBefore(session: ChatSessionRef, seq: number): Promise<void>;
  listSessions(ownerUserId: number): Promise<string[]>;
  deleteChat(session: ChatSessionRef): Promise<void>;
  /**
   * The two halves of a branch's opening context, optional because almost no
   * conversation has one and every hand-built store in the tests predates it.
   * A session that finds neither method simply opens with nothing carried,
   * which is what every conversation did before branching existed.
   */
  openingContext?(session: ChatSessionRef): Promise<string | null>;
  clearOpeningContext?(session: ChatSessionRef): Promise<void>;
  setPlanDocument?(session: ChatSessionRef, plan: PlanDocument): Promise<void>;
  planDocument?(session: ChatSessionRef): Promise<PlanDocument | null>;
  clearPlanDocument?(session: ChatSessionRef): Promise<void>;
}

/**
 * Whether a rejected append definitely left the canonical JSONL unchanged.
 *
 * `unknown` is deliberately different from an ordinary I/O failure: the log
 * may already contain the event even though a later index/verification step
 * failed. A caller must keep that event's sequence number reserved and retry
 * the exact same bytes (or recover the store); reusing the number would split
 * the live stream from the durable log.
 */
export type ChatStoreAppendOutcome = 'not_committed' | 'unknown';

export class ChatStoreAppendError extends Error {
  readonly outcome: ChatStoreAppendOutcome;
  readonly original: unknown;

  constructor(outcome: ChatStoreAppendOutcome, original: unknown, detail?: string) {
    const message = original instanceof Error ? original.message : String(original);
    super(detail ? `${detail}: ${message}` : message);
    this.name = 'ChatStoreAppendError';
    this.outcome = outcome;
    this.original = original;
  }
}

export function chatStoreAppendOutcome(error: unknown): ChatStoreAppendOutcome {
  return error instanceof ChatStoreAppendError ? error.outcome : 'not_committed';
}

/** Fold the two outbox events without replaying the rest of the transcript. */
export function foldQuestionContinuation(
  continuations: Map<string, QuestionContinuation>,
  event: ChatEvent,
): void {
  if (event.t === 'question_resolved' && event.continuation && !event.abandoned) {
    continuations.set(event.continuation.continuationId, {
      ...event.continuation,
      request: {
        ...event.continuation.request,
        options: event.continuation.request.options.map((option) => ({ ...option })),
      },
      answer: {
        ...event.continuation.answer,
        optionIds: [...event.continuation.answer.optionIds],
        labels: [...event.continuation.answer.labels],
      },
    });
    return;
  }
  if (event.t === 'question_continuation_dispatching') {
    const continuation = continuations.get(event.continuationId);
    if (continuation) continuation.dispatching = true;
    return;
  }
  if (event.t === 'question_continuation_pending') {
    const continuation = continuations.get(event.continuationId);
    if (continuation) delete continuation.dispatching;
    return;
  }
  if (event.t === 'question_continuation') {
    continuations.delete(event.continuationId);
    return;
  }
  if (event.t === 'marker' && event.kind === 'cleared') continuations.clear();
}

export function foldPendingQuestion(
  questions: Map<string, QuestionRequest>,
  event: ChatEvent,
): void {
  if (event.t === 'question') {
    questions.set(event.request.requestId, {
      ...event.request,
      options: event.request.options.map((option) => ({ ...option })),
    });
    return;
  }
  if (event.t === 'question_resolved') {
    questions.delete(event.requestId);
    return;
  }
  if (event.t === 'marker' && event.kind === 'cleared') questions.clear();
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
export function visitLine(line: string, visit: (event: ChatEvent) => void): void {
  const text = line.trim();
  if (!text) return;
  try {
    visit(JSON.parse(text) as ChatEvent);
  } catch {
    // Deliberately silent: an index is asked for on every open, and one bad
    // line would otherwise log on every one of them forever.
  }
}

export async function firstSeqInLog(base: string): Promise<number | null> {
  const buffer = Buffer.alloc(64 * 1024);
  let read = 0;
  try {
    const handle = await openSessionFileForRead(`${base}.jsonl`);
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

export function headerBuffer(firstSeq: number, turnsDropped = 0): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt16BE(FORMAT_VERSION, 4);
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(firstSeq), 8);
  header.writeBigUInt64BE(BigInt(turnsDropped), 16);
  return header;
}
