const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ModelCapacityLookup } = require('../dist/server/chat/model-capacity.js');
const {
  createTranscript,
  applyChatEvent,
  foldSessionUsage,
} = require('../dist/shared/chat-reducer.js');
const { mergeUsage } = require('../dist/shared/chat-events.js');

/**
 * Issue #82, the other half: a ceiling that has to come *down*.
 *
 * Every write of `contextWindow` in this app is a set. `assignDefined` drops an
 * absent field, `mergeUsage` keeps the older number, and a clear deliberately
 * preserves the window — all of which is right for a stream of partial reports
 * and all of which conspires to leave the last sizable model's window standing
 * after the conversation moves to a model nobody can size. What was on screen
 * then, and written into the log for every rejoin after it, was `1,000,000 ·
 * provider` for a model whose real capacity nobody in this system knows.
 *
 * The models below are the ones the agents actually offer: `moonshotai/kimi-k3`
 * and `~anthropic/claude-opus-latest` are both lines of pi's own `models`
 * output (test/fixtures/chat/pi-models-list.txt), and pi's tilde alias is
 * exactly the kind of id a catalogue keyed by exact id cannot match. The turn
 * that fills the window is pi's real capture, and grok's window comes out of
 * its real `session/new` reply. Nothing here invents an event shape.
 */

const ROOT = path.join(__dirname, '..');

function loadFixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8'));
}

/** Fold events the way a browser does, so `usage` is what a user sees. */
function replay(events) {
  const state = createTranscript({});
  let seq = 0;
  for (const event of events) {
    applyChatEvent(state, Object.assign({}, event, { seq: ++seq, ts: event.ts ?? 1 }));
  }
  return state;
}

function adapterEvents(Adapter, options, drive) {
  const events = [];
  const adapter = new Adapter(
    Object.assign(
      { sessionId: 's1', workingDir: '/work', command: 'x', emit: (event) => events.push(event) },
      options,
    ),
  );
  drive(adapter);
  return events;
}

/** pi's real turn: 8,074 tokens in the window and not a word about its size. */
function piTurn() {
  return adapterEvents(PiChatAdapter, {}, (adapter) => {
    for (const line of loadFixture('pi-context-turn.jsonl')) adapter.handleMessage(line);
  });
}

/** grok's real handshake: 512,000 tokens, and grok's own word for it. */
function grokWindow() {
  return adapterEvents(AcpChatAdapter, { runtime: 'grok', acpArgs: ['agent'] }, (adapter) => {
    adapter.applySessionConfig(loadJson('acp-grok-session-new.json'));
  });
}

/**
 * A real mid-conversation model switch, as the adapter performs it.
 *
 * `session/set_model` is the road grok takes — it publishes no model config
 * option — and the reply says only that the call was accepted, so everything
 * the session learns from a switch is what the adapter emits off the back of
 * it. That includes the new model's own window, and it goes out before any
 * message names the model: the naming one belongs to the next turn.
 */
async function grokModelSwitch(model) {
  const events = [];
  const sent = [];
  const adapter = new AcpChatAdapter({
    sessionId: 's1',
    workingDir: '/work',
    command: 'x',
    runtime: 'grok',
    acpArgs: ['agent'],
    emit: (event) => events.push(event),
  });
  adapter.applySessionConfig(loadJson('acp-grok-session-new.json'));
  adapter.nativeSessionId = 'acp-1';
  adapter.writeLine = (payload) => sent.push(payload);

  events.length = 0;
  const done = adapter.setModel(model);
  await new Promise((resolve) => setImmediate(resolve));
  const call = sent.find((message) => message.method === 'session/set_model');
  assert.ok(call, 'the adapter should have asked grok to switch');
  adapter.handleMessage({ jsonrpc: '2.0', id: call.id, result: {} });
  await done;
  return events;
}

/**
 * OpenRouter's catalogue, trimmed to the models pi lists as available. The two
 * lengths are the ones the provider publishes; the point of running the real
 * `ModelCapacityLookup` over them rather than stubbing an answer is that the
 * miss below has to be the real matcher's miss.
 */
const CATALOGUE = {
  data: [
    { id: 'moonshotai/kimi-k3', context_length: 1048576 },
    { id: 'anthropic/claude-opus-4.1', context_length: 200000 },
  ],
};

function catalogueLookup() {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true };
            done = true;
            return { done: false, value: new TextEncoder().encode(JSON.stringify(CATALOGUE)) };
          },
          async cancel() {},
        };
      },
    },
  });
  return new ModelCapacityLookup({ fetchImpl, catalogueUrl: 'https://example/models' });
}

// ------------------------------------------------------------- the session

