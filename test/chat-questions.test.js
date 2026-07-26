const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const { ChatSession } = require('../dist/server/chat/session.js');
const { PermissionBroker } = require('../dist/server/chat/permission-broker.js');
const { serveAsk, describeAnswer, ASK_TOOL_DEFINITION, askMcpConfig } = require('../dist/server/chat/ask-mcp.js');
const {
  applyChatEvent,
  createTranscript,
} = require('../dist/shared/chat-reducer.js');
const {
  isAskQuestionTool,
  looksLikeAskCall,
  askedQuestionFrom,
  normalizeQuestionOptions,
  ASK_QUESTION_TOOL_NAME,
} = require('../dist/shared/chat-events.js');
const { askChannelFor } = require('../dist/server/chat/registry.js');

// Choice-based questions from the model, end to end (issue #42).
//
// The mechanism is not obvious and was established by probe rather than by
// reading docs: Claude's own AskUserQuestion tool does not exist in the headless
// stream-json channel this app drives (`.work/probes/ask/`), so the capability
// is supplied as an MCP tool instead (`.work/probes/askmcp/`). What makes it
// work is that `tools/call` blocks — the model genuinely waits on a person —
// which is the property most of these tests are about.

const ROOT = path.join(__dirname, '..');
const ASK_SERVER = path.join(ROOT, 'dist', 'server', 'chat', 'ask-mcp.js');

const QUESTION = {
  question: 'Which approach should I take?',
  header: 'Approach',
  multiSelect: false,
  options: [
    { label: 'Rewrite it', description: 'Slower but cleaner' },
    { label: 'Patch it', description: 'Faster, more debt' },
  ],
};

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

function session({ bypass = false } = {}) {
  const store = memoryStore();
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ask-')),
      // Absent, so no real broker is stood up: askQuestion is driven directly,
      // which is the seam the broker would call anyway.
      hookScript: path.join(ROOT, 'does-not-exist.js'),
      broadcast: () => {},
      resolveCommand: () => 'claude',
    },
  );
  s.bypass = bypass;
  return { s, store };
}

/** Resolve, or fail loudly rather than letting mocha time out with no clue. */
function within(promise, what, ms = 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);
}

