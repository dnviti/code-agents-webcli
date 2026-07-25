const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createChatAttachmentRoutes,
  ATTACHMENT_MAX_BYTES,
} = require('../dist/server/routes/chat-attachments.js');
const {
  AttachmentStore,
  safeName,
  displayMime,
  serveKind,
} = require('../dist/server/services/attachment-store.js');

// Uploading a file to a chat turn, end to end over the real route.
//
// The properties that matter here are not "does it store the bytes" — they are
// the ones that stop a file picker from becoming a way into somebody else's
// session or a stored XSS on the app's own origin: ownership, confinement, and
// the refusal to ever serve a file back under a content type the uploader
// chose.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('chat attachment route', function () {
  let server;
  let baseUrl;
  let workingDir;
  let currentUser;
  let sessions;
  let allowPath;

  const OWNER = { id: 1, githubId: '1', githubLogin: 'tizio', githubName: null, avatarUrl: null, email: null };
  const OTHER = { id: 2, githubId: '2', githubLogin: 'altro', githubName: null, avatarUrl: null, email: null };

  beforeEach(async function () {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-wd-'));
    currentUser = OWNER;
    allowPath = true;

    sessions = new Map([
      ['mine', { id: 'mine', ownerUserId: 1, workingDir, active: true, connections: new Set() }],
      ['theirs', { id: 'theirs', ownerUserId: 2, workingDir, active: true, connections: new Set() }],
    ]);

    const app = express();
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(
      createChatAttachmentRoutes({
        claudeSessions: sessions,
        attachmentStore: new AttachmentStore(),
        validatePath: (target) =>
          (allowPath ? { valid: true, path: target } : { valid: false, error: 'outside' }),
      }),
    );

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async function () {
    // Undici keeps the socket alive between requests, and `close` waits for
    // every one of them; without this the suite hangs on teardown rather than
    // on anything it was testing.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  function upload(sessionId, name, body, type = 'application/octet-stream') {
    return fetch(`${baseUrl}/api/sessions/${sessionId}/chat-attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
  }

  it('stores a file inside the session directory and answers with a ChatAttachment', async function () {
    const response = await upload('mine', 'notes.txt', Buffer.from('hello'), 'text/plain');
    assert.strictEqual(response.status, 200);

    const body = await response.json();
    assert.strictEqual(body.name, 'notes.txt');
    assert.strictEqual(body.size, 5);
    assert.strictEqual(body.mime, 'text/plain');
    assert.ok(body.url.startsWith('/api/sessions/mine/chat-attachments/'), 'a URL the browser can fetch back');
    // `path` is the field the Claude and pi adapters actually hand to the CLI.
    assert.ok(body.path.startsWith(workingDir + path.sep), 'the file lands where the agent can read it');
    assert.strictEqual(fs.readFileSync(body.path, 'utf8'), 'hello');
  });

  it('serves a real image back inline, under the type its own bytes say', async function () {
    const { url } = await upload('mine', 'shot.png', PNG, 'image/png').then((r) => r.json());
    const fetched = await fetch(`${baseUrl}${url}`);

    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.headers.get('content-type'), 'image/png');
    assert.match(fetched.headers.get('content-disposition'), /^inline/);
    assert.strictEqual(fetched.headers.get('x-content-type-options'), 'nosniff');
    assert.deepStrictEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
  });

  it('never serves a file back under a content type the uploader chose', async function () {
    // The whole attack: upload markup, have it come back as text/html from the
    // app's own origin, and every cookie on it is reachable from the script.
    const html = Buffer.from('<script>alert(1)</script>');
    const stored = await upload('mine', 'evil.html', html, 'text/html').then((r) => r.json());

    assert.strictEqual(stored.mime, 'text/html', 'the claim is recorded for display');

    const fetched = await fetch(`${baseUrl}${stored.url}`);
    assert.strictEqual(fetched.headers.get('content-type'), 'application/octet-stream');
    assert.match(fetched.headers.get('content-disposition'), /^attachment/);
    assert.strictEqual(fetched.headers.get('x-content-type-options'), 'nosniff');
    await fetched.arrayBuffer();
  });

  it('refuses an image/* claim its bytes do not support', async function () {
    const stored = await upload('mine', 'fake.png', Buffer.from('not a png at all'), 'image/png').then((r) => r.json());
    // Left as image/png this would put a broken <img> in the transcript and
    // tell Claude's adapter to base64 a text file as a picture.
    assert.strictEqual(stored.mime, 'application/octet-stream');
  });

  it('will not let one user upload into another user’s session', async function () {
    const response = await upload('theirs', 'notes.txt', Buffer.from('hello'));
    assert.strictEqual(response.status, 404, '404, not 403 — nobody may probe for another user’s ids');
    await response.arrayBuffer();
  });

  it('will not let one user read another user’s attachment', async function () {
    const { url } = await upload('mine', 'secret.txt', Buffer.from('classified')).then((r) => r.json());

    currentUser = OTHER;
    const fetched = await fetch(`${baseUrl}${url}`);
    assert.strictEqual(fetched.status, 404);
    await fetched.arrayBuffer();
  });

  it('requires a signed-in user', async function () {
    currentUser = null;
    const response = await upload('mine', 'x.txt', Buffer.from('x'));
    assert.strictEqual(response.status, 401);
    await response.arrayBuffer();
  });

  it('refuses a session whose working directory is no longer inside the allowed base', async function () {
    allowPath = false;
    const response = await upload('mine', 'x.txt', Buffer.from('x'));
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'session_outside_base');
  });

  it('refuses a cross-origin write even though the cookie would ride along', async function () {
    const response = await fetch(`${baseUrl}/api/sessions/mine/chat-attachments?name=x.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: 'x',
    });
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'cross_origin');
  });

  it('rejects an empty body rather than storing a zero-byte file', async function () {
    const response = await upload('mine', 'empty.txt', Buffer.alloc(0));
    assert.strictEqual(response.status, 400);
    await response.arrayBuffer();
  });

  it('reports the same limit the client checks against', async function () {
    const response = await upload('mine', 'huge.bin', Buffer.alloc(ATTACHMENT_MAX_BYTES + 1024));
    assert.strictEqual(response.status, 413);
    assert.strictEqual((await response.json()).limitBytes, ATTACHMENT_MAX_BYTES);
  });

  it('cannot be talked into reading a path outside the attachment directory', async function () {
    fs.writeFileSync(path.join(workingDir, 'private.txt'), 'do not serve me');

    for (const attempt of ['../private.txt', '..%2Fprivate.txt', 'private.txt', '%2Fetc%2Fpasswd']) {
      const response = await fetch(`${baseUrl}/api/sessions/mine/chat-attachments/${attempt}`);
      assert.ok(response.status === 404, `${attempt} should not resolve (got ${response.status})`);
      await response.arrayBuffer();
    }
  });

  it('does not overwrite an earlier attachment of the same name', async function () {
    const first = await upload('mine', 'notes.txt', Buffer.from('one')).then((r) => r.json());
    const second = await upload('mine', 'notes.txt', Buffer.from('two')).then((r) => r.json());

    assert.notStrictEqual(first.path, second.path);
    assert.strictEqual(fs.readFileSync(first.path, 'utf8'), 'one');
    assert.strictEqual(fs.readFileSync(second.path, 'utf8'), 'two');
  });
});

