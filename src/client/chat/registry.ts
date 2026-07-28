import { ChatController } from './controller.js';

/**
 * Every chat conversation this browser is watching, one controller each.
 *
 * The page holds a single WebSocket, and the server used to bind that socket to
 * exactly one session — so opening a second chat detached the first, its
 * transcript was overwritten by the new one, and the tab the user came back to
 * was blank even though its agent had never stopped. Sessions are addressed
 * now: every chat message carries a `sessionId`, and this routes it.
 *
 * Controllers outlive tab switches deliberately. Rebuilding one on every switch
 * would mean re-fetching a transcript the browser already has, and would lose
 * the scroll-back a user had paged in.
 */

export interface ChatRegistryOptions {
  send: (message: Record<string, unknown>) => void;
  /**
   * A conversation changed. `sessionId` is which one, so a caller can tell
   * "the visible tab moved" from "a background agent said something".
   */
  onChange: (sessionId: string) => void;
}

/**
 * Messages this registry owns. Anything else belongs to the terminal path.
 *
 * Taken from the controller rather than restated here. A type missing from it
 * is not merely unhandled — it is handed to the terminal's own handler, which
 * does not know what a chat message is, and it disappears without a word. This
 * used to be a second list kept by hand, and it fell three types behind the
 * switch it was meant to mirror.
 */
const CHAT_MESSAGE_TYPES = ChatController.MESSAGE_TYPES;

export class ChatRegistry {
  private readonly controllers = new Map<string, ChatController>();

  /**
   * Whether the server on the other end can watch more than one conversation.
   *
   * Off until the handshake says otherwise. A server that predates this answers
   * an unknown message with a visible error, so asking anyway would replace a
   * quiet, working fallback — one live conversation at a time, exactly as
   * before — with an error toast per tab.
   */
  private multiSession = false;

  constructor(private readonly options: ChatRegistryOptions) {}

  /** Apply the feature list from the server's `connected` message. */
  setFeatures(features: unknown): void {
    const list = Array.isArray(features) ? features : [];
    const next = list.includes('chat_subscribe');
    const gained = next && !this.multiSession;
    this.multiSession = next;
    // A reconnect to an upgraded server: pick up the conversations that were
    // opened while it could not carry them.
    if (gained) this.resubscribeAll();
  }

  get supportsMultiSession(): boolean {
    return this.multiSession;
  }

  /** The controller for a session, created on first use. */
  ensure(sessionId: string): ChatController {
    const existing = this.controllers.get(sessionId);
    if (existing) return existing;

    const controller = new ChatController(sessionId, {
      send: this.options.send,
      onChange: () => this.options.onChange(sessionId),
    });
    this.controllers.set(sessionId, controller);
    return controller;
  }

  get(sessionId: string): ChatController | undefined {
    return this.controllers.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  ids(): string[] {
    return Array.from(this.controllers.keys());
  }

  /**
   * Route a server message to the conversation it names.
   *
   * Returns true for anything on the chat channel, including a message for a
   * session this browser has no controller for — that is a conversation it is
   * not showing, not a message the terminal handler should try to interpret.
   */
  handle(message: Record<string, unknown>): boolean {
    const type = String(message.type || '');
    if (!CHAT_MESSAGE_TYPES.has(type)) return false;

    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
    if (!sessionId) return true;

    // Any chat message may open the conversation, including a delta.
    //
    // A launch emits its `session` event — the one carrying the runtime's
    // capabilities, and with them its slash commands — while `manager.start()`
    // is still running, which is *before* `chat_started` announces the
    // conversation exists. Creating a controller only on the announcement threw
    // that event away, and the composer never learned the runtime had any
    // commands to offer.
    //
    // Safe to open one from anywhere in the stream: the server only sends a
    // conversation's events to a socket that has joined or subscribed to it, so
    // an id arriving here is by construction one this browser asked to watch.
    this.ensure(sessionId).handle(message);
    return true;
  }

  /** Ask the server for live events on a session, and for its transcript. */
  subscribe(sessionId: string): void {
    const controller = this.ensure(sessionId);
    if (this.multiSession) controller.subscribe();
  }

  /** Re-establish every subscription, e.g. after the socket reconnected. */
  resubscribeAll(): void {
    if (!this.multiSession) return;
    for (const controller of this.controllers.values()) {
      controller.subscribe();
    }
  }

  /** Stop following a conversation, e.g. when its tab is closed. */
  drop(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (!controller) return;
    if (this.multiSession) controller.unsubscribe();
    controller.dispose();
    this.controllers.delete(sessionId);
  }
}
