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

export class WebSocketHandler {
  private deps: WebSocketHandlerDeps;
  private messageProcessor: MessageProcessor;

  constructor(deps: WebSocketHandlerDeps, messageProcessor: MessageProcessor) {
    this.deps = deps;
    this.messageProcessor = messageProcessor;
  }

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
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

    // Send initial connection message
    sendToWebSocket(ws, {
      type: 'connected',
      connectionId: wsId,
    });

    // If sessionId provided, auto-join that session
    if (claudeSessionId && this.deps.claudeSessions.has(claudeSessionId)) {
      this.messageProcessor.joinSession(wsId, claudeSessionId);
    }
  }

  cleanupConnection(wsId: string): void {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

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
