'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const {
  createPhoneAccessGateway,
  exactHttpsOrigin,
} = require('./phone-access-gateway.js');
const { ensurePhoneAccessCertificates } = require('./phone-access-certificates.js');
const {
  DEFAULT_PHONE_ACCESS_PORT,
  listPhoneAccessInterfaces,
  validatePhoneAccessAddress,
} = require('./phone-access-network.js');
const { inspectTailscale, normalizeTailscaleDnsName } = require('./tailscale-status.js');

function jsonError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error.slice(0, 500);
  return String(error.message || error).slice(0, 500);
}

function listNetworkInterfaces(provider) {
  if (provider && typeof provider.listPhoneAccessInterfaces === 'function') {
    return provider.listPhoneAccessInterfaces().sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  }
  if (provider && typeof provider.list === 'function') provider = provider.list.bind(provider);
  const rows = listPhoneAccessInterfaces(provider === undefined ? {} : { networkInterfaces: provider });
  return rows.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
}

function readMaterialFile(value, label, fileSystem = fs) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return fileSystem.readFileSync(value);
  throw new TypeError(`The certificate helper did not provide ${label}`);
}

function certificateFingerprint(certificate) {
  try { return new crypto.X509Certificate(certificate).fingerprint256; } catch { return undefined; }
}

async function loadCertificateMaterial(helper, dataDir, address, fileSystem = fs) {
  let material;
  if (typeof helper === 'function') {
    material = await helper({ dataDir, hosts: [address] });
  } else if (helper && typeof helper.ensurePhoneAccessCertificates === 'function') {
    material = await helper.ensurePhoneAccessCertificates({ dataDir, hosts: [address] });
  } else if (helper && typeof helper.ensure === 'function') {
    material = await helper.ensure({ dataDir, hosts: [address] });
  } else if (helper && typeof helper.get === 'function') {
    material = await helper.get({ dataDir, hosts: [address] });
  } else if (helper) {
    material = helper;
  } else {
    material = await ensurePhoneAccessCertificates({ dataDir, hosts: [address] });
  }
  const keyValue = material.key ?? material.keyFile;
  const certValue = material.cert ?? material.certFile;
  const caValue = material.ca ?? material.caFile;
  const key = readMaterialFile(keyValue, 'a TLS private key', fileSystem);
  const cert = readMaterialFile(certValue, 'a TLS certificate', fileSystem);
  const ca = caValue == null ? null : readMaterialFile(caValue, 'a CA certificate', fileSystem);
  return {
    key,
    cert,
    ...(ca ? { ca } : {}),
    fingerprint: material.caFingerprint || material.fingerprint
      || (ca ? certificateFingerprint(ca) : certificateFingerprint(cert)),
  };
}

async function defaultCheckTailscale(options = {}) {
  return inspectTailscale(options);
}

function safeTailscaleStatus(value, configuredOrigin) {
  const source = value && typeof value === 'object' ? value : {};
  let reportedOrigin;
  try { if (source.origin) reportedOrigin = exactTailscaleOrigin(source.origin); } catch { /* discard helper mistakes */ }
  return {
    installed: source.installed === true,
    online: source.online === true,
    serve: source.serve === true,
    funnel: source.funnel === true,
    ...(reportedOrigin ? { origin: reportedOrigin } : {}),
    ...(source.funnel === true
      ? { message: 'Tailscale Funnel is enabled. Disable Funnel before allowing phone access.' }
      : source.message ? { message: String(source.message).slice(0, 500) } : {}),
  };
}

function exactTailscaleOrigin(value) {
  const origin = exactHttpsOrigin(value);
  const url = new URL(origin);
  if (url.port || normalizeTailscaleDnsName(url.hostname) !== url.hostname) {
    throw new TypeError('The Tailscale origin must be exactly https://<device>.<tailnet>.ts.net');
  }
  return origin;
}

