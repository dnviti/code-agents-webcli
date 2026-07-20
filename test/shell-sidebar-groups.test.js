const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// sidebarGroups is not exported — it is an implementation detail of AppShell —
// so the grouping is exercised through the rendered sidebar instead. That is
// also the honest level to test at: what matters is the order a user sees.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { AppShell } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/AppShell'))};`,
    `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `shell-groups-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'shell-groups.tsx' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
});

function renderWith(tabs) {
  const { renderToStaticMarkup, React, AppShell, shellStore } = mod;
  shellStore.setState({ tabs, activeId: tabs.length ? tabs[0].id : null, sidebarOpen: true });
  // A plain detached node stands in for the adopted terminal; the shell only
  // ever appends to it, and renderToStaticMarkup never runs effects anyway.
  const node = { nodeType: 1 };
  return renderToStaticMarkup(
    React.createElement(AppShell, {
      terminalNode: node,
      actions: {
        selectTab() {}, closeTab() {}, newTab() {},
        openSettings() {}, fitTerminal() {}, setTheme() {},
      },
    }),
  );
}

function tab(id, kind) {
  return { id, title: id, status: 'idle', kind, workingDir: null, unread: false };
}

describe('shell sidebar grouping', function () {
  it('orders known runtimes by the declared runtime order', function () {
    const html = renderWith([tab('a', 'kimi'), tab('b', 'claude'), tab('c', 'grok')]);
    const claude = html.indexOf('Claude');
    const grok = html.indexOf('Grok');
    const kimi = html.indexOf('Kimi');
    assert.ok(claude !== -1 && grok !== -1 && kimi !== -1, 'all three groups should render');
    assert.ok(claude < grok, 'Claude should come before Grok');
    assert.ok(grok < kimi, 'Grok should come before Kimi');
  });

  it('puts an unknown runtime last, not first', function () {
    // The regression: Array#indexOf returns -1 for an unranked kind, and a raw
    // indexOf subtraction sorts -1 ahead of every known runtime — so any kind
    // not yet in the label table, including the empty placeholder used before
    // the runtime is plumbed through, jumped to the top of the sidebar.
    const html = renderWith([tab('a', 'somethingnew'), tab('b', 'claude')]);
    const claude = html.indexOf('Claude');
    const unknown = html.indexOf('somethingnew');
    assert.ok(claude !== -1 && unknown !== -1, 'both groups should render');
    assert.ok(
      claude < unknown,
      'a known runtime must be listed before an unknown one',
    );
  });

  it('does not paint an idle session with the warning dot', function () {
    // 'busy' resolves to var(--warning) in ProfileSidebar, so mapping idle to
    // it made every quiet session look like it needed attention, and left
    // "busy" meaning "not running".
    const idle = renderWith([tab('a', 'claude')]);
    assert.ok(
      !/var\(--warning\)/.test(idle),
      'an idle session must not render the warning dot',
    );

    const running = renderWith([{ ...tab('b', 'claude'), status: 'running' }]);
    assert.ok(
      /var\(--ansi-green\)/.test(running),
      'a running session should still render the online dot',
    );
  });

  it('groups sessions of the same runtime together', function () {
    const html = renderWith([tab('a', 'claude'), tab('b', 'kimi'), tab('c', 'claude')]);
    assert.strictEqual(
      html.split('Claude').length - 1,
      1,
      'the Claude group heading should appear exactly once',
    );
  });
});
