'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPackagedWorkspacePersistenceSmoke, SMOKE_PAYLOAD_BYTES } = require('../desktop/packaged-smoke.js');
const { ClaudeCodeWebServer } = require('../dist/server/index.js');
const { openDatabase } = require('../dist/server/services/sqlite.js');

describe('packaged desktop workspace persistence smoke seam', function () {
  this.timeout(30_000);

  it('keeps metadata in shared SQLite and binary artifacts in workspace .cc-web', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-packaged-smoke-test-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    let server = null;
    let result = null;
    try {
      server = new ClaudeCodeWebServer({
        dataDir,
        baseFolder: root,
        port: 0,
        host: '127.0.0.1',
        desktop: {
          authToken: 'packaged-smoke-test-token',
          username: 'packaged-smoke-user',
          name: 'Packaged Smoke User',
        },
      });
      try {
        await server.start();
        result = await runPackagedWorkspacePersistenceSmoke({
          started: {
            server,
            url: server.localUrl,
            auth: server.desktopAuthCookie,
          },
          workspaceRoot,
          dataDir,
        });
        assert.equal(result.bytes, SMOKE_PAYLOAD_BYTES);
        assert.equal(result.mode, 'shared-sqlite-project-artifacts');
        assert.equal(result.workspaceOnly, false);
        assert.ok(result.attachmentPath.startsWith(path.join(workspaceRoot, '.cc-web') + path.sep));
        assert.ok(result.pastePath.startsWith(path.join(workspaceRoot, '.cc-web') + path.sep));
        assert.ok(result.chatLogPath.startsWith(path.join(workspaceRoot, '.cc-web') + path.sep));
        assert.ok(result.chatIndexPath.startsWith(path.join(workspaceRoot, '.cc-web') + path.sep));
        assert.equal(fs.existsSync(result.sessionDatabase), false);
        assert.ok(fs.existsSync(result.globalDatabase));
        assert.ok(fs.existsSync(path.join(result.sessionDirectory, 'transcript.md')));
        assert.ok(fs.existsSync(result.chatLogPath));
        assert.ok(fs.existsSync(result.chatIndexPath));
        assert.ok(fs.readFileSync(result.chatLogPath, 'utf8').includes(result.chatPayload));
      } finally {
        await server.shutdown().catch(() => undefined);
      }

      const globalDatabase = openDatabase(path.join(dataDir, 'app.sqlite'));
      try {
        const row = globalDatabase.prepare(`
          SELECT storage_workspace_root AS root
            FROM runtime_sessions WHERE id = ?
        `).get(result.sessionId);
        assert.equal(path.resolve(row.root), fs.realpathSync(workspaceRoot));
      } finally {
        globalDatabase.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
