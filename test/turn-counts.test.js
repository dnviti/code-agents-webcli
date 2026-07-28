const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const ChatStoreModule = require('../dist/server/chat/store.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

const ChatStore = ChatStoreModule.ChatStore || ChatStoreModule.default;

// What a turn is, and that every surface agrees about it (#86).
//
// The figure used to mean two different things at once: the statistics counted
// how many pieces an agent's answer arrived in, and the conversation counted the
// user messages a browser happened to be holding. Neither was a measurement of
// the work, and neither could be checked against the other — so this file checks
// them against each other on purpose.
//
// The settled definition, which every test here is an instance of: a turn is one
// user request and everything the agent did about it. A message delivered into
// the work already running belongs to that work; one that waited for it to
// finish is its own turn.

/** Drive a list of events through the accountant and collect what it filed. */
function account(events) {
  const closed = [];
  const accountant = new UsageAccountant((job) => closed.push(job));
  let seq = 0;
  for (const event of events) {
    seq += 1;
    accountant.observe({ ts: seq * 1000, seq, ...event });
  }
  return closed;
}

/** One prompt answered in `assistantMessages` pieces, with no figures reported. */
function promptAndAnswer(turnId, assistantMessages, extra = {}) {
  const events = [{ t: 'msg_start', id: `u-${turnId}`, role: 'user', turnId }];
  for (let i = 0; i < assistantMessages; i++) {
    events.push({ t: 'msg_start', id: `a-${turnId}-${i}`, role: 'assistant', turnId });
    events.push({ t: 'msg_end', msgId: `a-${turnId}-${i}` });
  }
  events.push({ t: 'turn_end', turnId, ...extra });
  return events;
}

describe('what counts as a turn', function () {
  it('counts one turn per request, whatever the agent chopped its answer into', function () {
    // The defect itself. An agent that separates its thinking from its answer
    // and one that says everything at once did the same amount of work, and the
    // figure the dashboard compares them by has to say so.
    const chatty = account([
      ...promptAndAnswer('t1', 6),
      ...promptAndAnswer('t2', 6),
      ...promptAndAnswer('t3', 6),
    ]);
    const terse = account([
      ...promptAndAnswer('t1', 1),
      ...promptAndAnswer('t2', 1),
      ...promptAndAnswer('t3', 1),
    ]);

    assert.strictEqual(chatty.length, 3);
    assert.strictEqual(terse.length, 3, 'the same work is the same number of turns');
  });

  it('leaves round trips unreported rather than inferring them from messages', function () {
    const [job] = account(promptAndAnswer('t1', 4));
    assert.strictEqual(job.modelTurns, null);
  });

  it('takes a runtime round-trip count where there is one, under its own name', function () {
    const [job] = account(promptAndAnswer('t1', 1, { modelTurns: 9 }));
    assert.strictEqual(job.modelTurns, 9, "claude's num_turns is no longer discarded");
  });

  it('folds a message delivered into the running turn back into that turn', function () {
    // A steer: the turn is cut short, the redirected work continues under the
    // same id, and the two halves are one turn — with the round trips of both.
    const closed = account([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' },
      { t: 'block_start', msgId: 'a1', index: 0, block: { kind: 'tool', toolId: 'x', name: 'Read' } },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'turn_end', turnId: 't1', modelTurns: 2 },
      // The redirect, carrying the turn it is steering.
      { t: 'msg_start', id: 'u2', role: 'user', turnId: 't1', steer: true },
      { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 't1' },
      { t: 'block_start', msgId: 'a2', index: 0, block: { kind: 'tool', toolId: 'y', name: 'Edit' } },
      { t: 'msg_end', msgId: 'a2' },
      { t: 'turn_end', turnId: 't1', modelTurns: 3 },
    ]);

    // Filed twice under one id — the second replaces the first in the store —
    // and the last filing is the whole turn.
    const last = closed[closed.length - 1];
    assert.ok(closed.every((job) => job.turnId === 't1'), 'a steer must not mint a new turn');
    assert.strictEqual(last.toolCalls, 2, 'the work of both halves is one turn’s work');
    assert.strictEqual(last.modelTurns, 5, 'and so are its round trips');
    assert.strictEqual(last.outcome, 'completed', 'being redirected is not how a turn ended');
  });

  it('counts a message that waited for its own turn as its own turn', function () {
    const closed = account([...promptAndAnswer('t1', 1), ...promptAndAnswer('t2', 1)]);
    assert.strictEqual(closed.length, 2);
    assert.deepStrictEqual(closed.map((job) => job.turnId), ['t1', 't2']);
  });

  it('files one turn when a runtime echoes the prompt back under its own id', function () {
    // codex and the ACP agents repeat the user's message with a turn id of
    // their own. It is the same request, so it is the same turn.
    const closed = account([
      { t: 'msg_start', id: 'ours', role: 'user', turnId: 'mine' },
      { t: 'msg_end', msgId: 'ours' },
      { t: 'msg_start', id: 'theirs', role: 'user', turnId: 'codex-1' },
      { t: 'msg_end', msgId: 'theirs' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'codex-1' },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'turn_end', turnId: 'codex-1' },
    ]);
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].turnId, 'mine', 'the id this app minted is the turn');
  });

  it('files nothing for a turn the agent never answered', function () {
    // `/clear` opens a turn before it is recognised as a command. Filing it
    // would put a blank row in the permanent history for every clear typed.
    assert.deepStrictEqual(
      account([
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_end', msgId: 'u' },
        { t: 'turn_end', turnId: 't1' },
      ]),
      [],
    );
  });
});

