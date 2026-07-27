import * as React from 'react';

import type { InstallState } from './store';
import { Dialog } from '../ui/relay/Dialog';
import { Icon } from '../ui/relay/Icon';

export interface MoreSheetProps {
  open: boolean;
  theme: 'dark' | 'light';
  logoutUrl: string | null;
  /** False when there is no session, which makes half the actions meaningless. */
  canCloseSession: boolean;
  /** Whether this window can become an installed app. */
  install: InstallState;
  onInstall(): void;
  onClose(): void;
  onReconnect(): void;
  onClearTerminal(): void;
  onSwitchMode(): void;
  onCloseSession(): void;
  onOpenSettings(): void;
  onOpenUsage(): void;
  onToggleTheme(): void;
  onRename?(): void;
}

interface SheetAction {
  label: string;
  icon: string;
  onPress(): void;
  destructive?: boolean;
}

/**
 * The mobile bar's overflow.
 *
 * A bottom sheet rather than the old right-hand drawer: it comes from the edge
 * the thumb is already at, and it reuses `Dialog` so focus handling, stacked
 * Escape and labelling are the same everywhere in the app.
 */
export function MoreSheet({
  open, theme, logoutUrl, canCloseSession, install, onClose, onInstall,
  onReconnect, onClearTerminal, onSwitchMode, onCloseSession,
  onOpenSettings, onOpenUsage, onToggleTheme, onRename,
}: MoreSheetProps): React.JSX.Element | null {
  if (!open) return null;

  const run = (fn: () => void) => () => {
    // Every action closes the sheet: it covers the terminal, and all of these
    // are things you do *to* the terminal.
    onClose();
    fn();
  };

  const actions: SheetAction[] = [
    { label: 'Reconnect', icon: 'rotate-cw', onPress: run(onReconnect) },
    { label: 'Clear terminal', icon: 'eraser', onPress: run(onClearTerminal) },
    { label: 'Switch mode (Shift+Tab)', icon: 'keyboard', onPress: run(onSwitchMode) },
    ...(onRename ? [{ label: 'Rename session', icon: 'pencil', onPress: onRename }] : []),
    { label: 'Settings', icon: 'settings', onPress: run(onOpenSettings) },
    { label: 'Usage', icon: 'gauge', onPress: run(onOpenUsage) },
    {
      label: theme === 'dark' ? 'Light theme' : 'Dark theme',
      icon: 'monitor',
      onPress: run(onToggleTheme),
    },
    // Offered whenever installing is still a thing that can happen. On iOS the
    // row explains the share-sheet route rather than pretending to do it; once
    // installed it disappears, because there is nothing left to offer.
    // `insecure` is listed too: a phone reaches this server over http on the
    // LAN, which is precisely the case where installing looks broken, and an
    // absent row would leave nowhere to find out why.
    ...(install === 'available'
      ? [{ label: 'Install app', icon: 'download', onPress: run(onInstall) }]
      : install === 'ios'
        ? [{ label: 'Install: use Share, Add to Home Screen', icon: 'download', onPress: run(onInstall) }]
        : install === 'insecure'
          ? [{ label: 'Install app: needs HTTPS', icon: 'download', onPress: run(onInstall) }]
          : install === 'blocked'
            ? [{ label: 'Install app: trust the certificate', icon: 'download', onPress: run(onInstall) }]
            : []),
    ...(canCloseSession
      ? [{ label: 'Close session', icon: 'trash-2', onPress: run(onCloseSession), destructive: true }]
      : []),
  ];

  return (
    <Dialog open placement="bottom" title="More" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '-8px -6px' }}>
        {actions.map((action) => (
          <SheetRow key={action.label} action={action} />
        ))}
        {logoutUrl ? (
          <a
            href={logoutUrl}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, padding: '0 12px',
              borderRadius: 'var(--radius)', color: 'var(--muted-foreground)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', textDecoration: 'none',
            }}
          >
            <Icon name="log-out" size={17} />
            <span>Sign out</span>
          </a>
        ) : null}
      </div>
    </Dialog>
  );
}

function SheetRow({ action }: { action: SheetAction }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={action.onPress}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        // 48px: the smallest row a thumb hits reliably.
        minHeight: 48,
        padding: '0 12px',
        width: '100%',
        border: 'none',
        borderRadius: 'var(--radius)',
        background: 'transparent',
        color: action.destructive ? 'var(--destructive)' : 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-body)',
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Icon name={action.icon} size={17} />
      <span>{action.label}</span>
    </button>
  );
}
