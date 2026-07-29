const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// paste.ts never reaches dist/ on its own — esbuild folds it into
// app.bundle.js for the browser — so this bundles it for Node and drives the
// real paste and drop listeners.
//
// What it exists to pin is WHICH way an uploaded image path leaves the client.
// Issue #18 was closed as completed with the path still going out through
// sendText, a raw {type:'input'} socket write that reaches the PTY verbatim:
// no bracketed-paste markers, so the agent sees an absolute path typed at the
// prompt instead of an image attachment. Every existing test was blind to the
// difference, which is how the regression survived a fix.

const ROOT = path.join(__dirname, '..');

let mod;

// The upload chain is three awaits deep and touches no timer, so draining the
// microtask queue once is enough; the loop is cheap insurance.
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Serves one insertText per upload, in call order. */
function stubUploads(paths) {
  const queue = paths.slice();
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, body: init.body });
    const insertText = queue.shift();
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ insertText }),
    });
  };
  return calls;
}

function fakeElement() {
  const handlers = {};
  const classes = new Set();
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (handlers[type]) handlers[type] = handlers[type].filter((h) => h !== fn);
    },
    dispatch(type, event) { (handlers[type] || []).slice().forEach((fn) => fn(event)); },
  };
}

/**
 * An ImagePasteTarget that records the two ways out separately.
 *
 * `sendText` is the raw socket write the paths used to leave by. It is gone
 * from the interface now, so reaching for it again would not compile — but the
 * fake still offers it, and every assertion still says it stayed empty, so the
 * thing the suite is about is visible in the suite rather than only in a type.
 */
function fakeTarget(overrides = {}) {
  const calls = { sendText: [], pasteText: [] };
  return {
    calls,
    element: fakeElement(),
    getSessionId: () => 'sess-1',
    sendText(text) { calls.sendText.push(text); },
    pasteText(text) { calls.pasteText.push(text); },
    isConnected: () => true,
    ...overrides,
  };
}

function imageFile(name = 'screenshot.png', size = 4096, type = 'image/png') {
  return { name, size, type };
}

function pasteEvent(files, text = '') {
  const event = {
    prevented: false,
    stopped: false,
    clipboardData: { files, items: [], getData: () => text },
  };
  event.preventDefault = () => { event.prevented = true; };
  event.stopPropagation = () => { event.stopped = true; };
  return event;
}

function dropEvent(files) {
  const event = {
    prevented: false,
    dataTransfer: { types: ['Files'], files, items: [] },
  };
  event.preventDefault = () => { event.prevented = true; };
  event.stopPropagation = () => {};
  return event;
}

const SENT_RAW = 'issue #18: the image path went out through sendText, an unbracketed raw '
  + 'socket write — the agent reads it as text typed at the prompt, not as an attachment';

