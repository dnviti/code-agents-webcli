const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AntigravityBridge } = require('../dist/server/bridges/antigravity.js');
const {
  AntigravityChatAdapter,
  withAttachments,
} = require('../dist/server/chat/adapters/antigravity.js');
const {
  installedModels,
  resetInstalledModels,
} = require('../dist/server/chat/installed-models.js');
const { collectAgentActivity } = require('../dist/shared/agent-activity.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const {
  advertisedChatCapabilities,
  createChatAdapter,
  supportsChat,
} = require('../dist/server/chat/registry.js');
const { isChatRuntime } = require('../dist/shared/chat-runtimes.js');

/**
 * Issue #133: Antigravity CLI (`agy`) as a runtime like any other.
 *
 * Every fixture here is verbatim output of agy 1.1.8 — the same discipline the
 * rest of the chat tests keep, and for the same reason: an invented event shape
 * agrees with the adapter that invented it and proves nothing about the CLI.
 *
 * `getArgs`, `getCommandCandidates`, `buildArgs` and `handleMessage` are
 * `protected` in TypeScript, which is a compile-time rule only; at runtime they
 * are ordinary methods.
 */

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Drive a capture through the real adapter and collect what a session would ingest. */
function driveFixture(name, options = {}) {
  const events = [];
  const adapter = new AntigravityChatAdapter({
    sessionId: 'chat-1',
    workingDir: '/work',
    command: '/nonexistent',
    emit: (event) => events.push({ ...event, seq: events.length + 1, ts: 1_000 + events.length }),
    ...options,
  });
  // What `send()` sets before the first line lands. `start()` is skipped
  // deliberately: it spawns `agy models` for the picker, which is the one part
  // of this adapter that is not a pure function of the capture.
  adapter.currentTurnId = 'turn-1';
  adapter.turnInFlight = true;
  for (const line of fixture(name)) adapter.handleMessage(line);
  return { adapter, events };
}

/**
 * The transcript a browser would have built, from a copy of the events.
 *
 * The copy is not ceremony. `block_start` puts the event's own `block` object
 * into the transcript by reference and `block_delta` appends into it, so
 * folding the same array twice starts the second fold from a block the first
 * one already filled in — which reads as an adapter that emitted the reply
 * three times. Every fold here gets its own events, which is also what a real
 * reader has: the log is a file of JSON lines.
 */
function transcriptOf(events) {
  const state = createTranscript({});
  for (const event of JSON.parse(JSON.stringify(events))) applyChatEvent(state, event);
  return state;
}

function blocksOf(events, kind) {
  const found = [];
  for (const message of transcriptOf(events).messages) {
    for (const block of message.blocks || []) {
      if (block.kind === kind) found.push(block);
    }
  }
  return found;
}

function lastOf(events, type) {
  return events.filter((event) => event.t === type).pop();
}

describe('AntigravityBridge (terminal mode)', function () {
  it('tries the installer directory before PATH', function () {
    // The installer drops a single ~190MB executable in ~/.local/bin, which is
    // often missing from a systemd --user PATH.
    const candidates = new AntigravityBridge().getCommandCandidates();
    assert.strictEqual(candidates[0], path.join(os.homedir(), '.local', 'bin', 'agy'));
    assert.ok(candidates.includes('agy'));
  });

  it('starts interactive, with no one-shot flag', function () {
    const args = new AntigravityBridge().getArgs({});
    assert.deepStrictEqual(args, []);
  });

  it('passes the real bypass flag, and only when asked', function () {
    const bridge = new AntigravityBridge();
    assert.deepStrictEqual(bridge.getArgs({ dangerouslySkipPermissions: true }), [
      '--dangerously-skip-permissions',
    ]);
    // `--mode accept-edits` and `--mode plan` both parse and neither changes
    // anything observable, so no control is wired to them.
    assert.ok(!bridge.getArgs({ dangerouslySkipPermissions: true }).includes('--mode'));
  });

  it('carries a profile model on --model', function () {
    assert.strictEqual(new AntigravityBridge().getModelFlag(), '--model');
  });

  it('answers the trust question a first launch in a folder asks', function () {
    // Captured from a real PTY run in a directory agy had never seen. Without an
    // answer it sits on this screen forever, which from the browser is a session
    // that looks alive and does nothing.
    const bridge = new AntigravityBridge();
    const written = [];
    const session = { process: { write: (data) => written.push(data) } };
    bridge.sessions.set('s1', session);

    const prompt =
      'Accessing workspace:\n\n/tmp/agy-probe\n\nDo you trust the contents of this project?\n\n'
      + 'Antigravity CLI requires permission to read, edit, and execute files here.\n\n'
      + '> Yes, I trust this folder\n  No, exit\n';

    const clock = fakeTimers();
    try {
      bridge.onSessionData('s1', prompt, prompt);
      clock.run();
      assert.deepStrictEqual(written, ['\r'], 'Enter should take the highlighted "Yes" row');

      // And exactly once: the phrase can reappear in scrollback the user pages
      // through, and a stray Enter there lands in whatever is on screen then.
      bridge.onSessionData('s1', prompt, prompt + prompt);
      clock.run();
      assert.deepStrictEqual(written, ['\r']);
    } finally {
      clock.restore();
    }
  });

  it('says nothing to a session that was never asked', function () {
    const bridge = new AntigravityBridge();
    const written = [];
    bridge.sessions.set('s1', { process: { write: (data) => written.push(data) } });
    const clock = fakeTimers();
    try {
      bridge.onSessionData('s1', 'ordinary output', 'ordinary output');
      clock.run();
      assert.deepStrictEqual(written, []);
    } finally {
      clock.restore();
    }
  });
});

