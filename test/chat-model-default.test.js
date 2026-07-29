const assert = require('assert');
const WebSocket = require('ws');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// A model picked in one chat used to die with it: the launch resolved exactly
// two candidates — this conversation's own override, then the server-wide
// runtime profile — and neither is scoped to the person who picked. So every
// new chat came back on the agent's built-in default and the choice had to be
// made again, every time (#135).
//
// These drive the launch through a real MessageProcessor with the two new deps
// wired to an in-memory settings store, because the whole claim is about what
// reaches `manager.start` and what the browser is told about why.

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
    // Null unless a test says otherwise: this and the surface together are what
    // "this conversation has never chatted" is read off.
    sessionStartTime: params.sessionStartTime ?? null,
    // The model a previous launch of this conversation actually used. Three
    // states: a name, `null` for "launched with no flag", and absent for a
    // record that predates the pin — which is the only one that still falls to
    // the profile once the conversation has chatted.
    chatModelPinned: params.chatModelPinned,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

/**
 * The user-settings table, as the database namespaces it.
 *
 * Keys are stored exactly as `Database.getUserSetting` composes them —
 * `user:<id>:chatModel:<runtime>` — so a test that expects one account to read
 * another's default has to say so in the key, and cannot get it by accident.
 */
function createSettings(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: (userId, runtime) => rows.get(`user:${userId}:chatModel:${runtime}`) ?? null,
    set: (userId, runtime, model) => {
      const key = `user:${userId}:chatModel:${runtime}`;
      if (model) rows.set(key, model);
      else rows.delete(key);
    },
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
  const settings = createSettings(options.stored);
  const calls = { start: [], rememberModel: [] };
  const chatManager = {
    has: () => false,
    async setModel() {
      return false;
    },
    rememberModel(sessionId, model) {
      calls.rememberModel.push({ sessionId, model });
    },
    async setEffort() {
      return false;
    },
    rememberEffort() {},
    async start(record, startOptions) {
      calls.start.push({ record, options: startOptions });
      return {
        runtimeKind: startOptions.runtime,
        currentCapabilities: { streaming: true },
        bypassing: false,
      };
    },
    async snapshot(record) {
      return {
        sessionId: record.id,
        runtime: 'claude',
        messages: [],
        state: 'idle',
        capabilities: options.models ? { models: options.models } : {},
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
    aliases: { claude: 'Claude', kimi: 'Kimi' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord,
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => options.profile ?? null,
    activeProfileFor: () => options.profile ?? null,
    getUserModelDefault: (userId, runtime) => settings.get(userId, runtime),
    setUserModelDefault: (userId, runtime, model) => settings.set(userId, runtime, model),
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

  return { processor, session, settings, calls, sent };
}

const lastOfType = (sent, type) => sent.filter((m) => m.type === type).pop();
const launchedModel = (calls) => calls.start[0]?.options.model;

describe('the model a new chat opens on', function () {
  it('starts on the model this account last chose for the runtime', async function () {
    const { processor, calls } = build({ stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' } });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'claude-opus-4-6');
  });

  it('lets this conversation’s own choice outrank the standing one', async function () {
    const { processor, session, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
    });
    session.chatModelOverride = 'claude-haiku';

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'claude-haiku');
  });

  it('falls back to the active profile when this account has chosen nothing', async function () {
    const { processor, calls } = build({ profile: { profileName: 'House', model: 'profile-model' } });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'profile-model');
  });

  it('and to the runtime itself when there is neither', async function () {
    const { processor, calls } = build();

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), undefined, 'no flag at all, so the CLI decides');
  });

  // The account's choice is a preference for opening the *next* conversation.
  // Applied to one already under way it would re-model a running conversation
  // from a decision made somewhere else afterwards — which is what a relaunch,
  // a resume from the launcher and the unavailable banner's restart all are.
  //
  // Restated after the adversarial review: this session predates the pin — a
  // row loaded from a database written before the column existed — which is the
  // only case in which the profile still answers for a conversation that has
  // already chatted. Every conversation launched since carries a pin, and the
  // three tests below are what the guarantee actually rests on.
  it('never re-models a conversation that has already chatted', async function () {
    const { processor, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      profile: { profileName: 'House', model: 'profile-model' },
      session: { surface: 'chat', sessionStartTime: new Date(), agent: 'claude' },
    });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'profile-model');
  });

  // The defect the review found, at full size: the seeded model reached the
  // process but nothing on the record, so the second launch — which is what a
  // server restart makes of every open conversation — resolved from scratch and
  // landed somewhere else. Two launches through the real processor, because the
  // whole claim is about what the second one is told.
  it('comes back on the same model when the conversation is relaunched', async function () {
    const { processor, session, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      profile: { profileName: 'House', model: 'profile-model' },
    });

    await processor.startChat('ws-1', 'claude', {});
    session.active = false;
    // What reopening a conversation from the list sends (mount.tsx), and what
    // the unavailable banner's restart sends.
    await processor.startChat('ws-1', 'claude', { resume: true });

    assert.strictEqual(calls.start[0].options.model, 'claude-opus-4-6');
    assert.strictEqual(calls.start[1].options.model, 'claude-opus-4-6', 'and again on the resume');
  });

  // The same conversation, after the account changed its mind somewhere else.
  // A standing choice is for the next new chat; this one keeps what it opened on.
  it('keeps its own model when the standing choice changes underneath it', async function () {
    const { processor, session, settings, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
    });

    await processor.startChat('ws-1', 'claude', {});
    settings.set(7, 'claude', 'claude-haiku');
    session.active = false;
    await processor.startChat('ws-1', 'claude', { resume: true });

    assert.strictEqual(calls.start[1].options.model, 'claude-opus-4-6');
  });

  // A conversation that deliberately ran bare has an answer of its own, and a
  // profile configured afterwards must not overwrite it.
  it('stays bare when it launched bare and a profile appears later', async function () {
    const built = build({});

    await built.processor.startChat('ws-1', 'claude', {});
    assert.strictEqual(built.calls.start[0].options.model, undefined);

    built.session.active = false;
    built.session.chatModelPinned = null;
    // The profile the installer added in between.
    const withProfile = build({
      profile: { profileName: 'House', model: 'profile-model' },
      session: {
        surface: 'chat',
        sessionStartTime: new Date(),
        agent: 'claude',
        lastAgent: 'claude',
        chatModelPinned: null,
      },
    });
    await withProfile.processor.startChat('ws-1', 'claude', { resume: true });

    assert.strictEqual(launchedModel(withProfile.calls), undefined);
  });

  // A pin is a fact in one runtime's vocabulary. Carried into another it would
  // be `--model <a name this CLI has never heard of>`.
  it('drops the pin when the conversation is relaunched on a different runtime', async function () {
    const { processor, calls } = build({
      session: {
        surface: 'chat',
        sessionStartTime: new Date(),
        lastAgent: 'claude',
        chatModelPinned: 'claude-opus-4-6',
      },
    });

    await processor.startChat('ws-1', 'kimi', {});

    assert.strictEqual(launchedModel(calls), undefined);
  });

  // `sessionStartTime` alone would fail this: the terminal launch path sets it
  // too, so a session whose first run was a shell command would have its first
  // chat treated as a continuation.
  it('still applies to the first chat in a session that has only run a terminal', async function () {
    const { processor, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      session: { surface: undefined, sessionStartTime: new Date('2026-01-01') },
    });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'claude-opus-4-6');
  });

  // A launch that threw leaves the surface on 'chat' with nothing behind it.
  // The retry is still this conversation's first.
  it('still applies to a retry after a launch that failed', async function () {
    const { processor, calls } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      session: { surface: 'chat', sessionStartTime: null },
    });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), 'claude-opus-4-6');
  });

  it('is kept per runtime, so a claude model never reaches a kimi launch', async function () {
    const { processor, calls } = build({ stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' } });

    await processor.startChat('ws-1', 'kimi', {});

    assert.strictEqual(launchedModel(calls), undefined);
  });

  // The issue's Security note: a shared install must not let one account's
  // preference decide another's launch. Isolation is a property of the key.
  it('is kept per account, so one user’s choice cannot reach another’s launch', async function () {
    const { processor, calls } = build({
      userId: 7,
      stored: { 'user:99:chatModel:claude': 'someone-elses-model' },
    });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(launchedModel(calls), undefined);
  });

  // What comes back is a database row. A hand-edited one must not become an
  // argv, for the same reason a typed name is normalised on the way in.
  it('re-normalises what it reads, so a hand-edited row cannot become a second argument', async function () {
    const { processor, calls } = build({
      stored: { 'user:7:chatModel:claude': `sneaky\nrm -rf /${'x'.repeat(400)}` },
    });

    await processor.startChat('ws-1', 'claude', {});

    const model = launchedModel(calls);
    assert.ok(!model.includes('\n'), 'a newline would become a second line of the /model turn');
    assert.ok(model.length <= 200, `stored ${model.length} characters`);
  });
});

