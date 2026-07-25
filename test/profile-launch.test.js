const assert = require('assert');
const { PiBridge } = require('../dist/server/bridges/pi.js');
const { OmpBridge } = require('../dist/server/bridges/omp.js');
const { KimiBridge } = require('../dist/server/bridges/kimi.js');
const { AgentBridge } = require('../dist/server/bridges/agent.js');

// buildArgs and getModelFlag are `protected` in TypeScript, a compile-time
// visibility rule only: at runtime they are ordinary methods.

describe('profile launch composition', function () {
  it('adds nothing when no profile is active', function () {
    // The default path must stay byte-identical to launching by hand.
    assert.deepStrictEqual(new PiBridge().buildArgs({}), []);
    assert.deepStrictEqual(new OmpBridge().buildArgs({}), []);
  });

  it('passes a model through the CLI flag', function () {
    assert.deepStrictEqual(
      new PiBridge().buildArgs({ model: 'vendor/model-x' }),
      ['--model', 'vendor/model-x'],
    );
  });

  it('passes the model as a separate argv entry, never interpolated', function () {
    // One argv entry means spaces or quotes in a model id cannot become extra
    // arguments; there is no shell between here and execvp.
    const args = new OmpBridge().buildArgs({ model: 'weird model; rm -rf /' });
    assert.deepStrictEqual(args, ['--model', 'weird model; rm -rf /']);
  });

  it('ignores a model for a CLI with no model flag', function () {
    // Better to launch without it than to invent a flag the CLI will reject.
    assert.deepStrictEqual(new AgentBridge().buildArgs({ model: 'x' }), []);
  });

  it('appends extra arguments after the bridge and the model', function () {
    const args = new PiBridge().buildArgs({ model: 'm', extraArgs: ['--think', 'hard'] });
    assert.deepStrictEqual(args, ['--model', 'm', '--think', 'hard']);
  });

  it('keeps the approval-bypass flag ahead of profile arguments', function () {
    // The bypass is a safety-relevant choice the app made; a value typed into
    // Settings must not be able to displace it by landing earlier in argv.
    const args = new KimiBridge().buildArgs({
      dangerouslySkipPermissions: true,
      model: 'm',
      extraArgs: ['--whatever'],
    });
    assert.strictEqual(args[0], '--yolo');
    assert.deepStrictEqual(args, ['--yolo', '--model', 'm', '--whatever']);
  });

  it('still applies the bypass when a profile is active', function () {
    const args = new OmpBridge().buildArgs({
      dangerouslySkipPermissions: true,
      extraArgs: ['--config', '/tmp/x.yml'],
    });
    assert.strictEqual(args[0], '--auto-approve');
    assert.deepStrictEqual(args, ['--auto-approve', '--config', '/tmp/x.yml']);
  });

  it('exposes --model only for CLIs whose help was checked', function () {
    // Unverified CLIs return null rather than a guess; a profile can still
    // reach them through extraArgs.
    for (const Bridge of [PiBridge, OmpBridge, KimiBridge]) {
      assert.strictEqual(new Bridge().getModelFlag(), '--model');
    }
    assert.strictEqual(new AgentBridge().getModelFlag(), null);
  });
});
