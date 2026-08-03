const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');

/**
 * Issue #129: one prompt, one bubble.
 *
 * Sending a single message from the composer put two identical user turns in
 * the transcript. The client was never involved — there is one `submit()`, one
 * `chat_send` frame, and nothing optimistic anywhere in it. Both copies were
 * written by the server: `ChatSession.deliver` writes the user's message,
 * because it is the same in every protocol, and then every ACP runtime (Oh My
 * Pi, Kimi, Grok, opencode) and both codex modes wrote it *again* from inside
 * their own `send`, under a turn id of their own. The reducer folds anything
 * arriving inside an open turn into that turn, so the two landed side by side.
 *
 * Three claims, in the three places they can be broken:
 *
 *  1. the adapter no longer writes one — driven through the real adapter on a
 *     real capture, not a hand-made event stream;
 *  2. the session refuses one if an adapter ever writes one again;
 *  3. a conversation recorded *before* the fix stops drawing the second bubble
 *     when it is reopened, because the logs already on disk still hold both.
 *
 * Claude and pi never did this — claude's `handleUserEcho` emits only tool
 * results, and pi skips its own echo explicitly — which is why the report came
 * from an Oh My Pi conversation.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'chat');

function fixture(name) {
  return fs
    .readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** The real ACP adapter, with the pipe replaced and nothing else. */
function harness(runtime = 'omp') {
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
  adapter.writeLine = (line) => sent.push(line);
  return { adapter, events, sent };
}

/**
 * The three events `ChatSession.deliver` writes for a prompt.
 *
 * Spelled out rather than driven through a session, because what is being
 * measured here is what happens when they meet the adapter's output. The id
 * shape matters — it is what tells the reducer this app minted the message.
 */
function askedByTheSession(text, turnId = 'turn-11111111-2222-3333-4444-555555555555') {
  const id = 'user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  return [
    { t: 'msg_start', id, role: 'user', turnId },
    { t: 'block_start', msgId: id, index: 0, block: { kind: 'text', text } },
    { t: 'msg_end', msgId: id },
  ];
}

function fold(events) {
  const state = createTranscript({});
  events.forEach((event, index) => applyChatEvent(state, { ts: index + 1, ...event, seq: index + 1 }));
  return state;
}

function textOf(message) {
  return message.blocks
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('');
}

