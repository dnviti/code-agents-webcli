import * as React from 'react';

import { Icon } from '../ui/relay/Icon';

export interface MobileBarAction {
  id: string;
  label: string;
  icon: string;
  onPress(): void;
  /** Paints the item as current, the way a native tab bar marks its section. */
  active?: boolean;
  /**
   * Set when the item opens a panel rather than navigating. `active` alone
   * announced "current item in a set", which is not what a button that opens a
   * sheet does.
   */
  expands?: boolean;
  /**
   * Set when the item toggles something visible rather than opening a panel
   * (e.g. the key strip). It is announced as pressed/not-pressed — neither a
   * dialog disclosure nor a current section.
   */
  toggle?: boolean;
  /** Draws attention without a count, e.g. background output arrived. */
  badge?: boolean;
  disabled?: boolean;
}

export interface MobileBarProps {
  actions: MobileBarAction[];
}

/**
 * The mobile bottom bar.
 *
 * Fixed to the bottom edge with a safe-area inset, five items wide, icon over
 * label — the shape a phone user already knows. It replaces the hamburger
 * drawer and the two floating buttons that used to sit over the terminal: on a
 * phone the agent's own output is the thing you are reading, and controls
 * floating on top of it hid the last lines exactly when they mattered.
 *
 * Height is published as `--mobile-bar-height` so the toast stack and the
 * terminal padding can both clear it without either duplicating the number.
 */
export function MobileBar({ actions }: MobileBarProps): React.JSX.Element {
  return (
    <nav
      aria-label="Session controls"
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'stretch',
        height: 'var(--mobile-bar-height)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        boxSizing: 'content-box',
        borderTop: '1px solid var(--border)',
        background: 'var(--card)',
      }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={action.onPress}
          disabled={action.disabled}
          aria-haspopup={action.expands ? 'dialog' : undefined}
          aria-expanded={action.expands ? Boolean(action.active) : undefined}
          aria-pressed={action.toggle ? Boolean(action.active) : undefined}
          aria-current={!action.expands && !action.toggle && action.active ? 'true' : undefined}
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            border: 'none',
            background: 'transparent',
            color: action.active ? 'var(--foreground)' : 'var(--muted-foreground)',
            opacity: action.disabled ? 0.4 : 1,
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-2xs)',
            letterSpacing: 'var(--tracking-wide)',
            cursor: action.disabled ? 'not-allowed' : 'pointer',
            // A tap that paints a lingering highlight reads as a stuck button.
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <span style={{ display: 'inline-flex', position: 'relative' }}>
            <Icon name={action.icon} size={20} />
            {action.badge ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute', top: -1, right: -3, width: 6, height: 6,
                  borderRadius: 'var(--radius-full)', background: 'var(--primary)',
                }}
              />
            ) : null}
          </span>
          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {action.label}
          </span>
        </button>
      ))}
    </nav>
  );
}
