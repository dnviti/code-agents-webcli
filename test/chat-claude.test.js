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

      // Only the init (-> session, limits, effort, state) and the two
      // status:requesting (-> state) lines should have produced anything; the
      // two hook lines are noise. The `effort` event rides with init because
      // that is the one moment the level is knowable: it is the flag this
      // adapter passed, and claude's init line never mentions one.
      //
      // `limits` rides with it for the same reason: `apiKeySource` is on the
      // init line and nowhere else, and it is the only thing that says how this
      // conversation is billed (#137).
      assert.strictEqual(events.filter((e) => e.t === 'session').length, 1);
      assert.strictEqual(events.filter((e) => e.t === 'state').length, 3); // idle (init) + 2x thinking
      assert.deepStrictEqual(
        events.map((e) => e.t),
        ['session', 'limits', 'effort', 'state', 'state', 'state'],
      );
      // Null, not a level: this fixture was launched without `--effort`, and
      // that means "whatever claude's own default is" rather than the bottom of
      // the ladder.
      assert.strictEqual(events.find((e) => e.t === 'effort').effort, null);
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

    it('carries the cost from the result event onto turn_end', function () {
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

      const turnEnd = events.find((e) => e.t === 'turn_end');
      assert.ok(turnEnd);
      assert.strictEqual(turnEnd.stopReason, 'end_turn');
      assert.strictEqual(turnEnd.usage.costUsd, 0.19010849999999999);
      assert.strictEqual(turnEnd.durationMs, 6997);
    });

    it('does not report the result’s tokens again after the messages reported them', function () {
      // The `usage` on a result is the turn's aggregate, and the turn's own
      // messages already reported every token in it on their message_delta.
      // Everything downstream *sums* what a turn reports, so passing it through
      // charged this capture 8 in / 194 out / 94574 cache read — twice what
      // Claude said it used, on the live meter, the session line and the
      // recorded history alike, and consistently enough to look like a real
      // number. #80.
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      for (const line of loadFixture('claude-oneshot.jsonl')) adapter.handleMessage(line);

      const perMessage = events
        .filter((e) => e.t === 'msg_end' && e.usage)
        .reduce(
          (sum, e) => ({
            inputTokens: sum.inputTokens + (e.usage.inputTokens ?? 0),
            outputTokens: sum.outputTokens + (e.usage.outputTokens ?? 0),
            cacheReadTokens: sum.cacheReadTokens + (e.usage.cacheReadTokens ?? 0),
            cacheWriteTokens: sum.cacheWriteTokens + (e.usage.cacheWriteTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        );
      assert.deepStrictEqual(perMessage, {
        inputTokens: 4,
        outputTokens: 97,
        cacheReadTokens: 47287,
        cacheWriteTokens: 16402,
      }, 'the messages already account for the whole turn');

      const turnEnd = events.find((e) => e.t === 'turn_end');
      assert.strictEqual(turnEnd.usage.inputTokens, 0);
      assert.strictEqual(turnEnd.usage.outputTokens, 0);
      assert.strictEqual(turnEnd.usage.cacheReadTokens, 0);
      assert.strictEqual(turnEnd.usage.cacheWriteTokens, 0);
    });

    it('still reports the result’s tokens when no message reported any', function () {
      // A turn that failed before its first message_delta has nothing that
      // could have been counted twice, and the result is its only reading.
      const { adapter, events } = makeAdapter();
      adapter.send({ text: 'x' });
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
      });

      const turnEnd = events.find((e) => e.t === 'turn_end');
      assert.strictEqual(turnEnd.usage.inputTokens, 11);
      assert.strictEqual(turnEnd.usage.outputTokens, 22);
      assert.strictEqual(turnEnd.usage.cacheReadTokens, 33);
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

    // Restated for #137: this used to assert that a rate_limit_event produced
    // nothing at all, which pinned in place the discarding of the only account
    // telemetry Anthropic gives a client. What still has to hold is the half of
    // it that was actually a safety property — an event with nothing usable in
    // it must not throw and must not manufacture a window.
    it('ignores a rate_limit_event that names no window, without throwing', function () {
      const { adapter, events } = makeAdapter();
      assert.doesNotThrow(() => {
        adapter.handleMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
      });
      assert.strictEqual(events.length, 0);
    });
  });

  /**
   * Issue #137. Everything here is driven off real captures, because the whole
   * point of the change is that the app stopped making these figures up.
   */
  describe('account limits', function () {
    function rateLimitLine(fixture) {
      return loadFixture(fixture).find((l) => l.type === 'rate_limit_event');
    }

    it('turns a five-hour window into a limits event with the reset time', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage(rateLimitLine('claude-oneshot.jsonl'));

      const limits = events.filter((e) => e.t === 'limits');
      assert.strictEqual(limits.length, 1);
      assert.deepStrictEqual(limits[0].limits.windows, [
        {
          kind: 'five_hour',
          status: 'allowed',
          // 1784990400 seconds, not milliseconds. Read as ms this lands in 1970.
          resetsAt: '2026-07-25T14:40:00.000Z',
        },
      ]);
    });

    it('leaves out a utilization the provider did not state', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage(rateLimitLine('claude-workflow.jsonl'));

      const window = events.find((e) => e.t === 'limits').limits.windows[0];
      // Not 0. Four of the five recorded events carry no percentage at all, and
      // a meter drawn at 0% is the bug this replaced.
      assert.ok(!('utilization' in window), JSON.stringify(window));
    });

    it('carries the utilization when the provider does state one', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage(rateLimitLine('claude-subagent.jsonl'));

      const window = events.find((e) => e.t === 'limits').limits.windows[0];
      assert.strictEqual(window.kind, 'seven_day');
      assert.strictEqual(window.status, 'allowed_warning');
      assert.strictEqual(window.utilization, 0.96);
      assert.strictEqual(window.resetsAt, '2026-07-26T23:00:00.000Z');
      // One reading is a level, not a rate.
      assert.ok(!('utilizationPerHour' in window));
    });

    it('keeps both windows when both are reported', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage(rateLimitLine('claude-oneshot.jsonl'));
      adapter.handleMessage(rateLimitLine('claude-subagent.jsonl'));

      const last = events.filter((e) => e.t === 'limits').pop();
      assert.deepStrictEqual(
        last.limits.windows.map((w) => w.kind).sort(),
        ['five_hour', 'seven_day'],
      );
    });

    it('turns two readings of one window into a rate', function () {
      const { adapter, events } = makeAdapter();
      const line = rateLimitLine('claude-subagent.jsonl');
      adapter.handleMessage(line);
      // The same window an hour later, further along. Only the clock and the
      // percentage move; the reset time is what makes it the same window.
      const later = JSON.parse(JSON.stringify(line));
      later.rate_limit_info.utilization = 0.98;
      const realNow = Date.now;
      Date.now = () => realNow() + 3_600_000;
      try {
        adapter.handleMessage(later);
      } finally {
        Date.now = realNow;
      }

      const window = events.filter((e) => e.t === 'limits').pop().limits.windows[0];
      assert.ok(
        Math.abs(window.utilizationPerHour - 0.02) < 0.001,
        String(window.utilizationPerHour),
      );
    });

    it('reads apiKeySource "none" as a subscription', function () {
      const { adapter, events } = makeAdapter();
      const init = loadFixture('claude-oneshot.jsonl').find((l) => l.subtype === 'init');
      assert.strictEqual(init.apiKeySource, 'none', 'fixture precondition');
      adapter.handleMessage(init);

      assert.strictEqual(events.find((e) => e.t === 'limits').limits.billing, 'subscription');
    });

    it('reads a named key source as an API key', function () {
      const { adapter, events } = makeAdapter();
      const init = loadFixture('claude-oneshot.jsonl').find((l) => l.subtype === 'init');
      adapter.handleMessage({ ...init, apiKeySource: 'ANTHROPIC_API_KEY' });

      assert.strictEqual(events.find((e) => e.t === 'limits').limits.billing, 'api-key');
    });

    it('reads the login-provisioned key source as unknown, not as an API key', function () {
      const { adapter, events } = makeAdapter();
      const init = loadFixture('claude-oneshot.jsonl').find((l) => l.subtype === 'init');
      // Not an invented string. `/login managed key` is the literal source
      // 2.1.220's own resolver returns for the key `/login` writes into
      // `~/.claude.json` as `primaryApiKey`, and the same build groups it with
      // a claude.ai login — it looks up the organisation name and the email
      // address for it exactly as it does for `claude.ai`. So it is neither a
      // subscription anybody stated nor a key the user configured, and the rule
      // for an ambiguous source is `unknown` rather than a confident claim.
      adapter.handleMessage({ ...init, apiKeySource: '/login managed key' });

      assert.strictEqual(events.find((e) => e.t === 'limits').limits.billing, 'unknown');
    });

    it('reads a missing apiKeySource as unknown, never as a subscription', function () {
      const { adapter, events } = makeAdapter();
      // Not a hand-written line: claude-thinking-twice.jsonl was captured from a
      // CLI whose init carries no apiKeySource at all, which is the common case
      // rather than the edge one.
      const init = loadFixture('claude-thinking-twice.jsonl').find((l) => l.subtype === 'init');
      assert.ok(!('apiKeySource' in init), 'fixture precondition');
      adapter.handleMessage(init);

      assert.strictEqual(events.find((e) => e.t === 'limits').limits.billing, 'unknown');
    });

    it('lands on the transcript, so a panel can read it', function () {
      const { adapter, events } = makeAdapter();
      adapter.handleMessage(loadFixture('claude-subagent.jsonl').find((l) => l.subtype === 'init'));
      adapter.handleMessage(rateLimitLine('claude-subagent.jsonl'));

      const state = applyAll(events);
      assert.strictEqual(state.limits.billing, 'subscription');
      assert.strictEqual(state.limits.windows[0].utilization, 0.96);
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

  // Everything else in this adapter assumes streaming built the message and a
  // snapshot only patches it, which is true of anything the model answered.
  // It is not true of a command the CLI answers by itself: `/effort auto` and
  // `/model x` are handled locally and emit no `stream_event` whatsoever —
  // verified against 2.1.220, which sends exactly two lines for one, an
  // `assistant` snapshot and a `result` with `num_turns: 0`. The reply had
  // nothing to patch and was dropped, so the transcript showed the command, a
  // turn, `$0`, and no answer at all.
  describe('an answer the CLI produced without going near the model', function () {
    it('reaches the transcript even though nothing streamed it', function () {
      const { adapter, events } = makeAdapter();
      adapter.writeLine = () => {};
      adapter.send({ text: '/effort auto' });
      adapter.handleMessage({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Effort level set to auto (this session only)' }],
        },
      });

      const texts = events
        .filter((event) => event.t === 'block_start' && event.block.kind === 'text')
        .map((event) => event.block.text);
      assert.deepStrictEqual(texts, ['Effort level set to auto (this session only)']);
      assert.strictEqual(events.filter((event) => event.t === 'msg_start').length, 1);
    });

    it('does not build a second copy of a message streaming already opened', function () {
      const { adapter, events } = makeAdapter();
      adapter.writeLine = () => {};
      adapter.send({ text: 'hello' });
      adapter.handleMessage({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_2', model: 'm' } },
      });
      adapter.handleMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      });
      adapter.handleMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi there' } },
      });
      // The snapshot arrives after the deltas it describes. Treating it as a new
      // message here is the failure the whole snapshot-is-only-a-patch rule
      // exists to prevent, so the guard has to be the turn rather than the shape.
      adapter.handleMessage({
        type: 'assistant',
        message: { id: 'msg_2', model: 'm', content: [{ type: 'text', text: 'hi there' }] },
      });

      assert.strictEqual(events.filter((event) => event.t === 'msg_start').length, 1);
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
      // `efforts` is destructured out beside `commands` for the same reason: both
      // are lists rather than yes/no answers, and this test is about the flags.
      // The ladder itself is asserted below.
      const { commands, efforts, ...rest } = adapter.capabilities;
      assert.deepStrictEqual(rest, {
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

    it('advertises a baseline command list before the runtime has said anything', function () {
      const { adapter } = makeAdapter();
      assert.ok(adapter.capabilities.commands.length > 0);
      assert.ok(adapter.capabilities.commands.some((c) => c.name === 'resume'));
      assert.ok(adapter.capabilities.commands.every((c) => c.description));
    });
  });

  describe('before the first turn', function () {
    it('a freshly constructed adapter already has a non-empty command list, so the menu never starts empty', function () {
      const { adapter } = makeAdapter();
      // No handleMessage call at all here: this is the state the session sees
      // the instant the process is spawned, before Claude has said a word.
      assert.ok(Array.isArray(adapter.capabilities.commands));
      assert.ok(adapter.capabilities.commands.length > 0);
    });
  });

  // ------------------------------------------------------------------
  // issue #44: what a delegated agent did inside its own work
  // ------------------------------------------------------------------

  describe('a delegated agent, replayed from a real subagent run', function () {
    // fixtures/chat/claude-subagent.jsonl is captured traffic, not hand-written:
    // `claude -p "...use the Task tool..." --output-format stream-json --verbose
    // --include-partial-messages`. The sub-agent read a file and reported back.
    const AGENT_TOOL_ID = 'toolu_01VkR42cA7oE6ZFBiBjJJ4j4';

    function replaySubagentRun() {
      const { adapter, events } = makeAdapter();
      for (const message of loadFixture('claude-subagent.jsonl')) {
        adapter.handleMessage(message);
      }
      const state = applyAll(events);
      const [messageIndex, blockIndex] = state.toolIndex[AGENT_TOOL_ID];
      return { state, events, block: state.messages[messageIndex].blocks[blockIndex] };
    }

    it('hangs the run off the delegation that started it', function () {
      const { block } = replaySubagentRun();
      assert.strictEqual(block.name, 'Agent');
      assert.ok(block.agent, 'the delegation carries an agent run');
      assert.strictEqual(block.agent.subagentType, 'general-purpose');
      assert.ok(block.agent.prompt.includes('hello.txt'));
    });

    it('records the step the agent actually took, with its input and its result', function () {
      const { block } = replaySubagentRun();
      assert.strictEqual(block.agent.steps.length, 1);
      const [step] = block.agent.steps;
      assert.strictEqual(step.name, 'Read');
      assert.strictEqual(step.status, 'completed');
      assert.ok(step.input.file_path.endsWith('hello.txt'));
      assert.ok(step.output.includes('BANANAPHONE'));
    });

    it('keeps the tool name from the opening half rather than the closing one', function () {
      // The tool_result that completes a step carries no tool name. An earlier
      // draft sent a whole step both times and the second overwrote `Read`
      // with a placeholder.
      const { block } = replaySubagentRun();
      assert.strictEqual(block.agent.steps[0].name, 'Read');
      assert.notStrictEqual(block.agent.steps[0].toolKind, 'other');
    });

    it('reports progress inside the run, not just running vs done', function () {
      const { block } = replaySubagentRun();
      assert.strictEqual(block.agent.activity, 'Reading hello.txt');
      assert.strictEqual(block.agent.lastTool, 'Read');
      assert.strictEqual(block.agent.toolUses, 1);
      assert.ok(block.agent.totalTokens > 0);
    });

    it('marks the run finished when task_updated closes it, which names only a task_id', function () {
      const { block } = replaySubagentRun();
      assert.strictEqual(block.agent.status, 'completed');
    });

    it('leaves no orphan patches: the inner call never reaches the transcript index', function () {
      // Before this change the sub-agent's own tool_use/tool_result were
      // emitted as `tool` patches keyed by the inner id, which no block owns,
      // so they piled up in orphanToolPatches and were never rendered.
      const { state } = replaySubagentRun();
      assert.deepStrictEqual(state.orphanToolPatches, {});
      assert.strictEqual(state.toolIndex['toolu_01RL4bYrSerH1tTitSjPmG7u'], undefined);
    });

    it('does not add the sub-agent\'s own messages to the conversation', function () {
      // The agent said things to itself; the transcript shows the delegation,
      // not a second voice in the main thread.
      const { state, events } = replaySubagentRun();
      assert.ok(!events.some((e) => e.t === 'msg_start' && e.role === 'user'));
      const texts = state.messages.flatMap((m) =>
        m.blocks.filter((b) => b.kind === 'text').map((b) => b.text),
      );
      assert.ok(!texts.some((t) => t.includes('report the magic word it contains')));
    });

    it('does not blank an earlier progress report with a later, quieter one', function () {
      // task_progress names one thing at a time. The adapter emits the keys it
      // has nothing to say about as undefined, so the reducer has to merge only
      // what is actually set or the detail view blanks out mid-run.
      const { adapter, events } = makeAdapter();
      for (const message of loadFixture('claude-subagent.jsonl')) {
        adapter.handleMessage(message);
      }
      adapter.handleMessage({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'a9255a128333cff79',
        tool_use_id: AGENT_TOOL_ID,
        usage: { total_tokens: 30000 },
      });
      const state = applyAll(events);
      const [messageIndex, blockIndex] = state.toolIndex[AGENT_TOOL_ID];
      const { agent } = state.messages[messageIndex].blocks[blockIndex];
      assert.strictEqual(agent.activity, 'Reading hello.txt');
      assert.strictEqual(agent.lastTool, 'Read');
      assert.strictEqual(agent.totalTokens, 30000);
    });

    it('still delivers the delegation\'s own final result', function () {
      const { block } = replaySubagentRun();
      assert.strictEqual(block.status, 'completed');
      assert.ok(block.output.includes('BANANAPHONE'));
    });
  });
});