// ------------------------------------------- the shape a real adapter produces

describe('the turn ids a real conversation actually carries', function () {
  // Taken from the logs on disk rather than imagined. **No adapter reuses the
  // id this app minted**: the session stamps the user's message
  // `turn-<uuid>` and the runtime answers under a name of its own, with the ACP
  // agents and codex echoing the prompt back under that name first.
  //
  //   msg_start user      turn-2979e29d-...     <- the app
  //   msg_start user      omp-turn-1            <- the runtime echoing it back
  //   msg_start assistant omp-turn-1
  //   turn_end            omp-turn-1
  //
  // Checked against every conversation on the machine this was written on: in
  // 46 of 46, the agent's messages share no id with the request that caused
  // them. So a reading that groups on the id as it arrives splits every single
  // turn in two — the ask in one, the answer in another with no prompt to name
  // it by, which is exactly what the index showed.
  function realTurn(n, ask) {
    const runtimeId = `omp-turn-${n}`;
    return [
      { t: 'msg_start', id: `u${n}`, role: 'user', turnId: `turn-uuid-${n}` },
      { t: 'block_start', msgId: `u${n}`, index: 0, block: { kind: 'text', text: ask } },
      { t: 'msg_end', msgId: `u${n}` },
      { t: 'msg_start', id: `echo${n}`, role: 'user', turnId: runtimeId },
      { t: 'msg_end', msgId: `echo${n}` },
      { t: 'msg_start', id: `a${n}`, role: 'assistant', turnId: runtimeId },
      { t: 'block_start', msgId: `a${n}`, index: 0, block: { kind: 'text', text: 'on it' } },
      { t: 'msg_end', msgId: `a${n}` },
      { t: 'turn_end', turnId: runtimeId, stopReason: 'end_turn' },
    ];
  }

  /** The conversation as a browser holding all of it would show it. */
  function shown(events) {
    const state = createTranscript({});
    let seq = 0;
    for (const event of events) {
      seq += 1;
      applyChatEvent(state, { ts: seq * 1000, seq, ...event });
    }
    const turns = [];
    let open;
    for (const message of state.messages) {
      if (turns.length === 0 || message.turnId !== open) {
        turns.push([]);
        open = message.turnId;
      }
      turns[turns.length - 1].push(message);
    }
    return { turns, state };
  }

  it('shows one turn per request, not one for the ask and one for the answer', function () {
    const { turns } = shown([...realTurn(1, 'first ask'), ...realTurn(2, 'second ask')]);
    assert.strictEqual(turns.length, 2);
    assert.deepStrictEqual(
      turns.map((group) => group.map((message) => message.id)),
      [['u1', 'echo1', 'a1'], ['u2', 'echo2', 'a2']],
    );
  });

  it('ends the turn the app opened, not the name the runtime ends it by', function () {
    // The outcome was being stamped by comparing the runtime's own id against
    // messages filed under ours, which matched nothing at all.
    const { state } = shown(realTurn(1, 'first ask'));
    assert.deepStrictEqual(
      state.messages.map((message) => message.turnOutcome),
      ['done', 'done', 'done'],
    );
  });

  it('counts the same turns the accounting filed for it', function () {
    const events = [...realTurn(1, 'first ask'), ...realTurn(2, 'second ask')];
    assert.strictEqual(shown(events).turns.length, account(events).length);
  });
});

// --------------------------------------------------- the same work, two agents