describe('a window nobody can size takes the last one down', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-ctx-unknown-'));
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

  it('retracts the ceiling when the conversation moves to a model the catalogue misses', async function () {
    const { instance, events } = session(catalogueLookup());
    for (const event of piTurn()) instance.ingest(event);
    await settle();

    // Where the bug starts: a real turn, a real window, and a reading that is
    // correct right up to the moment the model changes.
    const filled = replay(events).usage;
    assert.strictEqual(filled.contextWindow, 1048576);
    assert.strictEqual(filled.contextWindowSource, 'provider');
    assert.strictEqual(filled.contextUsed, 8074);

    instance.ingest({
      t: 'msg_start',
      id: 'm2',
      role: 'assistant',
      turnId: 't2',
      model: '~anthropic/claude-opus-latest',
    });
    await settle();

    const retractions = events.filter(
      (event) => event.t === 'usage' && event.usage.contextWindowSource === 'unknown',
    );
    assert.strictEqual(retractions.length, 1, 'the ceiling was never taken down');
    assert.strictEqual(retractions[0].usage.contextWindow, undefined);

    const after = replay(events).usage;
    // The reading a browser is left with — and, because this went through the
    // log, the reading every rejoin after it gets too.
    assert.strictEqual(after.contextWindow, undefined);
    assert.strictEqual(after.contextWindowSource, 'unknown');
    // Occupancy is a different measurement and is not being retracted: what is
    // in the window is still known, it is the window that is not.
    assert.strictEqual(after.contextUsed, 8074);
  });

  it('says it once, not once per message on the model nobody can size', async function () {
    const { instance, events } = session(catalogueLookup());
    for (const event of piTurn()) instance.ingest(event);
    await settle();

    for (const id of ['m2', 'm3', 'm4']) {
      instance.ingest({
        t: 'msg_start',
        id,
        role: 'assistant',
        turnId: 't2',
        model: '~anthropic/claude-opus-latest',
      });
      await settle();
    }

    const retractions = events.filter(
      (event) => event.t === 'usage' && event.usage.contextWindowSource === 'unknown',
    );
    assert.strictEqual(retractions.length, 1);
  });

  it('a conversation that never had a ceiling stays silent about losing one', async function () {
    // pi on a model the catalogue does not carry, from the first message. The
    // reading already says unknown; an event saying so again would be a log
    // entry that changes nothing on screen.
    const { instance, events } = session(catalogueLookup());
    instance.ingest({
      t: 'msg_start',
      id: 'm1',
      role: 'assistant',
      turnId: 't1',
      model: '~anthropic/claude-opus-latest',
    });
    await settle();

    assert.deepStrictEqual(events.filter((event) => event.t === 'usage'), []);
  });

  it('leaves a window alone when the agent sizes the new model itself, driven by the adapter', async function () {
    // The same claim as the case below, but with the events taken off the real
    // adapter performing a real `session/set_model` rather than written by
    // hand. This is the one that would have caught the first attempt: hand
    // written, the two events went in the wrong order, and a session that
    // retracts grok's own figure passed.
    const { instance, events } = session(catalogueLookup());
    for (const event of grokWindow()) instance.ingest(event);
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'grok-build' });
    await settle();
    assert.strictEqual(replay(events).usage.contextWindow, 512000);

    for (const event of await grokModelSwitch('grok-4.5')) instance.ingest(event);
    instance.ingest({ t: 'msg_start', id: 'm2', role: 'assistant', turnId: 't2', model: 'grok-4.5' });
    await settle();

    assert.deepStrictEqual(
      events.filter((event) => event.t === 'usage' && event.usage.contextWindowSource === 'unknown'),
      [],
      'grok published 500,000 for grok-4.5 and the catalogue has never heard of the id: '
      + 'asking it must not take grok’s own answer down',
    );
    const after = replay(events).usage;
    assert.strictEqual(after.contextWindow, 500000);
    assert.strictEqual(after.contextWindowSource, 'agent');
  });

  it('leaves a window alone when the agent sizes the new model itself', async function () {
    const { instance, events } = session(catalogueLookup());
    for (const event of grokWindow()) instance.ingest(event);
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'grok-build' });
    await settle();
    assert.strictEqual(replay(events).usage.contextWindow, 512000);

    // The order the adapter really produces, which is the whole difficulty: a
    // switch is confirmed on its own channel, so the window for the new model
    // arrives BEFORE any message names it — the naming one belongs to the next
    // turn. Written the other way round this test passes on code that retracts
    // grok's own figure, because the model change is then the last word.
    instance.ingest({
      t: 'usage',
      usage: {
        contextWindow: 500000,
        contextWindowSource: 'agent',
        contextWindowModel: 'grok-4.5',
      },
    });
    instance.ingest({ t: 'msg_start', id: 'm2', role: 'assistant', turnId: 't2', model: 'grok-4.5' });
    await settle();

    assert.deepStrictEqual(
      events.filter((event) => event.t === 'usage' && event.usage.contextWindowSource === 'unknown'),
      [],
    );
    const after = replay(events).usage;
    assert.strictEqual(after.contextWindow, 500000);
    assert.strictEqual(after.contextWindowSource, 'agent');
  });

  it('replaces rather than retracts when the new model can be sized', async function () {
    const { instance, events } = session(catalogueLookup());
    for (const event of piTurn()) instance.ingest(event);
    await settle();

    instance.ingest({
      t: 'msg_start',
      id: 'm2',
      role: 'assistant',
      turnId: 't2',
      model: 'anthropic/claude-opus-4.1',
    });
    await settle();

    const after = replay(events).usage;
    assert.strictEqual(after.contextWindow, 200000);
    assert.strictEqual(after.contextWindowSource, 'provider');
  });

  it('takes the ceiling down when there is no lookup to ask at all', async function () {
    // The catalogue can be switched off, and an installation that has done so
    // is in exactly the same position as one whose lookup came back empty: it
    // does not know how big this model is. What it must not do is keep showing
    // the last model's number as if it did.
    const { instance, events } = session(undefined);
    instance.ingest({ t: 'usage', usage: { contextWindow: 512000, contextWindowSource: 'agent' } });
    instance.ingest({ t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1', model: 'grok-build' });
    await settle();
    instance.ingest({ t: 'msg_start', id: 'm2', role: 'assistant', turnId: 't2', model: 'grok-4.5' });
    await settle();

    assert.strictEqual(replay(events).usage.contextWindow, undefined);
  });
});

