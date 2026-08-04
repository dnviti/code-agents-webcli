const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EnvironmentManager,
  createContainerConfig,
  LOGIN_LABEL,
  MANAGED_LABEL,
  TARGET_LABEL,
  USER_ID_LABEL,
} = require('../dist/server/services/environments/index.js');

// Deploy targets place each user's container on one of several engines, and
// later edits — a switch of the active target, an edit, a deletion — must
// never strand the containers a target already produced. These tests drive
// the manager with one fake engine per target and assert which engine every
// operation reaches.

/** An engine that records operations and answers with scripted responses. */
function fakeEngine(kind, overrides = {}) {
  const calls = [];
  const known = new Map();
  const engine = {
    kind,
    binary: kind,
    calls,
    async ensure(spec) {
      calls.push({ op: 'ensure', spec });
      const current = known.get(spec.name);
      if (current) {
        known.set(spec.name, { ...current, status: 'running' });
        return { created: false };
      }
      return { created: true };
    },
    async create(spec) { calls.push({ op: 'create', spec }); },
    async start(name) { calls.push({ op: 'start', name }); },
    async stop(name) { calls.push({ op: 'stop', name }); },
    async remove(name) { calls.push({ op: 'remove', name }); },
    async status() { return 'running'; },
    async describe(name) { return known.get(name) || null; },
    async describeStrict(name) { return this.describe(name); },
    async exec(spec) { calls.push({ op: 'exec', spec }); return { stdout: 'sh\n', stderr: '' }; },
    execArgs: (spec, command, args) => ['exec', spec.identity || spec.name, command, ...args],
    async list() { return []; },
    async available() { calls.push({ op: 'available' }); return true; },
    async resize(name, cpus, memory) { calls.push({ op: 'resize', name, cpus, memory }); return true; },
    async usage(name) { calls.push({ op: 'usage', name }); return null; },
    ...overrides,
  };
  engine.ensureIdentity = async (spec, expected) => {
    const before = await engine.describeStrict(spec.name);
    if (expected && (!before || before.identity !== expected.identity)) {
      throw new Error(`container ${spec.name} was replaced before ensure`);
    }
    if (!expected && before) throw new Error(`container ${spec.name} appeared before creation`);
    if (before && !known.has(spec.name)) known.set(spec.name, before);
    const result = await engine.ensure(spec);
    let current = known.get(spec.name);
    if (!current) {
      current = {
        name: spec.name,
        identity: `${kind}-${spec.name}-id`,
        status: 'running',
        image: spec.image,
        labels: { ...spec.labels },
      };
      known.set(spec.name, current);
    }
    if (expected && current.identity !== expected.identity) {
      throw new Error(`container ${spec.name} changed during ensure`);
    }
    return { created: result.created, identity: current.identity };
  };
  engine.stopIdentity = async (description) => {
    await engine.stop(description.identity);
    const current = known.get(description.name);
    if (current && current.identity !== description.identity) {
      throw new Error(`container ${description.name} was replaced during stop`);
    }
    if (current) known.set(description.name, { ...current, status: 'exited' });
  };
  engine.removeIdentity = async (description) => {
    await engine.remove(description.identity);
    const current = known.get(description.name);
    if (current && current.identity !== description.identity) {
      throw new Error(`container ${description.name} was replaced during removal`);
    }
    if (current) known.delete(description.name);
  };
  engine.replaceForTest = (name, description) => known.set(name, { name, ...description });
  engine.descriptionForTest = (name) => known.get(name) || null;
  return engine;
}