describe('what the browser is told about where the model came from', function () {
  it('names the account’s own choice on the launch', async function () {
    const { processor, sent } = build({ stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' } });

    await processor.startChat('ws-1', 'claude', {});

    assert.deepStrictEqual(lastOfType(sent, 'chat_started').modelDefault, {
      model: 'claude-opus-4-6',
      source: 'personal',
    });
  });

  it('names the profile, so a pinned model is visible instead of merely in force', async function () {
    const { processor, sent } = build({ profile: { profileName: 'House', model: 'profile-model' } });

    await processor.startChat('ws-1', 'claude', {});

    assert.deepStrictEqual(lastOfType(sent, 'chat_started').modelDefault, {
      model: 'profile-model',
      source: 'profile',
      profileName: 'House',
    });
  });

  it('says plainly that nobody has chosen', async function () {
    const { processor, sent } = build();

    await processor.startChat('ws-1', 'claude', {});

    assert.deepStrictEqual(lastOfType(sent, 'chat_started').modelDefault, {
      model: null,
      source: 'runtime',
    });
  });

  it('repeats it on every join, which is the only place a dead conversation can learn it', async function () {
    const { processor, session, sent } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.subscribeChat(
      processor.deps.webSocketConnections.get('ws-1'),
      session.id,
    );

    assert.deepStrictEqual(lastOfType(sent, 'chat_snapshot').modelDefault, {
      model: 'claude-opus-4-6',
      source: 'personal',
    });
  });

  // And the model this conversation is actually on, separately, because they
  // are different facts and the chip needs the second one: claude reports no
  // model at all, so without this the only thing left to name was the default —
  // which the conversation may never have been launched on.
  it('says what this conversation launched on, apart from what the default is', async function () {
    const { processor, sent } = build({ stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' } });

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(lastOfType(sent, 'chat_started').modelPinned, 'claude-opus-4-6');
  });

  it('says null when the launch passed no model flag at all', async function () {
    const { processor, sent } = build();

    await processor.startChat('ws-1', 'claude', {});

    assert.strictEqual(lastOfType(sent, 'chat_started').modelPinned, null);
  });

  // The reload case, which is the one the chip had no honest answer for: the
  // runtime has reported nothing to this browser yet.
  it('repeats what the conversation is on when a browser rejoins it', async function () {
    const { processor, session, sent } = build({
      stored: { 'user:7:chatModel:claude': 'claude-haiku' },
      session: {
        surface: 'chat',
        agent: 'claude',
        sessionStartTime: new Date(),
        chatModelPinned: 'claude-opus-4-6',
      },
    });

    await processor.subscribeChat(
      processor.deps.webSocketConnections.get('ws-1'),
      session.id,
    );

    const snapshot = lastOfType(sent, 'chat_snapshot');
    assert.strictEqual(snapshot.modelPinned, 'claude-opus-4-6', 'what it is running');
    assert.strictEqual(snapshot.modelDefault.model, 'claude-haiku', 'what the next new chat gets');
  });
});

describe('recording the account’s choice', function () {
  it('remembers a model the runtime published, and applies it to the next new chat', async function () {
    const { processor, session, settings } = build({
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
      models: [{ value: 'claude-opus-4-6', name: 'claude-opus-4-6' }],
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opus-4-6' });

    assert.strictEqual(settings.get(7, 'claude'), 'claude-opus-4-6');
    assert.strictEqual(
      session.chatModelOverride,
      'claude-opus-4-6',
      'and the conversation still has its own override',
    );
  });

  // A model is free text and nothing can pre-judge one — but the cost of a typo
  // changes once the name outlives the conversation it was typed in. An
  // override lasts until the next pick; a standing default becomes
  // `--model <typo>` on every new chat until somebody finds the clear entry.
  it('does not promote a name the runtime’s own list does not contain', async function () {
    const { processor, session, settings } = build({
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
      models: [{ value: 'claude-opus-4-6', name: 'claude-opus-4-6' }],
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opis-4-6' });

    assert.strictEqual(settings.get(7, 'claude'), null, 'a typo must not outlive this conversation');
    assert.strictEqual(
      session.chatModelOverride,
      'claude-opis-4-6',
      'the conversation still gets what was asked for — only the runtime can judge it',
    );
  });

  // Claude publishes no model list at all, so requiring one would mean AC1 was
  // never true there. Nothing to check against is not evidence against.
  it('remembers a name from a runtime that published no list', async function () {
    const { processor, settings } = build({
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opus-4-6' });

    assert.strictEqual(settings.get(7, 'claude'), 'claude-opus-4-6');
  });

  it('forgets it when the override is cleared, which is the only way back', async function () {
    const { processor, settings, sent } = build({
      stored: { 'user:7:chatModel:claude': 'claude-opus-4-6' },
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: '' });

    assert.strictEqual(settings.get(7, 'claude'), null);
    assert.deepStrictEqual(lastOfType(sent, 'chat_model_result').modelDefault, {
      model: null,
      source: 'runtime',
    });
  });

  // "Use the default for this runtime" has to reach the defaults, and the pin
  // sits above them: left in place it would send the conversation straight back
  // to the model it happened to launch on. The one case where re-reading the
  // defaults is not a retcon — the user asked, in this conversation, for them
  // to decide again.
  it('drops the pin as well, so clearing really does fall back to the profile', async function () {
    const { processor, session, calls } = build({
      profile: { profileName: 'House', model: 'profile-model' },
      session: {
        surface: 'chat',
        agent: 'claude',
        lastAgent: 'claude',
        sessionStartTime: new Date(),
        chatModelPinned: 'claude-opus-4-6',
      },
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: '' });
    assert.strictEqual(session.chatModelPinned, undefined);

    session.active = false;
    await processor.startChat('ws-1', 'claude', { resume: true });

    assert.strictEqual(launchedModel(calls), 'profile-model');
  });

  it('records a /model typed into the composer by the same rule', async function () {
    const { processor, settings } = build({
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.handleMessage('ws-1', { type: 'chat_send', text: '/model claude-opus-4-6' });

    assert.strictEqual(settings.get(7, 'claude'), 'claude-opus-4-6');
  });

  it('records nothing for a session belonging to another user', async function () {
    const { processor, settings } = build({
      session: { ownerUserId: 999, surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opus-4-6' });

    assert.strictEqual(settings.get(999, 'claude'), null);
    assert.strictEqual(settings.get(7, 'claude'), null);
  });

  // End to end, because this is the whole complaint in the issue: pick a model
  // in one chat, open a new one on the same agent, and it is still there.
  it('carries a pick in one conversation into the next new one', async function () {
    const { processor, session, settings, calls } = build({
      session: { surface: 'chat', agent: 'claude', sessionStartTime: new Date() },
    });

    await processor.handleMessage('ws-1', { type: 'chat_set_model', model: 'claude-opus-4-6' });

    // A brand new conversation, in the same tab, on the same runtime.
    const fresh = createSessionRecord({ id: 'session-2' });
    fresh.connections.add('ws-1');
    processor.deps.claudeSessions.set('session-2', fresh);
    processor.deps.webSocketConnections.get('ws-1').claudeSessionId = 'session-2';
    session.active = false;

    await processor.startChat('ws-1', 'claude', {}, 'session-2');

    assert.strictEqual(settings.get(7, 'claude'), 'claude-opus-4-6');
    assert.strictEqual(calls.start[0].options.model, 'claude-opus-4-6');
  });
});
