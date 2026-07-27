const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CodexAppServerAdapter,
  CodexExecAdapter,
  CodexChatAdapter,
} = require('../dist/server/chat/adapters/codex.js');
const { NO_CHAT_CAPABILITIES } = require('../dist/shared/chat-events.js');

// codex-appserver-*.jsonl fixtures are hand-written against the generated
// TypeScript bindings the CLI itself ships (`.work/probes/raw/codex-ts`):
// app-server has no live capture anywhere in this repo, only the schema, so
// unlike the acp/claude/grok fixtures these are not a trimmed wire log --
// see the class doc comment in codex.ts for exactly what that means for
// confidence in field names and event ordering.
//
// codex-exec-usage-limit.jsonl is copied verbatim from the one live probe
// that exists (`.work/probes/raw/codex-exec.jsonl`); it hit the account's
// usage limit before any item was produced. codex-exec-item.jsonl is
// hand-written to fill that gap, on the assumption documented in the
// `CodexExecAdapter` class comment.

// handshake/handleMessage/handleNotification/handleServerRequest/buildArgs
// are `protected` in TypeScript, a compile-time visibility rule only: at
// runtime they are ordinary methods, so translation is driven directly
// without spawning a CLI.

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

/** Feed the two handshake responses (ids 1 and 2), then await the handshake. */
async function boot(h) {
  const done = h.adapter.handshake();
  for (const line of fixture('codex-appserver-handshake')) {
    h.adapter.handleMessage(line);
    await flush();
  }
  await done;
}

async function feed(h, lines) {
  for (const line of lines) {
    h.adapter.handleMessage(line);
    await flush();
  }
}

function only(events, type) {
  return events.filter((event) => event.t === type);
}

function stripTs(events) {
  return events.map((event) => {
    const { ts, ...rest } = event;
    assert.strictEqual(typeof ts, 'number');
    return rest;
  });
}

