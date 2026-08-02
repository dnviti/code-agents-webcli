import * as React from 'react';

import type { AppSettings } from '../types';
import { Badge } from '../ui/relay/Badge';
import { CommandPalette, type CommandPaletteGroup } from '../ui/relay/CommandPalette';
import { Icon } from '../ui/relay/Icon';
import { PhoneContext } from '../ui/touch';
import { visualViewportKeyboardInset } from '../ui/keyboard-viewport';
import { IconButton } from '../ui/relay/IconButton';
import { StatusBar, type StatusBarSegment } from '../ui/relay/StatusBar';
import { TabBar, type TabItem } from '../ui/relay/TabBar';
import { resolveConfirm } from '../ui/confirm';
import { ConfirmDialog } from './dialogs/ConfirmDialog';
import { FolderBrowserDialog } from './dialogs/FolderBrowserDialog';
import { NewSessionDialog } from './dialogs/NewSessionDialog';
import { PlanDialog } from './dialogs/PlanDialog';
import { RenameDialog } from './dialogs/RenameDialog';
import { RuntimeProfilesDialog } from './dialogs/RuntimeProfilesDialog';
import { DeployTargetsDialog } from './dialogs/DeployTargetsDialog';
import { ProjectsDialog } from './dialogs/ProjectsDialog';
import { EnvironmentDialog, type EnvironmentInfo } from './dialogs/EnvironmentDialog';
import { SessionsDialog } from './dialogs/SessionsDialog';
import { ConversationsDialog } from './dialogs/ConversationsDialog';
import { ChatSettingsDialog } from './dialogs/ChatSettingsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { UsageDashboardDialog } from './dialogs/UsageDashboardDialog';
import { TerminalOptionsDialog } from './dialogs/TerminalOptionsDialog';
import { BottomNav, type BottomNavDestination } from './BottomNav';
import { FloatingMenu, type FloatingMenuAction } from './FloatingMenu';
import { TabSwitcherSheet } from './TabSwitcherSheet';
import { KeyStrip, KEY_STRIP_HEIGHT } from './KeyStrip';
import type { MobileKey } from '../ui/mobile';
import { MoreSheet } from './MoreSheet';
import { installHint, promptInstall } from './install-prompt';
import { OverlayHost } from './OverlayHost';
import { AppContextMenu } from './AppContextMenu.js';
import { downloadFile, uploadIntoWorkspace } from '../chat/workspace-api';
import { showConfirm } from '../ui/confirm';
import { showError } from '../ui/overlay';
import { TabContextMenu } from './TabContextMenu';
import { TerminalHost } from './TerminalHost';
import { ChatView } from './chat/ChatView';
import type { ChatController } from '../chat/controller';
import type { BranchedConversation } from '../chat/branch-api';
import type { ConversationList, ConversationSummary } from '../../shared/conversations';
import { CHAT_PANEL_ICONS, type ChatPanelId, type ChatViewSettings } from '../chat/view-settings';
import { Toasts } from './Toasts';
import { UpdateBannerView } from './UpdateBannerView';
import { shellStore, type ShellState, type ShellTab } from './store';

/**
 * What the shell needs from the imperative App, named rather than passing App
 * itself.
 *
 * It is a long list, and deliberately so: it is the complete inventory of what
 * the chrome is allowed to do. Anything not here, React cannot reach.
 */
export interface ShellActions {
  // Tabs
  selectTab(id: string): void;
  closeTab(id: string): void;
  closeOtherTabs(id: string): void;
  renameTab(id: string, name: string): void;
  reorderTabs(ids: string[]): void;
  newTab(): void;

  // Terminal
  fitTerminal(): void;
  clearTerminal(): void;
  sendEscape(): void;
  switchMode(): void;
  sendMobileKey(key: MobileKey): void;
  toggleCtrl(): void;
  toggleKeys(): void;
  showKeyboard(): void;
  attachImage(): void;
  reconnect(): void;
  closeCurrentSession(): void;

  // Appearance
  setTheme(theme: 'dark' | 'light'): void;
  readSettings(): AppSettings;
  previewSettings(next: AppSettings): void;
  saveSettings(next: AppSettings): void;
  openSettings(): void;

  // Session creation
  createSession(name: string, workingDir: string): void;
  startShell(shell: string): void;
  runCommand(command: string): void;
  /** Create a session inside a project and focus it. */
  openProjectSession(projectId: string): void;

  // Folder browser
  folderNavigate(path: string): void;
  folderUp(): void;
  folderHome(): void;
  folderToggleHidden(next: boolean): void;
  folderStartCreate(): void;
  folderCancelCreate(): void;
  folderCreate(name: string): void;
  folderSelect(): void;
  folderClose(): void;

