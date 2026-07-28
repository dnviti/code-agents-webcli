const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');

// The projection is client TypeScript with no build of its own, so it is
// bundled the same way chat-activity.test.js does it.
const ROOT = path.join(__dirname, '..');
let bundle;
let activityEvents;
let activityMeta;
let reasoningNote;

before(function () {
  this.timeout(60000);
  bundle = path.join(os.tmpdir(), `chat-reasoning-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'activity'))};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'chat-reasoning.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  ({ activityEvents, activityMeta, reasoningNote } = require(bundle));
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

// Issue #120: a reasoning entry that expands into an empty panel.
//
// One suite for every runtime the app drives, because the failure was
// per-runtime and invisible: each one reports reasoning differently, one of
// them working says nothing about the rest, and the surface they share showed
// the same blank box whichever of them had gone quiet. What each is asserted to
// do here is what it was watched doing -- see the notes on each block.
//
// The adapters' protected methods are a compile-time visibility rule only; at
// runtime they are ordinary methods, so translation is driven directly instead
// of spawning six CLIs.

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const CAPABILITIES = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  interrupt: true,
  resume: true,
  fork: false,
  attachments: true,
  usage: true,
  cost: true,
  plan: true,
};

/**
 * Assign seq/ts the way a live session would, then fold through the shared
 * reducer.
 *
 * Through JSON on the way in, because that is the only way the reducer ever
 * receives an event -- off a socket frame or off the durable log -- and because
 * `block_start` hands its block to the transcript by reference. Replaying the
 * same in-memory events twice would otherwise fold a second turn's worth of
 * deltas into the first turn's blocks.
 */
function replay(events) {
  const state = createTranscript(CAPABILITIES);
  let seq = 0;
  for (const event of events) {
    applyChatEvent(state, JSON.parse(JSON.stringify({ ...event, seq: ++seq, ts: event.ts ?? 1_000 })));
  }
  return state;
}

function thinkingBlocks(state) {
  const found = [];
  for (const message of state.messages) {
    message.blocks.forEach((block, index) => {
      if (block.kind === 'thinking') found.push({ message, index, block });
    });
  }
  return found;
}

async function claudeEvents() {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 's', workingDir: '/w', command: 'claude', emit: (event) => events.push(event),
  });
  for (const line of fixture('claude-subagent')) adapter.handleMessage(line);
  await flush();
  return events;
}

async function codexEvents() {
  const events = [];
  const adapter = new CodexAppServerAdapter({
    sessionId: 's', workingDir: '/w', command: 'codex', emit: (event) => events.push(event),
  });
  adapter.writeLine = () => {};
  for (const line of fixture('codex-appserver-reasoning')) {
    adapter.handleMessage(line);
    await flush();
  }
  return events;
}

async function acpEvents(name) {
  const events = [];
  const adapter = new AcpChatAdapter({
    sessionId: 's',
    workingDir: '/w',
    command: '/nonexistent',
    runtime: name,
    emit: (event) => events.push(event),
    readFile: async () => '',
    writeFile: async () => {},
  });
  adapter.writeLine = () => {};
  const lines = fixture(name === 'grok' ? 'acp-grok' : name === 'kimi' ? 'acp-kimi-tools' : 'acp-omp');
  const done = adapter.handshake();
  for (const line of lines.slice(0, 2)) {
    adapter.handleMessage(line);
    await flush();
  }
  await done;
  for (const line of lines.slice(2)) {
    adapter.handleMessage(line);
    await flush();
  }
  return events;
}

function piEvents() {
  const events = [];
  const adapter = new PiChatAdapter({
    sessionId: 's', workingDir: '/w', command: 'pi', emit: (event) => events.push(event),
  });
  for (const line of fixture('pi-final-turn')) adapter.handleMessage(line);
  return events;
}

describe('reasoning on the activity trace (#120)', function () {
  describe('claude', function () {
    // Probed live against 2.1.220 with `--effort high`: the CLI opens
    // `{"type":"thinking","thinking":""}`, streams `thinking_delta`s that are
    // also empty, and describes the block only through the `thinking_tokens`
    // system line running beside it (50, then 135 cumulative in this capture).
    // So the contract for claude is the opposite of the others: no text, and a
    // size that has to survive to the UI or the row has nothing at all to say.
    it('carries the size of reasoning claude will not show the text of', async function () {
      const state = replay(await claudeEvents());
      const blocks = thinkingBlocks(state);

      assert.strictEqual(blocks.length, 1, 'the fixture reasons exactly once');
      assert.strictEqual(blocks[0].block.text, '', 'claude sends no reasoning text');
      assert.strictEqual(blocks[0].block.tokens, 135, 'the size claude reported');
    });

    it('says so on the row rather than leaving it blank', async function () {
      const state = replay(await claudeEvents());
      const [reasoning] = activityEvents(state.messages).filter((e) => e.kind === 'reasoning');

      assert.strictEqual(reasoning.target, 'text not reported by this agent');
      assert.strictEqual(activityMeta(reasoning), '~135 tok');
      assert.match(reasoningNote(reasoning.block, false), /135 tokens of reasoning/);
    });

    it('gives each reasoning block its own size when a turn reasons twice', async function () {
      // Captured from a live `claude --effort high` turn that read a file and
      // thought either side of it: the CLI's counter runs 50 -> 114 for the
      // first block and then *restarts* at 50 -> 152 for the second. Read as
      // one running total the second block reports 38, or nothing at all.
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 's', workingDir: '/w', command: 'claude', emit: (event) => events.push(event),
      });
      for (const line of fixture('claude-thinking-twice')) adapter.handleMessage(line);
      await flush();
      const blocks = thinkingBlocks(replay(events));

      assert.strictEqual(blocks.length, 2, 'the capture reasons twice');
      assert.deepStrictEqual(blocks.map((entry) => entry.block.tokens), [114, 152]);
      assert.deepStrictEqual(blocks.map((entry) => entry.block.text), ['', '']);
    });

    it('and its own size when both blocks are inside one message', async function () {
      // The captures put one thinking block in each message. This is the
      // arrangement the wire also allows and nothing has been watched doing:
      // two blocks in one message, where no message boundary separates the two
      // runs of the counter. Event shapes are the CLI's own, taken from the
      // capture above; the arrangement is what is being asked about.
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 's', workingDir: '/w', command: 'claude', emit: (event) => events.push(event),
      });
      const stream = (event) => adapter.handleMessage({ type: 'stream_event', event });
      const counted = (estimated) =>
        adapter.handleMessage({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated });

      stream({ type: 'message_start', message: { id: 'm1', model: 'claude-opus-5' } });
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      counted(50);
      counted(114);
      stream({ type: 'content_block_stop', index: 0 });
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } });
      counted(50);
      counted(152);
      stream({ type: 'content_block_stop', index: 1 });
      stream({ type: 'message_stop' });
      await flush();
      const blocks = thinkingBlocks(replay(events));

      assert.deepStrictEqual(blocks.map((entry) => entry.block.tokens), [114, 152]);
    });

    it('counts the size against the block that was open, not the one before it', async function () {
      // The CLI's counter restarts per block. Two blocks that each reported 50
      // must read 50 and 50, never 50 and 100.
      const events = [
        { t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1' },
        { t: 'block_start', msgId: 'm1', index: 0, block: { kind: 'thinking', text: '' } },
        { t: 'block_delta', msgId: 'm1', index: 0, tokens: 50 },
        { t: 'block_end', msgId: 'm1', index: 0 },
        { t: 'block_start', msgId: 'm1', index: 1, block: { kind: 'thinking', text: '' } },
        { t: 'block_delta', msgId: 'm1', index: 1, tokens: 50 },
        { t: 'msg_end', msgId: 'm1' },
      ];
      const blocks = thinkingBlocks(replay(events));

      assert.deepStrictEqual(blocks.map((entry) => entry.block.tokens), [50, 50]);
    });

    it('keeps the reported size when the log is replayed, as a reload does', async function () {
      const events = await claudeEvents();
      const first = thinkingBlocks(replay(events))[0].block;
      const second = thinkingBlocks(replay(events))[0].block;

      assert.strictEqual(second.tokens, first.tokens);
      assert.strictEqual(second.tokens, 135);
    });
  });

  describe('codex', function () {
    // The one runtime that could not be driven live for this issue -- the
    // account was over its usage limit both times it was asked -- so the
    // fixture is written to codex's own schema export (`ReasoningThreadItem`,
    // `ReasoningTextDeltaNotification`, `ReasoningSummaryTextDeltaNotification`
    // under .work/probes/raw/codex-schema), in the same spirit as the other
    // codex app-server fixtures. What is *not* a guess: 22,987 reasoning items
    // across 155 of this machine's own codex rollouts carry an empty summary
    // and encrypted content, which is the third case below.
    it('shows a reasoning summary, which is all an encrypted trace ever offers', async function () {
      const state = replay(await codexEvents());
      const blocks = thinkingBlocks(state);

      assert.strictEqual(blocks[0].block.text, 'Counting the sheep before answering.');
    });

    it('prefers the trace over the summary when codex sends both', async function () {
      const state = replay(await codexEvents());
      const blocks = thinkingBlocks(state);

      assert.strictEqual(blocks[1].block.text, 'All but nine is the trap.');
    });

    it('leaves a reasoning item that carried neither for the panel to explain', async function () {
      const state = replay(await codexEvents());
      const blocks = thinkingBlocks(state);

      assert.strictEqual(blocks[2].block.text, '');
      assert.strictEqual(
        reasoningNote(blocks[2].block, false),
        'This agent reported that it reasoned here, but not the text of it.',
      );
    });

    it('never doubles a summary that the trace then replaced', async function () {
      const state = replay(await codexEvents());
      const text = thinkingBlocks(state)[1].block.text;

      assert.strictEqual(text.includes('All but nine is the trap.'), true);
      assert.strictEqual(text.indexOf('All but nine'), text.lastIndexOf('All but nine'));
    });
  });

  // grok, kimi and omp share one adapter and one wire format, and the captures
  // below are their own traffic. kimi and omp were also driven live for this
  // issue and both showed their reasoning; grok's own API was erroring at the
  // time ("responses API error", eight retries and no turn), so it stands on
  // its capture through the same code path.
  for (const runtime of ['grok', 'kimi', 'omp']) {
    it(`${runtime} shows the reasoning it streamed as thought chunks`, async function () {
      const state = replay(await acpEvents(runtime));
      const blocks = thinkingBlocks(state);

      assert.ok(blocks.length > 0, `${runtime} produced no reasoning block`);
      assert.ok(blocks[0].block.text.trim().length > 0, `${runtime} reasoning block is empty`);
      assert.strictEqual(reasoningNote(blocks[0].block, false), null);
    });
  }

  it('pi shows the reasoning it streamed alongside the answer', function () {
    const state = replay(piEvents());
    const blocks = thinkingBlocks(state);

    assert.ok(blocks.length > 0, 'pi produced no reasoning block');
    assert.ok(blocks[0].block.text.trim().length > 0, 'pi reasoning block is empty');
    assert.strictEqual(reasoningNote(blocks[0].block, false), null);
  });

  describe('the panel is never empty, whichever runtime filled it', function () {
    it('gives every reasoning row either text or a reason there is none', async function () {
      const sources = [
        ['claude', await claudeEvents()],
        ['codex', await codexEvents()],
        ['grok', await acpEvents('grok')],
        ['kimi', await acpEvents('kimi')],
        ['omp', await acpEvents('omp')],
        ['pi', piEvents()],
      ];

      for (const [runtime, events] of sources) {
        const state = replay(events);
        const rows = activityEvents(state.messages).filter((event) => event.kind === 'reasoning');
        assert.ok(rows.length > 0, `${runtime} produced no reasoning row at all`);
        for (const row of rows) {
          const hasText = Boolean((row.block.text || '').trim());
          const note = reasoningNote(row.block, row.status === 'running');
          assert.ok(hasText || note, `${runtime} row would render an empty panel`);
          assert.ok(row.target.length > 0, `${runtime} row has no collapsed preview`);
        }
      }
    });

    it('previews the reasoning text on the collapsed row wherever there is text', function () {
      const state = replay(piEvents());
      const [row] = activityEvents(state.messages).filter((event) => event.kind === 'reasoning');
      const firstLine = row.block.text.trim().split('\n')[0];

      assert.ok(row.target.length > 0);
      assert.ok(firstLine.startsWith(row.target.slice(0, 20)));
      assert.match(activityMeta(row), /tok$/);
    });

    it('says it is still reasoning while the block is open, and only then', function () {
      const open = { kind: 'thinking', text: '' };

      assert.strictEqual(reasoningNote(open, true), 'Reasoning now. Nothing has arrived from the agent yet.');
      assert.strictEqual(
        reasoningNote(open, false),
        'This agent reported that it reasoned here, but not the text of it.',
      );
      assert.strictEqual(reasoningNote({ kind: 'thinking', text: 'weighing it up' }, false), null);
    });

    it('shows a live reasoning row as thinking rather than as missing text', function () {
      const state = replay([
        { t: 'msg_start', id: 'm1', role: 'assistant', turnId: 't1' },
        { t: 'block_start', msgId: 'm1', index: 0, block: { kind: 'thinking', text: '' } },
        { t: 'block_delta', msgId: 'm1', index: 0, tokens: 40 },
      ]);
      const [row] = activityEvents(state.messages).filter((event) => event.kind === 'reasoning');

      assert.strictEqual(row.status, 'running');
      assert.strictEqual(row.target, 'thinking…');
      assert.strictEqual(row.tokens, 40, 'the size has to reach the row, not just the block');
      assert.strictEqual(activityMeta(row), '~40 tok');
    });
  });
});
