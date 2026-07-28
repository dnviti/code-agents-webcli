// Settings modal: load, save, apply user preferences

import type { ITerminalOptions } from '@xterm/xterm';
import type { App } from '../app';
import { shellStore } from '../shell/store';
import { setThemeMode } from '../shell/theme';
import type {
  AppSettings,
  NotifySettings,
  TerminalFontFamilyId,
  ThemePresetId,
} from '../types';

interface TerminalFontPreset {
  fontFamily: string;
  loadFamily?: string;
}

const TERMINAL_FONT_PRESETS: Record<TerminalFontFamilyId, TerminalFontPreset> = {
  'jetbrains-mono': {
    fontFamily: '"JetBrains Mono", "Fira Code", Monaco, Consolas, monospace',
  },
  'fira-code': {
    fontFamily: '"Fira Code", "JetBrains Mono", Monaco, Consolas, monospace',
  },
  'source-code-pro': {
    fontFamily: '"Source Code Pro", "JetBrains Mono", Monaco, Consolas, monospace',
  },
  'ibm-plex-mono': {
    fontFamily: '"IBM Plex Mono", "JetBrains Mono", Monaco, Consolas, monospace',
  },
  'cascadia-code-nf': {
    fontFamily:
      '"CaskaydiaMono Nerd Font", "CaskaydiaCove Nerd Font Mono", "Cascadia Code", Monaco, Consolas, monospace',
    loadFamily: '"CaskaydiaMono Nerd Font"',
  },
  'hack-nf': {
    fontFamily:
      '"Hack Nerd Font Mono", "Hack Nerd Font", Hack, "JetBrains Mono", Monaco, Consolas, monospace',
    loadFamily: '"Hack Nerd Font Mono"',
  },
  'meslo-nf': {
    fontFamily:
      '"MesloLGS Nerd Font Mono", "MesloLGS Nerd Font", Menlo, Monaco, Consolas, monospace',
    loadFamily: '"MesloLGS Nerd Font Mono"',
  },
  'sauce-code-pro-nf': {
    fontFamily:
      '"SauceCodePro Nerd Font Mono", "SauceCodePro Nerd Font", "Source Code Pro", Monaco, Consolas, monospace',
    loadFamily: '"SauceCodePro Nerd Font Mono"',
  },
};

const TERMINAL_THEMES: Record<ThemePresetId, NonNullable<ITerminalOptions['theme']>> = {
  'github-dark': {
    background: '#0d1117',
    foreground: '#f0f6fc',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(88, 166, 255, 0.3)',
    selectionInactiveBackground: 'rgba(88, 166, 255, 0.18)',
    black: '#484f58',
    red: '#ff7b72',
    green: '#7ee787',
    yellow: '#ffa657',
    blue: '#79c0ff',
    magenta: '#d2a8ff',
    cyan: '#a5f3fc',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#ffdf5d',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#a5f3fc',
    brightWhite: '#f0f6fc',
  },
  'github-dark-dimmed': {
    background: '#22272e',
    foreground: '#cdd9e5',
    cursor: '#539bf5',
    cursorAccent: '#22272e',
    selectionBackground: 'rgba(83, 155, 245, 0.26)',
    selectionInactiveBackground: 'rgba(83, 155, 245, 0.14)',
    black: '#373e47',
    red: '#f47067',
    green: '#57ab5a',
    yellow: '#c69026',
    blue: '#539bf5',
    magenta: '#b083f0',
    cyan: '#39c5cf',
    white: '#cdd9e5',
    brightBlack: '#768390',
    brightRed: '#ff938a',
    brightGreen: '#6bc46d',
    brightYellow: '#daaa3f',
    brightBlue: '#6cb6ff',
    brightMagenta: '#c297ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  'github-dark-high-contrast': {
    background: '#010409',
    foreground: '#f0f3f6',
    cursor: '#79c0ff',
    cursorAccent: '#010409',
    selectionBackground: 'rgba(121, 192, 255, 0.26)',
    selectionInactiveBackground: 'rgba(121, 192, 255, 0.16)',
    black: '#7a828e',
    red: '#ff9492',
    green: '#26cd4d',
    yellow: '#f0b72f',
    blue: '#71b7ff',
    magenta: '#cb9eff',
    cyan: '#39c5cf',
    white: '#f0f3f6',
    brightBlack: '#9ea7b3',
    brightRed: '#ffb1af',
    brightGreen: '#4ae168',
    brightYellow: '#f7c843',
    brightBlue: '#91cbff',
    brightMagenta: '#ddb7ff',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff',
  },
  'github-light': {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#0969da',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(9, 105, 218, 0.2)',
    selectionInactiveBackground: 'rgba(9, 105, 218, 0.12)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#bf8700',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#24292f',
  },
  'github-light-high-contrast': {
    background: '#ffffff',
    foreground: '#0e1116',
    cursor: '#0969da',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(9, 105, 218, 0.24)',
    selectionInactiveBackground: 'rgba(9, 105, 218, 0.14)',
    black: '#0e1116',
    red: '#a0111f',
    green: '#1a7f37',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#6f42c1',
    cyan: '#045b75',
    white: '#57606a',
    brightBlack: '#3d444d',
    brightRed: '#cf222e',
    brightGreen: '#116329',
    brightYellow: '#9a6700',
    brightBlue: '#0550ae',
    brightMagenta: '#8250df',
    brightCyan: '#0969da',
    brightWhite: '#0e1116',
  },
};

