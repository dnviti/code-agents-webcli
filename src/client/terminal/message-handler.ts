// WebSocket message handler: dispatches incoming messages to the appropriate app methods

import type { App } from '../app';
import type { WsMessage } from '../types';
import { showOverlay, hideOverlay, showError } from '../ui/overlay';
import {
  appendUpdateLog,
  applyUpdateStatus,
  onUpdateDone,
  onUpdateRestarting,
} from '../ui/update-banner';
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
      case 'pi_started':
      case 'grok_started':
      case 'qwen_started':
      case 'kimi_started':
      case 'terminal_started':
        this.onRuntimeStarted(message);
        break;

      case 'claude_stopped':
      case 'codex_stopped':
      case 'agent_stopped':
      case 'pi_stopped':
      case 'grok_stopped':
      case 'qwen_stopped':
      case 'kimi_stopped':
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

      // The session we tried to reattach to is gone (e.g. after a server
      // restart): drop the stale tab rather than leaving a dead terminal.
      case 'session_gone':
        this.onSessionDeleted(message);
        break;

      case 'history_chunk':
        this.onHistoryChunk(message);
        break;

      case 'pong':
        break;

      case 'usage_update':
        // Usage display has been removed from the UI
        break;

      case 'update_status':
        applyUpdateStatus(message.status);
        break;

      case 'update_output':
        appendUpdateLog(message.data);
        break;

      case 'update_restarting':
        onUpdateRestarting();
        break;

      case 'update_done':
        onUpdateDone(this.app, message);
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
    history?: { firstLine: number; totalLines: number };
  }): void {
    this.app.currentClaudeSessionId = message.sessionId;
    this.app.historyRange = message.history ?? { firstLine: 0, totalLines: 0 };
    this.app.historyView?.setRange(this.app.historyRange);
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

    // Replay output buffer. Joined into a single write: the transcript arrives
    // pre-split into 64KB chunks purely for transport, and parsing it as one
    // stream avoids re-entering the write pipeline dozens of times on join.
    if (message.outputBuffer && message.outputBuffer.length > 0 && this.app.terminal) {
      this.app.terminal.write(
        stripUnsupportedTerminalSequences(message.outputBuffer.join('')),
      );
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
          showOverlay(
            'loadingSpinner',
            this.app.getRuntimeStartMessage(
              this.app.pendingRuntimeStart.kind,
              this.app.pendingRuntimeStart.options,
            ),
          );
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
    // Batched to the next frame. Writing (and previously force-refreshing) once
    // per socket chunk meant a full-screen repaint per streamed token.
    this.app.terminalController?.write(filteredData);

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

  /**
   * Hand the page to whoever asked for it. Replies are matched by id because
   * fast scrolling leaves several requests in flight and they can come back
   * out of order.
   */
  private onHistoryChunk(message: {
    requestId?: string | null;
    lines?: string[];
    firstLine?: number;
    totalLines?: number;
  }): void {
    if (typeof message.firstLine === 'number' && typeof message.totalLines === 'number') {
      this.app.historyRange = { firstLine: message.firstLine, totalLines: message.totalLines };
      this.app.historyView?.setRange(this.app.historyRange);
    }

    if (!message.requestId) {
      return;
    }

    const resolve = this.app.historyRequests.get(message.requestId);
    if (resolve) {
      this.app.historyRequests.delete(message.requestId);
      resolve(message.lines ?? []);
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

  private lastSentCols = 0;
  private lastSentRows = 0;

  /**
   * Fit once now and once after layout settles.
   *
   * This used to fire three waves (sync, rAF, +32ms) and send a resize each
   * time. Every wave that changed the size reflowed the whole scrollback and
   * made the PTY redraw, so joining a session could reflow it several times
   * over. Sending only on an actual change also stops the server from
   * re-rendering for a size it already has.
   */
  private syncSize(): void {
    const terminal = this.app.terminal;
    if (
      !terminal ||
      terminal.cols <= 0 ||
      terminal.rows <= 0 ||
      !this.app.socket ||
      this.app.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (terminal.cols === this.lastSentCols && terminal.rows === this.lastSentRows) {
      return;
    }

    this.lastSentCols = terminal.cols;
    this.lastSentRows = terminal.rows;
    this.app.send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
  }

  private scheduleTerminalRefit(): void {
    this.app.fitTerminal();
    this.syncSize();

    requestAnimationFrame(() => {
      this.app.fitTerminal();
      this.syncSize();
    });
  }
}
