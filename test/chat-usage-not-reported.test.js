/**
 * Issue #136: what a conversation shows when the runtime says nothing.
 *
 * The issue's headline — "Oh My Pi does not report context window, token usage
 * or cost" — does not reproduce. omp reports all four, the adapter reads all
 * four, and the reducer carries all four; the first suite below is the
 * regression guard that keeps it that way, driven off omp's own capture rather
 * than off anything anyone here imagined.
 *
 * The agent that genuinely reports nothing is kimi. `acp-kimi-tools.jsonl` is
 * one complete kimi turn — two thought chunks, a reply, a read, a write, and a
 * prompt result of `{"stopReason":"end_turn"}` — and there is not one token
 * count, price or `usage_update` anywhere in it. Every figure and every silence
 * asserted here was read off a capture in `test/fixtures/chat`.
 *
 * The shape of the fix, and what these tests are really pinning down:
 *
 *  - a silence has to be *spoken*, because an absent field means "no news"
 *    everywhere else in this app, and "nobody has said yet" is what every
 *    conversation looks like for its first second against every agent;
 *  - it has to be spoken by something that only a finished turn can produce,
 *    never by `capabilities.usage === false`, which is also the pre-handshake
 *    state of every transcript;
 *  - and it has to survive a `/clear`, because clearing changes the
 *    conversation and not the runtime running it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const { advertisedChatCapabilities } = require('../dist/server/chat/registry.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

const ROOT = path.join(__dirname, '..');

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Replay a capture through the real ACP adapter and collect what it emitted. */
async function acpRun(name, runtime, options) {
  const events = [];
  const adapter = new AcpChatAdapter({
    sessionId: 's',
    workingDir: '/w',
    command: '/nonexistent',
    emit: (event) => events.push(event),
    readFile: async () => 'The magic word is BANANAPHONE.\n',
    writeFile: async () => {},
    runtime,
    acpArgs: ['acp'],
    ...options,
  });
  adapter.writeLine = () => {};
  const lines = fixture(name);
  const done = adapter.handshake();
  for (const line of lines.slice(0, 2)) {
    adapter.handleMessage(line);
    await flush();
  }
  await done;
  await adapter.send({ text: 'go' });
  for (const line of lines.slice(2)) {
    adapter.handleMessage(line);
    await flush();
  }
  return { events, adapter };
}

function memoryStore() {
  const events = [];
  return {
    append(_ref, batch) {
      events.push(...batch);
    },
    async stat() {
      return { firstSeq: 1, cursor: events.length };
    },
    async read() {
      return { events: [], firstSeq: 1, from: 1, cursor: events.length };
    },
  };
}

/**
 * Put adapter events through a real `ChatSession` and take back what a browser
 * would have been sent, in order. The user's own message comes from `deliver`
 * rather than from the runtime, so it is added the way every real session
 * emits it — and it is what makes the turn below a turn.
 */
