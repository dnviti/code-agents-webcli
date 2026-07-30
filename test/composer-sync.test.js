const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// The message you are in the middle of writing is a fact about the person
// writing it, not about the window it happens to be typed into (#163).
//
// Everything else about a conversation already reaches every screen an account
// has open — the transcript, the queue, the model, whether the agent is working.
// The composer did not: a prompt started on a laptop left the phone offering an
// empty box, and a screenshot dropped on one of them was invisible on the other.
// These check both halves — the server carrying it between screens, and the
// browser knowing which arriving composer is its own echo and which is somebody
// else's typing.

const ROOT = path.join(__dirname, '..');

const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { readDraft, applyDraft, clearDraft, MAX_DRAFT_TEXT_BYTES } = require('../dist/server/chat/drafts.js');

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

function sessionRecord(over = {}) {
  return {
    id: over.id || 'chat-1',
    ownerUserId: over.ownerUserId ?? 7,
    name: 'Session',
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: 'claude',
    runtimeLabel: null,
    surface: over.surface === undefined ? 'chat' : over.surface,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/tmp/project',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

/** A socket that records what it was sent. `watching` is what it subscribed to. */
function socket(id, userId, watching = []) {
  const sent = [];
  return {
    id,
    userId,
    githubLogin: 'tester',
    claudeSessionId: null,
    chatSessionIds: new Set(watching),
    created: new Date(),
    sent,
    ws: {
      readyState: WebSocket.OPEN,
      send: (payload) => sent.push(JSON.parse(payload)),
    },
  };
}

const typed = (info, type) => info.sent.filter((message) => message.type === type);

function build(infos, records, managerOverrides = {}) {
  const sends = [];
  const chatManager = {
    has: () => true,
    async start() {
      return { runtimeKind: 'claude', currentCapabilities: {} };
    },
    async snapshot(record) {
      return {
        sessionId: record.id,
        runtime: 'claude',
        messages: [],
        state: 'idle',
        capabilities: {},
        pendingPermissions: [],
        firstSeq: 1,
        replayFrom: 1,
        cursor: 0,
        live: true,
        bypassPermissions: false,
      };
    },
    async send(sessionId, turn) {
      sends.push({ sessionId, turn });
    },
    rememberModel() {},
    rememberEffort() {},
    async setModel() {
      return false;
    },
    async setEffort() {
      return false;
    },
    async interrupt() {},
    async stop() {},
    ...managerOverrides,
  };

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: new Map(records.map((entry) => [entry.id, entry])),
    webSocketConnections: new Map(infos.map((info) => [info.id, info])),
    baseFolder: '/tmp',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude', codex: 'Codex' },
    validatePath: () => ({ valid: true, path: '/tmp' }),
    getSelectedWorkingDir: () => '/tmp',
    createSessionRecord: (params) => sessionRecord(params),
    getRuntimeBridge: () => null,
    saveSessionsToDisk: () => Promise.resolve(),
    resolveRuntimeProfile: () => null,
    chatManager,
    transcriptStore: {
      appendOutput() {},
      ensureTranscript: () => Promise.resolve(),
      readTranscriptChunks: () => Promise.resolve([]),
    },
    historyStore: {
      append() {},
      stat: () => Promise.resolve({ firstLine: 0, totalLines: 0 }),
      read: () => Promise.resolve({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }),
    },
    getUserPreferences: () => ({ chatBypassPermissions: false }),
    usageReader: {},
    usageAnalytics: {},
  });

  return { processor, sends, chatManager };
}

const draftOf = (message) => message.draft;

/** Where this conversation's own uploads are served from; see chat-attachments.ts. */
const PREFIX = '/api/sessions/chat-1/chat-attachments/';

