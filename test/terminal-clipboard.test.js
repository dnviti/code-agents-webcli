const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The copy/paste logic never reaches dist/ on its own — esbuild bundles it into
// app.bundle.js for the browser. Typechecking only proves it compiles. This
// bundles clipboard.ts for Node and drives the handlers directly, which is the
// one place the chord matching, the "Ctrl+C stays the interrupt" rule and the
// quiet-rejection paths are actually exercised.
//
// clipboard.ts is deliberately UI- and xterm-agnostic (clipboard IO and notify
// are injected), so none of this needs a real terminal, DOM or Clipboard API.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export * from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/clipboard'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `clipboard-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'clipboard.ts' },
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
});

// A fresh document for every test: attachSelectionHint adds and removes
// document-level mousemove/mouseup listeners, and its teardown touches document.
beforeEach(function () {
  global.document = fakeTarget();
});

afterEach(function () {
  delete global.document;
  delete global.navigator;
  delete global.localStorage;
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function keyEvent(overrides = {}) {
  const event = {
    type: 'keydown',
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    prevented: false,
    stopped: false,
    ...overrides,
  };
  event.preventDefault = () => { event.prevented = true; };
  event.stopPropagation = () => { event.stopped = true; };
  return event;
}

function mouseEvent(overrides = {}) {
  const event = {
    button: 0,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    prevented: false,
    ...overrides,
  };
  event.preventDefault = () => { event.prevented = true; };
  return event;
}

function fakeTerminal(selection = '') {
  const calls = { paste: [], clearSelection: 0, keyHandlers: [] };
  return {
    selection,
    calls,
    hasSelection() { return Boolean(this.selection); },
    getSelection() { return this.selection; },
    clearSelection() { calls.clearSelection += 1; this.selection = ''; },
    paste(data) { calls.paste.push(data); },
    attachCustomKeyEventHandler(handler) { calls.keyHandlers.push(handler); },
  };
}

function fakeClipboard(opts = {}) {
  const calls = { writeText: [], readText: 0 };
  return {
    calls,
    writeText(text) {
      calls.writeText.push(text);
      return opts.writeImpl ? opts.writeImpl(text) : Promise.resolve();
    },
    readText() {
      calls.readText += 1;
      return opts.readImpl ? opts.readImpl() : Promise.resolve(opts.read ?? 'PASTED');
    },
  };
}

/** Records listeners and lets a test dispatch to them — used for both the
 *  terminal element and the global document stand-in. */
function fakeTarget() {
  const handlers = {};
  const log = [];
  return {
    handlers,
    log,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); log.push(['add', type]); },
    removeEventListener(type, fn) {
      if (handlers[type]) handlers[type] = handlers[type].filter((h) => h !== fn);
      log.push(['remove', type]);
    },
    dispatch(type, event) { (handlers[type] || []).slice().forEach((fn) => fn(event)); },
    isListening(type) { return (handlers[type] || []).length > 0; },
  };
}

function fakeHintStore(initiallySeen = false) {
  let seen = initiallySeen;
  return { seen: () => seen, markSeen: () => { seen = true; }, marked: () => seen };
}

function notifier() {
  const calls = [];
  const fn = (message, variant = 'info') => calls.push({ message, variant });
  fn.calls = calls;
  return fn;
}

