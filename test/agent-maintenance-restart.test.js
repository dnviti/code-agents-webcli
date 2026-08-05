const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { ChatSession } = require('../dist/server/chat/session.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { probeLaunchedAgentVersion } = require('../dist/server/index.js');

function chat() {
  const session = new ChatSession(
    { id: 'maintained-chat', ownerUserId: 7 },
    {
      store: {
        append() {},
        async stat() { return { firstSeq: 1, cursor: 0 }; },
        async read() { return { events: [], firstSeq: 1, from: 1, cursor: 0 }; },
      },
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-restart-')),
      hookScript: path.join(os.tmpdir(), 'missing-hook.js'),
      broadcast() {},
      resolveCommand: () => '/external/claude',
    },
  );
  session.adapter = {
    alive: true,
    capabilities: { resume: true },
    async send() {},
    async interrupt() {},
    respondPermission() {},
    async stop() {},
  };
  session.adapterReady = true;
  session.state = 'idle';
  session.nativeSessionId = 'native-1';
  session.capabilities = { resume: true };
  session.lastStartOptions = { runtime: 'claude', command: '/external/claude', workingDir: process.cwd() };
  return session;
}

describe('agent-update chat restart', function () {
  it('rejects invalid session ids before entering the restart single-flight map', async function () {
    const sent = [];
    const processor = new MessageProcessor({
      claudeSessions: new Map(),
      webSocketConnections: new Map([['ws-1', {
        ws: { readyState: WebSocket.OPEN, send: (value) => sent.push(JSON.parse(value)) },
        userId: 7,
      }]]),
    });
    await Promise.all([
      processor.handleMessage('ws-1', { type: 'runtime_restart' }),
      processor.handleMessage('ws-1', { type: 'runtime_restart', sessionId: null }),
    ]);
    assert.deepEqual(sent.map((message) => message.reason), ['invalid_session', 'invalid_session']);
  });

  it('probes the catalog executable with a fully scrubbed process environment', async function () {
    const wraps = [];
    const runs = [];
    const environment = {
      kind: 'host', name: null, homeDir: '/tmp', containerHome: '/tmp', shells: [], mounts: [], nodePath: 'node',
      toContainerPath: (value) => value, toHostPath: (value) => value,
      wrap(command, args, options) {
        wraps.push({ command, args, options });
        return { command, args, env: { PATH: '/safe/bin' } };
      },
    };
    const version = await probeLaunchedAgentVersion(environment, 'claude', undefined, {
      async run(command, args, options) {
        runs.push({ command, args, options });
        return { stdout: 'claude 1.2.3', stderr: '' };
      },
    });
    assert.equal(version, '1.2.3');
    assert.equal(wraps[0].command, 'claude', 'display aliases must never become executables');
    assert.equal(wraps[0].options.inheritHostEnv, false);
    assert.equal(runs[0].options.inheritEnv, false, 'the child runner must not merge process.env');
    assert.deepEqual(runs[0].options.env, { PATH: '/safe/bin' });
  });

  it('classifies only a fully idle resumable session as automatic-safe', function () {
    const session = chat();
    assert.equal(session.safeForAutomaticAgentRestart, true);
    session.state = 'running';
    assert.equal(session.safeForAutomaticAgentRestart, false);
    session.state = 'idle';
    session.queue.push({ text: 'next' });
    assert.equal(session.safeForAutomaticAgentRestart, false);
  });

  it('requires the requesting socket to have the chat currently opened even for manual restart', async function () {
    const sent = [];
    const record = { id: 'maintained-chat', ownerUserId: 7, active: true, agent: 'claude', lastAgent: 'claude', surface: 'chat' };
    const processor = new MessageProcessor({
      claudeSessions: new Map([[record.id, record]]),
      webSocketConnections: new Map([['ws-1', {
        ws: { readyState: WebSocket.OPEN, send: (value) => sent.push(JSON.parse(value)) },
        userId: 7,
        claudeSessionId: 'another-open-chat',
      }]]),
    });
    await processor.handleMessage('ws-1', {
      type: 'runtime_restart', sessionId: record.id, automatic: false, allowFreshContext: true,
    });
    assert.equal(sent.at(-1).reason, 'not_current');
  });

  it('keeps the old running version when the restarted process cannot verify the new pointer', async function () {
    const sent = [];
    const record = { id: 'maintained-chat', ownerUserId: 7, active: true, agent: 'claude', lastAgent: 'claude', surface: 'chat', runningAgentVersion: '1.0.0', runningManagedAgentVersion: null };
    const environment = { kind: 'container', identity: 'immutable-a', name: 'env', homeDir: '/tmp', containerHome: '/tmp', shells: [], mounts: [], nodePath: 'node', wrap: (command, args) => ({ command, args, env: {} }), toContainerPath: (value) => value, toHostPath: (value) => value };
    const processor = new MessageProcessor({
      claudeSessions: new Map([[record.id, record]]),
      webSocketConnections: new Map([['ws-1', {
        ws: { readyState: WebSocket.OPEN, send: (value) => sent.push(JSON.parse(value)) },
        userId: 7,
        claudeSessionId: record.id,
      }]]),
      resolveAgentEnvironment: async () => environment,
      resolveAgentLaunch: () => ({ command: '/managed/claude', version: '2.0.0' }),
      probeAgentLaunchVersion: async () => null,
      chatManager: { restartForAgentUpdate: async () => ({ ok: true, resumed: true }) },
    });
    await processor.handleMessage('ws-1', {
      type: 'runtime_restart', sessionId: record.id, automatic: false, allowFreshContext: true,
    });
    assert.equal(sent.at(-1).reason, 'version_verification_failed');
    assert.equal(record.runningAgentVersion, '1.0.0');
    assert.equal(record.runningManagedAgentVersion, null);
  });

  it('returns stable error codes without exposing environment or restart failures', async function () {
    const sent = [];
    const record = { id: 'maintained-chat', ownerUserId: 7, active: true, agent: 'claude', lastAgent: 'claude', surface: 'chat' };
    const connection = {
      ws: { readyState: WebSocket.OPEN, send: (value) => sent.push(JSON.parse(value)) },
      userId: 7,
      claudeSessionId: record.id,
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const environmentFailure = new MessageProcessor({
        claudeSessions: new Map([[record.id, record]]),
        webSocketConnections: new Map([['ws-1', connection]]),
        resolveAgentEnvironment: async () => { throw new Error('/secret/container/path'); },
      });
      await environmentFailure.handleMessage('ws-1', {
        type: 'runtime_restart', sessionId: record.id, automatic: false, allowFreshContext: true,
      });
      assert.equal(sent.at(-1).reason, 'environment_unavailable');

      const environment = { kind: 'container', identity: 'immutable-a', name: 'env', homeDir: '/tmp', containerHome: '/tmp', shells: [], mounts: [], nodePath: 'node', wrap: (command, args) => ({ command, args, env: {} }), toContainerPath: (value) => value, toHostPath: (value) => value };
      const restartFailure = new MessageProcessor({
        claudeSessions: new Map([[record.id, record]]),
        webSocketConnections: new Map([['ws-1', connection]]),
        resolveAgentEnvironment: async () => environment,
        resolveAgentLaunch: () => ({ command: '/managed/claude', version: '2.0.0' }),
        chatManager: { restartForAgentUpdate: async () => { throw new Error('private runtime detail'); } },
      });
      await restartFailure.handleMessage('ws-1', {
        type: 'runtime_restart', sessionId: record.id, automatic: false, allowFreshContext: true,
      });
      assert.equal(sent.at(-1).reason, 'restart_failed');
      assert.doesNotMatch(JSON.stringify(sent), /secret|private runtime detail/);
    } finally {
      console.error = originalError;
    }
  });

  it('atomically keeps the session and transcript while resuming on the managed command', async function () {
    const session = chat();
    const calls = [];
    session.stop = async (options) => { calls.push(['stop', options]); session.adapter = null; };
    session.start = async (options) => { calls.push(['start', options]); };

    const result = await session.restartForAgentUpdate({
      automatic: true,
      allowFreshContext: false,
      command: '/managed/claude',
    });

    assert.deepEqual(result, { ok: true, resumed: true });
    assert.deepEqual(calls[0], ['stop', { preserveHandoffs: true }]);
    assert.equal(calls[1][1].command, '/managed/claude');
    assert.equal(calls[1][1].resumeSessionId, 'native-1');
    assert.equal(calls[1][1].startFresh, false);
  });

  it('refuses a raced busy restart and requires consent before losing native context', async function () {
    const busy = chat();
    busy.state = 'running';
    assert.deepEqual(
      await busy.restartForAgentUpdate({ automatic: true, allowFreshContext: false }),
      { ok: false, reason: 'busy' },
    );

    const fresh = chat();
    fresh.nativeSessionId = null;
    fresh.capabilities = { resume: false };
    fresh.adapter.capabilities = { resume: false };
    assert.deepEqual(
      await fresh.restartForAgentUpdate({ automatic: true, allowFreshContext: false }),
      { ok: false, reason: 'cannot_resume' },
    );
    const starts = [];
    fresh.stop = async () => { fresh.adapter = null; };
    fresh.start = async (options) => { starts.push(options); };
    assert.deepEqual(
      await fresh.restartForAgentUpdate({ automatic: false, allowFreshContext: true, command: '/managed/claude' }),
      { ok: true, resumed: false },
    );
    assert.equal(starts[0].startFresh, false, 'the app transcript is retained even when native context is not');
  });
});
