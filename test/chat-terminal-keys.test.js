const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The shell inside a conversation, driven from a phone.
//
// Issue #21 took the on-screen keyboard away from every terminal in this app —
// it popped over half the screen on every tap — and gave the terminal surface a
// key strip in exchange. The pane inside a conversation arrived later and is a
// session of its own, with its own socket: it inherited the suppression and none
// of the keys, which left it readable and undrivable on the one kind of device
// the strip exists for.
//
// Two halves, because either can fail alone: the strip has to be *there* (in the
// split, on a phone and only on a phone), and its keys have to arrive at *this*
// pane's socket rather than at whichever session the app happens to have in
// focus. The second half is asserted against the class rather than a real pane —
// a real one owns an xterm and a canvas, and Node has neither.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { TerminalSplit } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/TerminalSplit'))};`,
    `export { ChatTerminal, terminalsFor } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/chat-terminal'))};`,
    `export { sendMobileKey } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/mobile'))};`,
    `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `chat-terminal-keys-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-terminal-keys.tsx' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
});

// `WebSocket.OPEN` is read at send time, and the constant is all either path
// needs. Re-stubbed per test rather than once: another suite's root-level
// afterEach clears globals for every file in the run.
let realWebSocket;

beforeEach(function () {
  realWebSocket = global.WebSocket;
  global.WebSocket = { OPEN: 1 };
  mod.shellStore.setState({ ctrlLatched: false });
});

afterEach(function () {
  global.WebSocket = realWebSocket;
  mod.shellStore.setState({ ctrlLatched: false });
});

/** A pane as the split renders one: the fields the tab strip reads, no xterm. */
function fakePane() {
  return {
    id: 'pane-1',
    label: 'shell — alpha',
    phase: 'live',
    cols: 80,
    rows: 24,
    fit() {},
    focus() {},
    clear() {},
    sendKey() {},
    showKeyboard() {},
  };
}

/** The split, rendered for one conversation with one pane already open in it. */
function renderSplit(chatSessionId, isMobile) {
  const { renderToStaticMarkup, React, TerminalSplit, terminalsFor } = mod;
  terminalsFor(chatSessionId).push(fakePane());
  return renderToStaticMarkup(
    React.createElement(TerminalSplit, {
      chatSessionId,
      workingDir: '/projects/alpha',
      height: 300,
      onResize() {},
      onClose() {},
      isMobile,
    }),
  );
}

/**
 * A pane without its constructor.
 *
 * The constructor opens an xterm on a real element, which is the one thing this
 * cannot have here — but `sendKey` only ever reads two things off the instance:
 * the socket this pane opened, and the cursor-key mode of the terminal it owns.
 * So the object carries those and inherits the rest of the class.
 */
function paneInnards({ open = true, applicationCursorKeys = false } = {}) {
  const sent = [];
  const self = Object.create(mod.ChatTerminal.prototype);
  self.socket = open ? { readyState: 1, send: (frame) => sent.push(frame) } : null;
  self.controller = { terminal: { modes: { applicationCursorKeysMode: applicationCursorKeys } } };
  return { sent, self };
}

/** The app, as the strip's original target: one socket, one send. */
function fakeApp({ open = true, applicationCursorKeys = false } = {}) {
  const sent = [];
  return {
    sent,
    app: {
      socket: open ? { readyState: 1 } : null,
      terminal: { modes: { applicationCursorKeysMode: applicationCursorKeys } },
      send: (frame) => sent.push(frame),
    },
  };
}

/** The `input` payloads a pane's socket carried, in order. */
function inputs(frames) {
  return frames
    .map((frame) => JSON.parse(frame))
    .filter((message) => message.type === 'input')
    .map((message) => message.data);
}

function press(self, key) {
  self.sendKey(key);
}

