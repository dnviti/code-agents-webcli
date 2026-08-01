const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { EnvironmentManager, createContainerConfig } = require('../dist/server/services/environments/index.js');
const { ProjectManager } = require('../dist/server/services/projects/manager.js');
const { checkRepositoryAccess, cloneRepository } = require('../dist/server/services/projects/clone.js');
const { preserveProjectWork } = require('../dist/server/services/projects/preserve.js');
const { ProjectStore } = require('../dist/server/services/projects/store.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { DeployTargetStore } = require('../dist/server/services/deploy-targets.js');

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-project-')); }
function engine(overrides = {}) {
  const calls = [];
  const known = new Map();
  const customEnsure = overrides.ensure;
  const customDescribe = overrides.describe;
  const result = {
    kind: 'docker', binary: 'docker', calls,
    async ensure() { throw new Error('ensure wrapper was not installed'); },
    async create() {}, async start(name) { const item = known.get(name); if (item) item.status = 'running'; }, async stop(name) { calls.push({ op: 'stop', name }); const item = known.get(name); if (item) item.status = 'stopped'; },
    async remove(name) { calls.push({ op: 'remove', name }); known.delete(name); }, async status(name) { return known.get(name)?.status || null; },
    async describe() { return null; },
    async exec(spec, command, args) { calls.push({ op: 'exec', spec, command, args }); return { stdout: '', stderr: '' }; },
    execArgs: () => [], async list() { return []; }, async available() { return true; },
    async resize() { return true; }, async usage() { return null; }, ...overrides,
  };
  result.ensure = async (spec) => {
    calls.push({ op: 'ensure', spec });
    const existed = known.has(spec.name);
    const ensured = customEnsure ? await customEnsure.call(result, spec) : { created: !existed };
    known.set(spec.name, { name: spec.name, identity: `${spec.name}-identity`, status: 'running', image: spec.image, labels: spec.labels });
    return ensured;
  };
  result.describe = async (name) => known.get(name) || (customDescribe ? customDescribe.call(result, name) : null);
  result.ensureIdentity = async (spec, expected) => {
    const ensured = await result.ensure(spec, expected);
    const described = await result.describe(spec.name);
    if (!described?.identity) throw new Error('test engine did not expose an ensured identity');
    return { ...ensured, identity: described.identity };
  };
  result.stopIdentity = async (description) => result.stop(description.name);
  result.removeIdentity = async (description) => result.remove(description.name);
  return result;
}
function config(dir) { return { ...createContainerConfig({ containers: true }, {}), rootDir: dir, extraMounts: [] }; }
function store(projects = [], limit = 3) {
  let n = projects.length;
  let leaseSequence = 0;
  const leases = new Map();
  const all = projects;
  const get = (id) => all.find((p) => p.id === id) || null;
  const update = (id, patch) => Object.assign(get(id), patch, { updatedAt: new Date().toISOString() });
  return {
    all, runLimitPerUser: () => limit, idleStopMinutes: () => 1, idleReclaimMinutes: () => 1,
    createProject(input) { const now = new Date().toISOString(); const p = { id: `p${++n}`, ...input, state: 'stopped', stateDetail: null, container: null, rebuildRequired: false, buildLog: [], lastActivityAt: now, lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now }; all.push(p); return p; },
    getProject: get, getProjectForUser(id, user) { const p = get(id); return p && p.ownerUserId === user ? p : null; },
    listProjectsForUser(user) { return all.filter((p) => p.ownerUserId === user); },
    listProjectsInState(...states) { return all.filter((p) => states.includes(p.state)); },
    listProjectsWithContainers() { return all.filter((p) => p.container); },
    setState(id, state, detail = null) { update(id, { state, stateDetail: detail }); },
    updateProject(id, patch) { update(id, patch); },
    setContainer(id, container) { update(id, { container }); }, setRebuildRequired(id, rebuildRequired) { update(id, { rebuildRequired }); }, touchActivity(id, when = new Date()) { update(id, { lastActivityAt: when.toISOString() }); },
    recordPreservation(id, branch, commit) { update(id, { lastPreservedBranch: branch, lastPreservedCommit: commit }); }, deleteProject(id) { all.splice(all.indexOf(get(id)), 1); },
    projectHasActiveSessions(projectId) { return [...leases.values()].some((lease) => lease.projectId === projectId); }, credentialFor() { return null; },
    tryAcquireSessionLease(projectId, ownerUserId) {
      const p = this.getProjectForUser(projectId, ownerUserId);
      if (!p) return { ok: false, reason: 'not_found' };
      if (p.state !== 'running') return { ok: false, reason: 'invalid_state' };
      const leaseId = `lease-${++leaseSequence}`; leases.set(leaseId, { projectId, ownerUserId });
      return { ok: true, leaseId };
    },
    releaseSessionLease(projectId, ownerUserId, leaseId) {
      const lease = leases.get(leaseId);
      if (!lease || lease.projectId !== projectId || lease.ownerUserId !== ownerUserId) return false;
      leases.delete(leaseId); return true;
    },
    clearSessionLeases() { const count = leases.size; leases.clear(); return count; },
    resetBuildLog(id) { get(id).buildLog = []; },
    tryClaimStop({ projectId, ownerUserId, idleBefore }) {
      const p = this.getProjectForUser(projectId, ownerUserId);
      if (!p) return { ok: false, reason: 'not_found' };
      if (p.state !== 'running') return { ok: false, reason: 'invalid_state' };
      if (idleBefore && p.lastActivityAt > idleBefore.toISOString()) return { ok: false, reason: 'not_idle' };
      if (this.projectHasActiveSessions(projectId)) return { ok: false, reason: 'active_work' };
      const snapshot = { ...p }; p.state = 'reclaiming'; return { ok: true, project: snapshot };
    },
    tryClaimIdleReclaim({ projectId, ownerUserId, idleBefore }) {
      const p = this.getProjectForUser(projectId, ownerUserId);
      if (!p) return { ok: false, reason: 'not_found' };
      if (p.state !== 'stopped') return { ok: false, reason: 'invalid_state' };
      if (p.lastActivityAt > idleBefore.toISOString()) return { ok: false, reason: 'not_idle' };
      if (this.projectHasActiveSessions(projectId)) return { ok: false, reason: 'active_work' };
      const snapshot = { ...p }; p.state = 'reclaiming'; p.rebuildRequired = true; return { ok: true, project: snapshot };
    },
    appendBuildEvent(id, event) { get(id).buildLog.push(event); },
    tryStartCounted({ projectId, ownerUserId, toState, fromStates, limit: max, stopProjectId }) {
      const p = this.getProjectForUser(projectId, ownerUserId); if (!p) return { ok: false, reason: 'not_found' };
      if (!fromStates.includes(p.state)) return { ok: false, reason: 'invalid_state' };
      if (stopProjectId) {
        const s = this.getProjectForUser(stopProjectId, ownerUserId);
        if (!s || s.state !== 'running') return { ok: false, reason: 'stop_candidate_invalid' };
        if (this.projectHasActiveSessions(stopProjectId)) return { ok: false, reason: 'stop_candidate_busy' };
        s.state = 'stopped';
      }
      const running = all.filter((x) => x.ownerUserId === ownerUserId && ['building', 'running', 'reclaiming'].includes(x.state));
      if (running.length >= max) return { ok: false, reason: 'run_limit', running: running.map((x) => ({ id: x.id, name: x.name, state: x.state, lastActivityAt: x.lastActivityAt, hasActiveWork: this.projectHasActiveSessions(x.id) })) };
      p.state = toState; return { ok: true };
    },
  };
}
function setup(initial = [], options = {}) {
  const dir = root(); const e = engine(options.engine);
  const cfg = config(dir); const environments = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir, engines: new Map([['legacy', e]]), configs: new Map([['legacy', cfg]]), activeKey: 'legacy' });
  const s = store(initial, options.limit);
  if (options.credentialFor) s.credentialFor = options.credentialFor;
  if (options.hasActiveWork) {
    const hasLease = s.projectHasActiveSessions.bind(s);
    s.projectHasActiveSessions = (projectId) => hasLease(projectId) || options.hasActiveWork(projectId);
  }
  const manager = new ProjectManager({
    store: s, environments, deployTargets: options.deployTargets || {},
    gitHubAppToken: options.gitHubAppToken || (() => null),
    authorFor: () => ({ name: 'Ada', email: 'ada@example.test' }),
    broadcast: options.broadcast || (() => {}),
    now: options.now,
    ownerFor: options.ownerFor || ((id) => ({ id, githubLogin: 'ada' })),
    deleteProjectSessions: options.deleteProjectSessions || (() => {}),
    fetch: options.fetch,
    preflightTimeoutMs: options.preflightTimeoutMs,
    cloneTimeoutMs: options.cloneTimeoutMs,
    hasLiveProjectWork: options.hasLiveProjectWork,
  });
  return { dir, e, s, manager };
}
function project(id, state = 'stopped', repoUrl = null) { const now = new Date().toISOString(); return { id, ownerUserId: 1, name: id, repoUrl, repoHost: repoUrl ? 'example.test' : null, targetId: null, tierId: null, state, stateDetail: null, container: null, rebuildRequired: false, buildLog: [], lastActivityAt: now, lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now }; }

