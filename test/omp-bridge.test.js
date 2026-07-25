const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmpBridge } = require('../dist/server/bridges/omp.js');
const { PiBridge } = require('../dist/server/bridges/pi.js');

// getArgs and getCommandCandidates are `protected` in TypeScript, which is a
// compile-time visibility rule only: at runtime they are ordinary methods.

describe('OmpBridge', function () {
  let sandbox;

  before(function () {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-omp-'));
  });

  after(function () {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** A stand-in `omp` whose `--help` prints whatever the test needs it to. */
  function fakeOmp(name, helpText) {
    const file = path.join(sandbox, name);
    fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${helpText}EOF\n`, { mode: 0o755 });
    return file;
  }

  it('tries the installer directory before PATH', function () {
    // omp ships as a single ~180MB executable that its installer drops in
    // ~/.local/bin, which is often missing from a systemd --user PATH — the same
    // reason the Grok and Kimi bridges lead with their own install directories.
    const candidates = new OmpBridge().getCommandCandidates();
    assert.strictEqual(candidates[0], path.join(os.homedir(), '.local', 'bin', 'omp'));
    assert.ok(candidates.includes('omp'));
  });

  it('also looks in the Bun global bin', function () {
    // omp is distributed for `bun install -g` as well as the shell installer.
    const candidates = new OmpBridge().getCommandCandidates();
    assert.ok(candidates.includes(path.join(os.homedir(), '.bun', 'bin', 'omp')));
  });

  it('starts interactive, with no one-shot flag', function () {
    // The bare command launches the terminal UI. Passing -p would turn it into a
    // one-shot prompt, which is not what a PTY session is for.
    const args = new OmpBridge().getArgs({});
    assert.ok(!args.includes('-p') && !args.includes('--print'), args.join(' '));
  });

  it('keeps a home-directory session in the home directory', function () {
    // Started in $HOME, omp silently chdir()s to a temp directory unless this
    // flag is passed — verified against omp 17.1.3 by reading /proc/<pid>/cwd,
    // which shows `/tmp` without it and `$HOME` with it. The app's default
    // working directory *is* the user's home, so without the flag the default
    // launch runs the agent against an empty /tmp: it looks alive, sees none of
    // the user's files, and disagrees with the directory the session record,
    // the transcript and pasted images all point at.
    const bridge = new OmpBridge();
    bridge.allowHomeSupported = true; // stand in for the --help probe
    assert.ok(bridge.getArgs({ workingDir: os.homedir() }).includes('--allow-home'));
    assert.ok(
      bridge
        .getArgs({ workingDir: os.homedir(), dangerouslySkipPermissions: true })
        .includes('--allow-home'),
    );
  });

  it('leaves argv alone for every other directory', function () {
    // The flag exists to cancel one specific relocation. Anywhere else omp
    // already honours its cwd, so adding it would be noise — and noise that an
    // older omp would reject outright.
    const bridge = new OmpBridge();
    bridge.allowHomeSupported = true;
    assert.deepStrictEqual(bridge.getArgs({ workingDir: '/tmp/project' }), []);
    assert.deepStrictEqual(bridge.getArgs({ workingDir: path.join(os.homedir(), 'src') }), []);
  });

  it('does not pass a flag the installed omp does not have', function () {
    // omp exits on an unrecognised flag ("Error: unknown flag: ..."), so a
    // build that predates --allow-home must not be handed it: that would turn
    // "starts in the wrong directory" into "does not start at all".
    const bridge = new OmpBridge();
    bridge.allowHomeSupported = false;
    assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), []);
  });

  it('reads the answer out of the CLI it is actually going to run', function () {
    // The probe is `--help`, not a version number: omp is a fast-moving fork
    // and parsing versions would need updating every time it renumbers.
    const bridge = new OmpBridge();
    bridge.resolvedCommand = fakeOmp('with-flag', 'FLAGS\n      --allow-home    Allow starting in ~\n');
    assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), ['--allow-home']);
  });

  it('probes once and reuses the answer', function () {
    // The binary is ~180MB and the probe is synchronous, so re-running it on
    // every session start would stall the whole server for a second each time.
    const bridge = new OmpBridge();
    bridge.resolvedCommand = fakeOmp('probe-once', 'FLAGS\n      --allow-home    Allow starting in ~\n');
    assert.strictEqual(bridge.allowHomeSupported, null);
    assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), ['--allow-home']);
    assert.strictEqual(bridge.allowHomeSupported, true);

    // Re-probing now would read a help text without the flag and drop it.
    bridge.resolvedCommand = fakeOmp('probe-once-changed', 'FLAGS\n      --model <value>\n');
    assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), ['--allow-home']);
  });

  it('says so, loudly, when the installed omp is too old for the flag', function () {
    // Silence here would reproduce the original bug — a session that looks
    // healthy while running somewhere the user never chose — with nothing in
    // the log to explain it.
    const bridge = new OmpBridge();
    bridge.resolvedCommand = fakeOmp('too-old', 'FLAGS\n      --model <value>\n');
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), []);
    } finally {
      console.warn = realWarn;
    }
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes('--allow-home'), warnings[0]);
  });

  it('falls back to leaving argv alone when the CLI cannot be run at all', function () {
    const bridge = new OmpBridge();
    bridge.resolvedCommand = path.join(os.tmpdir(), 'omp-does-not-exist-cawc');
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepStrictEqual(bridge.getArgs({ workingDir: os.homedir() }), []);
    } finally {
      console.warn = realWarn;
    }
  });

  it('is the only bridge that has to defend its working directory', function () {
    // Every other bridged CLI honours the cwd it is spawned with, so the flag
    // is omp-specific rather than a house style. If pi ever grows the same
    // relocation this test is where the divergence gets noticed.
    assert.deepStrictEqual(new PiBridge().getArgs({ workingDir: os.homedir() }), []);
  });

  it('passes --auto-approve when permissions are dangerously skipped', function () {
    // `--auto-approve  Auto-approve all tool calls (skip approval prompts)` —
    // verified against omp 17.1.3. First in argv, like every other bridge's
    // bypass flag, so a profile argument cannot land ahead of it.
    const args = new OmpBridge().getArgs({ dangerouslySkipPermissions: true });
    assert.strictEqual(args[0], '--auto-approve');
  });

  it('does not auto-approve unless asked', function () {
    assert.ok(!new OmpBridge().getArgs({}).includes('--auto-approve'));
    assert.ok(!new OmpBridge().getArgs({}).includes('--approval-mode'));
  });

  it('never passes --plan-yolo for the dangerous path', function () {
    // Despite the name, --plan-yolo is a plan-mode workflow that auto-approves
    // the plan and then switches models to execute it — not a blanket tool
    // bypass. Wiring the Dangerous button to it would both mislabel what the
    // user agreed to and silently change which model does the work.
    const args = new OmpBridge().getArgs({ dangerouslySkipPermissions: true });
    assert.ok(
      !args.some((a) => a.startsWith('--plan-yolo')),
      `--plan-yolo must not be used, got: ${args.join(' ')}`,
    );
  });

  it('is a separate binary from pi, so neither bridge shadows the other', function () {
    // omp is a fork of pi and both can be installed side by side. If the omp
    // bridge ever resolved to `pi` (or vice versa) the launcher would show two
    // entries that start the same agent.
    const omp = new OmpBridge().getCommandCandidates();
    const pi = new PiBridge().getCommandCandidates();
    assert.ok(omp.every((c) => path.basename(c) === 'omp'));
    assert.ok(pi.every((c) => path.basename(c) === 'pi'));
    assert.strictEqual(omp.filter((c) => pi.includes(c)).length, 0);
  });

  it('offers a bypass where the pi bridge deliberately does not', function () {
    // pi's --approve only trusts project-local extension and skill files; it is
    // not a tool-approval bypass, which is why PiBridge returns []. omp's
    // --auto-approve is the real thing, so the fork diverges here on purpose.
    assert.deepStrictEqual(new PiBridge().getArgs({ dangerouslySkipPermissions: true }), []);
    assert.ok(
      new OmpBridge().getArgs({ dangerouslySkipPermissions: true }).includes('--auto-approve'),
    );
  });
});