function throughSession(dir, runtime, events, extra = []) {
  const sent = [];
  const session = new ChatSession(
    { id: 'sess-1', ownerUserId: 7 },
    {
      store: memoryStore(),
      socketDir: dir,
      hookScript: path.join(ROOT, 'does-not-exist.js'),
      broadcast: (_id, message) => {
        if (message.type === 'chat_event') sent.push(message.event);
      },
      resolveCommand: () => runtime,
    },
  );
  session.runtime = runtime;
  session.ingest({ t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' });
  session.ingest({ t: 'msg_end', msgId: 'u1' });
  for (const event of events) session.ingest(event);
  for (const event of extra) session.ingest(event);
  return sent;
}

/** Fold the way the browser does, so `usage` is what a person actually reads. */
function replay(events, capabilities) {
  const state = createTranscript(capabilities || {});
  events.forEach((event, index) => applyChatEvent(state, { ...event, seq: index + 1, ts: 1 }));
  return state;
}

describe('what omp reports, which is everything (#136 AC1, AC5)', function () {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-136-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries the window, the occupancy, the turn’s tokens and the money end to end', async function () {
    // Every one of these is a literal from acp-omp.jsonl: `usage_update`
    // carries size 1048576, used 27755 and $0.0950478, and the prompt reply
    // carries 28234/147/55517/27136.
    const { events } = await acpRun('acp-omp', 'omp');
    const usage = replay(throughSession(dir, 'omp', events)).usage;

    assert.strictEqual(usage.contextWindow, 1048576);
    assert.strictEqual(usage.contextWindowSource, 'agent');
    assert.strictEqual(usage.contextUsed, 27755);
    assert.strictEqual(usage.costUsd, 0.0950478);
    assert.strictEqual(usage.inputTokens, 28234);
    assert.strictEqual(usage.outputTokens, 147);
    assert.strictEqual(usage.totalTokens, 55517);
    assert.strictEqual(usage.cacheReadTokens, 27136);
  });

  it('never says an agent that reported all of it reported none of it', async function () {
    const { events } = await acpRun('acp-omp', 'omp');
    const sent = throughSession(dir, 'omp', events);

    assert.ok(
      !sent.some((event) => event.usage?.usageSource === 'none' || event.usage?.costSource === 'none'),
      'a session that was told the figures must not state a silence',
    );
    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'agent');
    assert.strictEqual(usage.costSource, 'agent');
  });

  it('still says the window once, not once per report', async function () {
    // The ACP path has exactly one `usage` event for this capture and the
    // silence must not have added a second — an extra reading of the one fact
    // this meter is would be the double-count #82 removed.
    const { events } = await acpRun('acp-omp', 'omp');
    assert.strictEqual(events.filter((event) => event.t === 'usage').length, 1);
  });

  it('names the model its window is about', async function () {
    // omp's `usage_update` says how big the window is and never which model it
    // belongs to; the name comes off the session config, which for this capture
    // is `openrouter/moonshotai/kimi-k3`. Unnamed, the next message to name a
    // model reads as a switch away from one the agent never claimed, and the
    // session takes omp's own ceiling down in favour of a catalogue lookup.
    const { events } = await acpRun('acp-omp', 'omp');
    const report = events.find((event) => event.t === 'usage' && event.usage.contextWindow);
    assert.strictEqual(report.usage.contextWindowModel, 'openrouter/moonshotai/kimi-k3');
  });
});