describe('carrying an unsent message between somebody’s screens', function () {
  it('puts what one screen is typing on every other screen watching that conversation', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    const { processor } = build([laptop, phone], [sessionRecord()]);

    await processor.handleMessage('w1', {
      type: 'chat_draft',
      sessionId: 'chat-1',
      text: 'summarise the release notes',
      attachments: [],
    });

    const arrived = typed(phone, 'chat_draft');
    assert.strictEqual(arrived.length, 1, 'the other screen was never told');
    assert.strictEqual(draftOf(arrived[0]).text, 'summarise the release notes');
    assert.strictEqual(draftOf(arrived[0]).revision, 1);
    assert.strictEqual(arrived[0].sessionId, 'chat-1');
  });

  it('names the screen it came from, so that one is not typed over by its own echo', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const { processor } = build([laptop], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'hello', attachments: [] });

    const [echo] = typed(laptop, 'chat_draft');
    assert.ok(echo, 'the screen that typed it must still be told which revision it was given');
    assert.strictEqual(echo.origin, 'w1');
  });

  it('says nothing to somebody else’s screens', async function () {
    const mine = socket('w1', 7, ['chat-1']);
    const stranger = socket('w2', 8, ['chat-1']);
    const { processor } = build([mine, stranger], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'private', attachments: [] });

    assert.deepStrictEqual(typed(stranger, 'chat_draft'), []);
  });

  it('says nothing to a screen of mine that is not watching this conversation', async function () {
    const here = socket('w1', 7, ['chat-1']);
    const elsewhere = socket('w2', 7, ['chat-2']);
    const { processor } = build([here, elsewhere], [sessionRecord(), sessionRecord({ id: 'chat-2' })]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'hello', attachments: [] });

    assert.deepStrictEqual(typed(elsewhere, 'chat_draft'), []);
  });

  it('refuses a conversation this socket never asked to watch', async function () {
    const nosy = socket('w1', 7, []);
    const watcher = socket('w2', 7, ['chat-1']);
    const { processor } = build([nosy, watcher], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'hello', attachments: [] });

    assert.deepStrictEqual(typed(watcher, 'chat_draft'), []);
  });

  it('refuses a conversation somebody else owns', async function () {
    const stranger = socket('w1', 8, ['chat-1']);
    const owner = socket('w2', 7, ['chat-1']);
    const { processor } = build([stranger, owner], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'hello', attachments: [] });

    assert.deepStrictEqual(typed(owner, 'chat_draft'), []);
  });

  it('leaves a terminal alone: it has no composer to carry', async function () {
    const one = socket('w1', 7, ['chat-1']);
    const two = socket('w2', 7, ['chat-1']);
    const { processor } = build([one, two], [sessionRecord({ surface: 'terminal' })]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'ls -la', attachments: [] });

    assert.deepStrictEqual(typed(two, 'chat_draft'), []);
  });

  it('carries the files on the message, not just the words', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    const { processor } = build([laptop, phone], [sessionRecord()]);

    await processor.handleMessage('w1', {
      type: 'chat_draft',
      sessionId: 'chat-1',
      text: 'what is wrong here',
      attachments: [
        {
          url: `${PREFIX}abc123-shot.png`,
          name: 'shot.png',
          mime: 'image/png',
          size: 4096,
          path: '/tmp/project/.cc-web/attachments/abc123-shot.png',
        },
      ],
    });

    const [arrived] = typed(phone, 'chat_draft');
    assert.strictEqual(draftOf(arrived).attachments.length, 1);
    assert.strictEqual(draftOf(arrived).attachments[0].name, 'shot.png');
    assert.strictEqual(
      draftOf(arrived).attachments[0].url,
      `${PREFIX}abc123-shot.png`,
      'the url is the only thing a second screen can fetch the picture with',
    );
  });

  it('numbers each edit above the last, so a screen can tell new from old', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const { processor } = build([laptop], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'a', attachments: [] });
    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'ab', attachments: [] });
    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'abc', attachments: [] });

    assert.deepStrictEqual(
      typed(laptop, 'chat_draft').map((message) => draftOf(message).revision),
      [1, 2, 3],
    );
  });

  it('hands the composer over on the join, so a screen opens at the sentence in progress', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, []);
    const record = sessionRecord();
    const { processor } = build([laptop, phone], [record]);

    await processor.handleMessage('w1', {
      type: 'chat_draft',
      sessionId: 'chat-1',
      text: 'half a thought',
      attachments: [],
    });
    await processor.handleMessage('w2', { type: 'chat_subscribe', sessionId: 'chat-1' });

    const [snapshot] = typed(phone, 'chat_snapshot');
    assert.ok(snapshot, 'the joining screen got no snapshot at all');
    assert.strictEqual(snapshot.draft.text, 'half a thought');
    assert.strictEqual(snapshot.draft.revision, 1);
  });

  it('reports no composer for a conversation nobody has typed into', async function () {
    const phone = socket('w1', 7, []);
    const { processor } = build([phone], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_subscribe', sessionId: 'chat-1' });

    const [snapshot] = typed(phone, 'chat_snapshot');
    assert.strictEqual(
      snapshot.draft,
      null,
      'null is what tells a browser it may keep the copy it has, rather than being cleared by a server that has not heard',
    );
  });

  it('empties every screen’s composer when the message it held is sent', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    const { processor, sends } = build([laptop, phone], [sessionRecord()]);

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'ask this', attachments: [] });
    await processor.handleMessage('w1', {
      type: 'chat_send',
      sessionId: 'chat-1',
      text: 'ask this',
      attachments: [],
      fromComposer: true,
    });

    assert.strictEqual(sends.length, 1, 'the turn itself must still go');
    const cleared = typed(phone, 'chat_draft').pop();
    assert.strictEqual(cleared.draft.text, '');
    assert.deepStrictEqual(cleared.draft.attachments, []);
    assert.strictEqual(cleared.draft.revision, 2, 'now empty is a newer fact than the text it replaces');
    assert.strictEqual(
      cleared.origin,
      'w1',
      'the screen that sent it emptied its own box a round trip ago and may be typing the next question',
    );
  });

  it('leaves a half-written message alone when a turn is sent again from the transcript', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    const { processor } = build([laptop, phone], [sessionRecord()]);

    await processor.handleMessage('w1', {
      type: 'chat_draft',
      sessionId: 'chat-1',
      text: 'something else entirely',
      attachments: [],
    });
    // What ChatView.retryTurn sends: text taken from the log, composer untouched.
    await processor.handleMessage('w1', {
      type: 'chat_send',
      sessionId: 'chat-1',
      text: 'the turn that failed',
      attachments: [],
    });

    const drafts = typed(phone, 'chat_draft');
    assert.strictEqual(drafts.length, 1, 'retrying a turn must not blank what somebody is writing');
    assert.strictEqual(draftOf(drafts[0]).text, 'something else entirely');
  });

  it('keeps a message typed while a slow send was still running', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { processor } = build([laptop, phone], [sessionRecord()], {
      // What `/clear` costs: the agent's whole process is restarted behind this.
      async send() { await held; },
    });

    await processor.handleMessage('w1', { type: 'chat_draft', sessionId: 'chat-1', text: 'ask this', attachments: [] });
    const sending = processor.handleMessage('w1', {
      type: 'chat_send',
      sessionId: 'chat-1',
      text: 'ask this',
      attachments: [],
      fromComposer: true,
    });
    // Somebody starts the next question on the other screen while it runs.
    await processor.handleMessage('w2', {
      type: 'chat_draft',
      sessionId: 'chat-1',
      text: 'and then this',
      attachments: [],
    });
    release();
    await sending;

    const last = typed(phone, 'chat_draft').pop();
    assert.strictEqual(
      draftOf(last).text,
      'and then this',
      'the send clears the message it sent, not whatever the composer holds when it finally returns',
    );
  });

  it('says nothing when a send empties a composer that was already empty', async function () {
    const laptop = socket('w1', 7, ['chat-1']);
    const phone = socket('w2', 7, ['chat-1']);
    const { processor } = build([laptop, phone], [sessionRecord()]);

    await processor.handleMessage('w1', {
      type: 'chat_send',
      sessionId: 'chat-1',
      text: 'typed and sent in one go',
      attachments: [],
      fromComposer: true,
    });

    assert.deepStrictEqual(typed(phone, 'chat_draft'), []);
  });
});

