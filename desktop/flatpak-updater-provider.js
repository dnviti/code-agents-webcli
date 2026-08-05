'use strict';

const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const FLATPAK_APP_ID = 'io.github.dnviti.code_agents_webcli';
const FLATPAK_BUS_NAME = 'org.freedesktop.portal.Flatpak';
const FLATPAK_OBJECT_PATH = '/org/freedesktop/portal/Flatpak';
const FLATPAK_INTERFACE = 'org.freedesktop.portal.Flatpak';
const UPDATE_MONITOR_INTERFACE = 'org.freedesktop.portal.Flatpak.UpdateMonitor';
const FLATPAK_UPDATE_INFO_URL = 'https://dnviti.github.io/code-agents-webcli/flatpak/update-info.json';
const FLATPAK_UPDATE_SIGNATURE_URL = `${FLATPAK_UPDATE_INFO_URL}.asc`;
const MAX_UPDATE_INFO_BYTES = 64 * 1024;
const RELAUNCH_TIMEOUT_MS = 60_000;

function unwrap(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return unwrap(value.value);
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrap(entry)]));
  }
  return value;
}

function parseFlatpakInfo(contents) {
  const sections = new Map();
  let section = '';
  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const heading = /^\[([^\]]+)]$/.exec(line);
    if (heading) {
      section = heading[1];
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const separator = line.indexOf('=');
    if (!section || separator < 1) continue;
    sections.get(section).set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return {
    appId: sections.get('Application')?.get('name') || null,
    branch: sections.get('Instance')?.get('branch') || null,
    commit: sections.get('Instance')?.get('app-commit') || null,
  };
}

function readRunningFlatpakInfo(filename = '/.flatpak-info', fsImpl = fs) {
  const info = parseFlatpakInfo(fsImpl.readFileSync(filename, 'utf8'));
  if (info.appId !== FLATPAK_APP_ID || info.branch !== 'stable'
    || !/^[0-9a-f]{64}$/i.test(info.commit || '')) {
    const error = new Error('The packaged Flatpak instance metadata is incomplete.');
    error.code = 'FLATPAK_INSTANCE_INVALID';
    error.publicMessage = 'This Flatpak installation cannot verify its update channel. Reinstall it from the project release.';
    error.retryable = false;
    throw error;
  }
  return info;
}

function validateUpdateInfo(raw) {
  if (!raw || raw.schemaVersion !== 1 || raw.appId !== FLATPAK_APP_ID || raw.branch !== 'stable') {
    throw Object.assign(new Error('The Flatpak update manifest has an unexpected identity.'), {
      code: 'FLATPAK_FEED_INVALID',
    });
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(raw.version || ''))
    || !/^[0-9a-f]{64}$/i.test(String(raw.commit || ''))) {
    throw Object.assign(new Error('The Flatpak update manifest is malformed.'), {
      code: 'FLATPAK_FEED_INVALID',
    });
  }
  return {
    version: String(raw.version),
    commit: String(raw.commit).toLowerCase(),
    releaseName: typeof raw.releaseName === 'string' ? raw.releaseName : null,
    releaseDate: typeof raw.releaseDate === 'string' ? raw.releaseDate : null,
    releaseNotes: typeof raw.releaseNotes === 'string' ? raw.releaseNotes : null,
  };
}

async function readResponseLimited(response, maximum, controller) {
  const declaredHeader = response.headers?.get?.('content-length');
  const declared = declaredHeader === null || declaredHeader === undefined
    ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maximum) {
    controller.abort();
    throw Object.assign(new Error('Flatpak update response is too large.'), { code: 'FLATPAK_FEED_INVALID' });
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > maximum) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error('Flatpak update response is too large.'), { code: 'FLATPAK_FEED_INVALID' });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  // Test doubles and older fetch implementations may not expose a reader.
  const buffer = typeof response.arrayBuffer === 'function'
    ? Buffer.from(await response.arrayBuffer())
    : Buffer.from(await response.text());
  if (buffer.length > maximum) {
    controller.abort();
    throw Object.assign(new Error('Flatpak update response is too large.'), { code: 'FLATPAK_FEED_INVALID' });
  }
  return buffer;
}

