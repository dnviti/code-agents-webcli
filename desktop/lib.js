'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIN_WINDOW_WIDTH = 720;
const MIN_WINDOW_HEIGHT = 520;
const DEFAULT_WINDOW = Object.freeze({
  width: 1280,
  height: 820,
  isMaximized: false,
});
const CUSTOM_TITLE_BAR_HEIGHT = 40;
const DESKTOP_PERMISSIONS = new Set([
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
]);

/**
 * Let the web shell occupy the non-client area so Electron uses the same
 * title bar as the installed PWA. Windows and Linux need explicit colours for
 * their caption-button overlay; macOS supplies its own traffic-light styling.
 */
function desktopWindowChrome(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      // `hidden` keeps the real macOS traffic lights in their native upper-left
      // position. Do not set trafficLightPosition: the OS owns that placement,
      // while WCO reports the safe rectangle to the web title bar.
      titleBarStyle: 'hidden',
      titleBarOverlay: true,
    };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0a',
      symbolColor: '#fafafa',
      height: CUSTOM_TITLE_BAR_HEIGHT,
    },
    autoHideMenuBar: true,
  };
}

/** Pick whichever caption-symbol colour has stronger contrast with #rrggbb. */
function titleBarSymbolColor(background) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(background || '');
  if (!match) return '#fafafa';
  const linear = match.slice(1).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.179 ? '#0a0a0a' : '#fafafa';
}

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function intersectsDisplay(bounds, displays) {
  return displays.some((display) => {
    const area = display.workArea || display.bounds;
    if (!area) return false;
    const width = Math.min(bounds.x + bounds.width, area.x + area.width)
      - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height)
      - Math.max(bounds.y, area.y);
    // A sliver is not recoverable enough to drag. Keep a useful part of the
    // title bar visible after a monitor is unplugged or its scale changes.
    return width >= 120 && height >= 48;
  });
}

function normalizeWindowState(value, displays = []) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WINDOW };

  const width = finiteInteger(value.width);
  const height = finiteInteger(value.height);
  const x = finiteInteger(value.x);
  const y = finiteInteger(value.y);
  const candidate = {
    width: width && width >= MIN_WINDOW_WIDTH ? width : DEFAULT_WINDOW.width,
    height: height && height >= MIN_WINDOW_HEIGHT ? height : DEFAULT_WINDOW.height,
    ...(x === null ? {} : { x }),
    ...(y === null ? {} : { y }),
    isMaximized: value.isMaximized === true,
  };

  if (
    displays.length > 0
    && typeof candidate.x === 'number'
    && typeof candidate.y === 'number'
    && !intersectsDisplay(candidate, displays)
  ) {
    delete candidate.x;
    delete candidate.y;
  }
  return candidate;
}

function readWindowState(filename, displays) {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(filename, 'utf8')), displays);
  } catch {
    return { ...DEFAULT_WINDOW };
  }
}

function writeWindowState(filename, state) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

async function shutdownAfterStartupFailure(server, report = () => {}) {
  if (!server) return;
  try {
    await server.shutdown();
  } catch (error) {
    report(error);
  }
}

function isSafeExternalUrl(raw, localOrigin) {
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.origin !== localOrigin;
  } catch {
    return false;
  }
}

function desktopCookie(baseUrl, token, name = 'code_agents_webcli_desktop_auth') {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('Desktop authentication cookies are only valid on loopback HTTP.');
  }
  return {
    url: url.origin,
    name,
    value: token,
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
  };
}

function normalizedOrigin(value) {
  try {
    return value ? new URL(value).origin : '';
  } catch {
    return '';
  }
}

/**
 * Grant the local desktop shell only the browser capabilities it actually
 * uses. Clipboard access is needed by xterm's explicit copy/paste shortcuts;
 * exact-origin matching keeps remote or embedded content denied.
 */
function desktopPermissionAllowed(permission, requestingOrigin, localOrigin) {
  return DESKTOP_PERMISSIONS.has(permission)
    && normalizedOrigin(requestingOrigin) === normalizedOrigin(localOrigin);
}

function mergePath(preferred, inherited, delimiter = path.delimiter) {
  const seen = new Set();
  return [preferred, inherited]
    .filter(Boolean)
    .flatMap((value) => String(value).split(delimiter))
    .map((value) => value.trim())
    .filter((value) => value && !seen.has(value) && seen.add(value))
    .join(delimiter);
}

/**
 * GUI applications do not inherit a login shell's PATH on macOS and many Linux
 * desktops. Agent CLIs commonly live under nvm, mise, Homebrew or a user bin,
 * so recover that PATH once before bridges resolve their commands. The marker
 * makes shell startup banners harmless.
 */
function loginShellPath(options = {}) {
  if ((options.platform || process.platform) === 'win32') {
    return options.inheritedPath || process.env.PATH || '';
  }
  const shell = options.shell || process.env.SHELL || '/bin/sh';
  const exec = options.execFileSync || execFileSync;
  const marker = '__CODE_AGENTS_PATH__=';
  try {
    const output = exec(
      shell,
      ['-ilc', `printf '\n${marker}%s\n' "$PATH"`],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, TERM: 'dumb' },
      },
    );
    const index = String(output).lastIndexOf(marker);
    const recovered = index < 0
      ? ''
      : String(output).slice(index + marker.length).split(/\r?\n/, 1)[0];
    return mergePath(recovered, options.inheritedPath || process.env.PATH || '');
  } catch {
    return options.inheritedPath || process.env.PATH || '';
  }
}

module.exports = {
  CUSTOM_TITLE_BAR_HEIGHT,
  DEFAULT_WINDOW,
  desktopPermissionAllowed,
  desktopWindowChrome,
  desktopCookie,
  isSafeExternalUrl,
  loginShellPath,
  mergePath,
  normalizeWindowState,
  readWindowState,
  shutdownAfterStartupFailure,
  titleBarSymbolColor,
  writeWindowState,
};
