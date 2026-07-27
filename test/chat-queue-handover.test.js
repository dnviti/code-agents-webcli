const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { GrokChatAdapter } = require('../dist/server/chat/adapters/grok.js');
const { CodexExecAdapter } = require('../dist/server/chat/adapters/codex.js');

// Issue #89: a queued message was handed over the instant the previous turn
// reported itself finished — and for the three adapters that spawn one process
// per turn, "finished" is a line of *stdout* that arrives while the process
// that wrote it is still exiting. In that window the adapter's own send()
// throws. It threw after ChatSession.deliver had already written the user's
// message into the transcript and moved the state to `thinking`, so the message
// sat in the conversation unanswered forever, and because a drain needs an idle
// session, everything queued behind it died with it.
//
// These drive the real adapters against real child processes, because the bug
// was in the timing of a real process's death and a stub adapter that always
// accepts cannot have it. The stub CLI below is the race made deterministic:
// it says the turn is over and then takes EXIT_DELAY_MS to actually go away.

const EXIT_DELAY_MS = 120;

let dir;
let stub;
let log;

before(function () {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-handover-'));
  stub = path.join(dir, 'stub-runtime.js');
  log = path.join(dir, 'prompts.log');
  fs.writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      '// argv: [node, stub, runtime, ...adapter flags..., prompt]',
      'const runtime = process.argv[2];',
      'const prompt = process.argv[process.argv.length - 1];',
      '// One line per process that really ran, in the order they really ran.',
      "fs.appendFileSync(process.env.QUEUE_LOG, prompt + '\\n');",
      'const done = {',
      "  pi: [{ type: 'agent_settled' }],",
      "  grok: [{ type: 'end', stopReason: 'stop' }],",
      "  codex: [{ type: 'turn.completed' }],",
      '}[runtime];',
      "for (const line of done) process.stdout.write(JSON.stringify(line) + '\\n');",
      '// The window the bug lived in: the turn is over as far as every reader of',
      '// stdout is concerned, and this process is still here.',
      `setTimeout(() => process.exit(0), ${EXIT_DELAY_MS});`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

after(function () {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(function () {
  fs.writeFileSync(log, '');
});

/** What the stub recorded: one line per process that actually ran a prompt. */
function promptsRun() {
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
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

const ADAPTERS = [
  { runtime: 'pi', Adapter: PiChatAdapter },
  { runtime: 'grok', Adapter: GrokChatAdapter },
  { runtime: 'codex', Adapter: CodexExecAdapter },
];

/** A real ChatSession driving a real adapter driving real processes. */
function liveSession(runtime, Adapter) {
  const store = memoryStore();
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'queue-handover-sock-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: () => {},
      resolveCommand: () => process.execPath,
    },
  );
  const adapter = new Adapter({
    sessionId: 's1',
    workingDir: path.join(__dirname, '..'),
    command: process.execPath,
    env: { QUEUE_LOG: log },
    emit: (event) => s.ingest(event),
  });
  // The stub is node's script argument; the adapter's own flags follow it and
  // it ignores them. The runtime name tells it which protocol to speak.
  adapter.buildArgs = () => [stub, runtime];
  s.adapter = adapter;
  s.state = 'idle';
  return { s, store, adapter };
}

/** Resolve once `check()` holds, or fail loudly rather than hanging mocha. */
function until(check, what, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      let hit = false;
      try {
        hit = check();
      } catch (error) {
        clearInterval(poll);
        reject(error);
        return;
      }
      if (hit) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`${what} — gave up after ${timeoutMs}ms. Ran: ${JSON.stringify(promptsRun())}`));
      }
    }, 10);
  });
}