/** Any call to this is a failure: unplaceable work must touch nothing. */
function forbiddenEngine() {
  const fail = (op) => () => {
    throw new Error(`the ${op} engine call was made although no target is active`);
  };
  return {
    kind: 'docker',
    binary: 'docker',
    ensure: fail('ensure'),
    ensureIdentity: fail('ensureIdentity'),
    create: fail('create'),
    start: fail('start'),
    stop: fail('stop'),
    remove: fail('remove'),
    stopIdentity: fail('stopIdentity'),
    removeIdentity: fail('removeIdentity'),
    status: fail('status'),
    describe: fail('describe'),
    describeStrict: fail('describeStrict'),
    exec: fail('exec'),
    execArgs: fail('execArgs'),
    list: fail('list'),
    available: fail('available'),
    resize: fail('resize'),
    usage: fail('usage'),
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-multi-'));
}

function targetConfig(overrides = {}) {
  return {
    ...createContainerConfig({ containers: true }, {}),
    rootDir: tmpRoot(),
    ...overrides,
  };
}

const TARGET_A = 'a1b2c3d4-0000-4000-8000-aaaaaaaaaaaa';
const TARGET_B = 'b1b2c3d4-0000-4000-8000-bbbbbbbbbbbb';

/**
 * A manager over two targets whose active key the test flips by assignment,
 * the same way a settings save flips it on a running server.
 */
function multiManager() {
  const state = { activeKey: TARGET_A };
  const engines = new Map([
    ['legacy', fakeEngine('docker')],
    [TARGET_A, fakeEngine('docker')],
    [TARGET_B, fakeEngine('podman')],
  ]);
  const configs = new Map([
    ['legacy', targetConfig()],
    [TARGET_A, targetConfig()],
    [TARGET_B, targetConfig()],
  ]);
  const manager = new EnvironmentManager({
    config: configs.get('legacy'),
    engine: engines.get('legacy'),
    hostHome: '/srv/work',
    resolveActive: () => {
      if (!state.activeKey) {
        return null;
      }
      const config = configs.get(state.activeKey);
      return config ? { key: state.activeKey, config, name: state.activeKey } : null;
    },
    engines,
    configs,
  });
  return { manager, state, engines, configs };
}

function managedDescription(name, targetKey, userId = 1) {
  return {
    name,
    identity: `${name}-id`,
    status: 'running',
    image: 'img',
    labels: {
      [MANAGED_LABEL]: 'true',
      [USER_ID_LABEL]: String(userId),
      ...(targetKey ? { [TARGET_LABEL]: targetKey } : {}),
    },
  };
}

describe('multi-target environments', function () {
  it('places new work on the active target and labels the container with it', async function () {
    const { manager, engines } = multiManager();
    const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });

    assert.strictEqual(env.kind, 'container');
    const ensure = engines.get(TARGET_A).calls.find((c) => c.op === 'ensure');
    assert.ok(ensure, 'the active target’s engine must create the container');
    assert.strictEqual(ensure.spec.labels[TARGET_LABEL], TARGET_A);
    assert.strictEqual(ensure.spec.labels[MANAGED_LABEL], 'true');
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0);
    assert.strictEqual(engines.get('legacy').calls.length, 0);
    assert.strictEqual(manager.targetKeyForContainer(env.name), TARGET_A);
  });

  it('moves new work when the active target switches, and only new work', async function () {
    const { manager, state, engines } = multiManager();
    await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    state.activeKey = TARGET_B;

    const env = await manager.ensureFor({ id: 2, githubLogin: 'bob' });
    assert.strictEqual(
      engines.get(TARGET_B).calls.find((c) => c.op === 'ensure').spec.labels[TARGET_LABEL],
      TARGET_B,
    );
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'ensure').length, 1);
    assert.strictEqual(manager.targetKeyForContainer(env.name), TARGET_B);
  });

  it('keeps a user on their original target when the active one switches mid-session', async function () {
    const { manager, state, engines } = multiManager();
    const first = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    state.activeKey = TARGET_B;
    engines.get(TARGET_A).calls.length = 0;

    // Re-ensuring the same user must converge on the container they already
    // have: creating a same-named twin on the newly active target would
    // orphan the original and put two writers on one shared $HOME.
    const again = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    assert.strictEqual(again.name, first.name);
    const ensuredOnA = engines.get(TARGET_A).calls.filter((c) => c.op === 'ensure');
    assert.strictEqual(ensuredOnA.length, 1, 'the existing container is re-ensured where it was created');
    assert.strictEqual(ensuredOnA[0].spec.labels[TARGET_LABEL], TARGET_A);
    assert.strictEqual(
      engines.get(TARGET_B).calls.filter((c) => c.op === 'ensure').length,
      0,
      'nothing new is placed for this user on the active target',
    );
    assert.strictEqual(manager.targetKeyForContainer(again.name), TARGET_A);

    // …while a brand-new user still lands on the newly active target.
    const fresh = await manager.ensureFor({ id: 2, githubLogin: 'bob' });
    assert.strictEqual(manager.targetKeyForContainer(fresh.name), TARGET_B);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((c) => c.op === 'ensure').length, 1);
  });

  it('rediscovers an existing container on its original target after a restart', async function () {
    const { manager, state, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    state.activeKey = TARGET_B;
    engines.get(TARGET_A).list = async () => [name];
    engines.get(TARGET_A).describeStrict = async () => managedDescription(name, TARGET_A);

    const env = await manager.ensureFor(owner);

    assert.strictEqual(env.name, name);
    assert.strictEqual(manager.targetKeyForContainer(name), TARGET_A);
    assert.strictEqual(
      engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length,
      1,
      'the pre-restart container is re-ensured on the target that owns it',
    );
    assert.strictEqual(
      engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length,
      0,
      'the newly active target receives no same-named copy',
    );
  });

  it('single-flights restart discovery for concurrent ensures of one user', async function () {
    const { manager, state, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    state.activeKey = TARGET_B;

    let releaseScan;
    let markScanEntered;
    const scanGate = new Promise((resolve) => { releaseScan = resolve; });
    const scanEntered = new Promise((resolve) => { markScanEntered = resolve; });
    let scans = 0;
    engines.get(TARGET_A).list = async () => {
      scans += 1;
      markScanEntered();
      await scanGate;
      return [name];
    };
    engines.get(TARGET_A).describeStrict = async () => managedDescription(name, TARGET_A);

    const first = manager.ensureFor(owner);
    await scanEntered;
    const second = manager.ensureFor(owner);
    releaseScan();
    const [firstEnvironment, secondEnvironment] = await Promise.all([first, second]);

    assert.strictEqual(scans, 1, 'both callers share the all-target discovery');
    assert.strictEqual(firstEnvironment, secondEnvironment);
    assert.strictEqual(
      engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length,
      1,
      'both callers share provisioning too',
    );
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('deduplicates legacy and seeded-target views of the same container', async function () {
    const { manager, state, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    state.activeKey = TARGET_B;

    // A legacy startup engine and the target seeded from it can point at the
    // same daemon. Both see the same object, whose durable label identifies
    // one logical placement rather than two duplicate containers.
    for (const key of ['legacy', TARGET_A]) {
      engines.get(key).list = async () => [name];
      engines.get(key).describeStrict = async () => managedDescription(name, TARGET_A);
    }

    await manager.ensureFor(owner);

    assert.strictEqual(manager.targetKeyForContainer(name), TARGET_A);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 1);
    assert.strictEqual(engines.get('legacy').calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('keeps old unlabeled containers on the persisted seeded target after a reload', async function () {
    const { manager, state, engines, configs } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    state.activeKey = TARGET_B;

    // The server's rebuilt maps contain database targets only. Legacy is a
    // synthetic route the manager must preserve itself across this reload.
    manager.reloadTargets({
      engines: new Map([[TARGET_A, engines.get(TARGET_A)], [TARGET_B, engines.get(TARGET_B)]]),
      configs: new Map([[TARGET_A, configs.get(TARGET_A)], [TARGET_B, configs.get(TARGET_B)]]),
      activeKey: TARGET_B,
    });

    // Before deploy-target labels existed, both the startup engine and the
    // target seeded from it could see this managed object, but its logical
    // placement follows the persisted target, which remains valid even if the
    // startup flags are removed on a later restart.
    for (const key of ['legacy', TARGET_A]) {
      engines.get(key).list = async () => [name];
      engines.get(key).describeStrict = async () => managedDescription(name, null);
    }

    await manager.ensureFor(owner);

    assert.strictEqual(manager.reachableEngines().get('legacy'), engines.get('legacy'));
    assert.strictEqual(manager.targetKeyForContainer(name), TARGET_A);
    assert.strictEqual(engines.get('legacy').calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('routes an unlabeled upgrade container through the seeded target when legacy is disabled', async function () {
    const legacyConfig = { ...createContainerConfig({}, {}), rootDir: tmpRoot() };
    const legacyEngine = fakeEngine('docker');
    const targetA = targetConfig({ engine: 'podman' });
    const targetB = targetConfig();
    const engineA = fakeEngine('podman');
    const engineB = fakeEngine('docker');
    const owner = { id: 1, githubLogin: 'ada' };
    const name = 'cawc-ada-1';
    engineA.list = async () => [name];
    engineA.describeStrict = async () => managedDescription(name, null);

    const manager = new EnvironmentManager({
      config: legacyConfig,
      engine: legacyEngine,
      hostHome: '/srv/work',
      resolveActive: () => ({ key: TARGET_B, config: targetB, name: TARGET_B }),
      engines: new Map([[TARGET_A, engineA], [TARGET_B, engineB]]),
      configs: new Map([[TARGET_A, targetA], [TARGET_B, targetB]]),
    });

    await manager.ensureFor(owner);

    assert.strictEqual(manager.targetKeyForContainer(name), TARGET_A);
    assert.strictEqual(engineA.calls.filter((call) => call.op === 'ensure').length, 1);
    assert.strictEqual(engineB.calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(legacyEngine.calls.length, 0, 'disabled legacy is neither searched nor used');
  });

  it('commits an observed engine snapshot when targets reload during discovery', async function () {
    const { manager, state, engines, configs } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    state.activeKey = TARGET_B;

    let releaseScan;
    let markScanEntered;
    const scanGate = new Promise((resolve) => { releaseScan = resolve; });
    const scanEntered = new Promise((resolve) => { markScanEntered = resolve; });
    const engineA = engines.get(TARGET_A);
    engineA.list = async () => {
      markScanEntered();
      await scanGate;
      return [name];
    };
    engineA.describeStrict = async () => managedDescription(name, TARGET_A);

    const pending = manager.ensureFor(owner);
    await scanEntered;
    manager.reloadTargets({
      engines: new Map([[TARGET_B, engines.get(TARGET_B)]]),
      configs: new Map([[TARGET_B, configs.get(TARGET_B)]]),
      activeKey: TARGET_B,
    });
    releaseScan();
    await pending;

    assert.strictEqual(manager.targetKeyForContainer(name), TARGET_A);
    assert.strictEqual(engineA.calls.filter((call) => call.op === 'ensure').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(manager.reachableEngines().get(TARGET_A), engineA);
  });

  it('rejects a container whose target label disagrees with the engine that found it', async function () {
    const { manager, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    engines.get(TARGET_B).list = async () => [name];
    engines.get(TARGET_B).describeStrict = async () => managedDescription(name, TARGET_A);

    await assert.rejects(manager.ensureFor(owner), /labeled for deploy target.*found on/);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('rejects same-named containers on different logical targets', async function () {
    const { manager, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    for (const key of [TARGET_A, TARGET_B]) {
      engines.get(key).list = async () => [name];
      engines.get(key).describeStrict = async () => managedDescription(name, key);
    }

    await assert.rejects(manager.ensureFor(owner), /exists on multiple deploy targets/);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 0);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('rejects same-named containers on old and replacement endpoints for one target', async function () {
    const { manager, engines, configs } = multiManager();

    // Give target A a trusted live placement so its exact old engine remains
    // searchable after an administrator edits A to point at a new endpoint.
    await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    const oldEngineA = engines.get(TARGET_A);
    const replacementEngineA = fakeEngine('docker');
    manager.reloadTargets({
      engines: new Map([
        ['legacy', engines.get('legacy')],
        [TARGET_A, replacementEngineA],
        [TARGET_B, engines.get(TARGET_B)],
      ]),
      configs,
      activeKey: TARGET_A,
    });

    const owner = { id: 2, githubLogin: 'bob' };
    const name = manager.nameFor(owner);
    for (const engine of [oldEngineA, replacementEngineA]) {
      engine.list = async () => [name];
      engine.describeStrict = async () => managedDescription(name, TARGET_A, owner.id);
    }

    await assert.rejects(
      manager.ensureFor(owner),
      /exists on multiple engine endpoints for deploy target/,
    );
    assert.strictEqual(oldEngineA.calls.filter((call) => call.op === 'ensure').length, 1);
    assert.strictEqual(replacementEngineA.calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('rejects a discovered same-name container owned by another user', async function () {
    const { manager, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    engines.get(TARGET_A).list = async () => [name];
    engines.get(TARGET_A).describeStrict = async () => managedDescription(name, TARGET_A, 2);

    await assert.rejects(manager.ensureFor(owner), /belongs to another user/);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('fails closed when an inactive target cannot be searched after restart', async function () {
    const { manager, state, engines } = multiManager();
    state.activeKey = TARGET_B;
    engines.get(TARGET_A).list = async () => {
      throw new Error('target is offline');
    };

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /cannot safely place environment.*target is offline/,
    );
    assert.strictEqual(
      engines.get(TARGET_B).calls.filter((call) => call.op === 'ensure').length,
      0,
      'absence on the offline target was not provable, so no duplicate is created',
    );
  });

  it('does not adopt an unmanaged same-name object on the active target', async function () {
    const { manager, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    engines.get(TARGET_A).describeStrict = async () => ({
      name,
      identity: `${name}-id`,
      status: 'running',
      image: 'unrelated',
      labels: {},
    });

    await assert.rejects(manager.ensureFor(owner), /is not managed by this server/);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('revalidates ownership even after a route has been learned', async function () {
    const { manager, engines } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    const name = manager.nameFor(owner);
    const engineA = engines.get(TARGET_A);
    await manager.ensureFor(owner);
    const ensuredBefore = engineA.calls.filter((call) => call.op === 'ensure').length;

    // Simulate an operator replacing the object behind a still-known name.
    engineA.describeStrict = async () => ({
      name,
      identity: `${name}-replacement-id`,
      status: 'running',
      image: 'unrelated',
      labels: {},
    });

    await assert.rejects(manager.ensureFor(owner), /is not managed by this server/);
    assert.strictEqual(engineA.calls.filter((call) => call.op === 'ensure').length, ensuredBefore);
  });

  it('treats a strict collision-inspection failure as an error, not absence', async function () {
    const { manager, engines } = multiManager();
    const engineA = engines.get(TARGET_A);
    engineA.describeStrict = async () => {
      throw new Error('inspect authentication failed');
    };

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /inspect authentication failed/,
    );
    assert.strictEqual(engineA.calls.filter((call) => call.op === 'ensure').length, 0);
  });

  it('keeps operating existing containers on the engine that placed them', async function () {
    const { manager, state, engines } = multiManager();
    const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    state.activeKey = TARGET_B;
    engines.get(TARGET_A).calls.length = 0;

    manager.touch(1);
    assert.strictEqual(manager.existing(1).name, env.name);

    await manager.applyTier(1, { id: 'big', label: 'Big', cpus: '8', memory: '8g' });
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'resize').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0);

    await manager.stopFor(1);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'stop').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0);

    await manager.remove(env.name);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'remove').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0);
    assert.strictEqual(manager.targetKeyForContainer(env.name), 'legacy');
  });

  it('does not adopt a same-name replacement on a retained target', async function () {
    const { manager, state, engines } = multiManager();
    const environment = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    state.activeKey = TARGET_B;
    const engineA = engines.get(TARGET_A);
    engineA.replaceForTest(environment.name, {
      identity: 'replacement-id',
      status: 'running',
      image: 'img',
      labels: {
        [MANAGED_LABEL]: 'true',
        [USER_ID_LABEL]: '1',
        [LOGIN_LABEL]: 'ada',
        [TARGET_LABEL]: TARGET_A,
      },
    });
    engineA.calls.length = 0;

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /replaced before ensure/,
    );
    await assert.rejects(manager.stopFor(1), /same-name container was replaced/);
    await assert.rejects(manager.remove(environment.name), /same-name container was replaced/);
    assert.strictEqual(
      engineA.calls.some((call) => ['ensure', 'start', 'stop', 'remove', 'resize', 'exec'].includes(call.op)),
      false,
    );
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0, 'replacement never reroutes to active target');
  });

  it('does not trust listing labels as routes for destructive operations', async function () {
    const { manager, state, engines } = multiManager();
    engines.get(TARGET_A).list = async () => ['cawc-ada-1'];
    engines.get(TARGET_A).describe = async (name) => ({
      name,
      identity: `${name}-id`,
      status: 'running',
      image: 'img',
      // The object was observed through A but claims B. list() is an operator
      // view and must not let that unverified claim steer a later remove().
      labels: { [TARGET_LABEL]: TARGET_B },
    });

    const list = await manager.list();
    assert.deepStrictEqual(list.map((e) => e.name), ['cawc-ada-1']);
    assert.strictEqual(state.activeKey, TARGET_A);

    await assert.rejects(manager.remove('cawc-ada-1'), /deploy target has not been verified/);
    for (const engine of engines.values()) {
      assert.strictEqual(engine.calls.filter((call) => call.op === 'remove').length, 0);
    }
  });

  it('reports listed ownership and owner homes without adopting destructive routes', async function () {
    const { manager, state, engines, configs } = multiManager();
    engines.get(TARGET_A).list = async () => ['cawc-ada-1'];
    engines.get(TARGET_A).describe = async (name) => ({
      name,
      identity: `${name}-id`,
      status: 'running',
      image: 'img',
      labels: {
        [MANAGED_LABEL]: 'true',
        [USER_ID_LABEL]: '1',
        [LOGIN_LABEL]: 'ada',
        [TARGET_LABEL]: TARGET_A,
      },
    });
    // A container old enough to predate the label belongs to the legacy engine.
    engines.get('legacy').list = async () => ['cawc-cid-3'];
    engines.get('legacy').describe = async (name) => ({
      name,
      identity: `${name}-id`,
      status: 'running',
      image: 'img',
      labels: {
        [MANAGED_LABEL]: 'true',
        [USER_ID_LABEL]: '3',
        [LOGIN_LABEL]: 'cid',
      },
    });

    const list = await manager.list();
    const byName = new Map(list.map((environment) => [environment.name, environment]));
    assert.deepStrictEqual([...byName.keys()].sort(), ['cawc-ada-1', 'cawc-cid-3']);
    assert.deepStrictEqual(
      [byName.get('cawc-ada-1').userId, byName.get('cawc-ada-1').githubLogin],
      [1, 'ada'],
    );
    assert.strictEqual(
      byName.get('cawc-ada-1').homeDir,
      path.join(configs.get(TARGET_A).rootDir, 'cawc-ada-1'),
    );
    assert.deepStrictEqual(
      [byName.get('cawc-cid-3').userId, byName.get('cawc-cid-3').githubLogin],
      [3, 'cid'],
    );
    assert.strictEqual(
      byName.get('cawc-cid-3').homeDir,
      path.join(configs.get('legacy').rootDir, 'cawc-cid-3'),
    );
    assert.strictEqual(state.activeKey, TARGET_A);

    await assert.rejects(manager.remove('cawc-ada-1'), /deploy target has not been verified/);
    await assert.rejects(manager.remove('cawc-cid-3'), /deploy target has not been verified/);
    for (const engine of engines.values()) {
      assert.strictEqual(engine.calls.filter((call) => call.op === 'remove').length, 0);
    }
  });

  it('uses the host when targets exist but none is active, and touches no engine', async function () {
    const { manager, state } = multiManager();
    state.activeKey = null;

    const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    assert.strictEqual(env.kind, 'host');
  });

  it('reports disabled-container mode when targets exist but none is active', async function () {
    const manager = new EnvironmentManager({
      config: createContainerConfig({}, {}), // legacy startup config disabled
      engine: forbiddenEngine(),
      hostHome: '/srv/work',
      resolveActive: () => null, // targets exist, none active
      engines: new Map(),
      configs: new Map(),
    });

    assert.strictEqual(manager.enabled, false);
    assert.strictEqual((await manager.ensureFor({ id: 1, githubLogin: 'ada' })).kind, 'host');
  });

  it('contacts no engine when the legacy resolution is disabled (empty targets table)', async function () {
    // The disabled path must stay exactly what it was before targets existed:
    // the host for everyone, and not one engine call — the forbidden engine
    // throws on any contact, so passing at all proves none was made.
    const config = createContainerConfig({}, {});
    const engine = forbiddenEngine();
    const manager = new EnvironmentManager({
      config,
      engine,
      hostHome: '/srv/work',
      resolveActive: () => ({ key: 'legacy', config, name: 'startup configuration' }),
      engines: new Map([['legacy', engine]]),
      configs: new Map([['legacy', config]]),
    });

    assert.strictEqual(manager.enabled, false);
    const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
    assert.strictEqual(env.kind, 'host');
    assert.strictEqual(manager.existing(1), env, 'existing() returns the host when disabled, as before');
  });

  it('does not contact an engine when no target is active', async function () {
    const config = targetConfig();
    const manager = new EnvironmentManager({
      config,
      engine: forbiddenEngine(),
      hostHome: '/srv/work',
      resolveActive: () => null,
      engines: new Map(),
      configs: new Map(),
    });
    assert.strictEqual((await manager.ensureFor({ id: 1, githubLogin: 'ada' })).kind, 'host');
  });

  it('throws when the active target’s engine is unreachable', async function () {
    const { manager, engines } = multiManager();
    engines.get(TARGET_A).available = async () => false;

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      new RegExp(`deploy target '${TARGET_A}' is unreachable`),
    );
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'ensure').length, 0);
  });

  it('retains engines with live containers across a reload', async function () {
    const { manager, state, engines, configs } = multiManager();
    const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });

    // The administrator deletes target A and activates B in one save: the
    // store flips first (the resolver reads the new active key), then the
    // manager receives the new engine set.
    state.activeKey = TARGET_B;
    manager.reloadTargets({
      engines: new Map([['legacy', engines.get('legacy')], [TARGET_B, engines.get(TARGET_B)]]),
      configs: new Map([['legacy', configs.get('legacy')], [TARGET_B, configs.get(TARGET_B)]]),
      activeKey: TARGET_B,
    });
    engines.get(TARGET_A).calls.length = 0;

    // The retained engine is part of the authoritative set an in-use check
    // must ask: a delete that only saw the current targets would miss A's
    // container entirely.
    assert.strictEqual(manager.reachableEngines().get(TARGET_A), engines.get(TARGET_A));

    // Existing work on the deleted target is still reachable…
    await manager.stopFor(1);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'stop').length, 1);
    assert.strictEqual(engines.get(TARGET_B).calls.length, 0);

    // …but new work only ever lands on the new active target.
    const fresh = await manager.ensureFor({ id: 2, githubLogin: 'bob' });
    assert.strictEqual(manager.targetKeyForContainer(fresh.name), TARGET_B);
    assert.strictEqual(engines.get(TARGET_B).calls.filter((c) => c.op === 'ensure').length, 1);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'ensure').length, 0);
  });

  it('refreshes target policy while retaining the exact engine route', async function () {
    const { manager, engines, configs } = multiManager();
    const owner = { id: 1, githubLogin: 'ada' };
    await manager.ensureFor(owner);

    const originalEngine = engines.get(TARGET_A);
    const replacementEngine = fakeEngine('docker');
    const refreshedConfig = { ...configs.get(TARGET_A), image: 'example/new-policy:2' };
    manager.reloadTargets({
      engines: new Map([
        ['legacy', engines.get('legacy')],
        [TARGET_A, replacementEngine],
        [TARGET_B, engines.get(TARGET_B)],
      ]),
      configs: new Map([
        ['legacy', configs.get('legacy')],
        [TARGET_A, refreshedConfig],
        [TARGET_B, configs.get(TARGET_B)],
      ]),
      activeKey: TARGET_A,
    });
    originalEngine.calls.length = 0;

    await manager.ensureFor(owner);

    const ensured = originalEngine.calls.find((call) => call.op === 'ensure');
    assert.strictEqual(ensured.spec.image, 'example/new-policy:2');
    assert.strictEqual(
      replacementEngine.calls.filter((call) => call.op === 'ensure').length,
      0,
      'existing work keeps its exact endpoint even as its policy is refreshed',
    );
  });

  it('does not misroute an ensure that is in flight across a reload', async function () {
    const { manager, state, engines, configs } = multiManager();

    // Target A's engine answers ensure slowly, so the reload below lands
    // while the container is still being created.
    let release;
    let markEnsureEntered;
    const gate = new Promise((resolve) => { release = resolve; });
    const ensureEntered = new Promise((resolve) => { markEnsureEntered = resolve; });
    const engineA = engines.get(TARGET_A);
    engineA.ensure = async (spec) => {
      engineA.calls.push({ op: 'ensure', spec });
      markEnsureEntered();
      await gate;
      return { created: true };
    };

    const pending = manager.ensureFor({ id: 1, githubLogin: 'ada' });
    // Let the ensure reach the gate: the placement must already be registered
    // by then, or the reload would strand the half-created container.
    await ensureEntered;
    assert.strictEqual(engineA.calls.filter((c) => c.op === 'ensure').length, 1);

    state.activeKey = TARGET_B;
    manager.reloadTargets({
      engines: new Map([['legacy', engines.get('legacy')], [TARGET_B, engines.get(TARGET_B)]]),
      configs: new Map([['legacy', configs.get('legacy')], [TARGET_B, configs.get(TARGET_B)]]),
      activeKey: TARGET_B,
    });

    release();
    const env = await pending;
    assert.strictEqual(manager.targetKeyForContainer(env.name), TARGET_A);
    assert.strictEqual(manager.reachableEngines().get(TARGET_A), engineA,
      'the reload retained the engine the in-flight ensure was using');

    await manager.stopFor(1);
    assert.strictEqual(engineA.calls.filter((c) => c.op === 'stop').length, 1);
  });

  it('rolls back the registered placement when provisioning fails', async function () {
    const { manager, engines } = multiManager();
    engines.get(TARGET_A).ensure = async () => {
      throw new Error('engine exploded mid-create');
    };

    await assert.rejects(manager.ensureFor({ id: 1, githubLogin: 'ada' }), /engine exploded/);
    const name = manager.nameFor({ id: 1, githubLogin: 'ada' });
    assert.strictEqual(
      manager.targetKeyForContainer(name),
      'legacy',
      'a failed ensure leaves no route to a container that never came up',
    );
  });

  it('throws for an active key with no reachable engine instead of falling back', async function () {
    // A stale resolution must fail loudly: silently substituting the startup
    // engine would run the container against the wrong target.
    const ghost = targetConfig();
    const manager = new EnvironmentManager({
      config: targetConfig(),
      engine: fakeEngine('docker'),
      hostHome: '/srv/work',
      resolveActive: () => ({ key: 'ghost-target', config: ghost, name: 'ghost' }),
      engines: new Map(),
      configs: new Map([['ghost-target', ghost]]),
    });

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /no engine for deploy target 'ghost-target'/,
    );
  });

  it('treats an active key that names no target as host-local mode', async function () {
    const { manager, state } = multiManager();
    state.activeKey = 'dangling-target-id';
    assert.strictEqual((await manager.ensureFor({ id: 1, githubLogin: 'ada' })).kind, 'host');
  });

  describe('the legacy single-config path', function () {
    it('behaves exactly as before: one engine, no availability pre-check', async function () {
      const engine = fakeEngine('docker');
      const config = targetConfig();
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
      assert.strictEqual(env.kind, 'container');
      const ensure = engine.calls.find((c) => c.op === 'ensure');
      assert.ok(ensure);
      // Legacy containers identify as 'legacy' so a later migration to targets
      // can tell them apart from target-placed work.
      assert.strictEqual(ensure.spec.labels[TARGET_LABEL], 'legacy');
      // No extra engine round-trip: the single-config path must not change.
      assert.strictEqual(engine.calls.filter((c) => c.op === 'available').length, 0);
      assert.strictEqual(manager.targetKeyForContainer(env.name), 'legacy');
    });

    it('accepts an owned pre-target container with no target label', async function () {
      const engine = fakeEngine('docker');
      const config = targetConfig();
      engine.replaceForTest('cawc-legacy-41', {
        identity: 'legacy-id',
        status: 'running',
        image: config.image,
        labels: {
          [MANAGED_LABEL]: 'true',
          [USER_ID_LABEL]: '41',
          [LOGIN_LABEL]: 'legacy',
        },
      });
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      const environment = await manager.ensureFor({ id: 41, githubLogin: 'legacy' });
      assert.strictEqual(environment.identity, 'legacy-id');
      await manager.stopFor(41);
      assert.deepStrictEqual(
        engine.calls.filter((call) => call.op === 'stop').map((call) => call.name),
        ['legacy-id'],
      );
    });

    it('still returns the host environment when containers are disabled', async function () {
      const config = createContainerConfig({}, {});
      const manager = new EnvironmentManager({
        config,
        engine: forbiddenEngine(),
        hostHome: '/srv/work',
      });
      const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });
      assert.strictEqual(env.kind, 'host');
      assert.strictEqual(manager.existing(1).kind, 'host');
    });

    it('does not let an operator listing reactivate a disabled legacy container', async function () {
      const config = createContainerConfig({}, {});
      const engine = fakeEngine('docker');
      const name = 'cawc-ada-1';
      engine.list = async () => [name];
      engine.describe = async () => managedDescription(name, null);
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      await manager.list();
      const env = await manager.ensureFor({ id: 1, githubLogin: 'ada' });

      assert.strictEqual(env.kind, 'host');
      assert.strictEqual(engine.calls.filter((call) => call.op === 'ensure').length, 0);
    });
  });
});
