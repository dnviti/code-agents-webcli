const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDeployTargetRoutes } = require('../dist/server/routes/deploy-targets.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { DeployTargetStore } = require('../dist/server/services/deploy-targets.js');
const { TARGET_LABEL, targetLabelValue } = require('../dist/server/services/environments/index.js');

// The admin API for deploy targets: everything here is installer-only, no
// secret material may ever appear in a response, and the health check must
// touch nothing but `available()` on an engine built through the injected
// factory — which is why the factory, and not a real docker, answers below.

const KEY = Buffer.alloc(32, 9).toString('base64');
const HOST = 'tcp://docker.secret.example:2376';
const TLS = { ca: 'SECRET-CA-MATERIAL', cert: 'SECRET-CERT-MATERIAL', key: 'SECRET-KEY-MATERIAL' };
const KUBECONFIG = 'apiVersion: v1\n# SECRET-KUBECONFIG-MATERIAL';

const INSTALLER = { id: 1, githubLogin: 'installer' };
const OTHER = { id: 2, githubLogin: 'other' };

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-target-routes-'));
}

describe('deploy target routes', function () {
  let server;
  let baseUrl;
  let dataDir;
  let database;
  let store;
  let currentUser;
  let installerUserId;
  let reloadCount;
  let engineBehavior;
  let engineCalls;
  let enginesInManager;
  let createdConfigs;
  let projectRefs;
  let routeDeps;

  /** The engine the injected factory hands out; behavior set per test. */
  function fakeEngine() {
    engineCalls.push('available');
    return {
      kind: 'docker',
      binary: 'docker',
      available: engineBehavior.available,
      list: engineBehavior.list || (async () => []),
    };
  }

  beforeEach(async function () {
    dataDir = tmpRoot();
    database = new AppDatabase({ dataDir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: KEY, warn: () => {} });
    store = new DeployTargetStore({ database, keyRing, dataDir });
    currentUser = INSTALLER;
    installerUserId = 1;
    reloadCount = 0;
    engineCalls = [];
    createdConfigs = [];
    engineBehavior = { available: async () => true };
    enginesInManager = new Map();
    projectRefs = new Map();

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    routeDeps = {
        deployTargetsEnabled: true,
        deployTargets: store,
        deployTargetDataDir: dataDir,
        createDeployEngine: (config) => {
          createdConfigs.push(config);
          return fakeEngine();
        },
        enginesForDeployTargets: () => enginesInManager,
        legacyContainersEnabled: false,
        reloadDeployTargets: () => {
          reloadCount += 1;
        },
        projectIdsForTarget: (id) => projectRefs.get(id) || [],
        getDeploySetting: (key) => database.getSetting(key),
        setDeploySetting: (key, value) => database.setSetting(key, value),
        deleteDeploySetting: (key) => database.deleteSetting(key),
        getInstallerUserId: () => installerUserId,
      };
    app.use(createDeployTargetRoutes(routeDeps));

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async function () {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function req(method, url, body, headers = {}) {
    return fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function createTarget(overrides = {}) {
    return req('POST', '/api/admin/deploy-targets', {
      name: 'box',
      engine: 'docker',
      ...overrides,
    });
  }

  it('returns 404 from every administration surface when the feature is disabled', async function () {
    routeDeps.deployTargetsEnabled = false;
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets')).status, 404);
    assert.strictEqual((await req('POST', '/api/admin/deploy-targets', { name: 'x', engine: 'docker' })).status, 404);
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets/active')).status, 404);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-targets/active', { targetId: null })).status, 404);
    assert.strictEqual((await req('GET', '/api/admin/deploy-settings')).status, 404);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-settings', {})).status, 404);
    assert.deepStrictEqual(store.listTargets(), []);
  });

  it('answers 401 to an unauthenticated caller on every route', async function () {
    currentUser = null;
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets')).status, 401);
    assert.strictEqual((await req('POST', '/api/admin/deploy-targets', {})).status, 401);
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets/active')).status, 401);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-targets/active', { targetId: null })).status, 401);
    assert.strictEqual((await req('GET', '/api/admin/deploy-settings')).status, 401);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-settings', {})).status, 401);
    assert.strictEqual((await req('DELETE', '/api/admin/deploy-targets/x')).status, 401);
  });

  it('answers 403 not_installer to a signed-in non-installer', async function () {
    currentUser = OTHER;
    const res = await req('GET', '/api/admin/deploy-targets');
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, 'not_installer');

    assert.strictEqual((await req('POST', '/api/admin/deploy-targets', { name: 'x', engine: 'docker' })).status, 403);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-targets/active', { targetId: null })).status, 403);
    assert.strictEqual((await req('GET', '/api/admin/deploy-settings')).status, 403);
  });

  it('answers 403 not_installer when no installer is pinned at all', async function () {
    installerUserId = null;
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets')).status, 403);
  });

  it('rejects a cross-origin write but not a cross-origin read', async function () {
    const res = await req('POST', '/api/admin/deploy-targets', { name: 'x', engine: 'docker' }, {
      Origin: 'https://evil.example.com',
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, 'cross_origin');
    assert.strictEqual(store.listTargets().length, 0, 'the write must not have happened');

    const read = await req('GET', '/api/admin/deploy-targets', undefined, {
      Origin: 'https://evil.example.com',
    });
    assert.strictEqual(read.status, 200);
  });

  it('accepts a same-origin write', async function () {
    const res = await createTarget({ name: 'same-origin-box' });
    // fetch sends no Origin header by default; send one matching the host.
    assert.strictEqual(res.status, 201);
    const withOrigin = await req('PUT', '/api/admin/deploy-targets/active', { targetId: null }, {
      Origin: baseUrl,
    });
    assert.strictEqual(withOrigin.status, 200);
  });

  it('persists storage warning settings and preserves omitted values', async function () {
    const defaults = await (await req('GET', '/api/admin/deploy-settings')).json();
    assert.strictEqual(defaults.usageWarnUserBytes, null);
    assert.strictEqual(defaults.usageWarnAdminBytes, null);

    const saved = await req('PUT', '/api/admin/deploy-settings', {
      runLimitPerUser: 4,
      idleStopMinutes: 30,
      idleReclaimMinutes: 60,
      usageWarnUserBytes: 1024,
      usageWarnAdminBytes: 4096,
    });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(await saved.json(), {
      runLimitPerUser: 4,
      idleStopMinutes: 30,
      idleReclaimMinutes: 60,
      usageWarnUserBytes: 1024,
      usageWarnAdminBytes: 4096,
    });

    await req('PUT', '/api/admin/deploy-settings', {
      runLimitPerUser: 5,
      idleStopMinutes: 40,
      idleReclaimMinutes: 80,
    });
    let stored = await (await req('GET', '/api/admin/deploy-settings')).json();
    assert.strictEqual(stored.usageWarnUserBytes, 1024);
    assert.strictEqual(stored.usageWarnAdminBytes, 4096);

    await req('PUT', '/api/admin/deploy-settings', {
      runLimitPerUser: 5,
      idleStopMinutes: 40,
      idleReclaimMinutes: 80,
      usageWarnUserBytes: null,
      usageWarnAdminBytes: null,
    });
    stored = await (await req('GET', '/api/admin/deploy-settings')).json();
    assert.strictEqual(stored.usageWarnUserBytes, null);
    assert.strictEqual(stored.usageWarnAdminBytes, null);
    assert.strictEqual(database.getSetting('deploy.usageWarnUserBytes'), null);
    assert.strictEqual(database.getSetting('deploy.usageWarnAdminBytes'), null);
  });

  it('rejects invalid storage warning settings atomically', async function () {
    database.setSetting('deploy.usageWarnUserBytes', '100');
    database.setSetting('deploy.usageWarnAdminBytes', '200');
    for (const [field, value] of [
      ['usageWarnUserBytes', -1],
      ['usageWarnAdminBytes', 1.5],
      ['usageWarnUserBytes', 'not-bytes'],
      ['usageWarnAdminBytes', Number.MAX_SAFE_INTEGER + 1],
    ]) {
      const response = await req('PUT', '/api/admin/deploy-settings', {
        runLimitPerUser: 3,
        idleStopMinutes: 30,
        idleReclaimMinutes: 60,
        [field]: value,
      });
      assert.strictEqual(response.status, 400, `${field}=${value} should be rejected`);
      assert.strictEqual((await response.json()).error, 'invalid_settings');
      assert.strictEqual(database.getSetting('deploy.usageWarnUserBytes'), '100');
      assert.strictEqual(database.getSetting('deploy.usageWarnAdminBytes'), '200');
    }
  });

  it('creates, lists, reads, updates and deletes a target', async function () {
    const created = await createTarget({
      image: 'example/image:1',
      cpus: '2',
      memory: '4g',
      idleTimeoutMinutes: 30,
      setupCommand: 'apt-get update',
    });
    assert.strictEqual(created.status, 201);
    const { target } = await created.json();
    assert.ok(target.id);
    assert.strictEqual(target.name, 'box');
    assert.strictEqual(target.engine, 'docker');
    assert.strictEqual(target.hasHost, false);
    assert.strictEqual(target.hasKubernetesConfig, false);
    assert.strictEqual(reloadCount, 1, 'a create must reload the manager');

    const list = await (await req('GET', '/api/admin/deploy-targets')).json();
    assert.strictEqual(list.targets.length, 1);
    assert.strictEqual(list.targets[0].id, target.id);
    assert.strictEqual(list.canEdit, true);
    assert.ok(list.engineCaveats.kubernetes.length > 0, 'k8s caveats ship with the list');
    assert.match(list.engineCaveats.docker.join(' '), /Linux.*sh.*\/proc.*setsid/i);
    assert.match(list.engineCaveats.podman.join(' '), /Linux.*sh.*\/proc.*setsid/i);

    const detail = await req('GET', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual((await detail.json()).target.image, 'example/image:1');

    const updated = await req('PUT', `/api/admin/deploy-targets/${target.id}`, { name: 'renamed', memory: '8g' });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual((await updated.json()).target.name, 'renamed');
    assert.strictEqual(reloadCount, 2);

    const del = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(store.listTargets().length, 0);
    assert.strictEqual(reloadCount, 3);
  });

  it('rejects invalid input without echoing secrets', async function () {
    assert.strictEqual((await req('POST', '/api/admin/deploy-targets', { engine: 'docker' })).status, 400);
    assert.strictEqual((await req('POST', '/api/admin/deploy-targets', { name: 'x', engine: 'nerdctl' })).status, 400);

    await createTarget();
    const dupe = await createTarget();
    assert.strictEqual(dupe.status, 409);
    assert.strictEqual((await dupe.json()).error, 'name_exists');
  });

  it('never returns secret material, in any response', async function () {
    const created = await createTarget({
      name: 'secret-box',
      hostSecret: { host: HOST, tls: TLS },
    });
    assert.strictEqual(created.status, 201);
    const { target } = await created.json();
    assert.strictEqual(target.hasHost, true);

    const kube = await createTarget({
      name: 'kube-box',
      engine: 'kubernetes',
      kubernetesSecret: { kubeconfig: KUBECONFIG, namespace: 'work' },
    });
    assert.strictEqual(kube.status, 201);
    const kubeTarget = (await kube.json()).target;
    assert.strictEqual(kubeTarget.hasKubernetesConfig, true);

    const responses = [
      JSON.stringify(target),
      JSON.stringify(kubeTarget),
      JSON.stringify(await (await req('GET', '/api/admin/deploy-targets')).json()),
      JSON.stringify(await (await req('GET', `/api/admin/deploy-targets/${target.id}`)).json()),
      JSON.stringify(await (await req('GET', `/api/admin/deploy-targets/${kubeTarget.id}`)).json()),
    ];
    for (const body of responses) {
      assert.ok(!body.includes(HOST), `host leaked in ${body}`);
      for (const marker of Object.values(TLS)) {
        assert.ok(!body.includes(marker), `TLS material leaked in ${body}`);
      }
      assert.ok(!body.includes('SECRET-KUBECONFIG-MATERIAL'), `kubeconfig leaked in ${body}`);
    }
  });

  it('keeps a stored secret on update unless a new one is sent', async function () {
    const { target } = await (await createTarget({
      hostSecret: { host: HOST, tls: TLS },
    })).json();

    await req('PUT', `/api/admin/deploy-targets/${target.id}`, { name: 'still-secret' });
    assert.strictEqual(store.getTarget(target.id).hostSecret.host, HOST, 'absent field keeps the secret');

    await req('PUT', `/api/admin/deploy-targets/${target.id}`, { hostSecret: null });
    assert.strictEqual(store.getTarget(target.id).hostSecret, null, 'null clears the secret');
  });

  it('merges a partial secret edit instead of wiping companion material', async function () {
    // What the UI sends after M5: only the subfields the installer actually
    // edited. Everything else must survive.
    const kube = await (await createTarget({
      name: 'kube-merge',
      engine: 'kubernetes',
      kubernetesSecret: { kubeconfig: KUBECONFIG, context: 'ctx', namespace: 'ws' },
    })).json();

    const nsOnly = await req('PUT', `/api/admin/deploy-targets/${kube.target.id}`, {
      kubernetesSecret: { namespace: 'other' },
    });
    assert.strictEqual(nsOnly.status, 200);
    const kubeStored = store.getTarget(kube.target.id).kubernetesSecret;
    assert.strictEqual(kubeStored.namespace, 'other');
    assert.strictEqual(kubeStored.kubeconfig, KUBECONFIG, 'a namespace-only edit keeps the stored kubeconfig');
    assert.strictEqual(kubeStored.context, 'ctx');

    const docker = await (await createTarget({
      name: 'tls-merge',
      hostSecret: { host: HOST, tls: TLS },
    })).json();

    const hostOnly = await req('PUT', `/api/admin/deploy-targets/${docker.target.id}`, {
      hostSecret: { host: 'tcp://other:2376' },
    });
    assert.strictEqual(hostOnly.status, 200);
    const hostStored = store.getTarget(docker.target.id).hostSecret;
    assert.strictEqual(hostStored.host, 'tcp://other:2376');
    assert.deepStrictEqual(hostStored.tls, TLS, 'blank TLS fields keep the stored TLS');

    // …and an explicit null still clears just the TLS material.
    await req('PUT', `/api/admin/deploy-targets/${docker.target.id}`, {
      hostSecret: { host: 'tcp://other:2376', tls: null },
    });
    assert.strictEqual(store.getTarget(docker.target.id).hostSecret.tls, null);
  });

  it('rejects a tls object with any empty field', async function () {
    for (const tls of [
      { ca: '', cert: 'c', key: 'k' },
      { ca: 'a', cert: '', key: 'k' },
      { ca: 'a', cert: 'c', key: '' },
    ]) {
      const res = await createTarget({ name: `tls-${tls.ca || 'x'}`, hostSecret: { host: HOST, tls } });
      assert.strictEqual(res.status, 400, `tls ${JSON.stringify(tls)} must be rejected`);
      assert.strictEqual((await res.json()).error, 'invalid_target');
    }
    assert.strictEqual(store.listTargets().length, 0, 'none of them may be stored');
  });

  it('checks a target through the injected engine factory and persists the outcome', async function () {
    const { target } = await (await createTarget()).json();

    const res = await req('POST', `/api/admin/deploy-targets/${target.id}/check`, {});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.deepStrictEqual(engineCalls, ['available'], 'a check may only ask available()');
    assert.strictEqual(store.listTargets()[0].lastCheck.ok, true, 'the outcome is persisted');
  });

  it('reports a failed check without credential material in the error', async function () {
    const { target } = await (await createTarget({
      hostSecret: { host: HOST, tls: TLS },
    })).json();

    // What docker actually says: it rewrites the stored tcp:// host into the
    // https:// URL it tried to reach, so scrubbing the stored string alone
    // would leave the host standing in the message.
    engineBehavior.available = async () => {
      throw new Error(
        'error during connect: Post "https://docker.secret.example:2376/v1.51/info": '
        + `x509: certificate signed by unknown authority (${TLS.ca})`,
      );
    };
    const res = await req('POST', `/api/admin/deploy-targets/${target.id}/check`, {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.ok(!body.error.includes('docker.secret.example'), `host leaked in "${body.error}"`);
    assert.ok(!body.error.includes(TLS.ca), `TLS material leaked in "${body.error}"`);
    assert.ok(body.error.includes('[redacted]'), 'the redaction must be visible');

    const persisted = store.listTargets()[0].lastCheck;
    assert.strictEqual(persisted.ok, false);
    assert.ok(!persisted.error.includes('docker.secret.example'), 'the persisted error must be scrubbed too');
  });

  it('scrubs the cluster server URL a kubectl error quotes', async function () {
    const kubeconfig = [
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      '    certificate-authority-data: SECRET-CA-DATA',
      '    server: https://k8s.secret.example:6443',
      '  name: secret-cluster',
    ].join('\n');
    const { target } = await (await createTarget({
      name: 'kube-check',
      engine: 'kubernetes',
      kubernetesSecret: { kubeconfig, namespace: 'work' },
    })).json();

    // kubectl quotes the cluster's server URL, not the kubeconfig itself.
    engineBehavior.available = async () => {
      throw new Error(
        'The connection to the server https://k8s.secret.example:6443 was refused '
        + '- did you specify the right host or port?',
      );
    };
    const res = await req('POST', `/api/admin/deploy-targets/${target.id}/check`, {});
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.ok(!body.error.includes('k8s.secret.example'), `cluster server leaked in "${body.error}"`);
    assert.ok(body.error.includes('[redacted]'));
  });

  it('checks a target whose engine simply does not answer', async function () {
    const { target } = await (await createTarget()).json();
    engineBehavior.available = async () => false;
    const body = await (await req('POST', `/api/admin/deploy-targets/${target.id}/check`, {})).json();
    assert.strictEqual(body.ok, false);
    assert.ok(body.error.length > 0);
  });

  it('gets and sets the active target, and says running work stays put', async function () {
    const { target } = await (await createTarget()).json();

    const before = await (await req('GET', '/api/admin/deploy-targets/active')).json();
    assert.strictEqual(before.activeTargetId, null);

    const res = await req('PUT', '/api/admin/deploy-targets/active', { targetId: target.id });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.activeTargetId, target.id);
    assert.ok(/stays on|stay on|already running/i.test(body.message), 'the response must say running work is unaffected');
    assert.strictEqual(reloadCount, 2, 'create + activate');

    const after = await (await req('GET', '/api/admin/deploy-targets/active')).json();
    assert.strictEqual(after.activeTargetId, target.id);
  });

  it('refuses to activate a target that does not exist', async function () {
    const res = await req('PUT', '/api/admin/deploy-targets/active', {
      targetId: '00000000-0000-4000-8000-000000000000',
    });
    assert.ok(res.status === 400 || res.status === 404, `expected 4xx, got ${res.status}`);
    assert.strictEqual((await res.json()).error, 'unknown_target');
    assert.strictEqual(store.getActiveTargetId(), null);
  });

  it('answers 409 target_in_use when an engine still lists containers for the target', async function () {
    const { target } = await (await createTarget()).json();
    const label = `${TARGET_LABEL}=${targetLabelValue(target.id)}`;

    let askedLabel = null;
    enginesInManager.set(target.id, {
      kind: 'docker',
      binary: 'docker',
      list: async (l) => {
        askedLabel = l;
        return l === label ? ['cawc-cid-1', 'cawc-cid-2'] : [];
      },
    });

    const res = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'target_in_use');
    assert.deepStrictEqual(body.containers, ['cawc-cid-1', 'cawc-cid-2']);
    assert.strictEqual(askedLabel, label, 'the engine was asked with the target label');
    assert.strictEqual(store.listTargets().length, 1, 'the target must survive');

    // Once the containers are gone the delete goes through.
    enginesInManager.set(target.id, { kind: 'docker', binary: 'docker', list: async () => [] });
    const ok = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(store.listTargets().length, 0);
  });

  it('fails closed and retains target credentials when runtime inspection fails', async function () {
    const { target } = await (await createTarget({
      hostSecret: { host: HOST, tls: TLS },
    })).json();
    // A failed list is unknown, not proof that the target is empty.
    enginesInManager.set(target.id, {
      kind: 'docker',
      binary: 'docker',
      list: async () => {
        throw new Error(`cannot reach ${HOST}`);
      },
    });

    const res = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'target_runtime_unknown');
    assert.ok(!JSON.stringify(body).includes(HOST), 'connection failures must not leak credentials');
    assert.strictEqual(store.getTarget(target.id).hostSecret.host, HOST, 'the target and its credentials survive');
    assert.strictEqual(reloadCount, 1, 'a failed inspection does not reload or remove the target');
  });

  it('inspects a target runtime even when the manager did not retain its engine', async function () {
    const { target } = await (await createTarget()).json();
    engineBehavior.list = async () => ['orphaned-container'];

    const res = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual((await res.json()).containers, ['orphaned-container']);
    assert.ok(store.getTarget(target.id), 'the target survives a container found by its direct runtime probe');
  });

  it('retains a target recorded by stopped or reclaimed projects', async function () {
    const { target } = await (await createTarget()).json();
    projectRefs.set(target.id, ['project-stopped']);

    const changedConnection = await req('PUT', `/api/admin/deploy-targets/${target.id}`, {
      hostSecret: { host: 'tcp://replacement.example:2376' },
    });
    assert.strictEqual(changedConnection.status, 409);
    assert.deepStrictEqual((await changedConnection.json()).projects, ['project-stopped']);

    const deleted = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(deleted.status, 409);
    assert.deepStrictEqual((await deleted.json()).projects, ['project-stopped']);
    assert.ok(store.getTarget(target.id), 'durable project placement keeps its target row');
  });

  it('blocks connection edits while containers stand, but not renames or retunes', async function () {
    const { target } = await (await createTarget({
      hostSecret: { host: HOST },
    })).json();
    enginesInManager.set(target.id, {
      kind: 'docker',
      binary: 'docker',
      list: async () => ['cawc-cid-1'],
    });

    // Changing how the engine is reached would strand the containers the old
    // connection produced — same answer as a delete.
    for (const patch of [
      { hostSecret: { host: 'tcp://elsewhere:2376' } },
      { engine: 'podman' },
    ]) {
      const res = await req('PUT', `/api/admin/deploy-targets/${target.id}`, patch);
      assert.strictEqual(res.status, 409, `${JSON.stringify(patch)} must be blocked`);
      assert.strictEqual((await res.json()).error, 'target_in_use');
    }
    assert.strictEqual(store.getTarget(target.id).hostSecret.host, HOST, 'the blocked edit did not land');

    // Re-sending the stored connection values is not a change.
    const same = await req('PUT', `/api/admin/deploy-targets/${target.id}`, {
      hostSecret: { host: HOST },
    });
    assert.strictEqual(same.status, 200);

    // Renames, image and tier edits stay allowed with containers standing.
    const rename = await req('PUT', `/api/admin/deploy-targets/${target.id}`, {
      name: 'renamed',
      image: 'example/image:2',
      idleTimeoutMinutes: 15,
    });
    assert.strictEqual(rename.status, 200);
    assert.strictEqual(store.getTarget(target.id).name, 'renamed');

    // …and the same connection edit goes through once the containers are gone.
    enginesInManager.set(target.id, { kind: 'docker', binary: 'docker', list: async () => [] });
    const moved = await req('PUT', `/api/admin/deploy-targets/${target.id}`, {
      hostSecret: { host: 'tcp://elsewhere:2376' },
    });
    assert.strictEqual(moved.status, 200);
    assert.strictEqual(store.getTarget(target.id).hostSecret.host, 'tcp://elsewhere:2376');
  });

  it('clears the activation when the active target is deleted', async function () {
    const { target } = await (await createTarget()).json();
    await req('PUT', '/api/admin/deploy-targets/active', { targetId: target.id });
    assert.strictEqual(store.getActiveTargetId(), target.id);

    const res = await req('DELETE', `/api/admin/deploy-targets/${target.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(store.getActiveTargetId(), null);
  });

  it('answers 404 for a target that does not exist', async function () {
    assert.strictEqual((await req('GET', '/api/admin/deploy-targets/nope')).status, 404);
    assert.strictEqual((await req('PUT', '/api/admin/deploy-targets/nope', { name: 'x' })).status, 404);
    assert.strictEqual((await req('DELETE', '/api/admin/deploy-targets/nope')).status, 404);
    assert.strictEqual((await req('POST', '/api/admin/deploy-targets/nope/check', {})).status, 404);
  });
});
