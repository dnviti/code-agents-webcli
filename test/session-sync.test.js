const assert = require('assert');
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');

// The set of tabs a person has open is a fact about the person, not about the
// window they happen to be looking at (#163).
//
// Everything about a session used to be routed through the session: created for
// the socket that asked, deleted down `session.connections`, output sent to
// whoever was driving. None of those reach a second device that merely has the
// tab, so two screens on the same account drifted apart within a minute and only
// a reload put them back together. These check both halves of the repair — the
// server announcing to the person, and the strip acting on it.

const USER = { id: 7, githubId: '1', githubLogin: 'tester', githubName: null, avatarUrl: null, email: null };
const OTHER = { id: 8, githubId: '2', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

let sessions;
let sockets;
let server;
let base;
let currentUser;
let destroyed;

function record(id, over = {}) {
  const session = {
    id,
    ownerUserId: 7,
    name: `Session ${id}`,
    created: new Date('2026-07-01T10:00:00Z'),
    lastActivity: new Date('2026-07-01T10:00:00Z'),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/projects/alpha',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
  // Assigned rather than spread, because the real `createSessionRecord` is
  // handed a params object whose optional fields are present-and-undefined, and
  // a spread would overwrite the defaults above with them.
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) session[key] = value;
  }
  return session;
}

/** A socket that records what it was sent. `readyState` 1 is OPEN. */
function socket(id, userId, over = {}) {
  const sent = [];
  const info = {
    id,
    userId,
    githubLogin: 'tester',
    claudeSessionId: null,
    chatSessionIds: new Set(),
    created: new Date(),
    sent,
    ws: {
      readyState: over.readyState ?? 1,
      send: (payload) => sent.push(JSON.parse(payload)),
    },
  };
  if (over.claudeSessionId) info.claudeSessionId = over.claudeSessionId;
  return info;
}

function typed(info, type) {
  return info.sent.filter((message) => message.type === type);
}

