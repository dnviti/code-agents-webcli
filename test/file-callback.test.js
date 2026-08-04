const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  FILE_CALLBACK_GENERATED_CLIENT_SOURCE,
  FileCallbackBroker,
  requestFileCallback,
} = require('../dist/server/chat/file-callback.js');
const {
  fileMcpConfig,
  writeFileMcpBridge,
} = require('../dist/server/chat/file-mcp-bridge.js');
const {
  PI_ASK_EXTENSION,
  writePiAskExtension,
} = require('../dist/server/chat/pi-ask-extension.js');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function eventually(check, timeout = 2_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await delay(15);
  }
  assert.ok(check(), 'condition was not reached before timeout');
}

function fileContentsBelow(root) {
  const contents = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else contents.push(fs.readFileSync(file, 'utf8'));
    }
  };
  visit(root);
  return contents;
}

describe('file callback broker', function () {
  let home;
  let broker;

  beforeEach(function () {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-'));
  });

  afterEach(async function () {
    await broker?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('round-trips generic question and plan envelopes atomically', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const seen = [];
    const endpoint = await broker.listen(async (request) => {
      seen.push(request);
      return { received: request.payload };
    });

    assert.deepStrictEqual(
      await requestFileCallback(endpoint, 'question', { question: 'Which?', options: ['A', 'B'] }, { pollMs: 5 }),
      { received: { question: 'Which?', options: ['A', 'B'] } },
    );
    assert.deepStrictEqual(
      await requestFileCallback(endpoint, 'plan', { summary: 'Do it' }, { pollMs: 5 }),
      { received: { summary: 'Do it' } },
    );
    assert.deepStrictEqual(seen.map((request) => request.kind), ['question', 'plan']);
    assert.ok(endpoint.directory.startsWith(path.join(home, '.ccweb-callback')));
    assert.strictEqual(fs.statSync(endpoint.directory).mode & 0o777, 0o500);
    assert.strictEqual(fs.statSync(path.join(endpoint.directory, 'ccweb-mcp.mjs')).mode & 0o777, 0o600);
  });

  it('persists only authenticated ciphertext for requests, replies, leases, and heartbeats', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    let release;
    let started;
    const waiting = new Promise((resolve) => { release = resolve; });
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const requestSecret = 'QUESTION_PAYLOAD_d05aa79d';
    const replySecret = 'ANSWER_PAYLOAD_77ce9c12';
    const endpoint = await broker.listen(async () => {
      started();
      await waiting;
      return { answer: replySecret };
    });

    const pending = requestFileCallback(
      endpoint,
      'question',
      { question: requestSecret },
      { pollMs: 200 },
    );
    await startedPromise;
    let serialized = fileContentsBelow(endpoint.directory).join('\n');
    assert.ok(!serialized.includes(endpoint.token));
    assert.ok(!serialized.includes(requestSecret));
    assert.ok(!serialized.includes('"kind":"question"'));

    release();
    await eventually(() => fs.readdirSync(path.join(endpoint.directory, 'replies'))
      .some((entry) => !['heartbeat.json', 'lease.json'].includes(entry)));
    serialized = fileContentsBelow(endpoint.directory).join('\n');
    assert.ok(!serialized.includes(endpoint.token));
    assert.ok(!serialized.includes(requestSecret));
    assert.ok(!serialized.includes(replySecret));
    assert.deepStrictEqual(await pending, { answer: replySecret });
  });

  it('dispatches a second request while the first is still waiting', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    let releaseFirst;
    const firstWaiting = new Promise((resolve) => { releaseFirst = resolve; });
    const endpoint = await broker.listen(async (request) => {
      if (request.payload.order === 1) await firstWaiting;
      return request.payload.order;
    });

    const first = requestFileCallback(endpoint, 'question', { order: 1 }, { pollMs: 5 });
    const second = requestFileCallback(endpoint, 'question', { order: 2 }, { pollMs: 5 });
    assert.strictEqual(await second, 2);
    releaseFirst();
    assert.strictEqual(await first, 1);
  });

  it('rejects an unauthenticated plaintext request without dispatching it', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const endpoint = await broker.listen(async () => { throw new Error('must not run'); });
    const id = 'forged_request_123';
    const file = path.join(endpoint.directory, 'requests', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, token: 'nope', kind: 'question', payload: {}, createdAt: Date.now() }));
    await delay(35);
    assert.ok(!fs.existsSync(file));
  });

  it('does not authenticate or decrypt an endpoint with another endpoint token', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    let dispatched = false;
    const endpointA = await broker.listen(async () => {
      dispatched = true;
      return 'must not happen';
    });
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-other-'));
    const otherBroker = new FileCallbackBroker(otherHome, { pollMs: 5 });
    try {
      const endpointB = await otherBroker.listen(async () => 'other');
      await assert.rejects(
        requestFileCallback(
          { directory: endpointA.directory, token: endpointB.token },
          'question',
          { secret: 'cross-endpoint' },
          { pollMs: 5, timeoutMs: 100 },
        ),
        /invalid encrypted file callback envelope/,
      );
      await delay(25);
      assert.strictEqual(dispatched, false);
    } finally {
      await otherBroker.close();
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked callback base without changing or traversing its target', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-base-target-'));
    const sentinel = path.join(outside, 'keep.txt');
    fs.writeFileSync(sentinel, 'keep');
    fs.chmodSync(outside, 0o755);
    fs.symlinkSync(outside, path.join(home, '.ccweb-callback'), 'dir');
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    try {
      await assert.rejects(broker.listen(async () => null), /unsafe file callback path/);
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
      assert.strictEqual(fs.statSync(outside).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a replaced pre-created pi artifact without overwriting its target', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const endpoint = await broker.listen(async () => null);
    const generatedDir = path.join(endpoint.directory, '.pi', 'ccweb');
    const artifact = path.join(generatedDir, 'ask-user.ts');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-callback-artifact-target-'));
    const sentinel = path.join(outside, 'keep.ts');
    fs.writeFileSync(sentinel, 'do not overwrite');
    try {
      assert.strictEqual(fs.statSync(generatedDir).mode & 0o777, 0o500);
      fs.chmodSync(generatedDir, 0o700);
      fs.unlinkSync(artifact);
      fs.symlinkSync(sentinel, artifact);
      assert.strictEqual(writePiAskExtension(endpoint.directory), null);
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'do not overwrite');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when any critical directory is swapped and never cleans outside it', async function () {
    for (const folder of ['requests', 'replies', 'cancelled']) {
      const scopedHome = path.join(home, folder);
      fs.mkdirSync(scopedHome);
      const localBroker = new FileCallbackBroker(scopedHome, { pollMs: 5 });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), `file-callback-${folder}-target-`));
      const sentinel = path.join(outside, 'keep.txt');
      fs.writeFileSync(sentinel, `keep-${folder}`);
      let endpoint;
      let original;
      try {
        endpoint = await localBroker.listen(async () => 'must not run');
        fs.chmodSync(endpoint.directory, 0o700);
        original = path.join(endpoint.directory, `${folder}.original`);
        fs.renameSync(path.join(endpoint.directory, folder), original);
        fs.symlinkSync(outside, path.join(endpoint.directory, folder), 'dir');
        await assert.rejects(
          requestFileCallback(endpoint, 'question', {}, { pollMs: 5, timeoutMs: 50 }),
          /unsafe file callback path/,
        );
        await localBroker.close();
        assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), `keep-${folder}`);
      } finally {
        await localBroker.close();
        if (endpoint && original && fs.existsSync(original)) {
          const swapped = path.join(endpoint.directory, folder);
          fs.unlinkSync(swapped);
          fs.renameSync(original, swapped);
          fs.chmodSync(endpoint.directory, 0o700);
          fs.chmodSync(path.join(endpoint.directory, '.pi'), 0o700);
          fs.chmodSync(path.join(endpoint.directory, '.pi', 'ccweb'), 0o700);
          fs.rmSync(endpoint.directory, { recursive: true, force: true });
        }
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it('keeps atomic write and rename bound to the pinned requests fd during a replacement race', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const endpoint = await broker.listen(async () => 'must not dispatch');
    const requests = path.join(endpoint.directory, 'requests');
    const original = path.join(endpoint.directory, 'requests.race-original');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-write-race-'));
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside');
    let swapped = false;
    try {
      await assert.rejects(
        requestFileCallback(endpoint, 'question', { secret: 'pinned-write' }, {
          pollMs: 5,
          timeoutMs: 100,
          testHooks: {
            afterDirectoryOpened(operation, directory) {
              if (swapped || operation !== 'write' || directory !== requests) return;
              swapped = true;
              fs.chmodSync(endpoint.directory, 0o700);
              fs.renameSync(requests, original);
              fs.symlinkSync(outside, requests, 'dir');
            },
          },
        }),
        /unsafe file callback path/,
      );
      assert.strictEqual(swapped, true);
      assert.deepStrictEqual(fs.readdirSync(outside), ['sentinel.txt']);
      assert.ok(fs.readdirSync(original).some((entry) => entry.endsWith('.json')));
    } finally {
      if (fs.existsSync(original)) {
        if (fs.lstatSync(requests).isSymbolicLink()) fs.unlinkSync(requests);
        fs.renameSync(original, requests);
      }
      await broker.close();
      broker = null;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps reply unlink bound to the pinned replies fd during a replacement race', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const endpoint = await broker.listen(async () => ({ answer: 'ready' }));
    const replies = path.join(endpoint.directory, 'replies');
    const original = path.join(endpoint.directory, 'replies.race-original');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-unlink-race-'));
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside');
    let swapped = false;
    let replyName;
    try {
      const result = await requestFileCallback(endpoint, 'question', {}, {
        pollMs: 5,
        timeoutMs: 500,
        testHooks: {
          afterDirectoryOpened(operation, directory) {
            if (swapped || operation !== 'unlink' || directory !== replies) return;
            replyName = fs.readdirSync(replies)
              .find((entry) => !['heartbeat.json', 'lease.json'].includes(entry));
            assert.ok(replyName, 'the encrypted reply exists before client cleanup');
            fs.writeFileSync(path.join(outside, replyName), 'do not delete');
            swapped = true;
            fs.chmodSync(endpoint.directory, 0o700);
            fs.renameSync(replies, original);
            fs.symlinkSync(outside, replies, 'dir');
          },
        },
      });
      assert.deepStrictEqual(result, { answer: 'ready' });
      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(path.join(outside, replyName), 'utf8'), 'do not delete');
      assert.ok(!fs.existsSync(path.join(original, replyName)));
    } finally {
      if (fs.existsSync(original)) {
        if (fs.lstatSync(replies).isSymbolicLink()) fs.unlinkSync(replies);
        fs.renameSync(original, replies);
      }
      await broker.close();
      broker = null;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps stale cleanup bound to the pinned requests fd during a replacement race', async function () {
    let armed = false;
    let swapped = false;
    let endpoint;
    let requests;
    let original;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-cleanup-race-'));
    fs.writeFileSync(path.join(outside, 'orphan.tmp'), 'do not delete');
    broker = new FileCallbackBroker(home, {
      pollMs: 5,
      cleanupAfterMs: 50,
      testHooks: {
        afterDirectoryOpened(operation, directory) {
          if (!armed || swapped || operation !== 'cleanup' || directory !== requests) return;
          swapped = true;
          fs.chmodSync(endpoint.directory, 0o700);
          fs.renameSync(requests, original);
          fs.symlinkSync(outside, requests, 'dir');
        },
      },
    });
    try {
      endpoint = await broker.listen(async () => null);
      requests = path.join(endpoint.directory, 'requests');
      original = path.join(endpoint.directory, 'requests.cleanup-original');
      const orphan = path.join(requests, 'orphan.tmp');
      fs.writeFileSync(orphan, 'stale encrypted artifact');
      const old = new Date(Date.now() - 5_000);
      fs.utimesSync(orphan, old, old);
      armed = true;
      await eventually(() => swapped);
      await eventually(() => !fs.existsSync(path.join(original, 'orphan.tmp')));
      assert.strictEqual(fs.readFileSync(path.join(outside, 'orphan.tmp'), 'utf8'), 'do not delete');
    } finally {
      armed = false;
      if (requests && fs.existsSync(requests) && fs.lstatSync(requests).isSymbolicLink()) fs.unlinkSync(requests);
      if (original && fs.existsSync(original)) fs.renameSync(original, requests);
      await broker.close();
      broker = null;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('prunes stale crash artifacts without following symlinks', async function () {
    const base = path.join(home, '.ccweb-callback');
    const stale = path.join(base, 'a'.repeat(32));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-callback-stale-target-'));
    const sentinel = path.join(outside, 'keep.txt');
    fs.mkdirSync(path.join(stale, 'requests'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(stale, 'replies'), { mode: 0o700 });
    fs.mkdirSync(path.join(stale, 'cancelled'), { mode: 0o700 });
    fs.mkdirSync(path.join(stale, '.pi', 'ccweb'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stale, 'replies', 'orphan.json'), 'ciphertext-shaped-or-not');
    fs.writeFileSync(path.join(stale, '.pi', 'ccweb', 'ask-user.ts'), 'generated');
    fs.writeFileSync(sentinel, 'keep');
    fs.symlinkSync(sentinel, path.join(stale, 'requests', 'forged_request_123.json'));
    const old = new Date(Date.now() - 10_000);
    for (const directory of [
      path.join(stale, 'requests'),
      path.join(stale, 'replies'),
      path.join(stale, 'cancelled'),
      path.join(stale, '.pi', 'ccweb'),
      path.join(stale, '.pi'),
      stale,
    ]) fs.utimesSync(directory, old, old);

    broker = new FileCallbackBroker(home, { pollMs: 5, cleanupAfterMs: 1_000 });
    try {
      await broker.listen(async () => null);
      assert.ok(!fs.existsSync(stale));
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps a live idle endpoint leased even when its root is older than cleanupAfterMs', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5, cleanupAfterMs: 90 });
    const endpoint = await broker.listen(async () => 'still live');
    await delay(180);
    const peer = new FileCallbackBroker(home, { pollMs: 5, cleanupAfterMs: 90 });
    try {
      await peer.listen(async () => null);
      assert.ok(fs.existsSync(endpoint.directory));
      assert.strictEqual(
        await requestFileCallback(endpoint, 'question', {}, { pollMs: 5, timeoutMs: 500 }),
        'still live',
      );
    } finally {
      await peer.close();
    }
  });

  it('cancels a waiting handler and reports cancellation to its client', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5, requestTimeoutMs: 1_000 });
    const endpoint = await broker.listen(async (_request, signal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('aborted');
    });
    const controller = new AbortController();
    const pending = requestFileCallback(endpoint, 'question', {}, { pollMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, /cancelled/);
  });

  it('times out, leaves a cancellation marker for the host, and cleans its own files', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5, requestTimeoutMs: 1_000 });
    const endpoint = await broker.listen(async () => new Promise(() => {}));
    await assert.rejects(
      requestFileCallback(endpoint, 'plan', {}, { pollMs: 5, timeoutMs: 25 }),
      /timed out/,
    );
    await delay(30);
    assert.deepStrictEqual(fs.readdirSync(path.join(endpoint.directory, 'requests')), []);
  });

  it('does not clean an active question just because it outlives orphan cleanup', async function () {
    broker = new FileCallbackBroker(home, {
      pollMs: 5,
      cleanupAfterMs: 25,
      requestTimeoutMs: 20,
    });
    let release;
    let started;
    const waiting = new Promise((resolve) => { release = resolve; });
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const endpoint = await broker.listen(async () => {
      started();
      await waiting;
      return 'answered';
    });

    const pending = requestFileCallback(endpoint, 'question', {}, { pollMs: 5, timeoutMs: 20 });
    await startedPromise;
    await delay(80);
    assert.ok(fs.readdirSync(path.join(endpoint.directory, 'requests')).some((entry) => entry.endsWith('.json')));
    release();
    assert.strictEqual(await pending, 'answered');
  });
});

