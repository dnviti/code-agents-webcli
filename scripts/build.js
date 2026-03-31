#!/usr/bin/env node

const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

async function build() {
  console.log('Building code-agents-webcli...\n');

  // 1. Compile server TypeScript
  console.log('[server] Compiling TypeScript...');
  try {
    execSync('npx tsc --project tsconfig.json', { stdio: 'inherit' });
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

  console.log('[assets] Done.\n');
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
