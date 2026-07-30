const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../dist/server/chat/registry.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');

// Stopping a turn is not the turn failing.
//
// Claude reports an interrupted run exactly the way it reports one that broke —
// `is_error`, subtype `error_during_execution` — so pressing stop, or
// correcting the agent by sending ahead of it, put a red card in the
// conversation reading "claude ended the turn as error_during_execution", with
// a Retry button offering to run again the very thing the user had just
// stopped.
//
// The report is real and the app has to keep reading it: the same subtype is
// how a run that genuinely broke arrives. What changed is that a report of the
// run *this session asked to be dropped* is not written down. The record of the
// interrupt is the marker and the turn's own stop reason, both of which already
// say it in the user's terms.

const ROOT = path.join(__dirname, '..');

/**
 * The `result` line the CLI actually sends when a run is interrupted.
 *
 * Captured off the wire from claude 2.1.x driven by this app's own session
 * (`.work/probes/interrupt-noise-e2e.mjs`), not written by hand — an invented
 * payload would only prove the adapter agrees with whoever invented it. Note
 * `result: ''`, which is why the card said "claude ended the turn as
 * error_during_execution": there was no message to show, so the adapter's
 * fallback sentence is the whole of it.
 */
const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  stop_reason: null,
  num_turns: 2,
  result: '',
  session_id: 'native-1',
  duration_ms: 6100,
};

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
        sessionId: 's1', runtime: 'claude', messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: true, bypassPermissions: false,
      };
    },
  };
}

/**
 * A runtime that says only what a test tells it to.
 *
 * Handed to the session through the real registry seam, so its events travel
 * the real `emit` closure — which is where the filter lives, and the only place
 * that can tell a runtime's report apart from what the session writes itself.
 */
function fakeAdapter(options) {
  return {
    runtime: 'claude',
    capabilities: { permissions: false, streaming: true, interrupt: true },
    alive: true,
    sent: [],
    interrupts: 0,
    emit: options.emit,
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

describe('a turn that was stopped is not a turn that failed', function () {
  let made = [];
  let real = null;
  let dirs = [];

  before(function () {
    real = registry.createChatAdapter;
    registry.createChatAdapter = (_runtime, options) => {
      const adapter = fakeAdapter(options);
      made.push(adapter);
      return adapter;
    };
  });

  after(function () {
    // Restored, because the whole suite shares one process and every other
    // file that starts a session would otherwise get this one's fake.
    registry.createChatAdapter = real;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(function () {
    made = [];
  });

  /** A started session, and the runtime it is talking to. */
  async function started() {
    const store = memoryStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-'));
    dirs.push(dir);
    const session = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store,
        socketDir: dir,
        hookScript: path.join(ROOT, 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => path.join(ROOT, 'does-not-exist-either'),
      },
    );
    // Bypassing, so no approval hook is wired and the session needs no broker.
    await session.start({ runtime: 'claude', workingDir: dir, bypassPermissions: true });
    return { session, store, adapter: made[made.length - 1] };
  }

  const errorsIn = (store) => store.events.filter((event) => event.t === 'error');
  /** What the runtime says when it lets go of a run it was told to drop. */
  const interruptedRun = { t: 'error', message: 'claude ended the turn as error_during_execution' };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('is what the CLI actually reports, so the adapter is right to read it', function () {
    // The fixture, proved against the real adapter rather than assumed. If
    // Claude ever stops reporting an interrupt this way, this is the test that
    // says so — and every test below is built on this event.
    const emitted = [];
    const adapter = new ClaudeChatAdapter({
      sessionId: 's1', workingDir: '/tmp', command: 'claude', emit: (event) => emitted.push(event),
    });
    adapter.handleMessage(INTERRUPTED_RESULT);

    const error = emitted.find((event) => event.t === 'error');
    assert.ok(error, 'the adapter has to keep reading this: a run that broke arrives the same way');
    assert.strictEqual(error.message, interruptedRun.message);
    assert.notStrictEqual(error.fatal, true, 'the process is still there; only the run ended');
    assert.strictEqual(
      emitted.find((event) => event.t === 'turn_end').stopReason,
      'error_during_execution',
    );
  });

  it('leaves no error card when a waiting message interrupts the turn', async function () {
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });
    await session.send({ text: 'actually, stop' });

    const [waiting] = session.queuedTurns;
    const promoted = session.sendQueuedNow(waiting.id);
    // The report arrives while the interrupt is still being acknowledged, which
    // is the whole of the timing this depends on.
    adapter.emit(interruptedRun);
    adapter.emit({ t: 'turn_end', turnId: 't1', stopReason: 'error_during_execution' });
    await promoted;
    await settle();

    assert.deepStrictEqual(errorsIn(store).map((event) => event.message), []);
    assert.ok(
      store.events.some((event) => event.t === 'marker' && event.kind === 'interrupted'),
      'the interrupt is still on the record — as the interrupt it was',
    );
    assert.deepStrictEqual(adapter.sent, ['count to a hundred', 'actually, stop']);
  });

  it('leaves no error card when the stop button ends the turn', async function () {
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });

    const stopping = session.interrupt();
    adapter.emit(interruptedRun);
    adapter.emit({ t: 'turn_end', turnId: 't1', stopReason: 'error_during_execution' });
    await stopping;
    await settle();

    assert.deepStrictEqual(errorsIn(store).map((event) => event.message), []);
    // Nothing is hidden: the turn still says it did not get to finish, which is
    // what the badge on it reads.
    assert.strictEqual(
      store.events.find((event) => event.t === 'turn_end').stopReason,
      'error_during_execution',
    );
  });

  it('still says so when messages were thrown away with the turn', async function () {
    // This one is written by the session, not by the runtime, and lands inside
    // the same window. Swallowing it would lose messages the user typed without
    // ever telling them.
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });
    await session.send({ text: 'and then stop' });

    const stopping = session.interrupt();
    adapter.emit(interruptedRun);
    await stopping;
    await settle();

    assert.deepStrictEqual(
      errorsIn(store).map((event) => event.message),
      ['Stopped. 1 queued message was discarded.'],
    );
  });

  it('reports a run that broke on its own', async function () {
    // The control. Same event, same adapter, no interrupt — and it has to reach
    // the conversation, because this is also how a real failure arrives.
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });
    adapter.emit(interruptedRun);
    await settle();

    assert.deepStrictEqual(errorsIn(store).map((event) => event.message), [interruptedRun.message]);
  });

  it('reports one that breaks after the interrupt has been answered', async function () {
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });

    const stopping = session.interrupt();
    adapter.emit({ t: 'turn_end', turnId: 't1', stopReason: 'error_during_execution' });
    await stopping;
    // The run this session stopped is over, so the window is closed and
    // anything that goes wrong from here is a failure again.
    adapter.emit({ t: 'error', message: 'claude: the model refused the request' });
    await settle();

    assert.deepStrictEqual(
      errorsIn(store).map((event) => event.message),
      ['claude: the model refused the request'],
    );
  });

  it('never swallows the process going away', async function () {
    const { session, store, adapter } = await started();
    await session.send({ text: 'count to a hundred' });

    const stopping = session.interrupt();
    // A fatal error is the child itself dying, which is true whatever it was
    // doing — and a conversation that hid it would look live over nothing.
    adapter.emit({ t: 'error', message: 'claude exited with code 1', fatal: true });
    await stopping;
    await settle();

    assert.deepStrictEqual(
      errorsIn(store).map((event) => event.message),
      ['claude exited with code 1'],
    );
  });
});
