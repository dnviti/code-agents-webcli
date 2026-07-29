const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Issue #17: the main terminal comes back from a split, or from a reconnect,
// as a skeleton — borders and the one number that keeps ticking, nothing else.
//
// Two things were missing. The handler is built once and outlives every
// reconnect, session switch and split, and it remembered the last geometry it
// had sent forever; whenever something else attached to the same PTY (the split
// pane, a second tab, a phone) and resized it, this client's own cols/rows had
// not changed, so it decided there was nothing to send and never took the PTY
// back. And even at the right size, a CLI paints only the cells it thinks
// changed, so nothing on the client could make it redraw the screen it is
// already convinced it drew.
//
// Both live in the client, so this bundles message-handler.ts and
// connection.ts for Node and drives them with a fake app, a fake terminal and a
// fake socket — the same shape as version-skew.test.js.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { MessageHandler } from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/message-handler'))};`,
    `export { WebSocketConnection } from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/connection'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `terminal-geometry-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'geometry.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Let a test decide when the handshake completes. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
}

FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

// Set per test, not once: another suite's root afterEach deletes globals for
// every test in the run, and there is no compositor here to answer a real rAF.
const realRaf = global.requestAnimationFrame;
const realCancelRaf = global.cancelAnimationFrame;
const realWebSocket = global.WebSocket;
const realLocation = global.location;

beforeEach(function () {
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = (token) => clearTimeout(token);
  global.WebSocket = FakeWebSocket;
  global.location = { protocol: 'http:', host: 'localhost:3000' };
  FakeWebSocket.instances = [];
});

afterEach(function () {
  global.requestAnimationFrame = realRaf;
  global.cancelAnimationFrame = realCancelRaf;
  global.WebSocket = realWebSocket;
  global.location = realLocation;
});

/** Run the queued frames: the refit wave, then the nudge's restore. */
async function settle(turns = 3) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fakeTerminal(cols, rows) {
  return {
    cols,
    rows,
    reset() {},
    write() {},
    writeln() {},
  };
}

function fakeApp(overrides = {}) {
  const sent = [];
  const app = {
    sent,
    aliases: { claude: 'Claude', terminal: 'Terminal' },
    terminal: fakeTerminal(120, 40),
    socket: { readyState: FakeWebSocket.OPEN },
    currentClaudeSessionId: 'session-1',
    currentClaudeSessionName: null,
    historyRange: null,
    historyView: null,
    sessionTabManager: null,
    splitContainer: null,
    pendingJoinResolve: null,
    pendingJoinSessionId: null,
    pendingRuntimeStart: null,
    runtimeStartTimer: null,
    startPromptRequested: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 1000,
    chats: { handle: () => false, drop() {}, ensure: () => ({}), setFeatures() {} },
    fitTerminal() {},
    loadSessions() {},
    requestUsageStats() {},
    getRuntimeStartMessage: () => 'Starting...',
    getRuntimeLabel: (kind, label, fallback) => label || fallback,
    send: (message) => sent.push(message),
    ...overrides,
  };
  app.messageHandler = new mod.MessageHandler(app);
  return app;
}

function join(app, overrides = {}) {
  app.messageHandler.handle({
    type: 'session_joined',
    sessionId: 'session-1',
    sessionName: 'Session',
    workingDir: '/tmp/project',
    active: true,
    outputBuffer: [],
    ...overrides,
  });
}

const resizes = (app) => app.sent.filter((m) => m.type === 'resize');