describe('asking the user a choice-based question', function () {
  describe('the MCP tool the model actually calls', function () {
    /** Drive the real protocol over pipes, the way the runtime does. */
    function drive(answers) {
      const input = new PassThrough();
      const output = new PassThrough();
      const lines = [];
      let resolveLine = null;
      output.setEncoding('utf8');
      let buffer = '';
      output.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) !== -1) {
          lines.push(JSON.parse(buffer.slice(0, at)));
          buffer = buffer.slice(at + 1);
          if (resolveLine) {
            const go = resolveLine;
            resolveLine = null;
            go();
          }
        }
      });

      const asked = [];
      serveAsk(input, output, async (question) => {
        asked.push(question);
        return answers(question);
      });

      return {
        asked,
        lines,
        send(message) {
          input.write(`${JSON.stringify(message)}\n`);
        },
        next() {
          if (lines.length) return Promise.resolve(lines[lines.length - 1]);
          return within(
            new Promise((resolve) => {
              resolveLine = () => resolve(lines[lines.length - 1]);
            }),
            'the MCP server never replied',
          );
        },
      };
    }

    it('advertises exactly one tool, with a schema the model can fill in', async function () {
      const mcp = drive(() => ({ labels: [] }));
      mcp.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      const reply = await mcp.next();
      assert.strictEqual(reply.result.tools.length, 1);
      const [tool] = reply.result.tools;
      assert.ok(isAskQuestionTool(tool.name));
      // multiSelect is the whole second half of the issue; a schema without it
      // means the model can only ever ask single-choice questions.
      assert.ok(tool.inputSchema.properties.multiSelect);
      assert.deepStrictEqual(tool.inputSchema.required, ['question', 'options']);
    });

    it('echoes the protocol version the client offered rather than pinning one', async function () {
      const mcp = drive(() => ({ labels: [] }));
      mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });

      const reply = await mcp.next();
      assert.strictEqual(reply.result.protocolVersion, '2099-01-01');
    });

    it('does not answer the call until the user has', async function () {
      let release;
      const mcp = drive(() => new Promise((resolve) => { release = resolve; }));
      mcp.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_user_question', arguments: QUESTION } });

      // The property the whole feature rests on: a blocked tool call is what
      // makes the agent wait instead of guessing an answer and moving on.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepStrictEqual(mcp.lines, [], 'the call answered before anyone did');

      release({ labels: ['Patch it'] });
      const reply = await mcp.next();
      assert.strictEqual(reply.id, 7);
      assert.match(reply.result.content[0].text, /Patch it/);
      assert.notStrictEqual(reply.result.isError, true);
    });

    it('passes the model’s own question through untouched', async function () {
      const mcp = drive(() => ({ labels: ['Rewrite it'] }));
      mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user_question', arguments: QUESTION } });

      await mcp.next();
      assert.deepStrictEqual(mcp.asked[0], QUESTION);
    });

    it('refuses a tool it does not serve instead of answering for it', async function () {
      const mcp = drive(() => ({ labels: [] }));
      mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });

      const reply = await mcp.next();
      assert.ok(reply.error, 'an unknown tool should not come back as a result');
    });
  });

  describe('what the model is told', function () {
    it('names the options the user picked', function () {
      const { text, isError } = describeAnswer({ labels: ['Patch it', 'Rewrite it'] });
      assert.match(text, /"Patch it", "Rewrite it"/);
      assert.strictEqual(isError, false);
    });

    it('says a skip was a skip, and tells the model not to ask again', function () {
      const { text, isError } = describeAnswer({ labels: [], skipped: true });
      assert.match(text, /skipped/i);
      assert.match(text, /not ask it again/i);
      // Not an error: the user answering "none of these" is a normal outcome,
      // and flagging it as a failure invites the model to retry the question.
      assert.strictEqual(isError, false);
    });

    it('tells the model to fall back to prose when nobody could be reached', function () {
      // The opposite failure direction from an approval, and deliberately so:
      // nothing is gated on a question, so failing closed would block a turn
      // for no safety gain.
      const { text, isError } = describeAnswer({ labels: [], error: 'the browser is gone' });
      assert.match(text, /plain text/i);
      assert.strictEqual(isError, true);
    });
  });

  describe('the session', function () {
    it('puts the question in the transcript and blocks until it is answered', async function () {
      const { s, store } = session();
      const waiting = s.askQuestion(QUESTION);

      const asked = store.events.find((e) => e.t === 'question');
      assert.ok(asked, 'the question should reach the transcript');
      assert.strictEqual(asked.request.question, QUESTION.question);
      assert.strictEqual(asked.request.options.length, 2);
      assert.strictEqual(s.currentState ?? s.state, 'awaiting_answer');

      s.answerQuestion(asked.request.requestId, [asked.request.options[1].optionId]);

      const reply = await within(waiting, 'the question was never answered');
      assert.deepStrictEqual(reply.labels, ['Patch it']);
      assert.ok(store.events.some((e) => e.t === 'question_resolved' && e.skipped !== true));
    });

    it('carries every pick back for a multi-select question', async function () {
      const { s, store } = session();
      const waiting = s.askQuestion({
        question: 'Which of these should I apply?',
        multiSelect: true,
        options: ['semicolons', 'trailing commas', 'single quotes'],
      });

      const asked = store.events.find((e) => e.t === 'question').request;
      assert.strictEqual(asked.multiSelect, true);
      s.answerQuestion(asked.requestId, [asked.options[0].optionId, asked.options[2].optionId]);

      const reply = await within(waiting, 'the multi-select answer never came back');
      assert.deepStrictEqual(reply.labels, ['semicolons', 'single quotes']);
    });

    it('ignores option ids it never offered', async function () {
      const { s, store } = session();
      const waiting = s.askQuestion(QUESTION);
      const asked = store.events.find((e) => e.t === 'question').request;

      // The ids come off a socket. The labels they resolve to are handed to the
      // model as a statement of fact about what the user chose, so an id that
      // was never offered must not be able to invent one.
      s.answerQuestion(asked.requestId, ['opt-99', asked.options[0].optionId]);

      const reply = await within(waiting, 'the filtered answer never came back');
      assert.deepStrictEqual(reply.labels, ['Rewrite it']);
    });

    it('treats an answer of nothing at all as a skip', async function () {
      const { s, store } = session();
      const waiting = s.askQuestion(QUESTION);
      const asked = store.events.find((e) => e.t === 'question').request;

      s.answerQuestion(asked.requestId, [], true);

      const reply = await within(waiting, 'the skip never came back');
      assert.strictEqual(reply.skipped, true);
      assert.deepStrictEqual(reply.labels, []);
      assert.ok(store.events.some((e) => e.t === 'question_resolved' && e.skipped === true));
    });

    it('refuses a question with nothing to pick from, rather than showing an empty card', async function () {
      const { s, store } = session();
      const reply = await within(
        s.askQuestion({ question: 'Well?', options: [] }),
        'a malformed question should be answered, not hang',
      );
      assert.ok(reply.error);
      assert.ok(!store.events.some((e) => e.t === 'question'), 'nothing should be put on screen');
    });

    it('asks even when tool approvals are bypassed', async function () {
      // Bypassing means "stop asking me before you act". It has never meant
      // "answer my questions for me", and a session that auto-answered would
      // silently pick for the user.
      const { s, store } = session({ bypass: true });
      const waiting = s.askQuestion(QUESTION);

      const asked = store.events.find((e) => e.t === 'question');
      assert.ok(asked, 'a bypassed session must still put the question to the user');
      s.answerQuestion(asked.request.requestId, [asked.request.options[0].optionId]);
      await within(waiting, 'the bypassed session never delivered the answer');
    });

    it('never asks permission to ask a question', async function () {
      const { s } = session();
      const decision = await within(
        s.askUser({ toolName: ASK_QUESTION_TOOL_NAME, toolInput: QUESTION }),
        'the question tool was gated behind an approval',
      );
      assert.strictEqual(decision.allow, true);
    });

    it('pairs a question with the tool call that asked it', async function () {
      const { s, store } = session();
      s.ingest({
        t: 'block_start',
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'toolu_42', name: ASK_QUESTION_TOOL_NAME, toolKind: 'other', status: 'pending' },
      });

      s.askQuestion(QUESTION);
      const asked = store.events.find((e) => e.t === 'question').request;
      // Without this the card has nowhere to live in the conversation and falls
      // back to the pinned region.
      assert.strictEqual(asked.toolId, 'toolu_42');

      s.answerQuestion(asked.requestId, [asked.options[0].optionId]);
      const resolved = store.events.find((e) => e.t === 'question_resolved');
      // Repeated on the resolution so a card rebuilt from the log alone can
      // still find its own answer.
      assert.strictEqual(resolved.toolId, 'toolu_42');
    });

    it('does not pair a second question with a call already claimed', async function () {
      const { s, store } = session();
      s.ingest({
        t: 'block_start',
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'toolu_42', name: ASK_QUESTION_TOOL_NAME, toolKind: 'other', status: 'pending' },
      });
      s.askQuestion(QUESTION);
      s.askQuestion({ ...QUESTION, question: 'And then?' });

      const asked = store.events.filter((e) => e.t === 'question').map((e) => e.request);
      assert.strictEqual(asked[0].toolId, 'toolu_42');
      // Two cards in one place, one of them unanswerable, is worse than one
      // card in the pinned fallback.
      assert.strictEqual(asked[1].toolId, undefined);
    });

    it('keeps two calls announced together in the order they were announced', async function () {
      // A runtime may announce both tool calls in one message before running
      // either. Held in a single slot, the second announcement overwrote the
      // first, the first question claimed the second call's id, and both cards
      // were drawn against the wrong question.
      const { s, store } = session();
      for (const toolId of ['toolu_a', 'toolu_b']) {
        s.ingest({
          t: 'block_start',
          msgId: 'm1',
          index: 0,
          block: { kind: 'tool', toolId, name: ASK_QUESTION_TOOL_NAME, toolKind: 'other', status: 'pending' },
        });
      }

      s.askQuestion({ ...QUESTION, question: 'first?' });
      s.askQuestion({ ...QUESTION, question: 'second?' });

      const asked = store.events.filter((e) => e.t === 'question').map((e) => e.request);
      assert.strictEqual(asked[0].toolId, 'toolu_a');
      assert.strictEqual(asked[1].toolId, 'toolu_b');
    });

    it('does not pair a question with a call left over from an earlier turn', async function () {
      // An announced call that never reached the MCP server would otherwise sit
      // in the queue forever and mispair the next turn's question.
      const { s, store } = session();
      s.ingest({
        t: 'block_start',
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'toolu_stale', name: ASK_QUESTION_TOOL_NAME, toolKind: 'other', status: 'pending' },
      });
      s.ingest({ t: 'turn_end', turnId: 't1' });

      s.askQuestion(QUESTION);
      assert.strictEqual(store.events.find((e) => e.t === 'question').request.toolId, undefined);
    });

    it('keeps the question capability when the runtime introduces itself', function () {
      // Claude's `init` lands after start() returns and replaces the capability
      // record wholesale. Patched only on the session's own copy, the flag was
      // true on the server and false in every browser reading the same log.
      const { s, store } = session();
      s.questionsEnabled = true;
      s.ingest({
        t: 'session',
        capabilities: { streaming: true, permissions: false },
      });

      const announced = store.events.find((e) => e.t === 'session');
      assert.strictEqual(announced.capabilities.questions, true);
      assert.strictEqual(s.capabilities.questions, true);
    });

    it('leaves the capability off for a session that never wired the tool up', function () {
      const { s, store } = session();
      s.ingest({ t: 'session', capabilities: { streaming: true, permissions: false } });
      assert.notStrictEqual(store.events.find((e) => e.t === 'session').capabilities.questions, true);
    });

    it('does not mistake an ordinary tool call for a question', function () {
      const { s, store } = session();
      s.ingest({
        t: 'block_start',
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'toolu_read', name: 'Read', toolKind: 'read', status: 'pending' },
      });
      s.askQuestion(QUESTION);
      assert.strictEqual(store.events.find((e) => e.t === 'question').request.toolId, undefined);
    });

    it('releases a question the interrupted turn was waiting on', async function () {
      const { s } = session();
      s.adapter = {
        alive: true,
        async interrupt() {},
        async stop() {},
        respondPermission() {},
      };
      const waiting = s.askQuestion(QUESTION);

      await s.interrupt();

      const reply = await within(waiting, 'interrupt left the model blocked on a question');
      // An error rather than a skip: the user did not decline to answer, the
      // turn was cancelled underneath the question, and the model should not be
      // told someone considered it and passed.
      assert.match(reply.error, /interrupted/);
    });

    it('releases a question when the session stops', async function () {
      const { s } = session();
      const waiting = s.askQuestion(QUESTION);
      await s.stop();
      const reply = await within(waiting, 'stopping left the model blocked on a question');
      assert.ok(reply.error);
    });

    it('offers a pending question to a browser that rejoins', async function () {
      const { s } = session();
      s.askQuestion(QUESTION);
      const snapshot = await s.snapshot();
      // The acceptance criterion about closing the tab and coming back: the
      // pending question has to ride the snapshot or the card never returns.
      assert.strictEqual(snapshot.pendingQuestions.length, 1);
      assert.strictEqual(snapshot.pendingQuestions[0].question, QUESTION.question);
    });
  });

  describe('the transcript reducer', function () {
    const seq = (() => {
      let n = 0;
      return () => (n += 1);
    })();

    function apply(state, event) {
      applyChatEvent(state, { seq: seq(), ts: Date.now(), ...event });
      return state;
    }

    it('holds a question until it is answered, and says the session is waiting', function () {
      const state = createTranscript({});
      apply(state, {
        t: 'question',
        request: { requestId: 'q1', toolId: 't1', question: 'Which?', multiSelect: false, options: [{ optionId: 'opt-0', label: 'A' }], ts: 1 },
      });

      assert.strictEqual(state.pendingQuestions.length, 1);
      assert.strictEqual(state.state, 'awaiting_answer');

      apply(state, { t: 'question_resolved', requestId: 'q1', toolId: 't1', optionIds: ['opt-0'] });
      assert.strictEqual(state.pendingQuestions.length, 0);
      // Keyed by the call that asked, because that is all the card drawn from a
      // tool block knows once the request itself is gone.
      assert.deepStrictEqual(state.answeredQuestions.t1, ['opt-0']);
    });

    it('records a skip as answered-with-nothing, not as unanswered', function () {
      const state = createTranscript({});
      apply(state, {
        t: 'question',
        request: { requestId: 'q2', toolId: 't2', question: 'Which?', multiSelect: false, options: [], ts: 1 },
      });
      apply(state, { t: 'question_resolved', requestId: 'q2', toolId: 't2', optionIds: [], skipped: true });

      // An empty array and `undefined` mean different things to the card: one
      // draws "skipped", the other draws buttons.
      assert.deepStrictEqual(state.answeredQuestions.t2, []);
    });

    it('drops the cards when the conversation is cleared', function () {
      // The card is drawn against a tool block. `/clear` empties the transcript,
      // so a card left behind would hang off a message that is no longer there —
      // and answering it would reach a turn that no longer exists.
      const state = createTranscript({});
      apply(state, {
        t: 'question',
        request: { requestId: 'q4', toolId: 't4', question: 'Which?', multiSelect: false, options: [], ts: 1 },
      });
      apply(state, { t: 'question_resolved', requestId: 'q4', toolId: 't4', optionIds: [] });
      apply(state, {
        t: 'question',
        request: { requestId: 'q5', toolId: 't5', question: 'And now?', multiSelect: false, options: [], ts: 1 },
      });

      apply(state, { t: 'marker', kind: 'cleared' });
      assert.deepStrictEqual(state.pendingQuestions, []);
      assert.deepStrictEqual(state.answeredQuestions, {});
    });

    it('does not add the same question twice when a snapshot overlaps the stream', function () {
      const state = createTranscript({});
      const request = { requestId: 'q3', question: 'Which?', multiSelect: false, options: [], ts: 1 };
      apply(state, { t: 'question', request });
      apply(state, { t: 'question', request });
      assert.strictEqual(state.pendingQuestions.length, 1);
    });
  });

  describe('option ids', function () {
    it('are minted the same way on both sides of the wire', function () {
      // The server mints these when the question goes out; the browser mints
      // them again when it rebuilds a card from the tool call in a replayed
      // transcript. If the two ever disagreed by one dropped entry, the tick
      // would land on an option the user did not choose.
      const raw = ['A', { label: 'B', description: 'bee' }, { nonsense: true }, { label: '  ' }, 'C'];
      assert.deepStrictEqual(normalizeQuestionOptions(raw), [
        { optionId: 'opt-0', label: 'A', description: undefined },
        { optionId: 'opt-1', label: 'B', description: 'bee' },
        { optionId: 'opt-2', label: 'C', description: undefined },
      ]);
    });

    it('keep two identically-worded options apart', function () {
      const options = normalizeQuestionOptions(['Yes', 'Yes']);
      assert.notStrictEqual(options[0].optionId, options[1].optionId);
    });

    it('survive a payload that is not a list at all', function () {
      assert.deepStrictEqual(normalizeQuestionOptions('nope'), []);
      assert.deepStrictEqual(normalizeQuestionOptions(undefined), []);
    });
  });

  describe('the runtime handshake', function () {
    it('hands the runtime an inline server rather than editing the user’s MCP config', function () {
      const config = JSON.parse(askMcpConfig('/opt/app/ask-mcp.js', '/tmp/s.sock'));
      const server = config.mcpServers.ccweb;
      assert.strictEqual(server.command, process.execPath);
      assert.deepStrictEqual(server.args, ['/opt/app/ask-mcp.js']);
      assert.strictEqual(server.env.CCWEB_ASK_SOCKET, '/tmp/s.sock');
    });

    it('knows which runtimes have a verified way to take the server', function () {
      // Only the ones this has actually been watched working on. A runtime that
      // gets a flag nobody has seen it parse is a capability claim with nothing
      // behind it.
      assert.strictEqual(askChannelFor('claude'), 'cli');
      assert.strictEqual(askChannelFor('kimi'), 'protocol');
      assert.strictEqual(askChannelFor('omp'), 'protocol');
      assert.strictEqual(askChannelFor('codex'), undefined);
      assert.strictEqual(askChannelFor('nonesuch'), undefined);
    });

    it('matches the namespaced name a runtime reports the call under', function () {
      // What the transcript actually contains, and therefore what the UI has to
      // match on to draw a card instead of a generic tool row.
      assert.ok(isAskQuestionTool('mcp__ccweb__ask_user_question'));
      // One underscore, not two. This is how omp reports the very same tool,
      // and an exact-name table would have silently failed for it while
      // passing for Claude.
      assert.ok(isAskQuestionTool('mcp__ccweb_ask_user_question'));
      assert.ok(isAskQuestionTool(ASK_TOOL_DEFINITION.name));
      assert.ok(!isAskQuestionTool('Bash'));
      assert.ok(!isAskQuestionTool(undefined));
    });

    it('does not mistake a runtime’s own ask-the-user tool for this one', function () {
      // kimi ships a native `AskUserQuestion`, and in a headless ACP session it
      // answers itself with "user dismissed" without anyone being asked. It must
      // not be matched here: this app can neither auto-approve it (that rule
      // exists because *our* tool is unanswerable behind an approval) nor draw a
      // card for it (there is no pending question to answer, so the card would
      // render as already-answered with no answer in it).
      assert.ok(!isAskQuestionTool('AskUserQuestion'));
      assert.ok(!looksLikeAskCall('AskUserQuestion', { questions: [{ question: 'Tabs or spaces?' }] }));
      assert.strictEqual(askedQuestionFrom({ questions: [{ question: 'Tabs or spaces?' }] }), null);
    });

    it('recognises a call an ACP agent renamed past recognition', function () {
      // ACP has no tool-name field: the adapter uses the agent's own title for
      // the block, so the name is prose. The real name turns up in the
      // arguments instead, which is why those are consulted too.
      const rawInput = {
        path: 'xd://mcp__ccweb_ask_user_question',
        content: JSON.stringify({ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }),
      };
      assert.ok(!isAskQuestionTool('Asking tabs vs spaces preference'));
      assert.ok(looksLikeAskCall('Asking tabs vs spaces preference', rawInput));
      assert.ok(!looksLikeAskCall('Reading a file', { path: '/etc/hosts' }));
    });

    it('reads the question back out of either shape a runtime reports', function () {
      const direct = askedQuestionFrom({
        question: 'Tabs or spaces?',
        header: 'Indent',
        multiSelect: true,
        options: [{ label: 'Tabs' }, { label: 'Spaces', description: 'wider' }],
      });
      assert.strictEqual(direct.question, 'Tabs or spaces?');
      assert.strictEqual(direct.multiSelect, true);
      assert.strictEqual(direct.options[1].description, 'wider');

      // omp's envelope: the arguments arrive as a JSON string beside a path.
      const wrapped = askedQuestionFrom({
        path: 'xd://mcp__ccweb_ask_user_question',
        content: JSON.stringify({ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }),
      });
      assert.strictEqual(wrapped.question, 'Tabs or spaces?');
      assert.deepStrictEqual(wrapped.options.map((o) => o.label), ['Tabs', 'Spaces']);
      assert.strictEqual(wrapped.multiSelect, false);
    });

    it('reads nothing out of a call that is not a question', function () {
      assert.strictEqual(askedQuestionFrom(undefined), null);
      assert.strictEqual(askedQuestionFrom('nope'), null);
      assert.strictEqual(askedQuestionFrom({ question: 'no options?' }), null);
      assert.strictEqual(askedQuestionFrom({ content: 'not json' }), null);
    });

    it('accepts bare string options in the tool schema', function () {
      // omp's model sent `["Tabs","Spaces"]`, the call was rejected by schema
      // validation before it ever reached this server, and it burned a round
      // trip retrying. The shape was always understood; only the schema objected.
      const item = ASK_TOOL_DEFINITION.inputSchema.properties.options.items;
      assert.ok(Array.isArray(item.anyOf), 'options items should accept more than one shape');
      assert.ok(item.anyOf.some((shape) => shape.type === 'string'));
      assert.ok(item.anyOf.some((shape) => shape.type === 'object'));
    });
  });

  describe('over the real socket', function () {
    let broker = null;
    let root = '';

    beforeEach(function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'askbroker-'));
    });

    afterEach(function () {
      if (broker) broker.close();
      broker = null;
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** Speak MCP to the real spawned server, exactly as a runtime would. */
    function runServer(socketPath, calls) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [ASK_SERVER], {
          env: { ...process.env, CCWEB_ASK_SOCKET: socketPath },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const replies = [];
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf('\n')) !== -1) {
            replies.push(JSON.parse(buffer.slice(0, at)));
            buffer = buffer.slice(at + 1);
            if (replies.length === calls.length) {
              child.kill();
              resolve(replies);
            }
          }
        });
        for (const call of calls) child.stdin.write(`${JSON.stringify(call)}\n`);
      });
    }

    it('carries a question out and an answer back through the spawned server', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const seen = [];
      const socketPath = await broker.listen({
        permission: async () => ({ allow: false }),
        question: async (ask) => {
          seen.push(ask);
          return { labels: ['Patch it'] };
        },
      });

      const [reply] = await within(
        runServer(socketPath, [
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user_question', arguments: QUESTION } },
        ]),
        'the spawned MCP server never answered',
        5000,
      );

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].question, QUESTION.question);
      assert.match(reply.result.content[0].text, /Patch it/);
    });

    it('keeps two questions on one socket apart', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({
        permission: async () => ({ allow: false }),
        // Answered out of order on purpose: the socket is per session, not per
        // call, so a reply that could not be matched to its own question would
        // hand the model somebody else's answer.
        question: async (ask) =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ labels: [`answer to ${ask.question}`] }), ask.question === 'first?' ? 120 : 10),
          ),
      });

      const replies = await within(
        runServer(socketPath, [
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user_question', arguments: { question: 'first?', options: ['a'] } } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user_question', arguments: { question: 'second?', options: ['a'] } } },
        ]),
        'the spawned MCP server never answered both',
        5000,
      );

      const byId = new Map(replies.map((r) => [r.id, r.result.content[0].text]));
      assert.match(byId.get(1), /answer to first\?/);
      assert.match(byId.get(2), /answer to second\?/);
    });

    it('tells the model to ask in prose when the session socket is gone', async function () {
      const [reply] = await within(
        runServer(path.join(root, 'nothing-here.sock'), [
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user_question', arguments: QUESTION } },
        ]),
        'a dead socket left the model blocked forever',
        5000,
      );
      // The one thing that must never happen here is silence.
      assert.strictEqual(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /plain text/i);
    });
  });
});
