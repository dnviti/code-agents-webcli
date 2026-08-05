const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createSessionRoutes, retireProjectSessions } = require('../dist/server/routes/sessions.js');

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
let saveSessions;

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
      saveSessionsToDisk: async () => { await saveSessions?.(); },
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

async function children(id) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/children`);
  return { status: response.status, body: await response.json().catch(() => null) };
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
    saveSessions = null;
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

  it('discovers every durable child shell from the owner-scoped server record', async function () {
    conversation('chat-children');
    const first = await post({ ownerSessionId: 'chat-children' });
    const second = await post({ ownerSessionId: 'chat-children' });
    sessions.get(first.body.sessionId).active = true;
    sessions.get(second.body.sessionId).active = false;
    sessions.set('foreign-child', record('foreign-child', {
      ownerUserId: OTHER.id,
      ownerSessionId: 'chat-children',
      active: true,
    }));

    const owned = await children('chat-children');
    assert.strictEqual(owned.status, 200);
    assert.deepStrictEqual(owned.body.sessionIds, [first.body.sessionId, second.body.sessionId]);

    currentUser = OTHER;
    const hidden = await children('chat-children');
    assert.strictEqual(hidden.status, 404, 'another account cannot use the parent as an oracle');
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

  it('drains an in-flight child create before deleting its conversation', async function () {
    conversation('chat-race');
    let announceSave;
    let releaseSave;
    const saveStarted = new Promise((resolve) => { announceSave = resolve; });
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    let gated = true;
    saveSessions = async () => {
      if (!gated) return;
      gated = false;
      announceSave();
      await saveGate;
    };

    const creating = post({ ownerSessionId: 'chat-race' });
    await saveStarted;
    const child = Array.from(sessions.values())
      .find((session) => session.ownerSessionId === 'chat-race');
    assert.ok(child, 'the child is inserted before its durable save');

    const firstDelete = remove('chat-race');
    const secondDelete = remove('chat-race');
    while (!sessions.get('chat-race').retiring) await new Promise(setImmediate);

    const lateCreate = await post({ ownerSessionId: 'chat-race' });
    assert.strictEqual(lateCreate.status, 409);
    assert.strictEqual(lateCreate.body.error, 'owner_session_retiring');

    releaseSave();
    const [created, deletedOnce, deletedTwice] = await Promise.all([
      creating,
      firstDelete,
      secondDelete,
    ]);
    assert.strictEqual(created.status, 200);
    assert.strictEqual(deletedOnce, 200);
    assert.strictEqual(deletedTwice, 200);
    assert.strictEqual(sessions.has('chat-race'), false);
    assert.strictEqual(sessions.has(child.id), false, 'the committed child cannot miss the scan');
    assert.strictEqual(
      tornDown.filter((id) => id === child.id).length,
      1,
      'concurrent deletes share child teardown',
    );
    assert.strictEqual(
      tornDown.filter((id) => id === 'chat-race').length,
      1,
      'concurrent deletes share parent teardown',
    );
  });

  it('revalidates an owned create before project retirement can miss it', async function () {
    const checkout = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-owned-create-'));
    const parent = record('project-parent', {
      surface: 'chat',
      projectId: 'project-1',
      projectWorkingDirKind: 'host',
      workingDir: checkout,
    });
    const projectSessions = new Map([[parent.id, parent]]);
    let announceEnsure;
    let releaseEnsure;
    const ensureStarted = new Promise((resolve) => { announceEnsure = resolve; });
    const ensureGate = new Promise((resolve) => { releaseEnsure = resolve; });
    const released = [];
    const projectEnvironment = {
      kind: 'host',
      name: null,
      homeDir: checkout,
      containerHome: checkout,
      shells: [],
      mounts: [],
      nodePath: process.execPath,
      toContainerPath: (value) => value,
      toHostPath: (value) => value,
      wrap: (command, args, options = {}) => ({ command, args, env: options.env || {} }),
    };
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => {
        announceEnsure();
        await ensureGate;
        return {
          ok: true,
          environment: projectEnvironment,
          workingDir: checkout,
          allowedWorkingDirs: [checkout],
          containerAccess: {
            projectId: 'project-1', ownerUserId: USER.id, containerName: 'project-1',
            containerIdentity: 'immutable-1', root: '/', workspaceRoot: '/workspace',
            ownerHomeRoot: '/home/owner',
          },
          leaseId: 'owned-create-1',
        };
      },
      releaseSessionLease: (_owner, _project, leaseId) => {
        released.push(leaseId);
        return true;
      },
      touchActivity: () => {},
    };
    const deps = {
      claudeSessions: projectSessions,
      webSocketConnections: new Map(),
      baseFolder: checkout,
      dev: false,
      validatePath: (target) => ({ valid: true, path: target }),
      getSelectedWorkingDir: () => null,
      createSessionRecord: (params) => record(params.id, params),
      getRuntimeBridge: () => null,
      stopSessionRuntime: async () => {},
      saveSessionsToDisk: async () => {},
      transcriptStore: {
        ensureTranscript: async () => {},
        deleteTranscript: async () => {},
      },
      historyStore: { deleteHistory: async () => {} },
      getScreenSnapshot: () => [],
      disposeRecorder: () => {},
      sessionStore: { getSessionMetadata: async () => ({}) },
      projectsManager,
    };
    const projectApp = express();
    projectApp.use(express.json());
    projectApp.use((_req, res, next) => {
      res.locals.authContext = { user: USER, authSessionId: 'a' };
      next();
    });
    projectApp.use(createSessionRoutes(deps));
    const projectServer = http.createServer(projectApp);
    await new Promise((resolve) => projectServer.listen(0, '127.0.0.1', resolve));
    const projectBase = `http://127.0.0.1:${projectServer.address().port}`;

    try {
      const responsePromise = fetch(`${projectBase}/api/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerSessionId: parent.id }),
      });
      await ensureStarted;

      const retirement = retireProjectSessions(deps, 'project-1');
      assert.strictEqual(parent.retiring, true, 'project retirement closes owner admission first');
      releaseEnsure();

      const response = await responsePromise;
      const body = await response.json();
      assert.strictEqual(response.status, 409);
      assert.strictEqual(body.error, 'owner_session_retiring');
      assert.deepStrictEqual(await retirement, [parent.id]);
      assert.deepStrictEqual([...projectSessions.keys()], []);
      assert.deepStrictEqual(released, ['owned-create-1']);
    } finally {
      await new Promise((resolve) => projectServer.close(resolve));
      await fs.promises.rm(checkout, { recursive: true, force: true });
    }
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
