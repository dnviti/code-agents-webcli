import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import type { TurnStatus, TurnSummary } from '../../chat/turns.js';

/**
 * Every turn in the conversation, as a list you can jump around.
 *
 * A long session is a scrollbar with no landmarks: "the twelfth thing I asked"
 * is a unit the user thinks in and the message list has no name for. This gives
 * each one a number, an outcome glyph and the first line of what was asked.
 *
 * Selection moves with the arrow keys and commits on Enter, which is what makes
 * this a real navigation surface rather than a set of buttons that happen to be
 * stacked. Scrolling is done by the caller with `element.scrollTo` — never
 * `scrollIntoView`, which would also scroll every ancestor and can drag the
 * whole app shell sideways.
 */

export interface TurnIndexProps {
  turns: TurnSummary[];
  currentTurnId: string;
  onSelect(id: string): void;
  onJumpLatest(): void;
  /** Below 1280px the labels go and the numbers stay. */
  collapsed?: boolean;
}

const STATUS_GLYPH: Record<TurnStatus, { icon: string; color: string; spin?: boolean; word: string }> = {
  done: { icon: 'check', color: 'var(--success)', word: 'done' },
  failed: { icon: 'circle-x', color: 'var(--destructive)', word: 'failed' },
  waiting: { icon: 'shield', color: 'var(--warning)', word: 'waiting for you' },
  running: { icon: 'loader-circle', color: 'var(--info)', spin: true, word: 'running' },
};

export const TURN_INDEX_WIDTH = 196;
export const TURN_INDEX_COLLAPSED_WIDTH = 44;

export function TurnIndex({
  turns,
  currentTurnId,
  onSelect,
  onJumpLatest,
  collapsed = false,
}: TurnIndexProps): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const move = React.useCallback(
    (delta: number) => {
      if (!turns.length) return;
      const at = turns.findIndex((turn) => turn.id === currentTurnId);
      const next = Math.min(turns.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
      onSelect(turns[next].id);
    },
    [turns, currentTurnId, onSelect],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (turns.length) onSelect(turns[0].id);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (turns.length) onSelect(turns[turns.length - 1].id);
    }
  };

  return (
    <nav
      aria-label="Turns"
      style={{
        flex: '0 0 auto',
        width: collapsed ? TURN_INDEX_COLLAPSED_WIDTH : TURN_INDEX_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          padding: collapsed ? '0 6px' : '0 10px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted-foreground)',
        }}
      >
        {collapsed ? null : (
          <span style={{ letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase' }}>
            turns
          </span>
        )}
        <span style={{ marginLeft: collapsed ? 0 : 'auto' }}>{turns.length}</span>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label="Conversation turns"
        aria-activedescendant={currentTurnId ? rowId(currentTurnId) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {turns.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: '10px',
              fontSize: 'var(--text-xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {collapsed ? '—' : 'No turns yet.'}
          </p>
        ) : null}

        {turns.map((turn) => (
          <TurnRow
            key={turn.id}
            turn={turn}
            active={turn.id === currentTurnId}
            collapsed={collapsed}
            onSelect={() => onSelect(turn.id)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={onJumpLatest}
        aria-label="Jump to the latest turn"
        title="Jump to the latest turn"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 6,
          height: 30,
          padding: collapsed ? 0 : '0 10px',
          background: 'transparent',
          border: 0,
          borderTop: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted-foreground)',
          cursor: 'pointer',
        }}
      >
        <Icon name="arrow-down" size={10} />
        {collapsed ? null : 'jump to latest'}
      </button>
    </nav>
  );
}

function rowId(turnId: string): string {
  return `turn-index-${turnId}`;
}

function TurnRow({
  turn,
  active,
  collapsed,
  onSelect,
}: {
  turn: TurnSummary;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const glyph = STATUS_GLYPH[turn.status] || STATUS_GLYPH.done;
  const number = String(turn.index).padStart(2, '0');

  return (
    <button
      id={rowId(turn.id)}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The number and the outcome are the whole row once it is collapsed, so
      // the title carries what the label would have said.
      title={collapsed ? `Turn ${turn.index} — ${glyph.word}: ${turn.label}` : turn.label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        flex: '0 0 auto',
        padding: collapsed ? '6px 4px' : '6px 10px',
        textAlign: 'left',
        background: active ? 'var(--accent)' : hover ? 'var(--accent)' : 'transparent',
        border: 0,
        // 2px of foreground down the left edge, so the active row is still the
        // active row in a monochrome rendering.
        borderLeft: `2px solid ${active ? 'var(--foreground)' : 'transparent'}`,
        color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        font: 'inherit',
        cursor: 'pointer',
        transition: 'background var(--duration-fast) var(--ease-standard)',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          width: 14,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        {number}
      </span>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          flex: '0 0 auto',
          color: glyph.color,
          animation: glyph.spin ? 'relay-spin 900ms linear infinite' : undefined,
        }}
      >
        <Icon name={glyph.icon} size={10} />
      </span>
      {collapsed ? null : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--text-xs)',
            fontWeight: active ? 'var(--font-medium)' : 'var(--font-normal)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {turn.label}
        </span>
      )}
      {/* The word behind the glyph, for anything that cannot see a glyph. */}
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
      >
        {glyph.word}
      </span>
    </button>
  );
}
