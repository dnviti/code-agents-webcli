import { ChatController } from './controller.js';
import type { ChatEvent } from '../../shared/chat-events.js';
import { parseQualifiedSessionId } from '../controller/transport.js';

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
  /**
   * One event, as the conversation actually applied it.
   *
   * Separate from `onChange` because the two answer different questions.
   * `onChange` says the surface should redraw and carries no reason, which is
   * all a renderer needs; this carries what happened, which is what deciding
   * whether to interrupt somebody needs — a turn that *ended* is a different
   * fact from a transcript that is now one message longer.
   *
   * Only called for events the transcript accepted. A reconnect replays what
   * the browser already holds, and re-announcing a turn that finished ten
   * minutes ago is exactly the sort of notification that gets the feature
   * switched off.
   */
  onEvent?: (sessionId: string, event: ChatEvent) => void;
  /**
   * This browser's socket id, so a controller can recognise its own composer
   * edits coming back. Read through a function because it arrives with the
   * server's `connected` message and changes on every reconnect.
   */
  origin?: () => string | null;
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
  private defaultFeatures = featureProfile([]);
  /** A controller socket has one handshake per target, so its features do too. */
  private readonly serverFeatures = new Map<string, FeatureProfile>();
  private gatewayConnected = true;
  private readonly disconnectedServers = new Set<string>();

  constructor(private readonly options: ChatRegistryOptions) {}

  /** Apply one server's feature list from its `connected` handshake. */
  setFeatures(features: unknown, serverId?: string): void {
    const previous = serverId ? this.serverFeatures.get(serverId) : this.defaultFeatures;
    const next = featureProfile(features);
    if (serverId) this.serverFeatures.set(serverId, next);
    else this.defaultFeatures = next;
    // Told to the conversations that already exist as well as to the ones built
    // after this: the handshake arrives after a reload has restored its tabs,
    // so the controllers are routinely older than the answer.
    for (const [sessionId, controller] of this.controllers) {
      if ((serverId || null) !== this.serverFor(sessionId)) continue;
      controller.setDraftSync(next.draftSync);
      controller.setBuiltInWorkflowSupport(next.builtInWorkflows);
    }
    // A reconnect to an upgraded server: pick up the conversations that were
    // opened while it could not carry them.
    if (next.multiSession && !previous?.multiSession) this.resubscribeAll(serverId);
  }

  get supportsMultiSession(): boolean {
    return this.defaultFeatures.multiSession;
  }

  private serverFor(sessionId: string): string | null {
    return parseQualifiedSessionId(sessionId)?.serverId || null;
  }

  private featuresFor(sessionId: string): FeatureProfile {
    const serverId = this.serverFor(sessionId);
    return serverId ? this.serverFeatures.get(serverId) || featureProfile([]) : this.defaultFeatures;
  }

  /** The controller for a session, created on first use. */
  ensure(sessionId: string): ChatController {
    const existing = this.controllers.get(sessionId);
    if (existing) return existing;

    const features = this.featuresFor(sessionId);
    const controller = new ChatController(sessionId, {
      send: this.options.send,
      onChange: () => this.options.onChange(sessionId),
      onEvent: (event) => this.options.onEvent?.(sessionId, event),
      origin: this.options.origin,
      builtInWorkflows: features.builtInWorkflows,
    });
    controller.setDraftSync(features.draftSync);
    const serverId = this.serverFor(sessionId);
    if (!this.gatewayConnected || (serverId && this.disconnectedServers.has(serverId))) {
      controller.connectionLost(false);
    }
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

  /** Mark either the whole browser socket or one multiplexed server unavailable. */
  connectionLost(serverId?: string): void {
    if (serverId) this.disconnectedServers.add(serverId);
    else this.gatewayConnected = false;
    for (const [sessionId, controller] of this.controllers) {
      if (serverId && this.serverFor(sessionId) !== serverId) continue;
      controller.connectionLost();
    }
  }

  connectionRestored(serverId?: string): void {
    if (serverId) this.disconnectedServers.delete(serverId);
    else this.gatewayConnected = true;
    for (const [sessionId, controller] of this.controllers) {
      const owner = this.serverFor(sessionId);
      if (serverId && owner !== serverId) continue;
      if (!this.gatewayConnected || (owner && this.disconnectedServers.has(owner))) continue;
      controller.connectionRestored();
    }
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
    if (this.featuresFor(sessionId).multiSession) controller.subscribe();
  }

  /** Re-establish every subscription, e.g. after the socket reconnected. */
  resubscribeAll(serverId?: string): void {
    for (const [sessionId, controller] of this.controllers) {
      if (serverId !== undefined && this.serverFor(sessionId) !== serverId) continue;
      if (!this.featuresFor(sessionId).multiSession) continue;
      controller.subscribe();
    }
  }

  /** Stop following a conversation, e.g. when its tab is closed. */
  drop(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (!controller) return;
    if (this.featuresFor(sessionId).multiSession) controller.unsubscribe();
    controller.dispose();
    this.controllers.delete(sessionId);
  }
}

interface FeatureProfile {
  multiSession: boolean;
  draftSync: boolean;
  builtInWorkflows: boolean;
}

function featureProfile(features: unknown): FeatureProfile {
  const list = Array.isArray(features) ? features : [];
  return {
    multiSession: list.includes('chat_subscribe'),
    draftSync: list.includes('chat_draft'),
    builtInWorkflows: list.includes('chat_builtin_workflow'),
  };
}