describe('telling every screen what happened to a session', function () {
  before(async function () {
    this.timeout(30000);

    sessions = new Map();
    sockets = new Map();
    currentUser = USER;
    destroyed = [];

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: 'a' };
      next();
    });
    app.use(
      createSessionRoutes({
        claudeSessions: sessions,
        webSocketConnections: sockets,
        baseFolder: '/projects',
        dev: false,
        validatePath: (target) => ({ valid: true, path: target }),
        createSessionRecord: (params) => record(params.id, params),
        getRuntimeBridge: () => null,
        saveSessionsToDisk: async () => {},
        transcriptStore: {
          ensureTranscript: async () => {},
          deleteTranscript: async () => {},
        },
        historyStore: { deleteHistory: async () => {} },
        getScreenSnapshot: () => [],
        disposeRecorder: (id) => destroyed.push(id),
        getSelectedWorkingDir: () => null,
        sessionStore: { getSessionMetadata: async () => ({}) },
      }),
    );

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(function () {
    if (server) server.close();
  });

  beforeEach(function () {
    sessions.clear();
    sockets.clear();
    destroyed = [];
    currentUser = USER;
  });

  async function create(body) {
    const response = await fetch(`${base}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function remove(id) {
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('announces a new session to every one of this user\'s screens, and nobody else\'s', async function () {
    const asking = socket('w1', USER.id);
    const phone = socket('w2', USER.id);
    const shut = socket('w3', USER.id, { readyState: 3 });
    const stranger = socket('w4', OTHER.id);
    for (const info of [asking, phone, shut, stranger]) sockets.set(info.id, info);

    const result = await create({ name: 'a new one', workingDir: '/projects/alpha' });
    assert.strictEqual(result.status, 200);

    const announced = typed(phone, 'session_opened');
    assert.strictEqual(announced.length, 1, 'a second device learns of it without reloading');
    assert.deepStrictEqual(announced[0], {
      type: 'session_opened',
      sessionId: result.body.sessionId,
      name: 'a new one',
      customName: null,
      workingDir: '/projects/alpha',
      surface: 'terminal',
      active: false,
      bypassPermissions: false,
    });
    assert.strictEqual(
      typed(asking, 'session_opened').length,
      1,
      'the screen that asked hears it too, and folds it into the tab it already made',
    );
    assert.deepStrictEqual(shut.sent, [], 'a socket that is not open is skipped');
    assert.deepStrictEqual(stranger.sent, [], 'another user hears nothing about this session');
  });

  it('says nothing about a shell opened inside a conversation', async function () {
    // It is a real session, but it is reached through its conversation and only
    // there — which is why the listing leaves it out too. Announcing it would
    // put a top-level tab in front of every screen for something that can never
    // be one.
    sessions.set('chat', record('chat', { surface: 'chat' }));
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);

    const result = await create({ workingDir: '/projects/alpha', ownerSessionId: 'chat' });

    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(typed(phone, 'session_opened'), []);
  });

  it('announces a delete to a screen that has the tab but was never attached', async function () {
    // The old delete went down `session.connections`, which holds the sockets
    // *driving* the session. A second device with the tab in its strip and its
    // eyes on another one is not in there, so it went on offering a session that
    // had ceased to exist.
    sessions.set('s1', record('s1', { connections: new Set(['w1']) }));
    const driving = socket('w1', USER.id, { claudeSessionId: 's1' });
    const elsewhere = socket('w2', USER.id, { claudeSessionId: 's2' });
    const stranger = socket('w3', OTHER.id);
    for (const info of [driving, elsewhere, stranger]) sockets.set(info.id, info);

    assert.strictEqual((await remove('s1')).status, 200);

    const expected = {
      type: 'session_deleted',
      sessionId: 's1',
      message: 'Session has been deleted',
    };
    assert.deepStrictEqual(typed(driving, 'session_deleted'), [expected]);
    assert.deepStrictEqual(typed(elsewhere, 'session_deleted'), [expected]);
    assert.deepStrictEqual(stranger.sent, [], 'another user hears nothing');
    assert.deepStrictEqual(destroyed, ['s1'], 'the session really is torn down');
  });

  it('lets go of the session only on the sockets that were driving it', async function () {
    // Clearing the field on a screen that merely had a tab would tell it to let
    // go of the session it is actually on.
    sessions.set('s1', record('s1', { connections: new Set(['w1']) }));
    const driving = socket('w1', USER.id, { claudeSessionId: 's1' });
    const elsewhere = socket('w2', USER.id, { claudeSessionId: 's2' });
    for (const info of [driving, elsewhere]) sockets.set(info.id, info);

    await remove('s1');

    assert.strictEqual(driving.claudeSessionId, null);
    assert.strictEqual(
      elsewhere.claudeSessionId,
      's2',
      'a screen watching a different session keeps watching it',
    );
  });

  it('announces the conversation\'s own shells as they are torn down with it', async function () {
    sessions.set('chat', record('chat', { surface: 'chat' }));
    sessions.set('shell', record('shell', { ownerSessionId: 'chat' }));
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);

    await remove('chat');

    const gone = typed(phone, 'session_deleted').map((message) => message.sessionId).sort();
    assert.deepStrictEqual(
      gone,
      ['chat', 'shell'],
      'a shell that is going really is going, even though it was never a tab',
    );
    assert.deepStrictEqual(destroyed.sort(), ['chat', 'shell']);
  });
});

// ---------------------------------------------------------------------------
// The socket half
// ---------------------------------------------------------------------------

const { MessageProcessor } = require('../dist/server/websocket/messages.js');

/**
 * A processor wired to fake sockets and one fake runtime.
 *
 * The bridge hands back the callbacks it was given rather than spawning
 * anything, so a test can say "now it printed" and "now it exited" and watch
 * what the other screens are told.
 */
function processorWith(infos, records) {
  const connections = new Map(infos.map((info) => [info.id, info]));
  const claudeSessions = new Map(records.map((entry) => [entry.id, entry]));
  const bridge = { started: null, stopped: [] };

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions,
    webSocketConnections: connections,
    baseFolder: '/projects',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude', codex: 'Codex', agent: 'Cursor' },
    validatePath: (target) => ({ valid: true, path: target || '/projects' }),
    getSelectedWorkingDir: () => '/projects',
    createSessionRecord: (params) => record(params.id, params),
    getRuntimeBridge: () => ({
      startSession: async (_id, options) => {
        bridge.started = options;
        return { runtimeLabel: 'Terminal', terminalMode: 'shell', shell: '/bin/sh' };
      },
      stopSession: async (id) => { bridge.stopped.push(id); },
      sendInput: async () => {},
      resize: async () => {},
    }),
    saveSessionsToDisk: async () => {},
    resolveRuntimeProfile: () => null,
    historyStore: {
      append() {},
      stat: async () => ({ firstLine: 0, totalLines: 0 }),
      read: async () => ({ firstLine: 0, totalLines: 0, fromLine: 0, lines: [] }),
      deleteHistory: async () => {},
    },
    transcriptStore: {
      ensureTranscript: async () => '/tmp/t.md',
      appendOutput() {},
      readTranscriptChunks: async () => [],
      deleteTranscript: async () => {},
    },
    usageReader: {
      getCurrentSessionStats: async () => null,
      calculateBurnRate: async () => null,
      detectOverlappingSessions: async () => [],
      getUsageStats: async () => null,
    },
    usageAnalytics: { startSession() {}, addUsageData() {}, getAnalytics: () => ({}) },
  });

  return { processor, bridge, claudeSessions };
}

describe('announcing a session over the socket that made it', function () {
  it('tells the other screens about a session created on this one', async function () {
    const asking = socket('w1', USER.id);
    const phone = socket('w2', USER.id);
    const stranger = socket('w3', OTHER.id);
    const { processor, claudeSessions } = processorWith([asking, phone, stranger], []);

    await processor.createAndJoinSession('w1', 'from the socket', '/projects/alpha');

    const id = Array.from(claudeSessions.keys())[0];
    assert.deepStrictEqual(
      typed(phone, 'session_opened').map((message) => message.sessionId),
      [id],
    );
    assert.deepStrictEqual(
      asking.sent.map((message) => message.type),
      ['session_created', 'session_opened'],
      'the socket that asked is switched to it first, then hears the announcement',
    );
    assert.deepStrictEqual(stranger.sent, []);
  });

  it('names the session a join could not find, rather than reporting a bare error', async function () {
    // An `error` carries no session id, so the page could only attribute it to
    // the session it was still on — painting a healthy tab red for a click on a
    // dead one, and leaving the dead tab there to do it again.
    const mine = socket('w1', USER.id, { claudeSessionId: 'healthy' });
    const { processor } = processorWith([mine], [record('healthy')]);

    await processor.joinSession('w1', 'long-gone');

    assert.deepStrictEqual(mine.sent, [
      { type: 'session_gone', sessionId: 'long-gone', message: 'This session no longer exists.' },
    ]);
    assert.strictEqual(mine.claudeSessionId, 'healthy', 'and the socket stays where it was');
  });

  it('answers the same way for somebody else\'s session', async function () {
    // As far as this user is concerned there is no such session, and saying
    // anything more would be telling them one exists.
    const mine = socket('w1', USER.id);
    const theirs = record('theirs', { ownerUserId: OTHER.id });
    const { processor } = processorWith([mine], [theirs]);

    await processor.joinSession('w1', 'theirs');

    assert.deepStrictEqual(mine.sent.map((message) => message.type), ['session_gone']);
  });

  it('lights the tab on every screen when a runtime starts, and puts it out when it exits', async function () {
    const driving = socket('w1', USER.id, { claudeSessionId: 's1' });
    const phone = socket('w2', USER.id);
    const session = record('s1', { connections: new Set(['w1']) });
    const { processor, bridge } = processorWith([driving, phone], [session]);

    await processor.startRuntime('w1', 'terminal', {});

    assert.deepStrictEqual(
      typed(phone, 'session_activity'),
      [{ type: 'session_activity', sessionId: 's1', active: true }],
      'a run that prints nothing for its first ninety seconds is still a run',
    );

    bridge.started.onExit(0, null);

    assert.deepStrictEqual(
      typed(phone, 'session_activity').map((message) => message.active),
      [true, false],
    );
  });

  it('does not turn a stream of output into a stream of announcements', async function () {
    const driving = socket('w1', USER.id, { claudeSessionId: 's1' });
    const phone = socket('w2', USER.id);
    const session = record('s1', { connections: new Set(['w1']) });
    const { processor, bridge } = processorWith([driving, phone], [session]);

    await processor.startRuntime('w1', 'terminal', {});
    for (let i = 0; i < 500; i++) bridge.started.onOutput(`line ${i}\n`);

    assert.strictEqual(
      typed(phone, 'session_activity').length,
      1,
      'the start already said it is working, and a second of output does not need saying again',
    );

    // A second later, with the run still going, it says so again — which is what
    // keeps the ninety-second quiet rule from firing on the screens that are
    // only hearing about the output rather than receiving it.
    processor.activityAnnounced.set('s1', Date.now() - 5000);
    bridge.started.onOutput('still here\n');

    assert.deepStrictEqual(
      typed(phone, 'session_activity').map((message) => message.active),
      [true, true],
    );
  });

  it('stops announcing when the session is stopped on purpose', async function () {
    const driving = socket('w1', USER.id, { claudeSessionId: 's1' });
    const phone = socket('w2', USER.id);
    const session = record('s1', { connections: new Set(['w1']) });
    const { processor } = processorWith([driving, phone], [session]);

    await processor.startRuntime('w1', 'terminal', {});
    await processor.stopRuntime('s1', 'terminal');

    assert.deepStrictEqual(
      typed(phone, 'session_activity').map((message) => message.active),
      [true, false],
    );
  });
});

// ---------------------------------------------------------------------------
// The strip half
// ---------------------------------------------------------------------------

let mod;

const STUBBED = ['window', 'document', 'navigator', 'fetch', 'localStorage', 'sessionStorage'];

let requests;
let respondTo;
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

function fakeApp() {
  const joined = [];
  const app = {
    joined,
    isMobile: false,
    currentClaudeSessionId: null,
    currentClaudeSessionName: null,
    getAlias: () => 'Claude',
    joinSession: async (id) => { joined.push(id); app.currentClaudeSessionId = id; },
    leaveSession() {},
    folderBrowser: { show() {} },
    isCreatingNewSession: false,
    chats: {
      subscribed: [],
      dropped: [],
      seeded: [],
      subscribe(id) { this.subscribed.push(id); },
      drop(id) { this.dropped.push(id); },
      ensure(id) {
        const chats = this;
        return { seedBypass(value) { chats.seeded.push({ id, value }); } };
      },
    },
  };
  return app;
}

function manager() {
  const app = fakeApp();
  return { m: new mod.SessionTabManager(app), app };
}

function shellTab(id) {
  return mod.shellStore.getSnapshot().tabs.find((t) => t.id === id);
}

/** What the server says a session is, in the shape both the listing and the announcement use. */
function listed(id, over = {}) {
  return { id, name: id, active: false, workingDir: `/projects/${id}`, ...over };
}

describe('a tab strip that keeps up with the other screens', function () {
  before(function () {
    this.timeout(60000);

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

    const out = path.join(os.tmpdir(), `session-sync-${process.pid}.js`);
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
    for (const name of STUBBED) {
      if (originals[name] === undefined) delete global[name];
      else global[name] = originals[name];
    }
  });

  // Re-stubbed per test: another suite in this run deletes these globals in a
  // ROOT afterEach, which runs after every test in the whole process.
  beforeEach(function () {
    requests = [];
    stored.clear();
    perWindow.clear();
    respondTo = () => ({ ok: true, json: async () => ({ sessions: [] }) });
    installStubs();
  });

  it('takes a session opened on another screen without taking the screen over', function () {
    const { m, app } = manager();
    m.addTab('here', 'here', 'idle', '/projects/here', false);
    m.switchToTab('here');
    app.joined.length = 0;

    m.applyRemoteOpen(listed('elsewhere', { workingDir: '/projects/elsewhere' }));

    assert.deepStrictEqual(m.getOrderedTabIds(), ['here', 'elsewhere']);
    assert.strictEqual(m.activeTabId, 'here', 'the tab in front of the user is left alone');
    assert.deepStrictEqual(app.joined, [], 'and nothing is joined behind their back');
    assert.strictEqual(shellTab('elsewhere').title, 'elsewhere');
  });

  it('watches a conversation opened elsewhere, so it is live rather than a name', function () {
    const { m, app } = manager();

    m.applyRemoteOpen(listed('chat', { surface: 'chat', bypassPermissions: true }));

    assert.strictEqual(shellTab('chat').surface, 'chat');
    assert.deepStrictEqual(app.chats.subscribed, ['chat']);
    assert.deepStrictEqual(
      app.chats.seeded,
      [{ id: 'chat', value: true }],
      'the pane states the mode it is really in from its first paint',
    );
  });

  it('follows a session that turns into a conversation where it was a terminal', function () {
    // The same announcement, sent again when the surface changes. A screen that
    // still thinks this is a terminal never subscribes, so the tab sits frozen
    // at whatever it looked like when it was one.
    const { m, app } = manager();
    m.applyRemoteOpen(listed('s1'));
    assert.strictEqual(shellTab('s1').surface, 'terminal');

    m.applyRemoteOpen(listed('s1', { surface: 'chat' }));

    assert.strictEqual(shellTab('s1').surface, 'chat');
    assert.deepStrictEqual(app.chats.subscribed, ['s1']);
  });

  it('does not re-seed a conversation it is already following', function () {
    // The announcement repeats on every relaunch, anywhere. A pane that has been
    // following its own events must not have an older answer written over them.
    const { m, app } = manager();
    m.applyRemoteOpen(listed('chat', { surface: 'chat', bypassPermissions: true }));
    m.applyRemoteOpen(listed('chat', { surface: 'chat', bypassPermissions: false }));

    assert.deepStrictEqual(app.chats.seeded, [{ id: 'chat', value: true }]);
    assert.deepStrictEqual(app.chats.subscribed, ['chat'], 'and it is not subscribed twice');
  });

  it('leaves a conversation this screen closed off this screen', async function () {
    // Closing one means "take this off my screen" (#127). An announcement is
    // not a reason to overrule that, and one arrives every time the conversation
    // is relaunched anywhere.
    const sessions = [listed('chat', { surface: 'chat' })];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    m.closeSession('chat');
    assert.ok(!m.tabs.has('chat'));

    m.applyRemoteOpen(listed('chat', { surface: 'chat' }));

    assert.deepStrictEqual(m.getOrderedTabIds(), []);
  });

  it('shows a session as working while it works somewhere else', function () {
    const { m } = manager();
    m.addTab('build', 'build', 'idle', '/projects/build', false);

    m.applyRemoteActivity('build', true);
    assert.strictEqual(shellTab('build').status, 'running');

    m.applyRemoteActivity('build', false);
    assert.strictEqual(shellTab('build').status, 'idle');
    assert.strictEqual(
      shellTab('build').unread,
      true,
      'a background session that was working and has stopped is worth a dot',
    );
  });

  it('ignores activity for the session this screen is attached to', async function () {
    // That screen has the output itself and is already running this exact rule
    // off it; a second source would only race with it.
    const { m, app } = manager();
    m.addTab('mine', 'mine', 'idle', '/projects/mine', false);
    await m.switchToTab('mine');
    assert.strictEqual(app.currentClaudeSessionId, 'mine');

    m.applyRemoteActivity('mine', true);

    assert.strictEqual(shellTab('mine').status, 'idle');
  });

  it('ignores activity for a session it has no tab for', function () {
    const { m } = manager();
    m.applyRemoteActivity('unknown', true);
    assert.deepStrictEqual(m.getOrderedTabIds(), []);
  });

  it('reconciles a strip that was away: adds what appeared, drops what went', async function () {
    let sessions = [listed('kept'), listed('doomed')];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    assert.deepStrictEqual(m.getOrderedTabIds(), ['kept', 'doomed']);

    // What the socket missed while it was down.
    sessions = [listed('kept'), listed('started-elsewhere')];
    await m.reconcile();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['kept', 'started-elsewhere']);
  });

  it('does not delete a session created while it was asking', async function () {
    // The listing is a photograph. A tab younger than the question is absent
    // from it because of when the question was asked, not because the session
    // is not there — and removing it would take away the one the user just
    // started.
    const { m } = manager();
    respondTo = async () => {
      m.addTab('just-now', 'just-now', 'idle', '/projects/just-now', false);
      return { ok: true, json: async () => ({ sessions: [] }) };
    };

    await m.reconcile();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['just-now']);
  });

  it('does not mark half the strip unread just because it reconnected', async function () {
    // The session went quiet while this socket was away. It did not go quiet
    // *at this screen*, and lighting up the strip would be reporting the
    // disconnection rather than the work.
    let sessions = [listed('worker', { active: true })];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    assert.strictEqual(shellTab('worker').status, 'running');

    sessions = [listed('worker', { active: false })];
    await m.reconcile();

    assert.strictEqual(shellTab('worker').status, 'idle');
    assert.strictEqual(shellTab('worker').unread, false);
  });

  it('keeps a closed conversation closed through a reconcile, and forgets deleted ones', async function () {
    let sessions = [listed('closed', { surface: 'chat' }), listed('gone', { surface: 'chat' })];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    m.closeSession('closed');
    m.closeSession('gone');

    sessions = [listed('closed', { surface: 'chat' })];
    await m.reconcile();

    assert.deepStrictEqual(m.getOrderedTabIds(), [], 'neither comes back');
    assert.deepStrictEqual(
      JSON.parse(stored.get('cc-web-closed-conversations')),
      ['closed'],
      'the note about a conversation the server no longer has is dropped',
    );
  });

  it('leaves the strip alone when the listing cannot be had', async function () {
    // A failed question is not evidence that anything has gone.
    respondTo = () => { throw new Error('offline'); };

    const { m } = manager();
    m.addTab('s1', 's1', 'idle', '/projects/s1', false);
    await m.reconcile();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['s1']);
  });
});
