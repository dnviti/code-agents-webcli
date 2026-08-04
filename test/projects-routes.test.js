const assert = require('assert');
const { EventEmitter } = require('events');
const express = require('express');

const { createProjectRoutes } = require('../dist/server/routes/projects.js');
const { createDeployTargetRoutes } = require('../dist/server/routes/deploy-targets.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { DeployTargetStore } = require('../dist/server/services/deploy-targets.js');

const OWNER = { id: 1, githubLogin: 'owner' };
const OTHER = { id: 2, githubLogin: 'other' };
const INSTALLER = { id: 1, githubLogin: 'installer' };

function buildProject(overrides = {}) {
  return {
    id: 'project-1',
    ownerUserId: OWNER.id,
    name: 'acme',
    repoUrl: 'https://github.com/example/acme.git',
    repoHost: 'github.com',
    targetId: null,
    tierId: null,
    state: 'stopped',
    stateDetail: null,
    container: null,
    buildLog: [],
    lastActivityAt: new Date().toISOString(),
    lastPreservedCommit: null,
    compositionRevision: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeManager(overrides = {}) {
  const events = new EventEmitter();
  const projects = overrides.projects ?? [buildProject()];
  const find = (ownerUserId, projectId) => projects.find(
    (proj) => proj.id === projectId && proj.ownerUserId === ownerUserId,
  );

  return {
    events,
    createAndStart: overrides.createAndStart ?? (async () => ({ ok: true, project: buildProject(), state: 'building' })),
    start: overrides.start ?? (async (ownerUserId, projectId) => {
      return find(ownerUserId, projectId) ? { ok: true, state: 'building' } : { ok: false, reason: 'not_found' };
    }),
    stop: overrides.stop ?? (async (ownerUserId, projectId) => {
      return find(ownerUserId, projectId) ? { ok: true } : { ok: false, reason: 'not_found' };
    }),
    retry: overrides.retry ?? (async (ownerUserId, projectId) => {
      return find(ownerUserId, projectId) ? { ok: true, state: 'building' } : { ok: false, reason: 'not_found' };
    }),
    update: overrides.update ?? (async (ownerUserId, projectId, input) => {
      const project = find(ownerUserId, projectId);
      return project ? { ok: true, project: { ...project, ...input } } : { ok: false, reason: 'not_found' };
    }),
    remove: overrides.remove ?? (async (ownerUserId, projectId) => {
      return find(ownerUserId, projectId) ? { ok: true } : { ok: false, reason: 'not_found' };
    }),
    release: overrides.release ?? (async (ownerUserId, projectId) => {
      return find(ownerUserId, projectId) ? { ok: true } : { ok: false, reason: 'not_found' };
    }),
    listForUser: overrides.listForUser ?? (() => projects.map((p) => ({ ...p, hasActiveWork: false }))),
    getForUser: overrides.getForUser ?? ((ownerUserId, projectId) => {
      const p = find(ownerUserId, projectId);
      return p ? { ...p } : null;
    }),
    ensureForSession: overrides.ensureForSession ?? (async () => ({ ok: false, reason: 'not_found' })),
    reconcileOnBoot: overrides.reconcileOnBoot ?? (async () => {}),
    startSweep: overrides.startSweep ?? (() => {}),
    stopSweep: overrides.stopSweep ?? (() => {}),
  };
}

function makeApp(deps, currentUser = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: currentUser, authSessionId: null };
    next();
  });
  app.use(createProjectRoutes(deps));
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

describe('project routes', function () {
  let serverInfo;

  afterEach(async function () {
    if (serverInfo) {
      serverInfo.server.closeAllConnections?.();
      await serverInfo.close();
      serverInfo = null;
    }
  });

  it('answers 401 to an unauthenticated caller on every route', async function () {
    const app = makeApp({ manager: makeManager() }, null);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    assert.strictEqual((await req(baseUrl, 'GET', '/api/projects')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects', { name: 'x' })).status, 401);
    assert.strictEqual((await req(baseUrl, 'GET', '/api/projects/project-1')).status, 401);
    assert.strictEqual((await req(baseUrl, 'PUT', '/api/projects/project-1', { name: 'x' })).status, 401);
    assert.strictEqual((await req(baseUrl, 'DELETE', '/api/projects/project-1')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/start')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/stop')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/retry')).status, 401);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/release')).status, 401);
    assert.strictEqual((await req(baseUrl, 'GET', '/api/projects/project-1/build')).status, 401);
  });

  it('scopes all project access to the owner (404 shape)', async function () {
    const app = makeApp({ manager: makeManager() }, OTHER);
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const get = await req(baseUrl, 'GET', '/api/projects/project-1');
    assert.strictEqual(get.status, 404);
    assert.strictEqual((await get.json()).error, 'not_found');

    assert.strictEqual((await req(baseUrl, 'DELETE', '/api/projects/project-1')).status, 404);
    assert.strictEqual((await req(baseUrl, 'PUT', '/api/projects/project-1', { name: 'x' })).status, 404);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/start')).status, 404);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/stop')).status, 404);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/retry')).status, 404);
    assert.strictEqual((await req(baseUrl, 'POST', '/api/projects/project-1/release')).status, 404);
    assert.strictEqual((await req(baseUrl, 'GET', '/api/projects/project-1/build')).status, 404);
  });

  it('rejects a cross-origin write but not a cross-origin read', async function () {
    const app = makeApp({ manager: makeManager() });
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const create = await req(baseUrl, 'POST', '/api/projects', { name: 'x' }, { Origin: 'https://evil.example.com' });
    assert.strictEqual(create.status, 403);
    assert.strictEqual((await create.json()).error, 'cross_origin');

    const start = await req(baseUrl, 'POST', '/api/projects/project-1/start', {}, { Origin: 'https://evil.example.com' });
    assert.strictEqual(start.status, 403);
    assert.strictEqual((await req(baseUrl, 'PUT', '/api/projects/project-1', { name: 'x' }, { Origin: 'https://evil.example.com' })).status, 403);

    const read = await req(baseUrl, 'GET', '/api/projects', undefined, { Origin: 'https://evil.example.com' });
    assert.strictEqual(read.status, 200);
  });

  it('lists projects for the signed-in user', async function () {
    const app = makeApp({
      manager: makeManager(),
      targetNameFor: () => 'Build cluster',
      projectAvailability: () => ({ available: true }),
    });
    serverInfo = await listen(app);
    const body = await (await req(serverInfo.baseUrl, 'GET', '/api/projects')).json();
    assert.strictEqual(body.projects.length, 1);
    assert.strictEqual(body.projects[0].id, 'project-1');
    assert.strictEqual(body.projects[0].hasActiveWork, false);
    assert.strictEqual(body.projects[0].targetName, 'Build cluster');
    assert.deepStrictEqual(body.availability, { available: true });
  });

  it('preserves a target name already supplied by the manager', async function () {
    const manager = makeManager({
      listForUser: () => [{ ...buildProject(), hasActiveWork: false, targetName: 'Recorded cluster' }],
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const body = await (await req(serverInfo.baseUrl, 'GET', '/api/projects')).json();
    assert.strictEqual(body.projects[0].targetName, 'Recorded cluster');
  });

  it('creates a project and starts building (202)', async function () {
    const app = makeApp({ manager: makeManager() });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'acme', repoUrl: 'https://github.com/example/acme.git' });
    assert.strictEqual(res.status, 202);
    const body = await res.json();
    assert.strictEqual(body.project.name, 'acme');
  });

  it('forwards an explicit local-project override without exposing target selection', async function () {
    let createInput;
    const manager = makeManager({
      createAndStart: async (_ownerUserId, input) => {
        createInput = input;
        return { ok: true, project: buildProject({ executionKind: 'host' }), state: 'building' };
      },
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects', {
      name: 'local acme',
      repoUrl: null,
      local: true,
    });
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(createInput, { name: 'local acme', repoUrl: null, local: true });
    assert.strictEqual((await res.json()).project.executionKind, 'host');
  });

  it('validates create input', async function () {
    const app = makeApp({ manager: makeManager() });
    serverInfo = await listen(app);

    const noName = await req(serverInfo.baseUrl, 'POST', '/api/projects', {});
    assert.strictEqual(noName.status, 400);
    assert.strictEqual((await noName.json()).error, 'validation');

    const badRepo = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x', repoUrl: 123 });
    assert.strictEqual(badRepo.status, 400);
    assert.strictEqual((await badRepo.json()).error, 'validation');

    const badLocal = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x', local: 'yes' });
    assert.strictEqual(badLocal.status, 400);
    assert.strictEqual((await badLocal.json()).error, 'validation');
  });

  it('maps credential_required to 428 with host', async function () {
    const manager = makeManager({
      createAndStart: async () => ({ ok: false, reason: 'credential_required', host: 'github.com' }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x' });
    assert.strictEqual(res.status, 428);
    const body = await res.json();
    assert.strictEqual(body.error, 'credential_required');
    assert.strictEqual(body.host, 'github.com');
  });

  it('maps run_limit to 409 with running list', async function () {
    const running = [{ id: 'p2', name: 'other', lastActivityAt: new Date().toISOString(), hasActiveWork: true }];
    const manager = makeManager({
      createAndStart: async () => ({ ok: false, reason: 'run_limit', project: buildProject(), running }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x' });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'run_limit');
    assert.strictEqual(body.project.id, 'project-1');
    assert.deepStrictEqual(body.running, running);
  });

  it('maps manager validation/repo_unreachable to 400', async function () {
    const manager = makeManager({
      createAndStart: async () => ({ ok: false, reason: 'repo_unreachable', message: 'repo gone' }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x' });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'repo_unreachable');
    assert.strictEqual(body.message, 'repo gone');
  });

  it('reports an unavailable placement without touching a project', async function () {
    const manager = makeManager({
      projects: [],
      createAndStart: async () => ({ ok: false, reason: 'no_target', message: 'Activate a deploy target.' }),
    });
    const app = makeApp({
      manager,
      projectAvailability: () => ({ available: false, message: 'Activate a deploy target.' }),
    });
    serverInfo = await listen(app);

    const listed = await (await req(serverInfo.baseUrl, 'GET', '/api/projects')).json();
    assert.deepStrictEqual(listed.availability, { available: false, message: 'Activate a deploy target.' });
    const created = await req(serverInfo.baseUrl, 'POST', '/api/projects', { name: 'x' });
    assert.strictEqual(created.status, 409);
    assert.strictEqual((await created.json()).error, 'no_target');
  });

  it('gets a project by id', async function () {
    const app = makeApp({ manager: makeManager() });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'GET', '/api/projects/project-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).project.id, 'project-1');
  });

  it('updates an unavailable repository and retries its build', async function () {
    let updateInput;
    const manager = makeManager({
      update: async (_ownerUserId, _projectId, input) => {
        updateInput = input;
        return { ok: true, project: buildProject({ repoUrl: input.repoUrl, state: 'stopped' }) };
      },
      retry: async () => ({ ok: true, state: 'building' }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const updated = await req(serverInfo.baseUrl, 'PUT', '/api/projects/project-1', {
      repoUrl: 'https://git.example.test/acme.git',
    });
    assert.strictEqual(updated.status, 200);
    assert.deepStrictEqual(updateInput, { repoUrl: 'https://git.example.test/acme.git' });
    assert.strictEqual((await updated.json()).project.state, 'stopped');

    const retried = await req(serverInfo.baseUrl, 'POST', '/api/projects/project-1/retry');
    assert.strictEqual(retried.status, 202);
    assert.strictEqual((await retried.json()).state, 'building');
  });

  it('maps repository update credential, preservation and validation failures', async function () {
    const cases = [
      [{ ok: false, reason: 'credential_required', host: 'git.example.test' }, 428],
      [{ ok: false, reason: 'preserve_failed', detail: 'push denied' }, 409],
      [{ ok: false, reason: 'invalid_state', detail: 'stop first' }, 409],
      [{ ok: false, reason: 'validation', message: 'bad URL' }, 400],
    ];
    for (const [result, status] of cases) {
      const app = makeApp({ manager: makeManager({ update: async () => result }) });
      serverInfo = await listen(app);
      const response = await req(serverInfo.baseUrl, 'PUT', '/api/projects/project-1', { repoUrl: 'x' });
      assert.strictEqual(response.status, status);
      serverInfo.server.closeAllConnections?.();
      await serverInfo.close();
      serverInfo = null;
    }
  });

  it('starts, stops and releases a project', async function () {
    let stopOptions;
    const app = makeApp({ manager: makeManager({
      stop: async (_ownerUserId, _projectId, options) => { stopOptions = options; return { ok: true }; },
    }) });
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const start = await req(baseUrl, 'POST', '/api/projects/project-1/start', { stopProjectId: 'p2' });
    assert.strictEqual(start.status, 202);
    assert.strictEqual((await start.json()).state, 'building');

    const stop = await req(baseUrl, 'POST', '/api/projects/project-1/stop', { stopActive: true });
    assert.strictEqual(stop.status, 202);
    assert.deepStrictEqual(stopOptions, { stopActive: true });

    const release = await req(baseUrl, 'POST', '/api/projects/project-1/release', { discard: true });
    assert.strictEqual(release.status, 202);
  });

  it('passes confirmed active-session interruption through project deletion', async function () {
    let removeOptions;
    const manager = makeManager({
      remove: async (_ownerUserId, _projectId, options) => { removeOptions = options; return { ok: true }; },
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const response = await req(serverInfo.baseUrl, 'DELETE', '/api/projects/project-1', {
      force: true,
      stopActive: true,
    });
    assert.strictEqual(response.status, 204);
    assert.deepStrictEqual(removeOptions, { force: true, stopActive: true });
  });

  it('maps start run_limit to 409', async function () {
    const running = [{ id: 'p2', name: 'other', lastActivityAt: new Date().toISOString(), hasActiveWork: false }];
    const manager = makeManager({ start: async () => ({ ok: false, reason: 'run_limit', running }) });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects/project-1/start');
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual((await res.json()).running, running);
  });

  it('maps start blocked to 409 with detail', async function () {
    const manager = makeManager({ start: async () => ({ ok: false, reason: 'blocked', detail: 'disk full' }) });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects/project-1/start');
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'blocked');
    assert.strictEqual(body.detail, 'disk full');
  });

  it('maps invalid_state to 400', async function () {
    const manager = makeManager({ start: async () => ({ ok: false, reason: 'invalid_state' }) });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'POST', '/api/projects/project-1/start');
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'invalid_state');
  });

  it('deletes a project (204)', async function () {
    const app = makeApp({ manager: makeManager() });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'DELETE', '/api/projects/project-1', { force: true });
    assert.strictEqual(res.status, 204);
  });

  it('maps delete preserve_failed to 409 with detail', async function () {
    const manager = makeManager({ remove: async () => ({ ok: false, reason: 'preserve_failed', detail: 'push rejected' }) });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'DELETE', '/api/projects/project-1');
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'preserve_failed');
    assert.strictEqual(body.detail, 'push rejected');
  });

  it('replays the build log then live events over SSE', async function () {
    const buildLog = [
      { t: 'step', step: 'clone', at: new Date().toISOString() },
    ];
    const manager = makeManager({
      getForUser: (ownerUserId, projectId) => {
        if (ownerUserId !== OWNER.id || projectId !== 'project-1') return null;
        return buildProject({ buildLog, state: 'building' });
      },
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const decoder = new TextDecoder();
    const readPromise = (async () => {
      const res = await fetch(`${baseUrl}/api/projects/project-1/build`);
      assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      return chunks.join('');
    })();

    await new Promise((r) => setTimeout(r, 20));
    manager.events.emit('build', {
      projectId: 'project-1',
      event: { t: 'state', state: 'running', at: new Date().toISOString() },
    });

    const text = await readPromise;
    const lines = text.split('\n');
    const dataLines = lines.filter((line) => line.startsWith('data:'));
    assert.strictEqual(dataLines.length, 2, `expected 2 data frames, got: ${text}`);
    assert.ok(dataLines[0].includes('clone'), 'first frame replays build log');
    assert.ok(dataLines.some((line) => line.includes('"state":"running"')), 'live running event delivered');
  });

  it('buffers a live event emitted during replay without losing its order', async function () {
    const manager = makeManager();
    const replay = { t: 'step', step: 'clone', at: new Date().toISOString() };
    const live = { t: 'state', state: 'running', at: new Date().toISOString() };
    const buildLog = {
      [Symbol.iterator]: function* () {
        yield replay;
        manager.events.emit('build', { projectId: 'project-1', event: live });
      },
    };
    manager.getForUser = (ownerUserId, projectId) => (
      ownerUserId === OWNER.id && projectId === 'project-1'
        ? buildProject({ buildLog, state: 'building' })
        : null
    );

    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const text = await (await fetch(`${serverInfo.baseUrl}/api/projects/project-1/build`)).text();
    const data = text.split('\n').filter((line) => line.startsWith('data:'));
    assert.strictEqual(data.length, 2, text);
    assert.ok(data[0].includes('clone'), 'persisted replay stays first');
    assert.ok(data[1].includes('"state":"running"'), 'event emitted during replay follows it');
  });

  it('refreshes the replay snapshot after subscribing to close the lookup gap', async function () {
    const terminal = { t: 'state', state: 'running', at: new Date().toISOString() };
    let reads = 0;
    const manager = makeManager({
      getForUser: () => {
        reads += 1;
        if (reads === 1) return buildProject({ state: 'building', buildLog: [] });
        // Store append precedes event emission in the real manager, so the
        // refreshed snapshot and live queue can both contain this event.
        manager.events.emit('build', { projectId: 'project-1', event: terminal });
        return buildProject({ state: 'running', buildLog: [terminal] });
      },
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const text = await (await fetch(`${serverInfo.baseUrl}/api/projects/project-1/build`)).text();
    assert.strictEqual(reads, 2);
    assert.ok(text.includes('"state":"running"'));
    assert.strictEqual(text.split('\n').filter((line) => line.startsWith('data:')).length, 1);
    assert.strictEqual(manager.events.listenerCount('build'), 0);
  });

  it('closes and cleans up after replaying an already-terminal build', async function () {
    const terminal = { t: 'state', state: 'failed', message: 'clone failed', at: new Date().toISOString() };
    const manager = makeManager({
      getForUser: () => buildProject({ state: 'failed', buildLog: [terminal] }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const res = await fetch(`${serverInfo.baseUrl}/api/projects/project-1/build`);
    const text = await res.text();
    assert.ok(text.includes('"state":"failed"'));
    assert.strictEqual(manager.events.listenerCount('build'), 0);
  });

  it('closes when the terminal row has only an older building frame', async function () {
    const oldBuilding = {
      t: 'state', state: 'building', message: 'queued', at: new Date().toISOString(),
    };
    const manager = makeManager({
      getForUser: () => buildProject({ state: 'failed', buildLog: [oldBuilding] }),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);

    const response = await fetch(`${serverInfo.baseUrl}/api/projects/project-1/build`);
    const text = await response.text();
    assert.ok(text.includes('"state":"building"'));
    assert.strictEqual(manager.events.listenerCount('build'), 0);
  });

  it('filters SSE events to the requested project', async function () {
    const manager = makeManager({
      getForUser: (ownerUserId, projectId) => (
        ownerUserId === OWNER.id && projectId === 'project-1'
          ? buildProject({ state: 'building' })
          : null
      ),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const decoder = new TextDecoder();
    const readPromise = (async () => {
      const res = await fetch(`${baseUrl}/api/projects/project-1/build`);
      const reader = res.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      return chunks.join('');
    })();

    await new Promise((r) => setTimeout(r, 20));
    manager.events.emit('build', { projectId: 'project-2', event: { t: 'state', state: 'stopped', at: new Date().toISOString() } });
    manager.events.emit('build', { projectId: 'project-1', event: { t: 'state', state: 'stopped', at: new Date().toISOString() } });

    const text = await readPromise;
    assert.ok(!text.includes('"projectId":"project-2"'));
    assert.ok(text.includes('"state":"stopped"'));
  });

  it('cleans up when the SSE request is aborted', async function () {
    const manager = makeManager({
      getForUser: (ownerUserId, projectId) => (
        ownerUserId === OWNER.id && projectId === 'project-1'
          ? buildProject({ state: 'building' })
          : null
      ),
    });
    const app = makeApp({ manager });
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/projects/project-1/build`, { signal: controller.signal });
    assert.strictEqual(manager.events.listenerCount('build'), 1, 'one build listener should be attached');
    controller.abort();
    // Give the abort event time to fire.
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(manager.events.listenerCount('build'), 0, 'build listener removed on close');
    assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
  });
});

describe('admin deploy-settings routes', function () {
  let database;
  let store;
  let dataDir;
  let keyRing;
  let settings;
  let serverInfo;

  function deployTargetDeps(overrides = {}) {
    return {
      deployTargets: store,
      deployTargetDataDir: dataDir,
      createDeployEngine: () => ({ kind: 'docker', binary: 'docker', available: async () => true }),
      enginesForDeployTargets: () => new Map(),
      legacyContainersEnabled: false,
      reloadDeployTargets: () => {},
      projectIdsForTarget: () => [],
      getInstallerUserId: () => INSTALLER.id,
      getDeploySetting: (key) => settings[key] ?? null,
      setDeploySetting: (key, value) => { settings[key] = value; },
      ...overrides,
    };
  }

  function makeApp(deps, currentUser = INSTALLER) {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(createDeployTargetRoutes(deps));
    return app;
  }

  beforeEach(async function () {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-deploy-settings-'));
    database = new AppDatabase({ dataDir });
    keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 9).toString('base64'), warn: () => {} });
    store = new DeployTargetStore({ database, keyRing, dataDir });
    settings = {};
  });

  afterEach(async function () {
    if (serverInfo) {
      serverInfo.server.closeAllConnections?.();
      await serverInfo.close();
      serverInfo = null;
    }
    const fs = require('fs');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers 403 to a non-installer and 401 to an unauthenticated caller', async function () {
    const app = makeApp(deployTargetDeps(), OTHER);
    serverInfo = await listen(app);
    assert.strictEqual((await req(serverInfo.baseUrl, 'GET', '/api/admin/deploy-settings')).status, 403);
    assert.strictEqual((await req(serverInfo.baseUrl, 'PUT', '/api/admin/deploy-settings', {})).status, 403);

    const app2 = makeApp(deployTargetDeps(), null);
    serverInfo.server.closeAllConnections?.();
    await serverInfo.close();
    serverInfo = await listen(app2);
    assert.strictEqual((await req(serverInfo.baseUrl, 'GET', '/api/admin/deploy-settings')).status, 401);
  });

  it('rejects a cross-origin deploy-settings write', async function () {
    const app = makeApp(deployTargetDeps());
    serverInfo = await listen(app);
    const res = await req(serverInfo.baseUrl, 'PUT', '/api/admin/deploy-settings', { runLimitPerUser: 5 }, { Origin: 'https://evil.example.com' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, 'cross_origin');
  });

  it('returns defaults and accepts a round-trip', async function () {
    const app = makeApp(deployTargetDeps());
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    const get = await req(baseUrl, 'GET', '/api/admin/deploy-settings');
    assert.strictEqual(get.status, 200);
    const defaults = await get.json();
    assert.strictEqual(defaults.runLimitPerUser, 3);
    assert.strictEqual(defaults.idleStopMinutes, 60);
    assert.strictEqual(defaults.idleReclaimMinutes, 10080);

    const put = await req(baseUrl, 'PUT', '/api/admin/deploy-settings', {
      runLimitPerUser: 5,
      idleStopMinutes: 30,
      idleReclaimMinutes: 1440,
    });
    assert.strictEqual(put.status, 200);
    const updated = await put.json();
    assert.deepStrictEqual(updated, {
      runLimitPerUser: 5,
      idleStopMinutes: 30,
      idleReclaimMinutes: 1440,
      usageWarnUserBytes: null,
      usageWarnAdminBytes: null,
    });

    const get2 = await req(baseUrl, 'GET', '/api/admin/deploy-settings');
    assert.deepStrictEqual(await get2.json(), updated);
  });

  it('rejects non-positive or non-numeric settings', async function () {
    const app = makeApp(deployTargetDeps());
    serverInfo = await listen(app);
    const { baseUrl } = serverInfo;

    for (const body of [
      { runLimitPerUser: 0, idleStopMinutes: 1, idleReclaimMinutes: 1 },
      { runLimitPerUser: -1, idleStopMinutes: 1, idleReclaimMinutes: 1 },
      { runLimitPerUser: 1.5, idleStopMinutes: 1, idleReclaimMinutes: 1 },
      { runLimitPerUser: 'x', idleStopMinutes: 1, idleReclaimMinutes: 1 },
      { runLimitPerUser: 1, idleStopMinutes: null, idleReclaimMinutes: 1 },
    ]) {
      const res = await req(baseUrl, 'PUT', '/api/admin/deploy-settings', body);
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.strictEqual((await res.json()).error, 'invalid_settings');
    }
  });

  it('requires reclaim to be later than stop and changes nothing on rejection', async function () {
    settings = {
      'deploy.runLimitPerUser': '5',
      'deploy.idleStopMinutes': '30',
      'deploy.idleReclaimMinutes': '1440',
    };
    const app = makeApp(deployTargetDeps());
    serverInfo = await listen(app);

    for (const idleReclaimMinutes of [29, 30]) {
      const res = await req(serverInfo.baseUrl, 'PUT', '/api/admin/deploy-settings', {
        runLimitPerUser: 9,
        idleStopMinutes: 30,
        idleReclaimMinutes,
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, 'invalid_settings');
      assert.deepStrictEqual(settings, {
        'deploy.runLimitPerUser': '5',
        'deploy.idleStopMinutes': '30',
        'deploy.idleReclaimMinutes': '1440',
      });
    }
  });
});