describe('classifyChord', function () {
  // [name, event overrides, mac flag, expected]
  const cases = [
    ['Ctrl+Shift+C', { ctrlKey: true, shiftKey: true, key: 'C' }, false, 'copy'],
    ['Ctrl+Insert', { ctrlKey: true, key: 'Insert' }, false, 'copy'],
    ['Ctrl+Shift+V', { ctrlKey: true, shiftKey: true, key: 'V' }, false, 'paste'],
    ['Shift+Insert', { shiftKey: true, key: 'Insert' }, false, 'paste'],
    // Cmd is the control modifier only on Apple platforms.
    ['Cmd+Shift+C (mac)', { metaKey: true, shiftKey: true, key: 'C' }, true, 'copy'],
    ['Cmd+Shift+V (mac)', { metaKey: true, shiftKey: true, key: 'V' }, true, 'paste'],
    // Off-Mac, metaKey is the Super/Windows key: it must NOT act on a live agent.
    ['Super+Shift+V (non-mac)', { metaKey: true, shiftKey: true, key: 'V' }, false, null],
    ['Super+Shift+C (non-mac)', { metaKey: true, shiftKey: true, key: 'C' }, false, null],
    // AltGr reports as ctrl+alt; an undefined AltGr chord must not misfire.
    ['AltGr+Shift+V', { ctrlKey: true, altKey: true, shiftKey: true, key: 'V' }, false, null],
    ['AltGr+Shift+C', { ctrlKey: true, altKey: true, shiftKey: true, key: 'C' }, false, null],
    // The load-bearing negatives: the interrupt and the native image-paste path.
    ['Ctrl+C', { ctrlKey: true, key: 'c' }, false, null],
    ['Ctrl+V', { ctrlKey: true, key: 'v' }, false, null],
    ['Ctrl+Shift+A', { ctrlKey: true, shiftKey: true, key: 'A' }, false, null],
    ['plain a', { key: 'a' }, false, null],
    ['bare Insert', { key: 'Insert' }, false, null],
  ];

  cases.forEach(([name, overrides, mac, expected]) => {
    it(`${name} -> ${expected}`, function () {
      assert.strictEqual(mod.classifyChord(keyEvent(overrides), mac), expected);
    });
  });
});

describe('createClipboardKeyHandler', function () {
  it('Ctrl+Shift+C with a selection copies and returns false', async function () {
    const terminal = fakeTerminal('hello world');
    const clipboard = fakeClipboard();
    const notify = notifier();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard, notify });

    const event = keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' });
    const result = handler(event);

    assert.strictEqual(result, false, 'the chord must never be forwarded to the PTY');
    assert.strictEqual(event.prevented, true, 'must preventDefault so Chrome does not open devtools');
    assert.strictEqual(event.stopped, true, 'must stopPropagation so the chord does not bubble to the PTY path');
    assert.deepStrictEqual(clipboard.calls.writeText, ['hello world']);

    await flush();
    assert.deepStrictEqual(notify.calls, [{ message: 'Copied to clipboard', variant: 'info' }]);
  });

  it('plain Ctrl+C returns true so the interrupt still reaches the PTY', function () {
    const terminal = fakeTerminal('hello');
    const clipboard = fakeClipboard();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    const event = keyEvent({ ctrlKey: true, key: 'c' });
    assert.strictEqual(handler(event), true);
    assert.strictEqual(event.prevented, false);
    assert.deepStrictEqual(clipboard.calls.writeText, []);
  });

  it('plain Ctrl+V returns true so the native image-paste path still runs', function () {
    const terminal = fakeTerminal();
    const clipboard = fakeClipboard();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, key: 'v' })), true);
    assert.strictEqual(clipboard.calls.readText, 0);
    assert.deepStrictEqual(terminal.calls.paste, []);
  });

  it('Ctrl+Shift+C with no selection is swallowed but copies nothing', function () {
    const terminal = fakeTerminal('');
    const clipboard = fakeClipboard();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })), false);
    assert.deepStrictEqual(clipboard.calls.writeText, []);
  });

  it('only acts on keydown, not keyup/keypress', function () {
    const terminal = fakeTerminal('hi');
    const clipboard = fakeClipboard();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    for (const type of ['keyup', 'keypress']) {
      const event = keyEvent({ type, ctrlKey: true, shiftKey: true, key: 'C' });
      assert.strictEqual(handler(event), false, `${type} chord is still swallowed`);
      assert.strictEqual(event.prevented, false, `${type} does not preventDefault`);
    }
    assert.deepStrictEqual(clipboard.calls.writeText, [], 'no copy fires off keyup/keypress');
  });

  it('Ctrl+Shift+V reads the clipboard and pastes through xterm', async function () {
    const terminal = fakeTerminal();
    const clipboard = fakeClipboard({ read: 'from clipboard' });
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'V' })), false);
    await flush();
    assert.strictEqual(clipboard.calls.readText, 1);
    assert.deepStrictEqual(terminal.calls.paste, ['from clipboard']);
  });

  it('an empty clipboard pastes nothing', async function () {
    const terminal = fakeTerminal();
    const clipboard = fakeClipboard({ read: '' });
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'V' }));
    await flush();
    assert.deepStrictEqual(terminal.calls.paste, []);
  });

  it('a denied paste degrades quietly rather than throwing', async function () {
    const terminal = fakeTerminal();
    const clipboard = fakeClipboard({ readImpl: () => Promise.reject(new Error('denied')) });
    const notify = notifier();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard, notify });

    assert.doesNotThrow(() => handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'V' })));
    await flush();
    assert.deepStrictEqual(terminal.calls.paste, []);
    assert.strictEqual(notify.calls.length, 1);
    assert.strictEqual(notify.calls[0].variant, 'error');
  });

  it('a failed copy degrades quietly rather than throwing', async function () {
    const terminal = fakeTerminal('secret');
    const clipboard = fakeClipboard({ writeImpl: () => Promise.reject(new Error('blocked')) });
    const notify = notifier();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard, notify });

    assert.doesNotThrow(() => handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })));
    await flush();
    assert.strictEqual(notify.calls[0].variant, 'error');
  });

  it('with no Clipboard API, copy tells the user why', function () {
    const terminal = fakeTerminal('text');
    const notify = notifier();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard: null, notify });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })), false);
    assert.strictEqual(notify.calls.length, 1);
    assert.strictEqual(notify.calls[0].variant, 'error');
    assert.match(notify.calls[0].message, /secure|HTTPS/i);
  });

  it('with no Clipboard API, paste tells the user why and pastes nothing', function () {
    const terminal = fakeTerminal();
    const notify = notifier();
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard: null, notify });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, shiftKey: true, key: 'V' })), false);
    assert.deepStrictEqual(terminal.calls.paste, []);
    assert.strictEqual(notify.calls.length, 1);
    assert.strictEqual(notify.calls[0].variant, 'error');
    assert.match(notify.calls[0].message, /secure|HTTPS/i);
  });

  it('Ctrl+Insert / Shift+Insert are the fallback copy/paste pair', async function () {
    const terminal = fakeTerminal('picked');
    const clipboard = fakeClipboard({ read: 'pasted-insert' });
    const handler = mod.createClipboardKeyHandler(terminal, { clipboard });

    assert.strictEqual(handler(keyEvent({ ctrlKey: true, key: 'Insert' })), false);
    assert.deepStrictEqual(clipboard.calls.writeText, ['picked']);

    assert.strictEqual(handler(keyEvent({ shiftKey: true, key: 'Insert' })), false);
    await flush();
    assert.deepStrictEqual(terminal.calls.paste, ['pasted-insert']);
  });
});

