const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A conversation of more than about forty messages came back from a resume with
// no capabilities whatsoever: no slash commands, no attachment control, no model
// or effort menu, and a stop button that could not stop a running turn (#30).
//
// Both halves of that are pinned here, because either one alone leaves the user
// in it:
//
//   1. `chat_snapshot` took its capabilities from the replayed tail, and the
//      only event that carries them — claude's `session`, emitted with the
//      `init` of its first turn — sits at the head of the log, hundreds of
//      events above a window that stops at forty messages.
//   2. Relaunching did not repair it. `chat_started` has always carried the
//      live session's capabilities and the controller read past the field, so
//      the menu only reappeared once the user sent a throwaway message and
//      claude introduced itself again.
//
// The fixtures are shaped like what the claude adapter actually writes: one
// `session` event at the top carrying the whole set, `effort` and `state` after
// it, and turns of msg_start / block_start / block_delta… / block_end / msg_end.
// The delta density is what puts the head out of reach — a window measured in
// messages is measured in events on disk.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

/**
 * Built on demand, and asked for from each suite's own hook.
 *
 * Not from a hook at the top level of the file: mocha makes those ROOT hooks,
 * which run around every test in the whole run — so this bundle would become a
 * prerequisite for all hundred-odd suites, and a bad path or an esbuild bump
 * here would report as a failure in "{root}" and take the entire run with it.
 */