describe('what kimi reports, which is nothing (#136 AC4)', function () {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-136-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits not one token count, price or usage report across a whole turn', async function () {
    const { events } = await acpRun('acp-kimi-tools', 'kimi');

    assert.ok(
      events.some((event) => event.t === 'turn_end'),
      'the capture has to reach the end of a turn or it proves nothing',
    );
    assert.deepStrictEqual(
      events.filter((event) => event.t === 'usage'),
      [],
      'kimi sends no usage_update at all',
    );
    assert.deepStrictEqual(
      events
        .filter((event) => event.usage !== undefined)
        .map((event) => `${event.t}: ${JSON.stringify(event.usage)}`),
      [],
      'and nothing on its prompt reply either',
    );
  });

  it('stops claiming it can report tokens and money', async function () {
    const { adapter } = await acpRun('acp-kimi-tools', 'kimi');
    assert.strictEqual(adapter.capabilities.usage, false);
    assert.strictEqual(adapter.capabilities.cost, false);

    // And the pre-session table the launcher shows agrees with the running
    // session, which is the whole point of narrowing both.
    assert.strictEqual(advertisedChatCapabilities('kimi').usage, false);
    assert.strictEqual(advertisedChatCapabilities('kimi').cost, false);
  });

  it('leaves the other ACP agents optimistic, since the handshake corrects them', async function () {
    const { adapter } = await acpRun('acp-omp', 'omp');
    assert.strictEqual(adapter.capabilities.usage, true);
    assert.strictEqual(adapter.capabilities.cost, true);
    assert.strictEqual(advertisedChatCapabilities('omp').usage, true);
    assert.strictEqual(advertisedChatCapabilities('grok').cost, true);
  });

  it('says so out loud, once, on the turn_end that proves it', async function () {
    const { events } = await acpRun('acp-kimi-tools', 'kimi');
    const sent = throughSession(dir, 'kimi', events);

    const spoken = sent.filter(
      (event) => event.usage?.usageSource === 'none' || event.usage?.costSource === 'none',
    );
    assert.strictEqual(spoken.length, 1, 'said once, not on the end of every turn');
    assert.strictEqual(spoken[0].t, 'turn_end');
    assert.strictEqual(spoken[0].usage.usageSource, 'none');
    assert.strictEqual(spoken[0].usage.costSource, 'none');

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'none');
    assert.strictEqual(usage.costSource, 'none');
    // And no figure was invented on the way past. A confident zero is the one
    // thing worse than a blank.
    assert.strictEqual(usage.totalTokens, undefined);
    assert.strictEqual(usage.costUsd, undefined);
  });

  it('says nothing before the turn that measured it has ended', async function () {
    const { events } = await acpRun('acp-kimi-tools', 'kimi');
    const upToTurnEnd = events.slice(
      0,
      events.findIndex((event) => event.t === 'turn_end'),
    );
    const sent = throughSession(dir, 'kimi', upToTurnEnd);

    assert.ok(
      !sent.some((event) => event.usage?.usageSource === 'none'),
      'a turn still running is a runtime that has not finished not-reporting',
    );
    assert.strictEqual(replay(sent).usage.usageSource, undefined);
  });

  it('says nothing about a turn in which the runtime did no work', async function () {
    // `/clear` opens and closes a turn before it is recognised as a command.
    // Filing that as "reports nothing" would put the label on a conversation
    // whose agent had not been asked for anything yet.
    const sent = throughSession(dir, 'kimi', [{ t: 'turn_end', turnId: 'turn-1' }]);
    assert.ok(!sent.some((event) => event.usage?.usageSource === 'none'));
  });

  it('does not forget it across a /clear', async function () {
    // Clearing replaces the conversation, not the agent running it. Dropped
    // here, the header would go quiet again until the next turn ended.
    const { events } = await acpRun('acp-kimi-tools', 'kimi');
    const sent = throughSession(dir, 'kimi', events, [
      { t: 'marker', kind: 'cleared', text: 'New conversation' },
    ]);

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'none');
    assert.strictEqual(usage.costSource, 'none');
  });

  it('takes it back the moment a figure arrives', async function () {
    // The guard against the label outliving its truth: a runtime that goes
    // quiet for one turn and speaks on the next must read as having spoken.
    const { events } = await acpRun('acp-kimi-tools', 'kimi');
    const sent = throughSession(dir, 'kimi', events, [
      { t: 'turn_end', turnId: 'turn-2', usage: { inputTokens: 11, costUsd: 0.5 } },
    ]);

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'agent');
    assert.strictEqual(usage.costSource, 'agent');
  });
});

describe('an agent that reports tokens and never money (#136 AC4)', function () {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-136-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('states the missing half and keeps the half it has', async function () {
    // codex's shape, driven off codex's own numbers: the app-server prices
    // nothing, and this app holds no credentials to price a turn itself.
    const sent = throughSession(dir, 'codex', [
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1', model: 'gpt-5-codex' },
      { t: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'turn_end', turnId: 'turn-1' },
    ]);

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'agent');
    assert.strictEqual(usage.costSource, 'none');
    assert.strictEqual(usage.totalTokens, 150);
  });
});

/**
 * A turn that was cut short measured nothing, so it concludes nothing.
 *
 * The statement this feature writes is about the *runtime* and it is permanent
 * in practice: the reducer folds it, `/clear` carries it, and a rejoin re-reads
 * it off the log, so it stands until some later turn happens to report a
 * figure. That is only ever safe to write from a turn that ran to its own end.
 * Three kinds of `turn_end` did not:
 *
 *  - the acknowledgement of an interrupt sent to steer, which `chat-events.ts`
 *    marks `stale` and calls "not a turn ending" — the turn carries on with the
 *    correction, and the runtime prices a turn at the end of it;
 *  - a stop-button cancel, where the runtime is killed before the reply that
 *    would have carried the figures (`session/prompt` for ACP, the `result`
 *    message for Claude);
 *  - an ending the adapter wrote itself because the runtime errored or went
 *    away (`acp.ts` `failTurn`, `codex.ts` `closeTurn('error'|'exited')`,
 *    `pi.ts`'s crash path).
 *
 * Concluded from any of those, the app told a Claude user that Claude reports
 * neither tokens nor cost — because they had pressed stop.
 */