describe('the on-screen keys reach the terminal inside a conversation', function () {
  this.timeout(20000);

  it('puts the strip in the split on a phone', function () {
    const html = renderSplit('chat-keys-1', true);

    // The keys an agent actually asks for, and the keys a phone keyboard does
    // not have. Losing any of them silently is the failure worth catching.
    assert.ok(/aria-label="Terminal keys"/.test(html), 'the split renders no key strip on a phone');
    assert.ok(/>Esc</.test(html), 'the strip must offer Escape');
    assert.ok(/>Tab</.test(html), 'the strip must offer Tab');
    assert.ok(/>Ctrl</.test(html), 'the strip must offer the Ctrl latch');
    assert.ok(/aria-label="Send Enter"/.test(html), 'the strip must offer Enter');
    for (const arrow of ['Up', 'Down', 'Left', 'Right']) {
      assert.ok(html.includes(`aria-label="Send ${arrow} arrow"`), `the strip must offer the ${arrow} arrow`);
    }
    // Since #21 a tap on the terminal no longer summons the keyboard, so there
    // has to be something in this pane that does.
    assert.ok(
      /aria-label="Show on-screen keyboard"/.test(html),
      'the strip must be able to summon the on-screen keyboard',
    );
  });

  it('leaves the desktop split exactly as it was', function () {
    const html = renderSplit('chat-keys-2', false);
    assert.ok(
      !/aria-label="Terminal keys"/.test(html),
      'a desktop keyboard has these keys; the strip would only cost the shell rows',
    );
    // Still the same pane, with its tab and its geometry readout.
    assert.ok(html.includes('shell — alpha'), 'the split lost its tab');
    assert.ok(html.includes('80×24'), 'the split lost its geometry readout');
  });

  it('sends the key to this pane’s session, not the one the app has in focus', function () {
    const { sent: appSent, app } = fakeApp();
    const { sent: paneSent, self } = paneInnards();

    mod.sendMobileKey(app, 'esc');
    assert.deepStrictEqual(appSent, [{ type: 'input', data: '\x1b' }]);
    assert.deepStrictEqual(paneSent, [], 'the app’s key leaked into the conversation’s shell');

    press(self, 'esc');
    assert.deepStrictEqual(inputs(paneSent), ['\x1b']);
    assert.strictEqual(appSent.length, 1, 'the conversation’s key leaked into the active session');

    press(self, 'tab');
    press(self, 'enter');
    assert.deepStrictEqual(inputs(paneSent), ['\x1b', '\t', '\r']);
  });

  it('encodes arrows against this pane’s own cursor-key mode', function () {
    // The pane is running something full-screen; the session in focus is at a
    // shell prompt. Reading the mode off the app would give one of them the
    // encoding the other one wants.
    const { sent: paneSent, self } = paneInnards({ applicationCursorKeys: true });
    const { sent: appSent, app } = fakeApp({ applicationCursorKeys: false });

    press(self, 'up');
    mod.sendMobileKey(app, 'up');

    assert.deepStrictEqual(inputs(paneSent), ['\x1bOA']);
    assert.deepStrictEqual(appSent, [{ type: 'input', data: '\x1b[A' }]);
  });

  it('consumes the Ctrl latch the key was sent under', function () {
    const { sent, self } = paneInnards();
    mod.shellStore.setState({ ctrlLatched: true });

    press(self, 'left');

    assert.deepStrictEqual(inputs(sent), ['\x1b[1;5D'], 'Ctrl+Left must be the modified arrow');
    assert.strictEqual(
      mod.shellStore.getSnapshot().ctrlLatched,
      false,
      'the latch is one-shot: leaving it engaged would rewrite the next real keystroke',
    );
  });

  it('says nothing to a pane whose socket has gone', function () {
    // A shell whose pty exited still has a strip under it, and pressing a key
    // there must be a no-op rather than a throw inside a pointer handler.
    const { sent, self } = paneInnards({ open: false });
    press(self, 'enter');
    assert.deepStrictEqual(sent, []);
  });
});
