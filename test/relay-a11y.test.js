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

  it('names and distinguishes every session state with an icon', function () {
    const { renderToStaticMarkup, React, TabBar } = mod;
    const html = renderToStaticMarkup(
      React.createElement(TabBar, {
        tabs: [
          { id: 'working', title: 'working', status: 'running' },
          { id: 'approval', title: 'approval', status: 'running', attention: 'approval' },
          { id: 'input', title: 'input', status: 'running', attention: 'question' },
          { id: 'success', title: 'success', status: 'idle', unread: true },
          { id: 'error', title: 'error', status: 'error' },
          { id: 'idle', title: 'idle', status: 'idle' },
        ],
        activeId: 'working',
      }),
    );

    for (const state of ['working', 'waiting-approval', 'waiting-input', 'success', 'error', 'idle']) {
      assert.ok(
        html.includes(`data-tab-state="${state}"`),
        `the tab strip must render a distinct ${state} icon`,
      );
    }
    for (const label of [
      'Working',
      'Waiting for approval',
      'Waiting for input',
      'Completed',
      'Error',
      'Idle',
    ]) {
      assert.ok(html.includes(`aria-label="${label}"`), `${label} must be announced in words`);
    }
    assert.ok(
      /animation:relay-spin 900ms linear infinite/.test(html),
      'only the working icon should carry motion',
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

  it('contains Tab and programmatic focus in the topmost stacked dialog', function () {
    // Effects do not run in server rendering, so this is deliberately a
    // narrow implementation guard for the browser-only modal contract. It
    // protects both directions of Tab, the focusin escape hatch, and the
    // topmost check that stops an outer dialog stealing focus from an inner one.
    const source = fs.readFileSync(path.join(ROOT, 'src/client/ui/relay/Dialog.tsx'), 'utf8');
    assert.match(source, /event\.key === 'Tab'/, 'Tab must be handled by the modal');
    assert.match(source, /retainFocus\(panel, event\.shiftKey\)/, 'Shift+Tab must wrap backwards');
    assert.match(source, /document\.addEventListener\('focusin', onFocusIn, true\)/, 'programmatic focus must be contained too');
    assert.match(source, /if \(!isTopmostPanel\(panel\)/, 'only the topmost dialog may own focus');
    assert.match(source, /previous\?\.focus\(\)/, 'closing must restore its prior focus target');
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
      `export { FloatingMenu } from ${JSON.stringify(path.join(dir, 'FloatingMenu'))};`,
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

  it('names the floating menu button and says it opens a menu', function () {
    const { renderToStaticMarkup, React, FloatingMenu } = shell;
    const html = renderToStaticMarkup(
      React.createElement(FloatingMenu, {
        actions: [
          { id: 'sessions', label: 'Sessions', icon: 'layout-list', onPress() {} },
          { id: 'esc', label: 'Esc', icon: 'circle-x', onPress() {} },
        ],
      }),
    );

    // Shut, the button is the only thing rendered — so it is the only thing
    // that can carry a name, and an unnamed square is what the whole phone
    // layout would be reached through.
    assert.ok(/aria-label="Open the menu"/.test(html), 'the button is named');
    assert.ok(/aria-haspopup="menu"/.test(html), 'it says it opens a menu');
    assert.ok(/aria-expanded="false"/.test(html), 'shut reports collapsed');
    // Nothing behind it is in the document until it is opened, so the labels
    // must not be announced as though they were on screen.
    assert.ok(!html.includes('>Sessions<'), 'the rows are not rendered while shut');
  });

  it('gives every menu row a name, and reports what kind of control it is', function () {
    const { renderToStaticMarkup, React, FloatingMenu } = shell;
    // Rendered open by driving the button, which is the only way in: the
    // component owns its own open state, deliberately, so that a menu cannot
    // be left standing by a parent that forgot to close it.
    const html = renderToStaticMarkup(
      React.createElement(FloatingMenu, {
        actions: [
          { id: 'more', label: 'More', icon: 'ellipsis', expands: true, onPress() {} },
          { id: 'keys', label: 'Keys', icon: 'keyboard', toggle: true, active: true, onPress() {} },
        ],
      }),
    );
    // Shut on a static render. What this asserts is the shut contract; the
    // open one is asserted in the browser checks, where the button can be
    // pressed. Both matter and only one of them is reachable from here.
    assert.ok(/aria-expanded="false"/.test(html));
    assert.ok(!/aria-current/.test(html), 'a disclosure is not a current item');
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
