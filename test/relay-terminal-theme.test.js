const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// xterm renders from a JavaScript theme object, not from CSS custom properties.
// Toggling the Relay `.light` class therefore restyles every React surface and
// stops dead at the terminal — chrome light, terminal still dark. These cover
// the bridge that carries the tokens across.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { relayTerminalTheme } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/terminal-theme'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `relay-theme-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'relay-theme.ts' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
  delete global.getComputedStyle;
  delete global.document;
});

/** Stand in for the cascade with a fixed token table. */
function withTokens(tokens) {
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({
    getPropertyValue: (name) => (name in tokens ? tokens[name] : ''),
  });
}

const FULL = {
  '--terminal-bg': '#fbfbfb',
  '--terminal-fg': '#262626',
  '--terminal-cursor': '#171717',
  '--terminal-selection': 'rgba(23, 23, 23, 0.12)',
  '--ansi-black': '#171717',
  '--ansi-red': '#dc2626',
  '--ansi-green': '#16a34a',
  '--ansi-yellow': '#ca8a04',
  '--ansi-blue': '#2563eb',
  '--ansi-magenta': '#9333ea',
  '--ansi-cyan': '#0891b2',
  '--ansi-white': '#404040',
  '--ansi-bright-black': '#737373',
  '--ansi-bright-red': '#ef4444',
  '--ansi-bright-green': '#22c55e',
  '--ansi-bright-yellow': '#eab308',
  '--ansi-bright-blue': '#3b82f6',
  '--ansi-bright-magenta': '#a855f7',
  '--ansi-bright-cyan': '#06b6d4',
  '--ansi-bright-white': '#171717',
};

describe('relayTerminalTheme', function () {
  it('maps every Relay token onto the xterm theme key it belongs to', function () {
    withTokens(FULL);
    const theme = mod.relayTerminalTheme();
    assert.ok(theme, 'a complete token set must produce a theme');

    assert.strictEqual(theme.background, '#fbfbfb');
    assert.strictEqual(theme.foreground, '#262626');
    assert.strictEqual(theme.cursor, '#171717');
    assert.strictEqual(theme.green, '#16a34a');
    assert.strictEqual(theme.brightMagenta, '#a855f7');
    // No token of its own; it must mirror the active selection rather than be
    // left undefined, which xterm would render as opaque.
    assert.strictEqual(theme.selectionInactiveBackground, theme.selectionBackground);
  });

  it('fills every colour xterm expects, leaving none blank', function () {
    withTokens(FULL);
    const theme = mod.relayTerminalTheme();
    const required = [
      'background', 'foreground', 'cursor', 'cursorAccent',
      'selectionBackground', 'selectionInactiveBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    for (const key of required) {
      assert.ok(theme[key], `${key} must be set, got ${JSON.stringify(theme[key])}`);
    }
  });

  it('returns null rather than a half-built theme when the tokens are missing', function () {
    // The failure that matters: a theme assembled from empty strings renders a
    // black-on-black terminal. Refusing to build one keeps the previous theme,
    // which is merely the wrong palette rather than an unreadable one.
    withTokens({});
    assert.strictEqual(mod.relayTerminalTheme(), null);
  });

  it('returns null when only part of the ramp resolves', function () {
    const partial = { ...FULL };
    delete partial['--ansi-bright-cyan'];
    withTokens(partial);
    assert.strictEqual(
      mod.relayTerminalTheme(),
      null,
      'one missing colour must not yield a theme with a blank entry',
    );
  });

  it('survives an environment with no cascade at all', function () {
    delete global.getComputedStyle;
    assert.strictEqual(mod.relayTerminalTheme(), null);
  });
});
