import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import { AppShell, type ShellActions } from './AppShell';
import { shellStore } from './store';

const THEME_STORAGE_KEY = 'cc-web-relay-theme';

/** Apply the Relay theme by toggling the `.light` class the tokens key off. */
export function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.classList.toggle('light', theme === 'light');
  shellStore.setState({ theme });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode storage failures must not stop the app rendering.
  }
}

export function readStoredTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Mount the Relay shell around the already-constructed terminal.
 *
 * Called after App has built the terminal, so `#terminalContainer` exists and
 * xterm is attached to it before React ever renders. TerminalHost then adopts
 * that node rather than creating one.
 */
export function mountShell(app: App): void {
  const mountPoint = document.getElementById('relayRoot');
  const terminalNode = document.getElementById('terminalContainer');

  if (!mountPoint || !terminalNode) {
    // Better a working terminal with no chrome than a blank page.
    console.error('Relay shell not mounted: #relayRoot or #terminalContainer is missing.');
    return;
  }

  const actions: ShellActions = {
    selectTab: (id) => void app.sessionTabManager.switchToTab(id),
    closeTab: (id) => app.sessionTabManager.closeSession(id),
    newTab: () => app.sessionTabManager.createNewSession(),
    openSettings: () => app.showSettings(),
    fitTerminal: () => app.fitTerminal(),
    setTheme: applyTheme,
  };

  applyTheme(readStoredTheme());
  createRoot(mountPoint).render(<AppShell terminalNode={terminalNode} actions={actions} />);
}
