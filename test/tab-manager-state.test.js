const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// SessionTabManager used to keep part of its state in the DOM: `tabs` was
// `Map<string, HTMLElement>`, a tab's label was its `.tab-name` textContent, and
// "this session produced output while you were away" was a CSS class on the
// status dot. All of that is plain state now and rendered by the React strip.
//
// The browser stubs live inside the describe on purpose: a `before` at the top
// level of a mocha file is a ROOT hook and runs before every suite in the whole
// run, so a fake `window` declared there leaks into every other test file.
//
// That move is invisible to every other test — the strip renders from a store
// snapshot, so a manager that quietly stopped tracking unread would still
// produce perfectly valid markup, just always with the dot off. These assert the
// state transitions directly.

const ROOT = path.join(__dirname, '..');

let mod;

const STUBBED = ['window', 'document', 'navigator', 'fetch', 'localStorage', 'sessionStorage'];

/** Renames and the remembered tab both go out over the network / to storage. */
let requests;
let respondTo;
/** The browser-wide store, and this window's own. */
let stored;
let perWindow;
const originals = {};

function installStubs() {
  global.window = { innerWidth: 1280 };
  global.document = { addEventListener() {}, visibilityState: 'visible', title: 'test' };
  global.navigator = { maxTouchPoints: 0, userAgent: 'node' };
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return respondTo(url, init);
  };
  global.localStorage = storage(stored);
  global.sessionStorage = storage(perWindow);
}

