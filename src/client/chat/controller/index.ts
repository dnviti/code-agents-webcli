import { ChatControllerLifecycle } from './lifecycle.js';
import { ChatControllerOptions } from './types.js';

/**
 * One conversation's half of the socket.
 *
 * Sits where MessageHandler sits for the terminal: it owns the transcript,
 * applies what arrives, and is the only thing that speaks chat messages to the
 * server for its session. React never touches the socket — it subscribes to the
 * transcript and renders, which is the same split the rest of this client uses.
 *
 * Scoped to a single session id, fixed at construction. There used to be one
 * controller for the whole page, which meant a second chat tab hydrated the one
 * transcript with its own conversation and the first tab went blank while its
 * agent kept working. Sessions are addressed rather than swapped now; see
 * ChatRegistry.
 */
export class ChatController extends ChatControllerLifecycle {
  constructor(
    readonly sessionId: string,
    protected readonly options: ChatControllerOptions,
  ) {
    super();
    // Standalone controllers predate feature negotiation and are still useful
    // in embedders/tests. The registry passes an explicit false before a real
    // socket has completed its handshake, so production never guesses.
    this.builtInWorkflows = options.builtInWorkflows ?? true;
  }
}