class PhoneAccessService {
  constructor(options = {}) {
    if (!options.controller || typeof options.controller.listTargets !== 'function'
      || typeof options.controller.request !== 'function') {
      throw new TypeError('A controller facade with listTargets() and request() is required');
    }
    this.controller = options.controller;
    this.dataDir = options.dataDir || null;
    this.certificate = options.certificate || null;
    this.network = options.network;
    this.tailscale = options.tailscale || null;
    this.gatewayFactory = options.gatewayFactory || createPhoneAccessGateway;
    this.gatewayOptions = options.gatewayOptions || {};
    this.allowEphemeralPort = options.allowEphemeralPort === true;
    this.interfacePollMs = options.interfacePollMs === undefined ? 5_000 : options.interfacePollMs;
    if (!Number.isFinite(this.interfacePollMs) || this.interfacePollMs < 1_000) {
      throw new TypeError('The phone interface polling interval must be at least 1000ms');
    }
    this.setIntervalImpl = options.setIntervalImpl || setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl || clearInterval;
    this.interfaceTimer = null;
    this.fileSystem = options.fileSystem || fs;
    this.now = options.now || Date.now;
    this.localAvailable = options.localAvailable === true;
    this.localError = this.localAvailable ? null : jsonError(options.localError || 'The local server is unavailable.');
    this.state = this.localAvailable ? 'off' : 'unavailable';
    this.error = null;
    this.gateway = null;
    this.configuration = null;
    this.pairing = null;
    this.ca = null;
    // An origin is valid only for one active listener after a fresh Serve
    // inspection. Never seed a later start from remembered process state.
    this.tailscaleOrigin = null;
    this.tailscaleStatus = null;
    this.caCertificate = null;
    this.closed = false;
    this.transition = Promise.resolve();
  }

  _interfaces() {
    try {
      const current = this.configuration;
      return listNetworkInterfaces(this.network).map((entry) => ({
        ...entry,
        ...(current?.address === entry.address && current?.origins?.lan ? { origin: current.origins.lan } : {}),
      }));
    } catch {
      return [];
    }
  }

  _stopInterfaceMonitor() {
    if (!this.interfaceTimer) return;
    this.clearIntervalImpl(this.interfaceTimer);
    this.interfaceTimer = null;
  }

  _startInterfaceMonitor(address) {
    this._stopInterfaceMonitor();
    if (!address) return;
    this.interfaceTimer = this.setIntervalImpl(() => {
      try {
        validatePhoneAccessAddress(address, listNetworkInterfaces(this.network));
      } catch {
        this._stopInterfaceMonitor();
        void this.stop().then(() => {
          this.state = 'error';
          this.error = `Phone access stopped because ${address} is no longer assigned to an active network interface.`;
        }, () => {
          this.state = 'error';
          this.error = `Phone access could not safely close after ${address} left the network.`;
        });
      }
    }, this.interfacePollMs);
    this.interfaceTimer.unref?.();
  }

  status() {
    if (this.pairing && Date.parse(this.pairing.expiresAt) <= this.now()) this.pairing = null;
    const devices = this.gateway?.devices?.() || [];
    const state = !this.localAvailable && this.state !== 'starting' ? 'unavailable' : this.state;
    return {
      state,
      available: this.localAvailable && !this.closed,
      ...(this.configuration?.mode ? { mode: this.configuration.mode } : {}),
      ...(this.configuration?.port ? { port: this.configuration.port } : {}),
      interfaces: this._interfaces(),
      origins: { ...(this.configuration?.origins || {}) },
      ...(this.pairing ? { pairing: { ...this.pairing } } : {}),
      devices,
      ...(this.ca ? { ca: { ...this.ca } } : {}),
      ...(this.tailscaleStatus ? { tailscale: { ...this.tailscaleStatus } } : {}),
      ...(this.error || (!this.localAvailable && this.localError) ? { error: this.error || this.localError } : {}),
    };
  }

  _enqueue(action) {
    const current = this.transition.then(action, action);
    this.transition = current.catch(() => {});
    return current;
  }

