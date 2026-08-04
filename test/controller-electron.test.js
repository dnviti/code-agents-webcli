'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_REJECTED,
  CHROMIUM_DEFAULT,
  createCertificateVerifyProc,
  createElectronControllerSessions,
  createHardenedOAuthWindow,
  isAllowedOAuthNavigation,
  parseSetCookie,
  partitionForServer,
} = require('../desktop/controller-electron.js');

const FIRST_FINGERPRINT = Array(32).fill('11').join(':');
const SECOND_FINGERPRINT = Array(32).fill('22').join(':');

class MockCookies {
  constructor() {
    this.available = [];
    this.getCalls = [];
    this.setCalls = [];
    this.removeCalls = [];
    this.flushes = 0;
    this.rejectedNames = new Set();
  }
  async get(filter) { this.getCalls.push(filter); return this.available; }
  async set(details) {
    if (this.rejectedNames.has(details.name)) throw new Error('Chromium rejected this fixture');
    this.setCalls.push(details);
  }
  async remove(url, name) { this.removeCalls.push([url, name]); }
  async flushStore() { this.flushes += 1; }
}

class MockSession extends EventEmitter {
  constructor(partition) {
    super();
    this.partition = partition;
    this.cookies = new MockCookies();
    this.certificateProcs = [];
    this.closedConnections = 0;
    this.clearedStorage = 0;
    this.clearedData = 0;
    this.clearedAuth = 0;
    this.clearedCache = 0;
    this.webRequest = {
      onBeforeRequest: (listener) => { this.beforeRequest = listener; },
    };
  }
  setCertificateVerifyProc(proc) { this.certificateProcs.push(proc); this.certificateProc = proc; }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  async closeAllConnections() { this.closedConnections += 1; }
  async clearStorageData() { this.clearedStorage += 1; }
  async clearData() { this.clearedData += 1; }
  async clearAuthCache() { this.clearedAuth += 1; }
  async clearCache() { this.clearedCache += 1; }
}

function mockElectronSessions() {
  const calls = [];
  return {
    calls,
    fromPartition(partition, options) {
      const ses = new MockSession(partition);
      calls.push({ partition, options, session: ses });
      return ses;
    },
  };
}

class MockWebContents extends EventEmitter {
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
}

class MockBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new MockWebContents();
    this.destroyed = false;
    MockBrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  show() { this.shown = true; }
  focus() { this.focused = true; }
}

function target(id, origin = 'https://remote.example') {
  return { id, name: id, origin };
}

function certificateRequest(hostname, fingerprint, verificationResult = 'CERT_AUTHORITY_INVALID') {
  return {
    hostname,
    verificationResult,
    errorCode: verificationResult === 'OK' ? 0 : -202,
    certificate: { fingerprint },
  };
}

function verify(proc, request) {
  let result;
  proc(request, (value) => { result = value; });
  return result;
}

