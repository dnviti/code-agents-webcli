const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');

// Issue #43: `/clear` and `/new` looked like they reset the conversation —
// the transcript went blank — but the text was sent to the still-running
// agent process like any other message, so the very next turn brought the
// old context right back. A real reset has to stop the process that
// remembers and start a new one; these pin that down at the point the bug
// lived, `ChatSession.send`, without spawning a real CLI.

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

function fakeAdapter(sendCalls) {
  return {
    alive: true,
    async send(turn) {
      sendCalls.push(turn);
    },
    async interrupt() {},
    respondPermission() {},
    async stop() {},
  };
}

function session() {
  const store = memoryStore();
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clear-reset-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: () => {},
      resolveCommand: () => 'claude',
    },
  );
  const sendCalls = [];
  s.adapter = fakeAdapter(sendCalls);
  s.state = 'idle';
  // Stands in for whatever `start()` was last called with — set directly
  // because these tests stub the adapter rather than spawning a real one.
  s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp' };
  return { s, store, sendCalls };
}

describe('/clear and /new actually reset the conversation', function () {
  it('never forwards the clearing command to the live adapter', async function () {
    const { s, sendCalls } = session();
    s.start = async () => {
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.deepStrictEqual(
      sendCalls,
      [],
      'the process that already holds the old context must never see this turn',
    );
  });

  it('stops the running adapter and starts a fresh one with no resume id', async function () {
    const { s } = session();
    const startCalls = [];
    const stopCalls = [];
    const originalAdapter = s.adapter;
    originalAdapter.stop = async () => stopCalls.push('stopped');
    s.start = async (options) => {
      startCalls.push(options);
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/new' });

    assert.strictEqual(stopCalls.length, 1, 'the old process must be torn down, not reused');
    assert.strictEqual(startCalls.length, 1);
    assert.strictEqual(startCalls[0].runtime, 'claude');
    assert.strictEqual(startCalls[0].resumeSessionId, undefined, 'a resume would hand the new process the old context back');
    assert.strictEqual(startCalls[0].startFresh, true);
  });

  it('is case-insensitive and ignores arguments, matching isClearingCommand', async function () {
    const { s, sendCalls } = session();
    let started = 0;
    s.start = async () => {
      started += 1;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/CLEAR now please' });

    assert.strictEqual(started, 1);
    assert.deepStrictEqual(sendCalls, []);
  });

  it('still records the user turn in the transcript before resetting', async function () {
    const { s, store } = session();
    s.start = async () => {
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    const texts = store.events
      .filter((e) => e.t === 'block_start')
      .map((e) => e.block.text);
    assert.deepStrictEqual(texts, ['/clear']);
  });

  it('clears the stale native session id before the new process reports its own', async function () {
    const { s } = session();
    s.ingest({ t: 'session', nativeSessionId: 'native-old', capabilities: {} });
    assert.strictEqual(s.nativeId, 'native-old');

    s.start = async () => {
      // The new process has not announced itself yet.
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/new' });

    assert.strictEqual(s.nativeId, null, 'must not still point at the pre-clear conversation');
  });

  it('leaves an ordinary message alone', async function () {
    const { s, sendCalls } = session();
    let started = 0;
    s.start = async () => {
      started += 1;
    };

    await s.send({ text: 'clear the table, please' });

    assert.strictEqual(started, 0, 'not a slash command, so no restart');
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].text, 'clear the table, please');
  });

  // The restart replays the options the session was launched with, and the
  // model is the one thing in them that can change while the session is alive.
  // Both features shipped in 5.1.2 and each one's own tests passed: the
  // override was lost only where they met.
  it('restarts with the model the conversation was moved to, not the one it opened with', async function () {
    const { s } = session();
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', model: 'opened-with' };

    // What `chat_set_model` does once the choice is persisted, whether or not
    // the live adapter could take it.
    s.rememberModel('moved-to');

    let startedWith = null;
    s.start = async (options) => {
      startedWith = options;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.strictEqual(
      startedWith.model,
      'moved-to',
      'the fresh process must run the model the browser was told was applied',
    );
  });

  it('restarts on the profile default once the override is cleared', async function () {
    const { s } = session();
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', model: 'an-override' };

    // Clearing resolves to the profile default, so that is what arrives here.
    s.rememberModel('profile-default');

    let startedWith = null;
    s.start = async (options) => {
      startedWith = options;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.strictEqual(startedWith.model, 'profile-default');
  });
});

/**
 * Issue #69: the reset worked and the tab it happened in looked closed.
 *
 * These run a real adapter over a real process, because the bug was in the
 * timing of a real process's death. `stop()` signals the child and returns
 * without waiting for it, so the old process emitted its `state: exited` after
 * the replacement was already running — and the conversation it landed in was
 * the new one, which went read-only with an agent sitting behind it.
 */
describe('clearing leaves the tab live', function () {
  let dirs = [];

  /**
   * A CLI that behaves like one mid-conversation: alive, quiet, and holding an
   * open pipe. It ignores its arguments on purpose — the real flags belong to
   * the runtime this is standing in for, and a `cat` that read them would exit
   * on the first one it did not know, which is a dead process pretending to be
   * a live one and would make every test below pass for the wrong reason.
   */
  function fakeCli() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-cli-'));
    dirs.push(dir);
    const script = path.join(dir, 'quiet-agent');
    fs.writeFileSync(script, '#!/bin/sh\nexec cat > /dev/null\n');
    fs.chmodSync(script, 0o755);
    return script;
  }

  function liveSession() {
    const store = memoryStore();
    const lifecycle = [];
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-live-'));
    dirs.push(socketDir);
    const command = fakeCli();
    const s = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store,
        socketDir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => command,
        onLifecycle: (_id, change) => lifecycle.push(change),
      },
    );
    return { s, store, lifecycle };
  }

  /** Wait for the process behind an adapter to actually be gone. */
  async function died(adapter) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!adapter.alive) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the old process never exited');
  }

  afterEach(function () {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('does not let the process it replaced report the new conversation exited', async function () {
    const { s, store } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });
    const old = s.adapter;

    await s.send({ text: '/clear' });
    await died(old);

    assert.strictEqual(s.currentState, 'idle', 'the tab is running a new conversation');
    const marker = store.events.findIndex((e) => e.t === 'marker' && e.kind === 'cleared');
    assert.ok(marker >= 0, 'the window was told to empty');
    const after = store.events.slice(marker).filter((e) => e.t === 'state').map((e) => e.state);
    assert.ok(!after.includes('exited'), `nothing may claim this ended: ${after.join(', ')}`);
    await s.stop();
  });

  it('tells the session record it is running again, so no list calls it finished', async function () {
    const { s, lifecycle } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });
    const old = s.adapter;

    await s.send({ text: '/new' });
    await died(old);

    assert.strictEqual(
      lifecycle.filter((change) => change.exited === true).length,
      0,
      'a clear is not an exit',
    );
    assert.ok(
      lifecycle.some((change) => change.exited === false),
      'the record has to be put back, or the tab is listed as finished',
    );
    await s.stop();
  });

  it('still reports a genuine exit, which is what the recovery offer is for', async function () {
    const { s, lifecycle } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });
    const adapter = s.adapter;

    await s.stop();
    await died(adapter);
    // The exit event is emitted from the child's own 'exit' handler, a tick or
    // two after the process goes.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(
      lifecycle.some((change) => change.exited === true),
      'a session that really ended must still say so',
    );
  });

  it('clears while the agent is answering instead of queueing behind it', async function () {
    const { s, store } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });
    const old = s.adapter;

    // the stand-in never answers, so this turn stays in flight forever — which
    // is the case the acceptance criterion is about.
    await s.send({ text: 'take your time' });
    assert.notStrictEqual(s.currentState, 'idle', 'the turn is in flight');
    await s.send({ text: 'and another thing' });
    assert.strictEqual(s.queuedTurns.length, 1, 'ordinary turns still queue');

    await s.send({ text: '/reset' });
    await died(old);

    assert.strictEqual(s.currentState, 'idle', 'not stuck mid-turn');
    assert.deepStrictEqual(s.queuedTurns, [], 'the line went with the conversation');
    const marker = store.events.findIndex((e) => e.t === 'marker' && e.kind === 'cleared');
    assert.ok(marker >= 0);
    const errors = store.events.slice(marker).filter((e) => e.t === 'error');
    assert.deepStrictEqual(errors, [], 'a dropped queue is what was asked for, not a failure');
    await s.stop();
  });

  it('accepts a message typed before the new process has finished starting', async function () {
    const { s } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });

    // Both without awaiting the clear: this is someone typing into a composer
    // that is still enabled, which is exactly what the tab promises.
    const clearing = s.send({ text: '/clear' });
    await s.send({ text: 'right, from the top' });
    await clearing;

    assert.ok(s.live, 'a session mid-clear is starting, not gone');
    await s.stop();
  });
});

