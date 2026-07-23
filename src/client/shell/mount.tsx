import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
import { sendEscape, switchMode } from '../ui/mobile';
import { createNewSession, runTerminalCommand, startTerminalShell } from '../ui/modals';
import { loadSettings, applySettings, saveSettings } from '../ui/settings';
import { onBannerAction, onBannerDismiss, onBannerToggleLog } from '../ui/update-banner';
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

  // Before applyTheme, so the very first call can already reach the terminal.
  themedApp = app;
  applyTheme(readStoredTheme());

  createRoot(mountPoint).render(
    <AppShell
      terminalNode={terminalNode}
      actions={buildActions(app)}
      launcher={buildLauncher(app)}
    />,
  );
}

/**
 * The runtime picker.
 *
 * Rendered as a child of the shell rather than into its own root: the overlay
 * that hosts it is store state now, so there is nothing left for a second React
 * root to decouple it from.
 */
function buildLauncher(app: App): React.ReactNode {
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

  return (
    <RuntimeLauncher
      aliases={app.aliases}
      onStart={start}
      onTerminal={onTerminal}
      onCancel={() => void app.cancelStartPrompt()}
    />
  );
}

/**
 * The complete list of what the chrome may do to the app.
 *
 * Built once and passed down, so the identity is stable across renders and the
 * effects in AppShell that depend on `actions` do not re-run on every store
 * update.
 */
function buildActions(app: App): ShellActions {
  return {
    selectTab: (id) => void app.sessionTabManager.switchToTab(id),
    closeTab: (id) => app.sessionTabManager.closeSession(id),
    closeOtherTabs: (id) => app.sessionTabManager.closeOthers(id),
    renameTab: (id, name) => app.sessionTabManager.renameTab(id, name),
    reorderTabs: (ids) => app.sessionTabManager.applyOrder(ids),
    newTab: () => app.sessionTabManager.createNewSession(),

    fitTerminal: () => app.fitTerminal(),
    clearTerminal: () => app.clearTerminal(),
    sendEscape: () => sendEscape(app),
    switchMode: () => switchMode(app),
    attachImage: () => app.attachImage(),
    reconnect: () => app.reconnect(),
    closeCurrentSession: () => void app.closeSession(),

    setTheme: applyTheme,
    readSettings: () => loadSettings(),
    // Preview writes straight to xterm without touching localStorage, so
    // cancelling a settings edit leaves nothing persisted to undo.
    previewSettings: (next) => applySettings(app, next),
    saveSettings: (next) => saveSettings(app, next),
    openSettings: () => app.showSettings(),

    createSession: (name, workingDir) => void createNewSession(app, name, workingDir),
    startShell: (shell) => startTerminalShell(app, shell),
    runCommand: (command) => runTerminalCommand(app, command),

    folderNavigate: (path) => void app.folderBrowser.loadFolders(path),
    folderUp: () => void app.folderBrowser.navigateToParent(),
    folderHome: () => void app.folderBrowser.navigateToHome(),
    folderToggleHidden: (next) => void app.folderBrowser.setShowHidden(next),
    folderStartCreate: () => app.folderBrowser.showCreateFolderInput(),
    folderCancelCreate: () => app.folderBrowser.hideCreateFolderInput(),
    folderCreate: (name) => void app.folderBrowser.createFolder(name),
    folderSelect: () => void app.folderBrowser.selectCurrentFolder(),
    folderClose: () => app.folderBrowser.close(),

    openSessions: () => app.showSessions(),
    // The list can contain a session this client has no tab for — another user
    // created it, or it appeared after the tab strip was populated — and
    // switchToTab silently returns for an id it does not know.
    joinSession: (id) => {
      if (app.sessionTabManager.tabs.has(id)) {
        void app.sessionTabManager.switchToTab(id);
      } else {
        void app.joinSession(id);
      }
    },
    leaveSession: () => app.leaveSession(),
    // The dialog does not confirm; deleting another user's session in a shared
    // deployment is not something to do on a single tap.
    deleteSession: (id) => void app.deleteSession(id),

    acceptPlan: () => app.acceptPlan(),
    rejectPlan: () => app.rejectPlan(),

    retryConnection: () => app.reconnect(),

    updateAction: () => onBannerAction(),
    updateToggleLog: () => onBannerToggleLog(),
    updateDismiss: () => onBannerDismiss(),
  };
}
