/*
 * ChatSessionContinuations: question-continuation and structured-handoff fallback machinery driven by the event stream.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionEvents } from './session-events.js';
import * as crypto from 'crypto';
import * as path from 'path';
import { ChatEvent, planModeDirective, QUESTION_FALLBACK_OPEN } from '../../../shared/chat-events.js';
import { AdapterEvent } from '../adapter.js';
import { QuestionReply } from '../permission-broker.js';
import { QUEUE_READY_TIMEOUT_MS, QUEUE_READY_POLL_MS } from './session-constants.js';
import { responseQuestionEnvelope, cancelledFallbackAnswer, questionFallbackDirective, questionContinuation, stripResponseQuestionEnvelopes } from './session-question-helpers.js';
export abstract class ChatSessionContinuations extends ChatSessionEvents {
  protected capturePlanResponse(event: ChatEvent): string | null {
    if (!this.planMode && !this.questionFallbackEnabled) return null;

    if (event.t === 'msg_start' && event.role === 'assistant') {
      this.planResponseBlocks.set(event.id, new Map());
      return null;
    }
    if (event.t === 'block_start') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks && event.block.kind === 'text') blocks.set(event.index, event.block.text);
      return null;
    }
    if (event.t === 'block_delta') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks?.has(event.index) && event.text) {
        blocks.set(event.index, `${blocks.get(event.index) || ''}${event.text}`);
      }
      return null;
    }
    if (event.t === 'block_end') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      const block = event.block as { kind?: string; text?: unknown } | undefined;
      if (blocks?.has(event.index) && block?.kind === 'text' && typeof block.text === 'string') {
        blocks.set(event.index, block.text);
      }
      return null;
    }
    if (event.t === 'msg_end') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks) {
        this.planResponseBlocks.delete(event.msgId);
        const markdown = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, text]) => text)
          .join('\n\n')
          .trim();
        if (markdown) this.planResponseCandidate = markdown;
      }
      return null;
    }
    if (event.t !== 'turn_end' || event.stale) return null;

    const fallback = this.planResponseCandidate.trim();
    this.planResponseBlocks.clear();
    this.planResponseCandidate = '';
    return fallback || null;
  }


  protected async handleFallbackResponse(markdown: string): Promise<void> {
    const envelope = this.questionFallbackEnabled ? responseQuestionEnvelope(markdown) : null;
    if (envelope) {
      if (!envelope.question) {
        await this.continueAfterFallbackQuestion('', {
          labels: [],
          error: envelope.error || 'the structured question was invalid',
        });
        return;
      }
      const question = envelope.question;
      const prompt = typeof question.question === 'string' ? question.question.trim() : '';
      const error = await this.openHandoffQuestion(question);
      // Invalid envelopes have no card to wait on. Give the runtime the same
      // prose fallback a rejected tool call would have received; valid ones
      // return here and are continued by answerQuestion, possibly after a
      // process restart.
      if (error && !cancelledFallbackAnswer(error)) {
        await this.continueAfterFallbackQuestion(prompt, error);
      }
      return;
    }
    if (this.planMode && !this.planSubmittedThisTurn) {
      const result = await this.submitPlan({ markdown, source: 'response' });
      if (!result.accepted && this.planMode) {
        this.ingest({
          t: 'error',
          message: `The planning response could not become a reviewable plan: ${result.detail} Plan mode is still on; send another planning message to retry.`,
        });
      }
    }
  }


  protected async continueAfterFallbackQuestion(
    question: string,
    answer: QuestionReply,
    generation = this.questionContinuationGeneration,
    continuationId?: string,
  ): Promise<'delivered' | 'deferred' | 'failed'> {
    const adapter = this.adapter;
    if (generation !== this.questionContinuationGeneration) return 'deferred';
    if (!adapter?.alive) {
      this.ingest({
        t: 'error',
        message: 'The question was answered, but the runtime stopped before the answer could be delivered.',
      });
      if (this.state === 'awaiting_answer') this.setState('idle');
      return 'failed';
    }

    this.planSubmittedThisTurn = false;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';
    const continuationTurnId = `turn-${crypto.randomUUID()}`;
    this.turnInFlightId = continuationTurnId;
    this.ownUserMessageId = `internal-${crypto.randomUUID()}`;
    this.droppedUserEchoes.clear();
    const planInstruction = this.planMode
      ? planModeDirective(Boolean(await this.planDocument()))
      : null;
    const questionInstruction = this.questionFallbackEnabled
      ? questionFallbackDirective()
      : null;
    const text = [questionInstruction, planInstruction, questionContinuation(question, answer)]
      .filter(Boolean)
      .join('\n\n');
    // This is a new internal turn just as surely as a composer delivery is.
    // A resumed runtime may still be replaying its own transcript, but the
    // answer and everything it produces must be recorded from this point on.
    this.replaying = false;
    this.setState('thinking');
    try {
      // Codex exec and Antigravity declare the turn complete from stdout while
      // their one-shot child is still exiting. `alive` intentionally remains
      // true between turns, so wait on the adapter's explicit readiness gate
      // before handing it the continuation.
      const deadline = Date.now() + QUEUE_READY_TIMEOUT_MS;
      while (
        generation === this.questionContinuationGeneration
        && this.adapter === adapter
        && adapter.alive
        && adapter.readyForTurn === false
        && Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, QUEUE_READY_POLL_MS));
      }
      // Stop/restart owns the state from this point. Returning silently is what
      // prevents an answer queued a few milliseconds earlier from undoing it.
      if (
        generation !== this.questionContinuationGeneration
        || this.adapter !== adapter
      ) {
        if (this.turnInFlightId === continuationTurnId) {
          this.turnInFlightId = null;
          this.ownUserMessageId = null;
          this.droppedUserEchoes.clear();
        }
        return 'deferred';
      }
      if (!adapter.alive || adapter.readyForTurn === false) {
        throw new Error(`the ${this.runtime || 'agent'} process was not ready for the answer continuation`);
      }
      if (continuationId) {
        let claimed = false;
        try {
          claimed = await this.markQuestionContinuationDispatching(continuationId, generation);
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          this.ingest({
            t: 'error',
            message: `The answer was saved but could not be prepared for delivery: ${detail}`,
          });
          if (this.turnInFlightId === continuationTurnId) this.turnInFlightId = null;
          if (generation === this.questionContinuationGeneration) this.ownUserMessageId = null;
          if (generation === this.questionContinuationGeneration) this.setState('idle');
          return 'deferred';
        }
        if (!claimed) {
          if (this.turnInFlightId === continuationTurnId) this.turnInFlightId = null;
          if (generation === this.questionContinuationGeneration) this.ownUserMessageId = null;
          return 'deferred';
        }
        // The durable write yielded. Stop may have won while it was in flight;
        // in that case the explicit lifecycle path owns the claimed outbox and
        // no runtime call is started behind its back.
        if (
          generation !== this.questionContinuationGeneration
          || this.adapter !== adapter
          || !adapter.alive
          || this.questionStopIntent !== null
        ) {
          // No call to adapter.send has happened, so this process knows the
          // durable claim is not ambiguous. Put it back to pending before a
          // preserving shutdown hands recovery the outbox; otherwise recovery
          // would discard an answer that was provably never sent.
          this.knownUnsentQuestionContinuations.add(continuationId);
          try {
            await this.markQuestionContinuationPending(continuationId);
          } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`chat ${this.ref.id}: could not withdraw unsent continuation claim: ${detail}`);
          }
          if (this.turnInFlightId === continuationTurnId) this.turnInFlightId = null;
          if (generation === this.questionContinuationGeneration) this.ownUserMessageId = null;
          return 'deferred';
        }
      }
      await adapter.send({ text });
      // Once send accepted the turn, a concurrent graceful Stop must record it
      // as delivered rather than leave an outbox entry that a restart repeats.
      return 'delivered';
    } catch (error: unknown) {
      if (this.turnInFlightId === continuationTurnId) this.turnInFlightId = null;
      if (generation === this.questionContinuationGeneration) this.ownUserMessageId = null;
      if (
        generation !== this.questionContinuationGeneration
        || this.adapter !== adapter
        || !adapter.alive
      ) {
        return 'deferred';
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.ingest({ t: 'error', message: `The answer could not be delivered: ${detail}` });
      if (generation === this.questionContinuationGeneration) this.setState('idle');
      return 'failed';
    }
  }

  /**
   * Commit the pre-send boundary for an accepted answer.
   *
   * A cold process that sees this marker cannot know which side of the
   * following runtime call the old process reached. It therefore records an
   * explicit uncertain/abandoned outcome instead of silently issuing a second
   * model turn. Pending entries, which have no marker, remain safe to resume.
   */

  protected markQuestionContinuationDispatching(
    continuationId: string,
    generation: number,
  ): Promise<boolean> {
    return this.mutateQuestions(async () => {
      const continuation = this.questionContinuations.get(continuationId);
      if (
        !continuation
        || continuation.dispatching
        || generation !== this.questionContinuationGeneration
        || this.questionStopIntent !== null
      ) {
        return false;
      }
      await this.ingest({
        t: 'question_continuation_dispatching',
        requestId: continuation.request.requestId,
        continuationId,
      }, true);
      continuation.dispatching = true;
      return true;
    });
  }

  /** Return a claimed outbox to pending while this process still knows no send occurred. */

  protected markQuestionContinuationPending(continuationId: string): Promise<void> {
    return this.mutateQuestions(async () => {
      const continuation = this.questionContinuations.get(continuationId);
      if (!continuation?.dispatching) return;
      await this.ingest({
        t: 'question_continuation_pending',
        requestId: continuation.request.requestId,
        continuationId,
      }, true);
      delete continuation.dispatching;
      this.knownUnsentQuestionContinuations.delete(continuationId);
    });
  }

  /** Start one durable outbox item at most once in this process. */

  protected dispatchQuestionContinuation(
    continuationId: string,
    generation = this.questionContinuationGeneration,
  ): void {
    if (this.questionContinuations.get(continuationId)?.dispatching) return;
    if (this.questionDispatches.has(continuationId)) return;
    const task = this.runQuestionContinuation(continuationId, generation)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: question continuation failed: ${detail}`);
      })
      .finally(() => {
        if (this.questionDispatches.get(continuationId) === task) {
          this.questionDispatches.delete(continuationId);
        }
      });
    this.questionDispatches.set(continuationId, task);
  }

  /**
   * Runtime delivery deliberately lives outside `questionTransitionTail`.
   * Stop can cancel readiness polling without deadlocking behind the process it
   * must tear down; only the outbox's terminal commit re-enters the FIFO.
   */

  protected async runQuestionContinuation(
    continuationId: string,
    generation: number,
  ): Promise<void> {
    const continuation = this.questionContinuations.get(continuationId);
    if (
      !continuation
      || continuation.dispatching
      || this.questionStopIntent !== null
      || generation !== this.questionContinuationGeneration
      || !this.adapter?.alive
    ) {
      return;
    }
    const result = await this.continueAfterFallbackQuestion(
      continuation.request.question,
      {
        labels: [...continuation.answer.labels],
        text: continuation.answer.text,
        skipped: continuation.answer.skipped,
      },
      generation,
      continuationId,
    );
    if (result === 'deferred') return;
    await this.finishQuestionContinuation(
      continuationId,
      result === 'delivered' ? 'delivered' : 'abandoned',
      result === 'failed' ? 'the answer continuation could not be delivered' : undefined,
    );
  }

  /** Commit one outbox terminal record, then and only then forget its payload. */

  protected finishQuestionContinuation(
    continuationId: string,
    outcome: 'delivered' | 'abandoned',
    reason?: string,
  ): Promise<void> {
    return this.mutateQuestions(async () => {
      const continuation = this.questionContinuations.get(continuationId);
      if (!continuation) return;
      // `ingest` stamps this terminal record once and retries those exact
      // bytes. Retrying separate ingest calls changed the timestamp and made a
      // committed-but-unacknowledged first append impossible to recognise.
      await this.ingest({
        t: 'question_continuation',
        requestId: continuation.request.requestId,
        continuationId,
        outcome,
        ...(reason ? { reason } : null),
      }, true, 3);
      this.questionContinuations.delete(continuationId);
      this.knownUnsentQuestionContinuations.delete(continuationId);
      this.drainQueue();
    });
  }

  /** Terminalise all accepted continuations while the question FIFO is held. */

  protected async abandonQuestionContinuationsNow(reason: string): Promise<void> {
    for (const [continuationId, continuation] of [...this.questionContinuations]) {
      await this.ingest({
        t: 'question_continuation',
        requestId: continuation.request.requestId,
        continuationId,
        outcome: 'abandoned',
        reason,
      }, true);
      this.questionContinuations.delete(continuationId);
      this.knownUnsentQuestionContinuations.delete(continuationId);
    }
  }

  /**
   * Hold only text that can still be the structured fallback envelope.
   * Ordinary prose is released as soon as its prefix differs, retaining normal
   * streaming. A recognised envelope is converted into a question event later
   * and never written or broadcast as assistant-facing protocol JSON.
   */

  protected interceptFallbackQuestionText(event: AdapterEvent): boolean {
    if (!this.questionFallbackEnabled) return false;
    const keyOf = (msgId: string, index: number): string => `${msgId}\u0000${index}`;
    const flush = (events: AdapterEvent[]): void => {
      this.flushingFallbackText = true;
      try {
        for (const held of events) this.ingest(held);
      } finally {
        this.flushingFallbackText = false;
      }
    };
    const canStillBeEnvelope = (text: string): boolean => {
      const trimmed = text.trimStart();
      return !trimmed || QUESTION_FALLBACK_OPEN.startsWith(trimmed)
        || trimmed.startsWith(QUESTION_FALLBACK_OPEN);
    };

    if (event.t === 'block_start' && event.block.kind === 'text') {
      const text = event.block.text || '';
      if (!canStillBeEnvelope(text)) return false;
      this.fallbackTextBlocks.set(keyOf(event.msgId, event.index), {
        msgId: event.msgId,
        index: event.index,
        text,
        events: [event],
      });
      return true;
    }

    if (event.t === 'block_delta' || event.t === 'block_end') {
      const key = keyOf(event.msgId, event.index);
      const held = this.fallbackTextBlocks.get(key);
      if (!held) return false;
      held.events.push(event);
      if (event.t === 'block_delta' && event.text) held.text += event.text;
      if (event.t === 'block_end') {
        const text = (event.block as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string') held.text = text;
      }
      if (canStillBeEnvelope(held.text)) return true;
      this.fallbackTextBlocks.delete(key);
      flush(held.events);
      return true;
    }

    if (event.t !== 'msg_end') return false;
    const heldForMessage = [...this.fallbackTextBlocks.entries()]
      .filter(([, held]) => held.msgId === event.msgId)
      .sort(([, left], [, right]) => left.index - right.index);
    if (heldForMessage.length === 0) return false;

    let recognised: string | null = null;
    for (const [key, held] of heldForMessage) {
      this.fallbackTextBlocks.delete(key);
      const envelope = responseQuestionEnvelope(held.text);
      if (!envelope) {
        flush(held.events);
        continue;
      }
      recognised = held.text;
      const visible = stripResponseQuestionEnvelopes(held.text);
      if (visible) {
        flush([{
          t: 'block_start',
          msgId: held.msgId,
          index: held.index,
          block: { kind: 'text', text: visible },
        }]);
      }
    }
    flush([event]);
    // `msg_end` normally derives the candidate from the blocks just flushed.
    // Put the private envelope back only in the server-side candidate after it
    // has been persisted, so fallback handling sees it while the transcript
    // never does.
    if (recognised) this.planResponseCandidate = recognised;
    return true;
  }

  /**
   * Stamp, persist, broadcast.
   *
   * Most streaming events retain the historical fire-and-forget write path.
   * Protocol transitions that are acknowledged as durable pass `durable` and
   * are not broadcast until their exact store write has completed.
   */
}
