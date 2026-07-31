const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EnvironmentManager,
  createContainerConfig,
  MANAGED_LABEL,
  TARGET_LABEL,
} = require('../dist/server/services/environments/index.js');

// Deploy targets place each user's container on one of several engines, and
// later edits — a switch of the active target, an edit, a deletion — must
// never strand the containers a target already produced. These tests drive
// the manager with one fake engine per target and assert which engine every
// operation reaches.

/** An engine that records operations and answers with scripted responses. */
function fakeEngine(kind, overrides = {}) {
  const calls = [];
  const engine = {
    kind,
    binary: kind,
    calls,
    async ensure(spec) { calls.push({ op: 'ensure', spec }); return { created: true }; },
    async create(spec) { calls.push({ op: 'create', spec }); },
    async start(name) { calls.push({ op: 'start', name }); },
    async stop(name) { calls.push({ op: 'stop', name }); },
    async remove(name) { calls.push({ op: 'remove', name }); },
    async status() { return 'running'; },
    async describe() { return null; },
    async exec() { return { stdout: 'sh\n', stderr: '' }; },
    execArgs: (spec, command, args) => ['exec', spec.name, command, ...args],
    async list() { return []; },
    async available() { calls.push({ op: 'available' }); return true; },
    async resize(name, cpus, memory) { calls.push({ op: 'resize', name, cpus, memory }); return true; },
    async usage() { return null; },
    ...overrides,
  };
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
    create: fail('create'),
    start: fail('start'),
    stop: fail('stop'),
    remove: fail('remove'),
    status: fail('status'),
    describe: fail('describe'),
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

  it('learns container ownership from the target label when listing', async function () {
    const { manager, state, engines } = multiManager();
    engines.get(TARGET_A).list = async () => ['cawc-ada-1'];
    engines.get(TARGET_A).describe = async (name) => ({
      name,
      status: 'running',
      image: 'img',
      labels: { [TARGET_LABEL]: TARGET_A },
    });
    // A container old enough to predate the label belongs to the legacy engine.
    engines.get('legacy').list = async () => ['cawc-cid-3'];
    engines.get('legacy').describe = async (name) => ({
      name,
      status: 'running',
      image: 'img',
      labels: {},
    });

    const list = await manager.list();
    assert.deepStrictEqual(list.map((e) => e.name).sort(), ['cawc-ada-1', 'cawc-cid-3']);
    assert.strictEqual(manager.targetKeyForContainer('cawc-ada-1'), TARGET_A);
    assert.strictEqual(manager.targetKeyForContainer('cawc-cid-3'), 'legacy');
    assert.strictEqual(state.activeKey, TARGET_A);

    await manager.remove('cawc-cid-3');
    assert.strictEqual(engines.get('legacy').calls.filter((c) => c.op === 'remove').length, 1);
    assert.strictEqual(engines.get(TARGET_A).calls.filter((c) => c.op === 'remove').length, 0);
  });

  it('throws when targets exist but none is active, and touches nothing', async function () {
    const { manager, state } = multiManager();
    state.activeKey = null;

    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /no active deploy target/,
    );
  });

  it('reports enabled when targets exist but none is active, so the loud error surfaces', async function () {
    // The silent-host fallback: `enabled` answering false here would make the
    // server's ensureEnvironment hand out the host environment, and the
    // "no active deploy target" error would never reach anyone.
    const manager = new EnvironmentManager({
      config: createContainerConfig({}, {}), // legacy startup config disabled
      engine: forbiddenEngine(),
      hostHome: '/srv/work',
      resolveActive: () => null, // targets exist, none active
      engines: new Map(),
      configs: new Map(),
    });

    assert.strictEqual(manager.enabled, true, 'unplaceable is not disabled');
    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /no active deploy target/,
    );
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

  it('never falls back to the host engine when no target is active', async function () {
    const config = targetConfig();
    const manager = new EnvironmentManager({
      config,
      engine: forbiddenEngine(),
      hostHome: '/srv/work',
      resolveActive: () => null,
      engines: new Map(),
      configs: new Map(),
    });
    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /no active deploy target/,
    );
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

  it('does not misroute an ensure that is in flight across a reload', async function () {
    const { manager, state, engines, configs } = multiManager();

    // Target A's engine answers ensure slowly, so the reload below lands
    // while the container is still being created.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const engineA = engines.get(TARGET_A);
    engineA.ensure = async (spec) => {
      engineA.calls.push({ op: 'ensure', spec });
      await gate;
      return { created: true };
    };

    const pending = manager.ensureFor({ id: 1, githubLogin: 'ada' });
    // Let the ensure reach the gate: the placement must already be registered
    // by then, or the reload would strand the half-created container. The
    // wait is polled because the provision does real fs work before ensure.
    for (let i = 0; i < 100 && !engineA.calls.some((c) => c.op === 'ensure'); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
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

  it('treats an active key that names no target as no active target', async function () {
    const { manager, state } = multiManager();
    state.activeKey = 'dangling-target-id';
    await assert.rejects(
      manager.ensureFor({ id: 1, githubLogin: 'ada' }),
      /no active deploy target/,
    );
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
  });
});
