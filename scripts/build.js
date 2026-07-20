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
    if (fs.existsSync(src)) {
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
