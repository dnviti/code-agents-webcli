const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ModelCapacityLookup } = require('../dist/server/chat/model-capacity.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');
const { mergeUsage } = require('../dist/shared/chat-events.js');

/**
 * Issue #82: how full is this model's context, against its real capacity.
 *
 * Every figure asserted here was read off a live run today and trimmed into a
 * fixture — `.work/probes/raw/ctx-*.jsonl` holds the untouched wire logs. That
 * matters more than usual for this feature: the whole point is that no context
 * size is written down in the product, so a test built on a size *this file*
 * invented would be checking our own assumption rather than the agent's answer.
 *
 * The one figure not re-probed today is codex's, whose account answered "You've
 * hit your usage limit […] try again at Aug 8th, 2026" to every prompt. Its row
 * runs against the capture already in the repo, and this note is here rather
 * than a claim that it was verified.
 */

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8'));
}

/** Fold adapter events the way a browser does, so `usage` is what a user sees. */
function replay(events) {
  const state = createTranscript({});
  let seq = 0;
  for (const event of events) {
    applyChatEvent(state, Object.assign({}, event, { seq: ++seq, ts: event.ts ?? 1 }));
  }
  return state;
}

function makeAdapter(Adapter, options) {
  const events = [];
  const adapter = new Adapter(
    Object.assign(
      { sessionId: 's1', workingDir: '/work', command: 'x', emit: (event) => events.push(event) },
      options,
    ),
  );
  return { adapter, events };
}

// --------------------------------------------------------------- the agents

describe('what each agent says about its own context window', function () {
  it('claude reports its capacity, and the last request is what filled it', function () {
    const { adapter, events } = makeAdapter(ClaudeChatAdapter, {});
    for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

    const usage = replay(events).usage;
    // Straight out of claude's own `modelUsage` block, keyed by the model as
    // it ran. Nothing here knows what an opus is.
    assert.strictEqual(usage.contextWindow, 1000000);
    assert.strictEqual(usage.contextWindowSource, 'agent');
    // The last request: 2 in + 31,789 cache read + 111 cache write + 10 out.
    assert.strictEqual(usage.contextUsed, 2 + 31789 + 111 + 10);
  });

  it('a turn of several round trips is measured by its last one, not their sum', function () {
    const { adapter, events } = makeAdapter(ClaudeChatAdapter, {});
    // A real three-round-trip turn: write a file, read it back, answer.
    for (const line of loadFixture('claude-multi-turn-result.jsonl')) adapter.handleMessage(line);

    const usage = replay(events).usage;
    assert.strictEqual(usage.contextUsed, 2 + 33809 + 3571 + 5);
    // What the turn's own totals add up to, which is what a naive reading
    // would have shown: 105,027 against a 1,000,000 window reads as 10.5%
    // full where the truth is 3.7%. Three times over, on one turn.
    assert.notStrictEqual(usage.contextUsed, 5 + 82927 + 21882 + 213);
    assert.strictEqual(usage.contextWindow, 1000000);
  });

  it('codex reports its capacity, and its own `last` figure for what is in it', function () {
    // `CodexChatAdapter` is a wrapper that picks app-server or exec at start;
    // the app-server adapter is the one that speaks this protocol.
    const { adapter, events } = makeAdapter(CodexAppServerAdapter, { command: 'codex' });
    for (const line of loadFixture('codex-appserver-text-turn.jsonl')) {
      if (line.method || line.result !== undefined) adapter.handleMessage(line);
    }

    const usage = replay(events).usage;
    assert.strictEqual(usage.contextWindow, 128000);
    assert.strictEqual(usage.contextWindowSource, 'agent');
    assert.strictEqual(usage.contextUsed, 150);
  });

  it('omp reports both halves itself, and they are marked as its own', function () {
    const { adapter, events } = makeAdapter(AcpChatAdapter, { runtime: 'omp', acpArgs: ['acp'] });
    for (const line of loadFixture('acp-omp.jsonl')) {
      if (line.method === 'session/update') adapter.handleMessage(line);
    }

    const usage = replay(events).usage;
    assert.strictEqual(usage.contextWindow, 1048576);
    assert.strictEqual(usage.contextUsed, 27755);
    assert.strictEqual(usage.contextWindowSource, 'agent');
  });

  it('pi reports how much it used, and says nothing at all about capacity', function () {
    const { adapter, events } = makeAdapter(PiChatAdapter, {});
    for (const line of loadFixture('pi-context-turn.jsonl')) adapter.handleMessage(line);

    const usage = replay(events).usage;
    // The occupancy is real and the ceiling is absent — which is the state the
    // provider lookup exists for, and which the UI states in words rather than
    // drawing a bar against nothing.
    assert.strictEqual(usage.contextUsed, 8074);
    assert.strictEqual(usage.contextWindow, undefined);
    assert.strictEqual(usage.contextWindowSource, undefined);
  });

  it('an agent that publishes a window per model is believed over any catalogue', function () {
    const { adapter, events } = makeAdapter(AcpChatAdapter, { runtime: 'grok', acpArgs: ['agent'] });
    // Grok's real `session/new` reply, trimmed. It runs on this adapter from
    // #73 onward; the parse is here now because the shape is captured, not
    // guessed, and it costs nothing on an agent that sends no such block.
    adapter.applySessionConfig(loadJson('acp-grok-session-new.json'));

    const usage = replay(events).usage;
    assert.strictEqual(usage.contextWindow, 512000);
    assert.strictEqual(usage.contextWindowSource, 'agent');
  });

  it('an agent with no model block is left alone rather than defaulted', function () {
    const { adapter, events } = makeAdapter(AcpChatAdapter, { runtime: 'kimi', acpArgs: ['acp'] });
    adapter.applySessionConfig({ sessionId: 'x', configOptions: [] });
    assert.deepStrictEqual(events, []);
  });
});

