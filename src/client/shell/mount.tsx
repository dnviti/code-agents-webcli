import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
import { sendEscape, sendMobileKey, switchMode, toggleCtrlLatch } from '../ui/mobile';
import { summonKeyboard } from '../terminal/keyboard';
import { createNewSession, runTerminalCommand, startTerminalShell } from '../ui/modals';
import { loadSettings, applySettings, saveSettings } from '../ui/settings';
import { loadChatView, saveChatView, type ChatViewSettings } from '../chat/view-settings';
import { onBannerAction, onBannerDismiss, onBannerToggleLog } from '../ui/update-banner';
import { hideOverlay, showError } from '../ui/overlay';
import { AppShell, type ShellActions } from './AppShell';
import { RuntimeLauncher, type ResumableConversation } from './RuntimeLauncher';
import { readStoredTheme, setThemeMode, type RelayTheme } from './theme';
import { shellStore } from './store';
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

  // Published before the first render so the chat surface opens with the rail
  // the user left it with, rather than flashing the default and then correcting.
  shellStore.setState({ chatView: loadChatView() });

  createRoot(mountPoint).render(
    <AppShell
      terminalNode={terminalNode}
      actions={buildActions(app)}
      launcher={buildLauncher(app)}
    />,
  );
}

/** Past conversations in a folder, for the launcher's resume list. */
async function fetchResumable(app: App, workingDir: string): Promise<ResumableConversation[]> {
  const response = await app.authFetch(
    `/api/sessions/resumable?dir=${encodeURIComponent(workingDir)}`,
  );
  if (!response.ok) return [];
  const data = (await response.json()) as { conversations?: ResumableConversation[] };
  return Array.isArray(data.conversations) ? data.conversations : [];
}

/**
 * Pick up a past conversation instead of starting a new one.
 *
 * The tab the user is looking at was created a moment ago by choosing a folder,
 * and it is not the one they want: the conversation they picked has its own
 * session, with its own transcript. So this switches the tab to that session
 * and then throws the empty one away — leaving it behind would put a session
 * that never held anything into the session list, once per resume.
 *
 * `resume: true` is what makes it a resume rather than a re-open: the runtime
 * is handed back its own conversation, so it remembers what is on screen. A
 * conversation that never recorded one still opens — the transcript is intact
 * either way — with an agent reading it for the first time, which the list
 * marks as "transcript only" so the choice is made knowingly.
 */
async function resumeConversation(app: App, conversation: ResumableConversation): Promise<void> {
  const abandoned = app.currentClaudeSessionId;
  const runtime = (conversation.runtime || 'claude') as AgentKind;

  try {
    if (app.sessionTabManager) {
      app.sessionTabManager.addTab(
        conversation.id,
        conversation.name,
        'idle',
        undefined,
        false,
      );
      await app.sessionTabManager.switchToTab(conversation.id);
    } else {
      await app.joinSession(conversation.id);
    }

    app.startPromptRequested = false;
    hideOverlay();

    // Already running: it has a live process and a live transcript, and the
    // join above is the whole of what "open it" means. Starting it again would
    // be refused, and rightly.
    if (!conversation.running) {
      app.send({
        type: 'start_chat',
        agentKind: runtime,
        sessionId: conversation.id,
        options: { resume: true },
      });
    }

    // Last, and only once the destination is open: deleting first would leave
    // the user on a tab that no longer exists if the join then failed.
    if (abandoned && abandoned !== conversation.id) {
      await app.deleteSession(abandoned, { confirm: false });
    }
  } catch (error: unknown) {
    showError(error instanceof Error ? error.message : 'That conversation could not be opened');
  }
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
      case 'omp': void app.startOmpSession(options); break;
      // The launcher routes the terminal through onTerminal, because it needs a
      // shell chosen first. Handled here anyway: leaving it to `default` made a
      // call with 'terminal' a silent no-op, and a later refactor that routed it
      // through onStart would have produced a button that simply did nothing.
      case 'terminal': onTerminal(); break;
      default: break;
    }
  };

  // Wrapped in a component rather than returned directly so the launcher can
  // follow the viewport: `buildLauncher` runs once, but whether the buttons
  // have room for their labels changes every time the window is resized or the
  // phone is rotated.
  function LauncherHost(): React.JSX.Element {
    const state = React.useSyncExternalStore(
      shellStore.subscribe,
      shellStore.getSnapshot,
      shellStore.getSnapshot,
    );

    const workingDir = app.selectedWorkingDir || app.currentFolderPath || '';
    const [conversations, setConversations] = React.useState<ResumableConversation[]>([]);
    const [loading, setLoading] = React.useState(false);

    // Asked each time the launcher opens on a folder, not cached: an agent may
    // have been running in another tab since the last time, and a stale list
    // would offer a conversation to resume that is already going.
    React.useEffect(() => {
      if (!workingDir) {
        setConversations([]);
        return;
      }
      let cancelled = false;
      setLoading(true);
      fetchResumable(app, workingDir)
        .then((list) => {
          if (!cancelled) setConversations(list);
        })
        .catch(() => {
          // A folder with no past conversations and a server that could not
          // answer look the same from here, and both mean "just launch".
          if (!cancelled) setConversations([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [workingDir]);

    return (
      <RuntimeLauncher
        aliases={app.aliases}
        onStart={start}
        onTerminal={onTerminal}
        onCancel={() => void app.cancelStartPrompt()}
        compact={state.isMobile}
        chatBypass={state.chatBypassPermissions}
        conversations={conversations}
        conversationsLoading={loading}
        onResume={(conversation) => void resumeConversation(app, conversation)}
      />
    );
  }

  return <LauncherHost />;
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
    sendMobileKey: (key) => sendMobileKey(app, key),
    toggleCtrl: () => toggleCtrlLatch(),
    toggleKeys: () => shellStore.setState({ keysVisible: !shellStore.getSnapshot().keysVisible }),
    showKeyboard: () => summonKeyboard(),
    attachImage: () => app.attachImage(),
    reconnect: () => app.reconnect(),
    closeCurrentSession: () => void app.closeSession(),

    setChatView: (next: ChatViewSettings) => {
      // Normalised on the way to storage and published from the same value, so
      // the store can never hold a setting that would not survive a reload.
      shellStore.setState({ chatView: saveChatView(next) });
    },

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
