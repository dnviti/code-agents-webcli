const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { ChatStore } = require('../dist/server/chat/store.js');

// Choosing a conversation to carry on with, the web counterpart of
// `claude --resume`. The list is what makes it usable, so what is tested here
// is what the list says: whose conversations it shows, which folder's, whether
// each one can actually be resumed, and what it is called — because a column of
// timestamps identifies nothing and a person cannot pick from it.

const USER = { id: 7, githubId: '1', githubLogin: 'tester', githubName: null, avatarUrl: null, email: null };

let storageDir;
let chatStore;
let sessions;
let server;
let base;

function record(id, over = {}) {
  return {
    id,
    ownerUserId: 7,
    name: `Session ${id}`,
    created: new Date('2026-07-01T10:00:00Z'),
    lastActivity: new Date('2026-07-01T10:00:00Z'),
    active: false,
    agent: null,
    lastAgent: 'claude',
    runtimeLabel: 'Claude',
    surface: 'chat',
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

/** A conversation on disk, exactly as the session writes one. */
function writeChat(id, events) {
  chatStore.append({ id, ownerUserId: 7 }, events);
  return chatStore.stat({ id, ownerUserId: 7 });
}

function opened(text, nativeSessionId) {
  const events = [
    { t: 'state', state: 'idle', seq: 1, ts: 1 },
    { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1', seq: 2, ts: 2 },
    { t: 'block_start', msgId: 'u1', index: 0, block: { kind: 'text', text }, seq: 3, ts: 3 },
    { t: 'msg_end', msgId: 'u1', seq: 4, ts: 4 },
  ];
  if (nativeSessionId) {
    events.push({ t: 'session', nativeSessionId, capabilities: {}, seq: 5, ts: 5 });
  }
  return events;
}

before(async function () {
  this.timeout(30000);

  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumable-'));
  chatStore = new ChatStore({ storageDir });
  sessions = new Map();

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: USER, authSessionId: 'a' };
    next();
  });
  app.use(
    createSessionRoutes({
      claudeSessions: sessions,
      webSocketConnections: new Map(),
      baseFolder: '/projects',
      dev: false,
      // Everything under /projects is allowed; anything else is not.
      validatePath: (target) =>
        target.startsWith('/projects')
          ? { valid: true, path: target }
          : { valid: false, error: 'outside' },
      createSessionRecord: () => record('unused'),
      getRuntimeBridge: () => null,
      saveSessionsToDisk: async () => {},
      transcriptStore: {},
      historyStore: {},
      getScreenSnapshot: () => [],
      disposeRecorder: () => {},
      getSelectedWorkingDir: () => null,
      sessionStore: { getSessionMetadata: async () => ({}) },
      chatStore,
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
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
});

async function list(dir) {
  const response = await fetch(`${base}/api/sessions/resumable?dir=${encodeURIComponent(dir)}`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe('listing conversations to resume', function () {
  this.timeout(20000);

  beforeEach(function () {
    sessions.clear();
  });

  it('offers a conversation by what was said in it, not by when it happened', async function () {
    sessions.set('by-message', record('by-message'));
    await writeChat('by-message', opened('che file ho caricato?', 'native-7'));

    const got = await list('/projects/alpha');

    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.conversations.length, 1);
    const entry = got.body.conversations[0];
    assert.strictEqual(entry.firstMessage, 'che file ho caricato?');
    assert.strictEqual(entry.canResume, true);
    assert.strictEqual(entry.runtimeLabel, 'Claude');
    assert.ok(entry.events > 0);
  });

  it('says when a conversation can be opened but not truly resumed', async function () {
    // No `session` event: the transcript is intact and the agent that reads it
    // will be a stranger to it. Better said in the list than discovered after.
    sessions.set('no-native', record('no-native'));
    await writeChat('no-native', opened('senza id nativo'));

    const got = await list('/projects/alpha');
    assert.strictEqual(got.body.conversations[0].canResume, false);
  });

  it('shows only the folder that was asked about', async function () {
    // Ids unique per test: the log is append-only, so reusing one would read
    // back the previous test's opening line.
    sessions.set('dir-alpha', record('dir-alpha', { workingDir: '/projects/alpha' }));
    sessions.set('dir-beta', record('dir-beta', { workingDir: '/projects/beta' }));
    await writeChat('dir-alpha', opened('alpha', 'n1'));
    await writeChat('dir-beta', opened('beta', 'n2'));

    const got = await list('/projects/beta');
    assert.deepStrictEqual(got.body.conversations.map((c) => c.firstMessage), ['beta']);
  });

  it('never shows another user’s conversations', async function () {
    sessions.set('mine', record('mine'));
    sessions.set('theirs', record('theirs', { ownerUserId: 99 }));
    await writeChat('mine', opened('mia', 'n1'));
    await writeChat('theirs', opened('SEGRETO ALTRUI', 'n2'));

    const got = await list('/projects/alpha');
    const texts = got.body.conversations.map((c) => c.firstMessage);
    assert.deepStrictEqual(texts, ['mia']);
  });

  it('leaves out a terminal session, which has no conversation to resume', async function () {
    sessions.set('term', record('term', { surface: undefined }));
    await writeChat('term', opened('non è una chat', 'n1'));

    const got = await list('/projects/alpha');
    assert.deepStrictEqual(got.body.conversations, []);
  });

  it('leaves out a session that was opened and never used', async function () {
    // A folder someone opened and walked away from. Offering to "resume" it
    // would resume nothing, and it would crowd out the ones that matter.
    sessions.set('empty', record('empty'));

    const got = await list('/projects/alpha');
    assert.deepStrictEqual(got.body.conversations, []);
  });

  it('says which approval mode picking one will put back', async function () {
    // Resuming restores the mode the conversation was running in, and a bypass
    // is a standing permission: it has to be visible in the offer rather than
    // discovered when the agent stops asking.
    sessions.set('yolo', record('yolo', { chatBypassPermissions: true }));
    sessions.set('careful', record('careful'));
    await writeChat('yolo', opened('senza chiedere', 'n1'));
    await writeChat('careful', opened('chiedendo', 'n2'));

    const got = await list('/projects/alpha');
    const modes = Object.fromEntries(
      got.body.conversations.map((c) => [c.id, c.bypassPermissions]),
    );
    assert.strictEqual(modes.yolo, true);
    assert.strictEqual(modes.careful, false, 'a manual conversation must never look bypassed');
  });

  it('marks one that is already running, because that is a join and not a resume', async function () {
    sessions.set('live', record('live', { active: true }));
    await writeChat('live', opened('in corso', 'n1'));

    const got = await list('/projects/alpha');
    assert.strictEqual(got.body.conversations[0].running, true);
  });

  it('puts the most recent first, which is nearly always the one wanted', async function () {
    sessions.set('old', record('old', { lastActivity: new Date('2026-07-01T09:00:00Z') }));
    sessions.set('new', record('new', { lastActivity: new Date('2026-07-01T18:00:00Z') }));
    await writeChat('old', opened('vecchia', 'n1'));
    await writeChat('new', opened('recente', 'n2'));

    const got = await list('/projects/alpha');
    assert.deepStrictEqual(got.body.conversations.map((c) => c.firstMessage), ['recente', 'vecchia']);
  });

  it('refuses a folder outside the allowed base', async function () {
    assert.strictEqual((await list('/etc')).status, 403);
  });

  it('refuses to answer with no folder named', async function () {
    const response = await fetch(`${base}/api/sessions/resumable`);
    assert.strictEqual(response.status, 400);
  });
});
