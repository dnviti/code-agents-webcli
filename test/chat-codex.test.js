const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CodexAppServerAdapter,
  CodexExecAdapter,
  CodexChatAdapter,
} = require('../dist/server/chat/adapters/codex.js');
const { NO_CHAT_CAPABILITIES } = require('../dist/shared/chat-events.js');
const { collectAgentActivity } = require('../dist/shared/agent-activity.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');

// codex-appserver-*.jsonl fixtures are hand-written against the generated
// TypeScript bindings the CLI itself ships (`.work/probes/raw/codex-ts`):
// app-server has no live capture anywhere in this repo, only the schema, so
// unlike the acp/claude/grok fixtures these are not a trimmed wire log --
// see the class doc comment in codex.ts for exactly what that means for
// confidence in field names and event ordering.
//
//
// codex-appserver-ratelimits.jsonl is the exception and IS a live capture:
// `account/rateLimits/read` was probed against codex-cli 0.146.0 on 2026-07-29
// and the reply is stored verbatim (#137).
//
// codex-exec-usage-limit.jsonl is copied verbatim from the one live probe
// that exists (`.work/probes/raw/codex-exec.jsonl`); it hit the account's
// usage limit before any item was produced. codex-exec-item.jsonl is
// hand-written to fill that gap, on the assumption documented in the
// `CodexExecAdapter` class comment.

// handshake/handleMessage/handleNotification/handleServerRequest/buildArgs and
// feedStdout are `protected` in TypeScript, a compile-time visibility rule
// only. The harness exposes the raw protocol seam and drives translation
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

class TestCodexAppServerAdapter extends CodexAppServerAdapter {
  feedWire(chunk) { this.feedStdout(chunk); }
}

