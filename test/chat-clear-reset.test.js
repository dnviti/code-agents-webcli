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
  const truncations = [];
  return {
    events,
    truncations,
    append(_ref, batch) {
      events.push(...batch);
    },
    async stat() {
      return { firstSeq: 1, cursor: events.length };
    },
    async read() {
      return { events: [], firstSeq: 1, from: 1, cursor: events.length };
    },
    async truncateBefore(_ref, seq) {
      truncations.push(seq);
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

  // The approval mode is the other thing in those options that can be wrong by
  // the time a clear replays them — and the only one that decides whether shell
  // commands run unattended. `/clear` starts a *new* conversation, so it takes
  // the preference exactly as the launcher would, instead of replaying whatever
  // the conversation being abandoned was granted (#134).
  it('restarts in the mode the preference names, not the one it was launched in', async function () {
    const { s } = session();
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', bypassPermissions: true };
    s.deps.resolveBypass = () => false;

    let startedWith = null;
    s.start = async (options) => {
      startedWith = options;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.strictEqual(
      startedWith.bypassPermissions,
      false,
      'a preference switched back to asking must reach the next conversation',
    );
  });

  it('restarts into a bypass when that is what the preference says', async function () {
    // The other direction, and the one that makes the composer's New chat agree
    // with the recovery notice's Start a new chat: both begin a conversation, so
    // both land in the mode the user chose.
    const { s } = session();
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', bypassPermissions: false };
    s.deps.resolveBypass = () => true;

    let startedWith = null;
    s.start = async (options) => {
      startedWith = options;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.strictEqual(startedWith.bypassPermissions, true);
  });

  it('asks when nothing can answer what the mode should be', async function () {
    const { s } = session();
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', bypassPermissions: true };

    let startedWith = null;
    s.start = async (options) => {
      startedWith = options;
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    assert.strictEqual(startedWith.bypassPermissions, false);
  });

  it('tells the record the mode the restart actually landed in', async function () {
    // Without this the record still says "bypassing" for a conversation that was
    // just cleared down to asking, and the next resume — which replays the
    // record — hands back a standing permission it no longer had.
    const { s } = session();
    const lifecycle = [];
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp', bypassPermissions: true };
    s.deps.resolveBypass = () => false;
    s.deps.onLifecycle = (id, change) => lifecycle.push(change);
    s.start = async (options) => {
      s.bypass = Boolean(options.bypassPermissions);
      s.adapter = fakeAdapter([]);
      s.state = 'idle';
    };

    await s.send({ text: '/clear' });

    const reported = lifecycle.filter((change) => change.bypassing !== undefined).pop();
    assert.ok(reported, 'the record has to hear about a mode that changed');
    assert.strictEqual(reported.bypassing, false);
    assert.strictEqual(reported.exited, false, 'and still that the conversation is running');
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
        // The real one. Claude asks through this hook rather than through the
        // adapter protocol, so a session pointed at a script that is not there
        // is a session that genuinely cannot ask — which is a different thing
        // from the mode it is in, and the approvals notice says which.
        hookScript: path.join(__dirname, '..', 'dist', 'server', 'chat', 'permission-hook.js'),
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

  it('opens a conversation by saying which approval mode it is in', async function () {
    // Not the badge, which only appears for a bypass, and not a settings dialog
    // the user may never open: a line in the conversation, where the tools are
    // running. The mode is chosen as a conversation begins, so this is the one
    // moment it can be stated for both of them (#134).
    const { s, store } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir(), bypassPermissions: true });

    const notice = store.events.find((e) => e.t === 'marker' && e.kind === 'approvals');
    assert.ok(notice, 'a new conversation has to say which mode it is in');
    assert.match(notice.detail, /bypassed/);
    await s.stop();
  });

  it('says so again when a clear starts the conversation over in another mode', async function () {
    const { s, store } = liveSession();
    s.deps.resolveBypass = () => false;
    await s.start({ runtime: 'claude', workingDir: os.tmpdir(), bypassPermissions: true });
    const old = s.adapter;

    await s.send({ text: '/clear' });
    await died(old);

    const cleared = store.events.findIndex((e) => e.t === 'marker' && e.kind === 'cleared');
    const after = store.events
      .slice(cleared)
      .filter((e) => e.t === 'marker' && e.kind === 'approvals');
    assert.strictEqual(after.length, 1, 'the replacement conversation states its own mode');
    assert.match(
      after[0].detail,
      /asked before each tool call/,
      'a bypass that has just been dropped must not be dropped silently',
    );
    await s.stop();
  });

  it('says plainly that a runtime with no approval channel cannot ask', async function () {
    // pi's chat adapter publishes no approval channel — its --approve trusts
    // project files for the whole run rather than gating tool calls — so "ask"
    // cannot be enforced for it whatever the rule computes. Saying "you are
    // asked before each tool call" over one of its conversations would be this
    // app claiming a boundary that is not there.
    const { s, store } = liveSession();
    await s.start({ runtime: 'pi', workingDir: os.tmpdir() });

    const notice = store.events.find((e) => e.t === 'marker' && e.kind === 'approvals');
    assert.ok(notice, 'the line is drawn for every runtime');
    assert.match(notice.detail, /cannot ask/);
    await s.stop();
  });

  it('says nothing about the mode when a conversation is only resumed', async function () {
    // A resume comes back to a transcript that already carries the line from the
    // day it started. Repeating it on every relaunch would be noise, and noise
    // is how a line that matters stops being read.
    const { s, store } = liveSession();
    await s.start({
      runtime: 'claude',
      workingDir: os.tmpdir(),
      resumeSessionId: 'native-old',
    });

    assert.ok(
      !store.events.some((e) => e.t === 'marker' && e.kind === 'approvals'),
      'a continued conversation is not a conversation beginning',
    );
    await s.stop();
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

  it('cuts the log at the marker, so the clear survives a reload', async function () {
    const { s, store } = liveSession();
    await s.start({ runtime: 'claude', workingDir: os.tmpdir() });
    const old = s.adapter;

    await s.send({ text: '/clear' });
    await died(old);

    const marker = store.events.find((e) => e.t === 'marker' && e.kind === 'cleared');
    assert.ok(marker, 'the window was told to empty');
    assert.deepStrictEqual(
      store.truncations,
      [marker.seq],
      'emptying the window is not enough: the log has to start at the line, or a reload replays what was above it',
    );
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

  it('takes the figures above it with it', function () {
    // The header reads tokens, money and a context bar. All three are
    // statements about the conversation that has just ended, and a new one
    // opening under the old one's bill — or under a bar saying 80% of a window
    // that is now empty — is reporting the wrong conversation.
    const state = createTranscript({});
    applyChatEvent(state, {
      t: 'usage',
      seq: 1,
      ts: 1,
      usage: {
        inputTokens: 12000,
        outputTokens: 3400,
        totalTokens: 15400,
        costUsd: 4.21,
        contextUsed: 160000,
        contextWindow: 200000,
        contextWindowSource: 'agent',
      },
    });

    applyChatEvent(state, { t: 'marker', kind: 'cleared', seq: 2, ts: 2 });

    assert.deepStrictEqual(state.usage, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextUsed: 0,
      costUsd: 0,
      // The model's capacity, not the conversation's spend: a new conversation
      // on the same model has the same window, and dropping it would show
      // "size unknown" for a size that is known.
      contextWindow: 200000,
      contextWindowSource: 'agent',
    });
  });

  it('reports zero rather than nothing, so the meter resets instead of vanishing', function () {
    // Zero is the answer here, and an empty object is not it: the meter draws
    // nothing at all for a runtime that reported nothing, so emptying the
    // fields would blank the header rather than reset it.
    const state = createTranscript({});
    applyChatEvent(state, { t: 'usage', seq: 1, ts: 1, usage: { totalTokens: 900, costUsd: 0.5 } });
    applyChatEvent(state, { t: 'marker', kind: 'cleared', seq: 2, ts: 2 });

    assert.strictEqual(state.usage.totalTokens, 0);
    assert.strictEqual(state.usage.costUsd, 0);
  });

  it('invents no figure for a runtime that reported none', function () {
    // The other half of the same rule. A runtime that reports no money must
    // not come back from a clear claiming it spent $0.00 — that is an answer,
    // and nobody gave one.
    const state = createTranscript({});
    applyChatEvent(state, { t: 'usage', seq: 1, ts: 1, usage: { totalTokens: 900 } });
    applyChatEvent(state, { t: 'marker', kind: 'cleared', seq: 2, ts: 2 });

    assert.strictEqual(state.usage.totalTokens, 0);
    assert.strictEqual(state.usage.costUsd, undefined);
  });

  it('a line that is not a clear leaves the figures alone', function () {
    // Compaction empties the agent's context, not the conversation: what it
    // has cost so far is still what it has cost.
    const state = createTranscript({});
    applyChatEvent(state, { t: 'usage', seq: 1, ts: 1, usage: { totalTokens: 900, costUsd: 0.5 } });
    applyChatEvent(state, { t: 'marker', kind: 'compacted', seq: 2, ts: 2 });

    assert.strictEqual(state.usage.totalTokens, 900);
    assert.strictEqual(state.usage.costUsd, 0.5);
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
