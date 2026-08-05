import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { formatTurnMeta, turnTime, STATUS_GLYPH, type TurnSummary } from '../../chat/turns.js';

/**
 * The 28px rule that opens a turn, and everything that turn cost.
 *
 * Sticky for the turn you are in, static for the ones above it — so scrolling
 * back through an hour of conversation always leaves a header on screen saying
 * which turn the text under it belongs to. It has to be *opaque*: a translucent
 * sticky bar with a code block sliding under it is unreadable at exactly the
 * moment it is meant to be helping.
 *
 * The meta group is where a 28px bar gets broken, and nothing in it is allowed
 * to break: every figure there is a measurement, and half of one is worse than
 * none. The label is what gives the room up — cut to whatever is left, with the
 * whole prompt on hover — because a label cut short is still a label.
 */

export interface TurnStripProps {
  turn: TurnSummary;
  /** Marks the scroll target for "jump to turn N". */
  anchorId?: string;
  variant: 'current' | 'past';
  onCopy(): void;
  onBranch?: () => void;
  /** Set while the copy has just landed, so the glyph can acknowledge it. */
  copied?: boolean;
  /** Whether the turn's body is shown below this strip. */
  open: boolean;
  onToggleOpen(): void;
  /** Id of the element this strip discloses, for `aria-controls`. */
  bodyId?: string;
}

