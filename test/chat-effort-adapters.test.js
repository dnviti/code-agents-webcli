const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');

// Four runtimes, four completely different ways of moving one control, and the
// only thing they share is the `effort` event they emit and the ladder they
// publish. Each road below was found by probing the live CLI, so what is fed to
// the adapters here is the wire — the captures under fixtures/chat where one
// exists, and otherwise only the shapes quoted in the source's own comments
// beside the probe that produced them.
//
// `buildArgs`, `handshake`, `handleMessage` and `writeLine` are protected, and
// the effort bookkeeping fields are private: both are compile-time visibility
// rules only, so at runtime the translation is driven directly rather than by
// spawning a CLI.

function fixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Let the adapter's own promise chains run before asserting on their output. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function only(events, type) {
  return events.filter((event) => event.t === type);
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

describe('claude effort', function () {
  function makeAdapter(overrides) {
    const events = [];
    const sent = [];
    const adapter = new ClaudeChatAdapter(
      Object.assign(
        {
          sessionId: 'app-session-1',
          workingDir: '/tmp',
          command: 'claude',
          emit: (event) => events.push(event),
        },
        overrides,
      ),
    );
    adapter.writeLine = (payload) => sent.push(payload);
    // `alive` is `Boolean(child) && !exited`, and `setEffort` refuses to write
    // to a session that is not running. Nothing else reads the child here:
    // every write goes through the stub above.
    adapter.child = {};
    return { adapter, events, sent };
  }

  describe('the launch flag', function () {
    it('launches at the level the conversation was started with', function () {
      const { adapter } = makeAdapter({ effort: 'xhigh' });
      const args = adapter.buildArgs();
      const flag = args.indexOf('--effort');
      assert.notStrictEqual(flag, -1, 'the level must reach the command line');
      assert.strictEqual(args[flag + 1], 'xhigh');
    });

    it('passes no flag at all when no level was chosen, rather than naming a default', function () {
      // Claude's own default is not one of the five as far as anything here
      // knows, so the absence of the flag is the only honest way to say "run at
      // whatever you would have run at".
      const { adapter } = makeAdapter();
      assert.ok(!adapter.buildArgs().includes('--effort'));
    });

    // The flag does not refuse a level it does not know. Probed live:
    // `claude --effort auto --version` prints `Warning: Unknown --effort value
    // 'auto' — ignoring it and using the default effort. Valid values: low,
    // medium, high, xhigh, max.` and exits 0 — so the level is dropped onto a
    // stream nobody reads and the whole conversation runs at claude's default
    // while every chip, record and readout upstream goes on naming the level
    // that was asked for. Dropping it here makes that visible instead: the
    // session launches at the default and says so.
    //
    // Three real ways a level that is not on this ladder reaches buildArgs, and
    // none of them is hypothetical: a `/effort` typed into the composer, whose
    // accepted set is wider than the flag's by one word (`Usage: /effort
    // <low|medium|high|xhigh|max|ultracode|auto>` — `auto` works as a command
    // and is warned about as a flag; `ultracode` works as both, so it is on the
    // ladder); a record written while the conversation ran on another runtime,
    // so it holds that runtime's spelling (kimi's `on`, pi's `minimal`); and a
    // record written by a future build whose ladder is longer than this one's.
    it('drops a launch level this build has never heard of, because the flag only warns about it', function () {
      for (const level of ['auto', 'ultra', 'on', 'minimal']) {
        const { adapter } = makeAdapter({ effort: level });
        assert.ok(
          !adapter.buildArgs().includes('--effort'),
          `${level} is not on claude's ladder and must not reach the command line`,
        );
      }
      const { adapter } = makeAdapter({ effort: 'xhigh' });
      assert.ok(adapter.buildArgs().includes('--effort'), 'a level it does have still travels');
    });
  });

  describe('the published ladder', function () {
    // Six, not the five `--help` documents. `/effort` with no argument answers
    // `Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>`, and of those
    // two extras only `ultracode` is also a launch flag — probed against
    // 2.1.220, which accepts `--effort ultracode` in silence and answers
    // `--effort auto` with `Warning: Unknown --effort value 'auto'`. Offering a
    // level that worked live and then vanished at the next launch would be
    // worse than not offering it, which is why the two are treated differently.
    it('offers claude’s six levels in its own order, evenly ranked', function () {
      const { adapter } = makeAdapter();
      assert.deepStrictEqual(
        adapter.capabilities.efforts.map((level) => [level.value, level.rank]),
        [
          ['low', 0],
          ['medium', 0.2],
          ['high', 0.4],
          ['xhigh', 0.6],
          ['max', 0.8],
          ['ultracode', 1],
        ],
      );
    });

    it('carries ultracode onto the command line, since the flag takes it too', function () {
      const { adapter } = makeAdapter({ effort: 'ultracode' });
      const args = adapter.buildArgs();
      assert.ok(args.includes('--effort'));
      assert.strictEqual(args[args.indexOf('--effort') + 1], 'ultracode');
    });
  });

  describe('switching a running session', function () {
    it('asks for the level down the user channel, because no control request answers', function () {
      const { adapter, sent } = makeAdapter();
      adapter.setEffort('xhigh');
      assert.deepStrictEqual(sent, [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/effort xhigh' }] } },
      ]);
    });

    it('refuses to interleave a control turn with a turn the user started', async function () {
      const { adapter } = makeAdapter();
      await adapter.send({ text: 'do some work' });
      await assert.rejects(() => adapter.setEffort('high'), /mid-turn/);
    });

    it('refuses when there is no running session to change the level of', async function () {
      const { adapter } = makeAdapter();
      adapter.child = null;
      await assert.rejects(() => adapter.setEffort('high'), /not running/);
    });

    it('refuses a second switch while the first is still unanswered', async function () {
      const { adapter } = makeAdapter();
      const first = adapter.setEffort('high');
      await assert.rejects(() => adapter.setEffort('max'), /already being asked/);
      // Settle the first so its timer is cleared rather than left running.
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to high (this session only): ...',
      });
      await first;
    });
  });

  // The suppression is the point of the whole method. Claude answers `/effort`
  // as an ordinary turn — it echoes the command back on the user channel, then
  // an assistant message explaining the new level, streamed token by token —
  // and every one of those lines would otherwise land in the transcript as a
  // message nobody typed and a phantom turn nobody started. That turn would
  // take a row in the turn index and a line in the per-turn accounting with it,
  // for a button press.
  describe('while the switch is in flight', function () {
    /** The lines claude sends while it is answering the command, in wire order. */
    function noiseFor(sent) {
      const capture = fixture('claude-oneshot');
      return [
        // The echo of the command itself, which is exactly the line the adapter
        // wrote a moment ago coming back on the user channel.
        sent[0],
        // The answer, in both the forms claude sends it: streamed and then
        // snapshotted. Taken from the capture, because the shapes are what is
        // under test here and not the words in them.
        capture.find((line) => line.type === 'stream_event' && line.event.type === 'message_start'),
        capture.find((line) => line.type === 'stream_event' && line.event.type === 'content_block_start'),
        capture.find((line) => line.type === 'assistant'),
      ];
    }

    it('puts nothing the runtime says about it into the transcript', async function () {
      const { adapter, events, sent } = makeAdapter();
      const switching = adapter.setEffort('xhigh');
      events.length = 0;

      for (const line of noiseFor(sent)) adapter.handleMessage(line);

      assert.deepStrictEqual(events, [], 'not one event may reach the transcript');
      assert.strictEqual(adapter.activeTurnId, null, 'and no turn may be minted for it');

      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to xhigh (this session only): ...',
      });
      await switching;

      assert.deepStrictEqual(
        events.map((event) => event.t),
        ['effort'],
        'the confirmation is the only thing worth reporting',
      );
      assert.strictEqual(events[0].effort, 'xhigh');
      assert.strictEqual(only(events, 'turn_end').length, 0, 'no turn began, so none ends');
      assert.strictEqual(adapter.activeTurnId, null);
    });

    it('lifts the suppression once the answer lands, so the next real turn is heard', async function () {
      const { adapter, events, sent } = makeAdapter();
      const switching = adapter.setEffort('xhigh');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to xhigh (this session only): ...',
      });
      await switching;
      events.length = 0;
      sent.length = 0;

      await adapter.send({ text: 'now do some real work' });
      adapter.handleMessage(
        fixture('claude-oneshot').find(
          (line) => line.type === 'stream_event' && line.event.type === 'message_start',
        ),
      );

      assert.ok(only(events, 'msg_start').length === 1, 'the session must not be left deaf');
    });
  });

  describe('reading the confirmation back', function () {
    it('reports the level claude says it set, not the one that was asked for', async function () {
      // They differ the day the CLI clamps a level, normalises one, or accepts
      // an alias — and on that day the chip should show what is running.
      const { adapter, events } = makeAdapter();
      const switching = adapter.setEffort('max');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to high (this session only): ...',
      });
      await switching;

      assert.deepStrictEqual(
        only(events, 'effort').map((event) => event.effort),
        ['high'],
      );
    });

    // The confirmation sentence is the only thing that counts as one, and there
    // is deliberately no falling back to the level that was asked for. A refusal
    // does not look like a failure: probed against 2.1.220, `/effort ultra`
    // answers `{"is_error":false,"subtype":"success","result":"Invalid argument:
    // ultra. Valid options are: low, medium, high, xhigh, max, ultracode,
    // auto"}` — a *successful* result whose text is a rejection. A fallback
    // reported that to the user as "Now thinking at ultra."
    it('refuses to report a level when the answer is not a confirmation', async function () {
      const { adapter, events } = makeAdapter();
      const switching = adapter.setEffort('ultra');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Invalid argument: ultra. Valid options are: low, medium, high, xhigh, max, ultracode, auto',
      });

      await assert.rejects(switching, /Invalid argument/);
      assert.deepStrictEqual(only(events, 'effort'), [], 'nothing claimed a level');
    });

    it('says nothing rather than guessing when the wording is one it cannot parse', async function () {
      const { adapter, events } = makeAdapter();
      const switching = adapter.setEffort('max');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Effort: max.',
      });

      // The caller turns this into "saved, not applied", which is the honest
      // answer for a reply nobody here can read.
      await assert.rejects(switching);
      assert.deepStrictEqual(only(events, 'effort'), []);
    });

    it('is left usable by a refusal, rather than deaf and stuck on a switch that is over', async function () {
      // The refusal above settles the switch as surely as a confirmation does,
      // and everything the switch put up has to come down with it — the
      // suppression that eats the runtime's traffic, and the record of a
      // question still outstanding. Left up, the session goes on dropping every
      // line claude sends, no further level can be asked for ("already being
      // asked" is thrown at a user who is simply trying a valid level after a
      // bad one bounced), and the only thing that ever frees it is the 8-second
      // timeout.
      const { adapter, events } = makeAdapter();
      const refused = adapter.setEffort('ultracode');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Invalid argument: ultracode. Valid options are: low, medium, high, xhigh, max, ultracode, auto',
      });
      await assert.rejects(refused);
      events.length = 0;

      // A second attempt, at a level claude does have, is the obvious next
      // thing the user does.
      const second = adapter.setEffort('high');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to high (this session only): ...',
      });
      await second;
      assert.deepStrictEqual(
        only(events, 'effort').map((event) => event.effort),
        ['high'],
      );

      // And the session still hears its own runtime.
      events.length = 0;
      await adapter.send({ text: 'now do some real work' });
      adapter.handleMessage(
        fixture('claude-oneshot').find(
          (line) => line.type === 'stream_event' && line.event.type === 'message_start',
        ),
      );
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        total_cost_usd: 0.5,
        num_turns: 3,
      });

      assert.strictEqual(only(events, 'msg_start').length, 1, 'the session must not be left deaf');
      assert.strictEqual(only(events, 'turn_end').length, 1, 'and the real turn still ends');
      assert.strictEqual(adapter.activeTurnId, null);
    });

    it('reports no level at all when claude refuses the switch', async function () {
      const { adapter, events } = makeAdapter();
      const switching = adapter.setEffort('bogus_xyz');
      adapter.handleMessage({
        type: 'result',
        subtype: 'error',
        is_error: true,
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Unknown effort level: bogus_xyz',
      });

      await assert.rejects(() => switching, /bogus_xyz/);
      assert.strictEqual(only(events, 'effort').length, 0, 'a refusal is not a level');
      assert.strictEqual(only(events, 'turn_end').length, 0);
    });

    it('does not spend the conversation’s first cost reading on the control turn', async function () {
      // `total_cost_usd` is cumulative for the conversation, so a turn's cost is
      // the difference from the last reading — and with no baseline on record
      // the *first* reading is the baseline rather than a bill. Letting the
      // effort result take that slot would hand the next real turn a watermark
      // of zero and charge it the whole conversation.
      const { adapter, events } = makeAdapter({ costBaselineUsd: null });
      const switching = adapter.setEffort('high');
      adapter.handleMessage({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        num_turns: 0,
        result: 'Set effort level to high (this session only): ...',
      });
      await switching;

      await adapter.send({ text: 'first real turn' });
      adapter.handleMessage({ type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 1.25 });
      await adapter.send({ text: 'second real turn' });
      adapter.handleMessage({ type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 1.5 });

      const turns = only(events, 'turn_end');
      assert.strictEqual(turns.length, 2, 'only the real turns end');
      assert.strictEqual(turns[0].usage, undefined, 'the first reading is the baseline, not a bill');
      assert.strictEqual(turns[1].usage.costUsd, 0.25);
    });
  });

  // A switch can be given up on — the 8-second timeout, the child exiting, or a
  // message typed over the top of it — but the command is already on its way to
  // claude's stdin and claude will answer it regardless. The answer then arrives
  // with nothing expecting it, in the middle of whatever the user is doing now.
  describe('when the answer arrives after the switch was given up on', function () {
    const LATE_ANSWER = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0,
      num_turns: 0,
      result: 'Set effort level to xhigh (this session only): ...',
    };
    const REAL_TURN_RESULT = {
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      total_cost_usd: 0.5,
      num_turns: 3,
    };

    /** Ask for a level, then type over it — which abandons the switch. */
    async function abandonedSwitch(adapter) {
      const switching = adapter.setEffort('xhigh');
      const rejected = assert.rejects(switching, /before the effort level was confirmed/);
      await adapter.send({ text: 'hello' });
      await rejected;
    }

    it('does not let the late answer end the turn the user typed over it', async function () {
      // This is the sharpest failure of the lot, because nothing about it looks
      // broken from the outside. Unrecognised, the late answer falls through
      // into the ordinary turn-closing path and ends the *user's* turn the
      // instant it lands — at zero cost, before that turn has produced a single
      // token — and the reply that follows then opens a turn of its own with
      // nobody's question in it. The transcript ends up with a turn that cost
      // nothing and asked nothing, and an answer to a prompt that is not there.
      const { adapter, events } = makeAdapter();
      await abandonedSwitch(adapter);
      const turnId = adapter.activeTurnId;
      events.length = 0;

      adapter.handleMessage(LATE_ANSWER);

      assert.deepStrictEqual(events, [], 'nobody is waiting for this, so it is worth nothing to anybody');
      assert.strictEqual(adapter.activeTurnId, turnId, 'the turn the user is in stays open');

      adapter.handleMessage(REAL_TURN_RESULT);
      const ended = only(events, 'turn_end');
      assert.strictEqual(ended.length, 1, 'the turn ends once, on its own result');
      assert.strictEqual(ended[0].turnId, turnId);
      assert.strictEqual(ended[0].usage.costUsd, 0.5, 'and is billed for what it actually did');
      assert.strictEqual(adapter.activeTurnId, null);
    });

    it('still ends a real turn that answers first, since round trips are what tell the two apart', async function () {
      // The discriminator is `num_turns`: claude answers `/effort` locally and
      // reports zero round trips, which no turn that reached the model ever
      // does. Swallowing on the strength of an answer being owed alone would
      // eat the real turn's own result whenever that arrived first, and the
      // session would sit at "thinking" with a turn that never ends.
      const { adapter, events } = makeAdapter();
      await abandonedSwitch(adapter);
      events.length = 0;

      adapter.handleMessage(REAL_TURN_RESULT);
      assert.strictEqual(only(events, 'turn_end').length, 1, 'three round trips is not a control turn');

      // And the answer that is still owed is swallowed whenever it turns up.
      events.length = 0;
      adapter.handleMessage(LATE_ANSWER);
      assert.deepStrictEqual(events, []);
    });

    it('sends a typed message straight away rather than holding it for the switch', async function () {
      // Waiting on the pending switch was the first attempt at keeping the
      // suppression off a real turn, and it held the keystroke for as long as
      // the answer took — up to the whole 8-second ceiling when no answer ever
      // came. A composer that swallows a message for eight seconds is a far
      // worse failure than a level that did not change, so the button press is
      // what gets dropped.
      const { adapter, sent } = makeAdapter();
      const switching = adapter.setEffort('xhigh');
      const rejected = assert.rejects(switching);

      const outcome = await Promise.race([
        adapter.send({ text: 'hello' }).then(() => 'sent'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting on the switch'), 50)),
      ]);
      assert.strictEqual(outcome, 'sent');
      assert.deepStrictEqual(sent[sent.length - 1], {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });
      await rejected;
    });
  });
});

