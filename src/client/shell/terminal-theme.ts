import type { ITerminalOptions } from '@xterm/xterm';

/**
 * Build an xterm theme from the Relay design tokens.
 *
 * xterm does not read CSS custom properties: it renders from a JavaScript theme
 * object, to canvas under the WebGL renderer. So toggling the `.light` class
 * restyles every React surface and leaves the terminal exactly as it was — the
 * chrome goes light while the terminal stays dark. This reads the tokens back
 * out of the cascade and hands them over in the shape xterm wants.
 *
 * Relay defines the full 16-colour ANSI ramp for both themes, which is what
 * makes this a lookup rather than a translation.
 */

type XtermTheme = NonNullable<ITerminalOptions['theme']>;

/** Relay token -> xterm theme key. */
const TOKEN_MAP: ReadonlyArray<readonly [keyof XtermTheme, string]> = [
  ['background', '--terminal-bg'],
  ['foreground', '--terminal-fg'],
  ['cursor', '--terminal-cursor'],
  ['cursorAccent', '--terminal-bg'],
  ['selectionBackground', '--terminal-selection'],
  ['black', '--ansi-black'],
  ['red', '--ansi-red'],
  ['green', '--ansi-green'],
  ['yellow', '--ansi-yellow'],
  ['blue', '--ansi-blue'],
  ['magenta', '--ansi-magenta'],
  ['cyan', '--ansi-cyan'],
  ['white', '--ansi-white'],
  ['brightBlack', '--ansi-bright-black'],
  ['brightRed', '--ansi-bright-red'],
  ['brightGreen', '--ansi-bright-green'],
  ['brightYellow', '--ansi-bright-yellow'],
  ['brightBlue', '--ansi-bright-blue'],
  ['brightMagenta', '--ansi-bright-magenta'],
  ['brightCyan', '--ansi-bright-cyan'],
  ['brightWhite', '--ansi-bright-white'],
];

export interface ReadTokenOptions {
  /** Defaults to the document element, which is where the tokens are defined. */
  element?: Element;
}

/**
 * Read the Relay tokens currently in effect.
 *
 * Returns null when the token layer is not present — a stylesheet that failed
 * to load, or a test environment with no cascade. Callers must leave the
 * existing terminal theme alone in that case: a theme built from empty strings
 * renders a black-on-black terminal, which is far worse than the wrong palette.
 */
export function relayTerminalTheme(options: ReadTokenOptions = {}): XtermTheme | null {
  if (typeof getComputedStyle !== 'function') return null;

  const element = options.element ?? document.documentElement;
  const styles = getComputedStyle(element);

  const theme: Record<string, string> = {};
  for (const [key, token] of TOKEN_MAP) {
    const value = styles.getPropertyValue(token).trim();
    if (!value) return null;
    theme[key] = value;
  }

  // selectionInactiveBackground has no token of its own; Relay's selection
  // colour is already translucent, so reusing it keeps the two consistent
  // rather than inventing a second value.
  theme.selectionInactiveBackground = theme.selectionBackground;

  return theme as XtermTheme;
}
