import { ChatEvent } from '../chat-events.js';
import { applyMessage } from './apply-message.js';
import { applyMeta } from './apply-meta.js';
import { applyQuestion } from './apply-question.js';
import { applyState } from './apply-state.js';
import { applyTool } from './apply-tool.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * Apply one event.
 *
 * Events at or below the cursor are dropped rather than reapplied: a browser
 * that reconnects mid-turn receives a snapshot and then the tail, and the two
 * legitimately overlap. Making apply idempotent here is what lets the socket
 * layer stay simple about that overlap.
 */
export function applyChatEvent(state: TranscriptState, event: ChatEvent): TranscriptChange {
  if (event.seq !== undefined && event.seq <= state.cursor) {
    return NO_CHANGE;
  }
  if (event.seq !== undefined) {
    state.cursor = event.seq;
  }

  switch (event.t) {
    case 'session':
    case 'capabilities':
    case 'effort':
    case 'limits':
    case 'plan':
    case 'usage':
      return applyMeta(state, event);
    case 'msg_start':
    case 'block_start':
    case 'block_delta':
    case 'block_end':
    case 'msg_end':
      return applyMessage(state, event);
    case 'tool':
    case 'agent_step':
    case 'agent_progress':
    case 'workflow_progress':
    case 'workflow_failed':
      return applyTool(state, event);
    case 'permission':
    case 'permission_resolved':
    case 'question':
    case 'question_resolved':
    case 'question_continuation_dispatching':
    case 'question_continuation_pending':
    case 'question_continuation':
      return applyQuestion(state, event);
    case 'state':
    case 'error':
    case 'marker':
    case 'turn_end':
      return applyState(state, event);
    default:
      return NO_CHANGE;
  }
}

/** Convenience for replaying a whole log, e.g. when building a snapshot. */
export function applyAll(state: TranscriptState, events: ChatEvent[]): TranscriptState {
  for (const event of events) {
    applyChatEvent(state, event);
  }
  return state;
}
