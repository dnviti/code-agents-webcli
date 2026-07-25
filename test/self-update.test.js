const assert = require('assert');
const {
  SelfUpdateRunner,
  canTriggerUpdate,
  detectUpdateMode,
} = require('../dist/server/services/self-update.js');

const GLOBAL_ROOT = '/usr/lib/node_modules';
const INSTALLED_SCRIPT = '/usr/lib/node_modules/code-agents-webcli/bin/cc-web.js';

/** Every filesystem, subprocess and platform touchpoint is injected. */
function deps(overrides = {}) {
  return {
    spawn: () => {
      throw new Error('spawn should not run in mode detection');
    },
    execFile: () => {},
    execFileSync: (file, args) => {
      if (file.endsWith('npm') && args[0] === 'root') {
        return `${GLOBAL_ROOT}\n`;
      }
      if (file === 'systemctl' && args.includes('is-active')) {
        return 'active\n';
      }
      throw new Error(`unexpected execFileSync ${file} ${args.join(' ')}`);
    },
    existsSync: () => false,
    accessSync: () => {},
    readFileSync: () => {
      throw new Error('ENOENT');
    },
    resolveLaunchTarget: () => ({
      execPath: '/usr/bin/node',
      scriptPath: INSTALLED_SCRIPT,
      ephemeral: false,
    }),
    isSystemdUserAvailable: () => true,
    unitPath: () => '/home/u/.config/systemd/user/code-agents-webcli.service',
    platform: 'linux',
    env: {},
    ...overrides,
  };
}

describe('detectUpdateMode', function () {
  it('detects a running systemd unit', function () {
    const result = detectUpdateMode(deps({ existsSync: (p) => String(p).endsWith('.service') }));
    assert.strictEqual(result.mode, 'systemd');
    assert.strictEqual(result.packageDir, `${GLOBAL_ROOT}/code-agents-webcli`);
  });

  it('falls back to foreground when the unit exists but is not active', function () {
    const result = detectUpdateMode(deps({
      existsSync: (p) => String(p).endsWith('.service'),
      execFileSync: (file, args) => {
        if (file.endsWith('npm')) return `${GLOBAL_ROOT}\n`;
        return 'inactive\n';
      },
    }));
    assert.strictEqual(result.mode, 'foreground');
  });

  it('falls back to foreground when is-active exits non-zero', function () {
    const result = detectUpdateMode(deps({
      existsSync: (p) => String(p).endsWith('.service'),
      execFileSync: (file) => {
        if (file.endsWith('npm')) return `${GLOBAL_ROOT}\n`;
        throw new Error('exit 3');
      },
    }));
    assert.strictEqual(result.mode, 'foreground');
  });

  it('treats an npx install as ephemeral', function () {
    const result = detectUpdateMode(deps({
      resolveLaunchTarget: () => ({
        execPath: '/usr/bin/node',
        scriptPath: '/home/u/.npm/_npx/abc/node_modules/code-agents-webcli/bin/cc-web.js',
        ephemeral: true,
      }),
    }));
    assert.strictEqual(result.mode, 'ephemeral');
  });

  // Container detection has to survive cgroup v2, where /proc/1/cgroup inside a
  // container is a bare "0::/" and matches nothing.
  const containerCases = [
    ['a Docker container', { existsSync: (p) => p === '/.dockerenv' }],
    ['a Podman container', { existsSync: (p) => p === '/run/.containerenv' }],
    ['Kubernetes', { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } }],
    ['a cgroup v1 match', { readFileSync: () => '12:pids:/docker/abc123' }],
  ];

  containerCases.forEach(function ([label, overrides]) {
    it(`refuses to self-install inside ${label}`, function () {
      assert.strictEqual(detectUpdateMode(deps(overrides)).mode, 'container');
    });
  });

  it('prefers the container verdict over ephemeral', function () {
    const result = detectUpdateMode(deps({
      existsSync: (p) => p === '/.dockerenv',
      resolveLaunchTarget: () => ({ execPath: '', scriptPath: '', ephemeral: true }),
    }));
    assert.strictEqual(result.mode, 'container');
  });

  it('detects a source checkout that a global install would not replace', function () {
    // The common dev case: a clean git clone run in the foreground. Installing
    // globally would update a copy that is not the one running, and the banner
    // would never clear.
    const result = detectUpdateMode(deps({
      resolveLaunchTarget: () => ({
        execPath: '/usr/bin/node',
        scriptPath: '/home/u/Repos/code-agents-webcli/bin/cc-web.js',
        ephemeral: false,
      }),
    }));
    assert.strictEqual(result.mode, 'source');
  });

  it('detects a global prefix this user cannot write', function () {
    const result = detectUpdateMode(deps({
      existsSync: (p) => String(p).endsWith('.service'),
      accessSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    }));
    assert.strictEqual(result.mode, 'unwritable_prefix');
  });

  it('reports npm_unavailable when npm root -g fails', function () {
    const result = detectUpdateMode(deps({
      execFileSync: () => {
        throw new Error('npm not found');
      },
    }));
    assert.strictEqual(result.mode, 'npm_unavailable');
  });

  it('only allows a trigger in the two modes that can actually update', function () {
    assert.strictEqual(canTriggerUpdate('systemd'), true);
    assert.strictEqual(canTriggerUpdate('foreground'), true);
    for (const mode of ['ephemeral', 'container', 'source', 'unwritable_prefix', 'npm_unavailable']) {
      assert.strictEqual(canTriggerUpdate(mode), false, `${mode} must not offer the button`);
    }
  });
});

