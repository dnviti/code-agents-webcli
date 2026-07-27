const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GrokChatAdapter } = require('../dist/server/chat/adapters/grok.js');

// handleMessage and buildArgs are `protected` in TypeScript, a compile-time
// visibility rule only: at runtime they are ordinary methods and fields, so
// tests drive them directly instead of spawning the real CLI.

function makeAdapter(overrides) {
  const events = [];
  const adapter = new GrokChatAdapter(
    Object.assign(
      {
        sessionId: 's1',
        workingDir: '/tmp',
        command: '/does/not/matter',
        emit: (event) => events.push(event),
      },
      overrides,
    ),
  );
  return { adapter, events };
}

// Every emitted event carries a non-deterministic `ts`; strip it before a
// deepStrictEqual so fixtures do not have to guess wall-clock time.
function stripTs(events) {
  return events.map((event) => {
    const { ts, ...rest } = event;
    assert.strictEqual(typeof ts, 'number');
    return rest;
  });
}

function loadFixture(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Simulates what `send()` sets up before a turn's process is spawned, without
// actually spawning one -- these are plain fields at runtime regardless of
// their `private` keyword in the source.
function beginTurn(adapter, turnId = 't1', msgId = 'm1') {
  adapter.turnId = turnId;
  adapter.msgId = msgId;
  adapter.blockIndex = 0;
  adapter.openBlockKind = null;
  adapter.messageStarted = false;
  adapter.sawTerminalEvent = false;
}

describe('grok chat adapter', function () {
  describe('capabilities', function () {
    it('claims only what the CLI docs and live probes confirmed', function () {
      const { adapter } = makeAdapter();
      assert.strictEqual(adapter.capabilities.streaming, true);
      assert.strictEqual(adapter.capabilities.thinking, true);
      assert.strictEqual(adapter.capabilities.usage, true);
      assert.strictEqual(adapter.capabilities.cost, true);
      assert.strictEqual(adapter.capabilities.resume, true);
      assert.strictEqual(adapter.capabilities.interrupt, true);
      // No tool-call event is documented for streaming-json, so none of these
      // are claimed -- see the class doc comment on what would need re-probing.
      assert.strictEqual(adapter.capabilities.toolCalls, false);
      assert.strictEqual(adapter.capabilities.diffs, false);
      assert.strictEqual(adapter.capabilities.permissions, false);
      assert.strictEqual(adapter.capabilities.fork, false);
      assert.strictEqual(adapter.capabilities.attachments, false);
      assert.strictEqual(adapter.capabilities.plan, false);
    });
  });

  describe('start', function () {
    it('announces the session without spawning anything', async function () {
      const { adapter, events } = makeAdapter({ model: 'grok-build', resumeSessionId: 'r1' });
      await adapter.start();
      assert.strictEqual(adapter.child, null);
      const stripped = stripTs(events);
      assert.strictEqual(stripped[0].t, 'session');
      assert.strictEqual(stripped[0].nativeSessionId, 'r1');
      // Not 'grok-build', which is only what was *asked for*. Grok names the
      // model it ran at the end of a turn and nowhere else, so a session that
      // has run none names none rather than presenting the request as a
      // measurement. (#75)
      assert.strictEqual(stripped[0].model, undefined);
      assert.strictEqual(stripped[0].cwd, '/tmp');
      assert.deepStrictEqual(stripped[1], { t: 'state', state: 'idle' });
    });
  });

  describe('buildArgs', function () {
    it('is just the output format by default', function () {
      const { adapter } = makeAdapter();
      assert.deepStrictEqual(adapter.buildArgs(), ['--output-format', 'streaming-json']);
    });

    it('adds --always-approve, --model and extraArgs, in that order', function () {
      const { adapter } = makeAdapter({
        bypassPermissions: true,
        model: 'grok-build',
        extraArgs: ['--reasoning-effort', 'high'],
      });
      assert.deepStrictEqual(adapter.buildArgs(), [
        '--output-format',
        'streaming-json',
        '--always-approve',
        '--model',
        'grok-build',
        '--reasoning-effort',
        'high',
      ]);
    });
  });

  describe('translating a confirmed streaming-json turn', function () {
    it('maps text, thought and end into the ChatEvent sequence', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      for (const line of loadFixture('grok-stream.jsonl')) {
        adapter.handleMessage(line);
      }

      assert.deepStrictEqual(stripTs(events), [
        {
          t: 'msg_start',
          id: 'm1',
          role: 'assistant',
          turnId: 't1',
          model: undefined,
        },
        {
          t: 'block_start',
          msgId: 'm1',
          index: 0,
          block: { kind: 'text', text: '' },
        },
        { t: 'block_delta', msgId: 'm1', index: 0, text: "Here's" },
        { t: 'block_delta', msgId: 'm1', index: 0, text: ' a summary' },
        {
          t: 'block_start',
          msgId: 'm1',
          index: 1,
          block: { kind: 'thinking', text: '' },
        },
        {
          t: 'block_delta',
          msgId: 'm1',
          index: 1,
          text: 'Analyzing the directory structure...',
        },
        {
          t: 'msg_end',
          msgId: 'm1',
          stopReason: 'EndTurn',
          usage: {
            inputTokens: 7210,
            outputTokens: 1893,
            cacheReadTokens: 41000,
            reasoningTokens: 412,
            totalTokens: 50103,
            costUsd: 0.01268905,
          },
        },
        {
          t: 'turn_end',
          turnId: 't1',
          stopReason: 'EndTurn',
          usage: {
            inputTokens: 7210,
            outputTokens: 1893,
            cacheReadTokens: 41000,
            reasoningTokens: 412,
            totalTokens: 50103,
            costUsd: 0.01268905,
          },
        },
        { t: 'state', state: 'idle' },
      ]);
    });

    it('emits msg_start exactly once, not per delta', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      for (const line of loadFixture('grok-stream.jsonl')) {
        adapter.handleMessage(line);
      }
      assert.strictEqual(events.filter((event) => event.t === 'msg_start').length, 1);
    });

    it('learns the session id from `end` for the next --resume, without re-emitting `session`', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      for (const line of loadFixture('grok-stream.jsonl')) {
        adapter.handleMessage(line);
      }
      assert.strictEqual(adapter.nativeSessionId, 'abc123');
      assert.strictEqual(events.some((event) => event.t === 'session'), false);
    });
  });

  describe('translating the live rate-limit probe', function () {
    it('maps a mid-stream error to a non-fatal error event and closes the turn', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      for (const line of loadFixture('grok-error.jsonl')) {
        adapter.handleMessage(line);
      }

      assert.deepStrictEqual(stripTs(events), [
        {
          t: 'error',
          message:
            'You’ve hit the rate limit for your plan. Upgrade your account or try again later.',
          fatal: false,
        },
        { t: 'turn_end', turnId: 't1', stopReason: 'error', usage: undefined },
        { t: 'state', state: 'idle' },
      ]);
      // Confirmed live: no `end` line follows an `error` line, and the CLI
      // process exits right after -- closeTurn happens on the error itself.
      assert.strictEqual(adapter.sawTerminalEvent, true);
    });
  });

  describe('tolerance', function () {
    it('ignores a documented-but-unshaped event type instead of guessing', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      adapter.handleMessage({ type: 'auto_compact_start' });
      adapter.handleMessage({ type: 'auto_compact_end' });
      assert.deepStrictEqual(events, []);
    });

    it('ignores a completely unknown event type', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      adapter.handleMessage({ type: 'something_a_future_grok_invents' });
      assert.deepStrictEqual(events, []);
    });

    it('never throws on malformed JSON payload shapes', function () {
      const { adapter } = makeAdapter();
      beginTurn(adapter);
      assert.doesNotThrow(() => adapter.handleMessage('just a string'));
      assert.doesNotThrow(() => adapter.handleMessage(42));
      assert.doesNotThrow(() => adapter.handleMessage(null));
      assert.doesNotThrow(() => adapter.handleMessage(true));
      assert.doesNotThrow(() => adapter.handleMessage({}));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 42 }));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'text', data: 12345 }));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'end', usage: 'not-an-object' }));
    });

    it('drops an empty text/thought chunk without opening a block', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter);
      adapter.handleMessage({ type: 'text', data: '' });
      adapter.handleMessage({ type: 'thought' });
      assert.deepStrictEqual(events, []);
    });
  });

  describe('interrupt and permissions', function () {
    it('has nothing to send SIGINT to before a turn is running', async function () {
      const { adapter } = makeAdapter();
      await assert.doesNotReject(() => adapter.interrupt());
    });

    it('respondPermission is a no-op: no channel exists to answer on', function () {
      const { adapter, events } = makeAdapter();
      assert.doesNotThrow(() => adapter.respondPermission('req1', 'allow_once'));
      assert.deepStrictEqual(events, []);
    });
  });

  describe('setModel', function () {
    it('changes what the next spawned turn will pass as -m, not a live message', async function () {
      const { adapter } = makeAdapter({ model: 'grok-build' });
      await adapter.setModel('grok-4-1');
      assert.deepStrictEqual(adapter.buildArgs(), [
        '--output-format',
        'streaming-json',
        '--model',
        'grok-4-1',
      ]);
    });
  });
});
