const assert = require('node:assert/strict');
const express = require('express');
const {
  AGENT_MAINTENANCE_CATALOG, AGENT_MAINTENANCE_IDS, agentCatalogEntry, agentSupported,
} = require('../dist/shared/agent-maintenance.js');
const { AgentMaintenanceService, agentMaintenanceExecutionKey } = require('../dist/server/services/agent-maintenance.js');
const { createAgentMaintenanceRoutes } = require('../dist/server/routes/agent-maintenance.js');

function target(overrides = {}) { return { key: 'srv:host:private:7', platform: 'linux', architecture: 'x64', scope: 'private', ownerUserId: 7, ...overrides }; }
function fixture(overrides = {}) {
  const operations = []; const checks = new Map(); const activated = [];
  const deps = {
    store: { loadOperations: () => operations, saveOperation: (op) => { const at = operations.findIndex((x) => x.id === op.id); if (at < 0) operations.push(op); else operations[at] = op; }, loadCheck: (key, id) => checks.get(`${key}:${id}`) || null, saveCheck: (check) => checks.set(`${check.targetKey}:${check.agentId}`, check) },
    probe: { locate: async () => ({ state: 'missing', version: null }), version: async () => '1.2.3' },
    releases: { latest: async () => ({ version: '1.2.3' }) },
    installer: { install: async () => {}, activate: async (input) => activated.push(input) },
    rootFor: (_target, agent, version) => `/safe/${agent.id}/${version}`,
    now: () => 1,
    ...overrides,
  };
  return { deps, operations, checks, activated };
}

