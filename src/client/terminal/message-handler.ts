// WebSocket message handler: dispatches incoming messages to the appropriate app methods

import type { App } from '../app';
import type { WsMessage } from '../types';
import { showOverlay, hideOverlay, showError } from '../ui/overlay';
import { stripUnsupportedTerminalSequences } from './text';

export class MessageHandler {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  handle(message: WsMessage): void {
    switch (message.type) {
      case 'connected':
        this.app.connectionId = message.connectionId;
        break;

      case 'session_created':
        this.onSessionCreated(message);
        break;

      case 'session_joined':
        this.onSessionJoined(message);
        break;

      case 'session_left':
        this.onSessionLeft(message);
        break;

      case 'claude_started':
      case 'codex_started':
      case 'agent_started':
      case 'terminal_started':
        this.onRuntimeStarted(message);
        break;

      case 'claude_stopped':
      case 'codex_stopped':
      case 'agent_stopped':
      case 'terminal_stopped':
        this.onRuntimeStopped(message);
        break;

      case 'output':
        this.onOutput(message);
        break;

      case 'exit':
        this.onExit(message);
        break;

      case 'error':
        this.onError(message);
        break;

      case 'info':
        if (
          message.message.includes('not running') ||
          message.message.includes('No process is running')
        ) {
          if (this.app.startPromptRequested) {
            showOverlay('startPrompt');
            this.app.startPromptRequested = false;
          }
        }
        break;

      case 'session_deleted':
        this.onSessionDeleted(message);
        break;

      case 'pong':
        break;

      case 'usage_update':
        // Usage display has been removed from the UI
        break;

      default:
        break;
    }
  }

  private onSessionCreated(message: { sessionId: string; sessionName: string; workingDir: string }): void {
    this.app.currentClaudeSessionId = message.sessionId;
    this.app.currentClaudeSessionName = message.sessionName;
    this.app.loadSessions();

    if (this.app.sessionTabManager) {
      this.app.sessionTabManager.addTab(
        message.sessionId,
        message.sessionName,
        'idle',
        message.workingDir,
      );
      this.app.sessionTabManager.switchToTab(message.sessionId);
    }
  }

  private onSessionJoined(message: {
    sessionId: string;
    sessionName: string;
    workingDir: string;
    active: boolean;
    outputBuffer?: string[];
    lastAgent?: string;
    runtimeLabel?: string;
  }): void {
    this.app.currentClaudeSessionId = message.sessionId;
    this.app.currentClaudeSessionName = message.sessionName;
    this.app.terminal?.reset();
    this.scheduleTerminalRefit();

    if (this.app.sessionTabManager) {
      this.app.sessionTabManager.updateTabStatus(
        message.sessionId,
        message.active ? 'active' : 'idle',
      );
    }

    if (this.app.splitContainer) {
      this.app.splitContainer.onTabSwitch(message.sessionId);
    }

    // Resolve pending join promise
    if (this.app.pendingJoinResolve && this.app.pendingJoinSessionId === message.sessionId) {
      this.app.pendingJoinResolve();
      this.app.pendingJoinResolve = null;
      this.app.pendingJoinSessionId = null;
    }

    // Replay output buffer
    if (message.outputBuffer && message.outputBuffer.length > 0 && this.app.terminal) {
      message.outputBuffer.forEach((data: string) => {
        this.app.terminal?.write(stripUnsupportedTerminalSequences(data));
      });
      this.scheduleTerminalRefit();
    }

    if (message.active) {
      this.app.startPromptRequested = false;
      hideOverlay();
      this.scheduleTerminalRefit();
    } else {
      const isNewSession = !message.outputBuffer || message.outputBuffer.length === 0;

      if (isNewSession) {
        if (this.app.pendingRuntimeStart) {
          showOverlay('loadingSpinner');
          const spinnerEl = document.getElementById('loadingSpinner');
          const pEl = spinnerEl?.querySelector('p');
          if (pEl) {
            pEl.textContent = this.app.getRuntimeStartMessage(
              this.app.pendingRuntimeStart.kind,
              this.app.pendingRuntimeStart.options,
            );
          }
        } else {
          if (this.app.startPromptRequested) {
            showOverlay('startPrompt');
            this.app.startPromptRequested = false;
          } else {
            hideOverlay();
          }
        }
      } else {
        const runtimeLabel = this.app.getRuntimeLabel(
          message.lastAgent as any,
          message.runtimeLabel,
          'The previous process',
        );
        this.app.terminal?.writeln(
          `\r\n\x1b[33m${runtimeLabel} has stopped in this session. Choose an option to restart.\x1b[0m`,
        );
        hideOverlay();
      }
    }
  }

