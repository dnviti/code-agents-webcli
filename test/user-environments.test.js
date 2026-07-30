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
  const runner = async (file, args) => {
    calls.push({ file, args });
    const key = args[0];
    const handler = responses[key];
    if (typeof handler === 'function') {
      return handler(args);
    }
    return { stdout: '', stderr: '' };
  };
  const engine = new ContainerEngine({
    kind,
    runner,
    relabelMounts: false,
    uid: 1000,
    gid: 1000,
  });
  return { engine, calls };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-env-'));
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

    it('reads attributes through inspect, not off a ps row', async function () {
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => ({
          stdout: 'running\talpine:3\t{"com.code-agents-webcli.login":"alice"}\n',
          stderr: '',
        }),
      });
      const described = await engine.describe('box');
      assert.deepStrictEqual(described, {
        name: 'box',
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

    it('reports an absent container rather than throwing', async function () {
      const { engine } = fakeEngine('docker', {
        inspect: async () => { throw new Error('No such object'); },
      });
      assert.strictEqual(await engine.status('gone'), null);
      assert.strictEqual(await engine.describe('gone'), null);
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
        'cawc-alice-1', 'bash', '-l',
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
      let exists = false;
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => {
          if (!exists) {
            throw new Error('no such container');
          }
          return { stdout: 'running\n', stderr: '' };
        },
        run: async () => {
          exists = true;
          return { stdout: '', stderr: '' };
        },
      });
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
        inspect: async () => { throw new Error('absent'); },
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
      const { engine, calls } = fakeEngine('docker', {
        inspect: async () => ({ stdout: 'exited\n', stderr: '' }),
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 4, githubLogin: 'dan' });

      assert.strictEqual(calls.filter((c) => c.args[0] === 'run').length, 0);
      assert.deepStrictEqual(
        calls.filter((c) => c.args[0] === 'start').map((c) => c.args[1]),
        ['cawc-dan-4'],
      );
    });

    it('makes one environment when two sign-ins race', async function () {
      const root = tmpRoot();
      let exists = false;
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => {
          if (!exists) throw new Error('absent');
          return { stdout: 'running', stderr: '' };
        },
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          exists = true;
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
      let exists = false;
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => {
          if (!exists) throw new Error('absent');
          return { stdout: 'running', stderr: '' };
        },
        run: async () => { exists = true; return { stdout: '', stderr: '' }; },
      });
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
    });

    it('reports the shells the image actually has, not this host\'s', async function () {
      const root = tmpRoot();
      const { engine } = fakeEngine('podman', {
        inspect: async () => { throw new Error('absent'); },
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
        inspect: async () => { throw new Error('absent'); },
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
        inspect: async () => { throw new Error('absent'); },
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
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => ({ stdout: 'running', stderr: '' }),
      });
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
        ['cawc-hana-8'],
      );
    });

    it('never stops an environment that has something running in it', async function () {
      const root = tmpRoot();
      let clock = 1_000_000;
      const { engine, calls } = fakeEngine('podman', {
        inspect: async () => ({ stdout: 'running', stderr: '' }),
      });
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
      const { engine } = fakeEngine('podman', {
        inspect: async () => ({ stdout: 'running', stderr: '' }),
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      await manager.ensureFor({ id: 10, githubLogin: 'jo' });
      assert.deepStrictEqual(await manager.sweepIdle(), []);
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
            stdout: `${status}\texample/image:1\t${JSON.stringify({
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
      const { engine, calls } = fakeEngine('docker', {
        inspect: async () => { throw new Error('absent'); },
      });
      const config = { ...createContainerConfig({ containers: true }, {}), rootDir: root };
      const manager = new EnvironmentManager({ config, engine, hostHome: '/srv/work' });
      const env = await manager.ensureFor({ id: 11, githubLogin: 'kim' });
      fs.writeFileSync(path.join(env.homeDir, 'secret.txt'), 'token');

      await manager.remove('cawc-kim-11');
      assert.ok(fs.existsSync(path.join(env.homeDir, 'secret.txt')), 'data survives a plain remove');
      assert.ok(calls.some((c) => c.args[0] === 'rm' && c.args.includes('cawc-kim-11')));

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

      await manager.remove(`../${path.basename(outside)}`, { purgeData: true });
      assert.ok(fs.existsSync(outside), 'a traversing name must not delete another tree');
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });
});