// ------------------------------------------------------- the provider lookup

describe('asking a provider how large a model is', function () {
  const CATALOGUE = {
    data: [
      { id: 'moonshotai/kimi-k3', context_length: 1048576 },
      { id: 'moonshotai/kimi-k2.7-code', context_length: 262144 },
      { id: 'openai/gpt-5:free', canonical_slug: 'openai/gpt-5', context_length: 400000 },
    ],
  };

  function lookup(respond) {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      return respond(url, calls);
    };
    const instance = new ModelCapacityLookup({ fetchImpl, catalogueUrl: 'https://example/models' });
    return { instance, calls: () => calls };
  }

  function ok(body) {
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              return { done: false, value: new TextEncoder().encode(JSON.stringify(body)) };
            },
            async cancel() {},
          };
        },
      },
    };
  }

  it('answers with the length the provider publishes', async function () {
    const { instance } = lookup(() => ok(CATALOGUE));
    // pi reports exactly this id, with provider "openrouter".
    assert.strictEqual(await instance.contextWindowFor('moonshotai/kimi-k3'), 1048576);
  });

  it('strips the provider prefix an agent puts on its own model ids', async function () {
    const { instance } = lookup(() => ok(CATALOGUE));
    // kimi's ids look like this verbatim.
    assert.strictEqual(
      await instance.contextWindowFor('openrouter/moonshotai/kimi-k2.7-code'),
      262144,
    );
  });

  it('matches a canonical slug, which is the name a vendor uses', async function () {
    const { instance } = lookup(() => ok(CATALOGUE));
    assert.strictEqual(await instance.contextWindowFor('openai/gpt-5'), 400000);
  });

  it('says nothing rather than picking a neighbouring model', async function () {
    const { instance } = lookup(() => ok(CATALOGUE));
    // `grok-build` has no entry. The nearest one, `x-ai/grok-build-0.1`, says
    // 256,000 where grok itself says 512,000 — half. A fuzzy match here would
    // put a confidently wrong ceiling in front of a user, which is the exact
    // failure this feature exists to avoid.
    assert.strictEqual(await instance.contextWindowFor('grok-build'), null);
  });

  it('asks once and reuses the answer', async function () {
    const { instance, calls } = lookup(() => ok(CATALOGUE));
    await instance.contextWindowFor('moonshotai/kimi-k3');
    await instance.contextWindowFor('moonshotai/kimi-k2.7-code');
    assert.strictEqual(calls(), 1);
  });

  it('returns nothing when the provider cannot be reached', async function () {
    const { instance } = lookup(() => {
      throw new Error('ENOTFOUND');
    });
    assert.strictEqual(await instance.contextWindowFor('moonshotai/kimi-k3'), null);
  });

  it('does not cache an empty catalogue as if it were an answer', async function () {
    let shape = { data: [] };
    const { instance, calls } = lookup(() => ok(shape));
    assert.strictEqual(await instance.contextWindowFor('moonshotai/kimi-k3'), null);
    shape = CATALOGUE;
    // The failure backoff suppresses the immediate retry — what matters is
    // that nothing was remembered as "this model has no size".
    assert.strictEqual(calls(), 1);
  });

  it('can be switched off, and then asks nobody anything', async function () {
    let calls = 0;
    const instance = new ModelCapacityLookup({
      enabled: false,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('should not have been called');
      },
    });
    assert.strictEqual(await instance.contextWindowFor('moonshotai/kimi-k3'), null);
    assert.strictEqual(calls, 0);
  });

  it('holds no size for any model of its own', function () {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'server', 'chat', 'model-capacity.ts'),
      'utf8',
    );
    // The one thing issue #82 rules out is a table of model sizes living in
    // the product, so this asserts the absence directly: no six-or-seven digit
    // token count anywhere in the file that resolves them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const suspicious = code.match(/\b\d{5,}\b/g) || [];
    assert.deepStrictEqual(suspicious, [], `context sizes must not be written here: ${suspicious}`);
  });
});

// ------------------------------------------------------------- the session

