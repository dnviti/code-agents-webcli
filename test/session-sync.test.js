const assert = require('assert');
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { announceSessionOpened } = require('../dist/server/websocket/handler.js');

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
let saves;
let saveSessions;

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
    saves = 0;

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
        saveSessionsToDisk: () => saveSessions(),
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
    saves = 0;
    saveSessions = async () => { saves++; };
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

  async function setTab(id, open, options = {}) {
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/tab`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open, ...options }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function reorder(sessionIds) {
    const response = await fetch(`${base}/api/sessions/tabs/order`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function list() {
    const response = await fetch(`${base}/api/sessions/list`);
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

  it('closes a conversation tab on every screen without deleting or stopping it', async function () {
    const chat = record('chat', {
      surface: 'chat',
      active: true,
      agent: 'claude',
      connections: new Set(['w1']),
    });
    sessions.set(chat.id, chat);
    const laptop = socket('w1', USER.id, { claudeSessionId: 'chat' });
    const phone = socket('w2', USER.id);
    const stranger = socket('w3', OTHER.id);
    for (const info of [laptop, phone, stranger]) sockets.set(info.id, info);

    const result = await setTab('chat', false);

    assert.deepStrictEqual(result, {
      status: 200,
      body: { success: true, open: false, applied: true },
    });
    assert.strictEqual(chat.tabOpen, false);
    assert.strictEqual(sessions.get('chat'), chat, 'the conversation record remains');
    assert.strictEqual(chat.active, true, 'its running agent is not stopped');
    assert.deepStrictEqual(destroyed, [], 'none of its durable data is torn down');
    assert.strictEqual(saves, 1, 'the account-level tab state is persisted immediately');
    const expected = { type: 'session_tab_closed', sessionId: 'chat' };
    assert.deepStrictEqual(typed(laptop, 'session_tab_closed'), [expected]);
    assert.deepStrictEqual(typed(phone, 'session_tab_closed'), [expected]);
    assert.deepStrictEqual(stranger.sent, [], 'another account hears nothing');

    const listed = await list();
    assert.strictEqual(listed.status, 200);
    assert.deepStrictEqual(listed.body.sessions, [], 'a closed tab is absent from the strip list');
  });

  it('reopens a conversation tab on every screen', async function () {
    const chat = record('chat', { surface: 'chat', tabOpen: false });
    sessions.set(chat.id, chat);
    const laptop = socket('w1', USER.id);
    const phone = socket('w2', USER.id);
    for (const info of [laptop, phone]) sockets.set(info.id, info);

    const result = await setTab('chat', true);

    assert.deepStrictEqual(result, {
      status: 200,
      body: { success: true, open: true, applied: true },
    });
    assert.strictEqual(chat.tabOpen, true);
    const expected = {
      type: 'session_opened',
      sessionId: 'chat',
      name: 'Session chat',
      customName: null,
      workingDir: '/projects/alpha',
      surface: 'chat',
      active: false,
      bypassPermissions: false,
    };
    assert.deepStrictEqual(typed(laptop, 'session_opened'), [expected]);
    assert.deepStrictEqual(typed(phone, 'session_opened'), [expected]);
    assert.deepStrictEqual(typed(phone, 'session_tabs_reordered'), [
      { type: 'session_tabs_reordered', sessionIds: ['chat'] },
    ]);
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['chat']);
  });

  it('persists one exact tab order and announces it only to this account', async function () {
    sessions.set('a', record('a', { surface: 'chat' }));
    sessions.set('b', record('b', { surface: 'chat' }));
    sessions.set('theirs', record('theirs', { ownerUserId: OTHER.id, surface: 'chat' }));
    const laptop = socket('w1', USER.id);
    const phone = socket('w2', USER.id);
    const stranger = socket('w3', OTHER.id);
    for (const info of [laptop, phone, stranger]) sockets.set(info.id, info);

    const result = await reorder(['b', 'a']);

    assert.deepStrictEqual(result, {
      status: 200,
      body: { success: true, sessionIds: ['b', 'a'] },
    });
    assert.strictEqual(saves, 1, 'success is acknowledged only after persistence');
    assert.strictEqual(sessions.get('b').tabOrder, 0);
    assert.strictEqual(sessions.get('a').tabOrder, 1);
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['b', 'a']);
    const expected = { type: 'session_tabs_reordered', sessionIds: ['b', 'a'] };
    assert.deepStrictEqual(typed(laptop, 'session_tabs_reordered'), [expected]);
    assert.deepStrictEqual(typed(phone, 'session_tabs_reordered'), [expected]);
    assert.deepStrictEqual(stranger.sent, [], 'another account never receives this order');
  });

  it('rejects stale, duplicate and foreign reorder sets without changing membership', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOrder: 0 }));
    sessions.set('b', record('b', { surface: 'chat', tabOrder: 1 }));
    sessions.set('theirs', record('theirs', {
      ownerUserId: OTHER.id,
      surface: 'chat',
      tabOrder: 0,
    }));

    assert.strictEqual((await reorder(['a', 'a'])).status, 400, 'duplicates are malformed');
    assert.strictEqual((await reorder(['a'])).status, 409, 'a missing open tab is stale');
    assert.strictEqual((await reorder(['a', 'theirs'])).status, 409, 'foreign IDs are not accepted');
    assert.strictEqual((await reorder(['a', 'b', 'ghost'])).status, 409);
    assert.strictEqual(saves, 0);
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['a', 'b']);
  });

  it('rolls a reorder back when persistence fails', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOrder: 0 }));
    sessions.set('b', record('b', { surface: 'chat', tabOrder: 1 }));
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);
    saveSessions = async () => { saves++; return false; };

    const result = await reorder(['b', 'a']);

    assert.strictEqual(result.status, 503);
    assert.strictEqual(sessions.get('a').tabOrder, 0);
    assert.strictEqual(sessions.get('b').tabOrder, 1);
    assert.deepStrictEqual(phone.sent, [], 'an order that will not survive is never announced');
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['a', 'b']);
  });

  it('does not let a list observe a tentative reorder that later rolls back', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOrder: 0 }));
    sessions.set('b', record('b', { surface: 'chat', tabOrder: 1 }));
    let finishSave;
    const saving = new Promise((resolve) => { finishSave = resolve; });
    saveSessions = async () => saving;

    const moving = reorder(['b', 'a']);
    await new Promise((resolve) => setImmediate(resolve));
    let listSettled = false;
    const listing = list().then((value) => { listSettled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(listSettled, false, 'the list waits for the account transaction');

    finishSave(false);
    assert.strictEqual((await moving).status, 503);
    assert.deepStrictEqual(
      (await listing).body.sessions.map((entry) => entry.id),
      ['a', 'b'],
      'the first visible snapshot is the rolled-back durable order',
    );
  });

  it('appends a genuinely reopened tab without moving an idempotently open one', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOpen: true, tabOrder: 0 }));
    sessions.set('b', record('b', { surface: 'chat', tabOpen: true, tabOrder: 1 }));
    sessions.set('closed', record('closed', { surface: 'chat', tabOpen: false, tabOrder: 0 }));
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);

    assert.strictEqual((await setTab('closed', true)).status, 200);
    assert.strictEqual(sessions.get('closed').tabOrder, 2);
    assert.deepStrictEqual(
      (await list()).body.sessions.map((entry) => entry.id),
      ['a', 'b', 'closed'],
    );
    assert.deepStrictEqual(typed(phone, 'session_tabs_reordered').at(-1), {
      type: 'session_tabs_reordered',
      sessionIds: ['a', 'b', 'closed'],
    });

    assert.strictEqual((await setTab('a', true)).status, 200);
    assert.strictEqual(sessions.get('a').tabOrder, 0, 'restating open does not move the tab');
    assert.deepStrictEqual(
      (await list()).body.sessions.map((entry) => entry.id),
      ['a', 'b', 'closed'],
    );
    assert.deepStrictEqual(
      typed(phone, 'session_tabs_reordered').at(-1),
      { type: 'session_tabs_reordered', sessionIds: ['a', 'b', 'closed'] },
      'an idempotent open also corrects another stale client\'s insertion position',
    );
  });

  it('serializes a reorder with a close across the whole account', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOrder: 0 }));
    sessions.set('b', record('b', { surface: 'chat', tabOrder: 1 }));

    let finishReorder;
    const reorderSaved = new Promise((resolve) => { finishReorder = resolve; });
    saveSessions = async () => {
      saves++;
      if (saves === 1) return reorderSaved;
      return true;
    };

    const moving = reorder(['b', 'a']);
    await new Promise((resolve) => setImmediate(resolve));
    const closing = setTab('a', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(saves, 1, 'the close waits for the account reorder transaction');

    finishReorder(true);
    assert.strictEqual((await moving).status, 200);
    assert.strictEqual((await closing).status, 200);
    assert.strictEqual(saves, 2);
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['b']);
  });

  it('allocates a new tab only after a failed close has rolled back', async function () {
    sessions.set('a', record('a', { surface: 'chat', tabOrder: 5 }));
    let finishClose;
    const closeSaved = new Promise((resolve) => { finishClose = resolve; });
    saveSessions = async () => {
      saves++;
      if (saves === 1) return closeSaved;
      return true;
    };

    const closing = setTab('a', false);
    await new Promise((resolve) => setImmediate(resolve));
    const creating = create({ name: 'new', workingDir: '/projects/alpha' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(saves, 1, 'creation waits behind the tentative close');

    finishClose(false);
    assert.strictEqual((await closing).status, 503);
    const made = await creating;
    assert.strictEqual(made.status, 200);
    assert.strictEqual(sessions.get(made.body.sessionId).tabOrder, 6);
    assert.deepStrictEqual(
      (await list()).body.sessions.map((entry) => entry.id),
      ['a', made.body.sessionId],
    );
  });

  it('rejects invalid, terminal, nested and other-account tab changes', async function () {
    sessions.set('chat', record('chat', { surface: 'chat' }));
    sessions.set('terminal', record('terminal'));
    sessions.set('nested', record('nested', { surface: 'chat', ownerSessionId: 'chat' }));
    sessions.set('theirs', record('theirs', { ownerUserId: OTHER.id, surface: 'chat' }));
    const mine = socket('w1', USER.id);
    sockets.set(mine.id, mine);

    assert.strictEqual((await setTab('chat', 'false')).status, 400);
    assert.strictEqual((await setTab('terminal', false)).status, 400);
    assert.strictEqual((await setTab('nested', false)).status, 400);
    assert.strictEqual((await setTab('theirs', false)).status, 404);

    currentUser = OTHER;
    assert.strictEqual((await setTab('chat', false)).status, 404);
    assert.strictEqual(sessions.get('chat').tabOpen, undefined, 'no rejected write changes state');
    assert.deepStrictEqual(mine.sent, [], 'no rejected write is announced');
  });

  it('applies each legacy browser close once and never lets a stale device undo a reopen', async function () {
    const chat = record('chat', { surface: 'chat' });
    sessions.set(chat.id, chat);
    const laptop = socket('w1', USER.id);
    const phone = socket('w2', USER.id);
    sockets.set(laptop.id, laptop);
    sockets.set(phone.id, phone);

    const migrated = await setTab('chat', false, { legacy: true });
    assert.deepStrictEqual(migrated, {
      status: 200,
      body: { success: true, open: false, applied: true },
    });
    assert.strictEqual(chat.tabOpen, false);
    assert.strictEqual(saves, 1);
    assert.strictEqual(typed(phone, 'session_tab_closed').length, 1);

    const reopened = await setTab('chat', true);
    assert.deepStrictEqual(reopened.body, { success: true, open: true, applied: true });
    assert.strictEqual(chat.tabOpen, true);
    assert.strictEqual(saves, 2);

    // A second browser still has the old origin-local tombstone. It starts
    // after the reopen, but that old fact is not a newer close intent.
    laptop.sent.length = 0;
    phone.sent.length = 0;
    const stale = await setTab('chat', false, { legacy: true });
    assert.deepStrictEqual(stale, {
      status: 200,
      body: { success: true, open: true, applied: false },
    });
    assert.strictEqual(chat.tabOpen, true, 'the explicit reopen wins');
    assert.strictEqual(saves, 2, 'an ignored legacy write is not persisted');
    assert.deepStrictEqual(laptop.sent, [], 'an ignored tombstone is not broadcast');
    assert.deepStrictEqual(phone.sent, []);
  });

  it('does not announce or acknowledge a close that SQLite refused to save', async function () {
    const chat = record('chat', { surface: 'chat' });
    sessions.set(chat.id, chat);
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);
    saveSessions = async () => { saves++; return false; };

    const result = await setTab('chat', false);

    assert.strictEqual(result.status, 503);
    assert.strictEqual(result.body.error, 'tab_state_not_saved');
    assert.strictEqual(chat.tabOpen, undefined, 'the failed mutation is rolled back');
    assert.strictEqual(saves, 1);
    assert.deepStrictEqual(phone.sent, [], 'no device acts on state that will not survive restart');
    assert.deepStrictEqual((await list()).body.sessions.map((entry) => entry.id), ['chat']);
  });

  it('serializes cross-device tab writes through persistence in server arrival order', async function () {
    const chat = record('chat', { surface: 'chat', tabOpen: false });
    sessions.set(chat.id, chat);
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);

    let releaseFirst;
    const firstSave = new Promise((resolve) => { releaseFirst = resolve; });
    saveSessions = async () => {
      saves++;
      if (saves === 1) return firstSave;
      return true;
    };

    const opening = setTab('chat', true);
    // Let the first handler enter its persistence turn before the close arrives.
    await new Promise((resolve) => setImmediate(resolve));
    const closing = setTab('chat', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(saves, 1, 'the later device waits behind the first durable write');

    releaseFirst(true);
    const [opened, closed] = await Promise.all([opening, closing]);
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(closed.status, 200);
    assert.strictEqual(saves, 2);
    assert.strictEqual(chat.tabOpen, false, 'the later close is the final account state');
    assert.deepStrictEqual(
      phone.sent.map((message) => message.type),
      ['session_opened', 'session_tabs_reordered', 'session_tab_closed'],
      'every online screen observes the same persisted order',
    );
    assert.deepStrictEqual((await list()).body.sessions, []);
  });

  it('does not resurrect a closed tab when runtime metadata is re-announced', function () {
    const hidden = record('hidden', { surface: 'chat', tabOpen: false });
    const phone = socket('w1', USER.id);
    sockets.set(phone.id, phone);

    announceSessionOpened(hidden, sockets);

    assert.deepStrictEqual(phone.sent, []);
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

  it('restores the exact legacy Map order when a delete cannot be persisted', async function () {
    sessions.set('a', record('a'));
    sessions.set('b', record('b'));
    saveSessions = async () => false;

    const result = await remove('a');

    assert.strictEqual(result.status, 503);
    assert.deepStrictEqual(
      (await list()).body.sessions.map((entry) => entry.id),
      ['a', 'b'],
      'rollback must not move an unordered legacy tab to the Map tail',
    );
    assert.deepStrictEqual(destroyed, [], 'teardown starts only after durable deletion');
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

  it('does not let a deferred socket create overwrite a newer join', async function () {
    const asking = socket('w1', USER.id, { claudeSessionId: 'a' });
    const phone = socket('w2', USER.id);
    const a = record('a', { connections: new Set(['w1']) });
    const c = record('c');
    const { processor, claudeSessions } = processorWith([asking, phone], [a, c]);
    let finishSave;
    processor.deps.saveSessionsToDisk = () => new Promise((resolve) => { finishSave = resolve; });

    const creating = processor.createAndJoinSession('w1', 'new', '/projects/alpha');
    await new Promise((resolve) => setImmediate(resolve));
    const createdId = Array.from(claudeSessions.keys()).find((id) => id !== 'a' && id !== 'c');
    assert.ok(createdId, 'the durable tab is staged while save is pending');

    await processor.joinSession('w1', 'c');
    assert.strictEqual(asking.claudeSessionId, 'c');
    finishSave(true);
    await creating;

    assert.strictEqual(asking.claudeSessionId, 'c', 'the newer destination keeps focus');
    assert.ok(!claudeSessions.get(createdId).connections.has('w1'));
    assert.deepStrictEqual(
      typed(asking, 'session_created'),
      [],
      'the delayed create acknowledgement cannot switch the client back',
    );
    assert.deepStrictEqual(
      typed(phone, 'session_opened').map((message) => message.sessionId),
      [createdId],
      'the successfully saved tab still exists for the account',
    );
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

  it('does not let a late A-to-B join detach the newer C destination', async function () {
    const mine = socket('w1', USER.id, { claudeSessionId: 'a' });
    const a = record('a', { connections: new Set(['w1']) });
    const b = record('b');
    const c = record('c');
    const { processor } = processorWith([mine], [a, b, c]);

    let releaseB;
    const bTranscript = new Promise((resolve) => { releaseB = resolve; });
    processor.deps.transcriptStore.readTranscriptChunks = async (session) => {
      if (session.id === 'b') await bTranscript;
      return [];
    };

    const joiningB = processor.joinSession('w1', 'b');
    await Promise.resolve();
    assert.strictEqual(mine.claudeSessionId, 'b');

    // Before B's transcript finishes, another pair of remote closes makes C
    // the actual fallback. C completes first.
    await processor.joinSession('w1', 'c');
    assert.strictEqual(mine.claudeSessionId, 'c');
    assert.deepStrictEqual(
      typed(mine, 'session_joined').map((message) => message.sessionId),
      ['c'],
    );

    releaseB();
    await joiningB;
    assert.deepStrictEqual(
      typed(mine, 'session_joined').map((message) => message.sessionId),
      ['c'],
      'the obsolete B read produces no late acknowledgement',
    );

    // Defense in depth for an old server that did send B late: the client now
    // names B in its cleanup, and the newer C attachment is left untouched.
    await processor.handleMessage('w1', { type: 'leave_session', sessionId: 'b' });
    assert.strictEqual(mine.claudeSessionId, 'c');
    assert.ok(c.connections.has('w1'));
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
    sent: [],
    sessionListLoads: 0,
    isMobile: false,
    currentClaudeSessionId: null,
    currentClaudeSessionName: null,
    getAlias: () => 'Claude',
    authFetch: (url, init) => global.fetch(url, init),
    joinSession: async (id) => { joined.push(id); app.currentClaudeSessionId = id; },
    send(message) { app.sent.push(message); },
    leaveSession() {},
    loadSessions() { app.sessionListLoads += 1; },
    folderBrowser: { show() {} },
    isCreatingNewSession: false,
    chats: {
      subscribed: [],
      dropped: [],
      seeded: [],
      subscribe(id) { this.subscribed.push(id); },
      drop(id) { this.dropped.push(id); },
      handle() { return false; },
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
      `export { MessageHandler } from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/message-handler'))};`,
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

  it('adopts a conversation reopened on another screen without taking focus', async function () {
    const sessions = [listed('chat', { surface: 'chat' })];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    m.closeSession('chat', { skipServerRequest: true });
    assert.ok(!m.tabs.has('chat'));

    m.applyRemoteOpen(listed('chat', { surface: 'chat' }));

    assert.deepStrictEqual(m.getOrderedTabIds(), ['chat']);
    assert.strictEqual(m.activeTabId, null, 'another screen does not select this window\'s tab');
  });

  it('applies a remote tab close without echoing it back to the server', function () {
    const { m, app } = manager();
    app.sessionTabManager = m;
    m.addTab('chat', 'chat', 'idle', '/projects/chat', false);
    m.setTabSurface('chat', 'chat');
    requests.length = 0;

    new mod.MessageHandler(app).handle({ type: 'session_tab_closed', sessionId: 'chat' });

    assert.deepStrictEqual(m.getOrderedTabIds(), []);
    assert.deepStrictEqual(app.chats.dropped, ['chat']);
    assert.deepStrictEqual(requests, [], 'the broadcast must not cause another PATCH');
    assert.strictEqual(app.sessionListLoads, 1, 'an open session list is refreshed too');
  });

  it('applies a remote account order without echoing it or moving focus', function () {
    const { m, app } = manager();
    app.sessionTabManager = m;
    m.addTab('a', 'a', 'idle', '/projects/a', false);
    m.addTab('b', 'b', 'idle', '/projects/b', false);
    m.activeTabId = 'a';
    requests.length = 0;

    new mod.MessageHandler(app).handle({
      type: 'session_tabs_reordered',
      sessionIds: ['b', 'a'],
    });

    assert.deepStrictEqual(m.getOrderedTabIds(), ['b', 'a']);
    assert.strictEqual(m.activeTabId, 'a');
    assert.deepStrictEqual(requests, [], 'the socket event is not written back');
  });

  it('moves a stale existing tab when another device genuinely reopens it', function () {
    const { m, app } = manager();
    app.sessionTabManager = m;
    // This window missed the close, so X is still present at its old position.
    m.addTab('x', 'x', 'idle', '/projects/x', false);
    m.addTab('keep', 'keep', 'idle', '/projects/keep', false);
    m.activeTabId = 'keep';
    const handler = new mod.MessageHandler(app);

    handler.handle({
      type: 'session_opened',
      sessionId: 'x',
      name: 'x',
      customName: null,
      workingDir: '/projects/x',
      surface: 'chat',
      active: false,
      bypassPermissions: false,
    });
    assert.deepStrictEqual(m.getOrderedTabIds(), ['x', 'keep'], 'open alone is idempotent');

    handler.handle({ type: 'session_tabs_reordered', sessionIds: ['keep', 'x'] });
    assert.deepStrictEqual(m.getOrderedTabIds(), ['keep', 'x'], 'the full reopen order appends X');
    assert.strictEqual(m.activeTabId, 'keep');
  });

  it('detaches a late fallback join after both tabs close remotely', async function () {
    const { m, app } = manager();
    app.sessionTabManager = m;
    app.pendingJoinResolve = null;
    app.pendingJoinSessionId = null;
    app.left = 0;
    app.leaveSession = () => { app.left += 1; };
    app.fitTerminal = () => {};
    app.historyRange = { firstLine: 0, totalLines: 0 };
    app.historyView = null;
    app.terminal = null;
    app.splitContainer = null;
    app.pendingRuntimeStart = null;
    app.startPromptRequested = false;
    app.socket = null;

    m.addTab('a', 'a', 'idle', '/projects/a', false);
    m.addTab('b', 'b', 'idle', '/projects/b', false);
    m.setTabSurface('a', 'chat');
    m.setTabSurface('b', 'chat');
    await m.switchToTab('a');

    // Closing the active tab selects B immediately, but hold its actual join
    // answer until after the account has closed B too.
    let fallbackSettled = false;
    app.joinSession = (id) => new Promise((resolve) => {
      app.joined.push(id);
      app.pendingJoinSessionId = id;
      app.pendingJoinResolve = () => {
        fallbackSettled = true;
        resolve();
      };
    });

    const handler = new mod.MessageHandler(app);
    handler.handle({ type: 'session_tab_closed', sessionId: 'a' });
    assert.strictEqual(m.activeTabId, 'b');
    assert.strictEqual(app.pendingJoinSessionId, 'b');

    handler.handle({ type: 'session_tab_closed', sessionId: 'b' });
    await Promise.resolve();

    assert.deepStrictEqual(m.getOrderedTabIds(), []);
    assert.strictEqual(m.activeTabId, null);
    assert.strictEqual(app.pendingJoinSessionId, null, 'closing B invalidates its pending join');
    assert.strictEqual(app.pendingJoinResolve, null);
    assert.strictEqual(fallbackSettled, true, 'the abandoned switch promise is settled promptly');

    handler.handle({
      type: 'session_joined',
      sessionId: 'b',
      sessionName: 'b',
      workingDir: '/projects/b',
      active: true,
      surface: 'terminal',
    });

    assert.notStrictEqual(
      app.currentClaudeSessionId,
      'b',
      'the late answer cannot make a tabless session current',
    );
    assert.notStrictEqual(
      mod.shellStore.getSnapshot().chat.sessionId,
      'b',
      'the late answer cannot put the orphan on screen',
    );
    assert.deepStrictEqual(
      app.sent,
      [{ type: 'leave_session', sessionId: 'b' }],
      'cleanup names only the obsolete join and cannot detach a newer destination',
    );

    // The ordinary acknowledgement completes the detach and clears the stale
    // record of A, which the server left as soon as it began joining B.
    handler.handle({ type: 'session_left' });
    assert.strictEqual(app.currentClaudeSessionId, null);
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

  it('does not resurrect a remotely closed tab from an older list response', async function () {
    let answerList;
    const pendingList = new Promise((resolve) => { answerList = resolve; });
    let lists = 0;
    respondTo = () => {
      lists++;
      if (lists === 1) return pendingList;
      return { ok: true, json: async () => ({ sessions: [] }) };
    };

    const { m } = manager();
    const reconciling = m.reconcile();

    // This screen did not have the tab, but the event is still newer than the
    // in-flight photograph, which contains it. The close must invalidate that
    // response even though there is no local record to remove yet.
    m.applyRemoteClose('closed');
    answerList({
      ok: true,
      json: async () => ({ sessions: [listed('closed', { surface: 'chat' })] }),
    });
    await reconciling;

    assert.deepStrictEqual(m.getOrderedTabIds(), []);
    assert.strictEqual(lists, 2, 'the invalidated photograph is replaced with a fresh one');
  });

  it('does not resurrect a remotely closed tab from the initial list either', async function () {
    let answerList;
    const pendingList = new Promise((resolve) => { answerList = resolve; });
    let lists = 0;
    respondTo = () => {
      lists++;
      if (lists === 1) return pendingList;
      return { ok: true, json: async () => ({ sessions: [] }) };
    };

    const { m } = manager();
    const loading = m.loadSessions();

    m.applyRemoteClose('closed');
    answerList({
      ok: true,
      json: async () => ({ sessions: [listed('closed', { surface: 'chat' })] }),
    });
    await loading;

    assert.deepStrictEqual(m.getOrderedTabIds(), []);
    assert.strictEqual(lists, 2, 'startup also retries an invalidated account snapshot');
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

  it('reconciles a tab close missed while this screen was offline', async function () {
    let sessions = [
      listed('kept', { surface: 'chat' }),
      listed('closed-elsewhere', { surface: 'chat' }),
    ];
    respondTo = () => ({ ok: true, json: async () => ({ sessions }) });

    const { m } = manager();
    await m.loadSessions();
    requests.length = 0;

    sessions = [listed('kept', { surface: 'chat' })];
    await m.reconcile();

    assert.deepStrictEqual(m.getOrderedTabIds(), ['kept']);
    assert.strictEqual(
      requests.filter((request) => request.init?.method === 'PATCH').length,
      0,
      'catching up to server state does not write the same close back',
    );
    assert.strictEqual(stored.get('cc-web-closed-conversations'), undefined);
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
