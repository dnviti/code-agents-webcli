const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../dist/server/index.js');
const { createConfig } = require('../dist/server/config.js');

function request(url, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function closes(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('error', reject);
    ws.once('close', (code) => resolve(code));
  });
}

function opensAndCloses(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('error', reject);
    ws.once('open', () => ws.close(1000));
    ws.once('close', (code) => resolve(code));
  });
}

describe('Desktop server seam', function () {
  it('keeps an ephemeral port, requires the exact loopback bind, and makes HTTP explicit', function () {
    const config = createConfig({
      port: 0,
      host: '127.0.0.1',
      baseFolder: '/desktop-home',
      desktop: { authToken: 'token', username: 'daniele' },
    });
    assert.strictEqual(config.port, 0);
    assert.strictEqual(config.useHttps, false);
    assert.strictEqual(config.baseFolder, '/desktop-home');
    assert.strictEqual(createConfig({ https: false }).useHttps, true);
    assert.throws(
      () => new ClaudeCodeWebServer({ desktop: { authToken: 'token', username: 'daniele' } }),
      /127\.0\.0\.1/,
    );
  });

  it('authenticates only the embedder cookie and preserves the local user as installer', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'desktop-server-'));
    const server = new ClaudeCodeWebServer({
      dataDir,
      baseFolder: os.homedir(),
      port: 0,
      host: '127.0.0.1',
      desktop: { authToken: 'random-desktop-token', username: 'desktop-user', name: 'Desktop User' },
    });
    try {
      await server.start();
      const base = server.localUrl;
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepStrictEqual(server.desktopAuthCookie, {
        name: 'code_agents_webcli_desktop_auth',
        value: 'random-desktop-token',
        httpOnly: true,
        sameSite: 'strict',
      });

      assert.strictEqual((await request(`${base}/api/auth/me`)).status, 401);
      assert.strictEqual((await request(`${base}/api/auth/me`, 'code_agents_webcli_session=random-desktop-token')).status, 401);
      assert.strictEqual(await closes(base.replace('http:', 'ws:'), { Origin: base }), 4401);
      assert.strictEqual(await closes(base.replace('http:', 'ws:'), {
        Origin: 'http://127.0.0.1:9',
        Cookie: 'code_agents_webcli_desktop_auth=random-desktop-token',
      }), 4403);
      assert.strictEqual(await closes(base.replace('http:', 'ws:'), {
        Cookie: 'code_agents_webcli_desktop_auth=random-desktop-token',
      }), 4403);

      assert.strictEqual((await request(
        `${base}/api/auth/me`,
        'code_agents_webcli_desktop_auth=random-desktop-token',
        { Origin: 'http://127.0.0.1:9' },
      )).status, 403);
      assert.strictEqual((await request(
        `${base}/api/auth/me`,
        'code_agents_webcli_desktop_auth=random-desktop-token',
        { 'Sec-Fetch-Site': 'same-site' },
      )).status, 403);
      assert.strictEqual((await request(
        `${base}/api/auth/me`,
        'code_agents_webcli_desktop_auth=random-desktop-token',
        { Host: '127.0.0.1:9' },
      )).status, 403);

      const authenticated = await request(
        `${base}/api/auth/me`,
        'code_agents_webcli_desktop_auth=random-desktop-token',
        { Origin: base },
      );
      assert.strictEqual(authenticated.status, 200);
      assert.strictEqual(await opensAndCloses(base.replace('http:', 'ws:'), {
        Origin: base,
        Cookie: 'code_agents_webcli_desktop_auth=random-desktop-token',
      }), 1000);
      const user = JSON.parse(authenticated.body).user;
      assert.strictEqual(user.githubLogin, 'desktop-user');
      assert.strictEqual(user.githubName, 'Desktop User');
      assert.strictEqual(server.database.getInstallerUserId(), user.id);
      const desktopConfig = JSON.parse((await request(
        `${base}/api/config`,
        'code_agents_webcli_desktop_auth=random-desktop-token',
      )).body);
      assert.strictEqual(desktopConfig.logoutUrl, null);
      assert.ok(desktopConfig.supportedShells.length > 0);
      assert.strictEqual((await request(`${base}/auth/github/login`, 'code_agents_webcli_desktop_auth=random-desktop-token')).status, 404);
    } finally {
      await server.shutdown();
      server.saveSessionsToDisk = async () => {};
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });
});
