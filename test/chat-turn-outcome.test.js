const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { GrokChatAdapter } = require('../dist/server/chat/adapters/grok.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { NO_CHAT_CAPABILITIES } = require('../dist/shared/chat-events.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const { turnOutcomeOf } = require('../dist/shared/turn-outcome.js');
const { ChatStore } = require('../dist/server/chat/store.js');

// What a turn's badge says, proved end to end: the capture each agent really
// produced, through that agent's adapter, through the reducer, into the same
// grouping the turn index and the sticky strip read.
//
// Asserting on `turnOutcomeOf` alone would only prove the table agrees with
// itself. The thing worth knowing is whether the word a runtime actually uses
// to end a turn survives the whole path — and, for the fixtures with a failed
// step in them, that the step no longer decides the turn (issue #74).
//
// The fixtures are the same ones the per-adapter suites use; see their headers
// for what was captured live and what was written to a published schema.

const ROOT = path.join(__dirname, '..');

let bundle;
let turns;

before(function () {
  this.timeout(60000);
  // groupTurns lives under src/client and only reaches Node through esbuild.
  bundle = path.join(os.tmpdir(), `chat-turn-outcome-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'turns'))};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'turns.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  turns = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

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

/**
 * Put the user's own message in front of what the adapter emitted.
 *
 * Most adapters never emit it — the session writes the user's turn into the log
 * above them — and without it a capture is a group of assistant messages with
 * no opener, which is not what any of these conversations looked like. The turn
 * id is taken from the adapter's own events so `turn_end` reaches it, exactly
 * as it does in a real session.
 *
 * acp and codex do open the user's message themselves, so a stream that already
 * has one is left alone rather than given a second opener, which would split
 * one turn into two.
 */
function withUser(events) {
  if (events.some((event) => event.t === 'msg_start' && event.role === 'user')) return events;
  const carrier = events.find((event) => typeof event.turnId === 'string' && event.turnId);
  const turnId = carrier ? carrier.turnId : 't';
  return [
    { t: 'msg_start', ts: 0, id: 'u0', role: 'user', turnId },
    { t: 'block_start', ts: 0, msgId: 'u0', index: 0, block: { kind: 'text', text: 'go' } },
    { t: 'msg_end', ts: 0, msgId: 'u0' },
    ...events,
  ];
}

/** Fold what an adapter emitted into a transcript, seq assigned in order. */
function replay(events, capabilities) {
  const state = createTranscript(capabilities || NO_CHAT_CAPABILITIES);
  withUser(events).forEach((event, index) => applyChatEvent(state, { ...event, seq: index + 1 }));
  return state;
}

/** The one turn a capture contains, as the turn index would draw it. */
function badgeOf(state) {
  const grouped = turns.groupTurns(state.messages, state.state);
  assert.strictEqual(grouped.length, 1, 'expected the capture to fold into one turn');
  return grouped[0];
}

describe('what a turn ended as', function () {
  describe('the stop reason each runtime ends a turn with', function () {
    it('reads the words that mean the turn itself did not complete', function () {
      for (const reason of [
        'error',
        'failed',
        'exited',
        'error_during_execution',
        'error_max_turns',
        'max_turns_reached',
        'max_turn_requests',
      ]) {
        assert.strictEqual(turnOutcomeOf(reason), 'failed', reason);
      }
    });

    it('reads a turn that ran to completion as done, whatever it ended saying', function () {
      for (const reason of [
        'end_turn',
        // opencode capitalises the same protocol word.
        'EndTurn',
        'stop',
        'toolUse',
        'tool_use',
        'completed',
        'success',
        // The user stopped it. Nothing went wrong, and painting their own
        // decision red is the complaint this work exists to fix.
        'interrupted',
        'cancelled',
        // The agent answered; the answer is that it would not do the thing.
        'refusal',
        // Truncated, not missing.
        'max_tokens',
      ]) {
        assert.strictEqual(turnOutcomeOf(reason), 'done', reason);
      }
    });

    it('reads no reason at all as done, because pi ends a good turn with none', function () {
      assert.strictEqual(turnOutcomeOf(undefined), 'done');
      assert.strictEqual(turnOutcomeOf(''), 'done');
    });

    it('reads a word it has never seen as done rather than guessing failure', function () {
      // A runtime growing a new vocabulary word is not evidence anything went
      // wrong, and a badge that guesses is the badge this issue is about.
      assert.strictEqual(turnOutcomeOf('auto_compact_finished'), 'done');
    });
  });

  describe('claude', function () {
    function drive(lines) {
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => events.push(event),
      });
      for (const line of lines) adapter.handleMessage(line);
      return replay(events, adapter.capabilities);
    }

    it('ends a completed turn as done', function () {
      assert.strictEqual(badgeOf(drive(fixture('claude-oneshot'))).status, 'done');
    });

    it('ends a long turn with failed steps in it as done', function () {
      // The complaint itself, over a real recording. The only thing changed in
      // the capture is that one tool result comes back as an error, in the
      // shape claude sends for one — the turn still ends `end_turn` / success,
      // which is what makes this the case the badge used to get wrong.
      const lines = fixture('claude-subagent').map((line) => {
        const content = line?.message?.content;
        if (!Array.isArray(content)) return line;
        const result = content.find((block) => block.type === 'tool_result');
        if (!result) return line;
        return {
          ...line,
          message: {
            ...line.message,
            content: content.map((block) =>
              block === result
                ? { ...block, is_error: true, content: 'Error: No matches found' }
                : block,
            ),
          },
        };
      });

      const state = drive(lines);
      const turn = badgeOf(state);

      assert.ok(turn.failedStepCount > 0, 'expected the capture to contain a failed step');
      assert.strictEqual(turn.status, 'done');

      // And the step it failed on is still failed where the step is shown.
      const failed = state.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.kind === 'tool' && block.status === 'failed');
      assert.strictEqual(failed.length, turn.failedStepCount);
    });
  });

  describe('grok', function () {
    function drive(lines) {
      const events = [];
      const adapter = new GrokChatAdapter({
        sessionId: 's1',
        workingDir: '/tmp',
        command: 'grok',
        emit: (event) => events.push(event),
      });
      adapter.turnId = 't1';
      adapter.msgId = 'm1';
      adapter.blockIndex = 0;
      adapter.openBlockKind = null;
      adapter.messageStarted = false;
      adapter.sawTerminalEvent = false;
      for (const line of lines) adapter.handleMessage(line);
      return replay(events, adapter.capabilities);
    }

    it('ends a turn grok closed with EndTurn as done', function () {
      // Capitalised, where every other runtime spells it end_turn. A table that
      // matched case would have called this one failed by never matching it.
      assert.strictEqual(badgeOf(drive(fixture('grok-stream'))).status, 'done');
    });

    it('ends a turn grok stopped on an error as failed', function () {
      // The live rate-limit probe: grok's `error` line is terminal, no `end`
      // line ever arrives, and the turn genuinely did not complete.
      assert.strictEqual(badgeOf(drive(fixture('grok-error'))).status, 'failed');
    });
  });

  describe('pi', function () {
    function drive(name) {
      const events = [];
      const adapter = new PiChatAdapter({
        sessionId: 's1',
        workingDir: '/tmp',
        command: 'pi',
        emit: (event) => events.push(event),
      });
      adapter.currentTurnId = 'turn-1';
      for (const line of fixture(name)) adapter.handleMessage(line);
      return replay(events, adapter.capabilities);
    }

    it('ends a turn as done even though pi names no reason for a good one', function () {
      const state = drive('pi-final-turn');
      assert.strictEqual(badgeOf(state).status, 'done');
      // Worth pinning: this is the case that makes "absent means done" load
      // bearing rather than a convenience.
      assert.strictEqual(state.messages[0].turnOutcome, 'done');
    });

    it('ends a whole multi-step invocation as done', function () {
      assert.strictEqual(badgeOf(drive('pi-full-invocation')).status, 'done');
    });
  });

  describe('codex', function () {
    async function drive(name) {
      const events = [];
      const adapter = new CodexAppServerAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: (event) => events.push(event),
      });
      adapter.writeLine = () => {};
      const done = adapter.handshake();
      for (const line of fixture('codex-appserver-handshake')) {
        adapter.handleMessage(line);
        await flush();
      }
      await done;
      events.length = 0;
      for (const line of fixture(name)) {
        adapter.handleMessage(line);
        await flush();
      }
      return replay(events, adapter.capabilities);
    }

    it('ends a completed turn as done', async function () {
      assert.strictEqual(badgeOf(await drive('codex-appserver-text-turn')).status, 'done');
    });

    it('ends a turn codex reported as failed as failed', async function () {
      assert.strictEqual(badgeOf(await drive('codex-appserver-turn-failed')).status, 'failed');
    });
  });

  describe('acp', function () {
    async function drive(name) {
      const events = [];
      const adapter = new AcpChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: (event) => events.push(event),
      });
      adapter.writeLine = () => {};
      const lines = fixture(name);
      const done = adapter.handshake();
      for (const line of lines.slice(0, 2)) {
        adapter.handleMessage(line);
        await flush();
      }
      await done;
      events.length = 0;
      // ACP turns are a request the agent answers: without a prompt in flight
      // there is nothing for the capture's result line to be the result of.
      const sending = adapter.send({ text: 'go' });
      for (const line of lines.slice(2)) {
        adapter.handleMessage(line);
        await flush();
      }
      await sending;
      return replay(events, adapter.capabilities);
    }

    it('ends a kimi turn as done', async function () {
      assert.strictEqual(badgeOf(await drive('acp-kimi')).status, 'done');
    });

    it('ends an opencode turn with a tool call in it as done', async function () {
      assert.strictEqual(badgeOf(await drive('acp-opencode')).status, 'done');
    });
  });

  describe('a turn nobody ever ended', function () {
    it('fails the open turn when the runtime went away under it', function () {
      // No `turn_end` exists for this: the base adapter reports the exit as a
      // fatal error and the process is gone. The fatal flag is the only thing
      // separating it from an error the agent read and worked around.
      const state = replay(
        [
          { t: 'msg_start', ts: 1, id: 'm1', role: 'assistant', turnId: 't1' },
          { t: 'block_start', ts: 2, msgId: 'm1', index: 0, block: { kind: 'text', text: 'working on it' } },
          { t: 'error', ts: 3, message: 'kimi exited (code 1): killed', fatal: true },
          { t: 'state', ts: 4, state: 'exited' },
        ],
      );
      assert.strictEqual(badgeOf(state).status, 'failed');
    });

    it('does not fail it for an error the agent read and moved past', function () {
      const state = replay(
        [
          { t: 'msg_start', ts: 1, id: 'm1', role: 'assistant', turnId: 't1' },
          { t: 'block_start', ts: 2, msgId: 'm1', index: 0, block: { kind: 'text', text: 'looking' } },
          { t: 'error', ts: 3, message: 'kimi: could not read /tmp/notes.txt' },
          { t: 'msg_end', ts: 4, msgId: 'm1' },
          { t: 'turn_end', ts: 5, turnId: 't1', stopReason: 'end_turn' },
        ],
      );
      assert.strictEqual(badgeOf(state).status, 'done');
    });
  });

  describe('reopening the conversation', function () {
    it('carries every turn\'s outcome out of the store, over a replay window', async function () {
      // What a reopen actually is: the store folds the recorded log back
      // through this same reducer and hands the browser the messages. Worth
      // proving against the real store rather than a hand-folded transcript,
      // because the replay it does is a *windowed* one — it walks the tail of a
      // long session, and a turn_end that fell outside a message window would
      // take its turn's badge with it.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-turn-outcome-'));
      try {
        const store = new ChatStore({ storageDir: dir, snapshotMinMessages: 4, snapshotReplayEvents: 4 });
        const session = { id: 's1', ownerUserId: 1 };
        const events = [];
        let seq = 0;
        const push = (event) => events.push({ ...event, seq: ++seq, ts: seq * 100 });
        for (const [turnId, stopReason] of [['t1', 'end_turn'], ['t2', 'error'], ['t3', 'stop']]) {
          push({ t: 'msg_start', id: `u-${turnId}`, role: 'user', turnId });
          push({ t: 'block_start', msgId: `u-${turnId}`, index: 0, block: { kind: 'text', text: 'go' } });
          push({ t: 'msg_end', msgId: `u-${turnId}` });
          push({ t: 'msg_start', id: `a-${turnId}`, role: 'assistant', turnId });
          push({ t: 'block_start', msgId: `a-${turnId}`, index: 0, block: { kind: 'text', text: 'ok' } });
          push({ t: 'msg_end', msgId: `a-${turnId}` });
          push({ t: 'turn_end', turnId, stopReason });
        }
        store.append(session, events);

        const snapshot = await store.snapshot(session);
        assert.deepStrictEqual(
          turns.groupTurns(snapshot.messages, snapshot.state).map((turn) => turn.status),
          ['failed', 'done'],
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('shows every turn with the outcome it ended with, replayed from the log', function () {
      // What a reopen actually is: the store folds the recorded events back
      // through this same reducer. Nothing is migrated because nothing was ever
      // stored — the outcome comes from the turn_end that is already on disk.
      const events = [];
      let seq = 0;
      const push = (event) => events.push({ ...event, seq: ++seq, ts: seq * 100 });
      for (const [turnId, stopReason] of [['t1', 'end_turn'], ['t2', 'error'], ['t3', 'stop']]) {
        push({ t: 'msg_start', id: `u${turnId}`, role: 'user', turnId });
        push({ t: 'block_start', msgId: `u${turnId}`, index: 0, block: { kind: 'text', text: 'go' } });
        push({ t: 'msg_end', msgId: `u${turnId}` });
        push({ t: 'msg_start', id: `a${turnId}`, role: 'assistant', turnId });
        push({ t: 'block_start', msgId: `a${turnId}`, index: 0, block: { kind: 'text', text: 'ok' } });
        push({ t: 'msg_end', msgId: `a${turnId}` });
        push({ t: 'turn_end', turnId, stopReason });
      }

      const state = replay(events);
      assert.deepStrictEqual(
        turns.groupTurns(state.messages, state.state).map((turn) => turn.status),
        ['done', 'failed', 'done'],
      );
    });
  });
});