/**
 * Everything on.
 *
 * A notification still needs the browser's own permission, which this app asks
 * for from a click in the settings dialog and nowhere else — so "on" here means
 * "as soon as you allow it", not "the moment the page loads".
 */
export const DEFAULT_NOTIFICATIONS: NotifySettings = {
  enabled: true,
  finished: true,
  failed: true,
  approval: true,
  question: true,
  details: true,
};

const DEFAULTS: AppSettings = {
  fontSize: 14,
  theme: 'github-dark',
  terminalFontFamily: 'jetbrains-mono',
  // Off. Every other default in this file is a matter of taste; this one
  // decides whether an agent can act on this machine without being asked.
  chatBypassPermissions: false,
  notifications: DEFAULT_NOTIFICATIONS,
};

const THEME_ALIASES: Record<string, ThemePresetId> = {
  'github-dark': 'github-dark',
  'github-dark-dimmed': 'github-dark-dimmed',
  'github-dark-high-contrast': 'github-dark-high-contrast',
  'github-light': 'github-light',
  'github-light-high-contrast': 'github-light-high-contrast',
  'github-light-soft': 'github-light',
  dark: 'github-dark',
  light: 'github-light',
  dracula: 'github-dark-dimmed',
  'solarized-dark': 'github-dark-dimmed',
};

export function showSettings(): void {
  shellStore.patchSlice('dialogs', { settings: true });
}

export function hideSettings(): void {
  shellStore.patchSlice('dialogs', { settings: false });
}

export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem('cc-web-settings');
    if (!saved) {
      return { ...DEFAULTS };
    }

    const parsed = JSON.parse(saved) as Partial<AppSettings> & {
      terminalTheme?: string;
      theme?: string;
    };
    const normalizedTheme = normalizeThemePreset(parsed.theme, parsed.terminalTheme);

    return {
      ...DEFAULTS,
      ...parsed,
      theme: normalizedTheme,
      terminalFontFamily: normalizeTerminalFontFamily(parsed.terminalFontFamily),
      // Strict equality, not truthiness: anything in storage that is not
      // literally `true` leaves approvals on.
      chatBypassPermissions: parsed.chatBypassPermissions === true,
      notifications: normalizeNotifications(parsed.notifications),
    };
  } catch (error) {
    console.error('Failed to load settings:', error);
    return { ...DEFAULTS };
  }
}

/**
 * Coerce whatever storage hands back into a complete set of choices.
 *
 * `!== false` rather than `=== true`, the opposite of the approval bypass above
 * and for the same reason read the other way: the safe side of a notification
 * toggle is on. A blob written before this feature existed has no `notifications`
 * key at all, and reading its absence as silence would ship a feature that is
 * off for everybody who has ever opened the app.
 */
function normalizeNotifications(value: unknown): NotifySettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<NotifySettings>;
  return {
    enabled: input.enabled !== false,
    finished: input.finished !== false,
    failed: input.failed !== false,
    approval: input.approval !== false,
    question: input.question !== false,
    details: input.details !== false,
  };
}

function normalizeTerminalFontFamily(value: unknown): TerminalFontFamilyId {
  if (typeof value !== 'string') {
    return DEFAULTS.terminalFontFamily;
  }

  if (value in TERMINAL_FONT_PRESETS) {
    return value as TerminalFontFamilyId;
  }

  return DEFAULTS.terminalFontFamily;
}

/**
 * Persist and apply.
 *
 * The values now arrive from the dialog rather than being read back out of
 * three inputs, so they are re-normalised here: the dialog is the only caller
 * today, but this is the function that decides what gets written to storage and
 * it should not trust its input to be a valid preset id.
 */
