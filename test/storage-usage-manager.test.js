const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ADMIN_STORAGE_SCAN_CONCURRENCY,
  StorageUsageManager,
} = require('../dist/server/services/storage-usage-manager.js');
const {
  withOwnerMiseMutationLock,
  withOwnerToolVersionLock,
} = require('../dist/server/services/composition/provisioner.js');

function report(total = 10, userThreshold = null) {
  return { recordedAt: new Date().toISOString(), totalBytes: total, homeBytes: total, agentsBytes: 0, toolingBytes: 0,
    otherHomeBytes: total, projects: [], filesystems: [{ root: '/safe', capacityBytes: 100, freeBytes: 80 }],
    warnings: { user: userThreshold !== null && total >= userThreshold, admin: false, userThresholdBytes: userThreshold, adminThresholdBytes: null }, errors: [], complete: true };
}

describe('storage usage manager', () => {
  let users; let snapshots; let calls; let root;
  beforeEach(() => { users = [{ id: 1, githubLogin: 'one' }, { id: 2, githubLogin: 'two' }]; snapshots = new Map(); calls = []; root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-usage-manager-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function manager({ now = () => new Date('2026-08-03T12:00:00Z'), measure, storeOverrides = {} } = {}) {
    return new StorageUsageManager({
      database: { getUserById: (id) => users.find((user) => user.id === id) || null, listUsers: () => users, getUserSetting: (id, key) => id === 1 && key === 'deploy.usageWarnUserBytes' ? '7' : null },
      store: {
        listProjectsForUser: (id) => id === 1 ? [{ id: 'p1', name: 'one' }] : [],
        getProjectComposition: () => null,
        listInstallingCompositionsForUser: () => [],
        latestStorageUsageSnapshot: (id) => snapshots.get(id) || null,
        recordStorageUsageSnapshot(input) { const snapshot = { id: String(input.userId), createdAt: now().toISOString(), ...input }; snapshots.set(input.userId, snapshot); return snapshot; },
        usageWarnUserBytes: () => 50, usageWarnAdminBytes: () => 90,
        ...storeOverrides,
      },
      paths: { ownerHomePath: (user) => path.join(root, `home-${user.id}`), projectPaths: (project) => ({ workspacePath: path.join(root, project.id), overlayPath: path.join(root, `${project.id}-overlay`) }) },
      now,
      measure: measure || (async (input) => { calls.push(input); return report(10, input.thresholds.userWarningBytes); }),
    });
  }

  it('uses a durable hourly owner snapshot unless explicitly refreshed', async () => {
    const usage = manager();
    const first = await usage.reportForUser(1, false);
    const cached = await usage.reportForUser(1, false);
    await usage.reportForUser(1, true);
    assert.equal(first.warnings.userThresholdBytes, 7, 'per-user setting overrides deploy default');
    assert.equal(cached.totalBytes, 10);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].projects, [{ id: 'p1', name: 'one', workspacePath: path.join(root, 'p1'), overlayPath: path.join(root, 'p1-overlay') }]);
  });

  it('expires snapshots after one hour and provides installer list/detail shapes', async () => {
    let clock = new Date('2026-08-03T12:00:00Z');
    const usage = manager({ now: () => clock });
    await usage.reportForUser(1);
    clock = new Date('2026-08-03T13:00:01Z');
    await usage.reportForUser(1);
    assert.equal(calls.length, 2);
    assert.deepEqual((await usage.reportsForAdmin()).map((item) => item.login), ['one', 'two']);
    assert.equal((await usage.reportForAdmin(404)), null);
  });

  it('bounds concurrent admin scans while preserving user order', async () => {
    users = Array.from({ length: 11 }, (_, index) => ({ id: index + 1, githubLogin: `user-${index + 1}` }));
    let inFlight = 0;
    let maxInFlight = 0;
    const usage = manager({
      measure: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return report();
      },
    });

    const reports = await usage.reportsForAdmin(true);

    assert.equal(maxInFlight, ADMIN_STORAGE_SCAN_CONCURRENCY);
    assert.deepEqual(reports.map((item) => item.userId), users.map((user) => user.id));
  });

  it('clears only the opaque mise cache beneath the resolved owner home', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const cache = path.join(home, '.cache', 'code-agents', 'mise');
    fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'download'), 'x');
    const usage = manager();
    await usage.clearCache(1, 'miseDownloads');
    assert.equal(fs.existsSync(cache), false);
    assert.equal(calls.length, 1, 'cleanup refreshes the report');
  });

  it('refuses a cache cleanup path that traverses a user-created symlink', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep'), 'important');
    fs.symlinkSync(outside, path.join(home, '.cache'));
    const usage = manager();
    await assert.rejects(usage.clearCache(1, 'miseDownloads'), /symlinked storage cache/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'important');
    assert.equal(calls.length, 0, 'a refused cleanup does not claim a refreshed measurement');
  });

  it('keeps latest, active, applied, and installing recipe versions while removing an unused one', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const installs = path.join(home, '.local', 'share', 'code-agents', 'mise', 'installs', 'node');
    const versions = ['22.14.0', '20.0.0', '18.0.0', '16.0.0', '14.0.0'];
    for (const version of versions) {
      fs.mkdirSync(path.join(installs, version), { recursive: true });
      fs.writeFileSync(path.join(installs, version, 'node'), version);
    }
    const githubCli = path.join(home, '.local', 'share', 'code-agents', 'mise', 'installs', 'github-cli');
    const codex = path.join(home, '.local', 'share', 'code-agents', 'mise', 'installs', 'npm-openai-codex');
    const tea = path.join(home, '.local', 'share', 'code-agents', 'tools', 'tea');
    for (const [rootPath, toolVersions] of [
      [githubCli, ['2.97.0', '2.96.0']],
      [codex, ['0.146.0', '0.145.0']],
      [tea, ['0.15.1', '0.14.0']],
    ]) {
      for (const version of toolVersions) {
        fs.mkdirSync(path.join(rootPath, version), { recursive: true });
        fs.writeFileSync(path.join(rootPath, version, 'tool'), version);
      }
    }
    const project = {
      id: 'p1', name: 'one', compositionRevision: 'active', appliedCompositionRevision: 'applied',
    };
    const recipe = (id, version, forgeKind = null, agents = []) => ({
      id, projectId: 'p1', userId: 1, catalogVersion: 'v1',
      chosen: { runtimes: [{ runtimeId: 'node', version }], agents, forgeKind },
    });
    const recipes = new Map([
      ['latest', recipe('latest', '22.14.0', 'github', [{ runtimeId: 'codex', version: '0.146.0' }])],
      ['active', recipe('active', '20.0.0', 'gitea')],
      ['applied', recipe('applied', '18.0.0')],
      ['installing', recipe('installing', '16.0.0')],
    ]);
    const usage = manager({
      storeOverrides: {
        listProjectsForUser: (id) => id === 1 ? [project] : [],
        getProjectComposition: (_projectId, _userId, revision) => recipes.get(revision || 'latest') || null,
        listInstallingCompositionsForUser: (id) => id === 1 ? [recipes.get('installing')] : [],
      },
    });

    await usage.clearCache(1, 'unusedToolVersions');

    for (const retained of versions.slice(0, 4)) {
      assert.equal(fs.existsSync(path.join(installs, retained)), true, `${retained} remains referenced`);
    }
    assert.equal(fs.existsSync(path.join(installs, '14.0.0')), false, 'unreferenced version was removed');
    assert.equal(fs.existsSync(path.join(githubCli, '2.97.0')), true, 'latest forge client remains referenced');
    assert.equal(fs.existsSync(path.join(githubCli, '2.96.0')), false, 'unused mise forge client was removed');
    assert.equal(fs.existsSync(path.join(codex, '0.146.0')), true, 'selected agent runtime remains referenced');
    assert.equal(fs.existsSync(path.join(codex, '0.145.0')), false, 'unused agent runtime was removed');
    assert.equal(fs.existsSync(path.join(tea, '0.15.1')), true, 'active direct forge client remains referenced');
    assert.equal(fs.existsSync(path.join(tea, '0.14.0')), false, 'unused direct forge client was removed');
    assert.equal(calls.length, 1, 'cleanup refreshes the report');
  });

  it('rechecks recipe references after waiting for the shared install lock', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const installed = path.join(home, '.local', 'share', 'code-agents', 'mise', 'installs', 'node', '22.14.0');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'node'), 'installed');
    let latest = null;
    let release;
    let entered;
    const enteredLock = new Promise((resolve) => { entered = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    const holder = withOwnerToolVersionLock({ ownerHomeHost: home, tool: 'node', version: '22.14.0' }, async () => {
      entered();
      await hold;
    });
    await enteredLock;
    const project = { id: 'p1', name: 'one', compositionRevision: null, appliedCompositionRevision: null };
    const usage = manager({
      storeOverrides: {
        listProjectsForUser: (id) => id === 1 ? [project] : [],
        getProjectComposition: () => latest,
      },
    });

    const cleanup = usage.clearCache(1, 'unusedToolVersions');
    await new Promise((resolve) => setImmediate(resolve));
    latest = {
      id: 'latest', projectId: 'p1', userId: 1, catalogVersion: 'v1',
      chosen: { runtimes: [{ runtimeId: 'node', version: '22.14.0' }], forgeKind: null },
    };
    release();
    await Promise.all([holder, cleanup]);

    assert.equal(fs.existsSync(installed), true, 'reference added while cleanup waited was retained');
  });

  it('serializes mise version cleanup behind an owner-wide reshim mutation', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const installed = path.join(
      home, '.local', 'share', 'code-agents', 'mise', 'installs', 'node', '14.0.0',
    );
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'node'), 'unused');
    let entered;
    let release;
    const mutationEntered = new Promise((resolve) => { entered = resolve; });
    const holdMutation = new Promise((resolve) => { release = resolve; });
    const reshim = withOwnerMiseMutationLock(home, async () => {
      entered();
      await holdMutation;
    });
    await mutationEntered;

    const cleanup = manager().clearCache(1, 'unusedToolVersions');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(installed), true, 'cleanup crossed the owner-wide mise mutation lock');

    release();
    await Promise.all([reshim, cleanup]);
    assert.equal(fs.existsSync(installed), false);
  });

  it('does not make direct tea cleanup wait for an unrelated mise mutation', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home-1');
    const installed = path.join(
      home, '.local', 'share', 'code-agents', 'tools', 'tea', '0.14.0',
    );
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'tea'), 'unused');
    let entered;
    let release;
    const mutationEntered = new Promise((resolve) => { entered = resolve; });
    const holdMutation = new Promise((resolve) => { release = resolve; });
    const reshim = withOwnerMiseMutationLock(home, async () => {
      entered();
      await holdMutation;
    });
    await mutationEntered;

    let watchdog;
    try {
      await Promise.race([
        manager().clearCache(1, 'unusedToolVersions'),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('tea cleanup waited for mise')), 1_000);
        }),
      ]);
      assert.equal(fs.existsSync(installed), false);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release();
      await reshim;
    }
  });

  it('redacts server paths and raw filesystem errors from persisted and returned reports', async () => {
    const secretRoot = path.join(root, 'private-layout');
    const usage = manager({ measure: async () => ({
      ...report(),
      filesystems: [{ root: secretRoot, capacityBytes: 100, freeBytes: 80 }],
      errors: [{ root: secretRoot, code: 'permission', message: `EACCES: ${secretRoot}` }],
      complete: false,
    }) });
    const result = await usage.reportForUser(1, true);
    assert.equal(result.filesystems[0].root, 'durable filesystem 1');
    assert.equal(result.errors[0].root, 'durable storage');
    assert.equal(JSON.stringify(result).includes(secretRoot), false);
    assert.equal(JSON.stringify(snapshots.get(1)).includes(secretRoot), false);
  });

  it('does not require roots to exist; the scanner owns missing-root handling', async () => {
    const usage = manager({ measure: async (input) => { calls.push(input); return report(0, input.thresholds.userWarningBytes); } });
    assert.equal((await usage.reportForUser(2, true)).totalBytes, 0);
    assert.equal(calls.length, 1);
  });
});
