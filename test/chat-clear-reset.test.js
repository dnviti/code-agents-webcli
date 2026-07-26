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
