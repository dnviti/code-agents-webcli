const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');

// The approval mode a *running* pane is showing, across the one route that
// changes it without the browser being told anything else (#134).
//
// `/clear` restarts a conversation in place. The server re-decides the mode
// against the account's preference — that part already had tests — but nothing
// on the launch path runs, so no `chat_started` is broadcast and the pane never
// asks for a fresh snapshot. Everything persistent that names the mode (the
// chip beside the input box, the header badge, the label on the recovery
// notice's Resume button) reads `ChatTranscript.bypassing`, and both of the
// authorities that write it live on paths a restart does not take. The pane
// therefore went on naming the mode of the conversation the clear replaced,
// indefinitely — "Approvals asked for" over an agent now running unattended.
//
// Driven through both halves for real: a live `ChatSession` produces the
// events, and the bundled client `ChatController` is handed exactly those. No
// event here is written by hand, because an invented one would only prove the
// client agrees with this file's idea of what the server emits.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

/**
 * Built on demand from the suite's own hook, never from a top-level one.
 *
 * Mocha promotes a top-level `before` to a root hook that runs around every
 * suite in the process; an esbuild failure here would then report as a failure
 * in "{root}" and take the whole run with it.
 */
function ensureBundle() {
  if (mod) return mod;
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-approval-mode-live-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-approval-mode-live.ts' },
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
    // Recorded, not acted on: what the log does with the boundary is #43's
    // business, and dropping the events here would take the marker pair this
    // suite is about with it.
    async truncateBefore() {},
  };
}

describe('the approval mode a live pane is showing', function () {
  let dirs = [];

  this.timeout(60000);

  before(function () {
    ensureBundle();
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
    bundle = null;
  });

  afterEach(function () {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /**
   * A CLI that behaves like one mid-conversation: alive, quiet, holding an open
   * pipe, and ignoring its arguments — a process that exited on an unknown flag
   * would be a dead session pretending to be a live one.
   */
  function fakeCli() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-cli-'));
    dirs.push(dir);
    const script = path.join(dir, 'quiet-agent');
    fs.writeFileSync(script, '#!/bin/sh\nexec cat > /dev/null\n');
    fs.chmodSync(script, 0o755);
    return script;
  }

  function liveSession() {
    const store = memoryStore();
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-live-'));
    dirs.push(socketDir);
    const command = fakeCli();
    const s = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store,
        socketDir,
        hookScript: path.join(ROOT, 'dist', 'server', 'chat', 'permission-hook.js'),
        broadcast: () => {},
        resolveCommand: () => command,
      },
    );
    return { s, store };
  }

  /** Wait for the process behind an adapter to actually be gone. */
  async function died(adapter) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!adapter.alive) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the old process never exited');
  }

  /**
   * A pane already joined to this conversation, in the mode it is running in.
   *
   * The snapshot is the only thing this hand-writes, and only the fields the
   * transcript reads on hydrate; the mode on it is the server's own.
   */
  function pane(bypassPermissions) {
    const controller = new mod.ChatController('s1', { send: () => {} });
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: {
        sessionId: 's1',
        runtime: 'claude',
        messages: [],
        state: 'idle',
        capabilities: {},
        pendingPermissions: [],
        firstSeq: 1,
        replayFrom: 1,
        cursor: 0,
        live: true,
        bypassPermissions,
      },
    });
    return controller;
  }

  /** Everything the server wrote from `after` on, as the socket would deliver it. */
  function deliver(controller, events, after) {
    for (const event of events.slice(after)) {
      controller.handle({ type: 'chat_event', sessionId: 's1', event });
    }
  }

  it('drops the bypass on screen when a clear starts the conversation over asking', async function () {
    const { s, store } = liveSession();
    s.deps.resolveBypass = () => false;
    await s.start({ runtime: 'claude', workingDir: os.tmpdir(), bypassPermissions: true });

    const joined = pane(true);
    assert.strictEqual(joined.transcript.bypassing, true, 'the pane starts out agreeing');
    const before = store.events.length;

    const old = s.adapter;
    await s.send({ text: '/clear' });
    await died(old);
    deliver(joined, store.events, before);

    assert.strictEqual(
      joined.transcript.bypassing,
      false,
      'the chip, the badge and the recovery notice all read this — leaving it true is a standing '
      + 'promise that the agent will stop and ask, over one that no longer does',
    );
    await s.stop();
  });

  it('shows the bypass a clear has just granted rather than still promising prompts', async function () {
    // The dangerous direction. The conversation was asking; the preference now
    // says bypass; every tool call from here on runs unattended, and a chip
    // still reading "Approvals asked for" is a false safety claim rather than a
    // missing one.
    const { s, store } = liveSession();
    s.deps.resolveBypass = () => true;
    await s.start({ runtime: 'claude', workingDir: os.tmpdir(), bypassPermissions: false });

    const joined = pane(false);
    const before = store.events.length;

    const old = s.adapter;
    await s.send({ text: '/clear' });
    await died(old);
    deliver(joined, store.events, before);

    assert.strictEqual(joined.transcript.bypassing, true);
    await s.stop();
  });

  it('leaves the mode alone when a clear does not change it', async function () {
    const { s, store } = liveSession();
    s.deps.resolveBypass = () => true;
    await s.start({ runtime: 'claude', workingDir: os.tmpdir(), bypassPermissions: true });

    const joined = pane(true);
    const before = store.events.length;

    const old = s.adapter;
    await s.send({ text: '/clear' });
    await died(old);
    deliver(joined, store.events, before);

    assert.strictEqual(joined.transcript.bypassing, true);
    await s.stop();
  });

  it('does not let a replayed opening line rewrite a mode it is not about', function () {
    // History reaches the transcript through `hydrate` and `chat_page`, neither
    // of which comes through the live-event path — so scrolling back past the
    // opening line of a conversation that ran in another mode cannot flip the
    // indicators for the one on screen.
    const controller = pane(true);
    controller.handle({
      type: 'chat_page',
      sessionId: 's1',
      events: [
        {
          t: 'marker',
          kind: 'approvals',
          seq: 1,
          ts: 1,
          detail: 'on — you are asked before each tool call',
          bypassing: false,
        },
      ],
      firstSeq: 1,
      from: 1,
      cursor: 1,
    });
    assert.strictEqual(controller.transcript.bypassing, true);
  });
});