describe('createContextMenuHandler', function () {
  it('with a selection: copies, clears it after the write lands, and suppresses the menu', async function () {
    const terminal = fakeTerminal('menu copy');
    const clipboard = fakeClipboard();
    const notify = notifier();
    const handler = mod.createContextMenuHandler(terminal, { clipboard, notify });

    const event = mouseEvent();
    handler(event);

    assert.strictEqual(event.prevented, true, 'the native menu is suppressed');
    assert.deepStrictEqual(clipboard.calls.writeText, ['menu copy']);
    assert.strictEqual(terminal.calls.clearSelection, 0, 'not cleared until the copy actually lands');

    await flush();
    assert.strictEqual(terminal.calls.clearSelection, 1);
    assert.deepStrictEqual(notify.calls, [{ message: 'Copied to clipboard', variant: 'info' }]);
  });

  it('with no selection: leaves the native menu alone', function () {
    const terminal = fakeTerminal('');
    const clipboard = fakeClipboard();
    const handler = mod.createContextMenuHandler(terminal, { clipboard });

    const event = mouseEvent();
    handler(event);

    assert.strictEqual(event.prevented, false);
    assert.strictEqual(terminal.calls.clearSelection, 0);
    assert.deepStrictEqual(clipboard.calls.writeText, []);
  });

  it('a blocked write keeps the selection so the user can retry', async function () {
    const terminal = fakeTerminal('keep me');
    const clipboard = fakeClipboard({ writeImpl: () => Promise.reject(new Error('blocked')) });
    const notify = notifier();
    const handler = mod.createContextMenuHandler(terminal, { clipboard, notify });

    const event = mouseEvent();
    handler(event);
    await flush();

    assert.strictEqual(event.prevented, true);
    assert.strictEqual(terminal.calls.clearSelection, 0, 'a failed copy must not destroy the selection');
    assert.strictEqual(notify.calls[0].variant, 'error');
  });

  it('with no Clipboard API: keeps the selection and explains', function () {
    const terminal = fakeTerminal('keep me');
    const notify = notifier();
    const handler = mod.createContextMenuHandler(terminal, { clipboard: null, notify });

    const event = mouseEvent();
    handler(event);

    assert.strictEqual(event.prevented, true);
    assert.strictEqual(terminal.calls.clearSelection, 0);
    assert.strictEqual(notify.calls.length, 1);
    assert.match(notify.calls[0].message, /secure|HTTPS/i);
  });
});

