const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The service worker used to ask "Refresh to update?" with window.confirm —
// the browser's own dialog, in the browser's chrome, which on an installed PWA
// reads as the page being taken over. It asks with the app's dialog now.
//
// The property worth pinning is not that it looks right but that a question
// nobody answered is never read as a yes: every way out of the dialog except
// the confirm button must resolve false.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { showConfirm, resolveConfirm } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/confirm'))};`,
    `export { ConfirmDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ConfirmDialog'))};`,
    `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `confirm-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'confirm.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

afterEach(function () {
  mod.shellStore.setState({ confirm: null });
});

describe('the app asks its own questions', function () {
  describe('the answer', function () {
    it('resolves true only when the question was confirmed', async function () {
      const answer = mod.showConfirm({ title: 'Reload?' });
      mod.resolveConfirm(true);
      assert.strictEqual(await answer, true);
    });

    it('treats every other exit as a decline', async function () {
      const answer = mod.showConfirm({ title: 'Reload?' });
      // What the close control, the cancel button and Escape all call.
      mod.resolveConfirm(false);
      assert.strictEqual(await answer, false);
    });

    it('settles a question that a second one replaces', async function () {
      const first = mod.showConfirm({ title: 'First' });
      mod.showConfirm({ title: 'Second' });

      // Not merely "the second one is showing": the first promise must settle,
      // or whoever awaited it waits forever behind a dialog that is gone.
      assert.strictEqual(await first, false, 'a replaced question must not strand its caller');
      assert.strictEqual(mod.shellStore.getSnapshot().confirm.title, 'Second');
    });

    it('is a no-op when nothing was asked', function () {
      assert.doesNotThrow(() => mod.resolveConfirm(true));
    });
  });

  describe('the dialog', function () {
    const render = (request) =>
      mod.renderToStaticMarkup(
        mod.React.createElement(mod.ConfirmDialog, { request, onAnswer: () => {} }),
      );

    it('renders nothing when there is no question', function () {
      assert.strictEqual(render(null), '');
    });

    it('shows the question, the body and both labels', function () {
      const html = render({
        title: 'A new version is available',
        description: 'Reload to update Code Agents Web CLI.',
        confirmLabel: 'Reload',
        cancelLabel: 'Not now',
        resolve: () => {},
      });

      assert.ok(html.includes('A new version is available'));
      assert.ok(html.includes('Reload to update Code Agents Web CLI.'));
      assert.ok(html.includes('Reload'));
      assert.ok(html.includes('Not now'));
      assert.ok(html.includes('role="dialog"'), 'it must be a dialog to assistive tech');
    });

    it('does not pre-arm a destructive answer', function () {
      const danger = render({ title: 'Delete it?', tone: 'danger', resolve: () => {} });
      assert.ok(
        !/autofocus/i.test(danger),
        'a destructive confirm must not be one stray Return away',
      );
      assert.ok(danger.includes('var(--destructive)'), 'and must read as destructive');

      const ordinary = render({ title: 'Reload?', resolve: () => {} });
      assert.ok(/autofocus/i.test(ordinary), 'an ordinary confirm should be ready to accept');
    });
  });

  describe('no native dialogs are left in the page shell', function () {
    it('index.html asks nothing of its own', function () {
      const html = fs.readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8');
      assert.ok(
        !/\bconfirm\s*\(/.test(html),
        'a question asked from inline script can only ever be the browser’s own dialog',
      );
      assert.ok(!/\balert\s*\(/.test(html));
    });
  });
});
