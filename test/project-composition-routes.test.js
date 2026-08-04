const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');

const { createProjectRoutes } = require('../dist/server/routes/projects.js');

const OWNER = {
  id: 1,
  githubId: 'owner-id',
  githubLogin: 'owner',
  githubName: 'Project Owner',
  avatarUrl: null,
  email: 'owner@example.test',
};
const OTHER = { ...OWNER, id: 2, githubId: 'other-id', githubLogin: 'other' };
const NOW = '2026-08-03T10:00:00.000Z';

function project(overrides = {}) {
  return {
    id: 'project-1',
    ownerUserId: OWNER.id,
    name: 'acme',
    repoUrl: 'https://github.com/example/acme.git',
    repoHost: 'github.com',
    targetId: 'target-1',
    tierId: null,
    state: 'composition_pending',
    stateDetail: 'Build recipe is ready for review',
    container: null,
    rebuildRequired: false,
    buildLog: [],
    lastActivityAt: NOW,
    lastPreservedCommit: null,
    lastPreservedBranch: null,
    compositionRevision: null,
    appliedCompositionRevision: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function composition(overrides = {}) {
  return {
    revision: 'revision-1',
    activeRevision: null,
    appliedRevision: null,
    detected: {
      catalogVersion: 'v1',
      sourceOid: 'a'.repeat(40),
      sourceRef: 'refs/heads/main',
      forgeHint: { kind: 'github', host: 'github.com' },
      detectedRuntimes: [{
        runtimeId: 'node',
        sources: ['package.json'],
        versionHints: [{ path: '.tool-versions', version: '22.14.0' }],
        selectedVersion: '22.14.0',
        versionSource: 'marker',
      }],
    },
    chosen: { runtimes: [{ runtimeId: 'node', version: '22.14.0' }], forgeKind: 'github' },
    installations: [{
      itemId: 'node', status: 'pending', attempts: 0, installedVersion: null,
      errorCode: null, errorMessage: null,
    }],
    identity: { name: 'Project Owner', email: 'owner@example.test' },
    identitySource: 'provider',
    forge: { kind: 'github', host: 'github.com', connected: false, validationStatus: null },
    ...overrides,
  };
}

function makeManager() {
  const ownedProject = project();
  const calls = [];
  const responses = {
    read: { ok: true, project: ownedProject, composition: composition() },
    save: { ok: true, composition: composition({ revision: 'revision-2' }) },
    confirm: { ok: true, state: 'building' },
    retry: { ok: true, installations: composition().installations },
    inspect: { ok: true, project: ownedProject, composition: composition() },
  };
  const owns = (ownerUserId, projectId) => ownerUserId === OWNER.id && projectId === ownedProject.id;

  return {
    events: new EventEmitter(),
    calls,
    responses,
    getComposition(ownerUserId, projectId) {
      calls.push({ op: 'read', ownerUserId, projectId });
      return owns(ownerUserId, projectId) ? responses.read : { ok: false, reason: 'not_found' };
    },
    async saveComposition(ownerUserId, projectId, input) {
      calls.push({ op: 'save', ownerUserId, projectId, input });
      return owns(ownerUserId, projectId) ? responses.save : { ok: false, reason: 'not_found' };
    },
    async confirmComposition(ownerUserId, projectId, input) {
      calls.push({ op: 'confirm', ownerUserId, projectId, input });
      return owns(ownerUserId, projectId) ? responses.confirm : { ok: false, reason: 'not_found' };
    },
    async retryComposition(ownerUserId, projectId) {
      calls.push({ op: 'retry', ownerUserId, projectId });
      return owns(ownerUserId, projectId) ? responses.retry : { ok: false, reason: 'not_found' };
    },
    reinspectComposition(ownerUserId, projectId) {
      calls.push({ op: 'inspect', ownerUserId, projectId });
      return owns(ownerUserId, projectId) ? responses.inspect : { ok: false, reason: 'not_found' };
    },
  };
}

function makeApp(manager, currentUser = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: currentUser, authSessionId: currentUser ? 'test-session' : null };
    next();
  });
  app.use(createProjectRoutes({ manager, targetNameFor: () => 'Build cluster' }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function request(baseUrl, method, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PATHS = {
  read: '/api/projects/project-1/composition',
  save: '/api/projects/project-1/composition',
  confirm: '/api/projects/project-1/composition/confirm',
  retry: '/api/projects/project-1/composition/retry',
  inspect: '/api/projects/project-1/composition/inspect',
};

describe('project composition route contracts', function () {
  let serverInfo;

  afterEach(async function () {
    if (!serverInfo) return;
    serverInfo.server.closeAllConnections?.();
    await serverInfo.close();
    serverInfo = null;
  });

  it('requires authentication on every composition route', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager, null));
    const cases = [
      ['GET', PATHS.read, undefined],
      ['PUT', PATHS.save, { expectedCurrentRevision: null, runtimes: [] }],
      ['POST', PATHS.confirm, { revision: 'revision-1', expectedRevision: null, acknowledgeRebuild: false }],
      ['POST', PATHS.retry, {}],
      ['POST', PATHS.inspect, {}],
    ];

    for (const [method, pathname, body] of cases) {
      const response = await request(serverInfo.baseUrl, method, pathname, body);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'authentication_required');
    }
    assert.deepEqual(manager.calls, []);
  });

  it('passes the authenticated owner id and hides another owner project as not found', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager, OTHER));
    const cases = [
      ['GET', PATHS.read, undefined],
      ['PUT', PATHS.save, { expectedCurrentRevision: null, runtimes: [] }],
      ['POST', PATHS.confirm, { revision: 'revision-1', expectedRevision: null, acknowledgeRebuild: false }],
      ['POST', PATHS.retry, {}],
      ['POST', PATHS.inspect, {}],
    ];

    for (const [method, pathname, body] of cases) {
      const response = await request(serverInfo.baseUrl, method, pathname, body);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, 'not_found');
    }
    assert.deepEqual(manager.calls.map(({ op, ownerUserId, projectId }) => [op, ownerUserId, projectId]), [
      ['read', OTHER.id, 'project-1'],
      ['save', OTHER.id, 'project-1'],
      ['confirm', OTHER.id, 'project-1'],
      ['retry', OTHER.id, 'project-1'],
      ['inspect', OTHER.id, 'project-1'],
    ]);
  });

  it('rejects cross-origin composition writes while allowing the read', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager));
    const hostile = { Origin: 'https://elsewhere.example' };

    assert.equal((await request(serverInfo.baseUrl, 'GET', PATHS.read, undefined, hostile)).status, 200);
    assert.equal((await request(serverInfo.baseUrl, 'PUT', PATHS.save, { expectedCurrentRevision: null, runtimes: [] }, hostile)).status, 403);
    assert.equal((await request(serverInfo.baseUrl, 'POST', PATHS.confirm, { revision: 'revision-1', expectedRevision: null, acknowledgeRebuild: false }, hostile)).status, 403);
    assert.equal((await request(serverInfo.baseUrl, 'POST', PATHS.retry, {}, hostile)).status, 403);
    assert.equal((await request(serverInfo.baseUrl, 'POST', PATHS.inspect, {}, hostile)).status, 403);
    assert.deepEqual(manager.calls.map(({ op }) => op), ['read']);
  });

  it('returns the fixed catalog with the owner-scoped project and composition', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager));
    const response = await request(serverInfo.baseUrl, 'GET', PATHS.read);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(Object.keys(body).sort(), ['catalog', 'composition', 'project']);
    assert.equal(body.catalog.version, 'v1');
    assert.deepEqual(body.catalog.runtimes.map(({ id }) => id), ['node', 'python', 'php', 'go', 'rust', 'java', 'dotnet']);
    assert.deepEqual(body.catalog.agents.map(({ id }) => id), ['claude', 'codex', 'pi', 'grok', 'qwen', 'kimi', 'omp']);
    assert.deepEqual(body.composition, manager.responses.read.composition);
    assert.equal(body.project.id, 'project-1');
    assert.equal(body.project.targetName, 'Build cluster');
    assert.deepEqual(manager.calls, [{ op: 'read', ownerUserId: OWNER.id, projectId: 'project-1' }]);
  });

  it('validates and forwards saves, then maps manager failures without changing their meaning', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager));
    const invalidBodies = [
      { runtimes: [] },
      { expectedCurrentRevision: null, runtimes: 'node' },
      { expectedCurrentRevision: null, runtimes: [null] },
      { expectedCurrentRevision: null, runtimes: [{ runtimeId: 'node' }] },
      { expectedCurrentRevision: null, runtimes: [], forgeKind: 7 },
      { expectedCurrentRevision: null, runtimes: [], agents: 'codex' },
      { expectedCurrentRevision: null, runtimes: [], agents: [null] },
      { expectedCurrentRevision: null, runtimes: [], agents: [{ runtimeId: 'codex' }] },
    ];
    for (const body of invalidBodies) {
      assert.equal((await request(serverInfo.baseUrl, 'PUT', PATHS.save, body)).status, 400);
    }
    assert.deepEqual(manager.calls, []);

    const input = {
      expectedCurrentRevision: 'revision-1',
      runtimes: [{ runtimeId: 'node', version: '22.14.0' }],
      agents: [{ runtimeId: 'codex', version: '0.146.0' }],
      forgeKind: 'github',
    };
    const saved = await request(serverInfo.baseUrl, 'PUT', PATHS.save, input, { Origin: serverInfo.baseUrl });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { composition: manager.responses.save.composition });
    assert.deepEqual(manager.calls.at(-1), {
      op: 'save', ownerUserId: OWNER.id, projectId: 'project-1', input: {
        expectedRevision: 'revision-1',
        runtimes: input.runtimes,
        agents: input.agents,
        forgeKind: input.forgeKind,
      },
    });

    manager.responses.save = { ok: false, reason: 'conflict', detail: 'recipe changed' };
    let failed = await request(serverInfo.baseUrl, 'PUT', PATHS.save, input);
    assert.equal(failed.status, 409);
    assert.deepEqual(await failed.json(), { error: 'conflict', message: 'recipe changed' });

    manager.responses.save = { ok: false, reason: 'validation', detail: 'unsupported runtime' };
    failed = await request(serverInfo.baseUrl, 'PUT', PATHS.save, input);
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { error: 'validation', message: 'unsupported runtime' });

    manager.responses.save = { ok: false, reason: 'not_found' };
    failed = await request(serverInfo.baseUrl, 'PUT', PATHS.save, input);
    assert.equal(failed.status, 404);
    assert.equal((await failed.json()).error, 'not_found');
  });

  it('forwards confirmation and preserves run-limit and source-changed response shapes', async function () {
    const manager = makeManager();
    serverInfo = await listen(makeApp(manager));
    assert.equal((await request(serverInfo.baseUrl, 'POST', PATHS.confirm, {
      revision: 'revision-1', acknowledgeRebuild: false,
    })).status, 400);
    assert.deepEqual(manager.calls, []);

    const input = {
      revision: 'revision-1',
      expectedRevision: null,
      acknowledgeRebuild: false,
      stopProjectId: 'idle-project',
    };
    let response = await request(serverInfo.baseUrl, 'POST', PATHS.confirm, input);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { state: 'building' });
    assert.deepEqual(manager.calls.at(-1), {
      op: 'confirm', ownerUserId: OWNER.id, projectId: 'project-1', input,
    });

    const running = [{
      id: 'running-1', name: 'Idle project', state: 'running', lastActivityAt: NOW, hasActiveWork: false,
    }];
    manager.responses.confirm = { ok: false, reason: 'run_limit', running };
    response = await request(serverInfo.baseUrl, 'POST', PATHS.confirm, input);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'run_limit', running });

    const refreshed = composition({
      revision: 'revision-refreshed',
      detected: { ...composition().detected, sourceOid: 'b'.repeat(40) },
    });
    manager.responses.confirm = {
      ok: false,
      reason: 'source_changed',
      detail: 'Repository changed after inspection',
      composition: refreshed,
    };
    response = await request(serverInfo.baseUrl, 'POST', PATHS.confirm, input);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'source_changed',
      message: 'Repository changed after inspection',
      composition: refreshed,
    });
  });

  it('returns failed-item retry records and a fresh reinspection envelope', async function () {
    const manager = makeManager();
    const retried = [{
      itemId: 'node', status: 'installed', attempts: 2, installedVersion: '22.14.0',
      errorCode: null, errorMessage: null,
    }];
    manager.responses.retry = { ok: true, installations: retried };
    serverInfo = await listen(makeApp(manager));

    let response = await request(serverInfo.baseUrl, 'POST', PATHS.retry, {});
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { installations: retried });
    assert.deepEqual(manager.calls.at(-1), { op: 'retry', ownerUserId: OWNER.id, projectId: 'project-1' });

    manager.responses.retry = { ok: false, reason: 'invalid_state', detail: 'running project required' };
    response = await request(serverInfo.baseUrl, 'POST', PATHS.retry, {});
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'invalid_state', message: 'running project required' });

    const inspectedProject = project({ state: 'inspecting', stateDetail: 'Refreshing repository inspection' });
    const inspectedComposition = composition({ revision: 'revision-before-refresh' });
    manager.responses.inspect = { ok: true, project: inspectedProject, composition: inspectedComposition };
    response = await request(serverInfo.baseUrl, 'POST', PATHS.inspect, {});
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      project: { ...inspectedProject, targetName: 'Build cluster' },
      composition: inspectedComposition,
    });
    assert.deepEqual(manager.calls.at(-1), { op: 'inspect', ownerUserId: OWNER.id, projectId: 'project-1' });

    manager.responses.inspect = { ok: false, reason: 'not_found' };
    response = await request(serverInfo.baseUrl, 'POST', PATHS.inspect, {});
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not_found');
  });
});
