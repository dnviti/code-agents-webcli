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
    `export { Tabs } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/Tabs'))};`,
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

  it('does not offer a New tab button with nothing behind it', function () {
    // Same defect as the sidebar "+": a focusable control announcing itself as
    // "New tab" that does nothing when activated.
    const { renderToStaticMarkup, React, TabBar } = mod;
    const withoutHandler = renderToStaticMarkup(
      React.createElement(TabBar, { tabs: [{ id: 'a', title: 'one' }], activeId: 'a' }),
    );
    assert.ok(
      !/aria-label="New tab"/.test(withoutHandler),
      'no New tab control should render when there is no onNew handler',
    );

    const withHandler = renderToStaticMarkup(
      React.createElement(TabBar, {
        tabs: [{ id: 'a', title: 'one' }], activeId: 'a', onNew() {},
      }),
    );
    assert.ok(
      /aria-label="New tab"/.test(withHandler),
      'the New tab control should render when a handler is supplied',
    );
  });

  it('lets a parent control Tabs with no selection', function () {
    // `value` is typed `string | null`, so null has to mean "controlled, and
    // nothing selected". Treating it as uncontrolled left the component falling
    // back to its own last pick, which a parent could not override.
    const { renderToStaticMarkup, React, Tabs } = mod;
    const tabs = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

    const cleared = renderToStaticMarkup(React.createElement(Tabs, { tabs, value: null }));
    const selected = renderToStaticMarkup(React.createElement(Tabs, { tabs, value: 'b' }));
    const uncontrolled = renderToStaticMarkup(React.createElement(Tabs, { tabs }));

    assert.notStrictEqual(
      cleared,
      uncontrolled,
      'value={null} must not render the same as an uncontrolled Tabs, which selects the first tab',
    );
    assert.notStrictEqual(cleared, selected, 'value={null} must not select a tab');
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

// --------------------------------------------------------------------------
// The surfaces added when the last of the hand-written chrome was converted.
// Same rule as above: asserted on rendered markup, not on source text.
// --------------------------------------------------------------------------

let shell;

describe('shell chrome accessibility', function () {
  before(function () {
    this.timeout(60000);
    const dir = path.join(ROOT, 'src', 'client', 'shell');
    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { MobileBar } from ${JSON.stringify(path.join(dir, 'MobileBar'))};`,
      `export { MoreSheet } from ${JSON.stringify(path.join(dir, 'MoreSheet'))};`,
      `export { Toasts } from ${JSON.stringify(path.join(dir, 'Toasts'))};`,
      `export { TabContextMenu } from ${JSON.stringify(path.join(dir, 'TabContextMenu'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `shell-a11y-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'shell-a11y.tsx' },
      bundle: true,
      outfile: out,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });
    shell = require(out);
    shell.__file = out;
  });

  after(function () {
    if (shell && shell.__file) fs.rmSync(shell.__file, { force: true });
  });

  it('names the mobile bar and every control on it', function () {
    const { renderToStaticMarkup, React, MobileBar } = shell;
    const html = renderToStaticMarkup(
      React.createElement(MobileBar, {
        actions: [
          { id: 'sessions', label: 'Sessions', icon: 'layout-list', onPress() {} },
          { id: 'esc', label: 'Esc', icon: 'circle-x', onPress() {} },
        ],
      }),
    );

    assert.ok(/aria-label="Session controls"/.test(html), 'the bar itself is named');
    // Every button carries visible text, which is its accessible name. An
    // icon-only bar would announce five unnamed buttons.
    assert.ok(html.includes('>Sessions<') && html.includes('>Esc<'));
    // The icons are decoration next to that text, not the name.
    assert.strictEqual(
      html.split('aria-hidden="true"').length - 1 >= 2,
      true,
      'icons are hidden from assistive tech',
    );
  });

  it('announces the More button as opening a panel, not as a current section', function () {
    const { renderToStaticMarkup, React, MobileBar } = shell;
    const closed = renderToStaticMarkup(
      React.createElement(MobileBar, {
        actions: [{ id: 'more', label: 'More', icon: 'ellipsis', expands: true, onPress() {} }],
      }),
    );
    const open = renderToStaticMarkup(
      React.createElement(MobileBar, {
        actions: [{
          id: 'more', label: 'More', icon: 'ellipsis', expands: true, active: true, onPress() {},
        }],
      }),
    );

    assert.ok(/aria-haspopup="dialog"/.test(closed));
    assert.ok(/aria-expanded="false"/.test(closed), 'closed sheet reports collapsed');
    assert.ok(/aria-expanded="true"/.test(open), 'open sheet reports expanded');
    // aria-current means "current item in a set" — wrong for a button that
    // opens a sheet, and it was what this reported before.
    assert.ok(!/aria-current/.test(open), 'a disclosure is not a current item');
  });

  it('renders the bottom sheet as a real modal dialog', function () {
    const { renderToStaticMarkup, React, MoreSheet } = shell;
    const html = renderToStaticMarkup(
      React.createElement(MoreSheet, {
        open: true,
        theme: 'dark',
        logoutUrl: null,
        canCloseSession: true,
        canInstall: false,
        onInstall() {}, onClose() {}, onReconnect() {}, onClearTerminal() {},
        onSwitchMode() {}, onCloseSession() {}, onOpenSettings() {}, onToggleTheme() {},
      }),
    );

    assert.ok(/role="dialog"/.test(html) && /aria-modal="true"/.test(html));
    assert.ok(/aria-labelledby="/.test(html), 'the sheet points at its own title');
    assert.ok(html.includes('>More<'), 'and that title exists');
  });

  it('gives the tab menu a name and keyboard-reachable items', function () {
    const { renderToStaticMarkup, React, TabContextMenu } = shell;
    const html = renderToStaticMarkup(
      React.createElement(TabContextMenu, {
        x: 10,
        y: 10,
        items: [
          { label: 'Rename', onSelect() {} },
          { label: 'Close others', onSelect() {}, disabled: true },
        ],
        onClose() {},
      }),
    );

    assert.ok(/role="menu"/.test(html) && /aria-label="Session actions"/.test(html));
    assert.strictEqual(html.split('role="menuitem"').length - 1, 2);
    // Real <button>s, so they are in the tab order and Enter/Space work without
    // the component reimplementing either. contextmenu is not mouse-only —
    // Shift+F10 fires it — so an unreachable menu is a real trap.
    assert.ok(/<button[^>]*role="menuitem"/.test(html));
    assert.ok(/disabled=""/.test(html), 'an unavailable item is disabled, not merely dimmed');
  });

  it('announces an error toast assertively and a confirmation politely', function () {
    const { renderToStaticMarkup, React, Toasts } = shell;
    const html = renderToStaticMarkup(
      React.createElement(Toasts, {
        isMobile: false,
        onDismiss() {},
        toasts: [
          { id: 1, message: 'saved', variant: 'info' },
          { id: 2, message: 'upload failed', variant: 'error' },
        ],
      }),
    );

    // An error needs acting on now; a confirmation must not cut a screen reader
    // off mid-sentence.
    assert.ok(/role="alert"[^>]*aria-live="assertive"/.test(html));
    assert.ok(/role="status"[^>]*aria-live="polite"/.test(html));
    assert.ok(/aria-label="Dismiss"/.test(html), 'the close control is named');
  });
});