/** A spawn double that reports a chosen exit code per invocation. */
function spawnRecorder(codes) {
  const calls = [];
  const queue = [...codes];

  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const handlers = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: () => {},
      on: (event, handler) => {
        handlers[event] = handler;
        return child;
      },
    };
    const code = queue.shift();
    setImmediate(() => {
      if (code === 'error') {
        handlers.error?.(new Error('spawn failed'));
      } else {
        handlers.close?.(code);
      }
    });
    return child;
  };

  return { calls, spawn };
}

function settingsDouble() {
  const store = {};
  return {
    store,
    getSetting: (key) => (key in store ? store[key] : null),
    setSetting: (key, value) => {
      store[key] = value;
    },
    deleteSetting: (key) => {
      delete store[key];
    },
  };
}

function runner(overrides, options = {}) {
  const done = [];
  const restarts = [];
  const settings = options.settings ?? settingsDouble();
  const instance = new SelfUpdateRunner({
    deps: deps(overrides),
    settings,
    onOutput: () => {},
    onDone: (result) => done.push(result),
    onRestarting: () => restarts.push(true),
  });
  return { instance, done, restarts, settings };
}

describe('SelfUpdateRunner', function () {
  it('runs install, then a load check, then restarts', async function () {
    const { calls, spawn } = spawnRecorder([0, 0]);
    const execFileCalls = [];
    const { instance, restarts } = runner({
      spawn,
      execFile: (file, args, cb) => {
        execFileCalls.push({ file, args });
        cb(null, '', '');
      },
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
    });

    await instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));

    assert.strictEqual(calls.length, 2, 'install and smoke check must both run');
    assert.deepStrictEqual(calls[0].args, [
      'install', '-g', '--allow-git=all', 'github:dnviti/code-agents-webcli',
    ]);
    // There is deliberately no `npm rebuild` between the two any more: nothing
    // in the dependency tree compiles, so there is nothing to rebuild. If a
    // package with an install script is ever reintroduced, this test keeps
    // passing while the service breaks — which is why the real guard against
    // that is test/install-surface.test.js, not this assertion.
    assert.ok(calls[1].args.includes('require(process.argv[1])'));

    assert.strictEqual(restarts.length, 1);
    assert.deepStrictEqual(execFileCalls[0].args, [
      '--user', 'restart', '--no-block', 'code-agents-webcli.service',
    ]);
  });

  it('never uses a shell, and passes no metacharacters', async function () {
    const { calls, spawn } = spawnRecorder([0, 0, 0]);
    const { instance } = runner({
      spawn,
      execFile: (_f, _a, cb) => cb(null, '', ''),
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
    });

    await instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));

    for (const call of calls) {
      assert.strictEqual(call.options.shell, false);
    }

    // The npm invocation must stay free of anything a shell would treat as
    // syntax, since only the install spec varies.
    assert.doesNotMatch(calls[0].args.join(' '), /[;&|`$()<>]/);

    // The load check is a frozen literal plus a path passed as its own argv
    // entry, so the parentheses never reach a shell.
    assert.deepStrictEqual(calls[1].args, [
      '-e',
      'require(process.argv[1])',
      '/opt/pkg/dist/server/index.js',
    ]);
  });

  it('strips the baked build sha from the child environment', async function () {
    const { calls, spawn } = spawnRecorder([0, 0, 0]);
    const { instance } = runner({
      spawn,
      execFile: (_f, _a, cb) => cb(null, '', ''),
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
      env: { CODE_AGENTS_WEBCLI_BUILD_SHA: 'a'.repeat(40), PATH: '/usr/bin' },
    });

    await instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));

    // Inherited, the install would bake the OLD commit into the NEW build and
    // the banner would report "behind" forever.
    assert.strictEqual(calls[0].options.env.CODE_AGENTS_WEBCLI_BUILD_SHA, undefined);
    assert.strictEqual(calls[0].options.env.PATH, '/usr/bin');
  });

  it('does not restart when the install fails', async function () {
    const { calls, spawn } = spawnRecorder([1]);
    const execFileCalls = [];
    const { instance, done } = runner({
      spawn,
      execFile: (file, args, cb) => {
        execFileCalls.push({ file, args });
        cb(null, '', '');
      },
    });

    await instance.apply('systemd', '/opt/pkg', null);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(execFileCalls.length, 0, 'nothing may be restarted');
    assert.strictEqual(done[0].ok, false);
    assert.strictEqual(done[0].restarting, false);
  });

  it('does not restart when the new build fails to load', async function () {
    const { calls, spawn } = spawnRecorder([0, 1]);
    const execFileCalls = [];
    const { instance, done } = runner({
      spawn,
      execFile: (file, args, cb) => {
        execFileCalls.push({ file, args });
        cb(null, '', '');
      },
    });

    await instance.apply('systemd', '/opt/pkg', null);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(execFileCalls.length, 0);
    assert.match(done[0].message, /failed to load/i);
  });

  it('installs but does not exit in foreground mode', async function () {
    const { spawn } = spawnRecorder([0, 0]);
    const execFileCalls = [];
    const { instance, done } = runner({
      spawn,
      execFile: (file, args, cb) => {
        execFileCalls.push({ file, args });
        cb(null, '', '');
      },
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
    });

    await instance.apply('foreground', '/opt/pkg', 'b'.repeat(40));

    // Nothing supervises a foreground process, so exiting would drop every
    // live PTY with nothing to bring them back.
    assert.strictEqual(execFileCalls.length, 0);
    assert.strictEqual(done[0].ok, true);
    assert.strictEqual(done[0].restartRequired, true);
  });

  it('refuses a second concurrent update', async function () {
    const { calls, spawn } = spawnRecorder([0, 0, 0]);
    const { instance } = runner({
      spawn,
      execFile: (_f, _a, cb) => cb(null, '', ''),
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
    });

    const first = instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));
    const second = instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));
    await Promise.all([first, second]);

    assert.strictEqual(calls.length, 2, 'the second call must not spawn anything');
  });

  it('recovers from a restart that could not be queued', async function () {
    const { spawn } = spawnRecorder([0, 0, 0]);
    const { instance, done } = runner({
      spawn,
      execFile: (_f, _a, cb) => cb(new Error('Failed to connect to bus')),
      readFileSync: () => JSON.stringify({ sha: 'b'.repeat(40) }),
    });

    await instance.apply('systemd', '/opt/pkg', 'b'.repeat(40));
    await new Promise((resolve) => setImmediate(resolve));

    // Without this the runner would sit in 'restarting' forever and every
    // later attempt would 409, with no way back short of a shell.
    assert.strictEqual(instance.getState(), 'idle');
    assert.match(done[done.length - 1].message, /could not be restarted/i);
  });

  it('reports an update that was interrupted before it finished', async function () {
    const settings = settingsDouble();
    const { calls, spawn } = spawnRecorder([0, 0, 0]);
    const { instance } = runner(
      { spawn, execFile: (_f, _a, cb) => cb(null, '', '') },
      { settings },
    );

    const pending = instance.apply('foreground', '/opt/pkg', 'c'.repeat(40));
    // The marker is written before the first spawn, so a host reboot mid-install
    // leaves evidence behind.
    assert.ok(settings.store['update.inProgress'], 'a marker must exist while running');
    await pending;

    assert.strictEqual(settings.store['update.inProgress'], undefined);
    assert.strictEqual(calls.length, 2);

    const fresh = runner({ spawn }, { settings: settingsDouble() });
    fresh.settings.setSetting(
      'update.inProgress',
      JSON.stringify({ startedAt: 1, targetSha: 'c'.repeat(40) }),
    );
    const interrupted = fresh.instance.takeInterrupted();
    assert.strictEqual(interrupted.targetSha, 'c'.repeat(40));
    // Reported once, then cleared.
    assert.strictEqual(fresh.instance.takeInterrupted(), null);
  });
});