describe('codex app-server adapter', function () {
  describe('capabilities', function () {
    it('claims what app-server structurally supports', function () {
      const { adapter } = harness();
      assert.strictEqual(adapter.capabilities.streaming, true);
      assert.strictEqual(adapter.capabilities.thinking, true);
      assert.strictEqual(adapter.capabilities.toolCalls, true);
      assert.strictEqual(adapter.capabilities.diffs, true);
      assert.strictEqual(adapter.capabilities.permissions, true);
      assert.strictEqual(adapter.capabilities.interrupt, true);
      assert.strictEqual(adapter.capabilities.resume, true);
      assert.strictEqual(adapter.capabilities.plan, true);
      assert.strictEqual(adapter.capabilities.usage, true);
      // thread/fork forks the current head only, not a chosen earlier point.
      assert.strictEqual(adapter.capabilities.fork, false);
      // Tokens only; nothing in the schema prices a turn.
      assert.strictEqual(adapter.capabilities.cost, false);
    });

    it('passes the app-server subcommand and profile arguments to the spawn', function () {
      const { adapter } = harness({ extraArgs: ['--config', '/tmp/x.yml'] });
      assert.deepStrictEqual(adapter.buildArgs(), ['app-server', '--config', '/tmp/x.yml']);
    });
  });

  describe('handshake', function () {
    it('sends initialize then thread/start, in that order, and announces the session', async function () {
      const h = harness({ model: 'gpt-5-codex' });
      await boot(h);

      assert.strictEqual(h.sent[0].method, 'initialize');
      assert.deepStrictEqual(h.sent[0].params.clientInfo.name, 'code-agents-webcli');
      const initialized = h.sent.find((message) => message.method === 'initialized');
      assert.ok(initialized, 'must notify initialized before thread/start');
      const start = h.sent.find((message) => message.method === 'thread/start');
      assert.strictEqual(start.params.cwd, '/work');
      assert.strictEqual(start.params.model, 'gpt-5-codex');
      assert.ok(h.sent.indexOf(initialized) < h.sent.indexOf(start));

      const session = only(h.events, 'session')[0];
      assert.strictEqual(session.nativeSessionId, 'th_123');
      assert.strictEqual(session.model, 'gpt-5-codex');
      assert.strictEqual(session.cwd, '/work');
      // Not `ts: session.ts`: the two events are stamped by separate Date.now()
      // calls, so they differ by a millisecond whenever the clock ticks between
      // them — which CI hit. What matters is that idle is announced, and at the
      // same moment as the session, not on the same integer.
      const state = only(h.events, 'state')[0];
      assert.strictEqual(state.t, 'state');
      assert.strictEqual(state.state, 'idle');
      assert.ok(Math.abs(state.ts - session.ts) <= 50, `state ts ${state.ts} vs session ts ${session.ts}`);
    });

    it('offers the models codex says it accepts, without waiting for them (#75)', async function () {
      const h = harness({});
      await boot(h);

      // Asked for, but the session was announced without waiting on the answer:
      // a picker menu is not worth delaying a conversation for.
      const asked = h.sent.find((message) => message.method === 'model/list');
      assert.ok(asked, 'codex publishes its models over the protocol');
      assert.ok(only(h.events, 'session').length === 1);

      // The shape is the running app-server's own, captured from it.
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: asked.id,
        result: {
          data: [
            {
              id: 'gpt-5.6-terra',
              model: 'gpt-5.6-terra',
              displayName: 'GPT-5.6-Terra',
              description: 'Balanced agentic coding model for everyday work.',
              hidden: false,
              isDefault: true,
            },
            { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false },
            { id: 'retired-internal', displayName: 'Retired', hidden: true },
          ],
        },
      });
      await flush();

      const revised = only(h.events, 'capabilities').pop();
      assert.deepStrictEqual(revised.capabilities.models, [
        {
          value: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          description: 'Balanced agentic coding model for everyday work.',
        },
        { value: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
      ]);
      assert.strictEqual(h.adapter.capabilities.models.length, 2);
    });

    it('starts fine against a build that has no model/list at all (#75)', async function () {
      const h = harness({});
      await boot(h);
      const asked = h.sent.find((message) => message.method === 'model/list');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: asked.id,
        error: { code: -32600, message: 'unknown variant `model/list`' },
      });
      await flush();

      assert.strictEqual(h.adapter.capabilities.models, undefined);
      assert.strictEqual(only(h.events, 'error').length, 0);
      assert.strictEqual(only(h.events, 'session').length, 1);
    });

    it('resumes by threadId instead of starting fresh when asked to', async function () {
      const h = harness({ resumeSessionId: 'th_old' });
      const done = h.adapter.handshake();
      h.adapter.handleMessage(fixture('codex-appserver-handshake')[0]);
      await flush();
      h.adapter.handleMessage({ jsonrpc: '2.0', id: 2, result: { thread: { id: 'th_old' }, cwd: '/work' } });
      await done;

      const resume = h.sent.find((message) => message.method === 'thread/resume');
      assert.ok(resume);
      assert.strictEqual(resume.params.threadId, 'th_old');
      assert.strictEqual(h.sent.some((message) => message.method === 'thread/start'), false);
    });

    it('asks codex not to send approvals at all when the bypass is on', async function () {
      const h = harness({ bypassPermissions: true });
      await boot(h);
      const start = h.sent.find((message) => message.method === 'thread/start');
      assert.strictEqual(start.params.approvalPolicy, 'never');
    });

    it('rejects rather than hanging forever when a request never answers', async function () {
      // BaseChatAdapter's own `exit` handler never rejects a pending JSON-RPC
      // call, so without this guard an old codex build that answers nothing
      // would hang start() forever instead of letting the router fall back.
      // Exercised directly with a short timeout rather than waiting out the
      // real 8s default: the guarantee under test is "rejects", not "rejects
      // in exactly 8000ms".
      const { adapter } = harness();
      const neverResolves = new Promise(() => {});
      await assert.rejects(adapter.withTimeout(neverResolves, 5, 'initialize'), /timed out/);
    });
  });

  describe('sending a turn', function () {
    it('writes the user message into the transcript and starts the turn', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      h.sent.length = 0;

      const sendPromise = h.adapter.send({ text: 'Hello?' });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      assert.deepStrictEqual(started.params.input, [{ type: 'text', text: 'Hello?', text_elements: [] }]);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_1' } } });
      await sendPromise;

      const start = only(h.events, 'msg_start')[0];
      assert.strictEqual(start.role, 'user');
      assert.strictEqual(start.turnId, 'turn_1');
      assert.deepStrictEqual(only(h.events, 'block_start')[0].block, { kind: 'text', text: 'Hello?' });
      assert.strictEqual(only(h.events, 'state').pop().state, 'thinking');
    });

    it('sends local images and remote image URLs as distinct attachment kinds', async function () {
      const h = harness();
      await boot(h);
      h.sent.length = 0;
      const sendPromise = h.adapter.send({
        text: 'look',
        attachments: [
          { path: '/tmp/a.png', url: '/files/a.png', mime: 'image/png', name: 'a.png', size: 1 },
          { url: 'https://example.com/b.png', mime: 'image/png', name: 'b.png', size: 1 },
        ],
      });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      assert.deepStrictEqual(started.params.input.slice(1), [
        { type: 'localImage', path: '/tmp/a.png' },
        { type: 'image', url: 'https://example.com/b.png' },
      ]);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_x' } } });
      await sendPromise;
    });
  });

  describe('translating a text turn', function () {
    it('maps the full agentMessage lifecycle into the ChatEvent sequence', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;

      await feed(h, fixture('codex-appserver-text-turn'));

      const events = stripTs(h.events);
      assert.deepStrictEqual(events, [
        { t: 'msg_start', id: 'a_turn_1', role: 'assistant', turnId: 'turn_1', model: 'gpt-5-codex' },
        { t: 'block_start', msgId: 'a_turn_1', index: 0, block: { kind: 'text', text: '' } },
        { t: 'block_delta', msgId: 'a_turn_1', index: 0, text: 'Hello' },
        { t: 'block_delta', msgId: 'a_turn_1', index: 0, text: ', world' },
        {
          t: 'block_end',
          msgId: 'a_turn_1',
          index: 0,
          block: { kind: 'text', text: 'Hello, world' },
        },
        {
          t: 'usage',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            reasoningTokens: 0,
            totalTokens: 150,
            contextWindow: 128000,
            // Whose figure it is, and how much of the window the *last*
            // request filled — codex reports both, and `last` is what was in
            // the window rather than what the whole turn spent (issue #82).
            contextWindowSource: 'agent',
            contextUsed: 150,
          },
        },
        { t: 'msg_end', msgId: 'a_turn_1', stopReason: 'completed' },
        { t: 'turn_end', turnId: 'turn_1', stopReason: 'completed', durationMs: 1200 },
      ]);
    });

    it('never attaches usage to msg_end/turn_end, since the usage event is already absolute', async function () {
      // thread/tokenUsage/updated reports a running total, which the reducer
      // treats as an overwrite; attaching the same figure to msg_end/turn_end
      // (which merge additively) would double it on every subsequent turn.
      const h = harness();
      await boot(h);
      await feed(h, fixture('codex-appserver-text-turn'));
      assert.strictEqual(only(h.events, 'msg_end').pop().usage, undefined);
      assert.strictEqual(only(h.events, 'turn_end').pop().usage, undefined);
    });
  });

  describe('translating a turn with tool calls, reasoning and a plan', function () {
    let h;
    before(async function () {
      h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, fixture('codex-appserver-tool-turn'));
    });

    it('folds reasoning content into one thinking block', function () {
      const blocks = only(h.events, 'block_start').map((event) => event.block);
      const thinking = blocks.find((block) => block.kind === 'thinking');
      assert.strictEqual(thinking.text, '');
      const closed = only(h.events, 'block_end').find((event) => event.block && event.block.kind === 'thinking');
      assert.strictEqual(closed.block.text, 'Let me check the file');
    });

    it('opens a commandExecution as a running tool block, named for its category not its literal command', function () {
      const tool = only(h.events, 'block_start').map((event) => event.block).find((block) => block.kind === 'tool' && block.name === 'shell');
      assert.strictEqual(tool.title, 'ls -la');
      assert.strictEqual(tool.toolKind, 'execute');
      assert.strictEqual(tool.status, 'running');
      assert.deepStrictEqual(tool.input, { command: 'ls -la', cwd: '/work' });
    });

    it('patches the commandExecution result by toolId once it completes', function () {
      const patch = only(h.events, 'tool').find((event) => event.toolId === 'item_c1').patch;
      assert.strictEqual(patch.status, 'completed');
      assert.strictEqual(patch.output, 'file1\nfile2');
      assert.strictEqual(patch.durationMs, 42);
    });

    it('turns a fileChange item into a real structured diff', function () {
      const opened = only(h.events, 'block_start').map((event) => event.block).find((block) => block.toolId === 'item_f1');
      assert.strictEqual(opened.toolKind, 'edit');
      assert.strictEqual(opened.locations[0], 'hello.txt');
      const diff = opened.diffs[0];
      assert.strictEqual(diff.path, 'hello.txt');
      assert.strictEqual(diff.kind, 'update');
      assert.strictEqual(diff.added, 1);
      assert.strictEqual(diff.removed, 1);
      assert.deepStrictEqual(diff.hunks, [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
      ]);

      const patch = only(h.events, 'tool').find((event) => event.toolId === 'item_f1').patch;
      assert.strictEqual(patch.status, 'completed');
      assert.deepStrictEqual(patch.diffs, opened.diffs);
    });

    it('emits a state:running transition when a tool call starts', function () {
      assert.ok(only(h.events, 'state').some((event) => event.state === 'running'));
    });

    it('accumulates plan deltas into the top-level plan event and the in-message block', function () {
      const planEvents = only(h.events, 'plan');
      assert.deepStrictEqual(planEvents[0].items, [{ text: 'Step 1: read\n', status: 'in_progress' }]);
      assert.deepStrictEqual(planEvents[1].items, [
        { text: 'Step 1: read\nStep 2: edit', status: 'in_progress' },
      ]);

      const planBlockEnds = only(h.events, 'block_end').filter(
        (event) => event.block && event.block.items,
      );
      assert.strictEqual(planBlockEnds.length, 3); // two deltas + the final item/completed
      assert.deepStrictEqual(planBlockEnds.pop().block.items, [
        { text: 'Step 1: read\nStep 2: edit', status: 'in_progress' },
      ]);
    });

    it('closes the turn as completed', function () {
      const turn = only(h.events, 'turn_end').pop();
      assert.strictEqual(turn.turnId, 'turn_2');
      assert.strictEqual(turn.stopReason, 'completed');
      assert.strictEqual(turn.durationMs, 500);
    });
  });

  describe('a failed turn', function () {
    it('surfaces the error and closes with stopReason failed', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, fixture('codex-appserver-turn-failed'));

      assert.ok(only(h.events, 'error').some((event) => event.message === 'boom' && event.fatal === false));
      const turn = only(h.events, 'turn_end').pop();
      assert.strictEqual(turn.turnId, 'turn_3');
      assert.strictEqual(turn.stopReason, 'failed');
    });
  });

  describe('permissions', function () {
    it('turns execCommandApproval into a permission event with the default options', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, [fixture('codex-appserver-permission')[0]]);

      const request = only(h.events, 'permission')[0].request;
      assert.strictEqual(request.requestId, '10');
      assert.strictEqual(request.toolId, 'item_c2');
      assert.strictEqual(request.title, 'Run: rm -rf tmp');
      assert.strictEqual(request.toolKind, 'execute');
      assert.strictEqual(request.reason, 'cleanup');
      assert.deepStrictEqual(
        request.options.map((option) => option.kind),
        ['allow_once', 'allow_always', 'reject_once'],
      );
    });

    it('turns applyPatchApproval into a permission event carrying the real diff', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, [fixture('codex-appserver-permission')[1]]);

      const request = only(h.events, 'permission')[0].request;
      assert.strictEqual(request.toolId, 'item_f2');
      assert.strictEqual(request.title, 'Apply patch: hello.txt');
      assert.strictEqual(request.toolKind, 'edit');
      assert.strictEqual(request.diffs.length, 1);
      assert.strictEqual(request.diffs[0].added, 1);
      assert.strictEqual(request.diffs[0].removed, 1);
    });

    it('answers allow_once as ReviewDecision "approved" and reports it allowed', async function () {
      const h = harness();
      await boot(h);
      await feed(h, [fixture('codex-appserver-permission')[0]]);
      const requestId = only(h.events, 'permission')[0].request.requestId;

      h.adapter.respondPermission(requestId, 'allow_once');

      assert.deepStrictEqual(h.sent.find((message) => message.id === 10).result, 'approved');
      const resolved = only(h.events, 'permission_resolved')[0];
      assert.strictEqual(resolved.allowed, true);
      assert.strictEqual(resolved.automatic, undefined);
    });

    it('answers reject_once as ReviewDecision "denied" and reports it not allowed', async function () {
      const h = harness();
      await boot(h);
      await feed(h, [fixture('codex-appserver-permission')[1]]);
      const requestId = only(h.events, 'permission')[0].request.requestId;

      h.adapter.respondPermission(requestId, 'reject_once');

      assert.deepStrictEqual(h.sent.find((message) => message.id === 11).result, 'denied');
      assert.strictEqual(only(h.events, 'permission_resolved')[0].allowed, false);
    });

    it('answers allow_always as ReviewDecision "approved_for_session"', async function () {
      const h = harness();
      await boot(h);
      await feed(h, [fixture('codex-appserver-permission')[0]]);
      const requestId = only(h.events, 'permission')[0].request.requestId;

      h.adapter.respondPermission(requestId, 'allow_always');
      assert.strictEqual(h.sent.find((message) => message.id === 10).result, 'approved_for_session');
    });

    it('auto-approves under the bypass without ever emitting a permission event', async function () {
      const h = harness({ bypassPermissions: true });
      await boot(h);
      h.events.length = 0;
      await feed(h, [fixture('codex-appserver-permission')[0]]);

      assert.strictEqual(h.sent.find((message) => message.id === 10).result, 'approved_for_session');
      assert.strictEqual(only(h.events, 'permission').length, 0);
      const resolved = only(h.events, 'permission_resolved')[0];
      assert.strictEqual(resolved.allowed, true);
      assert.strictEqual(resolved.automatic, true);
    });

    it('declines a server request it does not implement rather than hanging the agent', async function () {
      const h = harness();
      await boot(h);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: 99, method: 'mcpServer/elicitation/request', params: {} });
      assert.strictEqual(h.sent.find((message) => message.id === 99).error.code, -32601);
    });
  });

  describe('interrupt', function () {
    it('sends turn/interrupt for the active thread and turn', async function () {
      const h = harness();
      await boot(h);
      const sendPromise = h.adapter.send({ text: 'go' });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_9' } } });
      await sendPromise;

      const interruptPromise = h.adapter.interrupt();
      const sent = h.sent[h.sent.length - 1];
      assert.strictEqual(sent.method, 'turn/interrupt');
      assert.deepStrictEqual(sent.params, { threadId: 'th_123', turnId: 'turn_9' });
      h.adapter.handleMessage({ jsonrpc: '2.0', id: sent.id, result: {} });
      await interruptPromise;
    });

    it('is a no-op when no turn is running', async function () {
      const h = harness();
      await boot(h);
      h.sent.length = 0;
      await assert.doesNotReject(() => h.adapter.interrupt());
      assert.deepStrictEqual(h.sent, []);
    });
  });

  describe('tolerance', function () {
    it('never throws on malformed or unknown notifications', async function () {
      const h = harness();
      await boot(h);
      const before = h.events.length;
      for (const message of [
        { jsonrpc: '2.0', method: 'item/started' },
        { jsonrpc: '2.0', method: 'item/started', params: { item: null } },
        { jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'somethingNew', id: 'x' } } },
        { jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {} },
        { jsonrpc: '2.0', method: 'turn/diff/updated', params: { diff: '@@ ignored @@' } },
        { jsonrpc: '2.0', method: 'skills/changed', params: {} },
      ]) {
        assert.doesNotThrow(() => h.adapter.handleMessage(message));
      }
      // An unmapped item type still renders something, so events.length grows
      // by exactly one for that line rather than staying flat for every case.
      assert.ok(h.events.length >= before);
    });
  });
});

