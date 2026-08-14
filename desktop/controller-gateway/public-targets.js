'use strict';

const { CONTROLLER_PRODUCT_ID } = require('../controller-protocol.js');

function publicTarget(target) {
  const safe = {
    id: target.id,
    type: target.type || (target.id === 'local' ? 'local' : 'remote'),
    name: target.name,
    status: target.status || 'unknown',
    insecure: target.insecure === true || Boolean(target.certificateOverride),
    signedIn: target.id === 'local' || target.signedIn === true || target.authMarker === true,
  };
  if (target.stagedAddition === true) safe.stagedAddition = true;
  if (typeof target.origin === 'string') safe.origin = target.origin;
  if (typeof target.version === 'string') safe.version = target.version;
  if (Number.isInteger(target.protocolVersion)) safe.protocolVersion = target.protocolVersion;
  if (typeof target.certificateFingerprint === 'string') {
    safe.certificateFingerprint = target.certificateFingerprint;
  }
  if (Number.isInteger(target.runningWorkCount) && target.runningWorkCount >= 0) {
    safe.runningWorkCount = target.runningWorkCount;
  }
  if (Array.isArray(target.capabilities)) {
    safe.capabilities = target.capabilities.filter((value) => typeof value === 'string');
  }
  if (target.error) {
    safe.error = typeof target.error === 'string'
      ? { message: target.error }
      : {
          ...(typeof target.error.code === 'string' ? { code: target.error.code } : {}),
          ...(typeof target.error.message === 'string' ? { message: target.error.message } : {}),
          ...(typeof target.error.category === 'string' ? { category: target.error.category } : {}),
          ...(typeof target.error.fingerprint256 === 'string' ? { fingerprint256: target.error.fingerprint256 } : {}),
          ...(target.error.requiresRenewedApproval === true ? { requiresRenewedApproval: true } : {}),
          ...(target.error.certificate && typeof target.error.certificate === 'object'
            ? { certificate: Object.fromEntries(Object.entries(target.error.certificate).filter(([, value]) => typeof value === 'string')) }
            : {}),
        };
  }
  if (typeof target.lastSuccessfulContact === 'string' || typeof target.lastSuccessfulContact === 'number') {
    safe.lastSuccessfulContact = target.lastSuccessfulContact;
  }
  return safe;
}

function publicCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const safe = {};
  for (const key of ['id', 'name', 'serverName', 'origin', 'address', 'status', 'version', 'protocolVersion', 'compatible', 'discoveredFrom']) {
    if (['string', 'number', 'boolean'].includes(typeof candidate[key])) safe[key] = candidate[key];
  }
  if (candidate.product?.id === CONTROLLER_PRODUCT_ID && typeof candidate.product.name === 'string') safe.product = { id: CONTROLLER_PRODUCT_ID, name: candidate.product.name };
  if (Array.isArray(candidate.capabilities)) safe.capabilities = candidate.capabilities.filter((value) => typeof value === 'string');
  return safe;
}

function publicActionResult(result) {
  if (result == null) return { success: true };
  if (!result || typeof result !== 'object') return { success: result === true };
  const safe = {};
  for (const key of ['success', 'removed', 'warning', 'requiresApproval', 'requiresConfirmation', 'message', 'origin']) {
    if (['string', 'boolean'].includes(typeof result[key])) safe[key] = result[key];
  }
  if (result.error) {
    safe.error = typeof result.error === 'string'
      ? { message: result.error }
      : {
          ...(typeof result.error.code === 'string' ? { code: result.error.code } : {}),
          ...(typeof result.error.message === 'string' ? { message: result.error.message } : {}),
          ...(typeof result.error.category === 'string' ? { category: result.error.category } : {}),
          ...(typeof result.error.fingerprint256 === 'string' ? { fingerprint256: result.error.fingerprint256 } : {}),
          ...(result.error.requiresRenewedApproval === true ? { requiresRenewedApproval: true } : {}),
          ...(result.error.certificate && typeof result.error.certificate === 'object'
            ? { certificate: Object.fromEntries(Object.entries(result.error.certificate).filter(([, value]) => typeof value === 'string')) }
            : {}),
        };
  }
  if (result.target) safe.target = publicTarget(result.target);
  else if (typeof result.id === 'string' && typeof result.name === 'string') return publicTarget(result);
  if (Array.isArray(result.targets)) safe.targets = result.targets.map(publicTarget);
  if (Array.isArray(result.candidates)) safe.candidates = result.candidates.map(publicCandidate).filter(Boolean);
  return Object.keys(safe).length ? safe : { success: true };
}

function isAvailable(target) {
  if (!target) return false;
  if (target.id === 'local' || target.type === 'local') return target.status === 'ready';
  const reportsAuthentication = typeof target.signedIn === 'boolean'
    || typeof target.authMarker === 'boolean';
  return target.status === 'connected'
    && (!reportsAuthentication || target.signedIn === true || target.authMarker === true);
}

module.exports = {
  isAvailable,
  publicActionResult,
  publicCandidate,
  publicTarget,
};