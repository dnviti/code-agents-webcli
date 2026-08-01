const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { applyChatEvent, createTranscript, messageText } = require('../dist/shared/chat-reducer.js');

// The fixtures under fixtures/chat are the `in` half of the wire logs captured
// from omp, opencode and kimi (`.work/probes/`), with the model list, the
// command list and the long runs of identical thought chunks trimmed. Nothing
// was reshaped: what the adapter is fed here is what those agents actually sent.
//
// acp-permission.jsonl is the exception and is hand-written to the protocol's
// shapes, because all three probes ran with approvals already granted and none
// of them ever asked. It is kept in the same form so it replays identically.

// `writeLine`, `handshake` and `handleMessage` are protected in TypeScript, a
// compile-time visibility rule only: at runtime they are ordinary methods, so
// the translation can be driven without ever spawning a CLI.

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

/** Feed the handshake replies, then hand back the rest of the capture. */
async function boot(h, lines) {
  const done = h.adapter.handshake();
  for (const line of lines.slice(0, 2)) {
    h.adapter.handleMessage(line);
    await flush();
  }
  await done;
  return lines.slice(2);
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

describe('acp chat adapter', function () {
  describe('handshake', function () {
    it('maps agent capabilities onto the chat capability descriptor', async function () {
      const h = harness({ readFile: async () => '', writeFile: async () => {} });
      await boot(h, fixture('acp-omp'));

      const session = only(h.events, 'session')[0];
      assert.strictEqual(session.nativeSessionId, '019f994c-6f83-7000-aa56-89bb51fff42f');
      assert.strictEqual(session.cwd, '/work');
      assert.strictEqual(session.capabilities.attachments, true);
      assert.strictEqual(session.capabilities.resume, true);
      // Advertised by the agent, but no capture shows the call that performs it.
      assert.strictEqual(session.capabilities.fork, false);
      assert.strictEqual(session.capabilities.streaming, true);
      assert.strictEqual(session.capabilities.permissions, true);
    });

    it('advertises only the filesystem it can actually serve', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));

      const initialize = h.sent.find((message) => message.method === 'initialize');
      assert.strictEqual(initialize.params.protocolVersion, 1);
      assert.deepStrictEqual(initialize.params.clientCapabilities.fs, {
        readTextFile: false,
        writeTextFile: false,
      });
    });

    it('turns the model config option into selectable models', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));

      const session = only(h.events, 'session')[0];
      assert.strictEqual(session.model, 'openrouter/moonshotai/kimi-k3');
      assert.strictEqual(session.capabilities.models.length, 3);
      assert.deepStrictEqual(session.capabilities.models[0], {
        value: 'openrouter/~anthropic/claude-fable-latest',
        name: 'Claude Fable Latest',
        description: 'openrouter/~anthropic/claude-fable-latest',
      });
    });

    it('advertises no models when the agent lists none', async function () {
      // kimi returns an empty model select when it is not authenticated; an
      // empty picker is worse than no picker.
      const h = harness();
      await boot(h, fixture('acp-kimi'));

      const session = only(h.events, 'session')[0];
      assert.strictEqual(session.capabilities.models, undefined);
      assert.strictEqual(session.model, undefined);
    });

    it('passes the ACP subcommand and profile arguments to the spawn', function () {
      const h = harness({ extraArgs: ['--config', '/tmp/x.yml'] });
      assert.deepStrictEqual(h.adapter.buildArgs(), ['acp', '--config', '/tmp/x.yml']);
    });

    it('uses the runtime-visible cwd in ACP handshakes', async function () {
      const environment = {
        kind: 'container',
        toContainerPath(value) {
          assert.strictEqual(value, '/host/projects/alpha');
          return '/workspace/alpha';
        },
      };
      const h = harness({ workingDir: '/host/projects/alpha', cwdKind: 'host', environment });
      await boot(h, fixture('acp-omp'));

      const opened = h.sent.find((message) => message.method === 'session/new');
      assert.strictEqual(opened.params.cwd, '/workspace/alpha');
      assert.strictEqual(only(h.events, 'session')[0].cwd, '/workspace/alpha');
    });

    it('does not translate an explicitly container-local ACP cwd', async function () {
      const environment = {
        kind: 'container',
        toContainerPath() { throw new Error('container cwd must not be translated as a host path'); },
      };
      const h = harness({ workingDir: '/tmp/work', cwdKind: 'container', environment });
      await boot(h, fixture('acp-omp'));
      const opened = h.sent.find((message) => message.method === 'session/new');
      assert.strictEqual(opened.params.cwd, '/tmp/work');
    });
  });

  describe('streaming messages', function () {
    it('never opens a reply for a chunk that is only whitespace (#132)', async function () {
      // Oh My Pi sends one of these beside the tool activity on almost every
      // step. Recorded as content it made the step "a step that said something"
      // and earned it the bordered row #46 exists to remove — a model name, a
      // clock, a work counter, and nothing to read. Driven on a real capture:
      // the blank chunks are in the recording, not in this file.
      const h = harness({ readFile: async () => 'The magic word is BANANAPHONE.\n' });
      await feed(h, await boot(h, fixture('acp-kimi-tools')));

      const blanks = only(h.events, 'block_start').filter(
        (event) => event.block.kind === 'text' && !event.block.text.trim(),
      );
      assert.deepStrictEqual(
        blanks.map((event) => JSON.stringify(event.block.text)),
        [],
        'a blank reply is not a reply and must not be written down as one',
      );
      // The real answer is untouched.
      const texts = only(h.events, 'block_start')
        .filter((event) => event.block.kind === 'text')
        .map((event) => event.block.text);
      assert.ok(texts.length > 0, 'the agent did answer, and that answer is still recorded');
    });

    it('still keeps the space between two words (#132)', async function () {
      // The regression the obvious version of the fix causes: a chunk that is
      // only a space, arriving *inside* an open reply, is the space between two
      // words. Dropping those records "Helloworld".
      const h = harness();
      await boot(h, fixture('acp-omp'));
      h.events.length = 0;
      for (const text of ['Hello', ' ', 'world']) {
        h.adapter.handleMessage({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'x',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          },
        });
        await flush();
      }
      const opened = only(h.events, 'block_start').filter((event) => event.block.kind === 'text');
      const deltas = only(h.events, 'block_delta').map((event) => event.text);
      assert.strictEqual(opened.length, 1, 'one reply, opened once');
      assert.strictEqual(
        opened[0].block.text + deltas.join(''),
        'Hello world',
        'the space between the words survives',
      );
    });

    it('folds thought chunks into one thinking block and starts a new message on a new id', async function () {
      const h = harness({ readFile: async () => 'The magic word is BANANAPHONE.\n' });
      await feed(h, await boot(h, fixture('acp-omp')));

      const starts = only(h.events, 'msg_start');
      assert.deepStrictEqual(
        starts.map((event) => event.id),
        ['85a4127c-9ea1-411a-aa76-356c9f894974', 'c1e5156e-bc21-4ceb-92ac-2f5e84cbe762'],
      );

      const first = starts[0].id;
      const blocks = only(h.events, 'block_start').filter((event) => event.msgId === first);
      assert.deepStrictEqual(
        blocks.map((event) => event.block.kind),
        ['thinking', 'tool'],
      );
      assert.strictEqual(blocks[0].block.text, 'The');
      const deltas = only(h.events, 'block_delta').filter((event) => event.msgId === first);
      assert.deepStrictEqual(
        deltas.map((event) => event.text),
        [' user'],
      );
      // The first message must be closed before the second opens.
      const order = h.events.map((event) => event.t);
      assert.ok(order.indexOf('msg_end') < order.lastIndexOf('msg_start'));
    });

    it('keeps thinking and answer as separate blocks of one message', async function () {
      // opencode reuses one messageId for both, so the split is by chunk type.
      const h = harness();
      await feed(h, await boot(h, fixture('acp-opencode')));

      const last = only(h.events, 'msg_start').pop().id;
      const blocks = only(h.events, 'block_start').filter((event) => event.msgId === last);
      assert.deepStrictEqual(
        blocks.map((event) => event.block.kind),
        ['thinking', 'text'],
      );
      const answer = blocks[1].block.text;
      const rest = only(h.events, 'block_delta')
        .filter((event) => event.index === blocks[1].index && event.msgId === last)
        .map((event) => event.text)
        .join('');
      assert.strictEqual(answer + rest, 'BANANAPHONE');
    });

    it('leaves the user’s own turn to the session, and writes none of its own (#129)', async function () {
      // It used to write one, on top of the one `ChatSession.deliver` had
      // already written — one prompt, two identical bubbles in the same turn.
      // `deliver` is the only place that knows what the user actually typed: a
      // branched conversation hands this adapter the carried briefing glued in
      // front of the prompt, and a steer arrives with a flag this side never
      // sees. So the adapter's job here is the prompt on the wire, and nothing
      // in the transcript.
      const h = harness();
      await boot(h, fixture('acp-omp'));
      h.events.length = 0;

      await h.adapter.send({
        text: 'hello there',
        attachments: [{ url: '/files/a.png', path: '/tmp/a.png', mime: 'image/png', name: 'a.png', size: 1 }],
      });

      assert.deepStrictEqual(
        only(h.events, 'msg_start').filter((event) => event.role === 'user'),
        [],
        'the adapter must not open a user message of its own',
      );
      assert.deepStrictEqual(
        only(h.events, 'block_start').filter((event) => JSON.stringify(event.block).includes('hello there')),
        [],
        'nor write the prompt into the transcript a second time',
      );

      // What it does still do, all of it.
      const prompt = h.sent.find((message) => message.method === 'session/prompt');
      assert.deepStrictEqual(prompt.params.prompt, [
        { type: 'text', text: 'hello there' },
        { type: 'resource_link', uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png' },
      ], 'the prompt and its attachments still reach the agent');
      assert.strictEqual(only(h.events, 'state')[0].state, 'thinking');
    });
  });

  describe('tool calls', function () {
    it('opens a tool block with the agent kind, title and locations', async function () {
      const h = harness({ readFile: async () => '' });
      await feed(h, await boot(h, fixture('acp-omp')));

      const tool = only(h.events, 'block_start').find((event) => event.block.kind === 'tool').block;
      assert.strictEqual(tool.toolId, 'read_0|fc_tmp_ij645mhpgt8');
      assert.strictEqual(tool.title, 'Reading hello.txt');
      assert.strictEqual(tool.toolKind, 'read');
      assert.strictEqual(tool.status, 'pending');
      assert.deepStrictEqual(tool.input, { path: 'hello.txt' });
      assert.deepStrictEqual(tool.locations, [
        '/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox/hello.txt',
      ]);
    });

    it('patches the call out of band, by id', async function () {
      const h = harness();
      await feed(h, await boot(h, fixture('acp-opencode')));

      const patches = only(h.events, 'tool');
      assert.strictEqual(patches[0].toolId, 'call_54d075d708174b8c8a40a61e');
      assert.strictEqual(patches[0].patch.status, 'running');
      assert.strictEqual(patches[1].patch.status, 'completed');
      assert.strictEqual(patches[1].patch.output, 'The magic word is BANANAPHONE.');
    });

    it('classifies a tool the agent left unlabelled and records the failure', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      const lines = fixture('acp-permission');
      await feed(h, lines.slice(3));

      const tool = only(h.events, 'block_start').find((event) => event.block.kind === 'tool').block;
      assert.strictEqual(tool.toolKind, 'execute');
      const patch = only(h.events, 'tool')[0].patch;
      assert.strictEqual(patch.status, 'failed');
      assert.strictEqual(patch.output, '1 failing');
      assert.strictEqual(patch.error, '1 failing');
    });
  });

  describe('client-side requests', function () {
    it('answers a file read with the file, not with nothing', async function () {
      const reads = [];
      const h = harness({
        readFile: async (file) => {
          reads.push(file);
          return 'The magic word is BANANAPHONE.\n';
        },
      });
      await feed(h, await boot(h, fixture('acp-omp')));

      const answer = h.sent.find((message) => message.id === 0);
      assert.deepStrictEqual(answer.result, { content: 'The magic word is BANANAPHONE.\n' });
      assert.deepStrictEqual(reads, [
        '/home/daniele/Documents/Repos/code-agents-webcli/.work/probes/sandbox/hello.txt',
      ]);
    });

    it('refuses a read it cannot serve instead of leaving the agent waiting', async function () {
      const h = harness();
      await feed(h, await boot(h, fixture('acp-omp')));

      const answer = h.sent.find((message) => message.id === 0);
      assert.strictEqual(answer.result, undefined);
      assert.strictEqual(answer.error.code, -32602);
    });

    it('surfaces a failed read as an error and still answers', async function () {
      const h = harness({
        readFile: async () => {
          throw new Error('ENOENT');
        },
      });
      await feed(h, await boot(h, fixture('acp-omp')));

      const answer = h.sent.find((message) => message.id === 0);
      assert.strictEqual(answer.error.code, -32603);
      assert.ok(only(h.events, 'error').some((event) => /ENOENT/.test(event.message)));
    });

    it('writes a file on the agent behalf and acknowledges', async function () {
      const writes = [];
      const h = harness({ writeFile: async (file, contents) => writes.push([file, contents]) });
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(1, 2));

      assert.deepStrictEqual(writes, [['/work/hello.txt', 'one\nTWO\nthree\n']]);
      assert.deepStrictEqual(h.sent.find((message) => message.id === 8).result, {});
    });

    it('answers a method it does not implement rather than ignoring it', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      h.adapter.handleMessage({ jsonrpc: '2.0', id: 99, method: 'terminal/create', params: {} });

      assert.strictEqual(h.sent.find((message) => message.id === 99).error.code, -32601);
    });
  });

  describe('permissions', function () {
    it('emits a request, holds the id and answers with the selected option', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(0, 1));

      const request = only(h.events, 'permission')[0].request;
      assert.strictEqual(request.toolId, 'call_edit_1');
      assert.strictEqual(request.title, 'Edit hello.txt');
      assert.strictEqual(request.toolKind, 'edit');
      assert.deepStrictEqual(
        request.options.map((option) => option.kind),
        ['allow_once', 'allow_always', 'reject_once'],
      );
      assert.strictEqual(only(h.events, 'state').pop().state, 'awaiting_permission');
      // Nothing is sent back until a person decides.
      assert.strictEqual(h.sent.find((message) => message.id === 7), undefined);

      h.adapter.respondPermission(request.requestId, 'allow-always');
      assert.deepStrictEqual(h.sent.find((message) => message.id === 7).result, {
        outcome: { outcome: 'selected', optionId: 'allow-always' },
      });
      const resolved = only(h.events, 'permission_resolved')[0];
      assert.strictEqual(resolved.allowed, true);
      assert.strictEqual(resolved.automatic, undefined);
    });

    it('reports a denial as a denial, not as an allow', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(0, 1));

      const request = only(h.events, 'permission')[0].request;
      h.adapter.respondPermission(request.requestId, 'reject');
      assert.strictEqual(only(h.events, 'permission_resolved')[0].allowed, false);
    });

    it('cancels rather than inventing an option the agent never offered', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(0, 1));

      const request = only(h.events, 'permission')[0].request;
      h.adapter.respondPermission(request.requestId, 'made-up');
      assert.deepStrictEqual(h.sent.find((message) => message.id === 7).result, {
        outcome: { outcome: 'cancelled' },
      });
      assert.strictEqual(only(h.events, 'permission_resolved')[0].allowed, false);
    });

    it('carries the proposed change so the user reviews the diff, not the path', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(0, 1));

      const diffs = only(h.events, 'permission')[0].request.diffs;
      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].path, '/work/hello.txt');
      assert.strictEqual(diffs[0].kind, 'update');
      assert.strictEqual(diffs[0].added, 1);
      assert.strictEqual(diffs[0].removed, 1);
      assert.deepStrictEqual(diffs[0].hunks, [
        { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-two', '+TWO'] },
      ]);
    });

    it('auto-allows under the bypass and says the decision was not a person', async function () {
      const h = harness({ bypassPermissions: true });
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(0, 1));

      assert.deepStrictEqual(h.sent.find((message) => message.id === 7).result, {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      const resolved = only(h.events, 'permission_resolved')[0];
      assert.strictEqual(resolved.allowed, true);
      assert.strictEqual(resolved.automatic, true);
      assert.strictEqual(only(h.events, 'permission').length, 0);
    });
  });

  describe('turn accounting', function () {
    it('maps a usage update onto the context and cost fields', async function () {
      const h = harness({ readFile: async () => '' });
      await feed(h, await boot(h, fixture('acp-omp')));

      const usage = only(h.events, 'usage')[0].usage;
      assert.strictEqual(usage.contextWindow, 1048576);
      assert.strictEqual(usage.contextUsed, 27755);
      assert.strictEqual(usage.costUsd, 0.0950478);
    });

    it('closes the open message with the stop reason and counts tokens once', async function () {
      const h = harness({ readFile: async () => '' });
      const rest = await boot(h, fixture('acp-omp'));
      // The prompt goes out before the updates, exactly as it did on the wire:
      // the captured turn result is the reply to it.
      await h.adapter.send({ text: 'go' });
      await feed(h, rest);

      const end = only(h.events, 'msg_end').pop();
      assert.strictEqual(end.stopReason, 'end_turn');
      assert.deepStrictEqual(end.usage, {
        inputTokens: 28234,
        outputTokens: 147,
        totalTokens: 55517,
        cacheReadTokens: 27136,
        cacheWriteTokens: undefined,
        reasoningTokens: undefined,
      });
      const turn = only(h.events, 'turn_end').pop();
      assert.strictEqual(turn.stopReason, 'end_turn');
      assert.strictEqual(turn.usage, undefined);
    });

    it('keeps the usage when a turn produced no message at all', async function () {
      // kimi ended its turn without saying anything; the numbers still count.
      const h = harness();
      await boot(h, fixture('acp-kimi'));
      await h.adapter.send({ text: 'go' });
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: 3,
        result: { stopReason: 'end_turn', usage: { inputTokens: 12 } },
      });
      await flush();

      const turn = only(h.events, 'turn_end').pop();
      assert.strictEqual(turn.stopReason, 'end_turn');
      assert.strictEqual(turn.usage.inputTokens, 12);
    });

    it('cancels through the protocol rather than killing the process', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await h.adapter.interrupt();

      const cancel = h.sent.pop();
      assert.strictEqual(cancel.method, 'session/cancel');
      assert.strictEqual(cancel.params.sessionId, '019f994c-6f83-7000-aa56-89bb51fff42f');
      assert.strictEqual(cancel.id, undefined);
    });
  });

  describe('degradation', function () {
    it('publishes the agent slash commands with their argument hints', async function () {
      const h = harness();
      await feed(h, await boot(h, fixture('acp-omp')));

      const commands = only(h.events, 'capabilities')[0].capabilities.commands;
      assert.strictEqual(commands.length, 3);
      assert.deepStrictEqual(commands[0], {
        name: 'model',
        description: 'Show current model selection',
        hint: undefined,
      });
      assert.strictEqual(commands[1].hint, '[on|off|status]');
    });

    it('turns a plan update into plan items', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      await feed(h, fixture('acp-permission').slice(2, 3));

      assert.deepStrictEqual(only(h.events, 'plan')[0].items, [
        { text: 'Read the file', status: 'completed', priority: 'high' },
        { text: 'Reply with the word', status: 'in_progress', priority: undefined },
      ]);
    });

    it('survives malformed and unknown updates', async function () {
      const h = harness();
      await boot(h, fixture('acp-omp'));
      const before = h.events.length;

      for (const message of [
        { jsonrpc: '2.0', method: 'session/update' },
        { jsonrpc: '2.0', method: 'session/update', params: { update: null } },
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'nonsense' } } },
        { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call' } } },
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: 42 } },
        },
        { jsonrpc: '2.0', method: 'lifecycle/whatever', params: {} },
      ]) {
        h.adapter.handleMessage(message);
      }

      // Nothing thrown, nothing invented: an update naming no content is not an
      // error the user needs to see.
      assert.strictEqual(h.events.length, before);
    });

    it('replays into the transcript the reducer builds', async function () {
      // The events are the mechanism; this is the outcome. Folding the whole
      // capture the way a session and a browser both will is the only check
      // that says the conversation actually reads correctly at the far end.
      const h = harness({ readFile: async () => 'The magic word is BANANAPHONE.\n' });
      const rest = await boot(h, fixture('acp-omp'));
      // The user's message as the session writes it, because the session writes
      // it and the adapter no longer does (#129). Folding the capture without
      // it would be folding half a conversation.
      const asked = [
        { t: 'msg_start', id: `user-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, role: 'user', turnId: 'turn-1' },
        { t: 'block_start', msgId: `user-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, index: 0, block: { kind: 'text', text: 'What is the magic word?' } },
        { t: 'msg_end', msgId: `user-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}` },
      ];
      await h.adapter.send({ text: 'What is the magic word?' });
      await feed(h, rest);

      const state = createTranscript(only(h.events, 'session')[0].capabilities);
      [...asked, ...h.events].forEach((event, index) => applyChatEvent(state, { ...event, seq: index + 1 }));

      assert.deepStrictEqual(
        state.messages.map((message) => message.role),
        ['user', 'assistant', 'assistant'],
      );
      assert.strictEqual(messageText(state.messages[0]), 'What is the magic word?');
      assert.ok(state.messages.every((message) => !message.streaming));

      const tool = state.messages[1].blocks.find((block) => block.kind === 'tool');
      assert.strictEqual(tool.status, 'completed');
      assert.strictEqual(tool.toolKind, 'read');

      const answer = state.messages[2];
      assert.deepStrictEqual(
        answer.blocks.map((block) => block.kind),
        ['thinking', 'text'],
      );
      assert.strictEqual(answer.blocks[1].text, 'abacus');
      assert.strictEqual(answer.stopReason, 'end_turn');
      assert.strictEqual(state.state, 'idle');
      assert.strictEqual(state.usage.contextUsed, 27755);
      assert.strictEqual(state.usage.inputTokens, 28234);
    });

    it('names the login when an unauthenticated agent refuses a session', async function () {
      const h = harness();
      const done = h.adapter.handshake().then(
        () => null,
        (error) => error,
      );
      h.adapter.handleMessage(fixture('acp-kimi')[0]);
      await flush();
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'Authentication required' },
      });
      const error = await done;

      assert.ok(/Login with Kimi account/.test(error.message));
      assert.ok(only(h.events, 'error').some((event) => event.fatal));
      assert.strictEqual(only(h.events, 'state').pop().state, 'error');
    });
  });
});