// ---------------------------------------------------------------------------
// codex (app-server)
// ---------------------------------------------------------------------------

describe('codex app-server effort', function () {
  function harness(overrides) {
    const events = [];
    const sent = [];
    const adapter = new CodexAppServerAdapter(
      Object.assign(
        {
          sessionId: 'chat-1',
          workingDir: '/work',
          command: '/nonexistent',
          emit: (event) => events.push(event),
        },
        overrides,
      ),
    );
    adapter.writeLine = (payload) => sent.push(payload);
    return { adapter, events, sent };
  }

  /**
   * Drive the handshake to completion, answering `thread/start` ourselves.
   *
   * The seam is the protocol: `writeLine` is stubbed, so `thread/start` is
   * inspected as the request the adapter actually wrote rather than through
   * any accessor invented for the test, and the reply is fed back the way the
   * running app-server would.
   */
  async function boot(h, threadReply) {
    const done = h.adapter.handshake();
    await flush();
    h.adapter.handleMessage(fixture('codex-appserver-handshake')[0]);
    await flush();
    const start = h.sent.find(
      (message) => message.method === 'thread/start' || message.method === 'thread/resume',
    );
    h.adapter.handleMessage({
      jsonrpc: '2.0',
      id: start.id,
      result: Object.assign({ thread: { id: 'th_123' }, model: 'gpt-5-codex', cwd: '/work' }, threadReply),
    });
    await done;
    return start;
  }

  it('carries the launch level in the config map thread/start reads', async function () {
    // There is no `effort` parameter on `thread/start`; the level travels under
    // the same key `codex -c model_reasoning_effort=…` writes.
    const h = harness({ effort: 'xhigh' });
    const start = await boot(h);

    assert.strictEqual(start.method, 'thread/start');
    assert.deepStrictEqual(start.params.config, { model_reasoning_effort: 'xhigh' });
  });

  it('sends no config map at all when the conversation named no level', async function () {
    const h = harness();
    const start = await boot(h);
    assert.strictEqual(start.params.config, undefined);
  });

  it('reports the level codex says the thread is on, not the one that was asked for', async function () {
    const h = harness({ effort: 'xhigh' });
    await boot(h, { reasoningEffort: 'low' });

    assert.deepStrictEqual(
      only(h.events, 'effort').map((event) => event.effort),
      ['low'],
    );
  });

  it('reports null when codex says the thread is on no override at all', async function () {
    const h = harness();
    await boot(h);
    assert.strictEqual(only(h.events, 'effort').pop().effort, null);
  });

  it('announces the level before any turn proves it, and every later turn carries it', async function () {
    // `turn/start` is the only thing that accepts a level, so resolving early is
    // a claim about what happens next rather than about what codex confirmed —
    // and what happens next is that the parameter rides on the request that
    // begins the very next turn.
    const h = harness();
    await boot(h);
    h.events.length = 0;

    await h.adapter.setEffort('high');
    assert.deepStrictEqual(
      only(h.events, 'effort').map((event) => event.effort),
      ['high'],
    );

    const sending = h.adapter.send({ text: 'go' });
    await flush();
    const started = h.sent.find((message) => message.method === 'turn/start');
    assert.strictEqual(started.params.effort, 'high');
    h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_1' } } });
    await sending;
  });

  it('sends no effort on a turn when nobody has switched one', async function () {
    const h = harness();
    await boot(h, { reasoningEffort: 'low' });

    const sending = h.adapter.send({ text: 'go' });
    await flush();
    const started = h.sent.find((message) => message.method === 'turn/start');
    // Not `reportedEffort`: repeating back what codex said it was already doing
    // would be this app overriding a setting it never touched.
    assert.strictEqual(started.params.effort, undefined);
    h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_1' } } });
    await sending;
  });

  it('publishes only the running model’s ladder, since the ladders differ per model', async function () {
    const h = harness();
    await boot(h);
    const asked = h.sent.find((message) => message.method === 'model/list');
    h.adapter.handleMessage({
      jsonrpc: '2.0',
      id: asked.id,
      result: {
        data: [
          {
            id: 'gpt-5-codex',
            displayName: 'GPT-5-Codex',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Quick' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
            defaultReasoningEffort: 'medium',
          },
          {
            id: 'gpt-5.6-terra',
            displayName: 'GPT-5.6-Terra',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'ultra' }],
          },
        ],
      },
    });
    await flush();

    assert.deepStrictEqual(
      h.adapter.capabilities.efforts.map((level) => [level.value, level.rank]),
      [
        ['low', 0],
        ['medium', 0.5],
        ['high', 1],
      ],
    );
    assert.deepStrictEqual(
      only(h.events, 'capabilities').pop().capabilities.efforts,
      h.adapter.capabilities.efforts,
    );
  });
});

