'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronUpdaterProvider } = require('../desktop/electron-updater-provider.js');
const {
  FlatpakUpdaterProvider,
  fetchFlatpakUpdateInfo,
  normalizeFlatpakError,
} = require('../desktop/flatpak-updater-provider.js');
const {
  DesktopUpdateService,
  isStableNewerVersion,
  readPersistedState,
} = require('../desktop/updater.js');
const {
  CHANNELS,
  isTrustedDesktopUpdateSender,
  registerDesktopUpdateIpc,
  validateExpectedVersion,
} = require('../desktop/update-ipc.js');

class FakeProvider extends EventEmitter {
  constructor() {
    super();
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
    this.available = null;
    this.quitHandled = false;
  }

  async check() {
    this.checks += 1;
    if (this.checkError) throw this.checkError;
    return this.available;
  }

  async download() {
    this.downloads += 1;
    await Promise.resolve();
    if (this.downloadError) throw this.downloadError;
    this.emit('progress', { percent: 42, transferred: 42, total: 100 });
    this.emit('ready');
  }

  install() {
    this.installs += 1;
    return { quitHandled: this.quitHandled };
  }
}

function temporaryStateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-update-test-'));
  return { directory, filename: path.join(directory, 'desktop-update-state.json') };
}

function serviceFor(provider, filename, options = {}) {
  return new DesktopUpdateService({
    provider,
    providerName: options.providerName || 'electron',
    currentVersion: options.currentVersion || '6.1.0',
    stateFile: filename,
    initialDelayMs: 60_000,
    intervalMs: 6 * 60 * 60 * 1000,
    random: () => 0,
    ...options,
  });
}

async function waitForPhase(service, phase) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (service.snapshot().phase === phase) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`desktop updater did not reach phase ${phase}; current phase is ${service.snapshot().phase}`);
}

function flatpakBus(monitor) {
  const portal = {
    CreateUpdateMonitor: async (options) => (
      `/org/freedesktop/portal/Flatpak/update_monitor/1_23/${options.handle_token.value}`
    ),
  };
  return Object.assign(new EventEmitter(), {
    async getProxyObject(_name, objectPath) {
      return { getInterface: () => objectPath === '/org/freedesktop/portal/Flatpak' ? portal : monitor };
    },
    disconnect() {},
  });
}

