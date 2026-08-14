import * as path from 'path';

export const REPLAYABLE = new Set([
  'msg_start',
  'block_start',
  'block_delta',
  'block_end',
  'msg_end',
  'tool',
  'turn_end',
]);

/**
 * How often to re-ask an adapter whether it can take the next queued turn.
 *
 * Short enough to be indistinguishable from immediate — the thing being waited
 * on is a child process finishing its exit, measured in single milliseconds —
 * and the wait only ever happens for adapters that spawn one process per turn.
 */
export const QUEUE_READY_POLL_MS = 25;

/**
 * How long to keep waiting before calling a queued message undeliverable.
 *
 * Generous on purpose: overshooting costs a message that arrives late, and
 * undershooting costs one reported as failed while it would still have gone.
 */
export const QUEUE_READY_TIMEOUT_MS = 15_000;

/**
 * How long after an interrupt a `turn_end` still counts as the answer to it.
 *
 * The runtimes here acknowledge in milliseconds, so this is already generous
 * by orders of magnitude, and it is deliberately not more. This window applies
 * to the interrupt path alone — a message that waited its turn in the queue is
 * delivered after the turn ended and starts its own — and the failure it has to
 * stay away from is swallowing a real ending: a turn left open would fold the
 * next queued message into work it has nothing to do with.
 */
export const INTERRUPT_ACK_WINDOW_MS = 5_000;

/**
 * Tool statuses that mean the call is over and nothing will be handed back to
 * it.
 *
 * Read only against calls that asked a question, and only to close the card
 * that belongs to one. `completed` is deliberately absent — an ask call
 * completes precisely when somebody answered it, and that resolution has
 * already happened by the time the status lands. `unknown` is here because the
 * reducer writes it onto calls the runtime stopped talking about, which is the
 * same fate arriving by a quieter route.
 */
export const DEAD_TOOL_STATUS: ReadonlySet<string> = new Set([
  'failed',
  'denied',
  'canceled',
  'unknown',
]);

/**
 * Turn endings that are the turn being cut short rather than finishing.
 *
 * Only used by `noteSpend`, and only to *decline* to conclude anything. A
 * runtime that was stopped mid-sentence, or that fell over, or that was killed
 * with the process, never reached the point where it reports what the turn
 * spent — Claude prices a turn in its final `result`, an ACP agent in the reply
 * to `session/prompt` — so the absence of a figure says nothing about whether
 * the runtime reports figures. Recording "reports nothing" from one of these
 * would put a permanent, wrong statement about the *runtime* on the log of a
 * conversation the *user* interrupted.
 *
 * Matched on the runtime's own word, lower-cased with separators removed
 * because the vocabulary is not shared: the adapters here emit `error`,
 * `exited`, `failed` and `interrupted` of their own accord, ACP adds
 * `cancelled` and `refusal`, and Claude's subtypes arrive as `error_max_turns`
 * and `error_during_execution` — hence the prefix test rather than a lookup for
 * those. Anything unrecognised is taken as a normal ending, which is the only
 * choice that keeps the feature working for a runtime nobody here has met:
 * `end_turn`, `EndTurn`, `completed`, `success`, `max_tokens` and no stop
 * reason at all are all ordinary endings, and no list could hold them all.
 */
export const CUT_SHORT_TURN: ReadonlySet<string> = new Set([
  'aborted',
  'cancel',
  'canceled',
  'cancelled',
  'exited',
  'failed',
  'interrupted',
  'killed',
  'refusal',
  'refused',
  'timedout',
  'timeout',
]);

/** Whether a `turn_end`'s stop reason means the turn never got to finish. */
export function wasCutShort(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  const word = stopReason.toLowerCase().replace(/[_\-\s]/g, '');
  return word.startsWith('error') || CUT_SHORT_TURN.has(word);
}

/**
 * Thrown when the session id is known but nothing is running under it.
 *
 * A distinct type rather than a message to match on, because the recovery for
 * it is specific and offering the wrong one is worse than offering none: this
 * is the condition where the transcript is intact and the conversation can be
 * picked back up, and every other failure here is not.
 */
