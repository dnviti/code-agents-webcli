const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ContainerEngine,
  EnvironmentManager,
  HostEnvironment,
  ContainerEnvironment,
  createContainerConfig,
  environmentName,
  environmentSlug,
  containerHomeFor,
  MANAGED_LABEL,
  USER_ID_LABEL,
  LOGIN_LABEL,
} = require('../dist/server/services/environments/index.js');

/** An engine that records argv instead of running it. */
function fakeEngine(kind, responses = {}) {
  const calls = [];
  const known = new Map();
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    const key = args[0] === 'container' ? args[1] : args[0];
    const handler = responses[key];
    let result;
    if (typeof handler === 'function') {
      result = await handler(args);
    } else if (key === 'inspect') {
      const name = args[args.length - 1];
      const description = known.get(name);
      if (!description) throw new Error(`No such object: ${name}`);
      result = args.includes('{{.State.Status}}')
        ? { stdout: `${description.status}\n`, stderr: '' }
        : {
            stdout: `${description.identity}\t${description.status}\t${description.image}\t${JSON.stringify(description.labels)}\n`,
            stderr: '',
          };
    } else {
      result = { stdout: '', stderr: '' };
    }

    if (key === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const labels = {};
      for (let at = 0; at < args.length; at += 1) {
        if (args[at] !== '--label') continue;
        const [label, ...value] = args[at + 1].split('=');
        labels[label] = value.join('=');
      }
      const identity = `${name}-id`;
      known.set(name, {
        name, identity, status: 'running', image: 'example/image:1', labels,
      });
      if (!result.stdout.trim()) result = { ...result, stdout: `${identity}\n` };
    } else if (key === 'start') {
      const target = args[args.length - 1];
      for (const [name, description] of known) {
        if (name === target || description.identity === target) {
          known.set(name, { ...description, status: 'running' });
        }
      }
    } else if (key === 'stop') {
      const target = args[args.length - 1];
      for (const [name, description] of known) {
        if (name === target || description.identity === target) {
          known.set(name, { ...description, status: 'exited' });
        }
      }
    } else if (key === 'rm') {
      const target = args[args.length - 1];
      for (const [name, description] of known) {
        if (name === target || description.identity === target) known.delete(name);
      }
    }
    return result;
  };
  const engine = new ContainerEngine({
    kind,
    runner,
    relabelMounts: false,
    uid: 1000,
    gid: 1000,
  });
  engine.replaceForTest = (name, description) => known.set(name, { name, ...description });
  return { engine, calls };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-env-'));
}

function managedInspect(args, status, userId, login = 'user') {
  const format = args[args.indexOf('--format') + 1] || '';
  if (!format.includes('Config.Labels')) {
    return { stdout: `${status}\n`, stderr: '' };
  }
  return {
    stdout: `container-${userId}\t${status}\texample/image:1\t${JSON.stringify({
      [MANAGED_LABEL]: 'true',
      [USER_ID_LABEL]: String(userId),
      [LOGIN_LABEL]: login,
    })}\n`,
    stderr: '',
  };
}

