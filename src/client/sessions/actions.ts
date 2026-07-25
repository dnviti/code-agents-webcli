// Session CRUD operations: load, join, leave, delete, start runtimes

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
import { shellStore } from '../shell/store';
import { hideOverlay, showOverlay, showError } from '../ui/overlay';

async function stabilizeTerminalSize(
  app: App,
): Promise<{ cols: number; rows: number } | null> {
  if (!app.terminal) {
    return null;
  }

  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best-effort only.
  }

  app.fitTerminal();

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  app.fitTerminal();

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  if (app.terminal.cols > 0 && app.terminal.rows > 0) {
    return { cols: app.terminal.cols, rows: app.terminal.rows };
  }

  return null;
}

export async function loadSessions(app: App): Promise<void> {
  try {
    const response = await app.authFetch('/api/sessions/list');
    if (!response.ok) throw new Error('Failed to load sessions');
    const data = await response.json();
    app.claudeSessions = data.sessions;
    // The sessions dialog reads from the store, so a delete or a create that
    // refreshes this list is reflected in an already-open dialog rather than
    // leaving a row behind for a session that is gone.
    shellStore.setState({ sessionList: data.sessions });
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

export async function joinSession(app: App, sessionId: string): Promise<void> {
  if (
    app.currentClaudeSessionId === sessionId &&
    app.socket &&
    app.socket.readyState === WebSocket.OPEN &&
    !app.pendingJoinSessionId
  ) {
    return;
  }

  // Ensure we're connected
  if (!app.socket || app.socket.readyState !== WebSocket.OPEN) {
    if (app.socket && app.socket.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        const checkConnection = setInterval(() => {
          if (app.socket!.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(checkConnection);
          resolve();
        }, 5000);
      });
    } else {
      await app.connect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return new Promise<void>((resolve) => {
    // A second join overwrites the stored resolver, so settle the previous one
    // first: otherwise its promise (and anything awaiting the tab switch)
    // hangs forever.
    if (app.pendingJoinResolve) {
      app.pendingJoinResolve();
    }

    app.pendingJoinResolve = resolve;
    app.pendingJoinSessionId = sessionId;

    app.send({ type: 'join_session', sessionId });
    app.requestUsageStats();

    setTimeout(() => {
      // Only clear the slot if it is still ours; always settle this promise.
      if (app.pendingJoinResolve === resolve) {
        app.pendingJoinResolve = null;
        app.pendingJoinSessionId = null;
      }
      resolve();
    }, 2000);
  });
}

export function leaveSession(app: App): void {
  app.send({ type: 'leave_session' });
}

export async function deleteSession(
  app: App,
  sessionId: string,
  options: { confirm?: boolean } = {},
): Promise<void> {
  const { confirm: requireConfirm = true } = options;

  if (
    requireConfirm &&
    !confirm('Are you sure you want to delete this session? This will stop any running Claude process.')
  ) {
    return;
  }

  try {
    const response = await app.authFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete session');

    app.loadSessions();

    if (sessionId === app.currentClaudeSessionId) {
      app.currentClaudeSessionId = null;
      app.currentClaudeSessionName = null;
      app.terminal?.reset();
      hideOverlay();
    }
  } catch (error) {
    console.error('Failed to delete session:', error);
    showError('Failed to delete session');
  }
}

export async function ensureSessionForStart(app: App): Promise<string> {
  if (app.currentClaudeSessionId) {
    return app.currentClaudeSessionId;
  }

  const workingDir = app.selectedWorkingDir || app.currentFolderPath;
  if (!workingDir) {
    app.folderBrowser.show();
    throw new Error('Please select a working directory first');
  }

  const sessionName = `Session ${new Date().toLocaleString()}`;
  const response = await app.authFetch('/api/sessions/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sessionName, workingDir }),
  });

  if (!response.ok) {
    let errorMessage = 'Failed to create session';
    try {
      const error = await response.json();
      errorMessage = error.message || error.error || errorMessage;
    } catch {
      // Keep default message
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();

  if (app.sessionTabManager) {
    app.sessionTabManager.addTab(data.sessionId, data.session.name, 'idle', data.session.workingDir, false);
    await app.sessionTabManager.switchToTab(data.sessionId);
  } else {
    await app.joinSession(data.sessionId);
  }

  app.loadSessions();
  return data.sessionId;
}

/**
 * How long a launch may go unanswered before the spinner gives up.
 *
 * Every runtime announces itself as soon as its process is spawned, not when
 * the model first replies, so a healthy start lands in well under a second on
 * either surface. This is therefore not a latency budget — it is the point past
 * which the only remaining explanation is that nothing is coming.
 */
const RUNTIME_START_TIMEOUT_MS = 25000;

/**
 * A launch has been answered — by a start, an error, or by giving up.
 *
 * The pending start and its watchdog are cleared together, from one place,
 * because they are two halves of one fact. Clearing only the first is what let
 * a finished chat launch re-raise its own "Starting…" overlay on the next join.
 */
export function settleRuntimeStart(app: App): void {
  if (app.runtimeStartTimer !== null) {
    clearTimeout(app.runtimeStartTimer);
    app.runtimeStartTimer = null;
  }
  app.pendingRuntimeStart = null;
}

export async function startRuntimeSession(
  app: App,
  kind: AgentKind,
  options: RuntimeStartOptions = {},
): Promise<void> {
  try {
    settleRuntimeStart(app);
    app.pendingRuntimeStart = { kind, options };
    app.terminal?.reset();
    app.fitTerminal();
    showOverlay('loadingSpinner', app.getRuntimeStartMessage(kind, options));
    const terminalSize = await stabilizeTerminalSize(app);
    const payloadOptions = terminalSize
      ? { ...options, ...terminalSize }
      : { ...options };
    await ensureSessionForStart(app);

    // Chat mode is a different server path, not a flag on the terminal one:
    // the runtime is spawned headless over a protocol stream rather than into
    // a PTY, so there is no geometry to negotiate and no terminal to attach.
    if (options.surface === 'chat') {
      app.send({ type: 'start_chat', agentKind: kind, options: payloadOptions });
    } else {
      app.send({ type: `start_${kind}`, options: payloadOptions });
    }

    // Armed only once the request is actually on the wire, so the window covers
    // the server's silence rather than the time spent measuring the terminal.
    app.runtimeStartTimer = setTimeout(() => {
      app.runtimeStartTimer = null;
      if (!app.pendingRuntimeStart) return;
      app.pendingRuntimeStart = null;
      const label = app.getRuntimeLabel(kind, undefined, 'the runtime');
      showError(
        `The server never answered the request to start ${label}. ` +
          'It may be running an older version than this page — restart the server and reload.',
      );
    }, RUNTIME_START_TIMEOUT_MS);
  } catch (error: unknown) {
    settleRuntimeStart(app);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start ${kind}:`, error);
    showError(msg || `Failed to start ${app.getRuntimeLabel(kind, undefined, 'session')}`);
  }
}

export function startClaudeSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'claude', options);
}

export function startCodexSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'codex', options);
}

export function startAgentSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'agent', options);
}

export function startPiSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'pi', options);
}

export function startGrokSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'grok', options);
}

export function startQwenSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'qwen', options);
}

export function startKimiSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'kimi', options);
}

export function startOmpSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'omp', options);
}

export function startTerminalSession(app: App, options: RuntimeStartOptions = {}): Promise<void> {
  return startRuntimeSession(app, 'terminal', options);
}

export async function closeSession(app: App): Promise<void> {
  try {
    if (app.socket && app.socket.readyState === WebSocket.OPEN) {
      app.send({ type: 'close_session' });
    }

    const response = await app.authFetch('/api/close-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to close session');
    }

    app.selectedWorkingDir = null;
    app.currentFolderPath = null;
    app.wsConnection.disconnect();
    app.terminal?.reset();
    app.folderBrowser.show();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Failed to close session:', error);
    showError(`Failed to close session: ${msg}`);
  }
}
