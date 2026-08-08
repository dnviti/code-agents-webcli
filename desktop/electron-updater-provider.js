'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_HANDOFF_TIMEOUT_MS = 30_000;

class ElectronUpdaterProvider extends EventEmitter {
  constructor({
    autoUpdater,
    platform = process.platform,
    architecture = process.arch,
    environment = process.env,
    beforeInstall = () => undefined,
    afterInstallFailure = () => undefined,
    nativeAutoUpdater = null,
    installHandoffTimeoutMs = INSTALL_HANDOFF_TIMEOUT_MS,
  }) {
    super();
    this.autoUpdater = autoUpdater;
    this.platform = platform;
    this.architecture = architecture;
    this.environment = environment;
    this.beforeInstall = beforeInstall;
    this.afterInstallFailure = afterInstallFailure;
    this.nativeAutoUpdater = nativeAutoUpdater;
    this.installHandoffTimeoutMs = installHandoffTimeoutMs;
    this.bound = [];
    this.started = false;

    // Setting a custom channel in electron-updater also enables downgrades.
    // Select the architecture feed first, then explicitly close that door.
    if (platform === 'darwin') {
      autoUpdater.channel = architecture === 'arm64' ? 'latest-arm64' : 'latest-x64';
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
  }

  _bind(event, listener) {
    this.autoUpdater.on(event, listener);
    this.bound.push([event, listener]);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._bind('update-available', (info) => this.emit('available', {
      version: info?.version,
      releaseName: info?.releaseName,
      releaseDate: info?.releaseDate,
      releaseNotes: info?.releaseNotes,
    }));
    this._bind('update-not-available', () => this.emit('not-available'));
    this._bind('download-progress', (progress) => this.emit('progress', progress));
    this._bind('update-downloaded', () => this.emit('ready'));
    this._bind('update-cancelled', () => {
      const error = new Error('The update download was cancelled.');
      error.code = 'UPDATE_CANCELLED';
      error.publicMessage = 'The update download was interrupted. Please try again.';
      this.emit('error', error);
    });
    this._bind('error', (error) => this.emit('error', error));
  }

  stop() {
    for (const [event, listener] of this.bound) this.autoUpdater.off(event, listener);
    this.bound = [];
    this.started = false;
  }

  async check() {
    await this.autoUpdater.checkForUpdates();
    return null;
  }

  _assertAppImageWritable() {
    if (this.platform !== 'linux') return;
    const filename = this.environment.APPIMAGE;
    if (!filename) {
      // A packaged Linux app without APPIMAGE is a deb/rpm/pacman install:
      // electron-updater selects its native updater from the `package-type`
      // resource, which installs through the package manager and has no
      // in-place writability requirement. Only real AppImage runs replace
      // themselves in place, and electron-updater itself deactivates the
      // AppImageUpdater when APPIMAGE is unset.
      return;
    }
    try {
      const stat = fs.statSync(filename);
      if (!stat.isFile()) throw new Error('APPIMAGE does not name a regular file.');
      fs.accessSync(filename, fs.constants.R_OK | fs.constants.W_OK);
      // AppImageUpdater replaces/renames the image; writable file bits alone
      // are insufficient when its containing directory is read-only.
      fs.accessSync(path.dirname(filename), fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      const error = new Error('The running AppImage is not writable.');
      error.code = 'APPIMAGE_NOT_WRITABLE';
      throw error;
    }
  }

  async download() {
    this._assertAppImageWritable();
    await this.autoUpdater.downloadUpdate();
  }

  async install() {
    // The shipped NSIS target is assisted (`oneClick: false`) for first-time
    // installs. An accepted in-app update must therefore use NSIS silent mode;
    // otherwise Electron closes into a second installer confirmation instead
    // of completing the one-click update and relaunch contract.
    const isSilent = this.platform === 'win32';
    let authorized = false;
    let revoked = false;
    const revoke = () => {
      if (!authorized || revoked) return;
      revoked = true;
      this.afterInstallFailure();
    };
    const failure = (error) => {
      const value = error instanceof Error ? error : new Error('The native installer did not start.');
      if (!value.code) value.code = 'UPDATE_INSTALL_LAUNCH_FAILED';
      if (!value.publicMessage) {
        value.publicMessage = 'The update was downloaded, but its installer could not start. Please try again.';
      }
      return value;
    };

    try {
      this.beforeInstall();
      authorized = true;
      if (!this.nativeAutoUpdater?.once) {
        this.autoUpdater.quitAndInstall(isSilent, true);
        if (this.platform !== 'darwin'
          && 'quitAndInstallCalled' in this.autoUpdater
          && this.autoUpdater.quitAndInstallCalled !== true) {
          throw failure();
        }
        return { quitHandled: true };
      }

      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.nativeAutoUpdater.off?.('before-quit-for-update', handoff);
          this.autoUpdater.off?.('error', failed);
          callback(value);
        };
        const handoff = () => finish(resolve, { quitHandled: true });
        const failed = (error) => {
          revoke();
          finish(reject, failure(error));
        };
        const timeout = setTimeout(() => failed(Object.assign(
          new Error('Timed out waiting for the native installer handoff.'),
          { code: 'UPDATE_INSTALL_HANDOFF_TIMEOUT' },
        )), this.installHandoffTimeoutMs);
        timeout.unref?.();
        this.nativeAutoUpdater.once('before-quit-for-update', handoff);
        this.autoUpdater.once('error', failed);
        try {
          this.autoUpdater.quitAndInstall(isSilent, true);
          if (this.platform !== 'darwin'
            && 'quitAndInstallCalled' in this.autoUpdater
            && this.autoUpdater.quitAndInstallCalled !== true) {
            failed();
          }
        } catch (error) {
          failed(error);
        }
      });
    } catch (error) {
      revoke();
      throw failure(error);
    }
  }
}

function loadElectronUpdaterProvider(options = {}) {
  // Kept lazy so source/dev/smoke starts never initialize updater networking.
  const imported = require('electron-updater');
  return new ElectronUpdaterProvider({
    autoUpdater: imported.autoUpdater,
    ...options,
  });
}

module.exports = {
  ElectronUpdaterProvider,
  INSTALL_HANDOFF_TIMEOUT_MS,
  loadElectronUpdaterProvider,
};
