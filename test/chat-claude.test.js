const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');

// Protected TS methods (buildArgs, handleMessage) are ordinary methods at
// runtime; tests call them directly instead of spawning the real CLI.

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeAdapter() {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 'app-session-1',
    workingDir: '/tmp',
    command: 'claude',
    emit: (event) => events.push(event),
  });
  return { adapter, events };
}

/** Turn adapter-emitted events into a replayable transcript, seq assigned in order. */
function applyAll(events) {
  const state = createTranscript({
    streaming: true,
    thinking: true,
    toolCalls: true,
    diffs: false,
    permissions: false,
    interrupt: true,
    resume: true,
    fork: false,
    attachments: true,
    usage: true,
    cost: true,
    plan: false,
  });
  events.forEach((event, index) => {
    applyChatEvent(state, { ...event, seq: index + 1 });
  });
  return state;
}

describe('claude chat adapter', function () {
  describe('buildArgs', function () {
    it('launches with the stream-json flags and a fresh session id', function () {
      const { adapter } = makeAdapter();
      const args = adapter.buildArgs();
      assert.deepStrictEqual(args.slice(0, 7), [
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
      ]);
      const sessionFlagIndex = args.indexOf('--session-id');
      assert.ok(sessionFlagIndex !== -1);
      const uuid = args[sessionFlagIndex + 1];
      assert.match(uuid, /^[0-9a-f-]{36}$/);
    });

    it('resumes instead of minting a session id when asked', function () {
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        resumeSessionId: 'native-session-9',
        emit: (event) => events.push(event),
      });
      const args = adapter.buildArgs();
      assert.deepStrictEqual(args.slice(7, 9), ['--resume', 'native-session-9']);
      assert.ok(!args.includes('--session-id'));
    });

    it('adds the bypass flag only when requested, model and extraArgs last', function () {
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 's',
        workingDir: '/tmp',
        command: 'claude',
        resumeSessionId: 'r',
        bypassPermissions: true,
        model: 'claude-opus-5',
        extraArgs: ['--add-dir', '/extra'],
        emit: (event) => events.push(event),
      });
      const args = adapter.buildArgs();
      assert.deepStrictEqual(args.slice(7), [
        '--resume',
        'r',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-5',
        '--add-dir',
        '/extra',
      ]);
    });
  });

  describe('system/init', function () {
    it('emits a session event with the native id, cwd, model and slash commands', function () {
      const { adapter, events } = makeAdapter();
      const initLine = loadFixture('claude-oneshot.jsonl').find(
        (l) => l.type === 'system' && l.subtype === 'init',
      );
      adapter.handleMessage(initLine);

      const session = events.find((e) => e.t === 'session');
      assert.ok(session, 'expected a session event');
      assert.strictEqual(session.nativeSessionId, '9888eb38-6a83-4a98-8a41-564ebdb56c14');
      assert.strictEqual(session.cwd, '/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox');
      assert.strictEqual(session.model, 'claude-opus-5[1m]');
      assert.ok(session.capabilities.commands.length > 0);
      assert.ok(session.capabilities.commands.some((c) => c.name === 'tdd'));
      assert.strictEqual(session.capabilities.permissions, false);
      assert.strictEqual(session.capabilities.diffs, false);
    });

    it('does not put hook_started/hook_response into the transcript', function () {
      const { adapter, events } = makeAdapter();
      const lines = loadFixture('claude-oneshot.jsonl').filter((l) => l.type === 'system');
      for (const line of lines) adapter.handleMessage(line);

      // Only the init (-> session) and the two status:requesting (-> state)
      // lines should have produced anything; the two hook lines are noise.
      assert.strictEqual(events.filter((e) => e.t === 'session').length, 1);
      assert.strictEqual(events.filter((e) => e.t === 'state').length, 3); // idle (init) + 2x thinking
      assert.deepStrictEqual(
        events.map((e) => e.t),
        ['session', 'state', 'state', 'state'],
      );
    });
  });

  describe('full fixture round trip', function () {
    it('produces one tool block with parsed input and completed status', function () {
      const { adapter, events } = makeAdapter();
      const lines = loadFixture('claude-oneshot.jsonl');

      // Simulate the send() that would have produced this exchange, so the
      // stream events below attach to a real turnId instead of inventing one.
      adapter.send({ text: 'Read hello.txt then say the magic word.' });
      for (const line of lines) adapter.handleMessage(line);

      const state = applyAll(events);

      const assistantMessages = state.messages.filter((m) => m.role === 'assistant');
      assert.strictEqual(assistantMessages.length, 2, 'one message for the tool call, one for the reply');

      const toolBlocks = assistantMessages[0].blocks.filter((b) => b.kind === 'tool');
      assert.strictEqual(toolBlocks.length, 1, 'the tool_use round trip must not fork into more than one block');

      const tool = toolBlocks[0];
      assert.strictEqual(tool.name, 'Read');
      assert.strictEqual(tool.toolKind, 'read');
      assert.strictEqual(tool.status, 'completed');
      assert.deepStrictEqual(tool.input, {
        file_path: '/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox/hello.txt',
      });
      assert.ok(tool.inputPartial === undefined, 'partial JSON must be cleared once parsed');
      assert.ok(tool.output.includes('BANANAPHONE'));

      const finalText = assistantMessages[1].blocks.find((b) => b.kind === 'text');
      assert.strictEqual(finalText.text, 'BANANAPHONE');

      // Both assistant messages belong to the one user turn.
      assert.strictEqual(assistantMessages[0].turnId, assistantMessages[1].turnId);
      assert.strictEqual(state.currentTurnId, null, 'turn_end must close the turn');
    });

    it('carries cost and token usage from the result event onto turn_end', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

      const turnEnd = events.find((e) => e.t === 'turn_end');
      assert.ok(turnEnd);
      assert.strictEqual(turnEnd.stopReason, 'end_turn');
      assert.strictEqual(turnEnd.usage.costUsd, 0.19010849999999999);
      assert.strictEqual(turnEnd.usage.inputTokens, 4);
      assert.strictEqual(turnEnd.usage.outputTokens, 97);
      assert.strictEqual(turnEnd.usage.cacheReadTokens, 47287);
      assert.strictEqual(turnEnd.usage.cacheWriteTokens, 16402);
      assert.strictEqual(turnEnd.durationMs, 6997);
    });

    it('streams tool arguments as incremental json before the block closes', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

      const jsonDeltas = events.filter((e) => e.t === 'block_delta' && e.json !== undefined);
      assert.strictEqual(jsonDeltas.length, 4, 'one delta per input_json_delta line in the fixture');
      assert.strictEqual(
        jsonDeltas.map((e) => e.json).join(''),
        '{"file_path": "/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox/hello.txt"}',
      );
    });

    it('opens the tool block without a resolved input, only pending status', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      const lines = loadFixture('claude-oneshot.jsonl');
      // Feed only up to the first content_block_start so we can inspect the
      // block before any deltas or the reconciling snapshot arrive.
      const stopAt = lines.findIndex((l) => l.type === 'stream_event' && l.event.type === 'content_block_start');
      for (const line of lines.slice(0, stopAt + 1)) adapter.handleMessage(line);

      const blockStart = events.find((e) => e.t === 'block_start');
      assert.ok(blockStart);
      assert.strictEqual(blockStart.block.kind, 'tool');
      assert.strictEqual(blockStart.block.status, 'pending');
      assert.strictEqual(blockStart.block.input, undefined);
    });

    it('marks the tool running once its arguments finish streaming', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      const lines = loadFixture('claude-oneshot.jsonl');
      const stopAt = lines.findIndex((l) => l.type === 'stream_event' && l.event.type === 'content_block_stop');
      for (const line of lines.slice(0, stopAt + 1)) adapter.handleMessage(line);

      const blockEnd = events.find((e) => e.t === 'block_end' && e.index === 0);
      assert.ok(blockEnd);
      assert.deepStrictEqual(blockEnd.block, { status: 'running' });
    });

    it('does not patch status on a text block_end', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

      const blockEnds = events.filter((e) => e.t === 'block_end');
      assert.strictEqual(blockEnds.length, 2, 'one per content_block_stop in the fixture');
      assert.deepStrictEqual(blockEnds[0].block, { status: 'running' }); // the tool_use block
      assert.strictEqual(blockEnds[1].block, undefined); // the plain text block
    });

    it('ignores rate_limit_event without throwing or emitting anything', function () {
      const { adapter, events } = makeAdapter();
      assert.doesNotThrow(() => {
        adapter.handleMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
      });
      assert.strictEqual(events.length, 0);
    });
  });

  describe('malformed input', function () {
    it('never throws on an unknown message type', function () {
      const { adapter } = makeAdapter();
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'something_new_from_a_future_cli' }));
    });

    it('never throws on a stream_event with a missing/garbage payload', function () {
      const { adapter } = makeAdapter();
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'stream_event' }));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'stream_event', event: null }));
      assert.doesNotThrow(() =>
        adapter.handleMessage({ type: 'stream_event', event: { type: 'content_block_delta' } }),
      );
    });

    it('never throws on a tool_result with no matching open tool', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
      });
      // Orphan patches are legitimate (the reducer holds them); the adapter
      // itself must still emit the tool event rather than swallowing it.
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].t, 'tool');
      assert.strictEqual(events[0].toolId, 'ghost');
    });
  });

  describe('interrupt', function () {
    it('never throws when the child process was never started', async function () {
      const { adapter } = makeAdapter();
      await assert.doesNotReject(() => adapter.interrupt());
    });
  });

  describe('capabilities', function () {
    it('advertises streaming/thinking/toolCalls/resume/interrupt/attachments but not diffs or permissions', function () {
      const { adapter } = makeAdapter();
      assert.deepStrictEqual(adapter.capabilities, {
        streaming: true,
        thinking: true,
        toolCalls: true,
        diffs: false,
        permissions: false,
        interrupt: true,
        resume: true,
        fork: false,
        attachments: true,
        usage: true,
        cost: true,
        plan: false,
      });
    });
  });
});
