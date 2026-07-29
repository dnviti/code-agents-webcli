const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatStore } = require('../dist/server/chat/store.js');

/**
 * Issue #113: an answered question keeps the marks it was answered with.
 *
 * The card is left in the conversation after it is answered for one reason —
 * scrolling back past a decision should show the decision. It survived only as
 * long as you stayed put. Switching to another tab and back redrew every
 * answered question blank: every option faded, none marked, sometimes a grey
 * sentence naming the labels underneath and sometimes nothing at all. A card
 * reading as one nobody had ever answered, beside an agent that had plainly
 * acted on an answer.
 *
 * The answer was never lost. `question_resolved` has always been written to the
 * log, and the shared reducer has always folded it into `answeredQuestions`
 * correctly — on the server as well, since the snapshot is built by replaying
 * the log through that same reducer. It was then dropped at the wire: the
 * snapshot had nowhere to put it. So every rejoin — a tab switch, a reload, a
 * reconnect, a second browser, a conversation whose agent has stopped — threw
 * away what the browser had and got nothing back in its place.
 *
 * Two halves, tested in the two places they live: the server has to send it,
 * and the browser has to keep it — including for a question far enough back
 * that it arrives by scrolling rather than with the opening view.
 */

const ROOT = path.join(__dirname, '..');
const TOOL_ID = 'ask-1';
const OPTIONS = [
  { optionId: 'opt-0', label: 'Rewrite it' },
  { optionId: 'opt-1', label: 'Patch it' },
  { optionId: 'opt-2', label: 'Leave it' },
];

/**
 * One question asked and answered, exactly as a session records it.
 *
 * The tool call that asked, the question, the answer, the tool result the model
 * was given, and the turn ending — in the order and with the shapes
 * `ChatSession` writes them.
 */
function asked(picks, { skipped = false } = {}) {
  let seq = 0;
  const next = () => (seq += 1);
  return [
    { t: 'msg_start', seq: next(), ts: 1, id: 'u1', role: 'user', turnId: 't1' },
    { t: 'block_start', seq: next(), ts: 2, msgId: 'u1', index: 0, block: { kind: 'text', text: 'what should I do' } },
    { t: 'msg_end', seq: next(), ts: 3, msgId: 'u1' },
    { t: 'msg_start', seq: next(), ts: 4, id: 'a1', role: 'assistant', turnId: 't1' },
    {
      t: 'block_start', seq: next(), ts: 5, msgId: 'a1', index: 0,
      block: {
        kind: 'tool', toolId: TOOL_ID, name: 'mcp__ccweb__ask_user_question', toolKind: 'task',
        status: 'running',
        input: { question: 'Which approach should I take?', options: OPTIONS },
      },
    },
    {
      t: 'question', seq: next(), ts: 6,
      request: {
        requestId: 'req-1', toolId: TOOL_ID, question: 'Which approach should I take?',
        multiSelect: picks.length > 1, options: OPTIONS,
      },
    },
    {
      t: 'question_resolved', seq: next(), ts: 7,
      requestId: 'req-1', toolId: TOOL_ID, optionIds: picks, skipped,
    },
    { t: 'tool', seq: next(), ts: 8, toolId: TOOL_ID, patch: { status: 'completed', output: 'The user chose: Rewrite it' } },
    { t: 'msg_end', seq: next(), ts: 9, msgId: 'a1' },
    { t: 'turn_end', seq: next(), ts: 10, turnId: 't1', stopReason: 'end_turn' },
  ];
}

