const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let api;

before(function () {
  const out = path.join(os.tmpdir(), `window-controls-overlay-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(ROOT, 'src/client/shell/window-controls-overlay'))};`,
        `export { isInstalled } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/install-prompt'))};`,
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'window-controls-overlay.ts',
      loader: 'ts',
    },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  api = require(out);
  api.__file = out;
});

after(function () {
  if (api?.__file) fs.rmSync(api.__file, { force: true });
});

function overlay(rect, visible = true) {
  const listeners = new Set();
  return {
    visible,
    getTitlebarAreaRect: () => rect,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    emit(nextRect) {
      rect = nextRect;
      for (const listener of listeners) listener({ type: 'geometrychange', titlebarAreaRect: nextRect });
    },
    listenerCount: () => listeners.size,
  };
}

describe('Window Controls Overlay', function () {
  it('fails silently when unsupported and sanitizes malformed geometry', function () {
    assert.deepStrictEqual(
      api.readWindowControlsOverlay(null),
      { visible: false, x: 0, y: 0, width: 0, height: 0 },
    );
    assert.deepStrictEqual(
      api.readWindowControlsOverlay(overlay({ x: -4, y: NaN, width: Infinity, height: 40 })),
      { visible: false, x: 0, y: 0, width: 0, height: 0 },
    );
  });

  it('publishes left/right geometry and follows live geometrychange toggles', function () {
    const source = overlay({ x: 144, y: 0, width: 880, height: 40 });
    const seen = [];
    const stop = api.watchWindowControlsOverlay(source, (state) => seen.push({ ...state }));
    assert.deepStrictEqual(seen.at(-1), { visible: true, x: 144, y: 0, width: 880, height: 40 });

    source.emit({ x: 0, y: 2, width: 930, height: 42 });
    assert.deepStrictEqual(seen.at(-1), { visible: true, x: 0, y: 2, width: 930, height: 42 });

    source.visible = false;
    source.emit({ x: 0, y: 0, width: 0, height: 0 });
    assert.deepStrictEqual(seen.at(-1), { visible: false, x: 0, y: 0, width: 0, height: 0 });
    stop();
    assert.strictEqual(source.listenerCount(), 0);
  });

  it('publishes safe CSS geometry without assuming which side owns native controls', function () {
    const values = new Map();
    const root = {
      dataset: {},
      style: { setProperty: (name, value) => values.set(name, value) },
    };
    api.publishWindowControlsOverlayToDocument(
      { visible: true, x: 112, y: 3, width: 900, height: 41 },
      root,
    );
    assert.strictEqual(root.dataset.windowControlsOverlay, 'visible');
    assert.strictEqual(values.get('--window-controls-x'), '112px');
    assert.strictEqual(values.get('--window-controls-width'), '900px');
    assert.strictEqual(values.get('--window-controls-bottom'), '44px');
  });

  it('recognizes an installed WCO window before standalone fallbacks', function () {
    const queries = [];
    const installed = api.isInstalled(
      { matchMedia(query) { queries.push(query); return { matches: query.includes('window-controls-overlay') }; } },
      {},
    );
    assert.strictEqual(installed, true);
    assert.deepStrictEqual(queries, ['(display-mode: window-controls-overlay)']);
  });

  it('covers startup, auth/setup/error, and offline recovery surfaces', function () {
    const index = fs.readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8');
    const relay = fs.readFileSync(path.join(ROOT, 'src/public/css/relay/relay.css'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'src/server/services/auth.ts'), 'utf8');
    const worker = fs.readFileSync(path.join(ROOT, 'src/public/service-worker.js'), 'utf8');
    assert.match(index, /id="bootTitlebar"[\s\S]*data-window-drag="true"/);
    assert.match(relay, /data-window-controls-overlay="hidden"[^}]*boot-titlebar[^{]*\{[^}]*display: none/);
    assert.match(auth, /id="authTitlebar"/);
    assert.match(auth, /geometrychange/);
    assert.match(worker, /Offline · Code Agents[\s\S]*windowControlsOverlay/);
  });
});
