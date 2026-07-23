// Modal management: new-session and terminal-options dialogs
//
// The panels themselves are `NewSessionDialog` and `TerminalOptionsDialog`.
// What is left here is what they never owned: creating the session on the
// server, and deciding what a validated command does next.

import type { App } from '../app';
import { shellStore } from '../shell/store';
import { showError } from './overlay';

// ---------------------------------------------------------------------------
// New Session Modal
// ---------------------------------------------------------------------------

export function showNewSessionModal(): void {
  shellStore.patchSlice('dialogs', { newSession: true });
}

export function hideNewSessionModal(): void {
  shellStore.patchSlice('dialogs', { newSession: false });
}

export async function createNewSession(
  app: App,
  name: string,
  workingDir: string,
): Promise<void> {
  const sessionName = name.trim() || `Session ${new Date().toLocaleString()}`;
  const dir = workingDir.trim() || app.selectedWorkingDir;

  // The dialog refuses to submit without a directory, so this is the
  // belt-and-braces path for a caller that is not the dialog.
  if (!dir) {
    showError('Please select a working directory first');
    return;
  }

  try {
    const response = await app.authFetch('/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sessionName, workingDir: dir }),
    });

    if (!response.ok) throw new Error('Failed to create session');

    const data = await response.json();

    hideNewSessionModal();
    app.startPromptRequested = true;

    if (app.sessionTabManager) {
      app.sessionTabManager.addTab(data.sessionId, sessionName, 'idle', dir);
      await app.sessionTabManager.switchToTab(data.sessionId);
    } else {
      await app.joinSession(data.sessionId);
    }

    app.loadSessions();
  } catch (error) {
    app.startPromptRequested = false;
    console.error('Failed to create session:', error);
    showError('Failed to create session');
  }
}

// ---------------------------------------------------------------------------
// Terminal Options Modal
// ---------------------------------------------------------------------------

export function showTerminalOptionsModal(): void {
  shellStore.patchSlice('dialogs', { terminalOptions: true });
}

export function hideTerminalOptionsModal(): void {
  shellStore.patchSlice('dialogs', { terminalOptions: false });
}

export function startTerminalShell(app: App, shell: string): void {
  hideTerminalOptionsModal();
  void app.startTerminalSession({ mode: 'shell', shell });
}

export function runTerminalCommand(app: App, command: string): void {
  const trimmed = command.trim();
  // The dialog will not submit an empty command; nothing else should either.
  if (!trimmed) return;

  hideTerminalOptionsModal();
  void app.startTerminalSession({ mode: 'command', command: trimmed });
}
