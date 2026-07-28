import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { STATUS_GLYPH, formatTurnCost, type TurnIndexRow } from '../../chat/turns.js';

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
  /** Every turn of the conversation, loaded or not — see `turnIndexRows`. */
  turns: TurnIndexRow[];
  currentTurnId: string;
  onSelect(id: string): void;
  onJumpLatest(): void;
  /** Below 1280px the labels go and the numbers stay. */
  collapsed?: boolean;
  /** Open or close every turn's body at once. Omitted, the row shows neither. */
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
}

export const TURN_INDEX_WIDTH = 196;
export const TURN_INDEX_COLLAPSED_WIDTH = 44;

export function TurnIndex({
  turns,
  currentTurnId,
  onSelect,
  onJumpLatest,
  collapsed = false,
  onExpandAll,
  onCollapseAll,
}: TurnIndexProps): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const isPhone = usePhone();

  // Newest first. The list is read from the top, and the turn you are almost
  // always looking for is the one that just happened — in a long conversation
  // the alternative is scrolling to the bottom of the index to reach the thing
  // already on screen. Only the order changes: a turn keeps the number the
  // conversation gave it, so the top of the list is 49 and it counts down.
  const ordered = React.useMemo(() => [...turns].reverse(), [turns]);

  // Arrow keys, Home and End follow what is drawn rather than the clock, so
  // "down" is down the list. That makes them older, which is the direction the
  // list now runs in.
  const move = React.useCallback(
    (delta: number) => {
      if (!ordered.length) return;
      const at = ordered.findIndex((turn) => turn.id === currentTurnId);
      const next = Math.min(ordered.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
      onSelect(ordered[next].id);
    },
    [ordered, currentTurnId, onSelect],
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
      if (ordered.length) onSelect(ordered[0].id);
    } else if (event.key === 'End') {
      event.preventDefault();
      if (ordered.length) onSelect(ordered[ordered.length - 1].id);
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
          gap: isPhone ? TOUCH_GAP : 8,
          height: isPhone ? undefined : 28,
          minHeight: isPhone ? TOUCH_TARGET + 8 : undefined,
          padding: collapsed ? '0 6px' : isPhone ? '4px 12px' : '0 10px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.meta : 10,
          color: 'var(--muted-foreground)',
        }}
      >
        {collapsed ? null : (
          <span style={{ letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase' }}>
            turns
          </span>
        )}
        <span style={{ marginLeft: collapsed ? 0 : 'auto' }}>{turns.length}</span>
        {/* Icon-rail width has no room for these — the row is already tight
            around the count at 44px. */}
        {!collapsed && (onExpandAll || onCollapseAll) ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: isPhone ? TOUCH_GAP : 2 }}>
            {onExpandAll ? (
              <FoldAllButton label="Expand every turn" icon="maximize-2" onClick={onExpandAll} />
            ) : null}
            {onCollapseAll ? (
              <FoldAllButton label="Collapse every turn" icon="fold-vertical" onClick={onCollapseAll} />
            ) : null}
          </span>
        ) : null}
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

        {ordered.map((turn) => (
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
          height: isPhone ? TOUCH_TARGET : 30,
          padding: collapsed ? 0 : isPhone ? '0 12px' : '0 10px',
          background: 'transparent',
          border: 0,
          borderTop: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.body : 10,
          color: 'var(--muted-foreground)',
          cursor: 'pointer',
        }}
      >
        <Icon name="arrow-down" size={isPhone ? 16 : 10} />
        {collapsed ? null : 'jump to latest'}
      </button>
    </nav>
  );
}

function rowId(turnId: string): string {
  return `turn-index-${turnId}`;
}

function FoldAllButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: isPhone ? TOUCH_TARGET : 18,
        height: isPhone ? TOUCH_TARGET : 18,
        padding: 0,
        background: hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: hover ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={isPhone ? 18 : 11} />
    </button>
  );
}

function TurnRow({
  turn,
  active,
  collapsed,
  onSelect,
}: {
  turn: TurnIndexRow;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
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
      title={
        collapsed
          ? `Turn ${turn.index} — ${glyph.word}: ${turn.label}`
          : turn.loaded
            ? turn.label
            : `${turn.label} — not loaded yet; selecting it fetches it`
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        flex: '0 0 auto',
        minHeight: isPhone ? TOUCH_TARGET : undefined,
        padding: collapsed ? '6px 4px' : isPhone ? '8px 12px' : '6px 10px',
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
          width: isPhone ? 20 : 14,
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.meta : 10,
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
        <Icon name={glyph.icon} size={isPhone ? 14 : 10} />
      </span>
      {collapsed ? null : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
            fontWeight: active ? 'var(--font-medium)' : 'var(--font-normal)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {turn.label}
        </span>
      )}
      {/* What this one turn cost. Only where it was actually recorded: a turn
          still running has no figure yet and a runtime that reports no money
          never will, and "$0.00" for either of those is a number nobody
          measured. Right of the label, in the same monospace as every other
          figure on this screen, so a column of them reads down the list. */}
      {collapsed || turn.costUsd === undefined ? null : (
        <span
          title={`this turn cost $${turn.costUsd.toFixed(4)}`}
          style={{
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 10,
            color: 'var(--muted-foreground)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTurnCost(turn.costUsd)}
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
