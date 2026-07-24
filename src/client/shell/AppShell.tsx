import * as React from 'react';

import type { AppSettings } from '../types';
import { Badge } from '../ui/relay/Badge';
import { CommandPalette, type CommandPaletteGroup } from '../ui/relay/CommandPalette';
import { Icon } from '../ui/relay/Icon';
import { IconButton } from '../ui/relay/IconButton';
import { StatusBar, type StatusBarSegment } from '../ui/relay/StatusBar';
import { TabBar, type TabItem } from '../ui/relay/TabBar';
import { FolderBrowserDialog } from './dialogs/FolderBrowserDialog';
import { NewSessionDialog } from './dialogs/NewSessionDialog';
import { PlanDialog } from './dialogs/PlanDialog';
import { RenameDialog } from './dialogs/RenameDialog';
import { SessionsDialog } from './dialogs/SessionsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { TerminalOptionsDialog } from './dialogs/TerminalOptionsDialog';
import { MobileBar, type MobileBarAction } from './MobileBar';
import { TabSwitcherSheet } from './TabSwitcherSheet';
import { KeyStrip, KEY_STRIP_HEIGHT } from './KeyStrip';
import type { MobileKey } from '../ui/mobile';
import { MoreSheet } from './MoreSheet';
import { installHint, promptInstall } from './install-prompt';
import { OverlayHost } from './OverlayHost';
import { TabContextMenu } from './TabContextMenu';
import { TerminalHost } from './TerminalHost';
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
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);

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
    // The on-screen key strip carries Escape now; this toggles it for the
    // moments the terminal needs the vertical room back.
    {
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
        <TerminalHost node={terminalNode} onResize={actions.fitTerminal} />
        <OverlayHost
          view={state.overlay}
          message={state.overlayMessage}
          errorText={state.errorText}
          onRetry={actions.retryConnection}
          launcher={launcher}
        />
      </div>

      {state.isMobile && state.keysVisible ? (
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
    </div>
  );
}
