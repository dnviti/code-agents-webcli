import * as React from 'react';
import { createRoot } from 'react-dom/client';

import type { App } from '../app';
import type { AgentKind, RuntimeStartOptions } from '../types';
import { sendEscape, sendMobileKey, switchMode, toggleCtrlLatch } from '../ui/mobile';
import { summonKeyboard } from '../terminal/keyboard';
import { createNewSession, runTerminalCommand, startTerminalShell } from '../ui/modals';
import { loadSettings, applySettings, saveSettings } from '../ui/settings';
import { loadChatView, saveChatView, type ChatViewSettings } from '../chat/view-settings';
import type { BranchedConversation } from '../chat/branch-api';
import {
  conversationLabel,
  type ConversationList,
  type ConversationSummary,
} from '../../shared/conversations';
import { showConfirm } from '../ui/confirm';
import { onBannerAction, onBannerDismiss, onBannerToggleLog } from '../ui/update-banner';
import { showNotification } from '../ui/notifications';
import { hideOverlay, showError } from '../ui/overlay';
import { AppShell, type ShellActions } from './AppShell';
import { RuntimeLauncher, type ResumableConversation } from './RuntimeLauncher';
import { readStoredTheme, setThemeMode, watchSystemTheme, type RelayTheme } from './theme';
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
  // Keeps following the OS until the user picks a side, at which point the
  // stored choice wins and this stops changing anything.
  watchSystemTheme(applyTheme);

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

interface ResumableLocation {
  workingDir: string;
  projectId?: string | null;
  workingDirKind?: 'host' | 'container';
}

