const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatStore } = require('../dist/server/chat/store.js');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Build `count` minimal, contiguous events starting at `startSeq`. */
function makeEvents(startSeq, count, ts = 0) {
  const events = [];
  for (let i = 0; i < count; i++) {
    events.push({ t: 'state', seq: startSeq + i, ts: ts + i, state: 'idle' });
  }
  return events;
}

describe('ChatStore', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-chat-'));
    store = new ChatStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('append + read', function () {
    it('round-trips a recorded event sequence exactly', async function () {
      const events = loadFixture('store-events.jsonl');
      store.append({ id: 's1', ownerUserId: 1 }, events);

      const page = await store.read({ id: 's1', ownerUserId: 1 }, 1, 100);
      assert.strictEqual(page.firstSeq, 1);
      assert.strictEqual(page.cursor, 13);
      assert.deepStrictEqual(page.events, events);
    });

    it('pages a session in slices without dropping or duplicating events', async function () {
      const events = loadFixture('store-events.jsonl');
      store.append({ id: 's1', ownerUserId: 1 }, events);

      const collected = [];
      let from = 1;
      for (;;) {
        const page = await store.read({ id: 's1', ownerUserId: 1 }, from, 4);
        if (page.events.length === 0) break;
        collected.push(...page.events);
        from = page.events[page.events.length - 1].seq + 1;
      }

      assert.deepStrictEqual(collected, events);
    });

    it('serves a page starting mid-log', async function () {
      const events = loadFixture('store-events.jsonl');
      store.append({ id: 's1', ownerUserId: 1 }, events);

      const page = await store.read({ id: 's1', ownerUserId: 1 }, 6, 3);
      assert.deepStrictEqual(
        page.events.map((e) => e.seq),
        [6, 7, 8],
      );
    });

    it('splits one append() call across several enqueued writes without interleaving', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 5));
      store.append(session, makeEvents(6, 5));
      store.append(session, makeEvents(11, 5));

      const page = await store.read(session, 1, 100);
      assert.deepStrictEqual(
        page.events.map((e) => e.seq),
        Array.from({ length: 15 }, (_, i) => i + 1),
      );
    });

    it('reports an empty page rather than throwing for a session that was never written', async function () {
      const page = await store.read({ id: 'never-seen', ownerUserId: 1 }, 1, 10);
      assert.deepStrictEqual(page.events, []);
      assert.strictEqual(page.firstSeq, 1);
      assert.strictEqual(page.cursor, 0);
    });

    it('clamps a page to maxPageEvents', async function () {
      const capped = new ChatStore({ storageDir: dir, maxPageEvents: 3 });
      const session = { id: 's1', ownerUserId: 1 };
      capped.append(session, makeEvents(1, 10));

      const page = await capped.read(session, 1, 100);
      assert.strictEqual(page.events.length, 3);
    });

    it('rejects a batch whose seq does not continue the log, without corrupting it', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 3));
      // Skips seq 4 - a caller bug the position math cannot tolerate silently.
      store.append(session, makeEvents(5, 2));

      await new Promise((resolve) => setTimeout(resolve, 50));

      const page = await store.read(session, 1, 100);
      assert.deepStrictEqual(
        page.events.map((e) => e.seq),
        [1, 2, 3],
      );
    });
  });

  describe('trimming', function () {
    it('moves firstSeq forward without renumbering what remains', async function () {
      const trimmed = new ChatStore({ storageDir: dir, maxEvents: 10, trimChunkEvents: 5 });
      const session = { id: 's1', ownerUserId: 1 };
      trimmed.append(session, makeEvents(1, 16));

      const stats = await trimmed.stat(session);
      assert.strictEqual(stats.firstSeq, 6);
      assert.strictEqual(stats.cursor, 16);

      const page = await trimmed.read(session, 1, 100);
      // The trimmed events are simply gone; the read starts from what remains
      // rather than renumbering it down to 1.
      assert.strictEqual(page.events[0].seq, 6);
      assert.strictEqual(page.events[page.events.length - 1].seq, 16);
      assert.strictEqual(page.events.length, 11);
    });

    it('keeps the numbers of the turns that survive, so nothing renumbers to 1', async function () {
      // Past the retention cap the head goes, and with it the turns that were
      // there. The ones left are still the fourth and fifth thing the user
      // asked, and the index, the header's count and the spend record all have
      // to say so — reading the number off a row's position in what survives is
      // what made the three disagree (#86).
      const trimmed = new ChatStore({ storageDir: dir, maxEvents: 12, trimChunkEvents: 6 });
      const session = { id: 'trimmed-turns', ownerUserId: 1 };
      let seq = 1;
      const ask = (turnId) => [
        { t: 'msg_start', seq: seq++, ts: 1, id: `u-${turnId}`, role: 'user', turnId },
        { t: 'msg_end', seq: seq++, ts: 1, msgId: `u-${turnId}` },
        { t: 'turn_end', seq: seq++, ts: 1, turnId, stopReason: 'end_turn' },
      ];
      trimmed.append(session, [...ask('one'), ...ask('two'), ...ask('three')]);
      await trimmed.stat(session);
      const before = await trimmed.turnIndex(session);
      assert.deepStrictEqual(before.turns.map((turn) => turn.index), [1, 2, 3]);

      trimmed.append(session, [...ask('four'), ...ask('five')]);
      const after = await trimmed.turnIndex(session);

      assert.deepStrictEqual(
        after.turns.map((turn) => turn.turnId),
        ['three', 'four', 'five'],
        'the trim did not drop what this test is about',
      );
      assert.deepStrictEqual(after.turns.map((turn) => turn.index), [3, 4, 5]);
      assert.strictEqual(after.complete, false, 'and it says the older ones are gone');
    });

    it('lets a client tell it fell off the back', async function () {
      const trimmed = new ChatStore({ storageDir: dir, maxEvents: 10, trimChunkEvents: 5 });
      const session = { id: 's1', ownerUserId: 1 };
      trimmed.append(session, makeEvents(1, 16));

      const page = await trimmed.read(session, 1, 5);
      assert.strictEqual(page.firstSeq, 6, 'a client asking from seq 1 learns the true floor is 6');
      assert.strictEqual(page.events[0].seq, 6);
    });

    it('pins an unresolved question across retention for warm and cold snapshots', async function () {
      const options = { storageDir: dir, maxEvents: 4, trimChunkEvents: 3 };
      const trimmed = new ChatStore(options);
      const session = { id: 'pinned-question', ownerUserId: 1 };
      const request = {
        requestId: 'question-1',
        origin: 'structured_handoff',
        question: 'Keep waiting?',
        multiSelect: false,
        options: [{ optionId: 'yes', label: 'Yes' }],
        ts: 1,
      };

      await trimmed.append(session, [{ t: 'question', seq: 1, ts: 1, request }]);
      // Populate the store's full-log cache before retention runs, so the same
      // assertion covers both the warm cache and reconstruction after restart.
      assert.deepStrictEqual(
        (await trimmed.snapshot(session)).pendingQuestions.map((entry) => entry.requestId),
        [request.requestId],
      );
      await trimmed.append(session, makeEvents(2, 7, 2));

      assert.strictEqual((await trimmed.stat(session)).firstSeq, 1, 'the live request pins its record');
      assert.deepStrictEqual(
        (await trimmed.snapshot(session)).pendingQuestions.map((entry) => entry.requestId),
        [request.requestId],
      );
      assert.deepStrictEqual(
        (await new ChatStore(options).snapshot(session)).pendingQuestions.map((entry) => entry.requestId),
        [request.requestId],
        'a restart reconstructs the request from the retained record',
      );

      await trimmed.append(session, [{
        t: 'question_resolved',
        seq: 9,
        ts: 9,
        requestId: request.requestId,
        optionIds: [],
        abandoned: true,
      }]);

      assert.ok((await trimmed.stat(session)).firstSeq > 1, 'the terminal resolution releases the pin');
      assert.deepStrictEqual((await trimmed.snapshot(session)).pendingQuestions, []);
      assert.deepStrictEqual((await new ChatStore(options).snapshot(session)).pendingQuestions, []);
    });

    it('pins an undelivered continuation across retention until its terminal record', async function () {
      const options = { storageDir: dir, maxEvents: 4, trimChunkEvents: 3 };
      const trimmed = new ChatStore(options);
      const session = { id: 'pinned-continuation', ownerUserId: 1 };
      const request = {
        requestId: 'question-1',
        origin: 'structured_handoff',
        question: 'Continue?',
        multiSelect: false,
        options: [{ optionId: 'yes', label: 'Yes' }],
        ts: 1,
      };
      const continuation = {
        continuationId: 'continuation-1',
        request,
        answer: { optionIds: ['yes'], labels: ['Yes'] },
      };

      await trimmed.append(session, [
        { t: 'question', seq: 1, ts: 1, request },
        {
          t: 'question_resolved',
          seq: 2,
          ts: 2,
          requestId: request.requestId,
          optionIds: ['yes'],
          continuation,
        },
      ]);
      assert.deepStrictEqual(
        (await trimmed.snapshot(session)).pendingQuestionContinuations.map(
          (entry) => entry.continuationId,
        ),
        [continuation.continuationId],
      );
      await trimmed.append(session, makeEvents(3, 6, 3));

      assert.strictEqual((await trimmed.stat(session)).firstSeq, 2, 'the outbox record becomes the floor');
      assert.deepStrictEqual(
        (await trimmed.snapshot(session)).pendingQuestionContinuations.map(
          (entry) => entry.continuationId,
        ),
        [continuation.continuationId],
      );
      assert.deepStrictEqual(
        (await new ChatStore(options).snapshot(session)).pendingQuestionContinuations.map(
          (entry) => entry.continuationId,
        ),
        [continuation.continuationId],
        'a restart reconstructs the undelivered answer from the retained record',
      );

      await trimmed.append(session, [{
        t: 'question_continuation',
        seq: 9,
        ts: 9,
        requestId: request.requestId,
        continuationId: continuation.continuationId,
        outcome: 'delivered',
      }]);

      assert.ok((await trimmed.stat(session)).firstSeq > 2, 'delivery releases the outbox pin');
      assert.deepStrictEqual((await trimmed.snapshot(session)).pendingQuestionContinuations, []);
      assert.deepStrictEqual(
        (await new ChatStore(options).snapshot(session)).pendingQuestionContinuations,
        [],
      );
    });

    it('rebuilds a stale index when retention swaps the log but its index rename fails', async function () {
      const options = { storageDir: dir, maxEvents: 4, trimChunkEvents: 3 };
      const trimmed = new ChatStore(options);
      const session = { id: 'trim-swap-repair', ownerUserId: 1 };
      const request = {
        requestId: 'question-1', origin: 'structured_handoff', question: 'Continue?',
        multiSelect: false, options: [{ optionId: 'yes', label: 'Yes' }], ts: 1,
      };
      const continuation = {
        continuationId: 'continuation-1', request,
        answer: { optionIds: ['yes'], labels: ['Yes'] },
      };
      await trimmed.append(session, [
        { t: 'question', seq: 1, ts: 1, request },
        {
          t: 'question_resolved', seq: 2, ts: 2, requestId: request.requestId,
          optionIds: ['yes'], continuation,
        },
        ...makeEvents(3, 6, 3),
      ]);

      const base = path.join(dir, '1', session.id);
      const originalRename = fs.promises.rename;
      const originalOpen = fs.promises.open;
      let injected = false;
      let verificationFailed = false;
      fs.promises.rename = async function (from, to) {
        if (
          !injected
          && String(from) === `${base}.idx.tmp`
          && String(to) === `${base}.idx`
        ) {
          injected = true;
          throw new Error('injected retention index rename failure');
        }
        return originalRename.call(fs.promises, from, to);
      };
      fs.promises.open = async function (file, ...args) {
        if (injected && !verificationFailed && String(file) === `${base}.jsonl`) {
          verificationFailed = true;
          throw new Error('injected post-retention suffix verification failure');
        }
        return originalOpen.call(fs.promises, file, ...args);
      };
      try {
        await assert.doesNotReject(() => trimmed.append(session, [{
          t: 'question_continuation', seq: 9, ts: 9,
          requestId: request.requestId,
          continuationId: continuation.continuationId,
          outcome: 'delivered',
        }]));
      } finally {
        fs.promises.rename = originalRename;
        fs.promises.open = originalOpen;
      }
      assert.strictEqual(injected, true);
      assert.strictEqual(verificationFailed, true);

      const cold = new ChatStore(options);
      const stats = await cold.stat(session);
      const page = await cold.read(session, 1, 100);
      assert.ok(stats.firstSeq > 1, 'the shortened log must advertise its real floor');
      assert.strictEqual(stats.cursor, 9);
      assert.strictEqual(page.firstSeq, stats.firstSeq);
      assert.deepStrictEqual(
        page.events.map((event) => event.seq),
        Array.from({ length: 10 - stats.firstSeq }, (_, index) => stats.firstSeq + index),
      );
      assert.deepStrictEqual((await cold.snapshot(session)).pendingQuestionContinuations, []);
    });
  });

  describe('crash repair', function () {
    it('treats a complete log append as committed when the derived index append fails', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      await store.append(session, makeEvents(1, 3));

      const base = path.join(dir, '1', 's1');
      const idxSizeBefore = fs.statSync(`${base}.idx`).size;
      const originalAppendFile = fs.promises.appendFile;
      let injected = false;

      fs.promises.appendFile = async function (file, ...args) {
        if (!injected && String(file) === `${base}.idx`) {
          injected = true;
          throw new Error('injected index append failure');
        }
        return originalAppendFile.call(fs.promises, file, ...args);
      };

      try {
        await assert.doesNotReject(() => store.append(session, makeEvents(4, 2)));
      } finally {
        fs.promises.appendFile = originalAppendFile;
      }

      assert.strictEqual(injected, true, 'the index append failure must have been exercised');
      assert.strictEqual(
        fs.statSync(`${base}.idx`).size,
        idxSizeBefore,
        'the failed index append should leave recovery work to the next operation',
      );

      const page = await store.read(session, 1, 100);
      assert.deepStrictEqual(
        page.events.map((event) => event.seq),
        [1, 2, 3, 4, 5],
      );
      assert.ok(
        fs.statSync(`${base}.idx`).size > idxSizeBefore,
        'the next operation must rebuild index entries for the committed batch',
      );

      await store.append(session, makeEvents(6, 1));
      const after = await store.read(session, 1, 100);
      assert.deepStrictEqual(
        after.events.map((event) => event.seq),
        [1, 2, 3, 4, 5, 6],
      );
    });

    it('drops a torn index entry before rebuilding from the canonical log', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      await store.append(session, makeEvents(1, 3));
      const base = path.join(dir, '1', 's1');
      const completeSize = fs.statSync(`${base}.idx`).size;
      fs.appendFileSync(`${base}.idx`, Buffer.from([0xaa, 0xbb]));

      const cold = new ChatStore({ storageDir: dir });
      const page = await cold.read(session, 1, 100);
      assert.deepStrictEqual(page.events.map((event) => event.seq), [1, 2, 3]);
      assert.strictEqual(fs.statSync(`${base}.idx`).size, completeSize);
    });

    it('truncates a partial log batch so the exact same seq can be retried', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      await store.append(session, makeEvents(1, 3));
      const base = path.join(dir, '1', 's1');
      const originalAppendFile = fs.promises.appendFile;
      let injected = false;

      fs.promises.appendFile = async function (file, data, ...args) {
        if (!injected && String(file) === `${base}.jsonl`) {
          injected = true;
          const bytes = Buffer.from(String(data), 'utf8');
          await originalAppendFile.call(
            fs.promises,
            file,
            bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
          );
          throw new Error('injected partial log append');
        }
        return originalAppendFile.call(fs.promises, file, data, ...args);
      };

      try {
        await assert.rejects(() => store.append(session, makeEvents(4, 2)), /partial log append/);
      } finally {
        fs.promises.appendFile = originalAppendFile;
      }

      await store.append(session, makeEvents(4, 2));
      const page = await store.read(session, 1, 100);
      assert.deepStrictEqual(page.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
    });

    it('recovers events the log has but the index does not', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 3));
      await store.stat(session); // force the write to land before we tamper

      const base = path.join(dir, '1', 's1');
      const idxSizeBefore = fs.statSync(`${base}.idx`).size;

      // Simulate a crash between the log append and the index append: the
      // event landed in the .jsonl but never got an index entry.
      fs.appendFileSync(`${base}.jsonl`, `${JSON.stringify({ t: 'state', seq: 4, ts: 4, state: 'idle' })}\n`);

      const fresh = new ChatStore({ storageDir: dir });
      const page = await fresh.read(session, 1, 100);
      assert.deepStrictEqual(
        page.events.map((e) => e.seq),
        [1, 2, 3, 4],
      );
      assert.ok(fs.statSync(`${base}.idx`).size > idxSizeBefore, 'the index must have grown to cover it');
    });

    it('drops a torn trailing record instead of serving a line JSON.parse would choke on', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 3));
      await store.stat(session);

      const base = path.join(dir, '1', 's1');
      // No trailing newline: this record never finished writing.
      fs.appendFileSync(`${base}.jsonl`, JSON.stringify({ t: 'state', seq: 4, ts: 4, state: 'idle' }));

      const fresh = new ChatStore({ storageDir: dir });
      const page = await fresh.read(session, 1, 100);
      assert.deepStrictEqual(
        page.events.map((e) => e.seq),
        [1, 2, 3],
      );

      // The torn bytes are truncated away, so a subsequent append lands cleanly.
      fresh.append(session, makeEvents(4, 1));
      const after = await fresh.read(session, 1, 100);
      assert.deepStrictEqual(
        after.events.map((e) => e.seq),
        [1, 2, 3, 4],
      );
    });
  });

  describe('ownership isolation', function () {
    it('keeps two users with the same session id on separate logs', async function () {
      store.append({ id: 'shared-id', ownerUserId: 1 }, makeEvents(1, 2));
      store.append({ id: 'shared-id', ownerUserId: 2 }, makeEvents(1, 1));

      const a = await store.read({ id: 'shared-id', ownerUserId: 1 }, 1, 100);
      const b = await store.read({ id: 'shared-id', ownerUserId: 2 }, 1, 100);

      assert.strictEqual(a.events.length, 2);
      assert.strictEqual(b.events.length, 1);
    });

    it('lists sessions scoped to one owner only', async function () {
      store.append({ id: 'mine', ownerUserId: 1 }, makeEvents(1, 1));
      store.append({ id: 'theirs', ownerUserId: 2 }, makeEvents(1, 1));
      await store.stat({ id: 'mine', ownerUserId: 1 });
      await store.stat({ id: 'theirs', ownerUserId: 2 });

      const mine = await store.listSessions(1);
      assert.deepStrictEqual(mine, ['mine']);
    });
  });

  describe('path safety', function () {
    const hostile = ['../../../../tmp/pwned', '..', '.', 'a/b', '/etc/passwd', 'has spaces'];

    hostile.forEach(function (id) {
      it(`refuses the session id ${JSON.stringify(id)}`, async function () {
        await assert.rejects(() => store.stat({ id, ownerUserId: 1 }));
        await assert.rejects(() => store.read({ id, ownerUserId: 1 }, 1, 10));
        await assert.rejects(() => store.snapshot({ id, ownerUserId: 1 }));
      });
    });

    it('refuses a non-integer owner id', async function () {
      await assert.rejects(() => store.stat({ id: 'ok', ownerUserId: '../root' }));
      await assert.rejects(() => store.listSessions('../root'));
    });

    it('writes nothing outside the storage directory', async function () {
      store.append({ id: '../../escaped', ownerUserId: 1 }, makeEvents(1, 1));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const outside = path.join(path.dirname(dir), 'escaped.jsonl');
      assert.ok(!fs.existsSync(outside));
    });

    it('accepts the UUIDs the server actually generates', async function () {
      const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
      store.append({ id, ownerUserId: 12 }, makeEvents(1, 1));
      const page = await store.read({ id, ownerUserId: 12 }, 1, 5);
      assert.strictEqual(page.events.length, 1);
    });
  });

  describe('snapshot', function () {
    it('replays the log into a ChatSnapshot matching chat-reducer semantics', async function () {
      const events = loadFixture('store-events.jsonl');
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, events);

      const snapshot = await store.snapshot(session, { runtime: 'claude', live: true });
      assert.strictEqual(snapshot.sessionId, 's1');
      assert.strictEqual(snapshot.runtime, 'claude');
      assert.strictEqual(snapshot.live, true);
      assert.strictEqual(snapshot.messages.length, 2);
      assert.strictEqual(snapshot.messages[0].role, 'user');
      assert.strictEqual(snapshot.messages[1].role, 'assistant');
      assert.strictEqual(snapshot.cursor, 13);
      assert.strictEqual(snapshot.firstSeq, 1);
      assert.strictEqual(snapshot.capabilities.streaming, true);
      assert.strictEqual(snapshot.usage.inputTokens, 120);
      assert.strictEqual(snapshot.usage.outputTokens, 45);

      const tool = snapshot.messages[1].blocks.find((b) => b.kind === 'tool');
      assert.strictEqual(tool.status, 'completed');
      assert.strictEqual(tool.output, 'login bug fixed');
    });

    it('caps replay to the tail while still reporting the true firstSeq', async function () {
      const capped = new ChatStore({ storageDir: dir, snapshotReplayEvents: 3 });
      const session = { id: 's1', ownerUserId: 1 };
      capped.append(session, makeEvents(1, 20));

      const snapshot = await capped.snapshot(session);
      // firstSeq still reflects the full disk-retained range...
      assert.strictEqual(snapshot.firstSeq, 1);
      assert.strictEqual(snapshot.cursor, 20);
      // ...even though the replay itself only walked the last few events. A
      // 'state' fixture has no messages, so what proves the cap held is that
      // read() can still serve everything from firstSeq, independent of it.
      const earlier = await capped.read(session, 1, 5);
      assert.deepStrictEqual(
        earlier.events.map((e) => e.seq),
        [1, 2, 3, 4, 5],
      );
    });

    it('opens a long streaming conversation at a message boundary, not an event count', async function () {
      // The shape that broke it: one assistant turn whose token deltas fill the
      // whole tail window. Cutting at a fixed event count started the replay
      // inside that message, the reducer had nowhere to put the deltas, and a
      // 42,000-event transcript opened completely blank.
      const session = { id: 'long', ownerUserId: 1 };
      const events = [];
      let seq = 1;

      const message = (id, text, deltas) => {
        events.push({ t: 'msg_start', seq: seq++, ts: 1, id, role: 'assistant', turnId: 't' });
        events.push({ t: 'block_start', seq: seq++, ts: 1, msgId: id, index: 0, block: { kind: 'text', text: '' } });
        for (let i = 0; i < deltas; i++) {
          events.push({ t: 'block_delta', seq: seq++, ts: 1, msgId: id, index: 0, text });
        }
        events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: id });
      };

      for (let i = 0; i < 5; i++) message(`m${i}`, 'x', 20);
      // The last turn alone is longer than the replay chunk.
      message('final', 'y', 4000);

      store.append(session, events);
      const snapshot = await store.snapshot(session);

      assert.ok(snapshot.messages.length > 0, 'a long conversation must not open empty');
      const last = snapshot.messages[snapshot.messages.length - 1];
      assert.strictEqual(last.id, 'final');
      assert.strictEqual(last.blocks[0].text.length, 4000, 'the streamed message must be whole');
      // And the replay floor is reported honestly, so the client knows to page.
      assert.ok(snapshot.replayFrom >= snapshot.firstSeq);
      assert.ok(snapshot.replayFrom <= snapshot.cursor);
    });

    it('gives back the newest messages, capped, on a conversation of many turns', async function () {
      const capped = new ChatStore({ storageDir: dir, snapshotMinMessages: 4 });
      const session = { id: 'many', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      for (let i = 0; i < 30; i++) {
        events.push({ t: 'msg_start', seq: seq++, ts: 1, id: `m${i}`, role: 'assistant', turnId: 't' });
        events.push({ t: 'block_start', seq: seq++, ts: 1, msgId: `m${i}`, index: 0, block: { kind: 'text', text: String(i) } });
        events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: `m${i}` });
      }
      capped.append(session, events);

      const snapshot = await capped.snapshot(session);
      assert.strictEqual(snapshot.messages.length, 4);
      assert.deepStrictEqual(snapshot.messages.map((m) => m.id), ['m26', 'm27', 'm28', 'm29']);
      assert.ok(snapshot.replayFrom > snapshot.firstSeq, 'there is older history to page');
    });

    it('files a half-loaded turn under the turn it belongs to, not the runtime’s name for it', async function () {
      // The conversation on screen when this was reported: one long turn, the
      // window cut past the question that opened it, and the index showing a
      // row reading "no prompt" — spinning — beside the finished turn it was
      // actually part of. The messages had been filed under the runtime's own
      // id for the turn, which is an id the recorded index has never heard of,
      // so nothing downstream could repair the label either.
      const capped = new ChatStore({ storageDir: dir, snapshotMinMessages: 3 });
      const session = { id: 'midturn', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'ask', role: 'user', turnId: 'turn-app' });
      events.push({
        t: 'block_start', seq: seq++, ts: 1, msgId: 'ask', index: 0,
        block: { kind: 'text', text: 'why is the cost reset?' },
      });
      events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: 'ask' });
      // The agent answers over many messages, under a name of its own — which
      // is what every adapter here actually does.
      for (let i = 0; i < 10; i++) {
        events.push({ t: 'msg_start', seq: seq++, ts: 1, id: `a${i}`, role: 'assistant', turnId: 'claude-run-1' });
        events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: `a${i}` });
      }
      capped.append(session, events);

      const snapshot = await capped.snapshot(session);
      assert.ok(snapshot.messages.length < 11, 'the window has to have cut the question');
      assert.ok(
        snapshot.messages.every((m) => m.turnId === 'turn-app'),
        `a windowed replay must resume the open turn, got ${JSON.stringify(
          snapshot.messages.map((m) => m.turnId),
        )}`,
      );
      // And it says what is still open, so the next event to arrive live joins
      // that turn instead of opening one nobody asked anything in.
      assert.strictEqual(snapshot.currentTurnId, 'turn-app');
    });

    it('does not turn an interruption line carried from further back into a turn', async function () {
      // Markers are not cut at the message boundary — a compaction or an
      // interruption is the reason the conversation reads as it does, so the
      // window carries them however old they are. But they *are* messages, and
      // replayed with no turn open one becomes a turn of its own: a second row
      // in the index, numbered 1 again, for a line the turn above it already
      // covers.
      const capped = new ChatStore({ storageDir: dir, snapshotMinMessages: 2 });
      const session = { id: 'marked', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'ask', role: 'user', turnId: 'turn-app' });
      events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: 'ask' });
      events.push({ t: 'marker', seq: seq++, ts: 1, kind: 'interrupted', detail: 'stop' });
      for (let i = 0; i < 6; i++) {
        events.push({ t: 'msg_start', seq: seq++, ts: 1, id: `a${i}`, role: 'assistant', turnId: 'claude-run-1' });
        events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: `a${i}` });
      }
      capped.append(session, events);

      const snapshot = await capped.snapshot(session);
      const marker = snapshot.messages.find((m) => m.role === 'system');
      assert.ok(marker, 'the line has to survive the window');
      assert.strictEqual(marker.turnId, 'turn-app', 'and belongs to the turn it was drawn in');
    });

    it('reads work an old log stranded back into the turn it came from', async function () {
      // History: promoting a message past the queue used to file it into the
      // turn it interrupted, which that interrupt then ended — leaving the
      // question in a finished turn and the work in one with no prompt at all.
      // Nothing opened that second turn, so under the settled rule there is no
      // second turn: the work goes back where it came from, and the row is
      // titled by the request that started all of it.
      const session = { id: 'steered', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'ask', role: 'user', turnId: 'turn-app' });
      events.push({
        t: 'block_start', seq: seq++, ts: 1, msgId: 'ask', index: 0,
        block: { kind: 'text', text: 'refactor the auth module' },
      });
      events.push({ t: 'marker', seq: seq++, ts: 1, kind: 'interrupted', detail: 'no —' });
      events.push({
        t: 'msg_start', seq: seq++, ts: 1, id: 'steer', role: 'user',
        turnId: 'turn-app', steer: true,
      });
      events.push({
        t: 'block_start', seq: seq++, ts: 1, msgId: 'steer', index: 0,
        block: { kind: 'text', text: 'no — the staging database' },
      });
      events.push({ t: 'turn_end', seq: seq++, ts: 1, turnId: 'claude-run-1', stopReason: 'end_turn' });
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'a1', role: 'assistant', turnId: 'claude-run-2' });
      store.append(session, events);

      const index = await store.turnIndex(session);
      assert.deepStrictEqual(
        index.turns.map((t) => t.label),
        ['refactor the auth module'],
      );
    });

    it('does not carry a turn across a /clear', async function () {
      // An agent speaking with nothing asked of it carries on in the turn it
      // was working on — but `/clear` is a new conversation in the same tab,
      // and the turns above it belong to the one the user walked away from.
      const session = { id: 'cleared', ownerUserId: 1 };
      let seq = 1;
      store.append(session, [
        { t: 'msg_start', seq: seq++, ts: 1, id: 'u1', role: 'user', turnId: 'turn-old' },
        { t: 'msg_end', seq: seq++, ts: 1, msgId: 'u1' },
        { t: 'turn_end', seq: seq++, ts: 1, turnId: 'run-1', stopReason: 'end_turn' },
        { t: 'marker', seq: seq++, ts: 1, kind: 'cleared', detail: 'started a new conversation' },
        { t: 'msg_start', seq: seq++, ts: 1, id: 'a1', role: 'assistant', turnId: 'run-2' },
      ]);

      const index = await store.turnIndex(session);
      assert.deepStrictEqual(index.turns.map((t) => t.turnId), ['run-2']);
      const snapshot = await store.snapshot(session);
      assert.deepStrictEqual(snapshot.messages.map((m) => m.turnId), ['run-2']);
    });

    it('says which turn a page of history starts inside', async function () {
      const session = { id: 'paged', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'ask', role: 'user', turnId: 'turn-app' });
      events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: 'ask' });
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'a1', role: 'assistant', turnId: 'claude-run-1' });
      events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: 'a1' });
      events.push({ t: 'turn_end', seq: seq++, ts: 1, turnId: 'claude-run-1', stopReason: 'end_turn' });
      events.push({ t: 'msg_start', seq: seq++, ts: 1, id: 'ask2', role: 'user', turnId: 'turn-app-2' });
      store.append(session, events);

      // Scrolled back to the middle of the first turn: the browser replays this
      // slice through the reducer, and without the turn it starts inside every
      // message in it is filed under the runtime's id.
      const inside = await store.read(session, 3, 2);
      assert.strictEqual(inside.openTurnId, 'turn-app');

      // And a page starting between two turns says so rather than guessing.
      const between = await store.read(session, 6, 1);
      assert.strictEqual(between.openTurnId, null);
    });

    it('reports what the whole conversation cost, not what the replayed tail cost', async function () {
      // The bug: session usage was folded out of the replay window, so a chat
      // long enough to be capped came back with a smaller cost every time the
      // browser reconnected, switched tab or reloaded — while the user had
      // never left the conversation.
      const capped = new ChatStore({ storageDir: dir, snapshotMinMessages: 4 });
      const session = { id: 'spend', ownerUserId: 1 };
      const events = [];
      let seq = 1;
      for (let i = 0; i < 30; i++) {
        events.push({ t: 'msg_start', seq: seq++, ts: 1, id: `m${i}`, role: 'assistant', turnId: `t${i}` });
        events.push({ t: 'msg_end', seq: seq++, ts: 1, msgId: `m${i}` });
        // Claude reports the money on turn_end, which is exactly the event the
        // window dropped.
        events.push({
          t: 'turn_end',
          seq: seq++,
          ts: 1,
          turnId: `t${i}`,
          usage: { costUsd: 0.01, outputTokens: 10 },
        });
      }
      capped.append(session, events);

      const snapshot = await capped.snapshot(session);
      assert.strictEqual(snapshot.messages.length, 4, 'the message cap still holds');
      assert.ok(
        Math.abs(snapshot.usage.costUsd - 0.3) < 1e-9,
        `every turn's cost must be counted, got ${snapshot.usage.costUsd}`,
      );
      assert.strictEqual(snapshot.usage.outputTokens, 300);
    });

    it('keeps the total steady across repeated rejoins, and extends it as the chat goes on', async function () {
      const capped = new ChatStore({ storageDir: dir, snapshotMinMessages: 2 });
      const session = { id: 'rejoin', ownerUserId: 1 };
      let seq = 1;
      const turn = (cost) => [
        { t: 'msg_start', seq: seq++, ts: 1, id: `m${seq}`, role: 'assistant', turnId: `t${seq}` },
        { t: 'msg_end', seq: seq++, ts: 1, msgId: `m${seq - 1}` },
        { t: 'turn_end', seq: seq++, ts: 1, turnId: `t${seq - 2}`, usage: { costUsd: cost } },
      ];

      capped.append(session, [...turn(0.5), ...turn(0.25), ...turn(0.25)]);
      const first = await capped.snapshot(session);
      const second = await capped.snapshot(session);
      assert.ok(Math.abs(first.usage.costUsd - 1) < 1e-9);
      assert.ok(Math.abs(second.usage.costUsd - 1) < 1e-9, 'a second rejoin must read the same');

      // And the running total the store keeps is extended by new turns rather
      // than left behind by them.
      capped.append(session, turn(0.5));
      const third = await capped.snapshot(session);
      assert.ok(Math.abs(third.usage.costUsd - 1.5) < 1e-9, `got ${third.usage.costUsd}`);
    });

    it('reads the same total from a cold store as from the one that wrote it', async function () {
      const session = { id: 'cold', ownerUserId: 1 };
      const events = [
        { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', seq: 2, ts: 1, msgId: 'm1', usage: { inputTokens: 100 } },
        { t: 'turn_end', seq: 3, ts: 1, turnId: 't1', usage: { costUsd: 0.75 } },
      ];
      store.append(session, events);
      const warm = await store.snapshot(session);

      // A restarted server has no cached total and must find it in the log.
      const cold = new ChatStore({ storageDir: dir });
      const reread = await cold.snapshot(session);
      assert.deepStrictEqual(reread.usage, warm.usage);
      assert.ok(Math.abs(reread.usage.costUsd - 0.75) < 1e-9);
      assert.strictEqual(reread.usage.inputTokens, 100);
    });

    it('does not let a context report with no money erase the money already spent', async function () {
      // An ACP runtime reports a running total; a report that carries only the
      // context window used to write cost back as undefined.
      const session = { id: 'acp', ownerUserId: 1 };
      store.append(session, [
        { t: 'turn_end', seq: 1, ts: 1, turnId: 't1', usage: { costUsd: 0.4 } },
        { t: 'usage', seq: 2, ts: 1, usage: { contextWindow: 200000, contextUsed: 1200 } },
      ]);

      const snapshot = await store.snapshot(session);
      assert.ok(Math.abs(snapshot.usage.costUsd - 0.4) < 1e-9, `got ${snapshot.usage.costUsd}`);
      assert.strictEqual(snapshot.usage.contextUsed, 1200);
    });

    it('starts the total again at a clear, warm or cold', async function () {
      // The figures over a chat are about the conversation on screen. A clear
      // ends that conversation, so a browser rejoining afterwards must not be
      // handed the bill of the one before it — and the running total the store
      // keeps in memory has to reset with the log it describes.
      const session = { id: 'cleared', ownerUserId: 1 };
      store.append(session, [
        { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', seq: 2, ts: 1, msgId: 'm1', usage: { inputTokens: 900 } },
        { t: 'turn_end', seq: 3, ts: 1, turnId: 't1', usage: { costUsd: 4.2 } },
      ]);
      assert.ok(Math.abs((await store.snapshot(session)).usage.costUsd - 4.2) < 1e-9);

      store.append(session, [{ t: 'marker', kind: 'cleared', seq: 4, ts: 2 }]);
      const after = await store.snapshot(session);
      assert.strictEqual(after.usage.costUsd, 0, `got ${after.usage.costUsd}`);
      assert.strictEqual(after.usage.inputTokens, 0);

      // And a server that restarts reads the same thing off the log rather
      // than the total from before the line.
      const cold = new ChatStore({ storageDir: dir });
      const reread = await cold.snapshot(session);
      assert.ok(!reread.usage.costUsd, `a cold read must not resurrect it, got ${reread.usage.costUsd}`);
    });

    it('stops walking back rather than replaying a log with no message boundaries', async function () {
      const capped = new ChatStore({
        storageDir: dir,
        snapshotReplayEvents: 10,
        snapshotMaxScanEvents: 30,
      });
      const session = { id: 'stateonly', ownerUserId: 1 };
      capped.append(session, makeEvents(1, 500));

      const snapshot = await capped.snapshot(session);
      assert.deepStrictEqual(snapshot.messages, []);
      // Bounded: it did not walk the whole log looking for a boundary.
      assert.ok(snapshot.replayFrom > 400, `walked back too far: ${snapshot.replayFrom}`);
    });

    it('returns a usable empty snapshot for a session with no events yet', async function () {
      const snapshot = await store.snapshot({ id: 'blank', ownerUserId: 1 });
      assert.deepStrictEqual(snapshot.messages, []);
      assert.strictEqual(snapshot.cursor, 0);
      assert.strictEqual(snapshot.firstSeq, 1);
      assert.strictEqual(snapshot.live, false);
    });

    it('recovers pending questions and answer outboxes from beyond the replay tail', async function () {
      const options = {
        storageDir: dir,
        snapshotReplayEvents: 2,
        snapshotMaxScanEvents: 4,
        snapshotMinMessages: 1,
      };
      const narrow = new ChatStore(options);
      const request = {
        requestId: 'old-answer', origin: 'structured_handoff',
        question: 'Still deliver this?', multiSelect: false,
        options: [{ optionId: 'opt-0', label: 'Yes' }], ts: 1,
      };
      const continuation = {
        continuationId: 'continue-old-answer',
        request,
        answer: { optionIds: ['opt-0'], labels: ['Yes'] },
      };
      const events = [
        { t: 'question', seq: 1, ts: 1, request },
        {
          t: 'question_resolved', seq: 2, ts: 2, requestId: request.requestId,
          optionIds: ['opt-0'], continuation,
        },
      ];
      for (let seq = 3; seq <= 20; seq += 1) {
        events.push({ t: 'state', seq, ts: seq, state: seq % 2 ? 'starting' : 'idle' });
      }
      await narrow.append({ id: 'old-outbox', ownerUserId: 1 }, events);

      const pendingRequest = {
        requestId: 'old-question', origin: 'structured_handoff',
        question: 'Still waiting?', multiSelect: false,
        options: [{ optionId: 'opt-0', label: 'Yes' }], ts: 1,
      };
      const pendingEvents = [{ t: 'question', seq: 1, ts: 1, request: pendingRequest }];
      for (let seq = 2; seq <= 20; seq += 1) {
        pendingEvents.push({ t: 'state', seq, ts: seq, state: seq % 2 ? 'starting' : 'idle' });
      }
      await narrow.append({ id: 'old-question', ownerUserId: 1 }, pendingEvents);

      const cold = new ChatStore(options);
      const outboxSnapshot = await cold.snapshot({ id: 'old-outbox', ownerUserId: 1 });
      assert.deepStrictEqual(
        outboxSnapshot.pendingQuestionContinuations.map((entry) => entry.continuationId),
        [continuation.continuationId],
      );
      assert.deepStrictEqual(outboxSnapshot.pendingQuestions, []);

      const pendingSnapshot = await cold.snapshot({ id: 'old-question', ownerUserId: 1 });
      assert.deepStrictEqual(
        pendingSnapshot.pendingQuestions.map((entry) => entry.requestId),
        [pendingRequest.requestId],
      );
    });
  });

  /**
   * What `/clear` costs the log.
   *
   * The bug these pin down: clearing emptied the browser's window and left the
   * log untouched, so reloading the page replayed the tail from disk and the
   * conversation the user had just ended came back — and because a freshly
   * cleared pane is too short to scroll, the client asked for the page above it
   * unprompted and pulled in the rest.
   */
  describe('truncateBefore', function () {
    /** A user/assistant exchange, so a truncation can be seen in the messages. */
    function exchange(startSeq, label) {
      const turnId = `turn-${label}`;
      return [
        { t: 'msg_start', seq: startSeq, ts: startSeq, id: `u-${label}`, role: 'user', turnId },
        {
          t: 'block_start',
          seq: startSeq + 1,
          ts: startSeq + 1,
          msgId: `u-${label}`,
          index: 0,
          block: { kind: 'text', text: `question ${label}` },
        },
        { t: 'msg_end', seq: startSeq + 2, ts: startSeq + 2, msgId: `u-${label}`, stopReason: 'end_turn' },
        { t: 'turn_end', seq: startSeq + 3, ts: startSeq + 3, turnId },
      ];
    }

    it('leaves a cleared conversation with nothing above the line', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      const before = [...exchange(1, 'old-a'), ...exchange(5, 'old-b')];
      const marker = { t: 'marker', seq: 9, ts: 9, kind: 'cleared', detail: 'started a new conversation' };
      store.append(session, [...before, marker, ...exchange(10, 'new')]);

      await store.truncateBefore(session, marker.seq);

      const snapshot = await store.snapshot(session);
      const texts = snapshot.messages.flatMap((message) =>
        message.blocks.filter((block) => block.kind === 'text').map((block) => block.text),
      );
      assert.deepStrictEqual(texts, ['question new'], 'a reload must open on the new conversation alone');
      // The two together are what stops the client asking for an older page:
      // there is no history below where the replay began.
      assert.strictEqual(snapshot.firstSeq, marker.seq);
      assert.strictEqual(snapshot.replayFrom, marker.seq);

      const older = await store.read(session, 1, 20);
      assert.strictEqual(
        older.events[0].seq,
        marker.seq,
        'paging back past the line must find nothing to bring in',
      );
      const index = await store.turnIndex(session);
      assert.deepStrictEqual(index.turns.map((turn) => turn.turnId), ['turn-new']);
      assert.strictEqual(index.complete, true, 'the index reaches the conversation it lists');
    });

    it('keeps numbering across the cut, so what follows still reads back', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 10));

      await store.truncateBefore(session, 6);
      store.append(session, makeEvents(11, 2));

      const stats = await store.stat(session);
      assert.strictEqual(stats.firstSeq, 6);
      assert.strictEqual(stats.cursor, 12);
      const page = await store.read(session, 1, 20);
      assert.deepStrictEqual(
        page.events.map((event) => event.seq),
        [6, 7, 8, 9, 10, 11, 12],
      );
    });

    it('does nothing when the log already starts there or later', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, makeEvents(1, 4));

      await store.truncateBefore(session, 1);
      await store.truncateBefore(session, 0);

      const page = await store.read(session, 1, 10);
      assert.deepStrictEqual(
        page.events.map((event) => event.seq),
        [1, 2, 3, 4],
      );
    });
  });

  /**
   * How a conversation is described in a list of them, and why that answer is
   * allowed to be remembered.
   *
   * The opening of an append-only log cannot change, which is what makes a
   * conversation list cost one bounded read per conversation once rather than
   * every time it opens (#127). The two operations that genuinely rewrite the head
   * — a `/clear` and a retention trim — have to be seen to drop it, because a
   * remembered opening line after a clear is the previous conversation's question
   * standing in for the new one's.
   */
  describe('describe', function () {
    /** A conversation that opens with a question, then says more. */
    function openingWith(startSeq, text, nativeSessionId) {
      const id = `u-${startSeq}`;
      const events = [
        { t: 'msg_start', seq: startSeq, ts: startSeq, id, role: 'user', turnId: `t-${startSeq}` },
        {
          t: 'block_start',
          seq: startSeq + 1,
          ts: startSeq + 1,
          msgId: id,
          index: 0,
          block: { kind: 'text', text },
        },
        { t: 'msg_end', seq: startSeq + 2, ts: startSeq + 2, msgId: id },
      ];
      if (nativeSessionId) {
        events.push({
          t: 'session',
          seq: startSeq + 3,
          ts: startSeq + 3,
          nativeSessionId,
          capabilities: {},
        });
      }
      return events;
    }

    it('reads the opening question and the runtime’s own id', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, openingWith(1, 'che file ho caricato?', 'native-1'));

      const found = await store.describe(session);
      assert.strictEqual(found.firstMessage, 'che file ho caricato?');
      assert.strictEqual(found.nativeSessionId, 'native-1');
    });

    it('gives the same answer however many times it is asked', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, openingWith(1, 'prima domanda', 'native-1'));
      await store.describe(session);
      // More is said afterwards, which is the ordinary case: the opening of an
      // append-only log is settled, so the answer must not drift.
      store.append(session, openingWith(5, 'seconda domanda'));

      const found = await store.describe(session);
      assert.strictEqual(found.firstMessage, 'prima domanda');
    });

    it('finds an opening it could not see the first time it looked', async function () {
      // A conversation asked about before anybody had said anything in it. The
      // answer then was "nothing yet", and that is not something to remember.
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, [{ t: 'state', seq: 1, ts: 1, state: 'starting' }]);
      assert.strictEqual((await store.describe(session)).firstMessage, null);

      store.append(session, openingWith(2, 'arrivata dopo', 'native-1'));
      assert.strictEqual((await store.describe(session)).firstMessage, 'arrivata dopo');
    });

    it('re-reads the opening after a /clear, which is a new conversation', async function () {
      const session = { id: 's1', ownerUserId: 1 };
      store.append(session, openingWith(1, 'la vecchia conversazione', 'native-1'));
      await store.describe(session);

      const marker = { t: 'marker', seq: 5, ts: 5, kind: 'cleared', detail: 'started a new conversation' };
      store.append(session, [marker, ...openingWith(6, 'la nuova conversazione', 'native-2')]);
      await store.truncateBefore(session, marker.seq);

      const found = await store.describe(session);
      assert.strictEqual(
        found.firstMessage,
        'la nuova conversazione',
        'a cleared conversation must not be listed under the question that ended it',
      );
      assert.strictEqual(found.nativeSessionId, 'native-2');
    });

    it('re-reads the opening after the head of the log is trimmed', async function () {
      // Past the retention cap the oldest events go, opening question included.
      // A remembered answer would keep listing a conversation by a line that is
      // no longer in it.
      const small = new ChatStore({ storageDir: dir, maxEvents: 12, trimChunkEvents: 6 });
      const session = { id: 'trimmed', ownerUserId: 1 };
      small.append(session, openingWith(1, 'la prima domanda', 'native-1'));
      assert.strictEqual((await small.describe(session)).firstMessage, 'la prima domanda');

      small.append(session, makeEvents(5, 6));
      small.append(session, openingWith(11, 'una domanda più tarda', 'native-2'));
      await small.stat(session);

      const found = await small.describe(session);
      assert.notStrictEqual(
        found.firstMessage,
        'la prima domanda',
        'the trimmed opening is no longer in the log and must not be reported from it',
      );
    });

    it('forgets a description when the conversation is deleted', async function () {
      // The ids are UUIDs, so this cannot happen in the app — but a remembered
      // answer keyed on a path that a later conversation could reuse is exactly
      // the sort of cache that outlives what it described.
      const session = { id: 'reused', ownerUserId: 1 };
      store.append(session, openingWith(1, 'la prima vita', 'native-1'));
      await store.describe(session);

      await store.deleteChat(session);
      store.append(session, openingWith(1, 'la seconda vita', 'native-2'));

      assert.strictEqual((await store.describe(session)).firstMessage, 'la seconda vita');
    });
  });

  describe('deleteChat', function () {
    it('removes the log and index for that session only', async function () {
      store.append({ id: 'gone', ownerUserId: 1 }, makeEvents(1, 1));
      store.append({ id: 'stays', ownerUserId: 1 }, makeEvents(1, 1));
      await store.stat({ id: 'gone', ownerUserId: 1 });
      await store.stat({ id: 'stays', ownerUserId: 1 });

      await store.deleteChat({ id: 'gone', ownerUserId: 1 });

      const remaining = await store.listSessions(1);
      assert.deepStrictEqual(remaining, ['stays']);

      const page = await store.read({ id: 'gone', ownerUserId: 1 }, 1, 10);
      assert.deepStrictEqual(page.events, []);
    });
  });
});