async function verifyUpdateInfoSignature(contents, armoredSignature, armoredKeys) {
  if (typeof armoredKeys !== 'string' || !armoredKeys.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    throw Object.assign(new Error('The Flatpak update signing key is unavailable.'), {
      code: 'FLATPAK_FEED_INVALID',
    });
  }
  try {
    const openpgp = await import('openpgp');
    const verificationKeys = await openpgp.readKeys({ armoredKeys });
    if (verificationKeys.length < 1) throw new Error('No verification key was found.');
    const signature = await openpgp.readSignature({ armoredSignature });
    const message = await openpgp.createMessage({ binary: new Uint8Array(contents) });
    const result = await openpgp.verify({ message, signature, verificationKeys });
    if (result.signatures.length !== 1) throw new Error('Expected exactly one manifest signature.');
    await result.signatures[0].verified;
  } catch (cause) {
    throw Object.assign(new Error('The Flatpak update manifest signature is invalid.', { cause }), {
      code: 'FLATPAK_FEED_SIGNATURE_INVALID',
    });
  }
}

async function fetchFlatpakUpdateInfo(fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Fetch is unavailable.'), { code: 'network' });
  let armoredKeys = options.publicKeyArmored;
  if (!armoredKeys && options.publicKeyFile) {
    const stat = fs.statSync(options.publicKeyFile);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_UPDATE_INFO_BYTES) {
      throw Object.assign(new Error('The Flatpak update signing key is invalid.'), { code: 'FLATPAK_FEED_INVALID' });
    }
    armoredKeys = fs.readFileSync(options.publicKeyFile, 'utf8');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  try {
    const request = (url, accept) => fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': 'code-agents-webcli-flatpak-updater',
      },
    });
    const response = await request(FLATPAK_UPDATE_INFO_URL, 'application/json');
    if (!response.ok) throw Object.assign(new Error(`Flatpak update service returned ${response.status}.`), { code: 'network' });
    const contents = await readResponseLimited(response, MAX_UPDATE_INFO_BYTES, controller);
    const signatureResponse = await request(FLATPAK_UPDATE_SIGNATURE_URL, 'application/pgp-signature');
    if (!signatureResponse.ok) {
      throw Object.assign(new Error(`Flatpak signature service returned ${signatureResponse.status}.`), {
        code: 'FLATPAK_FEED_SIGNATURE_INVALID',
      });
    }
    const signature = (await readResponseLimited(signatureResponse, 32 * 1024, controller)).toString('utf8');
    await verifyUpdateInfoSignature(contents, signature, armoredKeys);
    return validateUpdateInfo(JSON.parse(contents.toString('utf8')));
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFlatpakError(error) {
  if (!error || typeof error !== 'object') return error;
  const type = typeof error.type === 'string' ? error.type : '';
  if (type === 'org.freedesktop.DBus.Error.NotSupported'
    || error.code === 'org.freedesktop.DBus.Error.NotSupported') {
    error.code = 'FLATPAK_PERMISSIONS';
    error.publicMessage = 'This update needs new Flatpak permissions. Install it with the system software tool.';
    error.retryable = false;
  } else if (!error.code && type) {
    error.code = type.slice(0, 80);
  }
  return error;
}

function writeJsonAtomic(filename, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fsImpl.renameSync(temporary, filename);
}

function waitForRelaunchAck(filename, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const timeoutMs = options.timeoutMs ?? RELAUNCH_TIMEOUT_MS;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearIntervalFn(interval);
      clearTimeoutFn(timeout);
      callback(value);
    };
    const inspect = () => {
      try {
        const parsed = JSON.parse(fsImpl.readFileSync(filename, 'utf8'));
        if (parsed && typeof parsed.ok === 'boolean') finish(resolve, parsed);
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) finish(reject, error);
      }
    };
    const interval = setIntervalFn(inspect, 100);
    interval?.unref?.();
    const timeout = setTimeoutFn(() => {
      const error = new Error('The updated Flatpak did not confirm that it started.');
      error.code = 'FLATPAK_RELAUNCH_TIMEOUT';
      error.publicMessage = 'The update was installed, but the new app did not start. Start it again from your applications menu.';
      finish(reject, error);
    }, timeoutMs);
    timeout?.unref?.();
    inspect();
  });
}

