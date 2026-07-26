import * as React from 'react';

import { Icon } from '../ui/relay/Icon';
import { PHONE_TEXT, TOUCH_TARGET } from '../ui/touch';

/**
 * The phone's bottom bar: where you are in the app, and how to be somewhere
 * else.
 *
 * Destinations, not commands. The bar this replaced held whatever five things
 * seemed useful — Sessions, New, Panel, Image, More — which mixed a place to
 * go, a thing to make, a panel to toggle, a file to attach and a sheet of
 * everything left over. Five slots of the most valuable chrome in the app,
 * spent on a list with no idea in it.
 *
 * What the app actually does is run agent sessions, and inside one there are
 * four places worth being: the conversation, what the agent did about it, the
 * files it did that to, and a shell in the same directory. Plus the other
 * sessions. Those are the destinations, and the bar is where you switch
 * between them — so it paints which one you are on, the way a bar that says
 * "you are here" is supposed to.
 *
 * Everything that is a *verb* — search, new session, rename, reconnect, the
 * display settings — is on the floating button instead. A control that changes
 * where you are and a control that does something to where you are do not
 * belong in the same row.
 *
 * Height is published as `--mobile-bar-height` so the toast stack and the
 * terminal padding can both clear it without either duplicating the number.
 */

export interface BottomNavDestination {
  id: string;
  label: string;
  icon: string;
  /** You are here. Exactly one of these should be true. */
  current?: boolean;
  onGo(): void;
  /** Draws attention without a count, e.g. output arrived somewhere else. */
  badge?: boolean;
  disabled?: boolean;
}

export interface BottomNavProps {
  destinations: BottomNavDestination[];
  /**
   * Hidden while the on-screen keyboard is up.
   *
   * The keyboard takes half the screen, and the half it leaves is the half you
   * are typing into — which is the one moment nobody is navigating. The bar
   * comes straight back when the field is done with.
   */
  hidden?: boolean;
}

export function BottomNav({ destinations, hidden = false }: BottomNavProps): React.JSX.Element | null {
  if (hidden || destinations.length === 0) return null;

  return (
    <nav
      aria-label="Go to"
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
      {destinations.map((destination) => (
        <button
          key={destination.id}
          type="button"
          onClick={destination.onGo}
          disabled={destination.disabled}
          // The bar is a set of places and this is the one you are at, which is
          // exactly what `aria-current="page"` means. Not `aria-pressed`: none
          // of these is a switch, and not `aria-expanded`: none opens a panel
          // over what you were looking at, they replace it.
          aria-current={destination.current ? 'page' : undefined}
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            minHeight: TOUCH_TARGET,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            border: 'none',
            background: 'transparent',
            color: destination.current ? 'var(--foreground)' : 'var(--muted-foreground)',
            opacity: destination.disabled ? 0.4 : 1,
            fontFamily: 'var(--font-sans)',
            fontSize: PHONE_TEXT.meta,
            fontWeight: destination.current
              ? ('var(--font-medium)' as React.CSSProperties['fontWeight'])
              : undefined,
            cursor: destination.disabled ? 'not-allowed' : 'pointer',
            // A tap that paints a lingering highlight reads as a stuck button.
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          {/* The rule above the current item, so "you are here" survives being
              read in monochrome — colour alone is not the carrier anywhere
              else in this app either. */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              left: '22%',
              right: '22%',
              height: 2,
              background: destination.current ? 'var(--foreground)' : 'transparent',
            }}
          />
          <span style={{ display: 'inline-flex', position: 'relative' }}>
            <Icon name={destination.icon} size={20} />
            {destination.badge ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute', top: -1, right: -3, width: 7, height: 7,
                  borderRadius: 'var(--radius-full)', background: 'var(--primary)',
                }}
              />
            ) : null}
          </span>
          <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {destination.label}
          </span>
        </button>
      ))}
    </nav>
  );
}
