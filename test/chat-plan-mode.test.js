const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { ChatSession } = require('../dist/server/chat/session.js');
const { ChatStore } = require('../dist/server/chat/store.js');
const {
  SUBMIT_PLAN_TOOL,
  acceptedPlanDirective,
} = require('../dist/shared/chat-events.js');
const { serveAsk } = require('../dist/server/chat/ask-mcp.js');

const CAPABILITIES = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  questions: true,
  planMode: true,
  interrupt: true,
  resume: true,
  fork: false,
  attachments: false,
  usage: true,
  cost: false,
  plan: false,
};

function memoryStore() {
  const events = [];
  let plan = null;
  return {
    events,
    get plan() { return plan; },
    append(_ref, batch) { events.push(...batch); },
    async stat() { return { firstSeq: 1, cursor: events.length }; },
    async read() { return { events: [], firstSeq: 1, from: 1, cursor: events.length }; },
    async snapshot() {
      return {
        sessionId: 'plan-s1', runtime: 'claude', messages: [], state: 'idle',
        capabilities: CAPABILITIES, pendingPermissions: [], pendingQuestions: [],
        firstSeq: 1, replayFrom: 1, cursor: events.length, live: true,
        bypassPermissions: false,
      };
    },
    async setPlanDocument(_ref, document) { plan = { ...document }; },
    async planDocument() { return plan ? { ...plan } : null; },
    async clearPlanDocument() { plan = null; },
  };
}

function fixture() {
  const store = memoryStore();
  const sent = [];
  const broadcasts = [];
  const session = new ChatSession(
    { id: 'plan-s1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-')),
      hookScript: path.join(__dirname, 'missing-hook.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => 'claude',
    },
  );
  session.adapter = {
    alive: true,
    readyForTurn: true,
    capabilities: CAPABILITIES,
    async send(turn) { sent.push(turn); },
    async start() {},
    async stop() {},
    async interrupt() {},
    respondPermission() {},
  };
  session.state = 'idle';
  session.capabilities = CAPABILITIES;
  session.planEnabled = true;
  session.lastStartOptions = { runtime: 'claude', workingDir: process.cwd() };
  return { session, store, sent, broadcasts };
}

