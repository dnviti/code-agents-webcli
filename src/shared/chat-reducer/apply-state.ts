import {
  ChatEvent,
  ChatMessage,
  mergeUsage,
} from '../chat-events.js';
import { turnOutcomeOf } from '../turn-outcome.js';
import { openTurnAfter } from '../turn-boundaries.js';
import { foldSessionUsage, NOTICES } from './fold.js';
import { lastStreamingIndex, lastTurnId } from './core.js';
import { settleUnobservableWorkflows, settleUnreportedTools } from './settle.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * The lifecycle facts around a turn and the conversation: the state the
 * runtime reports, its errors, the markers that annotate history, and the
 * turn's own closing.
 */
export function applyState(state: TranscriptState, event: ChatEvent): TranscriptChange {
  switch (event.t) {
    case 'state': {
      state.state = event.state;
      // A runtime that died did not end its turn, and nothing else will. Left
      // open, the next thing the user typed would be folded into a turn whose
      // process is gone — the mirror of the `turn_end` case, and the same rule
      // the accountant applies when it closes a job on an exit (#86).
      const wasOpen = state.currentTurnId;
      state.currentTurnId = openTurnAfter(event, state.currentTurnId);
      if (event.state === 'exited' || event.state === 'error') {
        // Workflows first: a run left watching nothing gets its own honest
        // ending (#116), and only then is the rest of the dead turn swept —
        // nothing can report once the child is gone, so the exemption for a
        // run still reporting about itself does not apply here (#139).
        settleUnobservableWorkflows(state);
        settleUnreportedTools(state, wasOpen, true);
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'error': {
      state.lastError = event.message;
      if (event.fatal) state.state = 'error';
      // Surfaced in the transcript as well as the header: an error that only
      // lives in a status pill is an error the user scrolls past and misses.
      //
      // The last message that is *streaming*, not simply the last one. A rule
      // drawn across a conversation — a compaction, an interruption, a workflow
      // that failed in the background (#140) — is pushed onto the end while a
      // reply is still arriving, and answering "is the last message open?" with
      // that rule dropped every error for the rest of the turn.
      const openIndex = lastStreamingIndex(state);
      const last = openIndex === -1 ? undefined : state.messages[openIndex];
      if (last && last.streaming) {
        // `fatal` carried through rather than flattened away: it is the
        // difference between an error the agent read and moved past and the one
        // it stopped on, and a turn cut short by the second never reaches a
        // `turn_end` that could say so.
        last.blocks.push({ kind: 'error', text: event.message, ...(event.fatal ? { fatal: true } : {}) });
        return { messageIndex: openIndex, structural: false, meta: true, applied: true };
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'marker': {
      if (event.kind === 'cleared') {
        // Emptied, not annotated. `/clear` means "start again", and a window
        // still holding the previous conversation is the opposite of that —
        // and worse, it would show a history the agent can no longer see.
        state.messages = [];
        state.index = {};
        state.plan = [];
        state.lastError = undefined;
        // And the figures above it go back to nothing: the tokens, the money
        // and the context bar were all statements about the conversation that
        // has just ended. Left running, the new conversation opens carrying the
        // last one's bill — and a context bar reading 80% full of a window that
        // is now empty, which is the reading somebody clears in order to fix.
        state.usage = foldSessionUsage(state.usage, event);
        // Including the turn that was open: `/clear` is taken the moment it is
        // typed, mid-turn if need be, and the conversation it interrupted is
        // gone. Anything typed after it starts a turn of its own.
        state.currentTurnId = null;
        // The cards go with the conversation they were asked in. A question
        // card left behind would be drawn against a tool block that is no
        // longer on screen, and answering it would reach a turn that no longer
        // exists — the session resolves them at the same moment on its side.
        state.pendingQuestions = [];
        state.pendingQuestionContinuations = {};
        state.questionHistory = [];
        state.answeredQuestions = {};
        state.answeredQuestionText = {};
        state.abandonedQuestions = {};
        // And the approvals with them, for the same reason and one more: an
        // approval card is drawn above the composer rather than inside the
        // conversation, so it is the one piece of the old conversation that
        // would still be on screen — asking whether a tool may run in a
        // process that has already been replaced. The session drops its side
        // as it stops.
        state.pendingPermissions = [];
        // And no paging back past it. The log still holds what was said — this
        // is a view, not a delete — but offering "load earlier messages" right
        // after someone asked for a clean window would undo the thing they
        // just asked for, one scroll at a time.
        state.firstSeq = event.seq;
        return { messageIndex: null, structural: true, meta: true, applied: true };
      }

      // And the one that leaves nothing at all.
      //
      // The approval mode has to travel as an event — a conversation restarted
      // from inside itself re-decides it, and this marker is the only thing that
      // reaches the browser with the answer (#134) — but it is a standing fact
      // about the session rather than something that happened in the
      // conversation, and the surfaces that state standing facts say it
      // permanently: the badge in the header and the chip beside the composer,
      // both off `bypassing`.
      //
      // Written into the transcript as well, it was the whole of a conversation
      // nobody had spoken in yet. A chat opened and sat there showing a rule, a
      // turn strip and a row in the index for a turn that had not happened —
      // numbered 1, so the first question the user actually asked opened turn 2,
      // and both rows read "turn 1" until the recorded index arrived to
      // disagree. A conversation starts empty and the user's first prompt starts
      // turn 1.
      //
      // The event itself is untouched: it is still written to the log, so the
      // recording still says which mode each conversation ran in and when that
      // was decided. Only the row it used to draw is gone.
      if (event.kind === 'approvals') {
        return { messageIndex: null, structural: false, meta: false, applied: true };
      }

      // The ones that leave a line rather than empty the window. Compaction is
      // there because everything above it is no longer in the agent's context,
      // and an agent that quietly forgets the first hour is a confusing one.
      // An interruption is there because the turn above it stopped for a
      // reason — the message immediately below — and a transcript that showed
      // the stop without the reason would read as an agent that gave up. A
      // branch is there because everything above it happened in another
      // conversation, and a copied history presented as this one's own would
      // be the same lie in the other direction.
      //
      // What they have in common, and what `approvals` above does not, is that
      // each of them is an event in the conversation's own history: it happened
      // at a point in the transcript and means nothing anywhere else.
      const notice = NOTICES[event.kind];
      const message: ChatMessage = {
        id: `marker-${event.seq}`,
        seq: event.seq,
        // The turn it was drawn in, or the one it was drawn under: a line
        // marking what happened to the conversation is not a turn of its own,
        // and numbering it as one puts a row in the index nobody asked for.
        //
        // Except the one that says where this conversation came from. Joined to
        // the last carried turn it disappears the moment that turn folds, which
        // is the moment the branch is used — so the only statement that the
        // history above belongs to another conversation is the one thing a
        // reader cannot find. It stands on its own instead.
        turnId:
          event.kind === 'branched'
            ? `marker-${event.seq}`
            : state.currentTurnId ?? lastTurnId(state) ?? `marker-${event.seq}`,
        role: 'system',
        ts: event.ts,
        blocks: [{ kind: 'notice', ...notice, detail: event.detail }],
      };
      state.messages.push(message);
      state.index[message.id] = state.messages.length - 1;
      return {
        messageIndex: state.messages.length - 1,
        structural: true,
        meta: true,
        applied: true,
      };
    }

    case 'turn_end': {
      // A turn interrupted to redirect it is not a turn that ended: the
      // message that cut it short was delivered into it and the agent is
      // already working on it again. What the runtime is acknowledging here is
      // the half it abandoned, so this takes the spend and leaves the turn
      // open, running, and unstamped — see `stale` on the event.
      if (!event.stale) {
        if (state.state !== 'error' && state.state !== 'exited') {
          state.state = 'idle';
        }
        // The runtime's own word for how the turn concluded, kept rather than
        // dropped: it is the only statement any of them makes about the turn as
        // a whole, and without it the badge is left inferring one from whichever
        // steps inside it went wrong (issue #74).
        const outcome = turnOutcomeOf(event.stopReason);
        // Against the turn the messages are actually filed under, which is the
        // one this app opened rather than the name the runtime ends it by — see
        // `msg_start`. Comparing the runtime's own id here stamped the outcome
        // onto nothing at all.
        const ended = state.currentTurnId ?? event.turnId;
        for (const message of state.messages) {
          if (message.turnId === ended) {
            message.streaming = false;
            message.turnOutcome = outcome;
          }
        }
        // And the calls inside it that never reported an ending (#139). Inside
        // `!event.stale` on purpose: an interrupt-to-redirect acknowledges the
        // half it abandoned and the turn is still running, so nothing in it has
        // stopped reporting yet.
        settleUnreportedTools(state, ended, false);
        state.currentTurnId = null;
      }
      if (event.usage) {
        state.usage = mergeUsage(state.usage, event.usage);
      }
      if (event.models && event.models.length > 0) {
        state.turnModels = event.models.map((entry) => entry.model);
        // The header takes the model that answered — the one the messages of
        // this turn already carry — and only falls back to the busiest of the
        // reported models when nothing said. Preferring the report outright
        // would rename a claude conversation from what its messages say to the
        // billing alias beside it, which is the same name twice and reads as a
        // model switch nobody made.
        const answered = state.messages.find(
          (message) => message.turnId === event.turnId && message.role === 'assistant' && message.model,
        );
        state.model = answered?.model
          ?? [...event.models].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))[0].model;
        // A message that never carried one gets the answer this turn produced,
        // so scrolling back does not show a blank where the record has a name.
        if (state.turnModels.length === 1) {
          for (const message of state.messages) {
            if (message.turnId === event.turnId && message.role === 'assistant' && !message.model) {
              message.model = state.turnModels[0];
            }
          }
        }
      }
      return { messageIndex: null, structural: true, meta: true, applied: true };
    }

    default:
      return NO_CHANGE;
  }
}
