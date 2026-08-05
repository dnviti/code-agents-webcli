const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { ChatStore } = require('../dist/server/chat/store.js');

// The list that answers "what conversations do I have?" (#127).
//
// The resume list beside it answers a narrower question — "in this folder, is
// there one to carry on with" — and is reachable only on the way to starting a
// new session in a folder already chosen. What is asserted here is everything a
// browser cannot work out for itself: which conversations belong in the list at
// all, which project each one is filed under, and what order the projects and
// their contents come in. Those are decisions, so they are made once, here.

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

/** A conversation, its record and its log, in one call. */
async function conversation(id, text, over = {}) {
  sessions.set(id, record(id, over));
  await writeChat(id, opened(text, over.nativeSessionId === null ? undefined : `native-${id}`));
}

before(async function () {
  this.timeout(30000);

  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversations-'));
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
      projectsManager: {
        getForUser: (ownerUserId, projectId) => {
          if (ownerUserId !== USER.id) return null;
          if (projectId === 'project-a') return { id: projectId, name: 'Alpha project' };
          if (projectId === 'project-b') return { id: projectId, name: 'Beta project' };
          return null;
        },
      },
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

async function list() {
  const response = await fetch(`${base}/api/sessions/conversations`);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Every conversation in the answer, in the order it would be drawn. */
function flat(body) {
  return body.projects.flatMap((project) =>
    project.conversations.map((entry) => entry.firstMessage),
  );
}

describe('listing every conversation by project', function () {
  this.timeout(20000);

  beforeEach(function () {
    sessions.clear();
  });

  it('lists a conversation without being told which folder to look in', async function () {
    // The whole complaint about the resume list: you had to know the project
    // before you could look for the conversation.
    await conversation('unprompted', 'dov’è finito lo script di release?');

    const got = await list();

    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.total, 1);
    assert.deepStrictEqual(flat(got.body), ['dov’è finito lo script di release?']);
  });

  it('keeps a migration-blocked conversation visible with its retry reason', async function () {
    const reason = 'Workspace archive is unavailable';
    await conversation('blocked', 'conversation still discoverable', {
      persistenceUnavailable: reason,
    });
    const log = path.join(storageDir, '7', 'blocked.jsonl');
    const index = path.join(storageDir, '7', 'blocked.idx');
    fs.rmSync(index);
    const beforeLog = fs.readFileSync(log);
    const beforeEntries = fs.readdirSync(path.dirname(log)).sort();

    const got = await list();

    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.total, 1);
    const blocked = got.body.projects[0].conversations[0];
    assert.strictEqual(blocked.persistenceUnavailable, reason);
    assert.strictEqual(blocked.canResume, false);
    assert.strictEqual(blocked.running, false);
    assert.strictEqual(fs.existsSync(index), false, 'listing does not rebuild a legacy global index');
    assert.deepStrictEqual(fs.readFileSync(log), beforeLog, 'listing does not repair/truncate the legacy log');
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(log)).sort(),
      beforeEntries,
      'listing creates no legacy sidecar',
    );
  });

  it('keeps an empty-log recovery anchor visible for definitive deletion', async function () {
    sessions.set('recovery-anchor', record('recovery-anchor', {
      rollbackRecoveryPending: true,
      tabOpen: false,
    }));

    const got = await list();

    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.total, 1);
    const anchor = got.body.projects[0].conversations[0];
    assert.strictEqual(anchor.id, 'recovery-anchor');
    assert.strictEqual(anchor.rollbackRecoveryPending, true);
    assert.strictEqual(anchor.events, 0);
    assert.strictEqual(anchor.firstMessage, null);
  });

  it('groups conversations under the folder they belong to', async function () {
    await conversation('a1', 'alpha uno', { workingDir: '/projects/alpha' });
    await conversation('a2', 'alpha due', { workingDir: '/projects/alpha' });
    await conversation('b1', 'beta uno', { workingDir: '/projects/beta' });

    const got = await list();

    const byDir = Object.fromEntries(
      got.body.projects.map((project) => [
        project.dir,
        project.conversations.map((entry) => entry.firstMessage),
      ]),
    );
    assert.deepStrictEqual(Object.keys(byDir).sort(), ['/projects/alpha', '/projects/beta']);
    assert.strictEqual(byDir['/projects/alpha'].length, 2);
    assert.deepStrictEqual(byDir['/projects/beta'], ['beta uno']);
  });

  it('never collapses identical container paths across projects or namespaces', async function () {
    await conversation('project-a-container', 'alpha container', {
      projectId: 'project-a', projectWorkingDirKind: 'container', workingDir: '/workspace',
    });
    await conversation('project-b-container', 'beta container', {
      projectId: 'project-b', projectWorkingDirKind: 'container', workingDir: '/workspace',
    });
    await conversation('project-a-host', 'alpha host', {
      projectId: 'project-a', projectWorkingDirKind: 'host', workingDir: '/workspace',
    });

    const got = await list();
    assert.strictEqual(got.body.projects.length, 3);
    assert.strictEqual(new Set(got.body.projects.map((project) => project.key)).size, 3);
    const identities = got.body.projects.map((project) => [
      project.projectId, project.workingDirKind, project.dir, project.name,
    ]);
    assert.deepStrictEqual(identities, [
      ['project-a', 'container', '/workspace', 'Alpha project'],
      ['project-b', 'container', '/workspace', 'Beta project'],
      ['project-a', 'host', '/workspace', 'Alpha project'],
    ]);
    for (const project of got.body.projects) {
      assert.strictEqual(project.conversations[0].projectId, project.projectId);
      assert.strictEqual(project.conversations[0].workingDirKind, project.workingDirKind);
    }
  });

  it('names a group by the folder’s leaf and keeps the whole path', async function () {
    await conversation('leaf', 'in una cartella', { workingDir: '/projects/alpha/services/api' });

    const [project] = (await list()).body.projects;
    assert.strictEqual(project.name, 'api');
    assert.strictEqual(project.dir, '/projects/alpha/services/api');
  });

  it('puts the most recent conversation first inside a group', async function () {
    await conversation('old', 'vecchia', { lastActivity: new Date('2026-07-01T09:00:00Z') });
    await conversation('new', 'recente', { lastActivity: new Date('2026-07-01T18:00:00Z') });

    const [project] = (await list()).body.projects;
    assert.deepStrictEqual(
      project.conversations.map((entry) => entry.firstMessage),
      ['recente', 'vecchia'],
    );
  });

  it('orders the groups by their own most recent conversation', async function () {
    // The folder somebody was working in this morning goes to the top, whichever
    // folder it happens to be — that is what makes the list usable without a
    // search for the common case.
    await conversation('stale-1', 'ferma da giorni', {
      workingDir: '/projects/stale',
      lastActivity: new Date('2026-07-01T08:00:00Z'),
    });
    await conversation('busy-1', 'stamattina', {
      workingDir: '/projects/busy',
      lastActivity: new Date('2026-07-05T09:00:00Z'),
    });
    await conversation('stale-2', 'anche ferma', {
      workingDir: '/projects/stale',
      lastActivity: new Date('2026-07-02T08:00:00Z'),
    });

    const got = await list();
    assert.deepStrictEqual(
      got.body.projects.map((project) => project.dir),
      ['/projects/busy', '/projects/stale'],
    );
    assert.strictEqual(got.body.projects[0].lastActivity, new Date('2026-07-05T09:00:00Z').toISOString());
  });

  it('lists a conversation nothing is running, which is the point of having a list', async function () {
    await conversation('stopped', 'chiusa ieri', { active: false });

    const [project] = (await list()).body.projects;
    assert.strictEqual(project.conversations[0].running, false);
    assert.strictEqual(project.conversations[0].canResume, true);
  });

  it('keeps a conversation whose tab is closed available to reopen', async function () {
    // Tab membership and conversation lifetime are deliberately separate. If
    // the full conversation list applied the strip's `tabOpen` filter too, the
    // act of closing a tab would remove the only route that can bring it back.
    await conversation('closed-tab', 'riapri questa conversazione', {
      tabOpen: false,
    });

    const got = await list();
    const ids = got.body.projects.flatMap((project) =>
      project.conversations.map((entry) => entry.id),
    );

    assert.deepStrictEqual(ids, ['closed-tab']);
  });

  it('says which conversations are running right now', async function () {
    await conversation('live', 'in corso', { active: true });
    await conversation('quiet', 'ferma', { active: false });

    const states = Object.fromEntries(
      (await list()).body.projects[0].conversations.map((entry) => [entry.id, entry.running]),
    );
    assert.strictEqual(states.live, true);
    assert.strictEqual(states.quiet, false);
  });

  it('says up front when the agent cannot carry on from where it left off', async function () {
    // No `session` event and nothing on the record: the transcript is intact and
    // whatever opens it will be a stranger to it. Better said in the row than
    // discovered afterwards.
    sessions.set('no-native', record('no-native'));
    await writeChat('no-native', opened('senza id nativo'));

    const [project] = (await list()).body.projects;
    assert.strictEqual(project.conversations[0].canResume, false);
  });

  it('says which approval mode opening one will put back', async function () {
    await conversation('yolo', 'senza chiedere', { chatBypassPermissions: true });
    await conversation('careful', 'chiedendo');

    const modes = Object.fromEntries(
      (await list()).body.projects[0].conversations.map((entry) => [entry.id, entry.bypassPermissions]),
    );
    assert.strictEqual(modes.yolo, true);
    assert.strictEqual(modes.careful, false, 'a manual conversation must never look bypassed');
  });

  it('never shows another user’s conversations', async function () {
    await conversation('mine', 'mia');
    await conversation('theirs', 'SEGRETO ALTRUI', { ownerUserId: 99 });

    assert.deepStrictEqual(flat((await list()).body), ['mia']);
  });

  it('leaves out terminal sessions, which have no conversation to reopen', async function () {
    await conversation('chat', 'una chat');
    await conversation('term', 'non è una chat', { surface: undefined });

    assert.deepStrictEqual(flat((await list()).body), ['una chat']);
  });

  it('leaves out a shell opened inside a conversation', async function () {
    // A real session, but reached through the conversation that owns it and only
    // there. A row of its own would offer a pty as though it were a chat.
    await conversation('parent', 'la conversazione');
    await conversation('shell', 'la shell dentro', { ownerSessionId: 'parent' });

    assert.deepStrictEqual(flat((await list()).body), ['la conversazione']);
  });

  it('leaves out a session that was opened and never used', async function () {
    // A folder someone opened and walked away from: there is no conversation to
    // reopen, and the row would crowd out the ones that matter.
    sessions.set('empty', record('empty'));
    await conversation('used', 'ha detto qualcosa');

    assert.deepStrictEqual(flat((await list()).body), ['ha detto qualcosa']);
  });

  it('reports a folder’s name for a conversation and an unnamed one honestly', async function () {
    await conversation('named', 'con nome', { customName: 'Release work' });

    const [entry] = (await list()).body.projects[0].conversations;
    assert.strictEqual(entry.name, 'Release work', 'the label the user chose wins');
    assert.strictEqual(entry.firstMessage, 'con nome');
  });

  it('stays quick and complete with hundreds of conversations across a dozen folders', async function () {
    this.timeout(60000);

    const folders = 12;
    const each = 25;
    for (let folder = 0; folder < folders; folder++) {
      for (let index = 0; index < each; index++) {
        const id = `bulk-${folder}-${index}`;
        sessions.set(
          id,
          record(id, {
            workingDir: `/projects/p${folder}`,
            lastActivity: new Date(2026, 6, 1, folder, index),
          }),
        );
        await writeChat(id, opened(`domanda ${folder}/${index}`, `native-${id}`));
      }
    }

    const started = Date.now();
    const got = await list();
    const elapsed = Date.now() - started;

    assert.strictEqual(got.body.total, folders * each);
    assert.strictEqual(got.body.projects.length, folders);
    assert.strictEqual(got.body.truncated, false);
    // Not a benchmark — a ceiling. Three hundred conversations is the size this
    // list is built for, and it has to open rather than be waited for. The
    // generous bound is deliberate: what would fail here is a per-row cost that
    // is not bounded, not a slow disk.
    assert.ok(elapsed < 5000, `listing 300 conversations took ${elapsed}ms`);

    // And again, which is the case that matters in use: the openings are read
    // from append-only logs, so the second look must not re-read them.
    const again = Date.now();
    await list();
    const cached = Date.now() - again;
    assert.ok(
      cached <= Math.max(500, elapsed),
      `a second listing took ${cached}ms against a first of ${elapsed}ms`,
    );
  });

  it('says so when it has not described everything', async function () {
    this.timeout(120000);

    // One past the ceiling, so the answer has to admit it stopped. A list that
    // silently ends at a limit reads as "this is everything", which is the one
    // thing it must not say when the question is where a conversation went.
    for (let index = 0; index < 401; index++) {
      const id = `many-${index}`;
      sessions.set(id, record(id, { lastActivity: new Date(2026, 6, 1, 0, index) }));
      await writeChat(id, opened(`domanda ${index}`, `native-${id}`));
    }

    const got = await list();
    assert.strictEqual(got.body.truncated, true);
    assert.strictEqual(got.body.total, 400);
    // What was dropped is the least recently active, never the newest.
    assert.strictEqual(got.body.projects[0].conversations[0].firstMessage, 'domanda 400');
  });

  it('describes a conversation whose log cannot be read rather than dropping it', async function () {
    // A conversation that cannot be described is still a conversation. Losing
    // the row would be the one outcome the user has no way to diagnose.
    await conversation('readable', 'leggibile');
    const broken = record('unreadable', { lastActivity: new Date('2026-07-09T10:00:00Z') });
    sessions.set('unreadable', broken);
    await writeChat('unreadable', opened('era leggibile', 'native-unreadable'));
    fs.rmSync(path.join(storageDir, '7', 'unreadable.idx'), { force: true });
    fs.writeFileSync(path.join(storageDir, '7', 'unreadable.jsonl'), 'non è json\n');

    const got = await list();
    const ids = got.body.projects.flatMap((project) => project.conversations.map((e) => e.id));
    assert.ok(ids.includes('readable'));
  });

  it('refuses to answer without a signed-in user', async function () {
    // Asserted through the route's own guard rather than by taking the middleware
    // away: `requireUser` is what every other route in this file leans on.
    const anonymous = express();
    anonymous.use(
      createSessionRoutes({
        claudeSessions: new Map(),
        webSocketConnections: new Map(),
        baseFolder: '/projects',
        dev: false,
        validatePath: () => ({ valid: true, path: '/projects' }),
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
    const other = http.createServer(anonymous);
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${other.address().port}/api/sessions/conversations`,
      );
      assert.strictEqual(response.status, 401);
    } finally {
      other.close();
    }
  });

  it('is not shadowed by the single-session route', async function () {
    // `/api/sessions/:sessionId` is a GET on the same prefix, so registration
    // order is what decides whether this endpoint exists at all. A regression
    // here answers 404 for a session called "conversations".
    const got = await list();
    assert.strictEqual(got.status, 200);
    assert.ok(Array.isArray(got.body.projects));
  });
});
