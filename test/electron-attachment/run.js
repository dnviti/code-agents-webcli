#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function commandAvailable(command) {
  const result = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'sh',
    process.platform === 'win32' ? [command] : ['-c', `command -v ${command} >/dev/null 2>&1`],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

function electronAttachmentCommand(environment = process.env) {
  const electron = require('electron');
  const harness = path.join(__dirname, 'harness.js');
  if (process.platform !== 'linux' || environment.DISPLAY || environment.WAYLAND_DISPLAY) {
    // Prefer X11 when XWayland is advertised. Electron can otherwise wait
    // indefinitely for a compositor-specific readiness event on headless or
    // nested Wayland sessions; the shipped security preferences are identical.
    return {
      command: electron,
      args: [...(process.platform === 'linux' && environment.DISPLAY ? ['--ozone-platform=x11'] : []), harness],
    };
  }
  if (commandAvailable('xvfb-run')) {
    return { command: 'xvfb-run', args: ['-a', electron, harness] };
  }
  return {
    skipped: true,
    reason: 'no DISPLAY/WAYLAND_DISPLAY and xvfb-run is not installed',
  };
}

function runElectronAttachmentE2E(options = {}) {
  const requestedEnvironment = { ...process.env, ...(options.env || {}) };
  const selected = electronAttachmentCommand(requestedEnvironment);
  if (selected.skipped) {
    if (!requestedEnvironment.CI) return selected;
    const message = `Electron attachment renderer is required in CI: ${selected.reason}`;
    return {
      status: 1,
      output: message,
      error: new Error(message),
    };
  }
  const env = { ...requestedEnvironment };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  const result = spawnSync(selected.command, selected.args, {
    cwd: path.resolve(__dirname, '..', '..'),
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ...result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

if (require.main === module) {
  const result = runElectronAttachmentE2E();
  if (result.skipped) {
    console.log(`ELECTRON_ATTACHMENT_E2E_SKIPPED ${result.reason}`);
    process.exit(0);
  }
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}

module.exports = {
  electronAttachmentCommand,
  runElectronAttachmentE2E,
};
