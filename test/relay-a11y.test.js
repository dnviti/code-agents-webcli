const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Regression guards for accessibility defects that review found in the ported
// components. They are asserted on rendered markup rather than on source text,
// so a rewrite that keeps the behaviour keeps passing.
//
// The tab close button is the one that matters most: hidden with `opacity: 0`
// alone it stayed clickable and focusable, so an invisible control could close
// a user's session.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { TabBar } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/TabBar'))};`,
    `export { Separator } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/Separator'))};`,
    `export { Dialog } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/Dialog'))};`,
    `export { ProfileSidebar } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/ProfileSidebar'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `relay-a11y-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'relay-a11y.tsx' },
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

/** The markup of the close button for a tab that is neither active nor hovered. */
function inactiveTabMarkup() {
  const { renderToStaticMarkup, React, TabBar } = mod;
  return renderToStaticMarkup(
    React.createElement(TabBar, {
      tabs: [{ id: 'a', title: 'one', status: 'idle' }, { id: 'b', title: 'two', status: 'idle' }],
      // 'a' is active, so 'b' is the inactive, unhovered case.
      activeId: 'a',
    }),
  );
}

describe('Relay accessibility guards', function () {
  it('never leaves an invisible tab close button interactive', function () {
    const html = inactiveTabMarkup();

    // Locate every close control and check the inactive one is inert. Server
    // rendering has no hover, so any close button that is not on the active tab
    // is in the hidden state.
    const closes = html.match(/<button[^>]*Close tab[^>]*>|<button[^>]*aria-label="Close tab"[^>]*>/g) || [];
    assert.ok(closes.length >= 2, `expected a close button per tab, found ${closes.length}`);

    const hidden = closes.filter((b) => /tabindex="-1"/.test(b));
    assert.ok(
      hidden.length >= 1,
      'the close button of an inactive tab must be removed from the tab order',
    );

    for (const button of hidden) {
      assert.ok(
        /aria-hidden="true"/.test(button),
        `a hidden close button must be hidden from assistive tech: ${button}`,
      );
    }

    // pointer-events lives in the inline style; opacity alone is what made this
    // clickable in the first place.
    assert.ok(
      /pointer-events:\s*none/.test(html),
      'a hidden close button must not be clickable (pointer-events: none)',
    );
  });

  it('exposes the tab strip as a tablist of tabs', function () {
    const html = inactiveTabMarkup();
    assert.ok(/role="tablist"/.test(html), 'the strip must be a tablist');
    assert.ok(/role="tab"/.test(html), 'each tab must have role=tab');
    assert.ok(
      /aria-selected="true"/.test(html) && /aria-selected="false"/.test(html),
      'aria-selected must track which tab is active, not be constant',
    );
  });

  it('announces a vertical separator as vertical', function () {
    const { renderToStaticMarkup, React, Separator } = mod;
    const vertical = renderToStaticMarkup(React.createElement(Separator, { orientation: 'vertical' }));
    const horizontal = renderToStaticMarkup(React.createElement(Separator, {}));
    // role=separator defaults to horizontal in ARIA, so only the vertical case
    // is actually wrong without the attribute.
    assert.ok(/aria-orientation="vertical"/.test(vertical), 'vertical separator must say so');
    assert.ok(
      !/aria-orientation="vertical"/.test(horizontal),
      'a horizontal separator must not claim to be vertical',
    );
  });

  it('announces the dialog as a modal dialog with a real label target', function () {
    const { renderToStaticMarkup, React, Dialog } = mod;
    const html = renderToStaticMarkup(
      React.createElement(Dialog, { open: true, title: 'Settings', children: 'body' }),
    );
    assert.ok(/role="(dialog|alertdialog)"/.test(html), 'must have a dialog role');
    assert.ok(/aria-modal="true"/.test(html), 'must be aria-modal');

    const labelledBy = html.match(/aria-labelledby="([^"]+)"/);
    if (labelledBy) {
      // A dangling aria-labelledby is worse than none: it names the dialog
      // after an element that does not exist.
      assert.ok(
        new RegExp(`id="${labelledBy[1]}"`).test(html),
        `aria-labelledby points at "${labelledBy[1]}", which is not in the markup`,
      );
    } else {
      assert.ok(/aria-label="/.test(html), 'a dialog must be labelled somehow');
    }
  });

  it('does not render a decorative sidebar + that looks clickable', function () {
    const { renderToStaticMarkup, React, ProfileSidebar } = mod;
    // Without onNew there is no action behind it, so it must not invite a click.
    const html = renderToStaticMarkup(
      React.createElement(ProfileSidebar, {
        groups: [{ label: 'Local', items: [{ id: 'x', label: 'zsh', status: 'online' }] }],
        activeId: 'x',
      }),
    );
    const plus = html.match(/<[^>]*>\+<\/[^>]*>/);
    if (plus) {
      assert.ok(
        !/cursor:\s*pointer/.test(plus[0]),
        `a "+" with no handler must not show a pointer cursor: ${plus[0]}`,
      );
    }
  });
});
