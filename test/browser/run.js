#!/usr/bin/env node
// Bundles the browser checks, runs them in headless Chrome, and fails the
// process if any check reports FAIL.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const chrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((bin) => {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
});

if (!chrome) {
  console.log('Skipping browser checks: no Chrome/Chromium on PATH.');
  process.exit(0);
}

if (!fs.existsSync(path.join(dir, '..', '..', 'dist', 'public', 'css', 'components', 'terminal.css'))) {
  console.error('Run `npm run build` first: the checks load the built stylesheets.');
  process.exit(1);
}

// The esbuild `bin` entry is a native executable, not a script: use the API.
require('esbuild').buildSync({
  entryPoints: [path.join(dir, 'checks.ts')],
  bundle: true,
  outfile: path.join(dir, 'bundle.js'),
  format: 'iife',
  target: ['es2020'],
});

const out = execFileSync(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--virtual-time-budget=20000',
    '--dump-dom',
    `file://${path.join(dir, 'page.html')}`,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
);

fs.rmSync(path.join(dir, 'bundle.js'), { force: true });

const match = out.match(/<pre id="results">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('Browser checks produced no results.');
  process.exit(1);
}

const report = match[1]
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

console.log(report);
process.exit(/^FAIL/m.test(report) ? 1 : 0);
