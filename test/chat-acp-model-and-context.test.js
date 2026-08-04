/**
 * Three things grok says over ACP that the adapter was not listening for.
 *
 * Issue #38 (the chosen model is never applied at launch), #75 (the per-model
 * breakdown is dropped) and #82 (the context reading is never taken) are one
 * shape of mistake: the runtime publishes a fact, and the adapter reads a
 * narrower slice of the message that carries it. So they are proved the same
 * way — by driving the real `AcpChatAdapter` through the real captures under
 * `fixtures/chat` and folding what comes out through the reducer a browser
 * uses and the accountant the dashboard is built from.
 *
 * Every figure asserted here was sent by grok. `acp-grok.jsonl` is one complete
 * turn (`grok agent --no-leader stdio`, four round trips), `acp-grok-session-new.json`
 * is the `session/new` reply from the run that produced
 * `acp-grok-turn-completed.jsonl` — same session id, so the handshake and the
 * turn below genuinely belong together. Nothing here is a shape anybody
 * imagined: a capture invented to agree with the code would prove only that the
 * code agrees with itself.
 *
 * `handshake`, `handleMessage` and `writeLine` are protected in TypeScript, a
 * compile-time rule only, so the translation is driven without spawning a CLI.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8'));
}

/** Let the adapter's own promise chains run before asserting on their output. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function only(events, type) {
  return events.filter((event) => event.t === type);
}

function harness(overrides) {
  const events = [];
  const sent = [];
  const adapter = new AcpChatAdapter(
    Object.assign(
      {
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        readFile: async () => '',
        emit: (event) => events.push(event),
      },
      overrides,
    ),
  );
  adapter.writeLine = (payload) => sent.push(payload);
  return { adapter, events, sent };
}

/**
 * Answer `initialize` and `session/new` from the captures, then whatever the
 * handshake asks for next — which is the point of most of this file.
 */
async function boot(h, initializeLine, sessionResult, answer) {
  const done = h.adapter.handshake();
  await flush();
  h.adapter.handleMessage(initializeLine);
  await flush();
  const opened = h.sent.find((message) => message.method === 'session/new');
  h.adapter.handleMessage({ jsonrpc: '2.0', id: opened.id, result: sessionResult });
  await flush();
  if (answer) await answer(h);
  await done;
}

/** What a browser watching this conversation would have on screen. */
function replay(events) {
  const state = createTranscript({});
  events.forEach((event, index) =>
    applyChatEvent(state, Object.assign({}, event, { seq: index + 1, ts: event.ts ?? 1 })),
  );
  return state;
}

/**
 * What the dashboard filed, through the real accountant.
 *
 * The user's own message opens the job — `deliver` emits it, so no capture can
 * contain it — and the flush is the close a session performs when the process
 * goes away.
 */