describe('per-user environments', function () {
  describe('naming', function () {
    it('slugifies a login to a safe container fragment', function () {
      assert.strictEqual(environmentSlug('Alice-Smith'), 'alice-smith');
      assert.strictEqual(environmentSlug('a.b_c'), 'a-b-c');
      assert.strictEqual(environmentSlug('---'), 'user');
      assert.strictEqual(environmentSlug(''), 'user');
    });

    it('cannot be crafted to impersonate another account', function () {
      // `bob1` with id 2 must not collide with `bob` with id 12.
      assert.notStrictEqual(
        environmentName('cawc', { id: 2, githubLogin: 'bob1' }),
        environmentName('cawc', { id: 12, githubLogin: 'bob' }),
      );
      // Nor may a login that already looks like a full name reach one.
      assert.strictEqual(
        environmentName('cawc', { id: 7, githubLogin: 'alice-3' }),
        'cawc-alice-7',
      );
    });

    it('always ends in the numeric account id', function () {
      assert.strictEqual(
        environmentName('cawc', { id: 42, githubLogin: 'octocat' }),
        'cawc-octocat-42',
      );
      assert.strictEqual(containerHomeFor({ id: 42, githubLogin: 'octocat' }), '/home/octocat-42');
    });

    it('gives two different users two different environments', function () {
      const a = environmentName('cawc', { id: 1, githubLogin: 'same' });
      const b = environmentName('cawc', { id: 2, githubLogin: 'same' });
      assert.notStrictEqual(a, b);
    });
  });

  describe('configuration', function () {
    it('is disabled by default', function () {
      const config = createContainerConfig({}, {});
      assert.strictEqual(config.enabled, false);
    });

    it('is enabled by flag or by environment variable', function () {
      assert.strictEqual(createContainerConfig({ containers: true }, {}).enabled, true);
      assert.strictEqual(
        createContainerConfig({}, { CODE_AGENTS_WEBCLI_CONTAINERS: 'true' }).enabled,
        true,
      );
    });

    it('accepts either engine, defaulting to docker', function () {
      assert.strictEqual(createContainerConfig({}, {}).engine, 'docker');
      assert.strictEqual(createContainerConfig({ containerEngine: 'podman' }, {}).engine, 'podman');
      assert.strictEqual(
        createContainerConfig({}, { CODE_AGENTS_WEBCLI_CONTAINER_ENGINE: 'podman' }).engine,
        'podman',
      );
    });

    it('carries limits and image through', function () {
      const config = createContainerConfig({
        containerImage: 'example/image:1',
        containerCpus: '2',
        containerMemory: '4g',
        containerIdleMinutes: 30,
      }, {});
      assert.strictEqual(config.image, 'example/image:1');
      assert.strictEqual(config.cpus, '2');
      assert.strictEqual(config.memory, '4g');
      assert.strictEqual(config.idleTimeoutMinutes, 30);
    });
  });

  describe('engine argv', function () {
    it('builds a docker create with limits, labels and the bind mount', function () {
      const { engine } = fakeEngine('docker');
      const args = engine.createArgs({
        name: 'cawc-alice-1',
        image: 'example/image:1',
        mounts: [{ hostPath: '/data/environments/cawc-alice-1', containerPath: '/home/alice-1' }],
        containerHome: '/home/alice-1',
        cpus: '2',
        memory: '4g',
        labels: { [MANAGED_LABEL]: 'true' },
        env: { HOME: '/home/alice-1' },
      });
      const joined = args.join(' ');
      assert.ok(joined.includes('--name cawc-alice-1'));
      assert.ok(joined.includes('--volume /data/environments/cawc-alice-1:/home/alice-1'));
      assert.ok(joined.includes('--cpus 2'));
      assert.ok(joined.includes('--memory 4g'));
      assert.ok(joined.includes(`--label ${MANAGED_LABEL}=true`));
      assert.ok(joined.includes('--env HOME=/home/alice-1'));
      assert.ok(joined.includes('--user 1000:1000'));
      assert.ok(!joined.includes('keep-id'), 'docker has no --userns=keep-id');
    });

    it('adds --userns=keep-id for podman only', function () {
      const { engine } = fakeEngine('podman');
      const args = engine.createArgs({
        name: 'cawc-alice-1',
        image: 'example/image:1',
        mounts: [{ hostPath: '/data/x', containerPath: '/home/alice-1' }],
        containerHome: '/home/alice-1',
        cpus: null,
        memory: null,
        labels: {},
        env: {},
      });
      assert.ok(args.includes('--userns=keep-id'));
      assert.ok(!args.includes('--cpus'));
      assert.ok(!args.includes('--memory'));
    });

    it('relabels the mount when SELinux is enforcing', function () {
      const engine = new ContainerEngine({
        kind: 'podman', runner: async () => ({ stdout: '', stderr: '' }),
        relabelMounts: true, uid: 1000, gid: 1000,
      });
      const args = engine.createArgs({
        name: 'n', image: 'i', containerHome: '/c',
        mounts: [
          { hostPath: '/h', containerPath: '/c' },
          { hostPath: '/app', containerPath: '/opt/app', readOnly: true },
        ],
        cpus: null, memory: null, labels: {}, env: {},
      });
      assert.ok(args.includes('/h:/c:Z'));
      // Shared label, not private: the app's own directory is mounted into
      // every user's environment at once.
      assert.ok(args.includes('/app:/opt/app:ro,z'));
    });

    it('builds an exec that carries cwd, env and an optional tty', function () {
      const { engine } = fakeEngine('docker');
      const withTty = engine.execArgs(
        { name: 'box', cwd: '/home/alice-1/project', env: { FOO: 'bar' }, tty: true },
        'bash',
        ['-l'],
      );
      assert.deepStrictEqual(withTty, [
        'exec', '--interactive', '--tty',
        '--workdir', '/home/alice-1/project',
        '--env', 'FOO=bar',
        'box', 'bash', '-l',
      ]);

      const withoutTty = engine.execArgs({ name: 'box' }, 'ls', []);
      assert.deepStrictEqual(withoutTty, ['exec', '--interactive', 'box', 'ls']);
    });

    it('sends exec stdin through the runner without putting it in engine argv', async function () {
      const { engine, calls } = fakeEngine('docker');
      await engine.exec({ name: 'box', input: 'bearer-token\n' }, 'cat', []);
      const call = calls.find((entry) => entry.args.includes('exec'));
      assert.strictEqual(call.input, 'bearer-token\n');
      assert.ok(!call.args.some((arg) => arg.includes('bearer-token')));
    });

    it('reads attributes through inspect, not off a ps row', async function () {
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => ({
          stdout: 'immutable-id\trunning\talpine:3\t{"com.code-agents-webcli.login":"alice"}\n',
          stderr: '',
        }),
      });
      const described = await engine.describe('box');
      assert.deepStrictEqual(described, {
        name: 'box',
        identity: 'immutable-id',
        status: 'running',
        image: 'alpine:3',
        labels: { 'com.code-agents-webcli.login': 'alice' },
      });
      // A ps row is asked for names only — the one field both engines print
      // identically.
      await engine.list('x=y');
      const ps = calls.find((c) => c.args[0] === 'ps');
      assert.ok(ps.args.includes('{{.Names}}'));
      assert.ok(!ps.args.some((a) => a.includes('{{.Labels}}')));
    });

    it('scopes inspection to containers so same-named images are irrelevant', async function () {
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => { throw new Error('No such container'); },
      });

      assert.strictEqual(await engine.describeStrict('shared-name'), null);
      const inspect = calls.find((call) => call.args.includes('inspect'));
      assert.deepStrictEqual(inspect.args.slice(0, 2), ['container', 'inspect']);
    });

    it('reports an absent container rather than throwing', async function () {
      const { engine } = fakeEngine('docker', {
        inspect: async () => { throw new Error('No such object'); },
      });
      assert.strictEqual(await engine.status('gone'), null);
      assert.strictEqual(await engine.describe('gone'), null);
    });

    it('does not turn an inspect failure into strict absence', async function () {
      const { engine } = fakeEngine('docker', {
        inspect: async () => { throw new Error('permission denied by daemon'); },
      });
      await assert.rejects(engine.describeStrict('box'), /permission denied/);
      assert.strictEqual(await engine.describe('box'), null, 'operator views remain best-effort');
    });

    it('does not turn malformed inspect labels into strict absence', async function () {
      const { engine } = fakeEngine('docker', {
        inspect: async () => ({ stdout: 'box-id\trunning\timg\t{broken\n', stderr: '' }),
      });
      await assert.rejects(engine.describeStrict('box'), /malformed labels/);
      assert.strictEqual(await engine.describe('box'), null);
    });

    it('refuses to adopt an existing container with incompatible identity labels', async function () {
      const { engine, calls } = fakeEngine('docker', {
        inspect: async (args) => managedInspect(args, 'running', 2, 'other'),
      });
      await assert.rejects(
        engine.ensure({
          name: 'cawc-alice-1',
          image: 'example/image:1',
          mounts: [],
          containerHome: '/home/alice-1',
          cpus: null,
          memory: null,
          labels: { [MANAGED_LABEL]: 'true', [USER_ID_LABEL]: '1' },
          identityLabels: [MANAGED_LABEL, USER_ID_LABEL],
          env: {},
        }),
        /incompatible ownership label/,
      );
      assert.strictEqual(calls.some((call) => call.args[0] === 'start'), false);
      assert.strictEqual(calls.some((call) => call.args[0] === 'run'), false);
    });

    it('does not confuse transport failure or malformed output with strict absence', async function () {
      const uncertain = fakeEngine('docker', { inspect: async () => { throw new Error('daemon timeout'); } }).engine;
      await assert.rejects(() => uncertain.describeStrict('box'), /could not inspect.*timeout/i);
      assert.strictEqual(await uncertain.describe('box'), null);
      const malformed = fakeEngine('docker', { inspect: async () => ({ stdout: 'garbage', stderr: '' }) }).engine;
      await assert.rejects(() => malformed.describeStrict('box'), /malformed inspection/i);
      assert.strictEqual(await malformed.describe('box'), null);
    });

    it('targets immutable identity and detects a same-name replacement during stop', async function () {
      let inspection = 0;
      const { engine, calls } = fakeEngine('docker', {
        stop: async () => ({ stdout: '', stderr: '' }),
        inspect: async () => ({ stdout: `${inspection++ ? 'replacement-id' : 'original-id'}\trunning\timg\t{}\n`, stderr: '' }),
      });
      const original = await engine.describe('box');
      await assert.rejects(() => engine.stopIdentity(original), /replaced during stop/);
      assert.ok(calls.find((call) => call.args[0] === 'stop').args.includes('original-id'));
    });

    it('targets immutable identity and detects a same-name replacement during removal', async function () {
      let inspection = 0;
      const { engine, calls } = fakeEngine('docker', {
        rm: async () => ({ stdout: '', stderr: '' }),
        inspect: async () => ({
          stdout: `${inspection++ ? 'replacement-id' : 'original-id'}\trunning\timg\t{}\n`,
          stderr: '',
        }),
      });
      const original = await engine.describe('box');
      await assert.rejects(() => engine.removeIdentity(original), /replaced during removal/);
      assert.ok(calls.find((call) => call.args[0] === 'rm').args.includes('original-id'));
    });

    it('fails closed when stop leaves the same container potentially executable', async function () {
      for (const status of ['restarting', 'paused', 'unknown']) {
        const { engine, calls } = fakeEngine('docker', {
          stop: async () => ({ stdout: '', stderr: '' }),
          inspect: async () => ({ stdout: `original-id\t${status}\timg\t{}\n`, stderr: '' }),
        });
        await assert.rejects(
          () => engine.stopIdentity({ name: 'box', identity: 'original-id', status: 'running', image: 'img', labels: {} }),
          new RegExp(`potentially executable.*${status}`, 'i'),
        );
        assert.ok(calls.find((call) => call.args[0] === 'stop').args.includes('original-id'));
      }
    });

    it('accepts only a proven quiescent same-identity state after stop', async function () {
      const { engine } = fakeEngine('podman', {
        stop: async () => ({ stdout: '', stderr: '' }),
        inspect: async () => ({ stdout: 'original-id\texited\timg\t{}\n', stderr: '' }),
      });
      await engine.stopIdentity({ name: 'box', identity: 'original-id', status: 'running', image: 'img', labels: {} });
    });

    it('never starts a stopped same-name replacement during identity-safe ensure', async function () {
      const { engine, calls } = fakeEngine('docker', {
        inspect: async () => ({ stdout: 'replacement-id\texited\timg\t{}\n', stderr: '' }),
      });
      await assert.rejects(() => engine.ensureIdentity({ name: 'box' }, { name: 'box', identity: 'original-id', status: 'exited', image: 'img', labels: {} }), /replaced before ensure/);
      assert.strictEqual(calls.some((call) => call.args[0] === 'start'), false);
    });

    it('returns and verifies the immutable ID emitted by fresh creation', async function () {
      let inspection = 0;
      const { engine } = fakeEngine('docker', {
        inspect: async () => {
          if (inspection++ === 0) throw new Error('No such object');
          return { stdout: 'created-id\trunning\timg\t{}\n', stderr: '' };
        },
        run: async () => ({ stdout: 'created-id\n', stderr: '' }),
      });
      const spec = {
        name: 'box', image: 'img', containerHome: '/workspace', cpus: null, memory: null,
        labels: {}, env: {}, mounts: [],
      };
      assert.deepStrictEqual(await engine.ensureIdentity(spec, null), { created: true, identity: 'created-id' });
    });

    it('never passes user text through a shell', function () {
      const { engine, calls } = fakeEngine('docker');
      return engine.exec({ name: 'box' }, 'echo', ['; rm -rf /']).then(() => {
        assert.strictEqual(calls[0].file, 'docker');
        // The metacharacters survive as one argv entry rather than becoming syntax.
        assert.ok(calls[0].args.includes('; rm -rf /'));
      });
    });
  });

  describe('host environment', function () {
    it('is the identity transform', function () {
      const host = new HostEnvironment('/srv/work');
      assert.strictEqual(host.kind, 'host');
      assert.strictEqual(host.name, null);
      assert.strictEqual(host.toContainerPath('/srv/work/a'), '/srv/work/a');
      assert.strictEqual(host.toHostPath('/srv/work/a'), '/srv/work/a');
      const wrapped = host.wrap('bash', ['-l'], { cwd: '/srv/work', env: { A: '1' } });
      assert.strictEqual(wrapped.command, 'bash');
      assert.deepStrictEqual(wrapped.args, ['-l']);
      assert.strictEqual(wrapped.env.A, '1');
      assert.strictEqual(wrapped.env.PATH, process.env.PATH);
    });
  });

  describe('container environment', function () {
    const { engine } = fakeEngine('podman');
    const env = new ContainerEnvironment({
      name: 'cawc-alice-1',
      identity: 'cawc-alice-1-id',
      homeDir: '/data/environments/cawc-alice-1',
      containerHome: '/home/alice-1',
      engine,
    });

    it('translates host paths into the container and back', function () {
      assert.strictEqual(env.toContainerPath('/data/environments/cawc-alice-1'), '/home/alice-1');
      assert.strictEqual(
        env.toContainerPath('/data/environments/cawc-alice-1/proj/src'),
        '/home/alice-1/proj/src',
      );
      assert.strictEqual(env.toHostPath('/home/alice-1/proj'), '/data/environments/cawc-alice-1/proj');
      assert.strictEqual(env.toHostPath('/home/alice-1'), '/data/environments/cawc-alice-1');
    });

    it('refuses a path outside the user home rather than clamping it', function () {
      assert.throws(() => env.toContainerPath('/etc/passwd'), /outside environment/);
      assert.throws(() => env.toContainerPath('/data/environments/cawc-bob-2/x'), /outside environment/);
      assert.throws(() => env.toHostPath('/etc/passwd'), /outside environment/);
      // A traversal that resolves out of the home is caught after resolution.
      assert.throws(
        () => env.toContainerPath('/data/environments/cawc-alice-1/../cawc-bob-2/secret'),
        /outside environment/,
      );
    });

    it('wraps a command as an exec into its own container', function () {
      const wrapped = env.wrap('bash', ['-l'], {
        cwd: '/data/environments/cawc-alice-1/proj',
        env: { TERM: 'xterm-256color' },
        tty: true,
      });
      assert.strictEqual(wrapped.command, 'podman');
      assert.deepStrictEqual(wrapped.args, [
        'exec', '--interactive', '--tty',
        '--workdir', '/home/alice-1/proj',
        '--env', 'TERM=xterm-256color',
        'cawc-alice-1-id', 'bash', '-l',
      ]);
    });

    it('does not hand the server process environment to the user program', function () {
      const wrapped = env.wrap('bash', [], { env: { A: '1' } });
      const envFlags = wrapped.args.filter((a, i) => wrapped.args[i - 1] === '--env');
      assert.deepStrictEqual(envFlags, ['A=1']);
    });
  });

  describe('manager', function () {
    it('returns the host environment when disabled, without touching the engine', async function () {
      const { engine, calls } = fakeEngine('docker');
      const manager = new EnvironmentManager({
        config: createContainerConfig({}, {}),
        engine,
        hostHome: '/srv/work',
      });
      const env = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      assert.strictEqual(env.kind, 'host');
      assert.strictEqual(env.homeDir, '/srv/work');
      assert.strictEqual(calls.length, 0);
    });

    it('creates an environment on first use and reuses it afterwards', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('podman');
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      const first = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      assert.strictEqual(first.kind, 'container');
      assert.strictEqual(first.name, 'cawc-alice-1');
      assert.strictEqual(first.homeDir, path.join(root, 'cawc-alice-1'));
      assert.strictEqual(calls.filter((c) => c.args[0] === 'run').length, 1);

      const second = await manager.ensureFor({ id: 1, githubLogin: 'alice' });
      assert.strictEqual(second.name, first.name);
      assert.strictEqual(
        calls.filter((c) => c.args[0] === 'run').length,
        1,
        'signing in again must not create a second environment',
      );
    });

    it('creates the user home 0700 before the container exists', async function () {
      const root = tmpRoot();
      let homeAtCreate = null;
      const { engine } = fakeEngine('podman', {
        run: async (args) => {
          const volume = args[args.indexOf('--volume') + 1].split(':')[0];
          homeAtCreate = fs.existsSync(volume);
          return { stdout: '', stderr: '' };
        },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 3, githubLogin: 'carol' });

      assert.strictEqual(homeAtCreate, true, 'home must exist before the bind mount');
      const mode = fs.statSync(env.homeDir).mode & 0o777;
      assert.strictEqual(mode, 0o700);
    });

    it('starts a stopped environment instead of recreating it', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('docker');
      engine.replaceForTest('cawc-dan-4', {
        identity: 'cawc-dan-4-id', status: 'exited', image: 'example/image:1',
        labels: {
          [MANAGED_LABEL]: 'true', [USER_ID_LABEL]: '4', [LOGIN_LABEL]: 'dan',
        },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 4, githubLogin: 'dan' });

      assert.strictEqual(calls.filter((c) => c.args[0] === 'run').length, 0);
      assert.deepStrictEqual(
        calls.filter((c) => c.args[0] === 'start').map((c) => c.args[1]),
        ['cawc-dan-4-id'],
      );
    });

    it('makes one environment when two sign-ins race', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('podman', {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { stdout: '', stderr: '' };
        },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      const [a, b] = await Promise.all([
        manager.ensureFor({ id: 5, githubLogin: 'erin' }),
        manager.ensureFor({ id: 5, githubLogin: 'erin' }),
      ]);
      assert.strictEqual(a.name, b.name);
      assert.strictEqual(calls.filter((c) => c.args[0] === 'run').length, 1);
    });

    it('runs the setup command once per created container, never on reuse', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('podman');
      const config = {
        ...createContainerConfig({ containers: true, containerSetupCommand: 'npm i -g x' }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 6, githubLogin: 'frank' });
      await manager.ensureFor({ id: 6, githubLogin: 'frank' });

      // The shell probe is an exec too, and runs on every provision; the setup
      // command is the one that must not run twice.
      const setups = calls.filter(
        (c) => c.args[0] === 'exec' && c.args.includes('npm i -g x'),
      );
      assert.strictEqual(setups.length, 1);
      assert.ok(setups[0].args.includes('cawc-frank-6-id'), 'setup targets immutable identity');
    });

    it('rejects a foreign same-name container before setup or probing', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('docker');
      engine.replaceForTest('cawc-alice-1', {
        identity: 'foreign-id',
        status: 'running',
        image: 'foreign/image',
        labels: {
          [MANAGED_LABEL]: 'true',
          [USER_ID_LABEL]: '999',
          [LOGIN_LABEL]: 'mallory',
        },
      });
      const config = {
        ...createContainerConfig({ containers: true, containerSetupCommand: 'touch owned' }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      await assert.rejects(
        manager.ensureFor({ id: 1, githubLogin: 'alice' }),
        /belongs to another user/,
      );
      await assert.rejects(manager.remove('cawc-alice-1'), /not owned as a user environment/);
      assert.strictEqual(
        calls.some((call) => ['run', 'start', 'exec', 'stop', 'rm'].includes(call.args[0])),
        false,
        'foreign same-name state is inspected but never executed, started, stopped, or removed',
      );
    });

    it('fails provisioning if setup or probing observes a same-name replacement', async function () {
      const root = tmpRoot();
      let pair;
      pair = fakeEngine('podman', {
        exec: async () => {
          pair.engine.replaceForTest('cawc-setup-race-31', {
            identity: 'replacement-id',
            status: 'running',
            image: 'example/image:1',
            labels: {
              [MANAGED_LABEL]: 'true',
              [USER_ID_LABEL]: '31',
              [LOGIN_LABEL]: 'setup-race',
            },
          });
          return { stdout: 'sh\n', stderr: '' };
        },
      });
      const config = {
        ...createContainerConfig({ containers: true, containerSetupCommand: 'install extras' }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({ config, engine: pair.engine, hostHome: '/srv/work' });

      await assert.rejects(
        manager.ensureFor({ id: 31, githubLogin: 'setup-race' }),
        /identity or ownership changed during provisioning/,
      );
      const execs = pair.calls.filter((call) => call.args[0] === 'exec');
      assert.ok(execs.length >= 1);
      assert.ok(execs.every((call) => call.args.includes('cawc-setup-race-31-id')));
      assert.ok(execs.every((call) => !call.args.includes('replacement-id')));
      assert.strictEqual(manager.existing(31), null, 'the replacement is never adopted as ready');
    });

    it('reports the shells the image actually has, not this host\'s', async function () {
      const root = tmpRoot();
      const { engine } = fakeEngine('podman', {
        exec: async () => ({ stdout: 'bash\nsh\n', stderr: '' }),
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 12, githubLogin: 'lena' });
      assert.deepStrictEqual(env.shells, ['bash', 'sh']);
    });

    it('falls back to sh when the shell probe fails', async function () {
      const root = tmpRoot();
      const { engine } = fakeEngine('podman', {
        exec: async () => { throw new Error('probe blew up'); },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 13, githubLogin: 'mo' });
      assert.deepStrictEqual(env.shells, ['sh']);
    });

    it('survives a failing setup command', async function () {
      const root = tmpRoot();
      const { engine } = fakeEngine('podman', {
        exec: async () => { throw new Error('setup blew up'); },
      });
      const config = {
        ...createContainerConfig({ containers: true, containerSetupCommand: 'false' }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 7, githubLogin: 'gina' });
      assert.strictEqual(env.kind, 'container');
    });

    it('stops idle environments and leaves busy ones alone', async function () {
      const root = tmpRoot();
      let clock = 1_000_000;
      const { engine, calls } = fakeEngine('podman');
      const config = {
        ...createContainerConfig({ containers: true, containerIdleMinutes: 10 }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({
        config, engine, hostHome: '/srv/work', now: () => clock,
      });

      await manager.ensureFor({ id: 8, githubLogin: 'hana' });
      await manager.ensureFor({ id: 9, githubLogin: 'ivan' });

      clock += 11 * 60_000;
      manager.touch(9);

      const stopped = await manager.sweepIdle();
      assert.deepStrictEqual(stopped, ['cawc-hana-8']);
      assert.deepStrictEqual(
        calls.filter((c) => c.args[0] === 'stop').map((c) => c.args[c.args.length - 1]),
        ['cawc-hana-8-id'],
      );
    });

    it('never stops an environment that has something running in it', async function () {
      const root = tmpRoot();
      let clock = 1_000_000;
      const { engine, calls } = fakeEngine('podman');
      const config = {
        ...createContainerConfig({ containers: true, containerIdleMinutes: 10 }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({
        config, engine, hostHome: '/srv/work', now: () => clock,
      });

      await manager.ensureFor({ id: 20, githubLogin: 'nina' });
      clock += 11 * 60_000;

      // An agent that has been working for an hour without a new session
      // starting looks untouched, and stopping it would kill the run.
      assert.deepStrictEqual(await manager.sweepIdle((id) => id === 20), []);
      assert.strictEqual(calls.filter((c) => c.args[0] === 'stop').length, 0);

      // The busy check also counts as activity, so it is not stopped the
      // instant the run ends.
      assert.deepStrictEqual(await manager.sweepIdle(() => false), []);

      clock += 11 * 60_000;
      assert.deepStrictEqual(await manager.sweepIdle(() => false), ['cawc-nina-20']);
    });

    it('never stops anything when idle stopping is off', async function () {
      const root = tmpRoot();
      const { engine } = fakeEngine('podman');
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 10, githubLogin: 'jo' });
      assert.deepStrictEqual(await manager.sweepIdle(), []);
    });

    it('never mutates a same-name replacement through ready lifecycle paths', async function () {
      const root = tmpRoot();
      let clock = 1_000_000;
      const { engine, calls } = fakeEngine('docker');
      const config = {
        ...createContainerConfig({ containers: true, containerIdleMinutes: 1 }, {}),
        rootDir: root,
      };
      const manager = new EnvironmentManager({
        config, engine, hostHome: '/srv/work', now: () => clock,
      });
      const owner = { id: 32, githubLogin: 'ready-race' };
      const environment = await manager.ensureFor(owner);
      engine.replaceForTest(environment.name, {
        identity: 'replacement-id',
        status: 'running',
        image: 'example/image:1',
        // Even copied ownership labels cannot turn a new identity into the
        // environment this manager originally prepared.
        labels: {
          [MANAGED_LABEL]: 'true',
          [USER_ID_LABEL]: String(owner.id),
          [LOGIN_LABEL]: owner.githubLogin,
        },
      });
      calls.length = 0;
      clock += 2 * 60_000;

      const originalError = console.error;
      console.error = () => {};
      try {
        await assert.rejects(manager.ensureFor(owner), /replaced before ensure/);
        assert.deepStrictEqual(await manager.sweepIdle(), []);
        await assert.rejects(manager.stopFor(owner.id), /same-name container was replaced/);
        await assert.rejects(
          manager.applyTier(owner.id, { id: 'large', label: 'Large', cpus: '4', memory: '4g' }),
          /same-name container was replaced/,
        );
        await assert.rejects(manager.remove(environment.name), /same-name container was replaced/);
      } finally {
        console.error = originalError;
      }

      assert.strictEqual(manager.existing(owner.id), environment, 'failed checks retain the original handle');
      assert.strictEqual(
        calls.some((call) => ['run', 'start', 'exec', 'stop', 'rm', 'update'].includes(call.args[0])),
        false,
        'the replacement receives no lifecycle mutation',
      );
    });

    it('targets resize by immutable id and rejects replacement during the update', async function () {
      const root = tmpRoot();
      let pair;
      pair = fakeEngine('docker', {
        update: async () => {
          pair.engine.replaceForTest('cawc-resize-race-33', {
            identity: 'replacement-id',
            status: 'running',
            image: 'example/image:1',
            labels: {
              [MANAGED_LABEL]: 'true',
              [USER_ID_LABEL]: '33',
              [LOGIN_LABEL]: 'resize-race',
            },
          });
          return { stdout: '', stderr: '' };
        },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine: pair.engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 33, githubLogin: 'resize-race' });

      const originalError = console.error;
      console.error = () => {};
      let outcome;
      try {
        outcome = await manager.applyTier(
          33,
          { id: 'large', label: 'Large', cpus: '4', memory: '4g' },
          { busy: true },
        );
      } finally {
        console.error = originalError;
      }
      assert.strictEqual(outcome, 'deferred');
      const update = pair.calls.find((call) => call.args[0] === 'update');
      assert.ok(update.args.includes('cawc-resize-race-33-id'));
      assert.ok(!update.args.includes('replacement-id'));
      assert.strictEqual(manager.appliedTierFor(33).id, 'medium');
    });

    it('lists environments with their owners', async function () {
      const root = tmpRoot();
      // Shaped like the real engines: `ps` gives names only, and every
      // attribute comes back through `inspect`, because Docker and Podman
      // disagree about how `{{.Labels}}` prints in a `ps` row.
      const owners = {
        'cawc-alice-1': ['running', 1, 'alice'],
        'cawc-bob-2': ['exited', 2, 'bob'],
      };
      const { engine } = fakeEngine('docker', {
        ps: async () => ({ stdout: 'cawc-alice-1\ncawc-bob-2\n', stderr: '' }),
        inspect: async (args) => {
          const name = args[args.length - 1];
          const [status, id, login] = owners[name];
          return {
            stdout: `${name}-id\t${status}\texample/image:1\t${JSON.stringify({
              [MANAGED_LABEL]: 'true',
              [USER_ID_LABEL]: String(id),
              [LOGIN_LABEL]: login,
            })}`,
            stderr: '',
          };
        },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const list = await manager.list();
      assert.deepStrictEqual(list.map((e) => [e.name, e.githubLogin, e.userId, e.status]), [
        ['cawc-alice-1', 'alice', 1, 'running'],
        ['cawc-bob-2', 'bob', 2, 'exited'],
      ]);
    });

    it('removes an environment and, on request, its data', async function () {
      const root = tmpRoot();
      const { engine, calls } = fakeEngine('docker');
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 11, githubLogin: 'kim' });
      fs.writeFileSync(path.join(env.homeDir, 'secret.txt'), 'token');

      await manager.remove('cawc-kim-11');
      assert.ok(fs.existsSync(path.join(env.homeDir, 'secret.txt')), 'data survives a plain remove');
      assert.ok(calls.some((c) => c.args[0] === 'rm' && c.args.includes('cawc-kim-11-id')));

      await manager.remove('cawc-kim-11', { purgeData: true });
      assert.ok(!fs.existsSync(env.homeDir), 'purge takes the data with it');
    });

    it('refuses to purge outside its own root', async function () {
      const root = tmpRoot();
      const outside = path.join(root, '..', path.basename(root) + '-other');
      fs.mkdirSync(outside, { recursive: true });
      const { engine } = fakeEngine('docker');
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });

      await assert.rejects(
        manager.remove(`../${path.basename(outside)}`, { purgeData: true }),
        /safe path component/,
      );
      assert.ok(fs.existsSync(outside), 'a traversing name must not delete another tree');
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });
});