describe('a turn that never finished is not a measurement (#136 AC5)', function () {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-136-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A runtime that holds one process open and answers an interrupt at once.
   *
   * Claude's shape: `interrupt()` makes the CLI end its run, which arrives as a
   * `turn_end` — `claude.ts` stamps it `stopReason: str(raw.stop_reason) ??
   * subtype`. The session is what decides that ending is an acknowledgement
   * rather than an ending, so the flag under test is produced here rather than
   * written by hand.
   */
  function steerableAdapter() {
    return {
      runtime: 'claude',
      capabilities: { permissions: true, streaming: true, interrupt: true },
      alive: true,
      sent: [],
      async start() {},
      async send(turn) {
        this.sent.push(turn.text);
        this.emit({ t: 'msg_start', id: `a${this.sent.length}`, role: 'assistant', turnId: 'turn-1', model: 'claude-opus-5' });
      },
      async interrupt() {
        this.emit({ t: 'turn_end', turnId: 'turn-1', stopReason: 'interrupted' });
      },
      respondPermission() {},
      async stop() {
        this.alive = false;
      },
    };
  }

  function liveSession(adapter) {
    const sent = [];
    const session = new ChatSession(
      { id: 'sess-cut', ownerUserId: 7 },
      {
        store: memoryStore(),
        socketDir: dir,
        hookScript: path.join(ROOT, 'does-not-exist.js'),
        broadcast: (_id, message) => {
          if (message.type === 'chat_event') sent.push(message.event);
        },
        resolveCommand: () => adapter.runtime,
      },
    );
    adapter.emit = (event) => session.ingest(event);
    session.adapter = adapter;
    session.runtime = adapter.runtime;
    session.state = 'idle';
    return { session, sent };
  }

  it('says nothing off an interrupt the runtime is only acknowledging', async function () {
    const adapter = steerableAdapter();
    const { session, sent } = liveSession(adapter);
    await session.send({ text: 'refactor the auth module' });
    await session.send({ text: 'stop — the other file' });
    // The real steering path, which is what stamps `stale`.
    await session.sendQueuedNow(session.queuedTurns[0].id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const ends = sent.filter((event) => event.t === 'turn_end');
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].stale, true, 'the interrupt was acknowledged, not answered');
    assert.strictEqual(ends[0].usage, undefined, 'and nothing was concluded from it');

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, undefined);
    assert.strictEqual(usage.costSource, undefined);
  });

  it('and still says it when the turn it interrupted really does end', async function () {
    const adapter = steerableAdapter();
    const { session, sent } = liveSession(adapter);
    await session.send({ text: 'refactor the auth module' });
    await session.send({ text: 'stop — the other file' });
    await session.sendQueuedNow(session.queuedTurns[0].id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The redirected work finishing, reporting nothing. The work the stale
    // acknowledgement saw is still this turn's, which is why the statement
    // lands rather than being lost with the ending that was suppressed.
    adapter.emit({ t: 'turn_end', turnId: 'turn-1' });

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, 'none');
    assert.strictEqual(usage.costSource, 'none');
  });

  it('says nothing when the user pressed stop before the runtime priced the turn', function () {
    // Claude, mid-turn: the first message's tokens are in, the `result` that
    // carries `total_cost_usd` never arrives because the run was cancelled.
    const sent = throughSession(dir, 'claude', [
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1', model: 'claude-opus-5' },
      { t: 'msg_end', msgId: 'a1', usage: { inputTokens: 2, outputTokens: 87 } },
      { t: 'turn_end', turnId: 'turn-1', stopReason: 'aborted' },
    ]);

    const usage = replay(sent).usage;
    assert.strictEqual(usage.costSource, undefined, 'a cancelled turn is not evidence about Claude');
    assert.strictEqual(usage.usageSource, 'agent');
    assert.strictEqual(usage.outputTokens, 87);
  });

  it('says nothing off a turn the adapter ended because the runtime broke', function () {
    // `acp.ts` failTurn: an error event, then a turn_end nobody's runtime sent.
    const sent = throughSession(dir, 'omp', [
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
      { t: 'error', message: 'omp: connection reset' },
      { t: 'turn_end', turnId: 'turn-1', stopReason: 'error' },
    ]);

    const usage = replay(sent).usage;
    assert.strictEqual(usage.usageSource, undefined);
    assert.strictEqual(usage.costSource, undefined);
  });

  it('and not off Claude’s own error subtypes, which are spelled differently', function () {
    // `claude.ts` falls back to the result's `subtype` when there is no
    // `stop_reason`, and those read `error_during_execution` /
    // `error_max_turns` rather than a bare "error".
    for (const stopReason of ['error_during_execution', 'error_max_turns', 'exited', 'cancelled']) {
      const sent = throughSession(dir, 'claude', [
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1', model: 'claude-opus-5' },
        { t: 'turn_end', turnId: 'turn-1', stopReason },
      ]);
      assert.strictEqual(replay(sent).usage.usageSource, undefined, stopReason);
    }
  });

  it('but still concludes from every ordinary ending, whatever the runtime calls it', function () {
    // The other half of the rule, and the reason it is a short deny-list rather
    // than a list of the endings that count: the runtimes here spell a normal
    // ending `end_turn`, `EndTurn`, `completed`, `success` and nothing at all,
    // and an unrecognised word has to mean the turn finished or a new agent
    // would silently lose the label the feature exists to show.
    for (const stopReason of [undefined, 'end_turn', 'EndTurn', 'completed', 'success', 'max_tokens']) {
      const sent = throughSession(dir, 'kimi', [
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
        { t: 'turn_end', turnId: 'turn-1', ...(stopReason ? { stopReason } : {}) },
      ]);
      assert.strictEqual(replay(sent).usage.usageSource, 'none', String(stopReason));
    }
  });
});

