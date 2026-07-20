'use strict';

/**
 * Recovering from native dependencies that npm refused to build.
 *
 * npm >= 12 blocks dependency install scripts unless the *root project's*
 * package.json approves them. For a `npx github:...` run that root is a
 * package.json npm generates itself, holding nothing but the dependency and an
 * `_npx` marker — this package has no way to influence it. So node-pty and
 * better-sqlite3 arrive uncompiled and the server cannot start.
 *
 * Plain JavaScript with no dependencies, and deliberately NOT in dist/: it has
 * to work in exactly the situation where loading dist/ fails.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const packageJson = require('../package.json');

/**
 * The dependencies whose install scripts have to run for the server to start.
 *
 * Read from our own `allowScripts` rather than hard-coded, then narrowed to
 * runtime dependencies: esbuild is declared there too, but it is only needed to
 * build, so nobody should be asked to approve it in order to *run*.
 */
const NATIVE_DEPENDENCIES = Object.keys(packageJson.allowScripts || {}).filter(
  (name) => Boolean((packageJson.dependencies || {})[name]),
);

function isNativeModuleFailure(message) {
  return /pty\.node|better_sqlite3\.node|Failed to load native module|\.node['"]?$/.test(
    String(message),
  );
}

/** The npm next to this node binary, falling back to PATH. */
function resolveNpm(deps = {}) {
  const exists = deps.existsSync || fs.existsSync;
  const execPath = deps.execPath || process.execPath;
  const nodeDir = path.dirname(execPath);
  for (const candidate of ['npm', 'npm.cmd']) {
    const full = path.join(nodeDir, candidate);
    if (exists(full)) {
      return full;
    }
  }
  return 'npm';
}

/**
 * The directory npm treats as the project root for this installation.
 *
 * That is the parent of the `node_modules` holding us — the npx cache
 * directory for `npx github:...`, or `<prefix>/lib` for a global install. It is
 * where approvals have to be written, which is why naming it matters: the old
 * advice pointed at the package directory inside a *global* install, and for an
 * npx run there is no global install to point at at all.
 *
 * Returns null from a source checkout, where nothing needs approving.
 */
function resolveInstallRoot(startDir) {
  const packageDir = path.resolve(startDir || path.join(__dirname, '..'));
  const parent = path.dirname(packageDir);
  if (path.basename(parent) !== 'node_modules') {
    return null;
  }
  return path.dirname(parent);
}

/** True when this root is npm's global lib directory. */
function isGlobalRoot(root, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  try {
    const globalRoot = String(
      run(resolveNpm(deps), ['root', '-g'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    if (!globalRoot) {
      return false;
    }
    return path.resolve(globalRoot) === path.resolve(path.join(root, 'node_modules'));
  } catch {
    return false;
  }
}

/**
 * The commands that actually unblock and build the native dependencies.
 *
 * npm offers two mechanisms for this and they are exact mirror images, which
 * is why each has to be detected rather than guessed:
 *
 *   project-scoped   `npm install-scripts approve` writes the approval into
 *                    the root package.json. Passing `--allow-scripts` here is
 *                    refused outright (EALLOWSCRIPTS).
 *   global           `--allow-scripts=<list>` is the only way in. Running
 *                    `npm install-scripts` against a global prefix is refused
 *                    outright (EGLOBAL).
 *
 * `npm rebuild` on its own is never enough: it reports "rebuilt dependencies
 * successfully" while skipping every package whose scripts are blocked, which
 * is why advice built around it looks like it should work and does not.
 */
function repairCommands(root, options = {}) {
  if (options.global) {
    return [['rebuild', '--global', `--allow-scripts=${NATIVE_DEPENDENCIES.join(',')}`]];
  }

  const scope = ['--prefix', root];
  return [
    ['install-scripts', 'approve', ...NATIVE_DEPENDENCIES, ...scope],
    ['rebuild', ...scope],
  ];
}

/**
 * What to tell a user who has to fix this by hand.
 *
 * Returns an array of lines so it can be asserted in a test rather than only
 * eyeballed on a terminal.
 */
function manualInstructions(root, options = {}) {
  const lines = [];
  lines.push('npm 12 blocks dependency install scripts by default, so the native modules');
  lines.push('arrived uncompiled. Building them fixes it:');
  lines.push('');
  for (const args of repairCommands(root, options)) {
    lines.push(`  npm ${args.join(' ')}`);
  }
  lines.push('');
  lines.push('`npm rebuild` on its own is not enough — it reports success while still');
  lines.push('skipping the blocked packages.');

  if (options.global) {
    // Worth stating, because the flag is refused in the other kind of install
    // and someone who has met that error will assume it cannot be used here.
    lines.push('A global install is approved with --allow-scripts; passing that flag to a');
    lines.push('project-scoped install is refused, which is why the two differ.');
  }

  lines.push('');
  lines.push('Building needs a C++ toolchain (python3, make, g++ on Linux).');
  return lines;
}

module.exports = {
  NATIVE_DEPENDENCIES,
  isNativeModuleFailure,
  isGlobalRoot,
  manualInstructions,
  repairCommands,
  resolveInstallRoot,
  resolveNpm,
};
