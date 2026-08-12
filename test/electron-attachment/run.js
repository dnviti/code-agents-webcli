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

function electronAttachmentCommand(environment = process.env, options = {}) {
  const electron = options.electronPath || require('electron');
  const platform = options.platform || process.platform;
  const hasCommand = options.commandAvailable || commandAvailable;
  const harness = path.join(__dirname, 'harness.js');
  if (platform !== 'linux' || environment.DISPLAY || environment.WAYLAND_DISPLAY) {
    // Prefer X11 when XWayland is advertised. Electron can otherwise wait
    // indefinitely for a compositor-specific readiness event on headless or
    // nested Wayland sessions; the shipped security preferences are identical.
    return {
      command: electron,
      args: [...(platform === 'linux' && environment.DISPLAY ? ['--ozone-platform=x11'] : []), harness],
    };
  }
  if (hasCommand('xvfb-run')) {
    return { command: 'xvfb-run', args: ['-a', electron, harness] };
  }
  return {
    skipped: true,
    reason: 'no DISPLAY/WAYLAND_DISPLAY and xvfb-run is not installed',
  };
}

function isStrictTestEnvironment(environment) {
  return Boolean(environment.CI) || environment.CCWEB_TEST_STRICT === '1';
}

/**
 * Electron's Linux zygote reports this exact pair when the host kernel forbids
 * its user-namespace sandbox before our harness can start.  It is a host
 * capability failure, not an attachment regression.  Keep this deliberately
 * narrow: renderer errors, missing displays, and ordinary Electron exits must
 * remain test failures.
 */
function isKernelSandboxStartupFailure(output) {
  const text = String(output || '');
  const namespaceFailure = /Failed to move to new namespace:/i.test(text)
    && /zygote_host_impl_linux\.cc/i.test(text)
    && /(?:Operation not permitted|Invalid argument|Check failed)/i.test(text);
  const hostShutdownDenied = /sandbox_host_linux\.cc/i.test(text)
    && /shutdown:\s*Operation not permitted/i.test(text)
    && /Check failed/i.test(text);
  return namespaceFailure || hostShutdownDenied;
}

function runElectronAttachmentE2E(options = {}) {
  const requestedEnvironment = { ...process.env, ...(options.env || {}) };
  const strictTestEnvironment = isStrictTestEnvironment(requestedEnvironment);
  const selected = electronAttachmentCommand(requestedEnvironment, options);
  if (selected.skipped) {
    if (!strictTestEnvironment) return selected;
    const message = `Electron attachment renderer is required in CI or strict test mode: ${selected.reason}`;
    return {
      status: 1,
      output: message,
      error: new Error(message),
    };
  }
  const env = { ...requestedEnvironment };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  const result = (options.spawnSync || spawnSync)(selected.command, selected.args, {
    cwd: path.resolve(__dirname, '..', '..'),
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const completed = {
    ...result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
  if (!strictTestEnvironment && isKernelSandboxStartupFailure(completed.output)) {
    return {
      ...completed,
      skipped: true,
      reason: 'local kernel forbids Electron namespace sandbox startup',
    };
  }
  return completed;
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
  isStrictTestEnvironment,
  isKernelSandboxStartupFailure,
  runElectronAttachmentE2E,
};
