const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const pty = require('@lydell/node-pty');
const {
  ContainerProcessControl,
  TRACKED_PROCESS_GROUP_WRAPPER,
  TRACKED_PROCESS_WRAPPER,
} = require('../dist/server/services/environments/process-control.js');

function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition was not reached'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function tokenProcesses(token) {
  const needle = Buffer.from(`CODE_AGENTS_WEBCLI_RUNTIME_TOKEN=${token}`);
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = fs.readFileSync(`/proc/${entry}/environ`);
      if (environ.toString().split('\0').some((value) => Buffer.from(value).equals(needle))) {
        found.push(Number(entry));
      }
    } catch {}
  }
  return found;
}

function stat(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
  return { state: fields[0], pgrp: Number(fields[2]), session: Number(fields[3]) };
}

function localEngine(calls) {
  return {
    kind: 'podman',
    binary: 'sh',
    exec(spec, command, args) {
      calls.push(spec);
      return new Promise((resolve, reject) => {
        execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
    },
  };
}

describe('tracked container process control', function() {
  // The controller deliberately permits a full TERM/KILL/proof cycle of up to
  // 45 seconds. Leave scheduling headroom when this real PTY test runs beside
  // the full suite on a busy CI host.
  this.timeout(50000);

  it('preserves a real PTY and kills job-control plus detached descendants', async function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-process-control-'));
    const token = `abcde-${process.pid}-${Date.now()}`;
    const controlFile = path.join(dir, 'runtime.pid');
    const doneFile = path.join(dir, 'runtime.done');
    const calls = [];
    let output = '';
    let terminal;
    try {
      terminal = pty.spawn(
        'sh',
        [
          '-c', TRACKED_PROCESS_WRAPPER, 'sh', '1', controlFile, doneFile,
          token, TRACKED_PROCESS_GROUP_WRAPPER,
          'bash', '--noprofile', '--norc', '-i',
        ],
        { cwd: dir, env: process.env, cols: 80, rows: 24, name: 'xterm-color' },
      );
      terminal.onData((value) => { output += value; });
      const exited = new Promise((resolve) => terminal.onExit(resolve));
      await waitUntil(() => fs.existsSync(controlFile));

      terminal.write(
        "sleep 100 & setsid sh -c 'trap \"\" TERM; while :; do sleep 1; done' & echo TRACKED_READY\n",
      );
      await waitUntil(() => output.includes('TRACKED_READY'));

      const [leader, start] = fs.readFileSync(controlFile, 'utf8').trim().split(/\s+/);
      const members = tokenProcesses(token).map((pid) => ({ pid, ...stat(pid) }));
      assert.ok(members.some((member) => member.pgrp !== Number(leader)), 'job control opened another process group');
      assert.ok(members.some((member) => member.session !== Number(leader)), 'setsid descendant escaped the original SID');

      const control = new ContainerProcessControl(
        localEngine(calls),
        'immutable-container-name',
        'immutable-container-id',
        controlFile,
        doneFile,
      );
      await control.stop();
      await exited;
      await waitUntil(() => tokenProcesses(token).length === 0);

      assert.ok(start);
      assert.ok(!/Inappropriate ioctl|job control turned off/i.test(output), output);
      assert.ok(calls.length >= 2, 'verified stop is followed by proof cleanup');
      assert.ok(calls.every((spec) => spec.identity === 'immutable-container-id'));
      await waitUntil(() => !fs.existsSync(controlFile) && !fs.existsSync(doneFile));
    } finally {
      try { terminal?.kill(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settles when stop lands after identity publication but before runtime spawn', async function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-process-race-'));
    const token = `fedcb-${process.pid}-${Date.now()}`;
    const controlFile = path.join(dir, 'runtime.pid');
    const doneFile = path.join(dir, 'runtime.done');
    const delayedAnchor = TRACKED_PROCESS_GROUP_WRAPPER.replace(
      '"$@" <&0 >&1 2>&2 &',
      'sleep 2\n"$@" <&0 >&1 2>&2 &',
    );
    let terminal;
    try {
      terminal = pty.spawn(
        'sh',
        [
          '-c', TRACKED_PROCESS_WRAPPER, 'sh', '1', controlFile, doneFile,
          token, delayedAnchor,
          'sh', '-c', 'trap "" TERM; while :; do sleep 1; done',
        ],
        { cwd: dir, env: process.env, cols: 80, rows: 24, name: 'xterm-color' },
      );
      const exited = new Promise((resolve) => terminal.onExit(resolve));
      await waitUntil(() => fs.existsSync(controlFile));
      const control = new ContainerProcessControl(
        localEngine([]), 'container', 'container-id', controlFile, doneFile,
      );
      await control.stop();
      await exited;
      await waitUntil(() => tokenProcesses(token).length === 0);
    } finally {
      try { terminal?.kill(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
