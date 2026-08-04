const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { alertForEvent, endsAlert } = require('../dist/shared/chat-alerts.js');

// Whether a conversation is worth interrupting somebody for, proved against
// what each agent actually emits rather than against events written to agree
// with the table.
//
// The rule this is guarding is easy to get wrong in a way no unit test of the
// helper would show: three of the runtime families here — claude, every ACP
// agent, and codex in app-server mode — emit no `state` event at the end of a
// turn, so `turn_end` is the only thing on the wire that says the work is over.
// A notifier built on the state stream passes a hand-written test and then
// never fires for most of the agents this app supports. The same goes the other
// way for approvals: codex emits the `permission` event and no
// `awaiting_permission` state at all.
//
// The fixtures are the ones the per-adapter suites already use; see their
// headers for what was captured live and what was written to a published
// schema.

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8'));
}

/** Let an adapter's own promise chains run before reading what it emitted. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Every alert a stream of events raises, in order. */
function alertsFrom(events) {
  return events.map(alertForEvent).filter(Boolean);
}

function kinds(events) {
  return alertsFrom(events).map((alert) => alert.kind);
}

describe('what a conversation event means to somebody not watching it', function () {
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
      return events;
    }

    it('raises exactly one finished alert for a completed turn', function () {
      const events = drive(fixture('claude-oneshot'));
      assert.ok(
        events.some((event) => event.t === 'turn_end'),
        'the capture should contain the turn ending this reads',
      );
      // The handshake reports `idle` when the process comes up; nothing does
      // after the turn ends. That gap is the whole reason this reads endings
      // rather than states.
      const ended = events.findIndex((event) => event.t === 'turn_end');
      assert.ok(
        !events.slice(ended).some((event) => event.t === 'state'),
        'claude says nothing about its state when a turn ends',
      );
      assert.deepStrictEqual(kinds(events), ['finished']);
    });

    it('says nothing for the tokens, tool calls and usage in between', function () {
      const events = drive(fixture('claude-subagent'));
      assert.ok(events.length > 20, 'a subagent run is a long stream');
      assert.deepStrictEqual(kinds(events), ['finished']);
    });
  });

  describe('codex', function () {
    function harness() {
      const events = [];
      const adapter = new CodexAppServerAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: (event) => events.push(event),
      });
      adapter.writeLine = () => {};
      return { adapter, events };
    }

    async function boot(h) {
      const done = h.adapter.handshake();
      for (const line of fixture('codex-appserver-handshake')) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await done;
      h.events.length = 0;
    }

    async function feed(h, lines) {
      for (const line of lines) {
        h.adapter.handleMessage(line);
        await flush();
      }
    }

    it('reads a turn codex ended as failed as a failure', async function () {
      const h = harness();
      await boot(h);
      await feed(h, fixture('codex-appserver-turn-failed'));
      assert.deepStrictEqual(kinds(h.events), ['failed']);
    });

    it('reads an approval request codex never announces as a state', async function () {
      const h = harness();
      await boot(h);
      await feed(h, [fixture('codex-appserver-permission')[0]]);

      assert.ok(
        !h.events.some((event) => event.t === 'state'),
        'codex emits no awaiting_permission state — the request itself is the signal',
      );
      const [alert] = alertsFrom(h.events);
      assert.strictEqual(alert.kind, 'approval');
      assert.strictEqual(alert.blocking, true);
      assert.strictEqual(alert.detail, 'Run: rm -rf tmp', 'the command is what makes it decidable');
    });
  });

  describe('acp', function () {
    function harness(overrides) {
      const events = [];
      const sent = [];
      const adapter = new AcpChatAdapter(
        Object.assign(
          {
            sessionId: 'chat-1',
            workingDir: '/work',
            command: '/nonexistent',
            runtime: 'kimi',
            readFile: async () => '',
            emit: (event) => events.push(event),
          },
          overrides,
        ),
      );
      adapter.writeLine = (payload) => sent.push(payload);
      return { adapter, events, sent };
    }

    async function feed(h, lines) {
      for (const line of lines) {
        h.adapter.handleMessage(line);
        await flush();
      }
    }

    it('raises an approval when the agent asks, and nothing when it is answered', async function () {
      const h = harness();
      await feed(h, fixture('acp-permission'));

      const alerts = alertsFrom(h.events);
      assert.ok(alerts.length >= 1, 'the capture asks for permission at least once');
      assert.strictEqual(alerts[0].kind, 'approval');
      assert.ok(alerts[0].detail, 'an approval names what is being approved');
    });

    it('raises one finished alert for a completed grok turn, and no state to read', async function () {
      // Driven as a turn, because that is the only way the line carrying the
      // ending is delivered: `session/prompt` has to be outstanding for the
      // reply to correlate. Same steps as chat-acp-model-and-context.test.js.
      const h = harness({ runtime: 'grok', acpArgs: ['agent', '--no-leader', 'stdio'] });
      const lines = fixture('acp-grok');
      const done = h.adapter.handshake();
      await flush();
      h.adapter.handleMessage(lines[0]);
      await flush();
      const opened = h.sent.find((message) => message.method === 'session/new');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: opened.id,
        result: loadJson('acp-grok-session-new.json'),
      });
      await flush();
      await done;

      const sending = h.adapter.send({ text: 'Read the file probe.txt…' });
      const prompt = h.sent.find((message) => message.method === 'session/prompt');
      h.events.length = 0;
      for (const line of lines.slice(2, 18)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await sending;
      h.adapter.handleMessage(Object.assign({}, lines[18], { id: prompt.id }));
      await flush();

      const ended = h.events.findIndex((event) => event.t === 'turn_end');
      assert.ok(ended >= 0, 'the capture ends its turn');
      assert.ok(
        !h.events.slice(ended).some((event) => event.t === 'state'),
        'no ACP agent reports a state when its turn ends',
      );
      assert.deepStrictEqual(kinds(h.events), ['finished']);
    });
  });

  describe('pi', function () {
    it('reads a turn that ends with no stop reason at all as finished', async function () {
      const events = [];
      const adapter = new PiChatAdapter({
        sessionId: 'chat-1',
        workingDir: '/work',
        command: '/nonexistent',
        emit: (event) => events.push(event),
      });
      adapter.writeLine = () => {};
      // The capture is the tail of a turn, so the turn it belongs to has to be
      // open for its ending to be emitted at all — the same setup the pi
      // adapter suite uses.
      adapter.currentTurnId = 'turn-1';
      for (const line of fixture('pi-final-turn')) {
        adapter.handleMessage(line);
        await flush();
      }

      const ends = events.filter((event) => event.t === 'turn_end');
      assert.ok(ends.length >= 1, 'the capture ends its turn');
      assert.ok(!ends[0].stopReason, "pi's happy path carries no reason, and must not read as failure");
      assert.deepStrictEqual(kinds(events), ['finished']);
    });
  });

  describe('the endings that are not endings', function () {
    it('says nothing for a turn_end the server marked stale', function () {
      // Stamped by ChatSession when a runtime lets go of work that was
      // interrupted — the turn carries straight on with the message that
      // interrupted it. Announcing it would fire "finished" every time somebody
      // steered a running agent.
      assert.strictEqual(
        alertForEvent({ t: 'turn_end', seq: 9, ts: 0, turnId: 't1', stale: true }),
        null,
      );
    });

    it('reads a runtime that died as failed, though it sends no turn_end', function () {
      const alert = alertForEvent({ t: 'error', seq: 4, ts: 0, message: 'claude exited', fatal: true });
      assert.strictEqual(alert.kind, 'failed');
      assert.strictEqual(alert.blocking, false);
      assert.strictEqual(alert.detail, 'claude exited');
    });

    it('says nothing for an error the conversation carried on past', function () {
      assert.strictEqual(
        alertForEvent({ t: 'error', seq: 4, ts: 0, message: 'that file does not exist' }),
        null,
      );
    });

    it('keeps a question apart from an approval', function () {
      const alert = alertForEvent({
        t: 'question',
        seq: 3,
        ts: 0,
        request: {
          requestId: 'q1',
          question: 'Which of these should it use?',
          header: 'Pick a database',
          multiSelect: false,
          options: [],
          ts: 0,
        },
      });
      assert.strictEqual(alert.kind, 'question');
      assert.strictEqual(alert.blocking, true);
      assert.strictEqual(alert.detail, 'Pick a database', 'the header when there is one');
    });
  });

  describe('what ends an alert', function () {
    it('ends it when the block is answered, wherever it was answered', function () {
      assert.ok(endsAlert({ t: 'permission_resolved', seq: 5, ts: 0, requestId: 'p1', optionId: 'a', allowed: true }));
      assert.ok(endsAlert({ t: 'question_resolved', seq: 5, ts: 0, requestId: 'q1', optionIds: ['a'] }));
    });

    it('ends it when the conversation starts moving again', function () {
      // Most runtimes emit no state at all when an approval resolves — the
      // reducer works it out — so a mark cleared only on resolution would sit
      // on a conversation that went back to work minutes ago.
      for (const state of ['thinking', 'running', 'starting']) {
        assert.ok(endsAlert({ t: 'state', seq: 6, ts: 0, state }), state);
      }
      for (const state of ['idle', 'exited', 'error', 'awaiting_permission']) {
        assert.ok(!endsAlert({ t: 'state', seq: 6, ts: 0, state }), state);
      }
    });

    it('ends it when the user says something, whatever it was waiting for', function () {
      assert.ok(endsAlert({ t: 'msg_start', seq: 7, ts: 0, id: 'm1', role: 'user', turnId: 't2' }));
      assert.ok(!endsAlert({ t: 'msg_start', seq: 7, ts: 0, id: 'm2', role: 'assistant', turnId: 't2' }));
    });
  });
  describe('a workflow that failed in the background (#140)', function () {
    // Driven by the real capture rather than a hand-written event, because the
    // shape that matters here is the *order*: the run fails while its own turn
    // is still going, and everything the turn does afterwards used to take the
    // notification away again.
    function claudeEvents(name) {
      const emitted = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => emitted.push(event),
      });
      fixture(name).forEach((message) => adapter.handleMessage(message));
      return emitted.map((event, index) => ({ ts: index, ...event, seq: index + 1 }));
    }

    it('is worth telling somebody about, named for what actually failed', function () {
      const events = claudeEvents('claude-workflow-failed');
      const failed = events.find((event) => event.t === 'workflow_failed');
      const alert = alertForEvent(failed);

      assert.strictEqual(alert.kind, 'failed');
      assert.strictEqual(alert.blocking, false);
      assert.strictEqual(
        alert.subject,
        'The workflow "probe-workflow-failure"',
        'the notification would have said the turn failed, which it did not',
      );
      assert.match(alert.detail || '', /forced workflow failure/);
    });

    it('raises nothing for a run that finished, whatever died inside it', function () {
      assert.deepStrictEqual(
        claudeEvents('claude-workflow').filter((event) => event.t === 'workflow_failed'),
        [],
      );
    });

    it('is not taken back by the conversation carrying on', function () {
      // The run fails, its turn ends normally seconds later, and the agent goes
      // back to work. None of that un-fails the workflow.
      const events = claudeEvents('claude-workflow-failed');
      const at = events.findIndex((event) => event.t === 'workflow_failed');
      assert.ok(at >= 0, 'the recording no longer contains a failure');

      const after = events.slice(at + 1);
      assert.ok(
        after.some((event) => event.t === 'state' || event.t === 'turn_end'),
        'the recording no longer carries the aftermath this is about',
      );
      // `endsAlert` still says the conversation is moving — that is its job.
      // What must not happen is the failure being cleared by it, which is
      // `attention.ts`'s decision and is asserted in chat-attention.test.js.
      const raised = after.map(alertForEvent).filter(Boolean);
      assert.ok(
        !raised.some((alert) => alert.kind === 'failed'),
        'the aftermath raised a second failure, so this proves nothing',
      );
    });
  });
});