// --------------------------------------------------------------- the merge

describe('merging a retraction', function () {
  it('takes the window away and keeps what is in it', function () {
    const merged = mergeUsage(
      { contextWindow: 1048576, contextWindowSource: 'provider', contextUsed: 8074 },
      { contextWindowSource: 'unknown' },
    );
    assert.strictEqual(merged.contextWindow, undefined);
    assert.strictEqual(merged.contextWindowSource, 'unknown');
    assert.strictEqual(merged.contextUsed, 8074);
  });

  it('is not undone by the next report of occupancy', function () {
    const retracted = mergeUsage(
      { contextWindow: 1048576, contextWindowSource: 'provider' },
      { contextWindowSource: 'unknown' },
    );
    const merged = mergeUsage(retracted, { contextUsed: 61000 });
    assert.strictEqual(merged.contextWindow, undefined);
    assert.strictEqual(merged.contextWindowSource, 'unknown');
  });

  it('gives way the moment somebody can size the model again', function () {
    const retracted = { contextWindowSource: 'unknown', contextUsed: 8074 };
    const merged = mergeUsage(retracted, { contextWindow: 512000, contextWindowSource: 'agent' });
    assert.strictEqual(merged.contextWindow, 512000);
    assert.strictEqual(merged.contextWindowSource, 'agent');
  });

  it('still lets an ordinary report stay silent about the window', function () {
    // The rule the retraction had to be a spoken one to avoid weakening: a
    // patch that mentions only its own tokens says nothing about capacity.
    const merged = mergeUsage(
      { contextWindow: 512000, contextWindowSource: 'agent', contextUsed: 40000 },
      { outputTokens: 5 },
    );
    assert.strictEqual(merged.contextWindow, 512000);
    assert.strictEqual(merged.contextWindowSource, 'agent');
    assert.strictEqual(merged.contextUsed, 40000);
  });
});

// ------------------------------------------------------- the folded session

