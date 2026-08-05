const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { ChatSession } = require('../dist/server/chat/session.js');
const { ChatStore } = require('../dist/server/chat/store.js');
const safeSessionFiles = require('../dist/server/services/safe-session-file.js');
const registry = require('../dist/server/chat/registry.js');
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

function memoryStore({ pendingQuestions = [] } = {}) {
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
        capabilities: CAPABILITIES, pendingPermissions: [], pendingQuestions: [...pendingQuestions],
        firstSeq: 1, replayFrom: 1, cursor: events.length, live: true,
        bypassPermissions: false,
      };
    },
    async setPlanDocument(_ref, document) { plan = { ...document }; },
    async planDocument() { return plan ? { ...plan } : null; },
    async clearPlanDocument() { plan = null; },
  };
}

function fixture(options = {}) {
  const store = memoryStore(options);
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
    if (await test()) return;
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
    const envelope = '<ccweb-question>{"version":1,"question":"Which path?","header":"Path","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a2', role: 'assistant', turnId: 't2' });
    session.ingest({ t: 'block_start', msgId: 'a2', index: 0, block: { kind: 'text', text: envelope } });
    session.ingest({ t: 'msg_end', msgId: 'a2' });
    session.ingest({ t: 'turn_end', turnId: 't2' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'fallback question was not recorded');
    const request = store.events.find((event) => event.t === 'question').request;
    assert.strictEqual(request.origin, 'structured_handoff');
    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-1']), true);
    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), false);
    await eventually(() => sent.length === 1, 'fallback answer was not continued');
    assert.match(sent[0].text, /Selected: B/);
    assert.match(sent[0].text, /Interactive-question fallback/);
    assert.ok(store.events.some((event) => event.t === 'question_resolved'));
    assert.ok(
      !store.events.some((event) => JSON.stringify(event).includes('<ccweb-question>')),
      'the private fallback envelope must not become transcript history',
    );
  });

  it('waits for a one-shot child to finish exiting before continuing an accepted answer', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    session.adapter.readyForTurn = false;
    session.adapter.send = async function (turn) {
      if (!this.readyForTurn) throw new Error('one-shot child still exiting');
      sent.push(turn);
    };
    const envelope = '<ccweb-question>{"version":1,"question":"Continue where?","options":[{"label":"Here"},{"label":"There"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-ready', role: 'assistant', turnId: 't-ready' });
    session.ingest({
      t: 'block_start', msgId: 'a-ready', index: 0,
      block: { kind: 'text', text: envelope },
    });
    session.ingest({ t: 'msg_end', msgId: 'a-ready' });
    session.ingest({ t: 'turn_end', turnId: 't-ready' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'question was not opened');
    const request = store.events.find((event) => event.t === 'question').request;
    setTimeout(() => { session.adapter.readyForTurn = true; }, 25);

    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), true);
    await eventually(() => sent.length === 1, 'answer was lost while the one-shot child exited');
    assert.match(sent[0].text, /Selected: Here/);
    assert.ok(!store.events.some((event) => /still exiting/.test(event.message || '')));
  });

  it('does not send a readiness-waiting continuation after Stop wins', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    session.adapter.readyForTurn = false;
    const envelope = '<ccweb-question>{"version":1,"question":"Wait here?","options":[{"label":"Yes"},{"label":"No"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-stop-ready', role: 'assistant', turnId: 't-stop-ready' });
    session.ingest({
      t: 'block_start', msgId: 'a-stop-ready', index: 0,
      block: { kind: 'text', text: envelope },
    });
    session.ingest({ t: 'msg_end', msgId: 'a-stop-ready' });
    session.ingest({ t: 'turn_end', turnId: 't-stop-ready' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'question was not opened');
    const request = store.events.find((event) => event.t === 'question').request;
    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), true);
    await eventually(() => session.currentState === 'thinking', 'continuation did not begin waiting');
    await session.interrupt();
    session.adapter.readyForTurn = true;
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.strictEqual(sent.length, 0, 'Stop must invalidate a continuation before it reaches the runtime');
    assert.strictEqual(session.currentState, 'idle');
    assert.ok(store.events.some((event) => (
      event.t === 'question_continuation' && event.outcome === 'abandoned'
    )));
  });

  it('returns a durable claim to pending when preserving Stop wins before send', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-presend-stop-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-presend-stop', ownerUserId: 7 };
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const sent = [];
    const first = new ChatSession(ref, deps);
    first.adapter = {
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    };

    const append = store.append.bind(store);
    let releaseMarker;
    let rejectWithdrawal;
    let delayedMarker = false;
    let rejectedWithdrawal = false;
    store.append = async (sessionRef, batch) => {
      if (
        !rejectedWithdrawal
        && batch.some((event) => event.t === 'question_continuation_pending')
      ) {
        rejectedWithdrawal = true;
        await new Promise((_, reject) => { rejectWithdrawal = reject; });
      }
      await append(sessionRef, batch);
      if (
        !delayedMarker
        && batch.some((event) => event.t === 'question_continuation_dispatching')
      ) {
        delayedMarker = true;
        await new Promise((resolve) => { releaseMarker = resolve; });
      }
    };

    const realFactory = registry.createChatAdapter;
    registry.createChatAdapter = (runtime) => ({
      runtime,
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    });

    try {
      assert.strictEqual(await first.openHandoffQuestion({
        question: 'Should this survive the shutdown race?',
        options: ['Yes', 'No'],
      }), null);
      const [request] = (await first.snapshot()).pendingQuestions;
      assert.strictEqual(await first.answerQuestion(request.requestId, ['opt-0']), true);
      await eventually(() => typeof releaseMarker === 'function', 'dispatch marker did not begin');

      const stopping = first.stop({ preserveHandoffs: true });
      await new Promise((resolve) => setImmediate(resolve));
      releaseMarker();
      await eventually(() => typeof rejectWithdrawal === 'function', 'withdrawal write did not begin');
      first.ingest({ t: 'state', state: 'running' });
      rejectWithdrawal(new Error('injected first withdrawal failure'));
      await stopping;
      assert.strictEqual(sent.length, 0, 'Stop won before adapter.send and must keep that fact');
      assert.strictEqual(rejectedWithdrawal, true, 'the shutdown path did not exercise its retry');
      let snapshot = await store.snapshot(ref);
      assert.strictEqual(snapshot.pendingQuestionContinuations.length, 1);
      assert.strictEqual(snapshot.pendingQuestionContinuations[0].dispatching, undefined);
      const beforeResume = await store.read(ref, 1, 10_000);
      assert.deepStrictEqual(
        beforeResume.events.map((event) => event.seq),
        Array.from({ length: beforeResume.cursor }, (_, index) => index + 1),
        'a failed durable withdrawal must not let a raw adapter event create a sequence gap',
      );

      const resumed = new ChatSession(ref, deps);
      await resumed.start({
        runtime: 'claude', workingDir: root, bypassPermissions: true,
        planMode: false, resumeSessionId: 'native-presend-stop',
      });
      await eventually(() => sent.length === 1, 'the known-unsent answer did not resume');
      await eventually(async () => {
        snapshot = await store.snapshot(ref);
        return snapshot.pendingQuestionContinuations.length === 0;
      }, 'the resumed outbox did not close');
      await resumed.stop();
    } finally {
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets an already accepted runtime send commit before graceful shutdown', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    let releaseSend;
    let sendStarted = false;
    session.adapter.send = async (turn) => {
      sent.push(turn);
      sendStarted = true;
      await new Promise((resolve) => { releaseSend = resolve; });
    };
    assert.strictEqual(await session.openHandoffQuestion({
      question: 'Was this handed over?',
      options: ['Yes', 'No'],
    }), null);
    const request = store.events.find((event) => event.t === 'question').request;
    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), true);
    await eventually(() => sendStarted, 'the continuation never crossed the send gate');

    let stopped = false;
    const stopping = session.stop({ preserveHandoffs: true }).then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(stopped, false, 'shutdown must not race adapter.send');
    releaseSend();
    await stopping;

    assert.strictEqual(sent.length, 1);
    assert.ok(store.events.some((event) => (
      event.t === 'question_continuation' && event.outcome === 'delivered'
    )));
    assert.strictEqual((await session.snapshot()).pendingQuestionContinuations.length, 0);
  });

  it('publishes and accepts handoff transitions only after their store writes finish', async function () {
    const { session, store, broadcasts } = fixture();
    session.questionFallbackEnabled = true;
    const append = store.append.bind(store);
    let releaseQuestion;
    let releaseResolution;
    store.append = (ref, batch) => {
      append(ref, batch);
      if (batch.some((event) => event.t === 'question')) {
        return new Promise((resolve) => { releaseQuestion = resolve; });
      }
      if (batch.some((event) => event.t === 'question_resolved')) {
        return new Promise((resolve) => { releaseResolution = resolve; });
      }
      return undefined;
    };

    const envelope = '<ccweb-question>{"version":1,"question":"Persist first?","options":[{"label":"Yes"},{"label":"No"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-durable', role: 'assistant', turnId: 't-durable' });
    session.ingest({
      t: 'block_start', msgId: 'a-durable', index: 0,
      block: { kind: 'text', text: envelope },
    });
    session.ingest({ t: 'msg_end', msgId: 'a-durable' });
    session.ingest({ t: 'turn_end', turnId: 't-durable' });

    await eventually(() => typeof releaseQuestion === 'function', 'question write did not start');
    assert.ok(
      !broadcasts.some((message) => message.event?.t === 'question'),
      'a card must not be broadcast before its restart record exists',
    );
    releaseQuestion();
    await eventually(
      () => broadcasts.some((message) => message.event?.t === 'question'),
      'durable question was not broadcast',
    );

    const request = store.events.find((event) => event.t === 'question').request;
    let settled = false;
    const answering = session.answerQuestion(request.requestId, ['opt-0']).then((accepted) => {
      settled = true;
      return accepted;
    });
    await eventually(() => typeof releaseResolution === 'function', 'resolution write did not start');
    assert.strictEqual(settled, false, 'the answer must not be accepted before durability');
    assert.ok(
      !broadcasts.some((message) => message.event?.t === 'question_resolved'),
      'the canonical answer must not be broadcast before durability',
    );
    releaseResolution();
    assert.strictEqual(await answering, true);
    assert.ok(broadcasts.some((message) => message.event?.t === 'question_resolved'));
  });

  it('serializes an in-flight durable open ahead of Stop', async function () {
    const { session, store, broadcasts } = fixture();
    session.questionFallbackEnabled = true;
    const append = store.append.bind(store);
    let releaseQuestion;
    store.append = (ref, batch) => {
      append(ref, batch);
      if (batch.some((event) => event.t === 'question')) {
        return new Promise((resolve) => { releaseQuestion = resolve; });
      }
      return undefined;
    };

    const opening = session.openHandoffQuestion({
      question: 'Can Stop race this?',
      options: ['Yes', 'No'],
    });
    await eventually(() => typeof releaseQuestion === 'function', 'question write did not begin');
    const stopping = session.stop();
    releaseQuestion();
    assert.strictEqual(await opening, null);
    await stopping;

    const lifecycle = store.events.filter((event) => (
      event.t === 'question' || event.t === 'question_resolved'
    ));
    assert.deepStrictEqual(lifecycle.map((event) => event.t), ['question', 'question_resolved']);
    assert.strictEqual(lifecycle[1].requestId, lifecycle[0].request.requestId);
    assert.strictEqual(lifecycle[1].abandoned, true);
    assert.deepStrictEqual(
      broadcasts
        .map((message) => message.event)
        .filter((event) => event?.t === 'question' || event?.t === 'question_resolved')
        .map((event) => event.t),
      ['question', 'question_resolved'],
    );
    assert.strictEqual((await session.snapshot()).pendingQuestions.length, 0);
  });

  it('hides and rejects malformed or unsupported structured envelopes', async function () {
    for (const [id, envelope] of [
      ['version', '<ccweb-question>{"version":2,"question":"Which?","options":["A","B"]}</ccweb-question>'],
      ['json', '<ccweb-question>{not-json}</ccweb-question>'],
      ['open', '<ccweb-question>{"version":1,"question":"Which?"}'],
    ]) {
      const { session, store, sent } = fixture();
      session.questionFallbackEnabled = true;
      session.ingest({ t: 'msg_start', id: `a-${id}`, role: 'assistant', turnId: `t-${id}` });
      session.ingest({
        t: 'block_start', msgId: `a-${id}`, index: 0,
        block: { kind: 'text', text: envelope },
      });
      session.ingest({ t: 'msg_end', msgId: `a-${id}` });
      session.ingest({ t: 'turn_end', turnId: `t-${id}` });

      await eventually(() => sent.length === 1, `${id} envelope was not rejected`);
      assert.ok(!store.events.some((event) => event.t === 'question'));
      assert.ok(!store.events.some((event) => JSON.stringify(event).includes('<ccweb-question>')));
      assert.match(sent[0].text, /could not be delivered/i);
    }
  });

  it('accepts an unversioned in-flight envelope as legacy version 1', async function () {
    const { session, store } = fixture();
    session.questionFallbackEnabled = true;
    const envelope = '<ccweb-question>{"question":"Legacy choice?","options":[{"label":"A"},{"label":"B"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-legacy', role: 'assistant', turnId: 't-legacy' });
    session.ingest({
      t: 'block_start', msgId: 'a-legacy', index: 0,
      block: { kind: 'text', text: envelope },
    });
    session.ingest({ t: 'msg_end', msgId: 'a-legacy' });
    session.ingest({ t: 'turn_end', turnId: 't-legacy' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'legacy envelope was not accepted');
    assert.strictEqual(store.events.find((event) => event.t === 'question').request.question, 'Legacy choice?');
    await session.interrupt();
  });

  it('rehydrates an arbitrarily old handoff and continues it exactly once', async function () {
    const pending = {
      requestId: 'ask-before-restart',
      origin: 'structured_handoff',
      question: 'Which persisted path?',
      multiSelect: false,
      options: [
        { optionId: 'opt-0', label: 'First' },
        { optionId: 'opt-1', label: 'Second' },
      ],
      ts: 1,
    };
    const { session, store, sent } = fixture({ pendingQuestions: [pending] });

    assert.strictEqual(await session.restorePendingQuestions(true), true);
    session.state = 'awaiting_answer';
    assert.strictEqual(await session.answerQuestion(pending.requestId, ['opt-1']), true);
    assert.strictEqual(await session.answerQuestion(pending.requestId, ['opt-0']), false);

    await eventually(() => sent.length === 1, 'the restored answer was not continued');
    assert.match(sent[0].text, /Selected: Second/);
    assert.strictEqual(
      store.events.filter((event) => event.t === 'question_resolved' && event.requestId === pending.requestId).length,
      1,
    );
  });

  it('rehydrates a handoff from the real store after a server-style restart', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-restart-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-restart', ownerUserId: 7 };
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const first = new ChatSession(ref, deps);
    first.adapter = {
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send() {},
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    };
    first.openHandoffQuestion({ question: 'Resume this?', options: ['Yes', 'No'] });
    await first.stop({ preserveHandoffs: true });
    assert.strictEqual((await store.snapshot(ref)).pendingQuestions.length, 1);

    const sent = [];
    const realFactory = registry.createChatAdapter;
    registry.createChatAdapter = (runtime) => ({
      runtime,
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    });
    const resumed = new ChatSession(ref, deps);
    try {
      await resumed.start({
        runtime: 'claude', workingDir: root, bypassPermissions: true,
        planMode: false, resumeSessionId: 'native-resume-id',
      });
      const [request] = (await resumed.snapshot()).pendingQuestions;
      assert.strictEqual(resumed.currentState, 'awaiting_answer');
      assert.strictEqual(request.origin, 'structured_handoff');
      assert.strictEqual(await resumed.answerQuestion(request.requestId, ['opt-0']), true);
      assert.strictEqual(await resumed.answerQuestion(request.requestId, ['opt-1']), false);
      await eventually(() => sent.length === 1, 'the post-restart continuation was not sent');
      assert.match(sent[0].text, /Selected: Yes/);
      assert.strictEqual((await store.snapshot(ref)).pendingQuestions.length, 0);
    } finally {
      await resumed.stop();
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers an acknowledged answer outbox across graceful restart exactly once', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-answer-outbox-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-answer-outbox', ownerUserId: 7 };
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const first = new ChatSession(ref, deps);
    first.adapter = {
      alive: true,
      readyForTurn: false,
      capabilities: CAPABILITIES,
      async start() {},
      async send() { throw new Error('must not send before graceful shutdown'); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    };

    const sent = [];
    const realFactory = registry.createChatAdapter;
    registry.createChatAdapter = (runtime) => ({
      runtime,
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    });

    try {
      assert.strictEqual(await first.openHandoffQuestion({
        question: 'Which answer survives?',
        options: ['Durable', 'Ephemeral'],
      }), null);
      const [request] = (await first.snapshot()).pendingQuestions;
      const originalAppendFile = safeSessionFiles.appendSessionFile;
      const indexPath = path.join(root, 'store', '7', `${ref.id}.idx`);
      let injectedIndexFailure = false;
      safeSessionFiles.appendSessionFile = async function (file, ...args) {
        if (!injectedIndexFailure && String(file) === indexPath) {
          injectedIndexFailure = true;
          throw new Error('injected answer index failure');
        }
        return originalAppendFile(file, ...args);
      };
      try {
        assert.strictEqual(await first.answerQuestion(request.requestId, ['opt-0']), true);
      } finally {
        safeSessionFiles.appendSessionFile = originalAppendFile;
      }
      assert.strictEqual(injectedIndexFailure, true);
      await first.stop({ preserveHandoffs: true });

      let snapshot = await store.snapshot(ref);
      assert.strictEqual(snapshot.pendingQuestions.length, 0);
      assert.strictEqual(snapshot.pendingQuestionContinuations.length, 1);
      assert.deepStrictEqual(
        snapshot.pendingQuestionContinuations[0].answer.labels,
        ['Durable'],
      );

      const resumed = new ChatSession(ref, deps);
      await resumed.start({
        runtime: 'claude', workingDir: root, bypassPermissions: true,
        planMode: false, resumeSessionId: 'native-answer-outbox',
      });
      await eventually(() => sent.length === 1, 'the recovered answer was not delivered');
      await eventually(async () => {
        snapshot = await store.snapshot(ref);
        return snapshot.pendingQuestionContinuations.length === 0;
      }, 'the delivered outbox record was not closed');
      assert.match(sent[0].text, /Selected: Durable/);
      await resumed.stop({ preserveHandoffs: true });

      const second = new ChatSession(ref, deps);
      await second.start({
        runtime: 'claude', workingDir: root, bypassPermissions: true,
        planMode: false, resumeSessionId: 'native-answer-outbox',
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.strictEqual(sent.length, 1, 'a terminal outbox must not replay on a second restart');
      await second.stop();
    } finally {
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries only a failed terminal write and keeps later adapter events contiguous', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-terminal-retry-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-terminal-retry', ownerUserId: 7 };
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const sent = [];
    const first = new ChatSession(ref, deps);
    first.adapter = {
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    };

    const append = store.append.bind(store);
    let terminalAttempts = 0;
    let rejectFirstTerminal;
    store.append = (sessionRef, batch) => {
      if (batch.some((event) => event.t === 'question_continuation')) {
        terminalAttempts += 1;
        if (terminalAttempts === 1) {
          return new Promise((_, reject) => { rejectFirstTerminal = reject; });
        }
      }
      return append(sessionRef, batch);
    };

    try {
      assert.strictEqual(await first.openHandoffQuestion({
        question: 'Could this be duplicated?',
        options: ['Never', 'Maybe'],
      }), null);
      const [request] = (await first.snapshot()).pendingQuestions;
      assert.strictEqual(await first.answerQuestion(request.requestId, ['opt-0']), true);
      await eventually(() => sent.length === 1, 'the first dispatch never reached the adapter');
      await eventually(() => typeof rejectFirstTerminal === 'function', 'terminal write did not begin');

      first.ingest({ t: 'state', state: 'running' });
      first.ingest({ t: 'state', state: 'thinking' });
      rejectFirstTerminal(new Error('injected terminal outbox failure'));

      await eventually(async () => (
        (await store.snapshot(ref)).pendingQuestionContinuations.length === 0
      ), 'the safe terminal retry did not close the outbox');
      assert.strictEqual(terminalAttempts, 2);
      assert.strictEqual(sent.length, 1, 'retrying persistence must never resend the runtime turn');
      const replay = await store.read(ref, 1, 10_000);
      assert.deepStrictEqual(
        replay.events.map((event) => event.seq),
        Array.from({ length: replay.cursor }, (_, index) => index + 1),
        'a failed durable event must not leave a sequence hole',
      );
      assert.deepStrictEqual(
        replay.events.slice(-2).map((event) => event.state),
        ['running', 'thinking'],
      );
      await first.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles an ambiguously committed terminal using the exact reserved event', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-terminal-ambiguous-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-terminal-ambiguous', ownerUserId: 7 };
    const broadcasts = [];
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const sent = [];
    const session = new ChatSession(ref, deps);
    session.adapter = {
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    };

    const base = path.join(root, 'store', '7', ref.id);
    const originalStoreAppend = store.append.bind(store);
    const originalAppendFile = safeSessionFiles.appendSessionFile;
    const originalOpen = safeSessionFiles.openSessionFileForRead;
    const originalTruncate = safeSessionFiles.truncateSessionFile;
    const terminalRecords = [];
    let faultStarted = false;
    let releaseIndexFailure;
    let openFailures = 2;
    let truncateFailures = 1;

    store.append = (sessionRef, batch) => {
      const terminal = batch.find((event) => event.t === 'question_continuation');
      if (terminal) terminalRecords.push(JSON.stringify(terminal));
      return originalStoreAppend(sessionRef, batch);
    };
    safeSessionFiles.appendSessionFile = async function (file, data, ...args) {
      const target = String(file);
      if (target === `${base}.jsonl` && String(data).includes('"t":"question_continuation"')) {
        faultStarted = true;
      }
      if (faultStarted && target === `${base}.idx` && !releaseIndexFailure) {
        await new Promise((_, reject) => {
          releaseIndexFailure = () => reject(new Error('injected terminal index failure'));
        });
      }
      return originalAppendFile(file, data, ...args);
    };
    safeSessionFiles.openSessionFileForRead = async function (file, ...args) {
      if (faultStarted && String(file) === `${base}.jsonl` && openFailures > 0) {
        openFailures -= 1;
        throw new Error('injected terminal verification failure');
      }
      return originalOpen(file, ...args);
    };
    safeSessionFiles.truncateSessionFile = async function (file, ...args) {
      if (faultStarted && String(file) === `${base}.jsonl` && truncateFailures > 0) {
        truncateFailures -= 1;
        throw new Error('injected terminal rollback failure');
      }
      return originalTruncate(file, ...args);
    };

    try {
      assert.strictEqual(await session.openHandoffQuestion({
        question: 'Can an ambiguous append duplicate this continuation?',
        options: ['No', 'Maybe'],
      }), null);
      const [request] = (await session.snapshot()).pendingQuestions;
      assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), true);
      await eventually(() => sent.length === 1, 'the continuation never reached the adapter');
      await eventually(() => typeof releaseIndexFailure === 'function', 'terminal index write did not begin');

      session.ingest({ t: 'state', state: 'running' });
      session.ingest({ t: 'state', state: 'thinking' });
      releaseIndexFailure();

      await eventually(async () => (
        (await store.snapshot(ref)).pendingQuestionContinuations.length === 0
      ), 'the exact retry did not reconcile the committed terminal');
      assert.strictEqual(terminalRecords.length, 2, 'the ambiguous append should be reconciled once');
      assert.strictEqual(terminalRecords[0], terminalRecords[1], 'seq, timestamp, and bytes must stay stable');
      assert.strictEqual(sent.length, 1, 'persistence reconciliation must never resend the runtime turn');

      await store.stat(ref);
      const replay = await store.read(ref, 1, 10_000);
      assert.deepStrictEqual(
        replay.events.map((event) => event.seq),
        Array.from({ length: replay.cursor }, (_, index) => index + 1),
      );
      assert.deepStrictEqual(
        replay.events.filter((event) => event.t === 'state').slice(-2).map((event) => event.state),
        ['running', 'thinking'],
      );
      assert.ok(broadcasts.some((message) => message.event?.t === 'question_continuation'));
      await session.stop();
    } finally {
      store.append = originalStoreAppend;
      safeSessionFiles.appendSessionFile = originalAppendFile;
      safeSessionFiles.openSessionFileForRead = originalOpen;
      safeSessionFiles.truncateSessionFile = originalTruncate;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not resend a dispatch marker left ambiguous by a hard crash', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-uncertain-dispatch-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-uncertain-dispatch', ownerUserId: 7 };
    const request = {
      requestId: 'ask-before-crash', origin: 'structured_handoff', question: 'Continue?',
      multiSelect: false, options: [{ optionId: 'opt-0', label: 'Yes' }], ts: 1,
    };
    const continuation = {
      continuationId: 'continue-before-crash', request,
      answer: { optionIds: ['opt-0'], labels: ['Yes'] },
    };
    await store.append(ref, [
      { t: 'question', seq: 1, ts: 1, request },
      {
        t: 'question_resolved', seq: 2, ts: 2, requestId: request.requestId,
        optionIds: ['opt-0'], continuation,
      },
      {
        t: 'question_continuation_dispatching', seq: 3, ts: 3,
        requestId: request.requestId, continuationId: continuation.continuationId,
      },
    ]);
    const sent = [];
    const realFactory = registry.createChatAdapter;
    registry.createChatAdapter = (runtime) => ({
      runtime, alive: true, readyForTurn: true, capabilities: CAPABILITIES,
      async start() {},
      async send(turn) { sent.push(turn); },
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    });
    const resumed = new ChatSession(ref, {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    });
    try {
      await resumed.start({
        runtime: 'claude', workingDir: root, bypassPermissions: true,
        planMode: false, resumeSessionId: 'native-uncertain-dispatch',
      });
      assert.strictEqual(sent.length, 0);
      assert.strictEqual((await store.snapshot(ref)).pendingQuestionContinuations.length, 0);
      const replay = await store.read(ref, 1, 100);
      assert.ok(replay.events.some((event) => (
        event.t === 'question_continuation'
        && event.outcome === 'abandoned'
        && /not retried/.test(event.reason || '')
      )));
      await resumed.stop();
    } finally {
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('abandons persisted tool calls and handoffs that cannot be resumed', async function () {
    const tool = {
      requestId: 'orphaned-tool', origin: 'tool', question: 'Tool?', multiSelect: false,
      options: [{ optionId: 'opt-0', label: 'Yes' }], ts: 1,
    };
    const handoff = {
      requestId: 'failed-resume', origin: 'structured_handoff', question: 'Handoff?', multiSelect: false,
      options: [{ optionId: 'opt-0', label: 'Yes' }], ts: 1,
    };
    const { session, store, sent } = fixture({ pendingQuestions: [tool, handoff] });

    assert.strictEqual(await session.restorePendingQuestions(false), false);
    assert.deepStrictEqual(
      store.events.filter((event) => event.t === 'question_resolved').map((event) => event.requestId),
      ['orphaned-tool', 'failed-resume'],
    );
    assert.ok(store.events.filter((event) => event.t === 'question_resolved').every((event) => event.abandoned));
    assert.strictEqual(sent.length, 0);
  });

  it('records a handoff as abandoned when the real resume launch fails', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-failed-resume-'));
    const store = new ChatStore({ storageDir: path.join(root, 'store') });
    const ref = { id: 'handoff-failed-resume', ownerUserId: 7 };
    const deps = {
      store,
      socketDir: path.join(root, 'sockets'),
      hookScript: path.join(root, 'missing-hook.js'),
      askScript: path.join(root, 'missing-ask.js'),
      broadcast: () => {},
      resolveCommand: () => path.join(root, 'missing-runtime'),
    };
    const first = new ChatSession(ref, deps);
    first.openHandoffQuestion({ question: 'Can this resume?', options: ['Yes', 'No'] });
    const requestId = (await store.snapshot(ref)).pendingQuestions[0].requestId;

    const realFactory = registry.createChatAdapter;
    registry.createChatAdapter = (runtime) => ({
      runtime,
      alive: true,
      readyForTurn: true,
      capabilities: CAPABILITIES,
      async start() { throw new Error('resume refused'); },
      async send() {},
      async interrupt() {},
      async stop() { this.alive = false; },
      respondPermission() {},
    });
    const resumed = new ChatSession(ref, deps);
    try {
      await assert.rejects(
        resumed.start({
          runtime: 'claude', workingDir: root, bypassPermissions: true,
          planMode: false, resumeSessionId: 'missing-native-session',
        }),
        /resume refused/,
      );
      const snapshot = await store.snapshot(ref);
      assert.strictEqual(snapshot.pendingQuestions.length, 0);
      assert.strictEqual(snapshot.abandonedQuestions[requestId], true);
    } finally {
      await resumed.stop();
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('abandons a handoff when an exited runtime has no resumable conversation', async function () {
    const { session, store, sent } = fixture();
    assert.strictEqual(await session.openHandoffQuestion({
      question: 'Can this dead runtime continue?',
      options: ['Yes', 'No'],
    }), null);
    session.ingest({ t: 'state', state: 'exited' });
    await eventually(() => store.events.some((event) => (
      event.t === 'question_resolved' && event.abandoned === true
    )), 'the unresumable handoff stayed actionable');

    assert.strictEqual((await session.snapshot()).pendingQuestions.length, 0);
    assert.strictEqual(sent.length, 0);
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

  it('keeps Plan mode on across a structured question continuation', async function () {
    const { session, store, sent } = fixture();
    session.questionFallbackEnabled = true;
    await session.setPlanMode(true);
    const envelope = '<ccweb-question>{"version":1,"question":"Which plan shape?","options":[{"label":"Small"},{"label":"Broad"}]}</ccweb-question>';
    session.ingest({ t: 'msg_start', id: 'a-plan-question', role: 'assistant', turnId: 't-plan-question' });
    session.ingest({
      t: 'block_start', msgId: 'a-plan-question', index: 0,
      block: { kind: 'text', text: envelope },
    });
    session.ingest({ t: 'msg_end', msgId: 'a-plan-question' });
    session.ingest({ t: 'turn_end', turnId: 't-plan-question' });

    await eventually(() => store.events.some((event) => event.t === 'question'), 'Plan question was not opened');
    const request = store.events.find((event) => event.t === 'question').request;
    assert.strictEqual(await session.answerQuestion(request.requestId, ['opt-0']), true);
    await eventually(() => sent.length === 1, 'Plan answer was not continued');
    assert.strictEqual(session.planMode, true);
    assert.match(sent[0].text, /Plan mode is active/i);
    assert.match(sent[0].text, /Selected: Small/);
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
    const remove = safeSessionFiles.unlinkSessionEntry;
    safeSessionFiles.unlinkSessionEntry = async (target) => {
      if (String(target).endsWith('.plan')) throw new Error('read-only storage');
      return remove(target);
    };
    try {
      await assert.rejects(store.clearPlanDocument(ref), /read-only storage/);
    } finally {
      safeSessionFiles.unlinkSessionEntry = remove;
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