  private onSessionLeft(message: { sessionId?: string }): void {
    this.app.currentClaudeSessionId = null;
    this.app.currentClaudeSessionName = null;
    this.app.terminal?.reset();

    if (this.app.sessionTabManager && message.sessionId) {
      this.app.sessionTabManager.updateTabStatus(message.sessionId, 'disconnected');
    }

    hideOverlay();
  }

  private onRuntimeStarted(message: { agent?: string }): void {
    this.app.pendingRuntimeStart = null;
    this.app.startPromptRequested = false;
    hideOverlay();
    this.scheduleTerminalRefit();
    this.app.loadSessions();

    if (message.agent !== 'terminal') {
      this.app.requestUsageStats();
    }

    if (this.app.sessionTabManager && this.app.currentClaudeSessionId) {
      this.app.sessionTabManager.updateTabStatus(this.app.currentClaudeSessionId, 'active');
    }
  }

  private onRuntimeStopped(message: { agent?: string; runtimeLabel?: string }): void {
    const label = this.app.getRuntimeLabel(
      message.agent as any,
      message.runtimeLabel,
      'Process',
    );
    this.app.terminal?.writeln(`\r\n\x1b[33m${label} stopped\x1b[0m`);
    hideOverlay();
    this.app.loadSessions();
  }

  private onOutput(message: { data: string }): void {
    const filteredData = stripUnsupportedTerminalSequences(message.data);
    this.app.terminal?.write(filteredData);
    if (document.visibilityState === 'visible') {
      this.app.terminalController?.refresh();
    }

    if (this.app.sessionTabManager && this.app.currentClaudeSessionId) {
      this.app.sessionTabManager.markSessionActivity(
        this.app.currentClaudeSessionId,
        true,
        message.data,
      );
    }

    if (this.app.planDetector) {
      this.app.planDetector.processOutput(message.data);
    }
  }

  private onExit(message: { code: number; agent?: string; runtimeLabel?: string }): void {
    const label = this.app.getRuntimeLabel(
      message.agent as any,
      message.runtimeLabel,
      'Process',
    );
    this.app.terminal?.writeln(
      `\r\n\x1b[33m${label} exited with code ${message.code}\x1b[0m`,
    );

    if (this.app.sessionTabManager && this.app.currentClaudeSessionId && message.code !== 0) {
      this.app.sessionTabManager.markSessionError(this.app.currentClaudeSessionId, true);
    }

    hideOverlay();
    this.app.loadSessions();
  }

  private onError(message: { message: string }): void {
    this.app.pendingRuntimeStart = null;
    showError(message.message);

    if (this.app.sessionTabManager && this.app.currentClaudeSessionId) {
      this.app.sessionTabManager.markSessionError(this.app.currentClaudeSessionId, true);
    }
  }

  private onSessionDeleted(message: { sessionId: string; message: string }): void {
    const deletedSessionId = message.sessionId;
    const wasCurrentSession = deletedSessionId === this.app.currentClaudeSessionId;

    if (this.app.sessionTabManager && deletedSessionId) {
      this.app.sessionTabManager.closeSession(deletedSessionId, { skipServerRequest: true });
    }

    if (
      wasCurrentSession ||
      !this.app.sessionTabManager ||
      this.app.sessionTabManager.tabs.size === 0
    ) {
      this.app.currentClaudeSessionId = null;
      this.app.currentClaudeSessionName = null;
      this.app.pendingRuntimeStart = null;
      this.app.startPromptRequested = false;
      this.app.terminal?.reset();
      hideOverlay();
    }

    this.app.loadSessions();
  }

  private scheduleTerminalRefit(): void {
    const syncSize = (): void => {
      if (
        this.app.socket &&
        this.app.socket.readyState === WebSocket.OPEN &&
        this.app.terminal &&
        this.app.terminal.cols > 0 &&
        this.app.terminal.rows > 0
      ) {
        this.app.send({
          type: 'resize',
          cols: this.app.terminal.cols,
          rows: this.app.terminal.rows,
        });
      }
    };

    this.app.fitTerminal();
    syncSize();

    requestAnimationFrame(() => {
      this.app.fitTerminal();
      syncSize();
    });

    setTimeout(() => {
      this.app.fitTerminal();
      syncSize();
    }, 32);
  }
}