describe('an answer the CLI produced without going near the model', function () {
  // Claude handles some slash commands itself — `/effort auto`, `/model x` — and
  // a locally-handled command emits NO `stream_event` at all. Probed against
  // 2.1.220, which for one of them sent exactly two lines: an `assistant`
  // snapshot and a `result` with `num_turns: 0`.
  //
  // This adapter's snapshot handling is built on streaming having opened the
  // message first, so there was nothing for that reply to patch and it was
  // dropped on the floor. What the user saw was their command, a turn, `$0`,
  // and no answer whatsoever — for a command that had in fact worked.
  const snapshot = (text, id = 'msg_local') => ({
    type: 'assistant',
    message: { id, model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });

  it('reaches the transcript, even though nothing streamed it', async function () {
    const { adapter, events } = makeAdapter();
    adapter.writeLine = () => {};
    await adapter.send({ text: '/effort auto' });
    events.length = 0;

    adapter.handleMessage(snapshot('Effort level set to auto (this session only)'));

    const state = applyAll(events);
    const assistant = state.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(assistant.length, 1, 'the reply is a message of its own');
    assert.strictEqual(
      assistant[0].blocks[0].text,
      'Effort level set to auto (this session only)',
    );
  });

  it('is not built a second time when a second snapshot describes the same answer', function () {
    const { adapter, events } = makeAdapter();
    adapter.handleMessage(snapshot('once'));
    adapter.handleMessage(snapshot('once'));

    const state = applyAll(events);
    assert.strictEqual(state.messages.filter((m) => m.role === 'assistant').length, 1);
  });

  it('leaves a streamed answer alone, so an ordinary turn is never doubled', function () {
    const { adapter, events } = makeAdapter();
    // The shape a real turn arrives in: streaming opens the message, and the
    // snapshot that follows exists only to patch what it built.
    adapter.handleMessage({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_streamed', model: 'claude-opus-5' } },
    });
    adapter.handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    adapter.handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    });
    adapter.handleMessage(snapshot('hello', 'msg_streamed'));

    const state = applyAll(events);
    const assistant = state.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(assistant.length, 1, 'one message, not two');
    assert.strictEqual(assistant[0].blocks[0].text, 'hello');
  });

  it('says nothing for a snapshot that carries no text to say', function () {
    const { adapter, events } = makeAdapter();
    adapter.handleMessage({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    });
    assert.strictEqual(
      events.filter((e) => e.t === 'msg_start').length,
      0,
      'a tool-only snapshot still only patches',
    );
  });
});
