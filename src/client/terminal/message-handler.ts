// WebSocket message handler: dispatches incoming messages to the appropriate app methods

import type { App } from '../app';
import type { WsMessage } from '../types';
import { showOverlay, hideOverlay, showError } from '../ui/overlay';
import { showNotification } from '../ui/notifications';
import {
  appendUpdateLog,
  applyUpdateStatus,
  onUpdateDone,
  onUpdateRestarting,
} from '../ui/update-banner';
import { stripUnsupportedTerminalSequences } from './text';
import { createFrameScheduler } from './scheduler';
import { clearChatSurface, setChatSurface } from '../chat/surface';
import { settleRuntimeStart } from '../sessions/actions';

export class MessageHandler {
  private app: App;

  constructor(app: App) {
    this.app = app;

    // The trigger issue #17 names first is another viewer resizing the shared
    // PTY while this client just sits there — a second tab, a phone, a split.
    // Nothing happens on this end when it does, so there is no join and no
    // socket event to hang a recovery off; the user finds the skeleton when
    // they come back to the tab. Coming back is the event.
    //
    // Guarded because this handler is also bundled straight into node for the
    // tests, where there is no document.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.reclaimTerminalGeometry();
        }
      });
    }
  }

  handle(message: WsMessage): void {
    // A tab can disappear while its join is crossing the socket. In particular,
    // closing active A starts a fallback join to B; an account-wide close for B
    // can then remove it before the server's answer arrives. Nothing below may
    // paint, replay, subscribe or select a session that no longer has a tab.
    // The server has already attached this socket by the time it sends the
    // answer, so explicitly leave it again before discarding the message.
    if (
      message.type === 'session_joined' &&
      this.app.sessionTabManager &&
      !this.app.sessionTabManager.tabs.has(message.sessionId)
    ) {
      if (this.app.pendingJoinSessionId === message.sessionId) {
        const resolve = this.app.pendingJoinResolve;
        this.app.pendingJoinResolve = null;
        this.app.pendingJoinSessionId = null;
        resolve?.();
      }
      this.app.send({ type: 'leave_session', sessionId: message.sessionId });
      return;
    }

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
      case 'antigravity_started':
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
      case 'antigravity_stopped':
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

      // Closing a conversation is not deleting it: the transcript and any
      // running agent remain, but the tab leaves every screen on the account.
      // The screen that asked already removed it optimistically, so this is
      // deliberately idempotent there.
      case 'session_tab_closed':
        this.app.sessionTabManager?.applyRemoteClose(message.sessionId);
        this.app.loadSessions();
        break;

      // Order belongs to the account, selection to this window. Applying this
      // rearranges the strip without selecting a tab or echoing another write.
      case 'session_tabs_reordered':
        this.app.sessionTabManager?.applyRemoteOrder(message.sessionIds);
        break;

      // Someone renamed this session — in another window, on another device, or
      // in this one, since the server tells every socket rather than assuming
      // the asker already knows.
      case 'session_renamed':
        this.app.sessionTabManager?.applyRemoteName(message.sessionId, message.name);
        break;

      // A session came into existence somewhere else — or changed surface, which
      // is announced the same way. Also arrives on the socket that asked for it,
      // where it folds into the tab that request already put on the strip.
      case 'session_opened':
        this.app.sessionTabManager?.applyRemoteOpen({
          id: message.sessionId,
          name: message.name,
          customName: message.customName,
          workingDir: message.workingDir,
          surface: message.surface,
          active: message.active,
          bypassPermissions: message.bypassPermissions,
        });
        this.app.loadSessions();
        break;

      // A session somewhere is working, or has stopped. The screen attached to
      // it has the output and ignores this; every other screen with a tab for it
      // has nothing else to go on.
      case 'session_activity':
        this.app.sessionTabManager?.applyRemoteActivity(message.sessionId, message.active);
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

      case 'environment_tier_changed':
        // Told once, in passing. The environment panel re-reads itself off the
        // same event, so a dialog that happens to be open is never stale.
        showNotification(
          message.outcome === 'deferred'
            ? `Your workspace will move to ${message.tier} once nothing is running (${message.reason}).`
            : `Your workspace moved to ${message.tier} (${message.reason}).`,
          'info',
        );
        window.dispatchEvent(new CustomEvent('cc-environment-changed'));
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

    const event = message.event as {
      t?: string;
      state?: string;
      stale?: boolean;
      fatal?: boolean;
    } | undefined;
    if (!event) return;

    const background = sessionId !== this.app.currentClaudeSessionId;

    if (event.t === 'permission' || event.t === 'question') {
      // The two events that are genuinely blocking: the agent has stopped and
      // will not move again until somebody answers.
      tabs.updateTabStatus(sessionId, 'idle');
      if (background) tabs.updateUnreadIndicator(sessionId, true);
      return;
    }

    if (event.t === 'turn_end') {
      // The end of a turn is the *only* thing on the wire that says a
      // conversation stopped working, for claude, for every ACP runtime and for
      // codex in app-server mode: none of them emits a `state` event when a
      // turn ends, and the server does not synthesise one because the log
      // already carries this. Watching states alone left those tabs marked as
      // running until something else happened to move them, which on a finished
      // conversation is never.
      //
      // A `stale` end is the runtime letting go of work that was interrupted,
      // with the turn carrying straight on into what interrupted it. Nothing
      // has stopped, so nothing is reported.
      if (!event.stale) tabs.updateTabStatus(sessionId, 'idle');
      return;
    }

    if (event.t === 'error') {
      // A runtime that dies says so here and never sends `turn_end` at all.
      if (event.fatal) tabs.markSessionError(sessionId, true);
      return;
    }

    if (event.t === 'workflow_failed') {
      // The in-app half of telling somebody. The desktop notification is the
      // other half and it is the one that may not exist — permission is
      // `default` until a person grants it, and a browser that never got it
      // leaves the tab as the only surface saying anything happened at all.
      //
      // Unread rather than the error mark: the *conversation* has not failed
      // and may be working perfectly well on something else. What is waiting is
      // something to read (#140).
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
    // Whatever this client last told the PTY about its size stopped being true
    // the moment somebody else attached: the split pane, the second tab or the
    // phone that joined last is the one that set the geometry. Forget it here
    // so the refit below really re-sends ours, and ask for a repaint, because
    // the program is mid-screen and will not redraw on its own.
    this.forgetSentGeometry();
    this.repaintNudgeArmed = true;
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

    // An error carries no session id, so the only session it can be attributed
    // to is the one this socket is on — which is right for a failed start or a
    // runtime that died, and wrong for anything that failed on the way to a
    // *different* session. A join in flight is exactly that case: the socket is
    // still on the old session, so marking it would paint a healthy tab red for
    // something that went wrong with the tab the user just clicked.
    if (this.app.pendingJoinSessionId) return;

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
  private repaintNudgeArmed = false;
  /** rAF with a timer behind it: a starved frame here leaves the PTY one row short. */
  private readonly restoreScheduler = createFrameScheduler();
  /** And the same for the wave that fires the nudge, or it never fires at all. */
  private readonly refitScheduler = createFrameScheduler();

  /**
   * Drop this client's record of the geometry the PTY is running at.
   *
   * Nothing used to reset it, and this handler is built once and outlives every
   * reconnect, session switch and split. The PTY is shared, though: a split
   * pane, a second tab or a phone joining the same session resizes it to their
   * screen, and ours never changed — so syncSize() saw nothing to send and the
   * main terminal went on drawing a full-width screen over a half-width PTY.
   * Forgetting rather than bypassing the guard in syncSize keeps "send only on
   * a real change" true for every other path.
   */
  forgetSentGeometry(): void {
    this.lastSentCols = 0;
    this.lastSentRows = 0;
  }

  /**
   * Take the session's geometry back over a socket that never dropped.
   *
   * Closing a split is the case that needs saying out loud: the pane held this
   * same session and left the PTY half a screen wide, then closeSplit() calls
   * connect(), which returns straight away because the main socket was never
   * closed. No session_joined arrives, so without this nothing on this path
   * would ever speak up again and the only cure was resizing the window.
   */
  reclaimTerminalGeometry(): void {
    this.forgetSentGeometry();
    this.repaintNudgeArmed = true;
    this.scheduleTerminalRefit();
  }

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

  /**
   * Make the attached program repaint the whole screen.
   *
   * Re-sending the size it already has achieves nothing, and a CLI that paints
   * only the cells it believes changed leaves a rejoined terminal as a skeleton
   * with the ticking values moving on it. Dipping a row and coming back is two
   * real SIGWINCHes, which is what makes it redraw from scratch — by hand, that
   * is what resizing the browser window was doing.
   *
   * The two sizes go a frame apart on purpose: back to back they can reach the
   * program as a single change it reads once, and it repaints nothing.
   */
  private nudgeRepaint(): void {
    const terminal = this.app.terminal;
    if (
      !terminal ||
      !this.app.currentClaudeSessionId ||
      !this.app.socket ||
      this.app.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    // A single-row terminal has nothing to give back, and a PTY is never zero
    // rows tall, so there is no dip to make here.
    const cols = terminal.cols;
    const rows = terminal.rows;
    if (cols <= 0 || rows <= 1) {
      return;
    }

    // lastSent deliberately still says the real size: the refit waves that
    // follow this one in the same frame must stay quiet, or their resize lands
    // microseconds after the dip and closes the gap the nudge depends on.
    this.app.send({ type: 'resize', cols, rows: rows - 1 });

    this.restoreScheduler.schedule(() => {
      const current = this.app.terminal;
      if (
        !current ||
        current.cols <= 0 ||
        current.rows <= 0 ||
        !this.app.socket ||
        this.app.socket.readyState !== WebSocket.OPEN
      ) {
        // Giving up here would leave the PTY on the borrowed row while
        // lastSent still claims the real one, and syncSize would never correct
        // it: this issue again, made by the fix for it. Forget instead, so the
        // next fit sends whatever the truth turns out to be.
        this.forgetSentGeometry();
        return;
      }

      // Read again rather than restoring the captured size: a genuine resize
      // during that frame must win over the row we borrowed.
      this.lastSentCols = current.cols;
      this.lastSentRows = current.rows;
      this.app.send({ type: 'resize', cols: current.cols, rows: current.rows });
    });
  }

  private scheduleTerminalRefit(): void {
    this.app.fitTerminal();
    this.syncSize();

    this.refitScheduler.schedule(() => {
      this.app.fitTerminal();
      this.syncSize();

      // After the fit rather than alongside it: nudging a geometry that is
      // about to change again spends the repaint on the wrong size. Only a join
      // arms it, so the refits that follow output or a window resize — which
      // already carry a SIGWINCH of their own — stay silent.
      if (this.repaintNudgeArmed) {
        this.repaintNudgeArmed = false;
        this.nudgeRepaint();
      }
    });
  }
}