describe('the same work through different agents', function () {
  // The comparison the dashboard exists to support. Three requests, answered
  // the way each runtime actually answers them: claude in several messages with
  // its own round-trip count, an ACP agent in one message with none and an echo
  // of the prompt in front of it.
  function claudeConversation() {
    const events = [];
    for (const turnId of ['c1', 'c2', 'c3']) {
      events.push(
        { t: 'msg_start', id: `u-${turnId}`, role: 'user', turnId },
        { t: 'msg_start', id: `think-${turnId}`, role: 'assistant', turnId },
        { t: 'msg_end', msgId: `think-${turnId}` },
        { t: 'msg_start', id: `say-${turnId}`, role: 'assistant', turnId },
        { t: 'msg_end', msgId: `say-${turnId}` },
        { t: 'turn_end', turnId, modelTurns: 4 },
      );
    }
    return events;
  }

  function acpConversation() {
    const events = [];
    for (const [i, turnId] of ['a1', 'a2', 'a3'].entries()) {
      events.push(
        { t: 'msg_start', id: `ours-${i}`, role: 'user', turnId: `mine-${i}` },
        { t: 'msg_end', msgId: `ours-${i}` },
        { t: 'msg_start', id: `echo-${i}`, role: 'user', turnId },
        { t: 'msg_end', msgId: `echo-${i}` },
        { t: 'msg_start', id: `say-${turnId}`, role: 'assistant', turnId },
        { t: 'msg_end', msgId: `say-${turnId}` },
        { t: 'turn_end', turnId },
      );
    }
    return events;
  }

  it('produces the same turn count from both', function () {
    assert.strictEqual(account(claudeConversation()).length, 3);
    assert.strictEqual(account(acpConversation()).length, 3);
  });

  it('reports round trips for the one that counts them and nothing for the other', function () {
    assert.deepStrictEqual(
      account(claudeConversation()).map((job) => job.modelTurns),
      [4, 4, 4],
    );
    assert.deepStrictEqual(
      account(acpConversation()).map((job) => job.modelTurns),
      [null, null, null],
      'a runtime that does not count is not a runtime that counted zero',
    );
  });
});

// -------------------------------------------------- the turn a steer joins

describe('a steer, driven through the real session', function () {
  function fakeAdapter() {
    return {
      runtime: 'claude',
      capabilities: { permissions: true, streaming: true, interrupt: true },
      alive: true,
      sent: [],
      async start() {},
      async send(turn) {
        this.sent.push(turn.text);
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {
        this.alive = false;
      },
    };
  }

  function session() {
    const events = [];
    const s = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store: {
          append: (_ref, batch) => events.push(...batch),
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
        },
        socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'turn-counts-')),
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'claude',
      },
    );
    s.adapter = fakeAdapter();
    s.state = 'idle';
    return { s, events };
  }

  const userStarts = (events) =>
    events.filter((e) => e.t === 'msg_start' && e.role === 'user');

  it('gives a promoted message the turn it was delivered into', async function () {
    const { s, events } = session();
    await s.send({ text: 'refactor the auth module' });
    await s.send({ text: 'no — the staging database' });

    const [waiting] = s.queuedTurns;
    await s.sendQueuedNow(waiting.id);

    const [first, steer] = userStarts(events);
    assert.strictEqual(steer.turnId, first.turnId, 'the steer joins the running turn');
    assert.strictEqual(steer.steer, true, 'and says so, since it cannot be worked out later');
  });

  it('gives a promoted message its own turn when nothing was running', async function () {
    const { s, events } = session();
    // Queued behind an adapter that is not ready, then promoted while idle:
    // there is no work to be delivered into, so it is a request of its own.
    s.adapter.readyForTurn = false;
    await s.send({ text: 'later' });
    s.adapter.readyForTurn = true;

    const [waiting] = s.queuedTurns;
    await s.sendQueuedNow(waiting.id);

    const starts = userStarts(events);
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].steer, undefined, 'nothing was running to steer');
  });
});

// ------------------------------------------------------------- the turn index