/**
 * The two things a clear must not leave behind it.
 *
 * Both were found by asking what is still on screen, and what is still
 * believed, once the conversation the user asked to leave is gone.
 */
describe('nothing of the old conversation outlives it', function () {
  const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

  it('takes the approval card with it', function () {
    // Approval cards are drawn above the composer rather than inside the
    // conversation, so emptying the transcript does not touch them: without
    // this the fresh window opened with a card asking whether a tool may run
    // in a process that had already been replaced.
    const state = createTranscript({});
    applyChatEvent(state, {
      t: 'permission',
      seq: 1,
      ts: 1,
      request: {
        requestId: 'p1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        options: [],
        ts: 1,
      },
    });
    assert.strictEqual(state.pendingPermissions.length, 1);

    applyChatEvent(state, { t: 'marker', kind: 'cleared', seq: 2, ts: 2 });
    assert.deepStrictEqual(state.pendingPermissions, []);
  });

  it('says the session ended when the replacement could not be started', async function () {
    const store = memoryStore();
    const lifecycle = [];
    const s = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store,
        socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clear-fail-')),
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'claude',
        onLifecycle: (_id, change) => lifecycle.push(change),
      },
    );
    s.adapter = fakeAdapter([]);
    s.state = 'idle';
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp' };
    s.start = async () => {
      throw new Error('the binary is gone');
    };

    await assert.rejects(s.send({ text: '/clear' }), /the binary is gone/);

    // The old conversation was stopped and nothing took its place. Saying
    // otherwise leaves the record claiming a process that never started, and
    // the relaunch that would fix it is refused because of the claim.
    assert.deepStrictEqual(
      lifecycle.filter((change) => change.exited !== undefined),
      [{ exited: true }],
    );
  });
});