async function eventually(test, message, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

describe('Web-chat Plan mode', function () {
  it('changes only while idle, and switching off retains the latest document', async function () {
    const { session, store } = fixture();
    assert.strictEqual((await session.setPlanMode(true)).changed, true);
    assert.strictEqual((await session.submitPlan({ markdown: '# First' })).accepted, true);

    session.state = 'running';
    const busy = await session.setPlanMode(false);
    assert.strictEqual(busy.changed, false);
    assert.strictEqual(busy.planMode, true);

    session.state = 'idle';
    const off = await session.setPlanMode(false);
    assert.strictEqual(off.planMode, false);
    assert.strictEqual(store.plan.markdown, '# First');
  });

  it('stores complete numbered revisions and rejects empty, oversized, or off-mode submissions', async function () {
    const { session, store } = fixture();
    assert.strictEqual((await session.submitPlan({ markdown: '# No' })).accepted, false);
    await session.setPlanMode(true);
    assert.strictEqual((await session.submitPlan({ markdown: '  ' })).accepted, false);
    assert.strictEqual((await session.submitPlan({ markdown: 'x'.repeat(200001) })).accepted, false);
    assert.strictEqual((await session.submitPlan({ markdown: '# One' })).revision, 1);
    assert.strictEqual((await session.submitPlan({ markdown: '# Two' })).revision, 2);
    assert.strictEqual(store.plan.markdown, '# Two');
  });

  it('accepts only the latest revision and starts an internal implementation turn', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '## Steps\n\n- edit\n- test' });
    await session.submitPlan({ markdown: '## Revised\n\n- test first' });

    const stale = await session.acceptPlan(1);
    assert.strictEqual(stale.accepted, false);
    assert.strictEqual(sent.length, 0);
    const accepted = await session.acceptPlan(2);
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.planMode, false);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].text, acceptedPlanDirective(store.plan));
    assert.ok(!store.events.some((event) => event.t === 'msg_start' && event.role === 'user'));
  });

  it('serializes acceptance behind an in-flight revision save', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);
    const write = store.setPlanDocument.bind(store);
    let release;
    let writing = false;
    const gate = new Promise((resolve) => { release = resolve; });
    store.setPlanDocument = async (...args) => {
      writing = true;
      await gate;
      return write(...args);
    };

    const submitting = session.submitPlan({ markdown: '# Racing revision' });
    await eventually(() => writing, 'the plan save did not begin');
    const accepting = session.acceptPlan(1);
    release();

    assert.strictEqual((await submitting).accepted, true);
    assert.strictEqual((await accepting).accepted, true);
    assert.strictEqual(sent.length, 1);
  });

  it('records implementation events after accepting from a resumed runtime', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '# Resume safely' });
    session.replaying = true;
    session.adapter.send = async (turn) => {
      sent.push(turn);
      session.ingest({ t: 'msg_start', id: 'implementation', role: 'assistant', turnId: 'accepted' });
      session.ingest({ t: 'block_start', msgId: 'implementation', index: 0, block: { kind: 'text', text: 'Working' } });
      session.ingest({ t: 'msg_end', msgId: 'implementation' });
      session.ingest({ t: 'turn_end', turnId: 'accepted' });
    };

    assert.strictEqual((await session.acceptPlan(1)).accepted, true);
    assert.strictEqual(session.replaying, false);
    assert.ok(store.events.some((event) => event.t === 'msg_start' && event.id === 'implementation'));
  });

  it('waits until a one-shot adapter is actually ready before implementing', async function () {
    const { session, sent } = fixture();
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '# Wait for child exit' });
    session.adapter.readyForTurn = false;
    setTimeout(() => { session.adapter.readyForTurn = true; }, 25);

    const accepted = await session.acceptPlan(1);
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(sent.length, 1);
  });

  it('does not restore an old Plan mode when a fresh conversation wins the readiness race', async function () {
    const { session } = fixture();
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '# Superseded' });
    session.adapter.readyForTurn = false;

    const accepting = session.acceptPlan(1);
    await eventually(() => session.currentState === 'thinking', 'Accept did not begin waiting');
    session.planGeneration += 1;
    session.planMode = false;
    session.adapter.alive = false;

    const result = await accepting;
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.planMode, false);
    assert.strictEqual(session.planMode, false);
  });

  it('keeps the fallback questionnaire available during accepted implementation', async function () {
    const { session, sent } = fixture();
    session.questionFallbackEnabled = true;
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '# Ask if needed' });

    assert.strictEqual((await session.acceptPlan(1)).accepted, true);
    assert.match(sent[0].text, /Interactive-question fallback/);
    assert.match(sent[0].text, /accepted Plan revision 1/i);
  });

  it('rejects the latest revision without leaving Plan mode or deleting it', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);
    await session.submitPlan({ markdown: '# Keep me' });

    const rejected = await session.rejectPlan(1);
    assert.strictEqual(rejected.accepted, true);
    assert.strictEqual(rejected.planMode, true);
    assert.strictEqual(store.plan.markdown, '# Keep me');
    assert.strictEqual(sent.length, 0);
  });

  it('captures ordinary final markdown as the plan when no tool is called', async function () {
    const { session, store } = fixture();
    await session.setPlanMode(true);
    session.ingest({ t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' });
    session.ingest({ t: 'block_start', msgId: 'a1', index: 0, block: { kind: 'text', text: '# Fallback plan' } });
    session.ingest({ t: 'msg_end', msgId: 'a1' });
    session.ingest({ t: 'turn_end', turnId: 't1' });

    await eventually(() => store.plan?.markdown === '# Fallback plan', 'fallback plan was not stored');
    assert.strictEqual(store.plan.revision, 1);
  });

  it('keeps Plan mode on and explains how to retry when a turn submits no usable plan', async function () {
    const { session, store } = fixture();
    await session.setPlanMode(true);
    session.ingest({ t: 'turn_end', turnId: 'empty-plan-turn', stopReason: 'end_turn' });

    await eventually(
      () => store.events.some((event) => event.t === 'error' && /without a reviewable plan/.test(event.message)),
      'the missing-plan failure was not explained',
    );
    assert.strictEqual(session.planMode, true);
    assert.strictEqual(store.plan, null);
    assert.ok(store.events.some((event) => event.t === 'error' && /send another planning message to retry/.test(event.message)));
  });

  it('does not call an interrupted half-turn a missing plan', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);
    session.state = 'running';
    await session.send({ text: 'wait behind the redirected turn' });
    session.turnInFlightId = 'planning-turn';
    session.staleTurnEndUntil = Date.now() + 1_000;
    session.ingest({ t: 'turn_end', turnId: 'planning-turn', stopReason: 'error_during_execution' });

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(store.events.some((event) => event.t === 'turn_end' && event.stale === true));
    assert.ok(!store.events.some((event) => event.t === 'error' && /without a reviewable plan/.test(event.message)));
    assert.strictEqual(session.currentState, 'running', 'a stale acknowledgement does not make the server idle');
    assert.strictEqual(sent.length, 0, 'queued work must remain behind the redirected turn');
  });

  it('turns the structured no-MCP fallback into the same durable question flow', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    const envelope = '<ccweb-question>{"question":"Which path?","header":"Path","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a2', role: 'assistant', turnId: 't2' });
    session.ingest({ t: 'block_start', msgId: 'a2', index: 0, block: { kind: 'text', text: envelope } });
    session.ingest({ t: 'msg_end', msgId: 'a2' });
    session.ingest({ t: 'turn_end', turnId: 't2' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'fallback question was not recorded');
    const request = store.events.find((event) => event.t === 'question').request;
    assert.strictEqual(session.answerQuestion(request.requestId, ['opt-1']), true);
    await eventually(() => sent.length === 1, 'fallback answer was not continued');
    assert.match(sent[0].text, /Selected: B/);
    assert.match(sent[0].text, /Interactive-question fallback/);
    assert.ok(store.events.some((event) => event.t === 'question_resolved'));
    assert.ok(
      !store.events.some((event) => JSON.stringify(event).includes('<ccweb-question>')),
      'the private fallback envelope must not become transcript history',
    );
  });

  it('does not let a queued turn overtake a fallback question', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    session.state = 'running';
    await session.send({ text: 'queued behind the answer' });
    const envelope = '<ccweb-question>{"question":"First?","options":[{"label":"Yes"},{"label":"No"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a3', role: 'assistant', turnId: 't3' });
    session.ingest({ t: 'block_start', msgId: 'a3', index: 0, block: { kind: 'text', text: envelope } });
    session.ingest({ t: 'msg_end', msgId: 'a3' });
    session.ingest({ t: 'turn_end', turnId: 't3' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'fallback question was not opened');
    assert.strictEqual(sent.length, 0, 'the queued user turn must remain behind the unanswered question');
  });

  it('does not restart a runtime when Stop settles a fallback question', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    const envelope = '<ccweb-question>{"question":"Stop here?","options":[{"label":"Yes"},{"label":"No"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-stop', role: 'assistant', turnId: 't-stop' });
    session.ingest({ t: 'block_start', msgId: 'a-stop', index: 0, block: { kind: 'text', text: envelope } });
    session.ingest({ t: 'msg_end', msgId: 'a-stop' });
    session.ingest({ t: 'turn_end', turnId: 't-stop' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'fallback question was not opened');
    await session.interrupt();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(sent.length, 0, 'Stop must not launch an internal answer continuation');
    assert.strictEqual(session.currentState, 'idle');
    assert.ok(store.events.some((event) => event.t === 'question_resolved' && event.abandoned === true));
  });

  it('blocks opaque runtime commands while Plan mode is on', async function () {
    const { session, store, sent } = fixture();
    await session.setPlanMode(true);

    await session.send({ text: '/review and fix everything' });

    assert.strictEqual(sent.length, 0);
    assert.ok(store.events.some((event) => event.t === 'error' && /was not run because Plan mode/.test(event.message)));
    assert.ok(store.events.some((event) => event.t === 'turn_end' && event.stopReason === 'blocked'));
  });

  it('persists its sidecar across store instances and removes it with the chat', async function () {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-store-'));
    const ref = { id: 'persisted-plan', ownerUserId: 5 };
    const first = new ChatStore({ storageDir });
    await first.setPlanDocument(ref, { markdown: '# Durable', revision: 3, ts: 9 });
    const second = new ChatStore({ storageDir });
    assert.deepStrictEqual(await second.planDocument(ref), { markdown: '# Durable', revision: 3, ts: 9 });
    await second.deleteChat(ref);
    assert.strictEqual(await first.planDocument(ref), null);
  });

  it('propagates a Plan clear failure instead of claiming the document disappeared', async function () {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-clear-failure-'));
    const ref = { id: 'uncleared-plan', ownerUserId: 5 };
    const store = new ChatStore({ storageDir });
    await store.setPlanDocument(ref, { markdown: '# Must remain visible', revision: 1, ts: 1 });
    const remove = fs.promises.rm;
    fs.promises.rm = async (target, options) => {
      if (String(target).endsWith('.plan')) throw new Error('read-only storage');
      return remove(target, options);
    };
    try {
      await assert.rejects(store.clearPlanDocument(ref), /read-only storage/);
    } finally {
      fs.promises.rm = remove;
    }
    assert.deepStrictEqual(await store.planDocument(ref), {
      markdown: '# Must remain visible', revision: 1, ts: 1,
    });
  });

  it('offers submit_plan over the dedicated MCP server and waits for persistence', async function () {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = [];
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      for (const line of chunk.trim().split('\n')) if (line) replies.push(JSON.parse(line));
    });
    const plans = [];
    serveAsk(
      input,
      output,
      async () => ({ labels: [] }),
      undefined,
      undefined,
      async (markdown) => {
        plans.push(markdown);
        return { accepted: true, revision: 4, detail: 'Plan saved as revision 4.' };
      },
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    await eventually(() => replies.length === 1, 'tools/list did not answer');
    assert.ok(replies[0].result.tools.some((tool) => tool.name === SUBMIT_PLAN_TOOL));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: SUBMIT_PLAN_TOOL, arguments: { markdown: '# MCP' } } })}\n`);
    await eventually(() => replies.length === 2, 'submit_plan did not answer');
    assert.deepStrictEqual(plans, ['# MCP']);
    assert.strictEqual(replies[1].result.isError, false);
  });
});
