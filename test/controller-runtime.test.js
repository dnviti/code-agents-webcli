'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { ControllerCatalog } = require('../desktop/controller-catalog.js');
const {
  LAN_DISCOVERY_PORT,
  LAN_DISCOVERY_PROBE,
  createControllerRuntime,
  createLocalControllerTransport,
  parseDiscoveryResponse,
} = require('../desktop/controller-runtime.js');
const { ControllerTransportError } = require('../desktop/controller-transport.js');

const FINGERPRINT = Array(32).fill('AB').join(':');

function identity(origin, name = 'Remote') {
  return {
    product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
    version: '6.1.0',
    protocolVersion: 1,
    capabilities: ['remote-controller'],
    serverName: name,
    address: origin,
  };
}

function response(value, statusCode = 200) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
    statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

class SessionManager {
  constructor() {
    this.adapters = new Map();
    this.refreshes = [];
    this.clearedIds = [];
  }

  forServer(target) {
    if (!this.adapters.has(target.id)) {
      const adapter = {
        target,
        cleared: 0,
        authResult: { status: 'signed-in', authentication: { login: target.id } },
        cookieProvider: async () => [],
        cookieSink: async () => {},
        clearServerData: async () => { adapter.cleared += 1; },
        runOAuthFlow: async ({ checkAuthenticated }) => {
          await checkAuthenticated();
          return adapter.authResult;
        },
      };
      this.adapters.set(target.id, adapter);
    }
    return this.adapters.get(target.id);
  }

  async refreshCertificateApproval(target) {
    this.refreshes.push(target);
    this.forServer(target).target = target;
  }

  async clearServerData(serverId) {
    this.clearedIds.push(serverId);
    await this.adapters.get(serverId)?.clearServerData();
  }

  async removeServer(serverId) {
    await this.adapters.get(serverId)?.clearServerData();
  }
}

function scriptedTransportFactory(scripts) {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    const script = scripts.get(options.origin);
    if (!script) throw new Error(`No transport script for ${options.origin}`);
    return {
      verifyTarget: async () => {
        if (typeof script.verify === 'function') return script.verify(options);
        if (script.verify instanceof Error) throw script.verify;
        return script.verify || identity(options.origin);
      },
      requestTarget: async (request) => {
        if (script.request) return script.request(request, options);
        return response({ ok: true });
      },
      connectTargetWebSocket: async (request) => {
        if (typeof script.connect === 'function') return script.connect(request, options);
        if (script.connect instanceof Error) throw script.connect;
        return { origin: options.origin };
      },
    };
  };
  factory.calls = calls;
  return factory;
}

