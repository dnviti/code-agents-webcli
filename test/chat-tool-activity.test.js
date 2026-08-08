const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const {
  AntigravityChatAdapter,
} = require('../dist/server/chat/adapters/antigravity.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const {
  advertisedChatCapabilities,
  chatCapableRuntimes,
  createChatAdapter,
} = require('../dist/server/chat/registry.js');
const { feed, wire } = require('./acp-fixture-harness.js');

/**
 * Issue #73: work an agent does has to show up as work.
 *
 * Grok was the report — a conversation where it rewrote four files looked
 * exactly like one where it thought hard and wrote a paragraph — but the
 * honest position was that nobody had checked the others end to end. Each of
 * these CLIs is driven differently and describes its own work differently, so
 * "tool activity shows up" is a claim that has to be established per agent.
 *
 * So this file asks the same three questions of every runtime the app can chat
 * with, and answers them from that runtime's own recorded output:
 *
 *   1. Is the work visible while it happens — does a tool block reach the
 *      transcript, distinct from the agent's reasoning?
 *   2. Is it still there when the conversation is reopened — does it survive a
 *      round trip through the log, which is all a reopened conversation has?
 *   3. Is it counted — do the usage figures see it?
 *
 * Every fixture here is real captured output. That is not a style preference:
 * a fixture written to match our own assumptions is exactly what would let
 * this defect through again, because the assumption that grok reported tool
 * calls is the assumption that produced it.
 */

function fixture(name) {
  const file = path.join(__dirname, 'fixtures', 'chat', name);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The user's own message, the way a session writes it.
 *
 * `ChatSession.deliver` emits this before handing the prompt to the runtime,
 * and it is what opens a usage job — so a fixture that is nothing but the
 * runtime's own output has to be preceded by it or nothing downstream has a
 * turn to attribute the work to. The ACP adapters write their own (`send`
 * does it), so only the three that do not need this.
 */
function userTurn(emit, turnId) {
  emit({ t: 'msg_start', id: 'u1', role: 'user', turnId });
  emit({ t: 'block_start', msgId: 'u1', index: 0, block: { kind: 'text', text: 'do the thing' } });
  emit({ t: 'msg_end', msgId: 'u1' });
}

/**
 * The runtimes, each with the recorded output of a turn that used tools.
 *
 * `drive` feeds that output through the real adapter and hands back the events
 * a session would have ingested. Nothing is simulated between the two.
 */
const RUNTIMES = [
  {
    runtime: 'claude',
    fixture: 'claude-oneshot.jsonl',
    async drive(emit) {
      const adapter = new ClaudeChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'claude',
        emit,
      });
      userTurn(emit, 'turn-1');
      for (const line of fixture('claude-oneshot.jsonl')) adapter.handleMessage(line);
    },
  },
  {
    runtime: 'codex',
    fixture: 'codex-appserver-tool-turn.jsonl',
    async drive(emit) {
      const adapter = new CodexAppServerAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit,
      });
      adapter.writeLine = () => {};
      const done = adapter.handshake();
      for (const line of fixture('codex-appserver-handshake.jsonl')) {
        adapter.handleMessage(line);
        await flush();
      }
      await done;
      userTurn(emit, 'turn-1');
      for (const line of fixture('codex-appserver-tool-turn.jsonl')) {
        adapter.handleMessage(line);
        await flush();
      }
    },
  },
  {
    runtime: 'pi',
    fixture: 'pi-tool-turn.jsonl',
    async drive(emit) {
      const adapter = new PiChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'pi',
        emit,
      });
      userTurn(emit, 'turn-1');
      for (const line of fixture('pi-tool-turn.jsonl')) adapter.handleMessage(line);
    },
  },
  {
    // A fresh capture, because the kimi probe already in the tree only ever
    // ran a handshake — the agent was never asked to do anything. An agent
    // whose tool reporting has never been watched is not an agent whose tool
    // reporting is known to work, which is the whole thesis of this issue.
    runtime: 'kimi',
    fixture: 'acp-kimi-tools.jsonl',
    acp: true,
  },
  {
    runtime: 'omp',
    fixture: 'acp-omp.jsonl',
    acp: true,
  },
  {
    // The whole point of the issue. Same binary and same version as the
    // headless probe that reported nothing at all; a different entry point.
    runtime: 'grok',
    fixture: 'acp-grok.jsonl',
    acp: true,
  },
  {
    // agy 1.1.8, `--print --output-format stream-json`, asked to read a file,
    // edit it and create another. The capture holds a run_command, a
    // replace_file_content and a write_to_file.
    runtime: 'antigravity',
    fixture: 'antigravity-tool-turn.jsonl',
    async drive(emit) {
      const adapter = new AntigravityChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit,
      });
      // `start()` is skipped rather than stubbed: it would spawn `agy models`
      // for the picker, which is the one thing in this adapter that is not a
      // pure function of the capture. What `send()` sets up before the first
      // line arrives is set here instead, which is exactly the two fields
      // below — the same shape as the `writeLine` stub the codex entry uses.
      adapter.currentTurnId = 'turn-1';
      adapter.turnInFlight = true;
      userTurn(emit, 'turn-1');
      for (const line of fixture('antigravity-tool-turn.jsonl')) adapter.handleMessage(line);
    },
  },
];

