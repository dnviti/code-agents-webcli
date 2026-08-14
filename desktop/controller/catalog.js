'use strict';

// This module deliberately contains no Electron or network code.  It is the
// durable, local description of destinations; connecting to or removing a
// destination is somebody else's responsibility.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CONTROLLER_PRODUCT_ID } = require('../../dist/sdk/contracts/controller.js');

const SCHEMA_VERSION = 1;
const FRIENDLY_NAME_MAX_LENGTH = 120;
const LOCAL_TARGET = Object.freeze({
  id: 'local',
  type: 'local',
  name: 'Local computer',
  origin: null,
  status: 'ready',
  error: null,
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalOrigin(address) {
  if (typeof address !== 'string' || !address.trim()) throw new TypeError('A server address is required');
  let url;
  try { url = new URL(address.trim()); } catch { throw new TypeError('Server address must be a valid HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Server address must be a canonical HTTPS origin without credentials or a path');
  }
  return url.origin;
}

function friendlyName(name) {
  if (typeof name !== 'string') throw new TypeError('A friendly name is required');
  const normalized = name.trim();
  if (!normalized) throw new TypeError('A friendly name is required');
  if (/[\x00-\x1f\x7f-\x9f]/u.test(normalized)) {
    throw new TypeError('A friendly name cannot contain control characters');
  }
  if (normalized.length > FRIENDLY_NAME_MAX_LENGTH) {
    throw new TypeError(`A friendly name cannot exceed ${FRIENDLY_NAME_MAX_LENGTH} characters`);
  }
  return normalized;
}

function safeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error !== 'object') return { message: String(error) };
  const result = {};
  if (typeof error.code === 'string') result.code = error.code;
  if (typeof error.message === 'string') result.message = error.message;
  return Object.keys(result).length ? result : null;
}

function safeTimestamp(value) {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function sanitizeSession(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const result = {};
  if (typeof metadata.id === 'string') result.id = metadata.id;
  const name = typeof metadata.customName === 'string' && metadata.customName
    ? metadata.customName : metadata.name;
  if (typeof name === 'string') result.name = name;
  const runtime = typeof metadata.runtime === 'string' ? metadata.runtime
    : typeof metadata.agent === 'string' ? metadata.agent
      : typeof metadata.lastAgent === 'string' ? metadata.lastAgent
        : typeof metadata.runtimeLabel === 'string' ? metadata.runtimeLabel : null;
  if (runtime) result.runtime = runtime;
  const status = metadata.active === true ? 'active' : metadata.status;
  if (typeof status === 'string') result.status = status;
  if (typeof metadata.lastActivity === 'string' || typeof metadata.lastActivity === 'number') {
    result.lastActivity = metadata.lastActivity;
  }
  return Object.keys(result).length ? result : null;
}

// The shape is intentionally narrow. It is an in-memory availability aid for
// the current controller process only; session metadata must never enter the
// installation-wide desktop catalog under Electron userData.
function sanitizeOfflineMetadataCache(metadata) {
  const sessions = Array.isArray(metadata) ? metadata : metadata && metadata.sessions;
  if (!Array.isArray(sessions)) return { sessions: [] };
  return { sessions: sessions.map(sanitizeSession).filter(Boolean) };
}

function sanitizeServerIdentity(identity, origin) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const product = identity.product && typeof identity.product === 'object'
    ? identity.product : null;
  let identityOrigin;
  try {
    identityOrigin = canonicalOrigin(identity.address);
  } catch {
    return null;
  }
  if (
    product?.id !== CONTROLLER_PRODUCT_ID
    || typeof product.name !== 'string'
    || typeof identity.version !== 'string'
    || !Number.isInteger(identity.protocolVersion)
    || typeof identity.serverName !== 'string'
    || identityOrigin !== origin
    || !Array.isArray(identity.capabilities)
    || !identity.capabilities.every((value) => typeof value === 'string')
  ) {
    return null;
  }
  return {
    product: { id: CONTROLLER_PRODUCT_ID, name: product.name.slice(0, 80) },
    version: identity.version.slice(0, 80),
    protocolVersion: identity.protocolVersion,
    capabilities: [...new Set(identity.capabilities.map((value) => value.slice(0, 80)))],
    serverName: identity.serverName.slice(0, 120),
    address: origin,
  };
}

function isValidPersistedTarget(target) {
  if (!target || typeof target !== 'object' || target.id === 'local' || typeof target.id !== 'string') return false;
  try {
    return friendlyName(target.name) === target.name && canonicalOrigin(target.origin) === target.origin;
  } catch { return false; }
}

