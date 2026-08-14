/**
 * Folds a stream of ChatEvents into a transcript.
 *
 * Deliberately shared: the server runs it to answer "what does this session
 * look like right now" for a joining browser, and the client runs it to apply
 * live deltas on top of that answer. One implementation means the two can never
 * disagree about what the conversation is — a class of bug that is miserable to
 * chase once a reconnect has replayed half a turn.
 *
 * The state is mutated in place rather than rebuilt. A streaming turn produces
 * an event per token, and copying an hour-long transcript per token is not a
 * trade worth making; instead every apply reports which message it touched so
 * the UI can re-render exactly that one. This matches the shape the rest of the
 * client already uses: an imperative core that owns state, React that renders it.
 *
 * This file is a facade: the implementation lives in the `chat-reducer/`
 * subfolder, split into cohesive modules. Every export here is re-exported
 * from that subfolder, so the public surface is unchanged.
 */

export type { TranscriptChange, TranscriptState } from './chat-reducer/types.js';
export { applyAll, applyChatEvent } from './chat-reducer/apply.js';
export { createTranscript, reindexTranscript } from './chat-reducer/core.js';
export { foldCapabilities, foldSessionUsage } from './chat-reducer/fold.js';
export { messageText } from './chat-reducer/text.js';
