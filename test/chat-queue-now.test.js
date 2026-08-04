const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

// Sending one waiting message now, driven through the real ChatSession.
//
// The thing under test is not "can a message jump the line" — it is everything
// that must survive it. Until this existed the only way to get in front of a
// working agent was the stop button, and stopping discards the whole queue, so
// correcting one thing cost you the two messages you had already lined up. So
// the assertions here are mostly about what is still standing afterwards: the
// rest of the line, in order; a transcript that says why the turn stopped; and
// nothing left on screen waiting for an answer that can no longer arrive.

/** Records what the adapter was actually asked to send, in order. */
function fakeAdapter() {
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
      // What a real runtime does about it: claude, grok, codex and the ACP
      // agents all answer an interrupt by ending the turn, a moment later and
      // on their own thread. A fake that stayed silent let the promoted
      // message be delivered into a turn nothing had closed — a shape none of
      // them produces, and the one the session now waits to avoid.
      this.emit?.({ t: 'turn_end', turnId: 'cut-short', stopReason: 'interrupted' });
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
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'queue-now-')),
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => 'claude',
    },
  );
  const adapter = fakeAdapter();
  // The channel a real adapter is built with; these tests hand the session an
  // adapter directly, so it is wired here instead.
  adapter.emit = (event) => s.ingest(event);
  s.adapter = adapter;
  s.state = 'idle';
  return { s, store, broadcasts, adapter };
}