describe('desktop controller runtime', function () {
  let directory;
  let catalog;
  let sessions;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-runtime-'));
    catalog = new ControllerCatalog({ filename: path.join(directory, 'servers.json') });
    sessions = new SessionManager();
  });

  afterEach(function () {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the permanent Local computer visible when startup fails while remotes reconnect', async function () {
    const remote = catalog.add({ name: 'Build host', address: 'https://build.example' });
    const factory = scriptedTransportFactory(new Map([
      [remote.origin, { verify: identity(remote.origin, 'Build host') }],
    ]));
    const runtime = createControllerRuntime({ catalog, electronSessions: sessions, createRemoteTransport: factory });
    runtime.reportLocalFailure(Object.assign(new Error('PTY unavailable'), { code: 'PTY_FAILURE' }));

    await runtime.reconnect();
    const targets = runtime.listTargets();
    assert.strictEqual(targets[0].id, 'local');
    assert.strictEqual(targets[0].status, 'offline');
    assert.strictEqual(targets[0].error.message, 'PTY unavailable');
    assert.strictEqual(targets[1].status, 'connected');
    assert.strictEqual(targets[1].identity.serverName, 'Build host');
  });

  it('keeps Local computer ready when a downstream caller cancels one request', async function () {
    let attempts = 0;
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createLocalTransport: () => ({
        requestTarget: ({ signal }) => {
          attempts += 1;
          if (attempts > 1) return Promise.resolve(response({ retried: true }));
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
              name: 'AbortError', code: 'ABORT_ERR',
            })), { once: true });
          });
        },
      }),
    });
    runtime.attachLocal({ origin: 'http://127.0.0.1:1', auth: { name: 'ignored', value: 'ignored' } });
    const controller = new AbortController();
    const pending = runtime.request('local', { path: '/api/config', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'ABORT_ERR');
    assert.strictEqual(runtime.listTargets()[0].status, 'ready');
    const retry = await runtime.request('local', { path: '/api/config' });
    assert.strictEqual(retry.statusCode, 200);
    retry.resume();
    assert.strictEqual(runtime.listTargets()[0].status, 'ready');
    assert.strictEqual(attempts, 2);
  });

  it('never saves an unrelated or unapproved-certificate add and persists only after exact approval', async function () {
    const bad = new ControllerTransportError('UNRELATED_RESPONSE', 'Not CODE AGENTS');
    const tls = new ControllerTransportError('TLS_CERTIFICATE', 'Invalid certificate', {
      fingerprint256: FINGERPRINT,
      certificate: { fingerprint256: FINGERPRINT, subject: 'invalid.example' },
    });
    const scripts = new Map([
      ['https://wrong.example', { verify: bad }],
      ['https://invalid.example', {
        verify: (options) => {
          if (options.certificateApproval?.fingerprint === FINGERPRINT) return identity(options.origin, 'Lab');
          throw tls;
        },
      }],
    ]);
    const runtime = createControllerRuntime({
      catalog, electronSessions: sessions, createRemoteTransport: scriptedTransportFactory(scripts),
    });

    const unrelated = await runtime.action('add', { name: 'Wrong', address: 'https://wrong.example' });
    assert.strictEqual(unrelated.success, false);
    assert.deepStrictEqual(catalog.list().map((target) => target.id), ['local']);
    assert.strictEqual(sessions.adapters.size, 0);

    const invalid = await runtime.action('add', { name: 'Lab', address: 'https://invalid.example' });
    assert.strictEqual(invalid.requiresApproval, true);
    assert.strictEqual(invalid.error.certificate.subject, 'invalid.example');
    assert.deepStrictEqual(catalog.list().map((target) => target.id), ['local'], 'approval must precede persistence');
    assert.ok(runtime.listTargets().some((target) => target.id === invalid.target.id && target.stagedAddition));
    await assert.rejects(
      () => runtime.action('approveCertificate', { serverId: invalid.target.id, fingerprint: Array(32).fill('CD').join(':') }),
      /does not match/,
    );
    const approved = await runtime.action('approveCertificate', {
      serverId: invalid.target.id,
      fingerprint: FINGERPRINT,
    });
    assert.strictEqual(approved.target.status, 'connected');
    assert.notStrictEqual(approved.target.id, invalid.target.id);
    assert.strictEqual(catalog.get(approved.target.id).certificateOverride.fingerprint, FINGERPRINT);
    assert.strictEqual(runtime.listTargets().some((target) => target.id === invalid.target.id), false);
  });

  it('cannot resurrect a staged certificate addition removed while approval is verifying', async function () {
    let finishApproval;
    const approvalVerification = new Promise((resolve) => { finishApproval = resolve; });
    const tls = new ControllerTransportError('TLS_CERTIFICATE', 'Invalid certificate', {
      fingerprint256: FINGERPRINT,
    });
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([['https://race.example', {
        verify: (options) => options.certificateApproval
          ? approvalVerification
          : Promise.reject(tls),
      }]])),
    });
    const staged = await runtime.action('add', { name: 'Race lab', address: 'https://race.example' });
    const approval = runtime.action('approveCertificate', {
      serverId: staged.target.id,
      fingerprint: FINGERPRINT,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const removed = await runtime.action('remove', { serverId: staged.target.id });
    assert.strictEqual(removed.success, true);
    finishApproval(identity('https://race.example', 'Race lab'));
    await assert.rejects(approval, (error) => error.code === 'TARGET_CHANGED');
    assert.deepStrictEqual(catalog.list().map((target) => target.id), ['local']);
    assert.strictEqual(runtime.listTargets().some((target) => target.id === staged.target.id), false);
  });

  it('uses a saved target certificate decision for Test but keeps unsaved probes untrusted', async function () {
    const target = catalog.add({ name: 'Pinned', address: 'https://pinned.example' });
    catalog.setCertificateOverride(target.id, FINGERPRINT);
    const tls = new ControllerTransportError('TLS_CERTIFICATE', 'Approval required', {
      fingerprint256: FINGERPRINT,
    });
    const factory = scriptedTransportFactory(new Map([[target.origin, {
      verify: (options) => {
        if (options.certificateApproval?.fingerprint === FINGERPRINT) return identity(options.origin, 'Pinned');
        throw tls;
      },
    }]]));
    const runtime = createControllerRuntime({ catalog, electronSessions: sessions, createRemoteTransport: factory });

    const saved = await runtime.action('test', { serverId: target.id });
    assert.strictEqual(saved.success, true);
    assert.strictEqual(factory.calls.at(-1).certificateApproval.fingerprint, FINGERPRINT);

    const unsaved = await runtime.action('test', { origin: target.origin, name: 'Probe' });
    assert.strictEqual(unsaved.success, false);
    assert.strictEqual(unsaved.requiresApproval, true);
    assert.strictEqual(factory.calls.at(-1).certificateApproval, undefined);
  });

  it('retains signed-out destinations but verifies compatibility before saving a new target', async function () {
    const auth = new ControllerTransportError('AUTH_REQUIRED', 'Identity is not public');
    const unsupported = new ControllerTransportError('UNSUPPORTED_PROTOCOL', 'Upgrade this server', {
      category: 'unsupported-protocol',
    });
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([
        ['https://signed-out.example', { verify: identity('https://signed-out.example', 'Signed out') }],
        ['https://old.example', { verify: unsupported }],
        ['https://private.example', { verify: auth }],
      ])),
    });

    const signedOut = await runtime.action('add', { name: 'Signed out', address: 'https://signed-out.example' });
    assert.strictEqual(signedOut.success, true);
    assert.strictEqual(signedOut.target.status, 'connected');
    assert.strictEqual(signedOut.target.signedIn, false);

    const old = await runtime.action('add', { name: 'Old server', address: 'https://old.example' });
    assert.strictEqual(old.success, false);
    assert.strictEqual(old.error.message, 'Upgrade this server');
    assert.strictEqual(old.target, undefined);
    assert.strictEqual(catalog.list().some((target) => target.name === 'Old server'), false);

    const privateSite = await runtime.action('add', { name: 'Private site', address: 'https://private.example' });
    assert.strictEqual(privateSite.success, false);
    assert.strictEqual(privateSite.error.code, 'AUTH_REQUIRED');
    assert.strictEqual(catalog.list().some((target) => target.name === 'Private site'), false);
  });

  it('keeps a previously saved server visible when a later protocol becomes incompatible', async function () {
    const target = catalog.add({ name: 'Existing', address: 'https://existing.example' });
    const unsupported = new ControllerTransportError('UNSUPPORTED_PROTOCOL', 'Upgrade this server', {
      category: 'unsupported-protocol',
    });
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([[target.origin, { verify: unsupported }]])),
    });

    await runtime.reconnect();
    const visible = runtime.listTargets().find((item) => item.id === target.id);
    assert.strictEqual(visible.status, 'incompatible');
    assert.strictEqual(visible.error.message, 'Upgrade this server');
    assert.ok(catalog.get(target.id));
  });

  it('verifies an address edit before committing and then clears only that partition', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://old.example' });
    catalog.setAuthMarker(target.id, true);
    catalog.setCertificateOverride(target.id, FINGERPRINT);
    catalog.setOfflineMetadata(target.id, [{ id: 'session', active: true }]);
    const scripts = new Map([
      ['https://new.example:8443', { verify: identity('https://new.example:8443', 'Lab') }],
    ]);
    const runtime = createControllerRuntime({
      catalog, electronSessions: sessions, createRemoteTransport: scriptedTransportFactory(scripts),
    });

    const result = await runtime.action('update', {
      serverId: target.id,
      name: 'Renamed lab',
      address: 'https://new.example:8443',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.destinationChanged, true);
    const updated = catalog.get(target.id);
    assert.strictEqual(updated.origin, 'https://new.example:8443');
    assert.strictEqual(updated.name, 'Renamed lab');
    assert.strictEqual(updated.authMarker, undefined);
    assert.strictEqual(updated.certificateOverride, undefined);
    assert.strictEqual(updated.offlineMetadataCache, undefined);
    assert.strictEqual(sessions.adapters.get(target.id).cleared, 1);
  });

  it('stages an invalid-certificate address edit until its presented pin is approved', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://old.example' });
    catalog.setAuthMarker(target.id, true);
    const presented = Array(32).fill('CD').join(':');
    const certificateError = new ControllerTransportError('TLS_CERTIFICATE', 'New destination certificate is invalid', {
      fingerprint256: presented,
    });
    const scripts = new Map([
      ['https://new.example', {
        verify: (options) => {
          if (!options.certificateApproval) throw certificateError;
          return identity('https://new.example', 'Renamed lab');
        },
      }],
    ]);
    const runtime = createControllerRuntime({
      catalog, electronSessions: sessions, createRemoteTransport: scriptedTransportFactory(scripts),
    });

    const staged = await runtime.action('update', {
      serverId: target.id, name: 'Renamed lab', address: 'https://new.example',
    });
    assert.strictEqual(staged.success, false);
    assert.strictEqual(staged.requiresApproval, true);
    assert.strictEqual(staged.stagedDestinationChanged, true, 'the gateway must retire the old live socket');
    assert.strictEqual(catalog.get(target.id).origin, 'https://old.example', 'unapproved address must not persist');
    const visible = runtime.listTargets().find((item) => item.id === target.id);
    assert.strictEqual(visible.origin, 'https://new.example');
    assert.strictEqual(visible.name, 'Renamed lab');
    assert.strictEqual(visible.status, 'certificate-error');
    assert.strictEqual(visible.error.fingerprint256, presented);

    const approved = await runtime.action('approveCertificate', {
      serverId: target.id, fingerprint: presented,
    });
    assert.strictEqual(approved.success, true);
    assert.strictEqual(catalog.get(target.id).origin, 'https://new.example');
    assert.strictEqual(catalog.get(target.id).name, 'Renamed lab');
    assert.strictEqual(catalog.get(target.id).authMarker, undefined);
  });

  it('can cancel or supersede an unapproved address edit without retaining stale trust state', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://old.example' });
    const firstFingerprint = Array(32).fill('CD').join(':');
    const secondFingerprint = Array(32).fill('EF').join(':');
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([
        ['https://first.example', { verify: new ControllerTransportError('TLS_CERTIFICATE', 'First pin', {
          fingerprint256: firstFingerprint,
        }) }],
        ['https://second.example', { verify: new ControllerTransportError('TLS_CERTIFICATE', 'Second pin', {
          fingerprint256: secondFingerprint,
        }) }],
      ])),
    });

    await runtime.action('update', {
      serverId: target.id, name: 'First proposal', address: 'https://first.example',
    });
    const superseded = await runtime.action('update', {
      serverId: target.id, name: 'Second proposal', address: 'https://second.example',
    });
    assert.strictEqual(superseded.target.error.fingerprint256, secondFingerprint);

    const cancelled = await runtime.action('update', {
      serverId: target.id, name: 'Restored lab', address: target.origin,
    });
    assert.strictEqual(cancelled.success, true);
    assert.strictEqual(cancelled.target.origin, target.origin);
    assert.strictEqual(cancelled.target.name, 'Restored lab');
    assert.strictEqual(cancelled.target.status, 'disconnected');
    assert.strictEqual(cancelled.target.stagedDestination, undefined);
    await assert.rejects(
      () => runtime.action('approveCertificate', { serverId: target.id, fingerprint: secondFingerprint }),
      /Retry the connection/,
    );
  });

  it('does not let an older address edit overwrite a newer successful destination', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://old.example' });
    let rejectFirst;
    const delayedFirst = new Promise((_resolve, reject) => { rejectFirst = reject; });
    const firstFingerprint = Array(32).fill('CD').join(':');
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([
        ['https://first.example', { verify: () => delayedFirst }],
        ['https://second.example', { verify: identity('https://second.example', 'Second lab') }],
      ])),
    });

    const first = runtime.action('update', {
      serverId: target.id, name: 'First lab', address: 'https://first.example',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await runtime.action('update', {
      serverId: target.id, name: 'Second lab', address: 'https://second.example',
    });
    assert.strictEqual(second.success, true);
    rejectFirst(new ControllerTransportError('TLS_CERTIFICATE', 'Delayed invalid certificate', {
      fingerprint256: firstFingerprint,
    }));
    const stale = await first;
    assert.strictEqual(stale.superseded, true);
    assert.strictEqual(catalog.get(target.id).origin, 'https://second.example');
    const visible = runtime.listTargets().find((item) => item.id === target.id);
    assert.strictEqual(visible.origin, 'https://second.example');
    assert.strictEqual(visible.status, 'connected');
  });

  it('does not let an old-destination request overwrite a staged address certificate error', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://old.example' });
    let finishOldRequest;
    const oldRequest = new Promise((resolve) => { finishOldRequest = resolve; });
    const certificateError = new ControllerTransportError('TLS_CERTIFICATE', 'Approve the replacement', {
      fingerprint256: FINGERPRINT,
    });
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([
        ['https://old.example', {
          verify: identity('https://old.example'),
          request: async () => oldRequest,
        }],
        ['https://new.example', { verify: certificateError }],
      ])),
    });

    const pendingRequest = runtime.request(target.id, { path: '/api/config' });
    const staged = await runtime.action('update', {
      serverId: target.id, name: 'New lab', address: 'https://new.example',
    });
    assert.strictEqual(staged.requiresApproval, true);
    finishOldRequest(response({ ok: true }));
    await pendingRequest;

    const visible = runtime.listTargets().find((item) => item.id === target.id);
    assert.strictEqual(visible.origin, 'https://new.example');
    assert.strictEqual(visible.status, 'certificate-error');
    assert.strictEqual(visible.error.fingerprint256, FINGERPRINT);
  });

  it('validates an address edit before network or partition changes', async function () {
    const one = catalog.add({ name: 'One', address: 'https://one.example' });
    const two = catalog.add({ name: 'Two', address: 'https://two.example' });
    const factory = scriptedTransportFactory(new Map());
    const runtime = createControllerRuntime({ catalog, electronSessions: sessions, createRemoteTransport: factory });

    await assert.rejects(() => runtime.action('update', {
      serverId: one.id,
      name: two.name,
      address: 'https://three.example',
    }), /names must be unique/);
    assert.strictEqual(factory.calls.length, 0);
    assert.strictEqual(sessions.adapters.size, 0);
    assert.strictEqual(catalog.get(one.id).origin, 'https://one.example');
  });

  it('does not turn authorization denials into sign-out and scopes auth markers to auth endpoints', async function () {
    const target = catalog.add({ name: 'Office', address: 'https://office.example' });
    catalog.setAuthMarker(target.id, true);
    const factory = scriptedTransportFactory(new Map([[target.origin, {
      verify: identity(target.origin),
      request: (request) => response({}, request.path === '/api/admin' ? 403
        : request.path === '/api/private' ? 401 : 200),
    }]]));
    const runtime = createControllerRuntime({ catalog, electronSessions: sessions, createRemoteTransport: factory });

    await runtime.request(target.id, { path: '/api/admin' });
    assert.strictEqual(catalog.get(target.id).authMarker, true);
    assert.strictEqual(runtime.listTargets()[1].status, 'connected');

    await runtime.request(target.id, { path: '/api/private' });
    assert.strictEqual(catalog.get(target.id).authMarker, undefined);
    assert.strictEqual(runtime.listTargets()[1].status, 'authentication-required');

    await runtime.request(target.id, { path: '/api/health' });
    assert.strictEqual(catalog.get(target.id).authMarker, undefined);
    await runtime.request(target.id, { path: '/api/config' });
    assert.strictEqual(catalog.get(target.id).authMarker, true);
  });

  it('does not record a successful contact when a WebSocket upgrade requires authentication', async function () {
    const target = catalog.add({ name: 'Expired', address: 'https://expired.example' });
    catalog.setAuthMarker(target.id, true);
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([[target.origin, {
        verify: identity(target.origin, 'Expired'),
        connect: new ControllerTransportError('AUTH_REQUIRED', 'Sign in again', { statusCode: 401 }),
      }]])),
    });
    await assert.rejects(
      () => runtime.connectWebSocket(target.id, { path: '/' }),
      (error) => error.code === 'AUTH_REQUIRED',
    );
    const persisted = catalog.get(target.id);
    assert.strictEqual(persisted.status, 'authentication-required');
    assert.strictEqual(persisted.lastSuccessfulContact, undefined);
    assert.strictEqual(persisted.authMarker, undefined);
  });

  it('retains the account marker when a WebSocket upgrade is forbidden rather than expired', async function () {
    const target = catalog.add({ name: 'Denied', address: 'https://denied.example' });
    catalog.setAuthMarker(target.id, true);
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([[target.origin, {
        verify: identity(target.origin, 'Denied'),
        connect: new ControllerTransportError('REQUEST_FAILED', 'Permission denied', { statusCode: 403 }),
      }]])),
    });
    await assert.rejects(
      () => runtime.connectWebSocket(target.id, { path: '/' }),
      (error) => error.statusCode === 403,
    );
    assert.strictEqual(catalog.get(target.id).authMarker, true);
    assert.strictEqual(catalog.get(target.id).lastSuccessfulContact, undefined);
  });

  it('can disable an exact certificate override without getting trapped offline', async function () {
    const target = catalog.add({ name: 'Lab', address: 'https://lab.example' });
    catalog.setCertificateOverride(target.id, FINGERPRINT);
    const tls = new ControllerTransportError('TLS_CERTIFICATE', 'A valid certificate is required', {
      fingerprint256: FINGERPRINT,
    });
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map([[target.origin, {
        verify: (options) => {
          if (options.certificateApproval) return identity(options.origin, 'Lab');
          throw tls;
        },
      }]])),
    });

    const result = await runtime.action('requireValidCertificate', { serverId: target.id });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.requiresApproval, true);
    assert.strictEqual(result.target.status, 'certificate-error');
    assert.strictEqual(catalog.get(target.id).certificateOverride, undefined);
    assert.strictEqual(sessions.refreshes.at(-1).certificateOverride, undefined);
  });

  it('isolates sign-in, sign-out, cached metadata, and removal confirmation by server', async function () {
    const one = catalog.add({ name: 'One', address: 'https://one.example' });
    const two = catalog.add({ name: 'Two', address: 'https://two.example' });
    const factory = scriptedTransportFactory(new Map([
      [one.origin, { verify: identity(one.origin), request: () => response({ login: 'one' }) }],
      [two.origin, { verify: identity(two.origin), request: () => response({ login: 'two' }) }],
    ]));
    const runtime = createControllerRuntime({ catalog, electronSessions: sessions, createRemoteTransport: factory });

    assert.strictEqual((await runtime.action('signIn', { serverId: one.id })).success, true);
    runtime.cacheSessions(one.id, [{ id: 'active', name: 'Work', active: true, transcript: 'must not persist' }]);
    runtime.cacheSessions(two.id, [{ id: 'idle', status: 'exited' }]);
    assert.strictEqual(catalog.get(one.id).offlineMetadataCache.sessions[0].transcript, undefined);

    const warning = await runtime.action('remove', { serverId: one.id });
    assert.strictEqual(warning.requiresConfirmation, true);
    assert.ok(catalog.get(one.id));
    const removed = await runtime.action('remove', { serverId: one.id, confirmRunning: true });
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(sessions.adapters.get(one.id).cleared, 1);
    assert.ok(catalog.get(two.id));

    const signedOut = await runtime.action('signOut', { serverId: two.id });
    assert.strictEqual(signedOut.target.signedIn, false);
    assert.strictEqual(catalog.get(two.id).offlineMetadataCache, undefined);
    assert.deepStrictEqual(sessions.clearedIds, [two.id]);
  });

  it('starts LAN traffic only for an explicit discover action and passes the strict contract', async function () {
    const calls = [];
    const runtime = createControllerRuntime({
      catalog,
      electronSessions: sessions,
      createRemoteTransport: scriptedTransportFactory(new Map()),
      findLanServers: async (options) => {
        calls.push(options);
        return [identity('https://lan.example', 'LAN host')];
      },
    });
    assert.strictEqual(calls.length, 0);
    const result = await runtime.action('discover', { timeoutMs: 700 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].probe, LAN_DISCOVERY_PROBE);
    assert.strictEqual(calls[0].port, LAN_DISCOVERY_PORT);
    assert.strictEqual(calls[0].timeoutMs, 700);
    assert.deepStrictEqual(result.candidates.map((candidate) => candidate.serverName), ['LAN host']);
  });

  it('parses only bounded versioned discovery identities', function () {
    const payload = Buffer.from(JSON.stringify({
      type: 'CODE_AGENTS_IDENTITY/1', identity: identity('https://lan.example'),
    }));
    assert.strictEqual(parseDiscoveryResponse(payload).address, 'https://lan.example');
    assert.strictEqual(parseDiscoveryResponse(Buffer.from('{}')), null);
    assert.strictEqual(parseDiscoveryResponse(Buffer.alloc(1025)), null);
    assert.strictEqual(parseDiscoveryResponse(Buffer.from(JSON.stringify({
      type: 'CODE_AGENTS_IDENTITY/1', identity: { ...identity('https://old.example'), protocolVersion: 2 },
    }))).protocolVersion, 2);
  });
});