describe('image paste injection (issue #18)', function () {
  // Every hook is scoped to this suite. A hook declared at the top level of a
  // file is a *root* hook: mocha runs it around every test in the whole run,
  // so the stub below would answer for the thirteen suites that fetch against
  // their own local server, and the teardown would take Node's real `fetch`
  // away from them. tab-manager-state.test.js already had to learn that once.
  let realFetch;

  before(function () {
    this.timeout(60000);
    const contents = [
      `export * from ${JSON.stringify(path.join(ROOT, 'src/client/terminal/paste'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `terminal-paste-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'paste.ts' },
      bundle: true,
      outfile: out,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(out);
    mod.__file = out;
    realFetch = global.fetch;
  });

  after(function () {
    if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
  });

  beforeEach(function () {
    global.fetch = () => Promise.reject(new Error('no upload was expected'));
  });

  // Restored, never deleted: `delete global.fetch` would strip the runtime's
  // own implementation for whatever runs next.
  afterEach(function () {
    if (realFetch === undefined) delete global.fetch;
    else global.fetch = realFetch;
  });

  it('injects the uploaded path through pasteText, never sendText', async function () {
    const target = fakeTarget();
    stubUploads(['/srv/work/.cc-web/pasted/screenshot.png ']);
    mod.attachImagePaste(target);

    target.element.dispatch('paste', pasteEvent([imageFile()]));
    await settle();

    assert.deepStrictEqual(target.calls.sendText, [], SENT_RAW);
    assert.deepStrictEqual(target.calls.pasteText, ['/srv/work/.cc-web/pasted/screenshot.png ']);
  });

  it('injects a dropped image the same way', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-drop' });
    stubUploads(['/srv/work/.cc-web/pasted/dropped.png ']);
    mod.attachImageDrop(target);

    target.element.dispatch('drop', dropEvent([imageFile('dropped.png')]));
    await settle();

    assert.deepStrictEqual(target.calls.sendText, [], SENT_RAW);
    assert.deepStrictEqual(target.calls.pasteText, ['/srv/work/.cc-web/pasted/dropped.png ']);
  });

  it('keeps clipboard order across several images, all through pasteText', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-many' });
    stubUploads(['/one.png ', '/two.png ', '/three.png ']);
    mod.attachImagePaste(target);

    target.element.dispatch('paste', pasteEvent([imageFile('a.png'), imageFile('b.png'), imageFile('c.png')]));
    await settle();

    assert.deepStrictEqual(target.calls.sendText, [], SENT_RAW);
    assert.deepStrictEqual(target.calls.pasteText, ['/one.png ', '/two.png ', '/three.png ']);
  });

  it('puts the caption of a mixed paste after the path, both bracketed', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-mixed' });
    stubUploads(['/srv/work/.cc-web/pasted/shot.png ']);
    mod.attachImagePaste(target);

    target.element.dispatch('paste', pasteEvent([imageFile()], 'what is wrong here?'));
    await settle();

    assert.deepStrictEqual(target.calls.sendText, [], SENT_RAW);
    assert.deepStrictEqual(
      target.calls.pasteText,
      ['/srv/work/.cc-web/pasted/shot.png ', 'what is wrong here?'],
      'the caret must end after the user\'s own words',
    );
  });

  it('injects nothing at all when the session changed during the upload', async function () {
    // The guard around the injection has to keep working whichever call it
    // guards: a path landing in another session's terminal is worse than none.
    let sessionId = 'sess-before';
    const target = fakeTarget({ getSessionId: () => sessionId });
    global.fetch = () => {
      sessionId = 'sess-after';
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ insertText: '/late.png ' }),
      });
    };
    mod.attachImagePaste(target);

    target.element.dispatch('paste', pasteEvent([imageFile()], 'trailing'));
    await settle();

    assert.deepStrictEqual(target.calls.pasteText, []);
    assert.deepStrictEqual(target.calls.sendText, []);
  });

  it('injects nothing when the socket dropped while the upload was in flight', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-offline', isConnected: () => false });
    stubUploads(['/orphan.png ']);
    mod.attachImagePaste(target);

    target.element.dispatch('paste', pasteEvent([imageFile()]));
    await settle();

    assert.deepStrictEqual(target.calls.pasteText, []);
    assert.deepStrictEqual(target.calls.sendText, []);
    assert.strictEqual(
      target.element.classList.contains('terminal-upload-active'), false,
      'the busy class must be cleared even when nothing is injected',
    );
  });

  it('still delivers the text half when the image half is refused', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-oversize' });
    mod.attachImagePaste(target);

    // Over MAX_IMAGE_BYTES: no upload happens, but the caption must survive.
    target.element.dispatch(
      'paste',
      pasteEvent([imageFile('huge.png', mod.MAX_IMAGE_BYTES + 1)], 'look at this'),
    );
    await settle();

    assert.deepStrictEqual(target.calls.pasteText, ['look at this']);
    assert.deepStrictEqual(target.calls.sendText, [], SENT_RAW);
  });

  it('leaves a text-only paste entirely to xterm', async function () {
    const target = fakeTarget({ getSessionId: () => 'sess-text' });
    mod.attachImagePaste(target);

    const event = pasteEvent([], 'plain text');
    target.element.dispatch('paste', event);
    await settle();

    assert.strictEqual(event.prevented, false, 'xterm owns an ordinary paste');
    assert.deepStrictEqual(target.calls.pasteText, [], 'must not double-paste the text');
    assert.deepStrictEqual(target.calls.sendText, []);
  });
});