describe('folding a retraction into a session total', function () {
  const retraction = { t: 'usage', seq: 2, ts: 2, usage: { contextWindowSource: 'unknown' } };

  it('clears the ceiling the standalone report established', function () {
    const usage = foldSessionUsage(
      { contextWindow: 1048576, contextWindowSource: 'provider', contextUsed: 8074, costUsd: 0.02 },
      retraction,
    );
    assert.strictEqual(usage.contextWindow, undefined);
    assert.strictEqual(usage.contextWindowSource, 'unknown');
    // Everything the report did not mention is left exactly as it was.
    assert.strictEqual(usage.contextUsed, 8074);
    assert.strictEqual(usage.costUsd, 0.02);
  });

  it('does not let a clear invent an unknown where the size is known', function () {
    const cleared = foldSessionUsage(
      { contextWindow: 1048576, contextWindowSource: 'provider', contextUsed: 8074, costUsd: 0.02 },
      { t: 'marker', kind: 'cleared', seq: 3, ts: 3 },
    );
    assert.strictEqual(cleared.contextWindow, 1048576);
    assert.strictEqual(cleared.contextWindowSource, 'provider');
    assert.strictEqual(cleared.contextUsed, 0);
  });

  it('and does not let one put a known-unknown back to never-asked', function () {
    const cleared = foldSessionUsage(
      foldSessionUsage({ contextWindow: 1048576, contextWindowSource: 'provider' }, retraction),
      { t: 'marker', kind: 'cleared', seq: 3, ts: 3 },
    );
    assert.strictEqual(cleared.contextWindow, undefined);
    assert.strictEqual(cleared.contextWindowSource, 'unknown');
  });
});

// ------------------------------------------------------------- the readout

describe('what the meter says when half the reading is missing', function () {
  let mod;

  before(function () {
    this.timeout(60000);
    // UsageMeter never reaches dist/ — esbuild bundles it into app.bundle.js
    // for the browser — so it is bundled here the way the other component
    // tests in this repo do it.
    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { UsageMeter } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/UsageMeter'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `usage-meter-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'usage-meter.tsx' },
      bundle: true,
      outfile: out,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(out);
    mod.__file = out;
  });

  after(function () {
    if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
  });

  function render(usage, props) {
    const { renderToStaticMarkup, React, UsageMeter } = mod;
    const html = renderToStaticMarkup(
      React.createElement(UsageMeter, {
        usage,
        capabilities: { usage: true, cost: true },
        ...props,
      }),
    );
    return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  }

  // kimi: the provider sizes its model, kimi itself reports nothing about how
  // full it is. The header used to show the tokens, the cost, and then nothing
  // at all where the context reading goes — a silence that reads as "fine".
  it('states a window with no occupancy figure in the header', function () {
    const { text } = render({ totalTokens: 8074, contextWindow: 1048576 }, { compact: true });
    assert.ok(/\? of 1\.0M/.test(text), text);
  });

  it('and spells it out where there is room for words', function () {
    const { text } = render({ totalTokens: 8074, contextWindow: 1048576 });
    assert.ok(/1\.0M window · fill not reported/.test(text), text);
  });

  it('draws no bar against an occupancy nobody reported', function () {
    const { html } = render({ contextWindow: 1048576 }, { compact: true });
    assert.ok(!/progressbar/.test(html), html.slice(0, 300));
  });

  it('still says nothing when the runtime reports nothing', function () {
    assert.strictEqual(render({}, { compact: true }).html, '');
    assert.strictEqual(render({}).html, '');
  });

  it('reads a retracted ceiling as unknown rather than as the model that is gone', function () {
    // What the browser holds after the switch: the occupancy of the model now
    // running, and no ceiling to measure it against.
    const { html, text } = render({ contextUsed: 61000, contextWindowSource: 'unknown' });
    assert.ok(/size unknown/.test(text), text);
    assert.ok(!/1\.0M|1,048,576/.test(text), text);
    assert.ok(!/progressbar/.test(html), html.slice(0, 300));
  });

  it('and says so in the header instead of dropping the reading', function () {
    // The header is where the retracted bar used to be, and where a person
    // glances. Losing the false percentage must not mean losing the subject.
    const { html, text } = render(
      { totalTokens: 61000, contextUsed: 44000, contextWindowSource: 'unknown' },
      { compact: true },
    );
    assert.ok(/44\.0k of \?/.test(text), text);
    assert.ok(!/progressbar/.test(html), html.slice(0, 300));
  });

  it('without stuttering when the occupancy is the count already on the row', function () {
    // pi reports both from the same number, so spelling it twice — `61.0k tok ·
    // $0.02  61.0k of ?` — reads as a repeat rather than as a second fact. The
    // question mark is the part that was missing; the figure was not.
    const { text } = render(
      { totalTokens: 61000, contextUsed: 61000, contextWindowSource: 'unknown' },
      { compact: true },
    );
    assert.ok(/window \?/.test(text), text);
    assert.ok(!/61\.0k of \?/.test(text), text);
    assert.strictEqual(text.match(/61\.0k/g).length, 1, text);
  });

  it('leaves a measured reading exactly as it was', function () {
    const { html, text } = render({ contextWindow: 1048576, contextUsed: 8074 });
    assert.ok(/8\.1k \/ 1\.0M · 1%/.test(text), text);
    assert.ok(/progressbar/.test(html));
    assert.ok(!/fill not reported|size unknown/.test(text), text);
  });
});
