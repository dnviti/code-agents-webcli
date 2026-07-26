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
  // Skipping is a convenience for a machine that happens to have no browser,
  // never for CI: these checks are the only thing covering defects that a
  // layout engine has to be running to see, and a silent skip there would
  // report a green build for a suite that never ran.
  if (process.env.CI) {
    console.error('No Chrome/Chromium on PATH. CI must run the browser checks, not skip them.');
    process.exit(1);
  }
  console.log('Skipping browser checks: no Chrome/Chromium on PATH.');
  process.exit(0);
}

if (!fs.existsSync(path.join(dir, '..', '..', 'dist', 'public', 'css', 'components', 'terminal.css'))) {
  console.error('Run `npm run build` first: the checks load the built stylesheets.');
  process.exit(1);
}

// The esbuild `bin` entry is a native executable, not a script: use the API.
//
// Minified, at the shipped target: the settings are half of what is under test.
// Built unminified at a laxer target, these checks passed while the real bundle
// carried a `ReferenceError` that blanked the terminal on the first mode query
// — the defect lived in the minifier's output, so nothing that skipped
// minification could see it.
require('esbuild').buildSync({
  entryPoints: [path.join(dir, 'checks.ts')],
  bundle: true,
  outfile: path.join(dir, 'bundle.js'),
  format: 'iife',
  minify: true,
  target: require('../../scripts/client-bundle.js').CLIENT_TARGET,
});

const out = execFileSync(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Big enough for every fixture to fit inside the viewport.
    //
    // The default is 800x600, and the phone checks mount a 390x740 surface —
    // so a third of it was below the window. Layout is unaffected (the host is
    // absolutely sized), but anything that asks the *viewport* a question is:
    // `elementFromPoint` returns null off-screen, which reads as "nothing is
    // covering this control" for a control that is not on screen at all.
    '--window-size=1600,1000',
    // Virtual milliseconds, so this costs wall-clock only while something is
    // actually waiting. It is a deadline for the whole suite, and a suite that
    // outgrows it does not report failures — it dumps a page with no results
    // at all, which is why this has room over what the checks currently need.
    '--virtual-time-budget=40000',
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