  // Session list
  openSessions(): void;
  joinSession(id: string): void;
  leaveSession(): void;
  deleteSession(id: string): void;

  // Conversations
  /** Every conversation this user has, grouped by project. */
  loadConversations(): Promise<ConversationList>;
  /**
   * Put a stored conversation back on screen.
   *
   * Joins it when something is still running it, and otherwise brings it back
   * with its transcript — handing the agent its own context where that is
   * possible. See `openStoredConversation` in mount.tsx.
   */
  openStoredConversation(conversation: ConversationSummary): void;
  /** Ask, then delete for good. Resolves true when the conversation is gone. */
  deleteConversation(conversation: ConversationSummary): Promise<boolean>;

  // Plan
  acceptPlan(): void;
  rejectPlan(): void;

  // Connection overlay
  retryConnection(): void;

  // Chat surface
  /** Persist and publish a change to the chat's display settings. */
  setChatView(next: ChatViewSettings): void;
  /**
   * Open a conversation the chat surface has just created — today, a branch.
   *
   * It already exists on the server with its transcript on disk; what is left is
   * a tab, the switch onto it and the launch of its agent, none of which the
   * surface inside a conversation has any business doing for itself.
   */
  openConversation(conversation: BranchedConversation): void;

  // Update banner
  updateAction(): void;
  updateToggleLog(): void;
  updateDismiss(): void;
}

export interface AppShellProps {
  terminalNode: HTMLElement;
  actions: ShellActions;
  /** The runtime picker, rendered inside the overlay's "start" view. */
  launcher: React.ReactNode;
}

function tabItems(tabs: ShellTab[]): TabItem[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.projectName || tab.projectId ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--primary)', flex: '0 0 auto' }}>{tab.projectName || tab.projectId}</span>
      </span>
    ) : tab.title,
    status: tab.status,
    unread: tab.unread,
    attention: tab.attention,
    tooltip: tab.projectName || tab.projectId
      ? `${tab.projectName || tab.projectId} · ${tab.workingDir ?? tab.title}`
      : (tab.workingDir ?? tab.title),
  }));
}

function closeDialogs(patch: Parameters<typeof shellStore.patchSlice<'dialogs'>>[1]): void {
  shellStore.patchSlice('dialogs', patch);
}

/**
 * The user's environment, read when a dialog that shows it opens.
 *
 * Read on demand rather than kept live: the size changes rarely, and polling it
 * from every open tab would cost a request a second across a whole
 * installation to show a line that almost never moves. The one case that *does*
 * move on its own — automatic sizing — announces itself over the socket.
 */
function useEnvironment(visible: boolean): {
  info: EnvironmentInfo | null;
  error: string | null;
  busy: boolean;
  notice: string | null;
  apply(tier: string): Promise<void>;
} {
  const [info, setInfo] = React.useState<EnvironmentInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const read = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/environment', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      setInfo((await response.json()) as EnvironmentInfo);
      setError(null);
    } catch {
      setError('Could not read your environment from the server.');
    }
  }, []);

  React.useEffect(() => {
    if (visible) void read();
  }, [visible, read]);

  // A size the server changed on its own must not leave a stale one on screen.
  React.useEffect(() => {
    const onChanged = (): void => { void read(); };
    window.addEventListener('cc-environment-changed', onChanged);
    return () => window.removeEventListener('cc-environment-changed', onChanged);
  }, [read]);

  const apply = React.useCallback(async (tier: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/environment/tier', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.message || 'The size could not be changed.');
        return;
      }
      setError(null);
      setNotice(payload.message || 'Saved.');
      await read();
    } catch {
      setError('The size could not be changed.');
    } finally {
      setBusy(false);
    }
  }, [read]);

  return { info, error, busy, notice, apply };
}