for (const entry of RUNTIMES) {
  if (!entry.acp) continue;
  entry.drive = async (emit) => {
    const adapter = new AcpChatAdapter({
      sessionId: 'chat-1',
      workingDir: '/work',
      command: '/nonexistent',
      runtime: entry.runtime,
      acpArgs: ['acp'],
      emit,
    });
    const sent = [];
    wire(adapter, sent);
    const lines = fixture(entry.fixture);
    const done = adapter.handshake();
    await feed(adapter, lines.slice(0, 2), sent);
    await done;
    // The user's message as the *session* writes it, because the session is the
    // only thing that writes one — the ACP adapters used to echo it back and
    // put a second identical bubble in the turn (#129). The codex and pi
    // entries above have always modelled it this way; this one relied on the
    // echo, so it is spelled out here too.
    userTurn(emit, 'turn-1');
    // A real turn, not just a replay: `session/prompt` has to be outstanding
    // for its reply — the line carrying the turn's spend — to be delivered to
    // anything at all. Feeding the capture without it drops the one message
    // that says what the turn cost.
    const sending = adapter.send({ text: 'do the thing' });
    await feed(adapter, lines.slice(2), sent);
    await sending;
  };
}

/** Every event the adapter produced, stamped the way a session stamps them. */
async function eventsFor(entry) {
  const events = [];
  await entry.drive((event) => {
    events.push({ ...event, seq: events.length + 1, ts: event.ts ?? 1_000 + events.length });
  });
  return events;
}

/** The transcript a browser watching live would have built. */
function live(events) {
  const state = createTranscript({});
  for (const event of events) applyChatEvent(state, event);
  return state;
}

/**
 * The transcript a conversation reopened tomorrow would be built from.
 *
 * Through JSON and back, because the log is a file of JSON lines and that is
 * genuinely all a reopened conversation has — anything the adapter held in
 * memory is gone with the process.
 */
function reopened(events) {
  return live(JSON.parse(JSON.stringify(events)));
}

function toolBlocks(state) {
  const found = [];
  for (const message of state.messages) {
    for (const block of message.blocks || []) {
      if (block.kind === 'tool') found.push(block);
    }
  }
  return found;
}