describe('local controller transport', function () {
  it('keeps the embedded cookie on the exact loopback origin', async function () {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie, origin: req.headers.origin });
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const transport = createLocalControllerTransport({
        origin: `http://127.0.0.1:${address.port}`,
        auth: { name: 'desktop_auth', value: 'secret' },
      });
      const result = await transport.requestTarget({ path: '/api/config', headers: { origin: 'http://controller.invalid' } });
      await new Promise((resolve) => { result.resume(); result.once('end', resolve); });
      assert.deepStrictEqual(seen, [{
        url: '/api/config', cookie: 'desktop_auth=secret', origin: `http://127.0.0.1:${address.port}`,
      }]);
      assert.throws(
        () => transport.requestTarget({ path: 'http://127.0.0.1:1/steal' }),
        /crossed its server boundary/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('streams binary local uploads without changing their type or declared length', async function () {
    const seen = {};
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen.bytes = Buffer.concat(chunks);
      seen.type = req.headers['content-type'];
      seen.length = req.headers['content-length'];
      res.statusCode = 201;
      res.end('stored');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const bytes = Buffer.from([0, 255, 1, 254, 2, 3, 4]);
      const transport = createLocalControllerTransport({
        origin: `http://127.0.0.1:${address.port}`,
        auth: { name: 'desktop_auth', value: 'secret' },
      });
      const response = await transport.requestTarget({
        path: '/api/sessions/raw%2Fid/chat-attachments', method: 'POST',
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
        body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]),
      });
      assert.strictEqual(response.statusCode, 201);
      await new Promise((resolve) => { response.resume(); response.once('end', resolve); });
      assert.deepStrictEqual(seen.bytes, bytes);
      assert.strictEqual(seen.type, 'image/png');
      assert.strictEqual(seen.length, String(bytes.length));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('makes only exact-local absolute redirects origin-relative', async function () {
    let localOrigin;
    const server = http.createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('location', req.url === '/local'
        ? `${localOrigin}/next?value=1#result`
        : 'https://outside.example/steal');
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      localOrigin = `http://127.0.0.1:${address.port}`;
      const transport = createLocalControllerTransport({
        origin: localOrigin,
        auth: { name: 'desktop_auth', value: 'secret' },
      });
      const local = await transport.requestTarget({ path: '/local' });
      assert.strictEqual(local.headers.location, '/next?value=1#result');
      local.resume();
      const external = await transport.requestTarget({ path: '/external' });
      assert.strictEqual(external.headers.location, 'https://outside.example/steal');
      external.resume();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('aborts a request that is still waiting for local response headers', async function () {
    let requestReceived;
    const received = new Promise((resolve) => { requestReceived = resolve; });
    let requestClosed;
    const closed = new Promise((resolve) => { requestClosed = resolve; });
    const server = http.createServer((req) => {
      requestReceived();
      req.once('close', requestClosed);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const transport = createLocalControllerTransport({
        origin: `http://127.0.0.1:${address.port}`,
        auth: { name: 'desktop_auth', value: 'secret' },
      });
      const controller = new AbortController();
      const pending = transport.requestTarget({ path: '/api/config', signal: controller.signal });
      await received;
      controller.abort();
      await assert.rejects(pending, (error) => error.code === 'ABORT_ERR');
      await closed;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
