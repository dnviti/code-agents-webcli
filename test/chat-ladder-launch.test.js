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
    // What the real manager answers: the rung the *running* session is on. A
    // snapshot must not read the profile's current rung instead — a
    // conversation that launched bare carries the same null pin, and reporting
    // the profile's rung for it draws the chip as running a model the process
    // is not on (#135, again).
    ladderOf: () => options.runningLadder ?? null,
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
        // Whether a process is answering right now, which is the session's own
        // answer and not the record's flag. The two disagree in both directions
        // — an adapter that died through its error path never reports `exited`,
        // so the record still says active — which is why a test can set them
        // apart here.
        live: options.live ?? true,
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

  it('does not leave the conversation on the rung it was refused', async function () {
    // The retry used to be launched while the origin still said 'ladder', so
    // the session was handed the ladder anyway: `ladderOf` then reported the
    // refused rung to every browser that rejoined — contradicting the launch,
    // which had just said the opposite — and the escalation tool was offered
    // from a rung nobody was on.
    const { processor, calls, session } = build({
      profile: ladderProfile({ tiers: { mid: 'gateway/mid-model', high: 'gateway/high-model' } }),
      refuseModel: 'gateway/mid-model',
    });

    await processor.startChat('ws-1', 'pi', {});

    assert.deepStrictEqual(calls.start.map((c) => c.options.ladder), [
      { tier: 'mid', tiers: { mid: 'gateway/mid-model', high: 'gateway/high-model' } },
      undefined,
    ]);
    assert.strictEqual(session.chatModelPinned, null);
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
  it('is told nothing about a rung when the conversation is not on one', async function () {
    // A conversation that launched bare records the same null pin as one on a
    // rung. Reading the profile's current rung for it would name a model the
    // process is not running — the exact failure #135 introduced this field to
    // remove. Running, so the null pin is unambiguous: this process really did
    // start with no model flag.
    const { processor, session, sent, ws } = build({ profile: ladderProfile() });
    session.surface = 'chat';
    session.agent = 'pi';
    session.active = true;
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    const snapshot = lastOfType(sent, 'chat_snapshot');
    assert.strictEqual(snapshot.modelOrigin.source, 'runtime');
    assert.strictEqual(snapshot.modelOrigin.model, null);
  });

  it('claims no model at all for a conversation that has stopped', async function () {
    // The same null pin, read after the process is gone — a reload, or a tab
    // opened on a conversation that ended. A laddered conversation records
    // exactly this pin, so answering "the runtime's own default" here names a
    // model it was not on and will not be on when it is relaunched. Nothing is
    // in force while nothing is running, and that is what goes out.
    const { processor, session, sent, ws } = build({ profile: ladderProfile(), live: false });
    session.surface = 'chat';
    session.agent = 'pi';
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.strictEqual(lastOfType(sent, 'chat_snapshot').modelOrigin, null);
  });

  it('asks the conversation whether it is running, not the record', async function () {
    // The record is marked active and the process is gone: an adapter that dies
    // through its error path emits `error`, never `exited`, so nothing ever
    // corrects the flag the launch set. Reading it here would put the very
    // sentence this gate exists to remove back on screen.
    const { processor, session, sent, ws } = build({ profile: ladderProfile(), live: false });
    session.surface = 'chat';
    session.agent = 'pi';
    session.active = true;
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.strictEqual(lastOfType(sent, 'chat_snapshot').modelOrigin, null);
  });

  it('and answers for a conversation the record has already given up on', async function () {
    // The other direction, which codex produces on every fallback launch: the
    // abandoned handshake probe reports an exit into a session whose fallback
    // is answering normally. The conversation really is on the runtime's own
    // default and should say so.
    const { processor, session, sent, ws } = build({ profile: ladderProfile(), live: true });
    session.surface = 'chat';
    session.agent = 'pi';
    session.active = false;
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.strictEqual(lastOfType(sent, 'chat_snapshot').modelOrigin.source, 'runtime');
  });

  it('still answers for a stopped conversation the record can speak for', async function () {
    // A pin and an override are not guesses: one is the model this conversation
    // launched on, the other the model somebody chose for it, and both survive
    // the process to decide its next launch.
    const { processor, session, sent, ws } = build({ profile: ladderProfile(), live: false });
    session.surface = 'chat';
    session.agent = 'pi';
    session.chatModelPinned = 'launched/on-this';

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    const snapshot = lastOfType(sent, 'chat_snapshot');
    assert.deepStrictEqual(snapshot.modelOrigin, {
      model: 'launched/on-this',
      source: 'override',
    });
  });

  it('is told the rung, not just the model', async function () {
    const { processor, session, sent, ws } = build({
      profile: ladderProfile(),
      runningLadder: { tier: 'mid', model: 'gateway/mid-model' },
    });
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

  it('keeps the explanation for a rung it fell to', async function () {
    // The launch says "mid is blank, so the nearest filled rung answered"; the
    // running session knows only which rung it is on, so without the profile's
    // half of it the parenthetical survives exactly one screen.
    const { processor, session, sent, ws } = build({
      profile: ladderProfile({ ladder: { tier: 'high', model: 'h', requested: 'mid' } }),
      runningLadder: { tier: 'high', model: 'h' },
    });
    session.surface = 'chat';
    session.agent = 'pi';
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    const origin = lastOfType(sent, 'chat_snapshot').modelOrigin;
    assert.strictEqual(origin.tier, 'high');
    assert.strictEqual(origin.requestedTier, 'mid');
  });

  it('does not carry that explanation onto a rung the conversation has moved to', async function () {
    // An escalation, or a ladder edited under a live conversation: the rung the
    // profile fell to is not the rung being answered from, so the reason it
    // fell has nothing to say about it.
    const { processor, session, sent, ws } = build({
      profile: ladderProfile({ ladder: { tier: 'high', model: 'h', requested: 'mid' } }),
      runningLadder: { tier: 'top', model: 't' },
    });
    session.surface = 'chat';
    session.agent = 'pi';
    session.chatModelPinned = null;

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    const origin = lastOfType(sent, 'chat_snapshot').modelOrigin;
    assert.strictEqual(origin.tier, 'top');
    assert.strictEqual(origin.requestedTier, undefined);
  });

  it('repeats why the ladder is not applied, which only the launch was told', async function () {
    // The badge said so once, to the tab that watched it start. Every other
    // screen — a reload, a reconnect, a second tab — arrives at a snapshot, and
    // the client zeroes the field on each one, so a snapshot that stayed silent
    // took the warning down while the ladder was still not applied.
    const { processor, session, sent, ws } = build({
      profile: ladderProfile(),
      refuseModel: 'gateway/mid-model',
    });

    await processor.startChat('ws-1', 'pi', {});
    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.match(lastOfType(sent, 'chat_snapshot').ladderError, /would not start/);
  });

  it('does not hand a conversation a failure that is not its own', async function () {
    // It launched cleanly; the profile has failed to write its tier files
    // since. The conversation is running on the rung it resolved then, and a
    // badge saying its ladder was not applied would be describing somebody
    // else's next launch.
    const { processor, session, sent, ws } = build({ profile: ladderProfile() });

    await processor.startChat('ws-1', 'pi', {});
    processor.deps.activeProfileFor = () =>
      ladderProfile({ ladderError: 'the ladder could not be written to disk (EROFS)' });
    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.strictEqual(lastOfType(sent, 'chat_snapshot').ladderError, null);
  });

  it('repeats a ladder that could not be written through, from the profile', async function () {
    // This half outlives the process: the profile still cannot write its tier
    // files, so a conversation that has since stopped explains itself from the
    // profile rather than from a record that never held a launch failure.
    const { processor, session, sent, ws } = build({
      profile: {
        profileId: 'p1',
        profileName: 'Economy',
        ladder: null,
        ladderError: 'the ladder could not be written to disk (EROFS)',
      },
      live: false,
    });
    session.surface = 'chat';
    session.agent = 'pi';

    await processor.subscribeChat(
      { id: 'ws-1', ws, userId: 7, chatSessionIds: new Set() },
      session.id,
    );

    assert.match(lastOfType(sent, 'chat_snapshot').ladderError, /could not be written/);
  });
});
