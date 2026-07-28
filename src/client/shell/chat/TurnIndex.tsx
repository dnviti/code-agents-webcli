import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { STATUS_GLYPH, formatTurnCost, type TurnIndexRow } from '../../chat/turns.js';
import { TabContextMenu } from '../TabContextMenu.js';

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
  /**
   * False when the recorded index does not reach the conversation's first turn.
   *
   * Past the retention cap the server drops the head of the log, and what is
   * left is a list of the turns that survived it. Saying so is not a detail:
   * without it the list presents itself as the whole conversation, and the
   * reader's own memory of a turn that is not on it becomes a bug report.
   */
  complete?: boolean;
  /**
   * The row whose turn is being fetched right now, if any.
   *
   * Selecting an entry from before the loaded window pages back to it, and on a
   * long conversation that is several round trips. Nothing said so, so the row
   * highlighted and the transcript sat still (#86).
   */
  seekingId?: string | null;
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
  complete = true,
  seekingId = null,
}: TurnIndexProps): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const isPhone = usePhone();
  // Where the icon rail's menu was opened from, or null. Viewport coordinates,
  // because that is what the menu positions itself in.
  const [menuAt, setMenuAt] = React.useState<{ x: number; y: number } | null>(null);
  const folds = foldItems(onExpandAll, onCollapseAll);

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
          // The rail is 44px wide and the count and the menu button do not fit
          // beside each other in it, so collapsed they stack instead. The row
          // is the layout the labelled index wants; it is not a layout this
          // width has.
          flexDirection: collapsed ? 'column' : 'row',
          alignItems: 'center',
          gap: collapsed ? 2 : isPhone ? TOUCH_GAP : 8,
          height: isPhone || collapsed ? undefined : 28,
          minHeight: isPhone ? TOUCH_TARGET + 8 : collapsed ? 28 : undefined,
          padding: collapsed ? '4px 6px' : isPhone ? '4px 12px' : '0 10px',
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
        {/* A count of what is listed, and it only speaks for the conversation
            when the list does. Past a trim it reads "48+", because forty-eight
            is what is left rather than what was asked. */}
        <span
          style={{ marginLeft: collapsed ? 0 : 'auto' }}
          title={
            complete
              ? undefined
              : `${turns.length} turns listed — earlier ones are no longer on the log`
          }
        >
          {complete ? turns.length : `${turns.length}+`}
        </span>
        {/* Two buttons of their own, where there is width for two buttons. */}
        {!collapsed && folds.length ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: isPhone ? TOUCH_GAP : 2 }}>
            {folds.map((fold) => (
              <FoldAllButton
                key={fold.label}
                label={fold.label}
                icon={fold.icon}
                onClick={fold.onSelect}
              />
            ))}
          </span>
        ) : null}
        {/* And where there is not, a menu — rather than nothing at all, which
            is what the 44px rail offered between 1024 and 1280px: every
            maximised 1366×768 laptop and every half-screen on a 2560px
            monitor, with no keyboard way in either (#34). */}
        {collapsed && folds.length ? (
          <FoldAllButton
            label="Turn index actions"
            icon="ellipsis"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenuAt({ x: box.left, y: box.bottom });
            }}
          />
        ) : null}
      </div>

      {menuAt ? (
        <TabContextMenu
          x={menuAt.x}
          y={menuAt.y}
          label="Turn index actions"
          items={folds.map((fold) => ({
            label: fold.label,
            icon: fold.icon,
            onSelect: fold.onSelect,
          }))}
          onClose={() => setMenuAt(null)}
        />
      ) : null}

      <div
        ref={listRef}
        role="listbox"
        // The trim is in the list's own name as well as in a row at the end of
        // it: a note among the options is a thing you have to scroll to, and
        // some readers will not announce it there at all.
        aria-label={
          complete
            ? 'Conversation turns'
            : 'Conversation turns — earlier turns were trimmed from the log'
        }
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
            seeking={turn.id === seekingId}
            onSelect={() => onSelect(turn.id)}
          />
        ))}

      </div>

      {/* Directly under the list, not inside it: the list is a listbox and a
          listbox may hold nothing but its options, so a note among them is at
          best ignored and at worst breaks the set the keyboard walks. The
          trim is announced through the list's own name instead; this is the
          same fact where a reader's eye lands, at the oldest end. */}
      {complete ? null : (
        <p
          role="note"
          title="This conversation is longer than its log keeps. The turns above are the ones still recorded; the older ones were trimmed and cannot be shown."
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 6,
            margin: 0,
            padding: collapsed ? '8px 4px' : '8px 10px',
            borderTop: '1px dashed var(--border)',
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          <Icon name="scissors" size={isPhone ? 14 : 10} />
          {collapsed ? null : 'earlier turns trimmed'}
        </p>
      )}

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

