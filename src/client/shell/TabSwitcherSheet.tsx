import * as React from 'react';

import { Button } from '../ui/relay/Button';
import { Dialog } from '../ui/relay/Dialog';
import { Icon } from '../ui/relay/Icon';
import { SessionStateIcon, sessionStateVisual } from '../ui/SessionStateIcon';
import { PHONE_TEXT, TOUCH_TARGET, usePhone } from '../ui/touch';
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
  // Whether a conversation is waiting is live session information, and the
  // phone rule for that is explicit: never below the body size. At the caption
  // size the rest of this row uses it would be the smallest thing on the
  // screen, on the one surface where it is the only thing that answers the
  // question.
  const isPhone = usePhone();
  const state = sessionStateVisual(tab);

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
      <SessionStateIcon
        status={tab.status}
        unread={tab.unread}
        attention={tab.attention}
        size={15}
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
          // Stretching to the row was not enough on its own: a row of one short
          // line is 38px tall, which is under what a thumb reliably hits.
          minHeight: TOUCH_TARGET,
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
          {tab.attention ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                flex: '0 0 auto',
                fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-sm)',
                color: state.color,
                whiteSpace: 'nowrap',
              }}
            >
              {state.label}
            </span>
          ) : tab.unread ? (
            <span
              style={{
                flex: '0 0 auto',
                fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-sm)',
                color: state.state === 'success' ? state.color : 'var(--primary)',
                whiteSpace: 'nowrap',
              }}
            >
              {state.state === 'success' ? 'Completed' : 'New output'}
            </span>
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
      <IconButton
        label={`Close ${tab.title}`}
        onClick={onCloseTab}
        style={{ width: TOUCH_TARGET, height: TOUCH_TARGET, flex: '0 0 auto' }}
      >
        <Icon name="x" size={18} />
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
 * session ringed, state shown by icon and colour, close per row, and the two
 * ways to get more sessions (a fresh one, or the server-wide list) at the bottom.
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
          {/* `lg` is 38px, which is still short of a thumb, so the height is
              stated outright — this sheet only ever appears on a phone. */}
          <Button
            variant="primary"
            size="lg"
            style={{ height: TOUCH_TARGET }}
            iconLeft={<Icon name="plus" size={16} />}
            onClick={onNew}
          >
            New session
          </Button>
          <Button
            variant="secondary"
            size="lg"
            style={{ height: TOUCH_TARGET }}
            iconLeft={<Icon name="server" size={16} />}
            onClick={onAllSessions}
          >
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