describe('project core lifecycle', function () {
  it('builds, stops and restarts without wiping the workspace', async function () {
    const { manager, s, e, dir } = setup([project('one')]);
    assert.deepStrictEqual(await manager.start(1, 'one'), { ok: true, state: 'building' });
    await manager.waitForBuild('one');
    const progress = s.getProject('one').buildLog.map((event) => event.percent).filter((value) => value !== undefined);
    assert.deepStrictEqual(progress, [0, 15, 100]);
    const workspace = path.join(dir, 'projects', 'one');
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'keep');
    assert.deepStrictEqual(await manager.stop(1, 'one'), { ok: true });
    assert.strictEqual(s.getProject('one').rebuildRequired, false);
    assert.deepStrictEqual(await manager.start(1, 'one'), { ok: true, state: 'building' });
    await manager.waitForBuild('one');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'keep');
    assert.strictEqual(s.getProject('one').state, 'running');
    const session = await manager.ensureForSession(1, 'one');
    const ownerHome = path.join(dir, 'cawc-ada-1');
    fs.mkdirSync(path.join(ownerHome, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ownerHome, '.local', 'bin', 'installed-tool'), 'persistent');
    assert.strictEqual(session.environment.homeDir, ownerHome);
    assert.strictEqual(session.environment.containerHome, '/home/ada-1');
    assert.strictEqual(fs.readFileSync(path.join(session.environment.homeDir, '.local', 'bin', 'installed-tool'), 'utf8'), 'persistent');
    assert.strictEqual(session.environment.toContainerPath(path.join(workspace, 'keep.txt')), '/workspace/keep.txt');
    assert.strictEqual(session.environment.toContainerPath(ownerHome), '/home/ada-1');
    let wrapped;
    e.execArgs = (spec) => { wrapped = spec; return []; };
    session.environment.wrap('sh', []);
    assert.strictEqual(wrapped.cwd, '/home/ada-1', 'default command cwd follows persistent HOME');
    session.environment.wrap('sh', [], { cwd: session.workingDir });
    assert.strictEqual(wrapped.cwd, '/workspace', 'explicit project cwd still maps to the workspace');
    assert.deepStrictEqual(session.allowedWorkingDirs, [workspace, ownerHome]);
    assert.strictEqual(manager.releaseSessionLease(1, 'one', session.leaseId), true);
  });

  it('keeps same-user project workspaces outside the shared owner-home mount', async function () {
    const { manager, e, dir } = setup([project('one'), project('two')]);
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    await manager.start(1, 'two'); await manager.waitForBuild('two');
    const specs = e.calls.filter((call) => call.op === 'ensure').map((call) => call.spec);
    const first = specs.find((spec) => spec.labels['com.code-agents-webcli.project'] === 'one');
    const home = first.mounts.find((mount) => mount.containerPath.startsWith('/home/'));
    const workspace = first.mounts.find((mount) => mount.containerPath === '/workspace');
    assert.strictEqual(home.hostPath, path.join(dir, 'cawc-ada-1'));
    assert.strictEqual(workspace.hostPath, path.join(dir, 'projects', 'one'));
    assert.ok(!path.join(dir, 'projects', 'two').startsWith(`${home.hostPath}${path.sep}`));
  });

  it('includes the recorded target display name in project summaries', function () {
    const p = project('one'); p.targetId = 'target-1';
    const { manager } = setup([p], { deployTargets: { getTarget: (id) => id === 'target-1' ? { name: 'Build cluster' } : null } });
    assert.strictEqual(manager.listForUser(1)[0].targetName, 'Build cluster');
  });

  it('records the resolved target tier when creating a project', async function () {
    const { manager, e } = setup();
    const result = await manager.createAndStart(1, { name: 'one' });
    assert.strictEqual(result.ok, true); assert.strictEqual(result.state, 'building');
    assert.ok(result.project.tierId);
    await manager.waitForBuild(result.project.id);
    const spec = e.calls.find((call) => call.op === 'ensure').spec;
    assert.strictEqual(spec.labels['com.code-agents-webcli.tier'], result.project.tierId);
    assert.ok(spec.cpus); assert.ok(spec.memory);
  });

  it('returns building promptly and refuses deletion until the tracked build finishes', async function () {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    const { manager, s } = setup([project('one')], { engine: { async ensure() { await gate; return { created: true }; } } });
    const starting = manager.start(1, 'one');
    const deleting = manager.remove(1, 'one');
    assert.deepStrictEqual(await starting, { ok: true, state: 'building' });
    assert.strictEqual(s.getProject('one').state, 'building');
    const deletion = await deleting;
    assert.strictEqual(deletion.reason, 'invalid_state');
    finish(); await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'running');
  });

  it('lets an unrelated project stop and restart while another clone is blocked', async function () {
    let cloneEntered; let finishClone;
    const entered = new Promise((resolve) => { cloneEntered = resolve; });
    const gate = new Promise((resolve) => { finishClone = resolve; });
    const a = project('a', 'stopped', 'https://example.test/a.git');
    const b = project('b', 'running'); b.container = { name: 'b-box' };
    let harness;
    harness = setup([a, b], { fetch: async () => ({ status: 200 }), engine: {
      async exec(spec, command, args) {
        harness.e.calls.push({ op: 'exec', spec, command, args });
        if (args.includes('clone') && args.includes('https://example.test/a.git')) {
          cloneEntered(); await gate;
          fs.mkdirSync(path.join(harness.dir, 'projects', 'a', 'a', '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
      },
    } });

    await harness.manager.start(1, 'a');
    await entered;
    assert.deepStrictEqual(await harness.manager.stop(1, 'b'), { ok: true });
    assert.strictEqual((await harness.manager.start(1, 'b')).state, 'building');
    await harness.manager.waitForBuild('b');
    assert.strictEqual(harness.s.getProject('b').state, 'running');
    finishClone();
    await harness.manager.waitForBuild('a');
    assert.strictEqual(harness.s.getProject('a').state, 'running');
  });

  it('cancels a timed-out clone, stops its container, and only then marks the build failed', async function () {
    let aborted = false;
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, e, s } = setup([p], { fetch: async () => ({ status: 200 }), cloneTimeoutMs: 5, engine: {
      async exec(spec, command, args) {
        e.calls.push({ op: 'exec', spec, command, args });
        return new Promise((_resolve, reject) => {
          spec.signal.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    } });

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(aborted, true);
    assert.strictEqual(s.getProject('one').state, 'failed');
    assert.match(s.getProject('one').stateDetail, /timed out/);
    assert.ok(e.calls.some((call) => call.op === 'stop'));
  });

  it('retains a counted build state when clone cleanup cannot stop the running container', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, s } = setup([p], { fetch: async () => ({ status: 200 }), engine: {
      async exec() { throw new Error('clone failed'); },
      async stop() { throw new Error('daemon refused stop'); },
    } });

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(s.getProject('one').state, 'building');
    assert.match(s.getProject('one').stateDetail, /could not be stopped/);
  });

  it('drains an in-flight build before shutdown completes', async function () {
    let cloneEntered; let finishClone;
    const entered = new Promise((resolve) => { cloneEntered = resolve; });
    const gate = new Promise((resolve) => { finishClone = resolve; });
    let harness;
    harness = setup([project('one', 'stopped', 'https://example.test/a.git')], {
      fetch: async () => ({ status: 200 }),
      engine: { async exec(spec, command, args) {
        harness.e.calls.push({ op: 'exec', spec, command, args });
        if (args.includes('clone')) {
          cloneEntered(); await gate;
          fs.mkdirSync(path.join(harness.dir, 'projects', 'one', 'a', '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
      } },
    });
    await harness.manager.start(1, 'one');
    await entered;
    let drained = false;
    const shutdown = harness.manager.shutdown().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(drained, false);

    finishClone();
    await shutdown;
    assert.strictEqual(harness.s.getProject('one').state, 'running');
  });

  it('fails closed for lifecycle and admission calls after shutdown without touching store or engine', async function () {
    const { manager, s, e } = setup([project('one')]);
    await manager.shutdown();
    let reads = 0;
    const get = s.getProjectForUser.bind(s);
    s.getProjectForUser = (...args) => { reads += 1; return get(...args); };

    assert.strictEqual((await manager.start(1, 'one')).reason, 'shutting_down');
    assert.strictEqual((await manager.ensureForSession(1, 'one')).reason, 'shutting_down');
    assert.strictEqual((await manager.createAndStart(1, { name: 'new' })).reason, 'shutting_down');
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(e.calls, []);
    assert.strictEqual(s.projectHasActiveSessions('one'), false);
  });

  it('allows an idempotent lease release while shutdown finalizers drain', async function () {
    const p = project('one');
    const { manager, s } = setup([p]);
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    const admitted = await manager.ensureForSession(1, 'one');
    assert.strictEqual(admitted.ok, true);
    let drained = false;
    const shutdown = manager.shutdown().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(drained, false, 'shutdown keeps SQLite alive for lease finalizers');
    assert.strictEqual(manager.releaseSessionLease(1, 'one', admitted.leaseId), true);
    await shutdown;
    assert.strictEqual(manager.releaseSessionLease(1, 'one', admitted.leaseId), false);
    assert.strictEqual(s.projectHasActiveSessions('one'), false);
  });

  it('holds an admission lease before returning so a concurrent stop cannot kill the attachment', async function () {
    let enteredEnsure; let finishEnsure;
    const ensureEntered = new Promise((resolve) => { enteredEnsure = resolve; });
    const ensureGate = new Promise((resolve) => { finishEnsure = resolve; });
    const p = project('one', 'running'); p.container = { name: 'saved' };
    const { manager } = setup([p], { engine: { async ensure() { enteredEnsure(); await ensureGate; return { created: false }; } } });

    const admissionPromise = manager.ensureForSession(1, 'one');
    await ensureEntered;
    const stopPromise = manager.stop(1, 'one');
    finishEnsure();
    const admitted = await admissionPromise;
    const stopped = await stopPromise;

    assert.strictEqual(admitted.ok, true);
    assert.strictEqual(stopped.reason, 'invalid_state');
    assert.match(stopped.detail, /active_work|active work/);
    assert.strictEqual(manager.releaseSessionLease(1, 'one', admitted.leaseId), true);
    assert.strictEqual(manager.releaseSessionLease(1, 'one', admitted.leaseId), false, 'release is idempotent');
    assert.deepStrictEqual(await manager.stop(1, 'one'), { ok: true });
  });

  it('does not release binary streams when a same-name runtime replacement wins the spawn race', async function () {
    const { manager, e } = setup([project('one')]);
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    const admitted = await manager.ensureForSession(1, 'one'); assert.strictEqual(admitted.ok, true);
    const labels = { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'one', 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy' };
    let inspections = 0;
    e.describe = async (name) => ({ name, identity: inspections++ ? 'replacement-id' : admitted.containerAccess.containerIdentity, status: 'running', image: 'img', labels });
    e.binary = process.execPath;
    e.execArgs = () => ['-e', 'setInterval(() => {}, 1000)'];
    await assert.rejects(() => manager.spawnSessionFileCommand(1, 'one', admitted.leaseId, { operation: 'read', path: '/tmp/x' }), /was replaced/);
    assert.strictEqual(manager.releaseSessionLease(1, 'one', admitted.leaseId), true);
  });

  it('isolates failing event and broadcast listeners from lifecycle work', async function () {
    const { manager, s } = setup([project('one')], { broadcast: () => { throw new Error('socket gone'); } });
    let delivered = 0;
    manager.events.on('updated', () => { throw new Error('bad listener'); });
    manager.events.on('updated', () => { delivered += 1; });
    const original = console.error; console.error = () => {};
    try {
      await manager.start(1, 'one'); await manager.waitForBuild('one');
      assert.strictEqual(s.getProject('one').state, 'running'); assert.ok(delivered > 0);
    } finally { console.error = original; }
  });

  it('refuses a foreign container occupying a fresh project deterministic name', async function () {
    const { manager, s, e } = setup([project('one')], { engine: {
      async describe(name) { return { name, identity: 'foreign-id', status: 'running', image: 'foreign', labels: {} }; },
    } });
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'building');
    assert.match(s.getProject('one').stateDetail, /mismatched ownership/);
    assert.ok(!e.calls.some((call) => call.op === 'ensure'));
  });

  it('rejects a foreign container that appears between preflight describe and ensure', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, s, e } = setup([p], { fetch: async () => ({ status: 200 }) });
    let appeared = false;
    e.describe = async (name) => appeared
      ? { name, identity: 'foreign-id', status: 'running', image: 'foreign', labels: {} }
      : null;
    e.ensure = async (spec) => { e.calls.push({ op: 'ensure', spec }); appeared = true; return { created: false }; };

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(s.getProject('one').state, 'building');
    assert.match(s.getProject('one').stateDetail, /changed ownership/);
    assert.ok(!e.calls.some((call) => call.op === 'exec'), 'no command executes in the foreign container');
    assert.ok(!e.calls.some((call) => call.op === 'stop'), 'a known foreign container is never stopped');
  });

  it('keeps a post-ensure unverifiable container counted with its deterministic name', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, s, e } = setup([p], { fetch: async () => ({ status: 200 }) });
    e.describe = async () => null;
    e.ensure = async (spec) => { e.calls.push({ op: 'ensure', spec }); return { created: true }; };

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(s.getProject('one').state, 'building');
    assert.ok(s.getProject('one').container?.name);
    assert.match(s.getProject('one').stateDetail, /could not be verified/);
    assert.ok(!e.calls.some((call) => call.op === 'stop' || call.op === 'exec'));
  });

  it('keeps a partially started owned container counted when its compensating stop fails', async function () {
    const p = project('one', 'stopped');
    const { manager, s, e } = setup([p]);
    let attemptedSpec = null;
    e.describe = async (name) => attemptedSpec
      ? { name, identity: 'attempted-id', status: 'running', image: attemptedSpec.image, labels: attemptedSpec.labels }
      : null;
    e.ensure = async (spec) => { e.calls.push({ op: 'ensure', spec }); attemptedSpec = spec; throw new Error('engine wait failed'); };
    e.stop = async (name) => { e.calls.push({ op: 'stop', name }); throw new Error('stop failed'); };

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(s.getProject('one').state, 'building');
    assert.strictEqual(s.getProject('one').container.name, attemptedSpec.name);
    assert.match(s.getProject('one').stateDetail, /same-name project container appeared/);
    assert.ok(!e.calls.some((call) => call.op === 'stop'), 'an unproven replacement is never stopped');
  });

  it('reclaims a clean checkout by removing its container and workspace', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, e, dir } = setup([p]);
    const workspace = path.join(dir, 'projects', 'one'); fs.mkdirSync(workspace, { recursive: true });
    assert.deepStrictEqual(await manager.release(1, 'one'), { ok: false, reason: 'invalid_state' });
    assert.deepStrictEqual(await manager.remove(1, 'one'), { ok: true });
    // A test double cannot describe `saved`, so strict ownership validation
    // leaves the absent runtime alone while reclaiming the host workspace.
    assert.ok(!fs.existsSync(workspace));
  });

  it('blocks a failed preservation and lets an explicit discard release it', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, s, e, dir } = setup([p], { engine: { async exec() { throw Object.assign(new Error('push TOKEN failed'), { stderr: 'push TOKEN failed' }); } } });
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });
    const events = []; manager.events.on('build', ({ event }) => events.push(event));
    const failed = await manager.remove(1, 'one');
    assert.strictEqual(failed.reason, 'preserve_failed'); assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.ok(e.calls.some((call) => call.op === 'stop'), 'the running container stops before blocked becomes uncounted');
    assert.ok(events.some((event) => event.t === 'preserve' && event.state === 'blocked'));
    assert.deepStrictEqual(await manager.release(1, 'one', { discard: true }), { ok: true });
  });

  it('keeps preservation cleanup counted when a running container cannot stop', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, s, dir } = setup([p], { engine: {
      async exec() { throw new Error('push failed'); },
      async stop() { throw new Error('daemon refused stop'); },
    } });
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });

    const result = await manager.remove(1, 'one');

    assert.strictEqual(result.reason, 'preserve_failed');
    assert.strictEqual(s.getProject('one').state, 'reclaiming');
    assert.match(s.getProject('one').stateDetail, /could not be stopped/);
  });

  it('keeps reclaim counted when container preparation fails with an unknown physical state', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, s, e, dir } = setup([p]);
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });
    e.describe = async () => null;
    e.ensure = async () => { throw new Error('engine start outcome unknown'); };

    const result = await manager.remove(1, 'one');

    assert.strictEqual(result.reason, 'preserve_failed');
    assert.strictEqual(s.getProject('one').state, 'reclaiming');
    assert.strictEqual(s.getProject('one').container.name, 'saved');
    assert.match(s.getProject('one').stateDetail, /state could not be verified/);
    assert.ok(!e.calls.some((call) => call.op === 'stop'));
  });

  it('lets explicit recovery retry a terminal reclaiming project', async function () {
    const p = project('one', 'reclaiming');
    p.container = { name: 'saved' };
    p.rebuildRequired = true;
    const { manager, s, dir } = setup([p]);
    const workspace = path.join(dir, 'projects', 'one');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'discarded.txt'), 'transient');

    assert.deepStrictEqual(await manager.release(1, 'one'), { ok: true });
    assert.strictEqual(s.getProject('one').state, 'stopped');
    assert.ok(!fs.existsSync(workspace));
  });

  it('lets an explicit discard recover a terminal reclaiming project', async function () {
    const p = project('one', 'reclaiming', 'https://example.test/a.git');
    p.container = { name: 'saved' };
    p.rebuildRequired = true;
    const { manager, s, dir } = setup([p]);
    const workspace = path.join(dir, 'projects', 'one');
    fs.mkdirSync(path.join(workspace, 'a', '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a', 'discarded.txt'), 'transient');

    assert.deepStrictEqual(
      await manager.release(1, 'one', { discard: true }),
      { ok: true },
    );
    assert.strictEqual(s.getProject('one').state, 'stopped');
    assert.ok(!fs.existsSync(workspace));
  });

  it('never stops a known foreign container when reclaim preparation rejects it', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, s, e, dir } = setup([p], { engine: {
      async describe(name) { return { name, identity: 'foreign-id', status: 'running', image: 'foreign', labels: {} }; },
    } });
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });

    const result = await manager.remove(1, 'one');

    assert.strictEqual(result.reason, 'preserve_failed');
    assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.ok(!e.calls.some((call) => call.op === 'stop' || call.op === 'remove'));
  });

  it('restarts a blocked container to retry preservation before reclaiming', async function () {
    const p = project('one', 'blocked', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, e, s, dir } = setup([p]);
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });
    e.exec = async (spec, command, args) => {
      e.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    assert.deepStrictEqual(await manager.release(1, 'one'), { ok: true });
    assert.ok(e.calls.some((call) => call.op === 'ensure'));
    assert.ok(e.calls.some((call) => call.op === 'exec' && call.args.includes('push')));
    assert.strictEqual(s.getProject('one').state, 'stopped');
  });

  it('keeps a blocked workspace when its checkout is unavailable for preservation', async function () {
    const p = project('one', 'blocked', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, e, s, dir } = setup([p]);
    const checkout = path.join(dir, 'projects', 'one', 'a');
    fs.mkdirSync(checkout, { recursive: true });
    const marker = path.join(checkout, 'uncommitted.txt');
    fs.writeFileSync(marker, 'must survive');

    const result = await manager.release(1, 'one');

    assert.strictEqual(result.reason, 'preserve_failed');
    assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'must survive');
    assert.ok(!e.calls.some((call) => call.op === 'remove'));
  });

  it('blocks removal when missing or corrupt repository metadata could hide user work', async function () {
    for (const corruptGit of [false, true]) {
      const p = project(corruptGit ? 'corrupt' : 'missing', 'running', 'https://example.test/a.git'); p.container = { name: `box-${p.id}` };
      const harness = setup([p]); const checkout = path.join(harness.dir, 'projects', p.id, 'a');
      fs.mkdirSync(checkout, { recursive: true }); fs.writeFileSync(path.join(checkout, 'uncommitted.txt'), 'only copy');
      if (corruptGit) {
        fs.mkdirSync(path.join(checkout, '.git'));
        harness.e.exec = async (_spec, _command, args) => {
          if (args.includes('status')) throw new Error('fatal: not a git repository');
          return { stdout: '', stderr: '' };
        };
      }
      const result = await harness.manager.remove(1, p.id);
      assert.strictEqual(result.reason, 'preserve_failed');
      assert.strictEqual(harness.s.getProject(p.id).state, 'blocked');
      assert.strictEqual(fs.readFileSync(path.join(checkout, 'uncommitted.txt'), 'utf8'), 'only copy');
      assert.ok(!harness.e.calls.some((call) => call.op === 'remove'));
    }
  });

  it('refuses to release a blocked project while live work is attached', async function () {
    const p = project('one', 'blocked', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const { manager, e, s, dir } = setup([p], { hasLiveProjectWork: () => true });
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });

    const result = await manager.release(1, 'one');

    assert.strictEqual(result.reason, 'invalid_state');
    assert.match(result.detail, /active work/);
    assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.ok(!e.calls.some((call) => call.op === 'exec' || call.op === 'remove'));
  });

  it('retains the exact collision-resolved recovery branch across reclaim and a later start', async function () {
    const p = project('one', 'blocked', 'https://example.test/a.git'); p.container = { name: 'saved' };
    let pushes = 0;
    const harness = setup([p], {
      fetch: async () => ({ status: 200 }),
      now: () => new Date('2026-08-01T12:00:00.000Z'),
    });
    const checkout = path.join(harness.dir, 'projects', 'one', 'a');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'work.txt'), 'recover me');
    harness.e.exec = async (spec, command, args) => {
      harness.e.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push') && pushes++ === 0) throw new Error('stale info rejected');
      if (args.includes('ls-remote')) return { stdout: 'taken\n', stderr: '' };
      if (args.includes('clone')) fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      return { stdout: '', stderr: '' };
    };

    assert.deepStrictEqual(await harness.manager.release(1, 'one'), { ok: true });
    assert.strictEqual(harness.s.getProject('one').lastPreservedBranch, 'cc-web/wip/2026-08-01-abc123-1');
    assert.strictEqual(harness.s.getProject('one').lastPreservedCommit, 'wip-commit');

    await harness.manager.start(1, 'one');
    await harness.manager.waitForBuild('one');
    assert.strictEqual(harness.s.getProject('one').state, 'running');
    assert.strictEqual(harness.s.getProject('one').lastPreservedBranch, 'cc-web/wip/2026-08-01-abc123-1');
    assert.strictEqual(harness.s.getProject('one').lastPreservedCommit, 'wip-commit');
  });

  it('swaps an idle running project inside the start decision', async function () {
    const old = project('old', 'running'); old.container = { name: 'old-box' };
    const { manager, e } = setup([old, project('new')], { limit: 1 });
    assert.deepStrictEqual(await manager.start(1, 'new', { stopProjectId: 'old' }), { ok: true, state: 'building' });
    await manager.waitForBuild('new');
  });

  it('closes admission before the physical half of a swap begins', async function () {
    let stopEntered; let finishStop;
    const entered = new Promise((resolve) => { stopEntered = resolve; });
    const gate = new Promise((resolve) => { finishStop = resolve; });
    const old = project('old', 'running'); old.container = { name: 'old-box' };
    const labels = { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'old', 'com.code-agents-webcli.target': 'legacy', 'com.code-agents-webcli.user-id': '1' };
    const { manager } = setup([old, project('new')], { limit: 1, engine: {
      async describe(name) { return name === 'old-box' ? { name, identity: 'old-id', status: 'running', image: 'img', labels } : null; },
      async stop(name) { if (name === 'old-box') { stopEntered(); await gate; } },
    } });

    const swapPromise = manager.start(1, 'new', { stopProjectId: 'old' });
    await entered;
    const attachPromise = manager.ensureForSession(1, 'old');
    finishStop();

    assert.strictEqual((await swapPromise).state, 'building');
    const attachment = await attachPromise;
    assert.strictEqual(attachment.ok, false);
    assert.strictEqual(attachment.reason, 'run_limit');
    await manager.waitForBuild('new');
  });

  it('marks live in-memory work in run-limit swap offers', async function () {
    const old = project('old', 'running'); old.container = { name: 'old-box' };
    const { manager } = setup([old, project('new')], {
      limit: 1,
      hasLiveProjectWork: (projectId) => projectId === 'old',
    });

    const result = await manager.start(1, 'new');

    assert.strictEqual(result.reason, 'run_limit');
    assert.strictEqual(result.running.find((candidate) => candidate.id === 'old').hasActiveWork, true);
  });

  it('restores both database states when the swapped container cannot stop', async function () {
    const old = project('old', 'running'); old.container = { name: 'old-box' };
    const labels = { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'old', 'com.code-agents-webcli.target': 'legacy', 'com.code-agents-webcli.user-id': '1' };
    const { manager, s, e } = setup([old, project('new')], { limit: 1, engine: { async describe(name) { return { name, identity: 'old-id', status: 'running', image: 'img', labels }; }, async stop() { throw new Error('daemon refused'); } } });
    const result = await manager.start(1, 'new', { stopProjectId: 'old' });
    assert.strictEqual(result.reason, 'invalid_state');
    assert.strictEqual(s.getProject('old').state, 'running');
    assert.strictEqual(s.getProject('new').state, 'stopped');
    assert.ok(!e.calls.some((call) => call.op === 'ensure'));
  });

  it('blocks a non-empty partial clone because missing metadata may hide user work', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, s, e, dir } = setup([p], { fetch: async () => ({ status: 200 }) });
    const checkout = path.join(dir, 'projects', 'one', 'a');
    fs.mkdirSync(checkout, { recursive: true }); fs.writeFileSync(path.join(checkout, 'partial'), 'x');
    e.exec = async (spec, command, args) => {
      e.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('clone')) fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      return { stdout: '', stderr: '' };
    };
    assert.strictEqual((await manager.start(1, 'one')).state, 'building');
    await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.match(s.getProject('one').stateDetail, /metadata.*missing|repair.*discard/i);
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'partial'), 'utf8'), 'x');
    assert.ok(!fs.existsSync(path.join(checkout, '.git')));
    assert.ok(!e.calls.some((call) => call.op === 'exec' && call.args.includes('clone')));
  });

  it('marks a credentialed 404 unavailable and emits a terminal error state', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    const { manager, s } = setup([p], {
      credentialFor: () => 'owner-token',
      fetch: async () => ({ status: 404 }),
    });
    const events = []; manager.events.on('build', ({ event }) => events.push(event));
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'unavailable');
    assert.ok(events.some((event) => event.t === 'error' && event.state === 'unavailable'));
  });

  it('removes verified project-labelled orphan containers on boot', async function () {
    let present = true;
    const { manager, e } = setup([], { engine: { async describe(name) { return present ? { name, identity: 'orphan-id', status: 'running', image: 'img', labels: { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'gone', 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy' } } : null; } } });
    e.list = async (selector) => { e.calls.push({ op: 'list', selector }); return ['orphan']; };
    e.removeIdentity = async (description) => { e.calls.push({ op: 'remove', name: description.name, identity: description.identity }); present = false; };
    await manager.reconcileOnBoot();
    assert.ok(e.calls.some((c) => c.op === 'list' && c.selector === 'com.code-agents-webcli.project'));
    assert.ok(e.calls.some((c) => c.op === 'remove' && c.name === 'orphan' && c.identity === 'orphan-id'));
  });

  it('ignores unrelated containers that spoof only the project label on boot', async function () {
    const { manager, e } = setup([], { engine: { async describe(name) { return { name, labels: { 'com.code-agents-webcli.project': 'gone' } }; } } });
    e.list = async () => ['unrelated'];

    await manager.reconcileOnBoot();

    assert.ok(!e.calls.some((call) => call.op === 'remove' || call.op === 'stop'));
  });

  it('never removes a name-mismatched container that claims an existing project', async function () {
    const p = project('one', 'stopped'); p.container = { name: 'saved' };
    const { manager, e } = setup([p]);
    const statuses = new Map([['intruder', 'running'], ['saved', 'running']]);
    e.list = async () => ['intruder', 'saved'];
    e.describe = async (name) => ({
      name, identity: `${name}-id`, status: statuses.get(name), image: 'img',
      labels: {
        'com.code-agents-webcli.managed': 'true',
        'com.code-agents-webcli.project': 'one',
        'com.code-agents-webcli.target': 'legacy',
        'com.code-agents-webcli.user-id': '1',
      },
    });
    e.stopIdentity = async (description) => {
      e.calls.push({ op: 'stop', name: description.name, identity: description.identity });
      statuses.set(description.name, 'stopped');
    };
    await manager.reconcileOnBoot();
    assert.ok(!e.calls.some((call) => call.op === 'remove' && call.name === 'intruder'));
    assert.ok(e.calls.some((call) => call.op === 'stop' && call.name === 'saved' && call.identity === 'saved-id'));
  });

  it('retires every potentially executable recorded runtime on boot before marking it stopped', async function () {
    for (const scenario of [
      { kind: 'docker', status: 'running', retired: 'exited' },
      { kind: 'docker', status: 'restarting', retired: 'exited' },
      { kind: 'kubernetes', status: 'pending', retired: null },
    ]) {
      const p = project(`${scenario.kind}-${scenario.status}`, 'running');
      p.container = { name: `runtime-${scenario.status}` };
      const harness = setup([p]);
      harness.e.kind = scenario.kind;
      let status = scenario.status; let present = true;
      const labels = {
        'com.code-agents-webcli.managed': 'true',
        'com.code-agents-webcli.project': p.id,
        'com.code-agents-webcli.target': 'legacy',
        'com.code-agents-webcli.user-id': '1',
      };
      harness.e.describe = async (name) => present
        ? { name, identity: 'recorded-identity', status, image: 'img', labels }
        : null;
      harness.e.stopIdentity = async (description) => {
        harness.e.calls.push({ op: 'stop-identity', description });
        if (scenario.retired === null) present = false;
        else status = scenario.retired;
      };

      await harness.manager.reconcileOnBoot();

      assert.ok(harness.e.calls.some((call) => call.op === 'stop-identity'
        && call.description.identity === 'recorded-identity'));
      assert.strictEqual(harness.s.getProject(p.id).state, 'stopped');
      assert.strictEqual(present && !['configured', 'created', 'dead', 'exited', 'initialized', 'stopped'].includes(status), false);
    }
  });

  it('marks a missing recorded container for rebuild, then preserves and fresh-clones its old checkout', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    let harness; const operations = [];
    harness = setup([p], { fetch: async () => ({ status: 200 }), engine: {
      async describe() { return null; },
      async exec(spec, command, args) {
        harness.e.calls.push({ op: 'exec', spec, command, args });
        if (args.includes('status')) return { stdout: ' M uncommitted.txt\n', stderr: '' };
        if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abcdef012345\n', stderr: '' };
        if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
        if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
        if (args.includes('push')) operations.push('push');
        if (args.includes('clone')) {
          operations.push('clone');
          assert.ok(!fs.existsSync(path.join(harness.dir, 'projects', 'one', 'a', 'uncommitted.txt')));
          fs.mkdirSync(path.join(harness.dir, 'projects', 'one', 'a', '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
      },
    } });
    const checkout = path.join(harness.dir, 'projects', 'one', 'a');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'uncommitted.txt'), 'old bytes');

    await harness.manager.reconcileOnBoot();
    assert.strictEqual(harness.s.getProject('one').state, 'stopped');
    assert.strictEqual(harness.s.getProject('one').container, null);
    assert.match(harness.s.getProject('one').stateDetail, /missing.*rebuild/i);

    await harness.manager.start(1, 'one');
    await harness.manager.waitForBuild('one');
    assert.strictEqual(harness.s.getProject('one').state, 'running');
    assert.deepStrictEqual(operations, ['push', 'clone']);
    assert.ok(fs.existsSync(path.join(checkout, '.git')));
    const preserved = harness.s.getProject('one').buildLog.find((event) => event.t === 'preserve' && event.branch);
    assert.ok(preserved, 'the recovery branch must remain visible in persisted build events');
    assert.match(preserved.branch, /^cc-web\/wip\//);
    assert.strictEqual(preserved.commit, 'wip-commit');
    assert.ok(preserved.message.includes(preserved.branch));
  });

  it('detects a stopped Docker runtime disappearing live, preserves dirty work, and fresh-clones', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git'); p.container = { name: 'saved' };
    const operations = [];
    const harness = setup([p], { fetch: async () => ({ status: 200 }) });
    const checkout = path.join(harness.dir, 'projects', 'one', 'a');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'uncommitted.txt'), 'only copy');
    harness.e.exec = async (spec, command, args) => {
      harness.e.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('status')) return { stdout: ' M uncommitted.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push')) operations.push('push');
      if (args.includes('clone')) {
        operations.push('clone');
        assert.ok(!fs.existsSync(path.join(checkout, 'uncommitted.txt')));
        fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      }
      return { stdout: '', stderr: '' };
    };

    await harness.manager.start(1, 'one');
    await harness.manager.waitForBuild('one');

    assert.strictEqual(harness.s.getProject('one').state, 'running');
    assert.deepStrictEqual(operations, ['push', 'clone']);
    assert.strictEqual(harness.s.getProject('one').lastPreservedCommit, 'wip-commit');
  });

  it('wipes a no-repository workspace when its stopped Docker runtime disappeared live', async function () {
    const p = project('one', 'stopped'); p.container = { name: 'saved' };
    const harness = setup([p]);
    const workspace = path.join(harness.dir, 'projects', 'one');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ephemeral.txt'), 'old runtime state');

    await harness.manager.start(1, 'one');
    await harness.manager.waitForBuild('one');

    assert.strictEqual(harness.s.getProject('one').state, 'running');
    assert.ok(!fs.existsSync(path.join(workspace, 'ephemeral.txt')));
  });

  it('records missing Docker runtime rebuild intent during stop but exempts expected absent Kubernetes pods', async function () {
    for (const kind of ['docker', 'kubernetes']) {
      const p = project(kind, 'running'); p.container = { name: `${kind}-runtime` };
      const harness = setup([p]); harness.e.kind = kind;

      assert.deepStrictEqual(await harness.manager.stop(1, kind), { ok: true });
      assert.strictEqual(harness.s.getProject(kind).state, 'stopped');
      assert.strictEqual(harness.s.getProject(kind).rebuildRequired, kind === 'docker');
    }
  });

  it('refuses session admission when a DB-running runtime vanished, then uses the counted preserve/wipe/clone build', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    let spec; let firstDescribe = true; let present = false; const operations = [];
    const { manager, s, e, dir } = setup([p], { fetch: async () => ({ status: 200 }) });
    e.describe = async (name) => {
      if (firstDescribe) { firstDescribe = false; return null; } // recorded runtime is gone
      if (!present) return null;
      return { name, identity: `${name}-id`, status: 'running', image: 'img', labels: spec.labels };
    };
    e.ensure = async (next) => { spec = next; const created = !present; present = true; e.calls.push({ op: 'ensure', spec: next }); return { created }; };
    e.remove = async (name) => { e.calls.push({ op: 'remove', name }); present = false; };
    e.exec = async (execSpec, command, args) => {
      e.calls.push({ op: 'exec', spec: execSpec, command, args });
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push')) operations.push('push');
      if (args.includes('clone')) { operations.push('clone'); fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true }); }
      return { stdout: '', stderr: '' };
    };
    fs.mkdirSync(path.join(dir, 'projects', 'one', 'a', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'one', 'a', 'work.txt'), 'old');
    const admitted = await manager.ensureForSession(1, 'one');
    assert.strictEqual(admitted.ok, false); assert.strictEqual(admitted.reason, 'building');
    assert.strictEqual(s.getProject('one').state, 'building');
    await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'running');
    assert.deepStrictEqual(operations, ['push', 'clone']);
  });

  it('does not treat expected Kubernetes runtime recreation after a normal stop as a workspace rebuild', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git'); p.container = { name: 'pod-one' };
    let spec; let identity = 'old-uid'; let status = 'failed';
    const { manager, e, dir } = setup([p], { fetch: async () => ({ status: 200 }) });
    e.kind = 'kubernetes';
    e.describe = async (name) => ({ name, identity, status, image: 'img', labels: spec ? spec.labels : {
      'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'one', 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy',
    } });
    e.ensure = async (next) => { spec = next; identity = 'new-uid'; status = 'running'; return { created: true }; };
    const checkout = path.join(dir, 'projects', 'one', 'a'); fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'keep.txt'), 'keep');
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'keep.txt'), 'utf8'), 'keep');
    assert.ok(!e.calls.some((call) => call.op === 'exec' && (call.args.includes('push') || call.args.includes('clone'))));
  });

  it('keeps repo and no-repo Kubernetes worktrees across stop, boot reconciliation, and reopen', async function () {
    for (const repoUrl of [null, 'https://example.test/a.git']) {
      const p = project(repoUrl ? 'repo' : 'plain', 'running', repoUrl); p.container = { name: `pod-${p.id}` };
      let present = true; let spec = null;
      const harness = setup([p], { fetch: async () => ({ status: 200 }) });
      harness.e.kind = 'kubernetes';
      const labels = () => spec?.labels || { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': p.id, 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy' };
      harness.e.describe = async (name) => present ? { name, identity: `${name}-uid`, status: 'running', image: 'img', labels: labels() } : null;
      harness.e.stopIdentity = async () => { present = false; };
      harness.e.ensure = async (next) => { spec = next; const created = !present; present = true; return { created }; };
      const workspace = path.join(harness.dir, 'projects', p.id); fs.mkdirSync(workspace, { recursive: true });
      if (repoUrl) fs.mkdirSync(path.join(workspace, 'a', '.git'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'keep.txt'), 'keep');
      assert.deepStrictEqual(await harness.manager.stop(1, p.id), { ok: true });
      await harness.manager.reconcileOnBoot();
      assert.strictEqual(harness.s.getProject(p.id).rebuildRequired, false);
      await harness.manager.start(1, p.id); await harness.manager.waitForBuild(p.id);
      assert.strictEqual(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'keep');
    }
  });

  it('keeps uncertain lifecycle state counted and never touches workspace bytes', async function () {
    const p = project('one', 'running'); p.container = { name: 'saved' };
    const { manager, s, e, dir } = setup([p]);
    const workspace = path.join(dir, 'projects', 'one'); fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, 'keep'), 'x');
    e.describe = async () => { throw new Error('daemon transport timeout'); };
    const stopped = await manager.stop(1, 'one');
    assert.strictEqual(stopped.reason, 'invalid_state'); assert.strictEqual(s.getProject('one').state, 'running');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'keep'), 'utf8'), 'x');
  });

  it('retains the rebuild cause when idle reclaim destruction fails for repo and no-repo projects', async function () {
    for (const repoUrl of [null, 'https://example.test/a.git']) {
      const p = project(repoUrl ? 'repo' : 'plain', 'stopped', repoUrl); p.container = { name: `box-${p.id}` }; p.lastActivityAt = new Date(0).toISOString();
      const harness = setup([p], { now: () => new Date('2026-01-01T00:00:00Z') });
      const labels = { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': p.id, 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy' };
      harness.e.describe = async (name) => ({ name, identity: `${name}-id`, status: 'stopped', image: 'img', labels });
      harness.e.removeIdentity = async () => { throw new Error('remove failed'); };
      if (repoUrl) fs.mkdirSync(path.join(harness.dir, 'projects', p.id, 'a', '.git'), { recursive: true });
      await harness.manager.sweepOnce();
      assert.strictEqual(harness.s.getProject(p.id).rebuildRequired, true);
      assert.strictEqual(harness.s.getProject(p.id).state, 'reclaiming');
      await harness.manager.reconcileOnBoot();
      assert.strictEqual(harness.s.getProject(p.id).rebuildRequired, true);
    }
  });

  it('wipes a no-repository workspace only for a true rebuild, not an ordinary stop', async function () {
    const p = project('one'); p.rebuildRequired = true; p.container = { name: 'saved' };
    let spec; let present = true;
    const { manager, s, e, dir } = setup([p]);
    e.describe = async (name) => present ? { name, identity: `${name}-id`, status: 'running', image: 'img', labels: spec ? spec.labels : {
      'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.project': 'one', 'com.code-agents-webcli.user-id': '1', 'com.code-agents-webcli.target': 'legacy',
    } } : null;
    e.ensure = async (next) => { spec = next; const created = !present; present = true; return { created }; };
    e.remove = async () => { present = false; };
    const workspace = path.join(dir, 'projects', 'one'); fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, 'discard.txt'), 'gone');
    await manager.start(1, 'one'); await manager.waitForBuild('one');
    assert.strictEqual(s.getProject('one').state, 'running');
    assert.ok(!fs.existsSync(path.join(workspace, 'discard.txt')));
  });

  it('blocks a created replacement without wiping bytes when old-checkout preservation fails', async function () {
    const p = project('one', 'stopped', 'https://example.test/a.git');
    p.rebuildRequired = true;
    const { manager, s, dir } = setup([p], { fetch: async () => ({ status: 200 }), engine: {
      async exec() { throw new Error('preservation network failed'); },
    } });
    const checkout = path.join(dir, 'projects', 'one', 'a');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'uncommitted.txt'), 'must survive');

    await manager.start(1, 'one');
    await manager.waitForBuild('one');

    assert.strictEqual(s.getProject('one').state, 'blocked');
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'uncommitted.txt'), 'utf8'), 'must survive');
  });

  it('does not reclaim a project when its sessions cannot be retired', async function () {
    const p = project('one', 'running'); p.container = { name: 'saved' };
    const { manager, e } = setup([p], { deleteProjectSessions: async () => { throw new Error('session is still live'); } });
    const result = await manager.remove(1, 'one');
    assert.strictEqual(result.reason, 'invalid_state');
    assert.ok(!e.calls.some((c) => c.op === 'remove'), 'container remains until session retirement succeeds');
  });

  it('refuses deletion with active work before preservation or session retirement', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    let retired = false;
    const { manager, e } = setup([p], { hasActiveWork: () => true, deleteProjectSessions: () => { retired = true; } });
    const result = await manager.remove(1, 'one');
    assert.strictEqual(result.reason, 'invalid_state'); assert.strictEqual(retired, false);
    assert.ok(!e.calls.some((call) => call.op === 'exec' || call.op === 'remove'));
  });

  it('does not reclaim from a stale stopped snapshot after the project restarted', async function () {
    const now = new Date('2026-08-01T12:00:00.000Z');
    const p = project('one', 'stopped'); p.lastActivityAt = '2026-08-01T10:00:00.000Z';
    const { manager, s, e } = setup([p], { now: () => now });
    const original = s.listProjectsInState.bind(s);
    s.listProjectsInState = (...states) => {
      if (states.length === 1 && states[0] === 'stopped') {
        const stale = { ...p, state: 'stopped' };
        p.state = 'running';
        return [stale];
      }
      return original(...states);
    };
    await manager.sweepOnce();
    assert.strictEqual(p.state, 'running');
    assert.ok(!e.calls.some((call) => call.op === 'remove'));
  });

  it('uses the live-work seam in list, stop and deletion decisions', async function () {
    const p = project('one', 'running'); p.container = { name: 'saved' };
    let live = true;
    const { manager, s, e } = setup([p], { hasLiveProjectWork: () => live });
    assert.strictEqual(manager.listForUser(1)[0].hasActiveWork, true);
    assert.strictEqual((await manager.stop(1, 'one')).reason, 'invalid_state');
    assert.strictEqual((await manager.remove(1, 'one')).reason, 'invalid_state');
    assert.ok(!e.calls.some((call) => call.op === 'stop' || call.op === 'remove'));
    live = false; manager.touchActivity('one', new Date('2026-08-01T12:00:00.000Z'));
    assert.strictEqual(s.getProject('one').lastActivityAt, '2026-08-01T12:00:00.000Z');
  });

  it('preserves before irreversibly retiring sessions during deletion', async function () {
    const p = project('one', 'running', 'https://example.test/a.git'); p.container = { name: 'saved' };
    let engineRef; let retiredAfterPush = false;
    const harness = setup([p], { deleteProjectSessions: () => {
      retiredAfterPush = engineRef.calls.some((call) => call.op === 'exec' && call.args.includes('push'));
    } });
    engineRef = harness.e;
    fs.mkdirSync(path.join(harness.dir, 'projects', 'one', 'a', '.git'), { recursive: true });
    engineRef.exec = async (spec, command, args) => {
      engineRef.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/a.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    assert.deepStrictEqual(await harness.manager.remove(1, 'one'), { ok: true });
    assert.strictEqual(retiredAfterPush, true);
    assert.strictEqual(harness.s.getProject('one'), null);
  });

  it('updates a stopped repository after checking access and makes no WIP push for a clean checkout', async function () {
    const p = project('one', 'stopped', 'https://example.test/old.git'); p.container = { name: 'saved' };
    const { manager, e, s, dir } = setup([p], { fetch: async () => ({ status: 200 }) });
    const checkout = path.join(dir, 'projects', 'one', 'old');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    e.exec = async (spec, command, args) => {
      e.calls.push({ op: 'exec', spec, command, args });
      if (args.includes('status')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const result = await manager.update(1, 'one', { name: 'renamed', repoUrl: 'https://example.test/new.git' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(s.getProject('one').repoUrl, 'https://example.test/new.git');
    assert.strictEqual(s.getProject('one').name, 'renamed');
    assert.strictEqual(s.getProject('one').state, 'stopped');
    assert.ok(!e.calls.some((call) => call.op === 'exec' && call.args.includes('push')));
    assert.ok(!fs.existsSync(checkout));
  });
});

describe('project repository transport', function () {
  it('uses only smart HTTP and classifies auth and gone responses', async function () {
    const seen = []; const auth = await checkRepositoryAccess('https://example.test/team/repo.git', async (url) => { seen.push(url); return { status: 401 }; });
    assert.deepStrictEqual(auth, { ok: false, reason: 'credential_required', host: 'example.test', message: 'Repository credentials are required' });
    assert.ok(seen[0].endsWith('/info/refs?service=git-upload-pack'));
    const hidden = await checkRepositoryAccess('https://example.test/repo', async () => ({ status: 404 }));
    assert.strictEqual(hidden.reason, 'credential_required');
    const gone = await checkRepositoryAccess('https://example.test/repo', async () => ({ status: 404 }), 'token');
    assert.strictEqual(gone.reason, 'repo_gone');
    assert.strictEqual((await checkRepositoryAccess('git@example.test:repo')).reason, 'validation');
    for (const unsafe of [
      'https://user@example.test/repo',
      'https://example.test/repo?ref=main',
      'https://example.test/repo?',
      'https://example.test/repo#main',
      'https://example.test/repo#',
    ]) assert.strictEqual((await checkRepositoryAccess(unsafe)).reason, 'validation');
    const port = await checkRepositoryAccess('https://example.test:8443/repo', async () => ({ status: 200 }));
    assert.strictEqual(port.host, 'example.test:8443');
  });
  it('bounds a preflight even when the HTTP implementation ignores abort', async function () {
    const result = await checkRepositoryAccess('https://example.test/repo', () => new Promise(() => {}), null, 5);
    assert.strictEqual(result.reason, 'unreachable');
    assert.match(result.message, /timed out/);
  });
  it('redacts a credential echoed by a failing HTTP implementation', async function () {
    const result = await checkRepositoryAccess(
      'https://example.test/repo',
      async () => { throw new Error('request with owner-secret failed'); },
      'owner-secret',
    );
    assert.ok(!result.message.includes('owner-secret')); assert.match(result.message, /\*\*\*/);
  });
  it('passes auth as a one-shot git header and redacts it from clone failures', async function () {
    const e = engine({ async exec(spec, _cmd, args) {
      assert.strictEqual(spec.identity, 'box-id');
      assert.ok(args.includes('http.extraHeader=AUTHORIZATION: bearer secret'));
      throw Object.assign(new Error('secret failed'), { stderr: 'secret failed' });
    } });
    await assert.rejects(() => cloneRepository({ engine: e, containerName: 'box', containerIdentity: 'box-id', repoUrl: 'https://example.test/a.git', destination: '/workspace/a', credential: 'secret' }), /\*\*\* failed/);
  });

  it('never consults the installation GitHub token for a private repository', async function () {
    let appTokenCalls = 0;
    const { manager } = setup([], {
      fetch: async () => ({ status: 401 }),
      gitHubAppToken: () => { appTokenCalls += 1; return 'installation-token'; },
    });
    const result = await manager.createAndStart(1, { name: 'private', repoUrl: 'https://github.com/owner/private.git' });
    assert.strictEqual(result.reason, 'credential_required');
    assert.strictEqual(appTokenCalls, 0);
  });
});

describe('project placement guardrails', function () {
  it('pins the original host and container home across a login rename and restart', async function () {
    const dir = root(); const cfg = config(dir); const e = engine();
    const firstManager = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir });
    const first = await firstManager.ensureFor({ id: 1, githubLogin: 'ada' });
    fs.writeFileSync(path.join(first.homeDir, '.sign-in'), 'still signed in');

    const restarted = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir });
    const renamed = await restarted.ensureFor({ id: 1, githubLogin: 'renamed-ada' });

    assert.strictEqual(renamed.name, first.name);
    assert.strictEqual(renamed.homeDir, first.homeDir);
    assert.strictEqual(renamed.containerHome, first.containerHome);
    assert.strictEqual(fs.readFileSync(path.join(renamed.homeDir, '.sign-in'), 'utf8'), 'still signed in');
  });

  it('fails closed when an upgraded user id has multiple legacy home candidates', function () {
    const dir = root(); const cfg = config(dir); const e = engine();
    fs.mkdirSync(path.join(dir, 'cawc-ada-1'));
    fs.mkdirSync(path.join(dir, 'cawc-old-login-1'));
    const environments = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir });

    assert.throws(
      () => environments.ownerHomeOnTarget({ id: 1, githubLogin: 'renamed' }, null),
      /ambiguous/,
    );
    assert.ok(!fs.existsSync(path.join(dir, '.owner-homes', '1.json')));
  });

  it('rejects disabled legacy placement without contacting its engine', function () {
    const calls = []; const e = engine({ async available() { calls.push('available'); return true; }, async ensure() { calls.push('ensure'); return { created: true }; } });
    const cfg = createContainerConfig({}, {});
    const environments = new EnvironmentManager({ config: cfg, engine: e, hostHome: root() });
    assert.throws(() => environments.activeProjectTarget(), /disabled/);
    assert.deepStrictEqual(calls, []);
  });

  it('rejects creation before repository preflight when no target is configured', async function () {
    let fetched = false; const dir = root(); const e = engine(); const cfg = createContainerConfig({}, {});
    const environments = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir });
    const s = store();
    const manager = new ProjectManager({
      store: s, environments, deployTargets: {}, authorFor: () => ({ name: 'Ada', email: 'a@b' }),
      broadcast() {}, ownerFor: (id) => ({ id, githubLogin: 'ada' }), deleteProjectSessions() {},
      fetch: async () => { fetched = true; return { status: 200 }; },
    });
    const result = await manager.createAndStart(1, { name: 'one', repoUrl: 'https://example.test/repo.git' });
    assert.strictEqual(result.reason, 'no_target');
    assert.strictEqual(fetched, false); assert.strictEqual(e.calls.length, 0);
  });

  it('fails loudly for remote Docker bind-mount targets', function () {
    const dir = root(); const cfg = { ...config(dir), hostArgs: ['-H', 'tcp://remote:2376'] }; const e = engine();
    const environments = new EnvironmentManager({ config: cfg, engine: e, hostHome: dir });
    assert.throws(() => environments.activeProjectTarget(), /remote docker bind mounts/);
    assert.strictEqual(e.calls.length, 0);
  });
});