function waitForSpawn(child) {
  if (!child || typeof child.once !== 'function') {
    return Promise.reject(Object.assign(new Error('Flatpak relaunch did not create a process.'), {
      code: 'FLATPAK_RELAUNCH_FAILED',
    }));
  }
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

class FlatpakUpdaterProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dbusFactory = options.dbusFactory || (() => require('@particle/dbus-next').sessionBus());
    this.releaseResolver = options.releaseResolver || (() => fetchFlatpakUpdateInfo(options.fetchImpl, {
      publicKeyArmored: options.manifestPublicKey,
      publicKeyFile: options.manifestPublicKeyFile,
    }));
    this.spawnFn = options.spawnFn || spawn;
    this.fs = options.fsImpl || fs;
    this.runningInfo = options.runningInfo || readRunningFlatpakInfo(options.flatpakInfoFile, this.fs);
    this.executable = options.executable || process.execPath;
    this.parentWindow = options.parentWindow || (() => '');
    this.relaunchDirectory = options.relaunchDirectory || path.join(process.cwd(), '.desktop-update-relaunch');
    this.releaseSingleInstanceLock = options.releaseSingleInstanceLock || (() => undefined);
    this.reacquireSingleInstanceLock = options.reacquireSingleInstanceLock || (() => true);
    this.waitForAck = options.waitForAck || ((filename) => waitForRelaunchAck(filename, { fsImpl: this.fs }));
    this.randomBytes = options.randomBytes || randomBytes;
    this.variantFactory = options.variantFactory || ((signature, value) => {
      const { Variant } = require('@particle/dbus-next');
      return new Variant(signature, value);
    });
    this.flatpakSpawn = options.flatpakSpawn || '/usr/bin/flatpak-spawn';
    this.bus = null;
    this.monitor = null;
    this.startPromise = null;
    this.updatePromise = null;
    this.resolveUpdate = null;
    this.rejectUpdate = null;
    this.latest = null;
    this.installTarget = null;
    this.stopped = false;
    this.availabilityGeneration = 0;
    this.connectionGeneration = 0;
    this.busErrorListener = null;
    this.monitorBindings = [];
    this.deployment = {
      runningCommit: this.runningInfo.commit.toLowerCase(),
      localCommit: null,
      remoteCommit: null,
    };
  }

  async start() {
    if (this.monitor) return;
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    const generation = ++this.connectionGeneration;
    const bus = this.dbusFactory();
    const busErrorListener = (error) => this._handleBusError(error, bus, generation);
    this.bus = bus;
    this.busErrorListener = busErrorListener;
    const current = () => !this.stopped
      && generation === this.connectionGeneration && this.bus === bus;
    const starting = (async () => {
      bus.on?.('error', busErrorListener);
      try {
        const portalObject = await bus.getProxyObject(FLATPAK_BUS_NAME, FLATPAK_OBJECT_PATH);
        if (!current()) return;
        const portal = portalObject.getInterface(FLATPAK_INTERFACE);
        const monitorToken = `ccweb_${this.randomBytes(16).toString('hex')}`;
        const handle = String(await portal.CreateUpdateMonitor({
          handle_token: this.variantFactory('s', monitorToken),
        }));
        if (!current()) return;
        if (!/^\/org\/freedesktop\/portal\/Flatpak\/update_monitor\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(handle)
          || !handle.endsWith(`/${monitorToken}`)) {
          throw Object.assign(new Error('Flatpak returned an invalid update monitor handle.'), {
            code: 'FLATPAK_PORTAL_INVALID',
          });
        }
        const monitorObject = await bus.getProxyObject(FLATPAK_BUS_NAME, handle);
        if (!current()) return;
        const monitor = monitorObject.getInterface(UPDATE_MONITOR_INTERFACE);
        const available = (info) => void this._handleAvailable(info);
        const progress = (info) => this._handleProgress(info);
        monitor.on('UpdateAvailable', available);
        monitor.on('Progress', progress);
        if (!current()) {
          monitor.off?.('UpdateAvailable', available);
          monitor.off?.('Progress', progress);
          await monitor.Close?.().catch?.(() => undefined);
          return;
        }
        this.monitor = monitor;
        this.monitorBindings = [
          ['UpdateAvailable', available],
          ['Progress', progress],
        ];
      } catch (error) {
        bus.off?.('error', busErrorListener);
        bus.disconnect?.();
        if (this.bus === bus) {
          this.bus = null;
          this.busErrorListener = null;
        }
        if (!current() && this.stopped) return;
        throw normalizeFlatpakError(error);
      }
    })();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  async stop() {
    this.stopped = true;
    this.connectionGeneration += 1;
    this.availabilityGeneration += 1;
    const pendingError = Object.assign(new Error('Flatpak update monitoring stopped.'), {
      code: 'FLATPAK_MONITOR_STOPPED',
    });
    this.rejectUpdate?.(pendingError);
    this._clearUpdatePromise();
    const monitor = this.monitor;
    const bus = this.bus;
    const busErrorListener = this.busErrorListener;
    const pendingStart = this.startPromise;
    for (const [event, listener] of this.monitorBindings) monitor?.off?.(event, listener);
    this.monitorBindings = [];
    this.monitor = null;
    this.bus = null;
    this.busErrorListener = null;
    try {
      await monitor?.Close?.();
    } catch {
      // Process shutdown is already committed; Close is best effort here.
    } finally {
      bus?.off?.('error', busErrorListener);
      bus?.disconnect?.();
    }
    await pendingStart?.catch?.(() => undefined);
  }

  _handleBusError(error, bus = this.bus, generation = this.connectionGeneration) {
    if (!bus || bus !== this.bus || generation !== this.connectionGeneration) return;
    const normalized = normalizeFlatpakError(error);
    this.connectionGeneration += 1;
    this.availabilityGeneration += 1;
    const monitor = this.monitor;
    const busErrorListener = this.busErrorListener;
    for (const [event, listener] of this.monitorBindings) monitor?.off?.(event, listener);
    this.monitorBindings = [];
    this.monitor = null;
    this.bus = null;
    this.busErrorListener = null;
    this.rejectUpdate?.(normalized);
    this._clearUpdatePromise();
    void Promise.resolve().then(() => monitor?.Close?.()).catch(() => undefined).finally(() => {
      bus.off?.('error', busErrorListener);
      bus.disconnect?.();
    });
    if (!this.stopped) this.emit('error', normalized);
  }

  async check() {
    await this.start();
    const release = await this.releaseResolver();
    this.latest = validateUpdateInfo({
      ...release,
      schemaVersion: 1,
      appId: FLATPAK_APP_ID,
      branch: 'stable',
    });
    this.installTarget = null;
    if (this.latest.commit === this.runningInfo.commit.toLowerCase()) return { available: false };
    return { available: true, ...this.latest };
  }

  async _handleAvailable(rawInfo) {
    const info = unwrap(rawInfo) || {};
    const remoteCommit = String(info['remote-commit'] || '').toLowerCase();
    const localCommit = String(info['local-commit'] || '').toLowerCase();
    const runningCommit = String(info['running-commit'] || this.runningInfo.commit).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(remoteCommit) || !/^[0-9a-f]{64}$/.test(localCommit)
      || !/^[0-9a-f]{64}$/.test(runningCommit)
      || runningCommit !== this.runningInfo.commit.toLowerCase()) return;
    const mine = ++this.availabilityGeneration;
    try {
      const release = validateUpdateInfo({
        ...(await this.releaseResolver()),
        schemaVersion: 1,
        appId: FLATPAK_APP_ID,
        branch: 'stable',
      });
      if (this.stopped || mine !== this.availabilityGeneration) return;
      // The portal deploys remote-commit. Accepting a manifest that names the
      // older local deployment would let publication lag install a commit the
      // user never approved, even though the later relaunch check would catch it.
      if (release.commit !== remoteCommit) {
        throw Object.assign(new Error('The Flatpak repository commit does not match its update manifest.'), {
          code: 'FLATPAK_FEED_MISMATCH',
          publicMessage: 'The Flatpak update feed is still being published. Try again shortly.',
        });
      }
      this.latest = release;
      this.installTarget = null;
      this.deployment = { runningCommit, localCommit, remoteCommit };
      if (release.commit === this.runningInfo.commit.toLowerCase()) this.emit('not-available');
      else this.emit('available', release);
    } catch (error) {
      if (!this.stopped && mine === this.availabilityGeneration) this.emit('error', normalizeFlatpakError(error));
    }
  }

  _handleProgress(rawInfo) {
    const info = unwrap(rawInfo) || {};
    const status = Number(info.status || 0);
    const percent = Math.max(0, Math.min(100, Number(info.progress) || 0));
    this.emit('progress', { percent });
    if (status === 0) return;
    if (status === 2) {
      this.emit('ready');
      this.resolveUpdate?.();
      this._clearUpdatePromise();
      return;
    }
    if (status === 1) {
      const error = new Error('The Flatpak portal reported that there was no update to deploy.');
      error.code = 'FLATPAK_UPDATE_EMPTY';
      error.publicMessage = 'The Flatpak repository has not made this update available yet. Try again shortly.';
      this.rejectUpdate?.(error);
      this._clearUpdatePromise();
      return;
    }
    const error = new Error(typeof info.error_message === 'string' ? info.error_message : 'Flatpak update failed.');
    error.type = typeof info.error === 'string' ? info.error : '';
    error.code = error.type || 'FLATPAK_UPDATE_FAILED';
    const normalized = normalizeFlatpakError(error);
    this.rejectUpdate?.(normalized);
    this._clearUpdatePromise();
  }

  _clearUpdatePromise() {
    this.updatePromise = null;
    this.resolveUpdate = null;
    this.rejectUpdate = null;
  }

  async download(expectedVersion) {
    await this.start();
    if (!this.monitor || !this.latest || this.latest.version !== expectedVersion) {
      const error = new Error('Flatpak did not report the expected update.');
      error.code = 'UPDATE_TARGET_CHANGED';
      throw error;
    }
    const fresh = validateUpdateInfo({
      ...(await this.releaseResolver()),
      schemaVersion: 1,
      appId: FLATPAK_APP_ID,
      branch: 'stable',
    });
    if (fresh.version !== this.latest.version || fresh.commit !== this.latest.commit) {
      this.latest = fresh;
      this.installTarget = null;
      const error = new Error('A newer Flatpak update replaced the proposed version.');
      error.code = 'UPDATE_TARGET_CHANGED';
      error.publicMessage = 'A newer update became available. The app will refresh the proposal.';
      throw error;
    }
    if (this.updatePromise) return this.updatePromise;
    const updatePromise = new Promise((resolve, reject) => {
      this.resolveUpdate = resolve;
      this.rejectUpdate = reject;
    });
    this.updatePromise = updatePromise;
    try {
      await this.monitor.Update(this.parentWindow(), {});
    } catch (error) {
      this._clearUpdatePromise();
      throw normalizeFlatpakError(error);
    }
    try {
      await updatePromise;
    } catch (error) {
      // Empty can also mean a newer deployment is already installed while this
      // old process is still running. Prove that with a latest-version probe;
      // otherwise fail here, before any Local work is shut down.
      if (error?.code !== 'FLATPAK_UPDATE_EMPTY') throw error;
      await this.preflightInstall(expectedVersion);
    }
  }

  _assertRelaunchFacility() {
    try {
      this.fs.accessSync(this.flatpakSpawn, fs.constants.X_OK);
      this.fs.mkdirSync(this.relaunchDirectory, { recursive: true, mode: 0o700 });
      this.fs.accessSync(this.relaunchDirectory, fs.constants.W_OK);
    } catch (error) {
      error.code = 'FLATPAK_RELAUNCH_UNAVAILABLE';
      error.publicMessage = 'The update was downloaded, but this Flatpak cannot relaunch itself. Restart it from your applications menu.';
      error.retryable = false;
      throw error;
    }
  }

  async _probeDeployment(target) {
    const token = this.randomBytes(24).toString('hex');
    const requestFile = path.join(this.relaunchDirectory, `${token}.request.json`);
    const ackFile = path.join(this.relaunchDirectory, `${token}.ack.json`);
    writeJsonAtomic(requestFile, {
      schemaVersion: 1,
      mode: 'probe',
      token,
      expectedVersion: target.version,
      expectedCommit: target.commit,
      requestedAt: new Date().toISOString(),
    }, this.fs);
    try {
      const child = this.spawnFn(this.flatpakSpawn, [
        '--latest-version',
        this.executable,
        `--cc-web-update-probe=${token}`,
      ], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      await waitForSpawn(child);
      child.unref?.();
      const ack = await this.waitForAck(ackFile);
      if (ack?.schemaVersion !== 1 || ack?.token !== token || ack?.mode !== 'probe'
        || !ack.ok || ack.version !== target.version
        || String(ack.commit || '').toLowerCase() !== target.commit) {
        const error = new Error('The installed Flatpak deployment does not match the proposed update.');
        error.code = typeof ack?.code === 'string' ? ack.code : 'FLATPAK_DEPLOYMENT_UNVERIFIED';
        error.publicMessage = 'The Flatpak update is not ready on this computer yet. Try again shortly.';
        throw error;
      }
    } finally {
      for (const filename of [requestFile, ackFile]) {
        try { this.fs.unlinkSync(filename); } catch { /* best-effort handshake cleanup */ }
      }
    }
  }

  async preflightInstall(expectedVersion) {
    if (!this.latest || this.latest.version !== expectedVersion) {
      throw Object.assign(new Error('The Flatpak relaunch target changed.'), { code: 'UPDATE_TARGET_CHANGED' });
    }
    const target = Object.freeze({ version: this.latest.version, commit: this.latest.commit });
    if (this.installTarget?.version === target.version && this.installTarget?.commit === target.commit) return;
    this._assertRelaunchFacility();
    await this._probeDeployment(target);
    this.installTarget = target;
  }

  async install(expectedVersion) {
    await this.preflightInstall(expectedVersion);
    const target = this.installTarget;
    const token = this.randomBytes(24).toString('hex');
    const requestFile = path.join(this.relaunchDirectory, `${token}.request.json`);
    const ackFile = path.join(this.relaunchDirectory, `${token}.ack.json`);
    writeJsonAtomic(requestFile, {
      schemaVersion: 1,
      mode: 'relaunch',
      token,
      expectedVersion,
      expectedCommit: target.commit,
      requestedAt: new Date().toISOString(),
    }, this.fs);

    let lockReleased = false;
    let child = null;
    try {
      this.releaseSingleInstanceLock();
      lockReleased = true;
      child = this.spawnFn(this.flatpakSpawn, [
        '--latest-version',
        this.executable,
        `--cc-web-update-relaunch=${token}`,
      ], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      await waitForSpawn(child);
      child.unref?.();
      const ack = await this.waitForAck(ackFile);
      if (ack?.schemaVersion !== 1 || ack?.token !== token || ack?.mode !== 'relaunch'
        || !ack?.ok || ack.version !== expectedVersion
        || String(ack.commit || '').toLowerCase() !== target.commit) {
        const error = new Error('The updated Flatpak did not start with the expected version.');
        error.code = typeof ack?.code === 'string' ? ack.code : 'FLATPAK_RELAUNCH_MISMATCH';
        error.publicMessage = 'The new Flatpak could not start. Try again or launch it from your applications menu.';
        throw error;
      }
      return { quitHandled: false };
    } catch (error) {
      if (lockReleased && this.reacquireSingleInstanceLock() !== true) {
        error.code = 'FLATPAK_RELAUNCH_LOCK_LOST';
        error.publicMessage = 'The updated app may already be starting. Close this window if the new one appears.';
      }
      throw normalizeFlatpakError(error);
    } finally {
      for (const filename of [requestFile, ackFile]) {
        try { this.fs.unlinkSync(filename); } catch { /* best-effort handshake cleanup */ }
      }
    }
  }
}

module.exports = {
  FLATPAK_APP_ID,
  FLATPAK_BUS_NAME,
  FLATPAK_INTERFACE,
  FLATPAK_OBJECT_PATH,
  FLATPAK_UPDATE_INFO_URL,
  FLATPAK_UPDATE_SIGNATURE_URL,
  FlatpakUpdaterProvider,
  UPDATE_MONITOR_INTERFACE,
  fetchFlatpakUpdateInfo,
  normalizeFlatpakError,
  parseFlatpakInfo,
  readResponseLimited,
  readRunningFlatpakInfo,
  unwrap,
  validateUpdateInfo,
  verifyUpdateInfoSignature,
  waitForRelaunchAck,
  writeJsonAtomic,
};
