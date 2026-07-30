const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { HostEnvironment } = require('../dist/server/services/environments/manager.js');
const { AntigravityChatAdapter } = require('../dist/server/chat/adapters/antigravity.js');

/** A pi skill in a home directory, which is what the menu scan looks for. */
function skill(home, name) {
  const dir = path.join(home, '.pi', 'agent', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

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

describe('per-user environments: every runtime launch goes through one', function () {
  // A new adapter is written by copying an existing one, and the thing most
  // easily copied from the version before this feature is a bare `spawn`. That
  // adapter then runs the agent on the host, as the server's account, beside a
  // terminal for the same conversation that ran in the user's container — and
  // nothing about it fails, so nothing says so. Antigravity arrived that way.
  // Read from the sources rather than from `dist`: this is a claim about how an
  // adapter is written, and the one line that gives it away survives compilation
  // in a shape nobody would think to grep for.
  it('leaves no adapter reaching for child_process itself', function () {
    const dir = path.join(__dirname, '..', 'src', 'server', 'chat', 'adapters');
    const offenders = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /^\s*import[\s\S]*?from '(?:node:)?child_process';/m.test(
        fs.readFileSync(path.join(dir, name), 'utf8'),
      ));

    assert.deepStrictEqual(
      offenders,
      [],
      `these adapters launch their own processes instead of going through `
      + `BaseChatAdapter.launchChild, so their runtime runs on the host no matter `
      + `who owns the conversation: ${offenders.join(', ')}`,
    );
  });

  it('launches a turn as the runtime is named inside the container, not by this host\'s path', async function () {
    const wrapped = [];
    const environment = {
      ...fakeEnvironment('cawc-tester-7'),
      wrap(command, args, options) {
        wrapped.push({ command, args, options });
        // Somewhere harmless: this test is about what was asked for, not about
        // agy, which is not installed on a CI runner in any case.
        return { command: '/bin/true', args: [], env: {} };
      },
    };

    const adapter = new AntigravityChatAdapter({
      sessionId: 'chat-1',
      workingDir: '/data/environments/cawc-tester-7/project',
      // What the bridge found on this machine, and the plain name the image has.
      command: '/home/operator/.local/bin/agy',
      commandName: 'agy',
      environment,
      emit() {},
    });

    // The turn cannot succeed against `/bin/true`; what it was launched with is
    // decided before the process says anything.
    await adapter.send({ text: 'hello' }).catch(() => {});

    assert.strictEqual(wrapped.length, 1, 'the turn never reached the environment');
    assert.strictEqual(wrapped[0].command, 'agy');
    assert.ok(wrapped[0].args.includes('--print'), wrapped[0].args.join(' '));
    assert.strictEqual(wrapped[0].options.tty, false, 'a headless turn must not be given a terminal');
  });

  it('opens the command menu on the owner\'s skills, not on the server operator\'s', async function () {
    // The menu is read off disk before the runtime is even spawned, so it is
    // read by this process, as this account. A container's home is a bind mount
    // of a host directory, which an ordinary read can see — but only when the
    // session hands the scan that directory instead of its own HOME. Get it
    // wrong and every user's menu is a window onto the operator's machine.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-env-home-'));
    const ownerHome = path.join(root, 'environments', 'cawc-tester-7');
    const operatorHome = path.join(root, 'operator');
    skill(ownerHome, 'deploy-the-thing');
    skill(operatorHome, 'operators-private-thing');

    const { ChatSession } = require('../dist/server/chat/session.js');
    const session = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store: {
          append() {},
          async stat() { return { firstSeq: 1, cursor: 0 }; },
          async read() { return { events: [], firstSeq: 1, from: 1, cursor: 0 }; },
        },
        socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-env-sock-')),
        hookScript: path.join(root, 'no-such-hook.js'),
        broadcast() {},
        resolveCommand: () => '/bin/cat',
      },
    );

    // pi, whose adapter opens without a handshake, for the reason
    // chat-tool-activity.test.js gives: `/bin/cat` answers nothing and a
    // protocol handshake would wait on it forever. The runtime is incidental —
    // what is under test is which home the session scanned.
    const environment = {
      ...fakeEnvironment('cawc-tester-7'),
      homeDir: ownerHome,
      wrap: () => ({ command: '/bin/cat', args: [], env: {} }),
    };
    await session.start({
      runtime: 'pi',
      workingDir: path.join(ownerHome, 'project'),
      environment,
      env: { HOME: operatorHome },
    });
    await session.stop();

    const names = (session.capabilities.commands || []).map((command) => command.name);
    assert.ok(names.includes('deploy-the-thing'), `the owner's own skill is missing: ${names.join(', ')}`);
    assert.ok(
      !names.includes('operators-private-thing'),
      `the operator's skill leaked into a user's menu: ${names.join(', ')}`,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});
