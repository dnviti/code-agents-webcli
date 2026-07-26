const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatStore } = require('../dist/server/chat/store.js');
const { ChatSessionManager } = require('../dist/server/chat/manager.js');
const { SessionStore } = require('../dist/server/services/session-store.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

// The approval mode across a real server restart.
//
// Every other test of this stubs one side or the other: the wiring tests hand
// the message processor a fake chat manager, and the manager tests hand it a
// fake log. The defect this fixes lived in neither half — it lived in the fact
// that nothing wrote the mode down, so it crossed no boundary at all. This walks
// the whole way: a chat is launched with approvals bypassed, the sessions are
// saved to SQLite, a new SessionStore reads them back the way a restarted server
// does, and the conversation is asked what mode it is in with no process left
// anywhere to answer for it.

/** The one user every record here belongs to; also the socket's user id. */
const OWNER = 1;

function record(id, over = {}) {
  return {
    id,
    ownerUserId: OWNER,
    name: `Session ${id}`,
    created: new Date('2026-07-01T10:00:00Z'),
    lastActivity: new Date('2026-07-01T10:00:00Z'),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
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
    ...over,
  };
}

/**
 * A message processor over real session records, with only the chat *process*
 * faked — the launch is what cannot be run in a test, not the bookkeeping.
 */
function processorOver(sessions) {
  const sent = [];
  const ws = { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };
  const first = sessions.values().next().value;
  const connections = new Map([
    ['ws-1', {
      id: 'ws-1', ws, userId: OWNER, githubLogin: 'tester',
      claudeSessionId: first.id, chatSessionIds: new Set(), created: new Date(),
    }],
  ]);

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: sessions,
    webSocketConnections: connections,
    baseFolder: '/tmp',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord: record,
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => null,
    chatManager: {
      has: () => false,
      async start(_record, options) {
        return {
          runtimeKind: options.runtime,
          currentCapabilities: { streaming: true },
          bypassing: Boolean(options.bypassPermissions),
        };
      },
      async snapshot() {
        return { sessionId: 's', runtime: 'claude', messages: [] };
      },
      async stop() {},
    },
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

describe('the approval mode across a restart', function () {
  let dataDir;
  let sessionStore;

  beforeEach(function () {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-restart-'));
    sessionStore = new SessionStore({ dataDir });
    // The records reference a real user: session rows are owned, and an owner id
    // with no user behind it is refused by the schema rather than stored.
    const user = sessionStore.database.upsertGitHubUser({
      githubId: '1007', githubLogin: 'tester', githubName: 'Test User',
      email: 'tester@example.com',
    });
    assert.strictEqual(user.id, OWNER, 'the fixture owner id must be the first user');
  });

  afterEach(function () {
    sessionStore.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** What a restarted server has: records off the disk, no processes at all. */
  async function restart() {
    sessionStore.database.close();
    sessionStore = new SessionStore({ dataDir });
    return sessionStore.loadSessions();
  }

  function manager() {
    return new ChatSessionManager({
      store: new ChatStore({ storageDir: path.join(dataDir, 'chats') }),
      storageDir: dataDir,
      broadcast: () => {},
      resolveCommand: () => 'claude',
    });
  }

  it('brings a bypassed conversation back bypassed, with nothing running it', async function () {
    const live = new Map([['s1', record('s1')]]);
    const { processor } = processorOver(live);
    await processor.startChat('ws-1', 'claude', { dangerouslySkipPermissions: true });
    await sessionStore.saveSessions(live);

    const restored = await restart();
    const snapshot = await manager().snapshot(restored.get('s1'));

    assert.strictEqual(snapshot.live, false, 'a restart leaves no process behind');
    assert.strictEqual(
      snapshot.bypassPermissions,
      true,
      'the header would otherwise claim the agent asks first',
    );
  });

  it('relaunches it in the mode it was in, without the browser asking', async function () {
    const live = new Map([['s1', record('s1')]]);
    await processorOver(live).processor.startChat('ws-1', 'claude', {
      dangerouslySkipPermissions: true,
    });
    await sessionStore.saveSessions(live);

    // The relaunch a resume from the launcher sends: a session id, `resume`, and
    // nothing about permissions.
    const restored = await restart();
    restored.get('s1').active = false;
    const after = processorOver(restored);
    await after.processor.startChat('ws-1', 'claude', { resume: true });

    const started = after.sent.filter((m) => m.type === 'chat_started').pop();
    assert.strictEqual(started.bypassPermissions, true);
    assert.strictEqual(restored.get('s1').chatBypassPermissions, true);
  });

  it('brings a manual conversation back manual, over both boundaries', async function () {
    const live = new Map([['s1', record('s1')]]);
    await processorOver(live).processor.startChat('ws-1', 'claude', {});
    await sessionStore.saveSessions(live);

    const restored = await restart();
    const snapshot = await manager().snapshot(restored.get('s1'));
    assert.strictEqual(snapshot.bypassPermissions, false);

    restored.get('s1').active = false;
    const after = processorOver(restored);
    await after.processor.startChat('ws-1', 'claude', { resume: true });
    assert.strictEqual(
      after.sent.filter((m) => m.type === 'chat_started').pop().bypassPermissions,
      false,
      'a conversation that asked first must never come back not asking',
    );
  });

  it('keeps the mode to the one conversation that chose it', async function () {
    // Two conversations for the same user in the same folder, one bypassed. The
    // mode is a standing permission: it may travel with its own conversation and
    // nowhere else.
    const live = new Map([['yolo', record('yolo')], ['careful', record('careful')]]);
    const { processor } = processorOver(live);
    processor.deps.webSocketConnections.get('ws-1').chatSessionIds.add('yolo');
    processor.deps.webSocketConnections.get('ws-1').chatSessionIds.add('careful');

    await processor.startChat('ws-1', 'claude', { dangerouslySkipPermissions: true }, 'yolo');
    live.get('careful').active = false;
    await processor.startChat('ws-1', 'claude', {}, 'careful');
    await sessionStore.saveSessions(live);

    const restored = await restart();
    const mgr = manager();
    assert.strictEqual((await mgr.snapshot(restored.get('yolo'))).bypassPermissions, true);
    assert.strictEqual((await mgr.snapshot(restored.get('careful'))).bypassPermissions, false);
  });

  it('does not restore a bypass for another user’s copy of the same id', async function () {
    // The store is keyed by owner as well as session, so a record naming a
    // different user cannot read the mode written for this one. Asserted because
    // a standing permission crossing users is the worst thing this could do.
    const live = new Map([['s1', record('s1')]]);
    await processorOver(live).processor.startChat('ws-1', 'claude', {
      dangerouslySkipPermissions: true,
    });
    await sessionStore.saveSessions(live);

    const restored = await restart();
    const theirs = { ...restored.get('s1'), ownerUserId: OWNER + 92, chatBypassPermissions: undefined };
    assert.strictEqual((await manager().snapshot(theirs)).bypassPermissions, false);
  });
});