function persistedTarget(target) {
  const result = { id: target.id, type: 'remote', name: target.name, origin: target.origin };
  if (typeof target.status === 'string') result.status = target.status;
  result.error = safeError(target.error);
  if (safeTimestamp(target.lastSuccessfulContact) !== undefined) result.lastSuccessfulContact = target.lastSuccessfulContact;
  if (target.authMarker === true) result.authMarker = true;
  const identity = sanitizeServerIdentity(target.identity, target.origin);
  if (identity) result.identity = identity;
  if (target.certificateOverride && target.certificateOverride.origin === target.origin && typeof target.certificateOverride.fingerprint === 'string') {
    result.certificateOverride = { origin: target.origin, fingerprint: target.certificateOverride.fingerprint };
  }
  return result;
}

function hasPersistedOfflineMetadata(filename, fileSystem = fs) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    return parsed?.version === SCHEMA_VERSION
      && Array.isArray(parsed.targets)
      && parsed.targets.some((target) => (
        target && typeof target === 'object'
        && Object.prototype.hasOwnProperty.call(target, 'offlineMetadataCache')
      ));
  } catch {
    return false;
  }
}

function readCatalog(filename, fileSystem = fs) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.targets) || !parsed.targets.every(isValidPersistedTarget)) return [];
    const targets = parsed.targets.map(persistedTarget);
    const names = new Set(); const origins = new Set();
    for (const target of targets) {
      const name = target.name.toLocaleLowerCase();
      if (names.has(name) || origins.has(target.origin)) return [];
      names.add(name); origins.add(target.origin);
    }
    return targets;
  } catch { return []; }
}

function writeCatalog(filename, targets, fileSystem = fs) {
  const directory = path.dirname(filename);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const body = JSON.stringify({ version: SCHEMA_VERSION, targets: targets.map(persistedTarget) }, null, 2) + '\n';
  try {
    fileSystem.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fileSystem.chmodSync(temporary, 0o600);
    fileSystem.renameSync(temporary, filename);
    // rename preserves the temporary mode on POSIX; chmod also makes this true
    // when replacing a pre-existing file on unusual filesystems.
    fileSystem.chmodSync(filename, 0o600);
  } finally {
    try { fileSystem.unlinkSync(temporary); } catch { /* it was renamed or never created */ }
  }
}

class ControllerCatalog {
  constructor(options = {}) {
    if (typeof options === 'string') options = { filename: options };
    const { filename, fileSystem = fs, randomUUID = crypto.randomUUID, now = () => new Date().toISOString() } = options;
    if (typeof filename !== 'string' || !filename) throw new TypeError('ControllerCatalog requires a filename');
    this.filename = filename;
    this.fileSystem = fileSystem;
    this.randomUUID = randomUUID;
    this.now = now;
    const removeLegacySessionMetadata = hasPersistedOfflineMetadata(filename, fileSystem);
    this.targets = readCatalog(filename, fileSystem);
    // Older desktop builds wrote session ids, names, runtimes and activity into
    // servers.json. Rewrite a structurally readable legacy catalog immediately
    // through the metadata-free serializer; target configuration and trust are
    // retained, while the session cache is not even rehydrated into memory.
    if (removeLegacySessionMetadata) writeCatalog(filename, this.targets, fileSystem);
  }

  list() { return [LOCAL_TARGET, ...this.targets.map(clone)]; }
  listTargets() { return this.list(); }
  get(id) { return id === 'local' ? LOCAL_TARGET : clone(this._find(id)); }
  getTarget(id) { return this.get(id); }
  save() { writeCatalog(this.filename, this.targets, this.fileSystem); }

  add({ name, address, origin } = {}) {
    const target = { id: this._id(), type: 'remote', name: friendlyName(name), origin: canonicalOrigin(address ?? origin), status: 'disconnected', error: null };
    this._assertUnique(target);
    this._commit([...this.targets, target]);
    return clone(target);
  }
  addTarget(value) { return this.add(value); }

  rename(id, name) {
    this._assertRemote(id); const renamed = { ...this._find(id), name: friendlyName(name) };
    this._assertUnique(renamed, id); this._replace(id, renamed); return clone(renamed);
  }
  renameTarget(id, name) { return this.rename(id, name); }

  editAddress(id, address) {
    this._assertRemote(id); const previous = this._find(id); const origin = canonicalOrigin(address);
    const updated = { id: previous.id, type: 'remote', name: previous.name, origin, status: 'disconnected', error: null };
    this._assertUnique(updated, id); this._replace(id, updated); return clone(updated);
  }
  updateAddress(id, address) { return this.editAddress(id, address); }

  /** Replace an address and its trust generation in one catalog commit. */
  replaceDestination(id, { name, address, origin, identity, certificateFingerprint } = {}) {
    this._assertRemote(id);
    const nextOrigin = canonicalOrigin(address ?? origin);
    const replacement = {
      id,
      type: 'remote',
      name: friendlyName(name),
      origin: nextOrigin,
      status: 'disconnected',
      error: null,
    };
    const sanitizedIdentity = sanitizeServerIdentity(identity, nextOrigin);
    if (!sanitizedIdentity) throw new TypeError('A verified identity for the replacement destination is required');
    replacement.identity = sanitizedIdentity;
    if (certificateFingerprint) {
      replacement.certificateOverride = {
        origin: nextOrigin,
        fingerprint: String(certificateFingerprint).trim(),
      };
    }
    this._assertUnique(replacement, id);
    this._replace(id, replacement);
    return clone(replacement);
  }

