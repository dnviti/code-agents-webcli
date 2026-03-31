// Settings modal: load, save, apply user preferences

import type { ITerminalOptions } from '@xterm/xterm';
import type { App } from '../app';
import type {
  AppSettings,
  TerminalFontFamilyId,
  ThemePresetId,
} from '../types';

const TERMINAL_FONT_FAMILIES: Record<TerminalFontFamilyId, string> = {
  'jetbrains-mono': '"JetBrains Mono", "Fira Code", Monaco, Consolas, monospace',
  'fira-code': '"Fira Code", "JetBrains Mono", Monaco, Consolas, monospace',
  'source-code-pro': '"Source Code Pro", "JetBrains Mono", Monaco, Consolas, monospace',
  'ibm-plex-mono': '"IBM Plex Mono", "JetBrains Mono", Monaco, Consolas, monospace',
  'cascadia-code-nf':
    '"CascadiaCode NF", "CaskaydiaCove Nerd Font", "Cascadia Code", Monaco, Consolas, monospace',
  'hack-nf':
    '"Hack Nerd Font", Hack, "JetBrains Mono", Monaco, Consolas, monospace',
  'meslo-nf':
    '"MesloLGS NF", "MesloLGM Nerd Font", Menlo, Monaco, Consolas, monospace',
  'sauce-code-pro-nf':
    '"SauceCodePro NF", "SauceCodePro Nerd Font", "Source Code Pro", Monaco, Consolas, monospace',
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

const DEFAULTS: AppSettings = {
  fontSize: 14,
  theme: 'github-dark',
  terminalFontFamily: 'jetbrains-mono',
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

export function setupSettingsModal(app: App): void {
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('closeSettingsBtn');
  const saveBtn = document.getElementById('saveSettingsBtn');
  const fontSizeSlider = document.getElementById('fontSize') as HTMLInputElement | null;
  const fontSizeValue = document.getElementById('fontSizeValue');

  closeBtn?.addEventListener('click', () => hideSettings(app));
  saveBtn?.addEventListener('click', () => saveSettings(app));

  fontSizeSlider?.addEventListener('input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (fontSizeValue) {
      fontSizeValue.textContent = target.value + 'px';
    }
  });

  modal?.addEventListener('click', (e: Event) => {
    if (e.target === modal) {
      hideSettings(app);
    }
  });
}

export function showSettings(app: App): void {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.classList.add('active');

  if (app.isMobile) {
    document.body.style.overflow = 'hidden';
  }

  const settings = loadSettings();
  const fontSlider = document.getElementById('fontSize') as HTMLInputElement | null;
  const fontValue = document.getElementById('fontSizeValue');
  const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement | null;
  const terminalFontSelect = document.getElementById('terminalFontFamilySelect') as HTMLSelectElement | null;

  if (fontSlider) fontSlider.value = String(settings.fontSize);
  if (fontValue) fontValue.textContent = settings.fontSize + 'px';
  if (themeSelect) themeSelect.value = settings.theme;
  if (terminalFontSelect) terminalFontSelect.value = settings.terminalFontFamily;
}

export function hideSettings(app: App): void {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('active');

  if (app.isMobile) {
    document.body.style.overflow = '';
  }
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
    };
  } catch (error) {
    console.error('Failed to load settings:', error);
    return { ...DEFAULTS };
  }
}

export function saveSettings(app: App): void {
  const fontSlider = document.getElementById('fontSize') as HTMLInputElement | null;
  const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement | null;
  const terminalFontSelect = document.getElementById('terminalFontFamilySelect') as HTMLSelectElement | null;

  const settings: AppSettings = {
    fontSize: parseInt(fontSlider?.value ?? String(DEFAULTS.fontSize), 10),
    theme: normalizeThemePreset(themeSelect?.value) ?? DEFAULTS.theme,
    terminalFontFamily:
      (terminalFontSelect?.value as TerminalFontFamilyId) ?? DEFAULTS.terminalFontFamily,
  };

  try {
    localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    applySettings(app, settings);
    hideSettings(app);
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

export function applySettings(app: App, settings: AppSettings): void {
  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.setAttribute('data-color-mode', getThemeMode(settings.theme));
  updateThemeColor(settings.theme);

  const terminalFontFamily =
    TERMINAL_FONT_FAMILIES[settings.terminalFontFamily] ||
    TERMINAL_FONT_FAMILIES[DEFAULTS.terminalFontFamily];
  const terminalTheme =
    TERMINAL_THEMES[settings.theme] ||
    TERMINAL_THEMES[DEFAULTS.theme];

  if (app.terminal) {
    app.terminal.options.fontSize = settings.fontSize;
    app.terminal.options.fontFamily = terminalFontFamily;
    app.terminal.options.theme = terminalTheme;
  }

  app.terminalController?.restoreViewport();
  app.splitContainer?.applyTerminalAppearance({
    fontSize: settings.fontSize,
    fontFamily: terminalFontFamily,
    theme: terminalTheme,
  });
  app.fitTerminal();
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
