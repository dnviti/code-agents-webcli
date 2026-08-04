'use strict';

const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { Readable } = require('node:stream');
const WebSocket = require('ws');

const { canonicalOrigin, friendlyName } = require('./controller-catalog.js');
const {
  ControllerTransportError,
  createControllerTransport,
  normalizeFingerprint256,
} = require('./controller-transport.js');

const LOCAL_ID = 'local';
const DEFAULT_RECONNECT_MS = 15_000;
const LAN_DISCOVERY_PORT = 32353;
const LAN_DISCOVERY_PROBE = 'CODE_AGENTS_DISCOVERY/1';
const LAN_DISCOVERY_MAX_PACKET_BYTES = 1024;

function errorDetails(error) {
  const result = {
    code: typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
    message: typeof error?.message === 'string' ? error.message : 'The server request failed.',
  };
  for (const key of ['category', 'fingerprint256', 'tlsReason', 'requiresRenewedApproval']) {
    if (['string', 'boolean'].includes(typeof error?.[key])) result[key] = error[key];
  }
  if (error?.certificate && typeof error.certificate === 'object') {
    result.certificate = {};
    for (const key of ['fingerprint256', 'subject', 'issuer', 'validFrom', 'validTo', 'serialNumber']) {
      if (typeof error.certificate[key] === 'string') result.certificate[key] = error.certificate[key];
    }
  }
  return result;
}

function isCertificateError(error) {
  return error?.code === 'TLS_CERTIFICATE' || error?.code === 'TLS_CERTIFICATE_CHANGED';
}

function parseDiscoveryResponse(message) {
  if (!Buffer.isBuffer(message) || message.length > LAN_DISCOVERY_MAX_PACKET_BYTES) return null;
  try {
    const parsed = JSON.parse(message.toString('utf8'));
    const identity = parsed?.type === 'CODE_AGENTS_IDENTITY/1' ? parsed.identity : null;
    if (
      identity?.product?.id !== 'code-agents-webcli'
      || identity.product.name !== 'CODE AGENTS'
      || typeof identity.version !== 'string'
      || !Number.isInteger(identity.protocolVersion)
      || identity.protocolVersion < 1
      || !Array.isArray(identity.capabilities)
      || !identity.capabilities.every((value) => typeof value === 'string')
      || typeof identity.serverName !== 'string'
      || typeof identity.address !== 'string'
    ) return null;
    return identity;
  } catch {
    return null;
  }
}

function exactLoopbackOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('The local server URL is invalid'); }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new TypeError('The local server must use an exact 127.0.0.1 HTTP origin');
  return parsed.origin;
}

function localCookie(auth) {
  if (!auth || typeof auth.name !== 'string' || typeof auth.value !== 'string') {
    throw new TypeError('The local server authentication cookie is required');
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(auth.name) || /[\r\n;]/.test(auth.value)) {
    throw new TypeError('The local server authentication cookie is unsafe');
  }
  return `${auth.name}=${auth.value}`;
}

function sanitizeLocalHeaders(headers = {}, origin, cookie) {
  const result = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !name
      || ['connection', 'cookie', 'host', 'origin', 'proxy-authorization', 'transfer-encoding', 'upgrade'].includes(name)
      || name.startsWith('proxy-')
      || name.startsWith('sec-')
    ) continue;
    result[name] = value;
  }
  result.cookie = cookie;
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'origin')) result.origin = origin;
  return result;
}

function createLocalControllerTransport(options = {}) {
  const origin = exactLoopbackOrigin(options.origin);
  const cookie = localCookie(options.auth);
  const requestImpl = options.requestImpl || http.request;
  const createWebSocket = options.createWebSocket || ((url, protocols, wsOptions) => new WebSocket(url, protocols, wsOptions));

  function requestTarget(requestOptions = {}) {
    const url = new URL(requestOptions.path || '/', origin);
    if (url.origin !== origin) throw new TypeError('The local request crossed its server boundary');
    return new Promise((resolve, reject) => {
      const request = requestImpl(url, {
        method: requestOptions.method || 'GET',
        headers: sanitizeLocalHeaders(requestOptions.headers, origin, cookie),
      }, resolve);
      request.once('error', reject);
      const body = requestOptions.body;
      if (body && typeof body.pipe === 'function') body.pipe(request);
      else request.end(body == null ? undefined : body);
    });
  }

  function connectTargetWebSocket(webSocketOptions = {}) {
    const url = new URL(webSocketOptions.path || '/', origin);
    if (url.origin !== origin) throw new TypeError('The local WebSocket crossed its server boundary');
    url.protocol = 'ws:';
    return createWebSocket(url.href, webSocketOptions.protocols || [], {
      ...(webSocketOptions.options || {}),
      followRedirects: false,
      headers: { cookie, origin },
    });
  }

  return Object.freeze({ origin, requestTarget, connectTargetWebSocket });
}

