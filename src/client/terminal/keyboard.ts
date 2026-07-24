// The on-screen keyboard, owned rather than incidental (issue #21 follow-up).
//
// Two problems are solved here:
//
// 1. xterm focuses its hidden helper textarea on every tap, and focusing a
//    textarea summons the mobile keyboard — so every interaction with the
//    screen popped the OSK over half the terminal. Setting
//    `inputMode = 'none'` keeps the focus (hardware keys and the Ctrl latch
//    keep working) while telling the browser there is nothing to type with.
//    The keyboard then appears only when the user asks for it, via the key
//    strip's keyboard button (`summonKeyboard`).
//
// 2. When the keyboard does appear, it must not cover the terminal: the app
//    shrinks and shifts by exactly the keyboard's size. Android Chrome is
//    handled declaratively (`interactive-widget=resizes-content` in the
//    viewport meta); iOS Safari, which overlays the keyboard without resizing
//    anything, is handled here off visualViewport.

/** The helper textarea the user last typed into (main terminal or a split). */
let activeTextarea: HTMLTextAreaElement | null = null;

/**
 * Keep taps on the terminal from summoning the on-screen keyboard.
 *
 * Called for every terminal that opens, main and split alike. The blur
 * listener is what makes the arrangement one-shot: when a summoned keyboard
 * is dismissed (Back on Android, Done on iOS, or a tap elsewhere), the
 * textarea goes back to `none` and the next tap is silent again.
 */
export function suppressAutoKeyboard(container: HTMLElement): void {
  const textarea = container.querySelector('.xterm-helper-textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  textarea.inputMode = 'none';
  textarea.addEventListener('focus', () => {
    activeTextarea = textarea;
  });
  textarea.addEventListener('blur', () => {
    textarea.inputMode = 'none';
  });
}

/**
 * Show the on-screen keyboard on purpose.
 *
 * Must run inside a user gesture or iOS ignores the focus. If the textarea is
 * already focused (a tap landed first, silently), it has to be refocused:
 * changing inputMode on a focused element does not summon the keyboard. The
 * blur listener fires synchronously and resets inputMode, so it is set again
 * after the blur.
 */
export function summonKeyboard(): void {
  const textarea =
    activeTextarea ?? document.querySelector('#terminal .xterm-helper-textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  textarea.inputMode = 'text';
  if (document.activeElement === textarea) {
    textarea.blur();
    textarea.inputMode = 'text';
  }
  textarea.focus();
}

/** Below this many pixels of inset it is a URL bar, not a keyboard. */
const KEYBOARD_MIN_INSET_PX = 120;

/**
 * Move the app up by the on-screen keyboard's size.
 *
 * `window.innerHeight - visualViewport.height` is the keyboard's height on
 * iOS (innerHeight does not move there) and ~0 wherever the browser already
 * resizes the layout viewport for the keyboard (Android Chrome with
 * `interactive-widget=resizes-content`), so the two mechanisms never
 * double-count. `offsetTop` covers Safari scrolling the visual viewport to
 * reveal the caret: the app is translated back over the visible area.
 */
export function watchKeyboardInset(appEl: HTMLElement, onChange: () => void): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const apply = (): void => {
    // Lift only while the terminal is actually taking keyboard input. The
    // inset alone is not proof of a keyboard: a pinch-zoom shrinks the
    // visual viewport by the same mechanism, and squeezing the app because
    // someone zoomed is the bug this guard exists to prevent.
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLTextAreaElement &&
      focused.classList.contains('xterm-helper-textarea');
    const inset = window.innerHeight - viewport.height;
    if (typing && inset > KEYBOARD_MIN_INSET_PX) {
      appEl.style.height = `${viewport.height}px`;
      appEl.style.transform = `translateY(${viewport.offsetTop}px)`;
    } else {
      appEl.style.height = '';
      appEl.style.transform = '';
    }
    // The terminal's box just changed; xterm only reflows when told.
    onChange();
  };

  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
}
