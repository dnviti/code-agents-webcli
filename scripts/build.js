#!/usr/bin/env node

const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CLIENT_TARGET } = require('./client-bundle.js');
const { writeLegacyServiceForwarders } = require('./service-compatibility.js');

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

function compileTypeScript(scope, project) {
  console.log(`[${scope}] Compiling TypeScript...`);
  try {
    execFileSync(process.execPath, [resolveTsc(), '--project', project], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });
    console.log(`[${scope}] Done.\n`);
  } catch {
    console.error(`[${scope}] TypeScript compilation failed`);
    process.exit(1);
  }
}

const PRIVATE_SERVER_SLICES = [
  'server-core',
  'server-environment',
  'server-functions',
  'server-lifecycle',
  'server-runtime',
  'server-workspace',
];

/**
 * Keep the source composition root split without publishing new deep imports.
 * Only the private slices are folded into index.js; every established server
 * module remains an external require at its existing path.
 */
async function bundlePrivateServerSlices() {
  console.log('[server] Bundling private composition slices...');
  const privateFiles = new Set(PRIVATE_SERVER_SLICES.map((name) => `${name}.js`));
  const result = await esbuild.build({
    entryPoints: ['dist/server/index.js'],
    outfile: 'dist/server/index.js',
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: true,
    packages: 'external',
    plugins: [{
      name: 'private-server-slices',
      setup(build) {
        build.onResolve({ filter: /^\.\.?[\\/]/ }, (args) => {
          if (args.kind === 'entry-point' || privateFiles.has(path.basename(args.path))) {
            return undefined;
          }
          return { path: args.path, external: true };
        });
      },
    }],
  });

  for (const output of result.outputFiles) {
    fs.writeFileSync(output.path, output.contents);
  }

  const serverDir = path.join(__dirname, '..', 'dist', 'server');
  for (const name of PRIVATE_SERVER_SLICES) {
    for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
      fs.rmSync(path.join(serverDir, `${name}${suffix}`), { force: true });
    }
  }
  console.log('[server] Private slices bundled.\n');
}

