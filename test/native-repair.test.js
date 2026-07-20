const assert = require('assert');
const path = require('path');
const {
  NATIVE_DEPENDENCIES,
  isGlobalRoot,
  isNativeModuleFailure,
  manualInstructions,
  repairCommands,
  resolveInstallRoot,
  resolveNpm,
} = require('../bin/native-repair.js');

// bin/ is plain JavaScript on purpose: this code has to work in exactly the
// situation where loading dist/ fails, so it cannot live there.

describe('native dependency detection', function () {
  const failures = [
    'Failed to load native module: pty.node, checked: build/Release',
    "Cannot find module './prebuilds/linux-x64//pty.node'",
    'Error: /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  ];

  failures.forEach(function (message) {
    it(`recognises ${JSON.stringify(message.slice(0, 45))}…`, function () {
      assert.strictEqual(isNativeModuleFailure(message), true);
    });
  });

  it('does not mistake a missing build for a missing native module', function () {
    // These two need completely different advice: one says "run npm run build",
    // the other says "approve install scripts".
    assert.strictEqual(
      isNativeModuleFailure("Cannot find module '../dist/server/index.js'"),
      false,
    );
  });

  it('asks about the runtime native dependencies only', function () {
    // esbuild is in allowScripts too, but it is only needed to build, so nobody
    // should be asked to approve it in order to start the server.
    assert.deepStrictEqual([...NATIVE_DEPENDENCIES].sort(), ['better-sqlite3', 'node-pty']);
  });
});

describe('resolveInstallRoot', function () {
  it('finds the npx cache root', function () {
    // npm writes approvals to the parent of node_modules, not to the package.
    const packageDir = '/home/u/.npm/_npx/9ea5009dd2ffa9de/node_modules/code-agents-webcli';
    assert.strictEqual(resolveInstallRoot(packageDir), '/home/u/.npm/_npx/9ea5009dd2ffa9de');
  });

  it('finds a global install root', function () {
    const packageDir = '/usr/lib/node_modules/code-agents-webcli';
    assert.strictEqual(resolveInstallRoot(packageDir), '/usr/lib');
  });

  it('returns null for a source checkout', function () {
    // Nothing to approve: a checkout's own package.json is the root already.
    assert.strictEqual(resolveInstallRoot('/home/u/Repos/code-agents-webcli'), null);
  });
});

describe('repairCommands', function () {
  const ROOT = '/home/u/.npm/_npx/abc123';

  it('approves the blocked packages before rebuilding', function () {
    const commands = repairCommands(ROOT);
    assert.strictEqual(commands.length, 2);
    assert.deepStrictEqual(commands[0], [
      'install-scripts', 'approve', 'node-pty', 'better-sqlite3', '--prefix', ROOT,
    ]);
    assert.deepStrictEqual(commands[1], ['rebuild', '--prefix', ROOT]);
  });

  it('scopes every command to the resolved root', function () {
    // Without --prefix these would act on the current directory, which for an
    // npx run is wherever the user happened to be standing.
    for (const args of repairCommands(ROOT)) {
      assert.ok(args.includes('--prefix'));
      assert.strictEqual(args[args.indexOf('--prefix') + 1], ROOT);
    }
  });

  // The two mechanisms are exact mirror images: each is refused in the other's
  // context, so the wrong one is not merely suboptimal, it errors out.
  it('uses --allow-scripts for a global install', function () {
    const commands = repairCommands('/usr/lib', { global: true });
    assert.deepStrictEqual(commands, [
      ['rebuild', '--global', '--allow-scripts=node-pty,better-sqlite3'],
    ]);
  });

  it('never offers install-scripts approve for a global install', function () {
    // npm refuses it against a global prefix with EGLOBAL.
    const flat = repairCommands('/usr/lib', { global: true }).flat().join(' ');
    assert.ok(!flat.includes('install-scripts'));
  });

  it('never offers --allow-scripts for a project-scoped install', function () {
    // npm refuses it there with EALLOWSCRIPTS.
    const flat = repairCommands('/home/u/.npm/_npx/abc').flat().join(' ');
    assert.ok(!flat.includes('--allow-scripts'));
  });
});

describe('manualInstructions', function () {
  it('names the real directory, not the package directory', function () {
    const root = '/home/u/.npm/_npx/abc123';
    const text = manualInstructions(root).join('\n');
    assert.ok(text.includes(root));
    // The previous advice pointed at $(npm root -g)/code-agents-webcli, which
    // for an npx run does not exist at all.
    assert.ok(!text.includes('npm root -g'));
  });

  it('warns that npm rebuild alone is not enough', function () {
    // It reports "rebuilt dependencies successfully" while skipping every
    // blocked package, which is why the old advice looked like it worked.
    const text = manualInstructions('/home/u/.npm/_npx/abc123').join('\n');
    assert.match(text, /rebuild.*on its own is not enough/i);
  });

  it('does not tell a global install to run a command npm refuses', function () {
    const text = manualInstructions('/usr/lib', { global: true }).join('\n');
    assert.ok(!text.includes('install-scripts approve'));
    assert.match(text, /npm rebuild --global --allow-scripts=/);
    // Someone who has hit EALLOWSCRIPTS on an install will assume the flag is
    // unusable here too, so the difference is spelled out.
    assert.match(text, /project-scoped install is refused/);
  });

  it('always mentions the toolchain requirement', function () {
    for (const options of [{}, { global: true }]) {
      assert.match(manualInstructions('/x/y', options).join('\n'), /C\+\+ toolchain/);
    }
  });
});

describe('resolveNpm', function () {
  it('prefers the npm next to this node binary', function () {
    const npm = resolveNpm({
      execPath: '/opt/node/bin/node',
      existsSync: (target) => target === path.join('/opt/node/bin', 'npm'),
    });
    assert.strictEqual(npm, '/opt/node/bin/npm');
  });

  it('falls back to PATH when there is none beside node', function () {
    assert.strictEqual(
      resolveNpm({ execPath: '/opt/node/bin/node', existsSync: () => false }),
      'npm',
    );
  });
});

describe('isGlobalRoot', function () {
  it('matches when npm root -g is this root\'s node_modules', function () {
    const result = isGlobalRoot('/usr/lib', {
      execPath: '/opt/node/bin/node',
      existsSync: () => false,
      execFileSync: () => '/usr/lib/node_modules\n',
    });
    assert.strictEqual(result, true);
  });

  it('does not match an npx cache root', function () {
    const result = isGlobalRoot('/home/u/.npm/_npx/abc123', {
      execPath: '/opt/node/bin/node',
      existsSync: () => false,
      execFileSync: () => '/usr/lib/node_modules\n',
    });
    assert.strictEqual(result, false);
  });

  it('assumes not global when npm cannot be run', function () {
    const result = isGlobalRoot('/usr/lib', {
      execPath: '/opt/node/bin/node',
      existsSync: () => false,
      execFileSync: () => {
        throw new Error('npm missing');
      },
    });
    assert.strictEqual(result, false);
  });
});
