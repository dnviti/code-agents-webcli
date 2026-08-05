const assert = require('node:assert');

const {
  isWorkspacePrivatePath,
} = require('../dist/server/services/workspace-private-path.js');

describe('workspace private path guard', function () {
  it('matches the reserved component on host, Windows and container paths', function () {
    for (const value of [
      '.cc-web',
      '.cc-web/session-state.sqlite',
      '/workspace/.cc-web/sessions/owner/session/chat.jsonl',
      'C:\\workspace\\.CC-WEB\\history.log',
    ]) {
      assert.strictEqual(isWorkspacePrivatePath(value), true, value);
    }
  });

  it('is component-safe for similarly named project files and folders', function () {
    for (const value of [
      '.cc-web-example',
      'docs/.cc-web.md',
      '/workspace/not.cc-web/file.txt',
      '/workspace/cc-web/file.txt',
    ]) {
      assert.strictEqual(isWorkspacePrivatePath(value), false, value);
    }
  });
});
