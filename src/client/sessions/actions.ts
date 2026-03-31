// Session CRUD operations: load, join, leave, delete, start runtimes

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
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
    app.pendingJoinResolve = resolve;
    app.pendingJoinSessionId = sessionId;

    app.send({ type: 'join_session', sessionId });
    app.requestUsageStats();

    setTimeout(() => {
      if (app.pendingJoinResolve) {
        app.pendingJoinResolve = null;
        app.pendingJoinSessionId = null;
        resolve();
      }
    }, 2000);
  });
}

export function leaveSession(app: App): void {
  app.send({ type: 'leave_session' });
}

export async function deleteSession(app: App, sessionId: string): Promise<void> {
  if (!confirm('Are you sure you want to delete this session? This will stop any running Claude process.')) {
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

export async function startRuntimeSession(
  app: App,
  kind: AgentKind,
  options: RuntimeStartOptions = {},
): Promise<void> {
  try {
    app.pendingRuntimeStart = { kind, options };
    app.terminal?.reset();
    app.fitTerminal();
    showOverlay('loadingSpinner');
    const spinnerEl = document.getElementById('loadingSpinner');
    const pEl = spinnerEl?.querySelector('p');
    if (pEl) {
      pEl.textContent = app.getRuntimeStartMessage(kind, options);
    }
    const terminalSize = await stabilizeTerminalSize(app);
    const payloadOptions = terminalSize
      ? { ...options, ...terminalSize }
      : { ...options };
    await ensureSessionForStart(app);
    app.send({ type: `start_${kind}`, options: payloadOptions });
  } catch (error: unknown) {
    app.pendingRuntimeStart = null;
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