describe('one prompt makes one user turn (#129)', function () {
  describe('the adapter', function () {
    it('writes no user message of its own, on a real Oh My Pi conversation', async function () {
      const h = harness();
      const lines = fixture('acp-omp');
      const done = h.adapter.handshake();
      for (const line of lines.slice(0, 2)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await done;

      const prompt = 'What is the magic word?';
      h.events.length = 0;
      const sending = h.adapter.send({ text: prompt });
      for (const line of lines.slice(2)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await sending;

      const state = fold([...askedByTheSession(prompt), ...h.events]);
      const users = state.messages.filter((message) => message.role === 'user');
      assert.strictEqual(
        users.length,
        1,
        `one prompt should be one user message, got ${users.length}: ${users.map((m) => JSON.stringify(textOf(m))).join(', ')}`,
      );
      assert.strictEqual(textOf(users[0]), prompt, 'and it is the prompt that was typed');

      // The other half of the complaint: both copies landed in the same turn,
      // which is what made them read as a doubled message rather than as two
      // requests. Whatever else the turn holds, it holds one ask.
      const byTurn = new Map();
      for (const message of state.messages) {
        if (message.role !== 'user') continue;
        byTurn.set(message.turnId, (byTurn.get(message.turnId) || 0) + 1);
      }
      assert.deepStrictEqual(
        [...byTurn.values()].filter((count) => count > 1),
        [],
        'no turn may hold two user messages',
      );
    });

    it('does not put a branch briefing in the transcript as something the user said', async function () {
      // A branched conversation hands the adapter `${carried}\n\n${text}` — the
      // whole summary of what came before, glued in front of the prompt. That
      // is context for the agent, and the echo used to file all of it as the
      // user's own words.
      const h = harness();
      const lines = fixture('acp-omp');
      const done = h.adapter.handshake();
      for (const line of lines.slice(0, 2)) {
        h.adapter.handleMessage(line);
        await flush();
      }
      await done;

      const briefing = 'Here is everything that was said in the conversation this was branched from.';
      const prompt = 'carry on from there';
      h.events.length = 0;
      const sending = h.adapter.send({ text: `${briefing}\n\n${prompt}` });

      const state = fold([...askedByTheSession(prompt), ...h.events]);
      assert.ok(
        !state.messages.some((message) => textOf(message).includes(briefing)),
        'the briefing is context for the agent, not a thing the user typed',
      );
      const promptCall = h.sent.find((message) => message.method === 'session/prompt');
      h.adapter.handleMessage({
        jsonrpc: '2.0',
        id: promptCall.id,
        result: { stopReason: 'end_turn' },
      });
      await sending;
    });
  });

  describe('the session', function () {
    function memoryStore() {
      const events = [];
      return {
        events,
        append(_ref, batch) {
          events.push(...batch);
        },
        async stat() {
          return { firstSeq: 1, cursor: events.length };
        },
        async read() {
          return { events: [], firstSeq: 1, from: 1, cursor: events.length };
        },
        async snapshot() {
          return {
            sessionId: 's1', runtime: 'omp', messages: [], state: 'idle',
            capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
            cursor: events.length, live: true, bypassPermissions: false,
          };
        },
      };
    }

    /** An adapter that does exactly what every ACP adapter used to do. */
    function echoingAdapter() {
      return {
        runtime: 'omp',
        capabilities: { permissions: false, streaming: true, interrupt: true },
        alive: true,
        emit: null,
        async start() {},
        async send(turn) {
          this.emit({ t: 'msg_start', id: 'omp-user-2', role: 'user', turnId: 'omp-turn-1' });
          this.emit({ t: 'block_start', msgId: 'omp-user-2', index: 0, block: { kind: 'text', text: turn.text } });
          this.emit({ t: 'msg_end', msgId: 'omp-user-2' });
          this.emit({ t: 'state', state: 'thinking' });
        },
        async interrupt() {},
        respondPermission() {},
        async stop() {
          this.alive = false;
        },
      };
    }

    it('refuses a user message it did not write itself', async function () {
      const store = memoryStore();
      const session = new ChatSession(
        { id: 's1', ownerUserId: 7 },
        {
          store,
          socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'echo-')),
          hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
          broadcast: () => {},
          resolveCommand: () => 'omp',
        },
      );
      const adapter = echoingAdapter();
      // The session hands its adapter an `emit`; this stands in for that wiring
      // so the fake can push events back the way a real adapter does.
      adapter.emit = (event) => session.ingest(event);
      session.adapter = adapter;
      session.state = 'idle';

      await session.send({ text: 'the only prompt' });

      const users = store.events.filter((event) => event.t === 'msg_start' && event.role === 'user');
      assert.strictEqual(
        users.length,
        1,
        `the log should hold one user message, got ${users.length}: ${users.map((event) => event.id).join(', ')}`,
      );
      assert.ok(users[0].id.startsWith('user-'), 'and it is the one the session minted');

      // And no orphans: the blocks and the end of a message that was never
      // opened would be events pointing at nothing.
      const orphans = store.events.filter(
        (event) => (event.t === 'block_start' || event.t === 'msg_end') && event.msgId === 'omp-user-2',
      );
      assert.deepStrictEqual(orphans, [], 'the dropped message must take its own blocks with it');
    });
  });

  describe('a conversation recorded before the fix', function () {
    // Exactly what the logs on disk hold, and there are twelve of them on the
    // machine this was written on: the session's message, then the runtime's
    // copy of it under a turn id of its own, then the answer.
    const recorded = [
      ...askedByTheSession('fai partire l’applicazione'),
      { t: 'msg_start', id: 'omp-user-2', role: 'user', turnId: 'omp-turn-1' },
      { t: 'block_start', msgId: 'omp-user-2', index: 0, block: { kind: 'text', text: 'fai partire l’applicazione' } },
      { t: 'msg_end', msgId: 'omp-user-2' },
      { t: 'msg_start', id: 'omp-assistant-3', role: 'assistant', turnId: 'omp-turn-1' },
      { t: 'block_start', msgId: 'omp-assistant-3', index: 0, block: { kind: 'text', text: 'on it' } },
      { t: 'msg_end', msgId: 'omp-assistant-3' },
      { t: 'turn_end', turnId: 'omp-turn-1', stopReason: 'end_turn' },
    ];

    it('draws one bubble when it is reopened, without being rewritten', function () {
      const state = fold(recorded);
      assert.deepStrictEqual(
        state.messages.map((message) => message.id),
        ['user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'omp-assistant-3'],
        'the echo is folded away at the point it is read, not migrated out of the file',
      );
    });

    it('leaves a genuinely repeated prompt alone', function () {
      // The same words twice is a thing people do. What makes the echo an echo
      // is not that it repeats — it is that this app did not write it.
      const twice = [
        ...askedByTheSession('again', 'turn-11111111-2222-3333-4444-555555555555'),
        { t: 'turn_end', turnId: 'turn-11111111-2222-3333-4444-555555555555', stopReason: 'end_turn' },
        { t: 'msg_start', id: 'user-99999999-8888-7777-6666-555555555555', role: 'user', turnId: 'turn-99999999-8888-7777-6666-555555555555' },
        { t: 'block_start', msgId: 'user-99999999-8888-7777-6666-555555555555', index: 0, block: { kind: 'text', text: 'again' } },
        { t: 'msg_end', msgId: 'user-99999999-8888-7777-6666-555555555555' },
      ];
      assert.strictEqual(
        fold(twice).messages.filter((message) => message.role === 'user').length,
        2,
        'two real prompts are two messages, however identical their text',
      );
    });

    it('retains app-owned workflow intent without changing the visible prompt', function () {
      const events = askedByTheSession('Describe the issue.');
      events[0].workflow = 'gh-issue';
      const state = fold(events);

      assert.strictEqual(state.messages[0].workflow, 'gh-issue');
      assert.strictEqual(textOf(state.messages[0]), 'Describe the issue.');
    });
  });
});
