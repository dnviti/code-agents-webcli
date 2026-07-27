const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { HostEnvironment } = require('../dist/server/services/environments/manager.js');

// The environment feature typechecks perfectly while routing nothing: every
// call site takes an optional parameter, and leaving one out is invisible until
// somebody's agent runs on the host beside a terminal that ran in a container.
// These assert the routing itself — that a start is handed the environment, and
// that a server with the feature off is handed nothing at all.

function createSessionRecord(params = {}) {
  return {
    id: params.id || 'session-1',
    ownerUserId: params.ownerUserId ?? 7,
    name: 'Session',
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    surface: params.surface,
    terminalOptions: null,
    stopRequested: false,
    workingDir: params.workingDir || '/tmp/project',
    connections: new Set(['ws-1']),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

function build(overrides = {}) {
  const sent = [];
  const session = createSessionRecord(overrides.session);
  const started = [];
  const chatStarts = [];

  const bridge = {
    async startSession(sessionId, options) {
      started.push({ sessionId, options });
      return { runtimeLabel: 'bash', terminalMode: 'shell', shell: 'bash' };
    },
    async sendInput() {},
    async resize() {},
    async stopSession() {},
  };

  const connections = new Map([['ws-1', {
    id: 'ws-1',
    ws: { readyState: WebSocket.OPEN, send: (p) => sent.push(JSON.parse(p)) },
    userId: session.ownerUserId,
    githubLogin: 'tester',
    claudeSessionId: session.id,
    chatSessionIds: new Set(),
    created: new Date(),
  }]]);

  const deps = {
    dev: false,
    claudeSessions: new Map([[session.id, session]]),
    webSocketConnections: connections,
    baseFolder: '/srv/shared',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude' },
    validatePath: overrides.validatePath || (() => ({ valid: true, path: '/tmp/project' })),
    getSelectedWorkingDir: () => null,
    createSessionRecord,
    getRuntimeBridge: () => bridge,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => null,
    chatManager: {
      has: () => false,
      async start(record, options) {
        chatStarts.push(options);
        return { runtimeKind: options.runtime, currentCapabilities: {}, bypassing: false };
      },
      async snapshot() { return {}; },
      async send() {}, async interrupt() {}, async stop() {},
      async setModel() { return false; },
      rememberModel() {}, cancelQueued() { return false; },
      respondPermission() { return false; }, answerQuestion() { return false; },
      async readPage() { return { events: [], firstSeq: 0, cursor: 0 }; },
    },
    transcriptStore: {
      appendOutput() {},
      ensureTranscript: () => Promise.resolve(),
      readTranscriptChunks: () => Promise.resolve([]),
    },
    historyStore: {
      append() {},
      stat: () => Promise.resolve({ firstLine: 0, totalLines: 0 }),
      read: () => Promise.resolve({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }),
    },
    usageReader: {}, usageAnalytics: { startSession() {} },
    ...overrides.deps,
  };

  return { processor: new MessageProcessor(deps), session, started, chatStarts, sent };
}

/** A stand-in for one user's container, with just enough surface to be routed. */
function fakeEnvironment(name) {
  return {
    kind: 'container',
    name,
    homeDir: `/data/environments/${name}`,
    containerHome: '/home/user',
    shells: ['bash', 'sh'],
    mounts: [],
    nodePath: 'node',
    toContainerPath: (p) => p,
    toHostPath: (p) => p,
    wrap: (command, args) => ({ command, args, env: {} }),
  };
}

describe('per-user environments: server wiring', function () {
  it('hands the terminal bridge the environment of the user starting it', async function () {
    const asked = [];
    const { processor, started } = build({
      deps: {
        ensureEnvironment: async (userId) => {
          asked.push(userId);
          return fakeEnvironment(`cawc-tester-${userId}`);
        },
        getUserBaseFolder: () => '/data/environments/cawc-tester-7',
      },
    });

    await processor.handleMessage('ws-1', { type: 'start_terminal', options: {} });

    assert.deepStrictEqual(asked, [7], 'the owner of the session, not a default');
    assert.strictEqual(started.length, 1);
    assert.strictEqual(started[0].options.environment.name, 'cawc-tester-7');
  });

  it('hands the chat manager the same environment', async function () {
    const { processor, chatStarts } = build({
      session: { surface: 'chat', ownerUserId: 9 },
      deps: {
        ensureEnvironment: async (userId) => fakeEnvironment(`cawc-tester-${userId}`),
        getUserBaseFolder: () => '/data/environments/cawc-tester-9',
      },
    });

    await processor.handleMessage('ws-1', { type: 'start_chat', agentKind: 'claude' });

    assert.strictEqual(chatStarts.length, 1);
    assert.strictEqual(chatStarts[0].environment.name, 'cawc-tester-9');
  });

  it('routes nothing when the feature is off', async function () {
    // No ensureEnvironment dep at all: the shape a server without the feature
    // — and every deployment that predates it — constructs.
    const { processor, started } = build();

    await processor.handleMessage('ws-1', { type: 'start_terminal', options: {} });

    assert.strictEqual(started.length, 1);
    const passed = started[0].options.environment;
    assert.strictEqual(passed.kind, 'host', 'a server without the feature must stay on the host');
    assert.ok(passed instanceof HostEnvironment);
  });

  it('refuses to start rather than silently falling back to the host', async function () {
    const { processor, started, sent } = build({
      deps: {
        ensureEnvironment: async () => { throw new Error('docker daemon is not running'); },
        getUserBaseFolder: () => '/data/environments/cawc-tester-7',
      },
    });

    await processor.handleMessage('ws-1', { type: 'start_terminal', options: {} });

    assert.strictEqual(started.length, 0, 'nothing may run on the host in this case');
    const error = sent.filter((m) => m.type === 'error').pop();
    assert.ok(/environment could not be started/i.test(error.message), error && error.message);
  });

  it('moves a session pointing outside the user home into it, instead of failing forever', async function () {
    // What a session created before the feature was switched on looks like: its
    // working directory is a folder on the host that the container cannot see.
    const { processor, session, started } = build({
      session: { workingDir: '/srv/shared/legacy' },
      validatePath: (target) => ({
        valid: target.startsWith('/data/environments/cawc-tester-7'),
        path: target,
        error: 'outside',
      }),
      deps: {
        ensureEnvironment: async () => fakeEnvironment('cawc-tester-7'),
        getUserBaseFolder: () => '/data/environments/cawc-tester-7',
      },
    });

    await processor.handleMessage('ws-1', { type: 'start_terminal', options: {} });

    assert.strictEqual(session.workingDir, '/data/environments/cawc-tester-7');
    assert.strictEqual(started[0].options.workingDir, '/data/environments/cawc-tester-7');
  });
});