/** The queue as the last broadcast reported it — what a second browser sees. */
function lastQueue(broadcasts) {
  const queue = broadcasts.filter((m) => m.type === 'chat_queue');
  return queue.length ? queue[queue.length - 1].queued : null;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const markers = (store) => store.events.filter((e) => e.t === 'marker');

describe('sending a queued message now', function () {
  it('delivers the chosen message ahead of the turn in flight', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'stop, wrong file' });

    const [waiting] = s.queuedTurns;
    assert.strictEqual(await s.sendQueuedNow(waiting.id), true);

    assert.strictEqual(adapter.interrupts, 1, 'the turn in flight has to be cut short');
    assert.deepStrictEqual(
      adapter.sent,
      ['refactor the auth module', 'stop, wrong file'],
      'the promoted message reaches the runtime as a real turn',
    );
    assert.strictEqual(s.currentState, 'thinking', 'the agent is working on it, not idle');
  });

  it('preserves a built-in workflow when its queued turn is promoted', async function () {
    const { s, adapter, store } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'write up the regression', workflow: 'gh-issue' });

    assert.strictEqual(await s.sendQueuedNow(s.queuedTurns[0].id), true);
    assert.match(adapter.sent[1], /\[BEGIN APP-OWNED GH-ISSUE WORKFLOW\]/);
    assert.match(adapter.sent[1], /write up the regression/);
    const prompts = store.events.filter((event) => event.t === 'msg_start' && event.role === 'user');
    assert.strictEqual(prompts[1].workflow, 'gh-issue');
  });

  it('leaves the rest of the line waiting, in the order it was typed', async function () {
    const { s, adapter, broadcasts } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });
    await s.send({ text: 'urgent' });
    await s.send({ text: 'b' });

    const urgent = s.queuedTurns.find((t) => t.text === 'urgent');
    await s.sendQueuedNow(urgent.id);

    assert.deepStrictEqual(
      s.queuedTurns.map((t) => t.text),
      ['a', 'b'],
      'correcting one thing must not cost the two messages already lined up',
    );
    assert.deepStrictEqual((lastQueue(broadcasts) || []).map((t) => t.text), ['a', 'b']);

    // And they are still delivered afterwards, in their original order.
    s.ingest({ t: 'turn_end', turnId: 't2' });
    await settle();
    s.ingest({ t: 'turn_end', turnId: 't3' });
    await settle();
    assert.deepStrictEqual(adapter.sent, ['first', 'urgent', 'a', 'b']);
  });

  it('records that the turn was cut short, and by which message', async function () {
    const { s, store } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'no — use the staging database' });

    const [waiting] = s.queuedTurns;
    await s.sendQueuedNow(waiting.id);

    const [marker] = markers(store);
    assert.ok(marker, 'a turn that stopped for a reason has to say so in the transcript');
    assert.strictEqual(marker.kind, 'interrupted');
    assert.match(marker.detail, /use the staging database/, 'the marker names the message that did it');

    // And it lands before the promoted turn, not after it.
    const order = store.events.filter((e) => e.t === 'marker' || (e.t === 'msg_start' && e.role === 'user'));
    assert.deepStrictEqual(order.map((e) => e.t), ['msg_start', 'marker', 'msg_start']);
  });

  it('shortens a long message on the marker rather than pasting the whole thing', async function () {
    const { s, store } = session();
    await s.send({ text: 'first' });
    await s.send({ text: `stop ${'x'.repeat(400)}` });

    await s.sendQueuedNow(s.queuedTurns[0].id);

    const [marker] = markers(store);
    assert.ok(marker.detail.length < 80, `a marker is a line, not a copy: ${marker.detail.length}`);
    assert.match(marker.detail, /^“stop /);
  });

  it('clears an approval left on screen by the turn it cut short', async function () {
    const { s, store } = session();
    await s.send({ text: 'delete the old migrations' });
    s.ingest({
      t: 'permission',
      request: {
        requestId: 'p1',
        toolName: 'Bash',
        summary: 'rm -rf migrations',
        options: [{ optionId: 'allow_once', label: 'Allow' }],
      },
    });
    await s.send({ text: 'no, stop' });

    await s.sendQueuedNow(s.queuedTurns[0].id);

    assert.ok(
      store.events.some((e) => e.t === 'permission_resolved' && e.requestId === 'p1' && e.allowed === false),
      'a card whose turn no longer exists must not be left waiting for an answer',
    );
    const snapshot = await s.snapshot();
    assert.deepStrictEqual(snapshot.pendingPermissions, []);
  });

  it('clears a question left on screen by the turn it cut short', async function () {
    const { s, store } = session();
    await s.send({ text: 'pick a database' });
    let answered = null;
    s.questions.set('q1', {
      request: { requestId: 'q1', toolId: 'tool-1', question: 'which one?', options: [] },
      resolve: (value) => { answered = value; },
    });
    await s.send({ text: 'neither — use the one in the config' });

    await s.sendQueuedNow(s.queuedTurns[0].id);

    assert.ok(answered, 'the model is blocked until something comes back, even a refusal');
    assert.strictEqual(s.questions.size, 0);
    // Abandoned, not skipped. Cutting a turn short is something the *user* did
    // to the turn; skipping is something they did to the question, and the card
    // drew the second sentence over the first (#174).
    const resolved = store.events.find((e) => e.t === 'question_resolved' && e.requestId === 'q1');
    assert.ok(resolved, 'the card is taken down');
    assert.strictEqual(resolved.abandoned, true);
    assert.ok(!resolved.skipped, 'nobody skipped this — they were never asked');
  });

  it('sends once when the control is pressed twice', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'urgent' });

    const [waiting] = s.queuedTurns;
    const [one, two] = await Promise.all([s.sendQueuedNow(waiting.id), s.sendQueuedNow(waiting.id)]);

    assert.strictEqual(one, true);
    assert.strictEqual(two, false, 'the second press has nothing left to promote');
    assert.deepStrictEqual(adapter.sent, ['first', 'urgent']);
    assert.strictEqual(adapter.interrupts, 1, 'and the turn is not interrupted twice');
  });

  it('does not strand the queue when a press lands too late', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });

    // The turn ends between the click and its arrival: `a` has already been
    // handed over, so its id is gone from the line.
    const [a] = s.queuedTurns;
    s.ingest({ t: 'turn_end', turnId: 't1' });
    await settle();

    assert.strictEqual(await s.sendQueuedNow(a.id), false);
    assert.deepStrictEqual(adapter.sent, ['first', 'a'], 'and it is certainly not sent twice');
  });

  it('refuses on a session that is no longer running, and keeps the line intact', async function () {
    const { s, adapter } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'urgent' });
    const [waiting] = s.queuedTurns;

    adapter.alive = false;

    assert.strictEqual(await s.sendQueuedNow(waiting.id), false);
    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['urgent'], 'a refusal must not eat the message');
    assert.strictEqual(adapter.interrupts, 0);
  });

  it('does not interrupt an idle agent that is already working through the line', async function () {
    const { s, adapter, store } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });
    await s.send({ text: 'b' });
    // Idle with two still waiting — the state the drain runs in.
    s.state = 'idle';

    const b = s.queuedTurns.find((t) => t.text === 'b');
    assert.strictEqual(await s.sendQueuedNow(b.id), true);

    assert.strictEqual(adapter.interrupts, 0, 'there is nothing in flight to cut short');
    assert.strictEqual(markers(store).length, 0, 'and nothing to explain in the transcript');
    assert.deepStrictEqual(adapter.sent, ['first', 'b']);
    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['a']);
  });

  it('refuses on a runtime that cannot be interrupted, rather than sending two turns at once', async function () {
    // `CodexExecAdapter` is exactly this: one turn per process, no interrupt.
    // Cutting in would not end the turn in flight — it would hand the runtime a
    // second one, which is the thing the queue exists to prevent.
    const { s, adapter } = session();
    adapter.capabilities = { ...adapter.capabilities, interrupt: false };
    await s.send({ text: 'first' });
    await s.send({ text: 'urgent' });

    const [waiting] = s.queuedTurns;
    assert.strictEqual(await s.sendQueuedNow(waiting.id), false);
    assert.deepStrictEqual(adapter.sent, ['first']);
    assert.deepStrictEqual(s.queuedTurns.map((t) => t.text), ['urgent'], 'and the message stays in line');
  });

  it('still promotes on such a runtime when there is nothing in flight', async function () {
    const { s, adapter } = session();
    adapter.capabilities = { ...adapter.capabilities, interrupt: false };
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });
    await s.send({ text: 'b' });
    s.state = 'idle';

    const b = s.queuedTurns.find((t) => t.text === 'b');
    assert.strictEqual(await s.sendQueuedNow(b.id), true);
    assert.deepStrictEqual(adapter.sent, ['first', 'b']);
  });

  it('carries the attachments of the message it promotes', async function () {
    const { s } = session();
    const attachment = { url: '/a', mime: 'image/png', name: 'wrong.png', size: 12 };
    const sentTurns = [];
    s.adapter.send = async function (turn) {
      sentTurns.push(turn);
      this.sent.push(turn.text);
    };
    await s.send({ text: 'first' });
    await s.send({ text: 'this screenshot', attachments: [attachment] });

    await s.sendQueuedNow(s.queuedTurns[0].id);

    assert.deepStrictEqual(sentTurns[1].attachments, [attachment]);
  });

  it('stops the stop button from silently gaining a new meaning', async function () {
    // The whole feature exists because interrupting discards the queue. That
    // has to stay true — this promotes *instead of* stopping, it does not
    // change what stopping does.
    const { s } = session();
    await s.send({ text: 'first' });
    await s.send({ text: 'a' });
    await s.interrupt();
    assert.strictEqual(s.queuedTurns.length, 0);
  });
});