async function build() {
  console.log('Building code-agents-webcli...\n');

  const distDir = path.join(__dirname, '..', 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  const buildInfo = writeBuildInfo(distDir);
  // Identifies this bundle to the service-worker cache. Falls back to the
  // build timestamp so a source build still busts its own cache.
  // A commit identifies a released build exactly, but says nothing about a
  // working tree: every build from uncommitted changes produced the *same*
  // `<sha>-dirty` id, so the service worker kept serving the client it had
  // already cached however many times the bundle was rebuilt. A fix could be
  // built, shipped and reloaded, and the browser would still run the broken
  // bundle — which is precisely how it behaves when you most need it not to.
  //
  // Only the working-tree case needs the extra entropy; a clean build stays
  // reproducible and keeps its commit as the id.
  const buildId = buildInfo.sha && !buildInfo.dirty
    ? buildInfo.sha.slice(0, 12)
    : `${buildInfo.sha ? `${buildInfo.sha.slice(0, 12)}-` : ''}${buildInfo.builtAt.replace(/[^0-9]/g, '')}`;

  // 1. Compile Node/server and browser SDKs with their own platform libraries.
  compileTypeScript('server', 'tsconfig.json');
  await bundlePrivateServerSlices();
  const legacyServices = writeLegacyServiceForwarders(
    path.join(__dirname, '..', 'dist', 'server', 'services'),
  );
  console.log(`[server] Wrote ${legacyServices.length} legacy service forwarders.\n`);
  compileTypeScript('sdk/browser', 'tsconfig.sdk-browser.json');

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
      // Shared with the browser checks so they test what actually ships.
      target: CLIENT_TARGET,
      // The Relay shell is .tsx. 'automatic' matches tsconfig.client.json's
      // "jsx": "react-jsx", so components do not have to import React just to
      // use JSX — only to use hooks.
      jsx: 'automatic',
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

  // 2b. Bundle Mermaid as its own chunk.
  //
  // Kept out of the main bundle deliberately: Mermaid is larger than everything
  // else the client ships put together, and it is only reachable when a message
  // actually contains a ```mermaid fence. Loading it on demand keeps the cost
  // off every other session. It is bundled rather than pulled from a CDN
  // because this app is routinely run on a LAN with no outbound internet, and a
  // diagram that only renders when GitHub is reachable is not a feature.
  console.log('[mermaid] Bundling diagram renderer...');
  try {
    const mermaidCtx = await esbuild.context({
      entryPoints: ['src/client/chat/mermaid-entry.ts'],
      bundle: true,
      outfile: 'dist/public/mermaid.bundle.js',
      format: 'iife',
      globalName: 'ClaudeCodeWebMermaid',
      // Only in watch mode. This map is 12.7 MB — on its own, more than a third
      // of everything the package ships — and every byte of it describes
      // vendored third-party rendering code, not this app. Dropping it from
      // release builds is the single largest saving available to an install,
      // and costs nothing: with sourcemap off esbuild omits the
      // sourceMappingURL comment too, so the browser never asks for it.
      // app.bundle.js keeps its map, because that one is our code.
      sourcemap: isWatch,
      minify: !isWatch,
      target: CLIENT_TARGET,
      define: {
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
      }
    });

    if (isWatch) {
      await mermaidCtx.watch();
    } else {
      await mermaidCtx.rebuild();
      await mermaidCtx.dispose();
    }
    console.log('[mermaid] Done.\n');
  } catch (error) {
    console.error('[mermaid] Bundle failed:', error.message);
    process.exit(1);
  }

  // 2c. Bundle Monaco as its own chunk, plus its worker.
  //
  // Same bargain as Mermaid above, at a larger scale: the code editor is around
  // 3 MB and opens from one row of one panel, so it is fetched the first time
  // someone opens a file and never otherwise. And bundled rather than loaded
  // from a CDN — Monaco's usual AMD loader wants exactly that — because this
  // app is routinely run on a LAN with no outbound route, where an editor that
  // needs jsdelivr is not an editor.
  //
  // Two outputs beside the script:
  //
  //   - the stylesheet, because Monaco imports CSS from inside its own modules.
  //     esbuild emits it next to the bundle and chat/monaco.ts injects it.
  //   - the worker, as a separate top-level bundle. A worker cannot be part of
  //     an IIFE that is loaded with a <script> tag; it is a second entry point
  //     to a second file, which is what `MonacoEnvironment.getWorker` fetches.
  //
  // The codicon font is inlined as a data URI rather than emitted: it is 70 kB,
  // it is referenced from inside vendored CSS, and inlining removes an asset
  // whose relative path would otherwise have to survive the copy step below.
  console.log('[monaco] Bundling code editor...');
  try {
    // Resolved here, not written as a path in the source. Monaco's `exports`
    // map rewrites every subpath to `./esm/vs/*.js`, so its stylesheets are
    // unreachable by package name — and a relative `../../node_modules/...`
    // in the entry file is a guess about hoisting that breaks the first time
    // this is installed as a dependency of something else.
    //
    // Resolved through a module rather than through `package.json`: that map
    // catches `./package.json` too and rewrites it to `package.json.js`, which
    // does not exist. `editor.api` is a real file, and the codicon directory
    // sits at a fixed place relative to it inside the package.
    const editorApi = require.resolve('monaco-editor/editor/editor.api');
    const codicons = path.resolve(
      path.dirname(editorApi),
      '../base/browser/ui/codicons/codicon',
    );

    const monacoOptions = {
      alias: {
        'monaco-codicons/codicon.css': path.join(codicons, 'codicon.css'),
        'monaco-codicons/codicon-modifiers.css': path.join(codicons, 'codicon-modifiers.css'),
      },
      bundle: true,
      format: 'iife',
      // Monaco's own maps are tens of megabytes of vendored editor internals —
      // the same reasoning as the Mermaid map above, and the same answer.
      sourcemap: isWatch,
      minify: !isWatch,
      target: CLIENT_TARGET,
      loader: { '.ttf': 'dataurl' },
    };

    const monacoCtx = await esbuild.context({
      ...monacoOptions,
      entryPoints: ['src/client/chat/monaco-entry.ts'],
      outfile: 'dist/public/monaco.bundle.js',
      globalName: 'ClaudeCodeWebMonaco',
    });

    // No globalName: nothing imports this, the browser runs it as a worker.
    const monacoWorkerCtx = await esbuild.context({
      ...monacoOptions,
      entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
      outfile: 'dist/public/monaco-editor.worker.js',
    });

    if (isWatch) {
      await monacoCtx.watch();
      await monacoWorkerCtx.watch();
    } else {
      await monacoCtx.rebuild();
      await monacoCtx.dispose();
      await monacoWorkerCtx.rebuild();
      await monacoWorkerCtx.dispose();
    }
    console.log('[monaco] Done.\n');
  } catch (error) {
    console.error('[monaco] Bundle failed:', error.message);
    process.exit(1);
  }

  // 3. Rasterise the app icons, then copy public assets.
  //
  // Before the copy, because it writes into src/public/icons and
  // src/public/favicon.ico — running it after would ship the previous set.
  try {
    require('./build-icons.js');
  } catch (error) {
    console.warn('[icons] skipped:', error.message);
  }

  console.log('[assets] Copying public files...');
  const publicSrc = path.join(__dirname, '..', 'src', 'public');
  const publicDest = path.join(__dirname, '..', 'dist', 'public');

  fs.mkdirSync(publicDest, { recursive: true });

  const filesToCopy = ['index.html', 'manifest.json', 'service-worker.js', 'favicon.ico'];
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

  // Copy the icon set
  const iconSrc = path.join(publicSrc, 'icons');
  if (fs.existsSync(iconSrc)) {
    copyDir(iconSrc, path.join(publicDest, 'icons'));
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

  copyBuiltinWorkflowAssets({ watch: isWatch });

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

/**
 * Built-in workflows are application assets, not guest-installed skills. Keep
 * them beside the compiled chat server so an npm package and Docker image ship
 * the exact guidance used at runtime.
 */
function copyBuiltinWorkflowAssets({ watch }) {
  const sourceRoot = path.join(REPO_ROOT, 'src', 'server', 'chat', 'builtin-workflows');
  const destinationRoot = path.join(REPO_ROOT, 'dist', 'server', 'chat', 'builtin-workflows');
  const ghIssueSource = path.join(sourceRoot, 'gh-issue', 'SKILL.md');
  const ghIssueDestination = path.join(destinationRoot, 'gh-issue', 'SKILL.md');

  if (!fs.existsSync(ghIssueSource)) {
    throw new Error(`[workflows] Required bundled workflow is missing: ${ghIssueSource}`);
  }

  const copy = () => {
    fs.mkdirSync(path.dirname(ghIssueDestination), { recursive: true });
    fs.copyFileSync(ghIssueSource, ghIssueDestination);
  };

  copy();
  console.log('[workflows] Copied bundled gh-issue workflow.');

  if (watch) {
    fs.watch(ghIssueSource, (_event) => {
      try {
        if (!fs.existsSync(ghIssueSource)) {
          throw new Error('source file was removed');
        }
        copy();
        console.log('[workflows] Updated bundled gh-issue workflow.');
      } catch (error) {
        console.error('[workflows] Failed to copy bundled gh-issue workflow:', error.message);
      }
    });
  }
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
