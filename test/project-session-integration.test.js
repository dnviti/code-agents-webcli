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
const { ChatSessionManager } = require('../dist/server/chat/manager.js');
const chatRegistry = require('../dist/server/chat/registry.js');
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

function processorDeps({
  sessions,
  connections,
  projectsManager,
  bridge,
  transcriptStore,
  chatManager,
  saveSessionsToDisk,
}) {
  return {
    dev: false,
    claudeSessions: sessions,
    webSocketConnections: connections,
    baseFolder: os.tmpdir(),
    sessionDurationHours: 1,
    aliases: {
      claude: 'Claude', codex: 'Codex', agent: 'Agent', pi: 'Pi', grok: 'Grok',
      qwen: 'Qwen', kimi: 'Kimi', omp: 'OMP', antigravity: 'Antigravity', terminal: 'Terminal',
    },
    validatePath: () => ({ valid: false, error: 'outside' }),
    getSelectedWorkingDir: () => null,
    createSessionRecord: (params) => record(params),
    getRuntimeBridge: () => bridge,
    saveSessionsToDisk: saveSessionsToDisk || (async () => {}),
    resolveRuntimeProfile: () => null,
    ensureEnvironment: async () => { throw new Error('legacy environment must not be used'); },
    projectsManager,
    ...(chatManager ? { chatManager } : {}),
    sessionStore: { setActive: async () => {} },
    transcriptStore: transcriptStore || {
      appendOutput() {}, ensureTranscript: async () => {}, readTranscriptChunks: async () => [],
    },
    historyStore: {
      append() {}, stat: async () => ({ firstLine: 0, totalLines: 0 }),
      read: async () => ({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }),
    },
    usageReader: {},
    usageAnalytics: {},
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
      const sessions = new Map([['session-1', record({
        ownerUserId,
        projectId: 'project-1',
        projectWorkingDirKind: 'container',
        active: true,
      })]]);
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
      const restored = (await store.loadSessions()).get('session-1');
      assert.strictEqual(restored.projectId, 'project-1');
      assert.strictEqual(restored.projectWorkingDirKind, 'container');
    } finally {
      store.database.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('creates only owner-scoped project sessions and maps project start states', async function () {
    const sessions = new Map();
    const announcements = [];
    const connections = new Map([['other-screen', {
      id: 'other-screen',
      userId: USER.id,
      ws: { readyState: 1, send: (payload) => announcements.push(JSON.parse(payload)) },
    }]]);
    const app = express();
    const ensured = [];
    const released = [];
    let nextLease = 0;
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'project-checkout-'));
    const child = path.join(checkout, 'packages', 'web');
    fs.mkdirSync(child, { recursive: true });
    const persistentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'project-owner-home-'));
    const homeChild = path.join(persistentHome, 'notes');
    fs.mkdirSync(homeChild, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-project-checkout-'));
    const escapedLink = path.join(checkout, 'escaped-link');
    fs.symlinkSync(outside, escapedLink);
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.authContext = { user: USER, authSessionId: 'a' }; next(); });
    app.use(createSessionRoutes({
      claudeSessions: sessions, webSocketConnections: connections, baseFolder: os.tmpdir(), dev: false,
      validatePath: (target) => ({ valid: true, path: target }), getSelectedWorkingDir: () => null,
      createSessionRecord: (params) => record(params), getRuntimeBridge: () => null,
      saveSessionsToDisk: async () => {}, transcriptStore: { ensureTranscript: async () => {}, deleteTranscript: async () => {} },
      historyStore: { deleteHistory: async () => {} }, getScreenSnapshot: () => [], disposeRecorder: () => {},
      sessionStore: { getSessionMetadata: async () => ({}) },
      projectsManager: {
        getForUser: (_userId, id) => ['owned', 'limited', 'building', 'shutdown'].includes(id)
          ? { id, name: id === 'owned' ? 'Owned project' : id }
          : null,
        ensureForSession: async (_userId, id) => {
          ensured.push(id);
          if (id === 'limited') return { ok: false, reason: 'run_limit', running: [{ id: 'p', name: 'Busy', lastActivityAt: '2026-01-01T00:00:00.000Z', hasActiveWork: true }] };
          if (id === 'building') return { ok: false, reason: 'building', detail: 'still cloning' };
          if (id === 'shutdown') return { ok: false, reason: 'shutting_down', detail: 'server stopping' };
          return {
            ok: true, environment: projectEnvironment(), workingDir: checkout,
            allowedWorkingDirs: [checkout, persistentHome], leaseId: `lease-${++nextLease}`,
          };
        },
        releaseSessionLease: (userId, id, leaseId) => { released.push([userId, id, leaseId]); return true; },
        touchActivity: () => {},
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
      assert.strictEqual(created.body.session.projectName, 'Owned project');
      assert.strictEqual(created.body.session.projectWorkingDirKind, 'host');
      assert.strictEqual(
        announcements.find((message) => message.sessionId === created.body.sessionId).projectName,
        'Owned project',
      );
      assert.strictEqual((await post({ projectId: '' })).status, 400);
      assert.strictEqual((await post({ projectId: '   ' })).status, 400);
      const inCheckout = await post({ projectId: 'owned', workingDir: child });
      assert.strictEqual(inCheckout.status, 200);
      assert.strictEqual(sessions.get(inCheckout.body.sessionId).workingDir, fs.realpathSync(child));
      const inHome = await post({ projectId: 'owned', workingDir: homeChild });
      assert.strictEqual(inHome.status, 200);
      assert.strictEqual(sessions.get(inHome.body.sessionId).workingDir, fs.realpathSync(homeChild));
      const escaped = await post({ projectId: 'owned', workingDir: outside });
      assert.strictEqual(escaped.status, 403);
      assert.strictEqual(escaped.body.error, 'invalid_project_working_dir');
      const symlinkEscape = await post({ projectId: 'owned', workingDir: escapedLink });
      assert.strictEqual(symlinkEscape.status, 403);
      assert.strictEqual(symlinkEscape.body.error, 'invalid_project_working_dir');
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
      const shutdown = await post({ projectId: 'shutdown' });
      assert.strictEqual(shutdown.status, 503);
      assert.strictEqual(shutdown.body.error, 'project_unavailable');
      assert.deepStrictEqual(
        ensured,
        ['owned', 'owned', 'owned', 'owned', 'owned', 'owned', 'owned', 'limited', 'building', 'shutdown'],
      );
      assert.deepStrictEqual(
        released,
        Array.from({ length: 7 }, (_, index) => [USER.id, 'owned', `lease-${index + 1}`]),
        'every successful REST admission is released, including rejected cwd requests',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(checkout, { recursive: true, force: true });
      fs.rmSync(persistentHome, { recursive: true, force: true });
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
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-runtime-workspace-'));
    const checkout = path.join(workspace, 'repo');
    const ownerHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-runtime-home-'));
    const retainedCwd = path.join(ownerHome, 'notes');
    await fs.promises.mkdir(checkout, { recursive: true });
    await fs.promises.mkdir(retainedCwd, { recursive: true });
    const project = { ...projectEnvironment(), homeDir: ownerHome, containerHome: '/home/owner' };
    const sessions = new Map([['session-1', record({
      projectId: 'project-1', workingDir: retainedCwd, connections: new Set(['ws']),
    })]]);
    const active = [];
    const launches = [];
    const released = [];
    let nextLease = 0;
    let immediateChatExit = false;
    let processor;
    processor = new MessageProcessor({
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
        ensureForSession: async () => ({
          ok: true, environment: project, workingDir: checkout,
          allowedWorkingDirs: [workspace, ownerHome], leaseId: `runtime-${++nextLease}`,
        }),
        releaseSessionLease: (_userId, _projectId, leaseId) => { released.push(leaseId); return true; },
        touchActivity: () => {},
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
        start: async (chatRecord, options) => {
          launches.push(options);
          if (immediateChatExit) {
            processor.handleChatLifecycle(chatRecord.id, { exited: true, restarting: false });
            return { runtimeKind: 'claude', currentCapabilities: {}, bypassing: false, live: false };
          }
          return { runtimeKind: 'claude', currentCapabilities: {}, bypassing: false, live: true };
        },
      },
    });
    try {
      await processor.startRuntime('ws', 'terminal');
      assert.strictEqual(launches[0].environment, project);
      assert.strictEqual(sessions.get('session-1').workingDir, fs.realpathSync(retainedCwd));
      await processor.stopRuntime('session-1', 'terminal');
      sessions.get('session-1').surface = 'chat';
      await processor.startChat('ws', 'claude');
      assert.strictEqual(launches[1].environment, project);
      processor.handleChatLifecycle('session-1', { exited: true, restarting: true });
      processor.handleChatLifecycle('session-1', { exited: false });
      assert.deepStrictEqual(released, ['runtime-1'], 'a /clear hand-off retains its runtime lease');
      await processor.stopRuntime('session-1', 'claude');
      immediateChatExit = true;
      await processor.startChat('ws', 'claude');
      assert.strictEqual(sessions.get('session-1').active, false, 'an immediate chat exit is not resurrected');
      processor.cleanupConnection('ws');
      processor.cleanupConnection('ws');
      assert.deepStrictEqual(active, [true, false, true, false, false]);
      assert.deepStrictEqual(
        released,
        ['runtime-1', 'runtime-2', 'runtime-4', 'runtime-3'],
        'terminal, chat runtimes and chat subscription leases each release once',
      );
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
      await fs.promises.rm(ownerHome, { recursive: true, force: true });
    }
  });

  it('keeps the project runtime admission across a rejected ladder probe and its delayed exit', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-chat-fallback-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const session = record({
      projectId: 'project-1',
      projectWorkingDirKind: 'host',
      workingDir: checkout,
      connections: new Set(['ws']),
    });
    const sessions = new Map([[session.id, session]]);
    const connections = new Map([['ws', {
      id: 'ws',
      ws: { readyState: 1, send() {} },
      userId: USER.id,
      githubLogin: USER.githubLogin,
      claudeSessionId: session.id,
      chatSessionIds: new Set(),
      created: new Date(),
    }]]);
    let ensures = 0;
    const released = [];
    const environment = projectEnvironment();
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true,
        environment,
        workingDir: checkout,
        allowedWorkingDirs: [workspace],
        containerAccess: {
          projectId: 'project-1',
          ownerUserId: USER.id,
          containerName: 'project-1',
          root: '/',
          workspaceRoot: '/workspace',
          ownerHomeRoot: '/home/owner',
        },
        leaseId: `fallback-${++ensures}`,
      }),
      releaseSessionLease: (_owner, _project, leaseId) => {
        released.push(leaseId);
        return true;
      },
      touchActivity: () => {},
      execInSessionContainer: async () => { throw new Error('file access was not requested'); },
      spawnSessionFileCommand: async () => { throw new Error('file access was not requested'); },
    };
    const events = [];
    const chatStore = {
      append(_ref, batch) { events.push(...batch); },
      async stat() { return { firstSeq: 1, cursor: events.length }; },
      async read() { return { events: [], firstSeq: 1, from: 1, cursor: events.length }; },
      async snapshot() {
        return {
          sessionId: session.id, runtime: 'claude', messages: [], state: 'idle',
          capabilities: {}, pendingPermissions: [], firstSeq: 1, cursor: events.length,
          live: true, bypassPermissions: true,
        };
      },
    };

    const realCreate = chatRegistry.createChatAdapter;
    let adapterStarts = 0;
    let processor;
    const storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-chat-manager-'));
    const chatManager = new ChatSessionManager({
      store: chatStore,
      storageDir,
      broadcast: () => {},
      resolveCommand: () => '/not-used',
      resolveCommandName: () => 'not-used',
      onLifecycle: (sessionId, change) => {
        const current = sessions.get(sessionId);
        if (current) applyChatLifecycle(current, change);
        processor.handleChatLifecycle(sessionId, change);
      },
    });
    // Keep the test about lifecycle rather than permission-socket setup.
    chatManager.hookScript = path.join(storageDir, 'missing-hook.js');
    chatManager.askScript = path.join(storageDir, 'missing-ask.js');

    chatRegistry.createChatAdapter = (_runtime, options) => {
      const attempt = ++adapterStarts;
      let alive = true;
      return {
        runtime: 'claude',
        capabilities: { permissions: false, streaming: true },
        get alive() { return alive; },
        async start() {
          if (attempt !== 1) return;
          alive = false;
          options.emit({ t: 'state', state: 'exited' });
          throw new Error('model unavailable');
        },
        async send() {},
        async interrupt() {},
        respondPermission() { return false; },
        async stop() {
          alive = false;
          // `BaseChatAdapter.stop()` does not await process close. This second
          // exit stands in for that late close and must be generation-stale.
          options.emit({ t: 'state', state: 'exited' });
        },
      };
    };

    const deps = processorDeps({
      sessions,
      connections,
      projectsManager,
      bridge: null,
      chatManager,
    });
    deps.resolveRuntimeProfile = () => ({
      profileId: 'economy',
      profileName: 'Economy',
      ladder: { tier: 'mid', model: 'unavailable-model' },
      tiers: { mid: 'unavailable-model' },
    });
    deps.getUserPreferences = () => ({ chatBypassPermissions: true });
    processor = new MessageProcessor(deps);

    try {
      await processor.startChat('ws', 'claude');
      assert.strictEqual(adapterStarts, 2, 'the rejected rung is retried on the runtime default');
      assert.strictEqual(session.active, true, 'the failed probe cannot retire the successful fallback');
      assert.strictEqual(ensures, 2, 'one runtime lease and one subscription lease are sufficient');
      assert.deepStrictEqual(released, [], 'the fallback still owns both admissions while live');

      await processor.stopRuntime(session.id, 'claude');
      processor.cleanupConnection('ws');
      assert.strictEqual(session.active, false);
      assert.deepStrictEqual(released, ['fallback-1', 'fallback-2']);
    } finally {
      chatRegistry.createChatAdapter = realCreate;
      await chatManager.stopAll().catch(() => undefined);
      await fs.promises.rm(storageDir, { recursive: true, force: true });
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('serializes concurrent launches before active state is visible', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-launch-race-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const sessions = new Map([['session-1', record({
      projectId: 'project-1', workingDir: checkout, connections: new Set(['ws']),
    })]]);
    const sent = [];
    const connections = new Map([['ws', {
      id: 'ws', ws: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) },
      userId: USER.id, githubLogin: USER.githubLogin, claudeSessionId: 'session-1',
      chatSessionIds: new Set(), created: new Date(),
    }]]);
    let ensureCalls = 0;
    let starts = 0;
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const released = [];
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true, environment: projectEnvironment(), workingDir: checkout,
        allowedWorkingDirs: [workspace], leaseId: `lease-${++ensureCalls}`,
      }),
      releaseSessionLease: (_owner, _project, leaseId) => { released.push(leaseId); return true; },
      touchActivity: () => {},
    };
    const bridge = {
      startSession: async () => { starts++; await startGate; return { runtimeLabel: 'Terminal' }; },
      stopSession: async () => {}, sendInput: async () => {}, resize: async () => {},
    };
    const processor = new MessageProcessor(processorDeps({
      sessions, connections, projectsManager, bridge,
    }));

    try {
      const first = processor.startRuntime('ws', 'terminal');
      await Promise.resolve();
      assert.strictEqual(processor.hasPendingProjectWork('project-1'), true);
      let drained = false;
      const drain = processor.drainPendingRuntimeStarts().then(() => { drained = true; });
      await Promise.resolve();
      assert.strictEqual(drained, false, 'shutdown waits for the in-flight launch');
      await processor.startRuntime('ws', 'terminal');
      releaseStart();
      await first;
      await drain;

      assert.strictEqual(processor.hasPendingProjectWork('project-1'), false);
      assert.strictEqual(drained, true);
      assert.strictEqual(ensureCalls, 1);
      assert.strictEqual(starts, 1);
      assert.ok(sent.some((message) => /already starting/.test(message.message || '')));
      await processor.stopRuntime('session-1', 'terminal');
      assert.deepStrictEqual(released, ['lease-1']);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('retains an active terminal record and lease when its bridge is no longer registered', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-missing-bridge-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const session = record({
      projectId: 'project-1',
      projectWorkingDirKind: 'host',
      workingDir: checkout,
      connections: new Set(['ws']),
    });
    const sessions = new Map([[session.id, session]]);
    const connections = new Map([['ws', {
      id: 'ws', ws: { readyState: 1, send() {} }, userId: USER.id,
      githubLogin: USER.githubLogin, claudeSessionId: session.id,
      chatSessionIds: new Set(), created: new Date(),
    }]]);
    const released = [];
    const activeWrites = [];
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true, environment: projectEnvironment(), workingDir: checkout,
        allowedWorkingDirs: [workspace], leaseId: 'missing-bridge-runtime',
      }),
      releaseSessionLease: (_owner, _project, leaseId) => { released.push(leaseId); return true; },
      touchActivity: () => {},
    };
    const bridge = {
      startSession: async () => ({ runtimeLabel: 'Terminal' }),
      stopSession: async () => { throw new Error('the removed bridge must not be called'); },
      sendInput: async () => {},
      resize: async () => {},
    };
    const deps = processorDeps({ sessions, connections, projectsManager, bridge });
    deps.sessionStore = { setActive: async (_id, active) => { activeWrites.push(active); } };
    const processor = new MessageProcessor(deps);

    try {
      await processor.startRuntime('ws', 'terminal');
      assert.strictEqual(session.active, true);
      processor.deps.getRuntimeBridge = () => null;

      await assert.rejects(
        processor.stopRuntime(session.id, 'terminal'),
        /bridge unavailable/,
      );

      assert.strictEqual(session.active, true);
      assert.strictEqual(session.agent, 'terminal');
      assert.deepStrictEqual(released, []);
      assert.deepStrictEqual(activeWrites, [true]);
      processor.cleanupConnection('ws');
      assert.strictEqual(session.connections.size, 0);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('retires a manager-owned chat even when its record was stale-inactive', async function () {
    const session = record({
      surface: 'chat',
      active: false,
      agent: null,
      lastAgent: 'claude',
    });
    const sessions = new Map([[session.id, session]]);
    const activeWrites = [];
    let stops = 0;
    const chatManager = {
      has: (id) => id === session.id,
      stop: async () => { stops += 1; },
    };
    const deps = processorDeps({
      sessions,
      connections: new Map(),
      projectsManager: undefined,
      bridge: null,
      chatManager,
    });
    deps.sessionStore = {
      setActive: async (_id, value) => { activeWrites.push(value); },
    };
    const processor = new MessageProcessor(deps);

    await processor.retireSessionRuntime(session);

    assert.strictEqual(stops, 1);
    assert.strictEqual(session.retiring, true);
    assert.strictEqual(session.active, false);
    assert.strictEqual(session.agent, null);
    assert.deepStrictEqual(activeWrites, [true, false]);
  });

  it('rolls back a project join and its lease when transcript replay fails', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-join-rollback-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const session = record({ id: 'session-1', projectId: 'project-1', workingDir: checkout });
    const sessions = new Map([[session.id, session]]);
    const connections = new Map([['ws', {
      id: 'ws', ws: { readyState: 1, send() {} }, userId: USER.id,
      githubLogin: USER.githubLogin, claudeSessionId: null,
      chatSessionIds: new Set(), created: new Date(),
    }]]);
    const released = [];
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true, environment: projectEnvironment(), workingDir: checkout,
        allowedWorkingDirs: [workspace], leaseId: 'join-1',
      }),
      releaseSessionLease: (_owner, _project, leaseId) => { released.push(leaseId); return true; },
      touchActivity: () => {},
    };
    const bridge = {
      startSession: async () => ({}), stopSession: async () => {},
      sendInput: async () => {}, resize: async () => {},
    };
    const processor = new MessageProcessor(processorDeps({
      sessions, connections, projectsManager, bridge,
      transcriptStore: {
        appendOutput() {}, ensureTranscript: async () => {},
        readTranscriptChunks: async () => { throw new Error('transcript unavailable'); },
      },
    }));

    try {
      await assert.rejects(processor.joinSession('ws', 'session-1'), /transcript unavailable/);
      assert.strictEqual(connections.get('ws').claudeSessionId, null);
      assert.strictEqual(session.connections.has('ws'), false);
      assert.deepStrictEqual(released, ['join-1']);
      processor.cleanupConnection('ws');
      assert.deepStrictEqual(released, ['join-1'], 'double cleanup is idempotent');
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('persists a stale project cwd repair during a quiet websocket join', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-join-cwd-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const session = record({
      projectId: 'project-1',
      projectWorkingDirKind: 'host',
      workingDir: path.join(workspace, 'missing-after-rebuild'),
    });
    const sessions = new Map([[session.id, session]]);
    const connections = new Map([['ws', {
      id: 'ws', ws: { readyState: 1, send() {} }, userId: USER.id,
      githubLogin: USER.githubLogin, claudeSessionId: null,
      chatSessionIds: new Set(), created: new Date(),
    }]]);
    let saves = 0;
    const released = [];
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true, environment: projectEnvironment(), workingDir: checkout,
        allowedWorkingDirs: [workspace], leaseId: 'join-cwd-repair',
      }),
      releaseSessionLease: (_owner, _project, leaseId) => { released.push(leaseId); return true; },
      touchActivity: () => {},
    };
    const processor = new MessageProcessor(processorDeps({
      sessions,
      connections,
      projectsManager,
      bridge: null,
      saveSessionsToDisk: async () => { saves += 1; },
    }));

    try {
      await processor.joinSession('ws', session.id);
      assert.strictEqual(session.workingDir, fs.realpathSync(checkout));
      assert.strictEqual(session.projectWorkingDirKind, 'host');
      assert.strictEqual(saves, 1, 'the repaired record is saved before the join completes');
      processor.cleanupConnection('ws');
      assert.deepStrictEqual(released, ['join-cwd-repair']);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('releases only newly acquired chat-subscription leases when snapshots fail', async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-subscribe-'));
    const checkout = path.join(workspace, 'repo');
    await fs.promises.mkdir(checkout, { recursive: true });
    const session = record({
      id: 'session-1', projectId: 'project-1', workingDir: checkout, surface: 'chat',
    });
    const sessions = new Map([[session.id, session]]);
    const wsInfo = {
      id: 'ws', ws: { readyState: 1, send() {} }, userId: USER.id,
      githubLogin: USER.githubLogin, claudeSessionId: null,
      chatSessionIds: new Set(), created: new Date(),
    };
    const connections = new Map([['ws', wsInfo]]);
    let nextLease = 0;
    const released = [];
    let snapshotError = new Error('snapshot unavailable');
    const projectsManager = {
      getForUser: () => ({ id: 'project-1', name: 'Project' }),
      ensureForSession: async () => ({
        ok: true, environment: projectEnvironment(), workingDir: checkout,
        allowedWorkingDirs: [workspace], leaseId: `subscription-${++nextLease}`,
      }),
      releaseSessionLease: (_owner, _project, leaseId) => { released.push(leaseId); return true; },
      touchActivity: () => {},
    };
    const bridge = {
      startSession: async () => ({}), stopSession: async () => {},
      sendInput: async () => {}, resize: async () => {},
    };
    const chatManager = {
      snapshot: async () => {
        if (snapshotError) throw snapshotError;
        return { live: false };
      },
    };
    const processor = new MessageProcessor(processorDeps({
      sessions, connections, projectsManager, bridge, chatManager,
    }));

    try {
      assert.strictEqual(await processor.subscribeChat(wsInfo, session.id), false);
      assert.strictEqual(wsInfo.chatSessionIds.has(session.id), false);
      assert.deepStrictEqual(released, ['subscription-1']);

      snapshotError = null;
      assert.strictEqual(await processor.subscribeChat(wsInfo, session.id), true);
      assert.strictEqual(wsInfo.chatSessionIds.has(session.id), true);
      snapshotError = new Error('refresh failed');
      assert.strictEqual(await processor.subscribeChat(wsInfo, session.id), false);
      assert.deepStrictEqual(
        released,
        ['subscription-1'],
        'a failed refresh keeps the already-owned subscription claim',
      );

      processor.cleanupConnection('ws');
      assert.deepStrictEqual(released, ['subscription-1', 'subscription-2']);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  it('uses the project environment for workspace commands without host fallback', async function () {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-workspace-'));
    const project = projectEnvironment();
    let ensures = 0;
    const released = [];
    const sessions = new Map([['session-1', record({ projectId: 'project-1', workingDir: directory })]]);
    const app = express();
    app.use((_req, res, next) => { res.locals.authContext = { user: USER, authSessionId: 'a' }; next(); });
    app.use(createWorkspaceRoutes({
      claudeSessions: sessions, validatePath: () => ({ valid: true, path: directory }),
      saveSessionsToDisk: async () => {},
      ensureEnvironment: async () => { throw new Error('legacy environment must not be used'); },
      projectsManager: {
        getForUser: () => ({ id: 'project-1' }),
        ensureForSession: async () => {
          ensures++;
          return {
            ok: true, environment: project, workingDir: directory,
            allowedWorkingDirs: [directory], leaseId: `workspace-${ensures}`,
          };
        },
        releaseSessionLease: (_userId, _projectId, leaseId) => { released.push(leaseId); return true; },
        touchActivity: () => {},
      },
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspace/session-1/status`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(ensures, 1);
      assert.deepStrictEqual(released, ['workspace-1']);
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
    const releasedResources = [];
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
      releaseProjectSessionResources: (sessionId) => {
        releasedResources.push(sessionId);
        order.push(`release:${sessionId}`);
      },
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
      'terminal-bridge:nested-shell',
      'terminal-bridge:project-shell',
    ]);
    assert(order.indexOf('stop:project-chat') < order.indexOf('transcript:project-chat'));
    assert(order.indexOf('stop:project-shell') < order.indexOf('transcript:project-shell'));
    assert.deepStrictEqual(transcripts.sort(), retired.slice().sort());
    assert.deepStrictEqual(histories.sort(), retired.slice().sort());
    assert.deepStrictEqual(recorders.sort(), retired.slice().sort());
    assert.deepStrictEqual(teardown.sort(), retired.slice().sort());
    assert.deepStrictEqual(releasedResources.sort(), retired.slice().sort());
    assert(order.indexOf('stop:project-chat') < order.indexOf('release:project-chat'));
    assert(order.indexOf('release:project-chat') < order.indexOf('transcript:project-chat'));
    assert.strictEqual(saves, 1);
  });
});