describe('what a composer will and will not carry', function () {
  it('reads an attachment field by field, and drops what is not one', function () {
    const input = readDraft(
      'look at this',
      [
        { url: `${PREFIX}abc-a.png`, name: 'a.png', mime: 'image/png', size: 10, path: '/tmp/a.png', pretendField: 'x' },
        { name: 'no url' },
        'not an object',
        null,
      ],
      'chat-1',
    );

    assert.strictEqual(input.attachments.length, 1);
    assert.deepStrictEqual(input.attachments[0], {
      url: `${PREFIX}abc-a.png`,
      name: 'a.png',
      mime: 'image/png',
      size: 10,
      path: '/tmp/a.png',
    });
  });

  it('fills in what an attachment did not say rather than carrying undefined', function () {
    const input = readDraft('', [{ url: `${PREFIX}abc-a.bin`, name: 'a.bin' }], 'chat-1');
    assert.strictEqual(input.attachments[0].mime, 'application/octet-stream');
    assert.strictEqual(input.attachments[0].size, 0);
    assert.ok(!('path' in input.attachments[0]), 'a path nobody sent must not be invented');
  });

  it('refuses anything that is not a draft at all', function () {
    assert.strictEqual(readDraft(undefined, [], 'chat-1'), null);
    assert.strictEqual(readDraft(42, [], 'chat-1'), null);
    assert.strictEqual(readDraft({ text: 'nested' }, [], 'chat-1'), null);
  });

  it('takes an empty composer, because being emptied is worth saying', function () {
    const input = readDraft('', undefined, 'chat-1');
    assert.ok(input, 'an empty draft is a real thing to announce');
    assert.deepStrictEqual(input, { text: '', attachments: [] });
  });

  it('refuses more typing than it will carry, and leaves the last one standing', function () {
    const session = sessionRecord();
    applyDraft(session, { text: 'the one that fits', attachments: [] });

    assert.strictEqual(readDraft('x'.repeat(MAX_DRAFT_TEXT_BYTES + 1), [], 'chat-1'), null);
    assert.strictEqual(
      session.chatDraft.text,
      'the one that fits',
      'a refusal must not destroy the composer the screens already agree on',
    );
  });

  it('counts the limit in bytes, not in characters', function () {
    // Four bytes each in UTF-8, so a quarter of the cap is exactly the cap.
    const emoji = '🙂'.repeat(MAX_DRAFT_TEXT_BYTES / 4);
    assert.ok(readDraft(emoji, [], 'chat-1'), 'exactly the cap is allowed');
    assert.strictEqual(readDraft(emoji + '🙂', [], 'chat-1'), null);
  });

  it('refuses an attachment whose fields are longer than any upload could produce', function () {
    const input = readDraft(
      'x',
      [
        { url: `${PREFIX}${'a'.repeat(9000)}`, name: 'huge.png' },
        { url: `${PREFIX}ok.png`, name: 'n'.repeat(9000) },
        { url: `${PREFIX}fine.png`, name: 'fine.png', path: 'p'.repeat(9000) },
      ],
      'chat-1',
    );

    assert.strictEqual(input.attachments.length, 1, 'a name and a url of a megabyte each are not an attachment');
    assert.strictEqual(input.attachments[0].name, 'fine.png');
    assert.ok(!('path' in input.attachments[0]), 'and the field that was too long is simply not carried');
  });

  it('refuses an attachment that belongs to some other address entirely', function () {
    const input = readDraft(
      'x',
      [
        { url: 'https://example.com/beacon.gif', name: 'beacon.gif' },
        { url: '/api/sessions/chat-9/chat-attachments/abc-other.png', name: 'other.png' },
        { url: `${PREFIX}abc-mine.png`, name: 'mine.png' },
      ],
      'chat-1',
    );

    assert.deepStrictEqual(
      input.attachments.map((a) => a.name),
      ['mine.png'],
      'a composer carries this conversation’s own uploads and nothing else',
    );
  });

  it('does not announce an empty composer being emptied again', function () {
    const session = sessionRecord();
    assert.strictEqual(clearDraft(session), null, 'nothing was in it');

    applyDraft(session, { text: '', attachments: [] });
    assert.strictEqual(clearDraft(session), null, 'nothing was in it, whatever its revision');

    applyDraft(session, { text: 'a question', attachments: [] });
    const cleared = clearDraft(session);
    assert.strictEqual(cleared.text, '');
    assert.strictEqual(cleared.revision, 3);
  });
});

