import { shellStore } from './store';

export type RelayTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'cc-web-relay-theme';

export function readStoredTheme(): RelayTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Put the app into light or dark, without touching the terminal.
 *
 * Two controls decide light versus dark: the shell's own toggle, and the
 * colourway in Settings, which carries a mode of its own (github-light* is
 * light, everything else dark). They set different terminal palettes on
 * purpose, but they must never disagree about the mode itself — that produced
 * a light interface wrapped around a dark terminal.
 *
 * So the mode lives here and both call in. The terminal palette stays with
 * whichever control the user touched last, which is the behaviour they asked
 * for either way.
 */
export function setThemeMode(theme: RelayTheme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
  shellStore.setState({ theme });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode storage failures must not stop the app rendering.
  }
}
