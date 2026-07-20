import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
import { AppShell, type ShellActions } from './AppShell';
import { RuntimeLauncher } from './RuntimeLauncher';
import { readStoredTheme, setThemeMode, type RelayTheme } from './theme';
import { relayTerminalTheme } from './terminal-theme';

/** The live terminal, so a theme change can reach it. Set once at mount. */
let themedApp: App | null = null;

/**
 * Switch theme from the shell's own toggle: mode plus the Relay terminal
 * palette.
 *
 * Settings takes the other path — setThemeMode alone — because it applies a
 * GitHub colourway to the terminal itself and only needs the mode kept in step.
 */
export function applyTheme(theme: RelayTheme): void {
  setThemeMode(theme);

  // xterm renders from a JavaScript theme object, not from CSS, so the class
  // toggle reaches every React surface and stops at the terminal. Without this
  // the chrome goes light and the terminal stays dark.
  const terminal = themedApp?.terminal;
  if (terminal) {
    const next = relayTerminalTheme();
    // null means the tokens are not in the cascade. Keeping the previous theme
    // is right: one built from empty strings is black on black.
    if (next) terminal.options.theme = next;
  }
}

export { readStoredTheme };

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
  mountRuntimeLauncher(app);
}

/**
 * Render the runtime picker into the existing start-prompt slot.
 *
 * A separate root rather than part of AppShell: the overlay it lives in is
 * shown and hidden imperatively by the session code (showOverlay('startPrompt')
 * from several places in the message handler), and moving that decision into
 * React state would mean re-deriving when a session is being created — the one
 * piece of flow most likely to break quietly.
 */
function mountRuntimeLauncher(app: App): void {
  const slot = document.getElementById('runtimeLauncherRoot');
  if (!slot) {
    console.error('Runtime launcher not mounted: #runtimeLauncherRoot is missing.');
    return;
  }

  const onTerminal = (): void => app.showTerminalOptionsModal();

  const start = (kind: AgentKind, options: RuntimeStartOptions = {}): void => {
    switch (kind) {
      case 'claude': void app.startClaudeSession(options); break;
      case 'codex': void app.startCodexSession(options); break;
      case 'agent': void app.startAgentSession(options); break;
      case 'pi': void app.startPiSession(options); break;
      case 'grok': void app.startGrokSession(options); break;
      case 'qwen': void app.startQwenSession(options); break;
      case 'kimi': void app.startKimiSession(options); break;
      // The launcher routes the terminal through onTerminal, because it needs a
      // shell chosen first. Handled here anyway: leaving it to `default` made a
      // call with 'terminal' a silent no-op, and a later refactor that routed it
      // through onStart would have produced a button that simply did nothing.
      case 'terminal': onTerminal(); break;
      default: break;
    }
  };

  createRoot(slot).render(
    <RuntimeLauncher
      aliases={app.aliases}
      onStart={start}
      onTerminal={onTerminal}
      onCancel={() => void app.cancelStartPrompt()}
    />,
  );
}