describe('what the live surfaces say about a silence (#136 AC2, AC4)', function () {
  let mod;
  let bundle;

  before(function () {
    this.timeout(60000);
    // These are .tsx and never reach dist/ on their own — esbuild bundles them
    // into app.bundle.js for the browser — so they are bundled here the way the
    // other component tests in this repo do it.
    const dir = path.join(ROOT, 'src', 'client', 'shell', 'chat');
    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { UsageMeter } from ${JSON.stringify(path.join(dir, 'UsageMeter'))};`,
      `export { StatusPanel } from ${JSON.stringify(path.join(dir, 'StatusPanel'))};`,
      `export { Composer } from ${JSON.stringify(path.join(dir, 'Composer'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `usage-not-reported-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'usage-not-reported.tsx' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(bundle);
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  const CAPS = {
    streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
    interrupt: true, resume: false, fork: false, attachments: false, plan: true,
    // kimi's, once they are honest. The label has to survive them: a runtime
    // truthful enough to say it reports nothing is exactly the one whose flags
    // are false, and hiding the sentence with the figures leaves the same blank.
    usage: false, cost: false,
  };

  function text(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function meter(usage, props) {
    const { renderToStaticMarkup, React, UsageMeter } = mod;
    return text(
      renderToStaticMarkup(
        React.createElement(UsageMeter, { usage, capabilities: CAPS, ...props }),
      ),
    );
  }

  it('writes it into the compact header, where a person glances', function () {
    assert.match(meter({ usageSource: 'none', costSource: 'none' }, { compact: true }), /usage not reported/);
  });

  it('and on the phone strip, which is a second meter with less room', function () {
    assert.match(
      meter({ usageSource: 'none', costSource: 'none' }, { compact: true, phone: true }),
      /usage not reported/,
    );
  });

  it('and on the collapsed phone strip, in the width that one leaves', function () {
    // The tightest surface in the app: one 390px row already carrying a state
    // word, the bypass shield and the chevron, none of which shrink. "cost not
    // reported" put 22px of it off the side of the screen, measured in
    // test/browser/checks.ts. The slot holds nothing but the money — which is
    // why the figure is rendered bare, as `$0.12` — so the absence of it is
    // said the same way, and the title carries the noun.
    const line = meter({ costSource: 'none' }, { compact: true, phone: true, costOnly: true });
    assert.match(line, /not reported/);
    assert.doesNotMatch(line, /cost not reported/);
  });

  it('keeps the window a provider sized, which is all kimi ever has', function () {
    // The regression the honest capability flags nearly caused: the whole token
    // half of the meter used to be gated on `capabilities.usage`, and the
    // context reading was gated with it — so kimi's `? of 1.0M`, which comes
    // from the model's provider and not from kimi at all, vanished.
    const line = meter({ usageSource: 'none', costSource: 'none', contextWindow: 1048576 }, { compact: true });
    assert.match(line, /\? of 1\.0M/);
    assert.match(line, /usage not reported/);
  });

  it('spells both halves out where there is room for words', function () {
    const line = meter({ usageSource: 'none', costSource: 'none' });
    assert.match(line, /tokens not reported/);
    assert.match(line, /cost not reported/);
  });

  it('says only the half that is missing', function () {
    const line = meter(
      { totalTokens: 150, usageSource: 'agent', costSource: 'none' },
      { capabilities: { ...CAPS, usage: true }, compact: true },
    );
    assert.match(line, /cost not reported/);
    assert.doesNotMatch(line, /tokens not reported/);
    assert.match(line, /150 tok/);
  });

  it('and never over the top of a figure that did arrive', function () {
    // Belt and braces for the merge rule: even handed a contradictory reading,
    // the meter shows the number rather than the denial of it.
    const line = meter(
      { totalTokens: 150, costUsd: 0.02, usageSource: 'none', costSource: 'none' },
      { capabilities: { ...CAPS, usage: true, cost: true } },
    );
    assert.doesNotMatch(line, /not reported/);
  });

  function composer(usage, props) {
    const { renderToStaticMarkup, React, Composer } = mod;
    return text(
      renderToStaticMarkup(
        React.createElement(Composer, {
          onSend() {},
          onInterrupt() {},
          busy: false,
          capabilities: CAPS,
          turnLabel: 'turn 3',
          usage,
          ...props,
        }),
      ),
    );
  }

  it('replaces the composer’s bare turn label instead of leaving it alone', function () {
    // One phrase, not two. Restated from "tokens not reported · cost not
    // reported": this line is a single nowrap span that neither shrinks nor
    // wraps, and both phrases together measured 445px against a 390px phone —
    // the same rule the compact meter has always followed.
    assert.match(composer({ usageSource: 'none', costSource: 'none' }), /turn 3 · usage not reported/);
  });

  it('and names the half that is missing when only one of them is', function () {
    assert.match(
      composer({ totalTokens: 150, usageSource: 'agent', costSource: 'none' }),
      /turn 3 · 150 tok · cost not reported/,
    );
  });

  it('explains it in the status panel, which is the surface with room', function () {
    const { renderToStaticMarkup, React, StatusPanel } = mod;
    const transcript = {
      subscribe: () => () => {},
      getVersion: () => 0,
      usage: { usageSource: 'none', costSource: 'none' },
    };
    // `sessionId: ''` is the no-workspace branch the browser checks already
    // mount, so nothing here reaches for the network.
    const panel = text(
      renderToStaticMarkup(React.createElement(StatusPanel, { sessionId: '', transcript })),
    );
    assert.match(panel, /Usage this conversation/);
    assert.match(panel, /reports neither token counts nor costs/);
  });

  it('and says the opposite of that before anybody has spoken', function () {
    const { renderToStaticMarkup, React, StatusPanel } = mod;
    const transcript = { subscribe: () => () => {}, getVersion: () => 0, usage: {} };
    const panel = text(
      renderToStaticMarkup(React.createElement(StatusPanel, { sessionId: '', transcript })),
    );
    assert.match(panel, /Nothing has been reported yet/);
    assert.doesNotMatch(panel, /reports neither/);
  });
});

describe('claude names the model its window is about (#136)', function () {
  it('files the modelUsage key verbatim, brackets and all', async function () {
    // `claude-opus-5[1m]` reports 1,000,000 where the plain model does not, so
    // the suffix is load-bearing: a ceiling that does not say which model it
    // belongs to is one the session cannot tell from the previous model's.
    const events = [];
    const adapter = new ClaudeChatAdapter({
      sessionId: 's',
      workingDir: '/w',
      command: 'claude',
      emit: (event) => events.push(event),
    });
    adapter.send({ text: 'go' });
    for (const line of fixture('claude-model-usage')) adapter.handleMessage(line);

    const report = events.find((event) => event.usage?.contextWindow !== undefined);
    assert.strictEqual(report.usage.contextWindow, 1000000);
    assert.strictEqual(report.usage.contextWindowModel, 'claude-opus-5[1m]');
  });
});