// ---------------------------------------------------------------------------
// The browser half
// ---------------------------------------------------------------------------

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
    `export { ChatRegistry } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/registry'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `composer-sync-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'composer-sync.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

function client(over = {}) {
  const sent = [];
  const controller = new mod.ChatController('s1', {
    send: (message) => sent.push(message),
    origin: () => (over.origin === undefined ? 'me' : over.origin),
  });
  if (over.draftSync !== false) controller.setDraftSync(true);
  const seen = [];
  controller.subscribeDraft((draft) => seen.push(draft));
  return { controller, sent, seen };
}

const draftFrames = (sent) => sent.filter((message) => message.type === 'chat_draft');

function snapshot() {
  return {
    sessionId: 's1',
    runtime: 'claude',
    messages: [],
    state: 'idle',
    capabilities: {},
    pendingPermissions: [],
    firstSeq: 1,
    replayFrom: 1,
    cursor: 0,
    live: true,
    bypassPermissions: false,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a browser watching a composer it does not own', function () {
  it('applies what another screen typed', function () {
    const { controller, seen } = client();

    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'from the laptop', attachments: [], revision: 4 },
      origin: 'w9',
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].text, 'from the laptop');
    assert.strictEqual(controller.draftValue.revision, 4);
  });

  it('takes the number of its own edit without taking the text back', function () {
    const { controller, seen } = client();
    controller.publishDraft('hello wor', []);

    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'hello wor', attachments: [], revision: 1 },
      origin: 'me',
    });

    assert.deepStrictEqual(seen, [], 'writing your own keystrokes back drags the caret into the past');
    assert.strictEqual(controller.draftValue.revision, 1, 'the revision still has to be recorded');
  });

  it('ignores a composer older than the one it is already holding', function () {
    const { controller, seen } = client();
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'newer', attachments: [], revision: 6 },
      origin: 'w9',
    });
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'older', attachments: [], revision: 5 },
      origin: 'w9',
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(controller.draftValue.text, 'newer');
  });

  it('does not announce a composer it was just handed', function () {
    const { controller, sent } = client();
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'from the phone', attachments: [], revision: 2 },
      origin: 'w9',
    });

    // What the surface does with it: sets its field, which calls back here.
    controller.publishDraft('from the phone', []);

    assert.deepStrictEqual(draftFrames(sent), [], 'two screens echoing one sentence at each other forever');
  });

  it('treats an arriving composer as somebody else’s when it does not know its own socket', function () {
    const { controller, seen } = client({ origin: null });
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'mine, probably', attachments: [], revision: 1 },
      origin: 'me',
    });

    assert.strictEqual(seen.length, 1, 'a caret put back is a smaller loss than another screen’s typing dropped');
  });

  it('drops what it was about to say when another screen says something else', async function () {
    const { controller, sent, seen } = client();
    controller.publishDraft('mine', []);      // goes at once
    controller.publishDraft('mine, longer', []); // waits for the interval

    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'theirs', attachments: [], revision: 2 },
      origin: 'w9',
    });

    await wait(400);
    assert.deepStrictEqual(
      draftFrames(sent).map((f) => f.text),
      ['mine'],
      'a frame queued behind the rate limit would overwrite the other screen a moment after adopting it, and leave the two showing different things forever',
    );
    assert.strictEqual(seen.pop().text, 'theirs');
  });

  it('answers for the message type it handles even when the payload is missing', function () {
    const { controller } = client();
    assert.strictEqual(controller.handle({ type: 'chat_draft', sessionId: 's1' }), true);
  });

  it('is on the list the router filters by', function () {
    assert.ok(
      mod.ChatController.MESSAGE_TYPES.has('chat_draft'),
      'a type missing from this set is handed to the terminal and discarded in silence',
    );
  });
});

