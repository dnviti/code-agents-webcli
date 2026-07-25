const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { broadcastChat } = require('../dist/server/websocket/handler.js');

// Opening a second web chat used to blank the first one. The cause was a pair
// of one-at-a-time assumptions: the server bound each socket to exactly one
// session, and the browser held exactly one transcript. Both halves are
// exercised here, because fixing either alone still leaves the bug.
//
// The property under test throughout is autonomy: a conversation the user is
// not looking at keeps receiving its own events, keeps its own transcript, and
// is not disturbed by — nor able to disturb — any other.

const ROOT = path.join(__dirname, '..');

function sessionRecord(id, ownerUserId = 7, surface = 'chat') {
  return {
    id,
    ownerUserId,
    name: id,
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    surface,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/tmp/project',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

function fakeSocket(sent) {
  return {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

function wsInfo(id, userId, sent) {
  return {
    id,
    ws: fakeSocket(sent),
    userId,
    githubLogin: 'tester',
    claudeSessionId: null,
    chatSessionIds: new Set(),
    created: new Date(),
  };
}

function harness() {
  const sessions = new Map([
    ['chat-a', sessionRecord('chat-a')],
    ['chat-b', sessionRecord('chat-b')],
    // A different owner's conversation, to prove the subscription check is not
    // just a set membership test.
    ['chat-c', sessionRecord('chat-c', 99)],
  ]);

  const sentA = [];
  const sentB = [];
  const connections = new Map([
    ['ws-1', wsInfo('ws-1', 7, sentA)],
    ['ws-2', wsInfo('ws-2', 7, sentB)],
  ]);

  const calls = { send: [], interrupt: [] };
  const chatManager = {
    calls,
    has: () => false,
    async start() {
      return { runtimeKind: 'claude', currentCapabilities: {}, bypassing: false };
    },
    async snapshot(record) {
      return {
        sessionId: record.id,
        runtime: 'claude',
        messages: [],
        state: 'idle',
        capabilities: {},
        pendingPermissions: [],
        firstSeq: 1,
        replayFrom: 1,
        cursor: 0,
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
    respondPermission: () => true,
    async stop() {},
    async readPage() {
      return { events: [], firstSeq: 1, from: 1, cursor: 0 };
    },
  };

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: sessions,
    webSocketConnections: connections,
    baseFolder: '/tmp',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord: () => sessionRecord('x'),
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
      read: () => Promise.resolve({ lines: [], fromLine: 0, firstLine: 0, totalLines: 0 }),
    },
    usageReader: {},
    usageAnalytics: {},
  });

  return { processor, sessions, connections, sentA, sentB, calls };
}

const typesOf = (sent, type) => sent.filter((m) => m.type === type);

describe('a browser watching more than one conversation', function () {
  it('subscribes on join and keeps the previous subscription', async function () {
    const { processor, connections, sentA } = harness();

    await processor.joinSession('ws-1', 'chat-a');
    await processor.joinSession('ws-1', 'chat-b');

    const info = connections.get('ws-1');
    assert.deepStrictEqual([...info.chatSessionIds].sort(), ['chat-a', 'chat-b']);
    // Driving is still one at a time; watching is not.
    assert.strictEqual(info.claudeSessionId, 'chat-b');

    const snapshots = typesOf(sentA, 'chat_snapshot').map((m) => m.sessionId);
    assert.deepStrictEqual(snapshots, ['chat-a', 'chat-b']);
  });

  it('delivers a background conversation’s events to the socket that left it', async function () {
    const { processor, sessions, connections, sentA } = harness();

    await processor.joinSession('ws-1', 'chat-a');
    await processor.joinSession('ws-1', 'chat-b');
    sentA.length = 0;

    broadcastChat('chat-a', { type: 'chat_event', sessionId: 'chat-a', event: { t: 'state', state: 'thinking' } }, sessions, connections);

    // The regression: this used to arrive nowhere, because ws-1 had "left"
    // chat-a and session.connections no longer held it.
    assert.deepStrictEqual(
      typesOf(sentA, 'chat_event').map((m) => m.sessionId),
      ['chat-a'],
    );
  });

  it('does not leak one user’s conversation to another', async function () {
    const { processor, sessions, connections, sentB } = harness();

    // ws-2 belongs to user 7; chat-c belongs to user 99.
    await processor.subscribeChat(connections.get('ws-2'), 'chat-c');
    assert.strictEqual(connections.get('ws-2').chatSessionIds.has('chat-c'), false);
    assert.deepStrictEqual(typesOf(sentB, 'chat_snapshot'), []);

    sentB.length = 0;
    broadcastChat('chat-c', { type: 'chat_event', sessionId: 'chat-c' }, sessions, connections);
    assert.deepStrictEqual(typesOf(sentB, 'chat_event'), []);
  });

  it('routes a typed turn to the conversation the tab names, not the joined one', async function () {
    const { processor, connections, calls } = harness();

    await processor.joinSession('ws-1', 'chat-a');
    await processor.joinSession('ws-1', 'chat-b');

    await processor.handleMessage('ws-1', {
      type: 'chat_send',
      sessionId: 'chat-a',
      text: 'from the background tab',
    });

    assert.deepStrictEqual(calls.send.map((c) => c.sessionId), ['chat-a']);
    assert.strictEqual(connections.get('ws-1').claudeSessionId, 'chat-b');
  });

  it('refuses to drive a conversation the socket never subscribed to', async function () {
    const { processor, calls } = harness();

    await processor.handleMessage('ws-1', {
      type: 'chat_send',
      sessionId: 'chat-b',
      text: 'unsubscribed',
    });

    assert.deepStrictEqual(calls.send, []);
  });

  it('stops delivering once a tab unsubscribes', async function () {
    const { processor, sessions, connections, sentA } = harness();

    await processor.joinSession('ws-1', 'chat-a');
    await processor.joinSession('ws-1', 'chat-b');
    await processor.handleMessage('ws-1', { type: 'chat_unsubscribe', sessionId: 'chat-a' });
    sentA.length = 0;

    broadcastChat('chat-a', { type: 'chat_event', sessionId: 'chat-a' }, sessions, connections);
    assert.deepStrictEqual(typesOf(sentA, 'chat_event'), []);
  });
});

// ---------------------------------------------------------------------------
// The browser half: one controller per conversation, routed by session id.
// ---------------------------------------------------------------------------

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatRegistry } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/registry'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-multisession-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-multisession.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

function snapshotFor(sessionId, text) {
  return {
    sessionId,
    runtime: 'claude',
    messages: [
      { id: `m-${sessionId}`, seq: 1, turnId: 't', role: 'assistant', ts: 1, blocks: [{ kind: 'text', text }] },
    ],
    state: 'idle',
    capabilities: {},
    pendingPermissions: [],
    firstSeq: 1,
    replayFrom: 1,
    cursor: 1,
    live: true,
    bypassPermissions: false,
  };
}

describe('the chat controller registry', function () {
  function registry({ features = ['chat_subscribe'] } = {}) {
    const sent = [];
    const changed = [];
    const reg = new mod.ChatRegistry({
      send: (m) => sent.push(m),
      onChange: (id) => changed.push(id),
    });
    reg.setFeatures(features);
    sent.length = 0;
    return { reg, sent, changed };
  }

  it('keeps a transcript per conversation instead of one for the page', function () {
    const { reg } = registry();

    reg.handle({ type: 'chat_snapshot', sessionId: 'a', snapshot: snapshotFor('a', 'first chat') });
    reg.handle({ type: 'chat_snapshot', sessionId: 'b', snapshot: snapshotFor('b', 'second chat') });

    // The exact regression: hydrating the second conversation used to overwrite
    // the first, and the tab the user came back to was empty.
    assert.strictEqual(reg.get('a').transcript.messages[0].blocks[0].text, 'first chat');
    assert.strictEqual(reg.get('b').transcript.messages[0].blocks[0].text, 'second chat');
  });

  it('applies an event to the conversation it names', function () {
    const { reg } = registry();
    reg.handle({ type: 'chat_snapshot', sessionId: 'a', snapshot: snapshotFor('a', 'x') });
    reg.handle({ type: 'chat_snapshot', sessionId: 'b', snapshot: snapshotFor('b', 'y') });

    reg.handle({
      type: 'chat_event',
      sessionId: 'b',
      event: { t: 'state', seq: 2, ts: 1, state: 'thinking' },
    });

    assert.strictEqual(reg.get('a').transcript.chatState, 'idle');
    assert.strictEqual(reg.get('b').transcript.chatState, 'thinking');
  });

  it('keeps each conversation\u2019s queue to itself', function () {
    const { reg } = registry();
    reg.handle({ type: 'chat_snapshot', sessionId: 'a', snapshot: snapshotFor('a', 'x') });
    reg.handle({ type: 'chat_snapshot', sessionId: 'b', snapshot: snapshotFor('b', 'y') });

    reg.handle({ type: 'chat_queue', sessionId: 'b', queued: [{ id: 'q1', text: 'later', ts: 1 }] });

    assert.deepStrictEqual(reg.get('a').transcript.queuedTurns, []);
    assert.deepStrictEqual(reg.get('b').transcript.queuedTurns.map((t) => t.text), ['later']);
  });

  it('takes the whole queue from the server rather than patching a local copy', function () {
    const { reg } = registry();
    reg.handle({ type: 'chat_snapshot', sessionId: 'a', snapshot: snapshotFor('a', 'x') });

    reg.handle({
      type: 'chat_queue',
      sessionId: 'a',
      queued: [{ id: 'q1', text: 'one', ts: 1 }, { id: 'q2', text: 'two', ts: 2 }],
    });
    // A turn started running: the server says so by sending the line without
    // it. Reconciling removals locally is how two browsers drift apart.
    reg.handle({ type: 'chat_queue', sessionId: 'a', queued: [{ id: 'q2', text: 'two', ts: 2 }] });

    assert.deepStrictEqual(reg.get('a').transcript.queuedTurns.map((t) => t.text), ['two']);

    reg.handle({ type: 'chat_queue', sessionId: 'a', queued: [] });
    assert.deepStrictEqual(reg.get('a').transcript.queuedTurns, []);
  });

  it('names the session when withdrawing a queued turn', function () {
    const { reg, sent } = registry();
    reg.handle({ type: 'chat_snapshot', sessionId: 'b', snapshot: snapshotFor('b', 'y') });
    sent.length = 0;

    reg.get('b').cancelQueued('q7');
    assert.deepStrictEqual(sent, [{ type: 'chat_queue_cancel', queuedId: 'q7', sessionId: 'b' }]);
  });

  it('claims the chat channel, and opens a conversation from any of its messages', function () {
    const { reg } = registry();
    // Answering false here would hand the message to the terminal path, which
    // has no idea what a chat event is.
    assert.strictEqual(reg.handle({ type: 'chat_event', sessionId: 'unknown', event: {} }), true);
    // And it must not be dropped: a launch emits the `session` event carrying
    // the runtime's slash commands *before* `chat_started` announces the
    // conversation, so waiting for the announcement lost them.
    assert.strictEqual(reg.has('unknown'), true);
  });

  it('keeps the capabilities a launch reports before it is announced', function () {
    const { reg } = registry();
    const commands = [{ name: 'review' }, { name: 'commit' }];

    reg.handle({
      type: 'chat_event',
      sessionId: 'a',
      event: {
        t: 'session',
        seq: 1,
        ts: 1,
        capabilities: { streaming: true, commands },
      },
    });
    reg.handle({ type: 'chat_started', sessionId: 'a', agent: 'claude' });

    assert.deepStrictEqual(reg.get('a').transcript.capabilities.commands, commands);
  });

  it('leaves non-chat messages to the terminal handler', function () {
    const { reg } = registry();
    assert.strictEqual(reg.handle({ type: 'output', data: 'x' }), false);
  });

  it('stamps every outgoing message with its own session id', function () {
    const { reg, sent } = registry();
    reg.ensure('a').sendTurn('hello');
    reg.ensure('b').interrupt();

    assert.deepStrictEqual(
      sent.map((m) => [m.type, m.sessionId]),
      [
        ['chat_send', 'a'],
        ['chat_interrupt', 'b'],
      ],
    );
  });

  it('re-subscribes everything it is watching after a reconnect', function () {
    const { reg, sent } = registry();
    reg.ensure('a');
    reg.ensure('b');
    sent.length = 0;

    reg.resubscribeAll();

    assert.deepStrictEqual(
      sent.map((m) => m.sessionId).sort(),
      ['a', 'b'],
    );
    assert.ok(sent.every((m) => m.type === 'chat_subscribe'));
  });

  it('asks an older server for nothing it has not advertised', function () {
    // The server answers an unknown message with a visible error, so a client
    // that spoke first would turn a routine version gap into an error toast
    // per chat tab. It falls back to one live conversation at a time, which is
    // what that server can actually do.
    const { reg, sent } = registry({ features: [] });
    assert.strictEqual(reg.supportsMultiSession, false);

    reg.subscribe('a');
    reg.resubscribeAll();
    reg.drop('a');

    assert.deepStrictEqual(sent, []);
  });

  it('picks the conversations up once a reconnect finds an upgraded server', function () {
    const { reg, sent } = registry({ features: [] });
    reg.ensure('a');
    reg.ensure('b');
    sent.length = 0;

    reg.setFeatures(['chat_subscribe']);

    assert.deepStrictEqual(sent.map((m) => m.sessionId).sort(), ['a', 'b']);
  });

  it('unsubscribes and forgets a conversation that is dropped', function () {
    const { reg, sent } = registry();
    reg.ensure('a');
    sent.length = 0;

    reg.drop('a');

    assert.deepStrictEqual(sent, [{ type: 'chat_unsubscribe', sessionId: 'a' }]);
    assert.strictEqual(reg.has('a'), false);
  });
});