function ensureBundle() {
  if (mod) return mod;
  const contents = [
    `export { ChatStore } from ${JSON.stringify(path.join(ROOT, 'src/server/chat/store'))};`,
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-capabilities-recovery-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-capabilities-recovery.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
  return mod;
}

function useBundle(suite) {
  suite.timeout(60000);
  ensureBundle();
}

/** Idempotent, so each suite can tidy up after itself without ordering rules. */
function dropBundle() {
  if (bundle) fs.rmSync(bundle, { force: true });
  bundle = null;
  mod = null;
}

/** Claude's own set, as its adapter declares it and its `init` completes it. */
function claudeCapabilities(overrides = {}) {
  return {
    streaming: true,
    thinking: true,
    toolCalls: true,
    diffs: false,
    permissions: false,
    interrupt: true,
    resume: true,
    fork: false,
    attachments: true,
    usage: true,
    cost: true,
    plan: false,
    commands: [
      { name: 'compact', description: 'summarise the conversation so far' },
      { name: 'review', description: 'review the working diff' },
    ],
    efforts: [
      { value: 'low', name: 'Low', rank: 0 },
      { value: 'high', name: 'High', rank: 1 },
    ],
    ...overrides,
  };
}

/**
 * A recorded conversation: the runtime's introduction, then `messages` turns of
 * streamed text.
 *
 * `extras` are session-level events spliced in after the introduction, which is
 * where a model list probed at launch or a relaunch's own `session` event lands.
 */
function recordedChat(messages, { capabilities = claudeCapabilities(), extras = [] } = {}) {
  const events = [];
  let seq = 0;
  const at = (event) => {
    seq += 1;
    events.push({ ...event, seq, ts: 1_700_000_000_000 + seq });
  };

  at({ t: 'session', nativeSessionId: 'a1b2c3', model: 'claude-opus-5', capabilities });
  at({ t: 'effort', effort: null });
  at({ t: 'state', state: 'idle' });
  for (const extra of extras) at(extra);

  for (let i = 0; i < messages; i++) {
    const id = `msg-${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    at({ t: 'msg_start', id, role, turnId: `turn-${Math.floor(i / 2)}` });
    at({ t: 'block_start', msgId: id, index: 0, block: { kind: 'text', text: '' } });
    for (let token = 0; token < 12; token++) {
      at({ t: 'block_delta', msgId: id, index: 0, text: `token ${token} ` });
    }
    at({ t: 'block_end', msgId: id, index: 0 });
    at({ t: 'msg_end', msgId: id });
    if (role === 'assistant') at({ t: 'turn_end', turnId: `native-${Math.floor(i / 2)}`, stopReason: 'end_turn' });
  }

  return events;
}

describe('capabilities of a conversation whose process is gone', function () {
  before(function () {
    useBundle(this);
  });

  after(dropBundle);

  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-chat-caps-'));
    store = new mod.ChatStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function snapshotOf(id, events) {
    const session = { id, ownerUserId: 1 };
    store.append(session, events);
    return store.snapshot(session, { runtime: 'claude' });
  }

  it('recovers the account reading the provider stated above the window (#137)', async function () {
    const limits = {
      billing: 'subscription',
      windows: [{ kind: 'five_hour', status: 'allowed', resetsAt: '2026-07-29T16:00:00.000Z' }],
    };
    const snapshot = await snapshotOf('acct', recordedChat(200, {
      extras: [{ t: 'limits', limits }],
    }));

    // Claude states its rate-limit window on the first turn and then only when
    // it changes, so on a long conversation the statement is hundreds of events
    // above a window measured in messages. Lost, the panel would come back from
    // every rejoin claiming the runtime had never reported one.
    assert.deepStrictEqual(snapshot.limits, limits);
  });

  it('recovers what the runtime reported from above the replay window', async function () {
    const snapshot = await snapshotOf('long', recordedChat(200));

    assert.deepStrictEqual(
      snapshot.capabilities.commands,
      claudeCapabilities().commands,
      'the slash command menu is the first thing the user notices missing',
    );
    assert.strictEqual(snapshot.capabilities.interrupt, true, 'a running turn has to be stoppable');
    assert.strictEqual(snapshot.capabilities.attachments, true);
    assert.strictEqual(snapshot.capabilities.efforts?.length, 2, 'the effort menu had nothing to offer');
    assert.ok(
      snapshot.replayFrom > snapshot.firstSeq,
      'the window has to have left the head behind, or this proves nothing',
    );
  });

  it('leaves a conversation short enough to replay whole exactly as it was', async function () {
    const snapshot = await snapshotOf('short', recordedChat(8));

    assert.deepStrictEqual(snapshot.capabilities.commands, claudeCapabilities().commands);
    assert.strictEqual(snapshot.capabilities.interrupt, true);
  });

  it('keeps a capability announced after the introduction and before the window', async function () {
    // The model menu arrives on its own event, whenever the probe that went
    // looking for it finishes — near the top of the conversation, and just as
    // far outside the window as the introduction is.
    const models = [{ value: 'claude-opus-5', name: 'Opus 5' }];
    const snapshot = await snapshotOf(
      'probed',
      recordedChat(200, { extras: [{ t: 'capabilities', capabilities: { models } }] }),
    );

    assert.deepStrictEqual(snapshot.capabilities.models, models);
    assert.deepStrictEqual(snapshot.capabilities.commands, claudeCapabilities().commands);
  });

  it('takes the newest introduction rather than merging every one of them', async function () {
    // A conversation resumed under a runtime that has since lost a capability.
    // A merge would go on offering what it dropped — which is the failure this
    // whole issue is about, pointed the other way.
    const relaunched = claudeCapabilities({
      attachments: false,
      commands: [{ name: 'compact' }],
    });
    const snapshot = await snapshotOf(
      'relaunched',
      recordedChat(200, {
        // The model menu belongs to the run that probed for it, and the
        // relaunch's own set says nothing about models — so this key is the one
        // that tells a replace from a merge. Without it every key of the first
        // introduction is overwritten by the second either way, and the test
        // passes under both readings: verified by making the fold merge.
        extras: [
          { t: 'capabilities', capabilities: { models: [{ value: 'claude-opus-5', name: 'Opus 5' }] } },
          { t: 'session', nativeSessionId: 'd4e5f6', capabilities: relaunched },
        ],
      }),
    );

    assert.strictEqual(
      snapshot.capabilities.models,
      undefined,
      'a process that has just started is describing itself, not adding to what the last one said',
    );
    assert.deepStrictEqual(snapshot.capabilities.commands, [{ name: 'compact' }]);
    assert.strictEqual(snapshot.capabilities.attachments, false);
  });

  it('does not carry a cleared conversation’s capabilities into what replaced it', async function () {
    // `/clear` truncates the log at the marker, and the fold is read from the
    // log: what the runtime said before the line belongs to the conversation
    // the user walked away from.
    const session = { id: 'cleared', ownerUserId: 1 };
    store.append(session, recordedChat(200));
    const cursor = (await store.stat(session)).cursor;
    store.append(session, [
      { t: 'marker', kind: 'cleared', detail: 'started a new conversation', seq: cursor + 1, ts: 1 },
    ]);
    await store.truncateBefore(session, cursor + 1);

    // A second store over the same directory is a server that has restarted,
    // which is the only reader that has to answer this from the log alone.
    const reopened = new mod.ChatStore({ storageDir: dir });
    const snapshot = await reopened.snapshot(session, { runtime: 'claude' });
    assert.strictEqual(snapshot.capabilities.commands, undefined);
    assert.strictEqual(snapshot.capabilities.interrupt, false);
  });
});

describe('capabilities when a conversation is relaunched', function () {
  before(function () {
    useBundle(this);
  });

  after(dropBundle);

  function controller() {
    return new mod.ChatController('s1', { send: () => {} });
  }

  /** What the browser hydrates a long, resumable conversation with. */
  function deadSnapshot(capabilities, overrides = {}) {
    return {
      sessionId: 's1',
      runtime: 'claude',
      messages: [],
      state: 'exited',
      capabilities,
      pendingPermissions: [],
      pendingQuestions: [],
      firstSeq: 1,
      replayFrom: 900,
      cursor: 3200,
      live: false,
      bypassPermissions: false,
      ...overrides,
    };
  }

  const none = {
    streaming: false,
    thinking: false,
    toolCalls: false,
    diffs: false,
    permissions: false,
    interrupt: false,
    resume: false,
    fork: false,
    attachments: false,
    usage: false,
    cost: false,
    plan: false,
  };

  it('adopts what the launch announced instead of dropping it', function () {
    const c = controller();
    c.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: deadSnapshot(none) });
    c.handle({
      type: 'chat_started',
      sessionId: 's1',
      agent: 'claude',
      capabilities: claudeCapabilities(),
    });

    assert.strictEqual(c.transcript.capabilities.interrupt, true, 'the stop button was inert');
    assert.deepStrictEqual(c.transcript.capabilities.commands, claudeCapabilities().commands);
    assert.strictEqual(c.transcript.capabilities.attachments, true);
  });

  it('keeps the command list the runtime itself reported, over the launch stand-in', function () {
    // What a launch announces is always a stand-in: claude's adapter declares
    // the built-ins plus whatever the disk scan found, and does not publish its
    // real list until the `init` of its first turn. Folding that in on every
    // relaunch would take the runtime's own names back off the menu and put
    // names it has no command for back on — the condition #71 is about.
    const recovered = [{ name: 'project:deploy', description: 'ship it' }];
    const c = controller();
    c.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: deadSnapshot({ ...none, commands: recovered }),
    });
    c.handle({
      type: 'chat_started',
      sessionId: 's1',
      agent: 'claude',
      // What the adapter really broadcasts: its own declaration, command list
      // and all. A fixture with the list left out would make the merge look
      // protective in the one case production never produces.
      capabilities: claudeCapabilities(),
    });

    assert.deepStrictEqual(
      c.transcript.capabilities.commands,
      recovered,
      'the recorded list is the runtime’s own; the launch list is this app’s guess',
    );
    assert.strictEqual(c.transcript.capabilities.interrupt, true);
  });

  it('redraws the surfaces that read the menu', function () {
    // The composer reads `capabilities` straight off the transcript, so a set
    // that lands without notifying anybody is a menu that stays missing until
    // something else happens to re-render.
    //
    // Announced to a conversation that is already running, which is what a
    // `/clear` does: it restarts in place and the launch is the only thing that
    // says what came back. Nothing else on `chat_started` changes for it — the
    // live flag and the approval mode are already what they will be — so this
    // is the one redraw the new set has to cause on its own.
    const c = controller();
    c.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: deadSnapshot(none, { live: true, state: 'idle' }),
    });

    let redraws = 0;
    c.transcript.subscribe(() => {
      redraws += 1;
    });
    c.handle({
      type: 'chat_started',
      sessionId: 's1',
      agent: 'claude',
      capabilities: claudeCapabilities(),
    });

    assert.ok(redraws > 0, 'nothing subscribed to the transcript heard about it');
  });
});
