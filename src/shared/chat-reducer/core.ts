import { ChatCapabilities } from '../chat-events.js';
import { TranscriptState } from './types.js';

export function createTranscript(
  capabilities: ChatCapabilities,
  seed?: Partial<TranscriptState>,
): TranscriptState {
  return {
    messages: [],
    index: {},
    toolIndex: {},
    orphanToolPatches: {},
    state: 'starting',
    capabilities,
    usage: {},
    plan: [],
    pendingPermissions: [],
    pendingQuestions: [],
    pendingQuestionContinuations: {},
    questionHistory: [],
    answeredQuestions: {},
    answeredQuestionText: {},
    abandonedQuestions: {},
    firstSeq: 0,
    cursor: 0,
    currentTurnId: null,
    ...seed,
  };
}

/** Rebuild the id/tool lookup tables after messages are loaded wholesale. */
export function reindexTranscript(state: TranscriptState): void {
  state.index = {};
  state.toolIndex = {};
  state.messages.forEach((message, messageIndex) => {
    state.index[message.id] = messageIndex;
    message.blocks.forEach((block, blockIndex) => {
      if (block.kind === 'tool') {
        state.toolIndex[block.toolId] = [messageIndex, blockIndex];
      }
    });
  });
}

export function messageFor(state: TranscriptState, msgId: string): number | null {
  const at = state.index[msgId];
  return at === undefined ? null : at;
}

/**
 * The turn this conversation was last working on, or undefined for one that has
 * said nothing yet. See `openTurnAfter` for what goes back to it.
 */
export function lastTurnId(state: TranscriptState): string | undefined {
  return state.messages[state.messages.length - 1]?.turnId;
}

/**
 * The reply still arriving, or -1.
 *
 * Searched from the end rather than read off it, because the end is not always
 * the reply: a rule drawn across the conversation is pushed there while one is
 * still streaming. Bounded because the answer is always within a message or two
 * of the end — a scan of an hour-long transcript on every error is not.
 */
export function lastStreamingIndex(state: TranscriptState): number {
  const floor = Math.max(0, state.messages.length - 8);
  for (let i = state.messages.length - 1; i >= floor; i -= 1) {
    if (state.messages[i].streaming) return i;
  }
  return -1;
}
