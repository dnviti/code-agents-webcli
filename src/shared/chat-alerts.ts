/**
 * What an event in a conversation means for somebody who is not looking at it.
 *
 * The terminal side of this app decides an agent has finished because nothing
 * has been printed for ninety seconds, or because a line went past that matched
 * `/tests? passed/i` — see `checkForCommandCompletion` in
 * `src/client/sessions/tab-manager.ts`. A conversation never has to guess. It
 * knows when a turn ended, it knows how the runtime said it ended, and it knows
 * when it has stopped dead because only a person can move it. So this reads the
 * events themselves and nothing else: no timers, no silence, no text matching.
 *
 * Pure, and beside `turn-outcome.ts` rather than in the client, for two
 * reasons. The decision is worth testing against the recorded adapter output
 * under `test/fixtures/chat` without a browser anywhere near it; and the same
 * question has to be answered on the server the day these are delivered by web
 * push, when the browser that would have noticed is asleep.
 *
 * Deliberately *not* derived from `ChatState`. Three of the five runtime
 * families emit no `state` event at the end of a turn — for claude, ACP (kimi,
 * omp, grok) and codex in app-server mode, `turn_end` is the only thing on the
 * wire that says the work is over — and codex never emits
 * `awaiting_permission` at all, only the `permission` event that caused it. A
 * watcher built on the state stream would silently never fire for most of the
 * agents this app supports.
 */

import type { ChatEvent } from './chat-events.js';
import { turnOutcomeOf } from './turn-outcome.js';

/**
 * The four things worth interrupting somebody for.
 *
 * `approval` and `question` stay apart because they are answered differently
 * and read differently — the app is gating the agent in one and the agent is
 * asking the person something in the other — and because the user can switch
 * them on and off separately. The header chip makes the same distinction; see
 * `STATE_META` in `SessionHeader.tsx`.
 */
export type ChatAlertKind = 'finished' | 'failed' | 'approval' | 'question';

/**
 * The alert kinds that are also a lasting state, rather than a moment.
 *
 * A finished turn is over as soon as it is read; a conversation waiting for an
 * approval goes on waiting until somebody answers it. Only the second kind can
 * be shown on a tab the user is not in, which is what this names.
 */
export type ConversationAttention = Extract<ChatAlertKind, 'approval' | 'question'>;

export interface ChatAlert {
  kind: ChatAlertKind;
  /**
   * A fragment of what happened — the command being approved, the question, the
   * error — for a notification that is allowed to say. Never required: the user
   * can reduce every notification to the bare fact that one is needed.
   */
  detail?: string;
  /**
   * What failed, when it was not the turn.
   *
   * A workflow outlives the turn that launched it, so "the turn failed" is the
   * wrong sentence for one: the turn it came from finished, cleanly, minutes
   * ago. Left unset everywhere else, where the turn is exactly what failed.
   */
  subject?: string;
  /**
   * True when the conversation is stopped until somebody answers.
   *
   * The difference matters after the notification: a blocked conversation goes
   * on being blocked, so its mark inside the app has to survive being glanced
   * at, while "finished" is over the moment it is read.
   */
  blocking: boolean;
}

/**
 * The alert this event raises, or null for the overwhelming majority that raise
 * none.
 *
 * Called for every event of every conversation the browser is watching, so the
 * order here is the order events actually arrive in: tokens and tool patches
 * fall out on the first comparison.
 */
export function alertForEvent(event: ChatEvent): ChatAlert | null {
  switch (event.t) {
    case 'permission':
      return { kind: 'approval', detail: event.request.title, blocking: true };

    case 'question':
      return {
        kind: 'question',
        detail: event.request.header || event.request.question,
        blocking: true,
      };

    case 'turn_end': {
      // An interrupt acknowledgement, not a finish. Sending a message ahead of
      // the queue ends the runtime's own run while the turn carries on with the
      // new instruction, and the server marks that `stale` precisely so nothing
      // downstream reads it as the work being over. Announcing it would fire
      // "finished" every time somebody steers a running agent.
      if (event.stale) return null;
      return turnOutcomeOf(event.stopReason) === 'failed'
        ? { kind: 'failed', detail: event.stopReason, blocking: false }
        : { kind: 'finished', detail: undefined, blocking: false };
    }

    case 'error':
      // A runtime that dies emits this and never emits `turn_end` at all, so a
      // notifier that only watched turn endings would miss the one case the
      // user most wants to hear about. Non-fatal errors are left alone: they
      // are things the agent says and then carries on past.
      return event.fatal ? { kind: 'failed', detail: event.message, blocking: false } : null;

    case 'workflow_failed':
      // The case the turn-ending rules above cannot cover. A background
      // workflow's turn ends `end_turn`, successfully, while the run goes on
      // for another twenty minutes — so nothing about how the turn concluded
      // will ever say the work failed, and somebody in another conversation
      // would never find out (#140).
      return {
        kind: 'failed',
        detail: event.reason,
        subject: event.name ? `The workflow "${event.name}"` : 'A workflow',
        blocking: false,
      };

    default:
      return null;
  }
}

/**
 * Whether this event means an outstanding alert no longer stands.
 *
 * Two ways for that to happen: the block was answered, or the conversation
 * started moving again. The second matters more than it looks — a resolved
 * approval is followed by no `state` event on most runtimes (the reducer works
 * the state out for itself), so a mark cleared only on explicit resolution
 * would survive on a conversation that had long since gone back to work.
 */
export function endsAlert(event: ChatEvent): boolean {
  switch (event.t) {
    case 'permission_resolved':
    case 'question_resolved':
      return true;
    case 'state':
      return event.state === 'thinking' || event.state === 'running' || event.state === 'starting';
    case 'msg_start':
      // The person is plainly here, whatever the conversation was waiting for.
      return event.role === 'user';
    default:
      return false;
  }
}
