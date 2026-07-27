const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AUTO_TIER,
  DEFAULT_AUTO_POLICY,
  DEFAULT_TIERS,
  EnvironmentManager,
  INITIAL_AUTO_STATE,
  KubernetesEngine,
  createContainerConfig,
  decideAutoTier,
  parseSize,
  parseTiers,
  resolveTier,
  toQuantity,
  TIER_LABEL,
} = require('../dist/server/services/environments/index.js');

const TIERS = [
  { id: 'small', label: 'Small', cpus: '1', memory: '1g' },
  { id: 'medium', label: 'Medium', cpus: '2', memory: '2g' },
  { id: 'large', label: 'Large', cpus: '4', memory: '4g' },
];

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-tier-'));
}

/** An engine that records argv and answers scripted responses. */
function fakeEngine(overrides = {}) {
  const calls = [];
  const engine = {
    kind: 'podman',
    binary: 'podman',
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
    async available() { return true; },
    async resize(name, cpus, memory) { calls.push({ op: 'resize', name, cpus, memory }); return true; },
    async usage() { return null; },
    ...overrides,
  };
  if (overrides.resize) {
    engine.resize = async (name, cpus, memory) => {
      calls.push({ op: 'resize', name, cpus, memory });
      return overrides.resize(name, cpus, memory);
    };
  }
  return engine;
}

function managerWith(engine, extra = {}) {
  const root = tmpRoot();
  const config = {
    ...createContainerConfig({ containers: true }, {}),
    rootDir: root,
    tiers: TIERS,
    defaultTier: 'medium',
    ...extra.config,
  };
  return new EnvironmentManager({
    config,
    engine,
    hostHome: '/srv/work',
    ...extra.options,
  });
}