export function TurnStrip({
  turn,
  anchorId,
  variant,
  onCopy,
  onBranch,
  copied = false,
  open,
  onToggleOpen,
  bodyId,
}: TurnStripProps): React.JSX.Element {
  const past = variant === 'past';
  const isPhone = usePhone();
  const meta = formatTurnMeta(turn);
  const time = turnTime(turn);
  const glyph = STATUS_GLYPH[turn.status] || STATUS_GLYPH.done;

  return (
    <div
      // A heading rather than a div: this is what a screen-reader user navigates
      // a long conversation by, the same way a sighted one uses the sticky bar.
      role="heading"
      aria-level={3}
      // The anchor lives on this element and not on a wrapper around it. A
      // sticky box travels only inside its own containing block, so a wrapper
      // that is exactly the strip's height pins it to a 28px window — which is
      // to say it never sticks at all. As a direct child of the scroller's
      // content column it can travel the whole turn, and the next turn's strip
      // pushes it out the way a sticky header should.
      data-turn-id={anchorId}
      style={{
        flex: '0 0 auto',
        position: past ? 'static' : 'sticky',
        top: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        // On a phone the bar wraps and grows instead of holding 28px: it
        // carries a turn number, a time, a duration and a cost, and the only
        // way all four fit on one 390px line is at a size none of them can be
        // read at. The desktop bar is still a fixed rule that never wraps.
        flexWrap: isPhone ? 'wrap' : 'nowrap',
        gap: isPhone ? TOUCH_GAP : 10,
        minWidth: 0,
        height: isPhone ? undefined : 28,
        minHeight: isPhone ? TOUCH_TARGET : undefined,
        padding: isPhone ? '4px 12px' : '0 14px',
        // Opaque, deliberately: see the note above.
        background: past ? 'var(--muted)' : 'var(--secondary)',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${open ? 'Collapse' : 'Expand'} turn ${turn.index}`}
        title={open ? 'Collapse this turn' : 'Expand this turn'}
        onClick={onToggleOpen}
        style={{
          flex: '0 0 auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: isPhone ? TOUCH_TARGET : 16,
          height: isPhone ? TOUCH_TARGET : 16,
          padding: 0,
          margin: isPhone ? '0 0 0 -12px' : '0 -2px 0 -4px',
          background: 'transparent',
          border: 0,
          color: 'var(--muted-foreground)',
          cursor: 'pointer',
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={isPhone ? 18 : 12} />
      </button>

      <span
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.detail : 10,
          // Capitals and wide tracking read as louder than their size, which is
          // most of why this row competed with the message it sits above. On a
          // phone it says what it says and stops shouting it (#92); the mono
          // face stays, because the figures beside it want to line up.
          letterSpacing: isPhone ? 'normal' : '0.06em',
          textTransform: isPhone ? 'none' : 'uppercase',
          whiteSpace: 'nowrap',
          color: past ? 'var(--muted-foreground)' : 'var(--foreground)',
        }}
      >
        turn {turn.index}
      </span>

      {time ? (
        <span
          style={{
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.detail : 10,
            whiteSpace: 'nowrap',
            color: 'var(--muted-foreground)',
          }}
        >
          {time}
        </span>
      ) : null}

      {/* Only shown while the body it names is hidden — this is the entire
          reason a collapsed strip is still worth reading rather than just a
          number. */}
      {!open ? (
        <>
          <span
            aria-hidden="true"
            style={{
              flex: '0 0 auto',
              display: 'inline-flex',
              color: glyph.color,
              animation: glyph.spin ? 'relay-spin 900ms linear infinite' : undefined,
            }}
          >
            <Icon name={glyph.icon} size={isPhone ? 14 : 11} />
          </span>
          <span
            // The whole prompt on hover. What is on the bar is a first line cut
            // to whatever room is left, and the rest of it is a keystroke away
            // rather than gone.
            title={turn.label}
            style={{
              // Takes the room that is left and gives it all back before
              // anything else in the bar gives up any: the figures beside it are
              // why the bar exists, and a long first line used to push them into
              // ellipsis — "16 too…", "9 rea…" — which is a measurement nobody
              // can read. A label cut short is still a label; half a tool count
              // is nothing at all.
              flex: '1 1 0',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // Left at `body`, deliberately. This is the only line a folded
              // turn shows and it stands in for the message inside it, so it
              // sits above the detail — and still below the prose (#92).
              fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
            }}
          >
            {turn.label}
          </span>
        </>
      ) : null}

      <span
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          // Fixed, and every figure in it fixed too. These are measurements —
          // a truncated one is worse than none, and there is always something
          // beside them that can give the room up instead: the label.
          flex: '0 0 auto',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          // Per-turn accounting, not the session's: "83 tools 31 reasoning" is
          // about this turn, and reading it at the size of the live figures in
          // the header put it above the message it describes (#92).
          fontSize: isPhone ? PHONE_TEXT.detail : 10,
          color: 'var(--muted-foreground)',
        }}
      >
        {meta.tools ? <span style={{ flex: '0 0 auto' }}>{meta.tools}</span> : null}
        {meta.reasoning ? <span style={{ flex: '0 0 auto' }}>{meta.reasoning}</span> : null}
        {meta.duration ? <span style={{ flex: '0 0 auto' }}>{meta.duration}</span> : null}
        {meta.cost ? (
          <span
            title={meta.costTitle}
            style={{ flex: '0 0 auto', color: past ? 'var(--muted-foreground)' : 'var(--foreground)' }}
          >
            {meta.cost}
          </span>
        ) : null}
      </span>

      <StripButton
        label={copied ? 'Turn copied' : 'Copy this turn as Markdown'}
        icon={copied ? 'check' : 'copy'}
        tone={copied ? 'var(--success)' : undefined}
        onClick={onCopy}
      />
      {onBranch ? (
        <StripButton label="Branch a new session from this turn" icon="git-branch" onClick={onBranch} />
      ) : null}
    </div>
  );
}

function StripButton({
  label,
  icon,
  onClick,
  tone,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  tone?: string;
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
        width: isPhone ? TOUCH_TARGET : 20,
        height: isPhone ? TOUCH_TARGET : 20,
        padding: 0,
        background: hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: tone || (hover ? 'var(--foreground)' : 'var(--muted-foreground)'),
        cursor: 'pointer',
        transition: 'background var(--duration-fast), color var(--duration-fast)',
      }}
    >
      <Icon name={icon} size={isPhone ? 18 : 12} />
    </button>
  );
}