function fileJob(events) {
  const jobs = [];
  const accountant = new UsageAccountant((job) => jobs.push(job));
  let seq = 0;
  const feed = (event) => accountant.observe(Object.assign({ seq: ++seq, ts: 1000 + seq }, event));
  feed({ t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' });
  feed({ t: 'msg_end', msgId: 'u1' });
  for (const event of events) feed(event);
  accountant.flush();
  return jobs;
}

const GROK = { runtime: 'grok', acpArgs: ['agent', '--no-leader', 'stdio'] };

/**
 * The captured turn, driven as a turn.
 *
 * `session/prompt` has to be outstanding for the capture's reply — the line
 * carrying everything the turn spent — to be delivered to anything at all, and
 * the reply is re-pointed at the id this run's prompt actually used. That is
 * the transport's correlation number and nothing else: the payload is the
 * capture's, untouched.
 */
async function grokTurn(overrides) {
  const h = harness(Object.assign({}, GROK, overrides));
  const lines = fixture('acp-grok');
  await boot(h, lines[0], loadJson('acp-grok-session-new.json'));
  const sending = h.adapter.send({ text: 'Read the file probe.txt…' });
  const prompt = h.sent.find((message) => message.method === 'session/prompt');
  for (const line of lines.slice(2, 18)) {
    h.adapter.handleMessage(line);
    await flush();
  }
  await sending;
  h.adapter.handleMessage(Object.assign({}, lines[18], { id: prompt.id }));
  await flush();
  return h;
}

// ---------------------------------------------------------------------------
// #38 — the model the conversation was launched on
// ---------------------------------------------------------------------------

describe('the model an ACP conversation is launched on', function () {
  it('is applied over the protocol, so it survives the restart /clear performs', async function () {
    // The bug this is about is invisible at the first launch and certain at the
    // second: `/clear` restarts the process in place and replays the options
    // the session was started with, so a chosen model reached this adapter and
    // was dropped on the floor from then on — while the composer went on
    // asserting it, because the chip renders the override ahead of the model
    // the runtime reported.
    const h = harness(Object.assign({ model: 'grok-4.5' }, GROK));
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'), async () => {
      const call = h.sent.find((message) => message.method === 'session/set_model');
      assert.ok(call, 'the chosen model must reach the agent');
      assert.deepStrictEqual(call.params, {
        sessionId: '019fa521-db8c-7872-87da-316ce4cf3a83',
        modelId: 'grok-4.5',
      });
      // Grok's own answer to this call, probed live: an acceptance and nothing
      // more.
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        result: { _meta: { model: { Ok: 'grok-4.5' } } },
      });
      await flush();
    });

    // The session event is what names the conversation's model, so it has to be
    // the model that will answer rather than the one the agent opened on.
    assert.strictEqual(only(h.events, 'session')[0].model, 'grok-4.5');
    assert.strictEqual(replay(h.events).model, 'grok-4.5');
  });

  it('measures the window of the model it switched to, not the one it opened on', async function () {
    // Grok publishes a window per model, and they differ: 512,000 for
    // `grok-build`, 500,000 for `grok-4.5`. A switch that left the first figure
    // standing would draw every bar for the rest of the conversation against a
    // ceiling 12,000 tokens higher than the one that exists.
    const h = harness(Object.assign({ model: 'grok-4.5' }, GROK));
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'), async () => {
      const call = h.sent.find((message) => message.method === 'session/set_model');
      assert.ok(call, 'the chosen model must reach the agent');
      h.adapter.handleMessage({ jsonrpc: '2.0', id: call.id, result: { _meta: { model: { Ok: 'grok-4.5' } } } });
      await flush();
    });

    const usage = replay(h.events).usage;
    assert.strictEqual(usage.contextWindow, 500000);
    assert.strictEqual(usage.contextWindowSource, 'agent');
  });

  it('takes the config-option road where the agent published one', async function () {
    // omp's real model select, from its own `session/new`. The road matters:
    // setting the model as a config option is the only one that brings the rest
    // of the session's configuration back, and on these agents the thinking
    // ladder genuinely changes with the model.
    const session = fixture('acp-omp')[1].result;
    const h = harness({ runtime: 'omp', acpArgs: ['acp'], model: 'openrouter/~anthropic/claude-opus-latest' });
    await boot(h, fixture('acp-omp')[0], session, async () => {
      const call = h.sent.find((message) => message.method === 'session/set_config_option');
      assert.ok(call, 'the chosen model must reach the agent');
      assert.deepStrictEqual(call.params, {
        sessionId: '019f994c-6f83-7000-aa56-89bb51fff42f',
        configId: 'model',
        value: 'openrouter/~anthropic/claude-opus-latest',
      });
      // What these agents answer: the whole option list rebuilt, with
      // `currentValue` already moved.
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          configOptions: session.configOptions.map((option) =>
            option.id === 'model'
              ? Object.assign({}, option, { currentValue: 'openrouter/~anthropic/claude-opus-latest' })
              : option,
          ),
        },
      });
      await flush();
    });

    assert.strictEqual(only(h.events, 'session')[0].model, 'openrouter/~anthropic/claude-opus-latest');
  });

  it('opens the conversation anyway when the agent refuses the model', async function () {
    // A model remembered from another runtime's picker is a name this one has
    // never heard of, and a preference must not be able to take a conversation
    // down. The refusal is said out loud, because the picker cannot show it.
    const h = harness(Object.assign({ model: 'no-such-model' }, GROK));
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'), async () => {
      const call = h.sent.find((message) => message.method === 'session/set_model');
      assert.ok(call, 'the chosen model must reach the agent');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32602, message: 'Unknown model: no-such-model' },
      });
      await flush();
    });

    assert.ok(
      only(h.events, 'error').some((event) => /no-such-model/.test(event.message)),
      'the refusal has to be visible somewhere',
    );
    assert.strictEqual(only(h.events, 'session')[0].model, 'grok-build', 'on the agent’s own model');
    assert.strictEqual(only(h.events, 'state').pop().state, 'idle', 'and open for business');
  });

  it('asks for nothing when the agent already reports the model that was chosen', async function () {
    const h = harness(Object.assign({ model: 'grok-build' }, GROK));
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'));

    assert.deepStrictEqual(
      h.sent.map((message) => message.method),
      ['initialize', 'session/new'],
      'a round trip that could only confirm what the agent just said is not worth taking',
    );
  });
});

// ---------------------------------------------------------------------------
// #75 — what the turn spent, per model
// ---------------------------------------------------------------------------

