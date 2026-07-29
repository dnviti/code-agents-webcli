/**
 * Where one turn ends and the next begins, as one rule.
 *
 * A turn is open from the message that started it until the runtime ends it,
 * and everything said in between belongs to it whatever id it arrived under —
 * no adapter reuses the id this app minted, so grouping on the id as it arrives
 * splits every request from its answer (#86).
 *
 * The rule is here rather than written out at each of its readers because there
 * are three of them — the reducer a browser runs, the turn index the server
 * scans out of the log, and the seam a *windowed* read starts at — and three
 * readings of it are three answers to "which turn is this message in".
 *
 * That last reader is the one this file was extracted for. A snapshot replays
 * only the tail of a long conversation and a page is a slice of the middle, so
 * both routinely begin inside a turn whose opening message is outside the
 * window. Replayed from a standing start, the first message in the window opens
 * a turn of its own under the runtime's name for it: an index row with no user
 * text to be named from, reading "no prompt" beside a question that was asked
 * perfectly clearly, unmatchable against the recorded index because the id is
 * not the one the conversation filed it under. The fix is for the windowed read
 * to say which turn was open where it starts, and this is the function that
 * answers it.
 */

import { ChatEvent } from './chat-events.js';

/**
 * The turn open after `event`, given the one open before it.
 *
 * Null is "none open": a user's request starts the next turn. Three things
 * close one — the runtime ending it, the process going (which means nothing
 * ever will), and `/clear`, which ends the conversation the turn belonged to.
 *
 * `previous` is the last turn this conversation had, and it is what an agent
 * speaking again with no request in front of it goes back to. That happens for
 * real: an agent that started something in the background — a build, a check, a
 * job it was waiting on — ends its turn and then picks the same work back up
 * when the thing it was waiting for finishes. Nobody asked a second question,
 * so there is no second request, and only a request makes a turn. Read as one,
 * that stretch became a turn with no prompt to name it by — and, worse, work
 * the accounting had nowhere to file, because a job is opened by the user's
 * message and there was not one.
 */
export function openTurnAfter(
  event: ChatEvent,
  open: string | null,
  previous?: string | null,
): string | null {
  switch (event.t) {
    case 'msg_start':
      if (open) return open;
      // Only a request opens a turn. Anything else picks up where the
      // conversation left off, and opens one of its own only when there is no
      // "left off" — the tail of a resumed transcript, which is on screen and
      // has to be somewhere.
      if (event.role === 'user') return event.turnId;
      return previous ?? event.turnId;
    case 'turn_end':
      // Except when it is the runtime letting go of work that was interrupted
      // to redirect it. The turn goes on — see `stale` on the event.
      return event.stale ? open : null;
    case 'state':
      return event.state === 'exited' || event.state === 'error' ? null : open;
    case 'marker':
      return event.kind === 'cleared' ? null : open;
    default:
      return open;
  }
}

/**
 * One change of the open turn, at the seq that changed it.
 *
 * A whole conversation's worth of them is a handful of rows per turn, which is
 * why a server can hold this for a log it refuses to hold otherwise.
 */
export interface TurnBoundary {
  seq: number;
  turnId: string | null;
}

/** The turn open immediately *before* `seq` — what a replay starting there resumes. */
export function openTurnBefore(boundaries: ReadonlyArray<TurnBoundary>, seq: number): string | null {
  let open: string | null = null;
  for (const boundary of boundaries) {
    if (boundary.seq >= seq) break;
    open = boundary.turnId;
  }
  return open;
}