/** Past conversations in one explicit folder namespace, for the launcher. */
async function fetchResumable(
  app: App,
  location: ResumableLocation,
): Promise<ResumableConversation[]> {
  const query = new URLSearchParams({ dir: location.workingDir });
  if (location.projectId) {
    query.set('projectId', location.projectId);
    query.set('workingDirKind', location.workingDirKind || 'host');
  }
  const response = await app.authFetch(`/api/sessions/resumable?${query}`);
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
      const reopened = await app.sessionTabManager.reopenSession(conversation.id);
      if (!reopened) {
        throw new Error('That conversation was closed on another device');
      }
      app.sessionTabManager.addTab(
        conversation.id,
        conversation.name,
        'idle',
        conversation.workingDir,
        false,
        undefined,
        conversation.projectId,
        conversation.projectName,
        conversation.workingDirKind,
      );
      // See `openStoredConversation`: until the server confirms the surface, this
      // tab's close button would delete the conversation rather than detach it.
      // And the mode the row the user just clicked was labelled with, so the
      // pane does not open saying "asks first" over a conversation the list had
      // just called bypassed — a display seed, overwritten by the snapshot.
      app.chats.ensure(conversation.id).seedBypass(conversation.bypassPermissions === true);
      app.sessionTabManager.setTabSurface(conversation.id, 'chat');
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
 * Every conversation this user has, for the conversation list.
 *
 * Normalised on the way in rather than trusted: this answer is rendered as a
 * grouped, searchable list, and a missing `projects` array would be a TypeError
 * inside a dialog the user opened to find something.
 */
async function fetchConversations(app: App): Promise<ConversationList> {
  const response = await app.authFetch('/api/sessions/conversations');
  if (!response.ok) {
    // The server is a version behind this page more often than it is broken, and
    // that is worth saying: the endpoint is new, and the process loads its code
    // once, at boot.
    throw new Error(
      response.status === 404
        ? 'This server does not offer a conversation list yet — restart it and reload.'
        : 'Your conversations could not be listed.',
    );
  }
  const data = (await response.json()) as Partial<ConversationList>;
  return {
    projects: Array.isArray(data.projects) ? data.projects : [],
    total: typeof data.total === 'number' ? data.total : 0,
    truncated: data.truncated === true,
  };
}

/**
 * Put a stored conversation back on screen.
 *
 * Three cases, and the difference between them is the whole of what "open it"
 * means.
 *
 * It already has a tab: switch to it. Opening a second view of a conversation
 * this browser is already watching would be two transcripts of one conversation.
 *
 * It is running: joining it is all that is needed — the process is alive and the
 * join hands over its transcript. Starting it again would be refused, and rightly.
 *
 * Nothing is running it: bring it back. `resume: true` is what makes the agent
 * pick up its own context where the conversation recorded one; where it did not,
 * the same request still opens the conversation with its transcript intact and an
 * agent meeting it for the first time — which is what the row said would happen
 * before it was picked. Deliberately not `resume: false`: that means *start
 * fresh*, which draws a line under the transcript and truncates everything above
 * it, so reopening a conversation would begin by deleting it.
 */
async function openStoredConversation(
  app: App,
  conversation: ConversationSummary,
): Promise<void> {
  try {
    const tabs = app.sessionTabManager;
    const alreadyOpenHere = tabs?.tabs.has(conversation.id) === true;
    // Always restate the account-level open state, even when this window has a
    // stale local tab from a close announcement it missed while disconnected.
    // Switching that stale copy alone would leave every other device closed.
    if (tabs) {
      const reopened = await tabs.reopenSession(conversation.id);
      if (!reopened) {
        throw new Error('That conversation was closed on another device');
      }
    }
    if (alreadyOpenHere && tabs) {
      await tabs.switchToTab(conversation.id);
      return;
    }

    if (tabs) {
      tabs.addTab(
        conversation.id,
        conversation.name,
        conversation.running ? 'active' : 'idle',
        conversation.workingDir,
        false,
        undefined,
        conversation.projectId,
        conversation.projectName,
        conversation.workingDirKind,
      );
      // Said here rather than waited for. The server reports the surface on
      // `session_joined`, which is a round trip away, and a tab that reads as a
      // terminal in the meantime is a tab whose close button would delete the
      // conversation that was just reopened. Same for the approval mode the row
      // was labelled with — see `resumeConversation`.
      app.chats.ensure(conversation.id).seedBypass(conversation.bypassPermissions === true);
      tabs.setTabSurface(conversation.id, 'chat');
      await tabs.switchToTab(conversation.id);
    } else {
      await app.joinSession(conversation.id);
    }

    app.startPromptRequested = false;
    hideOverlay();

    if (!conversation.running) {
      app.send({
        type: 'start_chat',
        agentKind: (conversation.runtime || 'claude') as AgentKind,
        sessionId: conversation.id,
        options: { resume: true },
      });
    }
  } catch (error: unknown) {
    showError(error instanceof Error ? error.message : 'That conversation could not be opened');
  }
}

/**
 * Delete a conversation, having asked.
 *
 * The only way to lose one, and it stays that way: closing a tab is now a detach
 * (see SessionTabManager.closeSession), so this is the single irreversible action
 * in the feature and it is the one that asks. The app's own confirm dialog rather
 * than `window.confirm`, because on a phone-shaped install the native one reads as
 * a page hijack.
 */
async function removeConversation(
  app: App,
  conversation: ConversationSummary,
): Promise<boolean> {
  const confirmed = await showConfirm({
    title: 'Delete this conversation?',
    description:
      `“${conversationLabel(conversation)}” and its transcript are removed for good, `
      + 'along with anything still running it. This cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return false;

  const gone = await app.deleteSession(conversation.id, { confirm: false });
  // And take its tab with it, if this browser has one. The server announces a
  // delete to the sockets that *joined* the session, which is not every tab: a
  // tab restored from the session list and never switched to has never joined,
  // so nothing would arrive to close it and the strip would keep a tab pointing
  // at a conversation that no longer exists. Closing an absent tab is a no-op.
  if (gone) app.sessionTabManager?.closeSession(conversation.id, { skipServerRequest: true });
  return gone;
}

/**
 * Open the conversation a branch just created, in a tab of its own.
 *
 * The server has already made it: the record exists, the carried history is on
 * disk, and the opening context is waiting for the first message. All that is
 * left is what only a browser can do — put it on screen and start its agent.
 *
 * A tab beside the original rather than in place of it, which is the whole
 * shape of the feature: the conversation branched from is still running, still
 * has its own agent, and is one tab away.
 *
 * The launch names no mode at all, and that is load-bearing in both directions.
 * `resume: true` would hand the agent a runtime conversation this branch does
 * not have — it is meeting the history for the first time, out of the opening
 * context, which is the honest version of what a fork would have done had any
 * of these CLIs offered one. And `resume: false` is worse: it means *start
 * fresh*, which draws a line under the transcript and truncates everything
 * above it, so the branch would open by deleting the history it was made of.
 */
async function openBranch(app: App, conversation: BranchedConversation): Promise<void> {
  const runtime = (conversation.runtime || 'claude') as AgentKind;
  try {
    if (app.sessionTabManager) {
      app.sessionTabManager.addTab(
        conversation.sessionId,
        conversation.name,
        'idle',
        conversation.workingDir,
        false,
        undefined,
        conversation.projectId,
        conversation.projectName,
        conversation.projectWorkingDirKind,
      );
      await app.sessionTabManager.switchToTab(conversation.sessionId);
    } else {
      await app.joinSession(conversation.sessionId);
    }

    app.send({
      type: 'start_chat',
      agentKind: runtime,
      sessionId: conversation.sessionId,
      options: {},
    });

    // What was carried, and — where no window size was on record — that nothing
    // was measured against it. Said once, here, rather than left for the user to
    // discover when the agent answers as though the history were shorter than it
    // is.
    //
    // "on record" and not "never reported": the size is read from the source
    // conversation's own log, and a long enough conversation has had the event
    // carrying it trimmed off the head. The runtime may well have said; this
    // process cannot see that it did, and saying so would be a guess dressed as
    // a fact — on exactly the conversations most likely to overflow.
    showNotification(
      conversation.sizeChecked
        ? `Branched at turn ${conversation.turnIndex}, carrying ${conversation.turns} turn${conversation.turns === 1 ? '' : 's'}.`
        : `Branched at turn ${conversation.turnIndex}, carrying ${conversation.turns} turn${conversation.turns === 1 ? '' : 's'}. `
          + 'No window size was on record for this conversation, so the history was not checked against one.',
    );
  } catch (error: unknown) {
    showError(error instanceof Error ? error.message : 'That branch could not be opened');
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
      case 'antigravity': void app.startAntigravitySession(options); break;
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

    const active = state.tabs.find((tab) => tab.id === state.activeId);
    const projectId = active?.projectId || null;
    const workingDir = projectId
      ? active?.workingDir || state.connection.workingDir || ''
      : app.selectedWorkingDir || app.currentFolderPath || active?.workingDir || '';
    const workingDirKind = projectId
      ? active?.projectWorkingDirKind || 'host'
      : 'host';
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
      fetchResumable(app, { workingDir, projectId, workingDirKind })
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
    }, [workingDir, projectId, workingDirKind]);

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

/** Create and focus a session whose workspace is resolved by the project manager. */
async function createProjectSession(app: App, projectId: string): Promise<void> {
  try {
    const response = await app.authFetch('/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    if (!response.ok) throw new Error('Failed to create project session');
    const data = await response.json() as {
      sessionId: string;
      session?: {
        name?: string;
        workingDir?: string;
        projectId?: string | null;
        projectName?: string | null;
        projectWorkingDirKind?: 'host' | 'container';
      };
    };
    const sessionName = data.session?.name || 'Project session';
    const workingDir = data.session?.workingDir || '';
    app.startPromptRequested = true;
    if (app.sessionTabManager) {
      app.sessionTabManager.addTab(
        data.sessionId,
        sessionName,
        'idle',
        workingDir,
        true,
        undefined,
        data.session?.projectId ?? projectId,
        data.session?.projectName,
        data.session?.projectWorkingDirKind,
      );
      await app.sessionTabManager.switchToTab(data.sessionId);
    } else {
      await app.joinSession(data.sessionId);
    }
    app.loadSessions();
  } catch (error) {
    app.startPromptRequested = false;
    console.error('Failed to create project session:', error);
    showError('Could not open a session for this project.');
  }
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
    openConversation: (conversation) => void openBranch(app, conversation),

    setTheme: applyTheme,
    readSettings: () => loadSettings(),
    // Preview writes straight to xterm without touching localStorage, so
    // cancelling a settings edit leaves nothing persisted to undo.
    previewSettings: (next) => applySettings(app, next),
    saveSettings: (next) => saveSettings(app, next),
    openSettings: () => app.showSettings(),

    createSession: (name, workingDir) => void createNewSession(app, name, workingDir),
    openProjectSession: (projectId) => void createProjectSession(app, projectId),
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

    loadConversations: () => fetchConversations(app),
    openStoredConversation: (conversation) => void openStoredConversation(app, conversation),
    deleteConversation: (conversation) => removeConversation(app, conversation),

    acceptPlan: () => app.acceptPlan(),
    rejectPlan: () => app.rejectPlan(),

    retryConnection: () => app.reconnect(),

    updateAction: () => onBannerAction(),
    updateToggleLog: () => onBannerToggleLog(),
    updateDismiss: () => onBannerDismiss(),
  };
}