describe('project lifecycle transaction and preservation recovery', function () {
  it('persists the exact recovery branch alongside its commit across a database restart', function () {
    const dir = root(); const key = Buffer.alloc(32, 8).toString('base64');
    let database = new AppDatabase({ dataDir: dir });
    let keyRing = new EncryptionKeyRing({ settings: database, key, warn() {} });
    let projects = new ProjectStore({ database, keyRing });
    const userId = database.upsertGitHubUser({ githubId: 'preserved-user', githubLogin: 'ada' }).id;
    const created = projects.createProject({ ownerUserId: userId, name: 'preserved' });
    projects.recordPreservation(created.id, 'cc-web/wip/2026-08-01-abc-2', 'commit-id');
    database.close();

    database = new AppDatabase({ dataDir: dir });
    keyRing = new EncryptionKeyRing({ settings: database, key, warn() {} });
    projects = new ProjectStore({ database, keyRing });
    assert.strictEqual(projects.getProject(created.id).lastPreservedBranch, 'cc-web/wip/2026-08-01-abc-2');
    assert.strictEqual(projects.getProject(created.id).lastPreservedCommit, 'commit-id');
    database.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomically arbitrates durable session leases against stop and swap claims', function () {
    const dir = root(); const database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 9).toString('base64'), warn() {} });
    const projects = new ProjectStore({ database, keyRing });
    const userId = database.upsertGitHubUser({ githubId: 'lease-user', githubLogin: 'ada' }).id;
    const old = projects.createProject({ ownerUserId: userId, name: 'old' });
    const next = projects.createProject({ ownerUserId: userId, name: 'next' });
    projects.setState(old.id, 'running');

    const lease = projects.tryAcquireSessionLease(old.id, userId);
    assert.strictEqual(lease.ok, true);
    assert.strictEqual(projects.tryClaimStop({ projectId: old.id, ownerUserId: userId }).reason, 'active_work');
    const busySwap = projects.tryStartCounted({ projectId: next.id, ownerUserId: userId, toState: 'building', fromStates: ['stopped'], limit: 1, stopProjectId: old.id });
    assert.strictEqual(busySwap.reason, 'stop_candidate_busy');
    assert.strictEqual(projects.getProject(old.id).state, 'running');
    assert.strictEqual(projects.getProject(next.id).state, 'stopped');
    assert.strictEqual(projects.releaseSessionLease(old.id, userId, lease.leaseId), true);
    assert.strictEqual(projects.releaseSessionLease(old.id, userId, lease.leaseId), false);

    const swap = projects.tryStartCounted({ projectId: next.id, ownerUserId: userId, toState: 'building', fromStates: ['stopped'], limit: 1, stopProjectId: old.id });
    assert.strictEqual(swap.ok, true);
    assert.strictEqual(projects.tryAcquireSessionLease(old.id, userId).reason, 'invalid_state');
    database.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not stop a swap candidate when a lowered limit still rejects the start', function () {
    const dir = root(); const database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 3).toString('base64'), warn() {} });
    const projects = new ProjectStore({ database, keyRing });
    const userId = database.upsertGitHubUser({ githubId: '1', githubLogin: 'ada' }).id;
    const old = projects.createProject({ ownerUserId: userId, name: 'old' });
    const other = projects.createProject({ ownerUserId: userId, name: 'other' });
    const next = projects.createProject({ ownerUserId: userId, name: 'next' });
    projects.setState(old.id, 'running'); projects.setState(other.id, 'building');
    const result = projects.tryStartCounted({ projectId: next.id, ownerUserId: userId, toState: 'building', fromStates: ['stopped'], limit: 1, stopProjectId: old.id });
    assert.strictEqual(result.reason, 'run_limit');
    assert.strictEqual(result.running.find((row) => row.id === old.id).state, 'running');
    assert.strictEqual(result.running.find((row) => row.id === other.id).state, 'building');
    assert.strictEqual(projects.getProject(old.id).state, 'running', 'a rejected swap must leave its candidate alone');
    database.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes target references for admin edit/delete protection', function () {
    const dir = root(); const database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 4).toString('base64'), warn() {} });
    const targets = new DeployTargetStore({ database, keyRing, dataDir: dir });
    const targetId = targets.createTarget({ name: 'target', engine: 'docker' }).id;
    const userId = database.upsertGitHubUser({ githubId: '2', githubLogin: 'ada' }).id;
    const projects = new ProjectStore({ database, keyRing });
    const p = projects.createProject({ ownerUserId: userId, name: 'one', targetId });
    assert.deepStrictEqual(projects.projectIdsForTarget(targetId), [p.id]);
    database.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claims stop/reclaim only after atomically re-reading state and idle age', function () {
    const dir = root(); const database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 5).toString('base64'), warn() {} });
    const userId = database.upsertGitHubUser({ githubId: '3', githubLogin: 'ada' }).id;
    const projects = new ProjectStore({ database, keyRing });
    const p = projects.createProject({ ownerUserId: userId, name: 'one' });
    const idle = projects.createProject({ ownerUserId: userId, name: 'idle' });
    projects.touchActivity(idle.id, new Date(0));
    assert.strictEqual(projects.tryClaimIdleReclaim({ projectId: idle.id, ownerUserId: userId, idleBefore: new Date(1) }).ok, true);
    assert.strictEqual(projects.getProject(idle.id).rebuildRequired, true, 'idle claim commits rebuild cause atomically');
    projects.setState(p.id, 'running');
    const fresh = projects.getProject(p.id);
    assert.strictEqual(projects.tryClaimStop({ projectId: p.id, ownerUserId: userId, idleBefore: new Date(new Date(fresh.lastActivityAt).getTime() - 1) }).reason, 'not_idle');
    assert.strictEqual(projects.tryClaimIdleReclaim({ projectId: p.id, ownerUserId: userId, idleBefore: new Date(Date.now() + 1000) }).reason, 'invalid_state');
    assert.strictEqual(projects.tryClaimStop({ projectId: p.id, ownerUserId: userId, idleBefore: new Date(Date.now() + 1000) }).ok, true);
    assert.strictEqual(projects.getProject(p.id).state, 'reclaiming');
    database.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores dirty work after a failed push so a retry can preserve it', async function () {
    let failPush = true; let restored = false; const calls = []; const identities = [];
    const e = engine({ async exec(spec, _cmd, args) {
      identities.push(spec.identity);
      calls.push(args);
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/mutable-origin.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef012345\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('ls-remote')) return { stdout: '', stderr: '' };
      if (args.includes('push') && failPush) { failPush = false; throw new Error('push denied'); }
      return { stdout: '', stderr: '' };
    } });
    const options = { engine: e, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: '/workspace/repo', repoUrl: 'https://example.test/repo.git', credential: 'owner-secret', author: { name: 'Ada', email: 'ada@example.test' } };
    await assert.rejects(() => preserveProjectWork(options), /push denied/);
    assert.strictEqual(calls.some((args) => args.includes('reset') || args.includes('commit')), false, 'HEAD and the real index are never changed');
    const retried = await preserveProjectWork(options);
    assert.strictEqual(retried.preserved, true);
    assert.ok(calls.filter((args) => args.includes('push')).length === 2, 'retry pushes the restored work');
    const credentialed = calls.filter((args) => args.some((arg) => arg.includes('owner-secret')));
    assert.ok(credentialed.every((args) => args.includes('ls-remote') || args.includes('push')));
    assert.ok(credentialed.every((args) => args.includes('https://example.test/repo.git')));
    assert.ok(credentialed.every((args) => !args.includes('https://example.test/mutable-origin.git')));
    const preservationCommit = calls.find((args) => args.includes('commit-tree'));
    assert.ok(preservationCommit.includes('core.hooksPath=/dev/null'));
    assert.ok(preservationCommit.includes('commit.gpgSign=false'));
    assert.ok(identities.length > 0 && identities.every((identity) => identity === 'box-id'));
  });

  it('uses an atomic expected-absent WIP ref and retries only a proven collision', async function () {
    const calls = []; let pushes = 0;
    const e = engine({ async exec(_spec, _cmd, args) {
      calls.push(args);
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/repo.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push') && pushes++ === 0) throw new Error('stale info rejected');
      if (args.includes('ls-remote')) return { stdout: 'abcdef\trefs/heads/cc-web/wip/2026-01-02-abc\n', stderr: '' };
      return { stdout: '', stderr: '' };
    } });
    const result = await preserveProjectWork({ engine: e, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: '/workspace/repo', repoUrl: 'https://example.test/repo.git', author: { name: 'Ada', email: 'ada@example.test' }, now: () => new Date('2026-01-02T00:00:00Z') });
    assert.match(result.branch, /-1$/);
    const firstPush = calls.find((args) => args.includes('push'));
    assert.ok(firstPush.some((arg) => arg === '--force-with-lease=refs/heads/cc-web/wip/2026-01-02-abc:'));
    assert.ok(calls.findIndex((args) => args.includes('push')) < calls.findIndex((args) => args.includes('ls-remote')));
    assert.strictEqual(calls.some((args) => args.includes('reset') || args.includes('commit')), false);
  });

  it('pushes a WIP commit without changing HEAD, the real index, or dirty work', async function () {
    const dir = root(); const repo = path.join(dir, 'repo'); const remote = path.join(dir, 'remote.git'); fs.mkdirSync(repo);
    execFileSync('git', ['init', '--bare', remote]);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init'); git('config', 'user.name', 'Owner'); git('config', 'user.email', 'owner@example.test');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base'); git('add', '-A'); git('commit', '-m', 'base');
    git('remote', 'add', 'origin', 'https://example.test/repo.git');
    const hook = path.join(repo, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\ngit checkout -B hook-moved\n'); fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'unstaged');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged'); git('add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked');
    const beforeHead = git('rev-parse', 'HEAD'); const beforeStatus = git('status', '--porcelain=v1');
    const e = engine({ async exec(spec, command, args) {
      if (command === 'rm') { fs.rmSync(args[args.length - 1], { force: true }); return { stdout: '', stderr: '' }; }
      // Keep the durable HTTP origin intact for origin validation, but route
      // this fixture's one network operation to a local bare repository.
      const executedArgs = args.includes('push')
        ? args.map((arg) => arg === 'https://example.test/repo.git' ? `file://${remote}` : arg)
        : args;
      return { stdout: execFileSync(command, executedArgs, { encoding: 'utf8', env: { ...process.env, ...(spec.env || {}) } }), stderr: '' };
    } });
    const result = await preserveProjectWork({ engine: e, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: repo, repoUrl: 'https://example.test/repo.git', author: { name: 'Ada', email: 'ada@example.test' } });
    assert.strictEqual(git('rev-parse', 'HEAD'), beforeHead);
    assert.strictEqual(git('status', '--porcelain=v1'), beforeStatus);
    assert.notStrictEqual(git('branch', '--show-current').trim(), 'hook-moved');
    assert.strictEqual(git('cat-file', '-t', result.commit).trim(), 'commit');
    assert.match(execFileSync('git', ['--git-dir', remote, 'show-ref', result.branch], { encoding: 'utf8' }), new RegExp(result.commit));
  });

  it('aborts a timed-out preservation network subprocess', async function () {
    let signal; const e = engine({ async exec(spec, _cmd, args) {
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/repo.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push')) { signal = spec.signal; return new Promise(() => {}); }
      return { stdout: '', stderr: '' };
    } });
    await assert.rejects(() => preserveProjectWork({ engine: e, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: '/workspace/repo', repoUrl: 'https://example.test/repo.git', author: { name: 'Ada', email: 'ada@example.test' }, timeoutMs: 1 }), /timed out/);
    assert.strictEqual(signal.aborted, true);
  });

  it('bounds repeated atomic WIP collisions and aborts a hanging local git command', async function () {
    let pushes = 0; const collisionEngine = engine({ async exec(_spec, _cmd, args) {
      if (args.includes('status')) return { stdout: ' M work.txt\n', stderr: '' };
      if (args.includes('remote')) return { stdout: 'https://example.test/repo.git\n', stderr: '' };
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abcdef\n', stderr: '' };
      if (args.includes('write-tree')) return { stdout: 'tree-id\n', stderr: '' };
      if (args.includes('commit-tree')) return { stdout: 'wip-commit\n', stderr: '' };
      if (args.includes('push')) { pushes += 1; throw new Error('stale info'); }
      if (args.includes('ls-remote')) return { stdout: 'taken\n', stderr: '' };
      return { stdout: '', stderr: '' };
    } });
    await assert.rejects(() => preserveProjectWork({ engine: collisionEngine, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: '/workspace/repo', repoUrl: 'https://example.test/repo.git', author: { name: 'Ada', email: 'ada@example.test' } }), /collision limit/);
    assert.strictEqual(pushes, 9);

    let localSignal; const hanging = engine({ async exec(spec, _cmd, args) {
      if (args.includes('status')) { localSignal = spec.signal; return new Promise(() => {}); }
      return { stdout: '', stderr: '' };
    } });
    await assert.rejects(() => preserveProjectWork({ engine: hanging, containerName: 'box', containerIdentity: 'box-id', repoContainerPath: '/workspace/repo', repoUrl: 'https://example.test/repo.git', author: { name: 'Ada', email: 'ada@example.test' }, timeoutMs: 1 }), /timed out/);
    assert.strictEqual(localSignal.aborted, true);
  });
});
