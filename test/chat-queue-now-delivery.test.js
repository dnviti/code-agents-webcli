const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { CodexChatAdapter } = require('../dist/server/chat/adapters/codex.js');

// What happens to a promoted message when the runtime cannot take it yet.
//
// `chat-queue-now.test.js` covers the feature; this covers the delivery, which
// is a different question and was answered wrongly for every pi user (#70).
// Promoting a message interrupts the turn in flight and then hands the runtime
// the message — and on a runtime that spawns a process per turn, "interrupted"
// and "ready for another one" are separated by a process exiting. The send in
// that gap throws, and the message had already left the queue.
//
// The reason a suite that already tested this path did not catch it is the
// fake: no `readyForTurn`, and a `send()` that cannot fail. The adapter below is
// modelled on `src/server/chat/adapters/pi.ts` instead — one child per turn, an
// `interrupt()` that signals it and returns, `readyForTurn` false until that
// child's exit lands as its own macrotask, and a `send()` that throws while a
// turn is in flight. On that shape the old code lost the message 100% of the
// time, and never once as a race.

function piAdapter() {
  return {
    runtime: 'pi',
    // pi's own: no approval channel, and an interrupt that is a signal.
    capabilities: { permissions: false, streaming: true, interrupt: true },
    alive: true,
    sent: [],
    interrupts: 0,
    turnInFlight: false,
    currentTurnId: null,
    turnCounter: 0,
    get readyForTurn() {
      return !this.turnInFlight;
    },
    async start() {},
    async send(turn) {
      if (this.turnInFlight) {
        throw new Error('pi: a turn is already running on this session');
      }
      this.turnInFlight = true;
      this.currentTurnId = `t${++this.turnCounter}`;
      this.sent.push(turn.text);
      this.emit({ t: 'state', state: 'running' });
    },
    async interrupt() {
      if (!this.turnInFlight) return;
      this.interrupts += 1;
      // SIGINT and nothing else, which is all pi's interrupt does. The child's
      // exit is a macrotask of its own, so everything the session does between
      // here and its send happens while the adapter is still not ready.
      setTimeout(() => this.childExited(), 0);
    },
    /** pi's `onTurnExit`: the flag clears first, then the events go out. */
    childExited() {
      if (!this.turnInFlight) return;
      this.turnInFlight = false;
      const turnId = this.currentTurnId;
      this.currentTurnId = null;
      this.emit({ t: 'turn_end', turnId, stopReason: 'interrupted' });
      this.emit({ t: 'state', state: 'idle' });
    },
    respondPermission() {},
    async stop() {
      this.alive = false;
    },
  };
}

/** A runtime that holds one process open: always ready, and it answers at once. */
function claudeAdapter() {
  return {
    runtime: 'claude',
    capabilities: { permissions: true, streaming: true, interrupt: true },
    alive: true,
    sent: [],
    interrupts: 0,
    async start() {},
    async send(turn) {
      this.sent.push(turn.text);
    },
    async interrupt() {
      this.interrupts += 1;
      this.emit({ t: 'turn_end', turnId: 'cut-short', stopReason: 'interrupted' });
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
  };
}

function session(adapter = piAdapter()) {
  const store = memoryStore();
  const broadcasts = [];
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'queue-now-delivery-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => adapter.runtime,
    },
  );
  adapter.emit = (event) => s.ingest(event);
  s.adapter = adapter;
  s.state = 'idle';
  return { s, store, broadcasts, adapter };
}