describe('generated file MCP bridge', function () {
  let home;
  let broker;
  let child;

  beforeEach(function () {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'file-mcp-bridge-'));
  });

  afterEach(async function () {
    child?.kill();
    await broker?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function launch(endpoint, extraEnv = {}) {
    const bridge = await writeFileMcpBridge(endpoint.directory);
    child = spawn(process.execPath, [bridge], {
      env: {
        ...process.env,
        CCWEB_CALLBACK_DIR: endpoint.directory,
        CCWEB_CALLBACK_TOKEN: endpoint.token,
        CCWEB_CALLBACK_LIVENESS_MS: '25',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const replies = new Map();
    const waiters = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          waiter.resolve(message);
        } else {
          replies.set(message.id, message);
        }
      }
    });
    return {
      request(message, timeout = 2_000) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        if (replies.has(message.id)) return Promise.resolve(replies.get(message.id));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(message.id);
            reject(new Error(`MCP bridge did not reply to ${message.method}`));
          }, timeout);
          waiters.set(message.id, {
            resolve: (reply) => { clearTimeout(timer); resolve(reply); },
          });
        });
      },
    };
  }

  it('embeds the exact same authenticated-encryption client in MCP and pi', async function () {
    const directory = path.join(home, 'generated-source');
    for (const name of ['requests', 'replies', 'cancelled']) {
      fs.mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    }
    const bridge = await writeFileMcpBridge(directory);
    const bridgeSource = fs.readFileSync(bridge, 'utf8');
    assert.ok(bridgeSource.includes(FILE_CALLBACK_GENERATED_CLIENT_SOURCE));
    assert.ok(PI_ASK_EXTENSION.includes(FILE_CALLBACK_GENERATED_CLIENT_SOURCE));
    for (const source of [bridgeSource, PI_ASK_EXTENSION]) {
      assert.match(source, /aes-256-gcm/);
      assert.match(source, /callbackAad\(['"]request/);
      assert.match(source, /\/proc\/self\/fd/);
      assert.match(source, /\/dev\/fd/);
      assert.match(source, /callbackWithDirectory/);
      assert.ok(!source.includes('fs.rename(temporary, file)'));
      assert.ok(!source.includes('fs.unlink(file)'));
      assert.ok(!/token:\s*(?:TOKEN|CALLBACK_TOKEN)/.test(source));
    }
  });

  it('keeps the callback token out of the Claude MCP config argv', function () {
    const token = 'ARGV_SECRET_TOKEN_9eeea3';
    const config = fileMcpConfig(
      '/shared/session/ccweb-mcp.mjs',
      '/shared/session',
      token,
      process.execPath,
      true,
    );
    assert.ok(!config.includes(token));
    assert.deepStrictEqual(JSON.parse(config).mcpServers.ccweb.env, { CCWEB_TIER_LADDER: '1' });
  });

  it('keeps plan and tier tools available when the question tool is disabled', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const endpoint = await broker.listen(async () => ({ accepted: true }));
    const rpc = await launch(endpoint, { CCWEB_TIER_LADDER: '1' });

    const tools = await rpc.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.deepStrictEqual(tools.result.tools.map((tool) => tool.name), ['submit_plan', 'request_model_tier']);
    const unavailable = await rpc.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'ask_user_question', arguments: {},
    } });
    assert.strictEqual(unavailable.error.code, -32601);
  });

  it('lists questionnaire and plan tools when explicitly enabled, then delivers both through the broker', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    const calls = [];
    const endpoint = await broker.listen(async (request) => {
      calls.push(request);
      return request.kind === 'question'
        ? { labels: ['Remote'], text: 'because' }
        : { accepted: true, detail: 'Plan accepted.' };
    });
    const rpc = await launch(endpoint, { CCWEB_QUESTION_TOOL_ENABLED: '1' });

    await rpc.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const tools = await rpc.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepStrictEqual(tools.result.tools.map((tool) => tool.name), ['ask_user_question', 'submit_plan']);

    const question = await rpc.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'ask_user_question', arguments: { question: 'Where?', options: ['Local', 'Remote'] },
    } });
    const plan = await rpc.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'submit_plan', arguments: { markdown: '# Ship it' },
    } });
    assert.match(question.result.content[0].text, /Remote/);
    assert.match(plan.result.content[0].text, /Plan accepted/);
    assert.deepStrictEqual(calls.map((call) => call.kind), ['question', 'plan']);
    assert.deepStrictEqual(calls[1].payload, { markdown: '# Ship it' });
  });

  it('returns a prose fallback MCP error promptly when the callback host is unavailable', async function () {
    const directory = path.join(home, 'unavailable');
    for (const name of ['requests', 'replies', 'cancelled']) fs.mkdirSync(path.join(directory, name), { recursive: true });
    const rpc = await launch({ directory, token: 'test-token' }, { CCWEB_QUESTION_TOOL_ENABLED: '1' });
    const reply = await rpc.request({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
      name: 'ask_user_question', arguments: { question: 'Which?', options: ['A', 'B'] },
    } });
    assert.strictEqual(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /Ask in prose instead/);
    assert.match(reply.result.content[0].text, /unavailable/);
    assert.ok(fs.readdirSync(path.join(directory, 'cancelled')).some((entry) => entry.endsWith('.cancel')));
  });

  it('delivers MCP cancellation to a broker handler instead of leaving its request live', async function () {
    broker = new FileCallbackBroker(home, { pollMs: 5 });
    let aborted = false;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const endpoint = await broker.listen(async (_request, signal) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      aborted = true;
      throw new Error('cancelled');
    });
    const rpc = await launch(endpoint, { CCWEB_QUESTION_TOOL_ENABLED: '1' });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: {
      name: 'ask_user_question', arguments: { question: 'Wait?', options: ['Yes', 'No'] },
    } })}\n`);
    await Promise.race([
      startedPromise,
      delay(2_000).then(() => { throw new Error('bridge did not deliver its request'); }),
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 22 } })}\n`);
    await eventually(() => aborted);
    assert.deepStrictEqual(fs.readdirSync(path.join(endpoint.directory, 'requests')), []);
    assert.ok(!child.killed, 'the bridge remains live after a cancelled call');
    // The same live process can still serve ordinary MCP requests instead of
    // remaining blocked behind the one the ACP client abandoned.
    const tools = await rpc.request({ jsonrpc: '2.0', id: 23, method: 'tools/list', params: {} });
    assert.ok(tools.result.tools.some((tool) => tool.name === 'ask_user_question'));
  });
});
