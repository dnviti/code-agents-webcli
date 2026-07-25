const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Which keys the app takes from the browser, and — far more importantly — which
// it must not.
//
// The predicate is a pure function, so it is tested directly rather than through
// a synthesised keyboard: the cases that matter are the ones that have to come
// back false, and driving AltGr or a Super chord through a real listener proves
// much less than asserting on the decision itself.
//
// A browser-level sweep covers the other half — that the guard actually
// suppresses these in a live Monaco editor — but it needs Chrome, and the two
// mistakes this file exists to catch (swallowing a paste, eating AltGr) are the
// kind nobody notices until a user with a non-US keyboard cannot type an `@`.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const out = path.join(os.tmpdir(), `browser-shortcuts-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(path.join(ROOT, 'src/client/ui/browser-shortcuts'))};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'browser-shortcuts.ts',
    },
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

/** A KeyboardEvent-shaped object; every modifier off unless named. */
function press(key, modifiers = {}) {
  return {
    key,
    ctrlKey: Boolean(modifiers.ctrl),
    metaKey: Boolean(modifiers.meta),
    shiftKey: Boolean(modifiers.shift),
    altKey: Boolean(modifiers.alt),
  };
}

describe('claiming the browser’s shortcuts', function () {
  const claimed = (event, options) => mod.isClaimedBrowserShortcut(event, { mac: false, ...options });

  it('takes the chords a shell or an editor has a real use for', function () {
    // Every one of these is a readline binding before it is a browser menu.
    for (const key of ['b', 'd', 'e', 'f', 'g', 'h', 'j', 'k', 'l', 'o', 'p', 'r', 's', 'u']) {
      assert.ok(claimed(press(key, { ctrl: true })), `Ctrl+${key} should go to the app`);
    }
    assert.ok(claimed(press('F3')));
    assert.ok(claimed(press('ArrowLeft', { alt: true })), 'Back must not fire while typing');
    assert.ok(claimed(press('ArrowRight', { alt: true })));
  });

  it('never touches copy, paste, cut, select-all, undo or redo', function () {
    // For these the browser's default *is* the mechanism. A prevented copy is
    // a copy that did not happen.
    for (const key of ['c', 'v', 'x', 'a', 'z', 'y']) {
      assert.ok(!claimed(press(key, { ctrl: true })), `Ctrl+${key} must reach the browser`);
    }
  });

  it('leaves reload reachable from the keyboard', function () {
    // F5 and Ctrl+Shift+R are the deliberate escape hatch. Ctrl+R is claimed
    // because a shell wants it for reverse search, so without this pair there
    // would be no way to reload at all.
    assert.ok(!claimed(press('F5')));
    assert.ok(!claimed(press('r', { ctrl: true, shift: true })));
  });

  it('does not mistake AltGr for a chord', function () {
    // AltGr reports as Ctrl+Alt on Windows and Linux layouts. Claiming it would
    // stop an Italian, German or Polish keyboard from typing `@`, `#` or `[`.
    assert.ok(!claimed(press('@', { ctrl: true, alt: true })));
    assert.ok(!claimed(press('[', { ctrl: true, alt: true })));
    assert.ok(!claimed(press('e', { ctrl: true, alt: true })), 'even a claimed letter, under AltGr');
  });

  it('does not mistake Super for Command', function () {
    // Off a Mac, metaKey is the Super/Windows key and belongs to the window
    // manager. On a Mac it is Command and is exactly what to claim.
    assert.ok(!claimed(press('f', { meta: true })), 'Super+F is not the browser’s find');
    assert.ok(mod.isClaimedBrowserShortcut(press('f', { meta: true }), { mac: true }), 'Cmd+F is');
    assert.ok(!mod.isClaimedBrowserShortcut(press('f', { ctrl: true }), { mac: true }), 'Ctrl+F on a Mac is not');
  });

  it('ignores a bare key, a modifier on its own, and Shift variants', function () {
    assert.ok(!claimed(press('f')), 'typing the letter f is not a shortcut');
    assert.ok(!claimed(press('Control', { ctrl: true })));
    assert.ok(!claimed(press('Shift', { shift: true })));
    assert.ok(!claimed(press('f', { ctrl: true, shift: true })), 'Shift changes what a chord means');
    assert.ok(!claimed(press('')), 'an event with no key at all');
  });

  it('leaves the chords no page can intercept out of the table', function () {
    // Not a preference — Ctrl+T, Ctrl+W and Ctrl+N never reach a page at all.
    // Listing them as claimed would be a promise this cannot keep.
    for (const key of ['t', 'w', 'n']) {
      assert.ok(!claimed(press(key, { ctrl: true })), `Ctrl+${key} is reserved by the browser`);
    }
  });
});

describe('the shortcut guard', function () {
  /** The smallest document the guard actually uses. */
  function fakeDocument(inSurface) {
    const listeners = [];
    return {
      listeners,
      addEventListener(type, handler, capture) {
        listeners.push({ type, handler, capture });
      },
      removeEventListener(type, handler, capture) {
        const at = listeners.findIndex(
          (l) => l.type === type && l.handler === handler && l.capture === capture,
        );
        if (at >= 0) listeners.splice(at, 1);
      },
      fire(event) {
        const dispatched = {
          ...event,
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
          target: { closest: (selector) => (inSurface(selector) ? {} : null) },
        };
        for (const l of listeners) l.handler(dispatched);
        return dispatched.prevented;
      },
    };
  }

  const always = () => true;
  const never = () => false;

  it('listens in the capture phase, before anything else can act', function () {
    const doc = fakeDocument(always);
    mod.installBrowserShortcutGuard(doc, { mac: false });
    assert.strictEqual(doc.listeners.length, 1);
    assert.strictEqual(doc.listeners[0].type, 'keydown');
    assert.strictEqual(doc.listeners[0].capture, true);
  });

  it('claims a chord inside a marked surface', function () {
    const doc = fakeDocument(always);
    mod.installBrowserShortcutGuard(doc, { mac: false });
    assert.strictEqual(doc.fire(press('r', { ctrl: true })), true);
  });

  it('leaves the rest of the page alone', function () {
    // The composer, the dialogs and every ordinary text field keep the
    // browser's defaults; taking those away would be the bug, not the fix.
    const doc = fakeDocument(never);
    mod.installBrowserShortcutGuard(doc, { mac: false });
    assert.strictEqual(doc.fire(press('r', { ctrl: true })), false);
  });

  it('only ever prevents the default, so the app still receives the key', function () {
    // No stopPropagation anywhere: xterm and Monaco have to go on seeing these.
    const doc = fakeDocument(always);
    mod.installBrowserShortcutGuard(doc, { mac: false });
    let sawStop = false;
    const event = {
      ...press('r', { ctrl: true }),
      preventDefault() {},
      stopPropagation() {
        sawStop = true;
      },
      target: { closest: () => ({}) },
    };
    doc.listeners[0].handler(event);
    assert.strictEqual(sawStop, false);
  });

  it('can be uninstalled', function () {
    const doc = fakeDocument(always);
    const stop = mod.installBrowserShortcutGuard(doc, { mac: false });
    stop();
    assert.strictEqual(doc.listeners.length, 0);
  });

  it('survives an event with no usable target', function () {
    const doc = fakeDocument(always);
    mod.installBrowserShortcutGuard(doc, { mac: false });
    const event = { ...press('r', { ctrl: true }), preventDefault() {}, target: null };
    assert.doesNotThrow(() => doc.listeners[0].handler(event));
  });
});