/** Long enough for the child's exit and the drain that its events trigger. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const texts = (turns) => turns.map((turn) => turn.text);

describe('promoting a message on a runtime that spawns a process per turn', function () {
  it('keeps the message when the runtime is still letting go of the turn it stopped', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });
    await s.send({ text: 'and then run the tests' });

    const [urgent] = s.queuedTurns;
    const handedOver = await s.sendQueuedNow(urgent.id);

    assert.strictEqual(adapter.interrupts, 1, 'the turn in flight is still cut short');
    assert.strictEqual(handedOver, false, 'but the runtime has not been given anything');
    assert.deepStrictEqual(adapter.sent, ['refactor the auth module']);
    assert.deepStrictEqual(
      texts(s.queuedTurns),
      ['stop — that is the wrong file', 'and then run the tests'],
      'so it waits at the head of the line instead of disappearing',
    );
  });

  it('hands it over the moment the process lets go, ahead of what was typed after it', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });
    await s.send({ text: 'and then run the tests' });

    await s.sendQueuedNow(s.queuedTurns[0].id);
    await settle();

    assert.deepStrictEqual(
      adapter.sent,
      ['refactor the auth module', 'stop — that is the wrong file'],
      'the correction is what the agent hears next — not the message written after it',
    );
    assert.deepStrictEqual(texts(s.queuedTurns), ['and then run the tests']);
  });

  it('lets the abandoned turn end, because the correction can no longer join it', async function () {
    const { s, store } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });

    await s.sendQueuedNow(s.queuedTurns[0].id);
    await settle();

    const ends = store.events.filter((event) => event.t === 'turn_end');
    assert.strictEqual(ends.length, 1);
    assert.ok(
      !ends[0].stale,
      'a turn_end held open for work that is never resumed is a turn that never closes',
    );
    const asked = store.events.filter((event) => event.t === 'msg_start' && event.role === 'user');
    assert.strictEqual(asked.length, 2);
    assert.notStrictEqual(asked[1].turnId, asked[0].turnId, 'so the correction is its own turn');
  });

  it('says so in the queue every browser is watching, not only in this one', async function () {
    const { s, broadcasts } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });

    await s.sendQueuedNow(s.queuedTurns[0].id);

    const queues = broadcasts.filter((message) => message.type === 'chat_queue');
    assert.deepStrictEqual(
      texts(queues[queues.length - 1].queued),
      ['stop — that is the wrong file'],
      'a browser told the message had left the queue would show it nowhere at all',
    );
  });
});

describe('promoting a message the runtime refuses', function () {
  it('puts it back with the reason on it rather than dropping it', async function () {
    const { s, adapter } = session(claudeAdapter());
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });
    // An adapter that dies between the alive check and the send: the process is
    // gone, and nothing here found out until the write failed.
    adapter.send = async () => {
      throw new Error('write EPIPE');
    };

    assert.strictEqual(await s.sendQueuedNow(s.queuedTurns[0].id), false);

    assert.deepStrictEqual(texts(s.queuedTurns), ['stop — that is the wrong file']);
    assert.strictEqual(s.queuedTurns[0].error, 'write EPIPE', 'and it carries why it failed');
    assert.strictEqual(
      s.currentState,
      'idle',
      'a delivery that never happened must not leave the session claiming to work',
    );
  });

  it('leaves it where retrying it can find it, without retyping', async function () {
    const { s, adapter } = session(claudeAdapter());
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop — that is the wrong file' });
    adapter.send = async () => {
      throw new Error('write EPIPE');
    };
    await s.sendQueuedNow(s.queuedTurns[0].id);

    adapter.send = async function (turn) {
      this.sent.push(turn.text);
    };
    assert.strictEqual(s.retryQueued(s.queuedTurns[0].id), true);
    await settle();

    assert.deepStrictEqual(adapter.sent, ['refactor the auth module', 'stop — that is the wrong file']);
  });
});

/**
 * The facade in front of codex forwards what the session asks of an adapter,
 * and `readyForTurn` was not on the list — so for codex the readiness gate was
 * not merely bypassed on this path, it could not fire on any of them. Only the
 * exec fallback answers it, and only it needs to: it spawns a child per turn.
 */
describe('a runtime reached through a facade', function () {
  it('is asked whether it is ready, through it', function () {
    const facade = new CodexChatAdapter({
      sessionId: 's1',
      workingDir: os.tmpdir(),
      command: '/bin/cat',
      emit: () => {},
    });

    facade.delegate = { readyForTurn: false };
    assert.strictEqual(facade.readyForTurn, false, 'the exec child is still exiting');

    facade.delegate = { readyForTurn: true };
    assert.strictEqual(facade.readyForTurn, true);

    // The app-server delegate has no per-turn child and says nothing about it,
    // which is not the same as saying no.
    facade.delegate = {};
    assert.strictEqual(facade.readyForTurn, true);
  });
});
