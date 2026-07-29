const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Who gets told that a conversation needs them, and how many times.
//
// Driven through the real ChatRegistry and the real ChatController, not by
// calling the notifier with hand-made alerts: the property that matters most
// here is that a reconnect — which redelivers the tail of the event log —
// announces nothing, and that is a property of the transcript's own replay
// guard rather than of anything in the notifier. Feeding the same `turn_end`
// twice is exactly what a reconnect looks like from here.
//
// The browser stubs live inside the describe on purpose: a `before` at the top
// level of a mocha file is a ROOT hook and runs before every suite in the whole
// run. They are also re-installed per test, because another suite in this run
// deletes `document` and `navigator` in a root afterEach.

const ROOT = path.join(__dirname, '..');

let mod;

const STUBBED = ['window', 'document', 'Notification', 'localStorage'];
const originals = {};
/**
 * `navigator` is not assignable in Node.
 *
 * It is an accessor with a getter and no setter, so `global.navigator = {...}`
 * fails silently and leaves Node's own — which has no `serviceWorker`, so the
 * test would prove the fallback path twice and never the one that matters on a
 * phone. Defined over, and put back exactly as it was afterwards.
 */
let navigatorDescriptor;

function setNavigator(value) {
  Object.defineProperty(global, 'navigator', { value, configurable: true, writable: true });
}

/** Message listeners the page registered on the service worker. */
const workerListeners = [];
/** Every count written to the installed app's launcher badge. */
let badge;

/** What the worker posts when a notification is acted on. */
function postFromWorker(sessionId) {
  for (const listener of workerListeners) {
    listener({ data: { type: 'cc-web-open-conversation', sessionId } });
  }
}

/** Every notification the page constructor was asked to show. */
let shown;
/** Every notification the service worker was asked to show. */
let workerShown;
/** Conversations the app was asked to switch to. */
let switched;
let permission;
let visibility;
let focused;
let registration;

function installStubs() {
  global.window = {
    focus() {},
    addEventListener() {},
    location: { href: 'https://host/' },
    history: { replaceState() {} },
  };
  global.document = {
    addEventListener() {},
    get visibilityState() { return visibility; },
    hasFocus: () => focused,
    title: 'test',
  };
  workerListeners.length = 0;
  setNavigator({
    setAppBadge: async (count) => { badge.push(count); },
    clearAppBadge: async () => { badge.push('cleared'); },
    ...(registration
      ? {
        serviceWorker: {
          addEventListener(type, fn) { if (type === 'message') workerListeners.push(fn); },
          getRegistration: async () => registration,
        },
      }
      : {}),
  });
  global.Notification = class {
    constructor(title, options) {
      this.title = title;
      this.options = options || {};
      this.onclick = null;
      shown.push(this);
    }

    close() { this.closed = true; }

    static get permission() { return permission; }

    static async requestPermission() {
      permission = 'granted';
      return permission;
    }
  };
  global.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
}

/** Let the notifier's own promise chain run before reading what it showed. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The narrowest App the notifier actually reaches for.
 *
 * `tabs` is a real Map because the notifier consults it: a conversation with no
 * tab is one nothing can open and nothing will ever unblock. Every id used
 * below is registered in it, the way opening a conversation registers one.
 */
function fakeApp(registry) {
  const names = new Map();
  const attention = new Map();
  const tabs = new Map([['s1', {}], ['s2', {}], ['s3', {}]]);
  return {
    names,
    attention,
    tabs,
    chats: registry,
    sessionTabManager: {
      activeTabId: null,
      tabs,
      setAttention(sessionId, value) { attention.set(sessionId, value); },
      conversationLabel: (sessionId) => names.get(sessionId) || sessionId,
      switchToTab(sessionId) { switched.push(sessionId); },
    },
  };
}

