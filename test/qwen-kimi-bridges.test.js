const assert = require('assert');
const os = require('os');
const path = require('path');
const { QwenBridge } = require('../dist/server/bridges/qwen.js');
const { KimiBridge } = require('../dist/server/bridges/kimi.js');

// getArgs and getCommandCandidates are `protected` in TypeScript, which is a
// compile-time visibility rule only: at runtime they are ordinary methods.

describe('QwenBridge', function () {
  it('looks for the qwen binary on PATH', function () {
    const candidates = new QwenBridge().getCommandCandidates();
    assert.ok(candidates.includes('qwen'));
    assert.ok(candidates.includes(path.join(os.homedir(), '.local', 'bin', 'qwen')));
  });

  it('starts interactive with no arguments', function () {
    // The bare command launches the terminal UI. Passing -p would turn it into
    // a one-shot prompt, which is not what a PTY session is for.
    assert.deepStrictEqual(new QwenBridge().getArgs({}), []);
  });

  it('passes --yolo when permissions are dangerously skipped', function () {
    // Absent from `qwen --help`, but registered and read by the shipped bundle:
    //   .option("yolo", { alias: "y", type: "boolean", ... })
    //   else if (argv.yolo) approvalMode = "yolo"
    // Verified against @qwen-code/qwen-code 0.20.0.
    assert.deepStrictEqual(
      new QwenBridge().getArgs({ dangerouslySkipPermissions: true }),
      ['--yolo'],
    );
  });
});

describe('KimiBridge', function () {
  it('tries the installer directory before PATH', function () {
    // ~/.kimi-code/bin is where the Kimi installer puts the binary and is often
    // missing from a systemd --user PATH, so ordering here is the whole point.
    const candidates = new KimiBridge().getCommandCandidates();
    assert.strictEqual(candidates[0], path.join(os.homedir(), '.kimi-code', 'bin', 'kimi'));
    assert.ok(candidates.includes('kimi'));
  });

  it('starts interactive with no arguments', function () {
    assert.deepStrictEqual(new KimiBridge().getArgs({}), []);
  });

  it('passes --yolo when permissions are dangerously skipped', function () {
    // `-y, --yolo  Automatically approve all actions.` (Kimi Code 0.27.0).
    assert.deepStrictEqual(
      new KimiBridge().getArgs({ dangerouslySkipPermissions: true }),
      ['--yolo'],
    );
  });

  it('never passes --auto for the dangerous path', function () {
    // --auto is "auto permission mode", which still prompts for what it does
    // not cover. Using it for the Dangerous button would promise a bypass the
    // user does not actually get.
    const args = new KimiBridge().getArgs({ dangerouslySkipPermissions: true });
    assert.ok(!args.includes('--auto'), `--auto must not be used, got: ${args.join(' ')}`);
  });
});
