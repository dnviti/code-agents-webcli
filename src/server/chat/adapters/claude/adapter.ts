import { ClaudeChatAdapterMessages } from './adapter-messages.js';

/**
 * The Anthropic streaming-JSON adapter (`claude -p --output-format stream-json`).
 *
 * The concrete public class is tiny: all of its implementation lives in a
 * linear inheritance chain of abstract partials — `adapter-base` (fields plus
 * the launch/session/capabilities methods), `adapter-effort` (`/effort`),
 * `adapter-accounting` (cost and usage), and `adapter-messages` (wire-protocol
 * decoding) — which this class closes off. See `claude.ts` for the original
 * design notes on reconciling the stream_event and snapshot tracks.
 */
export class ClaudeChatAdapter extends ClaudeChatAdapterMessages {}

export default ClaudeChatAdapter;
