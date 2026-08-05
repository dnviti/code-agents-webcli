'use strict';

const assert = require('node:assert');

const { runElectronAttachmentE2E } = require('./electron-attachment/run.js');

describe('Electron attachment renderer', function () {
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
