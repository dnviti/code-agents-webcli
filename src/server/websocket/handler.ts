import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'http';
import { WebSocketInfo, SessionRecord, AuthContext } from '../types.js';
import { MessageProcessor } from './messages.js';

export interface WebSocketHandlerDeps {
  dev: boolean;
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  getAuthContext(message: IncomingMessage): AuthContext;
}

/**
 * Optional protocol extensions this build understands.
 *
 * Add a name here when a client would otherwise have to guess whether a message
 * is supported. Names are permanent once shipped: a client checks for the
 * string, so renaming one silently turns the feature off for every page that
 * has not been reloaded.
 */
export const SERVER_FEATURES = [
  // Watch several chat sessions on one socket, so a background conversation
  // keeps streaming while the user is looking at a different tab.
  'chat_subscribe',
  // Carry the unsent composer — the half-typed prompt and the files already
  // attached to it — between every screen the account has open (#163).
  'chat_draft',
] as const;

export class WebSocketHandler {
  private deps: WebSocketHandlerDeps;
  private messageProcessor: MessageProcessor;

  constructor(deps: WebSocketHandlerDeps, messageProcessor: MessageProcessor) {
    this.deps = deps;
    this.messageProcessor = messageProcessor;
  }

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    try {
      this.setupConnection(ws, req);
    } catch (error) {
      // This runs inside the ws 'connection' listener, where a throw is
      // uncaught and fatal. Close the socket instead of the process.
      console.error('Failed to set up WebSocket connection:', error);
      try {
        ws.close(1011, 'Internal error');
      } catch {
        // Socket already gone.
      }
    }
  }

  private setupConnection(ws: WebSocket, req: IncomingMessage): void {
    const authContext = this.deps.getAuthContext(req);
    if (!authContext.user) {
      ws.close(4401, 'Authentication required');
      return;
    }

    const wsId = randomUUID();
    const url = new URL(req.url || '', 'ws://localhost');
    const claudeSessionId = url.searchParams.get('sessionId');

    if (this.deps.dev) {
      console.log(`New WebSocket connection: ${wsId}`);
      if (claudeSessionId) {
        console.log(`Joining Claude session: ${claudeSessionId}`);
      }
    }

    const wsInfo: WebSocketInfo = {
      id: wsId,
      ws,
      userId: authContext.user.id,
      githubLogin: authContext.user.githubLogin,
      claudeSessionId: null,
      chatSessionIds: new Set<string>(),
      created: new Date(),
    };
    this.deps.webSocketConnections.set(wsId, wsInfo);

    ws.on('message', async (message: WebSocket.RawData) => {
      try {
        const data = JSON.parse(message.toString());
        await this.messageProcessor.handleMessage(wsId, data);
      } catch (error) {
        if (this.deps.dev) {
          console.error('Error handling message:', error);
        }
        sendToWebSocket(ws, {
          type: 'error',
          message: 'Failed to process message',
        });
      }
    });

    ws.on('close', () => {
      if (this.deps.dev) {
        console.log(`WebSocket connection closed: ${wsId}`);
      }
      this.cleanupConnection(wsId);
    });

    ws.on('error', (error: Error) => {
      if (this.deps.dev) {
        console.error(`WebSocket error for connection ${wsId}:`, error);
      }
      this.cleanupConnection(wsId);
    });

    // Send initial connection message.
    //
    // `features` is what lets a page newer than the server it is talking to
    // stay quiet about it. The server answers an unrecognised message with a
    // visible error — deliberately, because silence used to leave the browser
    // waiting forever — so a client that simply sent every message it knew
    // about would turn a routine version gap into an error toast per chat tab.
    // Advertised rather than inferred: the client asks for nothing it has not
    // been told is there.
    sendToWebSocket(ws, {
      type: 'connected',
      connectionId: wsId,
      features: SERVER_FEATURES,
    });

    // If sessionId provided, auto-join that session. joinSession is async and
    // reads the transcript from disk: an unhandled rejection here would take
    // the whole process down.
    if (claudeSessionId) {
      if (this.deps.claudeSessions.has(claudeSessionId)) {
        void this.messageProcessor.joinSession(wsId, claudeSessionId).catch((error) => {
          console.error(`Failed to auto-join session ${claudeSessionId}:`, error);
          sendToWebSocket(ws, {
            type: 'error',
            message: 'Failed to join session',
          });
        });
      } else {
        // Tell the client instead of silently leaving it attached to nothing:
        // after a server restart the reconnect would otherwise look successful
        // while the terminal stayed dead.
        sendToWebSocket(ws, {
          type: 'session_gone',
          sessionId: claudeSessionId,
          message: 'This session no longer exists.',
        });
      }
    }
  }

  cleanupConnection(wsId: string): void {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    wsInfo.chatSessionIds.clear();

    // Remove from session if joined
    if (wsInfo.claudeSessionId) {
      const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
      if (session) {
        session.connections.delete(wsId);
        session.lastActivity = new Date();

        if (session.connections.size === 0 && this.deps.dev) {
          console.log(`No more connections to session ${wsInfo.claudeSessionId}`);
        }
      }
    }

    this.deps.webSocketConnections.delete(wsId);
  }
}

