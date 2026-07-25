const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession, QueueFullError } = require('../dist/server/chat/session.js');
const { MAX_QUEUED_TURNS } = require('../dist/shared/chat-events.js');

// Type-ahead, driven through the real ChatSession.
//
// The queue lives on the server rather than in the browser, so this is where it
// has to be proved: that a turn typed while the agent works is kept rather than
// dropped, that it is handed over the instant the previous one ends, that it
// goes over in the order it was typed, and that the two things which end a
// session — stopping it and losing it — do not leave messages waiting for a
// process that will never take them.

/** Records what the adapter was actually asked to send, in order. */
function fakeAdapter() {
  return {
    runtime: 'claude',
    capabilities: { permissions: false, streaming: true, interrupt: true },
    alive: true,
    sent: [],
    interrupts: 0,
    async start() {},
    async send(turn) {
      this.sent.push(turn.text);
    },
    async interrupt() {
      this.interrupts += 1;
    },
    respondPermission() {},
    async stop() {
      this.alive = false;
    },
  };
}

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
    async snapshot() {
      return {
        sessionId: 's1', runtime: 'claude', messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: true, bypassPermissions: false,
      };
    },
  };
}

function session() {
  const store = memoryStore();
  const broadcasts = [];
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'queue-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => 'claude',
    },
  );
  const adapter = fakeAdapter();
  s.adapter = adapter;
  s.state = 'idle';
  return { s, store, broadcasts, adapter };
}

/** The queue as the last broadcast reported it. */
function lastQueue(broadcasts) {
  const queue = broadcasts.filter((m) => m.type === 'chat_queue');
  return queue.length ? queue[queue.length - 1].queued : null;
}

/** Let the drain's own promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('typing ahead while the agent works', function () {
  it('sends the first turn straight through', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    assert.deepStrictEqual(adapter.sent, ['first'], 'an idle session hands the turn over immediately');
    assert.strictEqual(s.queuedTurns.length, 0, 'nothing waits when nothing is running');
  });

  it('queues rather than refusing a turn typed mid-run', async function () {
    const { s, adapter, broadcasts } = session();
    await s.send({ text: 'first' });
    assert.strictEqual(s.currentState, 'thinking');

    await s.send({ text: 'second' });

    assert.deepStrictEqual(adapter.sent, ['first'], 'the runtime must not be handed two turns at once');
    assert.strictEqual(s.queuedTurns.length, 1);
    assert.strictEqual(s.queuedTurns[0].text, 'second');
    assert.deepStrictEqual(
      (lastQueue(broadcasts) || []).map((t) => t.text),
      ['second'],
      'every browser watching is told what is waiting',
    );
  });

  it('hands the next one over the moment the turn ends', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'second' });

    // What a real adapter emits when it finishes. The session folds this into
    // an idle state itself — it does not wait for a separate `state` event.
    s.ingest({ t: 'turn_end', turnId: 't1' });
    await settle();

    assert.deepStrictEqual(adapter.sent, ['first', 'second']);
    assert.strictEqual(s.queuedTurns.length, 0, 'the line is empty once it has been worked through');
  });

  it('keeps the order they were typed in, one turn at a time', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });
    await s.send({ text: 'b' });
    await s.send({ text: 'c' });

    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['a', 'b', 'c']);

    s.ingest({ t: 'turn_end', turnId: 't1' });
    await settle();
    assert.deepStrictEqual(adapter.sent, ['first', 'a'], 'exactly one comes off the line per turn');

    s.ingest({ t: 'turn_end', turnId: 't2' });
    await settle();
    s.ingest({ t: 'turn_end', turnId: 't3' });
    await settle();

    assert.deepStrictEqual(adapter.sent, ['first', 'a', 'b', 'c']);
  });

  it('does not let a turn arriving during a drain overtake the queue', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });

    // Idle again, but with `a` still waiting: a naive "idle means send now"
    // check would put `jumper` in front of the message typed before it.
    s.state = 'idle';
    await s.send({ text: 'jumper' });

    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['a', 'jumper']);
    assert.deepStrictEqual(adapter.sent, ['first'], 'nothing jumped the line');
  });

  it('lets a waiting turn be withdrawn', async function () {
    const { s, adapter, broadcasts } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'regret' });
    await s.send({ text: 'keep' });

    const [regret] = s.queuedTurns;
    assert.strictEqual(s.cancelQueued(regret.id), true);
    assert.strictEqual(s.cancelQueued(regret.id), false, 'cancelling twice is not an error, just a no-op');
    assert.deepStrictEqual((lastQueue(broadcasts) || []).map((t) => t.text), ['keep']);

    s.ingest({ t: 'turn_end', turnId: 't1' });
    await settle();
    assert.deepStrictEqual(adapter.sent, ['first', 'keep'], 'the withdrawn turn never ran');
  });

  it('discards the line when the user presses stop', async function () {
    const { s, adapter, store } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'and then this' });

    await s.interrupt();
    await settle();

    assert.strictEqual(adapter.interrupts, 1);
    assert.strictEqual(s.queuedTurns.length, 0, 'stop means stop');
    assert.deepStrictEqual(adapter.sent, ['first'], 'the queue must not fire on the way to idle');
    assert.ok(
      store.events.some((e) => e.t === 'error' && /discarded/i.test(e.message)),
      'the user is told their typed-ahead messages were dropped',
    );
  });

  it('drops the line rather than stranding it when the session dies', async function () {
    const { s, store } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'orphan' });

    s.adapter.alive = false;
    s.ingest({ t: 'state', state: 'exited' });
    await settle();

    assert.strictEqual(s.queuedTurns.length, 0);
    assert.ok(
      store.events.some((e) => e.t === 'error' && /no longer running/i.test(e.message)),
      'a queue that can never be delivered has to say so',
    );
  });

  it('refuses to hold more than the cap', async function () {
    const { s } = session();
    await s.send({ text: 'first' });
    for (let i = 0; i < MAX_QUEUED_TURNS; i++) {
      await s.send({ text: `q${i}` });
    }
    assert.strictEqual(s.queuedTurns.length, MAX_QUEUED_TURNS);

    await assert.rejects(() => s.send({ text: 'one too many' }), QueueFullError);
  });

  it('carries the queue on the snapshot, so a reload sees the same line', async function () {
    const { s } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'waiting' });

    const snapshot = await s.snapshot();
    assert.deepStrictEqual(snapshot.queued.map((t) => t.text), ['waiting']);
  });

  it('carries attachments through the queue intact', async function () {
    const { s } = session();
    const attachment = { url: '/a', mime: 'image/png', name: 'shot.png', size: 12, path: '/tmp/shot.png' };
    await s.send({ text: 'first' });
    await s.send({ text: 'look', attachments: [attachment] });

    assert.deepStrictEqual(s.queuedTurns[0].attachments, [attachment]);
  });

  it('empties the line when the session is stopped', async function () {
    const { s } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'waiting' });

    await s.stop();
    assert.strictEqual(s.queuedTurns.length, 0);
  });
});
