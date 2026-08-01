const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { ChatStore } = require('../dist/server/chat/store.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// Issue #34 asked for copy-a-turn and branch-from-a-turn together. Copy
// shipped; branch was announced in the changelog and never built — the hooks
// existed, nothing passed them, and no runtime here can fork a session at a
// point anyway. So a branch is two things this app does for itself, and both
// are what these tests are about: the new conversation really holds the turns
// up to the branch point, and the agent really receives that history on its
// first turn. Every one of these fails before the change, because before it
// there is no route to call.

const USER = { id: 7, githubLogin: 'dev' };

/**
 * A message processor over these records, with the chat process faked.
 *
 * Only used to launch a branch the route has really created: the approval mode
 * is decided at the launch, so a test that stops at the record proves nothing
 * about what the user gets.
 */
function launcherFor(sessions, sessionId, preference) {
  const chatManager = {
    calls: { start: [] },
    has: () => false,
    async start(record, options) {
      chatManager.calls.start.push({ record, options });
      return {
        runtimeKind: options.runtime,
        currentCapabilities: {},
        bypassing: Boolean(options.bypassPermissions),
      };
    },
    async snapshot() { return { sessionId, runtime: 'claude', messages: [] }; },
    async stop() {},
  };

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: sessions,
    webSocketConnections: new Map([['ws-1', {
      id: 'ws-1',
      ws: { readyState: 1, send() {} },
      userId: USER.id,
      githubLogin: USER.githubLogin,
      claudeSessionId: sessionId,
      chatSessionIds: new Set([sessionId]),
      created: new Date(),
    }]]),
    baseFolder: '/projects',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude' },
    validatePath: () => ({ valid: true, path: '/projects' }),
    getSelectedWorkingDir: () => null,
    createSessionRecord: (params) => chatRecord(params.id, params.name, params.workingDir),
    getRuntimeBridge: () => null,
    saveSessionsToDisk: async () => {},
    resolveRuntimeProfile: () => null,
    getUserPreferences: () => ({ chatBypassPermissions: preference === true }),
    transcriptStore: {
      appendOutput() {},
      ensureTranscript: async () => {},
      readTranscriptChunks: async () => [],
    },
    historyStore: {
      append() {},
      stat: async () => ({ firstLine: 0, totalLines: 0 }),
      read: async () => ({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }),
    },
    chatManager,
    usageReader: {},
    usageAnalytics: {},
  });

  return { processor, chatManager };
}

/**
 * A conversation with `turns` turns, each with a tool call and an answer.
 *
 * Shaped like the real thing rather than invented: every turn opens with the
 * user's own message (which is what opens a turn at all — see openTurnAfter),
 * carries reasoning and a tool call whose output is deliberately recognisable,
 * and ends with a `turn_end` carrying money.
 */
function conversation({ turns, contextWindow, nativeSessionId = 'native-source', padding = 0 }) {
  const events = [];
  let seq = 0;
  const push = (event) => {
    events.push({ ...event, seq: ++seq, ts: seq });
  };

  push({ t: 'session', nativeSessionId, capabilities: {} });
  if (contextWindow) {
    push({ t: 'usage', usage: { contextWindow, contextWindowSource: 'agent' } });
  }

  for (let i = 1; i <= turns; i++) {
    push({ t: 'msg_start', id: `u${i}`, role: 'user', turnId: `turn-${i}` });
    push({ t: 'block_start', msgId: `u${i}`, index: 0, block: { kind: 'text', text: `question ${i}` } });
    push({ t: 'msg_end', msgId: `u${i}` });
    push({ t: 'msg_start', id: `a${i}`, role: 'assistant', turnId: `turn-${i}` });
    push({ t: 'block_start', msgId: `a${i}`, index: 0, block: { kind: 'thinking', text: `REASONING-${i}` } });
    push({
      t: 'block_start',
      msgId: `a${i}`,
      index: 1,
      block: {
        kind: 'tool',
        toolId: `x${i}`,
        name: 'Bash',
        title: `ran step ${i}`,
        toolKind: 'execute',
        status: 'completed',
        output: `TOOL-OUTPUT-${i}`,
      },
    });
    push({
      t: 'block_start',
      msgId: `a${i}`,
      index: 2,
      block: { kind: 'text', text: `answer ${i}${' filler'.repeat(padding)}` },
    });
    push({ t: 'msg_end', msgId: `a${i}`, usage: { inputTokens: 1000, outputTokens: 500 } });
    push({ t: 'turn_end', turnId: `turn-${i}`, stopReason: 'end_turn', usage: { costUsd: 2.5 } });
  }
  return events;
}