// ---------------------------------------------------------------------------
// acp
// ---------------------------------------------------------------------------

describe('acp effort', function () {
  function harness(overrides) {
    const events = [];
    const sent = [];
    const adapter = new AcpChatAdapter(
      Object.assign(
        {
          sessionId: 'chat-1',
          workingDir: '/work',
          command: '/nonexistent',
          emit: (event) => events.push(event),
        },
        overrides,
      ),
    );
    adapter.writeLine = (payload) => sent.push(payload);
    return { adapter, events, sent };
  }

  /** Answer `initialize` from a real capture, then `session/new` with the reply under test. */
  async function boot(h, initializeLine, sessionResult) {
    const done = h.adapter.handshake();
    await flush();
    h.adapter.handleMessage(initializeLine);
    await flush();
    const opened = h.sent.find((message) => message.method === 'session/new');
    h.adapter.handleMessage({ jsonrpc: '2.0', id: opened.id, result: sessionResult });
    await done;
  }

  // kimi and omp put the level where the protocol has a place for it: a config
  // option in the `thought_level` category. The option below is kimi's own,
  // read off `session/new` — the two levels really are all it offers.
  describe('the config-option road (kimi, omp)', function () {
    const THINKING = {
      type: 'select',
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      currentValue: 'on',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    };

    function kimiSession(thinking) {
      // The model and mode options are kimi's own, from the capture; the
      // thinking option is the third one it publishes beside them.
      const capture = fixture('acp-kimi')[1].result;
      return {
        sessionId: capture.sessionId,
        configOptions: [...capture.configOptions, thinking],
      };
    }

    async function bootKimi() {
      const h = harness();
      await boot(h, fixture('acp-kimi')[0], kimiSession(THINKING));
      return h;
    }

    it('offers the two levels the agent published, ranked from off to on', async function () {
      const h = await bootKimi();
      assert.deepStrictEqual(
        only(h.events, 'session')[0].capabilities.efforts.map((level) => [level.value, level.rank]),
        [
          ['off', 0],
          ['on', 1],
        ],
      );
    });

    it('reports the level the agent said it is already on, before anything was asked of it', async function () {
      const h = await bootKimi();
      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['on'],
      );
    });

    it('sets the option by configId, which is the spelling the agent accepts', async function () {
      // `optionId` reads perfectly well and is wrong: kimi answers it with
      // `{"configId":{"_errors":["Invalid input: expected string, received
      // undefined"]}}`, so the whole road is closed by one word.
      const h = await bootKimi();
      const switching = h.adapter.setEffort('off');
      await flush();

      const call = h.sent.find((message) => message.method === 'session/set_config_option');
      assert.deepStrictEqual(call.params, {
        sessionId: fixture('acp-kimi')[1].result.sessionId,
        configId: 'thinking',
        value: 'off',
      });
      assert.strictEqual(call.params.optionId, undefined);

      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        result: { configOptions: [{ ...THINKING, currentValue: 'off' }] },
      });
      await switching;
    });

    it('reports the level off the agent’s own updated option, not off the request', async function () {
      const h = await bootKimi();
      const switching = h.adapter.setEffort('off');
      await flush();
      const call = h.sent.find((message) => message.method === 'session/set_config_option');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        result: { configOptions: [{ ...THINKING, currentValue: 'off' }] },
      });
      await switching;

      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['on', 'off'],
      );
    });

    it('leaves the caller to report a level the agent refuses, rather than claiming it took', async function () {
      const h = await bootKimi();
      const switching = h.adapter.setEffort('bogus_xyz');
      await flush();
      const call = h.sent.find((message) => message.method === 'session/set_config_option');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32602, message: 'Unknown thinking effort for model "kimi-k2.7-code": bogus_xyz' },
      });

      await assert.rejects(() => switching, /bogus_xyz/);
      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['on'],
        'the chip stays on the level the agent is actually running',
      );
    });
  });

  // grok publishes no `thought_level` option at all. Its ladder hangs off the
  // model, in `_meta`, and its setter is the model setter — so switching effort
  // and switching model are the same call. This reply is grok's own, probed
  // live; only the sessionId is borrowed from the capture beside it, because
  // the quoted shape omits the id the setter needs.
  describe('the per-model road (grok)', function () {
    const GROK_SESSION = {
      sessionId: '019fa521-db8c-7872-87da-316ce4cf3a83',
      models: {
        currentModelId: 'grok-4.5',
        availableModels: [
          {
            modelId: 'grok-4.5',
            name: 'Grok 4.5',
            _meta: {
              totalContextTokens: 500000,
              supportsReasoningEffort: true,
              reasoningEffort: 'high',
              reasoningEfforts: [
                {
                  id: 'high',
                  value: 'high',
                  label: 'High Effort',
                  description: 'Highest implementation quality with extensive reasoning',
                  default: true,
                },
                {
                  id: 'medium',
                  value: 'medium',
                  label: 'Medium Effort',
                  description: 'Balanced effort with standard implementation and testing',
                  default: false,
                },
                {
                  id: 'low',
                  value: 'low',
                  label: 'Low Effort',
                  description: 'Quick, fast implementations',
                  default: false,
                },
              ],
            },
          },
        ],
      },
    };

    async function bootGrok() {
      const h = harness({ runtime: 'grok' });
      await boot(h, fixture('acp-grok')[0], GROK_SESSION);
      return h;
    }

    it('turns grok’s ceiling-first ladder the right way up', async function () {
      // grok lists its levels highest-first. Ranked as published, its cheapest
      // level would be painted as its most expensive — which is the one thing
      // the rank exists to get right.
      const h = await bootGrok();
      assert.deepStrictEqual(
        only(h.events, 'session')[0].capabilities.efforts.map((level) => [level.value, level.rank]),
        [
          ['low', 0],
          ['medium', 0.5],
          ['high', 1],
        ],
      );
    });

    it('names each level as grok labelled it', async function () {
      const h = await bootGrok();
      assert.deepStrictEqual(only(h.events, 'session')[0].capabilities.efforts[0], {
        value: 'low',
        name: 'Low Effort',
        description: 'Quick, fast implementations',
        rank: 0,
      });
    });

    it('reports the level the model’s own _meta says it is on', async function () {
      const h = await bootGrok();
      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['high'],
      );
    });

    it('moves the level through the model setter, which is the only call grok answers', async function () {
      const h = await bootGrok();
      const switching = h.adapter.setEffort('low');
      await flush();

      const call = h.sent.find((message) => message.method === 'session/set_model');
      assert.deepStrictEqual(call.params, {
        sessionId: GROK_SESSION.sessionId,
        modelId: 'grok-4.5',
        _meta: { reasoningEffort: 'low' },
      });

      h.adapter.handleMessage({ jsonrpc: '2.0', id: call.id, result: { _meta: { model: { Ok: 'grok-4.5' } } } });
      await switching;
    });

    it('waits for grok to say what it is doing before moving the chip', async function () {
      // The reply to `session/set_model` is only `{"_meta":{"model":{"Ok":...}}}`
      // — an acceptance, not a report. The notification that follows is the
      // report, and it is the only thing worth putting on the chip.
      const h = await bootGrok();
      const switching = h.adapter.setEffort('low');
      await flush();
      const call = h.sent.find((message) => message.method === 'session/set_model');
      h.adapter.handleMessage({ jsonrpc: '2.0', id: call.id, result: { _meta: { model: { Ok: 'grok-4.5' } } } });
      await switching;

      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['high'],
        'accepting the call is not yet running at the level',
      );

      h.adapter.handleMessage({
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: {
          sessionId: GROK_SESSION.sessionId,
          update: { sessionUpdate: 'model_changed', model_id: 'grok-4.5', reasoning_effort: 'low' },
        },
      });
      await flush();

      assert.deepStrictEqual(
        only(h.events, 'effort').map((event) => event.effort),
        ['high', 'low'],
      );
    });

    it('refuses to guess a road for an agent that published no levels at all', async function () {
      const h = harness({ runtime: 'grok' });
      await boot(h, fixture('acp-grok')[0], fixture('acp-grok')[1].result);
      await assert.rejects(() => h.adapter.setEffort('low'), /no reasoning-effort levels/);
    });
  });
});

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

