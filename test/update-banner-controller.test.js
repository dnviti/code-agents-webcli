const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Bundle the renderer module exactly as the browser build does. The test uses
// controlled browser globals and transport responses so it can prove target
// ownership without starting Electron or a real update.
const ROOT = path.join(__dirname, '..');
let mod;
let bundle;
let restoreGlobals;
let installBrowserGlobals;
let controllerStorage;

function updateStatus(overrides = {}) {
  return {
    state: 'behind',
    installed: {
      sha: 'a'.repeat(40), short: 'aaaaaaa', commitDate: null,
      version: '6.1.0', dirty: false, source: 'git',
    },
    remote: {
      sha: 'b'.repeat(40), short: 'bbbbbbb', commitDate: null, subject: null,
    },
    behindBy: 2,
    checkedAt: 1,
    nextCheckAllowedAt: 2,
    message: null,
    ...overrides,
  };
}

function updateResponse(mode = 'systemd', overrides = {}) {
  return {
    mode,
    canTrigger: mode !== 'desktop',
    isInstaller: true,
    running: false,
    runnerState: 'idle',
    activeSessions: 1,
    interrupted: null,
    logTail: [],
    status: updateStatus(),
    ...overrides,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor(predicate, message) {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

describe('controller-owned update banners', function () {
  before(function () {
    this.timeout(60000);

    const originals = new Map();
    const replaceGlobal = (name, value) => {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    };

    controllerStorage = new Map([['code-agents-controller-last-server', 'alpha']]);
    const windowObject = new EventTarget();
    windowObject.location = {
      origin: 'http://127.0.0.1:45678', pathname: '/', search: '', reload() {},
    };
    windowObject.confirm = () => true;
    const storageObject = {
      getItem(key) { return controllerStorage.get(key) ?? null; },
      setItem(key, value) { controllerStorage.set(key, String(value)); },
      removeItem(key) { controllerStorage.delete(key); },
    };
    const navigatorObject = { clipboard: { async writeText() {} } };
    const cachesObject = { async keys() { return []; }, async delete() { return true; } };

    // Several older client tests expose root-level hooks that replace browser
    // globals before every test in the process. Keep one installer so this
    // suite can reassert its own complete browser fixture after those hooks.
    installBrowserGlobals = () => {
      Object.defineProperty(globalThis, 'window', {
        value: windowObject, configurable: true, writable: true,
      });
      Object.defineProperty(globalThis, 'location', {
        value: windowObject.location, configurable: true, writable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        value: storageObject, configurable: true, writable: true,
      });
      Object.defineProperty(globalThis, 'navigator', {
        value: navigatorObject, configurable: true, writable: true,
      });
      Object.defineProperty(globalThis, 'caches', {
        value: cachesObject, configurable: true, writable: true,
      });
    };
    installBrowserGlobals();
    if (typeof CustomEvent === 'undefined') {
      replaceGlobal('CustomEvent', class CustomEvent extends Event {
        constructor(type, options = {}) { super(type); this.detail = options.detail; }
      });
    }

    restoreGlobals = () => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    };

    const contents = [
      `export { initializeController, selectControllerServer } from ${JSON.stringify(path.join(ROOT, 'src/client/controller/transport'))};`,
      `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
      `export { setupUpdateBanner, onBannerAction, onBannerDismiss, refresh, applyUpdateStatus, appendUpdateLog, onUpdateRestarting, onUpdateDone } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/update-banner'))};`,
    ].join('\n');
    bundle = path.join(os.tmpdir(), `update-banner-controller-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'update-banner-controller.ts' },
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
    restoreGlobals?.();
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  beforeEach(function () {
    installBrowserGlobals();
    controllerStorage.clear();
    controllerStorage.set('code-agents-controller-last-server', 'alpha');
  });

  it('keeps status, logs, actions, dismissals, events, and restart polls on their exact server', async function () {
    const bootstrap = {
      desktopController: true,
      targets: [
        { id: 'local', type: 'local', name: 'Local computer', status: 'ready' },
        { id: 'alpha', type: 'remote', name: 'Alpha', status: 'connected', signedIn: true, protocolVersion: 1 },
        { id: 'beta', type: 'remote', name: 'Beta', status: 'connected', signedIn: true, protocolVersion: 1 },
      ],
    };
    const requestCalls = [];
    const healthCalls = [];
    const scheduled = [];
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalConfirm = window.confirm;
    const responses = new Map([
      ['local', updateResponse('desktop')],
      ['alpha', updateResponse('systemd')],
      ['beta', updateResponse('systemd')],
    ]);
    let resolveApply;

    globalThis.fetch = async (input, init = {}) => {
      if (String(input) === '/api/controller/bootstrap') return json(bootstrap);
      if (String(input) === '/api/health') {
        healthCalls.push(new Headers(init.headers).get('x-controller-server-id'));
        return new Response(null, { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    };
    globalThis.setTimeout = (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    };

    const app = {
      async authFetch(url, options = {}, serverId = null) {
        requestCalls.push({ url, method: options.method || 'GET', serverId });
        if (url === '/api/update/status') return json(responses.get(serverId));
        if (url === '/api/update/apply') {
          return await new Promise((resolve) => { resolveApply = resolve; });
        }
        if (url === '/api/update/check') return json({ ok: true });
        throw new Error(`Unexpected authFetch: ${url}`);
      },
    };

    try {
      await mod.initializeController();
      mod.setupUpdateBanner(app);
      await waitFor(
        () => requestCalls.some((call) => call.url === '/api/update/status' && call.serverId === 'alpha'),
        'the initially selected target was not refreshed explicitly',
      );
      await waitFor(
        () => mod.shellStore.getSnapshot().banner?.text.includes('Server update · Alpha'),
        'Alpha did not own its initial banner',
      );
      await waitFor(
        () => /Desktop package update:/.test(mod.shellStore.getSnapshot().desktopBanner?.text || ''),
        'the desktop package channel did not load independently',
      );

      const beforeUnqualified = mod.shellStore.getSnapshot().banner.text;
      mod.applyUpdateStatus(updateStatus({ behindBy: 99 }), null);
      assert.strictEqual(
        mod.shellStore.getSnapshot().banner.text,
        beforeUnqualified,
        'an unqualified controller event must not mutate the selected target',
      );

      mod.selectControllerServer('beta');
      assert.strictEqual(mod.shellStore.getSnapshot().banner, null, 'old target copy must not be relabeled while Beta loads');
      await waitFor(
        () => mod.shellStore.getSnapshot().banner?.text.includes('Server update · Beta'),
        'Beta did not receive its own status',
      );
      assert.match(mod.shellStore.getSnapshot().desktopBanner.text, /Desktop package update:/);

      mod.applyUpdateStatus(updateStatus({ behindBy: 9 }), 'alpha');
      mod.appendUpdateLog('alpha-only-log', 'alpha');
      assert.doesNotMatch(mod.shellStore.getSnapshot().banner.text, /Alpha/);
      assert.doesNotMatch(mod.shellStore.getSnapshot().banner.log, /alpha-only-log/);

      mod.selectControllerServer('alpha');
      assert.match(mod.shellStore.getSnapshot().banner.text, /Server update · Alpha/);
      assert.match(mod.shellStore.getSnapshot().banner.log, /alpha-only-log/);

      // Capture Beta at click time, then change the global selection before its
      // request completes. The mutation must still reach Beta and must not paint
      // over Alpha when the response settles.
      mod.selectControllerServer('beta');
      await waitFor(() => /Server update · Beta/.test(mod.shellStore.getSnapshot().banner?.text || ''), 'Beta did not redraw');
      let confirmation = '';
      window.confirm = (text) => { confirmation = text; return true; };
      const applying = mod.onBannerAction();
      await waitFor(() => typeof resolveApply === 'function', 'the apply request was not started');
      mod.selectControllerServer('alpha');
      resolveApply(new Response(null, { status: 202 }));
      await applying;
      assert.match(confirmation, /newer build on Beta/);
      assert.ok(requestCalls.some((call) => (
        call.url === '/api/update/apply' && call.serverId === 'beta'
      )), 'apply must carry the owner captured by the button');
      assert.match(mod.shellStore.getSnapshot().banner.text, /Server update · Alpha/);

      const timersBeforeUnqualified = scheduled.length;
      mod.onUpdateRestarting(null);
      assert.strictEqual(scheduled.length, timersBeforeUnqualified, 'unqualified restart must be ignored');
      mod.onUpdateRestarting('alpha');
      const restartTick = scheduled.slice(timersBeforeUnqualified)
        .find((entry) => entry.milliseconds === 2000);
      assert.ok(restartTick, 'qualified restart must start a poll');
      restartTick.callback();
      await waitFor(() => healthCalls.length > 0, 'restart poll did not reach health');
      assert.ok(
        healthCalls.includes('alpha'),
        `health polling must carry the restarting server id (saw ${JSON.stringify(healthCalls)})`,
      );

      // A desktop-mode response names the package, not Local computer's server,
      // and dismissing it must not hide another server at the same remote SHA.
      mod.selectControllerServer('local');
      assert.strictEqual(mod.shellStore.getSnapshot().banner, null, 'the previous remote notice must leave the server channel');
      await waitFor(
        () => /Desktop package update:/.test(mod.shellStore.getSnapshot().desktopBanner?.text || ''),
        'desktop package notice was not distinguished',
      );
      assert.doesNotMatch(mod.shellStore.getSnapshot().desktopBanner.text, /Server update/);
      mod.onBannerDismiss('local');
      assert.strictEqual(mod.shellStore.getSnapshot().desktopBanner, null);

      responses.set('beta', updateResponse('systemd'));
      await mod.refresh(app, 'beta');
      mod.selectControllerServer('beta');
      await waitFor(
        () => /Server update · Beta/.test(mod.shellStore.getSnapshot().banner?.text || ''),
        'Local dismissal incorrectly hid Beta at the same SHA',
      );

      responses.set('beta', updateResponse('systemd', {
        status: updateStatus({ state: 'offline', message: 'GitHub is unavailable.' }),
      }));
      await mod.refresh(app, 'beta');
      await mod.onBannerAction();
      assert.ok(requestCalls.some((call) => (
        call.url === '/api/update/check' && call.serverId === 'beta'
      )), 'retry must carry the banner owner explicitly');
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      window.confirm = originalConfirm;
    }
  });

  it('passes gateway-qualified ownership from every update WebSocket message', function () {
    const source = fs.readFileSync(
      path.join(ROOT, 'src/client/terminal/message-handler.ts'),
      'utf8',
    );
    for (const call of [
      'applyUpdateStatus(message.status, routedServerId)',
      'appendUpdateLog(message.data, routedServerId)',
      'onUpdateRestarting(routedServerId)',
      'onUpdateDone(this.app, message, routedServerId)',
    ]) {
      assert.ok(source.includes(call), `${call} must retain its gateway server id`);
    }
  });
});
