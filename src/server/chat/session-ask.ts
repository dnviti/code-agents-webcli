/*
 * ChatSessionAsk: question (ask) machinery: note/claim, handoffs, request building, answer, abandon.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionPermissions } from './session-permissions.js';
import * as path from 'path';
import * as crypto from 'crypto';
import { looksLikeAskCall, askedQuestionFrom, QuestionRequest, normalizeQuestionOptions, QuestionContinuation } from '../../shared/chat-events.js';
import { QuestionAsk, QuestionReply } from './permission-broker.js';
import { PendingQuestion, PendingToolQuestion } from './session-types.js';
export abstract class ChatSessionAsk extends ChatSessionPermissions {
  protected noteAskCall(toolId: string, name: string | undefined, input: unknown): void {
    const existing = this.askCalls.find((call) => call.toolId === toolId);
    if (!existing && !looksLikeAskCall(name, input)) return;

    const question = askedQuestionFrom(input)?.question;
    if (existing) {
      if (question) existing.question = question;
      return;
    }
    this.askCalls.push({ toolId, question });
  }

  /**
   * Which announced call a question belongs to, if any.
   *
   * Claimed as it is answered, so a second question cannot attach itself to the
   * same block — two cards in one place, one of them unanswerable, is worse than
   * one card in the pinned fallback.
   */

  protected claimAskCall(question: string): string | undefined {
    // Newest text match wins; see the note on `askCalls` for why a retry makes
    // that the right end to start from.
    for (let at = this.askCalls.length - 1; at >= 0; at -= 1) {
      if (this.askCalls[at].question === question) {
        return this.askCalls.splice(at, 1)[0].toolId;
      }
    }
    // Nothing matched on text — a runtime that reports no arguments, or reports
    // them in a shape nothing here parses. Order is the fallback, oldest first.
    return this.askCalls.shift()?.toolId;
  }

  /**
   * A question from the model, on its way to a person.
   *
   * The promise is the tool call: it resolves when someone clicks, and the MCP
   * server does not answer the runtime until it does. Everything here is
   * defensive about shape because the payload is whatever the model wrote — a
   * question with no options is a question nobody can answer, and coming back
   * with an error the model can read is better than putting an empty card on
   * screen and blocking the turn behind it.
   */

  protected askQuestion(ask: QuestionAsk, signal?: AbortSignal): Promise<QuestionReply> {
    const built = this.buildQuestionRequest(ask, 'tool');
    if ('error' in built) {
      return Promise.resolve({ labels: [], error: built.error });
    }
    if (!this.acceptingQuestionTransitions) {
      return Promise.resolve({ labels: [], error: 'the session was stopped' });
    }

    return new Promise<QuestionReply>((resolve) => {
      const { request } = built;
      this.questions.set(request.requestId, {
        kind: 'tool',
        request,
        resolve,
        phase: 'open',
      });
      // This path owns a live tool waiter and has to expose it synchronously:
      // the broker can cancel in the same tick. Its resolution/termination is
      // still serialised and durable; a cold restart reconciles the unresumable
      // opener as abandoned.
      this.ingest({ t: 'question', request });
      this.setState('awaiting_answer');
      signal?.addEventListener(
        'abort',
        () => { void this.abandonQuestion(request.requestId, 'the agent stopped waiting for an answer'); },
        { once: true },
      );
    });
  }

  /**
   * Open a question after the model has deliberately ended its turn.
   *
   * There is no promise to keep alive: origin plus the request itself are the
   * continuation record, which is why this variant can be reconstructed after
   * a server restart while a blocked MCP call cannot.
   */

  protected async openHandoffQuestion(ask: QuestionAsk): Promise<QuestionReply | null> {
    const built = this.buildQuestionRequest(ask, 'structured_handoff');
    if ('error' in built) return { labels: [], error: built.error };
    // Admission is decided before the FIFO yields. Stop waits for work already
    // admitted and rejects only calls that arrive after its synchronous gate.
    if (!this.acceptingQuestionTransitions) {
      return { labels: [], error: 'the session was stopped' };
    }
    return this.mutateQuestions(async () => {
      const { request } = built;
      try {
        // A browser must not receive an indefinitely actionable card until the
        // request is in the restart log that will rebuild that same card.
        await this.ingest({ t: 'question', request }, true);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { labels: [], error: `the question could not be saved: ${detail}` };
      }
      this.questions.set(request.requestId, {
        kind: 'structured_handoff',
        request,
        phase: 'open',
      });
      this.setState('awaiting_answer');
      return null;
    });
  }

  /** Put every question lifecycle commit behind one per-session boundary. */

  protected mutateQuestions<T>(operation: () => Promise<T>): Promise<T> {
    // The first operation starts synchronously. Besides avoiding a needless
    // tick, this preserves invocation order against a store snapshot requested
    // immediately after opening a handoff: append is enqueued before snapshot.
    const queued = new Promise<T>((resolve, reject) => {
      this.questionTransitionQueue.push({
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.runNextQuestionTransition();
    });
    this.questionTransitionTail = queued.then(() => undefined, () => undefined);
    return queued;
  }


  protected runNextQuestionTransition(): void {
    if (this.questionTransitionRunning) return;
    const next = this.questionTransitionQueue.shift();
    if (!next) return;
    this.questionTransitionRunning = true;
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(next.operation());
    } catch (error: unknown) {
      result = Promise.reject(error);
    }
    void result.then(next.resolve, next.reject).finally(() => {
      this.questionTransitionRunning = false;
      this.runNextQuestionTransition();
    });
  }

  /** Validate one model-authored payload and mint the durable browser request. */

  protected buildQuestionRequest(
    ask: QuestionAsk,
    origin: 'tool' | 'structured_handoff',
  ): { request: QuestionRequest } | { error: string } {
    const question = typeof ask.question === 'string' ? ask.question.trim() : '';
    const options = normalizeQuestionOptions(ask.options);

    if (!question || options.length === 0) {
      return { error: 'the question needs a question and at least one option' };
    }

    const request: QuestionRequest = {
        requestId: `ask-${crypto.randomUUID()}`,
        origin,
        // Claimed, not merely read: a second question must not attach itself to
        // the same tool block, which would draw two cards in one place and
        // leave the later one unanswerable.
        ...(origin === 'tool' ? { toolId: this.claimAskCall(question) } : {}),
        question,
        header: typeof ask.header === 'string' && ask.header.trim() ? ask.header.trim() : undefined,
        multiSelect: ask.multiSelect === true,
        options,
        ts: Date.now(),
    };
    return { request };
  }

  /**
   * Record the answer a browser sent, and hand it to the waiting tool call.
   *
   * Returns false for a question this session does not have, which is what a
   * second browser answering one that has already been answered looks like.
   */

  async answerQuestion(
    requestId: string,
    optionIds: string[],
    skipped = false,
    text?: string,
  ): Promise<boolean> {
    const entry = this.questions.get(requestId);
    if (!entry || entry.phase === 'resolving' || !this.acceptingQuestionTransitions) return false;
    // A handoff may remain durable while its dead process is waiting to be
    // resumed. Do not consume the only answer before there is an adapter able
    // to receive the continuation; the browser acknowledgement tells the user
    // to retry after recovery instead.
    if (entry.kind === 'structured_handoff' && !this.adapter?.alive) return false;

    // First writer claims the request before yielding. A second browser frame
    // therefore loses immediately even while the winner is waiting on disk.
    entry.phase = 'resolving';
    const continuationGeneration = this.questionContinuationGeneration;

    return this.mutateQuestions(async () => {
      // The entry can only disappear ahead of us if a legacy embedding mutated
      // the map directly. Treat that as a stale submission, never a new answer.
      if (this.questions.get(requestId) !== entry) return false;

      // Filtered against the offered options rather than trusted: the ids come
      // from a browser, and the labels they resolve to are about to be handed
      // straight to the model as fact.
      const picked = entry.request.options.filter((option) => optionIds.includes(option.optionId));
      // The one part of an answer that is *not* filtered against the options,
      // because it is by definition not one of them. Bounded at the wire; here
      // it only has to be non-empty to count as having been answered.
      const own = typeof text === 'string' ? text.trim() : '';
      const answered = !skipped && (picked.length > 0 || own.length > 0);

      const reply: QuestionReply = {
        labels: picked.map((option) => option.label),
        text: answered && own ? own : undefined,
        skipped: !answered,
      };
      const continuation: QuestionContinuation | undefined = entry.kind === 'structured_handoff'
        ? {
            continuationId: `continue-${crypto.randomUUID()}`,
            request: {
              ...entry.request,
              options: entry.request.options.map((option) => ({ ...option })),
            },
            answer: {
              optionIds: picked.map((option) => option.optionId),
              labels: [...reply.labels],
              ...(reply.text ? { text: reply.text } : null),
              ...(reply.skipped ? { skipped: true } : null),
            },
          }
        : undefined;
      try {
        await this.ingest({
          t: 'question_resolved',
          requestId,
          toolId: entry.request.toolId,
          optionIds: picked.map((option) => option.optionId),
          text: answered && own ? own : undefined,
          skipped: !answered,
          ...(continuation ? { continuation } : null),
        }, true);
      } catch {
        // No browser saw the resolution and no positive acknowledgement will
        // be sent. The phase rolls back; Stop, if already admitted, will close
        // the still-durable request in FIFO order.
        entry.phase = 'open';
        if (this.state !== 'awaiting_answer') this.setState('awaiting_answer');
        return false;
      }

      // The blocked tool and the continuation are released only after the exact
      // resolution event is on disk. A positive browser acknowledgement can now
      // truthfully mean the submission survived a restart boundary.
      this.questions.delete(requestId);
      if (this.isToolQuestion(entry)) entry.resolve(reply);
      if (continuation) {
        this.questionContinuations.set(continuation.continuationId, continuation);
        queueMicrotask(() => this.dispatchQuestionContinuation(
          continuation.continuationId,
          continuationGeneration,
        ));
      }
      return true;
    });
  }

  /** The pending questions asked by one tool call, usually none or one. */

  protected questionsFor(toolId: string): string[] {
    const ids: string[] = [];
    for (const [requestId, entry] of this.questions) {
      if (entry.request.toolId === toolId) ids.push(requestId);
    }
    return ids;
  }

  /**
   * End the questions a dead tool call was waiting on, and say so.
   *
   * The counterpart to `answerQuestion` for the case where nobody got to
   * answer. The waiting promise is still resolved — the MCP server on the other
   * end of the socket is holding a `tools/call` open, and abandoning it in
   * silence would strand that process rather than the card — but what goes into
   * the transcript is `abandoned`, not `skipped`. The two look identical on
   * screen if you conflate them and they say opposite things about the user.
   */

  protected abandonQuestionsFor(toolId: string, reason = 'the agent stopped waiting for an answer'): void {
    void this.abandonQuestions(reason, (entry) => entry.request.toolId === toolId);
  }

  /** Settle only questions whose live tool caller can no longer exist. */

  protected abandonToolQuestions(reason: string): void {
    void this.abandonQuestions(reason, (entry) => this.isToolQuestion(entry));
  }

  /** A dead, non-resumable runtime can own neither waiters nor an outbox. */

  protected abandonQuestionsAfterUnresumableExit(): void {
    this.questionContinuationGeneration += 1;
    void Promise.allSettled([...this.questionDispatches.values()]).then(() => (
      this.mutateQuestions(async () => {
        for (const [requestId, entry] of [...this.questions]) {
          await this.abandonQuestionNow(
            requestId,
            entry,
            'the runtime conversation could not be resumed',
          );
        }
        await this.abandonQuestionContinuationsNow(
          'the runtime conversation could not be resumed',
        );
      })
    )).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not abandon unresumable questions: ${detail}`);
    });
  }

  /**
   * Recognize both the discriminated shape and the pre-discriminator live
   * waiter shape. The latter cannot be recovered from disk, but it can still
   * exist in an embedding that populated the in-memory map before upgrading.
   */

  protected isToolQuestion(entry: PendingQuestion): entry is PendingToolQuestion {
    return entry.kind === 'tool'
      || typeof (entry as unknown as { resolve?: unknown }).resolve === 'function';
  }

  /** The same for one question, which is how a cancelled call arrives. */

  protected abandonQuestion(requestId: string, reason: string): Promise<void> {
    return this.mutateQuestions(async () => {
      const entry = this.questions.get(requestId);
      if (entry) await this.abandonQuestionNow(requestId, entry, reason);
    });
  }

  /** Batch termination; must not call the public enqueuing helper recursively. */

  protected abandonQuestions(
    reason: string,
    predicate: (entry: PendingQuestion) => boolean = () => true,
  ): Promise<void> {
    return this.mutateQuestions(async () => {
      for (const [requestId, entry] of [...this.questions]) {
        if (predicate(entry)) await this.abandonQuestionNow(requestId, entry, reason);
      }
    });
  }

  /** One durable close while `questionTransitionTail` is held. */

  protected async abandonQuestionNow(
    requestId: string,
    entry: PendingQuestion,
    reason: string,
  ): Promise<void> {
    try {
      await this.ingest({
        t: 'question_resolved',
        requestId,
        toolId: entry.request.toolId,
        optionIds: [],
        abandoned: true,
      }, true);
    } catch (error: unknown) {
      // A tool caller that is already gone must never stay blocked on a logging
      // failure. A handoff stays in memory so a failed Stop can be retried.
      if (this.isToolQuestion(entry)) {
        entry.resolve({ labels: [], error: reason });
        this.questions.delete(requestId);
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: question abandonment was not durable: ${detail}`);
      if (this.isToolQuestion(entry)) return;
      throw error;
    }
    if (this.isToolQuestion(entry)) entry.resolve({ labels: [], error: reason });
    this.questions.delete(requestId);
    // Nothing left to wait for. Said here rather than left to the next event,
    // because a conversation that goes on reporting `awaiting_answer` with no
    // card to answer is one whose composer stays out of the user's way.
    if (this.questions.size === 0 && this.state === 'awaiting_answer') {
      this.setState(this.live ? 'running' : 'idle');
    }
  }

  /**
   * Switch the live process to a different model, for the adapters that can.
   *
   * Only Grok exposes this today — its model is a per-invocation flag it can
   * rewrite for the next turn without a restart. Every other adapter's model
   * is fixed at spawn, so this reports it could not and the caller falls back
   * to the runtime's own `/model` command (best-effort) or to persisting the
   * choice for the next session.
   */
}
