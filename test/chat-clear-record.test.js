const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { ChatSessionManager } = require('../dist/server/chat/manager.js');
const { ChatStore } = require('../dist/server/chat/store.js');
const { applyChatLifecycle } = require('../dist/server/index.js');

// Issue #43, one layer out from `chat-clear-reset.test.js`.
//
// Clearing a conversation dropped the runtime's session id from the live
// `ChatSession` and nowhere else. The session record is the copy that outlives
// the process, and it is the only one anything reads once the process is gone —
// the rejoin snapshot, the resume banner, the `--resume <id>` the banner
// spawns. So a conversation cleared and then left alone came back after a
// server restart showing the emptied transcript above an offer to "pick it up
// where it left off", and taking that offer handed the agent every turn the
// user had cleared to be rid of.
//
// The record could not be told otherwise: its one writer only ever accepted a
// truthy id, so "there is no id" was not a thing that could be said.

function memoryStore() {
  const events = [];
  return {
    events,
    append(_ref, batch) {
      events.push(...batch);
    },
    async stat() {
      return { firstSeq: 1, cursor: events.length };
    },
    async read() {
      return { events: [], firstSeq: 1, from: 1, cursor: events.length };
    },
    async truncateBefore() {},
    async snapshot() {
      return {
        sessionId: 's1', runtime: 'claude', messages: [], state: 'exited',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: false, bypassPermissions: false,
      };
    },
    async nativeSessionId() {
      return null;
    },
  };
}

function fakeAdapter() {
  return {
    alive: true,
    async send() {},
    async interrupt() {},
    respondPermission() {},
    async stop() {},
  };
}

function session() {
  const store = memoryStore();
  const changes = [];
  const order = [];
  store.truncateBefore = async () => {
    order.push('truncated');
  };
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clear-record-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: () => {},
      // `/bin/cat` holds a pipe open and says nothing, which is exactly the
      // window this is about: the replacement announces an id of its own on its
      // first turn and not before — `adapters/claude.ts` says so outright — so a
      // clear followed by silence is where the stale id used to live. The real
      // `start` runs, because that is where the record is now told.
      resolveCommand: () => '/bin/cat',
      onLifecycle: (_id, change) => {
        changes.push(change);
        if (change.nativeSessionId === null) order.push('record told');
      },
    },
  );
  s.adapter = fakeAdapter();
  s.state = 'idle';
  s.lastStartOptions = { runtime: 'claude', workingDir: os.tmpdir() };
  return { s, store, changes, order };
}

const idChanges = (changes) =>
  changes.filter((change) => 'nativeSessionId' in change).map((change) => change.nativeSessionId);

describe('the record after a conversation is cleared', function () {
  it('is told the conversation it named no longer exists', async function () {
    this.timeout(20000);
    const { s, changes } = session();
    s.ingest({ t: 'session', nativeSessionId: 'native-old', capabilities: {} });

    await s.send({ text: '/clear' });
    await s.stop().catch(() => undefined);

    assert.deepStrictEqual(
      idChanges(changes),
      ['native-old', null],
      'the record is the only copy left once the process goes away',
    );
  });

  it('is told after the log it lived in is dropped, not before', async function () {
    // The order is the whole fix. A record with no id sends the manager to the
    // head of the log for one and stamps back what it finds, so telling the
    // record while the old introduction was still readable would have been
    // undone by the very next rejoin.
    this.timeout(20000);
    const { s, order } = session();
    s.ingest({ t: 'session', nativeSessionId: 'native-old', capabilities: {} });

    await s.send({ text: '/new' });
    await s.stop().catch(() => undefined);

    assert.deepStrictEqual(order, ['truncated', 'record told']);
  });
});

describe('what a session record can be told about its id', function () {
  it('can be told there is none', function () {
    const record = { nativeChatSessionId: 'native-old' };
    applyChatLifecycle(record, { nativeSessionId: null });
    assert.strictEqual(record.nativeChatSessionId, undefined);
  });

  it('still hears a real one', function () {
    const record = {};
    applyChatLifecycle(record, { nativeSessionId: 'native-new' });
    assert.strictEqual(record.nativeChatSessionId, 'native-new');
  });

  it('keeps the id it has when a change says nothing about it', function () {
    const record = { nativeChatSessionId: 'native-old', active: true };
    applyChatLifecycle(record, { exited: true });
    assert.strictEqual(record.nativeChatSessionId, 'native-old');
    assert.strictEqual(record.active, false, 'and the rest of the change still lands');
  });
});

describe('rejoining a cleared conversation whose process is gone', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-record-store-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real log with a real clear in it: introduction, a turn, the marker, the truncation. */
  async function clearedLog({ truncate }) {
    const store = new ChatStore({ storageDir: dir });
    const ref = { id: 's1', ownerUserId: 7 };
    store.append(ref, [
      { t: 'session', seq: 1, ts: 1, nativeSessionId: 'native-old', capabilities: {} },
      { t: 'msg_start', seq: 2, ts: 2, id: 'm1', role: 'user', turnId: 't1' },
      { t: 'msg_end', seq: 3, ts: 3, id: 'm1' },
      { t: 'marker', seq: 4, ts: 4, kind: 'cleared', detail: 'started a new conversation' },
    ]);
    // `append` is enqueued rather than awaited; this is the first thing that
    // waits behind it.
    await store.stat(ref);
    if (truncate) await store.truncateBefore(ref, 4);
    return store;
  }

  /** Wired to the record the way the server wires it, so a backfill is written through. */
  function manager(store, record) {
    return new ChatSessionManager({
      store,
      storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clear-record-mgr-')),
      broadcast: () => {},
      resolveCommand: () => 'claude',
      onLifecycle: (_id, change) => applyChatLifecycle(record, change),
    });
  }

  it('is not offered a resume into the memory the clear destroyed', async function () {
    const record = { id: 's1', ownerUserId: 7, nativeChatSessionId: 'native-old' };
    applyChatLifecycle(record, { nativeSessionId: null });

    const snapshot = await manager(await clearedLog({ truncate: true }), record).snapshot(record);

    assert.strictEqual(
      snapshot.nativeSessionId,
      undefined,
      'the banner offers a resume for exactly as long as this is set',
    );
    assert.strictEqual(
      record.nativeChatSessionId,
      undefined,
      'and nothing puts the id back on the record on the way past',
    );
  });

  it('but the log is what makes that true, so the order the two happen in matters', async function () {
    // The record is not the only thing that answers this: a record with no id
    // sends the manager to the head of the log for one, and stamps what it
    // finds back onto the record. So clearing the record while the old
    // introduction was still readable would achieve nothing at all — which is
    // why the session truncates first and tells the record second.
    const record = { id: 's1', ownerUserId: 7, nativeChatSessionId: 'native-old' };
    applyChatLifecycle(record, { nativeSessionId: null });

    const snapshot = await manager(await clearedLog({ truncate: false }), record).snapshot(record);

    assert.strictEqual(snapshot.nativeSessionId, 'native-old');
    assert.strictEqual(record.nativeChatSessionId, 'native-old');
  });
});