describe('tool activity, on every runtime that can be chatted with', function () {
  for (const entry of RUNTIMES) {
    describe(entry.runtime, function () {
      let events;

      before(async function () {
        events = await eventsFor(entry);
      });

      it('shows the work as work, not as reasoning', function () {
        const blocks = toolBlocks(live(events));
        assert.ok(
          blocks.length > 0,
          `${entry.runtime} produced no tool block from ${entry.fixture}`,
        );
        // A name, because a block the user cannot identify is barely better
        // than no block: "it ran something" is not an account of what happened
        // to their working folder.
        for (const block of blocks) {
          assert.ok(block.name, `${entry.runtime} produced a tool block with no name`);
        }
      });

      it('still has it when the conversation is reopened', function () {
        const before = toolBlocks(live(events)).map((block) => block.toolId);
        const after = toolBlocks(reopened(events)).map((block) => block.toolId);
        assert.deepStrictEqual(after, before);
      });

      it('counts it in the usage figures', function () {
        const jobs = [];
        const accountant = new UsageAccountant((job) => jobs.push(job));
        for (const event of events) accountant.observe(event);
        accountant.flush(9_999);

        const toolCalls = jobs.reduce((total, job) => total + job.toolCalls, 0);
        const distinct = new Set(toolBlocks(live(events)).map((block) => block.toolId));
        assert.strictEqual(
          toolCalls,
          distinct.size,
          `${entry.runtime}: counted ${toolCalls} tool calls for ${distinct.size} tool blocks`,
        );
        assert.ok(toolCalls > 0, `${entry.runtime} recorded zero tool calls`);

        // And per tool, which is the figure that makes two agents comparable
        // rather than merely non-zero.
        const named = jobs.flatMap((job) => job.tools);
        assert.ok(named.length > 0, `${entry.runtime} recorded no per-tool figures`);
        assert.strictEqual(
          named.reduce((total, tool) => total + tool.calls, 0),
          toolCalls,
        );
      });
    });
  }

  it('advertises tool calls for every runtime, and every one of them delivers', async function () {
    // Three layers that have to agree, checked against each other, because
    // before #73 two of them did not: the table advertised `toolCalls: true`
    // for grok, the adapter the table itself builds for grok set it to false,
    // and the runtime reported no tool call ever. The one place the app is
    // meant to be honest about capability said the opposite of the truth.
    const runtimes = chatCapableRuntimes();
    assert.deepStrictEqual(runtimes.slice().sort(), RUNTIMES.map((e) => e.runtime).sort());

    for (const entry of RUNTIMES) {
      assert.strictEqual(
        advertisedChatCapabilities(entry.runtime).toolCalls,
        true,
        `${entry.runtime} does not advertise tool calls`,
      );

      // The adapter the app would really build for this runtime, not a
      // hand-picked one — that distinction is the whole defect. Asking the
      // registry is what makes this fail if grok is ever wired back onto a
      // transport that cannot report a tool call.
      //
      // "Or it has not decided yet" is not a loophole: codex picks between
      // app-server and its `exec` fallback when it starts, and until then it
      // reports the empty capability set rather than half of one. What is
      // ruled out is the state grok was in — a populated capability set that
      // contradicts the table on this one flag.
      const adapter = createChatAdapter(entry.runtime, {
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: () => {},
      });
      const undecided = Object.values(adapter.capabilities).every((value) => value === false);
      assert.ok(
        adapter.capabilities.toolCalls === true || undecided,
        `${entry.runtime}: the app builds an adapter that reports it cannot do tool calls`,
      );

      const blocks = toolBlocks(live(await eventsFor(entry)));
      assert.ok(blocks.length > 0, `${entry.runtime} advertises tool calls and produced none`);
    }
  });
});