describe('the turn index of a recorded conversation', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-index-'));
    store = new ChatStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ref = { id: 's1', ownerUserId: 7 };

  function write(events) {
    store.append(ref, events.map((event, i) => ({ ts: (i + 1) * 1000, seq: i + 1, ...event })));
  }

  function conversation(count) {
    const events = [];
    for (let i = 1; i <= count; i++) {
      const turnId = `t${i}`;
      events.push(
        { t: 'msg_start', id: `u${i}`, role: 'user', turnId },
        { t: 'block_start', msgId: `u${i}`, index: 0, block: { kind: 'text', text: `ask ${i}\nmore` } },
        { t: 'msg_end', msgId: `u${i}` },
        { t: 'msg_start', id: `a${i}`, role: 'assistant', turnId },
        { t: 'block_start', msgId: `a${i}`, index: 0, block: { kind: 'text', text: `answer ${i}` } },
        { t: 'msg_end', msgId: `a${i}` },
        { t: 'turn_end', turnId, stopReason: 'end_turn' },
      );
    }
    return events;
  }

  it('lists every turn from the first, however long the conversation', async function () {
    write(conversation(120));
    const index = await store.turnIndex(ref);

    assert.strictEqual(index.turns.length, 120, 'an index that starts late is not an index');
    assert.strictEqual(index.turns[0].index, 1);
    assert.strictEqual(index.turns[0].label, 'ask 1');
    assert.strictEqual(index.turns[119].index, 120);
    assert.strictEqual(index.complete, true);
  });

  it('titles every entry with what the user asked, never with the answer', async function () {
    write(conversation(3));
    const index = await store.turnIndex(ref);
    assert.deepStrictEqual(
      index.turns.map((turn) => turn.label),
      ['ask 1', 'ask 2', 'ask 3'],
    );
  });

  it('says a turn had no prompt rather than borrowing the model’s words', async function () {
    write([
      { t: 'msg_start', id: 'a0', role: 'assistant', turnId: 'resumed' },
      { t: 'block_start', msgId: 'a0', index: 0, block: { kind: 'text', text: 'picking up where we left off' } },
      { t: 'msg_end', msgId: 'a0' },
      { t: 'turn_end', turnId: 'resumed', stopReason: 'end_turn' },
      ...conversation(1).map((event) => event),
    ]);
    const index = await store.turnIndex(ref);
    assert.strictEqual(index.turns[0].label, null, 'the model may not title a turn');
    assert.strictEqual(index.turns[1].label, 'ask 1');
  });

  it('counts a steer into the turn it joined rather than as another entry', async function () {
    write([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
      { t: 'block_start', msgId: 'u1', index: 0, block: { kind: 'text', text: 'refactor auth' } },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'msg_start', id: 'u2', role: 'user', turnId: 't1', steer: true },
      { t: 'block_start', msgId: 'u2', index: 0, block: { kind: 'text', text: 'no, staging' } },
      { t: 'msg_end', msgId: 'u2' },
      { t: 'turn_end', turnId: 't1', stopReason: 'end_turn' },
    ]);
    const index = await store.turnIndex(ref);
    assert.strictEqual(index.turns.length, 1);
    assert.strictEqual(index.turns[0].label, 'refactor auth', 'the ask that opened it names it');
  });

  it('reads a real conversation as one turn per request', async function () {
    // The same shape as above, through the log rather than through the reducer.
    // This is what aligns conversations recorded before any of this existed:
    // the index is read from the log every time it is asked for, so nothing has
    // to be migrated — the events were always right, it was the reading of them
    // that split a request from its answer.
    write([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-uuid-1' },
      { t: 'block_start', msgId: 'u1', index: 0, block: { kind: 'text', text: 'the real ask' } },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'msg_start', id: 'echo1', role: 'user', turnId: 'omp-turn-1' },
      { t: 'msg_end', msgId: 'echo1' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'omp-turn-1' },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'turn_end', turnId: 'omp-turn-1', stopReason: 'end_turn' },
    ]);
    const index = await store.turnIndex(ref);
    assert.strictEqual(index.turns.length, 1, 'the ask and its answer are one turn');
    assert.strictEqual(index.turns[0].label, 'the real ask');
    assert.strictEqual(index.turns[0].turnId, 'turn-uuid-1', 'under the id this app opened');
    assert.strictEqual(index.turns[0].outcome, 'done', 'ended by the runtime’s own word for it');
  });

  it('starts again at a /clear rather than listing the conversation it replaced', async function () {
    // The log is append-only, so everything before the marker is still on disk
    // — and belongs to the conversation the user left. The transcript stops
    // paging back there, and the index has to start there too, or it would list
    // turns a browser can never be shown.
    write([
      ...conversation(3),
      { t: 'marker', kind: 'cleared', detail: 'started a new conversation' },
      ...conversation(2).map((event, i) => ({
        ...event,
        ...(event.t === 'msg_start' ? { id: `new-${event.id}` } : {}),
        ...(event.t === 'block_start' ? { msgId: `new-${event.msgId}` } : {}),
        ...(event.t === 'msg_end' ? { msgId: `new-${event.msgId}` } : {}),
        ...(event.t === 'turn_end' ? { turnId: `n${i}` } : {}),
      })),
    ]);
    const index = await store.turnIndex(ref);
    assert.strictEqual(index.turns.length, 2, 'only the conversation now on screen');
    assert.deepStrictEqual(index.turns.map((turn) => turn.index), [1, 2]);
    assert.strictEqual(index.complete, true, 'a cleared log starts at turn 1 by construction');
  });

  it('agrees with what the accounting recorded for the same conversation', async function () {
    // The acceptance criterion in one line: the two surfaces are built from the
    // same events by the same rule, so they cannot disagree about how many
    // turns happened.
    const events = conversation(7);
    write(events);
    const index = await store.turnIndex(ref);
    const filed = account(events.map(({ ts, seq, ...event }) => event));

    assert.strictEqual(index.turns.length, filed.length);
    assert.deepStrictEqual(
      index.turns.map((turn) => turn.turnId),
      filed.map((job) => job.turnId),
    );
  });
});