  remove(id) {
    this._assertRemote(id); const target = this._find(id); const warning = Boolean(target.offlineMetadataCache && target.offlineMetadataCache.sessions.some((session) => session.active === true || session.status === 'active' || session.status === 'running'));
    this._commit(this.targets.filter((item) => item.id !== id));
    return { removed: true, warning, target: clone(target) };
  }
  removeTarget(id) { return this.remove(id); }

  setStatus(id, status, error) {
    this._assertRemote(id); if (typeof status !== 'string' || !status) throw new TypeError('A status is required');
    const updated = { ...this._find(id), status, error: safeError(error) };
    if (status === 'connected') updated.lastSuccessfulContact = this.now();
    this._replace(id, updated); return clone(updated);
  }
  recordSuccessfulContact(id, at = this.now()) {
    this._assertRemote(id); const updated = { ...this._find(id), status: 'connected', error: null, lastSuccessfulContact: at };
    this._replace(id, updated); return clone(updated);
  }
  setCertificateOverride(id, fingerprint) {
    this._assertRemote(id); if (typeof fingerprint !== 'string' || !fingerprint.trim()) throw new TypeError('A certificate fingerprint is required');
    const updated = { ...this._find(id), certificateOverride: { origin: this._find(id).origin, fingerprint: fingerprint.trim() } };
    this._replace(id, updated); return clone(updated);
  }
  clearCertificateOverride(id) { this._assertRemote(id); const updated = { ...this._find(id) }; delete updated.certificateOverride; this._replace(id, updated); return clone(updated); }
  setOfflineMetadata(id, metadata) {
    this._assertRemote(id);
    const updated = {
      ...this._find(id),
      offlineMetadataCache: sanitizeOfflineMetadataCache(metadata),
    };
    // `_replace` keeps the cache in this process, while `persistedTarget`
    // deliberately omits it from the atomic servers.json write.
    this._replace(id, updated);
    return clone(updated);
  }
  setIdentity(id, identity) {
    this._assertRemote(id);
    const current = this._find(id);
    const sanitized = sanitizeServerIdentity(identity, current.origin);
    if (!sanitized) throw new TypeError('A verified identity for the exact server origin is required');
    const updated = { ...current, identity: sanitized };
    this._replace(id, updated);
    return clone(updated);
  }
  setAuthMarker(id, present = true) { this._assertRemote(id); const updated = { ...this._find(id) }; if (present) updated.authMarker = true; else delete updated.authMarker; this._replace(id, updated); return clone(updated); }
  signOut(id) { this._assertRemote(id); const updated = { ...this._find(id) }; delete updated.authMarker; delete updated.offlineMetadataCache; this._replace(id, updated); return clone(updated); }
  removalWarning(id) {
    this._assertRemote(id);
    const target = this._find(id);
    return Boolean(target.offlineMetadataCache && target.offlineMetadataCache.sessions.some(
      (session) => session.active === true || session.status === 'active' || session.status === 'running',
    ));
  }

  _find(id) { const target = this.targets.find((item) => item.id === id); if (!target) throw new RangeError(`Unknown controller target: ${id}`); return target; }
  _assertRemote(id) { if (id === 'local') throw new TypeError('The local controller target is permanent and immutable'); this._find(id); }
  _id() { let id; do { id = this.randomUUID(); } while (typeof id !== 'string' || id === 'local' || this.targets.some((target) => target.id === id)); return id; }
  _assertUnique(candidate, exceptId) {
    const name = candidate.name.toLocaleLowerCase();
    if (this.targets.some((target) => target.id !== exceptId && target.name.toLocaleLowerCase() === name)) throw new RangeError('Controller friendly names must be unique');
    if (this.targets.some((target) => target.id !== exceptId && target.origin === candidate.origin)) throw new RangeError('A controller with this origin already exists');
  }
  _replace(id, replacement) { this._commit(this.targets.map((target) => target.id === id ? replacement : target)); }
  _commit(targets) { writeCatalog(this.filename, targets, this.fileSystem); this.targets = targets; }
}

module.exports = {
  SCHEMA_VERSION,
  FRIENDLY_NAME_MAX_LENGTH,
  LOCAL_TARGET,
  ControllerCatalog,
  canonicalOrigin,
  friendlyName,
  sanitizeOfflineMetadataCache,
  sanitizeServerIdentity,
  readCatalog,
  writeCatalog,
};