describe('grok, driven over ACP', function () {
  let events;

  before(async function () {
    events = await eventsFor(RUNTIMES.find((entry) => entry.runtime === 'grok'));
  });

  it('reports reading a file and running a command, with what each one touched', function () {
    const blocks = toolBlocks(live(events));
    // The name is grok's own name for the tool; the title is the phrasing it
    // sends a moment later, once it knows what the call turned out to be. Both
    // are kept, because "read_file" and "Read `probe.txt`" answer different
    // questions and the second only exists after the arguments are parsed.
    assert.deepStrictEqual(
      blocks.map((block) => block.name),
      ['read_file', 'run_terminal_command', 'read_file'],
    );
    assert.deepStrictEqual(
      blocks.map((block) => block.title),
      ['Read `probe.txt`', 'Execute `echo "OK" > answer.txt`', 'Read `answer.txt`'],
    );
    assert.deepStrictEqual(blocks[0].locations, ['probe.txt']);
    assert.strictEqual(blocks[0].toolKind, 'read');
    assert.strictEqual(blocks[1].toolKind, 'execute');
    // Every one finished, and the transcript says so rather than leaving three
    // calls that look like they are still running.
    assert.deepStrictEqual(
      blocks.map((block) => block.status),
      ['completed', 'completed', 'completed'],
    );
  });

  it('keeps the tool output, which is the account of what the command did', function () {
    const blocks = toolBlocks(live(events));
    assert.match(blocks[0].output, /hello from the acp probe/);
    assert.match(blocks[2].output, /OK/);
  });

  it('names the model it ran and offers the list it published', function () {
    const session = events.find((event) => event.t === 'session');
    assert.strictEqual(session.model, 'grok-build');
    assert.deepStrictEqual(
      (session.capabilities.models || []).map((model) => model.value),
      ['grok-build', 'grok-4.5'],
    );
  });

  it('says it can resume, on `loadSession` alone', function () {
    // Grok publishes `loadSession: true` and an empty `sessionCapabilities`.
    // The gate used to also require `sessionCapabilities.resume`, which kimi,
    // omp and opencode all send — so it never bit until a runtime arrived that
    // loads sessions perfectly well without announcing that key.
    const session = events.find((event) => event.t === 'session');
    assert.strictEqual(session.capabilities.resume, true);
  });

  it('reads the turn’s spend out of `_meta`, where grok puts it', function () {
    // kimi and omp answer `session/prompt` with a `usage` field; grok answers
    // with `_meta.usage`. Reading only the first spelling filed every grok turn
    // as free.
    const jobs = [];
    const accountant = new UsageAccountant((job) => jobs.push(job));
    for (const event of events) accountant.observe(event);
    accountant.flush(9_999);

    const [job] = jobs;
    assert.strictEqual(job.usage.inputTokens, 65551);
    assert.strictEqual(job.usage.outputTokens, 392);
    assert.strictEqual(job.usage.cacheReadTokens, 38272);
    assert.strictEqual(job.usage.reasoningTokens, 332);
  });

  it('converts a cost quoted in ticks into dollars', function () {
    // 357174000 ticks. Grok quotes cost only in these, and a tick is a
    // ten-billionth of a dollar — read off a headless run that reported both
    // `total_cost_usd: 0.02338` and `total_cost_usd_ticks: 233800000`.
    const jobs = [];
    const accountant = new UsageAccountant((job) => jobs.push(job));
    for (const event of events) accountant.observe(event);
    accountant.flush(9_999);

    assert.ok(Math.abs(jobs[0].usage.costUsd - 0.0357174) < 1e-9);
  });
});

/**
 * The side effect of moving grok onto ACP, and why it needed catching.
 *
 * Grok's headless mode never reported a command list, so the session's stand-in
 * — the skills and project commands it finds on disk — stood for the whole
 * session. Its ACP mode announces seven built-ins (`compact`, `context`, ...)
 * and says nothing about `.grok/skills`, and an adapter replaces the stand-in
 * with what the runtime reports. So the change that made grok's *tools* visible
 * would, on its own, have made a grok user's *skills* disappear from the menu
 * a few milliseconds after the conversation opened.
 */
describe('a runtime reporting its own commands does not drop what is installed', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-tool-activity-'));
    const skillDir = path.join(dir, 'home/.pi/agent/skills/commit');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: commit\ndescription: Write the commit message\n---\n',
    );
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an installed skill when the runtime announces its built-ins', async function () {
    const { ChatSession } = require('../dist/server/chat/session.js');
    const broadcast = [];
    const session = new ChatSession(
      { id: 's1', ownerUserId: 7 },
      {
        store: {
          append() {},
          async stat() { return { firstSeq: 1, cursor: 0 }; },
          async read() { return { events: [], firstSeq: 1, from: 1, cursor: 0 }; },
        },
        socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-sock-')),
        hookScript: path.join(dir, 'no-such-hook.js'),
        broadcast: (_id, message) => broadcast.push(message),
        resolveCommand: () => '/bin/cat',
      },
    );

    // Driven on pi, whose adapter opens without a handshake — `/bin/cat` says
    // nothing, and an ACP handshake would wait on it forever. What is under
    // test is the session rather than any one protocol: a runtime, any runtime,
    // reporting a command list after the disk has already been scanned.
    await session.start({
      runtime: 'pi',
      workingDir: path.join(dir, 'project'),
      env: { HOME: path.join(dir, 'home') },
    });

    session.ingest({
      t: 'capabilities',
      capabilities: { commands: [{ name: 'compact', description: 'Compress conversation history' }] },
    });
    await session.stop();

    const names = (session.capabilities.commands || []).map((command) => command.name);
    assert.ok(names.includes('compact'), 'the runtime’s own command is offered');
    assert.ok(names.includes('commit'), 'and the installed skill is still there');

    // On the event too, not just on the session's copy: the browser builds its
    // menu from the log, so a merge applied only locally is a menu that differs
    // between the server and every client reading it.
    // The one carrying commands. A pi session now also announces that it can
    // ask questions (#174), which is a `capabilities` event of its own and
    // arrives first — taking whichever came first found that one and read it as
    // a command list that had lost everything.
    const reported = broadcast
      .map((message) => message.event)
      .find((event) => event && event.t === 'capabilities' && event.capabilities.commands);
    assert.deepStrictEqual(
      (reported.capabilities.commands || []).map((command) => command.name),
      ['compact', 'commit'],
    );
  });
});

