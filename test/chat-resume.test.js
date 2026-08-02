const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { ChatSessionManager } = require('../dist/server/chat/manager.js');

// Picking a conversation back up after the process behind it is gone.
//
// Chat sessions live in the server's memory and transcripts live on disk, so a
// restart leaves a conversation on screen with nothing running it. Everything
// here is about the two halves of making that recoverable: carrying the
// runtime's own conversation id far enough that the agent can be handed its
// context back, and making sure that handing it back does not write the
// conversation into the log a second time.

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
    // Honours `options` the way the real store does: the log knows neither the
    // runtime nor the approval mode, so whatever the caller passes is the only
    // answer there is.
    async snapshot(_ref, options = {}) {
      return {
        sessionId: 's1', runtime: options.runtime ?? '', messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: options.live ?? false,
        bypassPermissions: options.bypassPermissions ?? false,
      };
    },
  };
}

function session(deps = {}) {
  const store = memoryStore();
  const broadcasts = [];
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'resume-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => 'claude',
      ...deps,
    },
  );
  s.adapter = {
    alive: true,
    async send() {},
    async interrupt() {},
    respondPermission() {},
    async stop() {},
  };
  s.state = 'idle';
  return { s, store, broadcasts };
}

describe('resuming a conversation', function () {
  describe('the replay gate', function () {
    // ACP's session/load hands the whole history back as notifications, and the
    // other runtimes promise nothing either way. Every one of those events would
    // be appended to a log that already holds them, and the user would watch the
    // conversation appear underneath itself.

    it('drops content a resuming runtime re-emits from history', function () {
      const { s, store } = session();
      s.replaying = true;

      s.ingest({ t: 'msg_start', id: 'old-1', role: 'user', turnId: 't0' });
      s.ingest({ t: 'block_start', msgId: 'old-1', index: 0, block: { kind: 'text', text: 'hi' } });
      s.ingest({ t: 'msg_end', msgId: 'old-1' });
      s.ingest({ t: 'turn_end', turnId: 't0' });

      assert.deepStrictEqual(store.events, [], 'a replayed conversation must not be re-logged');
    });

    it('keeps what describes the process that just started', function () {
      // Suppressing these would leave the browser looking at a session whose
      // runtime it could not name.
      const { s, store } = session();
      s.replaying = true;

      s.ingest({ t: 'session', nativeSessionId: 'native-7', capabilities: { streaming: true } });
      s.ingest({ t: 'state', state: 'idle' });

      assert.deepStrictEqual(
        store.events.map((e) => e.t),
        ['session', 'state'],
      );
    });

    it('spends no sequence number on a dropped event', function () {
      // A hole in the numbering is not cosmetic: a browser pages by seq, and a
      // gap it can never be handed is a request that never settles.
      const { s, store } = session();
      s.replaying = true;
      s.ingest({ t: 'msg_start', id: 'old-1', role: 'user', turnId: 't0' });
      s.ingest({ t: 'msg_end', msgId: 'old-1' });
      s.replaying = false;
      s.ingest({ t: 'state', state: 'idle' });

      assert.strictEqual(store.events.length, 1);
      assert.strictEqual(store.events[0].seq, 1, 'numbering continues unbroken');
    });

    it('ends the replay on the first thing the user says', async function () {
      const { s, store } = session();
      s.replaying = true;

      await s.send({ text: 'so where were we?' });

      const texts = store.events
        .filter((e) => e.t === 'block_start')
        .map((e) => e.block.text);
      assert.deepStrictEqual(texts, ['so where were we?'], 'the turn that ends the replay is kept');
      assert.strictEqual(s.replaying, false);
    });
  });

  describe('carrying the native id out of the process', function () {
    it('reports it the moment the runtime names its own conversation', function () {
      const seen = [];
      const { s } = session({ onLifecycle: (id, change) => seen.push([id, change]) });

      s.ingest({ t: 'session', nativeSessionId: 'native-7', capabilities: {} });

      assert.deepStrictEqual(seen, [['s1', { nativeSessionId: 'native-7' }]]);
    });

    it('reports the exit, so the record stops claiming a process it does not have', function () {
      // Without this a relaunch in the same tab came back as "A process is
      // already running in this session" — a lie the user could only escape by
      // opening a new tab and leaving the conversation behind.
      const seen = [];
      const { s } = session({ onLifecycle: (id, change) => seen.push(change) });

      s.ingest({ t: 'state', state: 'exited' });

      assert.deepStrictEqual(seen, [{ exited: true, restarting: false }]);
    });

    it('marks the old adapter exit during an in-place restart', function () {
      const seen = [];
      const { s } = session({ onLifecycle: (_id, change) => seen.push(change) });
      s.restarting = true;

      s.ingest({ t: 'state', state: 'exited' });

      assert.deepStrictEqual(seen, [{ exited: true, restarting: true }]);
    });

    it('puts it in the snapshot, so a browser knows a resume is possible', async function () {
      const { s } = session();
      s.ingest({ t: 'session', nativeSessionId: 'native-7', capabilities: {} });

      const snapshot = await s.snapshot();
      assert.strictEqual(snapshot.nativeSessionId, 'native-7');
    });
  });

  describe('the snapshot of a session with nothing running it', function () {
    function manager(deps = {}) {
      return new ChatSessionManager({
        store: { ...memoryStore(), async nativeSessionId() { return null; } },
        storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'resume-mgr-')),
        broadcast: () => {},
        resolveCommand: () => 'claude',
        ...deps,
      });
    }

    const record = (overrides) => ({
      id: 's1',
      ownerUserId: 7,
      lastAgent: 'claude',
      ...overrides,
    });

    it('takes the resume id from the record rather than the replayed log', async function () {
      // The log is replayed from its tail and the id is recorded once at the
      // very top of a conversation. Reading it from there would answer "this
      // cannot be resumed" for exactly the long conversations most worth
      // resuming.
      const snapshot = await manager().snapshot(record({ nativeChatSessionId: 'native-7' }));

      assert.strictEqual(snapshot.nativeSessionId, 'native-7');
      assert.strictEqual(snapshot.live, false, 'nothing is running it');
    });

    it('reports the approval mode of a conversation with nothing running it', async function () {
      // The mode is a standing permission the user chose for this conversation,
      // and the log holds what was said rather than how the conversation was set
      // up. Left to the store's default, every chat whose process was gone came
      // back to a header claiming it would ask before acting — over an agent
      // that, once relaunched, would not.
      const snapshot = await manager().snapshot(
        record({ chatBypassPermissions: true }),
      );

      assert.strictEqual(snapshot.bypassPermissions, true);
      assert.strictEqual(snapshot.live, false, 'nothing is running it');
    });

    it('never invents a bypass for a conversation that did not record one', async function () {
      const manual = await manager().snapshot(record());
      assert.strictEqual(manual.bypassPermissions, false);

      // The shape a session written before the mode was persisted comes back in.
      const legacy = await manager().snapshot(record({ chatBypassPermissions: undefined }));
      assert.strictEqual(legacy.bypassPermissions, false);
    });

    it('says so plainly when there is no id to resume with', async function () {
      const snapshot = await manager().snapshot(record());
      assert.strictEqual(snapshot.nativeSessionId, undefined);
    });

    it('still names the runtime, so the offer can say whose session it was', async function () {
      // The store knows nothing about a live process and returns an empty
      // runtime; the record is the only thing left that remembers.
      const snapshot = await manager().snapshot(record());
      assert.strictEqual(snapshot.runtime, 'claude');
    });

    it('falls back to the log for a conversation recorded before the column existed', async function () {
      // Otherwise every chat a user already had would come back offering only
      // to start over — on exactly the upgrade that added the feature.
      const saved = [];
      const mgr = manager({
        store: { ...memoryStore(), async nativeSessionId() { return 'from-the-log'; } },
        onLifecycle: (id, change) => saved.push([id, change]),
      });

      const snapshot = await mgr.snapshot(record());

      assert.strictEqual(snapshot.nativeSessionId, 'from-the-log');
      assert.deepStrictEqual(
        saved,
        [['s1', { nativeSessionId: 'from-the-log' }]],
        'and it is written to the record, so the scan happens once',
      );
    });

    it('survives a log it cannot read rather than failing the snapshot', async function () {
      const mgr = manager({
        store: {
          ...memoryStore(),
          async nativeSessionId() { throw new Error('disk went away'); },
        },
      });

      const snapshot = await mgr.snapshot(record());
      assert.strictEqual(snapshot.nativeSessionId, undefined, 'no resume offered, but a transcript');
    });
  });

  describe('reading the native id back out of a log', function () {
    const { ChatStore } = require('../dist/server/chat/store.js');

    function storeWith(lines) {
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-log-'));
      fs.mkdirSync(path.join(storageDir, '7'));
      fs.writeFileSync(
        path.join(storageDir, '7', 's1.jsonl'),
        lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
      );
      return new ChatStore({ storageDir });
    }

    const ref = { id: 's1', ownerUserId: 7 };

    it('finds it where a runtime actually puts it', async function () {
      const store = storeWith([
        { t: 'state', state: 'idle', seq: 1 },
        { t: 'session', nativeSessionId: 'native-7', seq: 2 },
        { t: 'msg_start', id: 'm1', seq: 3 },
      ]);
      assert.strictEqual(await store.nativeSessionId(ref), 'native-7');
    });

    it('answers null rather than guessing when the log has no such event', async function () {
      const store = storeWith([{ t: 'state', state: 'idle', seq: 1 }]);
      assert.strictEqual(await store.nativeSessionId(ref), null);
    });

    it('answers null for a session with no log at all', async function () {
      const store = storeWith([]);
      assert.strictEqual(await store.nativeSessionId({ id: 'never-existed', ownerUserId: 7 }), null);
    });

    it('is not derailed by a line it cannot parse', async function () {
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-log-'));
      fs.mkdirSync(path.join(storageDir, '7'));
      fs.writeFileSync(
        path.join(storageDir, '7', 's1.jsonl'),
        `{"t":"session","broken\n${JSON.stringify({ t: 'session', nativeSessionId: 'native-9' })}\n`,
      );
      const store = new ChatStore({ storageDir });
      assert.strictEqual(await store.nativeSessionId(ref), 'native-9');
    });

    it('reads past a runtime that opens with 90 kB of capabilities', async function () {
      // Not hypothetical: Oh My Pi's first event is 48 kB of command list and
      // the `capabilities` event after it another 44 kB, which puts the user's
      // opening message past 90 kB. A single 64 kB read found the session id
      // and silently missed the message, leaving the list nothing to label the
      // conversation with but a timestamp.
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-log-'));
      fs.mkdirSync(path.join(storageDir, '7'));
      fs.writeFileSync(
        path.join(storageDir, '7', 's1.jsonl'),
        [
          JSON.stringify({ t: 'session', nativeSessionId: 'native-1', pad: 'x'.repeat(48_000) }),
          JSON.stringify({ t: 'capabilities', pad: 'x'.repeat(44_000) }),
          JSON.stringify({ t: 'msg_start', id: 'u1', role: 'user' }),
          JSON.stringify({ t: 'block_start', msgId: 'u1', block: { kind: 'text', text: 'finalmente' } }),
        ].map((line) => `${line}\n`).join(''),
      );

      const store = new ChatStore({ storageDir });
      assert.deepStrictEqual(await store.describe(ref), {
        nativeSessionId: 'native-1',
        firstMessage: 'finalmente',
      });
    });

    it('still gives up rather than reading a whole log', async function () {
      // The ceiling is what keeps a pathological file from being read in full
      // to answer a question about its opening line.
      const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-log-'));
      fs.mkdirSync(path.join(storageDir, '7'));
      const filler = `${JSON.stringify({ t: 'block_delta', text: 'x'.repeat(2000) })}\n`;
      fs.writeFileSync(
        path.join(storageDir, '7', 's1.jsonl'),
        filler.repeat(600) + `${JSON.stringify({ t: 'session', nativeSessionId: 'too-deep' })}\n`,
      );
      const store = new ChatStore({ storageDir });
      assert.strictEqual(await store.nativeSessionId(ref), null, 'beyond the scan is out of reach');
    });
  });
});
