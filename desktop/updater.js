'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 5_000;
const MAX_TEXT_LENGTH = 4_000;

function safeText(value, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function releaseNotesText(value) {
  if (typeof value === 'string') return safeText(value);
  if (!Array.isArray(value)) return null;
  return safeText(value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry.note === 'string') return entry.note;
    return '';
  }).filter(Boolean).join('\n\n'));
}

function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    String(value || '').trim(),
  );
  if (!match) return null;
  return match.slice(1, 4).map((part) => BigInt(part));
}

function isStableNewerVersion(candidate, current) {
  const next = parseStableVersion(candidate);
  const running = parseStableVersion(current);
  if (!next || !running) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > running[index]) return true;
    if (next[index] < running[index]) return false;
  }
  return false;
}

function snapshotState(state) {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : null,
  };
}

function createInitialState(currentVersion, provider = null, enabled = true) {
  return {
    provider,
    phase: enabled ? 'idle' : 'disabled',
    currentVersion,
    targetVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    checkedAt: null,
    progress: null,
    prompt: null,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    generation: 0,
  };
}

function readPersistedState(filename) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const deferredVersion = safeText(parsed?.deferredVersion, 128);
    const promptedVersion = safeText(parsed?.promptedVersion, 128) || deferredVersion;
    const rawTarget = parsed?.knownTarget;
    const targetVersion = safeText(rawTarget?.version, 128);
    const knownTarget = targetVersion ? {
      version: targetVersion,
      releaseName: safeText(rawTarget?.releaseName, 300),
      releaseDate: safeText(rawTarget?.releaseDate, 80),
      releaseNotes: safeText(rawTarget?.releaseNotes),
      checkedAt: safeText(rawTarget?.checkedAt, 80),
    } : null;
    return { deferredVersion, promptedVersion, knownTarget };
  } catch {
    return { deferredVersion: null, promptedVersion: null, knownTarget: null };
  }
}

function writePersistedState(filename, state) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function publicError(error, fallbackCode = 'update_failed') {
  const code = safeText(error?.code, 80) || fallbackCode;
  if (error?.publicMessage) {
    return {
      code,
      message: safeText(error.publicMessage, 500) || 'The update could not be completed.',
      retryable: error?.retryable !== false,
    };
  }
  if (code === 'APPIMAGE_NOT_WRITABLE' || code === 'EACCES' || code === 'EROFS') {
    return {
      code,
      message: 'This AppImage cannot replace itself. Move it to a writable folder or download the new version manually.',
      retryable: false,
    };
  }
  if (code === 'org.freedesktop.DBus.Error.NotSupported' || code === 'FLATPAK_PERMISSIONS') {
    return {
      code: 'FLATPAK_PERMISSIONS',
      message: 'This Flatpak update needs new permissions and must be installed with the system software tool.',
      retryable: false,
    };
  }
  if (code === 'FLATPAK_RELAUNCH_UNAVAILABLE') {
    return { code, message: 'Restart the Flatpak from your applications menu to finish the update.', retryable: false };
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|offline/i.test(`${code} ${error?.message || ''}`)) {
    return { code: 'network', message: 'The update service is temporarily unreachable. Please try again.', retryable: true };
  }
  return { code, message: 'The update could not be completed. Please try again.', retryable: true };
}

class DesktopUpdateService extends EventEmitter {
  constructor(options) {
    super();
    this.provider = options.provider || null;
    this.providerName = options.providerName || null;
    this.currentVersion = options.currentVersion;
    this.stateFile = options.stateFile;
    this.enabled = options.enabled !== false && Boolean(this.provider);
    this.prepareInstall = options.prepareInstall || (async () => undefined);
    this.finishInstall = options.finishInstall || (async () => undefined);
    this.beginInstall = options.beginInstall || (async () => undefined);
    this.now = options.now || (() => new Date());
    this.random = options.random || Math.random;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_CHECK_DELAY_MS;
    this.intervalMs = options.intervalMs ?? SIX_HOURS_MS;
    this.persisted = readPersistedState(this.stateFile);
    this.state = createInitialState(this.currentVersion, this.providerName, this.enabled);
    const remembered = this.persisted.knownTarget;
    if (this.enabled && remembered
      && isStableNewerVersion(remembered.version, this.currentVersion)) {
      Object.assign(this.state, {
        phase: 'available',
        targetVersion: remembered.version,
        releaseName: remembered.releaseName,
        releaseDate: remembered.releaseDate,
        releaseNotes: remembered.releaseNotes,
        checkedAt: remembered.checkedAt,
        prompt: this.persisted.promptedVersion === remembered.version
          || this.persisted.deferredVersion === remembered.version
          ? 'deferred' : 'automatic',
      });
    }
    // A persisted reminder is display-only until this process confirms the
    // exact target through its trusted provider. Renderer state can never turn
    // cached metadata into an install authority.
    this.confirmedTargetVersion = null;
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.checkPromise = null;
    this.installPromise = null;
    this.checkFailures = 0;
    this.providerListeners = [];
  }

