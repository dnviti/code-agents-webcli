const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// The wiring between "the user clicked WebUI (Beta)" and "a chat session is
// running" crosses four files and two processes, and every one of them
// typechecks perfectly while doing nothing at all — which is exactly how the
// button came to open a terminal instead. These assert the behaviour rather
// than the shape: the message the browser sends is routed, the surface is
// recorded on the session, the runtime is launched through the chat manager,
// and rejoining that session hands back a conversation instead of a scrollback.

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

/** A chat manager that records what it was asked to do. */
function createChatManager(overrides = {}) {
  const calls = { start: [], send: [], interrupt: [], permission: [], page: [], cancelQueued: [] };
  return {
    calls,
    has: () => false,
    async start(record, options) {
      calls.start.push({ record, options });
      return {
        runtimeKind: options.runtime,
        currentCapabilities: { streaming: true, toolCalls: true },
        bypassing: Boolean(options.bypassPermissions),
      };
    },
    async snapshot(record) {
      return {
        sessionId: record.id,
        runtime: 'claude',
        messages: [{ id: 'm1', seq: 1, turnId: 't1', role: 'user', ts: 1, blocks: [] }],
        state: 'idle',
        capabilities: {},
        pendingPermissions: [],
        firstSeq: 0,
        cursor: 1,
        live: true,
        bypassPermissions: false,
      };
    },
    async send(sessionId, turn) {
      calls.send.push({ sessionId, turn });
    },
    async interrupt(sessionId) {
      calls.interrupt.push(sessionId);
    },
    cancelQueued(sessionId, queuedId) {
      calls.cancelQueued.push({ sessionId, queuedId });
      return true;
    },
    respondPermission(sessionId, requestId, optionId) {
      calls.permission.push({ sessionId, requestId, optionId });
      return true;
    },
    async stop() {},
    async readPage(record, fromSeq, count) {
      calls.page.push({ id: record.id, fromSeq, count });
      return { events: [], firstSeq: 0, cursor: 0 };
    },
    ...overrides,
  };
}

function build(sessionOverrides = {}, managerOverrides = {}) {
  const sent = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const session = createSessionRecord(sessionOverrides);
  const chatManager = createChatManager(managerOverrides);
  const connections = new Map([
    [
      'ws-1',
      {
        id: 'ws-1',
        ws,
        userId: 7,
        githubLogin: 'tester',
        claudeSessionId: session.id,
        // Chat events reach a socket that has *subscribed*, not one that
        // merely joined, so a fixture without this set receives nothing.
        chatSessionIds: new Set(),
        created: new Date(),
      },
    ],
  ]);
  session.connections.add('ws-1');

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: new Map([[session.id, session]]),
    webSocketConnections: connections,
    baseFolder: '/tmp',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude', codex: 'Codex' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord,
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => null,
    chatManager,
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

  return { processor, session, chatManager, sent };
}

const lastOfType = (sent, type) => sent.filter((m) => m.type === type).pop();