describe('Electron remote controller sessions', function () {
  beforeEach(function () { MockBrowserWindow.instances.length = 0; });

  it('uses deterministic opaque persistent partitions and one session per stable server id', function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({
      session: electronSessions,
      BrowserWindow: MockBrowserWindow,
    });
    const first = manager.forServer(target('server/one'));
    const again = manager.forServer(target('server/one'));
    const second = manager.forServer(target('server/two'));

    assert.strictEqual(first, again);
    assert.strictEqual(electronSessions.calls.length, 2);
    assert.strictEqual(first.partition, partitionForServer('server/one'));
    assert.match(first.partition, /^persist:code-agents-controller-[a-f0-9]{64}$/);
    assert.ok(!first.partition.includes('server/one'));
    assert.notStrictEqual(first.partition, second.partition);
    assert.deepStrictEqual(electronSessions.calls.map((call) => call.options), [
      { cache: true }, { cache: true },
    ]);
  });

  it('reads and writes cookies only through the selected server partition', async function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({ session: electronSessions, now: () => 1_000 });
    const one = manager.forServer(target('one'));
    const two = manager.forServer(target('two', 'https://other.example'));
    one.session.cookies.available = [{ name: 'one', value: 'secret' }];
    two.session.cookies.available = [{ name: 'two', value: 'different' }];

    assert.deepStrictEqual(
      await one.cookieProvider('https://remote.example', 'https://remote.example/api/private'),
      [{ name: 'one', value: 'secret' }],
    );
    assert.deepStrictEqual(
      await two.cookieProvider('https://other.example', 'https://other.example/api/private'),
      [{ name: 'two', value: 'different' }],
    );
    assert.deepStrictEqual(one.session.cookies.getCalls, [{ url: 'https://remote.example/api/private' }]);
    assert.deepStrictEqual(two.session.cookies.getCalls, [{ url: 'https://other.example/api/private' }]);
    await assert.rejects(
      () => one.cookieProvider('https://remote.example', 'https://other.example/api/private'),
      /crossed its server boundary/,
    );
    await one.cookieProvider('https://remote.example', 'wss://remote.example/socket');
    assert.deepStrictEqual(one.session.cookies.getCalls[1], { url: 'https://remote.example/socket' });
  });

  it('maps repeated Set-Cookie fields, expiry and deletion without domain widening', async function () {
    const electronSessions = mockElectronSessions();
    const adapter = createElectronControllerSessions({
      session: electronSessions,
      now: () => 1_000,
    }).forServer(target('one'));

    const result = await adapter.cookieSink(
      'https://remote.example',
      [
        'session=abc; Domain=remote.example; Path=/api; Secure; HttpOnly; SameSite=None; Max-Age=60',
        'old=gone; Path=/private; Max-Age=0',
        'wide=no; Domain=example; Secure',
        'bad=header\r\nInjected: yes',
      ],
      'https://remote.example/api/login',
    );

    assert.deepStrictEqual(result, { set: 1, removed: 1, ignored: 2 });
    assert.deepStrictEqual(adapter.session.cookies.setCalls, [{
      url: 'https://remote.example/api',
      name: 'session',
      value: 'abc',
      path: '/api',
      secure: true,
      httpOnly: true,
      expirationDate: 1_060,
      sameSite: 'no_restriction',
    }]);
    assert.ok(!Object.hasOwn(adapter.session.cookies.setCalls[0], 'domain'));
    assert.deepStrictEqual(adapter.session.cookies.removeCalls, [
      ['https://remote.example/private', 'old'],
    ]);
    assert.strictEqual(adapter.session.cookies.flushes, 1);
  });

  it('parses default paths and Expires according to the response URL', function () {
    const parsed = parseSetCookie(
      'remember=yes; Expires=Wed, 21 Oct 2037 07:28:00 GMT; SameSite=Strict',
      'https://remote.example/one/two',
      1_000,
    );
    assert.strictEqual(parsed.details.path, '/one');
    assert.strictEqual(parsed.details.url, 'https://remote.example/one');
    assert.strictEqual(parsed.details.sameSite, 'strict');
    assert.ok(parsed.details.expirationDate > 1_000);
    assert.strictEqual(parsed.remove, false);
  });

  it('ignores malformed or Electron-rejected cookies and continues with later fields', async function () {
    const electronSessions = mockElectronSessions();
    const adapter = createElectronControllerSessions({ session: electronSessions })
      .forServer(target('one'));
    adapter.session.cookies.rejectedNames.add('rejected');
    const result = await adapter.cookieSink(
      'https://remote.example',
      [
        'unicode=café; Secure',
        'none=unsafe; SameSite=None',
        '__Host-bad=domain; Domain=remote.example; Path=/; Secure',
        '__Secure-bad=insecure',
        'rejected=value; Secure',
        'valid=value; Secure; SameSite=Lax',
      ],
      'https://remote.example/login',
    );
    assert.deepStrictEqual(result, { set: 1, removed: 0, ignored: 5 });
    assert.strictEqual(adapter.session.cookies.setCalls[0].name, 'valid');
  });

  it('clears cookies, site storage, HTTP auth, cache, and live connections in only that partition', async function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({ session: electronSessions });
    const one = manager.forServer(target('one'));
    const two = manager.forServer(target('two', 'https://other.example'));

    await one.clearServerData();
    assert.strictEqual(one.session.clearedStorage, 0);
    assert.strictEqual(one.session.clearedData, 1);
    assert.strictEqual(one.session.clearedAuth, 1);
    assert.strictEqual(one.session.clearedCache, 1);
    assert.strictEqual(one.session.closedConnections, 2);
    assert.strictEqual(two.session.clearedStorage, 0);
    assert.strictEqual(two.session.closedConnections, 0);
  });

  it('clears a persistent partition even when it was not opened in this process', async function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({ session: electronSessions });
    await manager.clearServerData('saved-but-unopened');
    const cleared = electronSessions.calls[0];
    assert.strictEqual(cleared.partition, partitionForServer('saved-but-unopened'));
    assert.strictEqual(cleared.session.clearedData, 1);
    assert.strictEqual(cleared.session.clearedAuth, 1);
    assert.strictEqual(cleared.session.closedConnections, 2);
  });

  it('drops live trust state when a server is removed', async function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({ session: electronSessions });
    const oldAdapter = manager.forServer({
      ...target('one'),
      certificateOverride: { origin: 'https://remote.example', fingerprint: FIRST_FINGERPRINT },
    });
    const oldSession = oldAdapter.session;
    await manager.removeServer('one');
    assert.strictEqual(oldSession.certificateProc, null);
    assert.throws(() => oldAdapter.session, /no longer usable/);
    await assert.rejects(
      () => oldAdapter.refreshCertificateApproval(target('one')),
      /no longer usable/,
    );
    assert.throws(() => oldAdapter.runOAuthFlow(), /no longer usable/);
    const replacement = manager.forServer(target('one'));
    assert.notStrictEqual(replacement, oldAdapter);
    assert.strictEqual(replacement.approvedFingerprint, null);
  });

  it('refreshes harmless renamed metadata without retaining an old server label', function () {
    const electronSessions = mockElectronSessions();
    const manager = createElectronControllerSessions({ session: electronSessions });
    const adapter = manager.forServer({ ...target('one'), name: 'Old label' });
    assert.strictEqual(manager.forServer({ ...target('one'), name: 'New label' }), adapter);
    assert.strictEqual(adapter.target.name, 'New label');
  });

  describe('per-partition certificate verification', function () {
    it('delegates valid target and every non-target hostname to Chromium', function () {
      const configuration = {
        origin: 'https://remote.example',
        approvedFingerprint: FIRST_FINGERPRINT,
      };
      const proc = createCertificateVerifyProc(() => configuration);
      assert.strictEqual(verify(proc, certificateRequest('remote.example', FIRST_FINGERPRINT, 'OK')), CHROMIUM_DEFAULT);
      assert.strictEqual(verify(proc, certificateRequest('github.com', FIRST_FINGERPRINT)), CHROMIUM_DEFAULT);
      assert.strictEqual(verify(proc, certificateRequest('assets.example', FIRST_FINGERPRINT)), CHROMIUM_DEFAULT);
    });

    it('accepts only the exact invalid target pin and rejects a replacement', function () {
      let configuration = {
        origin: 'https://remote.example',
        approvedFingerprint: FIRST_FINGERPRINT,
      };
      const proc = createCertificateVerifyProc(() => configuration);
      assert.strictEqual(verify(proc, certificateRequest('remote.example', FIRST_FINGERPRINT)), CERTIFICATE_ACCEPTED);
      assert.strictEqual(verify(proc, certificateRequest('remote.example', SECOND_FINGERPRINT)), CERTIFICATE_REJECTED);
      configuration = { ...configuration, approvedFingerprint: SECOND_FINGERPRINT };
      assert.strictEqual(verify(proc, certificateRequest('remote.example', FIRST_FINGERPRINT)), CERTIFICATE_REJECTED);
      assert.strictEqual(verify(proc, certificateRequest('remote.example', SECOND_FINGERPRINT)), CERTIFICATE_ACCEPTED);
    });

    it('refreshes approval without a process-wide switch and clears the connection cache', async function () {
      const electronSessions = mockElectronSessions();
      const manager = createElectronControllerSessions({ session: electronSessions });
      const adapter = manager.forServer({
        ...target('one'),
        certificateOverride: { origin: 'https://remote.example', fingerprint: FIRST_FINGERPRINT },
      });
      const oldProc = adapter.session.certificateProc;
      await adapter.refreshCertificateApproval({
        ...target('one'),
        certificateOverride: { origin: 'https://remote.example', fingerprint: SECOND_FINGERPRINT },
      });
      assert.notStrictEqual(adapter.session.certificateProc, oldProc);
      assert.strictEqual(adapter.session.closedConnections, 3);
      assert.strictEqual(
        verify(adapter.session.certificateProc, certificateRequest('remote.example', SECOND_FINGERPRINT)),
        CERTIFICATE_ACCEPTED,
      );
      assert.strictEqual(
        verify(adapter.session.certificateProc, certificateRequest('github.com', SECOND_FINGERPRINT)),
        CHROMIUM_DEFAULT,
      );
    });

    it('clears the old account and trust context before an address replacement', async function () {
      const electronSessions = mockElectronSessions();
      const adapter = createElectronControllerSessions({ session: electronSessions })
        .forServer(target('one'));
      await adapter.refreshCertificateApproval(target('one', 'https://replacement.example'));
      assert.strictEqual(adapter.target.origin, 'https://replacement.example');
      assert.strictEqual(adapter.session.clearedData, 1);
      assert.strictEqual(adapter.session.clearedAuth, 1);
      assert.strictEqual(adapter.session.closedConnections, 4);
    });

    it('routes manager-level address refresh directly to an existing adapter', async function () {
      const electronSessions = mockElectronSessions();
      const manager = createElectronControllerSessions({ session: electronSessions });
      const adapter = manager.forServer(target('one'));
      const refreshed = await manager.refreshCertificateApproval(
        target('one', 'https://replacement.example'),
      );
      assert.strictEqual(refreshed, adapter);
      assert.strictEqual(adapter.target.origin, 'https://replacement.example');
      assert.strictEqual(adapter.session.clearedData, 1);
    });

    it('blocks the approved hostname on any non-target port before certificate verification', function () {
      const electronSessions = mockElectronSessions();
      const adapter = createElectronControllerSessions({ session: electronSessions }).forServer({
        ...target('one', 'https://remote.example:8443'),
        certificateOverride: {
          origin: 'https://remote.example:8443',
          fingerprint: FIRST_FINGERPRINT,
        },
      });
      const decision = (url) => new Promise((resolve) =>
        adapter.session.beforeRequest({ url }, resolve));
      return Promise.all([
        decision('https://remote.example:8443/login').then((result) => assert.deepStrictEqual(result, {})),
        decision('wss://remote.example:8443/socket').then((result) => assert.deepStrictEqual(result, {})),
        decision('https://remote.example:9443/login').then((result) => assert.deepStrictEqual(result, { cancel: true })),
        decision('https://github.com/login').then((result) => assert.deepStrictEqual(result, {})),
      ]);
    });
  });

  describe('dedicated OAuth window', function () {
    it('uses hardened preferences that callers cannot weaken', function () {
      const win = createHardenedOAuthWindow({
        BrowserWindow: MockBrowserWindow,
        targetOrigin: 'https://remote.example',
        partition: partitionForServer('one'),
        browserWindowOptions: {
          width: 900,
          webContents: { compromised: true },
          webPreferences: {
            preload: '/tmp/untrusted-preload.js',
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            webSecurity: false,
            webviewTag: true,
          },
        },
      });
      assert.strictEqual(win.options.width, 900);
      assert.strictEqual(win.options.webContents, undefined);
      assert.deepStrictEqual(win.options.webPreferences, {
        partition: partitionForServer('one'),
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        devTools: false,
        experimentalFeatures: false,
        spellcheck: false,
      });
      assert.deepStrictEqual(
        win.webContents.windowOpenHandler({ url: 'https://github.com/login' }),
        { action: 'deny' },
      );
    });

    it('allows only the exact target and GitHub HTTPS origins', function () {
      assert.strictEqual(isAllowedOAuthNavigation('https://remote.example/login', 'https://remote.example'), true);
      assert.strictEqual(isAllowedOAuthNavigation('https://github.com/login/oauth/authorize?client_id=x', 'https://remote.example'), true);
      assert.strictEqual(isAllowedOAuthNavigation('https://github.com/sessions/two-factor', 'https://remote.example'), true);
      assert.strictEqual(isAllowedOAuthNavigation('https://github.com/orgs/acme/sso', 'https://remote.example'), true);
      assert.strictEqual(isAllowedOAuthNavigation('https://github.com/dnviti/code-agents-webcli', 'https://remote.example'), true);
      assert.strictEqual(isAllowedOAuthNavigation('https://api.github.com/user', 'https://remote.example'), false);
      assert.strictEqual(isAllowedOAuthNavigation('https://evil.example/', 'https://remote.example'), false);

      const win = createHardenedOAuthWindow({
        BrowserWindow: MockBrowserWindow,
        targetOrigin: 'https://remote.example',
        partition: partitionForServer('one'),
      });
      let prevented = false;
      win.webContents.emit('will-navigate', {
        url: 'https://evil.example/',
        preventDefault() { prevented = true; },
      });
      assert.strictEqual(prevented, true);
      prevented = false;
      win.webContents.emit('will-redirect', {
        url: 'https://github.com/login/oauth/authorize',
        preventDefault() { prevented = true; },
      });
      assert.strictEqual(prevented, false);
    });

    it('reports sign-in only after GitHub returns and injected authentication succeeds', async function () {
      const electronSessions = mockElectronSessions();
      const checks = [];
      const manager = createElectronControllerSessions({
        session: electronSessions,
        BrowserWindow: MockBrowserWindow,
        checkAuthenticated: async (checkedTarget, ses) => {
          checks.push([checkedTarget.id, ses.partition]);
          return { login: 'octocat' };
        },
      });
      const adapter = manager.forServer(target('one'));
      const signedIn = [];
      const resultPromise = adapter.runOAuthFlow({ onSignedIn: (result) => signedIn.push(result) });
      const win = MockBrowserWindow.instances[0];
      await Promise.resolve();
      assert.strictEqual(win.webContents.loadedUrl, 'https://remote.example/login');
      win.webContents.emit('did-navigate', {}, 'https://remote.example/login');
      await Promise.resolve();
      assert.strictEqual(checks.length, 0, 'the initial target page is not an OAuth return');
      win.webContents.emit('did-redirect-navigation', {
        url: 'https://github.com/login/oauth/authorize',
      });
      win.webContents.emit('did-redirect-navigation', { url: 'https://remote.example/auth/github/callback' });
      await Promise.resolve();
      assert.strictEqual(checks.length, 0, 'redirect announcement is too early to confirm cookies');
      win.webContents.emit('did-navigate', {}, 'https://remote.example/auth/github/callback');
      const result = await resultPromise;
      assert.strictEqual(result.status, 'signed-in');
      assert.deepStrictEqual(result.authentication, { login: 'octocat' });
      assert.deepStrictEqual(checks, [['one', partitionForServer('one')]]);
      assert.strictEqual(signedIn.length, 1);
    });

    it('reports cancellation and authentication-check errors', async function () {
      const electronSessions = mockElectronSessions();
      const manager = createElectronControllerSessions({
        session: electronSessions,
        BrowserWindow: MockBrowserWindow,
        checkAuthenticated: async () => false,
      });
      const adapter = manager.forServer(target('one'));
      const cancelledPromise = adapter.runOAuthFlow();
      MockBrowserWindow.instances.at(-1).close();
      assert.deepStrictEqual(await cancelledPromise, { status: 'cancel' });

      const errors = [];
      const errorPromise = adapter.runOAuthFlow({ onError: (error) => errors.push(error) });
      const win = MockBrowserWindow.instances.at(-1);
      win.webContents.emit('did-navigate', {}, 'https://github.com/login/oauth/authorize');
      win.webContents.emit('did-navigate', {}, 'https://remote.example/auth/github/callback');
      const result = await errorPromise;
      assert.strictEqual(result.status, 'error');
      assert.match(result.error.message, /did not confirm authentication/);
      assert.strictEqual(errors.length, 1);
    });

    it('refuses a caller-supplied window whose partition and preload cannot be verified', function () {
      const electronSessions = mockElectronSessions();
      const adapter = createElectronControllerSessions({
        session: electronSessions,
        BrowserWindow: MockBrowserWindow,
        checkAuthenticated: async () => true,
      }).forServer(target('one'));
      assert.throws(
        () => adapter.runOAuthFlow({ window: new MockBrowserWindow({}) }),
        /Inject a BrowserWindow constructor/,
      );
    });

    it('cancels an active flow before replacing its address or trust state', async function () {
      const electronSessions = mockElectronSessions();
      let checks = 0;
      const manager = createElectronControllerSessions({
        session: electronSessions,
        BrowserWindow: MockBrowserWindow,
        checkAuthenticated: async () => { checks += 1; return true; },
      });
      const adapter = manager.forServer(target('one'));
      const flow = adapter.runOAuthFlow();
      const refresh = adapter.refreshCertificateApproval(
        target('one', 'https://replacement.example'),
      );
      const result = await flow;
      await refresh;
      assert.strictEqual(result.status, 'error');
      assert.match(result.error.message, /trust changed/);
      assert.strictEqual(checks, 0);
      assert.strictEqual(adapter.target.origin, 'https://replacement.example');
    });
  });
});
