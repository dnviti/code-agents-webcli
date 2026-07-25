const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// A server loads its code once, at boot. A browser reloads the page whenever it
// likes. So "the page is newer than the process serving it" is the ordinary
// state of a development machine, and it is how the WebUI launch came to spin
// forever: the page sent `start_chat`, the running server had never heard of
// it, and the switch dropped it without a word. Nothing was broken — nothing
// replied. These pin the three behaviours that turn that silence into a
// sentence, and the one that made a finished chat launch raise its own spinner
// again later.

const ROOT = path.join(__dirname, '..');

function createSessionRecord(params = {}) {
  return {
    id: params.id || 'session-1',
    ownerUserId: params.ownerUserId ?? 7,
    name: params.name || 'Session',
    created: new Date(),
    lastActivity: new Date(),
    active: params.active ?? false,
    agent: params.agent ?? null,
    lastAgent: null,
    runtimeLabel: null,
    surface: params.surface,
    terminalOptions: null,
    stopRequested: false,
    workingDir: params.workingDir || '/tmp/project',
    connections: new Set(params.connections || []),
    outputBuffer: params.outputBuffer || [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

function buildProcessor() {
  const sent = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const session = createSessionRecord();
  const connections = new Map([
    ['ws-1', {
      id: 'ws-1',
      ws,
      userId: 7,
      githubLogin: 'tester',
      claudeSessionId: session.id,
      created: new Date(),
    }],
  ]);
  session.connections.add('ws-1');

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: new Map([[session.id, session]]),
    webSocketConnections: connections,
    baseFolder: '/tmp',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude', pi: 'Pi' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord,
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => null,
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
    usageReader: {},
    usageAnalytics: {},
  });

  return { processor, sent };
}

describe('a page newer than the server it is talking to', function () {
  describe('the server answers what it cannot do', function () {
    it('reports a message type it does not know, instead of dropping it', async function () {
      const { processor, sent } = buildProcessor();

      // Stands in for whatever a future page sends that this build predates —
      // which is what `start_chat` itself was to the server running when the
      // WebUI button first hung.
      await processor.handleMessage('ws-1', { type: 'start_hologram', agentKind: 'pi' });

      const error = sent.find((m) => m.type === 'error');
      assert.ok(error, 'an unknown request must be answered, not swallowed');
      assert.match(error.message, /start_hologram/, 'the reply must name what was not understood');
      assert.match(error.message, /restart the server/i, 'and say what to do about it');
    });

    it('stays silent for the close message the client still sends', async function () {
      const { processor, sent } = buildProcessor();
      await processor.handleMessage('ws-1', { type: 'close_session' });
      assert.strictEqual(
        sent.find((m) => m.type === 'error'),
        undefined,
        'closing is done over HTTP; the socket half must not raise an error',
      );
    });
  });
});

describe('a launch nothing answers', function () {
  let mod;
  let bundle;

  before(function () {
    this.timeout(60000);

    const contents = [
      `export { startRuntimeSession, settleRuntimeStart } from ${JSON.stringify(path.join(ROOT, 'src/client/sessions/actions'))};`,
      `export { MessageHandler } from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/message-handler'))};`,
      `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `version-skew-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'skew.tsx' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(bundle);
  });

  // onSessionJoined schedules a terminal refit; there is no compositor here.
  const realRaf = global.requestAnimationFrame;
  beforeEach(function () {
    global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  });
  afterEach(function () {
    global.requestAnimationFrame = realRaf;
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  function fakeApp() {
    const sent = [];
    return {
      sent,
      aliases: { claude: 'Claude', pi: 'Pi' },
      pendingRuntimeStart: null,
      runtimeStartTimer: null,
      startPromptRequested: false,
      // null on purpose: stabilizeTerminalSize returns early without a
      // terminal, which keeps this clear of document/RAF.
      terminal: null,
      chat: null,
      sessionTabManager: null,
      splitContainer: null,
      historyView: null,
      historyRange: null,
      pendingJoinResolve: null,
      pendingJoinSessionId: null,
      fitTerminal() {},
      loadSessions() {},
      requestUsageStats() {},
      getRuntimeStartMessage: () => 'Starting Pi...',
      getRuntimeLabel: (kind, label, fallback) => label || 'Pi' || fallback,
      send: (message) => sent.push(message),
      currentClaudeSessionId: 'session-1',
      claudeSessions: [{ id: 'session-1' }],
    };
  }

  /** Run a launch with setTimeout captured, so the watchdog can be fired on demand. */
  async function launchCapturingTimer(app, options) {
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let fire = null;
    global.setTimeout = (fn, ms) => {
      // Only the watchdog: anything shorter belongs to the join fallback.
      if (ms >= 10000) {
        fire = fn;
        return { watchdog: true };
      }
      return realSetTimeout(fn, ms);
    };
    global.clearTimeout = (token) => {
      if (token && token.watchdog) {
        fire = null;
        return;
      }
      return realClearTimeout(token);
    };
    try {
      await mod.startRuntimeSession(app, 'pi', options);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
    return () => {
      assert.ok(fire, 'no watchdog was armed for this launch');
      fire();
    };
  }

  it('gives up and names the likely cause rather than spinning forever', async function () {
    const app = fakeApp();
    mod.shellStore.setState({ overlay: null, errorText: '' });

    const fireWatchdog = await launchCapturingTimer(app, { surface: 'chat' });
    assert.ok(
      app.sent.find((m) => m.type === 'start_chat'),
      'the launch must actually have been sent',
    );

    // The server says nothing at all — the old-process case.
    fireWatchdog();

    const state = mod.shellStore.getSnapshot();
    assert.strictEqual(state.overlay, 'error', 'the spinner must not be left up');
    assert.match(state.errorText, /never answered/i);
    assert.match(state.errorText, /older version/i, 'the message must point at the real cause');
    assert.strictEqual(app.pendingRuntimeStart, null);
  });

  it('does not accuse the server once it has answered', async function () {
    const app = fakeApp();
    const handler = new mod.MessageHandler(app);

    const fireWatchdog = await launchCapturingTimer(app, { surface: 'chat' });
    handler.handle({
      type: 'chat_started',
      sessionId: 'session-1',
      agent: 'pi',
      runtimeLabel: 'Pi',
    });

    assert.strictEqual(app.runtimeStartTimer, null, 'answering must disarm the watchdog');

    // Fired anyway, because disarming does not un-queue a timer that was
    // already due when the answer landed. The callback has to hold on its own.
    mod.shellStore.setState({ overlay: null, errorText: '' });
    fireWatchdog();
    assert.strictEqual(
      mod.shellStore.getSnapshot().overlay,
      null,
      'a late watchdog must not raise an error over a session that started',
    );
  });

  it('does not re-raise its own spinner when the session is joined again', async function () {
    // The defect this guards: chat_started cleared the overlay but left the
    // launch marked pending, so the next join treated a running conversation
    // as a start still in flight and covered it with "Starting Pi..." for good.
    const app = fakeApp();
    const handler = new mod.MessageHandler(app);

    await launchCapturingTimer(app, { surface: 'chat' });
    handler.handle({
      type: 'chat_started',
      sessionId: 'session-1',
      agent: 'pi',
      runtimeLabel: 'Pi',
    });
    assert.strictEqual(app.pendingRuntimeStart, null, 'the launch is over once it is answered');

    mod.shellStore.setState({ overlay: null, overlayMessage: '' });
    handler.handle({
      type: 'session_joined',
      sessionId: 'session-1',
      sessionName: 'Session',
      workingDir: '/tmp/project',
      active: false,
      outputBuffer: [],
      surface: 'chat',
      agent: 'pi',
    });

    assert.notStrictEqual(
      mod.shellStore.getSnapshot().overlay,
      'loading',
      'rejoining a live chat must not cover it with a start spinner',
    );
  });
});
