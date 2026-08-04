const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConnectedHostRoutes } = require('../dist/server/routes/connected-hosts.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { ProjectStore } = require('../dist/server/services/projects/store.js');

const OWNER = { id: 1, githubLogin: 'owner' };
const OTHER = { id: 2, githubLogin: 'other' };
const KEY = Buffer.alloc(32, 9).toString('base64');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-hosts-routes-'));
}

function makeApp(deps, currentUser = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: currentUser, authSessionId: null };
    next();
  });
  app.use(createConnectedHostRoutes(deps));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function req(baseUrl, method, url, body, headers = {}) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('connected-host routes', function () {
  let serverInfo;
  let dataDir;
  let database;
  let keyRing;
  let projectStore;

  beforeEach(async function () {
    dataDir = tmpRoot();
    database = new AppDatabase({ dataDir });
    keyRing = new EncryptionKeyRing({ settings: database, key: KEY, warn: () => {} });
    projectStore = new ProjectStore({ database, keyRing });
    OWNER.id = database.upsertGitHubUser({ githubId: 'owner-id', githubLogin: 'owner' }).id;
    OTHER.id = database.upsertGitHubUser({ githubId: 'other-id', githubLogin: 'other' }).id;
  });

  afterEach(async function () {
    if (serverInfo) {
      serverInfo.server.closeAllConnections?.();
      await serverInfo.close();
      serverInfo = null;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function appFor(currentUser) {
    return makeApp({ projectStore }, currentUser);
  }

  it('answers 401 to an unauthenticated caller on every route', async function () {
    const app = appFor(null);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    assert.strictEqual((await req(baseUrl, 'GET', '/api/connected-hosts')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'x', token: 't' })).status, 401);
    assert.strictEqual((await req(baseUrl, 'DELETE', '/api/connected-hosts/github.com')).status, 401);
  });

  it('rejects a cross-origin write but allows a cross-origin read', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const create = await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com', token: 't' }, { Origin: 'https://evil.example.com' });
    assert.strictEqual(create.status, 403);
    assert.strictEqual((await create.json()).error, 'cross_origin');

    const del = await req(baseUrl, 'DELETE', '/api/connected-hosts/github.com', undefined, { Origin: 'https://evil.example.com' });
    assert.strictEqual(del.status, 403);

    const read = await req(baseUrl, 'GET', '/api/connected-hosts', undefined, { Origin: 'https://evil.example.com' });
    assert.strictEqual(read.status, 200);
  });

  it('stores, lists and deletes a host credential', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const create = await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com', token: 'ghp_secret' });
    assert.strictEqual(create.status, 200);
    const body = await create.json();
    assert.strictEqual(body.host.host, 'github.com');
    assert.strictEqual(body.host.kind, 'token');
    assert.ok(!body.host.credential, 'credential must not be returned');
    const stored = database.raw.prepare(
      'SELECT credential_encrypted FROM connected_hosts WHERE user_id = ? AND host = ?',
    ).get(OWNER.id, 'github.com').credential_encrypted;
    assert.ok(stored);
    assert.ok(!stored.includes('ghp_secret'), 'plaintext token must never be stored in SQLite');
    assert.strictEqual(projectStore.credentialFor(OWNER.id, 'github.com'), 'ghp_secret');

    const list = await req(baseUrl, 'GET', '/api/connected-hosts');
    assert.strictEqual(list.status, 200);
    const hosts = (await list.json()).hosts;
    assert.strictEqual(hosts.length, 1);
    assert.strictEqual(hosts[0].host, 'github.com');

    const del = await req(baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(del.status, 204);

    const list2 = await req(baseUrl, 'GET', '/api/connected-hosts');
    assert.strictEqual((await list2.json()).hosts.length, 0);
  });

  it('normalizes host casing on create and delete', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    await req(baseUrl, 'POST', '/api/connected-hosts', { host: '  GITHUB.COM  ', token: 't' });
    const list = await (await req(baseUrl, 'GET', '/api/connected-hosts')).json();
    assert.strictEqual(list.hosts[0].host, 'github.com');

    const del = await req(baseUrl, 'DELETE', '/api/connected-hosts/GitHub.com');
    assert.strictEqual(del.status, 204);
    assert.strictEqual((await (await req(baseUrl, 'GET', '/api/connected-hosts')).json()).hosts.length, 0);
  });

  it('upserts rather than duplicating a host for the same user', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com', token: 'first' });
    await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com', token: 'second' });
    const list = await (await req(baseUrl, 'GET', '/api/connected-hosts')).json();
    assert.strictEqual(list.hosts.length, 1);
    assert.strictEqual(projectStore.credentialFor(OWNER.id, 'github.com'), 'second');
  });

  it('scopes hosts to the signed-in user', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    let { baseUrl } = serverInfo;

    await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com', token: 't' });

    serverInfo.server.closeAllConnections?.();
    await serverInfo.close();
    const app2 = appFor(OTHER);
    serverInfo = await listen(app2);
    baseUrl = serverInfo.baseUrl;

    const list = await (await req(baseUrl, 'GET', '/api/connected-hosts')).json();
    assert.strictEqual(list.hosts.length, 0);

    const del = await req(baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(del.status, 404);
  });

  it('returns 404 when deleting a host that does not exist', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await res.json()).error, 'not_found');
  });

  it('awaits live credential scrubbing before deleting the encrypted source row', async function () {
    projectStore.upsertConnectedHostToken(OWNER.id, 'github.com', 'private');
    const order = [];
    const originalDelete = projectStore.deleteConnectedHost.bind(projectStore);
    const scopedStore = Object.create(projectStore);
    scopedStore.deleteConnectedHost = (...args) => { order.push('delete'); return originalDelete(...args); };
    const app = makeApp({
      projectStore: scopedStore,
      disconnectHostCredentials: async (userId, host) => {
        assert.strictEqual(userId, OWNER.id);
        assert.strictEqual(host, 'github.com');
        assert.strictEqual(projectStore.listConnectedHosts(OWNER.id).length, 1, 'source exists while scrub runs');
        await Promise.resolve();
        order.push('scrub');
      },
    }, OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(response.status, 204);
    assert.deepStrictEqual(order, ['scrub', 'delete']);
    assert.strictEqual(projectStore.listConnectedHosts(OWNER.id).length, 0);
  });

  it('keeps the encrypted row when live credential scrubbing fails', async function () {
    projectStore.upsertConnectedHostToken(OWNER.id, 'github.com', 'must-remain-retryable');
    const app = makeApp({
      projectStore,
      disconnectHostCredentials: async () => { throw new Error('must-remain-retryable'); },
    }, OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(response.status, 503);
    const body = await response.json();
    assert.strictEqual(body.error, 'credential_scrub_failed');
    assert.ok(!JSON.stringify(body).includes('must-remain-retryable'));
    assert.strictEqual(projectStore.listConnectedHosts(OWNER.id).length, 1);
    assert.strictEqual(projectStore.credentialFor(OWNER.id, 'github.com'), 'must-remain-retryable');
  });

  it('does not delete twice when lifecycle synchronization owns source deletion', async function () {
    projectStore.upsertConnectedHostToken(OWNER.id, 'github.com', 'private');
    let routeDeletes = 0;
    const scopedStore = Object.create(projectStore);
    scopedStore.deleteConnectedHost = (...args) => {
      routeDeletes += 1;
      return projectStore.deleteConnectedHost(...args);
    };
    const app = makeApp({
      projectStore: scopedStore,
      disconnectHostCredentials: async (userId, host) => {
        assert.strictEqual(projectStore.deleteConnectedHost(userId, host), true);
        return true;
      },
    }, OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'DELETE', '/api/connected-hosts/github.com');
    assert.strictEqual(response.status, 204);
    assert.strictEqual(routeDeletes, 0);
  });

  it('validates create input', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const noHost = await req(baseUrl, 'POST', '/api/connected-hosts', { token: 't' });
    assert.strictEqual(noHost.status, 400);
    assert.strictEqual((await noHost.json()).error, 'validation');

    const noToken = await req(baseUrl, 'POST', '/api/connected-hosts', { host: 'github.com' });
    assert.strictEqual(noToken.status, 400);
    assert.strictEqual((await noToken.json()).error, 'validation');

    const emptyHost = await req(baseUrl, 'POST', '/api/connected-hosts', { host: '   ', token: 't' });
    assert.strictEqual(emptyHost.status, 400);

    for (const host of [
      'https://github.com',
      'github.com/path',
      'user@github.com',
      'a b',
      '/',
      'github.com:99999',
    ]) {
      const invalid = await req(baseUrl, 'POST', '/api/connected-hosts', { host, token: 't' });
      assert.strictEqual(invalid.status, 400, `expected ${host} to be rejected`);
    }
  });

  it('accepts and normalizes a valid host with a port', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const create = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'GIT.EXAMPLE.COM:8443',
      token: 'token',
    });
    assert.strictEqual(create.status, 200);
    assert.strictEqual((await create.json()).host.host, 'git.example.com:8443');
  });

  it('validates an explicitly selected forge through the bounded exact-host seam', async function () {
    const calls = [];
    const app = makeApp({
      projectStore,
      tokenValidator: { validate: async (input) => { calls.push(input); return { ok: true, scopes: ['repo'] }; } },
    }, OWNER);
    serverInfo = await listen(app);
    const token = 'not-in-response';
    const create = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'github.com', token, forgeKind: 'github',
    });
    assert.strictEqual(create.status, 200);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual({
      host: calls[0].host, url: calls[0].url, forgeKind: calls[0].forgeKind,
      redirect: calls[0].redirect, timeoutMs: calls[0].timeoutMs, maxResponseBytes: calls[0].maxResponseBytes,
    }, { host: 'github.com', url: 'https://github.com', forgeKind: 'github', redirect: 'error', timeoutMs: 5000, maxResponseBytes: 65536 });
    const body = await create.json();
    assert.strictEqual(body.host.validationStatus, 'valid');
    assert.ok(!JSON.stringify(body).includes(token));
  });

  it('does not let delayed validation overwrite a newer credential generation', async function () {
    let releaseValidation;
    let validationStarted;
    const started = new Promise((resolve) => { validationStarted = resolve; });
    const gate = new Promise((resolve) => { releaseValidation = resolve; });
    const app = makeApp({
      projectStore,
      tokenValidator: {
        validate: async () => {
          validationStarted();
          await gate;
          return { ok: true, scopes: ['repo'] };
        },
      },
    }, OWNER);
    serverInfo = await listen(app);

    const staleRequest = req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'github.com', token: 'superseded-token', forgeKind: 'github',
    });
    await started;
    const replacement = projectStore.upsertConnectedHostToken(OWNER.id, 'github.com', 'current-token');
    releaseValidation();

    const response = await staleRequest;
    assert.strictEqual(response.status, 409);
    assert.strictEqual((await response.json()).error, 'credential_changed');
    assert.strictEqual(projectStore.credentialFor(OWNER.id, 'github.com'), 'current-token');
    const current = projectStore.listConnectedHosts(OWNER.id)[0];
    assert.strictEqual(current.credentialRevision, replacement.credentialRevision);
    assert.strictEqual(current.validationStatus, 'unvalidated');
  });

  it('keeps replacement validation and live refresh inside the integration critical section', async function () {
    const order = [];
    const app = makeApp({
      projectStore,
      tokenValidator: {
        validate: async () => { order.push('validate'); return { ok: true }; },
      },
      synchronizeHostCredentialReplacement: async (userId, host, mutation) => {
        assert.strictEqual(userId, OWNER.id);
        assert.strictEqual(host, 'github.com');
        order.push('lock');
        const result = await mutation();
        order.push(`refresh:${projectStore.credentialFor(userId, host)}`);
        return result;
      },
    }, OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'github.com', token: 'replacement-token', forgeKind: 'github',
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(order, ['lock', 'validate', 'refresh:replacement-token']);
  });

  it('records a safe invalid result and permits a replacement without exposing the token', async function () {
    let attempts = 0;
    const app = makeApp({
      projectStore,
      tokenValidator: { validate: async () => (++attempts === 1
        ? { ok: false, status: 401, code: 'expired', message: 'Credential expired.' }
        : { ok: true }) },
    }, OWNER);
    serverInfo = await listen(app);
    const firstToken = 'first-private-token';
    const failed = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'gitlab.com', token: firstToken, forgeKind: 'gitlab',
    });
    assert.strictEqual(failed.status, 401);
    const failedBody = await failed.json();
    assert.deepStrictEqual(failedBody, { error: 'credential_invalid', code: 'expired', message: 'Credential expired.' });
    assert.ok(!JSON.stringify(failedBody).includes(firstToken));
    assert.strictEqual(projectStore.listConnectedHosts(OWNER.id)[0].validationStatus, 'invalid');
    const replacement = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'gitlab.com', token: 'replacement-private-token', forgeKind: 'gitlab',
    });
    assert.strictEqual(replacement.status, 200);
    assert.strictEqual(projectStore.listConnectedHosts(OWNER.id)[0].validationStatus, 'valid');
  });

  it('redacts a credential echoed by a failing validation adapter', async function () {
    const token = 'private-validator-token';
    const app = makeApp({
      projectStore,
      tokenValidator: { validate: async () => ({ ok: false, status: 403, code: `bad-${token}`, message: `Remote rejected ${token}` }) },
    }, OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'github.com', token, forgeKind: 'github',
    });
    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes(token));
    assert.ok(!JSON.stringify(projectStore.listConnectedHosts(OWNER.id)).includes(token));
    assert.match(body.message, /\[redacted\]/);
  });

  it('rejects unavailable OAuth approval rather than pretending it is connected', async function () {
    const app = appFor(OWNER);
    serverInfo = await listen(app);
    const response = await req(serverInfo.baseUrl, 'POST', '/api/connected-hosts', {
      host: 'github.com', token: 'private', credentialKind: 'oauth',
    });
    assert.strictEqual(response.status, 501);
    assert.strictEqual((await response.json()).error, 'oauth_approval_unavailable');
  });
});
