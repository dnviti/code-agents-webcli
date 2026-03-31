// Modal management: new-session and terminal-options dialogs

import type { App } from '../app';
import { showError } from './overlay';

// ---------------------------------------------------------------------------
// New Session Modal
// ---------------------------------------------------------------------------

export function setupNewSessionModal(app: App): void {
  const modal = document.getElementById('newSessionModal');
  const closeBtn = document.getElementById('closeNewSessionBtn');
  const cancelBtn = document.getElementById('cancelNewSessionBtn');
  const createBtn = document.getElementById('createSessionBtn');
  const nameInput = document.getElementById('sessionName') as HTMLInputElement | null;
  const dirInput = document.getElementById('sessionWorkingDir') as HTMLInputElement | null;

  closeBtn?.addEventListener('click', () => hideNewSessionModal(app));
  cancelBtn?.addEventListener('click', () => hideNewSessionModal(app));
  createBtn?.addEventListener('click', () => createNewSession(app));

  modal?.addEventListener('click', (e: Event) => {
    if (e.target === modal) {
      hideNewSessionModal(app);
    }
  });

  [nameInput, dirInput].forEach((input) => {
    input?.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        createNewSession(app);
      }
    });
  });
}

export function showNewSessionModal(app: App): void {
  const modal = document.getElementById('newSessionModal');
  if (!modal) return;
  modal.classList.add('active');

  if (app.isMobile) {
    document.body.style.overflow = 'hidden';
  }

  (document.getElementById('sessionName') as HTMLInputElement | null)?.focus();
}

export function hideNewSessionModal(app: App): void {
  const modal = document.getElementById('newSessionModal');
  if (modal) modal.classList.remove('active');

  if (app.isMobile) {
    document.body.style.overflow = '';
  }

  const nameInput = document.getElementById('sessionName') as HTMLInputElement | null;
  const dirInput = document.getElementById('sessionWorkingDir') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';
  if (dirInput) dirInput.value = '';
}

export async function createNewSession(app: App): Promise<void> {
  const nameInput = document.getElementById('sessionName') as HTMLInputElement | null;
  const dirInput = document.getElementById('sessionWorkingDir') as HTMLInputElement | null;

  const name = nameInput?.value.trim() || `Session ${new Date().toLocaleString()}`;
  const workingDir = dirInput?.value.trim() || app.selectedWorkingDir;

  if (!workingDir) {
    showError('Please select a working directory first');
    return;
  }

  try {
    const response = await app.authFetch('/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, workingDir }),
    });

    if (!response.ok) throw new Error('Failed to create session');

    const data = await response.json();

    hideNewSessionModal(app);
    app.startPromptRequested = true;

    if (app.sessionTabManager) {
      app.sessionTabManager.addTab(data.sessionId, name, 'idle', workingDir);
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

export function setupTerminalOptionsModal(app: App): void {
  const modal = document.getElementById('terminalOptionsModal');
  const closeBtn = document.getElementById('closeTerminalOptionsBtn');
  const cancelBtn = document.getElementById('cancelTerminalOptionsBtn');
  const runCommandBtn = document.getElementById('runTerminalCommandBtn');
  const commandInput = document.getElementById('terminalCommandInput') as HTMLInputElement | null;

  if (!modal) return;

  closeBtn?.addEventListener('click', () => hideTerminalOptionsModal(app));
  cancelBtn?.addEventListener('click', () => hideTerminalOptionsModal(app));
  runCommandBtn?.addEventListener('click', () => runTerminalCommand(app));

  modal.querySelectorAll<HTMLElement>('[data-terminal-shell]').forEach((button) => {
    button.addEventListener('click', () => {
      const shell = button.dataset.terminalShell!;
      hideTerminalOptionsModal(app);
      app.startTerminalSession({ mode: 'shell', shell });
    });
  });

  commandInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      runTerminalCommand(app);
    } else if (e.key === 'Escape') {
      hideTerminalOptionsModal(app);
    }
  });

  modal.addEventListener('click', (e: Event) => {
    if (e.target === modal) {
      hideTerminalOptionsModal(app);
    }
  });
}

function setTerminalCommandError(message = ''): void {
  const errorEl = document.getElementById('terminalCommandError');
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = message ? 'block' : 'none';
}

export function showTerminalOptionsModal(app: App): void {
  const modal = document.getElementById('terminalOptionsModal');
  if (!modal) return;

  modal.classList.add('active');
  if (app.isMobile) {
    document.body.style.overflow = 'hidden';
  }
  setTerminalCommandError('');
  (document.getElementById('terminalCommandInput') as HTMLInputElement | null)?.focus();
}

export function hideTerminalOptionsModal(app: App): void {
  const modal = document.getElementById('terminalOptionsModal');
  if (!modal) return;

  modal.classList.remove('active');
  if (app.isMobile) {
    document.body.style.overflow = '';
  }

  const commandInput = document.getElementById('terminalCommandInput') as HTMLInputElement | null;
  if (commandInput) commandInput.value = '';
  setTerminalCommandError('');
}

export function runTerminalCommand(app: App): void {
  const commandInput = document.getElementById('terminalCommandInput') as HTMLInputElement | null;
  const command = commandInput?.value.trim();

  if (!command) {
    setTerminalCommandError('Enter a command to run.');
    commandInput?.focus();
    return;
  }

  setTerminalCommandError('');
  hideTerminalOptionsModal(app);
  app.startTerminalSession({ mode: 'command', command });
}
