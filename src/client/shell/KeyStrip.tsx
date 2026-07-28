import * as React from 'react';

import { Icon } from '../ui/relay/Icon';
import type { MobileKey } from '../ui/mobile';

/**
 * Published for the toast stack, which has to clear the strip when it shows.
 *
 * Tall enough that a key is a full touch target from top to bottom. Nine keys
 * cannot also be 44px *wide* on a 390px screen — that is 460px of keys before
 * any gaps — and the platforms' own on-screen keyboards do not try: this is a
 * keyboard row, and the aim a thumb needs from it is vertical. Width is
 * whatever nine equal shares of the screen come to, which is where the phone
 * checks exempt it by name.
 */
export const KEY_STRIP_HEIGHT = 54;

export interface KeyStripProps {
  /** Paints Ctrl as engaged; the next input goes out as a control code. */
  ctrlLatched: boolean;
  onKey(key: MobileKey): void;
  onToggleCtrl(): void;
  /** Summons the on-screen keyboard; taps on the terminal no longer do. */
  onShowKeyboard(): void;
}

interface StripButton {
  id: string;
  /** Text for word keys, icon name for arrows. */
  label?: string;
  icon?: string;
  ariaLabel: string;
  /** Arrows repeat while held; Esc/Tab/Ctrl fire once per tap. */
  repeat?: boolean;
  onPress(): void;
  active?: boolean;
}

/** How long a held arrow waits before repeating, and how fast it then fires. */
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 65;

/**
 * The on-screen terminal keys (issue #21).
 *
 * A phone keyboard has no Escape, arrows, Ctrl or Tab — the keys an agent
 * actually asks for (interactive prompts, history recall with ↑, interrupt
 * with Ctrl+C). This strip puts them one thumb-tap away, above the bottom
 * bar, and sends them straight to the session socket: no xterm key handling,
 * and the on-screen keyboard never pops up for a key the terminal needed
 * anyway.
 *
 * Ctrl is a one-shot latch, not a chord: tap Ctrl (it stays lit), then type
 * the letter on the ordinary keyboard. Chording two fingers on glass is the
 * interaction phones are worst at; latching is what Termux converged on too.
 */
export function KeyStrip({ ctrlLatched, onKey, onToggleCtrl, onShowKeyboard }: KeyStripProps): React.JSX.Element {
  const buttons: StripButton[] = [
    { id: 'ctrl', label: 'Ctrl', ariaLabel: 'Latch Ctrl for the next key', active: ctrlLatched, onPress: onToggleCtrl },
    // Escape is the single most-used agent key and the one iOS keyboards
    // lack entirely, so it sits at the thumb's leading edge, always visible.
    { id: 'esc', label: 'Esc', ariaLabel: 'Send Escape', onPress: () => onKey('esc') },
    { id: 'tab', label: 'Tab', ariaLabel: 'Send Tab', onPress: () => onKey('tab') },
    { id: 'enter', icon: 'corner-down-left', ariaLabel: 'Send Enter', onPress: () => onKey('enter') },
    { id: 'left', icon: 'arrow-left', ariaLabel: 'Send Left arrow', repeat: true, onPress: () => onKey('left') },
    { id: 'down', icon: 'arrow-down', ariaLabel: 'Send Down arrow', repeat: true, onPress: () => onKey('down') },
    { id: 'up', icon: 'arrow-up', ariaLabel: 'Send Up arrow', repeat: true, onPress: () => onKey('up') },
    { id: 'right', icon: 'arrow-right', ariaLabel: 'Send Right arrow', repeat: true, onPress: () => onKey('right') },
    // The keyboard no longer appears by itself — every tap focused xterm's
    // hidden textarea and popped it — so summoning it is an explicit act.
    { id: 'keyboard', icon: 'keyboard', ariaLabel: 'Show on-screen keyboard', onPress: onShowKeyboard },
  ];

  return (
    <div
      role="group"
      aria-label="Terminal keys"
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'stretch',
        gap: 6,
        height: KEY_STRIP_HEIGHT,
        padding: '5px 8px',
        // Each key fills the strip's own height, so the target is the band the
        // thumb sees rather than something inset inside it.
        alignContent: 'stretch',
        boxSizing: 'border-box',
        borderTop: '1px solid var(--border)',
        background: 'var(--card)',
      }}
    >
      {buttons.map((button) => (
        <StripKey key={button.id} button={button} />
      ))}
    </div>
  );
}

function StripKey({ button }: { button: StripButton }): React.JSX.Element {
  const delayTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRepeat = React.useCallback((): void => {
    if (delayTimer.current !== null) { clearTimeout(delayTimer.current); delayTimer.current = null; }
    if (repeatTimer.current !== null) { clearInterval(repeatTimer.current); repeatTimer.current = null; }
  }, []);

  // A timer that outlives the component would fire onKey against a torn-down
  // strip — and holding a key while switching away is exactly how that happens.
  React.useEffect(() => stopRepeat, [stopRepeat]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // Without this the press steals focus from xterm's hidden textarea, and
    // the next real keystroke lands nowhere.
    event.preventDefault();
    button.onPress();
    if (!button.repeat) return;
    stopRepeat();
    delayTimer.current = setTimeout(() => {
      repeatTimer.current = setInterval(button.onPress, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };

  return (
    <button
      type="button"
      aria-label={button.ariaLabel}
      aria-pressed={button.active}
      onPointerDown={onPointerDown}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      // Click is deliberately unused: onPointerDown already fired, and a
      // second fire would double-send the key. The context menu is suppressed
      // too: a long-press on Android would otherwise pop a menu over a key
      // the user is holding for repeat.
      onClick={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid',
        borderColor: button.active ? 'var(--ring)' : 'var(--border)',
        borderRadius: 'var(--radius)',
        background: button.active ? 'var(--accent)' : 'var(--secondary)',
        color: button.active ? 'var(--foreground)' : 'var(--muted-foreground)',
        fontFamily: 'var(--font-sans)',
        // Not the 10px this used to be: the phone layout's own floor is 12,
        // and `Ctrl` on a key you are aiming at in a hurry has to be readable.
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'],
        letterSpacing: 'var(--tracking-wide)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        // The strip must never start a page scroll or a double-tap zoom.
        touchAction: 'manipulation',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {button.icon ? <Icon name={button.icon} size={16} /> : button.label}
    </button>
  );
}