describe('shouldHintSelection', function () {
  const base = { moved: true, shiftKey: false, hasSelection: false, alreadySeen: false };
  it('fires on a swallowed plain drag', function () {
    assert.strictEqual(mod.shouldHintSelection(base), true);
  });
  it('stays quiet when Shift was held (that makes a selection)', function () {
    assert.strictEqual(mod.shouldHintSelection({ ...base, shiftKey: true }), false);
  });
  it('stays quiet when a selection was actually made', function () {
    assert.strictEqual(mod.shouldHintSelection({ ...base, hasSelection: true }), false);
  });
  it('stays quiet on a plain click (no movement)', function () {
    assert.strictEqual(mod.shouldHintSelection({ ...base, moved: false }), false);
  });
  it('shows only once', function () {
    assert.strictEqual(mod.shouldHintSelection({ ...base, alreadySeen: true }), false);
  });
});

describe('attachClipboard', function () {
  it('registers a contextmenu handler and a custom key handler', function () {
    const terminal = fakeTerminal();
    const element = fakeTarget();

    mod.attachClipboard(terminal, element, { clipboard: null });

    assert.ok(element.isListening('contextmenu'), 'contextmenu handler must be registered');
    assert.ok(element.isListening('mousedown'), 'the selection-hint listener must be registered');
    assert.strictEqual(terminal.calls.keyHandlers.length, 1, 'a custom key handler must be attached');
    assert.strictEqual(typeof terminal.calls.keyHandlers[0], 'function');
  });

  it('detach removes the listeners and resets the key handler', function () {
    const terminal = fakeTerminal();
    const element = fakeTarget();

    const detach = mod.attachClipboard(terminal, element, { clipboard: null });
    detach();

    assert.ok(!element.isListening('contextmenu'), 'contextmenu listener removed');
    assert.ok(!element.isListening('mousedown'), 'mousedown listener removed');
    // Two attaches total: the real handler, then the reset-to-passthrough on detach.
    assert.strictEqual(terminal.calls.keyHandlers.length, 2);
    assert.strictEqual(terminal.calls.keyHandlers[1](keyEvent({ ctrlKey: true, shiftKey: true, key: 'C' })), true,
      'after detach the key handler is an inert passthrough');
  });

  it('hints once when a plain drag is swallowed, then never again', function () {
    const terminal = fakeTerminal(''); // agent swallowed the drag -> no selection
    const element = fakeTarget();
    const notify = notifier();
    const hintStore = fakeHintStore();

    mod.attachClipboard(terminal, element, { clipboard: null, notify, hintStore });

    // A plain (no-Shift) drag: down, move past the threshold, up.
    element.dispatch('mousedown', mouseEvent({ button: 0, clientX: 0, clientY: 0, shiftKey: false }));
    global.document.dispatch('mousemove', mouseEvent({ clientX: 40, clientY: 0 }));
    global.document.dispatch('mouseup', mouseEvent());

    assert.strictEqual(notify.calls.length, 1);
    assert.match(notify.calls[0].message, /Shift/);
    assert.ok(hintStore.marked(), 'the hint is recorded as seen');

    // A second swallowed drag must stay silent.
    hintStore.markSeen();
    element.dispatch('mousedown', mouseEvent({ button: 0, clientX: 0, clientY: 0, shiftKey: false }));
    global.document.dispatch('mousemove', mouseEvent({ clientX: 40, clientY: 0 }));
    global.document.dispatch('mouseup', mouseEvent());
    assert.strictEqual(notify.calls.length, 1, 'the hint never repeats');
  });

  it('does not hint on a Shift+drag that actually selects', function () {
    const terminal = fakeTerminal('selected text');
    const element = fakeTarget();
    const notify = notifier();
    const hintStore = fakeHintStore();

    mod.attachClipboard(terminal, element, { clipboard: null, notify, hintStore });

    element.dispatch('mousedown', mouseEvent({ button: 0, clientX: 0, clientY: 0, shiftKey: true }));
    global.document.dispatch('mousemove', mouseEvent({ clientX: 40, clientY: 0 }));
    global.document.dispatch('mouseup', mouseEvent());

    assert.strictEqual(notify.calls.length, 0);
  });

  function dragAndUp(shiftKey, from, to) {
    const terminal = fakeTerminal(''); // swallowed by the agent -> no selection
    const element = fakeTarget();
    const notify = notifier();
    mod.attachClipboard(terminal, element, { clipboard: null, notify, hintStore: fakeHintStore() });
    element.dispatch('mousedown', mouseEvent({ button: 0, clientX: from.x, clientY: from.y, shiftKey }));
    global.document.dispatch('mousemove', mouseEvent({ clientX: to.x, clientY: to.y }));
    global.document.dispatch('mouseup', mouseEvent());
    return notify.calls.length;
  }

  it('treats a sub-threshold twitch as a click, not a drag (no hint)', function () {
    // 3px each axis, under DRAG_THRESHOLD_PX (6): this is a click, not a drag.
    assert.strictEqual(dragAndUp(false, { x: 10, y: 10 }, { x: 13, y: 12 }), 0);
  });

  it('detects a purely vertical drag (Math.abs on the Y axis)', function () {
    assert.strictEqual(dragAndUp(false, { x: 50, y: 50 }, { x: 50, y: 10 }), 1);
  });

  it('detects a leftward drag (negative delta needs Math.abs)', function () {
    assert.strictEqual(dragAndUp(false, { x: 50, y: 50 }, { x: 10, y: 50 }), 1);
  });

  it('ignores a non-primary (right) button so the contextmenu path owns it', function () {
    const terminal = fakeTerminal('');
    const element = fakeTarget();
    const notify = notifier();
    mod.attachClipboard(terminal, element, { clipboard: null, notify, hintStore: fakeHintStore() });

    element.dispatch('mousedown', mouseEvent({ button: 2, clientX: 0, clientY: 0 }));
    // No document listeners were registered for a right-button press.
    assert.ok(!global.document.isListening('mousemove'));
    assert.strictEqual(notify.calls.length, 0);
  });
});