  snapshot() {
    return snapshotState(this.state);
  }

  /**
   * Record that a trusted renderer received the one automatic proposal without
   * emitting a second state that would immediately close the dialog it just
   * opened. Later snapshots/reloads receive the durable reminder instead.
   */
  markAutomaticPromptDelivered(expectedVersion) {
    if (!expectedVersion || this.state.targetVersion !== expectedVersion
      || this.state.phase !== 'available' || this.state.prompt !== 'automatic') return this.snapshot();
    this.persisted.promptedVersion = expectedVersion;
    this._persist();
    this.state = {
      ...this.state,
      prompt: 'deferred',
      generation: this.state.generation + 1,
    };
    return this.snapshot();
  }

  _set(patch) {
    const previous = this.state;
    this.state = {
      ...this.state,
      ...patch,
      generation: this.state.generation + 1,
    };
    if (previous.phase !== this.state.phase
      || previous.targetVersion !== this.state.targetVersion
      || previous.errorCode !== this.state.errorCode) {
      console.info(
        'Desktop update transition:',
        `${previous.phase}->${this.state.phase}`,
        this.state.targetVersion ? `target=${this.state.targetVersion}` : 'target=none',
        this.state.errorCode ? `error=${this.state.errorCode}` : 'error=none',
      );
    }
    const value = this.snapshot();
    this.emit('state', value);
    return value;
  }

  _listen(event, listener) {
    this.provider.on(event, listener);
    this.providerListeners.push([event, listener]);
  }

  _bindProvider() {
    this._listen('available', (info) => this._available(info));
    this._listen('not-available', () => this._notAvailable());
    this._listen('progress', (progress) => this._progress(progress));
    this._listen('ready', () => this._ready());
    this._listen('error', (error) => this._providerError(error, this.state.phase === 'checking'));
  }

  start() {
    if (!this.enabled || this.started) return this.snapshot();
    this.started = true;
    this.stopped = false;
    this._bindProvider();
    if (typeof this.provider.start === 'function') {
      Promise.resolve(this.provider.start()).catch((error) => this._providerError(error, true));
    }
    this._schedule(this.initialDelayMs);
    return this.snapshot();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    for (const [event, listener] of this.providerListeners) this.provider.off(event, listener);
    this.providerListeners = [];
    if (typeof this.provider?.stop === 'function') return Promise.resolve(this.provider.stop());
    return Promise.resolve();
  }