describe('environment tiers', function () {
  describe('catalog', function () {
    it('parses an administrator catalog, order preserved', function () {
      const tiers = parseTiers('tiny=0.5,512m; big=8,16g');
      assert.deepStrictEqual(tiers.map((t) => [t.id, t.cpus, t.memory]), [
        ['tiny', '0.5', '512m'],
        ['big', '8', '16g'],
      ]);
      assert.strictEqual(tiers[0].label, 'Tiny');
    });

    it('drops entries it cannot read rather than failing startup', function () {
      const tiers = parseTiers('good=1,1g; nonsense; also bad');
      assert.deepStrictEqual(tiers.map((t) => t.id), ['good']);
    });

    it('refuses a tier named auto, which would shadow automatic sizing', function () {
      assert.deepStrictEqual(parseTiers('auto=1,1g; real=2,2g').map((t) => t.id), ['real']);
    });

    it('ships a usable catalog when none is configured', function () {
      const config = createContainerConfig({ containers: true }, {});
      assert.deepStrictEqual(config.tiers, DEFAULT_TIERS);
      // The middle of the ladder, not the bottom: a default at the bottom makes
      // every new user's first impression the slowest one available.
      assert.strictEqual(config.defaultTier, 'medium');
    });

    it('takes the configured default, and warns past an unknown one', function () {
      assert.strictEqual(
        createContainerConfig({ containers: true, containerDefaultTier: 'large' }, {}).defaultTier,
        'large',
      );
      assert.strictEqual(
        createContainerConfig({ containers: true, containerDefaultTier: 'nope' }, {}).defaultTier,
        'medium',
      );
    });

    it('lets a flat limit stay the only size, rather than being overridden', function () {
      // `--container-memory 4g` was the whole story before tiers existed. A
      // stock catalog quietly winning over it would hand out environments of a
      // size the administrator never asked for.
      const config = createContainerConfig({
        containers: true,
        containerCpus: '3',
        containerMemory: '6g',
      }, {});
      assert.deepStrictEqual(config.tiers.map((t) => [t.id, t.cpus, t.memory]), [
        ['fixed', '3', '6g'],
      ]);
      assert.strictEqual(config.allowUserTierChoice, false, 'one size is not a choice');
    });

    it('lets an explicit catalog win over a flat limit', function () {
      const config = createContainerConfig({
        containers: true,
        containerMemory: '6g',
        containerTiers: 'a=1,1g;b=2,2g',
      }, {});
      assert.deepStrictEqual(config.tiers.map((t) => t.id), ['a', 'b']);
      assert.strictEqual(config.allowUserTierChoice, true);
    });

    it('lets an administrator take the choice away', function () {
      assert.strictEqual(createContainerConfig({ containers: true }, {}).allowUserTierChoice, true);
      assert.strictEqual(
        createContainerConfig({ containers: true, containerUserTierChoice: false }, {}).allowUserTierChoice,
        false,
      );
    });
  });

  describe('resolving a choice', function () {
    it('honours a named tier', function () {
      assert.strictEqual(resolveTier(TIERS, 'large', 'medium').id, 'large');
    });

    it('falls back to the default for no choice and for a vanished one', function () {
      assert.strictEqual(resolveTier(TIERS, null, 'medium').id, 'medium');
      assert.strictEqual(resolveTier(TIERS, 'gone', 'medium').id, 'medium');
    });

    it('resolves auto to wherever scaling has settled', function () {
      assert.strictEqual(resolveTier(TIERS, AUTO_TIER, 'medium', 'large').id, 'large');
      // A user who has never run anything starts from the default.
      assert.strictEqual(resolveTier(TIERS, AUTO_TIER, 'medium', null).id, 'medium');
    });
  });

  describe('the automatic policy', function () {
    const current = TIERS[1];
    const busy = { cpuCores: 1.9, memoryBytes: 100 * 1024 * 1024 };
    const quiet = { cpuCores: 0.1, memoryBytes: 100 * 1024 * 1024 };

    function run(samples, startState = INITIAL_AUTO_STATE, now = 10_000_000) {
      let state = startState;
      let last = null;
      for (const sample of samples) {
        last = decideAutoTier({ tiers: TIERS, current, sample, state, now });
        state = last.state;
      }
      return last;
    }

    it('steps up only after sustained load, not on one spike', function () {
      assert.strictEqual(run([busy]).next, null);
      assert.strictEqual(run([busy, busy]).next, null);
      assert.strictEqual(run([busy, busy, busy]).next.id, 'large');
    });

    it('forgets a streak the moment the load drops', function () {
      assert.strictEqual(run([busy, busy, quiet, busy, busy]).next, null);
    });

    it('steps down only after a much longer quiet spell', function () {
      assert.strictEqual(run(Array(9).fill(quiet)).next, null);
      assert.strictEqual(run(Array(10).fill(quiet)).next.id, 'small');
    });

    it('measures memory as well as cpu', function () {
      const memoryBound = { cpuCores: 0, memoryBytes: 1.9 * 1024 ** 3 };
      assert.strictEqual(run([memoryBound, memoryBound, memoryBound]).next.id, 'large');
    });

    it('will not move again inside the cooldown', function () {
      const justChanged = { hot: 0, cold: 0, lastChangeAt: 10_000_000 };
      const decision = run([busy, busy, busy], justChanged, 10_000_000 + 60_000);
      assert.strictEqual(decision.next, null, 'a minute after a change is too soon');

      const later = run([busy, busy, busy], justChanged, 10_000_000 + DEFAULT_AUTO_POLICY.cooldownMs + 1);
      assert.strictEqual(later.next.id, 'large');
    });

    it('stops at the ends of the ladder', function () {
      const top = decideAutoTier({
        tiers: TIERS, current: TIERS[2], sample: busy,
        state: { hot: 99, cold: 0, lastChangeAt: 0 }, now: 10_000_000,
      });
      assert.strictEqual(top.next, null);

      const bottom = decideAutoTier({
        tiers: TIERS, current: TIERS[0], sample: quiet,
        state: { hot: 0, cold: 99, lastChangeAt: 0 }, now: 10_000_000,
      });
      assert.strictEqual(bottom.next, null);
    });

    it('treats a missing reading as unknown, never as idle', function () {
      // A cluster with no metrics-server reports nothing. Reading that as quiet
      // would shrink every environment on it out from under its owner.
      const decision = run(Array(20).fill(null));
      assert.strictEqual(decision.next, null);
      assert.strictEqual(decision.state.cold, 0);
    });

    it('explains itself', function () {
      assert.match(run([busy, busy, busy]).reason, /% of Medium for 3 samples/);
    });
  });

  describe('applying a tier', function () {
    it('builds a new environment at the size the user chose', async function () {
      const engine = fakeEngine();
      const manager = managerWith(engine, { options: { getUserTier: () => 'large' } });
      await manager.ensureFor({ id: 1, githubLogin: 'alice' });

      const ensure = engine.calls.find((c) => c.op === 'ensure');
      assert.strictEqual(ensure.spec.cpus, '4');
      assert.strictEqual(ensure.spec.memory, '4g');
      assert.strictEqual(ensure.spec.labels[TIER_LABEL], 'large');
      assert.strictEqual(manager.appliedTierFor(1).id, 'large');
    });

    it('uses the default for a user who has never chosen', async function () {
      const engine = fakeEngine();
      const manager = managerWith(engine);
      await manager.ensureFor({ id: 2, githubLogin: 'bob' });
      assert.strictEqual(engine.calls.find((c) => c.op === 'ensure').spec.cpus, '2');
    });

    it('resizes a running environment in place when the engine can', async function () {
      const engine = fakeEngine();
      const manager = managerWith(engine);
      await manager.ensureFor({ id: 3, githubLogin: 'carol' });

      const outcome = await manager.applyTier(3, TIERS[2], { busy: true });
      assert.strictEqual(outcome, 'applied');
      assert.deepStrictEqual(
        engine.calls.filter((c) => c.op === 'resize').map((c) => [c.cpus, c.memory]),
        [['4', '4g']],
      );
      // Applied live, so nothing was stopped under the user.
      assert.strictEqual(engine.calls.some((c) => c.op === 'stop'), false);
      assert.strictEqual(manager.appliedTierFor(3).id, 'large');
    });

    it('waits for the user to be idle when it has to rebuild', async function () {
      const engine = fakeEngine({ resize: async () => false });
      const manager = managerWith(engine);
      await manager.ensureFor({ id: 4, githubLogin: 'dan' });

      const outcome = await manager.applyTier(4, TIERS[2], { busy: true });
      assert.strictEqual(outcome, 'deferred');
      assert.strictEqual(
        engine.calls.some((c) => c.op === 'stop'),
        false,
        'an agent that is working must not be killed to change a size',
      );
      assert.strictEqual(manager.pendingTierFor(4).id, 'large');
    });

    it('applies a deferred change the next time the user starts something', async function () {
      const engine = fakeEngine({ resize: async () => false });
      // The user is on the default, then picks a bigger size while working.
      let chosen = 'medium';
      const manager = managerWith(engine, { options: { getUserTier: () => chosen } });
      await manager.ensureFor({ id: 5, githubLogin: 'erin' });

      chosen = 'large';
      assert.strictEqual(await manager.applyTier(5, TIERS[2], { busy: true }), 'deferred');

      const before = engine.calls.filter((c) => c.op === 'ensure').length;
      await manager.ensureFor({ id: 5, githubLogin: 'erin' });

      assert.ok(engine.calls.some((c) => c.op === 'stop'), 'the old environment is replaced');
      assert.strictEqual(engine.calls.filter((c) => c.op === 'ensure').length, before + 1);
      assert.strictEqual(manager.pendingTierFor(5), null);
      assert.strictEqual(manager.appliedTierFor(5).id, 'large');
    });

    it('rebuilds straight away when nothing is running', async function () {
      const engine = fakeEngine({ resize: async () => false });
      const manager = managerWith(engine);
      await manager.ensureFor({ id: 6, githubLogin: 'frank' });

      const outcome = await manager.applyTier(6, TIERS[0], { busy: false });
      assert.strictEqual(outcome, 'applied');
      assert.ok(engine.calls.some((c) => c.op === 'stop'));
    });

    it('does nothing when the size is already the one asked for', async function () {
      const engine = fakeEngine();
      const manager = managerWith(engine);
      await manager.ensureFor({ id: 7, githubLogin: 'gina' });
      assert.strictEqual(await manager.applyTier(7, TIERS[1]), 'unchanged');
      assert.strictEqual(engine.calls.some((c) => c.op === 'resize'), false);
    });
  });

  describe('automatic sizing, end to end', function () {
    it('moves a user on auto and leaves everybody else alone', async function () {
      let clock = 10_000_000;
      const engine = fakeEngine({
        usage: async () => ({ cpuCores: 1.95, memoryBytes: 10 * 1024 * 1024 }),
      });
      const manager = managerWith(engine, {
        options: {
          now: () => clock,
          getUserTier: (userId) => (userId === 1 ? AUTO_TIER : 'medium'),
        },
      });

      await manager.ensureFor({ id: 1, githubLogin: 'auto-user' });
      await manager.ensureFor({ id: 2, githubLogin: 'fixed-user' });

      assert.deepStrictEqual(await manager.sampleAndScale(), []);
      assert.deepStrictEqual(await manager.sampleAndScale(), []);
      const changes = await manager.sampleAndScale();

      assert.strictEqual(changes.length, 1, 'only the auto user moves');
      assert.deepStrictEqual(
        [changes[0].userId, changes[0].from, changes[0].to, changes[0].outcome],
        [1, 'medium', 'large', 'applied'],
      );
      assert.strictEqual(manager.appliedTierFor(2).id, 'medium');

      // And the new size is what a rebuild would use, so a restart does not
      // silently undo the scaling.
      clock += 10 * 60_000;
      assert.strictEqual(manager.intendedTierFor(1).id, 'large');
    });

    it('defers rather than interrupting a busy user', async function () {
      const engine = fakeEngine({
        resize: async () => false,
        usage: async () => ({ cpuCores: 1.95, memoryBytes: 0 }),
      });
      const manager = managerWith(engine, { options: { getUserTier: () => AUTO_TIER } });
      await manager.ensureFor({ id: 8, githubLogin: 'hana' });

      let changes = [];
      for (let i = 0; i < 3; i += 1) {
        changes = await manager.sampleAndScale(() => true);
      }
      assert.strictEqual(changes[0].outcome, 'deferred');
      assert.strictEqual(engine.calls.some((c) => c.op === 'stop'), false);
    });

    it('does nothing at all when the feature is off', async function () {
      const engine = fakeEngine();
      const config = { ...createContainerConfig({}, {}), tiers: TIERS, defaultTier: 'medium' };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      assert.deepStrictEqual(await manager.sampleAndScale(), []);
    });
  });

  describe('size parsing', function () {
    it('reads what the engines print and what they accept', function () {
      assert.strictEqual(parseSize('1KiB'), 1024);
      // The Kubernetes spelling has no trailing B, and reading it as
      // unparseable is indistinguishable from having no sample at all.
      assert.strictEqual(parseSize('512Mi'), 512 * 1024 ** 2);
      assert.strictEqual(parseSize('2Gi'), 2 * 1024 ** 3);
      assert.strictEqual(parseSize('2g'), 2 * 1024 ** 3);
      assert.strictEqual(parseSize('1.5GiB'), 1.5 * 1024 ** 3);
      assert.strictEqual(parseSize('512m'), 512 * 1024 ** 2);
      assert.strictEqual(parseSize('nonsense'), null);
    });

    it('translates engine sizes into Kubernetes quantities', function () {
      assert.strictEqual(toQuantity('2g'), '2Gi');
      assert.strictEqual(toQuantity('512m'), '512Mi');
      // Already a Kubernetes quantity: left exactly as written.
      assert.strictEqual(toQuantity('4Gi'), '4Gi');
      assert.strictEqual(toQuantity('1500Mi'), '1500Mi');
    });
  });
});
