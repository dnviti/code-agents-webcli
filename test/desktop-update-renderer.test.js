const assert = require('assert');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const ROOT = path.join(__dirname, '..');

function state(overrides = {}) {
  return {
    provider: 'electron',
    phase: 'available',
    currentVersion: '6.1.0',
    targetVersion: '6.2.0',
    releaseName: 'Version 6.2.0',
    releaseDate: '2026-08-05T10:00:00.000Z',
    releaseNotes: 'Safer desktop updates.',
    checkedAt: '2026-08-05T10:00:00.000Z',
    progress: null,
    prompt: 'automatic',
    errorCode: null,
    errorMessage: null,
    retryable: false,
    generation: 1,
    ...overrides,
  };
}

describe('desktop update renderer controller', function () {
  let bundle;
  let mod;
  let originalWindow;

  before(function () {
    this.timeout(60000);
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    // Keep the transient bundle under the repository so external React imports
    // resolve to this project's one React instance during server rendering.
    bundle = path.join(ROOT, `.desktop-update-renderer-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(path.join(ROOT, 'src/client/ui/desktop-update'))};`,
          `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
          `export { localWorkWarning } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/DesktopUpdateDialog'))};`,
          `export { StatusBar } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/StatusBar'))};`,
          `export { BottomNav } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/BottomNav'))};`,
        ].join('\n'),
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'desktop-update-renderer.ts',
      },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      external: ['react', 'react-dom'],
      logLevel: 'silent',
    });
    mod = require(bundle);
  });

  after(function () {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    fs.rmSync(bundle, { force: true });
  });

  it('subscribes before hydration and rejects an older initial snapshot', async function () {
    let listener;
    let resolveInitial;
    const initial = new Promise((resolve) => { resolveInitial = resolve; });
    const calls = [];
    const bridge = {
      getSnapshot: () => initial,
      subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
      defer: async (version) => { calls.push(['defer', version]); return state({ generation: 3, prompt: 'deferred' }); },
      install: async (version) => {
        calls.push(['install', version]);
        return state({ generation: 4, phase: 'downloading', prompt: 'deferred', progress: { percent: 12, transferred: 12, total: 100, bytesPerSecond: 5 } });
      },
      retry: async (version) => { calls.push(['retry', version]); return state({ generation: 6, phase: 'downloading', prompt: 'deferred' }); },
    };
    globalThis.window = { desktopUpdates: bridge };

    mod.setupDesktopUpdates();
    listener(state({ generation: 2, targetVersion: '6.3.0', releaseNotes: 'Newer.' }));
    resolveInitial(state({ generation: 1 }));
    await new Promise((resolve) => setImmediate(resolve));

    let view = mod.shellStore.getSnapshot().desktopUpdate;
    assert.strictEqual(view.targetVersion, '6.3.0');
    assert.strictEqual(view.promptOpen, true);
    assert.strictEqual(view.summary, 'Newer.');

    // Continue against the current target; every command carries that exact
    // version and consumes the returned snapshot even if no event is pushed.
    bridge.defer = async (version) => { calls.push(['defer', version]); return state({ generation: 3, targetVersion: '6.3.0', prompt: 'deferred' }); };
    bridge.install = async (version) => { calls.push(['install', version]); return state({ generation: 4, targetVersion: '6.3.0', phase: 'downloading', prompt: 'deferred', progress: { percent: 12, transferred: 12, total: 100, bytesPerSecond: 5 } }); };
    await mod.deferDesktopUpdate();
    assert.strictEqual(mod.shellStore.getSnapshot().desktopUpdate.promptOpen, false);
    mod.openDesktopUpdate();
    assert.strictEqual(mod.shellStore.getSnapshot().desktopUpdate.promptOpen, true);
    await mod.installDesktopUpdate();
    view = mod.shellStore.getSnapshot().desktopUpdate;
    assert.strictEqual(view.phase, 'downloading');
    assert.strictEqual(view.progress, 12);
    assert.strictEqual(view.promptOpen, true, 'accepted download must keep the blocking dialog open');
    assert.deepStrictEqual(calls, [['defer', '6.3.0'], ['install', '6.3.0']]);
  });

  it('stays absent in a normal browser with no preload bridge', function () {
    globalThis.window = {};
    mod.setupDesktopUpdates();
    assert.strictEqual(mod.shellStore.getSnapshot().desktopUpdate, null);
  });

  it('describes Local running work for zero, one, many, and unknown counts', function () {
    assert.match(mod.localWorkWarning(0), /No Local work/);
    assert.match(mod.localWorkWarning(1), /1 running Local session will end/);
    assert.match(mod.localWorkWarning(4), /4 running Local sessions will end/);
    assert.match(mod.localWorkWarning(null), /Running Local work will end/);
  });

  it('renders semantic desktop and touch reminder buttons', function () {
    const desktop = renderToStaticMarkup(React.createElement(mod.StatusBar, {
      left: [],
      right: [{ children: 'Dark' }, { children: 'Update v6.2.0', title: 'Open update', ariaHasPopup: 'dialog', onClick() {} }],
    }));
    assert.match(desktop, /<button[^>]+aria-haspopup="dialog"/);
    assert.ok(desktop.indexOf('Dark') < desktop.indexOf('Update v6.2.0'), 'update must be the rightmost status action');

    const touch = renderToStaticMarkup(React.createElement(mod.BottomNav, {
      destinations: [{ id: 'chat', label: 'Chat', icon: 'message-square', current: true, onGo() {} }],
      trailingAction: {
        label: 'Update 6.2.0', ariaLabel: 'Update v6.2.0. Open the desktop update dialog.',
        icon: 'download', tone: 'warning', onPress() {},
      },
    }));
    assert.match(touch, /aria-label="Update v6\.2\.0\. Open the desktop update dialog\."/);
    assert.match(touch, /aria-haspopup="dialog"/);
    assert.ok(touch.indexOf('Chat') < touch.indexOf('Update 6.2.0'), 'touch update action must be last');
  });

  it('places the blocking update proposal above desktop chrome and actionable overlays', function () {
    const updateDialog = fs.readFileSync(path.join(ROOT, 'src/client/shell/DesktopUpdateDialog.tsx'), 'utf8');
    const tokens = fs.readFileSync(path.join(ROOT, 'src/public/css/relay/tokens/spacing.css'), 'utf8');
    const titleBar = fs.readFileSync(path.join(ROOT, 'src/client/shell/AppShell.tsx'), 'utf8');
    const value = (name) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(tokens)?.[1]);

    assert.match(updateDialog, /overlayZIndex="var\(--z-blocking-modal\)"/);
    assert.ok(value('blocking-modal') > value('toast'));
    assert.ok(value('blocking-modal') > value('tooltip'));
    assert.ok(value('blocking-modal') > Number(/zIndex:\s*(\d+)/.exec(titleBar)?.[1]));
  });
});
