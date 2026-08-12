'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  discoverTests,
  finishCliRun,
  formatCounts,
  formatSkipped,
  parseArguments,
  planTestRun,
  runTestCommand,
  selectTestFiles,
  validateManifest,
} = require('../scripts/run-tests.js');
const {
  probeAsyncSubprocess,
  probeNestedSubprocess,
  probeCapabilities,
  probeSubprocess,
  unavailable,
} = require('../scripts/capabilities.js');
const {
  capabilityManifest,
  strictCapabilityManifest,
} = require('../scripts/capability-manifest.js');

describe('capability-aware test runner', function () {
  it('discovers only sorted top-level Mocha test files', function () {
    const files = discoverTests(path.join(__dirname, '..'));
    assert.ok(files.includes('test/chat-resumable.test.js'));
    assert.ok(files.includes('test/capability-runner.test.js'));
    assert.ok(!files.includes('test/browser/run.js'));
    assert.deepStrictEqual(files, [...files].sort());
  });

  it('probes capabilities independently and reports probe exceptions as unavailable', async function () {
    const results = await probeCapabilities(['one', 'two'], {
      probes: {
        one: async () => ({ available: true, detail: 'ok' }),
        two: async () => { throw Object.assign(new Error('blocked'), { code: 'EPERM' }); },
      },
    });
    assert.deepStrictEqual(results.one, { available: true, detail: 'ok' });
    assert.deepStrictEqual(results.two, unavailable(Object.assign(new Error('blocked'), { code: 'EPERM' })));
  });

  it('requires a subprocess probe to return its expected stdout', function () {
    assert.deepStrictEqual(probeSubprocess({
      spawnSync: () => ({ status: 0, stdout: 'cc-web-subprocess-probe' }),
    }), { available: true, detail: 'available' });
    const missingOutput = probeSubprocess({ spawnSync: () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(missingOutput.available, false);
    assert.match(missingOutput.detail, /stdout did not match/);
  });

  it('requires the nested subprocess probe to capture exact grandchild output', function () {
    let childProgram;
    assert.deepStrictEqual(probeNestedSubprocess({
      spawnSync: (_command, args) => {
        childProgram = args[1];
        return { status: 0, stdout: 'cc-web-nested-subprocess-probe', stderr: '' };
      },
    }), { available: true, detail: 'available' });
    assert.match(childProgram, /spawnSync/);
    assert.match(childProgram, /cc-web-nested-grandchild/);
    const missingOutput = probeNestedSubprocess({
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.strictEqual(missingOutput.available, false);
    assert.match(missingOutput.detail, /nested stdout did not match/);
  });

  it('requires an asynchronously spawned child to return captured stdout', async function () {
    const result = await probeAsyncSubprocess({
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit('data', 'cc-web-async-subprocess-probe');
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.deepStrictEqual(result, { available: true, detail: 'available' });
  });

  it('keeps the capability manifest tied to real discovered tests and known capabilities', function () {
    assert.doesNotThrow(() => validateManifest(discoverTests(path.join(__dirname, '..'))));
    assert.doesNotThrow(() => validateManifest(
      discoverTests(path.join(__dirname, '..')),
      strictCapabilityManifest,
    ));
    assert.throws(
      () => validateManifest(['test/known.test.js'], { 'test/missing.test.js': ['loopbackTcp'] }),
      /undiscovered/,
    );
    assert.throws(
      () => validateManifest(['test/known.test.js'], { 'test/known.test.js': ['unknown'] }),
      /unknown capability/,
    );
    assert.ok(Object.keys(capabilityManifest).length > 0);
  });

  it('applies mixed-suite subprocess requirements only in strict mode', function () {
    const files = [
      'test/workspace-portable-storage.test.js',
      'test/workspace-session-migrator.test.js',
    ];
    const results = { nestedSubprocess: { available: false, detail: 'EPERM' } };
    const ordinary = planTestRun(files, results);
    assert.deepStrictEqual(ordinary.eligible, files);
    assert.deepStrictEqual(ordinary.skipped, []);

    const strict = planTestRun(files, results, process.cwd(), { strict: true });
    assert.deepStrictEqual(strict.eligible, []);
    assert.deepStrictEqual(strict.skipped.map(({ file }) => file), files);
    assert.ok(strict.skipped.every(({ missing }) => missing[0].capability === 'nestedSubprocess'));
  });

  it('preflights a focused mixed suite in strict mode', async function () {
    let probed;
    const result = await runTestCommand({
      files: ['test/workspace-portable-storage.test.js', 'test/chat-view.test.js'],
      argv: ['--strict', '--test-file', 'test/workspace-portable-storage.test.js'],
      probeCapabilities: async (capabilities) => {
        probed = capabilities;
        return { nestedSubprocess: { available: false, detail: 'EPERM' } };
      },
      print: () => {},
      spawnSync: () => { throw new Error('Mocha must not start'); },
    });
    assert.deepStrictEqual(probed, ['nestedSubprocess']);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.strictFailure, true);
    assert.deepStrictEqual(result.plan.skipped.map(({ file }) => file), [
      'test/workspace-portable-storage.test.js',
    ]);
  });

  it('groups exact missing capabilities by file', function () {
    const plan = planTestRun([
      'test/chat-resumable.test.js',
      'test/chat-approval-mode-live.test.js',
      'test/chat-view.test.js',
    ], {
      loopbackTcp: { available: false, detail: 'EPERM' },
      unixSocket: { available: false, detail: 'EPERM' },
    });
    assert.deepStrictEqual(plan.eligible, ['test/chat-view.test.js']);
    assert.deepStrictEqual(plan.skipped.map(({ file }) => file), [
      'test/chat-resumable.test.js',
      'test/chat-approval-mode-live.test.js',
    ]);
    assert.match(formatSkipped(plan.skipped), /test\/chat-resumable\.test\.js: loopbackTcp \(EPERM\)/);
    assert.match(formatSkipped(plan.skipped), /test\/chat-approval-mode-live\.test\.js: unixSocket \(EPERM\)/);
    assert.strictEqual(formatCounts(3, plan), 'Test selection: selected 3, eligible 1, skipped 2.');
  });

  it('fails strict mode before starting Mocha', async function () {
    let spawned = false;
    const output = [];
    const result = await runTestCommand({
      files: ['test/chat-resumable.test.js'],
      argv: ['--strict', '--grep', 'resume'],
      results: { loopbackTcp: { available: false, detail: 'EPERM' } },
      print: (line) => output.push(line),
      spawnSync: () => { spawned = true; },
    });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.strictFailure, true);
    assert.strictEqual(spawned, false);
    assert.match(output.join('\n'), /strict mode will not start Mocha/);
  });

  it('supports exact repeatable --test-file selection and rejects unknown paths', async function () {
    assert.deepStrictEqual(selectTestFiles([
      'test/chat-view.test.js',
      'test/chat-resumable.test.js',
    ], ['test/chat-resumable.test.js', 'test/chat-view.test.js']), [
      'test/chat-resumable.test.js',
      'test/chat-view.test.js',
    ]);
    assert.throws(
      () => selectTestFiles(['test/chat-view.test.js'], ['test/not-a-real-test.test.js']),
      /discovered test file/,
    );
    const output = [];
    const result = await runTestCommand({
      files: ['test/chat-view.test.js', 'test/chat-resumable.test.js'],
      argv: ['--strict', '--test-file', 'test/chat-resumable.test.js'],
      results: { loopbackTcp: { available: false, detail: 'EPERM' } },
      print: (line) => output.push(line),
      spawnSync: () => { throw new Error('Mocha must not start'); },
    });
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.plan.skipped.map(({ file }) => file), ['test/chat-resumable.test.js']);
    assert.match(output.join('\n'), /Test selection: selected 1, eligible 0, skipped 1\./);
  });

  it('forwards extra Mocha arguments while running eligible tests with inherited stdio', async function () {
    let invocation;
    const result = await runTestCommand({
      files: ['test/chat-view.test.js'],
      argv: ['--strict', '--grep', 'view'],
      results: {},
      print: () => {},
      spawnSync: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(invocation.command, process.execPath);
    assert.deepStrictEqual(invocation.args.slice(1, 4), ['--exit', '--grep', 'view']);
    assert.deepStrictEqual(invocation.args.slice(-1), ['test/chat-view.test.js']);
    assert.strictEqual(invocation.options.stdio, 'inherit');
    assert.strictEqual(invocation.options.env.CCWEB_TEST_STRICT, '1');
  });

  it('propagates an in-process fallback failure and keeps strict env set for its lifetime', async function () {
    let receivedArgs;
    const prior = process.env.CCWEB_TEST_STRICT;
    process.env.CCWEB_TEST_STRICT = 'prior';
    try {
      const result = await runTestCommand({
        files: ['test/chat-view.test.js'],
        argv: ['--strict'],
        results: {},
        print: () => {},
        spawnSync: () => ({ error: Object.assign(new Error('blocked'), { code: 'EPERM' }) }),
        runInProcessMocha: async (args) => {
          receivedArgs = args;
          assert.strictEqual(process.env.CCWEB_TEST_STRICT, '1');
          await Promise.resolve();
          assert.strictEqual(process.env.CCWEB_TEST_STRICT, '1');
          return 3;
        },
      });
      assert.strictEqual(result.status, 3);
      assert.strictEqual(result.inProcess, true);
      assert.deepStrictEqual(receivedArgs.slice(0, 2), ['--exit', 'test/chat-view.test.js']);
      assert.strictEqual(process.env.CCWEB_TEST_STRICT, 'prior');
    } finally {
      if (prior === undefined) delete process.env.CCWEB_TEST_STRICT;
      else process.env.CCWEB_TEST_STRICT = prior;
    }
  });

  it('flushes inherited output before force-exiting an in-process CLI run', async function () {
    const events = [];
    const stream = (name) => ({
      write(value, callback) {
        events.push(`${name}:${JSON.stringify(value)}`);
        callback();
      },
    });
    await finishCliRun({ status: 7, inProcess: true }, {
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      exit: (status) => events.push(`exit:${status}`),
    });
    assert.deepStrictEqual(events, ['stdout:""', 'stderr:""', 'exit:7']);
  });

  it('makes mixed-suite child skips fail closed after strict preflight', function () {
    const portable = fs.readFileSync(path.join(__dirname, 'workspace-portable-storage.test.js'), 'utf8');
    const migrator = fs.readFileSync(path.join(__dirname, 'workspace-session-migrator.test.js'), 'utf8');
    for (const source of [portable, migrator]) {
      assert.match(source, /CCWEB_TEST_STRICT === '1'/);
      assert.match(source, /nestedSubprocess capability disappeared after strict preflight/);
    }
  });

  it('parses strict mode without consuming regular Mocha arguments', function () {
    assert.deepStrictEqual(parseArguments(['--strict', '--test-file', 'test/chat-view.test.js', '--grep', 'socket']), {
      strict: true,
      testFiles: ['test/chat-view.test.js'],
      mochaArgs: ['--grep', 'socket'],
    });
  });
});