describe('attachment names and types', function () {
  it('reduces a filename to something that can only be a filename', function () {
    assert.strictEqual(safeName('notes.txt'), 'notes.txt');
    assert.strictEqual(safeName('../../etc/passwd'), 'passwd');
    assert.strictEqual(safeName('C:\\Users\\me\\report.pdf'), 'report.pdf');
    assert.strictEqual(safeName('.bashrc'), 'bashrc', 'no leading dot: an attachment must not hide');
    assert.strictEqual(safeName('my file (1).png'), 'my-file-1-.png');
    assert.strictEqual(safeName(''), 'attachment');
    assert.strictEqual(safeName('...'), 'attachment');
    assert.ok(safeName('a'.repeat(400)).length <= 120);
  });

  it('lets the bytes decide whether something is an image', function () {
    assert.strictEqual(displayMime(PNG, 'application/octet-stream'), 'image/png');
    assert.strictEqual(displayMime(Buffer.from('plain'), 'text/plain'), 'text/plain');
    assert.strictEqual(displayMime(Buffer.from('plain'), 'image/gif'), 'application/octet-stream');
    assert.strictEqual(displayMime(Buffer.from('plain'), 'nonsense'), 'application/octet-stream');
    assert.strictEqual(displayMime(Buffer.from('plain'), 'text/plain; charset=utf-8'), 'text/plain');
  });

  it('offers exactly two ways to serve a stored file', function () {
    const image = serveKind(PNG, 'abcdef012345-shot.png');
    assert.deepStrictEqual(image, { contentType: 'image/png', inline: true, filename: 'shot.png' });

    const other = serveKind(Buffer.from('<html>'), 'abcdef012345-evil.html');
    assert.strictEqual(other.contentType, 'application/octet-stream');
    assert.strictEqual(other.inline, false);
  });
});