describe('a terminal rejoining a PTY somebody else resized (issue #17)', function () {
  it('re-sends its geometry on a second join, unchanged though it is', async function () {
    const app = fakeApp();

    join(app);
    await settle();
    assert.ok(
      resizes(app).some((m) => m.cols === 120 && m.rows === 40),
      'the first join must claim the PTY',
    );

    // Between the two joins a split pane held the same session and resized the
    // shared PTY to half a screen. Nothing about *this* terminal changed.
    app.sent.length = 0;
    join(app);
    await settle();

    assert.ok(
      resizes(app).some((m) => m.cols === 120 && m.rows === 40),
      'the join must re-assert 120x40: the handler remembered having sent it '
        + 'once and stayed silent for the rest of the page\'s life',
    );
  });

  it('dips one row and comes straight back, so the CLI repaints everything', async function () {
    const app = fakeApp();

    join(app);
    await settle();

    const sizes = resizes(app).map((m) => `${m.cols}x${m.rows}`);
    const dip = sizes.indexOf('120x39');
    assert.notStrictEqual(dip, -1, 'a real SIGWINCH needs a size the PTY is not already at');
    assert.strictEqual(
      sizes.indexOf('120x40', dip + 1) > dip,
      true,
      'and the borrowed row has to come back',
    );
  });

  it('nudges once per join, not once per refit wave', async function () {
    // An output buffer makes onSessionJoined refit three times over.
    const app = fakeApp();
    join(app, { outputBuffer: ['hello\r\n'] });
    await settle();

    assert.strictEqual(
      resizes(app).filter((m) => m.rows === 39).length,
      1,
      'three refits must not mean three repaints of the whole screen',
    );
  });

  it('never asks a one-row terminal for zero rows', async function () {
    const app = fakeApp({ terminal: fakeTerminal(80, 1) });

    join(app);
    await settle();

    assert.deepStrictEqual(
      resizes(app).map((m) => m.rows),
      [1],
      'there is no row to borrow, so the size goes once and is not dipped',
    );
  });

  it('says nothing at all when the socket is not open', async function () {
    const app = fakeApp({ socket: { readyState: FakeWebSocket.CLOSED } });

    join(app);
    await settle();

    assert.deepStrictEqual(app.sent, []);
  });

  it('says nothing when no session is joined', async function () {
    const app = fakeApp();
    join(app);
    await settle();

    app.sent.length = 0;
    app.currentClaudeSessionId = null;
    app.messageHandler.reclaimTerminalGeometry();
    await settle();

    assert.deepStrictEqual(
      resizes(app).filter((m) => m.rows === 39),
      [],
      'a repaint of nothing is just a resize the server drops',
    );
  });

  it('does not nudge on a plain refit', async function () {
    const app = fakeApp();
    join(app);
    await settle();

    // A runtime start refits too. It is not a rejoin: the process is about to
    // paint its own first screen, and an ordinary window resize carries its own
    // SIGWINCH already.
    app.sent.length = 0;
    app.messageHandler.handle({ type: 'terminal_started', agent: 'terminal' });
    await settle();

    assert.deepStrictEqual(app.sent, []);
  });
});

describe('closing a split, over a socket that never dropped', function () {
  it('re-asserts the geometry when connect() finds the socket already open', async function () {
    const app = fakeApp();
    const connection = new mod.WebSocketConnection(app);

    join(app);
    await settle();

    // What closeSplit() does: the pane resized the shared PTY, then it asks the
    // main socket to reattach — and that socket was never closed, so there is
    // no session_joined coming.
    app.sent.length = 0;
    await connection.connect('session-1');
    await settle();

    const sizes = resizes(app).map((m) => `${m.cols}x${m.rows}`);
    assert.ok(sizes.includes('120x40'), 'the main terminal must take its width back');
    assert.ok(sizes.includes('120x39'), 'and make the program redraw at it');
  });
});

describe('a reconnect', function () {
  it('forgets the geometry the previous socket had claimed', async function () {
    const app = fakeApp();
    join(app);
    await settle();

    // The connection drops. While it is down, another device attaches and
    // resizes the PTY; this end has no way of hearing about it.
    app.socket = null;
    app.sent.length = 0;

    const connection = new mod.WebSocketConnection(app);
    const opened = connection.connect('session-1');
    FakeWebSocket.instances[0].open();
    await opened;

    // Any refit on the fresh socket now has to speak, because what this client
    // last sent went down with the old one.
    app.messageHandler.handle({ type: 'terminal_started', agent: 'terminal' });
    await settle();

    assert.ok(
      resizes(app).some((m) => m.cols === 120 && m.rows === 40),
      'the new socket must be told the size; the old one having been told does not count',
    );

    connection.disconnect();
  });
});