function chatRecord(id, name, workingDir) {
  return {
    id,
    ownerUserId: USER.id,
    name: name || `Session ${id}`,
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: 'claude',
    runtimeLabel: 'Claude Code',
    surface: 'chat',
    terminalOptions: null,
    stopRequested: false,
    workingDir: workingDir || '/projects/alpha',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0, models: {} },
    maxBufferSize: 1000,
  };
}

describe('branching a conversation from one of its turns', function () {
  this.timeout(20000);

  let storageDir;
  let activeProfile;
  let store;
  let sessions;
  let server;
  let base;
  let saves;

  beforeEach(async function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-branch-'));
    activeProfile = null;
    store = new ChatStore({ storageDir });
    sessions = new Map();
    saves = 0;

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: USER, authSessionId: 'a' };
      next();
    });
    app.use(
      createSessionRoutes({
        claudeSessions: sessions,
        webSocketConnections: new Map(),
        baseFolder: '/projects',
        dev: false,
        validatePath: (target) =>
          target.startsWith('/projects') ? { valid: true, path: target } : { valid: false, error: 'outside' },
        createSessionRecord: (params) => chatRecord(params.id, params.name, params.workingDir),
        getRuntimeBridge: () => null,
        saveSessionsToDisk: async () => {
          saves += 1;
        },
        transcriptStore: { ensureTranscript: async () => {}, deleteTranscript: async () => {} },
        historyStore: {},
        getScreenSnapshot: () => [],
        disposeRecorder: () => {},
        getSelectedWorkingDir: () => null,
        // Read by the branch alone, and only to pin the model — see the test
        // for it below. A test that wants no profile clears this.
        activeProfileFor: () => activeProfile,
        sessionStore: { getSessionMetadata: async () => ({}) },
        chatStore: store,
      }),
    );

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(function () {
    if (server) server.close();
    if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function record(id, events, name) {
    sessions.set(id, chatRecord(id, name));
    store.append({ id, ownerUserId: USER.id }, events);
    // Forces the store's own queue to drain, so the log is on disk before the
    // route reads it.
    await store.stat({ id, ownerUserId: USER.id });
  }

  async function branch(sessionId, turnId) {
    const response = await fetch(`${base}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const logPath = (id) => path.join(storageDir, String(USER.id), `${id}.jsonl`);

  async function eventsOf(id) {
    const page = await store.read({ id, ownerUserId: USER.id }, 1, 500);
    return page.events;
  }

  // -------------------------------------------------------- what is carried

  it('carries the turns up to and including the one branched from, and no further', async function () {
    await record('source', conversation({ turns: 5, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-3');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.turnIndex, 3);
    assert.strictEqual(made.body.turns, 3);

    const index = await store.turnIndex({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.deepStrictEqual(
      index.turns.map((turn) => turn.label),
      ['question 1', 'question 2', 'question 3'],
      'the branch holds the conversation as far as the turn it was cut at',
    );
    assert.strictEqual(index.complete, true, 'and it holds all of it, so its index says so');

    const events = await eventsOf(made.body.sessionId);
    const text = JSON.stringify(events);
    assert.ok(text.includes('answer 3'), 'the branch turn itself is carried');
    assert.ok(!text.includes('question 4'), 'the turns after it are not');
    assert.ok(!text.includes('answer 4'));
  });

  it('renumbers the carried log from its own beginning and closes it with a rule', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');

    const events = await eventsOf(made.body.sessionId);
    assert.deepStrictEqual(
      events.map((event) => event.seq),
      events.map((_event, position) => position + 1),
      'a new conversation log starts at one and stays contiguous',
    );

    const last = events[events.length - 1];
    assert.strictEqual(last.t, 'marker');
    assert.strictEqual(last.kind, 'branched');
    assert.ok(/turn 2/.test(last.detail), last.detail);
  });

  it('carries a workflow that failed, so a branch does not show it as done', async function () {
    // The launch acknowledgement is what the tool call carries — "Workflow
    // launched in background", no error — so a branch that replayed only that
    // would show a run that broke as a green "done" all over again, which is
    // the bug #140 was about, one conversation along.
    const events = conversation({ turns: 2 });
    let seq = events.length;
    events.push(
      {
        t: 'block_start',
        seq: ++seq,
        ts: seq,
        msgId: 'a1',
        index: 3,
        block: {
          kind: 'tool',
          toolId: 'wf1',
          name: 'Workflow',
          toolKind: 'task',
          status: 'completed',
          output: 'Workflow launched in background. Task ID: k1',
        },
      },
      {
        t: 'workflow_failed',
        seq: ++seq,
        ts: seq,
        parentToolId: 'wf1',
        name: 'nightly-audit',
        reason: 'usage limit reached',
      },
    );
    await record('source-wf', events);

    const made = await branch('source-wf', 'turn-2');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    const carried = await eventsOf(made.body.sessionId);

    const failure = carried.find((event) => event.t === 'workflow_failed');
    assert.ok(failure, 'the branch dropped the failure and kept only the launch');
    assert.strictEqual(failure.name, 'nightly-audit');
    assert.strictEqual(failure.reason, 'usage limit reached');
  });

  it('leaves the conversation it came from untouched', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 200_000 }));
    const before = fs.readFileSync(logPath('source'));

    const made = await branch('source', 'turn-2');
    assert.strictEqual(made.status, 200);

    assert.ok(
      before.equals(fs.readFileSync(logPath('source'))),
      'branching is a read of the source and a write somewhere else',
    );
  });

  it('does not carry the source runtime’s own session id, or its bill', async function () {
    await record('source', conversation({ turns: 3, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');

    const described = await store.describe({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.strictEqual(
      described.nativeSessionId,
      null,
      'a branch that inherited one would offer to resume the conversation it came from',
    );

    const snapshot = await store.snapshot({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.ok(
      !snapshot.usage.costUsd,
      `a branch opens having spent nothing, not ${snapshot.usage.costUsd}`,
    );
  });

  it('opens a conversation of its own, in the same place, on the same runtime', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }), 'Refactoring the parser');
    sessions.get('source').chatModelOverride = 'claude-opus-4-6';
    sessions.get('source').chatBypassPermissions = true;

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.ok(branched, 'the branch is a session the app knows about');
    assert.notStrictEqual(made.body.sessionId, 'source');
    assert.strictEqual(branched.workingDir, '/projects/alpha');
    assert.strictEqual(branched.lastAgent, 'claude');
    assert.strictEqual(branched.surface, 'chat');
    assert.strictEqual(branched.chatModelOverride, 'claude-opus-4-6');
    assert.strictEqual(
      branched.sessionStartTime,
      null,
      'nothing is running in it yet — which is why the pin above matters (#135)',
    );
    assert.ok(/branch at turn 1/.test(branched.name), branched.name);
    assert.strictEqual(
      branched.chatBypassPermissions,
      undefined,
      'a standing permission belongs to the conversation that granted it',
    );
    assert.ok(saves > 0, 'and the new record is persisted');
  });

  it('allocates its append position when the finished branch is inserted', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').tabOrder = 0;

    const originalSetOpeningContext = store.setOpeningContext.bind(store);
    let openingStarted;
    const started = new Promise((resolve) => { openingStarted = resolve; });
    let finishOpening;
    const finished = new Promise((resolve) => { finishOpening = resolve; });
    store.setOpeningContext = async (ref, context) => {
      await originalSetOpeningContext(ref, context);
      openingStarted();
      await finished;
    };

    const branching = branch('source', 'turn-1');
    await started;
    // Another tab opens during the branch's durable-log work. Capturing the
    // position when createSessionRecord ran would now duplicate this ordinal.
    const newer = chatRecord('newer');
    newer.tabOrder = 1;
    sessions.set(newer.id, newer);
    finishOpening();

    const made = await branching;
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(sessions.get(made.body.sessionId).tabOrder, 2);
  });

  // The window the history above was just measured against is the source's
  // model, and a source running on the profile's model carries no override to
  // copy. Left blank the branch is a conversation that has never chatted, so
  // its launch would take the brancher's *standing* model (#135) — a different
  // model from the one the estimate was computed for.
  //
  // Restated: this asserted the pin landed on `chatModelOverride`, which the
  // adversarial review caught as two defects in one. An override is something
  // the *user* said, so the branch's picker would report a model nobody chose
  // as "chosen for this conversation" and offer a clear that wipes the account's
  // standing choice with it. And reading the profile is the wrong question
  // anyway — see the test below, where the source never ran on the profile.
  it('pins a branch of a profile-defaulted conversation to that profile’s model', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.strictEqual(branched.chatModelPinned, 'profile-model');
    assert.strictEqual(
      branched.chatModelOverride,
      undefined,
      'nobody chose this model, so the picker must not report it as a choice',
    );
  });

  // The half the profile lookup could never answer. A source launched on the
  // account's standing choice ran on *that*, not on the profile — and the
  // profile is what the old code copied, so the branch opened on a different
  // model from the one its carried history had just been measured against.
  it('pins a branch to the model its source actually ran, not to the profile', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    // What a launch leaves behind: this source opened on the account's standing
    // choice, which outranks the profile.
    sessions.get('source').chatModelPinned = 'claude-opus-4-6';

    const made = await branch('source', 'turn-1');

    assert.strictEqual(sessions.get(made.body.sessionId).chatModelPinned, 'claude-opus-4-6');
  });

  // A source that ran bare is an answer too, and one the profile must not be
  // allowed to overwrite: the branch inherits "no model flag at all".
  it('carries a source that launched with no model flag as exactly that', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').chatModelPinned = null;

    const made = await branch('source', 'turn-1');

    assert.strictEqual(sessions.get(made.body.sessionId).chatModelPinned, null);
  });

  it('leaves a branch unpinned when there is no profile either, so the runtime still decides', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.strictEqual(branched.chatModelOverride, undefined);
    assert.strictEqual(branched.chatModelPinned, undefined);
  });

  // What the record holds is only half of it. A branch used to *always* ask,
  // whatever the source was doing and whatever the preference said, because
  // nothing consulted the preference at the launch either (#134). Proved here at
  // the launch rather than at the record, because that is where the mode is
  // decided and where the user meets it.
  it('opens in the mode the preference names, whichever the source was in', async function () {
    await record('source', conversation({ turns: 2 }), 'Refactoring the parser');
    sessions.get('source').chatBypassPermissions = true;

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    // The launch the browser sends for a branch: it names no mode at all, and
    // deliberately no resume either — see mount.tsx's openBranch.
    const asking = launcherFor(sessions, branched.id, false);
    await asking.processor.startChat('ws-1', 'claude', {}, branched.id);
    assert.strictEqual(
      asking.chatManager.calls.start[0].options.bypassPermissions,
      false,
      'the source conversation’s bypass must not travel with a branch',
    );

    branched.active = false;
    branched.chatBypassPermissions = undefined;
    const bypassing = launcherFor(sessions, branched.id, true);
    await bypassing.processor.startChat('ws-1', 'claude', {}, branched.id);
    assert.strictEqual(
      bypassing.chatManager.calls.start[0].options.bypassPermissions,
      true,
      'a branch is a conversation beginning, so the preference reaches it',
    );
  });

  it('closes a turn the source never finished, so the branch’s own first ask opens one', async function () {
    // The most natural branch there is: the agent is going the wrong way, so
    // you branch from the turn it is still working on. Carried open, that turn
    // stays open in the branch — and the rule the index and the reducer share
    // hands the branch's own first question to it, with no header, no row and
    // the source's question as its label.
    const events = conversation({ turns: 2, contextWindow: 200_000 });
    const unfinished = events.filter(
      (event) => !(event.t === 'turn_end' && event.turnId === 'turn-2'),
    );
    await record('source', unfinished);

    const made = await branch('source', 'turn-2');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));

    const carried = await eventsOf(made.body.sessionId);
    const ends = carried.filter((event) => event.t === 'turn_end' && event.turnId === 'turn-2');
    assert.strictEqual(ends.length, 1, 'the carried turn was left open');
    assert.ok(
      carried.indexOf(ends[0]) < carried.findIndex((event) => event.t === 'marker'),
      'and it has to close above the rule, or the rule is inside it',
    );
    assert.strictEqual(
      ends[0].usage,
      undefined,
      'nothing was measured about a turn this conversation did not run',
    );
  });

  it('carries the effort the source was running, not just its model', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').chatEffortOverride = 'high';

    const made = await branch('source', 'turn-2');

    assert.strictEqual(
      sessions.get(made.body.sessionId).chatEffortOverride,
      'high',
      'the window the history was just measured against is that model at that level',
    );
  });

  it('refuses a turn that is not in this conversation', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-9');
    assert.strictEqual(made.status, 404);
    assert.strictEqual(sessions.size, 1, 'nothing was created');
  });

  // ------------------------------------------------------- the size check

  it('refuses a history too large for the model’s window rather than trimming it', async function () {
    // A 4,000-token window leaves 2,000 for the history; four turns of padded
    // prose is several times that.
    await record('source', conversation({ turns: 4, contextWindow: 4_000, padding: 400 }));

    const made = await branch('source', 'turn-4');

    assert.strictEqual(made.status, 413, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'context_too_large');
    assert.ok(/4,000-token window/.test(made.body.message), made.body.message);
    assert.ok(/earlier turn/.test(made.body.message), made.body.message);
    assert.strictEqual(sessions.size, 1, 'a refused branch creates nothing');
  });

  it('branches from an earlier turn that does fit, which is what the refusal asks for', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 40_000, padding: 400 }));

    const made = await branch('source', 'turn-1');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.sizeChecked, true);
    assert.strictEqual(made.body.contextWindow, 40_000);
  });

  it('says plainly when nobody reported a window, instead of measuring against a guess', async function () {
    await record('source', conversation({ turns: 3 }));

    const made = await branch('source', 'turn-3');

    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.sizeChecked, false);
    assert.strictEqual(made.body.contextWindow, undefined);

    const events = await eventsOf(made.body.sessionId);
    const marker = events[events.length - 1];
    assert.ok(
      /size not checked/.test(marker.detail),
      `the transcript says so too, not just the reply: ${marker.detail}`,
    );
  });

  // --------------------------------------------- what the agent is handed

  it('hands the carried history to the agent with the first turn, and records only what the user typed', async function () {
    await record('source', conversation({ turns: 3, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');
    const sessionId = made.body.sessionId;

    const sent = [];
    const session = new ChatSession(
      { id: sessionId, ownerUserId: USER.id },
      {
        store,
        socketDir: storageDir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'claude',
      },
    );
    session.adapter = {
      alive: true,
      async send(turn) {
        sent.push(turn);
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {},
    };
    session.state = 'idle';
    // What `start()` would have set: numbering continues after the carried log.
    session.seq = (await store.stat({ id: sessionId, ownerUserId: USER.id })).cursor;

    await session.send({ text: 'now do the next bit' });

    assert.strictEqual(sent.length, 1);
    const delivered = sent[0].text;
    assert.ok(/question 1/.test(delivered), 'the agent is told what was asked before');
    assert.ok(/answer 2/.test(delivered), 'and what was answered, up to the branch point');
    assert.ok(!/question 3/.test(delivered), 'and nothing from after the branch point');
    assert.ok(
      /You were not in it/.test(delivered),
      'and that it was not there for any of it, so it cannot answer for work it never did',
    );
    assert.ok(!/REASONING-1/.test(delivered), 'reasoning is not carried');
    assert.ok(!/TOOL-OUTPUT-1/.test(delivered), 'nor is tool output');
    assert.ok(/ran step 1/.test(delivered), 'though the calls themselves are named');
    assert.ok(
      delivered.endsWith('now do the next bit'),
      'and the thing actually being asked comes last',
    );

    // What the transcript kept is the user's own message and nothing else: a
    // wall of quoted history standing in the conversation as their words would
    // be the same lie in the other direction.
    const events = await eventsOf(sessionId);
    const typed = events.filter(
      (event) => event.t === 'block_start' && event.block.kind === 'text' && /next bit/.test(event.block.text),
    );
    assert.strictEqual(typed.length, 1);
    assert.strictEqual(typed[0].block.text, 'now do the next bit');
    assert.ok(
      !events.some((event) => JSON.stringify(event).includes('You were not in it')),
      'the briefing is not written into the record as something anybody said',
    );

    // Once, not on every turn afterwards. Idle again first: a delivery leaves
    // the session thinking, and a second turn would otherwise take its place in
    // the queue instead of going out.
    session.state = 'idle';
    await session.send({ text: 'and now this' });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].text, 'and now this');
    assert.strictEqual(
      await store.openingContext({ id: sessionId, ownerUserId: USER.id }),
      null,
      'the context is consumed by the turn that carried it',
    );

    // Drains the store's queue: recording a turn is fire-and-forget by design,
    // and a write still in flight when the temp directory goes fails loudly for
    // no reason anybody should have to read.
    await store.stat({ id: sessionId, ownerUserId: USER.id });
  });

  it('keeps the carried history across a restart, until it has been handed over', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-1');
    const ref = { id: made.body.sessionId, ownerUserId: USER.id };

    // A second store over the same directory is what a server restart looks
    // like from here: nothing in memory, everything on disk.
    const restarted = new ChatStore({ storageDir });
    const context = await restarted.openingContext(ref);
    assert.ok(context && /question 1/.test(context), 'the branch is still waiting to be told');

    await restarted.clearOpeningContext(ref);
    assert.strictEqual(await restarted.openingContext(ref), null);
  });
});
