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
    chatBypassPermissions: params.chatBypassPermissions,
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
  const calls = {
    start: [], send: [], interrupt: [], permission: [], page: [], cancelQueued: [],
    setModel: [], rememberModel: [],
  };
  return {
    calls,
    has: () => false,
    async setModel(sessionId, model) {
      calls.setModel.push({ sessionId, model });
      return false;
    },
    rememberModel(sessionId, model) {
      calls.rememberModel.push({ sessionId, model });
    },
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

  describe('startRuntime (PTY)', function () {
    it('lets a saved model override outrank the profile default on this launch too', async function () {
      const { processor, session } = build({ surface: undefined });
      session.chatModelOverride = 'saved-override';
      processor.deps.resolveRuntimeProfile = () => ({ profileName: 'p', model: 'profile-default' });

      const startCalls = [];
      processor.deps.getRuntimeBridge = () => ({
        startSession: async (sessionId, options) => {
          startCalls.push(options);
          return { pid: 1 };
        },
      });

      await processor.startRuntime('ws-1', 'claude', {});

      assert.strictEqual(startCalls.length, 1, 'the bridge was not asked to start');
      assert.strictEqual(startCalls[0].model, 'saved-override');
    });
  });

  // The approval mode is part of how the user set a conversation up, so it has
  // to outlive the process serving it. It used to live only on the live
  // ChatSession: reconnecting to a conversation whose agent had gone, restarting
  // the server, or resuming from the launcher all brought it back in manual mode
  // without saying so — and the user was then interrupted by prompts they had
  // opted out of, or trusted prompts that were no longer coming.
  describe('the approval mode', function () {
    it('records the chosen mode on the session, where a restart can find it', async function () {
      const { processor, session } = build();

      await processor.startChat('ws-1', 'claude', { dangerouslySkipPermissions: true });

      assert.strictEqual(session.chatBypassPermissions, true);
    });

    it('restores the remembered mode when the browser names none', async function () {
      // Both a relaunch of a dead conversation and a resume from the launcher
      // arrive here without a mode. Falling back to manual is what silently
      // dropped the bypass.
      const { processor, chatManager, sent } = build({ chatBypassPermissions: true });

      await processor.startChat('ws-1', 'claude', { resume: true });

      assert.strictEqual(chatManager.calls.start[0].options.bypassPermissions, true);
      assert.strictEqual(
        lastOfType(sent, 'chat_started').bypassPermissions,
        true,
        'the browser has to be told the mode it came back in',
      );
    });

    it('never restores a conversation that asked first into a bypass', async function () {
      const { processor, chatManager, session, sent } = build();

      await processor.startChat('ws-1', 'claude', { resume: true });

      assert.strictEqual(chatManager.calls.start[0].options.bypassPermissions, false);
      assert.strictEqual(session.chatBypassPermissions, undefined);
      assert.strictEqual(lastOfType(sent, 'chat_started').bypassPermissions, false);
    });

    it('does not carry a bypass into a conversation started fresh', async function () {
      // "Start again" leaves the old conversation behind. The bypass was granted
      // to that conversation, and letting it cross would make one choice the
      // standing answer for every later conversation in the same tab.
      const { processor, chatManager, session, sent } = build({ chatBypassPermissions: true });

      await processor.startChat('ws-1', 'claude', { resume: false });

      assert.strictEqual(chatManager.calls.start[0].options.bypassPermissions, false);
      assert.strictEqual(session.chatBypassPermissions, undefined);
      assert.strictEqual(
        lastOfType(sent, 'chat_started').bypassPermissions,
        false,
        'and the header has to say the mode actually changed',
      );
    });

    it('lets an explicit choice turn the bypass back off', async function () {
      // The remembered mode is a default for a launch that names none, not an
      // override: a mode the user is standing in front of choosing wins.
      const { processor, chatManager, session } = build({ chatBypassPermissions: true });

      await processor.startChat('ws-1', 'claude', { dangerouslySkipPermissions: false });

      assert.strictEqual(chatManager.calls.start[0].options.bypassPermissions, false);
      assert.strictEqual(session.chatBypassPermissions, undefined);
    });

    it('does not remember a bypass from a launch that never ran', async function () {
      // Persisting a standing permission has to follow from a conversation that
      // really started in it, not from an attempt that failed.
      const { processor, session } = build(
        {},
        { start: () => Promise.reject(new Error('claude is not installed')) },
      );

      await processor.startChat('ws-1', 'claude', { dangerouslySkipPermissions: true });

      assert.strictEqual(session.chatBypassPermissions, undefined);
    });

    it('takes the mode from the session that was named, not the one joined', async function () {
      // A browser watching several conversations relaunches a specific one. The
      // remembered mode has to be read off that record, or a bypass could be
      // carried into a conversation that never chose it.
      const { processor, chatManager, session } = build({ chatBypassPermissions: true });

      const other = createSessionRecord({ id: 'session-2' });
      processor.deps.claudeSessions.set(other.id, other);
      processor.deps.webSocketConnections.get('ws-1').chatSessionIds.add(other.id);

      await processor.startChat('ws-1', 'claude', {}, other.id);

      assert.strictEqual(chatManager.calls.start[0].options.bypassPermissions, false);
      assert.strictEqual(other.chatBypassPermissions, undefined);
      assert.strictEqual(session.chatBypassPermissions, true, 'the other record is untouched');
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

  describe('chat_set_model', function () {
    it('applies live when the adapter can switch without a restart', async function () {
      const { processor, chatManager, session, sent } = build(
        { surface: 'chat' },
        { setModel: async (sessionId, model) => { chatManager.calls.setModel.push({ sessionId, model }); return true; } },
      );

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'grok-3-fast' });

      assert.deepStrictEqual(chatManager.calls.setModel[0], { sessionId: 'session-1', model: 'grok-3-fast' });
      assert.strictEqual(session.chatModelOverride, 'grok-3-fast', 'the override is persisted regardless of how it applied');
      const result = lastOfType(sent, 'chat_model_result');
      assert.strictEqual(result.applied, 'live');
      assert.strictEqual(result.model, 'grok-3-fast');
    });

    it('falls back to a best-effort slash command when the runtime advertises /model but cannot switch live', async function () {
      const { processor, chatManager, session, sent } = build(
        { surface: 'chat' },
        {
          async snapshot(record) {
            return {
              sessionId: record.id,
              runtime: 'claude',
              messages: [],
              state: 'idle',
              capabilities: { commands: [{ name: 'model' }] },
              pendingPermissions: [],
              firstSeq: 0,
              cursor: 0,
              live: true,
              bypassPermissions: false,
            };
          },
        },
      );

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opus' });

      assert.strictEqual(chatManager.calls.send.length, 1, 'the slash command must be sent as a turn');
      assert.strictEqual(chatManager.calls.send[0].turn.text, '/model claude-opus');
      assert.strictEqual(session.chatModelOverride, 'claude-opus');
      const result = lastOfType(sent, 'chat_model_result');
      assert.strictEqual(result.applied, 'sent');
    });

    it('saves for the next session when nothing live can take the change', async function () {
      const { processor, session, sent } = build({ surface: 'chat' });

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'some-custom-model' });

      assert.strictEqual(session.chatModelOverride, 'some-custom-model', 'still persisted for next launch');
      const result = lastOfType(sent, 'chat_model_result');
      assert.strictEqual(result.applied, 'pending');
      assert.match(result.message, /next time/i);
    });

    it('clears the override rather than treating an empty string as a model', async function () {
      const { processor, session, sent } = build({ surface: 'chat' });
      session.chatModelOverride = 'previously-set';

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: '' });

      assert.strictEqual(session.chatModelOverride, undefined);
      const result = lastOfType(sent, 'chat_model_result');
      assert.strictEqual(result.applied, 'cleared');
      assert.strictEqual(result.model, null);
    });

    // A live session holds the options `/clear` will relaunch from, and the
    // model is the only one this handler can change. Without carrying it over,
    // the next `/clear` reinstated the model the conversation opened with.
    it('carries the new model into the options a /clear restart replays', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'some-custom-model' });

      assert.deepStrictEqual(chatManager.calls.rememberModel[0], {
        sessionId: 'session-1',
        model: 'some-custom-model',
      });
    });

    it('carries the profile default across when the override is cleared', async function () {
      const { processor, chatManager } = build({ surface: 'chat' });
      processor.deps.resolveRuntimeProfile = () => ({ profileName: 'p', model: 'profile-default' });

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: '' });

      // The value itself, not just that something was carried: clearing has to
      // land where a fresh launch would land, which is the profile's model and
      // not the runtime's own default.
      assert.deepStrictEqual(chatManager.calls.rememberModel[0], {
        sessionId: 'session-1',
        model: 'profile-default',
      });
    });

    // The same choice by the other door. Forwarding it untouched left the
    // record unaware, so the next /clear restarted on the original model.
    it('records a /model typed straight into the composer, and still forwards it', async function () {
      const { processor, chatManager, session } = build({ surface: 'chat' });

      await processor.handleMessage('ws-1', { type: 'chat_send', text: '/model haiku-3' });

      assert.strictEqual(session.chatModelOverride, 'haiku-3');
      assert.deepStrictEqual(chatManager.calls.rememberModel[0], {
        sessionId: 'session-1',
        model: 'haiku-3',
      });
      assert.strictEqual(
        chatManager.calls.send[0].turn.text,
        '/model haiku-3',
        'the runtime still has to receive its own command',
      );
    });

    it('leaves an ordinary message that merely mentions /model alone', async function () {
      const { processor, chatManager, session } = build({ surface: 'chat' });

      await processor.handleMessage('ws-1', { type: 'chat_send', text: 'what does /model do?' });

      assert.strictEqual(session.chatModelOverride, undefined);
      assert.strictEqual(chatManager.calls.rememberModel.length, 0);
    });

    it('strips control characters and caps the length of a typed model name', async function () {
      const { processor, session } = build({ surface: 'chat' });

      await processor.handleMessage('ws-1', {
        type: 'chat_set_model',
        model: `sneaky\nrm -rf /${'x'.repeat(400)}`,
      });

      assert.ok(!session.chatModelOverride.includes('\n'), 'a newline would become a second line of the /model turn');
      assert.ok(session.chatModelOverride.length <= 200, `stored ${session.chatModelOverride.length} characters`);
    });

    it('lets a saved override outrank the profile default on the next launch', async function () {
      const { processor, chatManager, session } = build(
        { surface: 'chat' },
        {},
      );
      session.chatModelOverride = 'saved-override';
      processor.deps.resolveRuntimeProfile = () => ({ profileName: 'p', model: 'profile-default' });

      await processor.startChat('ws-1', 'claude', {});

      assert.strictEqual(chatManager.calls.start[0].options.model, 'saved-override');
    });

    it('will not set a model override for a session belonging to another user', async function () {
      const { processor, chatManager, session } = build({ surface: 'chat', ownerUserId: 999 });

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'sneaky-model' });

      assert.strictEqual(chatManager.calls.setModel.length, 0);
      assert.strictEqual(session.chatModelOverride, undefined);
    });

    it('reports pending rather than live when the adapter’s live switch throws', async function () {
      const { processor, session, sent } = build(
        { surface: 'chat' },
        { setModel: async () => { throw new Error('adapter rejected the switch'); } },
      );

      await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'grok-3-fast' });

      assert.strictEqual(session.chatModelOverride, 'grok-3-fast', 'still saved for next launch despite the failed live attempt');
      const result = lastOfType(sent, 'chat_model_result');
      assert.strictEqual(result.applied, 'pending');
      assert.match(result.message, /adapter rejected the switch|next time/i);
    });

    it('falls back to the profile default on the next launch when no override was ever saved', async function () {
      const { processor, chatManager } = build({ surface: 'chat' }, {});
      processor.deps.resolveRuntimeProfile = () => ({ profileName: 'p', model: 'profile-default' });

      await processor.startChat('ws-1', 'claude', {});

      assert.strictEqual(chatManager.calls.start[0].options.model, 'profile-default');
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