  async start(request = {}) {
    return this._enqueue(async () => {
      if (this.closed) throw new Error('Phone access service is closed');
      if (!this.localAvailable) throw new Error(this.localError || 'The local server is unavailable.');
      if (this.gateway) throw new Error('Phone access is already running');
      const mode = request.mode;
      if (!['lan', 'tailscale', 'both'].includes(mode)) throw new TypeError('Phone access mode must be lan, tailscale, or both');
      const port = request.port === undefined ? DEFAULT_PHONE_ACCESS_PORT : request.port;
      if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)
        || (port === 0 && !this.allowEphemeralPort)) {
        throw new TypeError(`The phone access port must be an unprivileged TCP port (default ${DEFAULT_PHONE_ACCESS_PORT})`);
      }
      const interfaces = listNetworkInterfaces(this.network);
      let address = request.address;
      if (mode === 'lan' || mode === 'both') {
        if (!address && interfaces.length === 1) address = interfaces[0].address;
        address = validatePhoneAccessAddress(address, interfaces).address;
      }
      this.state = 'starting';
      this.error = null;
      if (mode === 'tailscale' || mode === 'both') {
        this.tailscaleOrigin = null;
        this.tailscaleStatus = null;
      }
      let tls;
      let gateway;
      try {
        if (mode === 'lan' || mode === 'both') {
          tls = await loadCertificateMaterial(this.certificate, this.dataDir, address, this.fileSystem);
        }
        if (!this.localAvailable || this.closed) {
          throw new Error(this.localError || 'The local server became unavailable while phone access was starting.');
        }
        gateway = this.gatewayFactory({
          controller: this.controller,
          now: this.now,
          allowEphemeralPort: this.allowEphemeralPort,
          ...this.gatewayOptions,
        });
        const bound = await gateway.start({
          mode, address, port,
          ...(tls ? { tls } : {}),
        });
        if (!this.localAvailable || this.closed) {
          throw new Error(this.localError || 'The local server became unavailable while phone access was starting.');
        }
        const initialPairingOrigin = bound.origins.lan || bound.origins.tailscale;
        const initialPairing = initialPairingOrigin ? gateway.createPairing(initialPairingOrigin) : null;
        this.gateway = gateway;
        this.configuration = { mode, address, port: bound.port, origins: { ...bound.origins } };
        this.ca = tls?.ca ? {
          downloadUrl: bound.origins.lan ? `${bound.origins.lan}/ca.crt` : undefined,
          ...(tls.fingerprint ? { fingerprint: tls.fingerprint } : {}),
        } : null;
        this.caCertificate = tls?.ca ? Buffer.from(tls.ca) : null;
        this.pairing = initialPairing;
        this.state = 'running';
        if (mode === 'lan' || mode === 'both') this._startInterfaceMonitor(address);
        return this.status();
      } catch (error) {
        await Promise.resolve(gateway?.stop?.()).catch(() => {});
        this.gateway = null;
        this.configuration = null;
        this.ca = null;
        this.caCertificate = null;
        this.pairing = null;
        this.state = 'error';
        this.error = jsonError(error);
        throw error;
      }
    });
  }

  async stop() {
    return this._enqueue(() => this._stopNow());
  }

  async _stopNow() {
    this._stopInterfaceMonitor();
    const gateway = this.gateway;
    // Clear published capabilities before asynchronous listener shutdown.
    this.gateway = null;
    this.configuration = null;
    this.pairing = null;
    this.ca = null;
    this.caCertificate = null;
    this.tailscaleOrigin = null;
    this.tailscaleStatus = null;
    this.error = null;
    this.state = this.localAvailable && !this.closed ? 'off' : 'unavailable';
    let failure = null;
    try { await gateway?.stop?.(); } catch (error) { failure = error; }
    if (failure) {
      this.error = jsonError(failure);
      this.state = 'error';
      throw failure;
    }
    return this.status();
  }

  createPairing({ origin } = {}) {
    if (!this.gateway || this.state !== 'running') throw new Error('Phone access is not running');
    this.pairing = this.gateway.createPairing(origin);
    return this.status();
  }

  revoke(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('A phone device id is required');
    this.gateway?.revoke(deviceId);
    return this.status();
  }

  exportCa() {
    if (!this.gateway || this.state !== 'running' || !this.caCertificate) {
      throw Object.assign(new Error('The LAN phone-access CA is unavailable.'), { statusCode: 404 });
    }
    return Buffer.from(this.caCertificate);
  }

  async _readTailscale(port) {
    const context = { port };
    let value;
    if (typeof this.tailscale === 'function') value = await this.tailscale(context);
    else if (typeof this.tailscale?.check === 'function') value = await this.tailscale.check(context);
    else if (typeof this.tailscale?.inspectTailscale === 'function') value = await this.tailscale.inspectTailscale(context);
    else value = await defaultCheckTailscale(context);
    this.tailscaleStatus = safeTailscaleStatus(value);
    return this.tailscaleStatus;
  }

  async checkTailscale() {
    await this._readTailscale(this.configuration?.port || DEFAULT_PHONE_ACCESS_PORT);
    return this.status();
  }

  async setTailscaleOrigin(origin) {
    const normalized = exactTailscaleOrigin(origin);
    if (!this.gateway || !this.configuration
      || (this.configuration.mode !== 'tailscale' && this.configuration.mode !== 'both')) {
      throw new Error('Start a Tailscale phone-access backend before confirming its origin.');
    }
    // Never publish from a cached check: Serve, Funnel, the daemon, or the
    // selected backend port may have changed since the dialog last rendered.
    this.tailscaleStatus = null;
    const inspected = await this._readTailscale(this.configuration.port);
    if (inspected.funnel) {
      throw new Error('Disable Tailscale Funnel before confirming the phone access origin.');
    }
    if (!inspected.installed) throw new Error('Install Tailscale before confirming phone access.');
    if (!inspected.online) throw new Error('Connect this computer to Tailscale before confirming phone access.');
    if (!inspected.serve) {
      throw new Error(`Tailscale Serve must proxy / to http://127.0.0.1:${this.configuration.port} before phone access can be confirmed.`);
    }
    if (inspected.origin !== normalized) {
      throw new Error('The entered address does not match this computer’s exact Tailscale DNS name.');
    }
    this.tailscaleOrigin = normalized;
    if (this.gateway && (this.configuration.mode === 'tailscale' || this.configuration.mode === 'both')) {
      const previous = this.configuration.origins.tailscale;
      const bound = this.gateway.setTailscaleOrigin(normalized);
      this.configuration = { ...this.configuration, origins: { ...bound.origins } };
      if (previous && previous !== normalized && this.pairing?.origin === previous) this.pairing = null;
      this.pairing = this.gateway.createPairing(normalized);
    }
    return this.status();
  }

  setLocalAvailable(available, error) {
    this.localAvailable = available === true;
    this.localError = this.localAvailable ? null : jsonError(error || 'The local server is unavailable.');
    return this._enqueue(async () => {
      if (!this.localAvailable && this.gateway) {
        try { await this._stopNow(); } catch { /* status already carries the shutdown failure */ }
      } else if (!this.localAvailable) {
        this.state = 'unavailable';
      } else if (this.state === 'unavailable') {
        this.state = 'off';
        this.error = null;
      }
      return this.status();
    });
  }

  async close() {
    this.closed = true;
    try { await this.stop(); } catch { /* closing is best effort and state is already sealed */ }
    this.state = 'unavailable';
    return this.status();
  }
}

function createPhoneAccessService(options) {
  return new PhoneAccessService(options);
}

module.exports = {
  PhoneAccessService,
  certificateFingerprint,
  createPhoneAccessService,
  defaultCheckTailscale,
  exactTailscaleOrigin,
  listNetworkInterfaces,
  loadCertificateMaterial,
  safeTailscaleStatus,
};
