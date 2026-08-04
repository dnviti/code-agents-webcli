const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The loader for the on-demand editor chunk (issue #77).
//
// What broke there was not the editor but the loading of it: the script and the
// stylesheet are two requests that fail independently, and the loader took the
// second one on trust. One failed CSS fetch left a dead <link> in the head that
// every later attempt read as success, so Monaco was created with none of its
// own rules — lines drawn in the recycler's order instead of the file's, and
// its hidden input area showing up as a bare resizable textarea over line one.
//
// So these tests are about the *contract*: nothing here may report a loaded
// editor unless its stylesheet is actually in effect on the document.

const ROOT = path.join(__dirname, '..');

let bundle;
const pendingDomTimers = new Set();

function deferDom(callback) {
  const timer = setTimeout(() => {
    pendingDomTimers.delete(timer);
    callback();
  }, 0);
  pendingDomTimers.add(timer);
}

before(function () {
  this.timeout(60000);
  bundle = path.join(os.tmpdir(), `chat-monaco-loader-${process.pid}.js`);
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src', 'client', 'chat', 'monaco.ts')],
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

/**
 * Enough of a document to load an asset against.
 *
 * Hand-rolled rather than jsdom because the whole question is what the *layout
 * engine* says about one CSS rule, which jsdom does not answer either — so a
 * fake that answers it explicitly is the honest version, and the browser check
 * added alongside these is what covers the real engine.
 */
function fakeDom(options = {}) {
  const requests = [];
  const nodes = { head: [], body: [] };
  // What `getComputedStyle` will say about a `.view-line` inside a
  // `.monaco-editor`: `absolute` once a stylesheet that carries Monaco's rules
  // has actually loaded.
  let applied = false;

  const element = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      style: { cssText: '' },
      children: [],
      parent: null,
      onload: null,
      onerror: null,
      setAttribute() {},
      appendChild(child) {
        child.parent = node;
        node.children.push(child);
        return child;
      },
      remove() {
        for (const list of [nodes.head, nodes.body]) {
          const at = list.indexOf(node);
          if (at !== -1) list.splice(at, 1);
        }
      },
    };
    return node;
  };

  const document = {
    head: {
      appendChild(node) {
        nodes.head.push(node);
        if (node.tagName === 'LINK') {
          requests.push({ kind: 'style', href: node.href, node });
          if (options.styleFails) deferDom(() => node.onerror?.());
          else deferDom(() => { applied = true; node.onload?.(); });
        }
        if (node.tagName === 'SCRIPT') {
          requests.push({ kind: 'script', src: node.src, node });
          if (options.scriptFails) deferDom(() => node.onerror?.());
          else deferDom(() => { global.window[GLOBAL] = MODULE; node.onload?.(); });
        }
        return node;
      },
    },
    body: {
      appendChild(node) {
        nodes.body.push(node);
        return node;
      },
    },
    documentElement: { classList: { contains: () => false } },
    createElement: element,
    querySelector(selector) {
      if (!selector.startsWith('link')) return null;
      return nodes.head.find((node) => node.tagName === 'LINK') || null;
    },
  };

  const GLOBAL = 'ClaudeCodeWebMonaco';
  const MODULE = { create: () => ({}) };

  global.document = document;
  global.window = {};
  global.getComputedStyle = (node) => ({
    // Answered the way the real cascade would: the rule is
    // `.monaco-editor .view-line { position: absolute }`, so it applies only to
    // a `.view-line` and only once the stylesheet is in effect.
    position: applied && node.className === 'view-line' ? 'absolute' : 'static',
    getPropertyValue: () => '',
  });

  return {
    requests,
    nodes,
    module: MODULE,
    /** Serve the stylesheet from now on, whatever it did before. */
    heal() {
      options.styleFails = false;
    },
  };
}

function load() {
  delete require.cache[require.resolve(bundle)];
  return require(bundle);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the editor chunk is not reported loaded without its stylesheet', function () {
  let saved;

  beforeEach(function () {
    // Re-stubbed per test rather than once: another suite's root-level
    // afterEach deletes these globals out from under this one.
    saved = {
      document: global.document,
      window: global.window,
      getComputedStyle: global.getComputedStyle,
    };
  });

  afterEach(function () {
    // A failed request can settle Promise.all before its sibling timer fires.
    // Do not let that fake request escape into the next suite after its globals
    // have been restored.
    for (const timer of pendingDomTimers) clearTimeout(timer);
    pendingDomTimers.clear();
    global.document = saved.document;
    global.window = saved.window;
    global.getComputedStyle = saved.getComputedStyle;
  });

  it('a failed stylesheet is refused rather than reported as loaded', async function () {
    const dom = fakeDom({ styleFails: true });
    const { loadMonaco } = load();

    await assert.rejects(loadMonaco(), /stylesheet|editor/i, 'a chunk without its rules is not an editor');
    assert.strictEqual(
      dom.nodes.head.filter((node) => node.tagName === 'LINK').length,
      0,
      'and the link that failed must not be left behind to be mistaken for a good one',
    );
  });

  it('a later open really requests the stylesheet again', async function () {
    const dom = fakeDom({ styleFails: true });
    const { loadMonaco } = load();

    await assert.rejects(loadMonaco());
    dom.heal();

    const mod = await loadMonaco();
    assert.ok(mod && typeof mod.create === 'function', 'the second open gets a working editor');
    assert.strictEqual(
      dom.requests.filter((r) => r.kind === 'style').length,
      2,
      'the stylesheet was fetched again instead of assumed from the previous attempt',
    );
  });

  it('the loaded script alone is not enough to hand the editor over', async function () {
    // The exact shape of the report: the script publishes the global, so after
    // a blip that took only the stylesheet the page holds a perfectly good
    // `window.ClaudeCodeWebMonaco` and an editor that cannot render.
    const dom = fakeDom({ styleFails: true });
    const { loadMonaco } = load();

    await assert.rejects(loadMonaco());
    // The script's own request outlives the rejection — that is the whole
    // hazard: it finishes, publishes the global, and looks like success.
    await settle();
    assert.ok(global.window.ClaudeCodeWebMonaco, 'the script did load, and said so');

    await assert.rejects(loadMonaco(), 'but the editor is still refused while its rules are missing');
    assert.strictEqual(
      dom.requests.filter((r) => r.kind === 'script').length,
      1,
      'and it is not re-downloaded to be told the same thing',
    );
  });

  it('hands the editor over once both have arrived', async function () {
    const dom = fakeDom();
    const { loadMonaco } = load();

    const mod = await loadMonaco();
    assert.ok(mod && typeof mod.create === 'function');
    assert.strictEqual(dom.requests.filter((r) => r.kind === 'style').length, 1);
    assert.strictEqual(dom.requests.filter((r) => r.kind === 'script').length, 1);

    // The cached path, taken by every open after the first.
    const again = await loadMonaco();
    assert.strictEqual(again, mod, 'the same module, without a second download');
    assert.strictEqual(dom.requests.length, 2, 'nothing was fetched twice');
  });

  it('reports whether Monaco own rules are in effect', async function () {
    const dom = fakeDom();
    const { loadMonaco, monacoStylesApplied } = load();

    assert.strictEqual(monacoStylesApplied(), false, 'nothing has been loaded yet');
    await loadMonaco();
    await settle();
    assert.strictEqual(monacoStylesApplied(), true, 'the stylesheet is live');
    assert.strictEqual(
      dom.nodes.body.length,
      0,
      'and the element it asks the question with is not left in the page',
    );
  });

  it('a failed script is still a failure, stylesheet or not', async function () {
    fakeDom({ scriptFails: true });
    const { loadMonaco } = load();
    await assert.rejects(loadMonaco(), /editor/i);
  });
});