/** A setTimeout that fires when told, so the bridge's 500ms delay is not waited out. */
function fakeTimers() {
  const original = global.setTimeout;
  const queued = [];
  global.setTimeout = (fn) => {
    queued.push(fn);
    return { unref() {} };
  };
  return {
    run() {
      const pending = queued.splice(0, queued.length);
      for (const fn of pending) fn();
    },
    restore() {
      global.setTimeout = original;
    },
  };
}

describe('AntigravityChatAdapter (headless mode)', function () {
  describe('the command line it builds', function () {
    function argsFor(options = {}) {
      return new AntigravityChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'agy',
        emit() {},
        ...options,
      }).buildArgs();
    }

    it('keeps the agent in the folder the user picked', function () {
      // Without --new-project every shell tool runs in
      // ~/.gemini/antigravity-cli/scratch, whatever the process's own cwd is —
      // measured in a fresh directory, in a directory agy had been trusted in,
      // and in this repository. Asked to read a file that was sitting right
      // there, the unflagged run reported no such file existed.
      assert.ok(argsFor().includes('--new-project'));
    });

    it('asks for the structured stream and a ceiling a conversation can live with', function () {
      const args = argsFor();
      assert.ok(args.includes('--output-format'));
      assert.strictEqual(args[args.indexOf('--output-format') + 1], 'stream-json');
      // agy's own default is 5m, which cuts a long turn off mid-work with
      // nothing on screen to explain it. The ceiling that matters is the user's,
      // and it is the interrupt button.
      assert.strictEqual(args[args.indexOf('--print-timeout') + 1], '24h');
    });

    it('bypasses approvals only when the conversation was started that way', function () {
      assert.ok(!argsFor().includes('--dangerously-skip-permissions'));
      assert.ok(argsFor({ bypassPermissions: true }).includes('--dangerously-skip-permissions'));
    });

    it('resumes the conversation it was handed', function () {
      const args = argsFor({ resumeSessionId: 'conv-9' });
      assert.strictEqual(args[args.indexOf('--conversation') + 1], 'conv-9');
    });

    it('never sends a model and an effort together, because agy refuses both ways', function () {
      // `--model gemini-3.6-flash-low --effort high` answers "conflicts with
      // --effort=high"; `--model claude-sonnet-4-6 --effort high` answers
      // "--effort is not supported for model". The flag is only usable when
      // nothing is pinned.
      const adapter = new AntigravityChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'agy',
        model: 'gemini-3.6-flash-low',
        effort: 'high',
        emit() {},
      });
      const args = adapter.buildArgs();
      assert.ok(args.includes('--model'));
      assert.ok(!args.includes('--effort'), args.join(' '));
    });

    it('puts the profile\'s own arguments last', function () {
      const args = argsFor({ extraArgs: ['--sandbox'] });
      assert.strictEqual(args[args.length - 1], '--sandbox');
    });
  });

  describe('attachments', function () {
    it('names each attached file, by the path it was saved at', function () {
      // agy has no attachment flag and no mention syntax — `@notes.txt` reaches
      // the model as literal text. What it does have is a working directory it
      // can read, and every upload is stored inside it.
      const prompt = withAttachments({
        text: 'what is in this?',
        attachments: [
          { url: '/a', mime: 'image/png', name: 'shot.png', size: 1, path: '/work/.cc-web/attachments/ab-shot.png' },
        ],
      });
      assert.ok(prompt.startsWith('what is in this?'), prompt);
      assert.ok(prompt.includes('/work/.cc-web/attachments/ab-shot.png'), prompt);
      assert.match(prompt, /attached this file/);
    });

    it('counts them when there is more than one', function () {
      const prompt = withAttachments({
        text: 'compare these',
        attachments: [
          { url: '/a', mime: 'image/png', name: 'a.png', size: 1, path: '/work/a.png' },
          { url: '/b', mime: 'image/png', name: 'b.png', size: 1, path: '/work/b.png' },
        ],
      });
      assert.match(prompt, /attached these 2 files/);
      assert.ok(prompt.includes('/work/a.png') && prompt.includes('/work/b.png'), prompt);
    });

    it('leaves a turn with no attachments exactly as the user typed it', function () {
      // The prompt is the user's words. Anything added when there is nothing to
      // add would be this app talking over them.
      assert.strictEqual(withAttachments({ text: 'plain question' }), 'plain question');
      assert.strictEqual(withAttachments({ text: 'plain question', attachments: [] }), 'plain question');
    });

    it('skips an attachment that has no path, rather than describing it', function () {
      // `path` is optional on the wire; a runtime that cannot be handed one has
      // nothing to be told about it.
      const prompt = withAttachments({
        text: 'look',
        attachments: [{ url: '/a', mime: 'image/png', name: 'a.png', size: 1 }],
      });
      assert.strictEqual(prompt, 'look');
    });
  });

  describe('a turn that used tools', function () {
    let events;

    before(function () {
      events = driveFixture('antigravity-tool-turn.jsonl').events;
    });

    it('reports the conversation id, which is the whole of resuming later', function () {
      const session = lastOf(events, 'session');
      assert.strictEqual(session.nativeSessionId, '1f8ab6f4-e1f7-402c-90f3-91a3bb5cced4');
    });

    it('shows each call as its own card, naming what it touched', function () {
      const tools = blocksOf(events, 'tool');
      assert.deepStrictEqual(
        tools.map((block) => block.name),
        ['run_command', 'replace_file_content', 'write_to_file'],
      );
      const [command, edit] = tools;
      assert.strictEqual(command.title, 'cat notes.txt');
      assert.strictEqual(command.status, 'completed');
      assert.match(command.output, /line one/);
      assert.ok(command.durationMs >= 0);
      assert.strictEqual(edit.toolKind, 'edit');
      assert.deepStrictEqual(edit.locations, ['/tmp/agy-probe-3/notes.txt']);
    });

    it('says how much was thought, because agy will not say what', function () {
      // Every usage line carries thinking_tokens and no event anywhere carries a
      // word of the reasoning. One entry per message, growing, rather than six
      // each reading "~318 tokens".
      const thinking = blocksOf(events, 'thinking');
      assert.strictEqual(thinking.length, 1);
      assert.strictEqual(thinking[0].text, '');
      assert.strictEqual(thinking[0].tokens, 435 + 359 + 317);
    });

    it('assembles the reply from deltas, not from repeated snapshots', function () {
      // The step arrives ACTIVE with the opening and DONE with the rest;
      // concatenated they are exactly what `result.response` says.
      const text = blocksOf(events, 'text').map((block) => block.text).join('');
      const result = fixture('antigravity-tool-turn.jsonl').pop().result;
      assert.strictEqual(text, result.response);
    });

    it('bills the turn what agy said the turn cost, thinking and cache included', function () {
      const turn = lastOf(events, 'turn_end');
      assert.deepStrictEqual(turn.usage, {
        inputTokens: 26420,
        outputTokens: 1438,
        cacheReadTokens: 28352,
        reasoningTokens: 1111,
        totalTokens: 27858,
      });
      // Nothing anywhere prices a turn, so nothing here claims to.
      assert.strictEqual(turn.usage.costUsd, undefined);
      assert.strictEqual(turn.modelTurns, 1);
      assert.strictEqual(turn.durationMs, 11404);
    });
  });

  describe('a tool refused because there was nobody to ask', function () {
    let events;

    before(function () {
      events = driveFixture('antigravity-refused.jsonl').events;
    });

    it('marks the call denied rather than failed', function () {
      const [tool] = blocksOf(events, 'tool');
      assert.strictEqual(tool.status, 'denied');
      assert.match(tool.error, /User denied permission to run command/);
    });

    it('records that nobody made the decision', function () {
      const resolved = lastOf(events, 'permission_resolved');
      assert.strictEqual(resolved.allowed, false);
      assert.strictEqual(resolved.automatic, true);
    });

    it('explains itself in the conversation, naming the call and the way out', function () {
      // "Denied" on a card is not an account of anything: nobody was asked, and
      // the reason lives in how the conversation was started, several screens
      // away.
      const [error] = blocksOf(events, 'error');
      assert.ok(error, 'a refusal must be explained where the user is reading');
      assert.match(error.text, /pwd/);
      assert.match(error.text, /cannot stop and ask/);
      assert.match(error.text, /approvals bypassed/i);
      assert.strictEqual(error.fatal, false);
    });
  });

  describe('work handed to an agent of its own', function () {
    let events;

    before(function () {
      events = driveFixture('antigravity-subagent.jsonl').events;
    });

    it('lands where every other runtime\'s delegated work lands', function () {
      const activity = collectAgentActivity(transcriptOf(events).messages);
      assert.strictEqual(activity.length, 1);
      assert.strictEqual(activity[0].kind, 'agent');
      assert.strictEqual(activity[0].status, 'completed');
    });

    it('carries what the subagent was asked to do', function () {
      const [tool] = blocksOf(events, 'tool');
      assert.strictEqual(tool.name, 'subagent');
      assert.strictEqual(tool.title, 'Pineapple Responder');
      assert.strictEqual(tool.agent.prompt, 'reply with just the word pineapple');
      assert.strictEqual(tool.agent.subagentType, 'research');
    });
  });

  describe('a run agy refused before it started', function () {
    it('puts its own sentence in the conversation', function () {
      const events = [];
      const adapter = new AntigravityChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: (event) => events.push({ ...event, seq: events.length + 1, ts: 1 }),
      });
      adapter.currentTurnId = 'turn-1';
      adapter.turnInFlight = true;
      // Verbatim from `agy --model zzz`: the reply is a `result` with an error
      // and no conversation at all.
      adapter.handleMessage({
        event: 'result',
        result: {
          conversation_id: '',
          status: 'ERROR',
          response: '',
          error: 'invalid model selection (--model "zzz"): model zzz is not recognized',
          duration_seconds: 0,
          num_turns: 0,
          usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        },
      });

      const [error] = blocksOf(events, 'error');
      assert.match(error.text, /model zzz is not recognized/);
      assert.strictEqual(lastOf(events, 'turn_end').stopReason, 'failed');
      assert.strictEqual(lastOf(events, 'state').state, 'idle');
    });
  });

  describe('the effort control', function () {
    function adapterWith(model, models) {
      const events = [];
      const adapter = new AntigravityChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'agy',
        model,
        emit: (event) => events.push(event),
      });
      adapter.modelList = models.map((value) => ({ value, name: value }));
      adapter.publishEfforts();
      return { adapter, events };
    }

    const LISTED = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'chat', 'antigravity-models.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    it('offers the levels agy printed a model for, and no others', function () {
      // agy publishes the level *inside* the model id — gemini-3.6-flash-high,
      // -medium, -low are three entries in its own list — so every level offered
      // is one it named.
      const { adapter, events } = adapterWith('gemini-3.6-flash-high', LISTED);
      assert.deepStrictEqual(
        adapter.capabilities.efforts.map((level) => level.value),
        ['low', 'medium', 'high'],
      );
      assert.strictEqual(events.filter((e) => e.t === 'effort').pop().effort, 'high');
    });

    it('does not offer a level for a model agy printed no sibling for', function () {
      // gemini-3.1-pro comes in high and low only; there is no -medium id.
      const { adapter } = adapterWith('gemini-3.1-pro-high', LISTED);
      assert.deepStrictEqual(
        adapter.capabilities.efforts.map((level) => level.value),
        ['low', 'high'],
      );
    });

    it('says nothing at all for a model that has no level in its name', function () {
      // agy's own words for this case: "--effort is not supported for model".
      const { adapter, events } = adapterWith('claude-sonnet-4-6', LISTED);
      assert.strictEqual(adapter.capabilities.efforts, undefined);
      assert.strictEqual(events.filter((e) => e.t === 'effort').pop().effort, null);
    });

    it('switches level by switching to the model agy named for it', function () {
      const { adapter, events } = adapterWith('gemini-3.6-flash-high', LISTED);
      return adapter.setEffort('low').then(() => {
        assert.strictEqual(adapter.model, 'gemini-3.6-flash-low');
        assert.ok(adapter.buildArgs().includes('gemini-3.6-flash-low'));
        assert.strictEqual(events.filter((e) => e.t === 'effort').pop().effort, 'low');
      });
    });

    it('refuses a level agy has no model for, rather than promising one', function () {
      const { adapter } = adapterWith('gemini-3.1-pro-high', LISTED);
      return adapter.setEffort('medium').then(
        () => assert.fail('a level with no model behind it must be refused'),
        (error) => assert.match(error.message, /no "medium" level/),
      );
    });

    it('uses the flag itself when no model is pinned, which is the only case agy allows', function () {
      const { adapter } = adapterWith(undefined, LISTED);
      assert.deepStrictEqual(
        adapter.capabilities.efforts.map((level) => level.value),
        ['low', 'medium', 'high'],
      );
      return adapter.setEffort('medium').then(() => {
        const args = adapter.buildArgs();
        assert.strictEqual(args[args.indexOf('--effort') + 1], 'medium');
      });
    });

    it('takes the ladder away when the model moves to one that has none', function () {
      const { adapter, events } = adapterWith('gemini-3.6-flash-high', LISTED);
      return adapter.setModel('claude-sonnet-4-6').then(() => {
        assert.strictEqual(adapter.capabilities.efforts, undefined);
        const patch = events.filter((e) => e.t === 'capabilities').pop();
        assert.strictEqual(patch.capabilities.efforts, undefined);
      });
    });
  });

  describe('the model picker', function () {
    afterEach(function () {
      resetInstalledModels();
    });

    it('offers exactly what `agy models` printed', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-agy-'));
      try {
        const listing = fs.readFileSync(
          path.join(__dirname, 'fixtures', 'chat', 'antigravity-models.txt'),
          'utf8',
        );
        const fake = path.join(dir, 'agy');
        fs.writeFileSync(fake, `#!/bin/sh\ncat <<'EOF'\n${listing}EOF\n`, { mode: 0o755 });

        const models = await installedModels('antigravity', fake);
        assert.deepStrictEqual(models.slice(0, 3).map((model) => model.value), [
          'gemini-3.6-flash-high',
          'gemini-3.6-flash-medium',
          'gemini-3.6-flash-low',
        ]);
        assert.ok(models.some((model) => model.value === 'claude-opus-4-6-thinking'));
        // No description is invented: agy prints ids bare and says nothing about
        // which one is the default.
        assert.ok(models.every((model) => model.description === undefined));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('answers nothing rather than failing when the binary is not there', async function () {
      assert.deepStrictEqual(await installedModels('antigravity', '/nonexistent/agy'), []);
    });

    it('does not hand the probe an open stdin to wait on', async function () {
      // The defect this exists for: `agy models` blocks forever on an open stdin
      // pipe. Measured against the real binary — no output and no exit until the
      // eight-second timeout killed it, against 2.0s and the full list with
      // stdin closed. The picker said "this runtime hasn't listed models" about
      // a runtime that lists eleven, and said it eight seconds late.
      //
      // The stand-in reproduces exactly that: it reads stdin to end-of-file
      // before printing, so it answers instantly with stdin closed and never
      // with stdin piped.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-agy-stdin-'));
      try {
        const fake = path.join(dir, 'agy');
        fs.writeFileSync(fake, '#!/bin/sh\ncat > /dev/null\necho gemini-3.6-flash-low\n', { mode: 0o755 });
        const started = Date.now();
        const models = await installedModels('antigravity', fake);
        assert.deepStrictEqual(models.map((model) => model.value), ['gemini-3.6-flash-low']);
        // Well inside the 8s timeout: a hang would only be distinguishable from
        // a slow answer by how long it took.
        assert.ok(Date.now() - started < 4000, `the probe took ${Date.now() - started}ms`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('what the app says it can do', function () {
    it('is offered as a chat, and the two lists agree it is', function () {
      assert.ok(isChatRuntime('antigravity'));
      assert.ok(supportsChat('antigravity'));
    });

    it('promises no approval channel, because headless agy has none', function () {
      // It cannot stop and ask: anything needing approval is denied on the spot
      // and the run continues around it. A deny button here would do nothing.
      assert.strictEqual(advertisedChatCapabilities('antigravity').permissions, false);
      const adapter = createChatAdapter('antigravity', {
        sessionId: 'chat-1',
        workingDir: '/work',
        command: 'agy',
        emit() {},
      });
      assert.strictEqual(adapter.capabilities.permissions, false);
      assert.strictEqual(adapter.capabilities.questions, undefined);
    });

    it('promises no diffs, because no event carries one', function () {
      // replace_file_content reports its TargetFile and nothing else — no old
      // text, no new text, no hunk. A diff shown here would be one this app went
      // and computed.
      assert.strictEqual(advertisedChatCapabilities('antigravity').diffs, false);
    });

    it('promises no cost, because nothing anywhere prices a turn', function () {
      assert.strictEqual(advertisedChatCapabilities('antigravity').cost, false);
    });
  });
});
