const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createChatAttachmentRoutes,
  ATTACHMENT_MAX_BYTES,
  isChatAttachmentUploadRequest,
} = require('../dist/server/routes/chat-attachments.js');
const {
  AttachmentStore,
  safeName,
  displayMime,
  serveKind,
  storedAttachmentNameFromUrl,
  resolveAttachmentDirectoryBackend,
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
  let scopedRoot;
  let currentUser;
  let sessions;
  let allowPath;
  let validatePathCalls;
  let attachmentStore;

  const OWNER = { id: 1, githubId: '1', githubLogin: 'tizio', githubName: null, avatarUrl: null, email: null };
  const OTHER = { id: 2, githubId: '2', githubLogin: 'altro', githubName: null, avatarUrl: null, email: null };

  beforeEach(async function () {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-wd-'));
    scopedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-scope-'));
    currentUser = OWNER;
    allowPath = true;
    validatePathCalls = 0;
    attachmentStore = new AttachmentStore();

    sessions = new Map([
      ['mine', { id: 'mine', ownerUserId: 1, workingDir, active: true, connections: new Set() }],
      ['theirs', { id: 'theirs', ownerUserId: 2, workingDir, active: true, connections: new Set() }],
      ['scoped', {
        id: 'scoped', ownerUserId: 1, workingDir: path.join(workingDir, 'runtime-subdirectory'),
        storageScope: { workspaceRoot: scopedRoot, ownerKey: 'stable-owner-key' },
        active: true, connections: new Set(),
      }],
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
    const jsonParser = express.json();
    app.use((req, res, next) => {
      if (isChatAttachmentUploadRequest(req.method, req.path)) return next();
      return jsonParser(req, res, next);
    });
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(
      createChatAttachmentRoutes({
        claudeSessions: sessions,
        attachmentStore,
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
    // Undici keeps the socket alive between requests, and `close` waits for
    // every one of them; without this the suite hangs on teardown rather than
    // on anything it was testing.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(scopedRoot, { recursive: true, force: true });
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

  it('keeps an application/json attachment byte-identical past the global JSON parser', async function () {
    const original = Buffer.from('{\n  "kept": [1, 2, 3],\n  "spacing": true\n}\n');
    const response = await upload('mine', 'payload.json', original, 'application/json');
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(fs.readFileSync(body.path), original);
  });

  it('uses the immutable storage scope when it differs from the runtime working directory', async function () {
    const response = await upload('scoped', 'scope.txt', Buffer.from('workspace owned'), 'text/plain');
    assert.strictEqual(response.status, 200);
    const body = await response.json();

    const expected = path.join(
      scopedRoot, '.cc-web', 'attachments', 'stable-owner-key', 'scoped', path.basename(body.path),
    );
    assert.strictEqual(body.path, expected);
    assert.strictEqual(body.relativePath,
      path.join('.cc-web', 'attachments', 'stable-owner-key', 'scoped', path.basename(body.path)));
    assert.strictEqual(fs.readFileSync(expected, 'utf8'), 'workspace owned');
    assert.strictEqual(fs.existsSync(path.join(workingDir, 'runtime-subdirectory', '.cc-web')), false);
  });

  it('serves a real image back inline, under the type its own bytes say', async function () {
    const { url } = await upload('mine', 'shot.png', PNG, 'image/png').then((r) => r.json());
    const fetched = await fetch(`${baseUrl}${url}`);

    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.headers.get('content-type'), 'image/png');
    assert.match(fetched.headers.get('content-disposition'), /^inline/);
    assert.strictEqual(fetched.headers.get('cache-control'), 'no-store');
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

  it('refuses uploads while migration is blocked without calling the store path', async function () {
    const reason = 'Workspace storage is temporarily read-only';
    sessions.get('mine').persistenceUnavailable = reason;
    sessions.get('mine').rollbackRecoveryPending = true;

    const response = await upload('mine', 'must-not-exist.txt', Buffer.from('no write'));

    assert.strictEqual(response.status, 409);
    assert.deepStrictEqual(await response.json(), {
      error: 'session_persistence_unavailable',
      message: reason,
      retryable: true,
    });
    assert.strictEqual(validatePathCalls, 0);
    assert.strictEqual(fs.existsSync(path.join(workingDir, '.cc-web')), false);
  });

  it('refuses uploads for a rollback recovery anchor without calling the store path', async function () {
    sessions.get('mine').rollbackRecoveryPending = true;

    const response = await upload('mine', 'must-not-exist.txt', Buffer.from('no write'));

    assert.strictEqual(response.status, 409);
    assert.deepStrictEqual(await response.json(), {
      error: 'session_recovery_pending',
      message: 'This session is retained only to retry an incomplete rollback',
      retryable: true,
    });
    assert.strictEqual(validatePathCalls, 0);
    assert.strictEqual(fs.existsSync(path.join(workingDir, '.cc-web')), false);
  });

  it('refuses a session whose working directory is no longer inside the allowed base', async function () {
    allowPath = false;
    const response = await upload('mine', 'x.txt', Buffer.from('x'));
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'session_outside_base');
  });

  it('rejects every project namespace before a container path can touch host fs', async function () {
    const canary = path.join(os.tmpdir(), `cawc-attach-canary-${process.pid}-${Date.now()}`);
    fs.writeFileSync(canary, 'untouched');
    try {
      for (const sessionId of ['project-container', 'project-host']) {
        const response = await upload(sessionId, 'x.txt', Buffer.from('overwrite'));
        assert.strictEqual(response.status, 409);
        assert.strictEqual((await response.json()).error, 'unsupported_attachment_namespace');
      }
      assert.strictEqual(validatePathCalls, 0, 'host validation must not interpret a project path');
      assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'untouched');
    } finally {
      fs.rmSync(canary, { force: true });
    }
  });

  it('refuses a cross-origin write even though the cookie would ride along', async function () {
    const response = await fetch(`${baseUrl}/api/sessions/mine/chat-attachments?name=x.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://evil.example' },
      body: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1),
    });
    assert.strictEqual(
      response.status,
      403,
      'origin/session authorization runs before the route allocates or applies its body limit',
    );
    assert.strictEqual((await response.json()).error, 'cross_origin');
  });

  it('treats the URL scheme as part of the upload origin', async function () {
    const requestUrl = new URL(`${baseUrl}/api/sessions/mine/chat-attachments?name=x.txt`);
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: `https://${requestUrl.host}`,
      },
      body: Buffer.from('same host, different scheme'),
    });
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'cross_origin');
  });

  it('continues to accept an exact same-origin upload', async function () {
    const response = await fetch(`${baseUrl}/api/sessions/mine/chat-attachments?name=origin.txt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: baseUrl,
      },
      body: Buffer.from('same origin'),
    });
    assert.strictEqual(response.status, 200);
    const attachment = await response.json();
    assert.strictEqual(attachment.name, 'origin.txt');
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

  it('refuses a symlinked .cc-web instead of writing through it', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workingDir, '.cc-web'));
      const response = await upload('mine', 'escape.txt', Buffer.from('do not write'));
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await response.json()).error, 'unsafe_attachment_dir');
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('derives turn metadata from the owned URL, never a forged path or mismatched name', async function () {
    const first = await upload('mine', 'first.txt', Buffer.from('first'), 'text/plain').then((r) => r.json());
    const second = await upload('mine', 'second.txt', Buffer.from('second'), 'text/plain').then((r) => r.json());

    const resolved = await attachmentStore.resolveForTurn(
      { id: 'mine', ownerUserId: 1, workingDir },
      {
        url: first.url,
        name: 'second.txt',
        mime: 'image/png',
        size: 999999,
        path: second.path,
        storedName: path.basename(second.path),
      },
    );

    assert.strictEqual(resolved.path, first.path, 'the URL is the only stored identity');
    assert.strictEqual(resolved.name, 'first.txt');
    assert.strictEqual(resolved.mime, 'application/octet-stream');
    assert.strictEqual(resolved.size, 5);
    assert.strictEqual(fs.readFileSync(resolved.path, 'utf8'), 'first');
  });
});

describe('attachment names and types', function () {
  it('rejects a project namespace before resolving an identically named host path', async function () {
    const canary = path.join(os.tmpdir(), `cawc-turn-attach-canary-${process.pid}-${Date.now()}`);
    fs.writeFileSync(canary, 'untouched');
    try {
      const store = new AttachmentStore();
      await assert.rejects(
        () => store.resolveForTurn(
          {
            id: 'project-chat',
            ownerUserId: 1,
            workingDir: '/tmp',
            projectId: 'p1',
            projectWorkingDirKind: 'container',
          },
          {
            url: '/api/sessions/project-chat/chat-attachments/abcdef012345-canary.txt',
            name: 'canary.txt',
            mime: 'text/plain',
            size: 1,
            path: canary,
          },
        ),
        (error) => error && error.code === 'UNSUPPORTED_ATTACHMENT_NAMESPACE',
      );
      assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'untouched');
    } finally {
      fs.rmSync(canary, { force: true });
    }
  });

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

  it('accepts only an exact canonical owned attachment URL', function () {
    const good = '/api/sessions/mine/chat-attachments/abcdef012345-notes.txt';
    assert.strictEqual(storedAttachmentNameFromUrl(good, 'mine'), 'abcdef012345-notes.txt');
    for (const forged of [
      `${good}/nested`,
      `${good}?download=1`,
      '/api/sessions/other/chat-attachments/abcdef012345-notes.txt',
      '/api/sessions/mine/chat-attachments/abcdef012345-%2Fetc',
      '/api/sessions/mine/chat-attachments/not-a-stored-name',
    ]) {
      assert.strictEqual(storedAttachmentNameFromUrl(forged, 'mine'), null, forged);
    }
  });
});

describe('attachment owner and session isolation', function () {
  let workspaceRoot;

  beforeEach(function () {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-isolation-'));
  });

  afterEach(function () {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function ref(id, ownerKey, ownerUserId = 1) {
    return {
      id,
      ownerUserId,
      workingDir: path.join(workspaceRoot, 'runtime-cwd-does-not-own-storage'),
      projectId: undefined,
      projectWorkingDirKind: undefined,
      storageScope: { workspaceRoot, ownerKey },
    };
  }

  it('keeps two sessions belonging to the same owner in separate directories', async function () {
    const ids = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    const store = new AttachmentStore({ randomId: () => ids.shift() });
    const firstRef = ref('first-session', 'same-owner');
    const secondRef = ref('second-session', 'same-owner');
    const first = await store.save(firstRef, {
      filename: 'first.txt', declaredMime: 'text/plain', bytes: Buffer.from('first'),
    });
    const second = await store.save(secondRef, {
      filename: 'second.txt', declaredMime: 'text/plain', bytes: Buffer.from('second'),
    });

    assert.strictEqual(first.absolutePath.includes(`${path.sep}same-owner${path.sep}first-session${path.sep}`), true);
    assert.strictEqual(second.absolutePath.includes(`${path.sep}same-owner${path.sep}second-session${path.sep}`), true);
    await assert.rejects(
      () => store.resolveForTurn(firstRef, {
        url: `/api/sessions/first-session/chat-attachments/${second.storedName}`,
        name: 'forged.txt', mime: 'text/plain', size: 6, path: second.absolutePath,
      }),
      (error) => error && error.code === 'NOT_FOUND',
      'a valid stored name from a sibling session must not resolve',
    );
    await assert.rejects(
      () => store.openForDownload(firstRef, second.storedName),
      (error) => error && error.code === 'NOT_FOUND',
      'download must use the same owner/session namespace as turn resolution',
    );
  });

  it('keeps two owners with the same session id isolated even when stored names collide', async function () {
    const store = new AttachmentStore({ randomId: () => 'abcdef012345' });
    const firstRef = ref('same-session', 'owner-alpha', 1);
    const secondRef = ref('same-session', 'owner-beta', 2);
    const first = await store.save(firstRef, {
      filename: 'same.txt', declaredMime: 'text/plain', bytes: Buffer.from('alpha'),
    });
    const second = await store.save(secondRef, {
      filename: 'same.txt', declaredMime: 'text/plain', bytes: Buffer.from('beta'),
    });

    assert.strictEqual(first.storedName, second.storedName);
    assert.notStrictEqual(first.absolutePath, second.absolutePath);
    assert.strictEqual(fs.readFileSync((await store.resolve(firstRef, first.storedName)).absolutePath, 'utf8'), 'alpha');
    assert.strictEqual(fs.readFileSync((await store.resolve(secondRef, second.storedName)).absolutePath, 'utf8'), 'beta');
  });

  it('serves referenced flat-layout attachments without exposing them to another session', async function () {
    const storedName = 'abcdef012345-legacy.txt';
    const firstRef = ref('legacy-session', 'legacy-owner');
    const otherRef = ref('other-session', 'other-owner', 2);
    const legacyRoot = path.join(workspaceRoot, '.cc-web', 'attachments');
    const firstArtifacts = path.join(
      workspaceRoot, '.cc-web', 'sessions', 'legacy-owner', 'legacy-session',
    );
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.mkdirSync(firstArtifacts, { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, storedName), 'legacy bytes');
    fs.writeFileSync(
      path.join(firstArtifacts, 'chat.jsonl'),
      `${JSON.stringify({
        t: 'block_start',
        block: {
          kind: 'image',
          url: `/api/sessions/legacy-session/chat-attachments/${storedName}`,
        },
      })}\n`,
    );

    const store = new AttachmentStore();
    const resolved = await store.resolve(firstRef, storedName);
    assert.strictEqual(fs.readFileSync(resolved.absolutePath, 'utf8'), 'legacy bytes');
    const opened = await store.openForDownload(firstRef, storedName);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.strictEqual(Buffer.concat(chunks).toString('utf8'), 'legacy bytes');

    await assert.rejects(
      () => store.openForDownload(otherRef, storedName),
      (error) => error && error.code === 'NOT_FOUND',
      'a flat legacy filename is not authority without this session’s own durable URL',
    );
  });

  it('accounts quota within one owner/session namespace only', async function () {
    const ids = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
    const store = new AttachmentStore({ maxFiles: 1, quotaBytes: 8, randomId: () => ids.shift() });
    const firstRef = ref('quota-a', 'same-owner');
    const secondRef = ref('quota-b', 'same-owner');
    await store.save(firstRef, {
      filename: 'a.bin', declaredMime: 'application/octet-stream', bytes: Buffer.from('12345678'),
    });
    await store.save(secondRef, {
      filename: 'b.bin', declaredMime: 'application/octet-stream', bytes: Buffer.from('12345678'),
    });
    await assert.rejects(
      () => store.save(firstRef, {
        filename: 'again.bin', declaredMime: 'application/octet-stream', bytes: Buffer.from('x'),
      }),
      (error) => error && error.code === 'QUOTA_EXCEEDED',
    );
  });

  it('deletes only the exact owner/session namespace and is idempotent', async function () {
    const ids = [
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
      'cccccccccccc',
      'dddddddddddd',
    ];
    const store = new AttachmentStore({ randomId: () => ids.shift() });
    const target = ref('same-session', 'owner-alpha', 1);
    const siblingSession = ref('sibling-session', 'owner-alpha', 1);
    const siblingOwner = ref('same-session', 'owner-beta', 2);
    const targetFirst = await store.save(target, {
      filename: 'first.txt', declaredMime: 'text/plain', bytes: Buffer.from('first'),
    });
    await store.save(target, {
      filename: 'second.txt', declaredMime: 'text/plain', bytes: Buffer.from('second'),
    });
    const sessionCanary = await store.save(siblingSession, {
      filename: 'session.txt', declaredMime: 'text/plain', bytes: Buffer.from('session canary'),
    });
    const ownerCanary = await store.save(siblingOwner, {
      filename: 'owner.txt', declaredMime: 'text/plain', bytes: Buffer.from('owner canary'),
    });

    await store.deleteSessionAttachments(target);
    await store.deleteSessionAttachments(target);

    assert.strictEqual(fs.existsSync(path.dirname(targetFirst.absolutePath)), false);
    await assert.rejects(
      () => store.save(target, {
        filename: 'late.txt', declaredMime: 'text/plain', bytes: Buffer.from('must not return'),
      }),
      (error) => error && error.code === 'SESSION_DELETED',
      'an upload admitted before DELETE must not recreate the retired namespace',
    );
    assert.strictEqual(
      fs.readFileSync((await store.resolve(siblingSession, sessionCanary.storedName)).absolutePath, 'utf8'),
      'session canary',
    );
    assert.strictEqual(
      fs.readFileSync((await store.resolve(siblingOwner, ownerCanary.storedName)).absolutePath, 'utf8'),
      'owner canary',
    );
  });

  it('serializes quota accounting and writes across store instances for one session', async function () {
    let releaseFirst;
    let reportFirstScan;
    const firstScanned = new Promise((resolve) => { reportFirstScan = resolve; });
    const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStore = new AttachmentStore({
      quotaBytes: 6,
      randomId: () => 'aaaaaaaaaaaa',
      testHooks: {
        async afterUsageScanned() {
          reportFirstScan();
          await holdFirst;
        },
      },
    });
    const secondStore = new AttachmentStore({
      quotaBytes: 6,
      randomId: () => 'bbbbbbbbbbbb',
    });
    const session = ref('concurrent-quota', 'same-owner');

    const first = firstStore.save(session, {
      filename: 'first.bin', declaredMime: 'application/octet-stream', bytes: Buffer.from('1234'),
    });
    await firstScanned;

    let secondSettled = false;
    const second = secondStore.save(session, {
      filename: 'second.bin', declaredMime: 'application/octet-stream', bytes: Buffer.from('5678'),
    });
    second.then(
      () => { secondSettled = true; },
      () => { secondSettled = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.strictEqual(secondSettled, false, 'the second scan must wait for the first write/rollback');
    } finally {
      releaseFirst();
    }

    const outcomes = await Promise.all([
      first.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      second.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ]);
    assert.strictEqual(outcomes.filter((outcome) => outcome.ok).length, 1);
    const rejected = outcomes.find((outcome) => !outcome.ok);
    assert.strictEqual(rejected.error.code, 'QUOTA_EXCEEDED');

    const namespace = path.join(
      workspaceRoot, '.cc-web', 'attachments', 'same-owner', 'concurrent-quota',
    );
    const names = fs.readdirSync(namespace);
    assert.strictEqual(names.length, 1);
    assert.strictEqual(fs.statSync(path.join(namespace, names[0])).size, 4);
  });
});

describe('portable attachment directory backend', function () {
  let workspaceRoot;
  let outside;

  beforeEach(function () {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-portable-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-portable-outside-'));
  });

  afterEach(function () {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function portableRef() {
    return {
      id: 'portable-session',
      ownerUserId: 1,
      workingDir: workspaceRoot,
      projectId: undefined,
      projectWorkingDirKind: undefined,
      storageScope: { workspaceRoot, ownerKey: 'portable-owner' },
    };
  }

  it('uses proved fdescfs on macOS/BSD and never assumes it on Windows', function () {
    assert.strictEqual(resolveAttachmentDirectoryBackend('auto', 'darwin', true), 'descriptor');
    assert.strictEqual(resolveAttachmentDirectoryBackend('auto', 'freebsd', true), 'descriptor');
    assert.strictEqual(resolveAttachmentDirectoryBackend('auto', 'darwin', false), 'path');
    assert.strictEqual(resolveAttachmentDirectoryBackend('auto', 'win32', true), 'path');
    assert.strictEqual(resolveAttachmentDirectoryBackend('path', 'win32', false), 'path');
    assert.throws(
      () => resolveAttachmentDirectoryBackend('descriptor', 'win32', true),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
  });

  it('keeps reads available but refuses create/delete through an unproved path backend', async function () {
    const storedName = 'abcdef012345-portable.txt';
    const namespace = path.join(
      workspaceRoot, '.cc-web', 'attachments', 'portable-owner', 'portable-session',
    );
    fs.mkdirSync(namespace, { recursive: true });
    fs.writeFileSync(path.join(namespace, storedName), 'portable bytes');
    const store = new AttachmentStore({
      directoryBackend: 'path',
      randomId: () => 'abcdef012345',
    });
    const resolved = await store.resolve(portableRef(), storedName);
    assert.strictEqual(fs.readFileSync(resolved.absolutePath, 'utf8'), 'portable bytes');

    const opened = await store.openForDownload(portableRef(), storedName);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.strictEqual(Buffer.concat(chunks).toString('utf8'), 'portable bytes');

    await assert.rejects(
      () => store.save(portableRef(), {
        filename: 'new.txt', declaredMime: 'text/plain', bytes: Buffer.from('must not create'),
      }),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
    await assert.rejects(
      () => store.deleteSessionAttachments(portableRef()),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
    assert.strictEqual(fs.readFileSync(path.join(namespace, storedName), 'utf8'), 'portable bytes');
  });

  it('keeps path-backend writes out of a swapped or symlinked namespace', async function () {
    fs.symlinkSync(outside, path.join(workspaceRoot, '.cc-web'));
    const store = new AttachmentStore({ directoryBackend: 'path' });
    await assert.rejects(
      () => store.save(portableRef(), {
        filename: 'escape.txt', declaredMime: 'text/plain', bytes: Buffer.from('do not escape'),
      }),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  it('detects a namespace swap after portable directory handles were opened', async function () {
    fs.mkdirSync(path.join(
      workspaceRoot, '.cc-web', 'attachments', 'portable-owner', 'portable-session',
    ), { recursive: true });
    const store = new AttachmentStore({
      directoryBackend: 'path',
      randomId: () => 'abcdef012345',
      testHooks: {
        afterDirectoryOpened() {
          fs.renameSync(path.join(workspaceRoot, '.cc-web'), path.join(workspaceRoot, '.cc-web-opened'));
          fs.symlinkSync(outside, path.join(workspaceRoot, '.cc-web'));
        },
      },
    });

    await assert.rejects(
      () => store.save(portableRef(), {
        filename: 'escape.txt', declaredMime: 'text/plain', bytes: Buffer.from('do not escape'),
      }),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(
        workspaceRoot, '.cc-web-opened', 'attachments', 'portable-owner', 'portable-session',
      )),
      [],
    );
  });

  it('fails before transient swap-and-restore create or unlink syscalls', async function () {
    const namespace = path.join(
      workspaceRoot, '.cc-web', 'attachments', 'portable-owner', 'portable-session',
    );
    const storedName = 'bbbbbbbbbbbb-owned.txt';
    fs.mkdirSync(namespace, { recursive: true });
    fs.writeFileSync(path.join(namespace, storedName), 'owned-data');
    fs.writeFileSync(path.join(outside, storedName), 'external-canary');

    const parked = `${namespace}.parked`;
    const originalOpen = fs.promises.open;
    const originalRm = fs.promises.rm;
    let createSyscallReached = false;
    let unlinkSyscallReached = false;

    const transientSwap = async (operation) => {
      fs.renameSync(namespace, parked);
      fs.symlinkSync(outside, namespace, 'dir');
      try {
        return await operation();
      } finally {
        fs.unlinkSync(namespace);
        fs.renameSync(parked, namespace);
      }
    };

    fs.promises.open = async function (file, flags, ...rest) {
      if (
        path.basename(String(file)) === 'aaaaaaaaaaaa-new.txt'
        && (Number(flags) & fs.constants.O_CREAT) !== 0
      ) {
        createSyscallReached = true;
        return transientSwap(() => originalOpen.call(this, file, flags, ...rest));
      }
      return originalOpen.call(this, file, flags, ...rest);
    };
    fs.promises.rm = async function (target, ...rest) {
      if (path.basename(String(target)) === storedName) {
        unlinkSyscallReached = true;
        return transientSwap(() => originalRm.call(this, target, ...rest));
      }
      return originalRm.call(this, target, ...rest);
    };

    const store = new AttachmentStore({
      directoryBackend: 'path',
      randomId: () => 'aaaaaaaaaaaa',
    });
    try {
      await assert.rejects(
        () => store.save(portableRef(), {
          filename: 'new.txt', declaredMime: 'text/plain', bytes: Buffer.from('must not escape'),
        }),
        (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
      );
      await assert.rejects(
        () => store.deleteSessionAttachments(portableRef()),
        (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
      );
      await assert.rejects(
        () => store.save(portableRef(), {
          filename: 'retry.txt', declaredMime: 'text/plain', bytes: Buffer.from('still denied safely'),
        }),
        (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
        'a failed delete must not permanently tombstone a namespace that still exists',
      );
    } finally {
      fs.promises.open = originalOpen;
      fs.promises.rm = originalRm;
    }

    assert.strictEqual(createSyscallReached, false, 'unsafe O_CREAT must never be attempted');
    assert.strictEqual(unlinkSyscallReached, false, 'unsafe unlink must never be attempted');
    assert.strictEqual(fs.existsSync(path.join(outside, 'aaaaaaaaaaaa-new.txt')), false);
    assert.strictEqual(fs.readFileSync(path.join(outside, storedName), 'utf8'), 'external-canary');
    assert.strictEqual(fs.readFileSync(path.join(namespace, storedName), 'utf8'), 'owned-data');
  });
});

describe('attachment directory race safety', function () {
  let workingDir;
  let outside;
  let session;

  beforeEach(function () {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-race-wd-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-race-outside-'));
    session = {
      id: 'race',
      ownerUserId: 1,
      workingDir,
      projectId: undefined,
      projectWorkingDirKind: undefined,
    };
  });

  afterEach(function () {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function swapContainer() {
    const container = path.join(workingDir, '.cc-web');
    fs.renameSync(container, path.join(workingDir, '.cc-web-opened'));
    fs.symlinkSync(outside, container);
  }

  async function streamBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  it('keeps an existing attachment intact when a generated name collides', async function () {
    const store = new AttachmentStore({ randomId: () => 'abcdef012345' });
    const first = await store.save(
      session,
      { filename: 'same.txt', declaredMime: 'text/plain', bytes: Buffer.from('first') },
    );
    await assert.rejects(() => store.save(
      session,
      { filename: 'same.txt', declaredMime: 'text/plain', bytes: Buffer.from('second') },
    ));
    assert.strictEqual(fs.readFileSync(first.absolutePath, 'utf8'), 'first');
  });

  it('cannot redirect a save by swapping .cc-web after its directory fd opens', async function () {
    fs.mkdirSync(path.join(workingDir, '.cc-web', 'attachments'), { recursive: true });
    const store = new AttachmentStore({
      randomId: () => 'abcdef012345',
      testHooks: { afterDirectoryOpened: swapContainer },
    });

    await assert.rejects(
      () => store.save(session, {
        filename: 'secret.txt', declaredMime: 'text/plain', bytes: Buffer.from('must stay local'),
      }),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing is created through the new symlink');
    assert.deepStrictEqual(
      fs.readdirSync(path.join(workingDir, '.cc-web-opened', 'attachments', '1', 'race')),
      [],
      'a write completed on the bound inode is removed when no safe visible path can be returned',
    );
  });

  it('rejects a runtime path when .cc-web changes during resolution', async function () {
    const stored = await new AttachmentStore({ randomId: () => 'abcdef012345' }).save(
      session,
      { filename: 'mine.txt', declaredMime: 'text/plain', bytes: Buffer.from('mine') },
    );
    fs.mkdirSync(path.join(outside, 'attachments'));
    fs.writeFileSync(path.join(outside, 'attachments', path.basename(stored.absolutePath)), 'host secret');

    const racing = new AttachmentStore({
      testHooks: { afterDirectoryOpened: swapContainer },
    });
    await assert.rejects(
      () => racing.resolveForTurn(session, {
        url: `/api/sessions/race/chat-attachments/${path.basename(stored.absolutePath)}`,
        name: 'mine.txt', mime: 'text/plain', size: 4, path: '/etc/passwd',
      }),
      (error) => error && error.code === 'NOT_FOUND',
    );
  });

  it('streams the already-open inode when .cc-web changes during download', async function () {
    const stored = await new AttachmentStore({ randomId: () => 'abcdef012345' }).save(
      session,
      { filename: 'mine.txt', declaredMime: 'text/plain', bytes: Buffer.from('mine') },
    );
    fs.mkdirSync(path.join(outside, 'attachments'));
    fs.writeFileSync(path.join(outside, 'attachments', path.basename(stored.absolutePath)), 'host secret');

    const racing = new AttachmentStore({
      testHooks: { afterDirectoryOpened: swapContainer },
    });
    const opened = await racing.openForDownload(session, path.basename(stored.absolutePath));
    assert.strictEqual((await streamBytes(opened.stream)).toString('utf8'), 'mine');
  });
});

describe('branch attachment cloning', function () {
  let root;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-attach-branch-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ref = (id, workspaceRoot, ownerUserId = 1, ownerKey = 'stable-owner') => ({
    id,
    ownerUserId,
    workingDir: workspaceRoot,
    projectId: undefined,
    projectWorkingDirKind: undefined,
    storageScope: { workspaceRoot, ownerKey },
  });

  async function read(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  it('copies verified bytes between authorised workspaces and ignores a supplied runtime path', async function () {
    const sourceRoot = path.join(root, 'source-workspace');
    const targetRoot = path.join(root, 'target-workspace');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(targetRoot);
    const source = ref('source', sourceRoot);
    const target = ref('target', targetRoot);
    const ids = ['111111111111', '222222222222'];
    const store = new AttachmentStore({ randomId: () => ids.shift() });
    const bytes = Buffer.from('workspace-local clone');
    const original = await store.save(source, {
      filename: 'report.txt', declaredMime: 'text/plain', bytes,
    });

    const cloned = await store.cloneForBranch(source, target, {
      url: `/api/sessions/source/chat-attachments/${original.storedName}`,
      name: '../../untrusted-name.txt',
      mime: 'text/plain',
      size: 999999,
      path: '/etc/passwd',
    });

    assert.strictEqual(cloned.name, 'report.txt');
    assert.ok(cloned.url.startsWith('/api/sessions/target/chat-attachments/'));
    assert.ok(cloned.path.startsWith(targetRoot));
    const storedName = storedAttachmentNameFromUrl(cloned.url, target.id);
    const opened = await new AttachmentStore().openForDownload(target, storedName);
    assert.deepStrictEqual(await read(opened.stream), bytes);
    assert.deepStrictEqual(fs.readFileSync(original.absolutePath), bytes, 'the source was not moved');
  });

  it('rejects a same-size source mutation during the copy before creating target quota or bytes', async function () {
    const sourceRoot = path.join(root, 'source-workspace');
    const targetRoot = path.join(root, 'target-workspace');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(targetRoot);
    const source = ref('source-race', sourceRoot);
    const target = ref('target-race', targetRoot);
    const originalBytes = Buffer.alloc(256 * 1024, 0x61);
    const replacementBytes = Buffer.alloc(originalBytes.length, 0x62);
    let sourcePath = '';
    let mutated = false;
    const ids = ['111111111111', '222222222222'];
    const store = new AttachmentStore({
      randomId: () => ids.shift(),
      testHooks: {
        afterBranchCloneChunk(pass) {
          if (pass !== 'copy' || mutated) return;
          mutated = true;
          fs.writeFileSync(sourcePath, replacementBytes);
        },
      },
    });
    const original = await store.save(source, {
      filename: 'mutable.bin',
      declaredMime: 'application/octet-stream',
      bytes: originalBytes,
    });
    sourcePath = original.absolutePath;

    await assert.rejects(
      () => store.cloneForBranch(source, target, {
        url: `/api/sessions/${source.id}/chat-attachments/${original.storedName}`,
        name: original.name,
        mime: original.mime,
        size: original.bytes,
      }),
      (error) => error && error.code === 'SOURCE_ATTACHMENT_CHANGED',
    );

    assert.strictEqual(mutated, true);
    assert.deepStrictEqual(fs.readFileSync(sourcePath), replacementBytes);
    assert.strictEqual(
      fs.existsSync(path.join(
        targetRoot,
        '.cc-web',
        'attachments',
        target.storageScope.ownerKey,
        target.id,
      )),
      false,
      'source stability is proven before the target namespace is created',
    );
  });

  it('rejects cross-owner and owner-key target namespaces before creating bytes', async function () {
    const sourceRoot = path.join(root, 'source-workspace');
    const targetRoot = path.join(root, 'target-workspace');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(targetRoot);
    const source = ref('source', sourceRoot);
    const store = new AttachmentStore({ randomId: () => '111111111111' });
    const original = await store.save(source, {
      filename: 'report.txt', declaredMime: 'text/plain', bytes: Buffer.from('owned'),
    });
    const attachment = {
      url: `/api/sessions/source/chat-attachments/${original.storedName}`,
      name: original.name,
      mime: original.mime,
      size: original.bytes,
    };

    await assert.rejects(
      () => store.cloneForBranch(source, ref('foreign-user', targetRoot, 2, 'other-owner'), attachment),
      (error) => error && error.code === 'OWNER_MISMATCH',
    );
    await assert.rejects(
      () => store.cloneForBranch(source, ref('foreign-key', targetRoot, 1, 'other-owner'), attachment),
      (error) => error && error.code === 'OWNER_MISMATCH',
    );
    assert.strictEqual(
      fs.existsSync(path.join(targetRoot, '.cc-web')),
      false,
      'rejected targets are not even initialised',
    );
  });
});
