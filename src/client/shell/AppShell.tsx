import * as React from 'react';

import type { AppSettings } from '../types';
import { Badge } from '../ui/relay/Badge';
import { CommandPalette, type CommandPaletteGroup } from '../ui/relay/CommandPalette';
import { Icon } from '../ui/relay/Icon';
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
import { SessionsDialog } from './dialogs/SessionsDialog';
import { ChatSettingsDialog } from './dialogs/ChatSettingsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { TerminalOptionsDialog } from './dialogs/TerminalOptionsDialog';
import { MobileBar, type MobileBarAction } from './MobileBar';
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
import type { ChatViewSettings } from '../chat/view-settings';
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

  // Plan
  acceptPlan(): void;
  rejectPlan(): void;

  // Connection overlay
  retryConnection(): void;

  // Chat surface
  /** Persist and publish a change to the chat's display settings. */
  setChatView(next: ChatViewSettings): void;

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
    title: tab.title,
    status: tab.status === 'running' ? 'running' : tab.status === 'error' ? 'error' : 'idle',
    unread: tab.unread,
    tooltip: tab.workingDir ?? tab.title,
  }));
}

function closeDialogs(patch: Parameters<typeof shellStore.patchSlice<'dialogs'>>[1]): void {
  shellStore.patchSlice('dialogs', patch);
}

export function AppShell({ terminalNode, actions, launcher }: AppShellProps): React.JSX.Element {
  const state: ShellState = React.useSyncExternalStore(
    shellStore.subscribe,
    shellStore.getSnapshot,
    shellStore.getSnapshot,
  );

  const active = state.tabs.find((t) => t.id === state.activeId) || null;

  // The chat surface is decided by the server and published into the store; the
  // controller is carried as an opaque handle because its transcript mutates
  // per token and must not live in shell state.
  const chatActive = state.chat.active;
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

  const mobileActions: MobileBarAction[] = [
    {
      id: 'sessions',
      label: 'Sessions',
      icon: 'layout-list',
      badge: state.tabs.some((t) => t.unread && t.id !== state.activeId),
      active: state.dialogs.tabs,
      expands: true,
      onPress: () => closeDialogs({ tabs: true }),
    },
    { id: 'new', label: 'New', icon: 'plus', onPress: actions.newTab },
    // One slot, two jobs, decided by what is on screen.
    //
    // The key strip sends terminal control codes, which a conversation has no
    // use for; the workspace panel is meaningless without one. Giving each its
    // own slot would put six items on a 390px bar with one of them always
    // inert. This shows whichever the current surface can actually use.
    chatActive
      ? {
          id: 'workspace',
          label: 'Panel',
          icon: 'panel-left',
          active: state.chatView.panelOpen,
          toggle: true,
          onPress: () =>
            actions.setChatView({ ...state.chatView, panelOpen: !state.chatView.panelOpen }),
        }
      : {
          // The on-screen key strip carries Escape now; this toggles it for the
          // moments the terminal needs the vertical room back.
          id: 'keys',
          label: 'Keys',
          icon: 'keyboard',
          active: state.keysVisible,
          toggle: true,
          onPress: actions.toggleKeys,
        },
    { id: 'image', label: 'Image', icon: 'image', onPress: actions.attachImage },
    {
      id: 'more',
      label: 'More',
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
            bypassPermissions={state.chat.bypassPermissions}
            view={state.chatView}
            onViewChange={actions.setChatView}
            onOpenSettings={() => closeDialogs({ chatSettings: true })}
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

      {state.isMobile ? <MobileBar actions={mobileActions} /> : <StatusBar left={statusLeft} right={statusRight} />}

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

      <RuntimeProfilesDialog
        open={state.dialogs.runtimeProfiles}
        onClose={() => closeDialogs({ runtimeProfiles: false })}
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