describe('a queue is worked through even when every turn is instant (#89)', function () {
  this.timeout(30000);

  let live = null;
  afterEach(async function () {
    const adapter = live;
    live = null;
    if (adapter) await adapter.stop().catch(() => undefined);
  });

  for (const { runtime, Adapter } of ADAPTERS) {
    it(`${runtime}: answers every queued message, in order, with none skipped`, async function () {
      const { s, adapter } = liveSession(runtime, Adapter);
      live = adapter;

      const texts = ['one', 'two', 'three', 'four', 'five'];
      for (const text of texts) await s.send({ text });

      await until(() => promptsRun().length === texts.length, 'not every queued message reached a process');

      assert.deepStrictEqual(
        promptsRun(),
        texts,
        'every message must reach a real process, in the order it was typed',
      );
      assert.strictEqual(s.queuedTurns.length, 0, 'nothing is still waiting once the line is worked through');
    });

    it(`${runtime}: never shows a message as asked when it was not`, async function () {
      const { s, store, adapter } = liveSession(runtime, Adapter);
      live = adapter;

      const texts = ['alpha', 'beta', 'gamma'];
      for (const text of texts) await s.send({ text });
      await until(() => promptsRun().length === texts.length, 'not every queued message reached a process');

      // The user's own messages, as the transcript holds them, deduplicated:
      // `codex exec` and the ACP adapters write the user's turn into the log
      // themselves *as well as* the session doing it for every runtime, so two
      // of the five echo it twice. That is a separate defect — a message shown
      // twice, not one shown that was never asked — and this is about the
      // second. The failure mode here is a message written into the
      // conversation by deliver() and then never sent, which shows up as text
      // in the transcript that no process ever saw.
      const asked = [
        ...new Set(
          store.events
            .filter((e) => e.t === 'block_start' && e.block.kind === 'text')
            .map((e) => e.block.text)
            .filter((text) => texts.includes(text)),
        ),
      ];

      assert.deepStrictEqual(
        asked,
        promptsRun(),
        'the conversation must show exactly the messages that were really asked',
      );
      assert.ok(
        !store.events.some((e) => e.t === 'error' && /could not send a queued message/i.test(e.message)),
        'nothing should have failed to be handed over',
      );
    });
  }

  it('pi: the adapter is asked whether it can take a turn, not assumed to be able to', async function () {
    const { s, adapter } = liveSession('pi', PiChatAdapter);
    live = adapter;

    await s.send({ text: 'first' });
    await until(() => promptsRun().length === 1, 'the first turn never ran');

    // Mid-window: the turn is over (the stub said so) and the process it ran in
    // is still exiting. This is the exact moment the queue used to hand over.
    await until(() => s.currentState === 'idle', 'the turn never ended');
    assert.strictEqual(adapter.readyForTurn, false, 'a process still exiting cannot take the next turn');

    await s.send({ text: 'second' });
    assert.deepStrictEqual(
      s.queuedTurns.map((t) => t.text),
      ['second'],
      'a message sent into that window waits rather than being handed to a process that would refuse it',
    );

    await until(() => promptsRun().length === 2, 'the second message never ran');
    assert.deepStrictEqual(promptsRun(), ['first', 'second']);
  });

  it('keeps a message that could not be delivered, with the reason on it', async function () {
    const { s, store } = liveSession('pi', PiChatAdapter);
    // A stopped adapter refuses every send, which is a delivery failure rather
    // than a dead session — the session itself is still alive and idle.
    s.adapter = {
      alive: true,
      readyForTurn: true,
      async send() {
        throw new Error('nope');
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {},
    };

    await s.send({ text: 'keep me' });
    await until(() => s.queuedTurns.length === 1, 'the undelivered message was not kept');

    const [held] = s.queuedTurns;
    assert.strictEqual(held.text, 'keep me', 'the text is still here, so nothing has to be retyped');
    assert.match(held.error, /nope/, 'and it says why it did not go');
    assert.strictEqual(held.attempts, 1);
    assert.strictEqual(s.currentState, 'idle', 'a failed handover must not leave the session claiming to work');
    assert.ok(
      store.events.some((e) => e.t === 'error' && /could not send a queued message/i.test(e.message)),
      'the failure is reported, not swallowed',
    );
  });

  it('holds the rest of the line behind a message that failed', async function () {
    const { s } = liveSession('pi', PiChatAdapter);
    let refuse = true;
    const sent = [];
    s.adapter = {
      alive: true,
      readyForTurn: true,
      async send(turn) {
        if (refuse) throw new Error('nope');
        sent.push(turn.text);
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {},
    };

    await s.send({ text: 'first' });
    await s.send({ text: 'second' });
    await until(() => Boolean(s.queuedTurns[0]?.error), 'the first message never failed');

    // Everything behind it was typed expecting it to have been asked, so the
    // line stops rather than running the follow-ups against an agent that never
    // saw what they follow up on.
    s.ingest({ t: 'turn_end', turnId: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(sent, [], 'nothing jumps a failed message');
    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['first', 'second']);

    // And the way out is one click, on the row that says what went wrong.
    refuse = false;
    s.retryQueued(s.queuedTurns[0].id);
    await until(() => sent.length === 1, 'retrying did not send the message that had failed');
    // What the adapter would emit when that turn finishes; the line advances
    // from there on its own, which is the point of retrying rather than
    // resending each one by hand.
    s.ingest({ t: 'turn_end', turnId: 't2' });
    await until(() => sent.length === 2, 'the rest of the line did not follow');
    assert.deepStrictEqual(sent, ['first', 'second'], 'and the order they were typed in survives it');
  });
});

describe('the line keeps moving after a turn that replaces the process (#89)', function () {
  this.timeout(10000);

  it('works through what was queued behind a /clear', async function () {
    const store = memoryStore();
    const s = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store,
        socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'queue-clear-')),
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => process.execPath,
      },
    );
    const sent = [];
    const adapter = () => ({
      alive: true,
      readyForTurn: true,
      async send(turn) {
        sent.push(turn.text);
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {},
    });
    s.adapter = adapter();
    s.state = 'idle';
    s.lastStartOptions = { runtime: 'claude', workingDir: '/tmp' };
    // What a relaunch does: a new process, idle and ready. It emits no event
    // this session has not already seen, which is exactly the trap — a drain
    // that waits for one waits forever.
    s.start = async () => {
      s.adapter = adapter();
      s.state = 'idle';
    };

    await s.send({ text: 'first' });
    await s.send({ text: '/clear' });
    await s.send({ text: 'after the clear' });

    s.ingest({ t: 'turn_end', turnId: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepStrictEqual(
      sent,
      ['first', 'after the clear'],
      'the message queued behind a /clear must still be asked — /clear itself never reaches a process',
    );
    assert.strictEqual(s.queuedTurns.length, 0);
  });
});
