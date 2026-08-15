const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * The install story, enforced rather than documented.
 *
 * `npx --allow-git=all github:dnviti/code-agents-webcli` is a one-command
 * install only for as long as nothing in the production dependency tree needs
 * to compile. npm >= 12 blocks dependency lifecycle scripts by default, and an
 * npx run has no project package.json in which to record an approval — so a
 * single dependency with an `install` script silently converts the documented
 * one-liner back into "install a C++ toolchain, answer a prompt, then run two
 * more npm commands".
 *
 * That is not something a README sentence can hold. It is checked here, against
 * the real installed tree, because the failure is invisible on a developer
 * machine that already has the toolchain and an approved cache.
 */
describe('install surface', function () {
  this.timeout(60_000);

  /** Every production package actually on disk, resolved through npm. */
  function productionPackages() {
    const raw = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ls', '--omit=dev', '--all', '--json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    const names = new Set();
    const walk = (node) => {
      for (const [name, child] of Object.entries(node.dependencies || {})) {
        if (names.has(name)) {
          continue;
        }
        names.add(name);
        walk(child);
      }
    };
    walk(JSON.parse(raw));
    return names;
  }

  it('ships no production dependency that runs an install script', function () {
    const offenders = [];

    for (const name of productionPackages()) {
      const manifest = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
      if (!fs.existsSync(manifest)) {
        // Hoisting or an optional package skipped for this platform. Nothing
        // on disk means nothing that can run a script here.
        continue;
      }
      const scripts = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts || {};
      const hooks = ['preinstall', 'install', 'postinstall'].filter((hook) => scripts[hook]);
      if (hooks.length > 0) {
        offenders.push(`${name} (${hooks.join(', ')})`);
      }
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'These production dependencies run install scripts, which breaks the one-command '
      + 'install on npm >= 12:\n  '
      + offenders.join('\n  ')
      + '\nEither replace them with a prebuilt-binary equivalent (see '
      + 'src/server/services/runtime/terminal/pty.ts) or update the documented install steps to match.',
    );
  });

  it('declares no package that has to be compiled', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    // These are the two that used to be here. Naming them keeps the check
    // honest about what it is guarding against, so a well-meaning "just add it
    // back" is caught at the point it happens.
    for (const banned of ['node-pty', 'better-sqlite3']) {
      assert.ok(
        !(pkg.dependencies || {})[banned],
        `${banned} compiles on install. Use @lydell/node-pty and node:sqlite instead.`,
      );
    }

    // `allowScripts` only ever existed to permit the two above.
    assert.ok(
      !pkg.allowScripts,
      'package.json should not need an allowScripts allow-list any more.',
    );
  });

  it('requires a Node new enough for built-in SQLite serialization', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // serialize()/deserialize() arrive in Node 24.16.0.
    assert.strictEqual(pkg.engines.node, '>=24.16.0');
  });

  it('publishes the prebuilt output, so an install never has to build', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('dist'), 'the compiled output must ship');
    assert.ok(pkg.files.includes('bin'), 'the launcher must ship');

    // .npmignore and "files" are not additive: an .npmignore that excludes a
    // path listed in "files" is a standing invitation to ship an empty package.
    const npmignore = path.join(ROOT, '.npmignore');
    if (fs.existsSync(npmignore)) {
      const ignored = fs.readFileSync(npmignore, 'utf8')
        .split('\n')
        .map((line) => line.trim().replace(/\/$/, ''))
        .filter((line) => line && !line.startsWith('#'));
      for (const entry of pkg.files) {
        assert.ok(
          !ignored.includes(entry.replace(/\/$/, '')),
          `.npmignore excludes "${entry}" while package.json "files" includes it.`,
        );
      }
    }
  });

  it('ships the app-owned gh-issue workflow with the compiled chat server', function () {
    const source = path.join(ROOT, 'src', 'server', 'chat', 'builtin-workflows', 'gh-issue', 'SKILL.md');
    const built = path.join(ROOT, 'dist', 'server', 'chat', 'builtin-workflows', 'gh-issue', 'SKILL.md');
    assert.ok(fs.existsSync(source), 'the bundled workflow source must be version controlled');
    assert.ok(fs.existsSync(built), 'the bundled workflow must be copied into dist');
    assert.strictEqual(fs.readFileSync(built, 'utf8'), fs.readFileSync(source, 'utf8'));
  });
});
