import {
  ChatEvent,
  ChatMessage,
} from '../chat-events.js';
import { lastTurnId } from './core.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * Permission and question events, all of which park an actionable card
 * (composer-level or in the transcript) until a resolution removes it.
 */
export function applyQuestion(state: TranscriptState, event: ChatEvent): TranscriptChange {
  switch (event.t) {
    case 'permission': {
      const already = state.pendingPermissions.some(
        (pending) => pending.requestId === event.request.requestId,
      );
      if (!already) {
        state.pendingPermissions.push(event.request);
      }
      state.state = 'awaiting_permission';
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'permission_resolved': {
      state.pendingPermissions = state.pendingPermissions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      if (state.state === 'awaiting_permission' && state.pendingPermissions.length === 0) {
        state.state = 'running';
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'question': {
      const recorded = state.questionHistory.findIndex(
        (question) => question.requestId === event.request.requestId,
      );
      if (recorded < 0) state.questionHistory.push(event.request);
      else state.questionHistory[recorded] = event.request;
      // Durable publication orders the request before its resolution, but a
      // reconnect can still splice an older socket frame around a newer
      // snapshot. Once a resolution owns this key, a late request is history,
      // not a newly actionable card.
      const answerKey = event.request.toolId ?? event.request.requestId;
      const alreadyResolved = Object.prototype.hasOwnProperty.call(
        state.answeredQuestions,
        answerKey,
      );
      const already = state.pendingQuestions.some(
        (pending) => pending.requestId === event.request.requestId,
      );
      if (!already && !alreadyResolved) {
        state.pendingQuestions.push(event.request);
      }
      // Not folded into `awaiting_permission`: the composer, the header and the
      // stop button all read this, and "waiting for approval" over a question
      // about which of three approaches to take is simply the wrong sentence.
      if (!alreadyResolved) state.state = 'awaiting_answer';

      // A normal ask tool already owns its card in the message that contains
      // the call. The structured-response fallback has no tool block at all,
      // so make the question itself a durable block on the assistant response
      // that asked it. The raw private envelope in that response is hidden;
      // this is the readable chronological replacement that survives replay.
      const toolOwnsCard = event.request.toolId
        ? state.toolIndex[event.request.toolId] !== undefined
        : false;
      if (toolOwnsCard) {
        return { messageIndex: null, structural: false, meta: true, applied: true };
      }

      let messageIndex = -1;
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        if (state.messages[i].role === 'assistant') {
          messageIndex = i;
          break;
        }
      }
      if (messageIndex >= 0) {
        const message = state.messages[messageIndex];
        const exists = message.blocks.some(
          (block) => block.kind === 'question'
            && block.request.requestId === event.request.requestId,
        );
        if (!exists) {
          message.blocks.push({
            kind: 'question',
            request: event.request,
            ...(alreadyResolved ? {
              answer: {
                optionIds: [...state.answeredQuestions[answerKey]],
                ...(state.answeredQuestionText[answerKey]
                  ? { text: state.answeredQuestionText[answerKey] }
                  : null),
                ...(state.answeredQuestions[answerKey].length === 0
                  && !state.abandonedQuestions[answerKey]
                  ? { skipped: true }
                  : null),
                ...(state.abandonedQuestions[answerKey] ? { abandoned: true } : null),
              },
            } : null),
          });
        }
        return { messageIndex, structural: false, meta: true, applied: true };
      }

      // Defensive route for a runtime that asks before it has emitted any
      // assistant message. It still gets a transcript row and never falls back
      // to a question that can only be found beside the composer.
      const message: ChatMessage = {
        id: `question-${event.request.requestId}`,
        seq: event.seq,
        turnId: state.currentTurnId ?? lastTurnId(state) ?? `question-${event.seq}`,
        role: 'assistant',
        ts: event.ts,
        blocks: [{
          kind: 'question',
          request: event.request,
          ...(alreadyResolved ? {
            answer: {
              optionIds: [...state.answeredQuestions[answerKey]],
              ...(state.answeredQuestionText[answerKey]
                ? { text: state.answeredQuestionText[answerKey] }
                : null),
              ...(state.answeredQuestions[answerKey].length === 0
                && !state.abandonedQuestions[answerKey]
                ? { skipped: true }
                : null),
              ...(state.abandonedQuestions[answerKey] ? { abandoned: true } : null),
            },
          } : null),
        }],
      };
      state.index[message.id] = state.messages.length;
      state.messages.push(message);
      return {
        messageIndex: state.messages.length - 1,
        structural: true,
        meta: true,
        applied: true,
      };
    }

    case 'question_resolved': {
      const asked = state.pendingQuestions.find((pending) => pending.requestId === event.requestId);
      state.pendingQuestions = state.pendingQuestions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      // Kept after the fact so the card keeps showing what was picked once the
      // request itself is gone, without waiting for the runtime to echo a tool
      // result back.
      const key = event.toolId ?? asked?.toolId ?? event.requestId;
      state.answeredQuestions[key] = event.skipped ? [] : [...event.optionIds];
      // Written both ways round, because a card can resolve twice: a question
      // the agent gave up on and then asked again lands on the same key, and a
      // stale "nobody could answer this" under a freshly answered card would be
      // the same wrong sentence in the other direction.
      if (event.abandoned) {
        state.abandonedQuestions[key] = true;
      } else {
        delete state.abandonedQuestions[key];
      }
      // Written unconditionally rather than only when there is text, so a
      // re-answer — the same key resolving twice, which a retried turn does —
      // cannot leave the previous answer's sentence standing under a card that
      // was answered by clicking this time.
      if (!event.skipped && event.text) {
        state.answeredQuestionText[key] = event.text;
      } else {
        delete state.answeredQuestionText[key];
      }
      // A no-tool fallback owns a real chronological block. Put its outcome on
      // that block as well as in the compatibility lookup maps so snapshots,
      // branches and copied history remain self-contained.
      let resolvedMessageIndex: number | null = null;
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const block = state.messages[i].blocks.find(
          (candidate) => candidate.kind === 'question'
            && candidate.request.requestId === event.requestId,
        );
        if (!block || block.kind !== 'question') continue;
        block.answer = {
          optionIds: [...event.optionIds],
          ...(event.text ? { text: event.text } : null),
          ...(event.skipped ? { skipped: true } : null),
          ...(event.abandoned ? { abandoned: true } : null),
        };
        resolvedMessageIndex = i;
        break;
      }
      if (state.state === 'awaiting_answer' && state.pendingQuestions.length === 0) {
        state.state = 'running';
      }
      if (event.continuation && !event.abandoned) {
        state.pendingQuestionContinuations[event.continuation.continuationId] = {
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
        };
      }
      return {
        messageIndex: resolvedMessageIndex,
        structural: false,
        meta: true,
        applied: true,
      };
    }

    case 'question_continuation_dispatching': {
      const continuation = state.pendingQuestionContinuations[event.continuationId];
      if (continuation) continuation.dispatching = true;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'question_continuation_pending': {
      const continuation = state.pendingQuestionContinuations[event.continuationId];
      if (continuation) delete continuation.dispatching;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'question_continuation': {
      delete state.pendingQuestionContinuations[event.continuationId];
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    default:
      return NO_CHANGE;
  }
}
