#!/usr/bin/env node

const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/**
 * Resolve the TypeScript compiler that is actually installed here.
 *
 * Deliberately not `npx tsc`: when the local devDependency is not visible —
 * which happens inside the temporary clone npm prepares for a git install —
 * npx silently downloads the unrelated, deprecated `tsc` package from the
 * registry and runs that instead, which both fails the build and executes code
 * nobody asked for.
 */
function resolveTsc() {
  const pkg = require.resolve('typescript/package.json');
  const tscJs = path.join(path.dirname(pkg), 'bin', 'tsc');
  if (!fs.existsSync(tscJs)) {
    throw new Error(`TypeScript is installed but ${tscJs} is missing.`);
  }
  return tscJs;
}

async function build() {
  console.log('Building code-agents-webcli...\n');

  const distDir = path.join(__dirname, '..', 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  const buildInfo = writeBuildInfo(distDir);
  // Identifies this bundle to the service-worker cache. Falls back to the
  // build timestamp so a source build still busts its own cache.
  const buildId = buildInfo.sha
    ? `${buildInfo.sha.slice(0, 12)}${buildInfo.dirty ? '-dirty' : ''}`
    : buildInfo.builtAt.replace(/[^0-9]/g, '');

  // 1. Compile server TypeScript
  console.log('[server] Compiling TypeScript...');
  try {
    execFileSync(process.execPath, [resolveTsc(), '--project', 'tsconfig.json'], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });
    console.log('[server] Done.\n');
  } catch (error) {
    console.error('[server] TypeScript compilation failed');
    process.exit(1);
  }

  // 2. Bundle client TypeScript with esbuild
  console.log('[client] Bundling with esbuild...');
  try {
    const clientCtx = await esbuild.context({
      entryPoints: ['src/client/index.ts'],
      bundle: true,
      outfile: 'dist/public/app.bundle.js',
      format: 'iife',
      globalName: 'ClaudeCodeWeb',
      sourcemap: true,
      minify: !isWatch,
      target: ['es2020'],
      define: {
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
      }
    });

    if (isWatch) {
      await clientCtx.watch();
      console.log('[client] Watching for changes...\n');
    } else {
      await clientCtx.rebuild();
      await clientCtx.dispose();
      console.log('[client] Done.\n');
    }
  } catch (error) {
    console.error('[client] Bundle failed:', error.message);
    process.exit(1);
  }

  // 3. Copy public assets
  console.log('[assets] Copying public files...');
  const publicSrc = path.join(__dirname, '..', 'src', 'public');
  const publicDest = path.join(__dirname, '..', 'dist', 'public');

  fs.mkdirSync(publicDest, { recursive: true });

  const filesToCopy = ['index.html', 'manifest.json', 'service-worker.js'];
  for (const file of filesToCopy) {
    const src = path.join(publicSrc, file);
    const dest = path.join(publicDest, file);
    if (!fs.existsSync(src)) {
      continue;
    }
    if (file === 'service-worker.js') {
      // Stamp the cache name with this build, so the worker's activate handler
      // evicts the previous client instead of serving it against a new server.
      fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace(/__BUILD_ID__/g, buildId));
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // Copy CSS directory
  const cssSrc = path.join(publicSrc, 'css');
  const cssDest = path.join(publicDest, 'css');
  if (fs.existsSync(cssSrc)) {
    copyDir(cssSrc, cssDest);
  }

  // Vendor xterm's stylesheet locally. Loading it from unpkg made the terminal
  // unusable on any network that cannot reach the CDN.
  const xtermCss = path.join(
    __dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'
  );
  if (fs.existsSync(xtermCss)) {
    fs.mkdirSync(path.join(cssDest, 'vendor'), { recursive: true });
    fs.copyFileSync(xtermCss, path.join(cssDest, 'vendor', 'xterm.css'));
  } else {
    console.warn('[assets] WARNING: @xterm/xterm/css/xterm.css not found; terminal styling will be missing.');
  }

  console.log('[assets] Done.\n');

  if (isWatch) {
    // esbuild only watches the TS entry graph, so HTML/CSS edits were
    // invisible until a full rebuild.
    console.log('[assets] Watching public assets for changes...');
    fs.watch(publicSrc, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const src = path.join(publicSrc, filename);
      const dest = path.join(publicDest, filename);
      try {
        if (!fs.existsSync(src)) return;
        if (fs.statSync(src).isDirectory()) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`[assets] Updated ${filename}`);
      } catch (error) {
        console.error(`[assets] Failed to copy ${filename}:`, error.message);
      }
    });
  }

  console.log('Build complete!');
}

const REPO_ROOT = path.join(__dirname, '..');

function git(args) {
  // stdio must NOT be 'inherit': without a .git directory git writes
  // "fatal: not a git repository" straight into the user's install log.
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Record which commit this build came from, so the running server can ask
 * GitHub whether it is behind.
 *
 * It has to be a git SHA rather than the package version: installs come from
 * `github:dnviti/code-agents-webcli`, which resolves to whatever main's HEAD
 * is, and package.json's version only moves on release.
 *
 * The file lands in dist/ because that is what ships — package.json "files"
 * publishes bin/ and dist/ only, so a generated file anywhere else would be
 * missing from the installed package.
 */
function writeBuildInfo(distDir) {
  const pkg = require('../package.json');
  const info = {
    version: pkg.version,
    sha: null,
    commitDate: null,
    dirty: false,
    source: 'unknown',
    builtAt: new Date().toISOString(),
  };

  const envSha = (process.env.CODE_AGENTS_WEBCLI_BUILD_SHA || '').trim();
  const envDate = (process.env.CODE_AGENTS_WEBCLI_BUILD_DATE || '').trim();

  if (/^[0-9a-f]{40}$/.test(envSha)) {
    // Docker and CI: .dockerignore excludes .git, so the SHA has to be passed in.
    info.sha = envSha;
    info.commitDate = /^\d{4}-\d{2}-\d{2}T/.test(envDate) ? envDate : null;
    info.source = 'env';
  } else {
    try {
      const sha = git(['rev-parse', 'HEAD']);
      if (/^[0-9a-f]{40}$/.test(sha)) {
        info.sha = sha;
        info.source = 'git';
        try {
          info.commitDate = git(['show', '-s', '--format=%cI', 'HEAD']);
        } catch {
          // Shallow clone without the commit object; the SHA alone is enough.
        }
        // `dirty` marks a working tree the maintainer has edited, which turns
        // update checks informational. It must NOT be sampled while npm is
        // packing a release: prepack runs in the publisher's tree, so their
        // unrelated local edits would ship as "this build is modified" to
        // every user of the tarball.
        const packing = process.env.npm_lifecycle_event === 'prepack';
        if (!packing) {
          try {
            info.dirty = git(['status', '--porcelain']).length > 0;
          } catch {
            // Not fatal; assume clean.
          }
        }
      }
    } catch {
      // Both "not a git repository" (exit 128) and "git is not installed"
      // (ENOENT) land here. A build with no commit identity is supported; it
      // just cannot offer update checks.
    }
  }

  fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2));
  const label = info.sha ? info.sha.slice(0, 7) : 'unknown';
  console.log(`[build-info] ${info.source}: ${label}${info.dirty ? '-dirty' : ''}\n`);
  return info;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
