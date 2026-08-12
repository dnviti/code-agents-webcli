'use strict';

const assert = require('node:assert');

const {
  isKernelSandboxStartupFailure,
  isStrictTestEnvironment,
  runElectronAttachmentE2E,
} = require('./electron-attachment/run.js');

describe('Electron attachment renderer', function () {
  it('classifies only the known local namespace-sandbox startup abort', function () {
    const abort = [
      'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
      'FATAL:zygote_host_impl_linux.cc(207)] Check failed: . : Invalid argument (22)',
    ].join('\n');
    assert.strictEqual(isKernelSandboxStartupFailure(abort), true);
    assert.strictEqual(isKernelSandboxStartupFailure(
      'FATAL:content/browser/sandbox_host_linux.cc:41] Check failed: . shutdown: Operation not permitted (1)',
    ), true);
    assert.strictEqual(isKernelSandboxStartupFailure('renderer failed to upload attachment'), false);
    assert.strictEqual(isKernelSandboxStartupFailure('Failed to move to new namespace: Operation not permitted'), false);
  });

  it('forbids no-display and kernel-sandbox skips in strict runner mode', function () {
    const strictEnvironment = {
      CI: '',
      CCWEB_TEST_STRICT: '1',
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
    };
    assert.strictEqual(isStrictTestEnvironment(strictEnvironment), true);
    const noDisplay = runElectronAttachmentE2E({
      env: strictEnvironment,
      platform: 'linux',
      electronPath: '/test/electron',
      commandAvailable: () => false,
      spawnSync: () => { throw new Error('must fail before spawn'); },
    });
    assert.strictEqual(noDisplay.skipped, undefined);
    assert.strictEqual(noDisplay.status, 1);
    assert.match(noDisplay.output, /strict test mode/);

    const kernelOutput = [
      'Failed to move to new namespace: Operation not permitted',
      'FATAL:zygote_host_impl_linux.cc(207)] Check failed: . : Invalid argument (22)',
    ].join('\n');
    const kernel = runElectronAttachmentE2E({
      env: { ...strictEnvironment, DISPLAY: ':99' },
      platform: 'linux',
      electronPath: '/test/electron',
      spawnSync: () => ({ status: 1, stdout: '', stderr: kernelOutput }),
    });
    assert.strictEqual(kernel.skipped, undefined);
    assert.strictEqual(kernel.status, 1);
    assert.match(kernel.output, /zygote_host_impl_linux/);
  });

  it('takes picker, drop, and clipboard images through local and remote controller targets', function () {
    this.timeout(130_000);
    const result = runElectronAttachmentE2E();
    if (result.skipped) {
      console.log(`ELECTRON_ATTACHMENT_E2E_SKIPPED ${result.reason}`);
      this.skip();
      return;
    }
    assert.strictEqual(
      result.status,
      0,
      `real Electron attachment harness failed\n${result.output || result.error?.stack || ''}`,
    );
    assert.match(
      result.output,
      /ELECTRON_ATTACHMENT_E2E_OK picker=2 drop=2 clipboard=2 local=3 remote=3 ui-download=6/,
    );
  });
});
