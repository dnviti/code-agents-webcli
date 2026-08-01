const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { SessionStore } = require('../dist/server/services/session-store.js');
const { createSessionRoutes, retireProjectSessions } = require('../dist/server/routes/sessions.js');
const { createWorkspaceRoutes } = require('../dist/server/routes/workspace.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { applyChatLifecycle, ClaudeCodeWebServer } = require('../dist/server/index.js');

const USER = { id: 7, githubId: '7', githubLogin: 'owner', githubName: null, avatarUrl: null, email: null };

function record(overrides = {}) {
  const now = new Date();
  return {
    id: 'session-1', ownerUserId: USER.id, name: 'Session', created: now, lastActivity: now,
    active: false, agent: null, lastAgent: null, runtimeLabel: null, terminalOptions: null,
    stopRequested: false, workingDir: os.tmpdir(), connections: new Set(), outputBuffer: [],
    termCols: 80, termRows: 24, sessionStartTime: null, sessionUsage: {}, maxBufferSize: 1000,
    ...overrides,
  };
}

function projectEnvironment() {
  return {
    kind: 'host', name: null, homeDir: os.tmpdir(), containerHome: os.tmpdir(), shells: [], mounts: [],
    nodePath: process.execPath, toContainerPath: (p) => p, toHostPath: (p) => p,
    wrap: (command, args, options = {}) => ({ command, args, env: options.env || {} }),
  };
}

describe('project session integration', function () {
  it('persists a project id and writes active state without a second migration', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-session-store-'));
    const store = new SessionStore({ dataDir });
    try {
      const ownerUserId = store.database.upsertGitHubUser({
        githubId: '7', githubLogin: 'owner', githubName: null, email: null,
      }).id;
      const now = new Date().toISOString();
      store.database.raw.prepare(`
        INSERT INTO projects (id, owner_user_id, name, state, build_log_json, last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('project-1', ownerUserId, 'Project', 'running', '[]', now, now, now);
      const sessions = new Map([['session-1', record({ ownerUserId, projectId: 'project-1', active: true })]]);
      await store.saveSessions(sessions);
      // `setActive` is deliberately followed by a normal save: autosave must
      // not erase the write-through value before the project sweep sees it.
      await store.setActive('session-1', true);
      await store.saveSessions(sessions);
      assert.strictEqual(
        store.database.raw.prepare('SELECT active FROM runtime_sessions WHERE id = ?').get('session-1').active,
        1,
      );
      await store.resetActiveFlags();
      assert.strictEqual(
        store.database.raw.prepare('SELECT active FROM runtime_sessions WHERE id = ?').get('session-1').active,
        0,
      );
      await store.setActive('session-1', true);
      assert.strictEqual((await store.loadSessions()).get('session-1').projectId, 'project-1');
    } finally {
      store.database.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('creates only owner-scoped project sessions and maps project start states', async function () {
    const sessions = new Map();
    const app = express();
    const ensured = [];
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'project-checkout-'));
    const child = path.join(checkout, 'packages', 'web');
    fs.mkdirSync(child, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-project-checkout-'));
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.authContext = { user: USER, authSessionId: 'a' }; next(); });
    app.use(createSessionRoutes({
      claudeSessions: sessions, webSocketConnections: new Map(), baseFolder: os.tmpdir(), dev: false,
      validatePath: (target) => ({ valid: true, path: target }), getSelectedWorkingDir: () => null,
      createSessionRecord: (params) => record(params), getRuntimeBridge: () => null,
      saveSessionsToDisk: async () => {}, transcriptStore: { ensureTranscript: async () => {}, deleteTranscript: async () => {} },
      historyStore: { deleteHistory: async () => {} }, getScreenSnapshot: () => [], disposeRecorder: () => {},
      sessionStore: { getSessionMetadata: async () => ({}) },
      projectsManager: {
        getForUser: (_userId, id) => id === 'owned' || id === 'limited' || id === 'building' ? { id } : null,
        ensureForSession: async (_userId, id) => {
          ensured.push(id);
          if (id === 'limited') return { ok: false, reason: 'run_limit', running: [{ id: 'p', name: 'Busy', lastActivityAt: '2026-01-01T00:00:00.000Z', hasActiveWork: true }] };
          if (id === 'building') return { ok: false, reason: 'building', detail: 'still cloning' };
          return { ok: true, environment: projectEnvironment(), workingDir: checkout };
        },
      },
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const response = await fetch(`${base}/api/sessions/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const created = await post({ projectId: 'owned' });
      assert.strictEqual(created.status, 200);
      assert.strictEqual(sessions.get(created.body.sessionId).projectId, 'owned');
      assert.strictEqual(sessions.get(created.body.sessionId).workingDir, checkout);
      assert.strictEqual((await post({ projectId: '' })).status, 400);
      assert.strictEqual((await post({ projectId: '   ' })).status, 400);
      const inCheckout = await post({ projectId: 'owned', workingDir: child });
      assert.strictEqual(inCheckout.status, 200);
      assert.strictEqual(sessions.get(inCheckout.body.sessionId).workingDir, fs.realpathSync(child));
      const escaped = await post({ projectId: 'owned', workingDir: outside });
      assert.strictEqual(escaped.status, 403);
      assert.strictEqual(escaped.body.error, 'invalid_project_working_dir');
      assert.strictEqual((await post({ projectId: 'foreign' })).status, 404);
      sessions.set('project-parent', record({
        id: 'project-parent', surface: 'chat', projectId: 'owned', workingDir: child,
      }));
      const inherited = await post({ ownerSessionId: 'project-parent' });
      assert.strictEqual(inherited.status, 200);
      assert.strictEqual(sessions.get(inherited.body.sessionId).projectId, 'owned');
      assert.strictEqual(sessions.get(inherited.body.sessionId).workingDir, fs.realpathSync(child));
      const mismatched = await post({ ownerSessionId: 'project-parent', projectId: 'limited' });
      assert.strictEqual(mismatched.status, 400);
      assert.strictEqual(mismatched.body.error, 'owner_project_mismatch');
      const inheritedEscape = await post({ ownerSessionId: 'project-parent', workingDir: outside });
      assert.strictEqual(inheritedEscape.status, 403);
      assert.strictEqual(inheritedEscape.body.error, 'invalid_project_working_dir');
      const limited = await post({ projectId: 'limited' });
      assert.deepStrictEqual(limited, { status: 409, body: { error: 'run_limit', running: [{ id: 'p', name: 'Busy', lastActivityAt: '2026-01-01T00:00:00.000Z', hasActiveWork: true }] } });
      const building = await post({ projectId: 'building' });
      assert.strictEqual(building.body.error, 'project_building');
      assert.deepStrictEqual(
        ensured,
        ['owned', 'owned', 'owned', 'owned', 'owned', 'limited', 'building'],
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(checkout, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('persists both chat lifecycle directions through the composition seam', function () {
    const session = record({ id: 'chat-lifecycle' });
    const writes = [];
    const writeActive = (id, active) => { writes.push([id, active]); };
    applyChatLifecycle(session, { exited: false }, writeActive);
    applyChatLifecycle(session, { exited: true }, writeActive);
    assert.deepStrictEqual(writes, [
      ['chat-lifecycle', true],
      ['chat-lifecycle', false],
    ]);
    assert.strictEqual(session.active, false);
  });

  it('wires the real processor store and chat lifecycle writer', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-composition-'));
    const server = new ClaudeCodeWebServer({ dataDir, port: 0, noAuth: true });
    try {
      assert.strictEqual(server.messageProcessor.deps.sessionStore, server.sessionStore);
      const owner = server.database.upsertGitHubUser({
        githubId: 'composition-7', githubLogin: 'composition-owner', githubName: null, email: null,
      });
      const session = record({ id: 'composed-chat', ownerUserId: owner.id, surface: 'chat' });
      server.claudeSessions.set(session.id, session);
      const writes = [];
      server.sessionStore.setActive = async (id, active) => { writes.push([id, active]); };

      server.chatManager.deps.onLifecycle(session.id, { exited: false });
      server.chatManager.deps.onLifecycle(session.id, { exited: true });
      await Promise.resolve();

      assert.deepStrictEqual(writes, [
        ['composed-chat', true],
        ['composed-chat', false],
      ]);
    } finally {
      await server.shutdown();
      // The constructor registers a beforeExit callback; make its eventual
      // invocation harmless after shutdown has closed this test database.
      server.saveSessionsToDisk = async () => {};
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs terminal and chat project records in the project environment and writes active transitions', async function () {
    const project = projectEnvironment();
    const sessions = new Map([['session-1', record({ projectId: 'project-1' })]]);
    const active = [];
    const launches = [];
    const processor = new MessageProcessor({
      dev: false, claudeSessions: sessions,
      webSocketConnections: new Map([['ws', { id: 'ws', ws: { readyState: 1, send() {} }, userId: USER.id, githubLogin: USER.githubLogin, claudeSessionId: 'session-1', chatSessionIds: new Set(), created: new Date() }]]),
      baseFolder: os.tmpdir(), sessionDurationHours: 1, aliases: { claude: 'Claude', terminal: 'Terminal' },
      validatePath: () => ({ valid: false, error: 'outside' }), getSelectedWorkingDir: () => null,
      createSessionRecord: (params) => record(params), getRuntimeBridge: () => ({
        startSession: async (_id, options) => { launches.push(options); return { runtimeLabel: 'Terminal' }; },
        stopSession: async () => {}, sendInput: async () => {}, resize: async () => {},
      }), saveSessionsToDisk: async () => {}, resolveRuntimeProfile: () => null,
      getUserPreferences: () => ({ chatBypassPermissions: false }),
      ensureEnvironment: async () => { throw new Error('legacy environment must not be used'); },
      projectsManager: {
        getForUser: () => ({ id: 'project-1', name: 'Project One' }),
        ensureForSession: async () => ({ ok: true, environment: project, workingDir: '/workspace/repo' }),
      },
      sessionStore: { setActive: async (_id, value) => { active.push(value); } },
      transcriptStore: { appendOutput() {}, ensureTranscript: async () => {}, readTranscriptChunks: async () => [] },
      historyStore: { append() {}, stat: async () => ({ firstLine: 0, totalLines: 0 }), read: async () => ({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }) },
      usageReader: {}, usageAnalytics: {},
      chatManager: {
        has: () => false, snapshot: async () => ({}), send: async () => {}, interrupt: async () => {},
        setModel: async () => false, rememberModel: () => {}, setEffort: async () => false, rememberEffort: () => {},
        cancelQueued: () => false, sendQueuedNow: async () => false, retryQueued: () => false,
        respondPermission: () => false, answerQuestion: () => false, readPage: async () => ({ events: [], firstSeq: 0, from: 0, cursor: 0 }),
        turnIndex: async () => ({ turns: [], firstSeq: 0, complete: true }), stop: async () => {},
        start: async (_record, options) => { launches.push(options); return { runtimeKind: 'claude', currentCapabilities: {}, bypassing: false }; },
      },
    });
    await processor.startRuntime('ws', 'terminal');
    assert.strictEqual(launches[0].environment, project);
    assert.strictEqual(sessions.get('session-1').workingDir, '/workspace/repo');
    await processor.stopRuntime('session-1', 'terminal');
    sessions.get('session-1').surface = 'chat';
    await processor.startChat('ws', 'claude');
    assert.strictEqual(launches[1].environment, project);
    await processor.stopRuntime('session-1', 'claude');
    assert.deepStrictEqual(active, [true, false, true, false]);
  });

  it('uses the project environment for workspace commands without host fallback', async function () {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-workspace-'));
    const project = projectEnvironment();
    let ensures = 0;
    const sessions = new Map([['session-1', record({ projectId: 'project-1', workingDir: directory })]]);
    const app = express();
    app.use((_req, res, next) => { res.locals.authContext = { user: USER, authSessionId: 'a' }; next(); });
    app.use(createWorkspaceRoutes({
      claudeSessions: sessions, validatePath: () => ({ valid: true, path: directory }),
      ensureEnvironment: async () => { throw new Error('legacy environment must not be used'); },
      projectsManager: {
        getForUser: () => ({ id: 'project-1' }),
        ensureForSession: async () => { ensures++; return { ok: true, environment: project, workingDir: directory }; },
      },
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/session-1/status`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(ensures, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  it('retires a deleted project and every owned shell instead of orphaning them in legacy env', async function () {
    const sessions = new Map([
      ['project-chat', record({ id: 'project-chat', projectId: 'project-1', surface: 'chat', active: true, agent: 'claude' })],
      ['project-shell', record({ id: 'project-shell', ownerSessionId: 'project-chat', active: true, agent: 'terminal' })],
      ['nested-shell', record({ id: 'nested-shell', ownerSessionId: 'project-shell' })],
      ['other-project', record({ id: 'other-project', projectId: 'project-2' })],
    ]);
    const stopped = [];
    const transcripts = [];
    const histories = [];
    const recorders = [];
    const teardown = [];
    const order = [];
    let saves = 0;
    let releaseChatStop;
    let announceChatStop;
    const chatStopStarted = new Promise((resolve) => { announceChatStop = resolve; });
    const retirement = retireProjectSessions({
      claudeSessions: sessions, webSocketConnections: new Map(), baseFolder: os.tmpdir(), dev: false,
      validatePath: () => ({ valid: true, path: os.tmpdir() }), getSelectedWorkingDir: () => null,
      createSessionRecord: (params) => record(params), getRuntimeBridge: () => { throw new Error('unified stop hook was bypassed'); },
      stopSessionRuntime: async (session) => {
        const kind = session.surface === 'chat' ? 'chat-manager' : 'terminal-bridge';
        if (session.surface === 'chat') {
          announceChatStop();
          await new Promise((resolve) => { releaseChatStop = resolve; });
        }
        stopped.push(`${kind}:${session.id}`);
        order.push(`stop:${session.id}`);
      },
      saveSessionsToDisk: async () => { saves++; },
      transcriptStore: { ensureTranscript: async () => {}, deleteTranscript: async (session) => { transcripts.push(session.id); order.push(`transcript:${session.id}`); } },
      historyStore: { deleteHistory: async (session) => { histories.push(session.id); order.push(`history:${session.id}`); } },
      getScreenSnapshot: () => [], disposeRecorder: (id) => { recorders.push(id); },
      sessionStore: { getSessionMetadata: async () => ({}) },
      sessionTeardown: { dispose: (session) => { teardown.push(session.id); } },
    }, 'project-1');
    await chatStopStarted;
    assert.strictEqual(sessions.has('project-chat'), true, 'record remains until chat stop resolves');
    assert.deepStrictEqual(transcripts, [], 'stored state is untouched while the process is live');
    releaseChatStop();
    const retired = await retirement;
    assert.deepStrictEqual(retired.sort(), ['nested-shell', 'project-chat', 'project-shell']);
    assert.deepStrictEqual([...sessions.keys()], ['other-project']);
    assert.deepStrictEqual(stopped.sort(), [
      'chat-manager:project-chat',
      'terminal-bridge:project-shell',
    ]);
    assert(order.indexOf('stop:project-chat') < order.indexOf('transcript:project-chat'));
    assert(order.indexOf('stop:project-shell') < order.indexOf('transcript:project-shell'));
    assert.deepStrictEqual(transcripts.sort(), retired.slice().sort());
    assert.deepStrictEqual(histories.sort(), retired.slice().sort());
    assert.deepStrictEqual(recorders.sort(), retired.slice().sort());
    assert.deepStrictEqual(teardown.sort(), retired.slice().sort());
    assert.strictEqual(saves, 1);
  });
});
