'use strict';

// Runtime capability probes used by the repository test runner.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CAPABILITIES = Object.freeze([
  'loopbackTcp',
  'unixSocket',
  // A synchronously spawned child whose stdout can be captured reliably.
  'subprocess',
  // An asynchronously spawned child whose stdout can be captured reliably.
  'asyncSubprocess',
  // A captured child which can itself capture an exact grandchild response.
  'nestedSubprocess',
]);

function available() {
  return { available: true, detail: 'available' };
}

function unavailable(error) {
  const code = error?.code || error?.name || 'unavailable';
  const message = error?.message ? `: ${error.message}` : '';
  return { available: false, detail: `${code}${message}` };
}

function listenProbe(address, cleanup) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { cleanup?.(); } catch { /* probe cleanup must not hide the result */ }
      resolve(result);
    };
    const timeout = setTimeout(() => {
      server.close(() => finish({ available: false, detail: 'timeout: listener did not become ready' }));
    }, 2_000);
    timeout.unref?.();
    server.once('error', (error) => finish(unavailable(error)));
    server.listen(address, () => {
      server.close((error) => finish(error ? unavailable(error) : available()));
    });
  });
}

async function probeLoopbackTcp() {
  return listenProbe({ port: 0, host: '127.0.0.1' });
}

async function probeUnixSocket() {
  if (process.platform === 'win32') {
    return listenProbe(`\\\\.\\pipe\\cc-web-capability-${process.pid}-${Date.now()}`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-capability-'));
  const socketPath = path.join(directory, 'listener.sock');
  return listenProbe(socketPath, () => fs.rmSync(directory, { recursive: true, force: true }));
}

function probeSubprocess(options = {}) {
  const expectedOutput = 'cc-web-subprocess-probe';
  const result = (options.spawnSync || spawnSync)(options.execPath || process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(expectedOutput)})`,
  ], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.error) return unavailable(result.error);
  if (result.status !== 0) {
    return {
      available: false,
      detail: `exit ${result.status ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}`,
    };
  }
  if (result.stdout !== expectedOutput) {
    return {
      available: false,
      detail: `stdout did not match probe output (${JSON.stringify(result.stdout || '')})`,
    };
  }
  return available();
}

function probeNestedSubprocess(options = {}) {
  const grandchildOutput = 'cc-web-nested-grandchild';
  const expectedOutput = 'cc-web-nested-subprocess-probe';
  const grandchildProgram = `process.stdout.write(${JSON.stringify(grandchildOutput)})`;
  const childProgram = `
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.error) {
      process.stderr.write(String(result.error.code || result.error.message || result.error));
      process.exit(21);
    }
    if (result.status !== 0 || result.stdout !== ${JSON.stringify(grandchildOutput)}) {
      process.stderr.write('grandchild mismatch');
      process.exit(22);
    }
    process.stdout.write(${JSON.stringify(expectedOutput)});
  `;
  const result = (options.spawnSync || spawnSync)(options.execPath || process.execPath, [
    '-e',
    childProgram,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error) return unavailable(result.error);
  if (result.status !== 0) {
    return {
      available: false,
      detail: `nested exit ${result.status ?? 'unknown'}${result.stderr ? `: ${String(result.stderr).trim()}` : ''}`,
    };
  }
  if (result.stdout !== expectedOutput) {
    return {
      available: false,
      detail: `nested stdout did not match probe output (${JSON.stringify(result.stdout || '')})`,
    };
  }
  return available();
}

function probeAsyncSubprocess(options = {}) {
  const expectedOutput = 'cc-web-async-subprocess-probe';
  return new Promise((resolve) => {
    let child;
    try {
      child = (options.spawn || spawn)(options.execPath || process.execPath, [
        '-e',
        `process.stdout.write(${JSON.stringify(expectedOutput)})`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve(unavailable(error));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* capability is already unavailable */ }
      finish({ available: false, detail: 'timeout: async child did not exit' });
    }, 2_000);
    timeout.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(unavailable(error)));
    child.once('close', (status, signal) => {
      if (status !== 0) {
        finish({
          available: false,
          detail: `async exit ${status ?? 'unknown'}${signal ? ` (${signal})` : ''}${stderr ? `: ${stderr.trim()}` : ''}`,
        });
      } else if (stdout !== expectedOutput) {
        finish({
          available: false,
          detail: `async stdout did not match probe output (${JSON.stringify(stdout)})`,
        });
      } else {
        finish(available());
      }
    });
  });
}

const probes = Object.freeze({
  loopbackTcp: probeLoopbackTcp,
  unixSocket: probeUnixSocket,
  subprocess: probeSubprocess,
  asyncSubprocess: probeAsyncSubprocess,
  nestedSubprocess: probeNestedSubprocess,
});

async function probeCapabilities(capabilities = CAPABILITIES, options = {}) {
  const selected = options.probes || probes;
  const results = {};
  for (const capability of capabilities) {
    const probe = selected[capability];
    if (typeof probe !== 'function') {
      results[capability] = { available: false, detail: 'no probe is registered' };
      continue;
    }
    try {
      results[capability] = await probe();
    } catch (error) {
      results[capability] = unavailable(error);
    }
  }
  return results;
}

module.exports = {
  CAPABILITIES,
  available,
  unavailable,
  probeLoopbackTcp,
  probeUnixSocket,
  probeSubprocess,
  probeAsyncSubprocess,
  probeNestedSubprocess,
  probeCapabilities,
};
