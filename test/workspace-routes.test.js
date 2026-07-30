const assert = require('assert');
const { execFileSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createWorkspaceRoutes } = require('../dist/server/routes/workspace.js');

// Driven against a real git repository in a temp directory. The parsers have
// their own unit tests; what these prove is the part that cannot be faked —
// that the routes are wired to the right commands, run them in the session's
// own directory, and refuse a path outside it.

let repo;
let server;
let base;
let sessions;
/**
 * The two account inputs the status route takes, swapped per test.
 *
 * Held here rather than passed per-request because the app is built once in
 * `before`; the route reads them through the closures below on every call.
 */
let cachedClaudeAccount = null;
let burnResult = null;
let burnCalls = [];

const USER = { id: 7, githubId: '1', githubLogin: 'tester', githubName: null, avatarUrl: null, email: null };

function git(...args) {
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sessionRecord(over = {}) {
  return {
    id: 'session-1',
    ownerUserId: 7,
    name: 'Session',
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: repo,
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
    ...over,
  };
}

async function get(url) {
  const response = await fetch(`${base}${url}`);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

before(function () {
  this.timeout(30000);

  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-route-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(repo, 'kept.txt'), 'one\ntwo\nthree\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');

  // One modified, one untracked, so both diff paths are exercised.
  fs.writeFileSync(path.join(repo, 'kept.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(repo, 'fresh.txt'), 'brand new\n');

  sessions = new Map([['session-1', sessionRecord()]]);

  const app = express();
  // The real server installs this before its routes; the PUT handler reads a
  // JSON body and without it every write arrives as `undefined`.
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: USER, authSessionId: 'a' };
    next();
  });
  app.use(
    createWorkspaceRoutes({
      claudeSessions: sessions,
      // The server's own base-folder check. The base here is the temp
      // directory, which is what these fixtures live under — the real server
      // uses the user's home or the folder-mode root.
      validatePath: (target) => {
        const base = fs.realpathSync(os.tmpdir());
        const resolved = path.resolve(target);
        const ok = resolved === base || resolved.startsWith(base + path.sep);
        return ok ? { valid: true, path: resolved } : { valid: false, error: 'outside' };
      },
      readCachedClaudeAccount: () => cachedClaudeAccount,
      usageBurn: (userId, agent, hours) => {
        burnCalls.push({ userId, agent, hours });
        return burnResult;
      },
    }),
  );

  server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(function () {
  if (server) server.close();
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('workspace routes', function () {
  this.timeout(20000);

  /**
   * Issue #137. What this route must NOT answer with is as much of the point as
   * what it does: it used to serve a plan name that was a CLI flag's default, a
   * token/cost/message allowance out of a table written into this repository,
   * and a "session stats" figure scanned from every Claude Code transcript on
   * the host.
   */
  describe('status', function () {
    beforeEach(function () {
      cachedClaudeAccount = null;
      burnResult = null;
      burnCalls = [];
      sessions.get('session-1').agent = null;
      sessions.get('session-1').lastAgent = null;
    });

    it('serves no plan, no limits table and no predictions', async function () {
      const { status, body } = await get('/api/workspace/session-1/status');
      assert.strictEqual(status, 200);
      assert.ok(!('plan' in body), JSON.stringify(body));
      const serialised = JSON.stringify(body);
      for (const invented of ['max20', '220000', '188026', 'minutesToDepletion', 'sessionStats']) {
        assert.ok(!serialised.includes(invented), `${invented} is still being served`);
      }
    });

    it('names what the runtime will report, per runtime', async function () {
      sessions.get('session-1').agent = 'kimi';
      const kimi = (await get('/api/workspace/session-1/status')).body;
      assert.strictEqual(kimi.account.runtime, 'kimi');
      assert.match(kimi.account.reporting, /reports nothing about an account/i);

      sessions.get('session-1').agent = 'claude';
      const claude = (await get('/api/workspace/session-1/status')).body;
      assert.match(claude.account.reporting, /never states a token, message or dollar allowance/i);
      assert.notStrictEqual(claude.account.reporting, kimi.account.reporting);
    });

    it('offers the CLI cache for claude only', async function () {
      cachedClaudeAccount = {
        planName: 'claude max 20x',
        windows: [{ kind: 'five_hour', utilization: 0.46, resetsAt: '2026-07-29T16:00:00.000Z' }],
        asOf: '2026-07-29T09:00:00.000Z',
      };

      sessions.get('session-1').agent = 'claude';
      const claude = (await get('/api/workspace/session-1/status')).body;
      assert.strictEqual(claude.account.cached.planName, 'claude max 20x');

      // Codex has its own account and its own protocol channel; handing it
      // Claude's numbers is exactly the confusion this issue is about.
      sessions.get('session-1').agent = 'codex';
      const codex = (await get('/api/workspace/session-1/status')).body;
      assert.strictEqual(codex.account.cached, null);
    });

    it('measures burn for the signed-in user on this agent alone', async function () {
      sessions.get('session-1').agent = 'codex';
      burnResult = { from: 'a', to: 'b', hours: 24, totals: { turns: 3 } };
      const body = (await get('/api/workspace/session-1/status')).body;

      assert.deepStrictEqual(burnCalls, [{ userId: 7, agent: 'codex', hours: 24 }]);
      assert.strictEqual(body.account.measured.totals.turns, 3);
    });

    it('reports nothing measured rather than zero when no store is wired', async function () {
      sessions.get('session-1').agent = 'claude';
      burnResult = null;
      const body = (await get('/api/workspace/session-1/status')).body;
      assert.strictEqual(body.account.measured, null);
    });

    it('still answers for a session that has never run anything', async function () {
      const body = (await get('/api/workspace/session-1/status')).body;
      assert.strictEqual(body.account.runtime, null);
      assert.ok(body.account.reporting.length > 0);
      assert.strictEqual(body.account.cached, null);
    });
  });

  describe('raw', function () {
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    async function raw(url, options) {
      const response = await fetch(`${base}${url}`, options);
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, body };
    }

    before(function () {
      fs.writeFileSync(path.join(repo, 'shot.png'), PNG);
      fs.writeFileSync(path.join(repo, 'notes.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]));
      fs.writeFileSync(path.join(repo, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
      // The attack: markup wearing an image's name.
      fs.writeFileSync(path.join(repo, 'evil.png'), '<script>alert(1)</script>');
      fs.writeFileSync(path.join(repo, 'clip.mp4'), Buffer.concat([
        Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(48),
      ]));
    });

    // Removed before the later suites run: the directory listing test asserts
    // an exact set of entries, and fixtures left behind here fail a suite that
    // has nothing to do with them.
    after(function () {
      for (const name of ['shot.png', 'notes.pdf', 'logo.svg', 'evil.png', 'clip.mp4']) {
        fs.rmSync(path.join(repo, name), { force: true });
      }
    });

    it('serves an image under the type its own bytes say', async function () {
      const { status, headers, body } = await raw('/api/workspace/session-1/raw?path=shot.png');
      assert.strictEqual(status, 200);
      assert.strictEqual(headers.get('content-type'), 'image/png');
      assert.strictEqual(headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(headers.get('accept-ranges'), 'bytes');
      assert.deepStrictEqual(body, PNG);
    });

    it('serves a video and a PDF inline so the browser can play or render them', async function () {
      const video = await raw('/api/workspace/session-1/raw?path=clip.mp4');
      assert.strictEqual(video.headers.get('content-type'), 'video/mp4');
      assert.strictEqual(video.headers.get('content-disposition'), null, 'inline, not a download');

      const pdf = await raw('/api/workspace/session-1/raw?path=notes.pdf');
      assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    });

    it('never serves markup under the image type its name claims', async function () {
      // Left as image/png this is harmless; served as text/html from this
      // origin it is a stored XSS with a file tree in front of it.
      const { headers } = await raw('/api/workspace/session-1/raw?path=evil.png');
      assert.strictEqual(headers.get('content-type'), 'application/octet-stream');
      assert.match(headers.get('content-disposition'), /^attachment/);
    });

    it('sandboxes an SVG, which is the one image that is also a document', async function () {
      const { headers } = await raw('/api/workspace/session-1/raw?path=logo.svg');
      assert.strictEqual(headers.get('content-type'), 'image/svg+xml');
      assert.match(headers.get('content-security-policy'), /sandbox/);
      assert.match(headers.get('content-security-policy'), /default-src 'none'/);
    });

    it('answers a range request, which is how a video is seeked', async function () {
      const { status, headers, body } = await raw('/api/workspace/session-1/raw?path=kept.txt', {
        headers: { Range: 'bytes=0-2' },
      });
      // Safari will not begin playback at all without this.
      assert.strictEqual(status, 206);
      assert.strictEqual(headers.get('content-range'), 'bytes 0-2/14');
      assert.strictEqual(body.toString(), 'one');
    });

    it('answers a suffix range, which is how a container index is read', async function () {
      const { status, body } = await raw('/api/workspace/session-1/raw?path=kept.txt', {
        headers: { Range: 'bytes=-6' },
      });
      assert.strictEqual(status, 206);
      assert.strictEqual(body.toString(), 'three\n');
    });

    it('refuses a range past the end rather than inventing one', async function () {
      const { status, headers } = await raw('/api/workspace/session-1/raw?path=kept.txt', {
        headers: { Range: 'bytes=9999-' },
      });
      assert.strictEqual(status, 416);
      assert.strictEqual(headers.get('content-range'), 'bytes */14');
    });

    it('ignores a malformed range instead of failing the request', async function () {
      const { status } = await raw('/api/workspace/session-1/raw?path=kept.txt', {
        headers: { Range: 'rows=1-2' },
      });
      assert.strictEqual(status, 200, 'a header nothing here produces must not break playback');
    });

    it('refuses a path outside the session directory', async function () {
      const { status } = await raw('/api/workspace/session-1/raw?path=../../etc/passwd');
      assert.strictEqual(status, 403);
    });

    it('refuses to stream out of .git', async function () {
      const { status } = await raw('/api/workspace/session-1/raw?path=.git/config');
      assert.strictEqual(status, 403);
    });

    it('answers 404 for a file that is not there, and for a session it does not own', async function () {
      assert.strictEqual((await raw('/api/workspace/session-1/raw?path=nope.png')).status, 404);
      assert.strictEqual((await raw('/api/workspace/nope/raw?path=shot.png')).status, 404);
    });
  });

  describe('find', function () {
    it('finds a file anywhere in the tree, ranked by name', async function () {
      const { status, body } = await get('/api/workspace/session-1/find?q=app');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.matches[0], 'src/app.ts', 'the file named app comes first');
      assert.strictEqual(body.source, 'git', 'a repository is indexed by git, not by walking it');
    });

    it('offers the whole tree for an empty query, so the picker opens on something', async function () {
      const { body } = await get('/api/workspace/session-1/find?q=');
      assert.ok(body.matches.includes('kept.txt'));
      assert.ok(body.matches.includes('src/app.ts'));
    });

    it('includes an untracked file, because that is a file you can still point at', async function () {
      const { body } = await get('/api/workspace/session-1/find?q=fresh&refresh=1');
      assert.deepStrictEqual(body.matches, ['fresh.txt']);
    });

    it('leaves out what git is told to ignore', async function () {
      fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
      fs.writeFileSync(path.join(repo, 'ignored.txt'), 'noise\n');

      const { body } = await get('/api/workspace/session-1/find?q=ignored&refresh=1');
      assert.ok(!body.matches.includes('ignored.txt'), 'an ignored file is noise in a picker');
      fs.rmSync(path.join(repo, 'ignored.txt'));
      fs.rmSync(path.join(repo, '.gitignore'));
    });

    it('leaves this app\u2019s own attachment folder out of the picker', async function () {
      const dir = path.join(repo, '.cc-web', 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'abc123456789-screenshot.png'), 'x');

      const { body } = await get('/api/workspace/session-1/find?q=screenshot&refresh=1');
      assert.deepStrictEqual(body.matches, [], 'the files you attached are not files you meant to point at');

      fs.rmSync(path.join(repo, '.cc-web'), { recursive: true, force: true });
    });

    it('answers with nothing rather than everything when there is no match', async function () {
      const { body } = await get('/api/workspace/session-1/find?q=zzzznope&refresh=1');
      assert.deepStrictEqual(body.matches, []);
    });

    it('honours a limit and clamps an absurd one', async function () {
      const { body } = await get('/api/workspace/session-1/find?q=&limit=1&refresh=1');
      assert.strictEqual(body.matches.length, 1);

      const huge = await get('/api/workspace/session-1/find?q=&limit=99999&refresh=1');
      assert.ok(huge.body.matches.length <= 100, 'a client cannot ask for an unbounded page');
    });

    it('refuses a session it does not own', async function () {
      const { status } = await get('/api/workspace/nope/find?q=a');
      assert.strictEqual(status, 404);
    });
  });

  describe('files', function () {
    it('lists the session’s working directory', async function () {
      const { status, body } = await get('/api/workspace/session-1/files');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.root, repo);
      const names = body.entries.map((e) => e.name).sort();
      assert.deepStrictEqual(names, ['.git', 'fresh.txt', 'kept.txt', 'src']);
      assert.strictEqual(body.entries.find((e) => e.name === 'src').isDirectory, true);
      assert.ok(body.entries.find((e) => e.name === 'kept.txt').size > 0);
    });

    it('lists a subdirectory by absolute path', async function () {
      const { body } = await get(
        `/api/workspace/session-1/files?path=${encodeURIComponent(path.join(repo, 'src'))}`,
      );
      assert.deepStrictEqual(body.entries.map((e) => e.name), ['app.ts']);
    });

    it('refuses to walk out of the session directory', async function () {
      // The check that matters: this request is well-formed and arrives from a
      // browser, and without confinement it is a directory listing of the host.
      const escape = await get('/api/workspace/session-1/files?path=..%2F..%2F..');
      assert.strictEqual(escape.status, 403);

      const absolute = await get('/api/workspace/session-1/files?path=%2Fetc');
      assert.strictEqual(absolute.status, 403);
    });

    it('answers 404 for a session the caller does not own', async function () {
      sessions.set('other', sessionRecord({ id: 'other', ownerUserId: 99 }));
      const { status } = await get('/api/workspace/other/files');
      assert.strictEqual(status, 404);
      sessions.delete('other');
    });
  });

  describe('git', function () {
    it('reports the branch and what changed in the working tree', async function () {
      const { body } = await get('/api/workspace/session-1/git');
      assert.strictEqual(body.repo, true);
      assert.strictEqual(body.branch, 'main');

      const byPath = Object.fromEntries(body.changes.map((c) => [c.path, c]));
      assert.strictEqual(byPath['kept.txt'].kind, 'update');
      assert.strictEqual(byPath['kept.txt'].unstaged, true);
      assert.strictEqual(byPath['fresh.txt'].untracked, true);
      assert.ok(body.head && body.head.subject === 'first');
    });

    it('reports paths relative to the session, not to the repository root', async function () {
      // `git status --porcelain` reports repo-root-relative paths whatever
      // directory it ran in — verified against git, not assumed. A session
      // opened in a subdirectory therefore got a list of paths that resolved to
      // `<dir>/<repo-relative-path>`: files that do not exist.
      sessions.set('sub', sessionRecord({ id: 'sub', workingDir: path.join(repo, 'src') }));
      try {
        const { body } = await get('/api/workspace/sub/git');
        assert.strictEqual(body.repo, true);

        const paths = body.changes.map((c) => c.path);
        // Scoped to the subdirectory: nothing from the repository root.
        assert.ok(!paths.includes('kept.txt'), `leaked a file outside the session: ${paths.join(', ')}`);

        fs.writeFileSync(path.join(repo, 'src', 'nested.ts'), 'export const b = 2;\n');
        try {
          const after = await get('/api/workspace/sub/git');
          const nested = after.body.changes.find((c) => c.path.endsWith('nested.ts'));
          assert.ok(nested, 'the subdirectory change should be listed');
          assert.strictEqual(nested.path, 'nested.ts', 'the path must be relative to the session');

          // And it must be openable at the path that was reported.
          const opened = await get(
            `/api/workspace/sub/file?path=${encodeURIComponent(nested.path)}`,
          );
          assert.strictEqual(opened.status, 200);
          assert.strictEqual(opened.body.content, 'export const b = 2;\n');
        } finally {
          fs.rmSync(path.join(repo, 'src', 'nested.ts'), { force: true });
        }
      } finally {
        sessions.delete('sub');
      }
    });

    it('says plainly when the folder is not a repository', async function () {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-plain-'));
      sessions.set('plain', sessionRecord({ id: 'plain', workingDir: plain }));
      try {
        const { body } = await get('/api/workspace/plain/git');
        assert.strictEqual(body.repo, false);
        assert.ok(/not a git repository/i.test(body.reason));
      } finally {
        sessions.delete('plain');
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });

    it('returns a parsed diff for a modified file', async function () {
      const { body } = await get('/api/workspace/session-1/git/diff?path=kept.txt');
      assert.strictEqual(body.diffs.length, 1);
      assert.strictEqual(body.diffs[0].path, 'kept.txt');
      assert.strictEqual(body.diffs[0].added, 1);
      assert.strictEqual(body.diffs[0].removed, 1);
    });

    it('shows an untracked file as an addition rather than an empty diff', async function () {
      // git has never heard of the file, so `git diff` says nothing about it —
      // which would leave the panel listing a change it could not show.
      const { body } = await get('/api/workspace/session-1/git/diff?path=fresh.txt');
      assert.strictEqual(body.diffs.length, 1);
      assert.strictEqual(body.diffs[0].kind, 'create');
      assert.strictEqual(body.diffs[0].path, 'fresh.txt');
      assert.strictEqual(body.diffs[0].added, 1);
    });

    it('serves the staged diff separately from the unstaged one', async function () {
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2;\n');
      git('add', 'src/app.ts');
      try {
        const staged = await get('/api/workspace/session-1/git/diff?path=src%2Fapp.ts&staged=1');
        assert.strictEqual(staged.body.diffs.length, 1);

        const unstaged = await get('/api/workspace/session-1/git/diff?path=src%2Fapp.ts');
        assert.deepStrictEqual(unstaged.body.diffs, []);
      } finally {
        git('reset', '-q', 'HEAD', 'src/app.ts');
        fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
      }
    });

    it('refuses a diff for a path outside the session directory', async function () {
      const { status } = await get('/api/workspace/session-1/git/diff?path=..%2F..%2Fetc%2Fpasswd');
      assert.strictEqual(status, 403);
    });

    it('treats a filename that looks like a flag as a filename', async function () {
      // `--` before the pathspec is what makes this a path and not an option.
      const odd = path.join(repo, '--cached');
      fs.writeFileSync(odd, 'x\n');
      try {
        const { status, body } = await get('/api/workspace/session-1/git/diff?path=--cached');
        assert.strictEqual(status, 200);
        assert.ok(Array.isArray(body.diffs));
      } finally {
        fs.rmSync(odd, { force: true });
      }
    });
  });

  describe('file', function () {
    async function put(body) {
      const response = await fetch(`${base}/api/workspace/session-1/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }

    it('returns a text file with its language and its version', async function () {
      const { status, body } = await get('/api/workspace/session-1/file?path=src%2Fapp.ts');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.content, 'export const a = 1;\n');
      assert.strictEqual(body.language, 'ts');
      assert.strictEqual(body.relativePath, 'src/app.ts');
      assert.strictEqual(body.binary, false);
      assert.strictEqual(body.writable, true);
      assert.ok(typeof body.mtimeMs === 'number' && body.mtimeMs > 0);
    });

    it('says a file is binary rather than handing back replacement characters', async function () {
      // Round-tripping invalid UTF-8 through a textarea rewrites it as U+FFFD,
      // which would corrupt the file the moment anyone pressed Save.
      fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]));
      try {
        const { body } = await get('/api/workspace/session-1/file?path=blob.bin');
        assert.strictEqual(body.binary, true);
        assert.strictEqual(body.content, '');
        assert.strictEqual(body.writable, false);
        assert.ok(/not text/i.test(body.reason));
      } finally {
        fs.rmSync(path.join(repo, 'blob.bin'), { force: true });
      }
    });

    it('refuses a directory as a file', async function () {
      const { status } = await get('/api/workspace/session-1/file?path=src');
      assert.strictEqual(status, 400);
    });

    it('refuses to read outside the session directory', async function () {
      const escape = await get('/api/workspace/session-1/file?path=..%2F..%2F..%2Fetc%2Fpasswd');
      assert.strictEqual(escape.status, 403);
      const absolute = await get('/api/workspace/session-1/file?path=%2Fetc%2Fpasswd');
      assert.strictEqual(absolute.status, 403);
    });

    it('refuses to follow a symlink out of the session directory', async function () {
      // The check a lexical path test cannot make: the path resolves cleanly
      // inside the tree and still reads somewhere else entirely. An agent's
      // working tree is exactly the sort of place a symlink turns up.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not leak me\n');
      const link = path.join(repo, 'escape');
      fs.symlinkSync(outside, link);
      try {
        const read = await get('/api/workspace/session-1/file?path=escape%2Fsecret.txt');
        assert.strictEqual(read.status, 403);

        const listed = await get('/api/workspace/session-1/files?path=escape');
        assert.strictEqual(listed.status, 403);

        const written = await put({ path: 'escape/secret.txt', content: 'overwritten' });
        assert.strictEqual(written.status, 403);
        assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'do not leak me\n');
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('writes a file back and reports its new version', async function () {
      const opened = await get('/api/workspace/session-1/file?path=kept.txt');
      const { status, body } = await put({
        path: 'kept.txt',
        content: 'one\nTWO\nthree\nfour\n',
        mtimeMs: opened.body.mtimeMs,
      });

      assert.strictEqual(status, 200);
      assert.strictEqual(body.saved, true);
      assert.strictEqual(fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n');
      assert.ok(body.mtimeMs >= opened.body.mtimeMs);
    });

    it('refuses a save whose base version is stale', async function () {
      // The case that actually happens: the agent edits the file while the
      // browser has it open, and a blind write would erase work never seen.
      const opened = await get('/api/workspace/session-1/file?path=kept.txt');
      fs.writeFileSync(path.join(repo, 'kept.txt'), 'the agent got here first\n');

      const { status, body } = await put({
        path: 'kept.txt',
        content: 'my stale copy\n',
        mtimeMs: opened.body.mtimeMs - 5000,
      });

      assert.strictEqual(status, 409);
      assert.ok(/changed on disk/i.test(body.error));
      assert.strictEqual(fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8'), 'the agent got here first\n');
    });

    it('will not create a file that does not exist', async function () {
      const { status } = await put({ path: 'invented.txt', content: 'x' });
      assert.strictEqual(status, 404);
      assert.strictEqual(fs.existsSync(path.join(repo, 'invented.txt')), false);
    });

    it('will not write inside .git', async function () {
      const before = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
      const { status } = await put({ path: '.git/config', content: '[core]\n' });
      assert.strictEqual(status, 403);
      assert.strictEqual(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), before);
    });

    it('still refuses .git when the session directory is itself a symlink', async function () {
      // The guard compares the resolved target against the session root, so the
      // root has to be resolved too. /tmp on macOS and a home behind a network
      // mount are both symlinks in practice, and an unresolved root turns the
      // comparison into a relative path full of `..` that matches nothing —
      // the refusal fails open and a browser can rewrite .git/config.
      const link = path.join(os.tmpdir(), `workspace-link-${process.pid}`);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(repo, link);
      sessions.set('linked', sessionRecord({ id: 'linked', workingDir: link }));
      try {
        const before = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
        const response = await fetch(`${base}/api/workspace/linked/file`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '.git/config', content: '[core]\n' }),
        });
        assert.strictEqual(response.status, 403);
        assert.strictEqual(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), before);

        // And an ordinary file under the same symlinked root still opens.
        const opened = await fetch(
          `${base}/api/workspace/linked/file?path=${encodeURIComponent('src/app.ts')}`,
        );
        assert.strictEqual(opened.status, 200);
        const body = await opened.json();
        assert.strictEqual(body.relativePath, 'src/app.ts');
      } finally {
        sessions.delete('linked');
        fs.rmSync(link, { force: true });
      }
    });

    it('rejects a request with no contents rather than emptying the file', async function () {
      const { status } = await put({ path: 'kept.txt' });
      assert.strictEqual(status, 400);
      assert.ok(fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8').length > 0);
    });

    it('does not let a filename that looks like an option destroy another file', async function () {
      // Verified against git: without `--`, `git diff --no-index` parses an
      // untracked file called `--output=victim` as the --output option and
      // truncates victim. Reachable from a plain GET, by expanding that row.
      const hostile = path.join(repo, '--output=kept.txt');
      fs.writeFileSync(hostile, 'x\n');
      const before = fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8');
      assert.ok(before.length > 0);
      try {
        const { status } = await get(
          `/api/workspace/session-1/git/diff?path=${encodeURIComponent('--output=kept.txt')}`,
        );
        assert.strictEqual(status, 200);
        assert.strictEqual(
          fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8'),
          before,
          'a read must never truncate another file',
        );
      } finally {
        fs.rmSync(hostile, { force: true });
      }
    });

    it('refuses a FIFO rather than blocking a thread on it forever', async function () {
      // A read on a writer-less FIFO never returns and holds one of libuv's
      // four threadpool slots for the life of the process. Four of those and
      // every filesystem operation on the server stops.
      const fifo = path.join(repo, 'pipe');
      try {
        execFileSync('mkfifo', [fifo]);
      } catch {
        this.skip();
        return;
      }
      try {
        const { status, body } = await Promise.race([
          get('/api/workspace/session-1/file?path=pipe'),
          new Promise((resolve) => setTimeout(() => resolve({ status: 'HUNG', body: null }), 4000)),
        ]);
        assert.strictEqual(status, 400);
        assert.ok(/regular file/i.test(body.error));
      } finally {
        fs.rmSync(fifo, { force: true });
      }
    });

    it('refuses to write text over a binary file, whatever the client believes', async function () {
      const png = path.join(repo, 'logo.png');
      fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
      try {
        const stat = fs.statSync(png);
        const { status } = await put({ path: 'logo.png', content: 'not a png', mtimeMs: stat.mtimeMs });
        assert.strictEqual(status, 400);
        assert.strictEqual(fs.statSync(png).size, 7);
      } finally {
        fs.rmSync(png, { force: true });
      }
    });

    it('requires the base version, so a save can never silently clobber', async function () {
      // Left optional, a caller that simply omitted the field turned off the
      // only thing standing between the agent's work and a blind overwrite.
      const { status } = await put({ path: 'kept.txt', content: 'no version given\n' });
      assert.strictEqual(status, 400);
      assert.notStrictEqual(fs.readFileSync(path.join(repo, 'kept.txt'), 'utf8'), 'no version given\n');
    });

    it('refuses a write into a nested repository’s .git as well as the top one', async function () {
      const nested = path.join(repo, 'vendor', 'lib', '.git');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'config'), 'original\n');
      try {
        const stat = fs.statSync(path.join(nested, 'config'));
        const { status } = await put({
          path: 'vendor/lib/.git/config',
          content: 'rewritten\n',
          mtimeMs: stat.mtimeMs,
        });
        assert.strictEqual(status, 403);
        assert.strictEqual(fs.readFileSync(path.join(nested, 'config'), 'utf8'), 'original\n');
      } finally {
        fs.rmSync(path.join(repo, 'vendor'), { recursive: true, force: true });
      }
    });

    it('refuses a session whose working directory is outside the allowed base', async function () {
      // A session record outlives the configuration that admitted it: the base
      // folder can be narrowed between runs and the record is restored anyway.
      const outside = fs.mkdtempSync(path.join(os.homedir(), '.workspace-outside-'));
      sessions.set('stale', sessionRecord({ id: 'stale', workingDir: outside }));
      try {
        const { status } = await get('/api/workspace/stale/files');
        assert.strictEqual(status, 403);
      } finally {
        sessions.delete('stale');
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('offers an oversized file read-only instead of opening it', async function () {
      const big = path.join(repo, 'huge.txt');
      fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 10));
      try {
        const { body } = await get('/api/workspace/session-1/file?path=huge.txt');
        assert.strictEqual(body.tooLarge, true);
        assert.strictEqual(body.writable, false);
        assert.strictEqual(body.content, '');
        assert.ok(/past the/i.test(body.reason));
      } finally {
        fs.rmSync(big, { force: true });
      }
    });
  });

  describe('github', function () {
    it('reports which of the three reasons it cannot answer', async function () {
      const { status, body } = await get('/api/workspace/session-1/github');
      assert.strictEqual(status, 200);
      assert.strictEqual(typeof body.available, 'boolean');
      if (!body.available) {
        // An empty list and "gh is not installed" look identical to a user, so
        // the route has to say which it is.
        assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
        assert.ok(/gh|GitHub/i.test(body.reason));
      } else {
        assert.ok(Array.isArray(body.prs));
        assert.ok(Array.isArray(body.issues));
      }
    });
  });

  /**
   * The same routes against a `gh` this test wrote.
   *
   * The parser has its own unit tests; what needs a route is the half that
   * cannot be checked without one — that the commands are asked for the fields
   * the panel now draws, that a reference into another repository is carried
   * through to `-R`, and that the second call behind the reader is allowed to
   * fail without taking the issue with it. Every answer below is real `gh`
   * output for this repository, replayed by a script on PATH.
   */
  describe('github, with a gh that answers', function () {
    let shimDir;
    let originalPath;

    const ISSUE = {
      assignees: [{ login: 'dnviti', name: 'Daniele Viti' }],
      author: { login: 'dnviti', is_bot: false, name: 'Daniele Viti' },
      blockedBy: { nodes: [], totalCount: 0 },
      closedByPullRequestsReferences: [
        { number: 151, url: 'https://github.com/dnviti/code-agents-webcli/pull/151', repository: { name: 'code-agents-webcli', owner: { login: 'dnviti' } } },
      ],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      milestone: { number: 1, title: '6.0.0' },
      number: 134,
      parent: { number: 100, title: 'The epic', state: 'OPEN', url: 'https://github.com/dnviti/code-agents-webcli/issues/100', repository: { nameWithOwner: 'dnviti/code-agents-webcli' } },
      state: 'OPEN',
      subIssuesSummary: { completed: 1, percentCompleted: 50, total: 2 },
      title: 'Approval mode is not applied consistently',
      updatedAt: '2026-07-30T19:36:42Z',
      url: 'https://github.com/dnviti/code-agents-webcli/issues/134',
    };

    const PULL = {
      assignees: [{ login: 'dnviti', name: 'Daniele Viti' }],
      author: { login: 'dnviti', is_bot: false },
      baseRefName: 'main',
      closingIssuesReferences: [
        { number: 134, url: 'https://github.com/dnviti/code-agents-webcli/issues/134', repository: { name: 'code-agents-webcli', owner: { login: 'dnviti' } } },
      ],
      headRefName: 'fix/approval',
      isDraft: false,
      number: 151,
      reviewDecision: 'APPROVED',
      state: 'OPEN',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'Verify Node 22' }],
      title: 'fix: approval mode',
      url: 'https://github.com/dnviti/code-agents-webcli/pull/151',
    };

    const TIMELINE = {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: 'Issue',
            timelineItems: {
              nodes: [
                {
                  willCloseTarget: false,
                  source: {
                    __typename: 'PullRequest', number: 149, title: 'chore: release branch',
                    url: 'https://github.com/dnviti/code-agents-webcli/pull/149', state: 'MERGED',
                    isDraft: false, repository: { nameWithOwner: 'dnviti/code-agents-webcli' },
                  },
                },
              ],
            },
          },
        },
      },
    };

    /** Every argv the route handed `gh`, in order. */
    function calls() {
      const log = path.join(shimDir, 'calls.log');
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    }

    before(function () {
      shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
      const shim = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(shimDir, 'calls.log'))}, JSON.stringify(args) + '\\n');
const say = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === '--version') { process.stdout.write('gh version 2.96.0\\n'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'repo') say({ nameWithOwner: 'dnviti/code-agents-webcli', url: 'https://github.com/dnviti/code-agents-webcli' });
if (args[0] === 'api') {
  if (process.env.GH_SHIM_NO_GRAPHQL === '1') { process.stderr.write('no scope\\n'); process.exit(1); }
  say(${JSON.stringify(TIMELINE)});
}
const fields = args[args.indexOf('--json') + 1] || '';
if (args[1] === 'list') {
  // A gh too old for the sub-issue fields refuses the whole command.
  if (process.env.GH_SHIM_OLD === '1' && /subIssuesSummary|statusCheckRollup/.test(fields)) {
    process.stderr.write('Unknown JSON field: "subIssuesSummary"\\n');
    process.exit(1);
  }
  if (process.env.GH_SHIM_LIST_FAIL === '1') {
    process.stderr.write('could not reach github.com\\n');
    process.exit(1);
  }
}
if (args[0] === 'issue') say(args[1] === 'list' ? [${JSON.stringify(ISSUE)}] : ${JSON.stringify(ISSUE)});
if (args[0] === 'pr') say(args[1] === 'list' ? [${JSON.stringify(PULL)}] : ${JSON.stringify(PULL)});
process.exit(1);
`;
      fs.writeFileSync(path.join(shimDir, 'gh'), shim, { mode: 0o755 });
      originalPath = process.env.PATH;
      process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
    });

    after(function () {
      process.env.PATH = originalPath;
      for (const key of ['GH_SHIM_NO_GRAPHQL', 'GH_SHIM_OLD', 'GH_SHIM_LIST_FAIL']) delete process.env[key];
      fs.rmSync(shimDir, { recursive: true, force: true });
    });

    beforeEach(function () {
      fs.rmSync(path.join(shimDir, 'calls.log'), { force: true });
      for (const key of ['GH_SHIM_NO_GRAPHQL', 'GH_SHIM_OLD', 'GH_SHIM_LIST_FAIL']) delete process.env[key];
    });

    it('asks for the fields the panel draws, and hands them over', async function () {
      // `refresh=1`: the overview is cached for half a minute, and the test
      // above has already filled that cache with a `gh` that did not exist.
      const { status, body } = await get('/api/workspace/session-1/github?refresh=1');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.available, true, JSON.stringify(body));

      const issueList = calls().find((argv) => argv[0] === 'issue' && argv[1] === 'list');
      const prList = calls().find((argv) => argv[0] === 'pr' && argv[1] === 'list');
      for (const field of ['assignees', 'parent', 'subIssuesSummary', 'closedByPullRequestsReferences', 'blockedBy']) {
        assert.ok(issueList.join(' ').includes(field), `issue list never asked for ${field}`);
      }
      for (const field of ['assignees', 'closingIssuesReferences', 'reviewDecision', 'statusCheckRollup']) {
        assert.ok(prList.join(' ').includes(field), `pr list never asked for ${field}`);
      }

      const issue = body.issues[0];
      assert.deepStrictEqual(issue.assignees, [{ login: 'dnviti', name: 'Daniele Viti' }]);
      assert.strictEqual(issue.parent.number, 100);
      assert.strictEqual(issue.childrenTotal, 2);
      assert.strictEqual(issue.childrenDone, 1);
      assert.deepStrictEqual(issue.references.map((one) => [one.kind, one.number]), [['pr', 151]]);

      const pull = body.prs[0];
      assert.deepStrictEqual(pull.assignees, [{ login: 'dnviti', name: 'Daniele Viti' }]);
      assert.strictEqual(pull.reviewDecision, 'APPROVED');
      assert.deepStrictEqual(pull.checks, { total: 1, passed: 1, failed: 0, pending: 0, state: 'passing' });
      assert.deepStrictEqual(pull.references.map((one) => [one.kind, one.number, one.relation]), [['issue', 134, 'closes']]);

      // The node ids and repository objects `gh` wraps all of this in are of no
      // use to a browser and are most of the bytes.
      assert.ok(!JSON.stringify(body).includes('databaseId'));
    });

    it('reads one issue with its timeline beside it', async function () {
      const { status, body } = await get('/api/workspace/session-1/github/issue/134');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.item.kind, 'issue');
      assert.strictEqual(body.item.parent.number, 100);
      assert.deepStrictEqual(
        body.item.references.map((one) => [one.number, one.relation]),
        [[149, 'mentions'], [151, 'closed-by']],
      );
      assert.ok(calls().some((argv) => argv[0] === 'api' && argv[1] === 'graphql'));
    });

    it('still reads the issue when the timeline cannot be had', async function () {
      // `gh api` needs a token scope `gh issue view` does not, and half an
      // answer here is still a whole issue on screen.
      process.env.GH_SHIM_NO_GRAPHQL = '1';
      const { status, body } = await get('/api/workspace/session-1/github/issue/134');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.item.references.map((one) => one.number), [151]);
    });

    it('reads a reference that points into another repository from there', async function () {
      const { status } = await get('/api/workspace/session-1/github/issue/5?repo=other%2Fproject');
      assert.strictEqual(status, 200);
      const view = calls().find((argv) => argv[0] === 'issue' && argv[1] === 'view');
      assert.ok(view.includes('-R') && view.includes('other/project'), view.join(' '));
      const api = calls().find((argv) => argv[0] === 'api');
      assert.ok(api.includes('owner=other') && api.includes('name=project'), api.join(' '));
    });

    it('falls back to the older fields when gh does not know the new ones', async function () {
      // gh refuses the whole command over one field it has never heard of, and
      // half of these arrived in 2.94. A server on an older one must still get
      // its list, minus the facts that list cannot carry.
      process.env.GH_SHIM_OLD = '1';
      const { body } = await get('/api/workspace/session-1/github?refresh=1');
      assert.strictEqual(body.available, true, JSON.stringify(body));
      assert.strictEqual(body.issues.length, 1);
      assert.ok(!body.issuesError, JSON.stringify(body.issuesError));
      assert.deepStrictEqual(body.issues[0].assignees, [{ login: 'dnviti', name: 'Daniele Viti' }]);
      // Asked twice: the full list first, then the one it can answer.
      const asked = calls().filter((argv) => argv[0] === 'issue' && argv[1] === 'list');
      assert.strictEqual(asked.length, 2);
      assert.ok(!asked[1].join(' ').includes('subIssuesSummary'));
    });

    it('says a list could not be read rather than that nothing is open', async function () {
      process.env.GH_SHIM_LIST_FAIL = '1';
      const { body } = await get('/api/workspace/session-1/github?refresh=1');
      assert.strictEqual(body.available, true);
      assert.deepStrictEqual(body.issues, []);
      assert.match(body.issuesError, /github\.com/);
      assert.match(body.prsError, /github\.com/);

      // And the failure is not pinned for the half-minute the good answer gets:
      // a rate limit or a dropped network clears on its own, and the refresh
      // control has to be able to find that out.
      delete process.env.GH_SHIM_LIST_FAIL;
      const again = await get('/api/workspace/session-1/github');
      assert.strictEqual(again.body.issues.length, 1);
      assert.ok(!again.body.issuesError);
    });

    it('does not let a repository named after a number become one', async function () {
      // `gh api -F` reads its value as JSON, so `-F name=2048` is the number
      // 2048 against a String! variable, and the whole timeline is lost.
      const { status } = await get('/api/workspace/session-1/github/issue/5?repo=gabrielecirulli%2F2048');
      assert.strictEqual(status, 200);
      const api = calls().find((argv) => argv[0] === 'api');
      assert.ok(api.includes('-f') && api.includes('name=2048'), api.join(' '));
      assert.ok(!api.includes('-F') || api.indexOf('-F') === api.indexOf('number=5') - 1, api.join(' '));
    });

    it('refuses a repository name that is not one', async function () {
      // Silently reading this repository's #5 instead would look like success.
      for (const bad of ['--json', 'not a repo', 'owner/name/extra', '../../etc']) {
        const { status } = await get(`/api/workspace/session-1/github/issue/5?repo=${encodeURIComponent(bad)}`);
        assert.strictEqual(status, 400, `${bad} was accepted`);
      }
      assert.deepStrictEqual(calls(), [], 'gh was run for a repository that is not one');
    });
  });
});

describe('uploading a file into the project', function () {
  this.timeout(20000);

  async function upload(name, bytes, query = '') {
    const search = new URLSearchParams({ dir: 'src', name });
    const response = await fetch(`${base}/api/workspace/session-1/upload?${search}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('writes the bytes it was given, where it was told', async function () {
    const got = await upload('logo.bin', Buffer.from([1, 2, 3, 4]));

    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.name, 'logo.bin');
    assert.deepStrictEqual(
      Array.from(fs.readFileSync(path.join(repo, 'src', 'logo.bin'))),
      [1, 2, 3, 4],
      'the file must arrive byte for byte, not as text',
    );
  });

  it('refuses to replace a file unless asked', async function () {
    // The one outcome here that cannot be undone, so it is never the default.
    const got = await upload('logo.bin', Buffer.from([9]));
    assert.strictEqual(got.status, 409);
    assert.deepStrictEqual(
      Array.from(fs.readFileSync(path.join(repo, 'src', 'logo.bin'))),
      [1, 2, 3, 4],
      'the original must still be there',
    );
  });

  it('replaces it when asked', async function () {
    const got = await upload('logo.bin', Buffer.from([9]), '&overwrite=1');
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(Array.from(fs.readFileSync(path.join(repo, 'src', 'logo.bin'))), [9]);
  });

  it('treats the filename as a name, never as a path', async function () {
    // A browser can send this, and joining it onto a folder that passed its own
    // check would walk straight back out of the session directory.
    const got = await upload('../../escaped.txt', Buffer.from('nope'));

    assert.strictEqual(got.status, 200, 'the name is stripped, not the request refused');
    assert.strictEqual(got.body.name, 'escaped.txt');
    assert.ok(fs.existsSync(path.join(repo, 'src', 'escaped.txt')), 'it lands in the named folder');
    assert.ok(!fs.existsSync(path.join(repo, '..', 'escaped.txt')), 'and nowhere else');
  });

  it('refuses a folder outside the session directory', async function () {
    const search = new URLSearchParams({ dir: '../..', name: 'x.txt' });
    const response = await fetch(`${base}/api/workspace/session-1/upload?${search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.strictEqual(response.status, 403);
  });

  it('refuses to write into .git', async function () {
    const search = new URLSearchParams({ dir: '.git', name: 'HEAD' });
    const response = await fetch(`${base}/api/workspace/session-1/upload?${search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('ref: refs/heads/evil\n'),
    });
    assert.strictEqual(response.status, 403);
    assert.ok(
      fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').includes('main'),
      'the repository must be untouched',
    );
  });

  it('refuses an empty upload rather than creating an empty file', async function () {
    const got = await upload('nothing.txt', Buffer.alloc(0));
    assert.strictEqual(got.status, 400);
    assert.ok(!fs.existsSync(path.join(repo, 'src', 'nothing.txt')));
  });

  it('refuses a target that is a file rather than a folder', async function () {
    const search = new URLSearchParams({ dir: 'kept.txt', name: 'x.txt' });
    const response = await fetch(`${base}/api/workspace/session-1/upload?${search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.strictEqual(response.status, 400);
  });

  it('refuses a session it does not own', async function () {
    sessions.set('other', sessionRecord({ id: 'other', ownerUserId: 99 }));
    const search = new URLSearchParams({ dir: '.', name: 'x.txt' });
    const response = await fetch(`${base}/api/workspace/other/upload?${search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    assert.strictEqual(response.status, 404);
    sessions.delete('other');
  });
});

describe('serving a page and its parts for a preview', function () {
  this.timeout(20000);

  before(function () {
    fs.mkdirSync(path.join(repo, 'site', 'css'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'site', 'index.html'), '<!doctype html><p>hello</p>');
    fs.writeFileSync(path.join(repo, 'site', 'css', 'style.css'), 'p { color: red }');
    fs.writeFileSync(path.join(repo, 'site', 'app.js'), 'console.log(1)');
  });

  after(function () {
    fs.rmSync(path.join(repo, 'site'), { recursive: true, force: true });
  });

  async function asset(suffix) {
    const response = await fetch(`${base}/api/workspace/session-1/asset/${suffix}`);
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      csp: response.headers.get('content-security-policy'),
      nosniff: response.headers.get('x-content-type-options'),
      body: await response.text(),
    };
  }

  it('serves a stylesheet as a stylesheet, so a preview is not unstyled', async function () {
    // The sniffing route cannot do this: CSS has no recognisable header, so it
    // comes back as an opaque download and `nosniff` makes the browser refuse
    // it. This is the reason the route exists separately.
    const got = await asset('site/css/style.css');
    assert.strictEqual(got.status, 200);
    assert.match(got.type, /^text\/css/);
    assert.strictEqual(got.body, 'p { color: red }');
  });

  it('serves a script as a script', async function () {
    const got = await asset('site/app.js');
    assert.match(got.type, /javascript/);
  });

  it('sandboxes the page itself, so it cannot use this app’s origin', async function () {
    // Without this, opening the URL in a top-level tab would run a project's
    // own HTML on our origin, with our cookies.
    const got = await asset('site/index.html');
    assert.strictEqual(got.status, 200);
    assert.match(got.type, /^text\/html/);
    assert.ok(got.csp.includes('sandbox'), `expected a sandbox, got ${got.csp}`);
    assert.ok(!got.csp.includes('allow-same-origin'), 'that would undo the sandbox');
    assert.strictEqual(got.nosniff, 'nosniff');
  });

  it('nests folders, which is the whole point of a path-shaped url', async function () {
    // `./css/style.css` from `site/index.html` has to resolve, and it only can
    // if the folder is a real folder to the browser.
    assert.strictEqual((await asset('site/css/style.css')).status, 200);
  });

  it('refuses to walk out of the session directory', async function () {
    // Percent-encoded, because that is the form that actually arrives: a URL
    // parser collapses a literal `../` before the request is ever sent, so the
    // plain version never reaches the check being tested here (it 404s at the
    // router instead, which is refused either way).
    assert.strictEqual((await asset('..%2f..%2f..%2fetc%2fpasswd')).status, 403);
    assert.ok([403, 404].includes((await asset('../../../etc/passwd')).status));
  });

  it('refuses to serve out of .git', async function () {
    assert.strictEqual((await asset('.git/HEAD')).status, 403);
  });

  it('answers 404 for a file that is not there, and for a folder', async function () {
    assert.strictEqual((await asset('site/missing.css')).status, 404);
    assert.strictEqual((await asset('site')).status, 404);
  });

  it('refuses a session it does not own', async function () {
    sessions.set('other2', sessionRecord({ id: 'other2', ownerUserId: 99 }));
    const response = await fetch(`${base}/api/workspace/other2/asset/site/index.html`);
    assert.strictEqual(response.status, 404);
    sessions.delete('other2');
  });

  it('does not let an unknown extension pass as text', async function () {
    // Anything off the allowlist falls back to sniffing, and an unrecognisable
    // file is an opaque download — the same answer /raw gives.
    fs.writeFileSync(path.join(repo, 'site', 'thing.weird'), '<script>alert(1)</script>');
    const got = await asset('site/thing.weird');
    assert.match(got.type, /octet-stream/);
  });
});
