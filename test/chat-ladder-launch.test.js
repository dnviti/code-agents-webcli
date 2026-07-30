const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// A capability ladder used to configure only the helpers the agent delegated
// to. The conversation itself answered from whatever model the runtime would
// have picked on its own — frequently the most expensive one in play — with
// nothing on screen to say the ladder had decided nothing (#171).
//
// These drive the launch through a real MessageProcessor, because the claim is
// about which model reaches `manager.start` and what the browser is told about
// where it came from.

function createSessionRecord(params = {}) {
  return {
    id: params.id || 'session-1',
    ownerUserId: params.ownerUserId ?? 7,
    name: 'Session',
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: params.agent ?? null,
    lastAgent: params.lastAgent ?? null,
    runtimeLabel: null,
    surface: params.surface,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/tmp/project',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: params.sessionStartTime ?? null,
    chatModelPinned: params.chatModelPinned,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

/** A resolved profile as the server hands one to the launch. */
function ladderProfile(extra = {}) {
  return {
    profileId: 'p1',
    profileName: 'Economy',
    ladder: { tier: 'mid', model: 'gateway/mid-model' },
    ...extra,
  };
}

function build(options = {}) {
  const sent = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  const session = createSessionRecord(options.session);
  const rows = new Map(Object.entries(options.stored || {}));
  const calls = { start: [] };
  const chatManager = {
    has: () => false,
    async setModel() {
      return false;
    },
    rememberModel() {},
    async setEffort() {
      return false;
    },
    rememberEffort() {},
    async start(record, startOptions) {
      calls.start.push({ record, options: startOptions });
      // The provider-refusal case: the first attempt throws, the retry does not.
      if (options.refuseModel && startOptions.model === options.refuseModel) {
        throw new Error('model not available on this plan');
      }
      return {
        runtimeKind: startOptions.runtime,
        currentCapabilities: { streaming: true },
        bypassing: false,
      };
    },
    async snapshot(record) {
      return {
        sessionId: record.id,
        runtime: 'pi',
        messages: [],
        state: 'idle',
        capabilities: {},
        pendingPermissions: [],
        firstSeq: 0,
        cursor: 0,
        live: true,
        bypassPermissions: false,
      };
    },
    async send() {},
    async interrupt() {},
    async stop() {},
    async readPage() {
      return { events: [], firstSeq: 0, cursor: 0 };
    },
  };

  const connections = new Map([
    [
      'ws-1',
      {
        id: 'ws-1',
        ws,
        userId: options.userId ?? 7,
        githubLogin: 'tester',
        claudeSessionId: session.id,
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
    aliases: { pi: 'pi', omp: 'Oh My Pi' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord,
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => options.profile ?? null,
    activeProfileFor: () => options.profile ?? null,
    getUserModelDefault: (userId, runtime) => rows.get(`user:${userId}:chatModel:${runtime}`) ?? null,
    setUserModelDefault: () => {},
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

  return { processor, session, calls, sent, ws };
}

const lastOfType = (sent, type) => sent.filter((m) => m.type === type).pop();
const launchedModels = (calls) => calls.start.map((c) => c.options.model);

describe('a conversation opens on its ladder rung', function () {
  it('answers from the rung rather than the runtime’s own default', async function () {
    // The whole of the bug: the four boxes were filled in, the profile was
    // active, and the conversation still ran on whatever pi would have picked.
    const { processor, calls } = build({ profile: ladderProfile() });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['gateway/mid-model']);
  });

  it('says the rung and the model the conversation is on', async function () {
    const { processor, sent } = build({ profile: ladderProfile() });

    await processor.startChat('ws-1', 'pi', {});

    const started = lastOfType(sent, 'chat_started');
    assert.deepStrictEqual(started.modelOrigin, {
      model: 'gateway/mid-model',
      source: 'ladder',
      profileName: 'Economy',
      tier: 'mid',
    });
  });

  it('names the rung it fell to when the chosen one was blank', async function () {
    const { processor, sent } = build({
      profile: ladderProfile({ ladder: { tier: 'high', model: 'h', requested: 'mid' } }),
    });

    await processor.startChat('ws-1', 'pi', {});

    const origin = lastOfType(sent, 'chat_started').modelOrigin;
    assert.strictEqual(origin.tier, 'high');
    assert.strictEqual(origin.requestedTier, 'mid');
  });
});

describe('what still beats the ladder', function () {
  it('a model typed into the profile', async function () {
    const { processor, calls, sent } = build({
      profile: ladderProfile({ model: 'typed/by-hand' }),
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['typed/by-hand']);
    assert.strictEqual(lastOfType(sent, 'chat_started').modelOrigin.source, 'profile');
  });

  it('the account’s standing model for that runtime', async function () {
    const { processor, calls, sent } = build({
      profile: ladderProfile(),
      stored: { 'user:7:chatModel:pi': 'my/standing-choice' },
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['my/standing-choice']);
    assert.strictEqual(lastOfType(sent, 'chat_started').modelOrigin.source, 'personal');
  });

  it('this conversation’s own pick', async function () {
    const { processor, session, calls, sent } = build({ profile: ladderProfile() });
    session.chatModelOverride = 'picked/in-this-chat';

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['picked/in-this-chat']);
    assert.strictEqual(lastOfType(sent, 'chat_started').modelOrigin.source, 'override');
  });
});

describe('conversations that predate the ladder', function () {
  it('move onto it the next time they are relaunched', async function () {
    // Every conversation launched before #171 recorded `chatModelPinned: null`
    // — "it launched with no flag" — and that pin outranks a profile so an
    // unrelated edit cannot re-model a conversation under way. The rung is the
    // one thing it must not outrank, or the ladder would never reach a single
    // conversation that already existed.
    const { processor, calls } = build({
      profile: ladderProfile(),
      session: { chatModelPinned: null, surface: 'chat', sessionStartTime: new Date(), lastAgent: 'pi' },
    });

    await processor.startChat('ws-1', 'pi', { resume: true });

    assert.deepStrictEqual(launchedModels(calls), ['gateway/mid-model']);
  });

  it('still keeps a bare launch bare when the profile only types a model', async function () {
    // The #135 guarantee, untouched: a `null` pin outranks `profile.model`.
    const { processor, calls } = build({
      profile: { profileId: 'p1', profileName: 'House', model: 'added/later' },
      session: { chatModelPinned: null, surface: 'chat', sessionStartTime: new Date(), lastAgent: 'pi' },
    });

    await processor.startChat('ws-1', 'pi', { resume: true });

    assert.deepStrictEqual(launchedModels(calls), [undefined]);
  });

  it('does not pin a rung, so a changed ladder reaches the next launch', async function () {
    const { processor, session } = build({ profile: ladderProfile() });

    await processor.startChat('ws-1', 'pi', {});

    // Recorded as "no flag" rather than as the rung's model, which is what
    // leaves the rung to be re-read rather than replayed.
    assert.strictEqual(session.chatModelPinned, null);
  });

  it('pins a model that did not come from the ladder', async function () {
    const { processor, session } = build({
      profile: ladderProfile({ model: 'typed/by-hand' }),
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.strictEqual(session.chatModelPinned, 'typed/by-hand');
  });
});

describe('a rung the provider will not serve', function () {
  it('starts on the runtime’s default instead of refusing to open', async function () {
    const { processor, calls, sent } = build({
      profile: ladderProfile(),
      refuseModel: 'gateway/mid-model',
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['gateway/mid-model', undefined]);
    const started = lastOfType(sent, 'chat_started');
    assert.ok(started, 'the conversation still starts');
    assert.strictEqual(started.modelOrigin.source, 'runtime');
    assert.match(started.ladderError, /would not start/);
  });

  it('does not retry a model somebody typed in themselves', async function () {
    // A typed model is a request to make. Quietly starting on a different one
    // answers their question wrongly rather than not at all.
    const { processor, calls, sent } = build({
      profile: ladderProfile({ model: 'typed/by-hand' }),
      refuseModel: 'typed/by-hand',
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(launchedModels(calls), ['typed/by-hand']);
    assert.strictEqual(lastOfType(sent, 'chat_started'), undefined);
    assert.match(lastOfType(sent, 'error').message, /Could not start pi/);
  });
});

describe('a ladder that could not be written through', function () {
  it('starts the session anyway and says the ladder was not applied', async function () {
    const { processor, calls, sent } = build({
      profile: {
        profileId: 'p1',
        profileName: 'Economy',
        ladder: null,
        ladderError: 'the ladder could not be written to disk (EROFS)',
      },
    });

    await processor.startChat('ws-1', 'pi', {});

    const started = lastOfType(sent, 'chat_started');
    assert.ok(started, 'the session still starts');
    assert.deepStrictEqual(launchedModels(calls), [undefined]);
    assert.match(started.ladderError, /could not be written/);
  });
});

describe('a browser rejoining a laddered conversation', function () {
  it('is told the rung, not just the model', async function () {
    const { processor, session, sent, ws } = build({ profile: ladderProfile() });
    session.surface = 'chat';
    session.agent = 'pi';
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    const snapshot = lastOfType(sent, 'chat_snapshot');
    assert.strictEqual(snapshot.modelOrigin.source, 'ladder');
    assert.strictEqual(snapshot.modelOrigin.tier, 'mid');
    assert.strictEqual(snapshot.modelOrigin.model, 'gateway/mid-model');
  });
});
