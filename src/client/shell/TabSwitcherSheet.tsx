import * as React from 'react';

import { Button } from '../ui/relay/Button';
import { Dialog } from '../ui/relay/Dialog';
import { Icon } from '../ui/relay/Icon';
import { IconButton } from '../ui/relay/IconButton';
import type { ShellTab } from './store';

export interface TabSwitcherSheetProps {
  open: boolean;
  tabs: ShellTab[];
  activeId: string | null;
  onSelect(id: string): void;
  onCloseTab(id: string): void;
  onNew(): void;
  /** Opens the server-wide session list (join/leave/delete). */
  onAllSessions(): void;
  onClose(): void;
}

function statusColor(status: ShellTab['status']): string {
  switch (status) {
    case 'running': return 'var(--ansi-green)';
    case 'error': return 'var(--destructive)';
    default: return 'var(--muted-foreground)';
  }
}

/** Last path segment; `/` keeps a label when the session sits at the root. */
function folderLabel(workingDir: string): string {
  return workingDir.split('/').filter(Boolean).pop() || '/';
}

function TabRow({
  tab,
  isActive,
  onSelect,
  onCloseTab,
}: {
  tab: ShellTab;
  isActive: boolean;
  onSelect(): void;
  onCloseTab(): void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 52,
        padding: '6px 6px 6px 12px',
        background: 'var(--card)',
        border: '1px solid',
        borderColor: isActive ? 'var(--ring)' : 'var(--border)',
        borderRadius: 'var(--radius)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          flex: '0 0 auto',
          borderRadius: 'var(--radius-full)',
          background: statusColor(tab.status),
        }}
      />
      {/* The row is the switch target, not just the text: on a phone the whole
          card has to be the button, or switching means aiming. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'true' : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 3,
          border: 'none',
          background: 'transparent',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-sans)',
          textAlign: 'left',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--text-ui)',
            overflow: 'hidden',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tab.title}
          </span>
          {tab.unread ? (
            <span
              role="img"
              aria-label="Unread output"
              style={{
                width: 6,
                height: 6,
                flex: '0 0 auto',
                borderRadius: 'var(--radius-full)',
                background: 'var(--primary)',
              }}
            />
          ) : null}
        </span>
        {tab.workingDir ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
              overflow: 'hidden',
            }}
          >
            <Icon name="folder" size={11} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {folderLabel(tab.workingDir)}
            </span>
          </span>
        ) : null}
      </button>
      <IconButton label={`Close ${tab.title}`} onClick={onCloseTab}>
        <Icon name="x" size={15} />
      </IconButton>
    </div>
  );
}

/**
 * The mobile tab switcher (issue #21).
 *
 * The desktop tab strip does not fit a phone: several sessions squeeze into a
 * narrow strip that eats vertical space and turns switching into target
 * practice. On mobile the strip is not rendered at all and sessions live in
 * this bottom sheet instead — full-width rows a thumb can hit, the active
 * session ringed, unread output dotted, close per row, and the two ways to
 * get more sessions (a fresh one, or the server-wide list) at the bottom.
 */
export function TabSwitcherSheet({
  open,
  tabs,
  activeId,
  onSelect,
  onCloseTab,
  onNew,
  onAllSessions,
  onClose,
}: TabSwitcherSheetProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <Dialog
      open={open}
      placement="bottom"
      title="Sessions"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          <Button variant="primary" iconLeft={<Icon name="plus" size={14} />} onClick={onNew}>
            New session
          </Button>
          <Button variant="secondary" iconLeft={<Icon name="server" size={14} />} onClick={onAllSessions}>
            All sessions
          </Button>
        </div>
      }
    >
      {tabs.length === 0 ? (
        <div
          style={{
            padding: '28px 16px',
            textAlign: 'center',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius)',
            fontSize: 'var(--text-sm)',
            color: 'var(--muted-foreground)',
          }}
        >
          No open sessions
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: '52vh',
            overflowY: 'auto',
          }}
        >
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeId}
              onSelect={() => onSelect(tab.id)}
              onCloseTab={() => onCloseTab(tab.id)}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}
