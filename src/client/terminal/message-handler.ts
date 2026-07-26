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
import { clearChatSurface, setChatSurface } from '../chat/surface';
import { settleRuntimeStart } from '../sessions/actions';

export class MessageHandler {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  handle(message: WsMessage): void {
    // The surface a session runs on is the server's decision, and it arrives
    // on exactly these two messages. Read before dispatching, because the chat
    // handler below consumes chat_started and the terminal path never sees it.
    //
    // Both are now conditional on the message naming the session the shell is
    // actually showing. A browser watching three conversations receives
    // `chat_started` for any of them, and swapping the visible pane because a
    // background agent launched is exactly the behaviour that made tabs feel
    // like they were taking the screen from one another.
    if (message.type === 'chat_started') {
      const startedId = message.sessionId || '';
      if (startedId) this.app.sessionTabManager?.setTabSurface(startedId, 'chat');

      if (!startedId || startedId === this.app.currentClaudeSessionId) {
        // Settled here for the same reason onRuntimeStarted settles the
        // terminal path: this message *is* the answer to the launch. Left
        // pending, the next join would read it as a start still in flight and
        // cover the live conversation with a spinner that had nothing left to
        // wait for.
        settleRuntimeStart(this.app);
        this.app.startPromptRequested = false;
        setChatSurface(this.app, {
          active: true,
          sessionId: startedId,
          runtime: message.agent || '',
          runtimeLabel: message.runtimeLabel || '',
          workingDir: message.workingDir || '',
        });
        hideOverlay();
      }
    } else if (message.type === 'session_joined') {
      if (message.surface === 'chat') {
        this.app.sessionTabManager?.setTabSurface(message.sessionId, 'chat');
        setChatSurface(this.app, {
          active: true,
          sessionId: message.sessionId,
          runtime: message.agent || message.lastAgent || '',
          runtimeLabel: message.runtimeLabel || '',
          workingDir: message.workingDir || '',
        });
      } else {
        clearChatSurface();
      }
    } else if (message.type === 'chat_event') {
      this.reflectChatActivity(message);
    }

    // The chat surface owns its own message family. Offered them first so this
    // switch does not have to grow a case per chat event, and so an unknown
    // chat message stays inside the chat layer rather than reaching a terminal
    // handler that has no idea what to do with it.
    if (this.app.chats.handle(message as unknown as Record<string, unknown>)) {
      return;
    }

    switch (message.type) {
      case 'connected':
        this.app.connectionId = message.connectionId;
        // Before anything can ask for an optional message: the handshake is
        // the first thing the server sends, and the alternative is a client
        // that has to guess what the other end understands.
        this.app.chats.setFeatures(message.features);
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
      case 'omp_started':
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
      case 'omp_stopped':
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

      // Someone renamed this session — in another window, on another device, or
      // in this one, since the server tells every socket rather than assuming
      // the asker already knows.
      case 'session_renamed':
        this.app.sessionTabManager?.applyRemoteName(message.sessionId, message.name);
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

  /**
   * Let a conversation the user is not looking at move its own tab.
   *
   * A chat session emits no PTY output, so none of the terminal path's activity
   * tracking ever fires for it and a background agent could work, finish, or
   * stop and ask for approval with nothing on the tab strip to say so. Only the
   * events that mean something at that distance are used: what the session is
   * doing, and whether it is waiting on a person.
   */
  private reflectChatActivity(message: { sessionId?: string; event?: unknown }): void {
    const tabs = this.app.sessionTabManager;
    const sessionId = message.sessionId;
    if (!tabs || !sessionId) return;

    const event = message.event as { t?: string; state?: string } | undefined;
    if (!event) return;

    const background = sessionId !== this.app.currentClaudeSessionId;

    if (event.t === 'permission') {
      // The one event that is genuinely blocking: the agent has stopped and
      // will not move again until somebody answers.
      tabs.updateTabStatus(sessionId, 'idle');
      if (background) tabs.updateUnreadIndicator(sessionId, true);
      return;
    }

    if (event.t !== 'state') return;

    switch (event.state) {
      case 'thinking':
      case 'running':
      case 'starting':
        tabs.updateTabStatus(sessionId, 'active');
        return;
      case 'awaiting_permission':
      case 'awaiting_answer':
        tabs.updateTabStatus(sessionId, 'idle');
        if (background) tabs.updateUnreadIndicator(sessionId, true);
        return;
      case 'error':
        tabs.markSessionError(sessionId, true);
        return;
      case 'idle':
      case 'exited':
        // updateTabStatus already raises the unread dot for a background
        // session that was working and has gone quiet, which is the signal
        // worth carrying here.
        tabs.updateTabStatus(sessionId, 'idle');
        return;
      default:
        return;
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
    settleRuntimeStart(this.app);
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
    settleRuntimeStart(this.app);
    showError(message.message);

    if (this.app.sessionTabManager && this.app.currentClaudeSessionId) {
      this.app.sessionTabManager.markSessionError(this.app.currentClaudeSessionId, true);
    }
  }

  private onSessionDeleted(message: { sessionId: string; message: string }): void {
    const deletedSessionId = message.sessionId;
    const wasCurrentSession = deletedSessionId === this.app.currentClaudeSessionId;

    // The conversation is gone with the session; keeping its controller would
    // leak a transcript and a subscription for a session id that no longer
    // resolves anywhere.
    if (deletedSessionId) this.app.chats.drop(deletedSessionId);

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
      settleRuntimeStart(this.app);
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