function harness(overrides) {
  const events = [];
  const sent = [];
  const adapter = new TestCodexAppServerAdapter(
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

/** Fold the adapter's wire-independent events the same way the browser does. */
function transcriptOf(events) {
  const state = createTranscript({});
  for (const [index, event] of JSON.parse(JSON.stringify(events)).entries()) {
    applyChatEvent(state, {
      ...event,
      seq: index + 1,
      ts: event.ts ?? 1_000 + index,
    });
  }
  return state;
}

describe('codex app-server adapter', function () {
  describe('stdout framing', function () {
    it('completes a command whose record is above the former 1 MB limit', async function () {
      const h = harness();
      await boot(h);
      h.events.length = 0;

      const turnId = 'turn_large_output';
      const itemId = 'item_large_output';
      const output = 'x'.repeat(1_100_000);
      const line = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

      h.adapter.feedWire(Buffer.concat([
        line({
          jsonrpc: '2.0',
          method: 'turn/started',
          params: { threadId: 'th_123', turn: { id: turnId, status: 'inProgress' } },
        }),
        line({
          jsonrpc: '2.0',
          method: 'item/started',
          params: {
            threadId: 'th_123',
            turnId,
            item: {
              type: 'commandExecution',
              id: itemId,
              command: 'produce-output',
              cwd: '/work',
              status: 'inProgress',
              aggregatedOutput: null,
            },
          },
        }),
      ]));
      h.events.length = 0;

      const completed = Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId: 'th_123',
          turnId,
          item: {
            type: 'commandExecution',
            id: itemId,
            command: 'produce-output',
            cwd: '/work',
            status: 'completed',
            aggregatedOutput: output,
            exitCode: 0,
            durationMs: 42,
          },
        },
      }), 'utf8');

      for (let offset = 0; offset < completed.length; offset += 64 * 1024) {
        h.adapter.feedWire(completed.subarray(offset, offset + 64 * 1024));
      }
      assert.strictEqual(only(h.events, 'tool').length, 0, 'an incomplete record must not dispatch');
      assert.strictEqual(only(h.events, 'error').length, 0, 'a valid partial record must not be discarded');

      h.adapter.feedWire(Buffer.from('\n', 'utf8'));

      const patch = only(h.events, 'tool').find((event) => event.toolId === itemId)?.patch;
      assert.ok(patch, 'the completed command must patch its opened tool');
      assert.strictEqual(patch.status, 'completed');
      assert.strictEqual(patch.output.length, output.length);
      assert.ok(patch.output === output, 'large command output changed during framing');
      assert.strictEqual(patch.durationMs, 42);
      assert.deepStrictEqual(only(h.events, 'error'), []);
    });
  });

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
      // issue #182: codex now reports an API-list-price estimate computed by
      // this app from the confirmed model and reported tokens.
      assert.strictEqual(adapter.capabilities.cost, true);
    });

    it('offers the app-owned commands and installed skills before the handshake', function () {
      const { adapter } = harness({
        installedCommands: [{ name: 'release', description: 'Prepare a release' }],
      });
      assert.deepStrictEqual(
        adapter.capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'release'],
      );
      assert.strictEqual(adapter.capabilities.commands[3].description, 'Prepare a release');
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

    it('uses container-visible paths on the wire and the host path in public capabilities', async function () {
      const h = harness({
        environment: {
          kind: 'container',
          toContainerPath: (value) => `/container${value}`,
        },
      });
      const done = h.adapter.handshake();
      h.adapter.handleMessage(fixture('codex-appserver-handshake')[0]);
      await flush();
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        result: { thread: { id: 'th_container' }, model: 'gpt-5.6-sol', cwd: '/container/work' },
      });
      await done;

      assert.strictEqual(h.sent.find((message) => message.method === 'thread/start').params.cwd, '/container/work');
      assert.deepStrictEqual(
        h.sent.find((message) => message.method === 'skills/list').params.cwds,
        ['/container/work'],
      );
      assert.strictEqual(only(h.events, 'session')[0].cwd, '/work');
    });

    it('sends the translated runtime cwd to app-server', async function () {
      const h = harness({
        workingDir: '/host/projects/alpha',
        cwdKind: 'host',
        environment: {
          kind: 'container',
          toContainerPath(value) {
            assert.strictEqual(value, '/host/projects/alpha');
            return '/workspace/alpha';
          },
        },
      });
      await boot(h);
      const start = h.sent.find((message) => message.method === 'thread/start');
      assert.strictEqual(start.params.cwd, '/workspace/alpha');
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

    it('offers the enabled skills codex says are available in this working directory', async function () {
      const h = harness({
        installedCommands: [{ name: 'fallback-only', description: 'Only the disk scan found this' }],
      });
      await boot(h);

      const asked = h.sent.find((message) => message.method === 'skills/list');
      assert.ok(asked, 'codex publishes its skills over the app-server protocol');
      assert.deepStrictEqual(asked.params, { cwds: ['/work'] });
      assert.strictEqual(only(h.events, 'session').length, 1, 'skill discovery must not delay the session');

      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: asked.id,
        result: {
          data: [{
            cwd: '/work',
            skills: [
              {
                name: 'review',
                description: 'Review the current changes',
                path: '/home/user/.agents/skills/review/SKILL.md',
                enabled: true,
              },
              { name: 'disabled-skill', description: 'Do not offer this', enabled: false },
              { name: 'missing-manifest', description: 'Cannot be invoked', enabled: true },
            ],
            errors: [],
          }],
        },
      });
      await flush();

      const revised = only(h.events, 'capabilities').pop();
      assert.deepStrictEqual(
        revised.capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'review'],
      );
      assert.strictEqual(
        revised.capabilities.commands.find((command) => command.name === 'review').description,
        'Review the current changes',
      );
      assert.ok(!revised.capabilities.commands.some((command) => command.name === 'disabled-skill'));
      assert.ok(!revised.capabilities.commands.some((command) => command.name === 'missing-manifest'));
      assert.ok(!revised.capabilities.commands.some((command) => command.name === 'fallback-only'));
      assert.ok(!JSON.stringify(revised.capabilities.commands).includes('/home/user/'), 'paths stay private');
      assert.deepStrictEqual(h.adapter.capabilities.commands, revised.capabilities.commands);
    });

    it('refreshes the command menu when codex says its skills changed', async function () {
      const h = harness({});
      await boot(h);

      const initial = h.sent.find((message) => message.method === 'skills/list');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: initial.id,
        result: { data: [{ cwd: '/work', skills: [
          { name: 'old-skill', description: 'Old', path: '/skills/old/SKILL.md', enabled: true },
        ], errors: [] }] },
      });
      await flush();

      h.adapter.handleNotification('skills/changed', {});
      await flush();
      const refresh = h.sent.filter((message) => message.method === 'skills/list').pop();
      assert.deepStrictEqual(refresh.params, { cwds: ['/work'], forceReload: true });
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: refresh.id,
        result: { data: [{ cwd: '/work', skills: [
          { name: 'new-skill', description: 'New', path: '/skills/new/SKILL.md', enabled: true },
        ], errors: [] }] },
      });
      await flush();
      assert.deepStrictEqual(
        h.adapter.capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'new-skill'],
      );
    });

    it('keeps the stand-in menu when a build has no skills/list method', async function () {
      const h = harness({
        installedCommands: [{ name: 'release', description: 'Prepare a release' }],
        installedSkills: [{ name: 'release', path: '/home/user/.codex/skills/release/SKILL.md' }],
      });
      await boot(h);
      const asked = h.sent.find((message) => message.method === 'skills/list');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: asked.id,
        error: { code: -32600, message: 'unknown variant `skills/list`' },
      });
      await flush();

      assert.deepStrictEqual(
        h.adapter.capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'release'],
      );
      assert.strictEqual(only(h.events, 'error').length, 0);

      h.sent.length = 0;
      const sendPromise = h.adapter.send({ text: '/release 6.1.0' });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      assert.deepStrictEqual(started.params.input, [
        { type: 'text', text: '$release 6.1.0', text_elements: [] },
        {
          type: 'skill',
          name: 'release',
          path: '/home/user/.codex/skills/release/SKILL.md',
        },
      ]);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_fallback' } } });
      await sendPromise;
    });

    it('reads the account rate limits codex volunteers (#137)', async function () {
      const h = harness({});
      await boot(h);

      const asked = h.sent.find((m) => m.method === 'account/rateLimits/read');
      assert.ok(asked, 'codex publishes its rate limits over the protocol');
      // Asked for without waiting, like the model list: a status readout is not
      // worth delaying a conversation for.
      assert.strictEqual(only(h.events, 'session').length, 1);

      const captured = fixture('codex-appserver-ratelimits')[0];
      h.adapter.handleMessage({ jsonrpc: '2.0', id: asked.id, result: captured.result });
      await flush();

      const limits = only(h.events, 'limits').pop();
      assert.ok(limits, 'expected a limits event');
      // The plan name codex states about itself. It is also inside the id_token
      // in ~/.codex/auth.json, and this app deliberately does not read that
      // file -- it holds access and refresh tokens.
      assert.strictEqual(limits.limits.planName, 'free');
      assert.deepStrictEqual(limits.limits.windows, [
        {
          kind: 'primary',
          // usedPercent 100 in the capture; the event carries fractions.
          utilization: 1,
          durationMinutes: 43200,
          resetsAt: new Date(1786182229 * 1000).toISOString(),
        },
      ]);
      // `secondary` is null in the capture, and null is not a window.
      assert.strictEqual(limits.limits.windows.length, 1);
    });

    it('starts fine against a build with no account/rateLimits/read (#137)', async function () {
      const h = harness({});
      await boot(h);
      const asked = h.sent.find((m) => m.method === 'account/rateLimits/read');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: asked.id,
        error: { code: -32600, message: 'unknown variant `account/rateLimits/read`' },
      });
      await flush();

      assert.strictEqual(only(h.events, 'limits').length, 0);
      assert.strictEqual(only(h.events, 'error').length, 0);
      assert.strictEqual(only(h.events, 'session').length, 1);
    });

    it('takes the same reading from the update notification (#137)', async function () {
      const h = harness({});
      await boot(h);
      const captured = fixture('codex-appserver-ratelimits')[0];
      h.adapter.handleNotification('account/rateLimits/updated', captured.result);
      await flush();

      const limits = only(h.events, 'limits').pop();
      assert.strictEqual(limits.limits.windows[0].kind, 'primary');
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
    it('starts the turn and leaves the user’s own message to the session (#129)', async function () {
      // It used to write one of its own, on top of the one `ChatSession.deliver`
      // had already written — one prompt, two identical bubbles in one turn.
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

      assert.deepStrictEqual(
        only(h.events, 'msg_start').filter((event) => event.role === 'user'),
        [],
        'the adapter must not open a user message of its own',
      );
      assert.deepStrictEqual(
        only(h.events, 'block_start').filter((event) => JSON.stringify(event.block).includes('Hello?')),
        [],
        'nor write the prompt into the transcript a second time',
      );
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

    it('turns a selected slash skill into Codex’s explicit skill input', async function () {
      const h = harness();
      await boot(h);
      const listed = h.sent.find((message) => message.method === 'skills/list');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: listed.id,
        result: { data: [{ cwd: '/work', skills: [{
          name: 'review',
          description: 'Review changes',
          path: '/home/user/.agents/skills/review/SKILL.md',
          enabled: true,
        }], errors: [] }] },
      });
      await flush();
      h.sent.length = 0;

      const sendPromise = h.adapter.send({ text: '/review the current diff' });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      assert.deepStrictEqual(started.params.input, [
        { type: 'text', text: '$review the current diff', text_elements: [] },
        { type: 'skill', name: 'review', path: '/home/user/.agents/skills/review/SKILL.md' },
      ]);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_skill' } } });
      await sendPromise;
    });

    it('leaves an unknown slash untouched instead of guessing that it is a skill', async function () {
      const h = harness();
      await boot(h);
      h.sent.length = 0;
      const sendPromise = h.adapter.send({ text: '/not-a-reported-skill please' });
      await flush();
      const started = h.sent.find((message) => message.method === 'turn/start');
      assert.deepStrictEqual(started.params.input, [
        { type: 'text', text: '/not-a-reported-skill please', text_elements: [] },
      ]);
      h.adapter.handleMessage({ jsonrpc: '2.0', id: started.id, result: { turn: { id: 'turn_plain' } } });
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
            // And which model it is about. `thread/tokenUsage/updated` never
            // says, so it comes off the thread codex opened — without it a
            // model switch mid-thread makes the session read codex's own
            // ceiling as the previous model's and go asking a catalogue for a
            // worse one (#136).
            contextWindowModel: 'gpt-5-codex',
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

    it('leaves usage unpriced when no estimator is provided', async function () {
      const h = harness();
      await boot(h);
      await feed(h, fixture('codex-appserver-text-turn'));
      const usage = only(h.events, 'usage').pop().usage;
      assert.strictEqual(usage.costUsd, undefined);
      assert.strictEqual(usage.costSource, undefined);
    });

    it('prices reported usage at list price when an estimator is provided (issue #182)', async function () {
      const h = harness({
        codexPricing: {
          estimate: (tokens) => ({
            costUsd: (tokens.inputTokens ?? 0) * 2e-6,
            model: 'gpt-5-codex',
            rates: { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6 },
            source: 'openai-list',
            pricingDate: '2026-08-05',
          }),
        },
      });
      await boot(h);
      await feed(h, fixture('codex-appserver-text-turn'));
      const usage = only(h.events, 'usage').pop().usage;
      // The fixure reports 100 input tokens; the stub prices them at $2/M.
      assert.strictEqual(usage.costUsd, 100 * 2e-6);
      assert.strictEqual(usage.costSource, 'estimated');
      assert.ok(usage.costEstimate);
      assert.strictEqual(usage.costEstimate.model, 'gpt-5-codex');
      assert.strictEqual(usage.costEstimate.source, 'openai-list');
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

  describe('a delegated agent broadcast on its own Codex thread', function () {
    const AGENT_THREAD_ID = 'th_child';
    const AGENT_TOOL_ID = `codex-agent:${AGENT_THREAD_ID}`;

    async function replay(lines = fixture('codex-appserver-subagent')) {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, lines);
      return { ...h, state: transcriptOf(h.events) };
    }

    function throughActivity(lines, kind) {
      const end = lines.findIndex((line) =>
        line.method === 'item/completed'
        && line.params?.item?.type === 'subAgentActivity'
        && line.params.item.kind === kind,
      );
      assert.ok(end >= 0, `fixture has no completed ${kind} activity`);
      return lines.slice(0, end + 1);
    }

    function activityPair(id, kind) {
      const item = {
        type: 'subAgentActivity',
        id,
        kind,
        agentThreadId: AGENT_THREAD_ID,
        agentPath: '/root/scout',
      };
      return ['item/started', 'item/completed'].map((method) => ({
        jsonrpc: '2.0',
        method,
        params: { threadId: 'th_123', turnId: 'turn_agents', item },
      }));
    }

    function agentBlock(state) {
      const located = state.toolIndex[AGENT_TOOL_ID];
      assert.ok(located, 'the stable child-thread id must locate the Agent block');
      return state.messages[located[0]].blocks[located[1]];
    }

    it('keeps child work in one Agent row while the parent answer continues streaming', async function () {
      const { events, state } = await replay();
      const activity = collectAgentActivity(state.messages);

      assert.strictEqual(activity.length, 1);
      assert.strictEqual(activity[0].toolId, AGENT_TOOL_ID);
      assert.strictEqual(activity[0].kind, 'agent');
      assert.strictEqual(activity[0].name, '/root/scout');
      assert.strictEqual(activity[0].status, 'completed');
      assert.strictEqual(activity[0].running, false);

      const block = agentBlock(state);
      assert.strictEqual(block.kind, 'tool');
      assert.strictEqual(block.name, 'Agent');
      assert.strictEqual(block.output, 'child result');
      assert.strictEqual(block.agent.status, 'completed');
      assert.strictEqual(block.agent.steps.length, 1);
      assert.deepStrictEqual(block.agent.steps[0], {
        id: 'child_command',
        name: 'shell',
        toolKind: 'execute',
        status: 'completed',
        input: { command: 'cat note.txt', cwd: '/work' },
        output: 'BANANA\n',
        ts: block.agent.steps[0].ts,
      });
      assert.strictEqual(typeof block.agent.steps[0].ts, 'number');

      const texts = state.messages.flatMap((message) =>
        message.blocks.filter((candidate) => candidate.kind === 'text').map((candidate) => candidate.text),
      );
      assert.deepStrictEqual(texts, ['Parent answer']);
      assert.ok(!texts.some((text) => text.includes('child result')));
      assert.ok(!JSON.stringify(state.messages).includes('[unhandled codex item: subAgentActivity]'));

      assert.ok(events.some((event) =>
        event.t === 'agent_step'
        && event.parentToolId === AGENT_TOOL_ID
        && event.step.id === 'child_command',
      ));
      assert.strictEqual(state.toolIndex.child_command, undefined);
      assert.deepStrictEqual(state.orphanToolPatches, {});
    });

    it('does not duplicate or settle an agent merely because it was interacted with', async function () {
      const lines = fixture('codex-appserver-subagent');
      const { state } = await replay(throughActivity(lines, 'interacted'));
      const activity = collectAgentActivity(state.messages);

      assert.strictEqual(activity.length, 1);
      assert.strictEqual(activity[0].toolId, AGENT_TOOL_ID);
      assert.strictEqual(activity[0].status, 'running');
      assert.strictEqual(activity[0].running, true);
      assert.strictEqual(agentBlock(state).agent.status, 'running');
      assert.strictEqual(
        state.messages.flatMap((message) => message.blocks)
          .filter((block) => block.kind === 'tool' && block.name === 'Agent').length,
        1,
      );
    });

    it('cancels the existing row when Codex reports that child interrupted', async function () {
      const lines = fixture('codex-appserver-subagent');
      const prefix = throughActivity(lines, 'interacted');
      const { state } = await replay([
        ...prefix,
        ...activityPair('interrupt_scout', 'interrupted'),
        {
          jsonrpc: '2.0',
          method: 'thread/status/changed',
          params: { threadId: AGENT_THREAD_ID, status: { type: 'idle' } },
        },
      ]);
      const activity = collectAgentActivity(state.messages);

      assert.strictEqual(activity.length, 1);
      assert.strictEqual(activity[0].toolId, AGENT_TOOL_ID);
      assert.strictEqual(activity[0].status, 'canceled');
      assert.strictEqual(activity[0].running, false);
      assert.strictEqual(agentBlock(state).agent.status, 'canceled');
      assert.deepStrictEqual(state.orphanToolPatches, {});
    });

    it('preserves a precise failure through idle and clears it when the child reopens', async function () {
      const lines = fixture('codex-appserver-subagent');
      const prefix = throughActivity(lines, 'started');
      const failed = {
        jsonrpc: '2.0',
        method: 'error',
        params: { threadId: AGENT_THREAD_ID, error: { message: 'child crashed' } },
      };
      const idle = {
        jsonrpc: '2.0',
        method: 'thread/status/changed',
        params: { threadId: AGENT_THREAD_ID, status: { type: 'idle' } },
      };
      const active = {
        jsonrpc: '2.0',
        method: 'thread/status/changed',
        params: { threadId: AGENT_THREAD_ID, status: { type: 'active' } },
      };

      const stopped = await replay([...prefix, failed, idle]);
      assert.strictEqual(agentBlock(stopped.state).status, 'failed');
      assert.strictEqual(agentBlock(stopped.state).agent.status, 'failed');
      assert.strictEqual(agentBlock(stopped.state).agent.error, 'child crashed');

      const reopened = await replay([...prefix, failed, idle, active]);
      assert.strictEqual(agentBlock(reopened.state).status, 'running');
      assert.strictEqual(agentBlock(reopened.state).agent.status, 'running');
      assert.strictEqual(agentBlock(reopened.state).error, '');
      assert.strictEqual(agentBlock(reopened.state).agent.error, '');
    });
  });

  /**
   * An item that arrives already finished, with no `item/started` before it.
   *
   * The one place this adapter opens and closes a block in the same breath, and
   * therefore the one place #132's record-time refusal happens: the text is final
   * here, so a reply that says nothing can be turned away rather than written
   * down. What must *not* be turned away is a block that simply earns no row of
   * its own — reasoning and tool calls both draw nothing on their own and both
   * belong to the trace, and a record-time refusal is permanent.
   */
  describe('an item that arrives already finished', function () {
    async function completedOnly(item) {
      const h = harness();
      await boot(h);
      h.events.length = 0;
      await feed(h, [{ jsonrpc: '2.0', method: 'turn/started', params: { turnId: 'turn_9' } }]);
      h.events.length = 0;
      await feed(h, [{ jsonrpc: '2.0', method: 'item/completed', params: { turnId: 'turn_9', item } }]);
      return only(h.events, 'block_start').map((event) => event.block);
    }

    it('refuses a reply that says nothing', async function () {
      assert.deepStrictEqual(
        await completedOnly({ id: 'i1', type: 'agentMessage', text: '  \n ' }),
        [],
        'a blank reply was written into the conversation',
      );
    });

    it('records a reply that says something', async function () {
      const blocks = await completedOnly({ id: 'i1', type: 'agentMessage', text: 'done' });
      assert.deepStrictEqual(blocks.map((block) => block.kind), ['text']);
      assert.strictEqual(blocks[0].text, 'done');
    });

    it('records reasoning, which earns no row but is not nothing', async function () {
      const blocks = await completedOnly({ id: 'i1', type: 'reasoning', content: ['I should read the file first'] });
      assert.deepStrictEqual(blocks.map((block) => block.kind), ['thinking']);
      assert.strictEqual(blocks[0].text, 'I should read the file first');
    });

    // A tool item is not covered here on purpose: a completed tool item is
    // routed by `isToolItemType` to the patch-by-toolId path instead, which
    // never reaches this gate, so one arriving with no `item/started` before it
    // is dropped by that path for reasons that predate #132. Every real capture
    // pairs the two. What the record-time rule owes a tool call is pinned
    // directly on the predicate, in test/chat-empty-rows.test.js.
    it('refuses a plan the runtime announced and never filled in', async function () {
      assert.deepStrictEqual(
        await completedOnly({ id: 'i1', type: 'plan', text: '   ' }),
        [],
        'an empty plan was written into the conversation',
      );
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

    it('keeps app-owned commands and disk-discovered skills in fallback mode', function () {
      const { adapter } = makeAdapter({
        installedCommands: [{ name: 'release', description: 'Prepare a release' }],
      });
      assert.deepStrictEqual(
        adapter.capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'release'],
      );
    });
  });

  describe('start', function () {
    it('announces the session without spawning anything', async function () {
      const { adapter, events } = makeAdapter({
        installedCommands: [{ name: 'release', description: 'Prepare a release' }],
      });
      await adapter.start();
      assert.strictEqual(adapter.child, null);
      assert.strictEqual(events[0].t, 'session');
      assert.strictEqual(events[0].cwd, '/work');
      assert.deepStrictEqual(
        events[0].capabilities.commands.map((command) => command.name),
        ['clear', 'new', 'reset', 'release'],
      );
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

    it('invokes a disk-discovered skill with Codex’s dollar marker', async function () {
      const { adapter } = makeAdapter({
        installedCommands: [{ name: 'release', description: 'Prepare a release' }],
        installedSkills: [{ name: 'release', path: '/home/user/.codex/skills/release/SKILL.md' }],
      });
      let spawned;
      adapter.spawnTurn = (args) => { spawned = args; };
      await adapter.send({ text: '/release 6.1.0' });
      assert.strictEqual(spawned[spawned.length - 1], '$release 6.1.0');
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

    it('coalesces every activity for one child into one Agents-panel row', function () {
      const { adapter, events } = makeAdapter();
      beginTurn(adapter, 't_agents');
      for (const [id, kind] of [
        ['spawn_scout', 'started'],
        ['message_scout', 'interacted'],
        ['interrupt_scout', 'interrupted'],
      ]) {
        adapter.handleMessage({
          type: 'item.completed',
          item: {
            type: 'subAgentActivity',
            id,
            kind,
            agentThreadId: 'th_exec_child',
            agentPath: '/root/scout',
          },
        });
      }

      const state = transcriptOf(events);
      const activity = collectAgentActivity(state.messages);
      assert.strictEqual(activity.length, 1);
      assert.strictEqual(activity[0].toolId, 'codex-agent:th_exec_child');
      assert.strictEqual(activity[0].status, 'canceled');
      assert.strictEqual(
        state.messages.flatMap((message) => message.blocks)
          .filter((block) => block.kind === 'tool' && block.name === 'Agent').length,
        1,
      );
      assert.ok(!JSON.stringify(state.messages).includes('[unhandled codex item: subAgentActivity]'));
      assert.deepStrictEqual(state.orphanToolPatches, {});
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
  it('owns its pre-start capabilities instead of mutating the shared empty sentinel', function () {
    const adapter = new CodexChatAdapter({
      sessionId: 's1',
      workingDir: '/work',
      command: '/nonexistent',
      installedCommands: [{ name: 'release', description: 'Prepare a release' }],
      emit: () => {},
    });
    assert.notStrictEqual(adapter.capabilities, NO_CHAT_CAPABILITIES);
    assert.deepStrictEqual(
      adapter.capabilities.commands.map((command) => command.name),
      ['clear', 'new', 'reset', 'release'],
    );
    assert.strictEqual(NO_CHAT_CAPABILITIES.commands, undefined);
    assert.strictEqual(adapter.alive, false);

    adapter.capabilities.commands.push({ name: 'private-to-one-router' });
    const other = new CodexChatAdapter({
      sessionId: 's2', workingDir: '/work', command: '/nonexistent', emit: () => {},
    });
    assert.ok(!other.capabilities.commands.some((command) => command.name === 'private-to-one-router'));
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

  it('retains ownership of a failed app-server probe when verified teardown fails', async function () {
    const originalPrimaryStart = CodexAppServerAdapter.prototype.start;
    const originalPrimaryStop = CodexAppServerAdapter.prototype.stop;
    const originalFallbackStart = CodexExecAdapter.prototype.start;
    const originalWarn = console.warn;
    let stopCalls = 0;
    let fallbackStarts = 0;

    CodexAppServerAdapter.prototype.start = async function () {
      throw new Error('probe handshake failed');
    };
    CodexAppServerAdapter.prototype.stop = async function () {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error('remote process close unverified');
    };
    CodexExecAdapter.prototype.start = async function () {
      fallbackStarts += 1;
    };
    console.warn = () => {};

    try {
      const adapter = new CodexChatAdapter({
        sessionId: 's1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: () => {},
      });

      await assert.rejects(() => adapter.start(), /remote process close unverified/);
      assert.ok(adapter.delegate instanceof CodexAppServerAdapter);
      assert.strictEqual(fallbackStarts, 0, 'fallback must not start beside an unverified probe');

      // The failed probe remains reachable through the facade so a retained
      // ChatSession can retry its teardown instead of leaking it.
      await adapter.stop();
      assert.strictEqual(stopCalls, 2);
    } finally {
      CodexAppServerAdapter.prototype.start = originalPrimaryStart;
      CodexAppServerAdapter.prototype.stop = originalPrimaryStop;
      CodexExecAdapter.prototype.start = originalFallbackStart;
      console.warn = originalWarn;
    }
  });

  it('transfers ownership to exec only after the app-server probe is verified gone', async function () {
    const originalPrimaryStart = CodexAppServerAdapter.prototype.start;
    const originalPrimaryStop = CodexAppServerAdapter.prototype.stop;
    const originalFallbackStart = CodexExecAdapter.prototype.start;
    const originalWarn = console.warn;
    let releaseStop;
    const stopped = new Promise((resolve) => {
      releaseStop = resolve;
    });
    let fallbackStarts = 0;

    CodexAppServerAdapter.prototype.start = async function () {
      throw new Error('probe handshake failed');
    };
    CodexAppServerAdapter.prototype.stop = async function () {
      await stopped;
    };
    CodexExecAdapter.prototype.start = async function () {
      fallbackStarts += 1;
    };
    console.warn = () => {};

    try {
      const adapter = new CodexChatAdapter({
        sessionId: 's1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: () => {},
      });
      const starting = adapter.start();
      await flush();

      assert.ok(adapter.delegate instanceof CodexAppServerAdapter);
      assert.strictEqual(fallbackStarts, 0);

      releaseStop();
      await starting;
      assert.ok(adapter.delegate instanceof CodexExecAdapter);
      assert.strictEqual(fallbackStarts, 1);
    } finally {
      CodexAppServerAdapter.prototype.start = originalPrimaryStart;
      CodexAppServerAdapter.prototype.stop = originalPrimaryStop;
      CodexExecAdapter.prototype.start = originalFallbackStart;
      console.warn = originalWarn;
    }
  });
});
