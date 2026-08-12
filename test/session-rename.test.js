const assert = require('assert');
const express = require('express');
const http = require('http');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');

// A name the user chose belongs to the session, not to the page that typed it.
//
// Which means two things this file checks: the record keeps it (so an autosave
// carries it across a restart, and every later page load reads it back from the
// listing), and every socket the same user has open is told, so a second window
// does not sit there disagreeing about what a tab is called until someone
// reloads it.

const USER = { id: 7, githubId: '1', githubLogin: 'tester', githubName: null, avatarUrl: null, email: null };
const OTHER = { id: 8, githubId: '2', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };

let sessions;
let sockets;
let server;
let base;
let currentUser;
let saves;
let saveResult;

function record(id, over = {}) {
  return {
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
    ...over,
  };
}

/** A socket that records what it was sent. `readyState` 1 is OPEN. */
function socket(id, userId, readyState = 1) {
  const sent = [];
  return {
    id,
    userId,
    githubLogin: 'tester',
    claudeSessionId: null,
    chatSessionIds: new Set(),
    created: new Date(),
    sent,
    ws: {
      readyState,
      send: (payload) => sent.push(JSON.parse(payload)),
    },
  };
}

// Inside the describe, not at the top level: a top-level `before` is a ROOT
// hook and would stand a server up for every other suite in the run.
describe('renaming a session', function () {
before(async function () {
  this.timeout(30000);

  sessions = new Map();
  sockets = new Map();
  saves = 0;
  currentUser = USER;

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
      saveSessionsToDisk: async () => { saves++; return saveResult; },
      transcriptStore: { ensureTranscript: async () => {}, deleteTranscript: async () => {} },
      historyStore: { deleteHistory: async () => {} },
      getScreenSnapshot: () => [],
      disposeRecorder: () => {},
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
  currentUser = USER;
  saves = 0;
  saveResult = true;
});

async function rename(id, body) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function list() {
  const response = await fetch(`${base}/api/sessions/list`);
  return (await response.json()).sessions;
}

  it('stores the chosen name beside the created one and saves', async function () {
    sessions.set('s1', record('s1'));

    const result = await rename('s1', { name: '  the good one  ' });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.name, 'the good one');
    assert.strictEqual(sessions.get('s1').customName, 'the good one');
    assert.strictEqual(
      sessions.get('s1').name,
      'Session s1',
      'the created name is left alone, so a session nobody renamed is unaffected',
    );
    assert.strictEqual(saves, 1, 'the rename is persisted rather than waiting for the next autosave');
  });

  it('reports the chosen name in the listing every page boots from', async function () {
    sessions.set('s1', record('s1'));
    sessions.set('s2', record('s2'));

    await rename('s1', { name: 'renamed' });

    const rows = await list();
    assert.strictEqual(rows.find((row) => row.id === 's1').customName, 'renamed');
    assert.strictEqual(
      rows.find((row) => row.id === 's2').customName,
      undefined,
      'a session nobody renamed reports no chosen name',
    );
  });

  it('rolls back and reports a rename that could not be saved', async function () {
    sessions.set('s1', record('s1', { customName: 'previous' }));
    const mine = socket('w1', USER.id);
    sockets.set(mine.id, mine);
    saveResult = false;

    const result = await rename('s1', { name: 'false success' });

    assert.strictEqual(result.status, 503);
    assert.deepStrictEqual(result.body, {
      error: 'session_name_not_saved',
      message: 'The session name could not be saved',
    });
    assert.strictEqual(sessions.get('s1').customName, 'previous');
    assert.strictEqual(saves, 1);
    assert.deepStrictEqual(mine.sent, [], 'a failed rename is never broadcast as successful');
  });

  it('lists an unavailable-storage reason but refuses to rename the read-only record', async function () {
    const reason = 'The workspace storage is read-only';
    sessions.set('blocked', record('blocked', { persistenceUnavailable: reason }));
    const mine = socket('w1', USER.id);
    sockets.set(mine.id, mine);

    const rows = await list();
    assert.strictEqual(rows.find((row) => row.id === 'blocked').persistenceUnavailable, reason);

    const result = await rename('blocked', { name: 'must not stick' });
    assert.strictEqual(result.status, 409);
    assert.deepStrictEqual(result.body, {
      error: 'session_persistence_unavailable',
      message: reason,
      retryable: true,
    });
    assert.strictEqual(sessions.get('blocked').customName, undefined);
    assert.strictEqual(saves, 0);
    assert.deepStrictEqual(mine.sent, [], 'a refused mutation is not announced as a rename');
  });

  it('tells every one of this user\'s sockets, and nobody else\'s', async function () {
    sessions.set('s1', record('s1'));
    const mine = socket('w1', USER.id);
    const otherWindow = socket('w2', USER.id);
    const closed = socket('w3', USER.id, 3);
    const stranger = socket('w4', OTHER.id);
    for (const info of [mine, otherWindow, closed, stranger]) sockets.set(info.id, info);

    await rename('s1', { name: 'renamed' });

    const expected = { type: 'session_renamed', sessionId: 's1', name: 'renamed' };
    assert.deepStrictEqual(mine.sent, [expected]);
    assert.deepStrictEqual(otherWindow.sent, [expected], 'an already-open window follows without a reload');
    assert.deepStrictEqual(closed.sent, [], 'a socket that is not open is skipped');
    assert.deepStrictEqual(stranger.sent, [], 'another user hears nothing about this session');
  });

  it('refuses a name that is not a name', async function () {
    sessions.set('s1', record('s1'));

    assert.strictEqual((await rename('s1', { name: '   ' })).status, 400);
    assert.strictEqual((await rename('s1', { name: '' })).status, 400);
    assert.strictEqual((await rename('s1', { name: 42 })).status, 400);
    assert.strictEqual((await rename('s1', {})).status, 400);
    assert.strictEqual(
      sessions.get('s1').customName,
      undefined,
      'a refused rename leaves the previous name in place',
    );
    assert.strictEqual(saves, 0);
  });

  it('caps a very long name rather than storing a paragraph', async function () {
    sessions.set('s1', record('s1'));

    const result = await rename('s1', { name: 'x'.repeat(5000) });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.name.length, 200);
    assert.strictEqual(sessions.get('s1').customName.length, 200);
  });

  it('will not rename a session this user does not own', async function () {
    sessions.set('s1', record('s1', { ownerUserId: OTHER.id }));

    const result = await rename('s1', { name: 'mine now' });

    assert.strictEqual(result.status, 404);
    assert.strictEqual(sessions.get('s1').customName, undefined);
  });

  it('404s for a session that no longer exists', async function () {
    assert.strictEqual((await rename('ghost', { name: 'anything' })).status, 404);
  });
});
