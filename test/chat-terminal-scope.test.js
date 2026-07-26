const assert = require('assert');
const express = require('express');
const http = require('http');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');

// A terminal opened inside a conversation belongs to that conversation.
//
// Which is a claim about what the rest of the app can *see*: every tab strip and
// every session dialog in this app — in this browser and in every other one the
// user has open — is built from `/api/sessions/list`, so "does not leak" means
// "is not in that list". The other half is lifetime: a shell reachable only
// through its conversation must not outlive it, or the delete leaves a pty
// running that nothing in the app can ever reach again.

const USER = { id: 7, githubId: '1', githubLogin: 'tester', githubName: null, avatarUrl: null, email: null };
const OTHER = { id: 8, githubId: '2', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };

let sessions;
let server;
let base;
let currentUser;
/** Sessions whose teardown ran, in order, so a cascade can be checked. */
let tornDown;
let deletedTranscripts;
let stoppedRuntimes;

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

before(async function () {
  this.timeout(30000);

  sessions = new Map();
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
      webSocketConnections: new Map(),
      baseFolder: '/projects',
      dev: false,
      validatePath: (target) =>
        target.startsWith('/projects')
          ? { valid: true, path: target }
          : { valid: false, error: 'outside' },
      createSessionRecord: (params) =>
        record(params.id, {
          ownerUserId: params.ownerUserId,
          name: params.name || `Session ${params.id}`,
          workingDir: params.workingDir,
          ownerSessionId: params.ownerSessionId,
        }),
      getRuntimeBridge: () => ({
        startSession: async () => {},
        sendInput: async () => {},
        resize: async () => {},
        stopSession: async (id) => {
          stoppedRuntimes.push(id);
        },
      }),
      saveSessionsToDisk: async () => {},
      transcriptStore: {
        ensureTranscript: async () => {},
        deleteTranscript: async (session) => {
          deletedTranscripts.push(session.id);
        },
      },
      historyStore: { deleteHistory: async () => {} },
      getScreenSnapshot: () => [],
      disposeRecorder: () => {},
      getSelectedWorkingDir: () => null,
      sessionStore: { getSessionMetadata: async () => ({}) },
      sessionTeardown: {
        dispose: (session) => {
          tornDown.push(session.id);
        },
      },
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

async function post(body) {
  const response = await fetch(`${base}/api/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function list() {
  const response = await fetch(`${base}/api/sessions/list`);
  return (await response.json()).sessions;
}

async function remove(id) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return response.status;
}

/** A conversation, as the chat surface leaves one on the record. */
function conversation(id) {
  sessions.set(id, record(id, { surface: 'chat' }));
  return id;
}

describe('terminals opened inside a conversation', function () {
  this.timeout(20000);

  beforeEach(function () {
    sessions.clear();
    currentUser = USER;
    tornDown = [];
    deletedTranscripts = [];
    stoppedRuntimes = [];
  });

  it('is not offered as a standalone session to any client', async function () {
    conversation('chat-1');
    const created = await post({ name: 'shell — alpha', ownerSessionId: 'chat-1' });
    assert.strictEqual(created.status, 200);

    // The listing is the only thing a tab strip is built from, here or in any
    // other browser: absent from it is absent from all of them.
    assert.deepStrictEqual((await list()).map((s) => s.id), ['chat-1']);
  });

  it('is still a real session — reachable, resizable, restartable', async function () {
    conversation('chat-2');
    const created = await post({ workingDir: '/projects/alpha', ownerSessionId: 'chat-2' });

    // Hidden from the listing, not from the pane that opened it: the split
    // rejoins its shell by id after a reload.
    const response = await fetch(`${base}/api/sessions/${created.body.sessionId}`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).workingDir, '/projects/alpha');
  });

  it('leaves standalone sessions exactly as they were', async function () {
    const plain = await post({ name: 'an ordinary terminal' });
    assert.strictEqual(plain.status, 200);
    assert.deepStrictEqual((await list()).map((s) => s.name), ['an ordinary terminal']);
  });

  it('goes when its conversation goes', async function () {
    conversation('chat-3');
    const first = await post({ ownerSessionId: 'chat-3' });
    const second = await post({ ownerSessionId: 'chat-3' });
    // A shell in a *different* conversation, which must survive this delete.
    conversation('chat-4');
    const elsewhere = await post({ ownerSessionId: 'chat-4' });

    assert.strictEqual(await remove('chat-3'), 200);

    assert.ok(!sessions.has(first.body.sessionId), 'the first shell outlived its conversation');
    assert.ok(!sessions.has(second.body.sessionId), 'the second shell outlived its conversation');
    assert.ok(sessions.has(elsewhere.body.sessionId), 'another conversation lost its shell');
    // Everything stored for them goes too, not just the record.
    assert.deepStrictEqual(deletedTranscripts.sort(), [
      'chat-3',
      first.body.sessionId,
      second.body.sessionId,
    ].sort());
    assert.strictEqual(tornDown.length, 3);
  });

  it('stops the process it was holding when the conversation is deleted', async function () {
    conversation('chat-5');
    const shell = await post({ ownerSessionId: 'chat-5' });
    // As it is once the pane has started a shell in it.
    const owned = sessions.get(shell.body.sessionId);
    owned.active = true;
    owned.agent = 'terminal';

    await remove('chat-5');

    assert.deepStrictEqual(stoppedRuntimes, [shell.body.sessionId]);
  });

  it('closing one shell leaves the conversation and its other shells alone', async function () {
    conversation('chat-6');
    const closing = await post({ ownerSessionId: 'chat-6' });
    const staying = await post({ ownerSessionId: 'chat-6' });

    assert.strictEqual(await remove(closing.body.sessionId), 200);

    assert.ok(!sessions.has(closing.body.sessionId));
    assert.ok(sessions.has(staying.body.sessionId));
    assert.ok(sessions.has('chat-6'));
  });

  it('refuses to belong to a conversation that does not exist', async function () {
    // Otherwise a bad id would produce a session hidden from its own owner's
    // tab strip with nothing left to reach it by.
    const got = await post({ ownerSessionId: 'no-such-conversation' });
    assert.strictEqual(got.status, 400);
    assert.strictEqual(got.body.error, 'unknown_owner_session');
    assert.strictEqual(sessions.size, 0);
  });

  it('refuses to belong to another user’s conversation', async function () {
    sessions.set('theirs', record('theirs', { ownerUserId: OTHER.id, surface: 'chat' }));

    const got = await post({ ownerSessionId: 'theirs' });

    assert.strictEqual(got.status, 400);
    assert.strictEqual(got.body.error, 'unknown_owner_session');
  });

  it('refuses to belong to a plain terminal session', async function () {
    // Only conversations own shells. A terminal owning a terminal would be a
    // session hidden behind something that has no way to show it.
    sessions.set('plain', record('plain'));

    const got = await post({ ownerSessionId: 'plain' });

    assert.strictEqual(got.status, 400);
    assert.strictEqual(got.body.error, 'unknown_owner_session');
  });

  it('refuses an owner that is not a string', async function () {
    const got = await post({ ownerSessionId: 42 });
    assert.strictEqual(got.status, 400);
    assert.strictEqual(got.body.error, 'invalid_owner_session');
  });
});
