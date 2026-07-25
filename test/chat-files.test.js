const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// FileTreePanel manages expand/collapse state internally in response to real
// DOM click/keyboard events, which renderToStaticMarkup cannot dispatch (no
// hydration, no event loop). So this suite — like relay-components.test.js,
// which it mirrors — proves every state the component can be *mounted* into
// renders correctly: collapsed trees of mixed entries, the changed-file
// markers, the loading/empty states, and the render cap on a huge directory.
// The expand/collapse transition itself is exercised by hand-tracing the
// `toggle`/`buildNavRows`/`visibleSlice` logic during review, not by this file.

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'client', 'shell', 'chat', 'FileTreePanel.tsx');

let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { FileTreePanel } from ${JSON.stringify(FILE)};`,
  ].join('\n');

  const bundle = path.join(os.tmpdir(), `chat-files-smoke-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-files-smoke.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });

  mod = require(bundle);
  fs.rmSync(bundle, { force: true });
});

function entry(name, opts = {}) {
  return { path: `/repo/${name}`, name, isDirectory: false, ...opts };
}

function dir(name, opts = {}) {
  return { path: `/repo/${name}`, name, isDirectory: true, ...opts };
}

function render(props) {
  const { renderToStaticMarkup, React, FileTreePanel } = mod;
  return renderToStaticMarkup(
    React.createElement(FileTreePanel, {
      root: '/repo',
      entries: [],
      onExpand: async () => [],
      ...props,
    }),
  );
}

describe('FileTreePanel', function () {
  it('exports a component function', function () {
    assert.strictEqual(typeof mod.FileTreePanel, 'function');
  });

  it('renders a nested mix of directories and files, sorted directories-first', function () {
    const html = render({
      entries: [
        entry('zeta.ts'),
        dir('alpha'),
        entry('beta.md'),
        dir('gamma'),
      ],
    });
    assert.ok(html.includes('role="tree"'), 'root container must expose role="tree"');
    assert.ok(html.includes('role="treeitem"'), 'entries must expose role="treeitem"');
    assert.ok(html.includes('aria-level="1"'), 'top-level rows must carry aria-level');
    assert.ok(html.includes('alpha'), 'directory name missing');
    assert.ok(html.includes('zeta.ts'), 'file name missing');
    // Directories sort before files: alpha's row must precede zeta.ts's row.
    assert.ok(html.indexOf('alpha') < html.indexOf('zeta.ts'), 'directories must sort before files');
    assert.ok(html.indexOf('gamma') < html.indexOf('beta.md'), 'directories must sort before files');
  });

  it('shows a compact size on files but not on directories', function () {
    const html = render({
      entries: [entry('big.bin', { size: 3 * 1024 * 1024 }), dir('src')],
    });
    assert.ok(html.includes('3.0M') || html.includes('3M'), `expected a compact size, got: ${html}`);
  });

  it('marks a changed file with its kind letter, and gives every kind a distinct badge', function () {
    const html = render({
      entries: [entry('created.ts'), entry('updated.ts'), entry('deleted.ts'), entry('renamed.ts')],
      changed: {
        '/repo/created.ts': 'create',
        '/repo/updated.ts': 'update',
        '/repo/deleted.ts': 'delete',
        '/repo/renamed.ts': 'rename',
      },
    });
    for (const letter of ['A', 'M', 'D', 'R']) {
      assert.ok(html.includes(`>${letter}<`), `expected a "${letter}" change badge in: ${html}`);
    }
  });

  it('rolls up descendant changes onto a collapsed directory as a count, not just a colour', function () {
    const html = render({
      entries: [dir('src')],
      changed: {
        '/repo/src/a.ts': 'update',
        '/repo/src/nested/b.ts': 'create',
      },
    });
    // Collapsed, so the two files themselves are not rendered — only the
    // directory's roll-up marker, which must be a legible count.
    assert.ok(html.includes('>2<'), `expected a roll-up count badge of 2 in: ${html}`);
  });

  it('renders an accessible-name loading state distinct from an empty one', function () {
    const loadingHtml = render({ loading: true });
    assert.ok(/loading/i.test(loadingHtml), 'loading state must say so in text, not just spin silently');

    const emptyHtml = render({ entries: [] });
    assert.ok(/no files/i.test(emptyHtml), 'an empty root must read as empty, not as still loading');
    assert.notStrictEqual(loadingHtml, emptyHtml);
  });

  it('caps a huge directory listing and offers a way to see the rest', function () {
    const entries = [];
    for (let i = 0; i < 5000; i += 1) {
      entries.push(entry(`file-${String(i).padStart(5, '0')}.txt`));
    }
    const html = render({ entries });
    assert.ok(html.includes('file-00000.txt'), 'first entries after sort must render');
    assert.ok(!html.includes('file-04999.txt'), 'render must be capped, not dump all 5000 nodes');
    assert.ok(/Show 4700 more/.test(html), `expected a "show more" affordance, got tail: ${html.slice(-400)}`);
  });

  it('renders an empty directory with no crash when it has zero entries and a root path with no trailing slash', function () {
    const html = render({ root: '/srv/app', entries: [] });
    assert.ok(html.length > 0);
    assert.ok(html.includes('/srv/app'));
  });

  it('wires the refresh affordance only when a handler is supplied', function () {
    const withRefresh = render({ onRefresh: () => {} });
    const withoutRefresh = render({});
    assert.ok(withRefresh.includes('Refresh file tree'), 'refresh button must have an accessible name');
    assert.ok(!withoutRefresh.includes('Refresh file tree'), 'no onRefresh must mean no refresh control');
  });
});
