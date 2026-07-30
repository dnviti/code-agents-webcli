// WebSocket connection management

import type { App } from '../app';
import { shellStore } from '../shell/store';
import { hideOverlay, isOverlayVisible, showOverlay, showError } from '../ui/overlay';

/**
 * Publish the socket's state to the status bar.
 *
 * Nothing wrote this, so the indicator sat on `disconnected` — its initial
 * value — for the whole life of a perfectly healthy session, and the one thing
 * on screen that is supposed to tell you the connection dropped could never say
 * anything else.
 */
function publishConnection(state: 'connected' | 'connecting' | 'disconnected'): void {
  const { connection } = shellStore.getSnapshot();
  if (connection.state === state) return;
  shellStore.setState({ connection: { ...connection, state } });
}

export class WebSocketConnection {
  private app: App;
  private connectPromise: Promise<void> | null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private pongTimeout: ReturnType<typeof setTimeout> | null;
  private socketVersion: number;
  private manuallyClosed: boolean;

  private readonly heartbeatIntervalMs = 30000;
  private readonly pongTimeoutMs = 10000;
  /** Retry cadence once the fast exponential backoff budget is spent. */
  private readonly slowReconnectDelayMs = 30000;

  constructor(app: App) {
    this.app = app;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pongTimeout = null;
    this.socketVersion = 0;
    this.manuallyClosed = false;
  }

  connect(sessionId: string | null = null): Promise<void> {
    if (this.app.socket?.readyState === WebSocket.OPEN) {
      // Nothing to reconnect, but the caller asked because its view of the
      // session just changed — closing a split is the case that hurts. The pane
      // shared this PTY and left it half a screen wide, and since this socket
      // never dropped there is no session_joined to put the geometry back.
      this.app.messageHandler?.reclaimTerminalGeometry();
      return Promise.resolve();
    }

    if (this.app.socket?.readyState === WebSocket.CONNECTING && this.connectPromise) {
      return this.connectPromise;
    }

    const requestedSessionId = sessionId ?? this.app.currentClaudeSessionId;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${location.host}`;
    if (requestedSessionId) {
      wsUrl += `?sessionId=${encodeURIComponent(requestedSessionId)}`;
    }

    // Only switch to the spinner if an overlay is already covering the
    // terminal: a background reconnect must not throw a panel over output
    // somebody is reading.
    if (isOverlayVisible()) {
      showOverlay('loadingSpinner');
    }

    this.clearReconnectTimer();
    this.manuallyClosed = false;
    publishConnection('connecting');

    const socketVersion = ++this.socketVersion;

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        reject(error);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        resolve();
      };

      try {
        const socket = new WebSocket(wsUrl);
        this.app.socket = socket;

        socket.onopen = () => {
          if (!this.isCurrentSocket(socket, socketVersion)) {
            return;
          }

          this.app.reconnectAttempts = 0;
          publishConnection('connected');
          this.startHeartbeat();
          this.clearPongTimeout();
          void this.app.loadSessions();
          // Nothing announced while this socket was away was queued for it, so
          // the strip is asked to agree with the server rather than with what it
          // remembers: a session started elsewhere during the outage is missing
          // from it, and one ended elsewhere is still on it.
          void this.app.sessionTabManager?.reconcile();
          // Subscriptions live on the server's socket record, so a reconnect
          // starts with none. Without this every background conversation goes
          // quiet after a dropped connection and only the joined one recovers.
          this.app.sessionTabManager?.resubscribeChats();
          // Whoever stayed attached while we were away owns the PTY's size now,
          // and this end has no way of knowing what they set it to. Drop the
          // record of what we last sent so the rejoin genuinely re-sends ours
          // instead of deciding nothing has changed.
          this.app.messageHandler?.forgetSentGeometry();

          if (
            !this.app.currentClaudeSessionId &&
            (!this.app.sessionTabManager || this.app.sessionTabManager.tabs.size === 0)
          ) {
            hideOverlay();
          }

          succeed();
        };

        socket.onmessage = (event: MessageEvent) => {
          if (!this.isCurrentSocket(socket, socketVersion)) {
            return;
          }

          try {
            const message = JSON.parse(event.data);
            if (message?.type === 'pong') {
              this.handlePong();
            }
            this.app.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        };

        socket.onclose = (event: CloseEvent) => {
          if (!this.isCurrentSocket(socket, socketVersion)) {
            return;
          }

          this.stopHeartbeat();
          this.clearPongTimeout();
          this.app.socket = null;
          publishConnection('disconnected');

          if (!settled) {
            fail(new Error('WebSocket closed before connection was established'));
          }

          if (this.manuallyClosed) {
            return;
          }

          if (event.code === 4401) {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login?next=${next}`;
            return;
          }

          this.scheduleReconnect(event);
        };

        socket.onerror = (error: Event) => {
          if (!this.isCurrentSocket(socket, socketVersion)) {
            return;
          }

          console.error('WebSocket error:', error);

          if (!settled) {
            showError('Failed to connect to the server');
            fail(error);
          }
        };
      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        showError('Failed to create connection');
        fail(error);
      }
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.closeSocket(true);
  }

  reconnect(): void {
    this.clearReconnectTimer();
    this.closeSocket(false);
    this.connect(this.app.currentClaudeSessionId).catch((err) => {
      console.error('Reconnection failed:', err);
    });
  }

  send(data: Record<string, unknown>): void {
    if (this.app.socket && this.app.socket.readyState === WebSocket.OPEN) {
      this.app.socket.send(JSON.stringify(data));
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.app.socket && this.app.socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
        this.armPongTimeout();
      }
    }, this.heartbeatIntervalMs);
  }

  private isCurrentSocket(socket: WebSocket, socketVersion: number): boolean {
    return this.app.socket === socket && this.socketVersion === socketVersion;
  }

  private closeSocket(manuallyClosed: boolean): void {
    this.manuallyClosed = manuallyClosed;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearPongTimeout();

    const socket = this.app.socket;
    this.app.socket = null;
    this.connectPromise = null;
    publishConnection('disconnected');

    if (socket) {
      try {
        socket.close();
      } catch (error) {
        console.warn('Failed to close WebSocket cleanly:', error);
      }
    }
  }

  private scheduleReconnect(event: CloseEvent): void {
    if (this.reconnectTimer) {
      return;
    }

    // Past the fast-retry budget, keep retrying slowly instead of giving up
    // forever: a laptop resuming from sleep or a brief server restart should
    // recover without the user reloading the page.
    const exhausted = this.app.reconnectAttempts >= this.app.maxReconnectAttempts;
    if (exhausted) {
      showError('Connection lost. Retrying in the background...');
    }

    const attempt = this.app.reconnectAttempts;
    const delay = exhausted
      ? this.slowReconnectDelayMs
      : this.app.reconnectDelay * Math.pow(2, attempt);
    this.app.reconnectAttempts++;

    console.warn(
      `WebSocket closed (code ${event.code}). Reconnecting in ${delay}ms...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.app.currentClaudeSessionId).catch((error) => {
        console.error('Scheduled reconnection failed:', error);
      });
    }, delay);
  }

  private armPongTimeout(): void {
    this.clearPongTimeout();
    this.pongTimeout = setTimeout(() => {
      if (this.app.socket && this.app.socket.readyState === WebSocket.OPEN) {
        console.warn('WebSocket heartbeat timed out, forcing reconnect');
        this.reconnect();
      }
    }, this.pongTimeoutMs);
  }

  private handlePong(): void {
    this.clearPongTimeout();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearPongTimeout(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
