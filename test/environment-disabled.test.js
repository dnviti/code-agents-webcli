const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EnvironmentManager,
  HostEnvironment,
  createContainerConfig,
  defaultEnvironmentRoot,
} = require('../dist/server/services/environments/index.js');
const { createEnvironmentRoutes } = require('../dist/server/routes/environment.js');

// An installation that configured no container engine must behave exactly as
// it did before any of this existed: everything on this machine, as this
// account. That is a promise about the *whole* feature, not about one branch,
// so these tests are deliberately about what is NOT reached — an engine that
// throws on contact, a directory that must not appear, an interval that must
// not be scheduled.

/** Any call to this is a failure: nothing may touch an engine when disabled. */
function forbiddenEngine() {
  const fail = (op) => () => {
    throw new Error(`the ${op} engine call was made on a server with no engine configured`);
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
    describeStrict: fail('describeStrict'),
    exec: fail('exec'),
    execArgs: fail('execArgs'),
    list: fail('list'),
    available: fail('available'),
    resize: fail('resize'),
    usage: fail('usage'),
  };
}

function response() {
  const sent = { status: 200, body: null };
  return {
    locals: {},
    status(code) { sent.status = code; return this; },
    json(payload) { sent.body = payload; return this; },
    sent,
  };
}

describe('an installation with no container engine configured', function () {
  describe('configuration', function () {
    it('is off when nothing is passed and nothing is in the environment', function () {
      assert.strictEqual(createContainerConfig({}, {}).enabled, false);
    });

    it('stays off for every value but the exact opt-in', function () {
      for (const value of ['', 'false', 'FALSE', '0', 'yes', 'True', undefined]) {
        assert.strictEqual(
          createContainerConfig({}, { CODE_AGENTS_WEBCLI_CONTAINERS: value }).enabled,
          false,
          `CODE_AGENTS_WEBCLI_CONTAINERS=${String(value)} must not enable it`,
        );
      }
      // Naming an engine, an image or a size is not the same as asking for the
      // feature: an operator setting these on a whim must not silently move
      // everybody's work into containers.
      assert.strictEqual(createContainerConfig({ containerEngine: 'podman' }, {}).enabled, false);
      assert.strictEqual(createContainerConfig({ containerImage: 'alpine' }, {}).enabled, false);
      assert.strictEqual(createContainerConfig({ containerTiers: 'a=1,1g' }, {}).enabled, false);
      assert.strictEqual(createContainerConfig({ kubeNamespace: 'ws' }, {}).enabled, false);
    });
  });

  describe('the manager', function () {
    const config = createContainerConfig({}, {});

    function disabled() {
      return new EnvironmentManager({
        config,
        engine: forbiddenEngine(),
        hostHome: '/srv/work',
      });
    }

    it('hands out the host for every user, without contacting an engine', async function () {
      const manager = disabled();
      for (const owner of [{ id: 1, githubLogin: 'alice' }, { id: 2, githubLogin: 'bob' }]) {
        const env = await manager.ensureFor(owner);
        assert.strictEqual(env.kind, 'host');
        assert.ok(env instanceof HostEnvironment);
        assert.strictEqual(env.homeDir, '/srv/work', 'everyone shares the one folder, as before');
        assert.strictEqual(env.name, null);
      }
    });

    it('gives every user the same host environment, not one each', async function () {
      const manager = disabled();
      const a = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      const b = await manager.ensureFor({ id: 2, githubLogin: 'bob' });
      assert.strictEqual(a, b);
      assert.strictEqual(manager.existing(1), a);
    });

    it('runs commands exactly as an unwrapped spawn would', async function () {
      const manager = disabled();
      const env = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      const wrapped = env.wrap('bash', ['-lc', 'echo hi'], {
        cwd: '/srv/work/project',
        env: { FOO: 'bar' },
        tty: true,
      });

      // The identity: same command, same argv, and the process environment the
      // server itself has — which is what "exactly as it does today" means.
      assert.strictEqual(wrapped.command, 'bash');
      assert.deepStrictEqual(wrapped.args, ['-lc', 'echo hi']);
      assert.strictEqual(wrapped.env.FOO, 'bar');
      assert.strictEqual(wrapped.env.PATH, process.env.PATH);
      assert.strictEqual(wrapped.env.HOME, process.env.HOME);
    });

    it('leaves paths alone rather than translating them', async function () {
      const manager = disabled();
      const env = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      // Anywhere on the machine, unchanged and never refused: path scoping is
      // the base folder's job here, exactly as it was before.
      for (const p of ['/etc/passwd', '/srv/work/x', '/tmp']) {
        assert.strictEqual(env.toContainerPath(p), p);
        assert.strictEqual(env.toHostPath(p), p);
      }
    });

    it('lets the terminal bridge keep choosing the shell itself', async function () {
      const manager = disabled();
      const env = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      // Empty means "the bridge's own host search is still the right answer",
      // which is what keeps $SHELL and the real host paths in play.
      assert.deepStrictEqual(env.shells, []);
      assert.deepStrictEqual(env.mounts, []);
      assert.strictEqual(env.nodePath, process.execPath);
    });

    it('sweeps and scales nothing, without contacting an engine', async function () {
      const manager = disabled();
      await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      assert.deepStrictEqual(await manager.sweepIdle(), []);
      assert.deepStrictEqual(await manager.sweepIdle(() => true), []);
      assert.deepStrictEqual(await manager.sampleAndScale(), []);
      assert.strictEqual(await manager.usageFor(1), null);
      assert.strictEqual(await manager.stopFor(1), false);
      await manager.stopAll();
    });

    it('creates no directory anywhere', async function () {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-off-'));
      const manager = new EnvironmentManager({
        config: createContainerConfig({ dataDir }, {}),
        engine: forbiddenEngine(),
        hostHome: '/srv/work',
      });
      await manager.ensureFor({ id: 1, githubLogin: 'alice' });

      // Not even the root: an install that never turns this on should not find
      // an empty `environments/` tree in its data directory wondering what it is.
      assert.deepStrictEqual(fs.readdirSync(dataDir), []);
      assert.strictEqual(fs.existsSync(defaultEnvironmentRoot(dataDir)), false);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  });

  describe('the environment API', function () {
    const deps = {
      environments: new EnvironmentManager({
        config: createContainerConfig({}, {}),
        engine: forbiddenEngine(),
        hostHome: '/srv/work',
      }),
      setUserEnvironmentTier() { throw new Error('nothing may be persisted when the feature is off'); },
      getUserEnvironmentTier: () => null,
      userHasLiveSession: () => false,
    };

    function route(method, url) {
      const router = createEnvironmentRoutes(deps);
      const layer = router.stack.find(
        (entry) => entry.route?.path === url && entry.route.methods[method],
      );
      assert.ok(layer, `no ${method.toUpperCase()} ${url} route`);
      return layer.route.stack[0].handle;
    }

    it('reports the feature as off rather than erroring', async function () {
      const res = response();
      res.locals.authContext = { user: { id: 1, githubLogin: 'alice' }, authSessionId: 's' };
      await route('get', '/api/environment')({}, res);

      assert.strictEqual(res.sent.status, 200);
      // The browser uses exactly this to leave the whole section out, so it has
      // to be a plain answer and not a 404 or a 500.
      assert.deepStrictEqual(res.sent.body, { enabled: false });
    });

    it('refuses to set a size, and explains why', async function () {
      const res = response();
      res.locals.authContext = { user: { id: 1, githubLogin: 'alice' }, authSessionId: 's' };
      await route('put', '/api/environment/tier')({ body: { tier: 'large' } }, res);

      assert.strictEqual(res.sent.status, 409);
      assert.strictEqual(res.sent.body.error, 'environments_disabled');
    });

    it('still refuses an unauthenticated caller first of all', async function () {
      const res = response();
      await route('get', '/api/environment')({}, res);
      assert.strictEqual(res.sent.status, 401);
    });
  });
});
