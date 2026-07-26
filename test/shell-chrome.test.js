const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The shell is the whole UI now: one top bar, no side panel, and every dialog,
// sheet and toast mounted from the store. None of that is reachable from a unit
// test of a helper — the helpers are not exported, and the thing that matters is
// what a user ends up looking at. So this renders AppShell for real and asserts
// on the markup.
//
// It replaces test/shell-sidebar-groups.test.js, which tested the runtime
// grouping of a sidebar that no longer exists.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { AppShell } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/AppShell'))};`,
    `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
    `export { DEFAULT_CHAT_VIEW } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/view-settings'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `shell-chrome-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'shell-chrome.tsx' },
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
  DEFAULTS.chatView = mod.DEFAULT_CHAT_VIEW;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
});

const SETTINGS = { fontSize: 14, theme: 'github-dark', terminalFontFamily: 'jetbrains-mono' };

/** Filled in `before`, once the bundle exists. */
const DEFAULTS = {};

/** Every action is a no-op; the assertions are about what renders, not what runs. */
function actions() {
  return new Proxy(
    { readSettings: () => SETTINGS },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => {};
      },
    },
  );
}

function render(state) {
  const { renderToStaticMarkup, React, AppShell, shellStore } = mod;
  shellStore.setState(state);
  // A plain detached node stands in for the adopted terminal; the shell only
  // ever appends to it, and renderToStaticMarkup never runs effects anyway.
  return renderToStaticMarkup(
    React.createElement(AppShell, {
      terminalNode: { nodeType: 1 },
      actions: actions(),
      launcher: null,
    }),
  );
}

function reset(extra) {
  return Object.assign(
    {
      tabs: [],
      activeId: null,
      isMobile: false,
      // Reset explicitly: the store is shared between these tests, so a case
      // that puts a conversation on screen leaves one there for every case
      // after it — which is how the key-strip test started failing for a
      // reason that had nothing to do with the key strip.
      chat: {
        active: false, sessionId: '', controller: null,
        runtime: '', runtimeLabel: '', workingDir: '',
      },
      chatView: DEFAULTS.chatView,
      overlay: null,
      overlayMessage: '',
      errorText: '',
      plan: null,
      toasts: [],
      banner: null,
      sessionList: [],
      paletteOpen: false,
      install: 'unsupported',
      keysVisible: true,
      ctrlLatched: false,
      dialogs: {
        settings: false, newSession: false, terminalOptions: false,
        sessions: false, tabs: false, more: false, rename: null,
      },
      folder: {
        open: false, path: null, parentPath: null, entries: [],
        showHidden: false, loading: false, creating: false,
      },
    },
    extra,
  );
}

function tab(id, over) {
  return Object.assign(
    { id, title: id, status: 'idle', kind: '', workingDir: null, unread: false },
    over,
  );
}

