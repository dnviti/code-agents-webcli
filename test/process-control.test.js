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

function waitUntil(predicate, description = 'condition', timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`${description} was not reached`));
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
  return {
    state: fields[0],
    pgrp: Number(fields[2]),
    session: Number(fields[3]),
    startTime: fields[19],
  };
}

function processIsGoneOrReplaced(process) {
  try {
    const current = stat(process.pid);
    return current.state === 'Z' || current.startTime !== process.startTime;
  } catch {
    return true;
  }
}

function processFromFile(file) {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^\d+$/.test(value)) throw new Error(`process identity is not ready: ${file}`);
  const pid = Number(value);
  return { pid, ...stat(pid) };
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
    const jobFile = path.join(dir, 'job.pid');
    const detachedFile = path.join(dir, 'detached.pid');
    const bashrcFile = path.join(dir, 'bashrc');
    const shellPrompt = `CAWC_SHELL_READY_${token}> `;
    const delayedRuntime = TRACKED_PROCESS_GROUP_WRAPPER.replace(
      '"$@" <&0 >&1 2>&2 &',
      'sleep 1\n"$@" <&0 >&1 2>&2 &',
    );
    const calls = [];
    let output = '';
    let terminal;
    let control;
    let cleanupVerified = false;
    try {
      fs.writeFileSync(bashrcFile, `PS1='${shellPrompt}'\nPROMPT_COMMAND=\n`);
      terminal = pty.spawn(
        'sh',
        [
          '-c', TRACKED_PROCESS_WRAPPER, 'sh', '1', controlFile, doneFile,
          token, delayedRuntime,
          'bash', '--noprofile', '--rcfile', bashrcFile, '-i',
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            CAWC_JOB_FILE: jobFile,
            CAWC_DETACHED_FILE: detachedFile,
          },
          cols: 80,
          rows: 24,
          name: 'xterm-color',
        },
      );
      terminal.onData((value) => { output += value; });
      const exited = new Promise((resolve) => terminal.onExit(resolve));
      await waitUntil(() => fs.existsSync(controlFile), 'runtime identity');
      await waitUntil(() => output.includes(shellPrompt), 'interactive shell prompt');

      terminal.write(
        "sh -c 'printf \"%s\\n\" \"$$\" > \"$CAWC_JOB_FILE\"; trap \"\" TERM; exec sleep 100' & "
          + "setsid sh -c 'printf \"%s\\n\" \"$$\" > \"$CAWC_DETACHED_FILE\"; trap \"\" TERM; while :; do sleep 1; done' & "
          + "printf 'TRACKED_%s\\n' READY\n",
      );
      await waitUntil(() => output.includes('TRACKED_READY'), 'tracked child command');

      const [leader, start] = fs.readFileSync(controlFile, 'utf8').trim().split(/\s+/);
      let job;
      let detached;
      await waitUntil(() => {
        try {
          job = processFromFile(jobFile);
          detached = processFromFile(detachedFile);
          return true;
        } catch {
          return false;
        }
      }, 'tracked child identities');
      assert.ok(job.pgrp !== Number(leader), 'job control opened another process group');
      assert.ok(detached.session !== Number(leader), 'setsid descendant escaped the original SID');
      const tracked = tokenProcesses(token);
      assert.ok(tracked.includes(job.pid), 'job-control child carries the runtime token');
      assert.ok(tracked.includes(detached.pid), 'detached child carries the runtime token');

      control = new ContainerProcessControl(
        localEngine(calls),
        'immutable-container-name',
        'immutable-container-id',
        controlFile,
        doneFile,
      );
      await control.stop();
      await exited;
      await waitUntil(() => (
        tokenProcesses(token).length === 0
        && processIsGoneOrReplaced(job)
        && processIsGoneOrReplaced(detached)
      ), 'exact tracked child cleanup');
      cleanupVerified = true;

      assert.ok(start);
      assert.ok(!/Inappropriate ioctl|job control turned off/i.test(output), output);
      assert.ok(calls.length >= 2, 'verified stop is followed by proof cleanup');
      assert.ok(calls.every((spec) => spec.identity === 'immutable-container-id'));
      await waitUntil(
        () => !fs.existsSync(controlFile) && !fs.existsSync(doneFile),
        'control-file cleanup',
      );
    } finally {
      if (!cleanupVerified && (control || fs.existsSync(controlFile))) {
        try {
          control ??= new ContainerProcessControl(
            localEngine(calls),
            'immutable-container-name',
            'immutable-container-id',
            controlFile,
            doneFile,
          );
          await control.stop();
        } catch {}
      }
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
      await waitUntil(() => fs.existsSync(controlFile), 'race identity');
      const control = new ContainerProcessControl(
        localEngine([]), 'container', 'container-id', controlFile, doneFile,
      );
      await control.stop();
      await exited;
      await waitUntil(() => tokenProcesses(token).length === 0, 'race token cleanup');
    } finally {
      try { terminal?.kill(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
