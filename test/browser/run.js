#!/usr/bin/env node
// Bundles the browser checks, runs them in headless Chrome, and fails the
// process if any check reports FAIL.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { findCommand } = require('./find-command.js');

const dir = __dirname;
const strict = process.argv.slice(2).includes('--strict') || Boolean(process.env.CI);
const chrome = findCommand(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);

if (!chrome) {
  // Skipping is a convenience for a non-strict local run that happens to have
  // no browser. Strict runs are the release gate for defects only a layout
  // engine can expose, so they must fail rather than report a false green.
  if (strict) {
    console.error('No Chrome/Chromium on PATH. Strict browser checks must run, not skip.');
    process.exit(1);
  }
  console.log('Skipping browser checks: no Chrome/Chromium on PATH.');
  process.exit(0);
}

if (!fs.existsSync(path.join(dir, '..', '..', 'dist', 'public', 'css', 'components', 'terminal.css'))) {
  console.error('Run `npm run build` first: the checks load the built stylesheets.');
  process.exit(1);
}

function prepareBrowserFixtures() {
// What a real workflow reports, in the form the browser receives it (#117).
//
// Derived here rather than written into checks.ts, because a check driven by
// events someone typed out proves the component agrees with that person. The
// recordings are real runs captured off the wire, and this replays each one
// through the adapter that would have carried it, so the browser gets exactly
// what a browser would have got. Generated on every run, so they can never
// drift from either end.
//
// Two of them. `claude-workflow.jsonl` is a run that finished, with one agent
// inside it failing; `claude-workflow-failed.jsonl` is a run that failed
// outright after every agent inside it failed. Both were reported to the user
// as a green "done" before #140.
{
  const { ClaudeChatAdapter } = require('../../dist/server/chat/adapters/claude.js');
  const replay = (fixture) => {
    const events = [];
    const adapter = new ClaudeChatAdapter({
      sessionId: 'browser-check',
      workingDir: '/tmp',
      command: 'claude',
      emit: (event) => events.push(event),
    });
    fs.readFileSync(path.join(dir, '..', 'fixtures', 'chat', fixture), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .forEach((message) => adapter.handleMessage(message));
    return events;
  };
  fs.writeFileSync(
    path.join(dir, 'workflow-events.json'),
    JSON.stringify(replay('claude-workflow.jsonl')),
  );
  fs.writeFileSync(
    path.join(dir, 'workflow-failed-events.json'),
    JSON.stringify(replay('claude-workflow-failed.jsonl')),
  );
  // The same run with everything the runtime said *about the run* left out,
  // which is what a runtime going quiet looks like (#139): the call is opened
  // and never mentioned again, and the turn ends anyway.
  //
  // Its own artefact rather than a filter applied in the browser, because the
  // reducer stores a `block_start`'s block by reference and writes into it — so
  // by the time a later check filtered the shared import, an earlier one had
  // already left its own results on those objects.
  fs.writeFileSync(
    path.join(dir, 'workflow-quiet-events.json'),
    JSON.stringify(
      replay('claude-workflow.jsonl').filter(
        (event) => !['agent_progress', 'agent_step', 'workflow_progress', 'tool'].includes(event.t),
      ),
    ),
  );
}

// A real Oh My Pi conversation, at the level the browser receives it (#132).
//
// Already a ChatEvent log — these are the app's own recordings, not a runtime's
// wire format — so there is no adapter to replay it through: parsed and handed
// straight over. Five steps whose whole reply was a space, and the one that
// finally said something.
fs.writeFileSync(
  path.join(dir, 'empty-rows-events.json'),
  JSON.stringify(
    fs
      .readFileSync(path.join(dir, '..', 'fixtures', 'chat', 'omp-empty-rows.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  ),
);

// One turn of a real Oh My Pi conversation, in the form the browser receives it
// (#129).
//
// Generated for the same reason as the two above: the claim is "one prompt
// draws one bubble", and a hand-written event stream would only prove that the
// component agrees with whoever wrote it. This drives the real ACP adapter with
// a real `send()` — which is where the second copy of the prompt used to come
// from — and hands the browser exactly what a browser would have got.
{
  const { AcpChatAdapter } = require('../../dist/server/chat/adapters/acp.js');
  const events = [];
  const adapter = new AcpChatAdapter({
    sessionId: 'browser-check',
    workingDir: '/tmp',
    command: '/nonexistent',
    runtime: 'omp',
    acpArgs: ['acp'],
    emit: (event) => events.push(event),
  });
  adapter.writeLine = () => {};
  const lines = fs
    .readFileSync(path.join(dir, '..', 'fixtures', 'chat', 'acp-omp.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  adapter.handshake();
  for (const line of lines.slice(0, 2)) adapter.handleMessage(line);
  // The handshake settles on a microtask and this file is synchronous, so the
  // one thing it would have left behind is put there by hand — read off the
  // same line of the same capture the handshake reads it from. Without it
  // `send` bails on "no ACP session" and writes nothing, which would leave this
  // check quietly passing against the very code it exists to catch.
  adapter.nativeSessionId = lines[1].result.sessionId;
  // Synchronous as far as the transcript is concerned: the RPC is fired with
  // `.then`, so everything this writes has been written by the time it returns.
  adapter.send({ text: 'What is the magic word?' });
  for (const line of lines.slice(2)) adapter.handleMessage(line);
  fs.writeFileSync(path.join(dir, 'omp-turn-events.json'), JSON.stringify(events));
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
}

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
  if (url.pathname === '/auth/pair') {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end('NETWORK_PHONE_PAIR_BOOTSTRAP');
    return;
  }
  // Normalised first and required to stay under one of the roots afterwards, so
  // a `..` in the request cannot walk out of the directories served here.
  const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
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

// Probe loopback before starting the real fixture server. Some managed
// environments deny listeners outright; report that as a clean local skip,
// while strict mode must fail before Chrome is launched (and before an
// uncaught listen error can leave the process hanging).
function probeLoopback(timeoutMilliseconds = 2_000) {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { probe.close(); } catch {}
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => {
      finish(error);
    };
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`listener did not become ready within ${timeoutMilliseconds}ms`), {
        code: 'ETIMEDOUT',
      });
      finish(error);
    }, timeoutMilliseconds);
    probe.once('error', onError);
    try {
      probe.listen(0, '127.0.0.1', () => probe.close((error) => finish(error)));
      probe.unref();
    } catch (error) {
      finish(error);
    }
  });
}

async function startFixtureServer() {
  try {
    await probeLoopback();
  } catch (error) {
    const message = `loopback listener unavailable: ${String(error?.message || error)}`;
    if (strict) {
      console.error(`Strict browser checks cannot run: ${message}`);
      process.exitCode = 1;
    } else {
      console.log(`Skipping browser checks: ${message}`);
    }
    return;
  }
  prepareBrowserFixtures();
  server.once('error', (error) => {
    const message = `loopback listener unavailable: ${String(error?.message || error)}`;
    console.error(`Browser checks failed after the loopback preflight: ${message}`);
    process.exitCode = 1;
  });
  server.listen(0, '127.0.0.1', () => run(server.address().port));
}

startFixtureServer().catch((error) => {
  console.error(`Browser checks could not start: ${String(error?.stack || error)}`);
  process.exitCode = 1;
});

function timeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function devToolsEndpoint(child) {
  return timeout(new Promise((resolve, reject) => {
    let output = '';
    const parse = (chunk) => {
      output = `${output}${chunk}`.slice(-32 * 1024);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    };
    child.stderr.on('data', parse);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Chrome exited before DevTools was ready (${code}).`)));
  }), 10_000, 'Chrome DevTools startup');
}

function connectCdp(endpoint) {
  return timeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const pending = new Map();
    const events = [];
    let nextId = 1;
    socket.once('error', reject);
    socket.once('open', () => {
      const client = {
        send(method, params = {}, sessionId) {
          return new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCall, reject: rejectCall });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        once(method, sessionId) {
          return new Promise((resolveEvent) => events.push({ method, sessionId, resolve: resolveEvent }));
        },
        close() { socket.close(); },
      };
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString('utf8'));
        if (message.id) {
          const call = pending.get(message.id);
          if (!call) return;
          pending.delete(message.id);
          if (message.error) call.reject(new Error(message.error.message || 'Chrome DevTools command failed.'));
          else call.resolve(message.result || {});
          return;
        }
        const index = events.findIndex((event) => event.method === message.method
          && (!event.sessionId || event.sessionId === message.sessionId));
        if (index >= 0) events.splice(index, 1)[0].resolve(message.params || {});
      });
      resolve(client);
    });
  }), 10_000, 'Chrome DevTools connection');
}

function waitForChildExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), milliseconds);
    // Close the listener-registration race if Chrome exited between the first
    // state check and child.once().
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function runInstalledWorkerCheck(chrome, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-worker-check-'));
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectCdp(await devToolsEndpoint(child));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/page.html` }, sessionId);
    await timeout(loaded, 10_000, 'worker-check page load');
    const expression = `(async()=>{
      const registration=await navigator.serviceWorker.register('/service-worker.js');
      await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller){
        await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      }
      const cacheName='phone-access-pairing-adversarial';
      const cache=await caches.open(cacheName);
      await cache.put('/auth/pair',new Response('<title>CACHED SHELL</title>',{headers:{'content-type':'text/html'}}));
      const response=await fetch('/auth/pair#token=fragment-never-sent',{cache:'no-store'});
      const body=await response.text();
      await caches.delete(cacheName);
      await registration.unregister();
      return {controlled:Boolean(navigator.serviceWorker.controller),status:response.status,body};
    })()`;
    const evaluated = await timeout(cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId), 15_000, 'installed service-worker check');
    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'Worker check threw.');
    }
    const value = evaluated.result?.value || {};
    if (!value.controlled || value.status !== 200
      || value.body !== 'NETWORK_PHONE_PAIR_BOOTSTRAP' || value.body.includes('CACHED SHELL')) {
      throw new Error(`unexpected worker result ${JSON.stringify(value)}`);
    }
    return 'PASS :: the installed worker keeps pairing network-only';
  } catch (error) {
    return `FAIL :: the installed worker keeps pairing network-only :: ${String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500)}`;
  } finally {
    try {
      if (cdp) await timeout(cdp.send('Browser.close'), 2_000, 'Chrome shutdown');
    } catch {}
    cdp?.close();
    if (!(await waitForChildExit(child, 1_000))) {
      try { child.kill('SIGTERM'); } catch {}
      if (!(await waitForChildExit(child, 2_000))) {
        try { child.kill('SIGKILL'); } catch {}
        await waitForChildExit(child, 2_000);
      }
    }
    // Chrome may finish an atomic profile write just after its parent exits.
    // Node retries ENOTEMPTY for recursive removals when maxRetries is set.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

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
      //
      // Raised from 90s when the 5.3.2 checks landed together and started
      // running it out. Worth knowing what that looks like from the inside: a
      // spent budget does not stop the page, it makes every timer come back at
      // once — so a check that waits for something to be drawn spins through
      // its whole allowance in an instant and reports that it never appeared.
      // It reads as one flaky check rather than as a deadline.
      '--virtual-time-budget=240000',
      '--dump-dom',
      `http://127.0.0.1:${port}/page.html`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    async (error, out) => {
      fs.rmSync(path.join(dir, 'bundle.js'), { force: true });

      const match = String(out).match(/<pre id="results">([\s\S]*?)<\/pre>/);
      if (!match) {
        server.close();
        console.error('Browser checks produced no results.');
        if (error) console.error(String(error.message).split('\n')[0]);
        if (process.env.BROWSER_CHECK_TRACE) console.error(String(out).slice(-4_000));
        process.exit(1);
      }

      const uiReport = match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      const workerReport = await runInstalledWorkerCheck(chrome, port);
      const report = `${uiReport}\n${workerReport}`;
      server.close();

      console.log(process.env.BROWSER_CHECK_PHONE_ONLY
        ? report.split('\n').filter((line) => /Tailscale|installed worker|checked Tailscale/.test(line)).join('\n')
        : report);
      process.exit(/^FAIL/m.test(report) ? 1 : 0);
    },
  );
}