describe('the per-model breakdown grok publishes at the end of a turn', function () {
  it('reaches turn_end, in grok’s own spelling and its own units', async function () {
    const h = await grokTurn();

    const turn = only(h.events, 'turn_end').pop();
    assert.deepStrictEqual(turn.models, [
      {
        model: 'grok-build',
        calls: 4,
        usage: {
          inputTokens: 65551,
          outputTokens: 392,
          cacheReadTokens: 38272,
          cacheWriteTokens: undefined,
          // Ten-billionths of a dollar on the wire: `costUsdTicks: 357174000`.
          // Passed through as it stands rather than divided into shares the way
          // claude's has to be — grok's tick count is the turn's own, and the
          // entries add up to exactly it.
          costUsd: 0.0357174,
        },
      },
    ]);
    // The two fields a straight read of the shared `modelUsage` parser would
    // have lost: it looks for `cacheReadInputTokens` and `costUSD`, which is
    // what claude and grok's own *headless* mode send —
    // `fixtures/chat/grok-model-usage.jsonl` is that spelling, from the entry
    // point #73 retired. Over ACP the same agent sends `cachedReadTokens` and
    // ticks, and reading only one vocabulary files the cache and the money as
    // never reported.
    const headless = fixture('grok-model-usage')[1].modelUsage['grok-build'];
    assert.strictEqual(headless.cacheReadInputTokens, 4096);
    assert.strictEqual(headless.costUSD, 0.0128712);
  });

  it('files the round trips the dashboard was reading as “not reported”', async function () {
    // `modelCalls` is the only round-trip count grok reports anywhere, and it
    // travels on this map alone. Without it every Grok row's Model turns column
    // said nothing at all.
    const jobs = fileJob((await grokTurn()).events);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].modelTurns, 4);
    assert.strictEqual(jobs[0].model, 'grok-build');
  });

  it('counts the turn once, though grok announces it on two channels', async function () {
    // Grok sends the same map twice: once as a `turn_completed` notification on
    // its own `_x.ai` channel and once, a beat later, on the reply to
    // `session/prompt`. Both lines below are that pair, verbatim from one real
    // turn — byte-identical usage objects. Reading both would file two round
    // trips for a turn that made one, and double what it cost.
    const [notification, reply] = fixture('acp-grok-turn-completed');
    const h = harness(GROK);
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'));
    const sending = h.adapter.send({ text: 'go' });
    const prompt = h.sent.find((message) => message.method === 'session/prompt');

    h.adapter.handleMessage(notification);
    await flush();
    h.adapter.handleMessage(Object.assign({}, reply, { id: prompt.id }));
    await sending;
    await flush();

    assert.strictEqual(only(h.events, 'turn_end').length, 1);
    assert.deepStrictEqual(only(h.events, 'turn_end')[0].models, [
      {
        model: 'grok-build',
        calls: 1,
        usage: {
          inputTokens: 16173,
          outputTokens: 149,
          cacheReadTokens: 1280,
          cacheWriteTokens: undefined,
          costUsd: 0.015447,
        },
      },
    ]);
    assert.strictEqual(fileJob(h.events)[0].modelTurns, 1, 'one turn, one round trip');
  });
});

// ---------------------------------------------------------------------------
// #82 — how full the window is
// ---------------------------------------------------------------------------

describe('how much of grok’s context is occupied', function () {
  it('is read from the figure grok puts on every update, against the window it published', async function () {
    const usage = replay((await grokTurn()).events).usage;
    assert.strictEqual(usage.contextWindow, 512000);
    assert.strictEqual(usage.contextWindowSource, 'agent');
    // The last request's own total, which is what occupancy means here.
    assert.strictEqual(usage.contextUsed, 16637);
    // Not the turn's: its four requests moved 65,943 tokens between them, and a
    // bar built on that would read four times as full as the window ever was.
    assert.notStrictEqual(usage.contextUsed, 65943);
    assert.strictEqual(usage.totalTokens, 65943, 'which still counts, as spend');
  });

  it('has a reading before the conversation has sent anything', async function () {
    // 1,038 tokens of system prompt, on the `available_commands_update` grok
    // sends as the session opens — a kind nothing in the adapter reads, which
    // is why the figure is taken off the envelope rather than the update.
    const h = harness(GROK);
    await boot(h, fixture('acp-grok')[0], loadJson('acp-grok-session-new.json'));
    h.adapter.handleMessage(fixture('acp-grok')[2]);
    await flush();

    assert.strictEqual(replay(h.events).usage.contextUsed, 1038);
  });

  it('says it once per change, not once per chunk', async function () {
    // Grok repeats the same figure on every chunk of a streamed answer. The log
    // is a durable record of what changed, not of how often it was mentioned.
    const h = await grokTurn();
    assert.deepStrictEqual(
      only(h.events, 'usage')
        .map((event) => event.usage.contextUsed)
        .filter((used) => used !== undefined),
      [1038, 8363, 16381, 16641, 16811, 16812, 16637],
    );
  });

  it('leaves the agents that publish usage_update exactly as they were', async function () {
    // omp and opencode report occupancy on ACP's own channel and put no `_meta`
    // on their updates at all — 1,386 of them across the probes, not one with
    // the key grok's reading is taken from. A second reading landing on either
    // would double-count the one fact this whole meter is.
    for (const [name, runtime, used, window] of [
      ['acp-omp', 'omp', 27755, 1048576],
      ['acp-opencode', 'opencode', 43354, 200000],
    ]) {
      const h = harness({ runtime, acpArgs: ['acp'] });
      const lines = fixture(name);
      const done = h.adapter.handshake();
      for (const line of lines.slice(0, 2)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await done;
      const sending = h.adapter.send({ text: 'go' });
      for (const line of lines.slice(2)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await sending;

      assert.strictEqual(only(h.events, 'usage').length, 1, `${runtime}: one report, as before`);
      const usage = replay(h.events).usage;
      assert.strictEqual(usage.contextUsed, used);
      assert.strictEqual(usage.contextWindow, window);
    }
  });
});