describe('agent maintenance foundation', () => {
  it('has a fail-closed official catalog for all eight managed agents', () => {
    assert.equal(AGENT_MAINTENANCE_CATALOG.length, 8);
    assert.equal(AGENT_MAINTENANCE_IDS.includes('agent'), false);
    assert.equal(agentCatalogEntry('agent'), null);
    for (const entry of AGENT_MAINTENANCE_CATALOG) {
      assert.match(entry.officialSource, /^https:\/\//);
      assert.deepEqual(entry.versionArgs, ['--version']);
      assert.ok(entry.manualGuidance);
    }
    const antigravity = AGENT_MAINTENANCE_CATALOG.find((x) => x.id === 'antigravity');
    assert.equal(agentSupported(antigravity, 'linux', 'x64'), true);
    assert.equal(agentSupported(antigravity, 'win32', 'arm64'), true);
    const qwen = AGENT_MAINTENANCE_CATALOG.find((x) => x.id === 'qwen');
    assert.equal(agentSupported(qwen, 'win32', 'arm64'), true);
  });

  it('caches bounded checks and reports updates without startup work', async () => {
    let calls = 0; let now = 100;
    const { deps } = fixture({ now: () => now, probe: { locate: async () => ({ state: 'managed', version: '1.0.0' }), version: async () => '1.0.0' }, releases: { latest: async () => { calls++; return { version: '1.2.3' }; } } });
    const service = new AgentMaintenanceService(deps);
    assert.equal(calls, 0);
    assert.equal((await service.check(target(), 'claude')).state, 'update_available');
    now += 1; assert.equal((await service.check(target(), 'claude')).state, 'update_available');
    assert.equal(calls, 1);
  });

  it('does not offer a downgrade when the installed version is newer than the stable pointer', async () => {
    const { deps } = fixture({
      probe: { locate: async () => ({ state: 'managed', version: '2.1.221' }), version: async () => '2.1.221' },
      releases: { latest: async () => ({ version: '2.1.220' }) },
    });
    assert.equal((await new AgentMaintenanceService(deps).check(target(), 'claude', true)).state, 'current');
  });

  it('binds private targets to immutable container identities and fails closed without one', () => {
    const base = { kind: 'container', name: 'reused-name' };
    assert.notEqual(
      agentMaintenanceExecutionKey(7, { ...base, identity: 'container-a' }),
      agentMaintenanceExecutionKey(7, { ...base, identity: 'container-b' }),
    );
    assert.throws(() => agentMaintenanceExecutionKey(7, base), /immutable identity/);
  });

  it('reports the captured process version instead of a newly activated pointer', async () => {
    const { deps } = fixture({ probe: { locate: async () => ({ state: 'managed', version: '2.0.0', managedVersion: '2.0.0' }), version: async () => '2.0.0' } });
    const service = new AgentMaintenanceService(deps);
    const running = await service.status(target({ runningAgentId: 'claude', runningVersion: '1.0.0' }), 'claude', 7, 7);
    assert.equal(running.version, '1.0.0');
    assert.equal(running.managedVersion, '2.0.0');
    const unknown = await service.status(target({ runningAgentId: 'claude', runningVersion: null }), 'claude', 7, 7);
    assert.equal(unknown.version, null, 'an unverified process is not relabelled from the active pointer');
  });

  it('settles a hung official check through its abort deadline', async () => {
    const { deps } = fixture({ checkTimeoutMs: 1, releases: { latest: (_agent, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) } });
    const service = new AgentMaintenanceService(deps);
    assert.equal((await service.check(target(), 'claude', true)).state, 'unable_to_check');
  });

  it('refuses project-managed and unauthorized shared targets without touching installers', async () => {
    const { deps, activated } = fixture(); const service = new AgentMaintenanceService(deps);
    await assert.rejects(() => service.install(target({ projectManaged: true }), 'claude', 7, 7), /project/);
    await assert.rejects(() => service.install(target({ scope: 'shared', ownerUserId: null }), 'claude', 7, 8), /installer/);
    assert.deepEqual(activated, []);
  });

  it('does not contact a publisher for project-managed agents and marks shared changes for confirmation', async () => {
    let releaseCalls = 0;
    const { deps } = fixture({ releases: { latest: async () => { releaseCalls++; return { version: '1.2.3' }; } } });
    const service = new AgentMaintenanceService(deps);
    const project = target({ projectManaged: true, scope: 'shared', ownerUserId: null });
    assert.equal((await service.check(project, 'claude', true)).state, 'current');
    assert.equal(releaseCalls, 0);
    assert.equal((await service.status(project, 'claude', 7, 7)).state, 'project_managed');
    assert.equal((await service.status(target({ scope: 'shared', ownerUserId: null }), 'claude', 7, 7)).requiresConfirmation, true);
    assert.equal((await service.status(target(), 'claude', 7, 7)).requiresConfirmation, false);
  });

  it('coalesces operations, recovers interrupted records, and activates only verified copies', async () => {
    let install; const wait = new Promise((resolve) => { install = resolve; });
    const { deps, operations, activated } = fixture({ installer: { install: async () => wait, activate: async (input) => activated.push(input) } });
    const service = new AgentMaintenanceService(deps);
    const one = service.install(target(), 'claude', 7, 7); const two = service.install(target(), 'claude', 7, 7);
    install(); const [first, second] = await Promise.all([one, two]);
    assert.equal(first.id, second.id); assert.equal(first.phase, 'complete'); assert.equal(activated.length, 1);
    const recovered = new AgentMaintenanceService({ ...deps, store: { ...deps.store, loadOperations: () => [{ ...operations[0], phase: 'installing', canCancel: true }] } });
    assert.equal(recovered.operation(operations[0].id).phase, 'failed');
  });

  it('reports downloading until the installer begins local installation', async () => {
    const phases = [];
    const { deps } = fixture();
    const save = deps.store.saveOperation;
    deps.store.saveOperation = (operation) => { phases.push(operation.phase); save(operation); };
    deps.installer = {
      install: async (input) => {
        assert.equal(phases.at(-1), 'downloading');
        input.onInstalling();
        assert.equal(phases.at(-1), 'installing');
      },
      activate: async () => {},
    };
    const result = await new AgentMaintenanceService(deps).install(target(), 'claude', 7, 7);
    assert.equal(result.phase, 'complete');
    assert.ok(phases.indexOf('downloading') < phases.indexOf('installing'));
    assert.ok(phases.indexOf('installing') < phases.indexOf('verifying'));
  });

  it('keeps cancellation authoritative when an abort-insensitive publisher returns late', async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let installs = 0;
    const { deps, activated } = fixture({
      releases: { latest: async () => waiting },
      installer: { install: async () => { installs++; }, activate: async (input) => activated.push(input) },
    });
    const service = new AgentMaintenanceService(deps);
    const operation = service.start(target(), 'claude', 7, 7);
    assert.equal(service.cancel(operation.id).phase, 'cancelled');
    release({ version: '1.2.3' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.operation(operation.id).phase, 'cancelled');
    assert.equal(installs, 0);
    assert.deepEqual(activated, []);
  });

  it('keeps a cancelled worker single-flight until its abort-insensitive work settles', async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    let installs = 0;
    const { deps } = fixture({
      installer: {
        install: async () => { installs++; if (installs === 1) await pending; },
        activate: async () => {},
      },
    });
    const service = new AgentMaintenanceService(deps);
    const first = service.start(target(), 'claude', 7, 7);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.cancel(first.id).phase, 'cancelled');
    const whileSettling = service.start(target(), 'claude', 7, 7);
    assert.equal(whileSettling.id, first.id);
    assert.equal(installs, 1);

    finish();
    const settled = await service.install(target(), 'claude', 7, 7);
    assert.equal(settled.id, first.id);
    assert.equal(settled.phase, 'cancelled');
    const retry = await service.install(target(), 'claude', 7, 7);
    assert.notEqual(retry.id, first.id);
    assert.equal(retry.phase, 'complete');
    assert.equal(installs, 2);
  });

  it('keeps external installs read-only and rejects cross-origin mutations', async () => {
    const { deps } = fixture({ probe: { locate: async () => ({ state: 'external', version: '9.0.0' }), version: async () => null } });
    const service = new AgentMaintenanceService(deps);
    const status = await service.status(target(), 'claude', 7, 7);
    assert.equal(status.state, 'external'); assert.equal(status.canInstall, false); assert.equal(status.canManageCopy, true);
    const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.authContext = { user: { id: 7 }, authSessionId: 's' }; next(); });
    app.use(createAgentMaintenanceRoutes({ maintenance: service, getInstallerUserId: () => 7, resolveTarget: async () => target() }));
    const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const body = JSON.stringify({ targetId: 'bound-target' });
      const response = await fetch(`${base}/api/agent-maintenance/claude/install`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body });
      assert.equal(response.status, 403);
      const wrongScheme = await fetch(`${base}/api/agent-maintenance/claude/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: base.replace('http:', 'https:') },
        body,
      });
      assert.equal(wrongScheme.status, 403, 'matching hosts with a different scheme are cross-origin');
    }
    finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('requires shared-host confirmation and target-binds operation restore and cancellation', async () => {
    let finishInstall;
    const pending = new Promise((resolve) => { finishInstall = resolve; });
    const { deps } = fixture({ installer: { install: async () => pending, activate: async () => {} } });
    const service = new AgentMaintenanceService(deps);
    const shared = target({ key: 'host:shared', scope: 'shared', ownerUserId: null });
    const other = target({ key: 'other:private' });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.authContext = { user: { id: 7 }, authSessionId: 's' }; next(); });
    app.use(createAgentMaintenanceRoutes({
      maintenance: service,
      getInstallerUserId: () => 7,
      resolveTarget: async ({ targetId }) => targetId === 'shared' ? shared : targetId === 'other' ? other : null,
    }));
    const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { 'content-type': 'application/json' };
      const refused = await fetch(`${base}/api/agent-maintenance/claude/install`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'shared' }) });
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error, 'confirmation_required');

      const accepted = await fetch(`${base}/api/agent-maintenance/claude/install`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'shared', confirmed: true }) });
      assert.equal(accepted.status, 202);
      const operation = (await accepted.json()).operation;
      const hidden = await fetch(`${base}/api/agent-maintenance/operations/${operation.id}?targetId=other`);
      assert.equal(hidden.status, 404);
      const cannotCancel = await fetch(`${base}/api/agent-maintenance/operations/${operation.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ targetId: 'other' }) });
      assert.equal(cannotCancel.status, 404);
      const restored = await fetch(`${base}/api/agent-maintenance/operations/${operation.id}?targetId=shared`);
      assert.equal(restored.status, 200);
      finishInstall();
    } finally {
      finishInstall?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('never activates a copy whose version differs from the selected release', async () => {
    const { deps, activated } = fixture({ probe: { locate: async () => ({ state: 'missing', version: null }), version: async () => '1.2.4' } });
    const result = await new AgentMaintenanceService(deps).install(target(), 'claude', 7, 7);
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /not the selected official release/);
    assert.deepEqual(activated, []);
  });

  it('preserves version-probe failures instead of replacing them with Windows runtime guidance', async () => {
    const { deps } = fixture({
      probe: { locate: async () => ({ state: 'missing', version: null }), version: async () => { throw new Error('kimi executable could not load a required DLL'); } },
    });
    const result = await new AgentMaintenanceService(deps).install(target({ platform: 'win32' }), 'kimi', 7, 7);
    assert.match(result.error, /kimi executable could not load a required DLL/);
    assert.doesNotMatch(result.error, /Install Git for Windows/);
  });

  it('retains a failed staging tree when Windows PATH cleanup could not remove its reference', async () => {
    const discarded = [];
    const cleanupFailure = new Error('publisher failed\nThe temporary Windows user PATH entry could not be removed.');
    cleanupFailure.preserveStaging = true;
    const { deps } = fixture({
      installer: {
        install: async () => { throw cleanupFailure; },
        activate: async () => {},
        discard: async (input) => { discarded.push(input.stagingRoot); },
      },
    });
    const result = await new AgentMaintenanceService(deps).install(target({ platform: 'win32' }), 'codex', 7, 7);
    assert.equal(result.phase, 'failed');
    assert.match(result.error, /PATH entry could not be removed/);
    assert.deepEqual(discarded, []);
  });

  it('shows prerequisite guidance only for the affected target platform', async () => {
    const missingVersion = () => fixture({
      probe: { locate: async () => ({ state: 'missing', version: null }), version: async () => null },
    }).deps;
    const linux = await new AgentMaintenanceService(missingVersion()).install(target(), 'pi', 7, 7);
    assert.match(linux.error, /did not provide a normalized version/);
    assert.doesNotMatch(linux.error, /Windows|Bash/);
    const windows = await new AgentMaintenanceService(missingVersion()).install(
      target({ platform: 'win32' }),
      'pi',
      7,
      7,
    );
    assert.match(windows.error, /Managed installation includes Node.js; Git Bash is needed when Pi runs shell tools/);
  });
});