describe('telling the user a conversation needs them', function () {
  before(function () {
    this.timeout(60000);
    for (const name of STUBBED) originals[name] = global[name];
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    shown = [];
    workerShown = [];
    switched = [];
    badge = [];
    permission = 'granted';
    visibility = 'hidden';
    focused = false;
    registration = null;
    installStubs();

    const contents = [
      `export { ChatRegistry } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/registry'))};`,
      `export * from ${JSON.stringify(path.join(ROOT, 'src/client/chat/attention'))};`,
      `export * from ${JSON.stringify(path.join(ROOT, 'src/client/ui/notify'))};`,
      `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `chat-attention-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'attention.ts' },
      bundle: true,
      outfile: out,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(out);
    mod.__file = out;
  });

  after(function () {
    if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
    for (const name of STUBBED) {
      if (originals[name] === undefined) delete global[name];
      else global[name] = originals[name];
    }
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  });

  beforeEach(async function () {
    shown = [];
    workerShown = [];
    switched = [];
    badge = [];
    permission = 'granted';
    // The ordinary case this feature is for: the window is not what the user is
    // looking at. Individual tests move it.
    visibility = 'hidden';
    focused = false;
    registration = null;
    installStubs();
    mod.clearAllAlerts();
    mod.setConversationOpener((sessionId) => switched.push(sessionId));
    mod.shellStore.setState({
      notifications: {
        enabled: true,
        finished: true,
        failed: true,
        approval: true,
        question: true,
        details: true,
      },
    });
    await flush();
    shown.length = 0;
  });

  /** A registry wired the way App wires it, plus the app it reports to. */
  function conversation() {
    let app;
    const registry = new mod.ChatRegistry({
      send: () => {},
      onChange: () => {},
      onEvent: (sessionId, event) => mod.noteChatEvent(app, sessionId, event),
    });
    app = fakeApp(registry);
    return { app, registry };
  }

  /** Deliver an event exactly as the socket would. */
  async function deliver(registry, sessionId, event) {
    registry.handle({ type: 'chat_event', sessionId, event });
    await flush();
  }

  const finished = (seq) => ({ t: 'turn_end', seq, ts: 1, turnId: `t${seq}`, stopReason: 'end_turn' });

  it('tells the user when a background conversation finishes, and names it', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');

    await deliver(registry, 's1', finished(1));

    assert.strictEqual(shown.length, 1, 'one notification');
    assert.strictEqual(shown[0].title, 'webcli');
    assert.match(shown[0].options.body, /Finished/);
  });

  it('says nothing about the conversation on screen', async function () {
    const { app, registry } = conversation();
    app.sessionTabManager.activeTabId = 's1';
    visibility = 'visible';
    focused = true;

    await deliver(registry, 's1', finished(1));

    assert.deepStrictEqual(shown, [], 'the user is looking straight at it');
  });

  it('still speaks when the window is visible but behind something else', async function () {
    // The case the terminal notifications cannot reach at all: `visible` is not
    // "on screen", it is "not minimised and not in a background browser tab".
    // Somebody who alt-tabbed away to do something else is exactly who this is
    // for, and their window is still visible.
    const { app, registry } = conversation();
    app.sessionTabManager.activeTabId = 's1';
    visibility = 'visible';
    focused = false;

    await deliver(registry, 's1', finished(1));

    assert.strictEqual(shown.length, 1);
  });

  it('says nothing twice for a turn a reconnect delivered again', async function () {
    const { registry } = conversation();
    await deliver(registry, 's1', finished(4));
    await deliver(registry, 's1', finished(4));
    await deliver(registry, 's1', { ...finished(3), turnId: 'older' });

    assert.strictEqual(shown.length, 1, 'a replayed event is not a new fact');
  });

  it('folds several conversations into one notification rather than a stack', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');
    app.names.set('s2', 'docs');
    app.names.set('s3', 'infra');

    await deliver(registry, 's1', finished(1));
    await deliver(registry, 's2', finished(1));
    await deliver(registry, 's3', finished(1));

    assert.strictEqual(shown.length, 3, 'each is shown as it happens');
    const tags = new Set(shown.map((notification) => notification.options.tag));
    assert.strictEqual(tags.size, 1, 'one tag, so each replaces the last instead of stacking');
    assert.strictEqual(shown[2].title, '3 conversations finished');
    assert.strictEqual(shown[2].options.body, 'webcli, docs, infra');
    assert.ok(shown[0].closed, 'the page-scoped ones it replaced are closed behind it');
  });

  it('counts a conversation that finishes repeatedly once', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');

    await deliver(registry, 's1', finished(1));
    await deliver(registry, 's1', { t: 'msg_start', seq: 2, ts: 1, id: 'u1', role: 'user', turnId: 't2' });
    await deliver(registry, 's1', finished(3));

    assert.strictEqual(shown[shown.length - 1].title, 'webcli', 'still one conversation, not two');
    assert.strictEqual(mod.outstandingAlerts().length, 1);
  });

  it('tells the user a background workflow failed, and says which', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');

    await deliver(registry, 's1', {
      t: 'workflow_failed',
      seq: 1,
      ts: 1,
      parentToolId: 'w1',
      name: 'nightly-audit',
      reason: 'usage limit reached',
    });

    assert.strictEqual(shown.length, 1, 'nothing was raised for a workflow that broke');
    assert.strictEqual(shown[0].title, 'webcli');
    assert.strictEqual(
      shown[0].options.body,
      'The workflow "nightly-audit" failed — usage limit reached',
      'the notification blamed the turn, which ended perfectly well',
    );
  });

  it('does not take that back when the conversation carries on working', async function () {
    // The shape the recording actually has: the run fails while its own turn is
    // still going, the turn ends, and the agent starts the next thing. All of
    // that used to remove the notification before anybody read it (#140).
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');

    await deliver(registry, 's1', {
      t: 'workflow_failed',
      seq: 1,
      ts: 1,
      parentToolId: 'w1',
      name: 'nightly-audit',
      reason: 'usage limit reached',
    });
    await deliver(registry, 's1', finished(2));
    await deliver(registry, 's1', { t: 'state', seq: 3, ts: 1, state: 'thinking' });

    assert.strictEqual(mod.outstandingAlerts().length, 1, 'the failure was withdrawn');
    assert.strictEqual(
      mod.outstandingAlerts()[0].kind,
      'failed',
      'a plain "finished" replaced the failure it followed',
    );
  });

  it('still clears a failure once the user is plainly there', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');

    await deliver(registry, 's1', {
      t: 'workflow_failed',
      seq: 1,
      ts: 1,
      parentToolId: 'w1',
      name: 'nightly-audit',
      reason: 'usage limit reached',
    });
    await deliver(registry, 's1', { t: 'msg_start', seq: 2, ts: 1, id: 'u1', role: 'user', turnId: 't2' });

    assert.strictEqual(mod.outstandingAlerts().length, 0, 'a dealt-with failure is still outstanding');
  });

  it('says a conversation needs you and nothing else when details are off', async function () {
    const { app, registry } = conversation();
    app.names.set('s1', 'a-private-project');
    mod.shellStore.setState({
      notifications: {
        enabled: true, finished: true, failed: true, approval: true, question: true, details: false,
      },
    });

    await deliver(registry, 's1', {
      t: 'permission',
      seq: 1,
      ts: 1,
      request: {
        requestId: 'p1',
        title: 'Run: rm -rf /srv/customer-data',
        toolKind: 'execute',
        options: [],
        ts: 1,
      },
    });

    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].title, 'A conversation needs you');
    assert.strictEqual(shown[0].options.body, '');
    assert.ok(
      !JSON.stringify(shown[0]).includes('customer-data'),
      'nothing about the work leaves the app',
    );
  });

  it('honours the switch for each kind, and the master switch over all of them', async function () {
    const { registry } = conversation();
    mod.shellStore.setState({
      notifications: {
        enabled: true, finished: false, failed: true, approval: true, question: true, details: true,
      },
    });
    await deliver(registry, 's1', finished(1));
    assert.deepStrictEqual(shown, [], 'finished is switched off');

    await deliver(registry, 's1', { t: 'error', seq: 2, ts: 1, message: 'kimi exited', fatal: true });
    assert.strictEqual(shown.length, 1, 'failure is not');

    mod.shellStore.setState({
      notifications: {
        enabled: false, finished: true, failed: true, approval: true, question: true, details: true,
      },
    });
    shown.length = 0;
    await deliver(registry, 's2', finished(1));
    assert.deepStrictEqual(shown, [], 'the master switch stops everything');
  });

  it('marks the tab while a conversation is blocked, and unmarks it when it is answered', async function () {
    const { app, registry } = conversation();

    await deliver(registry, 's1', {
      t: 'permission',
      seq: 1,
      ts: 1,
      request: { requestId: 'p1', title: 'Run: npm test', toolKind: 'execute', options: [], ts: 1 },
    });
    assert.strictEqual(app.attention.get('s1'), 'approval');
    assert.strictEqual(shown.length, 1);
    assert.match(shown[0].options.body, /npm test/);

    // Answered from somewhere else entirely — another window, another device.
    await deliver(registry, 's1', {
      t: 'permission_resolved', seq: 2, ts: 1, requestId: 'p1', optionId: 'allow_once', allowed: true,
    });
    assert.strictEqual(app.attention.get('s1'), null, 'the mark goes when the block does');
    assert.strictEqual(mod.outstandingAlerts().length, 0, 'and so does the notification');
  });

  it('keeps the mark when the user opens the conversation but has not answered', async function () {
    const { app, registry } = conversation();
    await deliver(registry, 's1', {
      t: 'question',
      seq: 1,
      ts: 1,
      request: {
        requestId: 'q1',
        question: 'Which approach?',
        header: 'Pick one',
        multiSelect: false,
        options: [],
        ts: 1,
      },
    });
    assert.strictEqual(app.attention.get('s1'), 'question');
    assert.strictEqual(shown.length, 1, 'a question interrupts as an approval does');
    assert.match(shown[0].options.body, /Pick one/, 'and says what it asked, when detail is on');

    mod.noteConversationOpened('s1');
    await flush();

    assert.strictEqual(mod.outstandingAlerts().length, 0, 'the notification has been acted on');
    assert.strictEqual(
      app.attention.get('s1'),
      'question',
      'but the question is still unanswered, so the tab still says so',
    );
  });

  it('opens the conversation it was about when it is acted on', async function () {
    const { app, registry } = conversation();
    app.names.set('s2', 'docs');
    await deliver(registry, 's2', finished(1));

    shown[0].onclick();

    assert.deepStrictEqual(switched, ['s2']);
  });

  it('shows through the service worker where there is one', async function () {
    // Not a preference: `new Notification(...)` throws "Illegal constructor" on
    // Android Chrome, so the phone this feature exists for gets nothing at all
    // unless the worker shows it.
    registration = {
      showNotification: async (title, options) => { workerShown.push({ title, options }); },
      getNotifications: async () => [],
    };
    installStubs();

    const { app, registry } = conversation();
    app.names.set('s1', 'webcli');
    await deliver(registry, 's1', finished(1));

    assert.strictEqual(workerShown.length, 1);
    assert.strictEqual(workerShown[0].title, 'webcli');
    assert.strictEqual(workerShown[0].options.data.sessionId, 's1', 'so the click knows where to go');
    assert.deepStrictEqual(shown, [], 'and the page constructor is not touched');
  });

  it('says nothing about a conversation whose tab has been closed', async function () {
    // Closing a tab leaves the unsubscribe in flight, and a `turn_end` that
    // crosses it rebuilds a controller with an empty transcript — which accepts
    // the event as new. Nothing could ever end the alert it would raise: there
    // is no tab to open and no more events to come.
    const { app, registry } = conversation();
    app.sessionTabManager.tabs.delete('s1');

    await deliver(registry, 's1', finished(1));

    assert.deepStrictEqual(shown, []);
    assert.strictEqual(mod.outstandingAlerts().length, 0, 'and nothing is left in the summary');
  });

  it('clears the launcher badge left behind by a previous window', async function () {
    // The badge is app-scoped and outlives the page that set it, while the
    // outstanding set dies with it. Nothing else in a fresh page would ever
    // paint over yesterday's count.
    badge.length = 0;
    mod.startNotifyRouting();
    assert.deepStrictEqual(badge, ['cleared']);
  });

  it('holds on to a notification acted on before the app could open one', async function () {
    // A notification survives a reload, so it can be clicked while the window
    // is still fetching its session list. The worker posts once and never
    // retries.
    registration = { showNotification: async () => {}, getNotifications: async () => [] };
    installStubs();
    mod.setConversationOpener(null);
    mod.startNotifyRouting();

    postFromWorker('s3');
    assert.deepStrictEqual(switched, [], 'nothing can act on it yet');
    assert.strictEqual(
      mod.takeRequestedConversation(),
      's3',
      'and the tab this window opens on is the one that was clicked',
    );
    assert.strictEqual(mod.takeRequestedConversation(), null, 'read once, not on every reload');

    postFromWorker('s2');
    mod.setConversationOpener((sessionId) => switched.push(sessionId));
    assert.deepStrictEqual(switched, ['s2'], 'a later click is delivered when the opener arrives');
  });

  it('says nothing at all when the browser has refused', async function () {
    permission = 'denied';
    const { app, registry } = conversation();

    await deliver(registry, 's1', {
      t: 'permission',
      seq: 1,
      ts: 1,
      request: { requestId: 'p1', title: 'Run: npm test', toolKind: 'execute', options: [], ts: 1 },
    });

    assert.deepStrictEqual(shown, [], 'nothing is shown');
    assert.strictEqual(
      app.attention.get('s1'),
      'approval',
      'and the tab mark is what the user has instead, so it must not depend on permission',
    );
  });
});