export function saveSettings(app: App, next: AppSettings): void {
  // Every field is named here on purpose, and every field has to be: this
  // literal is what gets written, so a setting added to the type and to
  // `loadSettings` but forgotten here reads back correctly until the first save
  // and then reverts for good.
  const settings: AppSettings = {
    fontSize: clampFontSize(next.fontSize),
    theme: normalizeThemePreset(next.theme),
    terminalFontFamily: normalizeTerminalFontFamily(next.terminalFontFamily),
    chatBypassPermissions: next.chatBypassPermissions === true,
    notifications: normalizeNotifications(next.notifications),
  };

  try {
    localStorage.setItem('cc-web-settings', JSON.stringify(settings));
  } catch (error) {
    // Private browsing refuses writes. Applying anyway is right: the change
    // works for this session, it just will not survive a reload.
    console.error('Failed to save settings:', error);
  }

  applySettings(app, settings);
  hideSettings();
}

/** Matches the dialog's slider bounds; a stored value outside them is junk. */
function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.fontSize;
  return Math.min(24, Math.max(10, Math.round(value)));
}

export function applySettings(app: App, settings: AppSettings): void {
  // Published so the runtime launcher can show the current choice on the
  // button that acts on it, instead of the two reading storage separately and
  // disagreeing about what is about to happen.
  shellStore.setState({ chatBypassPermissions: settings.chatBypassPermissions === true });

  // Same reason, and one more: the code that decides whether a finished
  // conversation may interrupt somebody runs on a socket message, nowhere near
  // React, and reading localStorage on every chat event of every conversation
  // would be a parse per token.
  shellStore.setState({ notifications: normalizeNotifications(settings.notifications) });

  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.setAttribute('data-color-mode', getThemeMode(settings.theme));
  updateThemeColor(settings.theme);

  // Keep the Relay shell on the same side of light/dark as the colourway.
  // The two set different terminal palettes by design, but without this a
  // github-dark colourway left the chrome light around a dark terminal.
  setThemeMode(getThemeMode(settings.theme));

  const terminalFontPreset =
    TERMINAL_FONT_PRESETS[settings.terminalFontFamily] ||
    TERMINAL_FONT_PRESETS[DEFAULTS.terminalFontFamily];
  const terminalTheme =
    TERMINAL_THEMES[settings.theme] ||
    TERMINAL_THEMES[DEFAULTS.theme];

  // Published as the app-wide monospace family, not just handed to xterm.
  // Everything that shows code already reads `--font-mono` — the chat's code
  // blocks and inline spans, the file editor, the diff view, the `@` picker —
  // and before this the setting labelled "terminal font" changed exactly one
  // of them, so the same snippet was one typeface in the terminal and another
  // in the transcript quoting it.
  try {
    document.documentElement.style.setProperty('--font-mono', terminalFontPreset.fontFamily);
  } catch {
    // A document that refuses a custom property is one where the rest of this
    // will not work either; the terminal below is still worth applying.
  }

  if (app.terminal) {
    app.terminal.options.fontSize = settings.fontSize;
    app.terminal.options.fontFamily = terminalFontPreset.fontFamily;
    app.terminal.options.theme = terminalTheme;
  }

  app.terminalController?.restoreViewport();
  app.splitContainer?.applyTerminalAppearance({
    fontSize: settings.fontSize,
    fontFamily: terminalFontPreset.fontFamily,
    theme: terminalTheme,
  });
  app.fitTerminal();
  void loadTerminalFont(app, terminalFontPreset, settings.fontSize, terminalTheme);
}

async function loadTerminalFont(
  app: App,
  preset: TerminalFontPreset,
  fontSize: number,
  terminalTheme: NonNullable<ITerminalOptions['theme']>,
): Promise<void> {
  if (!preset.loadFamily || !document.fonts?.load) {
    return;
  }

  try {
    await document.fonts.load(`${Math.max(fontSize, 12)}px ${preset.loadFamily}`);
    app.terminalController?.restoreViewport();
    app.splitContainer?.applyTerminalAppearance({
      fontSize,
      fontFamily: preset.fontFamily,
      theme: terminalTheme,
    });
    app.fitTerminal();
  } catch {
    // Font loading is best-effort only.
  }
}

function normalizeThemePreset(
  theme?: string,
  legacyTerminalTheme?: string,
): ThemePresetId {
  if (theme && theme in THEME_ALIASES) {
    return THEME_ALIASES[theme];
  }

  if (legacyTerminalTheme && legacyTerminalTheme in THEME_ALIASES) {
    return THEME_ALIASES[legacyTerminalTheme];
  }

  return DEFAULTS.theme;
}

function getThemeMode(theme: ThemePresetId): 'light' | 'dark' {
  return theme.startsWith('github-light') ? 'light' : 'dark';
}

function updateThemeColor(theme: ThemePresetId): void {
  const themeColor = theme === 'github-light'
    ? '#f6f8fa'
    : theme === 'github-light-high-contrast'
      ? '#ffffff'
      : theme === 'github-dark-dimmed'
        ? '#22272e'
        : theme === 'github-dark-high-contrast'
          ? '#010409'
          : '#0d1117';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', themeColor);
  }
}
