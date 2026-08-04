const assert = require('assert');
const { BaseChatAdapter } = require('../dist/server/chat/adapter.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class LifecycleAdapter extends BaseChatAdapter {
  runtime = 'lifecycle-test';
  capabilities = {};

  buildArgs() { return []; }
  handleMessage() {}
  async send() {}
  async interrupt() {}
  respondPermission() {}
}

function options(environment, events) {
  return {
    sessionId: 'lifecycle-session',
    workingDir: process.cwd(),
    command: process.execPath,
    environment,
    emit: (event) => events.push(event),
  };
}

describe('container chat child lifecycle', function() {
  it('waits for exact child close and remote proof before publishing exit', async function() {
    const proof = deferred();
    const events = [];
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 350)'], { stdio: ['ignore', 1, 2] });",
      'process.exit(0);',
    ].join('\n');
    const environment = {
      kind: 'container',
      wrap() {
        return {
          command: process.execPath,
          args: ['-e', script],
          env: process.env,
          processControl: { stop: () => proof.promise },
        };
      },
      toContainerPath: (value) => value,
    };
    const adapter = new LifecycleAdapter(options(environment, events));
    await adapter.start();
    await waitUntil(() => adapter.exited === true);

    proof.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(adapter.alive, true, 'open inherited stdout keeps ownership');
    assert.strictEqual(events.some((event) => event.t === 'state' && event.state === 'exited'), false);

    await waitUntil(() => events.some((event) => event.t === 'state' && event.state === 'exited'));
    assert.strictEqual(adapter.alive, false);
  });

  it('retains ownership when remote stop proof rejects', async function() {
    const events = [];
    let stops = 0;
    const environment = {
      kind: 'container',
      wrap() {
        return {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: process.env,
          processControl: {
            async stop() {
              stops += 1;
              throw new Error('remote proof unavailable');
            },
          },
        };
      },
      toContainerPath: (value) => value,
    };
    const adapter = new LifecycleAdapter(options(environment, events));
    await adapter.start();
    await waitUntil(() => events.some((event) => event.t === 'state' && event.state === 'error'));

    assert.strictEqual(adapter.alive, true);
    assert.strictEqual(events.some((event) => event.t === 'state' && event.state === 'exited'), false);
    await assert.rejects(() => adapter.stop(), /remote proof unavailable/);
    assert.ok(stops >= 2, 'an explicit stop retries the retained proof handle');
  });

  it('releases cleanly when the engine client fails before spawn', async function() {
    const events = [];
    let stops = 0;
    const environment = {
      kind: 'container',
      wrap() {
        return {
          command: `/definitely-missing-${process.pid}`,
          args: [],
          env: process.env,
          processControl: { async stop() { stops += 1; } },
        };
      },
      toContainerPath: (value) => value,
    };
    const adapter = new LifecycleAdapter(options(environment, events));
    await adapter.start();
    await waitUntil(() => events.some((event) => event.t === 'state' && event.state === 'exited'));

    assert.strictEqual(adapter.alive, false);
    assert.strictEqual(stops, 0, 'no remote process existed to stop');
  });

  it('waits for spawn outcome before deciding whether remote stop is required', async function() {
    const events = [];
    let stops = 0;
    const environment = {
      kind: 'container',
      wrap() {
        return {
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 5000)'],
          env: process.env,
          processControl: { async stop() { stops += 1; } },
        };
      },
      toContainerPath: (value) => value,
    };
    const adapter = new LifecycleAdapter(options(environment, events));

    const starting = adapter.start();
    const stopping = adapter.stop();
    await Promise.all([starting, stopping]);

    assert.strictEqual(stops, 1, 'successful spawn still invokes remote proof');
    assert.strictEqual(adapter.alive, false);
  });

  it('fails before spawning when a container omits process control', async function() {
    const events = [];
    const environment = {
      kind: 'container',
      wrap() {
        return { command: process.execPath, args: ['-e', 'process.exit(0)'], env: process.env };
      },
      toContainerPath: (value) => value,
    };
    const adapter = new LifecycleAdapter(options(environment, events));

    await assert.rejects(adapter.start(), /verified process control/);
    assert.strictEqual(adapter.alive, false);
  });
});