describe('the interruption marker in the transcript', function () {
  it('draws a line across the conversation rather than emptying it', function () {
    const state = createTranscript({});
    applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'u1', role: 'user', turnId: 't1' });
    applyChatEvent(state, { t: 'block_start', seq: 2, ts: 1, msgId: 'u1', index: 0, block: { kind: 'text', text: 'go' } });
    applyChatEvent(state, { t: 'msg_end', seq: 3, ts: 1, msgId: 'u1' });

    applyChatEvent(state, { t: 'marker', seq: 4, ts: 2, kind: 'interrupted', detail: '“no, stop”' });

    assert.strictEqual(state.messages.length, 2, 'the conversation above the line is still there');
    const marker = state.messages[1];
    assert.strictEqual(marker.role, 'system');
    assert.deepStrictEqual(marker.blocks, [{
      kind: 'notice',
      notice: 'interrupted',
      text: 'Interrupted to send',
      detail: '“no, stop”',
    }]);
  });

  it('leaves compaction alone', function () {
    const state = createTranscript({});
    applyChatEvent(state, { t: 'marker', seq: 1, ts: 1, kind: 'compacted', detail: '42k summarised' });
    assert.strictEqual(state.messages[0].blocks[0].notice, 'compacted');
    assert.strictEqual(state.messages[0].blocks[0].text, 'Context compacted');
  });

  it('survives a reopen, because it is a message like any other', function () {
    const state = createTranscript({});
    applyChatEvent(state, { t: 'marker', seq: 1, ts: 1, kind: 'interrupted', detail: '“no, stop”' });
    const rebuilt = createTranscript({});
    // What `hydrate` does with a snapshot: the messages are the record.
    rebuilt.messages = JSON.parse(JSON.stringify(state.messages));
    assert.strictEqual(rebuilt.messages[0].blocks[0].notice, 'interrupted');
  });
});