describe('desktop update service', function () {
  it('accepts only a higher stable semantic version', function () {
    assert.strictEqual(isStableNewerVersion('6.1.1', '6.1.0'), true);
    assert.strictEqual(isStableNewerVersion('7.0.0', '6.9.9'), true);
    assert.strictEqual(isStableNewerVersion('6.1.0+build.2', '6.1.0'), false);
    assert.strictEqual(isStableNewerVersion('6.2.0+build..2', '6.1.0'), false);
    assert.strictEqual(isStableNewerVersion('06.2.0', '6.1.0'), false);
    assert.strictEqual(isStableNewerVersion('6.1.0-beta.1', '6.0.0'), false);
    assert.strictEqual(isStableNewerVersion('5.9.9', '6.1.0'), false);
  });

  it('does nothing when disabled and never schedules a check', function () {
    const { directory, filename } = temporaryStateFile();
    const scheduled = [];
    try {
      const service = new DesktopUpdateService({
        currentVersion: '6.1.0',
        provider: null,
        stateFile: filename,
        enabled: false,
        setTimer: (...args) => scheduled.push(args),
      });
      assert.strictEqual(service.start().phase, 'disabled');
      assert.deepStrictEqual(scheduled, []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('schedules startup and six-hour checks with jitter, then backs failures off', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    const timers = [];
    const setTimer = (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    };
    const clearTimer = (timer) => { timer.cleared = true; };
    try {
      const service = serviceFor(provider, filename, {
        initialDelayMs: 5_000,
        intervalMs: 6 * 60 * 60 * 1000,
        random: () => 0.5,
        setTimer,
        clearTimer,
      });
      service.start();
      assert.strictEqual(timers.at(-1).delay, 5_250);

      provider.available = { available: false };
      await service.check();
      assert.strictEqual(timers.at(-1).delay, (6 * 60 * 60 * 1000) * 1.05);

      provider.checkError = Object.assign(new Error('offline'), { code: 'network' });
      await service.check();
      assert.strictEqual(timers.at(-1).delay, 63_000);
      await service.check();
      assert.strictEqual(timers.at(-1).delay, 126_000);
      await service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not lose the next periodic check when its timer lands during installation', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    const timers = [];
    try {
      const service = serviceFor(provider, filename, {
        random: () => 0,
        setTimer: (callback, delay) => {
          const timer = { callback, delay, unref() {} };
          timers.push(timer);
          return timer;
        },
        clearTimer: () => undefined,
      });
      service.start();
      service.installPromise = new Promise(() => undefined);
      await service.check();
      assert.strictEqual(provider.checks, 0);
      assert.strictEqual(timers.at(-1).delay, 6 * 60 * 60 * 1000);
      service.installPromise = null;
      await service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks once at a time and proposes a newer release without downloading it', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    provider.available = {
      available: true,
      version: '6.2.0',
      releaseName: 'Version 6.2.0',
      releaseNotes: '<b>plain renderer text</b>',
    };
    try {
      const service = serviceFor(provider, filename);
      service.start();
      await Promise.all([service.check(), service.check()]);
      assert.strictEqual(provider.checks, 1);
      assert.strictEqual(provider.downloads, 0);
      assert.strictEqual(service.snapshot().phase, 'available');
      assert.strictEqual(service.snapshot().targetVersion, '6.2.0');
      assert.strictEqual(service.snapshot().prompt, 'automatic');
      assert.strictEqual(service.snapshot().releaseNotes, '<b>plain renderer text</b>');
      service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists deferral per release and gives a newer release a fresh prompt', async function () {
    const { directory, filename } = temporaryStateFile();
    try {
      const firstProvider = new FakeProvider();
      firstProvider.available = { available: true, version: '6.2.0' };
      const first = serviceFor(firstProvider, filename);
      first.start();
      await first.check();
      first.defer('6.2.0');
      assert.strictEqual(readPersistedState(filename).deferredVersion, '6.2.0');
      first.stop();

      const secondProvider = new FakeProvider();
      secondProvider.available = { available: true, version: '6.2.0' };
      const second = serviceFor(secondProvider, filename);
      second.start();
      await second.check();
      assert.strictEqual(second.snapshot().prompt, 'deferred');
      secondProvider.available = { available: true, version: '6.3.0' };
      await second.check();
      assert.strictEqual(second.snapshot().prompt, 'automatic');
      assert.strictEqual(readPersistedState(filename).deferredVersion, null);
      second.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists discovery, but records the prompt only after trusted delivery', async function () {
    const { directory, filename } = temporaryStateFile();
    try {
      const firstProvider = new FakeProvider();
      firstProvider.available = {
        available: true,
        version: '6.2.0',
        releaseName: 'Version 6.2.0',
        releaseNotes: 'Safer updates',
      };
      const first = serviceFor(firstProvider, filename);
      first.start();
      await first.check();
      assert.strictEqual(first.snapshot().prompt, 'automatic');
      assert.strictEqual(readPersistedState(filename).promptedVersion, null);

      const beforeDelivery = serviceFor(new FakeProvider(), filename);
      assert.strictEqual(beforeDelivery.snapshot().prompt, 'automatic', 'a crash before delivery must not consume the prompt');
      await beforeDelivery.stop();

      first.markAutomaticPromptDelivered('6.2.0');
      assert.strictEqual(readPersistedState(filename).promptedVersion, '6.2.0');
      assert.strictEqual(first.snapshot().prompt, 'deferred', 'a renderer reload must get the reminder, not a second prompt');
      await first.stop();

      const secondProvider = new FakeProvider();
      secondProvider.available = { available: true, version: '6.2.0' };
      const second = serviceFor(secondProvider, filename);
      assert.strictEqual(second.snapshot().phase, 'available');
      assert.strictEqual(second.snapshot().targetVersion, '6.2.0');
      assert.strictEqual(second.snapshot().prompt, 'deferred');
      assert.strictEqual(second.snapshot().releaseNotes, 'Safer updates');
      second.start();
      await second.check();
      assert.strictEqual(second.snapshot().prompt, 'deferred');
      await second.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a known proposal actionable-looking only after its background recheck settles', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    provider.available = { available: true, version: '6.2.0' };
    try {
      const service = serviceFor(provider, filename);
      service.start();
      await service.check();

      let finishCheck;
      provider.check = () => new Promise((resolve) => { finishCheck = resolve; });
      const recheck = service.check();
      assert.strictEqual(service.snapshot().phase, 'available');
      assert.strictEqual(service.snapshot().prompt, 'automatic');

      const install = service.install('6.2.0');
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(provider.downloads, 0, 'download must wait for the in-flight trusted recheck');
      finishCheck({ available: true, version: '6.2.0' });
      await Promise.all([recheck, install]);
      assert.strictEqual(provider.downloads, 1);
      await service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores stale availability events after a newer target is known', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    try {
      const service = serviceFor(provider, filename);
      service.start();
      provider.emit('available', { version: '6.3.0' });
      provider.emit('available', { version: '6.2.0' });
      assert.strictEqual(service.snapshot().targetVersion, '6.3.0');
      service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('clears a deferred target when a later provider check confirms there is no update', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    provider.available = { available: true, version: '6.2.0' };
    try {
      const service = serviceFor(provider, filename);
      service.start();
      await service.check();
      service.defer('6.2.0');

      provider.available = { available: false };
      await service.check();

      assert.strictEqual(service.snapshot().phase, 'up_to_date');
      assert.strictEqual(service.snapshot().targetVersion, null);
      assert.strictEqual(service.snapshot().prompt, null);
      assert.strictEqual(readPersistedState(filename).deferredVersion, null);
      await service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let stale provider events regress an active install phase', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    provider.available = { available: true, version: '6.2.0' };
    let finishDownload;
    let finishShutdown;
    let finishInstall;
    provider.download = () => new Promise((resolve) => { finishDownload = resolve; });
    provider.install = () => new Promise((resolve) => { finishInstall = resolve; });
    try {
      const service = serviceFor(provider, filename, {
        prepareInstall: () => new Promise((resolve) => { finishShutdown = resolve; }),
      });
      service.start();
      await service.check();
      const operation = service.install('6.2.0');
      await waitForPhase(service, 'downloading');

      provider.emit('ready');
      finishDownload();
      await waitForPhase(service, 'installing');
      provider.emit('progress', { percent: 99 });
      provider.emit('ready');
      provider.emit('not-available');
      provider.emit('error', Object.assign(new Error('late bus error'), { code: 'ECONNRESET' }));
      assert.strictEqual(service.snapshot().phase, 'installing');
      assert.strictEqual(service.snapshot().targetVersion, '6.2.0');

      finishShutdown();
      await waitForPhase(service, 'restarting');
      provider.emit('progress', { percent: 100 });
      provider.emit('ready');
      provider.emit('not-available');
      provider.emit('error', Object.assign(new Error('late bus error'), { code: 'ECONNRESET' }));
      assert.strictEqual(service.snapshot().phase, 'restarting');
      assert.strictEqual(service.snapshot().targetVersion, '6.2.0');

      finishInstall({ quitHandled: true });
      await operation;
      await service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the current target and performs download, shutdown, install, and relaunch once', async function () {
    const { directory, filename } = temporaryStateFile();
    const provider = new FakeProvider();
    provider.available = { available: true, version: '6.2.0' };
    const order = [];
    try {
      const service = serviceFor(provider, filename, {
        prepareInstall: async () => { order.push('shutdown'); },
        finishInstall: async () => { order.push('relaunch'); },
      });
      service.start();
      await service.check();
      assert.throws(() => service.defer('9.9.9'), /no longer current/);
      const installing = service.install('6.2.0');
      const duplicate = service.install('6.2.0');
      await Promise.all([installing, duplicate]);
      assert.strictEqual(provider.downloads, 1);
      assert.strictEqual(provider.installs, 1);
      assert.deepStrictEqual(order, ['shutdown', 'relaunch']);
      assert.strictEqual(service.snapshot().phase, 'restarting');
      assert.strictEqual(service.snapshot().progress.percent, 42);
      service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps background check failures quiet and exposes post-consent failures for retry', async function () {
    const { directory, filename } = temporaryStateFile();
    try {
      const provider = new FakeProvider();
      provider.checkError = Object.assign(new Error('offline token/path detail'), { code: 'ECONNRESET' });
      const service = serviceFor(provider, filename);
      service.start();
      await service.check();
      assert.strictEqual(service.snapshot().phase, 'idle');
      assert.strictEqual(service.snapshot().errorMessage, null);

      provider.checkError = null;
      provider.available = { available: true, version: '6.2.0' };
      await service.check();
      provider.downloadError = Object.assign(new Error('/private/cache/file'), { code: 'EACCES' });
      await service.install('6.2.0');
      assert.strictEqual(service.snapshot().phase, 'error');
      assert.strictEqual(service.snapshot().retryable, false);
      assert.doesNotMatch(service.snapshot().errorMessage, /private/);
      assert.match(service.snapshot().errorMessage, /writable folder/);
      service.stop();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('desktop update providers and IPC guards', function () {
  it('configures electron-updater for explicit consent and maps native events', async function () {
    const native = new EventEmitter();
    native.checkForUpdates = async () => undefined;
    native.downloadUpdate = async () => undefined;
    native.quitAndInstall = (...args) => { native.installArgs = args; };
    let authorized = 0;
    const provider = new ElectronUpdaterProvider({
      autoUpdater: native,
      platform: 'win32',
      beforeInstall: () => { authorized += 1; },
    });
    provider.start();
    assert.strictEqual(native.autoDownload, false);
    assert.strictEqual(native.autoInstallOnAppQuit, false);
    assert.strictEqual(native.allowPrerelease, false);
    assert.strictEqual(native.allowDowngrade, false);
    const available = new Promise((resolve) => provider.once('available', resolve));
    native.emit('update-available', { version: '6.2.0' });
    assert.strictEqual((await available).version, '6.2.0');
    await provider.download();
    assert.deepStrictEqual(await provider.install(), { quitHandled: true });
    assert.strictEqual(authorized, 1);
    assert.deepStrictEqual(native.installArgs, [true, true]);
    provider.stop();
  });

  it('waits for a real native quit handoff and revokes quit authority on launch failure', async function () {
    const wrapper = new EventEmitter();
    const native = new EventEmitter();
    wrapper.quitAndInstallCalled = false;
    let installArgs = null;
    wrapper.quitAndInstall = (...args) => {
      installArgs = args;
      wrapper.quitAndInstallCalled = true;
      setImmediate(() => native.emit('before-quit-for-update'));
    };
    let authorized = 0;
    let revoked = 0;
    const provider = new ElectronUpdaterProvider({
      autoUpdater: wrapper,
      nativeAutoUpdater: native,
      platform: 'win32',
      beforeInstall: () => { authorized += 1; },
      afterInstallFailure: () => { revoked += 1; },
      installHandoffTimeoutMs: 50,
    });
    assert.deepStrictEqual(await provider.install(), { quitHandled: true });
    assert.deepStrictEqual(installArgs, [true, true]);
    assert.strictEqual(authorized, 1);
    assert.strictEqual(revoked, 0);

    wrapper.quitAndInstallCalled = false;
    wrapper.quitAndInstall = () => wrapper.emit('error', Object.assign(
      new Error('spawn failed'), { code: 'INSTALLER_SPAWN_FAILED' },
    ));
    await assert.rejects(provider.install(), (error) => error.code === 'INSTALLER_SPAWN_FAILED');
    assert.strictEqual(authorized, 2);
    assert.strictEqual(revoked, 1);
  });

  it('rejects a missing or read-only AppImage before download', async function () {
    const native = new EventEmitter();
    native.downloadUpdate = async () => assert.fail('must not download');
    const provider = new ElectronUpdaterProvider({
      autoUpdater: native,
      platform: 'linux',
      environment: {},
    });
    await assert.rejects(provider.download(), (error) => error.code === 'APPIMAGE_NOT_WRITABLE');
  });

  it('selects the matching architecture-specific macOS feed', function () {
    const x64 = new EventEmitter();
    const arm64 = new EventEmitter();
    let x64Channel = null;
    let arm64Channel = null;
    Object.defineProperty(x64, 'channel', {
      set(value) { x64Channel = value; this.allowDowngrade = true; },
      get() { return x64Channel; },
    });
    Object.defineProperty(arm64, 'channel', {
      set(value) { arm64Channel = value; this.allowDowngrade = true; },
      get() { return arm64Channel; },
    });
    new ElectronUpdaterProvider({ autoUpdater: x64, platform: 'darwin', architecture: 'x64' });
    new ElectronUpdaterProvider({ autoUpdater: arm64, platform: 'darwin', architecture: 'arm64' });
    assert.strictEqual(x64.channel, 'latest-x64');
    assert.strictEqual(arm64.channel, 'latest-arm64');
    assert.strictEqual(x64.allowDowngrade, false, 'the custom channel setter must not leave downgrades enabled');
    assert.strictEqual(arm64.allowDowngrade, false, 'the custom channel setter must not leave downgrades enabled');
  });

  it('uses the Flatpak update monitor and relaunches the latest deployment', async function () {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-flatpak-update-'));
    const flatpakSpawn = path.join(temporary, 'flatpak-spawn');
    fs.writeFileSync(flatpakSpawn, '#!/bin/sh\n', { mode: 0o700 });
    const monitor = new EventEmitter();
    monitor.Close = async () => undefined;
    monitor.Update = async () => {
      process.nextTick(() => monitor.emit('Progress', { progress: { value: 100 }, status: { value: 2 } }));
    };
    const portal = { CreateUpdateMonitor: async (options) => (
      `/org/freedesktop/portal/Flatpak/update_monitor/1_23/${options.handle_token.value}`
    ) };
    const bus = Object.assign(new EventEmitter(), {
      async getProxyObject(_name, objectPath) {
        return { getInterface: () => objectPath === '/org/freedesktop/portal/Flatpak' ? portal : monitor };
      },
      disconnect() {},
    });
    const spawns = [];
    let released = 0;
    let reacquired = 0;
    const provider = new FlatpakUpdaterProvider({
      dbusFactory: () => bus,
      releaseResolver: async () => ({ version: '6.2.0', commit: 'b'.repeat(64), releaseName: 'Stable' }),
      runningInfo: { appId: 'io.github.dnviti.code_agents_webcli', branch: 'stable', commit: 'a'.repeat(64) },
      executable: '/app/bin/code-agents-webcli',
      relaunchDirectory: temporary,
      flatpakSpawn,
      releaseSingleInstanceLock: () => { released += 1; },
      reacquireSingleInstanceLock: () => { reacquired += 1; return true; },
      waitForAck: async (ackFile) => {
        const token = path.basename(ackFile).split('.')[0];
        const request = JSON.parse(fs.readFileSync(path.join(temporary, `${token}.request.json`), 'utf8'));
        return {
          schemaVersion: 1, token, mode: request.mode, ok: true,
          version: '6.2.0', commit: 'b'.repeat(64),
        };
      },
      randomBytes: () => Buffer.alloc(24, 7),
      spawnFn: (...args) => {
        spawns.push(args);
        const child = new EventEmitter();
        child.unref = () => undefined;
        process.nextTick(() => child.emit('spawn'));
        return child;
      },
    });
    try {
      assert.strictEqual((await provider.check()).version, '6.2.0');
      const download = provider.download('6.2.0');
      await download;
      assert.deepStrictEqual(await provider.install('6.2.0'), { quitHandled: false });
      assert.strictEqual(spawns[0][0], flatpakSpawn);
      assert.deepStrictEqual(spawns[0][1].slice(0, 2), ['--latest-version', '/app/bin/code-agents-webcli']);
      assert.match(spawns[0][1][2], /^--cc-web-update-probe=[0-9a-f]{48}$/);
      assert.strictEqual(spawns[0][2].shell, false);
      assert.match(spawns[1][1][2], /^--cc-web-update-relaunch=[0-9a-f]{48}$/);
      assert.strictEqual(spawns[1][2].shell, false);
      assert.strictEqual(released, 1);
      assert.strictEqual(reacquired, 0);
      await provider.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('accepts only the fixed commit-bound Flatpak manifest', async function () {
    const openpgp = await import('openpgp');
    const keys = await openpgp.generateKey({
      type: 'rsa', rsaBits: 2048, userIDs: [{ name: 'Updater Test' }], format: 'armored',
    });
    const contents = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      appId: 'io.github.dnviti.code_agents_webcli',
      branch: 'stable',
      version: '6.2.0',
      commit: 'b'.repeat(64),
    }));
    const signingKey = await openpgp.readPrivateKey({ armoredKey: keys.privateKey });
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: new Uint8Array(contents) }),
      signingKeys: signingKey,
      detached: true,
      format: 'armored',
    });
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push(url);
      assert.strictEqual(options.redirect, 'error');
      return new Response(url.endsWith('.asc') ? signature : contents, { status: 200 });
    };
    assert.strictEqual((await fetchFlatpakUpdateInfo(fetchImpl, {
      publicKeyArmored: keys.publicKey,
    })).commit, 'b'.repeat(64));
    assert.deepStrictEqual(seen, [
      'https://dnviti.github.io/code-agents-webcli/flatpak/update-info.json',
      'https://dnviti.github.io/code-agents-webcli/flatpak/update-info.json.asc',
    ]);

    await assert.rejects(fetchFlatpakUpdateInfo(async (url) => (
      new Response(url.endsWith('.asc') ? signature : Buffer.concat([contents, Buffer.from(' ')]), { status: 200 })
    ), { publicKeyArmored: keys.publicKey }), (error) => error.code === 'FLATPAK_FEED_SIGNATURE_INVALID');
  });

  it('reports no Flatpak update when the signed feed names the running commit', async function () {
    const monitor = Object.assign(new EventEmitter(), { Close: async () => undefined });
    const bus = flatpakBus(monitor);
    const provider = new FlatpakUpdaterProvider({
      dbusFactory: () => bus,
      releaseResolver: async () => ({ version: '6.1.0', commit: 'a'.repeat(64) }),
      runningInfo: {
        appId: 'io.github.dnviti.code_agents_webcli',
        branch: 'stable',
        commit: 'a'.repeat(64),
      },
    });
    assert.deepStrictEqual(await provider.check(), { available: false });
    await provider.stop();
  });

  it('maps a Flatpak D-Bus error type for expanded permissions', async function () {
    const direct = normalizeFlatpakError(Object.assign(new Error('permission detail'), {
      type: 'org.freedesktop.DBus.Error.NotSupported',
    }));
    assert.strictEqual(direct.code, 'FLATPAK_PERMISSIONS');
    assert.match(direct.publicMessage, /system software tool/);

    const monitor = Object.assign(new EventEmitter(), {
      Close: async () => undefined,
      Update: async () => {
        throw Object.assign(new Error('private portal detail'), {
          type: 'org.freedesktop.DBus.Error.NotSupported',
        });
      },
    });
    const provider = new FlatpakUpdaterProvider({
      dbusFactory: () => flatpakBus(monitor),
      releaseResolver: async () => ({ version: '6.2.0', commit: 'b'.repeat(64) }),
      runningInfo: {
        appId: 'io.github.dnviti.code_agents_webcli',
        branch: 'stable',
        commit: 'a'.repeat(64),
      },
    });
    await provider.check();
    await assert.rejects(provider.download('6.2.0'), (error) => (
      error.code === 'FLATPAK_PERMISSIONS' && /system software tool/.test(error.publicMessage)
    ));
    await provider.stop();
  });

  it('drops a failed Flatpak bus so the next check creates a fresh monitor', async function () {
    const buses = [];
    const monitors = [];
    let disconnects = 0;
    const provider = new FlatpakUpdaterProvider({
      dbusFactory: () => {
        const monitor = Object.assign(new EventEmitter(), { Close: async () => undefined });
        const bus = flatpakBus(monitor);
        bus.disconnect = () => { disconnects += 1; };
        monitors.push(monitor);
        buses.push(bus);
        return bus;
      },
      releaseResolver: async () => ({ version: '6.2.0', commit: 'b'.repeat(64) }),
      runningInfo: {
        appId: 'io.github.dnviti.code_agents_webcli', branch: 'stable', commit: 'a'.repeat(64),
      },
    });
    const errors = [];
    provider.on('error', (error) => errors.push(error.code));
    await provider.check();
    buses[0].emit('error', Object.assign(new Error('bus disconnected'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
    await provider.check();
    assert.strictEqual(buses.length, 2);
    assert.deepStrictEqual(errors, ['ECONNRESET']);
    assert.ok(disconnects >= 1);
    await provider.stop();
  });

  it('does not accept an empty Flatpak transaction without proving the target deployment', async function () {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-flatpak-empty-'));
    const flatpakSpawn = path.join(temporary, 'flatpak-spawn');
    fs.writeFileSync(flatpakSpawn, '#!/bin/sh\n', { mode: 0o700 });
    const monitor = Object.assign(new EventEmitter(), {
      Close: async () => undefined,
      Update: async () => process.nextTick(() => monitor.emit('Progress', {
        progress: { value: 100 }, status: { value: 1 },
      })),
    });
    let released = 0;
    const provider = new FlatpakUpdaterProvider({
      dbusFactory: () => flatpakBus(monitor),
      releaseResolver: async () => ({ version: '6.2.0', commit: 'b'.repeat(64) }),
      runningInfo: {
        appId: 'io.github.dnviti.code_agents_webcli', branch: 'stable', commit: 'a'.repeat(64),
      },
      flatpakSpawn,
      relaunchDirectory: temporary,
      releaseSingleInstanceLock: () => { released += 1; },
      waitForAck: async (ackFile) => {
        const token = path.basename(ackFile).split('.')[0];
        return {
          schemaVersion: 1, token, mode: 'probe', ok: false,
          code: 'FLATPAK_PROBE_MISMATCH', version: '6.1.0', commit: 'a'.repeat(64),
        };
      },
      spawnFn: () => {
        const child = new EventEmitter();
        child.unref = () => undefined;
        process.nextTick(() => child.emit('spawn'));
        return child;
      },
    });
    try {
      await provider.check();
      await assert.rejects(provider.download('6.2.0'), (error) => error.code === 'FLATPAK_PROBE_MISMATCH');
      assert.strictEqual(released, 0, 'deployment proof must happen before releasing the app lock');
      await provider.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('refuses consent when the Flatpak version or commit changes before download', async function () {
    for (const replacement of [
      { version: '6.3.0', commit: 'c'.repeat(64) },
      { version: '6.2.0', commit: 'c'.repeat(64) },
    ]) {
      let updateCalls = 0;
      let resolveCalls = 0;
      const monitor = Object.assign(new EventEmitter(), {
        Close: async () => undefined,
        Update: async () => { updateCalls += 1; },
      });
      const provider = new FlatpakUpdaterProvider({
        dbusFactory: () => flatpakBus(monitor),
        releaseResolver: async () => {
          resolveCalls += 1;
          return resolveCalls === 1
            ? { version: '6.2.0', commit: 'b'.repeat(64) }
            : replacement;
        },
        runningInfo: {
          appId: 'io.github.dnviti.code_agents_webcli',
          branch: 'stable',
          commit: 'a'.repeat(64),
        },
      });
      await provider.check();
      await assert.rejects(provider.download('6.2.0'), (error) => error.code === 'UPDATE_TARGET_CHANGED');
      assert.strictEqual(updateCalls, 0, 'changed consent must be rejected before invoking the portal update');
      await provider.stop();
    }
  });

  it('reacquires the single-instance lock after Flatpak spawn and acknowledgement failures', async function () {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-flatpak-relaunch-failure-'));
    const flatpakSpawn = path.join(temporary, 'flatpak-spawn');
    fs.writeFileSync(flatpakSpawn, '#!/bin/sh\n', { mode: 0o700 });
    const latest = { version: '6.2.0', commit: 'b'.repeat(64) };
    try {
      const ackFor = (ackFile, ok = true, code = undefined) => {
        const token = path.basename(ackFile).split('.')[0];
        const request = JSON.parse(fs.readFileSync(path.join(temporary, `${token}.request.json`), 'utf8'));
        return {
          schemaVersion: 1,
          token,
          mode: request.mode,
          ok,
          code,
          version: latest.version,
          commit: latest.commit,
        };
      };
      let released = 0;
      let reacquired = 0;
      let spawnCalls = 0;
      const spawnFailure = new FlatpakUpdaterProvider({
        runningInfo: {
          appId: 'io.github.dnviti.code_agents_webcli', branch: 'stable', commit: 'a'.repeat(64),
        },
        flatpakSpawn,
        relaunchDirectory: temporary,
        releaseSingleInstanceLock: () => { released += 1; },
        reacquireSingleInstanceLock: () => { reacquired += 1; return true; },
        waitForAck: async (ackFile) => ackFor(ackFile),
        randomBytes: () => Buffer.alloc(24, 1),
        spawnFn: () => {
          const child = new EventEmitter();
          spawnCalls += 1;
          process.nextTick(() => {
            if (spawnCalls === 1) child.emit('spawn');
            else child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
          });
          child.unref = () => undefined;
          return child;
        },
      });
      spawnFailure.latest = latest;
      await assert.rejects(spawnFailure.install('6.2.0'), (error) => error.code === 'ENOENT');
      assert.strictEqual(released, 1);
      assert.strictEqual(reacquired, 1);

      released = 0;
      reacquired = 0;
      const ackFailure = new FlatpakUpdaterProvider({
        runningInfo: {
          appId: 'io.github.dnviti.code_agents_webcli', branch: 'stable', commit: 'a'.repeat(64),
        },
        flatpakSpawn,
        relaunchDirectory: temporary,
        releaseSingleInstanceLock: () => { released += 1; },
        reacquireSingleInstanceLock: () => { reacquired += 1; return false; },
        waitForAck: async (ackFile) => {
          const request = JSON.parse(fs.readFileSync(
            path.join(temporary, `${path.basename(ackFile).split('.')[0]}.request.json`),
            'utf8',
          ));
          return ackFor(ackFile, request.mode === 'probe', 'FLATPAK_RELAUNCH_START_FAILED');
        },
        randomBytes: () => Buffer.alloc(24, 2),
        spawnFn: () => {
          const child = new EventEmitter();
          child.unref = () => undefined;
          process.nextTick(() => child.emit('spawn'));
          return child;
        },
      });
      ackFailure.latest = latest;
      await assert.rejects(ackFailure.install('6.2.0'), (error) => error.code === 'FLATPAK_RELAUNCH_LOCK_LOST');
      assert.strictEqual(released, 1);
      assert.strictEqual(reacquired, 1);
      assert.deepStrictEqual(
        fs.readdirSync(temporary).sort(),
        ['flatpak-spawn'],
        'failed relaunches must remove request and acknowledgement files',
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('requires the exact main frame and origin for updater IPC', function () {
    const mainFrame = { url: 'http://127.0.0.1:43210/app' };
    const webContents = { mainFrame };
    const window = { webContents, isDestroyed: () => false };
    assert.strictEqual(isTrustedDesktopUpdateSender(
      { sender: webContents, senderFrame: mainFrame },
      window,
      'http://127.0.0.1:43210',
    ), true);
    assert.strictEqual(isTrustedDesktopUpdateSender(
      { sender: webContents, senderFrame: { url: mainFrame.url } },
      window,
      'http://127.0.0.1:43210',
    ), false);
    assert.strictEqual(isTrustedDesktopUpdateSender(
      { sender: webContents, senderFrame: { ...mainFrame, url: 'https://evil.test/' } },
      window,
      'http://127.0.0.1:43210',
    ), false);
    assert.strictEqual(validateExpectedVersion('6.2.0'), '6.2.0');
    assert.throws(() => validateExpectedVersion('../../payload'), /Invalid/);
  });

  it('requires an explicit trusted acknowledgement before persisting prompt delivery', async function () {
    const listeners = new Map();
    const handlers = new Map();
    const automatic = {
      phase: 'available', prompt: 'automatic', targetVersion: '6.2.0', generation: 1,
    };
    const delivered = [];
    const service = Object.assign(new EventEmitter(), {
      snapshot: () => automatic,
      markAutomaticPromptDelivered: (version) => delivered.push(version),
    });
    const mainFrame = { url: 'http://127.0.0.1:43210/app' };
    const sent = [];
    const webContents = {
      mainFrame,
      getURL: () => mainFrame.url,
      send: (channel, value) => sent.push([channel, value]),
    };
    const window = { webContents, isDestroyed: () => false };
    let ready = 0;
    const dispose = registerDesktopUpdateIpc({
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
        on(channel, listener) { listeners.set(channel, listener); },
        removeListener(channel) { listeners.delete(channel); },
      },
      service,
      getWindow: () => window,
      getOrigin: () => 'http://127.0.0.1:43210',
      onRendererReady: () => { ready += 1; },
    });
    try {
      service.emit('state', automatic);
      assert.deepStrictEqual(sent, [[CHANNELS.state, automatic]]);
      assert.deepStrictEqual(delivered, [], 'webContents.send has no delivery acknowledgement');

      const trustedEvent = { sender: webContents, senderFrame: mainFrame };
      assert.strictEqual(await handlers.get(CHANNELS.snapshot)(trustedEvent), automatic);
      assert.deepStrictEqual(delivered, [], 'snapshot invocation alone must not consume the prompt');

      assert.doesNotThrow(() => listeners.get(CHANNELS.rendererReady)({
        sender: {},
        senderFrame: { url: 'https://evil.test/' },
      }));
      assert.strictEqual(ready, 0);
      listeners.get(CHANNELS.rendererReady)(trustedEvent);
      assert.strictEqual(ready, 1);

      assert.doesNotThrow(() => listeners.get(CHANNELS.promptDelivered)({
        sender: {}, senderFrame: { url: 'https://evil.test/' },
      }, '6.2.0'));
      assert.deepStrictEqual(delivered, []);
      listeners.get(CHANNELS.promptDelivered)(trustedEvent, '6.2.0');
      assert.deepStrictEqual(delivered, ['6.2.0']);
    } finally {
      dispose();
    }
  });

  it('exposes only the frozen narrow updater API from the isolated preload', function () {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    assert.match(preload, /contextBridge\.exposeInMainWorld\('desktopUpdates'/);
    for (const method of ['getSnapshot', 'subscribe', 'defer', 'install', 'retry']) {
      assert.match(preload, new RegExp(`\\b${method}\\b`));
    }
    assert.doesNotMatch(preload, /setFeedURL|downloadURL|installerPath/);
    assert.strictEqual(CHANNELS.rendererReady, 'desktop-update:renderer-ready');
    assert.strictEqual(CHANNELS.promptDelivered, 'desktop-update:prompt-delivered');
    assert.match(preload, /cc-web:desktop-renderer-ready/);
    assert.match(preload, /ipcRenderer\.send\(CHANNELS\.rendererReady\)/);
    assert.match(preload, /ipcRenderer\.send\(CHANNELS\.promptDelivered, pendingAutomaticPrompt\)/);
    assert.match(preload, /listener\(state\);[\s\S]+acknowledgeObservedState\(state\)/);
  });

  it('acknowledges a Flatpak relaunch only after the trusted renderer becomes ready', function () {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    assert.match(main, /validateUpdateHandshake\(updateProbeToken, 'probe'\)/);
    assert.match(main, /await waitForRendererReady\(\);\s*acknowledgeUpdateRelaunch\(true\)/);
    assert.match(main, /app\.releaseSingleInstanceLock\(\);\s*acknowledgeUpdateRelaunch\(false/);
  });
});