describe('a session fills in the capacity its agent would not give', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-ctx-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function session(capacity) {
    const { ChatSession } = require('../dist/server/chat/session.js');
    const events = [];
    const instance = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store: {
          append(_ref, batch) {
            events.push(...batch);
          },
          async stat() {
            return { firstSeq: 1, cursor: events.length };
          },
          async read() {
            return { events: [], firstSeq: 1, from: 1, cursor: events.length };
          },
        },
        socketDir: dir,
        hookScript: path.join(dir, 'nope.js'),
        broadcast: () => {},
        resolveCommand: () => '/bin/cat',
        capacity,
      },
    );
    return { instance, events };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('asks the provider for a model the agent described no window for', async function () {
    const asked = [];
    const { instance, events } = session({
      async contextWindowFor(model) {
        asked.push(model);
        return model === 'moonshotai/kimi-k3' ? 1048576 : null;
      },
    });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'moonshotai/kimi-k3' });
    await settle();

    assert.deepStrictEqual(asked, ['moonshotai/kimi-k3']);
    const usage = events.filter((event) => event.t === 'usage');
    assert.strictEqual(usage.length, 1);
    assert.strictEqual(usage[0].usage.contextWindow, 1048576);
    // Marked as second-hand, because it is.
    assert.strictEqual(usage[0].usage.contextWindowSource, 'provider');
  });

  it('does not ask about a model whose agent already answered', async function () {
    const asked = [];
    const { instance } = session({
      async contextWindowFor(model) {
        asked.push(model);
        return 999;
      },
    });
    instance.ingest({ t: 'usage', usage: { contextWindow: 512000, contextWindowSource: 'agent' } });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'grok-build' });
    await settle();
    assert.deepStrictEqual(asked, []);
  });

  it('asks once per model, not once per message', async function () {
    const asked = [];
    const { instance } = session({
      async contextWindowFor(model) {
        asked.push(model);
        return null;
      },
    });
    for (const id of ['m1', 'm2', 'm3']) {
      instance.ingest({ t: 'msg_start', id, role: 'assistant', turnId: 't1', model: 'unknown/model' });
      await settle();
    }
    assert.deepStrictEqual(asked, ['unknown/model']);
  });

  it('re-asks when the conversation switches model, and never carries the old ceiling', async function () {
    const { instance, events } = session({
      async contextWindowFor(model) {
        return model === 'big/one' ? 1000000 : 200000;
      },
    });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'big/one' });
    await settle();
    instance.ingest({ t: 'msg_start', id: 'm2', role: 'assistant', turnId: 't2', model: 'small/one' });
    await settle();

    const windows = events
      .filter((event) => event.t === 'usage')
      .map((event) => event.usage.contextWindow);
    assert.deepStrictEqual(windows, [1000000, 200000]);
    // And the reading a browser ends up with is the new model's, not the old.
    assert.strictEqual(replay(events).usage.contextWindow, 200000);
  });

  it('says nothing at all when nobody can answer', async function () {
    const { instance, events } = session({
      async contextWindowFor() {
        return null;
      },
    });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'nobody/knows' });
    await settle();
    assert.deepStrictEqual(events.filter((event) => event.t === 'usage'), []);
    assert.strictEqual(replay(events).usage.contextWindow, undefined);
  });

  it('runs without a lookup at all', async function () {
    const { instance, events } = session(undefined);
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'x/y' });
    await settle();
    assert.deepStrictEqual(events.filter((event) => event.t === 'usage'), []);
  });

  it('a lookup that throws does not reach the conversation', async function () {
    const { instance, events } = session({
      async contextWindowFor() {
        throw new Error('provider on fire');
      },
    });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'x/y' });
    await settle();
    assert.deepStrictEqual(events.filter((event) => event.t === 'error'), []);
  });
});

// --------------------------------------------------------------- the merge

describe('merging usage keeps a window and its provenance together', function () {
  it('a later turn that only reports occupancy leaves the source alone', function () {
    const merged = mergeUsage(
      { contextWindow: 512000, contextWindowSource: 'agent' },
      { contextUsed: 40000 },
    );
    assert.strictEqual(merged.contextWindow, 512000);
    assert.strictEqual(merged.contextWindowSource, 'agent');
    assert.strictEqual(merged.contextUsed, 40000);
  });

  it('a new window brings its own provenance with it', function () {
    const merged = mergeUsage(
      { contextWindow: 200000, contextWindowSource: 'provider' },
      { contextWindow: 512000, contextWindowSource: 'agent' },
    );
    assert.strictEqual(merged.contextWindow, 512000);
    assert.strictEqual(merged.contextWindowSource, 'agent');
  });

  it('the window is never added up the way tokens are', function () {
    const merged = mergeUsage(
      { contextWindow: 512000, contextUsed: 10, inputTokens: 5 },
      { contextWindow: 512000, contextUsed: 20, inputTokens: 5 },
    );
    assert.strictEqual(merged.contextWindow, 512000);
    assert.strictEqual(merged.contextUsed, 20);
    assert.strictEqual(merged.inputTokens, 10);
  });
});