  _schedule(delay) {
    if (this.stopped || !this.enabled) return;
    if (this.timer) this.clearTimer(this.timer);
    const jitter = Math.floor(Math.max(0, delay) * 0.1 * this.random());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.check();
    }, Math.max(0, delay) + jitter);
    this.timer?.unref?.();
  }

  async check() {
    if (!this.enabled || this.stopped) return this.snapshot();
    if (this.installPromise) {
      // A periodic timer can land during a long download/install. It must not
      // consume the only future check just because this particular one cannot
      // run safely alongside installation.
      this._schedule(this.intervalMs);
      return this.snapshot();
    }
    if (this.checkPromise) return this.checkPromise;
    const hasKnownTarget = Boolean(this.state.targetVersion
      && ['available', 'error'].includes(this.state.phase));
    if (!hasKnownTarget) {
      this._set({ phase: 'checking', errorCode: null, errorMessage: null, retryable: false });
    }
    this.checkPromise = (async () => {
      try {
        const result = await this.provider.check();
        if (result?.available) this._available(result);
        else if (result?.available === false) this._notAvailable();
        else if (this.state.phase === 'checking') this._set({ phase: 'idle' });
        this.checkFailures = 0;
        this._schedule(this.intervalMs);
      } catch (error) {
        this.checkFailures += 1;
        const retryMs = Math.min(this.intervalMs, 60_000 * (2 ** Math.min(this.checkFailures - 1, 6)));
        this._providerError(error, true);
        this._schedule(retryMs);
      } finally {
        this.checkPromise = null;
      }
      return this.snapshot();
    })();
    return this.checkPromise;
  }

  _available(info) {
    const version = safeText(info?.version, 128);
    if (!version || !isStableNewerVersion(version, this.currentVersion)) {
      if (this.state.phase === 'checking') this._notAvailable();
      return;
    }
    if (this.installPromise || ['downloading', 'ready', 'installing', 'restarting'].includes(this.state.phase)) {
      return;
    }
    if (this.state.targetVersion
      && version !== this.state.targetVersion
      && !isStableNewerVersion(version, this.state.targetVersion)) {
      return;
    }
    const sameTarget = this.state.targetVersion === version;
    const firstPrompt = this.persisted.promptedVersion !== version;
    if (!sameTarget && this.persisted.deferredVersion !== version) {
      this.persisted.deferredVersion = null;
    }
    this.persisted.knownTarget = {
      version,
      releaseName: safeText(info.releaseName, 300),
      releaseDate: safeText(info.releaseDate, 80),
      releaseNotes: releaseNotesText(info.releaseNotes),
      checkedAt: this.now().toISOString(),
    };
    this.confirmedTargetVersion = version;
    this._persist();
    this._set({
      phase: 'available',
      targetVersion: version,
      releaseName: this.persisted.knownTarget.releaseName,
      releaseDate: this.persisted.knownTarget.releaseDate,
      releaseNotes: this.persisted.knownTarget.releaseNotes,
      checkedAt: this.persisted.knownTarget.checkedAt,
      progress: null,
      prompt: sameTarget && this.state.prompt === 'automatic'
        ? 'automatic'
        : firstPrompt ? 'automatic' : 'deferred',
      errorCode: null,
      errorMessage: null,
      retryable: false,
    });
  }

  _notAvailable() {
    // Provider events can arrive after another event from the same check. A
    // late no-update result must never erase a newer target already accepted.
    if (this.installPromise || (!this.checkPromise && this.state.phase !== 'checking')) return;
    this.persisted.deferredVersion = null;
    this.persisted.promptedVersion = null;
    this.persisted.knownTarget = null;
    this.confirmedTargetVersion = null;
    this._persist();
    this._set({
      phase: 'up_to_date',
      targetVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      checkedAt: this.now().toISOString(),
      progress: null,
      prompt: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
    });
  }

  _progress(progress) {
    if (!this.installPromise || !this.state.targetVersion || this.state.phase !== 'downloading') return;
    const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
    const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    this._set({
      phase: 'downloading',
      progress: {
        percent,
        transferred: numberOrNull(progress?.transferred),
        total: numberOrNull(progress?.total),
        bytesPerSecond: numberOrNull(progress?.bytesPerSecond),
      },
    });
  }

  _ready() {
    if (!this.installPromise || !this.state.targetVersion || this.state.phase !== 'downloading') return;
    this._set({ phase: 'ready', progress: this.state.progress });
  }

  _providerError(error, checking = false, direct = false) {
    const detail = publicError(error, checking ? 'check_failed' : 'update_failed');
    // Once graceful shutdown or relaunch has begun, only the awaited install()
    // result may decide success or failure. A delayed transport/event error from
    // an earlier check must not regress a continuing install back to `error`.
    if (!direct && ['installing', 'restarting'].includes(this.state.phase)) {
      console.warn('Ignored late desktop updater event:', detail.code, `phase=${this.state.phase}`);
      return;
    }
    if (checking || !this.state.targetVersion) {
      console.warn('Desktop update check failed:', detail.code);
      this._set({
        phase: this.state.targetVersion ? 'available' : 'idle',
        checkedAt: this.now().toISOString(),
        errorCode: detail.code,
        errorMessage: null,
        retryable: false,
      });
      return;
    }
    this.persisted.deferredVersion = this.state.targetVersion;
    this._persist();
    this._set({
      phase: 'error',
      prompt: 'deferred',
      errorCode: detail.code,
      errorMessage: detail.message,
      retryable: Boolean(this.state.targetVersion) && detail.retryable !== false,
    });
  }

  _persist() {
    try {
      writePersistedState(this.stateFile, {
        deferredVersion: this.persisted.deferredVersion,
        promptedVersion: this.persisted.promptedVersion,
        knownTarget: this.persisted.knownTarget,
      });
    } catch (error) {
      console.warn('Could not persist desktop update state:', error?.code || 'write_failed');
    }
  }

  _assertExpectedVersion(expectedVersion) {
    if (typeof expectedVersion !== 'string'
      || expectedVersion.length > 128
      || expectedVersion !== this.state.targetVersion) {
      const error = new Error('The requested update is no longer current.');
      error.code = 'STALE_UPDATE';
      throw error;
    }
  }

  defer(expectedVersion) {
    this._assertExpectedVersion(expectedVersion);
    if (this.installPromise || ['installing', 'restarting'].includes(this.state.phase)) {
      const error = new Error('The update is already being installed.');
      error.code = 'UPDATE_IN_PROGRESS';
      throw error;
    }
    this.persisted.deferredVersion = expectedVersion;
    this._persist();
    return this._set({ prompt: 'deferred' });
  }

  async install(expectedVersion) {
    this._assertExpectedVersion(expectedVersion);
    if (this.installPromise) return this.installPromise;
    const pendingCheck = this.checkPromise;
    if (pendingCheck) {
      await pendingCheck;
      this._assertExpectedVersion(expectedVersion);
      if (this.installPromise) return this.installPromise;
    }
    // A reminder restored from disk remains useful while offline, but it is
    // never sufficient authority to download or install. Reconfirm it against
    // the fixed provider before accepting this click.
    if (this.confirmedTargetVersion !== expectedVersion) {
      await this.check();
      this._assertExpectedVersion(expectedVersion);
      if (this.confirmedTargetVersion !== expectedVersion) {
        const error = Object.assign(new Error('The remembered update could not be verified.'), {
          code: 'UPDATE_CONFIRMATION_FAILED',
          publicMessage: 'The update could not be verified right now. Check your connection and try again.',
        });
        this._providerError(error, false, true);
        return this.snapshot();
      }
      if (this.installPromise) return this.installPromise;
    }
    if (!['available', 'error'].includes(this.state.phase)) {
      const error = new Error('The update is not ready to start.');
      error.code = 'UPDATE_NOT_AVAILABLE';
      throw error;
    }
    const targetVersion = this.state.targetVersion;
    let refreshAfterFailure = false;
    this.installPromise = (async () => {
      try {
        await this.beginInstall();
        this._set({
          phase: 'downloading',
          progress: { percent: 0, transferred: null, total: null, bytesPerSecond: null },
          prompt: 'automatic',
          errorCode: null,
          errorMessage: null,
          retryable: false,
        });
        await this.provider.download(targetVersion);
        if (this.state.phase === 'downloading') this._ready();
        await this.provider.preflightInstall?.(targetVersion);
        this._set({ phase: 'installing', retryable: false });
        await this.prepareInstall();
        this._set({ phase: 'restarting' });
        const result = await this.provider.install(targetVersion);
        if (!result?.quitHandled) await this.finishInstall();
      } catch (error) {
        refreshAfterFailure = error?.code === 'UPDATE_TARGET_CHANGED';
        this._providerError(error, false, true);
      } finally {
        this.installPromise = null;
        if (refreshAfterFailure && !this.stopped) {
          const timer = this.setTimer(() => void this.check(), 0);
          timer?.unref?.();
        }
      }
      return this.snapshot();
    })();
    const result = await this.installPromise;
    if (this.state.targetVersion !== targetVersion && this.state.phase !== 'restarting') {
      return this.snapshot();
    }
    return result;
  }

  retry(expectedVersion) {
    this._assertExpectedVersion(expectedVersion);
    if (this.state.phase !== 'error') {
      const error = new Error('There is no failed update to retry.');
      error.code = 'UPDATE_NOT_FAILED';
      throw error;
    }
    return this.install(expectedVersion);
  }
}

module.exports = {
  DesktopUpdateService,
  INITIAL_CHECK_DELAY_MS,
  SIX_HOURS_MS,
  createInitialState,
  isStableNewerVersion,
  publicError,
  readPersistedState,
  releaseNotesText,
  safeText,
  writePersistedState,
};
