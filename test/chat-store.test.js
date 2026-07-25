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

    it('lets a client tell it fell off the back', async function () {
      const trimmed = new ChatStore({ storageDir: dir, maxEvents: 10, trimChunkEvents: 5 });
      const session = { id: 's1', ownerUserId: 1 };
      trimmed.append(session, makeEvents(1, 16));

      const page = await trimmed.read(session, 1, 5);
      assert.strictEqual(page.firstSeq, 6, 'a client asking from seq 1 learns the true floor is 6');
      assert.strictEqual(page.events[0].seq, 6);
    });
  });

  describe('crash repair', function () {
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