describe('a browser typing into a shared composer', function () {
  it('says nothing at all to a server that does not carry composers', function () {
    const { controller, sent } = client({ draftSync: false });
    controller.publishDraft('hello', []);
    assert.deepStrictEqual(draftFrames(sent), [], 'an older server answers an unknown message with an error toast');
  });

  it('turns the feature on when the handshake advertises it', function () {
    const sent = [];
    const registry = new mod.ChatRegistry({ send: (m) => sent.push(m), onChange: () => {} });
    const controller = registry.ensure('s1');
    assert.strictEqual(controller.draftSyncAvailable, false, 'off until the server says otherwise');

    registry.setFeatures(['chat_subscribe', 'chat_draft']);
    assert.strictEqual(
      controller.draftSyncAvailable,
      true,
      'the handshake arrives after a reload has restored its tabs, so existing conversations must hear it too',
    );
  });

  it('says the first thing at once, then folds a burst into one more', async function () {
    const { controller, sent } = client();
    controller.publishDraft('t', []);
    controller.publishDraft('th', []);
    controller.publishDraft('the', []);
    controller.publishDraft('them', []);

    assert.strictEqual(draftFrames(sent).length, 1, 'the start of typing is the part being watched');
    assert.strictEqual(draftFrames(sent)[0].text, 't');

    await wait(400);
    const frames = draftFrames(sent);
    assert.strictEqual(frames.length, 2, 'a paragraph is a few dozen frames, not six hundred');
    assert.strictEqual(frames[1].text, 'them', 'and the last one carries what is actually in the field');
  });

  it('sends what is waiting the moment the page is put down', function () {
    const { controller, sent } = client();
    controller.publishDraft('a', []);
    controller.publishDraft('and the rest of it', []);
    controller.flushDraft();

    const frames = draftFrames(sent);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[1].text, 'and the rest of it');
  });

  it('does not repeat itself when nothing changed', function () {
    const { controller, sent } = client();
    controller.publishDraft('steady', []);
    controller.flushDraft();
    controller.publishDraft('steady', []);
    controller.flushDraft();

    assert.strictEqual(draftFrames(sent).length, 1, 'a caret moving is not an edit');
  });

  it('drops the frame that was waiting when the message is sent', async function () {
    const { controller, sent } = client();
    controller.publishDraft('ask', []);
    controller.publishDraft('ask this now', []);
    controller.sendTurn('ask this now', [], { fromComposer: true });

    await wait(400);
    const frames = draftFrames(sent);
    assert.strictEqual(frames.length, 1, 'a late frame would put the sent message back into every composer');
    assert.strictEqual(frames[0].text, 'ask');
    assert.strictEqual(sent.filter((m) => m.type === 'chat_send').length, 1);
  });

  it('keeps typing alive when a turn is sent again from the transcript', async function () {
    const { controller, sent } = client();
    controller.publishDraft('a', []);
    controller.publishDraft('a half-written question', []);
    controller.sendTurn('an old turn', []);

    await wait(400);
    const frames = draftFrames(sent);
    assert.strictEqual(frames.length, 2, 'retrying a turn must not swallow what is being written');
    assert.strictEqual(frames[1].text, 'a half-written question');
  });

  it('tells the server which sends came from the composer', function () {
    const { controller, sent } = client();
    controller.sendTurn('typed', [], { fromComposer: true });
    controller.sendTurn('replayed', []);

    const turns = sent.filter((m) => m.type === 'chat_send');
    assert.strictEqual(turns[0].fromComposer, true);
    assert.strictEqual(turns[1].fromComposer, false);
  });

  it('stays quiet while the composer empties itself after a send', async function () {
    const { controller, sent } = client();
    const file = { url: `${PREFIX}abc-shot.png`, name: 'shot.png', mime: 'image/png', size: 10 };
    controller.publishDraft('look at this', [file]);
    controller.flushDraft();

    // What the surface does, in the order it does it: the turn goes, the owner
    // of the draft empties it, and then the composer clears its own two halves.
    controller.sendTurn('look at this', [file], { fromComposer: true });
    controller.publishDraft('', []);
    controller.publishDraft('', []);
    controller.publishDraft('', []);

    await wait(400);
    const frames = draftFrames(sent);
    assert.strictEqual(frames.length, 1, 'a half-cleared composer must not go out as an edit');
    assert.strictEqual(frames[0].text, 'look at this');
  });

  it('lets nothing go after the conversation is disposed of', async function () {
    const { controller, sent } = client();
    controller.publishDraft('a', []);
    controller.publishDraft('ab', []);
    controller.dispose();

    await wait(400);
    assert.strictEqual(draftFrames(sent).length, 1, 'a timer outliving its tab is a frame nobody asked for');
  });
});