describe('shell chrome', function () {
  it('renders exactly one tab strip and no side panel', function () {
    const html = render(reset({ tabs: [tab('a'), tab('b')], activeId: 'a' }));

    const tablists = html.split('role="tablist"').length - 1;
    assert.strictEqual(tablists, 1, 'there must be exactly one tab strip');

    // ProfileSidebar renders a <nav> with this label; the bottom bar's <nav> is
    // labelled differently, and is not rendered on desktop at all.
    assert.ok(
      !/aria-label="Sessions"[^>]*>\s*<div[^>]*>Local/.test(html),
      'the profile sidebar must not render',
    );
    assert.strictEqual(
      html.split('role="tab"').length - 1,
      2,
      'both sessions should appear as tabs in the strip',
    );
  });

  it('shows the status bar on desktop and the floating menu on mobile', function () {
    const desktop = render(reset({ tabs: [tab('a')], activeId: 'a' }));
    assert.ok(!/aria-haspopup="menu"/.test(desktop), 'no floating menu on desktop');

    // The bottom bar is gone: five slots of permanent chrome along the bottom
    // edge, on a surface whose whole point is what is above it. What replaced
    // it is one square button, and everything the bar held is behind it.
    const mobile = render(reset({ tabs: [tab('a')], activeId: 'a', isMobile: true }));
    assert.ok(!/aria-label="Session controls"/.test(mobile), 'the bottom bar is gone');
    assert.ok(/aria-label="Open the menu"/.test(mobile), 'the floating menu button is there');
    assert.ok(/aria-haspopup="menu"/.test(mobile), 'and says what it opens');
    // Shut, so nothing behind it is announced as being on screen. Scoped to
    // the menu: "Sessions" is also a destination on the bar, where it is
    // supposed to be visible.
    const menu = mobile.slice(mobile.indexOf('aria-haspopup="menu"'));
    assert.ok(!/role="menuitem"/.test(menu), 'its rows are not rendered while shut');
  });

  it('never opens a phone onto a panel, whatever the stored preference says', function () {
    // The rail replaces the conversation on a phone, so a stored `panelOpen`
    // — a desktop preference, where the rail sits *beside* the transcript —
    // would put every conversation behind a panel. It is session state on a
    // phone, held by the shell, and the persisted setting is left alone rather
    // than overwritten, which would close the rail on the desktop that set it.
    const mobile = render(reset({
      tabs: [tab('a')], activeId: 'a', isMobile: true,
      chat: {
        active: true, sessionId: 'a', controller: null,
        runtime: 'claude', runtimeLabel: 'Claude', workingDir: '/tmp',
      },
      chatView: { ...mod.DEFAULT_CHAT_VIEW, panelOpen: true, panelTab: 'files' },
    }));

    // Read off the bar, which says where you are without needing the surface
    // itself mounted: Chat is current, not Files.
    const at = mobile.indexOf('aria-current="page"');
    assert.notStrictEqual(at, -1, 'the bar marks a destination');
    const marked = mobile.slice(at, mobile.indexOf('</button>', at));
    assert.ok(/>Chat</.test(marked), `the marked destination is the conversation, got: ${marked.slice(-80)}`);
  });

  it('swaps the tab strip for the key strip on mobile (issue #21)', function () {
    const mobile = render(reset({ tabs: [tab('a'), tab('b')], activeId: 'a', isMobile: true }));

    // The desktop tab strip does not fit a phone: squeezed tabs are
    // untappable and the row costs vertical space the terminal needs.
    assert.strictEqual(
      mobile.split('role="tablist"').length - 1,
      0,
      'the desktop tab strip must not render on mobile',
    );

    // A phone keyboard has no Escape, arrows, Ctrl or Tab — the strip is the
    // only way to send them, so losing it silently is the failure worth
    // catching.
    assert.ok(/aria-label="Terminal keys"/.test(mobile), 'the key strip renders on mobile');
    assert.ok(/>Esc</.test(mobile), 'the key strip must offer Escape');
    assert.ok(/>Tab</.test(mobile), 'the key strip must offer Tab');
    assert.ok(/>Ctrl</.test(mobile), 'the key strip must offer the Ctrl latch');
    assert.ok(/aria-label="Send Enter"/.test(mobile), 'the key strip must offer Enter');
    assert.ok(
      /aria-label="Show on-screen keyboard"/.test(mobile),
      'summoning the keyboard is an explicit act, never a side effect of a tap',
    );
    for (const arrow of ['Up', 'Down', 'Left', 'Right']) {
      assert.ok(
        mobile.includes(`aria-label="Send ${arrow} arrow"`),
        `the key strip must offer the ${arrow} arrow`,
      );
    }

    // Hidden on purpose: the toggle has to be able to reclaim the room.
    const keysHidden = render(reset({
      tabs: [tab('a')], activeId: 'a', isMobile: true, keysVisible: false,
    }));
    assert.ok(
      !/aria-label="Terminal keys"/.test(keysHidden),
      'keysVisible: false must hide the strip',
    );
  });

  it('switches sessions from a touch sheet, not the strip, on mobile', function () {
    const html = render(reset({
      tabs: [tab('a'), tab('b', { status: 'running', unread: true })],
      activeId: 'a',
      isMobile: true,
      dialogs: {
        settings: false, newSession: false, terminalOptions: false,
        sessions: false, tabs: true, more: false, rename: null,
      },
    }));

    assert.ok(html.includes('aria-current="true"'), 'the active session is marked');
    assert.ok(html.includes('aria-label="Unread output"'), 'unread activity is visible');
    assert.ok(html.includes('aria-label="Close b"'), 'every session can be closed from the sheet');
    assert.ok(html.includes('New session'), 'a new session is one tap away');
    assert.ok(html.includes('All sessions'), 'the server-wide list stays reachable');
  });

  it('renders a running session with the online dot and an idle one without a warning', function () {
    const idle = render(reset({ tabs: [tab('a')], activeId: 'a' }));
    assert.ok(!/var\(--warning\)/.test(idle), 'an idle session must not paint a warning');

    const running = render(reset({ tabs: [tab('a', { status: 'running' })], activeId: 'a' }));
    assert.ok(/var\(--ansi-green\)/.test(running), 'a running session paints the online dot');
  });

  it('mounts the connection overlay over the terminal, not over the tabs', function () {
    const html = render(reset({ tabs: [tab('a')], activeId: 'a', overlay: 'error', errorText: 'boom' }));
    assert.ok(html.includes('boom'), 'the error text should render');
    assert.ok(
      html.indexOf('role="tablist"') < html.indexOf('boom'),
      'the tab strip must still precede the overlay so sessions stay reachable',
    );
  });

  it('shows the runtime-specific line while a runtime is starting', function () {
    // "Starting Grok (auto-approving every tool call)…" is the only place the
    // user is told a session is starting with permissions bypassed. It used to
    // be written into the spinner's <p> by id; when that markup went, the
    // defensive lookup made it silently never appear.
    const specific = render(reset({
      overlay: 'loading',
      overlayMessage: 'Starting Grok (auto-approving every tool call)...',
    }));
    assert.ok(
      specific.includes('auto-approving every tool call'),
      'the runtime start message must reach the overlay',
    );

    const generic = render(reset({ overlay: 'loading', overlayMessage: '' }));
    assert.ok(generic.includes('Connecting'), 'with no message it falls back to the default');
  });

  it('renders plan content as text, never as markup', function () {
    // Plan content is raw terminal output: whatever the agent printed, which
    // includes any file it read. The old modal escaped it and then re-parsed
    // the result as HTML.
    const html = render(reset({ plan: '<img src=x onerror=alert(1)>\n**bold**' }));
    assert.ok(!/<img/.test(html), 'plan content must never reach the DOM as a tag');
    assert.ok(html.includes('&lt;img'), 'it should render escaped instead');
    assert.ok(/<strong[^>]*>bold<\/strong>/.test(html), 'markdown emphasis still formats');
  });

  it('offers install only where installing can actually happen', function () {
    // A button that silently does nothing is worse than no button: the prompt
    // never fires on iOS, and never fires again once the app is installed.
    const none = render(reset({ paletteOpen: true, install: 'unsupported' }));
    assert.ok(!/Install app/.test(none), 'no entry on a browser that cannot install');

    const done = render(reset({ paletteOpen: true, install: 'installed' }));
    assert.ok(!/Install app/.test(done), 'no entry once it is already installed');

    const ready = render(reset({ paletteOpen: true, install: 'available' }));
    assert.ok(/Install app/.test(ready), 'the entry appears once a prompt is in hand');
  });

  it('always shows an install row in settings, and never a dead button', function () {
    const ready = render(reset({ dialogs: {
      settings: true, newSession: false, terminalOptions: false,
      sessions: false, more: false, rename: null,
    }, install: 'available' }));
    assert.ok(/Install app/.test(ready) && />Install</.test(ready), 'an actionable button');

    for (const state of ['installed', 'ios', 'insecure', 'blocked', 'unsupported']) {
      const html = render(reset({ dialogs: {
        settings: true, newSession: false, terminalOptions: false,
        sessions: false, more: false, rename: null,
      }, install: state }));
      assert.ok(/Install app/.test(html), `the row is present when ${state}`);
      assert.ok(
        !/>Install</.test(html),
        `${state} must explain instead of offering a button that cannot work`,
      );
    }
  });

  // Reaching this server at http://192.168.x.x:32352 — the normal way to use it
  // from a second machine — is not a secure context, so no service worker is
  // registered and beforeinstallprompt never fires. The UI reported that as
  // "This browser cannot install the app", which sends the reader off to change
  // browsers over something only the URL can fix.
  it('blames the origin, not the browser, when the page is not a secure context', function () {
    const settings = {
      settings: true, newSession: false, terminalOptions: false,
      sessions: false, more: false, rename: null,
    };
    const html = render(reset({ dialogs: settings, install: 'insecure' }));

    assert.ok(/secure origin/i.test(html), 'says what is actually wrong');
    assert.ok(/HTTPS/.test(html) && /localhost/.test(html), 'names both ways out');
    assert.ok(
      !/cannot install the app/i.test(html),
      'must not claim the browser is incapable when the browser is fine',
    );

    // And on a phone, where this is the common case, the More sheet must still
    // carry the row: an omitted row leaves nowhere to discover the reason.
    const sheet = render(reset({
      isMobile: true,
      dialogs: { ...settings, settings: false, more: true },
      install: 'insecure',
    }));
    assert.ok(/Install app/.test(sheet), 'the More sheet keeps the entry');
  });

  // The https version of the same trap, and a nastier one: the padlock is
  // there, isSecureContext is true, the page renders — and the browser is
  // quietly refusing the service worker because it does not trust the local
  // CA. Reporting that as "not offered" sends the reader looking at the app.
  it('says the certificate is untrusted when the service worker was refused', function () {
    const html = render(reset({
      dialogs: {
        settings: true, newSession: false, terminalOptions: false,
        sessions: false, more: false, rename: null,
      },
      install: 'blocked',
    }));

    assert.ok(/service worker/i.test(html), 'names what the browser refused');
    assert.ok(/ca\.crt/.test(html), 'points at the certificate to install');
    assert.ok(/restart/i.test(html), 'says the running browser will not pick it up on its own');
  });
});