/**
 * The one capability the move to ACP would otherwise have cost grok.
 *
 * Headless mode took `--model` per invocation, so switching models mid-session
 * worked by changing what the next turn spawned with. ACP has no argv to
 * rewrite — but it does have `session/set_model`, and grok answers it.
 */
describe('switching a model on an ACP agent', function () {
  function harness(runtime) {
    const events = [];
    const sent = [];
    const adapter = new AcpChatAdapter({
      sessionId: 'chat-1',
      workingDir: '/work',
      command: '/nonexistent',
      runtime,
      acpArgs: ['acp'],
      emit: (event) => events.push(event),
    });
    adapter.writeLine = (payload) => sent.push(payload);
    return { adapter, events, sent };
  }

  async function booted(runtime, fixtureName) {
    const h = harness(runtime);
    const lines = fixture(fixtureName);
    const done = h.adapter.handshake();
    for (const line of lines.slice(0, 2)) {
      h.adapter.handleMessage(line);
      await flush();
    }
    await done;
    h.sent.length = 0;
    return h;
  }

  it('asks the agent, naming the session and the model', async function () {
    const h = await booted('grok', 'acp-grok.jsonl');
    const pending = h.adapter.setModel('grok-4.5');
    await flush();

    const request = h.sent.find((message) => message.method === 'session/set_model');
    assert.deepStrictEqual(request.params, {
      sessionId: '019fa507-a65c-74d3-a53f-096701d2ddfe',
      modelId: 'grok-4.5',
    });

    h.adapter.handleMessage({ jsonrpc: '2.0', id: request.id, result: { _meta: { model: { Ok: 'grok-4.5' } } } });
    await pending;
  });

  // Kimi and omp publish a `model` config option, and a switch goes down that
  // road rather than `session/set_model` — because it is the only one that
  // brings the rest of the configuration back with it. Probed against kimi:
  // `session/set_model` answers `{}` and says nothing about the new model, while
  // setting the model *as a config option* answers with the whole option list
  // rebuilt, thinking ladder included — which genuinely differs per model
  // (`off`/`on` on one, `off`/`low`/`medium`/`high`/`xhigh` on another). Taking
  // the quiet road left the effort control offering levels the new model refuses.
  it('sets the model as a config option where the agent published one, so the rest of the configuration comes back', async function () {
    const h = await booted('kimi', 'acp-kimi-tools.jsonl');
    const pending = h.adapter.setModel('kimi-k2');
    await flush();

    const request = h.sent.find((message) => message.method === 'session/set_config_option');
    assert.ok(request, 'expected the config-option road, not session/set_model');
    assert.strictEqual(request.params.configId, 'model');
    assert.strictEqual(request.params.value, 'kimi-k2');
    assert.ok(
      !h.sent.some((message) => message.method === 'session/set_model'),
      'the quiet road is not also taken',
    );

    h.adapter.handleMessage({ jsonrpc: '2.0', id: request.id, result: { configOptions: [] } });
    await pending;
  });

  it('rejects when the agent refuses the switch, so the caller can fall back', async function () {
    // -32601 is what an agent that never implemented this answers. The websocket
    // handler catches it and offers the runtime's own `/model` command instead
    // — which is strictly better than reporting a switch that never happened.
    const h = await booted('kimi', 'acp-kimi-tools.jsonl');
    const pending = h.adapter.setModel('kimi-k2');
    await flush();

    const request = h.sent.find((message) => message.method === 'session/set_config_option');
    h.adapter.handleMessage({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Method not found' },
    });
    await assert.rejects(pending);
  });
});
