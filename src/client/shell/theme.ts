import { shellStore } from './store';

export type RelayTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'cc-web-relay-theme';

/**
 * The theme to open in.
 *
 * A stored choice wins outright — it is the user saying so. With nothing
 * stored, the operating system's preference is the next best evidence, and
 * defaulting to dark against a machine set to light is the app disagreeing with
 * its own environment on first run for no reason. Dark remains the fallback
 * when nothing can be read, which is the house style.
 */
export function readStoredTheme(): RelayTheme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private-mode storage refuses reads; fall through to the OS preference.
  }
  return systemTheme();
}

/** What the OS is asking for, or dark where it cannot be asked. */
export function systemTheme(): RelayTheme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Follow the OS while the user has expressed no preference of their own.
 *
 * Stops as soon as anything is stored — flipping the app out from under someone
 * who chose dark, because their machine went light at sunset, would be the app
 * overruling them.
 */
export function watchSystemTheme(apply: (theme: RelayTheme) => void): () => void {
  let query: MediaQueryList;
  try {
    query = window.matchMedia('(prefers-color-scheme: light)');
  } catch {
    return () => {};
  }

  const onChange = (): void => {
    try {
      if (localStorage.getItem(THEME_STORAGE_KEY)) return;
    } catch {
      // Unreadable storage means no stored choice to respect.
    }
    apply(systemTheme());
  };

  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
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