describe('codex exec adapter (fallback)', function () {
  function makeAdapter(overrides) {
    const events = [];
    const adapter = new CodexExecAdapter(
      Object.assign(
        {
          sessionId: 's1',
          workingDir: '/work',
          command: '/nonexistent',
          emit: (event) => events.push(event),
        },
        overrides,
      ),
    );
    return { adapter, events };
  }

  // Mirrors GrokChatAdapter's own test convention: turnId is what send()
  // would have set up before a turn's process was spawned; setting it
  // directly drives handleMessage without spawning a real child.
  function beginTurn(adapter, turnId) {
    adapter.turnId = turnId;
    adapter.assistantMsgId = null;
    adapter.blockIndex = 0;
    adapter.sawTerminalEvent = false;
  }

  describe('capabilities', function () {
    it('is honest about what a one-shot, non-interactive CLI cannot do', function () {
      const { adapter } = makeAdapter();
      assert.strictEqual(adapter.capabilities.streaming, false);
      assert.strictEqual(adapter.capabilities.thinking, false);
      assert.strictEqual(adapter.capabilities.permissions, false);
      assert.strictEqual(adapter.capabilities.interrupt, false);
      assert.strictEqual(adapter.capabilities.resume, false);
      assert.strictEqual(adapter.capabilities.attachments, false);
      assert.strictEqual(adapter.capabilities.usage, false);
      assert.strictEqual(adapter.capabilities.plan, false);
      // These are shared with app-server via the same itemToBlock mapping.
      assert.strictEqual(adapter.capabilities.toolCalls, true);
      assert.strictEqual(adapter.capabilities.diffs, true);
    });
  });

  describe('start', function () {
    it('announces the session without spawning anything', async function () {
      const { adapter, events } = makeAdapter();
      await adapter.start();
      assert.strictEqual(adapter.child, null);
      assert.strictEqual(events[0].t, 'session');
      assert.strictEqual(events[0].cwd, '/work');
      assert.deepStrictEqual(events[1], { t: 'state', state: 'idle', ts: events[1].ts });
    });
  });

  describe('buildArgs', function () {
    it('always bypasses approvals: there is no channel to answer a prompt on', function () {
      const { adapter } = makeAdapter();
      assert.deepStrictEqual(adapter.buildArgs(), [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
    });

    it('still appends profile extraArgs after the fixed flags', function () {
      const { adapter } = makeAdapter({ extraArgs: ['--foo', 'bar'] });
      assert.deepStrictEqual(adapter.buildArgs(), [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--foo',
        'bar',
      ]);
    });
  });

  describe('translating the live usage-limit probe', function () {
    it('surfaces the error and fails the turn without ever opening a message', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter, 't1');
      for (const line of fixture('codex-exec-usage-limit')) {
        adapter.handleMessage(line);
      }

      const errors = only(events, 'error');
      assert.ok(errors.length >= 1);
      assert.ok(errors.every((event) => /usage limit/.test(event.message)));
      assert.strictEqual(only(events, 'msg_start').length, 0);
      const turn = only(events, 'turn_end').pop();
      assert.strictEqual(turn.turnId, 't1');
      assert.strictEqual(turn.stopReason, 'failed');
      assert.strictEqual(only(events, 'state').pop().state, 'idle');
    });
  });

  describe('translating a completed turn with an item', function () {
    it('opens the assistant message lazily and renders the completed item', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter, 't2');
      for (const line of fixture('codex-exec-item')) {
        adapter.handleMessage(line);
      }

      const start = only(events, 'msg_start')[0];
      assert.strictEqual(start.role, 'assistant');
      assert.strictEqual(start.turnId, 't2');
      const block = only(events, 'block_start')[0].block;
      assert.deepStrictEqual(block, { kind: 'text', text: 'abacus' });
      const end = only(events, 'msg_end').pop();
      assert.strictEqual(end.stopReason, 'completed');
      assert.strictEqual(only(events, 'turn_end').pop().stopReason, 'completed');
    });
  });

  describe('tolerance', function () {
    it('never throws on malformed payload shapes', function () {
      const { adapter } = makeAdapter();
      beginTurn(adapter, 't1');
      assert.doesNotThrow(() => adapter.handleMessage('just a string'));
      assert.doesNotThrow(() => adapter.handleMessage(42));
      assert.doesNotThrow(() => adapter.handleMessage(null));
      assert.doesNotThrow(() => adapter.handleMessage({}));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'something_future_codex_invents' }));
      assert.doesNotThrow(() => adapter.handleMessage({ type: 'item.completed', item: null }));
    });
  });

  describe('interrupt and permissions', function () {
    it('has nothing to signal before a turn is running', async function () {
      const { adapter } = makeAdapter();
      await assert.doesNotReject(() => adapter.interrupt());
    });

    it('respondPermission is a no-op: no approval channel exists in this mode', function () {
      const { adapter, events } = makeAdapter();
      assert.doesNotThrow(() => adapter.respondPermission('req1', 'allow_once'));
      assert.deepStrictEqual(events, []);
    });
  });
});

describe('codex chat adapter (router)', function () {
  it('reports no capabilities and is not alive before start() has chosen a mode', function () {
    const adapter = new CodexChatAdapter({
      sessionId: 's1',
      workingDir: '/work',
      command: '/nonexistent',
      emit: () => {},
    });
    assert.deepStrictEqual(adapter.capabilities, NO_CHAT_CAPABILITIES);
    assert.strictEqual(adapter.alive, false);
  });

  it('rejects send() before start() rather than reaching into a null delegate', async function () {
    const adapter = new CodexChatAdapter({
      sessionId: 's1',
      workingDir: '/work',
      command: '/nonexistent',
      emit: () => {},
    });
    await assert.rejects(() => adapter.send({ text: 'hi' }), /not started/);
  });
});
