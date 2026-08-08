const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { CodexExecAdapter } = require('../dist/server/chat/adapters/codex.js');

// The one-shot adapters must always deliver EOF. Pi writes its prompt and then
// closes the pipe; Codex gets a closed stdin because its prompt is in argv.
// Leaving either writer open makes the CLI wait forever: from the browser that
// is a turn that simply never answers — no error, no exit, nothing to click.
//
// The stub below is that behaviour in miniature: it emits only once stdin has
// reached EOF, which happens immediately when stdin is closed and never when it
// is an open pipe nobody writes to. So these fail by timing out, exactly as the
// real thing did.

const ROOT = path.join(__dirname, '..');

let dir;
let stub;

before(function () {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-stdin-'));
  stub = path.join(dir, 'stub-runtime.js');
  fs.writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "// Emits one protocol line, but only after stdin reaches EOF.",
      "const chunks = [];",
      "const done = () => {",
      "  const prompt = Buffer.concat(chunks).toString('utf8');",
      "  process.stdout.write(JSON.stringify({ type: 'session', id: prompt ? `stub:${prompt}` : 'stub-session', cwd: process.cwd() }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      '  process.exit(0);',
      '};',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', done);",
      // An 'ignore'd stdin is /dev/null and Pi explicitly ends its prompt
      // pipe; a pipe with a live writer never ends. No timer here on purpose — a fallback would
      // hide the very hang this is checking for.
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

after(function () {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function collect() {
  const events = [];
  return {
    events,
    /** Resolves when the adapter emits an event of this type. */
    waitFor(type, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
          const hit = events.find((e) => e.t === type);
          if (hit) {
            clearInterval(poll);
            resolve(hit);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            clearInterval(poll);
            reject(
              new Error(
                `no "${type}" after ${timeoutMs}ms — the child is stuck on stdin. ` +
                  `Saw: ${JSON.stringify(events.map((e) => e.t))}`,
              ),
            );
          }
        }, 25);
      });
    },
  };
}

function options(sink, extra = {}) {
  return {
    sessionId: 'stdin-test',
    workingDir: ROOT,
    command: 'node',
    // The stub is the argv[1] the adapter's own flags follow; it ignores them.
    extraArgs: [],
    emit: (event) => sink.events.push(event),
    ...extra,
  };
}

describe('one-shot chat adapters finish stdin', function () {
  this.timeout(20000);

  // When these fail they fail by *not* getting output, which means the child is
  // still alive and holding the event loop open. Torn down here rather than at
  // the end of each test, so a regression reports its assertion instead of
  // hanging mocha and looking like a broken test run.
  let live = null;
  afterEach(async function () {
    const adapter = live;
    live = null;
    if (adapter) await adapter.stop().catch(() => undefined);
  });

  it('pi receives the prompt on stdin and produces a turn after EOF', async function () {
    const sink = collect();
    // `command` is the executable and the adapter appends its own flags, so the
    // stub is reached by running it as node's script argument.
    live = new PiChatAdapter(options(sink, { command: process.execPath, extraArgs: [] }));
    live.buildArgs = () => [stub];

    await live.start();
    await live.send({ text: 'hello' });

    const session = await sink.waitFor('session');
    assert.strictEqual(session.nativeSessionId, 'stub:hello');
  });

  it('codex exec produces a turn instead of waiting on a pipe nobody writes to', async function () {
    const sink = collect();
    live = new CodexExecAdapter(options(sink, { command: process.execPath }));
    live.buildArgs = () => [stub];

    await live.start();
    await live.send({ text: 'hello' });

    // `turn_end` is the assertion because it is emitted from the child's own
    // exit handler. The `state` events around a turn are emitted before the
    // spawn, so waiting on one of those would pass just as happily with the
    // child wedged on stdin — which is to say, prove nothing.
    const end = await sink.waitFor('turn_end');
    assert.ok(end, 'the turn must close, which only happens once the child exits');
  });
});
