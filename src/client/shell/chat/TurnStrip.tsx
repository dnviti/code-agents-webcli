import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';
import { formatTurnMeta, turnTime, type TurnSummary } from '../../chat/turns.js';

/**
 * The 28px rule that opens a turn, and everything that turn cost.
 *
 * Sticky for the turn you are in, static for the ones above it — so scrolling
 * back through an hour of conversation always leaves a header on screen saying
 * which turn the text under it belongs to. It has to be *opaque*: a translucent
 * sticky bar with a code block sliding under it is unreadable at exactly the
 * moment it is meant to be helping.
 *
 * The meta group is where a 28px bar gets broken. Counts may ellipsise; the
 * duration and the money may not — they are the two figures someone came here
 * to read, and half of a cost is worse than none.
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
}

export function TurnStrip({
  turn,
  anchorId,
  variant,
  onCopy,
  onBranch,
  copied = false,
}: TurnStripProps): React.JSX.Element {
  const past = variant === 'past';
  const meta = formatTurnMeta(turn);
  const time = turnTime(turn);

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
        gap: 10,
        minWidth: 0,
        height: 28,
        padding: '0 14px',
        // Opaque, deliberately: see the note above.
        background: past ? 'var(--muted)' : 'var(--secondary)',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
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
            fontSize: 10,
            whiteSpace: 'nowrap',
            color: 'var(--muted-foreground)',
          }}
        >
          {time}
        </span>
      ) : null}

      <span
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted-foreground)',
        }}
      >
        {meta.tools ? <Shrinkable>{meta.tools}</Shrinkable> : null}
        {meta.reasoning ? <Shrinkable>{meta.reasoning}</Shrinkable> : null}
        {meta.duration ? <span style={{ flex: '0 0 auto' }}>{meta.duration}</span> : null}
        {meta.cost ? (
          <span style={{ flex: '0 0 auto', color: past ? 'var(--muted-foreground)' : 'var(--foreground)' }}>
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

/** A meta item that gives up its own width before the row wraps. */
function Shrinkable({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        flex: '0 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </span>
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
        width: 20,
        height: 20,
        padding: 0,
        background: hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: tone || (hover ? 'var(--foreground)' : 'var(--muted-foreground)'),
        cursor: 'pointer',
        transition: 'background var(--duration-fast), color var(--duration-fast)',
      }}
    >
      <Icon name={icon} size={12} />
    </button>
  );
}