/**
 * Send a JSON message to a WebSocket if it is open.
 */
export function sendToWebSocket(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Send a message to every socket belonging to one user.
 *
 * Session-agnostic, unlike broadcastToSession: update output is addressed to a
 * person, not to a terminal, and must not reach anybody else.
 */
export function sendToUser(
  userId: number,
  data: Record<string, unknown>,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  for (const wsInfo of webSocketConnections.values()) {
    if (wsInfo.userId === userId) {
      sendToWebSocket(wsInfo.ws, data);
    }
  }
}

/**
 * Tell every screen a user has open that one of their sessions now exists.
 *
 * Addressed to the person rather than to the session, and that is the whole
 * point: nobody is watching a session that was created a millisecond ago, so
 * anything routed through `session.connections` or `chatSessionIds` reaches
 * exactly the one socket that asked for it — which is how a conversation
 * started on a laptop stayed invisible on the phone until someone reloaded.
 *
 * Idempotent by design. The same fact is announced again when the session
 * changes surface, and the socket that created it hears it alongside its own
 * `session_created`; the client folds a repeat into the tab it already has.
 *
 * A shell opened *inside* a conversation is deliberately not announced. It is a
 * real session, but it is reached through its conversation and only there —
 * exactly the reason `/api/sessions/list` leaves it out — so announcing it would
 * put a top-level tab in front of every screen for something that has no
 * business being one.
 */
export function announceSessionOpened(
  session: SessionRecord,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  // A runtime relaunch re-announces its metadata through this same helper. That
  // must not turn a conversation the account closed back into a tab; only the
  // explicit tab-open route changes this durable state.
  if (session.ownerSessionId || session.tabOpen === false) return;

  sendToUser(
    session.ownerUserId,
    {
      type: 'session_opened',
      sessionId: session.id,
      name: session.name,
      customName: session.customName ?? null,
      workingDir: session.workingDir,
      projectId: session.projectId,
      surface: session.surface || 'terminal',
      active: session.active,
      // So a conversation that appears on a second screen states the mode it is
      // really in from its first paint, the same way a tab restored on page
      // load does.
      bypassPermissions: session.chatBypassPermissions === true,
    },
    webSocketConnections,
  );
}

/**
 * Tell every screen belonging to an account to remove one tab.
 *
 * Distinct from `announceSessionClosed`: a tab close preserves the conversation,
 * transcript, runtime and any shells it owns. A client that treated this as
 * `session_deleted` would erase local conversation state for a record that is
 * still available from the conversation list.
 */
export function announceSessionTabClosed(
  session: SessionRecord,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  if (session.ownerSessionId) return;

  sendToUser(
    session.ownerUserId,
    {
      type: 'session_tab_closed',
      sessionId: session.id,
    },
    webSocketConnections,
  );
}

/** Tell only this account's screens the authoritative order of its open tabs. */
export function announceSessionTabsReordered(
  userId: number,
  sessionIds: string[],
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  sendToUser(
    userId,
    {
      type: 'session_tabs_reordered',
      sessionIds,
    },
    webSocketConnections,
  );
}

/**
 * Tell every screen a user has open that one of their sessions has gone.
 *
 * Same reasoning as the open, and the same bug in reverse: a delete used to be
 * announced down `session.connections`, which holds the sockets *driving* the
 * session. A second device with the tab in its strip but its eyes on another
 * one is not in there, so it kept offering a session that no longer existed.
 */
export function announceSessionClosed(
  session: SessionRecord,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  sendToUser(
    session.ownerUserId,
    {
      type: 'session_deleted',
      sessionId: session.id,
      message: 'Session has been deleted',
    },
    webSocketConnections,
  );
}

/**
 * Tell every screen whether a session is working right now.
 *
 * A terminal's tab goes bright because output is flowing, and output only ever
 * reached the socket attached to that session — so the same session read as
 * "working" on one screen and "idle" on every other. This carries the fact
 * itself rather than the bytes: the screens that are not attached have nothing
 * to draw with the output and every reason to know it happened.
 */
export function announceSessionActivity(
  session: SessionRecord,
  active: boolean,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  if (session.ownerSessionId) return;

  sendToUser(
    session.ownerUserId,
    {
      type: 'session_activity',
      sessionId: session.id,
      active,
    },
    webSocketConnections,
  );
}

/** Send a message to every connected client, whatever session they are in. */
export function broadcastToAllConnections(
  data: Record<string, unknown>,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  for (const wsInfo of webSocketConnections.values()) {
    sendToWebSocket(wsInfo.ws, data);
  }
}

/**
 * Deliver a chat message to every socket watching that conversation.
 *
 * Deliberately not routed through `session.connections`: that set records who
 * is *driving* the session, and a browser with three chat tabs open is driving
 * at most one of them. Chat events are session-tagged and land in a per-session
 * transcript on the client, so anyone who asked to watch can safely receive
 * them — which is the whole of what makes a background tab keep up rather than
 * going quiet until it is focused again.
 *
 * Ownership is still enforced: a socket only ever gets into `chatSessionIds`
 * for a session it owns (see MessageProcessor.subscribeChat), and the check is
 * repeated here so a stale entry cannot outlive the ownership that put it there.
 */
export function broadcastChat(
  claudeSessionId: string,
  data: Record<string, unknown>,
  claudeSessions: Map<string, SessionRecord>,
  webSocketConnections: Map<string, WebSocketInfo>,
): void {
  const session = claudeSessions.get(claudeSessionId);

  for (const wsInfo of webSocketConnections.values()) {
    const watching =
      wsInfo.chatSessionIds.has(claudeSessionId) || wsInfo.claudeSessionId === claudeSessionId;
    if (!watching) continue;
    if (session && session.ownerUserId !== wsInfo.userId) continue;
    sendToWebSocket(wsInfo.ws, data);
  }
}

/**
 * Broadcast a message to all WebSocket connections in a session.
 */
export function broadcastToSession(
  claudeSessionId: string,
  data: Record<string, unknown>,
  claudeSessions: Map<string, SessionRecord>,
  webSocketConnections: Map<string, WebSocketInfo>
): void {
  const session = claudeSessions.get(claudeSessionId);
  if (!session) return;

  session.connections.forEach((wsId) => {
    const wsInfo = webSocketConnections.get(wsId);
    if (
      wsInfo &&
      wsInfo.claudeSessionId === claudeSessionId &&
      wsInfo.ws.readyState === WebSocket.OPEN
    ) {
      sendToWebSocket(wsInfo.ws, data);
    }
  });
}