describe('chat wiring', function () {
  describe('start_chat', function () {
    it('launches the runtime through the chat manager, not the PTY bridge', async function () {
      const { processor, session, chatManager, sent } = build();

      await processor.startChat('ws-1', 'claude', {});

      assert.strictEqual(chatManager.calls.start.length, 1, 'the chat manager was not asked to start');
      const call = chatManager.calls.start[0];
      assert.strictEqual(call.options.runtime, 'claude');
      assert.strictEqual(call.options.workingDir, session.workingDir);

      const started = lastOfType(sent, 'chat_started');
      assert.ok(started, 'no chat_started was broadcast');
      assert.strictEqual(started.agent, 'claude');
      assert.ok(started.capabilities, 'capabilities must reach the browser');
    });

    it('records the surface on the session so a rejoin knows what it is', async function () {
      const { processor, session } = build();
      await processor.startChat('ws-1', 'claude', {});
      assert.strictEqual(session.surface, 'chat');
      assert.strictEqual(session.active, true);
      assert.strictEqual(session.agent, 'claude');
    });

    it('refuses a runtime with no verified chat adapter, and says why', async function () {
      const { processor, session, chatManager, sent } = build();

      await processor.startChat('ws-1', 'qwen', {});

      assert.strictEqual(chatManager.calls.start.length, 0, 'must not launch an unsupported runtime');
      const error = lastOfType(sent, 'error');
      assert.ok(error, 'the refusal must be explained');
      assert.match(error.message, /terminal only|cannot be opened/i);
      assert.notStrictEqual(session.surface, 'chat');
    });

    it('refuses when a process is already running in the session', async function () {
      const { processor, chatManager, sent } = build({ active: true });
      await processor.startChat('ws-1', 'claude', {});
      assert.strictEqual(chatManager.calls.start.length, 0);
      assert.match(lastOfType(sent, 'error').message, /already running/i);
    });

    it('passes the bypass flag through, and only that, from the browser', async function () {
      const { processor, chatManager } = build();

      await processor.startChat('ws-1', 'claude', {
        dangerouslySkipPermissions: true,
        // A forged launch configuration must not survive the boundary.
        model: 'attacker/model',
        extraArgs: ['--evil'],
        env: { LD_PRELOAD: '/tmp/x.so' },
        workingDir: '/etc',
      });

      const { options } = chatManager.calls.start[0];
      assert.strictEqual(options.bypassPermissions, true);
      assert.strictEqual(options.model, undefined, 'model must come from the server profile');
      assert.strictEqual(options.extraArgs, undefined, 'args must come from the server profile');
      assert.strictEqual(options.env, undefined, 'env must come from the server profile');
      assert.strictEqual(options.workingDir, '/tmp/project', 'the directory is the session’s');
    });

    it('reports a failed launch instead of leaving the session marked active', async function () {
      const { processor, session, sent } = build(
        {},
        {
          start() {
            return Promise.reject(new Error('claude is not installed'));
          },
        },
      );

      await processor.startChat('ws-1', 'claude', {});

      assert.strictEqual(session.active, false);
      assert.match(lastOfType(sent, 'error').message, /not installed/);
    });
  });

  describe('turn traffic', function () {
    it('forwards a typed message', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_send', text: 'fix the auth race' });
      assert.deepStrictEqual(chatManager.calls.send[0].turn.text, 'fix the auth race');
    });

    it('ignores an empty message rather than starting a turn', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_send', text: '   ' });
      assert.strictEqual(chatManager.calls.send.length, 0);
    });

    it('forwards an interrupt', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_interrupt' });
      assert.deepStrictEqual(chatManager.calls.interrupt, ['session-1']);
    });

    it('forwards a withdrawal of a queued turn', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_queue_cancel', queuedId: 'queued-9' });
      assert.deepStrictEqual(chatManager.calls.cancelQueued[0], {
        sessionId: 'session-1',
        queuedId: 'queued-9',
      });
    });

    it('ignores a withdrawal with no id rather than clearing the whole line', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_queue_cancel' });
      assert.strictEqual(chatManager.calls.cancelQueued.length, 0);
    });

    it('will not let one socket withdraw from another user\u2019s queue', async function () {
      const { processor, chatManager } = build({ surface: 'chat', ownerUserId: 999 });
      await processor.handleMessage('ws-1', { type: 'chat_queue_cancel', queuedId: 'queued-9' });
      assert.strictEqual(chatManager.calls.cancelQueued.length, 0);
    });

    it('forwards a permission decision', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', {
        type: 'chat_permission_response',
        requestId: 'perm-1',
        optionId: 'allow_once',
      });
      assert.deepStrictEqual(chatManager.calls.permission[0], {
        sessionId: 'session-1',
        requestId: 'perm-1',
        optionId: 'allow_once',
      });
    });

    it('drops a permission decision missing either half', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', { type: 'chat_permission_response', requestId: 'x' });
      assert.strictEqual(chatManager.calls.permission.length, 0);
    });

    it('serves a page of older events', async function () {
      const { processor, chatManager, sent } = build({ surface: 'chat' });
      await processor.handleMessage('ws-1', {
        type: 'chat_history_request',
        fromSeq: 40,
        count: 20,
        requestId: 'p1',
      });
      assert.deepStrictEqual(chatManager.calls.page[0], { id: 'session-1', fromSeq: 40, count: 20 });
      assert.strictEqual(lastOfType(sent, 'chat_page').requestId, 'p1');
    });
  });

  describe('rejoining', function () {
    it('hands a chat session its conversation, and says which surface it is', async function () {
      const { processor, sent } = build({ surface: 'chat' });

      await processor.joinSession('ws-1', 'session-1');

      const joined = lastOfType(sent, 'session_joined');
      assert.strictEqual(joined.surface, 'chat');

      const snapshot = lastOfType(sent, 'chat_snapshot');
      assert.ok(snapshot, 'a chat session must replay its transcript on join');
      assert.strictEqual(snapshot.snapshot.messages.length, 1);
    });

    it('sends no chat snapshot for a terminal session', async function () {
      const { processor, sent } = build({ surface: 'terminal' });
      await processor.joinSession('ws-1', 'session-1');
      assert.strictEqual(lastOfType(sent, 'session_joined').surface, 'terminal');
      assert.strictEqual(lastOfType(sent, 'chat_snapshot'), undefined);
    });

    it('treats a session predating chat mode as a terminal', async function () {
      const { processor, sent } = build({ surface: undefined });
      await processor.joinSession('ws-1', 'session-1');
      assert.strictEqual(lastOfType(sent, 'session_joined').surface, 'terminal');
    });
  });

  describe('ownership', function () {
    it('will not drive a chat belonging to another user', async function () {
      const { processor, chatManager } = build({ ownerUserId: 99 });
      await processor.handleMessage('ws-1', { type: 'chat_send', text: 'hello' });
      await processor.handleMessage('ws-1', { type: 'chat_interrupt' });
      assert.strictEqual(chatManager.calls.send.length, 0);
      assert.strictEqual(chatManager.calls.interrupt.length, 0);
    });
  });

  describe('a server without chat mode', function () {
    it('answers plainly instead of throwing', async function () {
      const { processor, sent } = build({}, {});
      // Rebuilt without the manager: the dependency is optional so existing
      // deployments and every older test keep working untouched.
      processor.deps.chatManager = undefined;
      await processor.startChat('ws-1', 'claude', {});
      assert.match(lastOfType(sent, 'error').message, /not available/i);
    });
  });
});
