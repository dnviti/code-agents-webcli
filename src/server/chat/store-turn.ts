import { turnOutcomeOf } from '../../shared/turn-outcome.js';
import { openTurnAfter } from '../../shared/turn-boundaries.js';
import {
  ChatSessionRef,
  ChatStats,
  ChatTurnIndex,
  PersistedTurn,
  SessionState,
  TurnCut,
} from './store-types.js';
import { ChatStoreRead } from './store-read.js';

export abstract class ChatStoreTurn extends ChatStoreRead {
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
      const openTurn = (turnId: string, ts: number, id: string, seq: number): PersistedTurn => {
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
          startSeq: seq,
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
            const turn = openTurn(turnId, event.ts, event.id, event.seq);
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
   * The conversation as far as one turn, inclusive.
   *
   * Where a branch is cut. "Up to and including that turn" is answered from the
   * turn index rather than by matching ids against events, because the index is
   * already this store's answer to which turn a message belongs to — a second
   * reading of that here would be a second answer, and the two would disagree
   * about exactly the case the index exists for: a turn the agent carried on
   * with after ending it. So the cut is the seq the *next* turn opens at, and
   * everything before that belongs to this one however it is filed.
   *
   * Two passes over the log, which is a price worth paying once for an action
   * somebody asked for by name. The slice is held whole because it is about to
   * be written whole into another log; the store's own retention cap is what
   * bounds it, and a conversation past that cap has already lost its head.
   *
   * Null when no such turn is on disk — a turn from before the log was trimmed,
   * or an id from another conversation.
   */
  async turnCut(session: ChatSessionRef, turnId: string): Promise<TurnCut | null> {
    const index = await this.turnIndex(session);
    const at = index.turns.findIndex((turn) => turn.turnId === turnId);
    if (at < 0) return null;

    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      const state = await this.loadState(base);
      const stats = this.statsOf(state);
      // The turn after this one opens where this one's copy has to stop. Absent
      // — this is the newest turn — means everything still being said belongs
      // to it, so the cut runs to the end of the log.
      const next = index.turns[at + 1]?.startSeq;
      const end = next === undefined ? stats.cursor + 1 : next;
      const events = await this.readSlice(base, state, state.firstSeq, end);
      return {
        events,
        turn: index.turns[at],
        complete: index.complete,
        usage: await this.sessionUsage(base, state, stats),
      };
    });
  }

}
