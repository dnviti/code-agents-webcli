const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Selecting an index entry from before the loaded window used to page back
// twenty times and then give up in silence: the row highlighted, the transcript
// did not move, and clicking again walked another four thousand events. In the
// conversations an index exists for — the long ones — that was every jump, not
// an edge case (#86). These pin what replaced it: a jump with no page ceiling,
// which says which turn it is fetching, can be abandoned, and stops on its own
// when there is nothing left to read rather than asking forever.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-turn-jump-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-turn-jump.ts' },
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

const TARGET = 'msg-old';

/**
 * A conversation whose history is on disk and whose window is at the end of it.
 *
 * `reply` decides what the server does with a page request, so a test can be a
 * healthy log, a read that fails, or a log whose head was trimmed away.
 */
function conversation({ firstSeq = 1, replayFrom = 10_000, cursor = 10_400, targetSeq = 4_000, reply } = {}) {
  const asked = [];
  const controller = new mod.ChatController('s1', {
    send(message) {
      asked.push(message);
      if (message.type !== 'chat_history_request') return;
      // A socket answers on a later tick. That is what makes a jump a sequence
      // of awaits with the surface still painting between them.
      setTimeout(() => answer(message), 0);
    },
  });

  const page = (message) => {
    const from = Math.max(firstSeq, message.fromSeq);
    const hit = targetSeq !== null && from <= targetSeq && targetSeq < from + message.count;
    return {
      type: 'chat_page',
      sessionId: 's1',
      requestId: message.requestId,
      firstSeq,
      from,
      events: hit
        ? [
            { t: 'msg_start', seq: targetSeq, ts: 1, id: TARGET, role: 'user', turnId: 'told' },
            {
              t: 'block_start',
              seq: targetSeq + 1,
              ts: 1,
              msgId: TARGET,
              index: 0,
              block: { kind: 'text', text: 'the thing I asked hours ago' },
            },
          ]
        : [],
    };
  };

  const answer = (message) => {
    controller.handle(reply ? reply(message, page(message)) : page(message));
  };

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
      firstSeq,
      replayFrom,
      cursor,
      live: true,
      bypassPermissions: false,
    },
  });

  controller.asked = asked;
  controller.pages = () => asked.filter((message) => message.type === 'chat_history_request');
  return controller;
}

describe('jumping to a turn from before the loaded window', function () {
  it('walks the whole way back, past the ceiling that used to stop it', async function () {
    // Six thousand events above the window: half again the twenty-page,
    // 200-event ceiling the old `loadUntilLoaded` gave up at.
    const c = conversation({ replayFrom: 10_000, targetSeq: 4_000 });

    const outcome = await c.seekTo(TARGET);

    assert.strictEqual(outcome, 'arrived');
    assert.ok(
      c.transcript.messages.some((message) => message.id === TARGET),
      'the turn the user asked for has to actually be in the transcript',
    );
    assert.ok(
      10_000 - c.transcript.oldestSeq > 4_000,
      `walked only ${10_000 - c.transcript.oldestSeq} events, which the old ceiling allowed`,
    );
  });

  it('says which turn it is fetching, from the moment it starts', async function () {
    const c = conversation();

    const journey = c.seekTo(TARGET);
    // Synchronously: the indicator has to be up before the first page is even
    // asked for, or the first seconds of a jump look exactly like a dead click.
    assert.strictEqual(c.seekingMessageId, TARGET);

    await journey;
    assert.strictEqual(c.seekingMessageId, null);
  });

  it('is abandoned when the user goes somewhere else', async function () {
    const c = conversation();

    const journey = c.seekTo(TARGET);
    c.cancelSeek();

    assert.strictEqual(await journey, 'abandoned');
    assert.strictEqual(c.seekingMessageId, null);

    const asked = c.pages().length;
    // The page already in flight still lands — it is history this browser now
    // holds — but nothing asks for the next one.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(c.pages().length, asked, 'a cancelled jump kept paging');
  });

  it('is abandoned when the cancel lands while a page is in the air', async function () {
    // The ordinary case, and the one the three-way outcome exists for: a
    // rejoin, a disposal or a tab switch all arrive during a page, not between
    // two. Read only at the top of the loop, the cancel is never consulted and
    // the jump reports the log as exhausted — so the user who simply left is
    // told the turn is no longer in their conversation.
    const c = conversation();

    const journey = c.seekTo(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 0));
    c.cancelSeek();

    assert.strictEqual(await journey, 'abandoned');
  });

  it('stops when a read fails, rather than asking the same page forever', async function () {
    // With no ceiling, "the floor did not move" is the only thing standing
    // between a failed read and a loop that never ends.
    const c = conversation({
      reply: (message) => ({
        type: 'chat_page_failed',
        sessionId: 's1',
        requestId: message.requestId,
        message: 'read failed',
      }),
    });

    // And it is reported as a read that did not arrive, not as a turn that is
    // gone: one failed page says nothing about whether the log still holds it,
    // and on a slow link a long walk has a hundred chances to hit this.
    assert.strictEqual(await c.seekTo(TARGET), 'unreachable');
    assert.strictEqual(c.pages().length, 1);
  });

  it('admits it when the turn is no longer on the log', async function () {
    // The head was trimmed: the paging floor reaches the first seq still on
    // disk and the message is not among what came back.
    const c = conversation({ firstSeq: 9_000, replayFrom: 10_000, targetSeq: null });

    assert.strictEqual(await c.seekTo(TARGET), 'exhausted');
    assert.strictEqual(c.transcript.hasMore, false);
  });
});
