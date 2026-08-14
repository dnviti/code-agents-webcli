import { ChatEvent } from '../chat-events.js';
import { foldCapabilities, foldSessionUsage } from './fold.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * The session-level facts that replace or merge directly into known state:
 * capabilities, effort, limits, the plan and the usage total. Each writes a
 * single field (or two) and changes nothing in the message list.
 */
export function applyMeta(state: TranscriptState, event: ChatEvent): TranscriptChange {
  switch (event.t) {
    case 'session': {
      state.capabilities = foldCapabilities(state.capabilities, event);
      if (event.nativeSessionId) state.nativeSessionId = event.nativeSessionId;
      if (event.model) state.model = event.model;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'capabilities': {
      state.capabilities = foldCapabilities(state.capabilities, event);
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'effort': {
      // Cleared rather than left standing when the runtime reports null: it has
      // gone back to its own default, and a stale level on the chip would keep
      // claiming a choice nobody is running any more.
      state.effort = event.effort ?? undefined;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'limits': {
      // Replaced whole, not merged: the adapter accumulates the account picture
      // across a conversation and re-sends all of it, so the newest event is
      // always the complete answer. Merging here would keep a window alive
      // after the provider stopped reporting it.
      state.limits = event.limits;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'plan': {
      state.plan = event.items;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'usage': {
      // Runtimes that report a running total would double-count if summed, so
      // absolute fields overwrite. See `foldSessionUsage` for why only the
      // fields the report actually carries are written.
      state.usage = foldSessionUsage(state.usage, event);
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    default:
      return NO_CHANGE;
  }
}