describe('browserClipboard', function () {
  it('is null when the Clipboard API is unavailable', function () {
    global.navigator = {};
    assert.strictEqual(mod.browserClipboard(), null);
  });

  it('wraps navigator.clipboard when present', async function () {
    const written = [];
    global.navigator = {
      clipboard: {
        writeText: (t) => { written.push(t); return Promise.resolve(); },
        readText: () => Promise.resolve('X'),
      },
    };
    const clip = mod.browserClipboard();
    assert.ok(clip);
    await clip.writeText('hi');
    assert.deepStrictEqual(written, ['hi']);
    assert.strictEqual(await clip.readText(), 'X');
  });
});

describe('controller wiring (issue #19 requirement 5)', function () {
  // clipboard.ts can be perfect in isolation and copy/paste still be dead in the
  // app if createTerminalController stops calling it. controller.ts can't be
  // bundled for Node — it pulls in xterm's DOM/canvas — so this pins the wiring
  // at the source level, the way dom-contract.test.js pins the HTML it depends
  // on. Deleting the wiring turns this red instead of leaving the suite green.
  // (test/browser/checks.ts exercises the same wiring against a real controller,
  // but that suite is not run by `npm test` in CI.)
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'client', 'terminal', 'controller.ts'), 'utf8',
  );

  it('imports attachClipboard from the clipboard module', function () {
    assert.match(src, /import\s*\{[^}]*\battachClipboard\b[^}]*\}\s*from\s*['"]\.\/clipboard['"]/);
  });

  it('attaches it in open(), passing the terminal and its container', function () {
    assert.match(
      src, /attachClipboard\(\s*terminal\s*,\s*target/,
      'createTerminalController.open() must call attachClipboard(terminal, target, ...) '
        + 'or copy/paste is dead in the main terminal and every split pane',
    );
  });

  it('keeps the detach handle and invokes it in dispose()', function () {
    assert.match(src, /detachClipboard\s*=\s*attachClipboard/, 'must store the detach handle');
    assert.match(src, /detachClipboard\?\.\(\)/, 'dispose() must invoke the detach handle');
  });
});