function responseBody(response) {
  return response?.body && typeof response.body.pipe === 'function' ? response.body : response;
}

async function readJson(response, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of responseBody(response) || Readable.from([])) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('The server response was unexpectedly large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createControllerRuntime(options = {}) {
  const {
    catalog,
    electronSessions,
    findLanServers,
    createRemoteTransport = createControllerTransport,
    createLocalTransport = createLocalControllerTransport,
    reconnectMs = DEFAULT_RECONNECT_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = options;
  if (!catalog || typeof catalog.list !== 'function') throw new TypeError('A controller catalog is required');
  if (!electronSessions || typeof electronSessions.forServer !== 'function') {
    throw new TypeError('Electron controller sessions are required');
  }

  const state = new Map();
  const transports = new Map();
  const pendingChanges = new Map();
  // Certificate-failing additions are deliberately process-local until the
  // user approves the exact fingerprint. They are visible in the manager so
  // the warning has a target, but a restart proves nothing was saved first.
  const stagedTargets = new Map();
  // Network work against a superseded destination may still settle after an
  // address edit or sign-out. A generation prevents that stale completion from
  // overwriting the newer, security-relevant state.
  const connectionGenerations = new Map();
  const mutationGenerations = new Map();
  let localTransport = null;
  let reconnectTimer = null;
  state.set(LOCAL_ID, { status: 'offline', error: { code: 'LOCAL_NOT_STARTED', message: 'Local computer is starting.' } });
  for (const target of catalog.list().filter((item) => item.id !== LOCAL_ID)) {
    state.set(target.id, { status: 'disconnected', error: null });
  }

  function catalogTarget(serverId) {
    const target = catalog.get(serverId);
    if (!target) throw new RangeError(`Unknown controller target: ${serverId}`);
    return target;
  }

  function connectionGeneration(serverId) {
    return connectionGenerations.get(serverId) || 0;
  }

  function mutationGeneration(serverId) {
    return mutationGenerations.get(serverId) || 0;
  }

  function invalidateMutation(serverId) {
    const next = mutationGeneration(serverId) + 1;
    mutationGenerations.set(serverId, next);
    return next;
  }

  function invalidateConnection(serverId) {
    connectionGenerations.set(serverId, connectionGeneration(serverId) + 1);
    invalidateMutation(serverId);
    transports.delete(serverId);
  }

  function supersededMutation(serverId) {
    const error = {
      code: 'TARGET_CHANGED',
      message: 'A newer server change replaced this request.',
    };
    let target;
    try { target = targetWithState(catalogTarget(serverId)); } catch { /* the target was removed */ }
    return { success: false, superseded: true, ...(target ? { target } : {}), error };
  }

  function targetWithState(target) {
    const current = state.get(target.id) || {};
    const cachedSessions = target.offlineMetadataCache?.sessions || [];
    const runningWorkCount = cachedSessions.filter((session) => (
      session.active === true || session.status === 'active' || session.status === 'running'
    )).length;
    return {
      ...target,
      ...current,
      signedIn: target.id === LOCAL_ID || target.authMarker === true,
      insecure: Boolean(target.certificateOverride),
      capabilities: target.identity?.capabilities || [],
      version: target.identity?.version,
      protocolVersion: target.identity?.protocolVersion,
      ...(target.certificateOverride?.fingerprint
        ? { certificateFingerprint: target.certificateOverride.fingerprint }
        : {}),
      ...(runningWorkCount > 0 ? { runningWorkCount } : {}),
    };
  }

  function listTargets() {
    return [...catalog.list(), ...stagedTargets.values()].map(targetWithState);
  }

  function validateDraft(payload = {}, excludingId) {
    const draft = {
      type: 'remote',
      name: friendlyName(payload.name),
      origin: canonicalOrigin(payload.address || payload.origin),
    };
    for (const target of [...catalog.list(), ...stagedTargets.values()]) {
      if (target.id === LOCAL_ID || target.id === excludingId) continue;
      if (target.name.toLocaleLowerCase() === draft.name.toLocaleLowerCase()) {
        throw new RangeError('Controller friendly names must be unique');
      }
      if (target.origin === draft.origin) throw new RangeError('A controller with this origin already exists');
    }
    return draft;
  }

  function stagedId() {
    let id;
    do { id = `pending-${randomUUID()}`; }
    while (catalog.list().some((target) => target.id === id) || stagedTargets.has(id));
    return id;
  }

  function remoteTransport(target) {
    const signature = JSON.stringify([target.origin, target.certificateOverride || null]);
    const existing = transports.get(target.id);
    if (existing?.signature === signature) return existing.transport;
    const adapter = electronSessions.forServer(target);
    const transport = createRemoteTransport({
      origin: target.origin,
      certificateApproval: target.certificateOverride,
      cookieProvider: adapter.cookieProvider,
      cookieSink: adapter.cookieSink,
    });
    transports.set(target.id, { signature, transport });
    return transport;
  }

  function setFailure(serverId, error) {
    const status = error?.code === 'AUTH_REQUIRED' ? 'authentication-required'
      : isCertificateError(error) ? 'certificate-error'
        : ['UNSUPPORTED_PROTOCOL', 'INCOMPATIBLE_RESPONSE'].includes(error?.code) ? 'incompatible'
          : 'offline';
    state.set(serverId, { status, error: errorDetails(error) });
    if (serverId !== LOCAL_ID) catalog.setStatus(serverId, status, errorDetails(error));
    return targetWithState(catalogTarget(serverId));
  }

  function setConnected(serverId, identity) {
    state.set(serverId, { status: 'connected', error: null });
    if (serverId !== LOCAL_ID) {
      if (identity) catalog.setIdentity(serverId, identity);
      catalog.recordSuccessfulContact(serverId);
    }
    return targetWithState(catalogTarget(serverId));
  }

  function attachLocal(local) {
    localTransport = createLocalTransport(local);
    state.set(LOCAL_ID, { status: 'ready', error: null });
    return targetWithState(catalogTarget(LOCAL_ID));
  }

  function reportLocalFailure(error) {
    localTransport = null;
    state.set(LOCAL_ID, { status: 'offline', error: errorDetails(error) });
    return targetWithState(catalogTarget(LOCAL_ID));
  }

  async function verifyExisting(serverId) {
    const target = catalogTarget(serverId);
    if (serverId === LOCAL_ID) return targetWithState(target);
    const generation = connectionGeneration(serverId);
    state.set(serverId, { status: 'connecting', error: null });
    try {
      const identity = await remoteTransport(target).verifyTarget();
      if (generation !== connectionGeneration(serverId)) return targetWithState(catalogTarget(serverId));
      pendingChanges.delete(serverId);
      return setConnected(serverId, identity);
    } catch (error) {
      if (generation !== connectionGeneration(serverId)) throw error;
      if (isCertificateError(error)) {
        pendingChanges.set(serverId, {
          kind: 'certificate', origin: target.origin, fingerprint256: error.fingerprint256,
        });
      }
      setFailure(serverId, error);
      throw error;
    }
  }

  async function request(serverId, requestOptions) {
    const generation = connectionGeneration(serverId);
    try {
      const target = catalogTarget(serverId);
      const transport = serverId === LOCAL_ID ? localTransport : remoteTransport(target);
      if (!transport) throw Object.assign(new Error('The Local computer server is unavailable.'), { code: 'LOCAL_UNAVAILABLE' });
      const response = await transport.requestTarget(requestOptions);
      if (serverId !== LOCAL_ID && generation === connectionGeneration(serverId)) {
        if (response.statusCode === 401) {
          catalog.recordSuccessfulContact(serverId);
          catalog.setAuthMarker(serverId, false);
          const error = Object.assign(new Error('Sign in to this server to continue.'), { code: 'AUTH_REQUIRED' });
          state.set(serverId, { status: 'authentication-required', error: errorDetails(error) });
          catalog.setStatus(serverId, 'authentication-required', errorDetails(error));
        } else {
          const pathname = String(requestOptions?.path || '').split('?', 1)[0];
          if (
            response.statusCode >= 200 && response.statusCode < 300
            && (pathname === '/api/config' || pathname === '/api/auth/me')
            && !catalogTarget(serverId).authMarker
          ) {
            catalog.setAuthMarker(serverId, true);
          }
          setConnected(serverId);
        }
      }
      return response;
    } catch (error) {
      if (generation === connectionGeneration(serverId)) {
        if (serverId !== LOCAL_ID && error?.code === 'AUTH_REQUIRED' && error?.statusCode === 401) {
          catalog.setAuthMarker(serverId, false);
        }
        setFailure(serverId, error);
      }
      throw error;
    }
  }

  async function connectWebSocket(serverId, socketOptions) {
    const generation = connectionGeneration(serverId);
    try {
      const target = catalogTarget(serverId);
      const transport = serverId === LOCAL_ID ? localTransport : remoteTransport(target);
      if (!transport) throw Object.assign(new Error('The Local computer server is unavailable.'), { code: 'LOCAL_UNAVAILABLE' });
      const socket = await transport.connectTargetWebSocket(socketOptions);
      if (serverId !== LOCAL_ID && generation === connectionGeneration(serverId)) setConnected(serverId);
      return socket;
    } catch (error) {
      if (generation === connectionGeneration(serverId)) {
        if (serverId !== LOCAL_ID && error?.code === 'AUTH_REQUIRED' && error?.statusCode === 401) {
          catalog.setAuthMarker(serverId, false);
        }
        setFailure(serverId, error);
      }
      throw error;
    }
  }

  function cacheSessions(serverId, sessions) {
    if (serverId !== LOCAL_ID) catalog.setOfflineMetadata(serverId, sessions);
  }

  async function testTarget(payload = {}) {
    const saved = payload.serverId ? catalogTarget(payload.serverId) : null;
    if (saved?.id === LOCAL_ID) throw new TypeError('Local computer does not use remote connection tests');
    const origin = saved ? saved.origin : canonicalOrigin(payload.address || payload.origin);
    // An existing-row test is the same exact trust decision as normal traffic.
    // An unsaved add-form probe intentionally has neither credentials nor a pin.
    const transport = saved ? remoteTransport(saved) : createRemoteTransport({ origin });
    try {
      const identity = await transport.verifyTarget();
      return { success: true, identity, origin };
    } catch (error) {
      return { success: false, origin, error: errorDetails(error), requiresApproval: isCertificateError(error) };
    }
  }

  async function addTarget(payload = {}) {
    const draft = validateDraft(payload);
    try {
      const identity = await createRemoteTransport({ origin: draft.origin }).verifyTarget();
      validateDraft(draft);
      const target = catalog.add(draft);
      state.set(target.id, { status: 'connecting', error: null });
      return { success: true, target: setConnected(target.id, identity) };
    } catch (error) {
      if (isCertificateError(error)) {
        // Recheck after the await so two concurrent adds cannot stage duplicate
        // names or origins.
        validateDraft(draft);
        const id = stagedId();
        const target = { id, ...draft, status: 'certificate-error', error: null };
        stagedTargets.set(id, target);
        pendingChanges.set(id, {
          kind: 'addition', origin: draft.origin, name: draft.name,
          fingerprint256: error.fingerprint256,
        });
        state.set(id, { status: 'certificate-error', error: errorDetails(error), stagedAddition: true });
        return { success: false, target: targetWithState(target), requiresApproval: true, error: errorDetails(error) };
      }
      return { success: false, error: errorDetails(error) };
    }
  }

  async function updateTarget(payload = {}) {
    const { serverId } = payload;
    const current = catalogTarget(serverId);
    if (serverId === LOCAL_ID) throw new TypeError('Local computer cannot be edited');
    const nextName = friendlyName(payload.name === undefined ? current.name : payload.name);
    const nextOrigin = payload.address === undefined && payload.origin === undefined
      ? current.origin : canonicalOrigin(payload.address || payload.origin);
    for (const target of catalog.list()) {
      if (target.id === serverId || target.id === LOCAL_ID) continue;
      if (target.name.toLocaleLowerCase() === nextName.toLocaleLowerCase()) {
        throw new RangeError('Controller friendly names must be unique');
      }
      if (target.origin === nextOrigin) throw new RangeError('A controller with this origin already exists');
    }
    if (nextOrigin === current.origin) {
      invalidateMutation(serverId);
      const renamed = nextName === current.name ? current : catalog.rename(serverId, nextName);
      if (pendingChanges.get(serverId)?.kind === 'address') {
        // Entering the still-saved address is an explicit cancellation of an
        // unapproved destination edit. Restore the persisted target instead of
        // leaving an invisible pending pin to surprise the next Retry.
        pendingChanges.delete(serverId);
        state.set(serverId, {
          status: renamed.status || 'disconnected',
          error: renamed.error || null,
        });
      }
      return { success: true, target: targetWithState(renamed) };
    }

    invalidateConnection(serverId);
    const currentMutationGeneration = mutationGeneration(serverId);
    if (pendingChanges.get(serverId)?.kind === 'address') pendingChanges.delete(serverId);
    state.set(serverId, {
      status: 'connecting', error: null,
      name: nextName, origin: nextOrigin, stagedDestination: true,
    });
    const transport = createRemoteTransport({ origin: nextOrigin });
    try {
      const identity = await transport.verifyTarget();
      if (currentMutationGeneration !== mutationGeneration(serverId)) return supersededMutation(serverId);
      await electronSessions.forServer(current).clearServerData();
      if (currentMutationGeneration !== mutationGeneration(serverId)) return supersededMutation(serverId);
      const updated = catalog.replaceDestination(serverId, {
        name: nextName,
        origin: nextOrigin,
        identity,
      });
      transports.delete(serverId);
      await electronSessions.refreshCertificateApproval?.(updated);
      if (currentMutationGeneration !== mutationGeneration(serverId)) return supersededMutation(serverId);
      return { success: true, destinationChanged: true, target: setConnected(serverId, identity) };
    } catch (error) {
      if (currentMutationGeneration !== mutationGeneration(serverId)) return supersededMutation(serverId);
      if (isCertificateError(error)) {
        const details = errorDetails(error);
        pendingChanges.set(serverId, {
          kind: 'address', origin: nextOrigin, name: nextName, fingerprint256: error.fingerprint256,
        });
        // Expose the staged destination and its presented certificate without
        // committing either to disk. This gives the renderer an approval path
        // while restart before approval still returns to the old saved server.
        state.set(serverId, {
          status: 'certificate-error', error: details,
          name: nextName, origin: nextOrigin, stagedDestination: true,
        });
      } else {
        state.set(serverId, {
          status: current.status || 'disconnected',
          error: current.error || null,
        });
      }
      return {
        success: false,
        target: targetWithState(current),
        requiresApproval: isCertificateError(error),
        stagedDestinationChanged: isCertificateError(error),
        error: errorDetails(error),
      };
    }
  }

  async function approveCertificate(payload = {}) {
    const { serverId } = payload;
    const pending = pendingChanges.get(serverId);
    if (!pending || !pending.fingerprint256) throw new TypeError('Retry the connection before approving its certificate');
    const current = pending.kind === 'addition' ? stagedTargets.get(serverId) : catalogTarget(serverId);
    if (!current) throw new RangeError(`Unknown controller target: ${serverId}`);
    const supplied = normalizeFingerprint256(payload.fingerprint256 || payload.fingerprint);
    if (supplied !== normalizeFingerprint256(pending.fingerprint256)) {
      throw new TypeError('The approved fingerprint does not match the certificate just presented');
    }
    const approval = { origin: pending.origin, fingerprint: supplied };
    const transport = createRemoteTransport({ origin: pending.origin, certificateApproval: approval });
    const generation = connectionGeneration(serverId);
    const identity = await transport.verifyTarget();
    if (
      generation !== connectionGeneration(serverId)
      || pendingChanges.get(serverId) !== pending
      || (pending.kind === 'addition' && stagedTargets.get(serverId) !== current)
    ) {
      throw Object.assign(
        new Error('This certificate decision is no longer current. Review the server again.'),
        { code: 'TARGET_CHANGED' },
      );
    }

    if (pending.kind === 'addition') {
      validateDraft(current, serverId);
      const added = catalog.add({ name: current.name, origin: current.origin });
      catalog.setIdentity(added.id, identity);
      const updated = catalog.setCertificateOverride(added.id, supplied);
      await electronSessions.refreshCertificateApproval?.(updated);
      stagedTargets.delete(serverId);
      pendingChanges.delete(serverId);
      state.delete(serverId);
      state.set(added.id, { status: 'connecting', error: null });
      return { success: true, target: setConnected(added.id, identity) };
    }

    invalidateConnection(serverId);
    if (pending.kind === 'address') {
      await electronSessions.forServer(current).clearServerData();
      const updated = catalog.replaceDestination(serverId, {
        name: pending.name,
        origin: pending.origin,
        identity,
        certificateFingerprint: supplied,
      });
      await electronSessions.refreshCertificateApproval?.(updated);
    } else {
      const updated = catalog.setCertificateOverride(serverId, supplied);
      await electronSessions.refreshCertificateApproval?.(updated);
      catalog.setIdentity(serverId, identity);
    }
    transports.delete(serverId);
    pendingChanges.delete(serverId);
    return { success: true, target: setConnected(serverId, identity) };
  }

  async function signIn(payload = {}) {
    const target = catalogTarget(payload.serverId);
    if (target.id === LOCAL_ID) return { success: true, target: targetWithState(target) };
    const adapter = electronSessions.forServer(target);
    const result = await adapter.runOAuthFlow({
      checkAuthenticated: async () => {
        const response = await remoteTransport(target).requestTarget({ path: '/api/auth/me', method: 'GET' });
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          response.resume?.();
          return null;
        }
        return readJson(response);
      },
    });
    if (result.status !== 'signed-in') return { success: false, message: result.status === 'cancel' ? 'Sign-in was cancelled.' : result.error?.message };
    catalog.setAuthMarker(target.id, true);
    return { success: true, target: await verifyExisting(target.id) };
  }

  async function requireValidCertificate(payload = {}) {
    const target = catalogTarget(payload.serverId);
    if (target.id === LOCAL_ID) throw new TypeError('Local computer does not use certificate overrides');
    invalidateConnection(target.id);
    const updated = target.certificateOverride
      ? catalog.clearCertificateOverride(target.id) : target;
    transports.delete(target.id);
    pendingChanges.delete(target.id);
    await electronSessions.refreshCertificateApproval?.(updated);
    try {
      return { success: true, target: await verifyExisting(target.id) };
    } catch (error) {
      return {
        success: true,
        warning: true,
        target: targetWithState(catalogTarget(target.id)),
        requiresApproval: isCertificateError(error),
        error: errorDetails(error),
      };
    }
  }

  async function signOut(payload = {}) {
    const target = catalogTarget(payload.serverId);
    if (target.id === LOCAL_ID) throw new TypeError('Local computer does not use remote sign-in');
    invalidateConnection(target.id);
    if (typeof electronSessions.clearServerData === 'function') await electronSessions.clearServerData(target.id);
    else await electronSessions.forServer(target).clearServerData();
    const updated = catalog.signOut(target.id);
    transports.delete(target.id);
    pendingChanges.delete(target.id);
    state.set(target.id, { status: 'disconnected', error: null });
    return { success: true, target: targetWithState(updated) };
  }

  async function removeTarget(payload = {}) {
    const staged = stagedTargets.get(payload.serverId);
    if (staged) {
      stagedTargets.delete(staged.id);
      pendingChanges.delete(staged.id);
      state.delete(staged.id);
      invalidateConnection(staged.id);
      return { success: true, removed: true, warning: false };
    }
    const target = catalogTarget(payload.serverId);
    if (target.id === LOCAL_ID) throw new TypeError('Local computer is permanent');
    const warning = catalog.removalWarning(target.id);
    if (warning && payload.confirmRunning !== true) {
      return { success: false, warning: true, requiresConfirmation: true, target: targetWithState(target) };
    }
    invalidateConnection(target.id);
    if (typeof electronSessions.removeServer === 'function') await electronSessions.removeServer(target.id);
    else await electronSessions.forServer(target).clearServerData();
    const result = catalog.remove(target.id);
    transports.delete(target.id);
    state.delete(target.id);
    pendingChanges.delete(target.id);
    return { success: true, removed: true, warning: result.warning };
  }

  async function discover(payload = {}) {
    if (typeof findLanServers !== 'function') throw new Error('LAN discovery is unavailable');
    const candidates = await findLanServers({
      probe: LAN_DISCOVERY_PROBE,
      parseResponse: parseDiscoveryResponse,
      port: LAN_DISCOVERY_PORT,
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    });
    return {
      success: true,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        compatible: candidate.protocolVersion === 1,
        status: candidate.protocolVersion === 1
          ? 'Compatible controller'
          : `Protocol ${candidate.protocolVersion} requires a server upgrade`,
      })),
    };
  }

  async function action(name, payload = {}) {
    if (name === 'test') return testTarget(payload);
    if (name === 'add') return addTarget(payload);
    if (name === 'update') return updateTarget(payload);
    if (name === 'remove') return removeTarget(payload);
    if (name === 'retry') {
      const pending = pendingChanges.get(payload.serverId);
      if (pending?.kind === 'addition') {
        const staged = stagedTargets.get(payload.serverId);
        if (!staged) throw new RangeError(`Unknown controller target: ${payload.serverId}`);
        try {
          const identity = await createRemoteTransport({ origin: staged.origin }).verifyTarget();
          validateDraft(staged, staged.id);
          const target = catalog.add(staged);
          stagedTargets.delete(staged.id);
          pendingChanges.delete(staged.id);
          state.delete(staged.id);
          state.set(target.id, { status: 'connecting', error: null });
          return { success: true, target: setConnected(target.id, identity) };
        } catch (error) {
          if (isCertificateError(error)) {
            pendingChanges.set(staged.id, { ...pending, fingerprint256: error.fingerprint256 });
            state.set(staged.id, { status: 'certificate-error', error: errorDetails(error), stagedAddition: true });
          }
          return { success: false, target: targetWithState(staged), requiresApproval: isCertificateError(error), error: errorDetails(error) };
        }
      }
      if (pending?.kind === 'address') {
        return updateTarget({
          serverId: payload.serverId,
          name: pending.name,
          address: pending.origin,
        });
      }
      try {
        return { success: true, target: await verifyExisting(payload.serverId) };
      }
      catch (error) { return { success: false, target: targetWithState(catalogTarget(payload.serverId)), requiresApproval: isCertificateError(error), error: errorDetails(error) }; }
    }
    if (name === 'signIn') return signIn(payload);
    if (name === 'signOut') return signOut(payload);
    if (name === 'approveCertificate') return approveCertificate(payload);
    if (name === 'requireValidCertificate') return requireValidCertificate(payload);
    if (name === 'discover') return discover(payload);
    throw new RangeError(`Unknown controller action: ${name}`);
  }

  async function reconnect() {
    await Promise.all(catalog.list().filter((target) => target.id !== LOCAL_ID).map(async (target) => {
      if (state.get(target.id)?.status === 'connected') return;
      if (pendingChanges.get(target.id)?.kind === 'address') return;
      try { await verifyExisting(target.id); } catch { /* state is recorded for the renderer */ }
    }));
  }

  function start() {
    if (reconnectTimer) return;
    void reconnect();
    reconnectTimer = setIntervalImpl(() => void reconnect(), reconnectMs);
    reconnectTimer?.unref?.();
  }

  function stop() {
    if (reconnectTimer) clearIntervalImpl(reconnectTimer);
    reconnectTimer = null;
  }

  return Object.freeze({
    listTargets,
    request,
    connectWebSocket,
    cacheSessions,
    action,
    attachLocal,
    reportLocalFailure,
    reconnect,
    start,
    stop,
  });
}

module.exports = {
  DEFAULT_RECONNECT_MS,
  LAN_DISCOVERY_MAX_PACKET_BYTES,
  LAN_DISCOVERY_PORT,
  LAN_DISCOVERY_PROBE,
  createControllerRuntime,
  createLocalControllerTransport,
  errorDetails,
  parseDiscoveryResponse,
};
