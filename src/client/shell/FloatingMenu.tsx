import * as React from 'react';

import { Icon } from '../ui/relay/Icon';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET } from '../ui/touch';

/**
 * The phone's one piece of permanent chrome: a square button in the bottom
 * right, and everything else behind it.
 *
 * It replaced the bottom bar. A five-slot bar is 56px plus the safe-area inset
 * of screen that the conversation never gets back, on a surface whose whole
 * purpose is the conversation — and it could only ever show five things, so
 * every other control had to live in a sheet reached *through* it anyway. A
 * button that is 56px square and floats over the transcript costs the corner it
 * covers and nothing else.
 *
 * Open, it is a column of labelled rows rising from the button. Rows rather
 * than a grid because the labels are what make the icons legible, and a phone
 * has height to give a list and no width to give a grid.
 */

export interface FloatingMenuAction {
  id: string;
  label: string;
  icon: string;
  onPress(): void;
  /** Paints the row as the current state of something, e.g. an open panel. */
  active?: boolean;
  /** Opens a panel or sheet rather than navigating. */
  expands?: boolean;
  /** Toggles something visible. Announced as pressed/not-pressed. */
  toggle?: boolean;
  /** Draws attention without a count, e.g. background output arrived. */
  badge?: boolean;
  disabled?: boolean;
  /** Rows are drawn grouped by this, newest group nearest the button. */
  group?: string;
}

export interface FloatingMenuProps {
  actions: FloatingMenuAction[];
  /** Sits above whatever owns the bottom edge, e.g. the on-screen key strip. */
  bottomOffset?: number;
}

const SIDE = 56;

export function FloatingMenu({ actions, bottomOffset = 0 }: FloatingMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const alerting = actions.some((action) => action.badge);

  // Escape closes it, and so does the surface underneath being replaced: a menu
  // still standing over a conversation that has been switched away from is a
  // list of controls for something that is no longer on screen.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const groups: Array<[string, FloatingMenuAction[]]> = [];
  for (const action of actions) {
    const key = action.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last[0] === key) last[1].push(action);
    else groups.push([key, [action]]);
  }

  return (
    <>
      {/* Tapping anywhere else closes it. Not a `Dialog`: this must not take
          focus away from the composer, because the commonest reason to open it
          is to reach for something mid-sentence. */}
      {open ? (
        <button
          type="button"
          aria-label="Close the menu"
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 'var(--z-overlay)' as unknown as number,
            background: 'color-mix(in oklab, var(--background) 55%, transparent)',
            border: 0,
            cursor: 'default',
            animation: 'relay-fade-in var(--duration-fast) var(--ease-standard)',
          }}
        />
      ) : null}

      <div
        style={{
          position: 'absolute',
          right: 12,
          bottom: 12 + bottomOffset,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          // Above the scrim, said outright. Both were at `--z-overlay` and the
          // order came down to which appeared later in the DOM — which is a
          // fact about this file, not about what has to be on top, and it put
          // the dimming layer over the button that dismisses it.
          zIndex: 'var(--z-modal)' as unknown as number,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: TOUCH_GAP,
          // The column above the button must not swallow taps meant for the
          // conversation behind it when the menu is shut.
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {open ? (
          <div
            role="menu"
            aria-label="Session menu"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 2,
              // Capped and scrollable: the list grows with the number of open
              // sessions, and a menu taller than the screen is a menu with
              // items nobody can reach.
              maxHeight: '60vh',
              overflowY: 'auto',
              minWidth: 200,
              maxWidth: 'calc(100vw - 24px)',
              padding: 'var(--space-1)',
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-popover)',
              animation: 'relay-rise var(--duration-base) var(--ease-out)',
            }}
          >
            {groups.map(([key, rows], index) => (
              <React.Fragment key={key || index}>
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    style={{ height: 1, margin: '4px 0', background: 'var(--border)' }}
                  />
                ) : null}
                {rows.map((action) => (
                  <MenuRow
                    key={action.id}
                    action={action}
                    onDone={() => setOpen(false)}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={open ? 'Close the menu' : 'Open the menu'}
          onClick={() => setOpen((value) => !value)}
          style={{
            position: 'relative',
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: SIDE,
            height: SIDE,
            flex: '0 0 auto',
            background: open ? 'var(--foreground)' : 'var(--card)',
            color: open ? 'var(--background)' : 'var(--foreground)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-md)',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
            transition: 'background var(--duration-fast) var(--ease-standard)',
          }}
        >
          <Icon name={open ? 'x' : 'menu'} size={24} />
          {/* Something behind the menu wants attention. Carried on the button
              because when it is shut the button is the only thing on screen
              that could say so. */}
          {alerting && !open ? (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 8,
                height: 8,
                borderRadius: 'var(--radius-full)',
                background: 'var(--primary)',
              }}
            />
          ) : null}
        </button>
      </div>
    </>
  );
}

function MenuRow({
  action,
  onDone,
}: {
  action: FloatingMenuAction;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={action.disabled}
      aria-haspopup={action.expands ? 'dialog' : undefined}
      aria-expanded={action.expands ? Boolean(action.active) : undefined}
      aria-pressed={action.toggle ? Boolean(action.active) : undefined}
      onClick={() => {
        // Closed first: every one of these either opens something over this
        // menu or changes what is behind it, and a menu left standing on top
        // of its own result is in the way of the thing it just did.
        onDone();
        action.onPress();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        minHeight: TOUCH_TARGET,
        padding: '0 12px',
        background: action.active ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: action.disabled ? 'var(--muted-foreground)' : 'var(--foreground)',
        opacity: action.disabled ? 0.5 : 1,
        fontFamily: 'var(--font-sans)',
        fontSize: PHONE_TEXT.body,
        textAlign: 'left',
        cursor: action.disabled ? 'not-allowed' : 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Icon name={action.icon} size={20} />
      <span style={{ flex: 1, minWidth: 0 }}>{action.label}</span>
      {action.badge ? (
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            flex: '0 0 auto',
            borderRadius: 'var(--radius-full)',
            background: 'var(--primary)',
          }}
        />
      ) : null}
      {action.toggle ? (
        <span
          aria-hidden="true"
          style={{ flex: '0 0 auto', color: 'var(--muted-foreground)', fontSize: PHONE_TEXT.meta }}
        >
          {action.active ? 'on' : 'off'}
        </span>
      ) : null}
    </button>
  );
}