export function AppShell({ terminalNode, actions, launcher }: AppShellProps): React.JSX.Element {
  const state: ShellState = React.useSyncExternalStore(
    shellStore.subscribe,
    shellStore.getSnapshot,
    shellStore.getSnapshot,
  );

  const active = state.tabs.find((t) => t.id === state.activeId) || null;
  const environment = useEnvironment(state.dialogs.settings || state.dialogs.environment);

  // The chat surface is decided by the server and published into the store; the
  // controller is carried as an opaque handle because its transcript mutates
  // per token and must not live in shell state.
  const chatActive = state.chat.active;
  const keyboardUp = useKeyboardUp(state.isMobile);
  const chatController = state.chat.controller as ChatController | null;
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);

  /**
   * The right-click menu's file actions, present only when there is a project.
   *
   * Composed here rather than added to ShellActions because both halves need
   * the session the user is looking at, and that is state this component
   * already holds — threading it down to build the same closure elsewhere would
   * be the same code with one more hop.
   */
  const chatSessionId = chatActive ? state.chat.sessionId : null;
  const menuActions = React.useMemo(
    () => ({
      ...actions,
      workspace: chatSessionId
        ? {
            download: (filePath: string) => downloadFile(chatSessionId, filePath),
            upload: (directory: string) => void pickAndUpload(chatSessionId, directory),
          }
        : undefined,
    }),
    [actions, chatSessionId],
  );

  const closePalette = React.useCallback(() => {
    shellStore.setState({ paletteOpen: false });
  }, []);

  const toggleTheme = React.useCallback(() => {
    const next = shellStore.getSnapshot().theme === 'dark' ? 'light' : 'dark';
    actions.setTheme(next);
  }, [actions]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        shellStore.setState({ paletteOpen: !shellStore.getSnapshot().paletteOpen });
      } else if (e.key === 'Escape') {
        shellStore.setState({ paletteOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The terminal's usable box changes whenever a bar appears or disappears
  // around it, and xterm only reflows when it is told to.
  React.useEffect(() => {
    actions.fitTerminal();
  }, [actions, state.isMobile, state.keysVisible, state.banner !== null]);

  const paletteGroups: CommandPaletteGroup[] = [
    {
      label: 'Session',
      items: [
        {
          label: 'New session',
          icon: <Icon name="plus" size={13} />,
          shortcut: ['Ctrl', 'T'],
          onSelect: () => { closePalette(); actions.newTab(); },
        },
        {
          label: 'All conversations',
          icon: <Icon name="message-square" size={13} />,
          onSelect: () => { closePalette(); closeDialogs({ conversations: true }); },
        },
        {
          label: 'All sessions',
          icon: <Icon name="layout-list" size={13} />,
          onSelect: () => { closePalette(); actions.openSessions(); },
        },
        ...(active
          ? [
              {
                label: `Rename ${active.title}`,
                icon: <Icon name="pencil" size={13} />,
                onSelect: () => { closePalette(); closeDialogs({ rename: active.id }); },
              },
              {
                label: `Close ${active.title}`,
                icon: <Icon name="x" size={13} />,
                shortcut: ['Ctrl', 'W'],
                onSelect: () => { closePalette(); actions.closeTab(active.id); },
              },
            ]
          : []),
      ],
    },
    {
      label: 'Terminal',
      items: [
        {
          label: 'Reconnect',
          icon: <Icon name="rotate-cw" size={13} />,
          onSelect: () => { closePalette(); actions.reconnect(); },
        },
        {
          label: 'Clear terminal',
          icon: <Icon name="eraser" size={13} />,
          onSelect: () => { closePalette(); actions.clearTerminal(); },
        },
        {
          label: 'Attach image',
          icon: <Icon name="image" size={13} />,
          onSelect: () => { closePalette(); actions.attachImage(); },
        },
      ],
    },
    {
      label: 'Go to',
      items: state.tabs.map((tab) => ({
        label: tab.title,
        icon: <Icon name="terminal" size={13} />,
        onSelect: () => { closePalette(); actions.selectTab(tab.id); },
      })),
    },
    {
      label: 'View',
      items: [
        {
          label: state.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
          icon: <Icon name="monitor" size={13} />,
          onSelect: () => { closePalette(); toggleTheme(); },
        },
        {
          label: 'Settings',
          icon: <Icon name="settings" size={13} />,
          onSelect: () => { closePalette(); actions.openSettings(); },
        },
        {
          label: 'Usage',
          icon: <Icon name="gauge" size={13} />,
          onSelect: () => { closePalette(); closeDialogs({ usage: true }); },
        },
        // Offered only while the browser is actually holding a deferred
        // prompt, so the entry is never a control that does nothing.
        ...(state.install === 'available'
          ? [{
              label: 'Install app',
              icon: <Icon name="download" size={13} />,
              onSelect: () => { closePalette(); void promptInstall(); },
            }]
          : []),
      ],
    },
  ];

  const statusLeft: StatusBarSegment[] = [
    {
      dot:
        state.connection.state === 'connected'
          ? 'var(--ansi-green)'
          : state.connection.state === 'connecting'
            ? 'var(--ansi-yellow)'
            : 'var(--destructive)',
      children: state.connection.state,
      title: 'Connection to the session server',
    },
    ...(active ? [{ children: active.title }] : []),
    ...(state.connection.workingDir
      ? [{ icon: <Icon name="folder" size={12} />, children: state.connection.workingDir }]
      : []),
  ];

  const statusRight: StatusBarSegment[] = [
    { children: `${state.tabs.length} ${state.tabs.length === 1 ? 'session' : 'sessions'}` },
    ...(state.user ? [{ children: `@${state.user}` }] : []),
    { children: state.theme === 'dark' ? 'Dark' : 'Light' },
  ];

  /**
   * Where a phone can be, and where it is.
   *
   * Inside a conversation the app has four places worth being — the
   * conversation, what the agent did, the files it did it to, and a shell in
   * the same directory — plus the other sessions. Outside one there is the
   * terminal and its keys. Every one of these *replaces* what fills the screen,
   * which is what makes them destinations rather than toggles.
   */
  /**
   * On a phone, which panel is open is where you are — not a preference.
   *
   * The rail replaces the conversation there rather than sitting beside it, so
   * a stored `panelOpen: true` would open every conversation onto a panel with
   * the conversation behind it. And writing the phone's answer back would
   * clobber the desktop's: the setting is shared, so one session on a phone
   * would silently close the rail on the machine it was set open on.
   *
   * So on a phone it lives here, for the life of the tab, and the persisted
   * settings never hear about it.
   */
  const [phonePanel, setPhonePanel] = React.useState<{ open: boolean; tab: ChatPanelId }>(() => ({
    open: false,
    tab: state.chatView.panelTab,
  }));
  const view: ChatViewSettings = state.isMobile
    ? { ...state.chatView, panelOpen: phonePanel.open, panelTab: phonePanel.tab }
    : state.chatView;
  const setView = React.useCallback(
    (next: ChatViewSettings): void => {
      if (!shellStore.getSnapshot().isMobile) {
        actions.setChatView(next);
        return;
      }
      setPhonePanel({ open: next.panelOpen, tab: next.panelTab });
      // Everything else is still a preference and still persists; only the two
      // fields that mean "where am I" are held back.
      const stored = shellStore.getSnapshot().chatView;
      actions.setChatView({ ...next, panelOpen: stored.panelOpen, panelTab: stored.panelTab });
    },
    [actions],
  );

  const goChat = (): void => setView({ ...view, panelOpen: false, terminalOpen: false });
  const goPanel = (panelTab: ChatPanelId): void =>
    setView({ ...view, panelOpen: true, panelTab, terminalOpen: false });

  const destinations: BottomNavDestination[] = chatActive
    ? [
        {
          id: 'chat',
          label: 'Chat',
          icon: 'message-square',
          current: !view.panelOpen && !view.terminalOpen,
          onGo: goChat,
        },
        {
          id: 'trace',
          label: 'Trace',
          icon: CHAT_PANEL_ICONS.trace,
          current: view.panelOpen && view.panelTab === 'trace',
          onGo: () => goPanel('trace'),
        },
        {
          id: 'files',
          label: 'Files',
          icon: CHAT_PANEL_ICONS.files,
          current: view.panelOpen && view.panelTab !== 'trace',
          onGo: () => goPanel('files'),
        },
        {
          id: 'terminal',
          label: 'Shell',
          icon: 'terminal',
          current: view.terminalOpen,
          onGo: () => setView({ ...view, panelOpen: false, terminalOpen: true }),
        },
        {
          id: 'sessions',
          label: 'Sessions',
          icon: 'layout-list',
          // A conversation that has stopped for an approval counts as much as
          // one with unread output: on a phone this destination badge is the
          // only cross-session signal there is — the tab strip is not rendered.
          badge: state.tabs.some((t) => (t.unread || t.attention !== null) && t.id !== state.activeId),
          onGo: () => closeDialogs({ tabs: true }),
        },
      ]
    : [
        { id: 'terminal', label: 'Shell', icon: 'terminal', current: true, onGo: () => {} },
        {
          id: 'keys',
          label: 'Keys',
          icon: 'keyboard',
          current: state.keysVisible,
          onGo: actions.toggleKeys,
        },
        {
          id: 'sessions',
          label: 'Sessions',
          icon: 'layout-list',
          // A conversation that has stopped for an approval counts as much as
          // one with unread output: on a phone this destination badge is the
          // only cross-session signal there is — the tab strip is not rendered.
          badge: state.tabs.some((t) => (t.unread || t.attention !== null) && t.id !== state.activeId),
          onGo: () => closeDialogs({ tabs: true }),
        },
      ];

  // Verbs, not places — see BottomNav. These are what the floating button is
  // for, and what a destination bar has no business holding.
  const sessionActions: FloatingMenuAction[] = [
    { id: 'new', label: 'New session', icon: 'plus', onPress: actions.newTab },
    // Only when there is no conversation on screen. Inside one, ChatView puts
    // this beside its transcript search, which is where the issue asks for it;
    // here it is the phone's route to the list when every conversation's tab has
    // been closed — otherwise closing the last one would close the door behind it.
    ...(chatActive
      ? []
      : [{
          id: 'conversations',
          label: 'All conversations',
          icon: 'message-square',
          expands: true,
          onPress: () => closeDialogs({ conversations: true }),
        } as FloatingMenuAction]),
    { id: 'image', label: 'Attach an image', icon: 'image', onPress: actions.attachImage },
    { id: 'rename', label: 'Rename this session', icon: 'pencil', disabled: !active, onPress: () => active && closeDialogs({ rename: active.id }) },
    { id: 'reconnect', label: 'Reconnect', icon: 'rotate-cw', onPress: actions.reconnect },
    {
      id: 'more',
      label: 'More…',
      icon: 'ellipsis',
      active: state.dialogs.more,
      expands: true,
      onPress: () => closeDialogs({ more: true }),
    },
  ];



  // No brand on a phone. It cost about a third of a 390px tab strip to say
  // something the user already knows, and the working directory that stood
  // there instead only repeated the tab title. The tabs get the room.
  const brand = state.isMobile ? null : (
    <div
      aria-hidden="true"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', flex: '0 0 auto',
        borderRight: '1px solid var(--border)', color: 'var(--muted-foreground)',
      }}
    >
      <Icon name="terminal" size={14} />
      <span
        style={{
          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
          letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        Code Agents
      </span>
    </div>
  );

  const barActions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px', flex: '0 0 auto' }}>
      {state.isMobile ? null : (
        <>
          {state.user ? <Badge>@{state.user}</Badge> : null}
          <IconButton label="Command palette" size="sm" onClick={() => shellStore.setState({ paletteOpen: true })}>
            <Icon name="command" />
          </IconButton>
          <IconButton label="Toggle theme" size="sm" onClick={toggleTheme}>
            <Icon name="monitor" />
          </IconButton>
        </>
      )}
      <IconButton label="Usage" size="sm" onClick={() => closeDialogs({ usage: true })}>
        <Icon name="gauge" />
      </IconButton>
      <IconButton label="Settings" size="sm" onClick={actions.openSettings}>
        <Icon name="settings" />
      </IconButton>
      {state.logoutUrl && !state.isMobile ? (
        <a
          href={state.logoutUrl}
          title="Sign out"
          aria-label="Sign out"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, color: 'var(--muted-foreground)',
          }}
        >
          <Icon name="log-out" />
        </a>
      ) : null}
    </div>
  );

  return (
    // The shell's phone answer, published to everything under it — including
    // the dialogs, which render here rather than inside any conversation and
    // would otherwise be the one part of a phone still drawn at desktop sizes.
    // ChatView publishes its own for the same value; a conversation rendered
    // outside this shell still has to know. See ui/touch.ts.
    <PhoneContext.Provider value={state.isMobile}>
    <div
      style={{
        // In flow rather than `position: absolute; inset: 0`. #app is a column
        // flex container with `position: relative`, so an absolute shell is
        // sized against #app and paints over its in-flow siblings.
        flex: 1,
        minHeight: 0,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        // The box the floating menu and its scrim are positioned against.
        position: 'relative',
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
      }}
    >
      <UpdateBannerView
        banner={state.banner}
        onAction={actions.updateAction}
        onToggleLog={actions.updateToggleLog}
        onDismiss={actions.updateDismiss}
      />

      {/* One bar, not two. The title row was a second full-width strip whose
          only unique content was a title the tab already shows, and on a phone
          it cost a tenth of the viewport. */}
      {/* On mobile the strip is gone entirely (issue #21): squeezed tabs are
          untappable and the row costs vertical space the terminal needs.
          Sessions are managed from the TabSwitcherSheet instead; everything
          else the strip's trailing side carried (theme, settings, sign-out)
          lives in the More sheet on a phone. */}
      {state.isMobile ? null : (
        <TabBar
          tabs={tabItems(state.tabs)}
          activeId={state.activeId ?? undefined}
          ariaLabel="Sessions"
          onSelect={actions.selectTab}
          onClose={actions.closeTab}
          onNew={() => actions.newTab()}
          onReorder={actions.reorderTabs}
          // Split view reads this off the drop; see split-container.ts.
          dragPayload={(id) => ({
            'application/x-session-id': id,
            'x-source-pane': '-1',
          })}
          onTabDoubleClick={(id) => closeDialogs({ rename: id })}
          onTabAuxClose={actions.closeTab}
          onTabContextMenu={(id, x, y) => setMenu({ id, x, y })}
          leading={brand}
          trailing={barActions}
          style={{ height: 38, flex: '0 0 auto' }}
        />
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {/*
          The terminal stays mounted even while the chat surface is showing.
          xterm is imperative and owns a live DOM node; unmounting it to swap
          surfaces would throw away the buffer, and re-parenting it is the one
          thing this shell has always refused to do. Hiding costs nothing.
        */}
        <div
          style={{
            flex: 1,
            display: chatActive ? 'none' : 'flex',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          <TerminalHost node={terminalNode} onResize={actions.fitTerminal} />
        </div>
        {chatActive && chatController ? (
          <ChatView
            // Keyed by session so switching tabs remounts the surface: the
            // scroller, the composer draft and every panel's fetch belong to
            // one conversation, and carrying them across would show the new
            // chat scrolled to the old one's position.
            key={chatController.sessionId}
            controller={chatController}
            runtime={state.chat.runtime}
            runtimeLabel={state.chat.runtimeLabel || state.chat.runtime}
            workingDir={state.chat.workingDir || active?.workingDir || ''}
            isMobile={state.isMobile}
            // For the recovery notice's labels only. The conversation's own
            // mode is on the transcript; this is what a *new* one would get.
            approvalPreference={state.chatBypassPermissions}
            view={view}
            onViewChange={setView}
            onOpenSettings={() => closeDialogs({ chatSettings: true })}
            onOpenConversations={() => closeDialogs({ conversations: true })}
            menuActions={sessionActions}
            onOpenConversation={actions.openConversation}
            // The chat surface owns the whole viewport, so the tab strip's own
            // theme button is off-screen while a conversation is showing.
            theme={state.theme}
            onToggleTheme={toggleTheme}
          />
        ) : null}
        <OverlayHost
          view={state.overlay}
          message={state.overlayMessage}
          errorText={state.errorText}
          onRetry={actions.retryConnection}
          launcher={launcher}
        />
      </div>

      {/* Not over a conversation: the strip sends terminal control codes, and
          the chat surface has its own composer. Now that its toggle gives up
          the mobile-bar slot to the workspace panel in chat mode, leaving the
          strip rendered would also leave it with no way to be dismissed. */}
      {state.isMobile && state.keysVisible && !chatActive ? (
        <KeyStrip
          ctrlLatched={state.ctrlLatched}
          onKey={actions.sendMobileKey}
          onToggleCtrl={actions.toggleCtrl}
          onShowKeyboard={actions.showKeyboard}
        />
      ) : null}

      {/* The phone's only permanent chrome. A bar along the bottom edge cost
          56px plus the safe-area inset of a screen whose whole point is the
          conversation; this costs the corner it covers. */}
      {/* Over a conversation the menu belongs to the chat surface, which is
          the only thing that knows where its composer ends — see ChatView. Out
          here it covers the terminal, which has no bottom-right control of its
          own to collide with. */}
      {state.isMobile && !chatActive ? (
        <FloatingMenu
          actions={sessionActions}
          bottomOffset={(state.keysVisible ? KEY_STRIP_HEIGHT : 0) + MOBILE_BAR_HEIGHT}
        />
      ) : null}

      {state.isMobile ? (
        <BottomNav destinations={destinations} hidden={keyboardUp} />
      ) : (
        <StatusBar left={statusLeft} right={statusRight} />
      )}

      <CommandPalette
        open={state.paletteOpen}
        groups={paletteGroups}
        placeholder="Search sessions and commands…"
        onClose={closePalette}
      />

      <SettingsDialog
        open={state.dialogs.settings}
        settings={actions.readSettings()}
        install={state.install}
        onInstall={() => void installHint()}
        onOpenRuntimeProfiles={() => closeDialogs({ settings: false, runtimeProfiles: true })}
        onOpenDeployTargets={() => closeDialogs({ settings: false, deployTargets: true })}
        environmentsEnabled={environment.info?.enabled === true}
        onOpenEnvironment={() => closeDialogs({ settings: false, environment: true })}
        onOpenProjects={() => closeDialogs({ settings: false, projects: true })}
        onPreview={actions.previewSettings}
        onSave={(next) => { actions.saveSettings(next); closeDialogs({ settings: false }); }}
        onClose={() => {
          // Every edit is previewed straight onto the live terminal, so
          // cancelling has to put the persisted values back — otherwise
          // "Cancel" left the font size and palette the user was only trying
          // out in place until the next reload.
          actions.previewSettings(actions.readSettings());
          closeDialogs({ settings: false });
        }}
      />

      <UsageDashboardDialog
        open={state.dialogs.usage}
        onClose={() => closeDialogs({ usage: false })}
      />

      <RuntimeProfilesDialog
        open={state.dialogs.runtimeProfiles}
        onClose={() => closeDialogs({ runtimeProfiles: false })}
      />

      <DeployTargetsDialog
        open={state.dialogs.deployTargets}
        onClose={() => closeDialogs({ deployTargets: false })}
      />

      <EnvironmentDialog
        open={state.dialogs.environment}
        info={environment.info}
        error={environment.error}
        busy={environment.busy}
        notice={environment.notice}
        onApply={(tier) => void environment.apply(tier)}
        onClose={() => closeDialogs({ environment: false })}
      />

      <ProjectsDialog
        open={state.dialogs.projects}
        onClose={() => closeDialogs({ projects: false })}
        onOpenProject={(projectId) => {
          closeDialogs({ projects: false });
          actions.openProjectSession(projectId);
        }}
      />

      <ChatSettingsDialog
        open={state.dialogs.chatSettings}
        settings={state.chatView}
        onChange={actions.setChatView}
        onClose={() => closeDialogs({ chatSettings: false })}
      />

      <NewSessionDialog
        open={state.dialogs.newSession}
        defaultWorkingDir={state.folder.path}
        onCreate={(name, workingDir) => actions.createSession(name, workingDir)}
        onClose={() => closeDialogs({ newSession: false })}
      />

      <TerminalOptionsDialog
        open={state.dialogs.terminalOptions}
        onShell={actions.startShell}
        onCommand={actions.runCommand}
        onClose={() => closeDialogs({ terminalOptions: false })}
      />

      <FolderBrowserDialog
        open={state.folder.open}
        path={state.folder.path}
        parentPath={state.folder.parentPath}
        entries={state.folder.entries}
        workingDirKind={state.folder.workingDirKind}
        lifetime={state.folder.lifetime}
        showHidden={state.folder.showHidden}
        loading={state.folder.loading}
        creating={state.folder.creating}
        onNavigate={actions.folderNavigate}
        onUp={actions.folderUp}
        onHome={actions.folderHome}
        onToggleHidden={actions.folderToggleHidden}
        onStartCreate={actions.folderStartCreate}
        onCancelCreate={actions.folderCancelCreate}
        onCreate={actions.folderCreate}
        onSelect={actions.folderSelect}
        onClose={actions.folderClose}
      />

      <SessionsDialog
        open={state.dialogs.sessions}
        sessions={state.sessionList}
        activeId={state.activeId}
        onJoin={(id) => { closeDialogs({ sessions: false }); actions.joinSession(id); }}
        onLeave={() => { closeDialogs({ sessions: false }); actions.leaveSession(); }}
        onDelete={actions.deleteSession}
        onNew={() => { closeDialogs({ sessions: false }); actions.newTab(); }}
        onClose={() => closeDialogs({ sessions: false })}
      />

      <ConversationsDialog
        open={state.dialogs.conversations}
        load={actions.loadConversations}
        // Every tab, not only the ones known to be chats: a tab whose surface has
        // not come back from the server yet is still a tab, and a row that says
        // "open" about it is right either way — picking it switches to that tab.
        openIds={state.tabs.map((tab) => tab.id)}
        activeId={state.activeId}
        onOpen={(conversation) => {
          closeDialogs({ conversations: false });
          actions.openStoredConversation(conversation);
        }}
        onDelete={actions.deleteConversation}
        onClose={() => closeDialogs({ conversations: false })}
      />

      <TabSwitcherSheet
        open={state.dialogs.tabs}
        tabs={state.tabs}
        activeId={state.activeId}
        onSelect={(id) => { closeDialogs({ tabs: false }); actions.selectTab(id); }}
        onCloseTab={(id) => actions.closeTab(id)}
        onNew={() => { closeDialogs({ tabs: false }); actions.newTab(); }}
        onAllSessions={() => { closeDialogs({ tabs: false }); actions.openSessions(); }}
        onClose={() => closeDialogs({ tabs: false })}
      />

      <PlanDialog
        open={state.plan !== null}
        content={state.plan ?? ''}
        onAccept={actions.acceptPlan}
        onReject={actions.rejectPlan}
        onClose={() => shellStore.setState({ plan: null })}
      />

      <RenameDialog
        open={state.dialogs.rename !== null}
        initialName={state.tabs.find((t) => t.id === state.dialogs.rename)?.title ?? ''}
        onRename={(name) => {
          const id = shellStore.getSnapshot().dialogs.rename;
          if (id) actions.renameTab(id, name);
          closeDialogs({ rename: null });
        }}
        onClose={() => closeDialogs({ rename: null })}
      />

      <ConfirmDialog request={state.confirm} onAnswer={resolveConfirm} />

      <MoreSheet
        open={state.dialogs.more}
        theme={state.theme}
        logoutUrl={state.logoutUrl}
        canCloseSession={active !== null}
        install={state.install}
        onInstall={() => void installHint()}
        onClose={() => closeDialogs({ more: false })}
        onReconnect={actions.reconnect}
        onClearTerminal={actions.clearTerminal}
        onSwitchMode={actions.switchMode}
        onCloseSession={actions.closeCurrentSession}
        onOpenSettings={actions.openSettings}
        onOpenUsage={() => closeDialogs({ usage: true, more: false })}
        onToggleTheme={toggleTheme}
        onRename={active ? () => closeDialogs({ rename: active.id, more: false }) : undefined}
      />

      <Toasts
        toasts={state.toasts}
        isMobile={state.isMobile}
        bottomOffset={state.isMobile && state.keysVisible ? KEY_STRIP_HEIGHT : 0}
        onDismiss={(id) => {
          shellStore.setState({ toasts: shellStore.getSnapshot().toasts.filter((t) => t.id !== id) });
        }}
      />

      {menu ? (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: 'Rename', onSelect: () => closeDialogs({ rename: menu.id }) },
            {
              label: 'Close others',
              onSelect: () => actions.closeOtherTabs(menu.id),
              disabled: state.tabs.length < 2,
            },
            { label: 'Close', onSelect: () => actions.closeTab(menu.id), destructive: true },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {/* Last, so it sits above everything and its own `contextmenu` listener
          is the final one to see an event no surface claimed. */}
      <AppContextMenu
        actions={menuActions}
        theme={state.theme}
        hasTerminal={state.tabs.some((tab) => tab.id === state.activeId && tab.surface !== 'chat')}
      />
    </div>
    </PhoneContext.Provider>
  );
}

/**
 * Ask for files and put them in a folder of the project.
 *
 * A file input created on demand rather than a hidden one kept in the tree: it
 * is used from a menu item that only exists while a project is open, and a
 * permanently-mounted input would be one more thing for the shortcut guard and
 * the focus order to step around for the sake of a gesture used occasionally.
 */
async function pickAndUpload(sessionId: string, directory: string): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);

  const files = await new Promise<File[]>((resolve) => {
    // `cancel` is not universally supported, so the promise must not be the
    // only thing keeping the input alive — `change` settles it where it fires,
    // and the removal below runs either way.
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.addEventListener(
      'change',
      () => resolve(Array.from(input.files || [])),
      { once: true },
    );
    input.click();
  });
  input.remove();
  if (!files.length) return;

  let wrote = 0;
  for (const file of files) {
    try {
      await uploadIntoWorkspace(sessionId, directory, file);
      wrote += 1;
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 409) {
        // The one outcome that cannot be undone from here, so it is asked
        // rather than assumed — per file, because "replace all" on a multi-file
        // drop is a different promise than the one the user made.
        const replace = await showConfirm({
          title: `Replace ${file.name}?`,
          description: `A file called ${file.name} is already in that folder. Replacing it cannot be undone from here.`,
          confirmLabel: 'Replace',
          tone: 'danger',
        });
        if (!replace) continue;
        try {
          await uploadIntoWorkspace(sessionId, directory, file, { overwrite: true });
          wrote += 1;
          continue;
        } catch (retryError) {
          showError(retryError instanceof Error ? retryError.message : 'That file could not be uploaded');
          continue;
        }
      }
      showError(error instanceof Error ? error.message : 'That file could not be uploaded');
    }
  }

  // The tree is the thing that just became wrong. Announced rather than called,
  // because the panel that has to re-read is not in this component's tree.
  if (wrote > 0) {
    window.dispatchEvent(new CustomEvent('ccweb:workspace-changed', { detail: { directory } }));
  }
}


/** The height the bar reserves, matching `--mobile-bar-height`. */
const MOBILE_BAR_HEIGHT = 56;

/**
 * Whether the on-screen keyboard is up.
 *
 * `visualViewport` is the only thing that reports it: a phone keyboard does not
 * resize the layout viewport, it covers it. The bar goes away while it is up —
 * the keyboard takes half the screen and the half it leaves is the half being
 * typed into, which is the one moment nobody is navigating.
 *
 * The threshold is generous on purpose. A browser's own collapsing address bar
 * moves the visual viewport by 60-90px and is not a keyboard; every phone
 * keyboard is far taller than that.
 */
function useKeyboardUp(isMobile: boolean): boolean {
  const [up, setUp] = React.useState(false);

  React.useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    if (!isMobile || !viewport) {
      setUp(false);
      return;
    }
    const measure = (): void => setUp(visualViewportKeyboardInset(viewport) > 160);
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
    };
  }, [isMobile]);

  return up;
}