function storage(map) {
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** The narrowest App the manager actually reaches for. */
function fakeApp() {
  const joined = [];
  return {
    joined,
    isMobile: false,
    currentClaudeSessionId: null,
    getAlias: () => 'Claude',
    joinSession: async (id) => { joined.push(id); },
    folderBrowser: { show() {} },
    isCreatingNewSession: false,
    // The manager subscribes a chat tab when it learns its surface, and drops
    // the conversation when the tab closes.
    chats: {
      subscribed: [],
      dropped: [],
      subscribe(id) { this.subscribed.push(id); },
      drop(id) { this.dropped.push(id); },
    },
  };
}

function manager() {
  const app = fakeApp();
  const m = new mod.SessionTabManager(app);
  return { m, app };
}

/** What the React strip would render for a session. */
function shellTab(id) {
  return mod.shellStore.getSnapshot().tabs.find((t) => t.id === id);
}

describe('session tab state', function () {
  before(function () {
    this.timeout(60000);

    // The manager touches browser globals at construction (notification
    // permission, a keydown listener). Stubs, not jsdom: the surface used is four
    // properties wide and a real DOM would only hide which ones they are.
    //
    // Saved rather than deleted afterwards: `fetch` is a real Node global, and
    // `delete global.fetch` removes it for the rest of the run — which is how
    // this file first took the whole update-routes suite down with it.
    for (const name of STUBBED) originals[name] = global[name];

    requests = [];
    respondTo = () => ({ ok: true, json: async () => ({ sessions: [] }) });
    stored = new Map();
    perWindow = new Map();
    installStubs();

    const contents = [
      `export { SessionTabManager } from ${JSON.stringify(path.join(ROOT, 'src/client/sessions/tab-manager'))};`,
      `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `tab-manager-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'tab-manager.ts' },
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
    // Mocha runs every file in one process, so leaving a fake `window` behind
    // would tell React and anything else loaded later that this is a browser.
    for (const name of STUBBED) {
      if (originals[name] === undefined) delete global[name];
      else global[name] = originals[name];
    }
  });

  // Re-stubbed per test, not just once: another suite in this run deletes
  // `document`, `navigator` and `localStorage` in a ROOT afterEach, which runs
  // after every test in the whole process — including these.
  beforeEach(function () {
    requests = [];
    stored.clear();
    perWindow.clear();
    respondTo = () => ({ ok: true, json: async () => ({ sessions: [] }) });
    installStubs();
  });

  it('keeps the label out of the DOM and renames in place', function () {
    const { m } = manager();
    m.addTab('s1', 'my-session', 'idle', '/repos/thing', false);
    assert.strictEqual(shellTab('s1').title, 'my-session');

    m.renameTab('s1', '  renamed  ');
    assert.strictEqual(shellTab('s1').title, 'renamed', 'rename trims and persists');

    m.renameTab('s1', '   ');
    assert.strictEqual(shellTab('s1').title, 'renamed', 'a blank name is refused, not applied');
  });

  it('falls back to the folder name when the session name is the generated one', function () {
    const { m } = manager();
    m.addTab('s1', 'Session 7/23/2026, 10:26:39 AM', 'idle', '/home/me/repos/thing', false);
    assert.strictEqual(
      shellTab('s1').title,
      'thing',
      'a default "Session <date>" name shows the working directory instead',
    );
  });

  it('raises unread when a background session goes quiet, and clears it on switch', async function () {
    const { m } = manager();
    m.addTab('active', 'active', 'idle', null, false);
    m.addTab('bg', 'bg', 'idle', null, false);
    m.activeTabId = 'active';

    // Output arrives in the background session, then it settles.
    m.updateTabStatus('bg', 'active');
    assert.strictEqual(shellTab('bg').status, 'running');
    assert.strictEqual(shellTab('bg').unread, false, 'a session still working is not unread');

    m.updateTabStatus('bg', 'idle');
    assert.strictEqual(
      shellTab('bg').unread,
      true,
      'a background session that worked and went quiet is unread',
    );

    await m.switchToTab('bg');
    assert.strictEqual(shellTab('bg').unread, false, 'switching to it clears unread');
  });

  it('does not mark the session you are looking at as unread', function () {
    const { m } = manager();
    m.addTab('s1', 's1', 'idle', null, false);
    m.activeTabId = 's1';

    m.updateTabStatus('s1', 'active');
    m.updateTabStatus('s1', 'idle');
    assert.strictEqual(
      shellTab('s1').unread,
      false,
      'output in the foreground session is not something you missed',
    );
  });

  it('picks the most recently visited surviving tab when the active one closes', async function () {
    const { m } = manager();
    m.addTab('a', 'a', 'idle', null, false);
    m.addTab('b', 'b', 'idle', null, false);
    m.addTab('c', 'c', 'idle', null, false);

    await m.switchToTab('a');
    await m.switchToTab('b');
    await m.switchToTab('c');

    m.closeSession('c', { skipServerRequest: true });
    assert.strictEqual(m.activeTabId, 'b', 'history decides the fallback, not list order');
    assert.ok(!m.tabs.has('c'), 'the closed session is gone');
  });

  it('leaves no active tab and an empty strip when the last one closes', function () {
    const { m } = manager();
    m.addTab('only', 'only', 'idle', null, false);
    m.activeTabId = 'only';

    m.closeSession('only', { skipServerRequest: true });
    assert.strictEqual(m.activeTabId, null);
    assert.deepStrictEqual(mod.shellStore.getSnapshot().tabs, [], 'the strip empties');
  });

  it('takes the conversation off screen when its tab is closed', function () {
    const { m } = manager();
    m.addTab('s1', 'One', 'idle', '/tmp/one', false);
    m.setTabSurface('s1', 'chat');

    // What the shell would be showing for that tab.
    mod.shellStore.setState({
      chat: {
        active: true,
        sessionId: 's1',
        controller: {},
        runtime: 'claude',
        runtimeLabel: 'Claude',
        workingDir: '/tmp/one',
        bypassPermissions: false,
      },
    });

    m.closeSession('s1', { skipServerRequest: true });

    // The surface used to be replaced only by *joining* something else, so
    // closing the last tab left a dead conversation on screen with a composer
    // that could not send anything.
    const chat = mod.shellStore.getSnapshot().chat;
    assert.strictEqual(chat.active, false);
    assert.strictEqual(chat.sessionId, '');
    assert.strictEqual(chat.controller, null);
  });

  it('leaves another conversation on screen when a different tab closes', function () {
    const { m } = manager();
    m.addTab('keep', 'Keep', 'idle', '/tmp/keep', false);
    m.addTab('go', 'Go', 'idle', '/tmp/go', false);
    mod.shellStore.setState({
      chat: {
        active: true,
        sessionId: 'keep',
        controller: {},
        runtime: 'claude',
        runtimeLabel: 'Claude',
        workingDir: '/tmp/keep',
        bypassPermissions: false,
      },
    });

    m.closeSession('go', { skipServerRequest: true });

    assert.strictEqual(mod.shellStore.getSnapshot().chat.sessionId, 'keep');
  });

  it('subscribes to a session once it learns the session is a chat', function () {
    const { m, app } = manager();
    m.addTab('s1', 'One', 'idle', '/tmp/one', false);

    m.setTabSurface('s1', 'chat');
    m.setTabSurface('s1', 'chat');

    // Idempotent: the same fact arrives from the session list, from
    // session_joined and from chat_started.
    assert.deepStrictEqual(app.chats.subscribed, ['s1']);
    assert.strictEqual(shellTab('s1').surface, 'chat');
  });

  it('applies a dragged order and keeps a tab that arrived mid-drag', function () {
    const { m } = manager();
    m.addTab('a', 'a', 'idle', null, false);
    m.addTab('b', 'b', 'idle', null, false);

    m.applyOrder(['b', 'a']);
    assert.deepStrictEqual(m.getOrderedTabIds(), ['b', 'a']);

    // The strip started the drag before 'c' existed, so its order predates it.
    m.addTab('c', 'c', 'idle', null, false);
    m.applyOrder(['a', 'b']);
    assert.deepStrictEqual(
      m.getOrderedTabIds(),
      ['a', 'b', 'c'],
      'a session missing from the dragged order is appended, never dropped',
    );

    m.applyOrder(['a', 'ghost', 'b', 'c']);
    assert.deepStrictEqual(
      m.getOrderedTabIds(),
      ['a', 'b', 'c'],
      'an id for a session that no longer exists is ignored',
    );
  });

  // A rename that only lives in the page that typed it is the bug in #54: the
  // name is gone on the next reload, and a second window never hears about it.
  describe('renaming outlives the page', function () {
    it('tells the server, without waiting for it to answer', function () {
      const { m } = manager();
      m.addTab('s1', 'One', 'idle', '/repos/one', false);

      m.renameTab('s1', '  the good one  ');

      assert.strictEqual(shellTab('s1').title, 'the good one', 'the label moves immediately');
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].url, '/api/sessions/s1/name');
      assert.strictEqual(requests[0].init.method, 'PATCH');
      assert.deepStrictEqual(JSON.parse(requests[0].init.body), { name: 'the good one' });
    });

    it('settles on the name the server actually stored', async function () {
      const { m } = manager();
      m.addTab('s1', 'One', 'idle', null, false);

      // The server caps a very long name. A strip still showing the uncapped
      // one would disagree with every other window the user has open.
      respondTo = () => ({ ok: true, json: async () => ({ success: true, name: 'x'.repeat(200) }) });
      m.renameTab('s1', 'x'.repeat(5000));
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(shellTab('s1').title.length, 200);
    });

    it('does not ask the server to store a blank name', function () {
      const { m } = manager();
      m.addTab('s1', 'One', 'idle', null, false);

      m.renameTab('s1', '   ');

      assert.strictEqual(shellTab('s1').title, 'One');
      assert.strictEqual(requests.length, 0, 'a name that is only whitespace never leaves the page');
    });

    it('puts the old label back when the server refuses', async function () {
      const { m } = manager();
      m.addTab('s1', 'Session 7/23/2026, 10:26:39 AM', 'idle', '/repos/thing', false);
      assert.strictEqual(shellTab('s1').title, 'thing');

      respondTo = () => ({ ok: false, status: 404, json: async () => ({}) });
      m.renameTab('s1', 'gone');
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(
        shellTab('s1').title,
        'thing',
        'a name the server would not store is not left on the strip',
      );
    });

    it('keeps the new label when the request never gets out', async function () {
      const { m } = manager();
      m.addTab('s1', 'One', 'idle', null, false);

      respondTo = () => { throw new Error('offline'); };
      m.renameTab('s1', 'still mine');
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(shellTab('s1').title, 'still mine');
    });

    it('takes a rename that happened in another window', function () {
      const { m } = manager();
      m.addTab('s1', 'One', 'idle', null, false);

      m.applyRemoteName('s1', '  from next door  ');

      assert.strictEqual(shellTab('s1').title, 'from next door');
      assert.strictEqual(requests.length, 0, 'hearing about a rename does not echo it back');

      m.applyRemoteName('unknown', 'nobody');
      m.applyRemoteName('s1', '   ');
      assert.strictEqual(shellTab('s1').title, 'from next door');
    });

    it('shows the stored name for a session that was renamed before this page loaded', function () {
      const { m } = manager();
      // What `/api/sessions/list` reports for a renamed session: the created
      // name it still has, plus the name the user gave it.
      m.addTab('s1', 'Session 7/23/2026, 10:26:39 AM', 'idle', '/repos/thing', false, 'the good one');

      assert.strictEqual(
        shellTab('s1').title,
        'the good one',
        'a chosen name is not run through the generated-name rules',
      );

      const { m: m2 } = manager();
      m2.addTab('s2', 'Session 7/23/2026, 10:26:39 AM', 'idle', '/repos/thing', false);
      assert.strictEqual(
        m2.tabs.get('s2').customName,
        undefined,
        'a session nobody renamed carries no chosen name',
      );
    });
  });

  describe('the selected tab outlives the page', function () {
    it('remembers the tab that was switched to', async function () {
      const { m } = manager();
      m.addTab('a', 'a', 'idle', null, false);
      m.addTab('b', 'b', 'idle', null, false);

      await m.switchToTab('b');

      assert.strictEqual(perWindow.get('cc-web-active-tab'), 'b', 'this window remembers it');
      assert.strictEqual(stored.get('cc-web-active-tab'), 'b', 'and so does the browser, for the next new window');
    });

    it('does not let a second window drag this one off its tab', async function () {
      const { m } = manager();
      m.addTab('a', 'a', 'idle', null, false);
      m.addTab('b', 'b', 'idle', null, false);
      await m.switchToTab('b');

      // Another window of the same browser: its own sessionStorage, the same
      // localStorage. It settles on 'a', which must not move this window.
      stored.set('cc-web-active-tab', 'a');

      assert.strictEqual(
        m.initialTabId(),
        'b',
        'this window\'s own memory wins over the browser-wide one',
      );
    });

    it('opens on the remembered tab, and on the first one when it is gone', function () {
      const { m } = manager();
      m.addTab('a', 'a', 'idle', null, false);
      m.addTab('b', 'b', 'idle', null, false);

      stored.set('cc-web-active-tab', 'b');
      assert.strictEqual(m.initialTabId(), 'b');

      // The remembered session was closed elsewhere, or ended with the server.
      stored.set('cc-web-active-tab', 'ghost');
      assert.strictEqual(m.initialTabId(), 'a', 'a stale id falls back, it does not blank the app');

      stored.delete('cc-web-active-tab');
      assert.strictEqual(m.initialTabId(), 'a', 'a first visit behaves as it always did');
    });
  });
});
