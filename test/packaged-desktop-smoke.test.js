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

  it('round-trips a binary attachment and leaves the session only in workspace .cc-web', async function () {
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
        assert.ok(result.attachmentPath.startsWith(path.join(workspaceRoot, '.cc-web') + path.sep));
        assert.ok(fs.existsSync(result.sessionDatabase));
        assert.ok(fs.existsSync(path.join(result.sessionDirectory, 'transcript.md')));
      } finally {
        await server.shutdown().catch(() => undefined);
      }

      const workspaceDatabase = openDatabase(result.sessionDatabase);
      try {
        const row = workspaceDatabase
          .prepare('SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?')
          .get(result.sessionId);
        assert.equal(row.count, 1);
      } finally {
        workspaceDatabase.close();
      }
      const globalDatabase = openDatabase(path.join(dataDir, 'app.sqlite'));
      try {
        assert.equal(
          globalDatabase.prepare('SELECT COUNT(*) AS count FROM runtime_sessions').get().count,
          0,
        );
      } finally {
        globalDatabase.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
