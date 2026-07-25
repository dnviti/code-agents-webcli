const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');

// handleMessage, buildArgs, buildTurnArgs and every private field below are
// TypeScript-private only; at runtime they are ordinary members, so the
// adapter can be driven directly with recorded protocol lines instead of a
// real pi process.

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeAdapter(options) {
  const events = [];
  const adapter = new PiChatAdapter(
    Object.assign(
      {
        sessionId: 's1',
        workingDir: '/work',
        command: 'pi',
        emit: (event) => events.push(event),
      },
      options,
    ),
  );
  return { adapter, events };
}

function feed(adapter, lines) {
  for (const line of lines) adapter.handleMessage(line);
}

/** Assigns seq/ts the way a real session would, then folds through the shared reducer. */
function replay(events, capabilities) {
  const state = createTranscript(capabilities);
  let seq = 0;
  for (const event of events) {
    applyChatEvent(state, Object.assign({}, event, { seq: ++seq, ts: event.ts ?? Date.now() }));
  }
  return state;
}

describe('pi chat adapter', function () {
  it('reports capabilities matching what the protocol actually shows', function () {
    const { adapter } = makeAdapter();
    assert.strictEqual(adapter.runtime, 'pi');
    assert.strictEqual(adapter.capabilities.thinking, true);
    assert.strictEqual(adapter.capabilities.toolCalls, true);
    assert.strictEqual(adapter.capabilities.usage, true);
    assert.strictEqual(adapter.capabilities.cost, true);
    assert.strictEqual(adapter.capabilities.streaming, true);
    assert.strictEqual(adapter.capabilities.attachments, true);
    // Not evidenced by the fixture or --help: must stay honest, not optimistic.
    assert.strictEqual(adapter.capabilities.permissions, false);
    assert.strictEqual(adapter.capabilities.diffs, false);
    assert.strictEqual(adapter.capabilities.plan, false);
    assert.strictEqual(adapter.capabilities.fork, false);
  });

  it('emits one session event even though every respawned turn reports "session" again', function () {
    const { adapter, events } = makeAdapter();
    const sessionLine = loadFixture('pi-session.jsonl')[0];
    feed(adapter, [sessionLine, sessionLine, sessionLine]);
    const sessionEvents = events.filter((e) => e.t === 'session');
    assert.strictEqual(sessionEvents.length, 1);
    assert.strictEqual(sessionEvents[0].nativeSessionId, '019f994c-acac-70ab-b806-1cad4f934c17');
    assert.strictEqual(sessionEvents[0].cwd, '/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox');
  });

  it('adopts a resumeSessionId at start() and does not need pi to report one', async function () {
    const { adapter, events } = makeAdapter({ resumeSessionId: 'resumed-abc' });
    await adapter.start();
    const sessionEvents = events.filter((e) => e.t === 'session');
    assert.strictEqual(sessionEvents.length, 1);
    assert.strictEqual(sessionEvents[0].nativeSessionId, 'resumed-abc');
  });

  it('turns pi\'s cumulative message_update stream into incremental deltas with no duplication', function () {
    // This fixture slice contains the exact case that makes cumulative-vs-delta
    // matter: two consecutive updates report the same cumulative thinking text
    // ("The"), even though pi's own (unreliable) delta field claims text arrived
    // twice. Diffing against what was already emitted must produce nothing on
    // the second line, not a repeated "The".
    const { adapter, events } = makeAdapter();
    adapter.currentTurnId = 'turn-1';
    feed(adapter, loadFixture('pi-final-turn.jsonl'));

    const state = replay(events, adapter.capabilities);
    assert.strictEqual(state.messages.length, 1);
    const message = state.messages[0];
    assert.strictEqual(message.blocks[0].kind, 'thinking');
    assert.strictEqual(
      message.blocks[0].text,
      'The file contains "The magic word is BANANAPHONE." Reply with only the magic word.',
    );
    assert.strictEqual(message.blocks[1].kind, 'text');
    assert.strictEqual(message.blocks[1].text, 'BANANAPHONE');

    // The actual anti-duplication assertion: every character streamed across
    // all block_delta events for the thinking block, concatenated, equals the
    // final text exactly once — not the cumulative snapshot re-sent per line.
    const thinkingDeltas = events.filter((e) => e.t === 'block_delta' && e.msgId === message.id && e.index === 0);
    assert.ok(thinkingDeltas.length > 1, 'expected more than one incremental delta');
    const rebuilt = thinkingDeltas.map((e) => e.text).join('');
    assert.strictEqual(rebuilt, message.blocks[0].text);

    // Same check for the text block.
    const textDeltas = events.filter((e) => e.t === 'block_delta' && e.msgId === message.id && e.index === 1);
    assert.strictEqual(textDeltas.map((e) => e.text).join(''), message.blocks[1].text);
  });

  it('closes out the turn on agent_settled with the usage seen so far', function () {
    const { adapter, events } = makeAdapter();
    adapter.currentTurnId = 'turn-1';
    feed(adapter, loadFixture('pi-final-turn.jsonl'));

    const turnEnd = events.find((e) => e.t === 'turn_end');
    assert.ok(turnEnd, 'expected a turn_end event');
    assert.strictEqual(turnEnd.turnId, 'turn-1');
    assert.strictEqual(turnEnd.usage.costUsd, 0.0084492);
    assert.strictEqual(turnEnd.usage.totalTokens, 8178);

    const stateEvents = events.filter((e) => e.t === 'state');
    assert.strictEqual(stateEvents[stateEvents.length - 1].state, 'idle');
    // agent_settled must also close currentTurnId, so a stray second
    // agent_settled (should not happen, but costs nothing to guard) is a no-op.
    const before = events.length;
    adapter.handleMessage({ type: 'agent_settled' });
    assert.strictEqual(events.length, before);
  });

  it('streams a tool call\'s arguments from cumulative partialArgs, then closes it with the parsed object', function () {
    const { adapter, events } = makeAdapter();
    adapter.currentTurnId = 'turn-1';
    feed(adapter, loadFixture('pi-tool-turn.jsonl'));

    const state = replay(events, adapter.capabilities);
    const message = state.messages[0];
    const toolBlock = message.blocks[1];
    assert.strictEqual(toolBlock.kind, 'tool');
    assert.strictEqual(toolBlock.toolId, 'read_0');
    assert.strictEqual(toolBlock.name, 'read');
    assert.strictEqual(toolBlock.toolKind, 'read');
    assert.deepStrictEqual(toolBlock.input, { path: 'hello.txt' });
    assert.strictEqual(toolBlock.inputPartial, undefined);

    // tool_execution_start/end must have driven it the rest of the way.
    assert.strictEqual(toolBlock.status, 'completed');
    assert.strictEqual(toolBlock.output, 'The magic word is BANANAPHONE.\n');
    assert.strictEqual(typeof toolBlock.durationMs, 'number');
  });

  it('reports a tool patch as running before it reports it completed', function () {
    const { adapter, events } = makeAdapter();
    adapter.currentTurnId = 'turn-1';
    feed(adapter, loadFixture('pi-tool-turn.jsonl'));

    const toolPatches = events.filter((e) => e.t === 'tool' && e.toolId === 'read_0');
    assert.strictEqual(toolPatches.length, 2);
    assert.strictEqual(toolPatches[0].patch.status, 'running');
    assert.strictEqual(toolPatches[1].patch.status, 'completed');
  });

  it('sums usage across every internal pi turn into the one turn_end for the whole invocation', function () {
    const { adapter, events } = makeAdapter();
    adapter.currentTurnId = 'turn-1';
    feed(adapter, loadFixture('pi-full-invocation.jsonl'));

    const sessionEvents = events.filter((e) => e.t === 'session');
    assert.strictEqual(sessionEvents.length, 1);

    const msgStarts = events.filter((e) => e.t === 'msg_start');
    // Two assistant messages (tool-use, then final answer); the user's own
    // echoed message and the toolResult message produce no msg_start.
    assert.strictEqual(msgStarts.length, 2);

    const turnEnd = events.find((e) => e.t === 'turn_end');
    assert.ok(turnEnd);
    assert.strictEqual(turnEnd.turnId, 'turn-1');
    // 0.0236136 (tool-use turn) + 0.0084492 (final answer turn), from the fixture.
    assert.ok(Math.abs(turnEnd.usage.costUsd - 0.0320628) < 1e-9);
    assert.strictEqual(turnEnd.usage.totalTokens, 16278);
  });

  it('builds one-shot argv with mode, model, session resume and attachments in order', function () {
    const { adapter } = makeAdapter({ model: 'vendor/model-x' });
    assert.deepStrictEqual(adapter.buildArgs(), ['--mode', 'json', '--model', 'vendor/model-x']);

    assert.deepStrictEqual(adapter.buildTurnArgs({ text: 'hello' }), [
      '--mode',
      'json',
      '--model',
      'vendor/model-x',
      '-p',
      'hello',
    ]);

    adapter.nativeSessionId = 'native-1';
    assert.deepStrictEqual(
      adapter.buildTurnArgs({
        text: 'hello again',
        attachments: [{ url: '/files/a', mime: 'text/plain', name: 'a.txt', size: 1, path: '/tmp/a.txt' }],
      }),
      ['--mode', 'json', '--model', 'vendor/model-x', '--session-id', 'native-1', '@/tmp/a.txt', '-p', 'hello again'],
    );
  });

  it('never throws out of handleMessage on a malformed line', function () {
    const { adapter } = makeAdapter();
    assert.doesNotThrow(() => adapter.handleMessage(null));
    assert.doesNotThrow(() => adapter.handleMessage('not an object'));
    assert.doesNotThrow(() => adapter.handleMessage({ type: 'message_update', message: { role: 'assistant' } }));
    assert.doesNotThrow(() => adapter.handleMessage({ type: 'something_pi_added_later' }));
  });
});
