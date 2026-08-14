import type { BuiltInWorkflowId } from './workflow.js';
/** An attachment on an outgoing user turn. */
export interface ChatAttachment {
  /** Server-relative URL of the stored file. Bytes never ride on the socket. */
  url: string;
  mime: string;
  name: string;
  size: number;
  /** Absolute path on the server, for runtimes that take a path not a blob. */
  path?: string;
}

/** A user turn on its way to the runtime. */
export interface UserTurn {
  text: string;
  attachments?: ChatAttachment[];
  /** Internal intent for an app-bundled workflow; never rendered as user text. */
  workflow?: BuiltInWorkflowId;
}

/**
 * What is in the composer, before any of it is a turn.
 *
 * Deliberately not a transcript event, for the same reason a queued turn is not
 * one: the log records what happened to a conversation, and a half-typed
 * sentence has not happened. It rides on the join and on its own broadcast
 * instead, which is what puts the same unsent prompt on a phone and a laptop
 * at once (#163).
 *
 * The attachments are metadata only — the bytes went up over HTTP when the file
 * was picked and are served back from the session's own folder, so a second
 * device draws the chip from the same store rather than from a blob it has no
 * way to resolve.
 */
export interface ChatDraft {
  text: string;
  attachments: ChatAttachment[];
  /**
   * Which version of this draft it is, counted by the server.
   *
   * A counter and never a clock. Two edits from two devices in the same
   * millisecond carry the same timestamp, so `>` and `>=` are each wrong half
   * the time — a client deciding whether an arriving draft is newer than the one
   * it is holding needs an order that actually exists.
   */
  revision: number;
}

/**
 * A turn typed while the agent was still working, waiting its place in line.
 *
 * Deliberately not a transcript event. The log is the record of what happened,
 * and a queued turn has not happened yet — it can still be cancelled, and if
 * the server goes down it is gone along with the process it was queued for.
 * It rides on the snapshot and on its own broadcast instead, which is what
 * lets a second browser (or the same one after a reload) see the same line.
 */
export interface QueuedTurn {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  /** Preserves runtime-only bundled guidance through queueing and retry. */
  workflow?: BuiltInWorkflowId;
  ts: number;
  /**
   * Why the last attempt to hand this turn over failed.
   *
   * A turn that could not be delivered stays in line with this set rather than
   * being dropped: the whole point of queueing is to walk away and trust it,
   * and a queue that discards work silently is worse than no queue (#89). The
   * text is still here, so it is recoverable without retyping.
   */
  error?: string;
  /** How many times delivery has been attempted. Absent means not yet tried. */
  attempts?: number;
}

/**
 * How many turns may wait at once.
 *
 * A ceiling rather than a policy: the queue is held in memory on behalf of a
 * browser that may never come back, and "type as much as you like" is not a
 * promise this server should make with someone else's RAM.
 */
export const MAX_QUEUED_TURNS = 20;

