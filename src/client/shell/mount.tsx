import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import { AppShell, type ShellActions } from './AppShell';
import { shellStore } from './store';
import { relayTerminalTheme } from './terminal-theme';

const THEME_STORAGE_KEY = 'cc-web-relay-theme';

/** The live terminal, so a theme change can reach it. Set once at mount. */
let themedApp: App | null = null;

/** Apply the Relay theme by toggling the `.light` class the tokens key off. */
export function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.classList.toggle('light', theme === 'light');
  shellStore.setState({ theme });

  // xterm renders from a JavaScript theme object, not from CSS, so the class
  // toggle above reaches every React surface and stops at the terminal. Without
  // this the chrome goes light and the terminal stays dark.
  const terminal = themedApp?.terminal;
  if (terminal) {
    const next = relayTerminalTheme();
    // null means the tokens are not in the cascade. Keeping the previous theme
    // is right: one built from empty strings is black on black.
    if (next) terminal.options.theme = next;
  }

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
  // '.main', not '#terminalContainer': SplitContainer appends its split panes
  // into '.main' as a sibling of the terminal and toggles between them, so
  // adopting only the child would strand '.main' outside the shell and make
  // split view silently unreachable.
  const terminalNode = document.querySelector<HTMLElement>('.main');

  if (!mountPoint || !terminalNode) {
    // Better a working terminal with no chrome than a blank page.
    console.error('Relay shell not mounted: #relayRoot or .main is missing.');
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

  // Before applyTheme, so the very first call can already reach the terminal.
  themedApp = app;
  applyTheme(readStoredTheme());
  createRoot(mountPoint).render(<AppShell terminalNode={terminalNode} actions={actions} />);
}
