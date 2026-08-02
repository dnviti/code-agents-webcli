const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPasteRoutes, PASTE_MAX_BYTES } = require('../dist/server/routes/paste.js');
const { PasteStore } = require('../dist/server/services/paste-store.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('paste-image route', function () {
  let server;
  let baseUrl;
  let storageDir;
  let workingDir;
  let currentUser;
  let sessions;
  let allowPath;
  let validatePathCalls;

  const OWNER = {
    id: 1, githubId: '1', githubLogin: 'tizio', githubName: null, avatarUrl: null, email: null,
  };
  const OTHER = {
    id: 2, githubId: '2', githubLogin: 'altro', githubName: null, avatarUrl: null, email: null,
  };

  beforeEach(async function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-route-store-'));
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-route-wd-'));
    currentUser = OWNER;
    allowPath = true;
    validatePathCalls = 0;

    sessions = new Map([
      ['mine', { id: 'mine', ownerUserId: 1, workingDir, active: true, connections: new Set() }],
      ['theirs', { id: 'theirs', ownerUserId: 2, workingDir, active: true, connections: new Set() }],
      ['project-container', {
        id: 'project-container', ownerUserId: 1, workingDir: '/tmp', projectId: 'p1',
        projectWorkingDirKind: 'container', active: true, connections: new Set(),
      }],
      ['project-host', {
        id: 'project-host', ownerUserId: 1, workingDir, projectId: 'p1',
        projectWorkingDirKind: 'host', active: true, connections: new Set(),
      }],
    ]);

    const app = express();
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(
      createPasteRoutes({
        claudeSessions: sessions,
        pasteStore: new PasteStore({ storageDir }),
        validatePath: (target) => {
          validatePathCalls += 1;
          return allowPath ? { valid: true, path: target } : { valid: false, error: 'outside' };
        },
      }),
    );

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async function () {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  function post(sessionId, body, headers = {}) {
    return fetch(`${baseUrl}/api/sessions/${sessionId}/paste-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body,
    });
  }

  it('stores an image and returns the text to type', async function () {
    const response = await post('mine', PNG);
    assert.strictEqual(response.status, 200);

    const body = await response.json();
    const stored = listFiles(path.join(workingDir, '.cc-web', 'pasted'))
      .filter((file) => file.endsWith('.png'));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(body.path, stored[0]);
    // The trailing space, and no newline: the user still has to add their
    // question and press Enter themselves.
    assert.ok(body.insertText.endsWith(' '));
    assert.ok(!body.insertText.includes('\n'));
    assert.deepStrictEqual(fs.readFileSync(stored[0]), PNG);
  });

  // The declared content type is untrusted on both sides: the browser derives
  // File.type from an extension lookup on the client's own machine.
  it('ignores the declared MIME type in both directions', async function () {
    const asText = await post('mine', PNG, { 'Content-Type': 'text/plain' });
    assert.strictEqual(asText.status, 200, 'real PNG bytes are accepted whatever the header says');

    const before = listFiles(workingDir).length;
    const lying = await post('mine', Buffer.from('#!/bin/sh\nrm -rf /\n'), {
      'Content-Type': 'image/png',
    });
    assert.strictEqual(lying.status, 415);
    assert.strictEqual((await lying.json()).error, 'unsupported_image_type');
    assert.strictEqual(listFiles(workingDir).length, before, 'nothing may be written');
  });

  const rejected = [
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 415],
    ['an HTML document', Buffer.from('<!doctype html><body>x</body>'), 415],
    ['an ELF binary', Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(64)]), 415],
    ['an empty body', Buffer.alloc(0), 400],
  ];

  rejected.forEach(function ([label, bytes, status]) {
    it(`refuses ${label} and writes nothing`, async function () {
      const response = await post('mine', bytes);
      assert.strictEqual(response.status, status);
      assert.deepStrictEqual(listFiles(workingDir), []);
    });
  });

  it('refuses an image over the limit', async function () {
    const oversize = Buffer.concat([PNG, Buffer.alloc(PASTE_MAX_BYTES)]);
    const response = await post('mine', oversize);
    assert.strictEqual(response.status, 413);
    assert.strictEqual((await response.json()).error, 'image_too_large');
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('accepts an image exactly at the limit', async function () {
    // Proves the cap is not off by one in the strict direction.
    const exact = Buffer.concat([PNG, Buffer.alloc(PASTE_MAX_BYTES - PNG.length)]);
    assert.strictEqual(exact.length, PASTE_MAX_BYTES);
    const response = await post('mine', exact);
    assert.strictEqual(response.status, 200);
  });

  it('requires a signed-in user', async function () {
    currentUser = null;
    const response = await post('mine', PNG);
    assert.strictEqual(response.status, 401);
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('answers 404 for another user\'s session', async function () {
    currentUser = OTHER;
    const response = await post('mine', PNG);
    // 404 rather than 403, so nobody can probe for another user's session ids.
    assert.strictEqual(response.status, 404);
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('answers 404 for a session that does not exist', async function () {
    const response = await post('does-not-exist', PNG);
    assert.strictEqual(response.status, 404);
  });

  it('refuses when the session\'s working directory is no longer allowed', async function () {
    // SessionStore restores working_dir from SQLite with no re-check, so a
    // narrowed base folder has to be caught here.
    allowPath = false;
    const response = await post('mine', PNG);
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'session_outside_base');
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('rejects every project namespace before a container path can touch host fs', async function () {
    const canary = path.join(os.tmpdir(), `cawc-paste-canary-${process.pid}-${Date.now()}`);
    fs.writeFileSync(canary, 'untouched');
    try {
      for (const sessionId of ['project-container', 'project-host']) {
        const response = await post(sessionId, PNG);
        assert.strictEqual(response.status, 409);
        assert.strictEqual((await response.json()).error, 'unsupported_paste_namespace');
      }
      assert.strictEqual(validatePathCalls, 0, 'host validation must not interpret a project path');
      assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'untouched');
      assert.ok(!fs.existsSync(path.join(workingDir, '.cc-web')));
    } finally {
      fs.rmSync(canary, { force: true });
    }
  });

  it('refuses a cross-origin write', async function () {
    // SameSite=Lax is site-scoped, so a sibling subdomain the attacker
    // controls would otherwise arrive with the cookie attached.
    const response = await post('mine', PNG, { Origin: 'https://evil.example' });
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'cross_origin');
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('allows a same-origin write', async function () {
    const origin = baseUrl;
    const response = await post('mine', PNG, { Origin: origin });
    assert.strictEqual(response.status, 200);
  });

  it('quotes a path that needs it', async function () {
    const awkward = path.join(workingDir, "spazio e ' apostrofo");
    fs.mkdirSync(awkward);
    sessions.get('mine').workingDir = awkward;

    const body = await (await post('mine', PNG)).json();
    assert.ok(body.insertText.startsWith("'"), 'a path with a space must be quoted');
    assert.ok(body.insertText.includes("'\\''"), 'an apostrophe must be escaped POSIX-style');
  });

  it('leaves no escape sequences or header injection in the response', async function () {
    const response = await post('mine', PNG);
    const body = await response.text();
    assert.ok(!body.includes('\x1b'));
    assert.ok(!response.headers.get('x-injected'));
  });
});
