const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Relay components are .tsx and never reach dist/ on their own — esbuild
// bundles them straight into app.bundle.js for the browser. Typechecking them
// only proves they compile; it does not prove they render. This bundles them
// for Node and renders each one, which is what catches a bad import, a hook
// called at module scope, or a lookup table that returns undefined.

const ROOT = path.join(__dirname, '..');
const RELAY_DIR = path.join(ROOT, 'src', 'client', 'ui', 'relay');

// Minimal props per component. Anything not listed renders with no props at
// all, which is itself the assertion: a primitive must not explode bare.
const PROPS = {
  Button: { children: 'ok' },
  IconButton: { label: 'Toggle', children: null },
  Badge: { children: 'live' },
  Kbd: { children: 'K' },
  SettingRow: { label: 'Font size', children: null },
  Tooltip: { label: 'Hint', children: 'target' },
  Dialog: { open: true, title: 'Settings', children: 'body' },
  Icon: { name: 'terminal' },
  TabBar: {
    tabs: [{ id: 't1', title: 'zsh', status: 'running' }],
    activeId: 't1',
  },
  Tabs: {
    tabs: [{ id: 'a', label: 'General' }],
    value: 'a',
  },
  ProfileSidebar: {
    groups: [{ label: 'Local', items: [{ id: 'l1', label: 'zsh', status: 'online' }] }],
    activeId: 'l1',
  },
  StatusBar: { left: [{ children: 'main' }], right: [{ children: '2 tabs' }] },
  CommandPalette: {
    open: true,
    groups: [{ label: 'Tabs', items: [{ label: 'New tab' }] }],
  },
  SplitPane: { children: ['left', 'right'] },
  TerminalPane: { lines: ['$ echo hi', 'hi'] },
  // 'none' is what this app actually renders: it runs in a browser tab, so mac
  // traffic lights and windows caption glyphs would be buttons that do nothing.
  WindowControls: { title: 'relay', os: 'none' },
  Switch: { label: 'Enabled' },
  // Both need a label: rendered bare they exercise none of the
  // label-association path, which is where their accessibility bugs were.
  Checkbox: { label: 'Enabled' },
  Select: { options: [{ value: 'a', label: 'A' }] },
};

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const names = fs
    .readdirSync(RELAY_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();

  assert.ok(names.length > 0, 'no Relay components found to test');

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    ...names.map((n) => `export { ${n} } from ${JSON.stringify(path.join(RELAY_DIR, n))};`),
  ].join('\n');

  bundle = path.join(os.tmpdir(), `relay-smoke-${process.pid}.js`);
  require('esbuild').buildSync({
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'relay-smoke.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });

  mod = require(bundle);
  mod.__names = names;
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

describe('Relay components', function () {
  it('exports every ported component', function () {
    for (const name of mod.__names) {
      assert.strictEqual(
        typeof mod[name],
        'function',
        `${name} must be exported as a component function`,
      );
    }
  });

  it('renders each component to non-empty markup', function () {
    const { renderToStaticMarkup, React } = mod;
    const empty = [];

    for (const name of mod.__names) {
      const html = renderToStaticMarkup(
        React.createElement(mod[name], PROPS[name] || {}),
      );
      // Icon returns null for an unknown name by design, but every component
      // here is given a valid one, so nothing should render blank.
      if (!html || html.length === 0) empty.push(name);
    }

    assert.deepStrictEqual(empty, [], `these rendered nothing: ${empty.join(', ')}`);
  });

  it('themes from CSS custom properties rather than baked-in colours', function () {
    // The whole point of the token layer: swapping .light must restyle the app.
    // A component that hardcodes #0a0a0a silently ignores the theme.
    const { renderToStaticMarkup, React } = mod;
    const offenders = [];

    for (const name of mod.__names) {
      const html = renderToStaticMarkup(
        React.createElement(mod[name], PROPS[name] || {}),
      );
      // Inline SVG payloads legitimately carry their own literals.
      const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
      const hex = withoutSvg.match(/(?:color|background|border|fill)[^;"']*#[0-9a-fA-F]{3,8}/g);
      if (hex) offenders.push(`${name}: ${hex.join(', ')}`);
    }

    assert.deepStrictEqual(offenders, [], `hardcoded colours found:\n${offenders.join('\n')}`);
  });

  it('keeps the one legitimate colour literal behind the variant that needs it', function () {
    // WindowControls os="mac" paints the real macOS traffic lights, which are
    // fixed system colours and correctly do not theme. That exception is
    // pinned here rather than whitelisted on the component, so if any other
    // literal appears in it the check above still fails.
    const { renderToStaticMarkup, React } = mod;
    const mac = renderToStaticMarkup(
      React.createElement(mod.WindowControls, { title: 'relay', os: 'mac' }),
    );
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
      assert.ok(mac.includes(c), `mac variant should paint ${c}`);
    }

    const none = renderToStaticMarkup(
      React.createElement(mod.WindowControls, { title: 'relay', os: 'none' }),
    );
    assert.ok(!/#[0-9a-fA-F]{3,8}/.test(none), 'os="none" must not paint window decoration');
  });
});

// --------------------------------------------------------------------------
// Icon.tsx returns null for a name it does not know, so a typo — or a name
// added to a component before it was added to the set — renders nothing at all.
// No error, no warning, just a control that quietly loses its glyph. That is
// how "Install app" shipped without its icon while every row beside it had one.
// --------------------------------------------------------------------------

describe('Relay icon names', function () {
  it('defines every icon the client asks for', function () {
    const iconSrc = fs.readFileSync(path.join(RELAY_DIR, 'Icon.tsx'), 'utf8');
    const defined = new Set([...iconSrc.matchAll(/^ {2}"([a-z0-9-]+)":/gm)].map((m) => m[1]));
    assert.ok(defined.size > 0, 'no icons parsed out of Icon.tsx');

    const used = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || entry.name.startsWith('Icon.')) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Only the two shapes that reach Icon: the JSX prop and the plain
        // `icon:` field the bars and sheets use to describe their rows.
        for (const m of text.matchAll(/<Icon\s[^>]*name="([a-z0-9-]+)"/g)) used.set(m[1], full);
        for (const m of text.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) used.set(m[1], full);
      }
    };
    walk(path.join(ROOT, 'src', 'client'));

    const missing = [...used.entries()].filter(([name]) => !defined.has(name));
    assert.deepStrictEqual(
      missing.map(([name, file]) => `${name} (${path.relative(ROOT, file)})`),
      [],
      'these icon names render as nothing because Icon.tsx does not define them',
    );
  });
});