describe('a composer arriving on the join', function () {
  it('is taken from the snapshot', function () {
    const { controller, seen } = client();
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: snapshot(),
      draft: { text: 'in progress elsewhere', attachments: [], revision: 3 },
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].text, 'in progress elsewhere');
    assert.strictEqual(controller.draftAnswer, 'held');
  });

  it('is not re-applied by the broadcast that follows it', function () {
    const { controller, seen } = client();
    const draft = { text: 'once', attachments: [], revision: 3 };
    controller.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(), draft });
    controller.handle({ type: 'chat_draft', sessionId: 's1', draft, origin: 'w9' });

    assert.strictEqual(seen.length, 1, 'a rejoin replays what this browser already applied');
  });

  it('reports a server with nothing to say, so the surface can offer what it kept', function () {
    const { controller, seen } = client();
    controller.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(), draft: null });

    assert.deepStrictEqual(seen, [null]);
    assert.strictEqual(controller.draftAnswer, 'none');
  });

  it('never tells the surface to clear itself just because a server said nothing', function () {
    const { controller, seen } = client();
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'being written', attachments: [], revision: 2 },
      origin: 'w9',
    });
    // An older server, which sends no draft field at all.
    controller.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot() });

    assert.deepStrictEqual(
      seen.slice(1),
      [null],
      'the surface is told the server has nothing, and keeps its own text',
    );
  });

  it('starts counting again when the server says it holds no composer', function () {
    const { controller, seen } = client();
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'from before the restart', attachments: [], revision: 7 },
      origin: 'w9',
    });
    // The server came back up: the session is still there, its composer is not,
    // and its numbering begins again at one.
    controller.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(), draft: null });
    controller.handle({
      type: 'chat_draft',
      sessionId: 's1',
      draft: { text: 'typed on the phone since', attachments: [], revision: 1 },
      origin: 'w9',
    });

    assert.strictEqual(
      seen.pop(),
      controller.draftValue,
      'a floor left at 7 silently drops the next seven edits, then heals — which is what makes it invisible',
    );
    assert.strictEqual(controller.draftValue.text, 'typed on the phone since');
  });

  it('offers its own text again when the server turns out never to have got it', function () {
    const { controller, seen } = client();
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: snapshot(),
      draft: { text: 'as far as the server knows', attachments: [], revision: 4 },
    });
    // A reconnect: the same conversation, the same revision. This browser typed
    // on into a socket that was already closing, so the server holds the older
    // text and nothing has told anybody.
    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: snapshot(),
      draft: { text: 'as far as the server knows', attachments: [], revision: 4 },
    });

    assert.strictEqual(
      seen.pop(),
      null,
      'the surface is asked to offer what it kept, which is the only thing that repairs a dropped frame',
    );
  });

  it('will repeat itself after a reconnect, having been told what the server really has', async function () {
    const { controller, sent } = client();
    controller.publishDraft('typed into a dying socket', []);
    assert.strictEqual(draftFrames(sent).length, 1, 'the frame the socket then dropped on the floor');

    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: snapshot(),
      draft: { text: 'the older text the server kept', attachments: [], revision: 1 },
    });
    // The surface answers the "nothing newer" by offering what it is holding.
    controller.publishDraft('typed into a dying socket', []);
    await wait(400);

    assert.deepStrictEqual(
      draftFrames(sent).map((f) => f.text),
      ['typed into a dying socket', 'typed into a dying socket'],
      'a browser that believes it published something it never did would stop repeating it forever',
    );
  });

  it('drops what it was about to say when the join brings something newer', async function () {
    const { controller, sent } = client();
    controller.publishDraft('mine', []);
    controller.publishDraft('mine, longer', []);

    controller.handle({
      type: 'chat_snapshot',
      sessionId: 's1',
      snapshot: snapshot(),
      draft: { text: 'typed on the phone', attachments: [], revision: 9 },
    });

    await wait(400);
    assert.deepStrictEqual(
      draftFrames(sent).map((f) => f.text),
      ['mine'],
      'the reconnect path has the same trap as the broadcast one, and the same answer',
    );
  });

  it('has heard nothing before the first join', function () {
    const { controller } = client();
    assert.strictEqual(
      controller.draftAnswer,
      'unheard',
      'a surface that cannot tell this from "nothing typed" publishes its stale copy over a newer one',
    );
  });
});