describe('pi effort', function () {
  function makeAdapter(overrides) {
    const events = [];
    const adapter = new PiChatAdapter(
      Object.assign(
        {
          sessionId: 's1',
          workingDir: '/work',
          command: 'pi',
          emit: (event) => events.push(event),
        },
        overrides,
      ),
    );
    return { adapter, events };
  }

  it('offers the seven levels pi named while refusing a bad one', function () {
    const { adapter } = makeAdapter();
    assert.deepStrictEqual(
      adapter.capabilities.efforts.map((level) => level.value),
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.strictEqual(adapter.capabilities.efforts[0].rank, 0);
    assert.strictEqual(adapter.capabilities.efforts[6].rank, 1);
  });

  it('spawns the next turn at the level it was launched with', function () {
    const { adapter } = makeAdapter({ effort: 'high' });
    const args = adapter.buildArgs();
    const flag = args.indexOf('--thinking');
    assert.notStrictEqual(flag, -1);
    assert.strictEqual(args[flag + 1], 'high');
  });

  it('passes no thinking flag when no level was chosen', function () {
    const { adapter } = makeAdapter();
    assert.ok(!adapter.buildArgs().includes('--thinking'));
  });

  it('drops a launch level pi has never heard of instead of putting it on the command line', function () {
    const { adapter } = makeAdapter({ effort: 'bogus_xyz' });
    assert.ok(!adapter.buildArgs().includes('--thinking'));
  });

  // pi only *warns* about an unknown level — `Warning: Invalid thinking level
  // "bogus_xyz"` on stderr — and then answers the prompt at its default. So
  // accepting one would not fail the turn; it would run at a level nobody chose
  // while the control reported the one they picked.
  it('rejects a level pi does not have, rather than reporting one that is not running', async function () {
    const { adapter, events } = makeAdapter({ effort: 'high' });
    await assert.rejects(() => adapter.setEffort('bogus_xyz'), /no thinking level called/);

    assert.deepStrictEqual(events, [], 'nothing to report: nothing changed');
    const args = adapter.buildArgs();
    assert.strictEqual(args[args.indexOf('--thinking') + 1], 'high', 'the live level is untouched');
  });

  it('switches with nothing to acknowledge, because the next turn is the next process', async function () {
    const { adapter, events } = makeAdapter();
    await adapter.setEffort('max');

    assert.deepStrictEqual(
      only(events, 'effort').map((event) => event.effort),
      ['max'],
    );
    const args = adapter.buildArgs();
    assert.strictEqual(args[args.indexOf('--thinking') + 1], 'max');
  });

  it('leaves the caller’s launch options alone when it takes a new level', async function () {
    // The session still reads `options` to decide what a relaunch looks like;
    // rewriting it here would quietly change the request it believes it made.
    const options = { sessionId: 's1', workingDir: '/work', command: 'pi', effort: 'low', emit: () => {} };
    const adapter = new PiChatAdapter(options);
    await adapter.setEffort('max');
    assert.strictEqual(options.effort, 'low');
  });
});
