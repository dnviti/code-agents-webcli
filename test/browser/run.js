#!/usr/bin/env node
// Bundles the browser checks, runs them in headless Chrome, and fails the
// process if any check reports FAIL.
const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
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

// Served over HTTP rather than opened from disk, because one of the things
// under test is a chunk the app fetches by absolute path at runtime: from a
// `file://` page `/monaco.bundle.js` resolves to the filesystem root and can
// never arrive. That is why 375 checks could cover every part the file editor
// is made of and none of them the editor (issue #77).
//
// Two roots: the built public directory, so every asset is reached by the same
// path the app uses, and this directory, for the page and the check bundle.
// Resolved, because they are compared against resolved paths below: an
// unnormalised root never prefixes a normalised file, and every asset under it
// would quietly 404 — which for a stylesheet means checks measuring a page that
// has none.
const ROOTS = [path.resolve(dir, '..', '..', 'dist', 'public'), path.resolve(dir)];
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  // Normalised first and required to stay under one of the roots afterwards, so
  // a `..` in the request cannot walk out of the directories served here.
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  const found = ROOTS.map((root) => path.join(root, relative)).find(
    (file) =>
      ROOTS.some((root) => file.startsWith(root + path.sep)) &&
      fs.existsSync(file) &&
      fs.statSync(file).isFile(),
  );
  if (!found) {
    if (process.env.BROWSER_CHECK_TRACE) process.stderr.write(`404 ${relative}\n`);
    response.writeHead(404);
    response.end('not found');
    return;
  }
  if (process.env.BROWSER_CHECK_TRACE) process.stderr.write(`served ${relative}\n`);
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(found)] || 'application/octet-stream' });
  fs.createReadStream(found).pipe(response);
});

server.listen(0, '127.0.0.1', () => run(server.address().port));

// Spawned rather than run synchronously, and this is not a style choice: the
// page is served by the server above, in this process, so a synchronous child
// would hold the event loop and never answer the request for the page it is
// waiting on. Chrome would sit there until something killed it.
function run(port) {
  execFile(
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
      '--virtual-time-budget=90000',
      '--dump-dom',
      `http://127.0.0.1:${port}/page.html`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    (error, out) => {
      fs.rmSync(path.join(dir, 'bundle.js'), { force: true });
      server.close();

      const match = String(out).match(/<pre id="results">([\s\S]*?)<\/pre>/);
      if (!match) {
        console.error('Browser checks produced no results.');
        if (error) console.error(String(error.message).split('\n')[0]);
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
    },
  );
}
