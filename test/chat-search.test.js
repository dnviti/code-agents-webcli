const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatStore } = require('../dist/server/chat/store.js');
const { searchChatSessions } = require('../dist/server/chat/search.js');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A single-block user or assistant message, contiguous from `seq`. */
function textTurn(seq, role, text, turnId = 't') {
  return [
    { t: 'msg_start', seq, ts: seq, id: `m${seq}`, role, turnId },
    { t: 'block_start', seq: seq + 1, ts: seq, msgId: `m${seq}`, index: 0, block: { kind: 'text', text } },
    { t: 'msg_end', seq: seq + 2, ts: seq, msgId: `m${seq}` },
  ];
}

describe('chat search', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-chat-search-'));
    store = new ChatStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a match in a recorded session and reports where it lives', async function () {
    const events = loadFixture('store-events.jsonl');
    store.append({ id: 's1', ownerUserId: 1 }, events);
    await store.stat({ id: 's1', ownerUserId: 1 });

    // Matches both the user's request and the tool output the assistant
    // produced ("...login bug fixed"), in transcript order.
    const hits = await searchChatSessions(store, 1, 'login bug');
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].sessionId, 's1');
    assert.strictEqual(hits[0].seq, 2);
    assert.strictEqual(hits[0].role, 'user');
    assert.ok(hits[0].snippet.includes('login bug'));
    assert.strictEqual(hits[1].seq, 5);
    assert.strictEqual(hits[1].role, 'assistant');
  });

  it('finds text produced by tool output too, via messageText', async function () {
    const events = loadFixture('store-events.jsonl');
    store.append({ id: 's1', ownerUserId: 1 }, events);
    await store.stat({ id: 's1', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, 'fixed');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].seq, 5);
    assert.strictEqual(hits[0].role, 'assistant');
  });

  it('is case-insensitive', async function () {
    const events = loadFixture('store-events.jsonl');
    store.append({ id: 's1', ownerUserId: 1 }, events);
    await store.stat({ id: 's1', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, 'LOGIN BUG');
    assert.strictEqual(hits.length, 2);
  });

  it('returns nothing for a query that matches no session', async function () {
    const events = loadFixture('store-events.jsonl');
    store.append({ id: 's1', ownerUserId: 1 }, events);
    await store.stat({ id: 's1', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, 'nonexistent-phrase-xyz');
    assert.deepStrictEqual(hits, []);
  });

  it('returns nothing for a blank query rather than matching everything', async function () {
    const events = loadFixture('store-events.jsonl');
    store.append({ id: 's1', ownerUserId: 1 }, events);
    await store.stat({ id: 's1', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, '   ');
    assert.deepStrictEqual(hits, []);
  });

  it('never returns a hit from another user\'s session', async function () {
    store.append({ id: 'mine', ownerUserId: 1 }, textTurn(1, 'user', 'the shared secret is hunter2'));
    store.append({ id: 'theirs', ownerUserId: 2 }, textTurn(1, 'user', 'the shared secret is hunter2'));
    await store.stat({ id: 'mine', ownerUserId: 1 });
    await store.stat({ id: 'theirs', ownerUserId: 2 });

    const hits = await searchChatSessions(store, 1, 'hunter2');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sessionId, 'mine');
  });

  it('searches across several sessions for the same owner', async function () {
    store.append({ id: 'a', ownerUserId: 1 }, textTurn(1, 'user', 'please refactor the parser'));
    store.append({ id: 'b', ownerUserId: 1 }, textTurn(1, 'user', 'please add tests for the parser'));
    await store.stat({ id: 'a', ownerUserId: 1 });
    await store.stat({ id: 'b', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, 'parser');
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(
      hits.map((h) => h.sessionId).sort(),
      ['a', 'b'],
    );
  });

  it('caps the number of hits returned across sessions', async function () {
    for (let i = 0; i < 5; i++) {
      store.append({ id: `s${i}`, ownerUserId: 1 }, textTurn(1, 'user', 'find me please'));
      await store.stat({ id: `s${i}`, ownerUserId: 1 });
    }

    const hits = await searchChatSessions(store, 1, 'find me', { limit: 2 });
    assert.strictEqual(hits.length, 2);
  });

  it('bounds the scan within one session so a huge log cannot starve the rest', async function () {
    const session = { id: 'huge', ownerUserId: 1 };
    // A long run of unrelated events, followed by the message we're hunting for.
    const filler = Array.from({ length: 30 }, (_, i) => ({
      t: 'state',
      seq: i + 1,
      ts: i,
      state: 'idle',
    }));
    const target = textTurn(31, 'user', 'the needle phrase');
    store.append(session, [...filler, ...target]);
    await store.stat(session);

    const capped = await searchChatSessions(store, 1, 'needle phrase', { perSessionEventCap: 10 });
    assert.deepStrictEqual(capped, [], 'the match sits past the per-session cap');

    const uncapped = await searchChatSessions(store, 1, 'needle phrase', { perSessionEventCap: 5_000 });
    assert.strictEqual(uncapped.length, 1);
  });

  it('builds a snippet with context around the match, not the whole message', async function () {
    const longText = `${'x'.repeat(200)} findable-term ${'y'.repeat(200)}`;
    store.append({ id: 's1', ownerUserId: 1 }, textTurn(1, 'user', longText));
    await store.stat({ id: 's1', ownerUserId: 1 });

    const hits = await searchChatSessions(store, 1, 'findable-term', { snippetRadius: 10 });
    assert.strictEqual(hits.length, 1);
    assert.ok(hits[0].snippet.length < longText.length);
    assert.ok(hits[0].snippet.includes('findable-term'));
    assert.ok(hits[0].snippet.startsWith('…'));
    assert.ok(hits[0].snippet.endsWith('…'));
  });

  it('returns nothing for a user with no chat sessions at all', async function () {
    const hits = await searchChatSessions(store, 999, 'anything');
    assert.deepStrictEqual(hits, []);
  });
});
