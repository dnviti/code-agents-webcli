const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// "Loading earlier messages" sat on screen forever, doing nothing. Two separate
// defects produced it and either one alone reproduces it, so both are pinned
// here:
//
//   1. `hasMore` was `firstSeq > 0`. Event seq numbering starts at 1, so every
//      session that has ever existed reported "there is older history",
//      including a brand new one with a single message and nothing above it.
//   2. A page that came back with no messages returned from `prepend` without
//      notifying anyone, so the list never re-rendered and the spinner it had
//      raised was never taken down.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
    `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-paging-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-paging.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

function snapshot(over) {
  return {
    sessionId: 's1',
    runtime: 'claude',
    messages: [],
    state: 'idle',
    capabilities: {},
    pendingPermissions: [],
    firstSeq: 1,
    replayFrom: 1,
    cursor: 1,
    live: true,
    bypassPermissions: false,
    ...over,
  };
}

function controller(snap) {
  const sent = [];
  const c = new mod.ChatController('s1', { send: (m) => sent.push(m) });
  c.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(snap) });
  c.sent = sent;
  return c;
}

describe('paging back through a conversation', function () {
  it('offers nothing to page on a session whose replay reached the head', function () {
    // The exact shape the store reports for an untrimmed log.
    const c = controller({ firstSeq: 1, replayFrom: 1, cursor: 12 });
    assert.strictEqual(c.transcript.hasMore, false);

    // Opening a conversation asks for its turn index, which is not a page and
    // is sent however little there is to page (#86).
    assert.deepStrictEqual(
      c.sent.map((m) => m.type),
      ['chat_turn_index_request'],
    );
    c.sent.length = 0;

    c.loadMore();
    assert.deepStrictEqual(c.sent, [], 'nothing to fetch, so nothing was asked for');
    assert.strictEqual(c.transcript.loadingMore, false);
  });

  it('offers to page when the log holds events the replay did not carry', function () {
    const c = controller({ firstSeq: 40, replayFrom: 900, cursor: 1200 });
    assert.strictEqual(c.transcript.hasMore, true);

    c.sent.length = 0;
    c.loadMore();
    assert.strictEqual(c.transcript.loadingMore, true);
    assert.strictEqual(c.sent.length, 1);
    assert.strictEqual(c.sent[0].type, 'chat_history_request');
    assert.strictEqual(c.sent[0].sessionId, 's1');
    assert.strictEqual(c.sent[0].fromSeq, 700);
  });

  it('settles when a page comes back empty, instead of spinning forever', function () {
    const c = controller({ firstSeq: 40, replayFrom: 900, cursor: 1200 });
    c.loadMore();
    assert.strictEqual(c.transcript.loadingMore, true);

    let notified = 0;
    c.transcript.subscribe(() => {
      notified += 1;
    });

    // A page can legitimately produce no messages: its events opened messages
    // that closed inside a page already held.
    c.handle({
      type: 'chat_page',
      sessionId: 's1',
      requestId: c.sent[0].requestId,
      events: [],
      firstSeq: 40,
      from: 700,
    });

    assert.strictEqual(c.transcript.loadingMore, false);
    assert.ok(notified > 0, 'an empty page still has to re-render the list');
    // The floor moved, so asking again reaches further back rather than
    // re-requesting the same range.
    assert.strictEqual(c.transcript.oldestSeq, 700);
  });

  it('stops offering to page once the head of the log is reached', function () {
    const c = controller({ firstSeq: 40, replayFrom: 240, cursor: 400 });
    c.loadMore();
    c.handle({
      type: 'chat_page',
      sessionId: 's1',
      requestId: c.sent[0].requestId,
      events: [],
      firstSeq: 40,
      // Clamped by the server to the lowest seq it still has.
      from: 40,
    });

    assert.strictEqual(c.transcript.oldestSeq, 40);
    assert.strictEqual(c.transcript.hasMore, false);
  });

  it('gives the control back when the server reports the read failed', function () {
    const c = controller({ firstSeq: 40, replayFrom: 900, cursor: 1200 });
    c.loadMore();

    c.handle({ type: 'chat_page_failed', sessionId: 's1', requestId: c.sent[0].requestId, message: 'boom' });

    assert.strictEqual(c.transcript.loadingMore, false);
    assert.strictEqual(c.transcript.hasMore, true, 'the history is still there to retry');
  });

  it('does not stack requests while one is in flight', function () {
    const c = controller({ firstSeq: 40, replayFrom: 900, cursor: 1200 });
    c.sent.length = 0;
    c.loadMore();
    c.loadMore();
    c.loadMore();
    assert.strictEqual(c.sent.length, 1);
  });

  it('offers no paging at all to a server that does not report its replay floor', function () {
    // Older server: no `replayFrom`. Silence has to read as "nothing older",
    // because the alternative is a control that can never complete.
    const c = controller({ firstSeq: 40, replayFrom: undefined, cursor: 1200 });
    assert.strictEqual(c.transcript.hasMore, false);
  });

  it('folds a page of real events in front of what it already holds', function () {
    const c = controller({
      firstSeq: 1,
      replayFrom: 3,
      cursor: 3,
      messages: [
        { id: 'later', seq: 3, turnId: 't2', role: 'assistant', ts: 3, blocks: [{ kind: 'text', text: 'second' }] },
      ],
    });
    assert.strictEqual(c.transcript.hasMore, true);

    c.loadMore();
    c.handle({
      type: 'chat_page',
      sessionId: 's1',
      requestId: c.sent[0].requestId,
      firstSeq: 1,
      from: 1,
      events: [
        { t: 'msg_start', seq: 1, ts: 1, id: 'earlier', role: 'assistant', turnId: 't1' },
        { t: 'block_start', seq: 2, ts: 1, msgId: 'earlier', index: 0, block: { kind: 'text', text: 'first' } },
      ],
    });

    assert.deepStrictEqual(
      c.transcript.messages.map((m) => m.id),
      ['earlier', 'later'],
    );
    assert.strictEqual(c.transcript.hasMore, false);
  });
});
