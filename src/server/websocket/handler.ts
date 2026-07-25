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
