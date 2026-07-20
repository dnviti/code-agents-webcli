import * as React from 'react';

import { CommandPalette, type CommandPaletteGroup } from '../ui/relay/CommandPalette';
import { Icon } from '../ui/relay/Icon';
import { IconButton } from '../ui/relay/IconButton';
import { ProfileSidebar, type ProfileSidebarGroup } from '../ui/relay/ProfileSidebar';
import { StatusBar, type StatusBarSegment } from '../ui/relay/StatusBar';
import { TabBar, type TabItem } from '../ui/relay/TabBar';
import { WindowControls } from '../ui/relay/WindowControls';
import { TerminalHost } from './TerminalHost';
import { shellStore, type ShellState, type ShellTab } from './store';

/** What the shell needs from the imperative App, named rather than passing App itself. */
export interface ShellActions {
  selectTab(id: string): void;
  closeTab(id: string): void;
  newTab(): void;
  openSettings(): void;
  fitTerminal(): void;
  setTheme(theme: 'dark' | 'light'): void;
}

export interface AppShellProps {
  terminalNode: HTMLElement;
  actions: ShellActions;
}

/**
 * Runtime kind -> the label its sidebar group gets.
 *
 * A session whose kind is not known yet falls into "Sessions". Nothing
 * client-side currently records which runtime a tab belongs to — SessionInfo
 * carries id, name, status and workingDir only — so rather than guess a kind
 * and mislabel every group, unknown stays unknown until that is plumbed
 * through from the server's SessionRecord.agent.
 */
const UNGROUPED = 'Sessions';

const GROUP_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agent: 'Cursor',
  pi: 'pi',
  grok: 'Grok',
  qwen: 'Qwen',
  kimi: 'Kimi',
  terminal: 'Terminal',
};

function sidebarGroups(tabs: ShellTab[]): ProfileSidebarGroup[] {
  // Grouped by runtime rather than by connection type: Relay's own sidebar
  // groups Local/SSH/Serial, but this app's sessions differ by which agent is
  // driving them, which is the distinction a user actually navigates by.
  const byKind = new Map<string, ShellTab[]>();
  for (const tab of tabs) {
    const list = byKind.get(tab.kind);
    if (list) list.push(tab);
    else byKind.set(tab.kind, [tab]);
  }

  // indexOf returns -1 for a kind that is not in GROUP_LABELS, which would sort
  // it *ahead* of every known runtime — so the moment a new kind appears, or
  // while the kind is still the empty placeholder, the unknown group jumps to
  // the top. Unranked kinds sort last instead, and ties break by label so the
  // order is stable rather than dependent on insertion.
  const order = Object.keys(GROUP_LABELS);
  const rank = (kind: string): number => {
    const i = order.indexOf(kind);
    return i === -1 ? order.length : i;
  };
  return [...byKind.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([kind, items]) => ({
      label: GROUP_LABELS[kind] || (kind ? kind : UNGROUPED),
      items: items.map((tab) => ({
        id: tab.id,
        label: tab.title,
        meta: tab.workingDir ? basename(tab.workingDir) : undefined,
        status: tab.status === 'running' ? 'online' : tab.status === 'error' ? 'error' : 'busy',
      })),
    }));
}

function basename(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

function tabItems(tabs: ShellTab[]): TabItem[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    status: tab.status === 'running' ? 'running' : tab.status === 'error' ? 'error' : 'idle',
  }));
}

export function AppShell({ terminalNode, actions }: AppShellProps): React.JSX.Element {
  const state: ShellState = React.useSyncExternalStore(
    shellStore.subscribe,
    shellStore.getSnapshot,
    shellStore.getSnapshot,
  );

  const active = state.tabs.find((t) => t.id === state.activeId) || null;

  const closePalette = React.useCallback(() => {
    shellStore.setState({ paletteOpen: false });
  }, []);

  const toggleSidebar = React.useCallback(() => {
    shellStore.setState({ sidebarOpen: !shellStore.getSnapshot().sidebarOpen });
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
        ...(active
          ? [{
              label: `Close ${active.title}`,
              icon: <Icon name="x" size={13} />,
              shortcut: ['Ctrl', 'W'],
              onSelect: () => { closePalette(); actions.closeTab(active.id); },
            }]
          : []),
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
          label: 'Toggle sidebar',
          icon: <Icon name="panel-left" size={13} />,
          onSelect: () => { closePalette(); toggleSidebar(); },
        },
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
    { children: state.theme === 'dark' ? 'Dark' : 'Light' },
  ];

  return (
    <div
      style={{
        // In flow rather than `position: absolute; inset: 0`. #app is a column
        // flex container with `position: relative`, so an absolute shell is
        // sized against #app and paints over its in-flow siblings — the update
        // banner sits above the shell in that column and was being covered.
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
      {/* os="none": this runs in a browser tab, so traffic lights or caption
          glyphs would be buttons that close and minimise nothing. */}
      <WindowControls title={active ? active.title : 'Code Agents Web CLI'} os="none">
        <IconButton label="Toggle sidebar" size="sm" active={state.sidebarOpen} onClick={toggleSidebar}>
          <Icon name="panel-left" />
        </IconButton>
        <IconButton
          label="Command palette"
          size="sm"
          onClick={() => shellStore.setState({ paletteOpen: true })}
        >
          <Icon name="command" />
        </IconButton>
        <IconButton label="Settings" size="sm" onClick={actions.openSettings}>
          <Icon name="settings" />
        </IconButton>
        <IconButton label="Toggle theme" size="sm" onClick={toggleTheme}>
          <Icon name="monitor" />
        </IconButton>
      </WindowControls>

      <TabBar
        tabs={tabItems(state.tabs)}
        activeId={state.activeId ?? undefined}
        onSelect={actions.selectTab}
        onClose={actions.closeTab}
        onNew={() => actions.newTab()}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {state.sidebarOpen && state.tabs.length > 0 ? (
          <ProfileSidebar
            title="Sessions"
            groups={sidebarGroups(state.tabs)}
            activeId={state.activeId ?? undefined}
            onSelect={actions.selectTab}
            // Without this the header "+" renders as inert decoration. It reads
            // as a control, so it should be one.
            onNew={actions.newTab}
            newLabel="New session"
          />
        ) : null}
        <TerminalHost node={terminalNode} onResize={actions.fitTerminal} />
      </div>

      <StatusBar left={statusLeft} right={statusRight} />

      <CommandPalette
        open={state.paletteOpen}
        groups={paletteGroups}
        placeholder="Search sessions and commands…"
        onClose={closePalette}
      />
    </div>
  );
}
