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

/** Renames and tab visibility go over the network; the active tab uses storage. */
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
  const app = {
    joined,
    /** How many times the manager gave up its attachment to a session. */
    left: 0,
    isMobile: false,
    currentClaudeSessionId: null,
    currentClaudeSessionName: null,
    getAlias: () => 'Claude',
    authFetch: (url, init) => global.fetch(url, init),
    joinSession: async (id) => { joined.push(id); app.currentClaudeSessionId = id; },
    // Closing the last conversation's tab has to let go of it: the socket is
    // otherwise still attached to a conversation that has left the screen.
    leaveSession() { app.left += 1; },
    folderBrowser: { show() {} },
    isCreatingNewSession: false,
    // The manager subscribes a chat tab when it learns its surface, and drops
    // the conversation when the tab closes.
    chats: {
      subscribed: [],
      dropped: [],
      // What the pane was told to show before any socket traffic: the session
      // list already knows each conversation's approval mode, and a pane that
      // opened claiming "asks first" over a bypassing one was #134.
      seeded: [],
      // One log across both calls, because the ordering *between* them is the
      // load-bearing part and two independent arrays cannot express it: each
      // pins its own order and neither says which came first.
      calls: [],
      subscribe(id) {
        this.subscribed.push(id);
        this.calls.push(`subscribe:${id}`);
      },
      drop(id) { this.dropped.push(id); },
      ensure(id) {
        const chats = this;
        return {
          seedBypass(value) {
            chats.seeded.push({ id, value });
            chats.calls.push(`seed:${id}=${value}`);
          },
        };
      },
    },
  };
  return app;
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

  /**
   * Closing a conversation takes it off the screen; it does not end it (#127).
   *
   * These are the phase that had to land first, because everything else in the
   * conversation list is built on it: while closing a tab deleted the session,
   * the only way to shorten a strip that grows forever was to destroy something
   * you might want next week.
   */
  it('closes a conversation for the account without deleting it', async function () {
    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/repos/thing', false);
    m.setTabSurface('chat', 'chat');

    m.closeSession('chat');
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(!m.tabs.has('chat'), 'the tab is removed optimistically');
    assert.deepStrictEqual(
      requests.filter((request) => request.init && request.init.method === 'DELETE'),
      [],
      'closing a conversation must not delete it: the list is how it is reached again',
    );
    const patches = requests.filter((request) => request.init && request.init.method === 'PATCH');
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].url.endsWith('/api/sessions/chat/tab'), patches[0].url);
    assert.deepStrictEqual(JSON.parse(patches[0].init.body), { open: false });
    assert.strictEqual(
      stored.get('cc-web-closed-conversations'),
      undefined,
      'visibility belongs to the account, not this browser profile',
    );
  });

  it('still ends a terminal when its tab is closed', function () {
    // Not an oversight. A pty is reached through its tab and nowhere else, so a
    // terminal closed without being ended is a shell holding a working directory
    // open that nothing in the app can ever reach again.
    const { m } = manager();
    m.addTab('term', 'term', 'idle', '/repos/thing', false);

    m.closeSession('term');

    const deletes = requests.filter((request) => request.init && request.init.method === 'DELETE');
    assert.strictEqual(deletes.length, 1);
    assert.ok(deletes[0].url.endsWith('/api/sessions/term'), deletes[0].url);
  });

  it('restores a terminal and focus when the server refuses to delete it', async function () {
    const terminal = { id: 'term', name: 'term', active: false, workingDir: '/repos/thing' };
    respondTo = (_url, init) => init?.method === 'DELETE'
      ? { ok: false, status: 503, json: async () => ({ error: 'session_delete_not_saved' }) }
      : { ok: true, json: async () => ({ sessions: [terminal] }) };
    const { m, app } = manager();
    m.addTab('term', 'term', 'idle', '/repos/thing', false);
    m.activeTabId = 'term';

    const oldError = console.error;
    console.error = () => {};
    try {
      m.closeSession('term');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = oldError;
    }

    assert.ok(m.tabs.has('term'));
    assert.strictEqual(m.activeTabId, 'term');
    assert.deepStrictEqual(app.joined, ['term']);
  });

  it('stops following a closed conversation without ending it', function () {
    const { m, app } = manager();
    m.addTab('chat', 'chat', 'idle', '/repos/thing', false);
    m.setTabSurface('chat', 'chat');

    m.closeSession('chat');

    assert.deepStrictEqual(
      app.chats.dropped,
      ['chat'],
      'nothing is drawing it, so the browser stops receiving its events',
    );
  });

  it('lets go of the last closed conversation, so the next launch is not aimed at it', async function () {
    const { m, app } = manager();
    m.addTab('only', 'only', 'idle', '/repos/thing', false);
    m.setTabSurface('only', 'chat');
    await m.switchToTab('only');
    assert.strictEqual(app.currentClaudeSessionId, 'only');

    m.closeSession('only');

    // `ensureSessionForStart` reads exactly this field to decide where the next
    // runtime goes. Left set, picking an agent from the launcher would have
    // started it inside the conversation just closed.
    assert.strictEqual(app.currentClaudeSessionId, null);
    assert.strictEqual(app.left, 1, 'and the socket is told, so the server detaches too');
  });

  it('takes tab visibility from the account when a new screen loads', async function () {
    let sessions = [
      { id: 'kept', name: 'kept', active: false, workingDir: '/a', surface: 'chat' },
      { id: 'closed', name: 'closed', active: false, workingDir: '/b', surface: 'chat' },
    ];
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH' && JSON.parse(init.body).open === false) {
        sessions = sessions.filter((session) => session.id !== 'closed');
      }
      return { ok: true, json: async () => ({ sessions }) };
    };

    const first = manager();
    await first.m.loadSessions();
    first.m.closeSession('closed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!first.m.tabs.has('closed'));

    // A second manager stands in for another browser or device. It has no state
    // in common with the first except the account-owned server answer.
    const reloaded = manager();
    await reloaded.m.loadSessions();
    assert.deepStrictEqual(
      reloaded.m.getOrderedTabIds(),
      ['kept'],
      'a conversation taken off the screen must not come back by reloading',
    );
  });

  it('reopens a conversation for every screen and keeps it open', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    let open = true;
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH') open = JSON.parse(init.body).open;
      return { ok: true, json: async () => ({ sessions: open ? [chat] : [] }) };
    };

    const first = manager();
    await first.m.loadSessions();
    first.m.closeSession('chat');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(open, false, 'the account now reports the tab closed');

    // What opening it from the conversation list does: make the server state
    // authoritative first, then draw and select the local copy.
    const reopening = manager();
    await reopening.m.reopenSession('chat');
    reopening.m.addTab('chat', 'chat', 'idle', '/a', false);
    assert.ok(reopening.m.tabs.has('chat'));
    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body)),
      [{ open: false }, { open: true }],
    );

    const reloaded = manager();
    await reloaded.m.loadSessions();
    assert.deepStrictEqual(
      reloaded.m.getOrderedTabIds(),
      ['chat'],
      'reopening must outlive the reload too, or it vanishes again',
    );
  });

  it('serializes a close followed immediately by a reopen for the same conversation', async function () {
    let finishClose;
    const closeFinished = new Promise((resolve) => { finishClose = resolve; });
    let open = true;
    respondTo = async (_url, init) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => ({
            sessions: open
              ? [{ id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' }]
              : [],
          }),
        };
      }
      const requestedOpen = JSON.parse(init.body).open;
      if (!requestedOpen) await closeFinished;
      open = requestedOpen;
      return { ok: true, json: async () => ({ success: true, open: requestedOpen }) };
    };

    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');

    m.closeSession('chat');
    const reopened = m.reopenSession('chat');
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body)),
      [{ open: false }],
      'the reopen waits for the earlier close instead of racing it',
    );

    finishClose();
    await reopened;
    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body)),
      [{ open: false }, { open: true }],
      'the final server write matches the final user intent',
    );
  });

  it('does not let an older open response override a newer close from another device', async function () {
    let finishOpen;
    const openResponse = new Promise((resolve) => { finishOpen = resolve; });
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? openResponse
      : { ok: true, json: async () => ({ sessions: [] }) };

    const { m } = manager();
    const reopening = m.reopenSession('chat');
    await Promise.resolve();

    // The server processed this screen's open, then another screen's close.
    // WebSocket ordering is correct, but the older HTTP response is delayed.
    m.applyRemoteOpen({
      id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat',
    });
    m.applyRemoteClose('chat');
    finishOpen({
      ok: true,
      json: async () => ({ success: true, open: true, applied: true }),
    });

    assert.strictEqual(await reopening, false, 'the caller is told not to recreate the tab');
    assert.ok(!m.tabs.has('chat'));
    assert.deepStrictEqual(
      requests.map((request) => request.init?.method ?? 'GET'),
      ['PATCH', 'GET'],
      'the ambiguous cross-transport order is settled from the account snapshot',
    );
  });

  it('trusts a successful empty reconcile over an older open response', async function () {
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? { ok: true, json: async () => ({ success: true, open: true, applied: true }) }
      : { ok: true, json: async () => ({ sessions: [] }) };

    const { m } = manager();

    assert.strictEqual(
      await m.reopenSession('chat'),
      false,
      'a newer close missed over WebSocket still wins through the authoritative list',
    );
    assert.ok(!m.tabs.has('chat'));
  });

  it('restates account state when a notification targets a stale local conversation tab', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? { ok: true, json: async () => ({ success: true, open: true, applied: true }) }
      : { ok: true, json: async () => ({ sessions: [chat] }) };

    const { m, app } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');

    await m.reopenAndSwitch('chat');

    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body)),
      [{ open: true }],
      'a local copy is not mistaken for an account-open tab',
    );
    assert.deepStrictEqual(app.joined, ['chat']);
  });

  it('restores an optimistically closed conversation when the server refuses the close', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, json: async () => ({ sessions: [chat] }) };

    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');

    const oldError = console.error;
    console.error = () => {};
    try {
      m.closeSession('chat');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = oldError;
    }

    assert.ok(m.tabs.has('chat'), 'reconciliation puts back the server-open tab');
    assert.deepStrictEqual(
      requests.map((request) => request.init?.method ?? 'GET'),
      ['PATCH', 'GET'],
    );
  });

  it('keeps stored and resumable conversation navigation working against an old server', async function () {
    // Both navigation paths await reopenSession before they add and select the
    // conversation. During a rolling deployment, the new browser bundle can be
    // served while the old process still answers requests and has no /tab route.
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH') {
        return {
          ok: false,
          status: 404,
          // Express' default missing-route response is HTML, so JSON parsing
          // fails. This distinguishes it from the new route's session 404.
          json: async () => { throw new Error('Unexpected token <'); },
        };
      }
      return { ok: true, json: async () => ({ sessions: [] }) };
    };
    stored.set('cc-web-closed-conversations', JSON.stringify(['chat']));

    const { m, app } = manager();
    await assert.doesNotReject(() => m.reopenSession('chat'));

    // The remainder is the shared seam used by openStoredConversation and
    // resumeConversation after their awaited reopen. It must still be reached.
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');
    await m.switchToTab('chat');

    assert.deepStrictEqual(app.joined, ['chat']);
    assert.strictEqual(
      stored.get('cc-web-closed-conversations'),
      undefined,
      'the explicit reopen clears the old browser-local close too',
    );
  });

  it('does not mistake the new tab endpoint\'s missing-session 404 for an old server', async function () {
    respondTo = () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Session not found' }),
    });

    const { m } = manager();
    await assert.rejects(
      () => m.reopenSession('gone'),
      /could not be reopened/,
      'a real new-server refusal must still stop navigation',
    );
  });

  it('falls back to local closes until the old server restarts', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    let supportsAccountTabs = false;
    let accountOpen = true;
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH') {
        if (!supportsAccountTabs) {
          return {
            ok: false,
            status: 404,
            json: async () => { throw new Error('Unexpected token <'); },
          };
        }
        accountOpen = JSON.parse(init.body).open;
        return { ok: true, json: async () => ({ success: true, open: accountOpen }) };
      }
      return { ok: true, json: async () => ({ sessions: accountOpen ? [chat] : [] }) };
    };

    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');
    m.closeSession('chat');
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(!m.tabs.has('chat'), 'the old server does not immediately resurrect the close');
    assert.deepStrictEqual(
      JSON.parse(stored.get('cc-web-closed-conversations')),
      ['chat'],
      'the old browser-local behaviour is retained only as a rollout fallback',
    );
    assert.deepStrictEqual(
      requests.map((request) => request.init?.method ?? 'GET'),
      ['PATCH'],
      'a missing route is not treated like a refused write and reconciled immediately',
    );

    await m.reconcile();
    assert.ok(!m.tabs.has('chat'), 'an old-server reconnect still respects the local fallback');
    assert.strictEqual(accountOpen, true, 'the unsupported endpoint changed no server state');

    // The process now comes back on the supporting version. Reconciliation
    // retries the tombstone, transfers ownership to the account, and retires it.
    supportsAccountTabs = true;
    await m.reconcile();
    assert.strictEqual(accountOpen, false);
    assert.strictEqual(stored.get('cc-web-closed-conversations'), undefined);

    const otherDevice = manager();
    await otherDevice.m.loadSessions();
    assert.deepStrictEqual(
      otherDevice.m.getOrderedTabIds(),
      [],
      'once the server supports it, the fallback close is visible on every device',
    );
  });

  it('keeps an old-server close hidden while the missing-route response is still in flight', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    let finishPatch;
    const patchResponse = new Promise((resolve) => { finishPatch = resolve; });
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? patchResponse
      : { ok: true, json: async () => ({ sessions: [chat] }) };

    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');
    m.closeSession('chat');

    await m.reconcile();
    assert.ok(!m.tabs.has('chat'), 'a reconnect cannot re-adopt a close awaiting capability detection');

    finishPatch({
      ok: false,
      status: 404,
      json: async () => { throw new Error('Unexpected token <'); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(JSON.parse(stored.get('cc-web-closed-conversations')), ['chat']);
    assert.ok(!m.tabs.has('chat'));
  });

  it('reconciles an open that arrives while this device is still awaiting its earlier close', async function () {
    const chat = { id: 'chat', name: 'chat', active: false, workingDir: '/a', surface: 'chat' };
    let accountOpen = true;
    let finishClose;
    const closeResponse = new Promise((resolve) => { finishClose = resolve; });
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH') {
        accountOpen = false;
        return closeResponse;
      }
      return {
        ok: true,
        json: async () => ({ sessions: accountOpen ? [chat] : [] }),
      };
    };

    const { m } = manager();
    m.addTab('chat', 'chat', 'idle', '/a', false);
    m.setTabSurface('chat', 'chat');
    m.closeSession('chat');
    await Promise.resolve();

    // The server has since processed a later explicit reopen from device B.
    accountOpen = true;
    m.applyRemoteOpen(chat);
    assert.ok(!m.tabs.has('chat'), 'the pending local close is not flashed back prematurely');

    // Device A's older HTTP response arrives last. Its body alone is stale; the
    // ignored newer open forces a list reconciliation after the close settles.
    finishClose({
      ok: true,
      json: async () => ({ success: true, open: false, applied: true }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(m.tabs.has('chat'), 'the server-final reopen is restored on this device too');
    assert.deepStrictEqual(
      requests.map((request) => request.init?.method ?? 'GET'),
      ['PATCH', 'GET'],
    );
  });

  it('migrates only legacy closed tabs that belong to the current account', async function () {
    stored.set('cc-web-closed-conversations', JSON.stringify(['closed', 'another-account']));
    const sessions = [
      { id: 'kept', name: 'kept', active: false, workingDir: '/a', surface: 'chat' },
      { id: 'closed', name: 'closed', active: false, workingDir: '/b', surface: 'chat' },
    ];
    let closedMigrated = false;
    respondTo = (url, init) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => ({ sessions: closedMigrated ? sessions.slice(0, 1) : sessions }),
        };
      }
      if (url.endsWith('/closed/tab')) {
        closedMigrated = true;
        return {
          ok: true,
          json: async () => ({ success: true, open: false, applied: true }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Session not found' }),
      };
    };

    const { m } = manager();
    await m.init();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['kept']);
    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body)),
      [{ open: false, legacy: true }, { open: false, legacy: true }],
      'every legacy ID is probed because account-closed tabs are absent from the list',
    );
    assert.deepStrictEqual(
      JSON.parse(stored.get('cc-web-closed-conversations')),
      ['another-account'],
      'an unknown ID may belong to another account using this browser',
    );
  });

  it('does not let a stale legacy tombstone undo an explicit account reopen', async function () {
    stored.set('cc-web-closed-conversations', JSON.stringify(['chat']));
    const chat = {
      id: 'chat',
      name: 'chat',
      active: false,
      workingDir: '/a',
      surface: 'chat',
    };
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? {
        ok: true,
        json: async () => ({ success: true, open: true, applied: false }),
      }
      : { ok: true, json: async () => ({ sessions: [chat] }) };

    const { m } = manager();
    await m.init();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['chat']);
    assert.deepStrictEqual(JSON.parse(requests[1].init.body), {
      open: false,
      legacy: true,
    });
    assert.strictEqual(
      stored.get('cc-web-closed-conversations'),
      undefined,
      'an owned 2xx retires the stale local value even when it applies no close',
    );
  });

  it('preserves legacy closed tabs when the account session list fails', async function () {
    const legacy = JSON.stringify(['closed', 'another-account']);
    stored.set('cc-web-closed-conversations', legacy);
    respondTo = () => ({ ok: false, status: 500, json: async () => ({ sessions: [] }) });

    const oldError = console.error;
    console.error = () => {};
    try {
      const { m } = manager();
      await m.init();
    } finally {
      console.error = oldError;
    }

    assert.strictEqual(stored.get('cc-web-closed-conversations'), legacy);
    assert.strictEqual(
      requests.filter((request) => request.init?.method === 'PATCH').length,
      0,
      'a failed list cannot establish which legacy IDs belong to this account',
    );
  });

  it('does not let go when another tab takes over, because joining it detaches', async function () {
    const { m, app } = manager();
    m.addTab('a', 'a', 'idle', null, false);
    m.addTab('b', 'b', 'idle', null, false);
    m.setTabSurface('a', 'chat');
    m.setTabSurface('b', 'chat');
    await m.switchToTab('a');
    await m.switchToTab('b');

    m.closeSession('b');

    assert.strictEqual(m.activeTabId, 'a');
    assert.strictEqual(app.left, 0, 'the join onto the fallback is what detaches');
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

  it('tells a restored chat tab its approval mode before it subscribes', async function () {
    // A tab restored on page load used to open claiming "asks first" until the
    // first snapshot came back over the socket, over a conversation the server
    // already knew was bypassing (#134). The list carries the mode; this is
    // where it reaches the pane, and it has to happen before the subscribe or
    // the snapshot could land in front of it.
    respondTo = () => ({
      ok: true,
      json: async () => ({
        sessions: [
          { id: 'yolo', name: 'yolo', active: false, workingDir: '/a', surface: 'chat', bypassPermissions: true },
          { id: 'careful', name: 'careful', active: false, workingDir: '/a', surface: 'chat', bypassPermissions: false },
        ],
      }),
    });

    const { m, app } = manager();
    await m.loadSessions();

    assert.deepStrictEqual(app.chats.seeded, [
      { id: 'yolo', value: true },
      { id: 'careful', value: false },
    ]);
    assert.deepStrictEqual(app.chats.subscribed, ['yolo', 'careful']);
    // The two lists above pin the order *within* each of them and say nothing
    // about the interleaving, which is the invariant that actually matters:
    // move the seed after the subscribe and both would still pass while the
    // snapshot got a clear run at landing first. One log, one assertion.
    assert.deepStrictEqual(app.chats.calls, [
      'seed:yolo=true',
      'subscribe:yolo',
      'seed:careful=false',
      'subscribe:careful',
    ]);
  });

  it('applies a dragged order and keeps a tab that arrived mid-drag', async function () {
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
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('persists a dragged account order while keeping this window on its active tab', async function () {
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? { ok: true, json: async () => ({ success: true, sessionIds: ['b', 'a'] }) }
      : {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'b', name: 'b', active: false, workingDir: '/b', surface: 'chat' },
              { id: 'a', name: 'a', active: false, workingDir: '/a', surface: 'chat' },
            ],
          }),
        };
    const { m } = manager();
    m.addTab('a', 'a', 'idle', null, false);
    m.addTab('b', 'b', 'idle', null, false);
    m.activeTabId = 'a';
    requests.length = 0;

    m.applyOrder(['b', 'a']);

    assert.deepStrictEqual(m.getOrderedTabIds(), ['b', 'a'], 'the drag is optimistic');
    assert.strictEqual(m.activeTabId, 'a', 'order never changes this window\'s selection');
    await new Promise((resolve) => setImmediate(resolve));
    const patches = requests.filter((request) => request.init?.method === 'PATCH');
    assert.strictEqual(patches.length, 1);
    assert.strictEqual(patches[0].url, '/api/sessions/tabs/order');
    assert.deepStrictEqual(JSON.parse(patches[0].init.body), { sessionIds: ['b', 'a'] });

    m.applyRemoteOrder(['a', 'b']);
    assert.deepStrictEqual(m.getOrderedTabIds(), ['a', 'b']);
    assert.strictEqual(m.activeTabId, 'a');
    assert.strictEqual(
      requests.filter((request) => request.init?.method === 'PATCH').length,
      1,
      'a server order is applied without an echo PATCH',
    );
  });

  it('sends rapid drag orders to the server in the order they happened', async function () {
    let finishFirst;
    const firstFinished = new Promise((resolve) => { finishFirst = resolve; });
    let serverOrder = ['a', 'b'];
    respondTo = async (_url, init) => {
      if (!init?.method) {
        return {
          ok: true,
          json: async () => ({
            sessions: serverOrder.map((id) => ({
              id, name: id, active: false, workingDir: `/${id}`, surface: 'chat',
            })),
          }),
        };
      }
      const order = JSON.parse(init.body).sessionIds;
      if (order[0] === 'b') await firstFinished;
      serverOrder = order;
      return { ok: true, json: async () => ({ success: true, sessionIds: order }) };
    };

    const { m } = manager();
    m.addTab('a', 'a', 'idle', null, false);
    m.addTab('b', 'b', 'idle', null, false);
    m.applyOrder(['b', 'a']);
    m.applyOrder(['a', 'b']);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(requests.length, 1, 'the later drag waits behind persistence of the first');
    // The first request's own socket event arrives after the second drag. It is
    // older than the optimistic A,B intent and must not rewind the strip.
    m.applyRemoteOrder(['b', 'a']);
    assert.deepStrictEqual(m.getOrderedTabIds(), ['a', 'b']);
    finishFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(
      requests
        .filter((request) => request.init?.method === 'PATCH')
        .map((request) => JSON.parse(request.init.body).sessionIds),
      [['b', 'a'], ['a', 'b']],
    );
    assert.ok(
      requests.some((request) => !request.init?.method),
      'the drained local queue confirms final order from the authoritative list',
    );
    assert.deepStrictEqual(m.getOrderedTabIds(), ['a', 'b']);
  });

  it('takes list order on first load and after an offline reconnect', async function () {
    let sessions = [
      { id: 'b', name: 'b', active: false, workingDir: '/b', surface: 'chat' },
      { id: 'a', name: 'a', active: false, workingDir: '/a', surface: 'chat' },
    ];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    m.activeTabId = 'b';
    assert.deepStrictEqual(m.getOrderedTabIds(), ['b', 'a']);

    // This screen was offline for a drag on another device. The reconnect list
    // is already server-sorted and changes order, never the local selection.
    sessions = [sessions[1], sessions[0]];
    await m.reconcile();
    assert.deepStrictEqual(m.getOrderedTabIds(), ['a', 'b']);
    assert.strictEqual(m.activeTabId, 'b');
    assert.deepStrictEqual(
      requests.filter((request) => request.init?.method === 'PATCH'),
      [],
      'applying list order never writes it back',
    );
  });

  it('moves a stale local copy to the server append position when it is reopened', async function () {
    let sessions = [
      { id: 'closed', name: 'closed', active: false, workingDir: '/closed', surface: 'chat' },
      { id: 'keep', name: 'keep', active: false, workingDir: '/keep', surface: 'chat' },
    ];
    respondTo = (_url, init) => {
      if (init?.method === 'PATCH') {
        // The server knew `closed` was absent even though this window missed the
        // close event. A genuine reopen appends it to the durable order.
        sessions = [sessions[1], sessions[0]];
        return { ok: true, json: async () => ({ success: true, open: true }) };
      }
      return { ok: true, json: async () => ({ sessions }) };
    };

    const { m } = manager();
    await m.loadSessions();
    m.activeTabId = 'keep';
    assert.deepStrictEqual(m.getOrderedTabIds(), ['closed', 'keep']);

    assert.strictEqual(await m.reopenSession('closed'), true);
    assert.deepStrictEqual(m.getOrderedTabIds(), ['keep', 'closed']);
    assert.strictEqual(m.activeTabId, 'keep', 'reopen order does not steal focus');
  });

  it('restores the existing server position when an idempotently open tab was missed', async function () {
    const sessions = [
      { id: 'missed', name: 'missed', active: false, workingDir: '/missed', surface: 'chat' },
      { id: 'keep', name: 'keep', active: false, workingDir: '/keep', surface: 'chat' },
    ];
    respondTo = (_url, init) => init?.method === 'PATCH'
      ? { ok: true, json: async () => ({ success: true, open: true, applied: true }) }
      : { ok: true, json: async () => ({ sessions }) };

    const { m } = manager();
    // This disconnected screen knows Keep but missed the earlier open/order
    // that placed Missed before it on the account.
    m.addTab('keep', 'keep', 'idle', '/keep', false);
    m.activeTabId = 'keep';

    assert.strictEqual(await m.reopenSession('missed'), true);
    assert.deepStrictEqual(m.getOrderedTabIds(), ['missed', 'keep']);
    assert.strictEqual(m.activeTabId, 'keep');
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
        await m.initialTabId(),
        'b',
        'this window\'s own memory wins over the browser-wide one',
      );
    });

    it('opens on the remembered tab, and on the first one when it is gone', async function () {
      const { m } = manager();
      m.addTab('a', 'a', 'idle', null, false);
      m.addTab('b', 'b', 'idle', null, false);

      stored.set('cc-web-active-tab', 'b');
      assert.strictEqual(await m.initialTabId(), 'b');

      // The remembered session was closed elsewhere, or ended with the server.
      stored.set('cc-web-active-tab', 'ghost');
      assert.strictEqual(await m.initialTabId(), 'a', 'a stale id falls back, it does not blank the app');

      stored.delete('cc-web-active-tab');
      assert.strictEqual(await m.initialTabId(), 'a', 'a first visit behaves as it always did');
    });

    it('reopens a closed notification target on a cold start with no tabs', async function () {
      global.window.location = { href: 'https://webcli.test/?conversation=closed' };
      const replaced = [];
      global.window.history = { replaceState: (_state, _title, url) => replaced.push(url) };
      const chat = {
        id: 'closed',
        name: 'closed',
        active: false,
        workingDir: '/a',
        surface: 'chat',
      };
      let open = false;
      respondTo = (_url, init) => {
        if (init?.method === 'PATCH') open = JSON.parse(init.body).open;
        return { ok: true, json: async () => ({ sessions: open ? [chat] : [] }) };
      };

      const { m } = manager();
      const selected = await m.initialTabId();

      assert.strictEqual(selected, 'closed');
      assert.ok(m.tabs.has('closed'), 'the missing conversation is restored before selection');
      assert.deepStrictEqual(
        requests.map((request) => request.init?.method ?? 'GET'),
        ['PATCH', 'GET'],
      );
      assert.deepStrictEqual(JSON.parse(requests[0].init.body), { open: true });
      assert.deepStrictEqual(replaced, ['/'], 'the cold-start request is consumed once');
    });
  });
});
