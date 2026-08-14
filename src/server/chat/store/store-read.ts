import { applyChatEvent, createTranscript } from '../../../shared/chat-reducer.js';
import { openTurnBefore } from '../../../shared/turn-boundaries.js';
import { ChatSnapshot } from '../../../shared/chat-events.js';
import {
  ChatPage,
  ChatSessionRef,
  ChatSnapshotOptions,
  ChatStats,
  SessionState,
} from './store-types.js';
import { ChatStoreAppend } from './store-append.js';

export abstract class ChatStoreRead extends ChatStoreAppend {
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
        return { ...stats, events: [], from: start, openTurnId: null };
      }

      const events = await this.readSlice(base, state, start, end);
      const boundaries = await this.turnBoundaries(base, state, stats);
      return { ...stats, events, from: start, openTurnId: openTurnBefore(boundaries, start) };
    });
  }

  /**
   * Replay of a session, capped to its most recent messages.
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

      const { from: windowStart, events } = await this.replayTail(base, state, stats);

      // Which turn is open is told to the replay rather than worked out by it.
      //
      // A tail cannot work it out. It routinely begins inside a turn whose
      // opening message the window cut, so replayed cold that turn's messages
      // are filed under the runtime's own id for it — a row in the index with
      // no prompt to name it by, and one the recorded index cannot be matched
      // against to repair. Nor is a single seed at the edge enough: the events
      // carried from before the window include a compaction or interruption
      // line, which *is* a message, and the turns opened between them were cut
      // away, so a fold across that stretch loses the thread again.
      //
      // The boundaries are the whole log's answer for every seq, so each event
      // is applied against the turn that was open when it happened, and the
      // replay lands exactly where a full one would.
      const boundaries = await this.turnBoundaries(base, state, stats);
      // Seeded with what the conversation recorded rather than with nothing,
      // for the same reason its usage is taken from the log: the window cannot
      // be a basis for a fact about the session. Anything the window does carry
      // is applied over this and lands on the same answer.
      const reports = await this.sessionRuntimeReports(base, state, stats);
      const recoverableQuestions = await this.recoverableQuestionState(base, state, stats);
      const transcript = createTranscript({ ...reports.capabilities }, { limits: reports.limits });
      let at = 0;
      let open: string | null = null;
      for (const event of events) {
        while (at < boundaries.length && boundaries[at].seq < event.seq) {
          open = boundaries[at].turnId;
          at += 1;
        }
        transcript.currentTurnId = open;
        applyChatEvent(transcript, event);
      }

      return {
        sessionId: session.id,
        runtime: options.runtime ?? '',
        messages: transcript.messages,
        state: transcript.state,
        capabilities: transcript.capabilities,
        // From the whole conversation, not from the replayed tail. What a
        // session has spent is a property of the session, and the tail is a
        // window over its last forty messages: taking it from the transcript
        // meant a long chat's meter fell to whatever the window happened to
        // contain the moment the browser reconnected, switched tab or
        // reloaded — a total that only ever went *down* while the user was
        // still in the same conversation.
        usage: await this.sessionUsage(base, state, stats),
        plan: transcript.plan,
        pendingPermissions: transcript.pendingPermissions,
        // Structured question handoffs do not have a live tool promise. They
        // are deliberately recoverable from the log so a server restart while
        // the user is away does not turn the card into a dead control.
        pendingQuestions: recoverableQuestions.pendingQuestions,
        pendingQuestionContinuations: recoverableQuestions.continuations,
        questionHistory: transcript.questionHistory,
        // What was picked, for the questions that have been answered (#113).
        // The replay above folds `question_resolved` the same way a browser
        // does, and the answer sits between the same two message starts as the
        // call that asked — so any window holding the card holds its answer.
        answeredQuestions: transcript.answeredQuestions,
        // And which of them nobody was ever offered the chance to answer, so a
        // rejoin does not redraw an abandoned card as a skipped one.
        abandonedQuestions: transcript.abandonedQuestions,
        // And what was typed for the ones answered in free text, which is the
        // only place that sentence exists for a card the browser is rebuilding.
        answeredQuestionText: transcript.answeredQuestionText,
        firstSeq: stats.firstSeq,
        replayFrom: windowStart,
        cursor: stats.cursor,
        // Where the replay left off, so live events arriving after this join
        // continue the turn they belong to instead of opening one of their own
        // under the runtime's name for it.
        currentTurnId: transcript.currentTurnId,
        // Replayed out of the log along with everything else, so a rejoin knows
        // what the runtime said it was thinking at even when nobody ever chose
        // a level for this conversation.
        effort: transcript.effort,
        // Same reasoning as `usage` and `capabilities`: read from the whole
        // log, not from the replayed tail. A five-hour window stated at the top
        // of a long conversation is hundreds of events above the window, and
        // taken from the tail alone every rejoin came back claiming the runtime
        // had never reported one (#137).
        limits: transcript.limits,
        live: options.live ?? false,
        bypassPermissions: options.bypassPermissions ?? false,
      };
    });
  }

}