interface FoldItem {
  label: string;
  icon: string;
  onSelect: () => void;
}

/**
 * The fold-all pair, as data.
 *
 * One list, read by the labelled header and by the icon rail's menu, so the two
 * cannot end up offering different things — the rail offering *nothing* is what
 * #34 was. The chord is written into the label because a control that has moved
 * into a menu is a control somebody is looking for, and the keyboard is the only
 * way to reach these when the index itself is closed.
 */
function foldItems(onExpandAll?: () => void, onCollapseAll?: () => void): FoldItem[] {
  const mod = modifierLabel();
  const items: FoldItem[] = [];
  if (onExpandAll) {
    items.push({ label: `Expand every turn — ${mod}E`, icon: 'maximize-2', onSelect: onExpandAll });
  }
  if (onCollapseAll) {
    items.push({
      label: `Collapse every turn — ${mod}${mod === '⌘' ? '⇧' : 'Shift+'}E`,
      icon: 'fold-vertical',
      onSelect: onCollapseAll,
    });
  }
  return items;
}

/**
 * How this platform writes the app's modifier — the same split `keymap.ts`
 * makes when it decides whether a chord belongs to the app or to the field.
 */
function modifierLabel(): string {
  const platform =
    typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl+';
}

function FoldAllButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
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
  seeking,
  onSelect,
}: {
  turn: TurnIndexRow;
  active: boolean;
  collapsed: boolean;
  seeking: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  // While the turn is being paged in, the glyph says what is happening to the
  // row rather than how the turn ended. A row that highlights and then sits
  // there is indistinguishable from a click that did nothing, which is exactly
  // what a jump past the loaded window used to look like (#86).
  const glyph = seeking
    ? STATUS_GLYPH.running
    : STATUS_GLYPH[turn.status] || STATUS_GLYPH.done;
  const number = String(turn.index).padStart(2, '0');

  return (
    <button
      id={rowId(turn.id)}
      type="button"
      role="option"
      aria-selected={active}
      aria-busy={seeking || undefined}
      tabIndex={-1}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // The number and the outcome are the whole row once it is collapsed, so
      // the title carries what the label would have said.
      title={
        seeking
          ? `Turn ${turn.index} — fetching it from the recorded history…`
          : collapsed
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
        // Nothing paints outside the rail: a long number in a 44px column is
        // otherwise drawn over the transcript beside it.
        overflow: 'hidden',
        transition: 'background var(--duration-fast) var(--ease-standard)',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          // A fixed column keeps the glyphs in a line down the labelled index.
          // On the 44px rail there is no line to keep — the number is the row —
          // and a four-figure one painted straight out of a 14px box.
          width: collapsed ? undefined : isPhone ? 20 : 14,
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.meta : 10,
          color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        {number}
      </span>
      {/* And on the rail a four-figure number and a glyph do not both fit. The
          number is what the row is scanned for, so it is the glyph that goes —
          the outcome is still in the title and in the word below, which is what
          a monochrome or spoken rendering reads anyway. While the turn is being
          fetched the glyph stays: it is the only thing on screen saying the
          click is being acted on, and it is over in a few seconds. */}
      {collapsed && number.length > 3 && !seeking ? null : (
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
      )}
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
      {/* The word behind the glyph, for anything that cannot see a glyph. Not
          `glyph.word` while the turn is being fetched: the spinner is borrowed
          from a running turn and this one is not running, it is arriving. */}
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
      >
        {seeking ? 'fetching' : glyph.word}
      </span>
    </button>
  );
}