describe('an answered question survives being left and come back to (#113)', function () {
  describe('what the server hands a browser that rejoins', function () {
    let dir;
    let store;
    const ref = { id: 's1', ownerUserId: 7 };

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answered-'));
      store = new ChatStore({ storageDir: dir });
    });

    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('carries what was picked, not only what is still waiting', async function () {
      store.append(ref, asked(['opt-0']));
      const snapshot = await store.snapshot(ref, {});
      assert.deepStrictEqual(
        snapshot.answeredQuestions[TOOL_ID],
        ['opt-0'],
        'the option chosen has to ride the snapshot or the card comes back blank',
      );
    });

    it('brings a multi-select answer back with every pick, and only the picks', async function () {
      store.append(ref, asked(['opt-0', 'opt-2']));
      const snapshot = await store.snapshot(ref, {});
      assert.deepStrictEqual(snapshot.answeredQuestions[TOOL_ID], ['opt-0', 'opt-2']);
    });

    it('brings a skip back as answered-with-nothing rather than as unanswered', async function () {
      store.append(ref, asked([], { skipped: true }));
      const snapshot = await store.snapshot(ref, {});
      assert.deepStrictEqual(
        snapshot.answeredQuestions[TOOL_ID],
        [],
        'an empty array is "they skipped it"; undefined is "we do not know", and the card draws them differently',
      );
    });

    it('says nothing about a question still waiting for an answer', async function () {
      // Sliced before `question_resolved`: asked, not yet answered. A question
      // in that state is a *pending* one, which the live session overlays onto
      // the snapshot separately — this map is only about answers already given,
      // and claiming an empty one here would draw the card as skipped.
      store.append(ref, asked(['opt-0']).slice(0, 6));
      const snapshot = await store.snapshot(ref, {});
      assert.deepStrictEqual(snapshot.answeredQuestions, {});
    });
  });

  describe('what the browser does with it', function () {
    let mod;
    let bundle;

    before(function () {
      this.timeout(60000);
      const contents = [
        `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
        `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
      ].join('\n');
      bundle = path.join(os.tmpdir(), `question-record-${process.pid}.js`);
      require('esbuild').buildSync({
        stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'question-record.ts' },
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

    const snapshot = (over) => ({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: {
        sessionId: 's1', runtime: 'claude', state: 'idle', capabilities: { questions: true },
        messages: [], pendingPermissions: [], queued: [], firstSeq: 1, replayFrom: 1, cursor: 0,
        live: true, bypassPermissions: false,
        ...over,
      },
    });

    it('keeps the picks when a tab switch re-delivers the snapshot', function () {
      const controller = new mod.ChatController('s1', { send: () => {} });
      controller.handle(snapshot({}));
      for (const event of asked(['opt-0', 'opt-2'])) controller.transcript.apply(event);
      assert.deepStrictEqual(controller.transcript.answerFor(TOOL_ID), ['opt-0', 'opt-2']);

      // Switching to another conversation and back rejoins the session, and the
      // server answers a rejoin with a whole fresh snapshot. That is the moment
      // the marks used to go.
      const messages = controller.transcript.messages;
      controller.handle(
        snapshot({ messages, answeredQuestions: { [TOOL_ID]: ['opt-0', 'opt-2'] }, cursor: 10 }),
      );
      assert.deepStrictEqual(
        controller.transcript.answerFor(TOOL_ID),
        ['opt-0', 'opt-2'],
        'the same options, marked the same way, after coming back',
      );
    });

    it('does not lose a live answer to a snapshot from a server that has no answers to send', function () {
      // An older server, or one whose window did not reach the question. It
      // knows nothing about the answer, which is not the same as knowing there
      // was none — so it must not take the marks off a card this browser
      // watched being answered a moment ago.
      const controller = new mod.ChatController('s1', { send: () => {} });
      controller.handle(snapshot({}));
      for (const event of asked(['opt-1'])) controller.transcript.apply(event);
      controller.handle(snapshot({ messages: controller.transcript.messages, cursor: 10 }));
      assert.deepStrictEqual(controller.transcript.answerFor(TOOL_ID), ['opt-1']);
    });

    it('keeps the marks on a question that arrives by scrolling back through history', function () {
      // A page of history is replayed through a scratch transcript, which folds
      // the answer correctly — and then the scratch was thrown away with it.
      const controller = new mod.ChatController('s1', { send: () => {} });
      controller.handle(snapshot({ firstSeq: 11, replayFrom: 11, cursor: 20 }));
      controller.handle({
        type: 'chat_page',
        sessionId: 's1',
        events: asked(['opt-2']),
        firstSeq: 1,
        from: 1,
      });
      assert.deepStrictEqual(
        controller.transcript.answerFor(TOOL_ID),
        ['opt-2'],
        'scrolling back far enough to reach a decision has to show the decision',
      );
    });
  });
});
