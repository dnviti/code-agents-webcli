const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

/**
 * The session's recorded geometry is what the scrollback recorder wraps at.
 * These tests pin the rules: the start payload sets it, a payload without
 * geometry never clobbers it, and malformed resize messages are dropped
 * before NaN can reach the recorder or the PTY.
 */
describe('session terminal geometry', function () {
  function harness({ bridge } = {}) {
    const sentMessages = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send(payload) {
        sentMessages.push(JSON.parse(payload));
      },
    };

    const session = {
      id: 'session-1',
      ownerUserId: 7,
      name: 'Test Session',
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      agent: null,
      lastAgent: null,
      runtimeLabel: null,
      terminalOptions: null,
      stopRequested: false,
      workingDir: '/tmp',
      connections: new Set(['ws-1']),
      outputBuffer: [],
      termCols: 80,
      termRows: 24,
      sessionStartTime: null,
      sessionUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        models: {},
      },
      maxBufferSize: 1000,
    };

    const processor = new MessageProcessor({
      dev: false,
      claudeSessions: new Map([[session.id, session]]),
      webSocketConnections: new Map([
        ['ws-1', {
          id: 'ws-1',
          ws,
          userId: 7,
          githubLogin: 'tester',
          claudeSessionId: session.id,
          created: new Date(),
        }],
      ]),
      baseFolder: '/tmp',
      sessionDurationHours: 5,
      aliases: { terminal: 'Terminal' },
      validatePath: () => ({ valid: true, path: '/tmp' }),
      getSelectedWorkingDir: () => '/tmp',
      createSessionRecord: () => session,
      getRuntimeBridge: () => bridge ?? null,
      saveSessionsToDisk: () => Promise.resolve(),
      // No runtime profile configured: the default, unmodified launch.
      resolveRuntimeProfile: () => null,
      historyStore: {
        append() {},
        stat: () => Promise.resolve({ firstLine: 0, totalLines: 0 }),
        read: () => Promise.resolve({ firstLine: 0, totalLines: 0, fromLine: 0, lines: [] }),
        deleteHistory: () => Promise.resolve(),
      },
      transcriptStore: {
        ensureTranscript: () => Promise.resolve('/tmp/session-1.md'),
        appendOutput() {},
        readTranscriptChunks: () => Promise.resolve([]),
        deleteTranscript: () => Promise.resolve(),
      },
      usageReader: {},
      usageAnalytics: {},
    });

    return { processor, session, sentMessages };
  }

  it('takes the geometry from the start payload and forwards it to the PTY', async function () {
    let startedWith;
    const bridge = {
      startSession(id, options) {
        startedWith = options;
        return Promise.resolve({ runtimeLabel: 'Shell', terminalMode: 'shell', shell: '/bin/sh' });
      },
    };
    const { processor, session } = harness({ bridge });

    await processor.handleMessage('ws-1', {
      type: 'start_terminal',
      options: { cols: 132, rows: 43 },
    });

    assert.strictEqual(session.termCols, 132);
    assert.strictEqual(session.termRows, 43);
    assert.strictEqual(startedWith.cols, 132, 'the PTY must spawn at the same geometry');
    assert.strictEqual(startedWith.rows, 43);
  });

  it('keeps the known geometry when a restart payload has none', async function () {
    const bridge = {
      startSession() {
        return Promise.resolve({ runtimeLabel: 'Shell', terminalMode: 'shell', shell: '/bin/sh' });
      },
    };
    const { processor, session } = harness({ bridge });
    session.termCols = 212;
    session.termRows = 55;

    await processor.handleMessage('ws-1', { type: 'start_terminal', options: {} });

    assert.strictEqual(session.termCols, 212, 'a restart must not reset geometry to 80x24');
    assert.strictEqual(session.termRows, 55);
  });

  it('ignores malformed resize messages instead of storing NaN', async function () {
    const resizes = [];
    const bridge = {
      resize(id, cols, rows) {
        resizes.push([cols, rows]);
        return Promise.resolve();
      },
    };
    const { processor, session } = harness({ bridge });
    session.active = true;
    session.agent = 'terminal';
    session.termCols = 120;
    session.termRows = 40;

    await processor.handleMessage('ws-1', { type: 'resize', cols: 'wide', rows: NaN });
    assert.strictEqual(session.termCols, 120);
    assert.strictEqual(session.termRows, 40);
    assert.deepStrictEqual(resizes, [], 'a malformed resize must never reach the PTY');

    // Infinity is not finite either; `Infinity || 80` passes it through.
    await processor.handleMessage('ws-1', { type: 'resize', cols: Infinity, rows: 40 });
    assert.strictEqual(session.termCols, 120);
    assert.deepStrictEqual(resizes, []);

    // A sane resize still applies, clamped to positive integers.
    await processor.handleMessage('ws-1', { type: 'resize', cols: 100.7, rows: 30 });
    assert.strictEqual(session.termCols, 100);
    assert.strictEqual(session.termRows, 30);
    assert.deepStrictEqual(resizes, [[100, 30]]);
  });
});
