const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdateRoutes } = require('../dist/server/routes/update.js');
const { AppDatabase } = require('../dist/server/services/database.js');

function makeStatus(overrides = {}) {
  return {
    state: 'behind',
    installed: {
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      commitDate: null,
      version: '4.1.0',
      dirty: false,
      source: 'git',
    },
    remote: { sha: 'b'.repeat(40), short: 'bbbbbbb', commitDate: null, subject: 'nuovo' },
    behindBy: 3,
    checkedAt: 1,
    nextCheckAllowedAt: 2,
    message: null,
    ...overrides,
  };
}

function makeSession(id, ownerUserId, active) {
  return { id, ownerUserId, active, connections: new Set() };
}

describe('update routes', function () {
  let server;
  let baseUrl;
  let currentUser;
  let status;
  let mode;
  let applyCalls;
  let installerUserId;
  let running;

  const INSTALLER = {
    id: 1, githubId: '1', githubLogin: 'installer', githubName: null, avatarUrl: null, email: null,
  };
  const OTHER = {
    id: 2, githubId: '2', githubLogin: 'altro', githubName: null, avatarUrl: null, email: null,
  };

  beforeEach(async function () {
    status = makeStatus();
    mode = 'systemd';
    applyCalls = [];
    installerUserId = 1;
    running = false;
    currentUser = INSTALLER;

    const sessions = new Map([
      ['one', makeSession('one', 1, true)],
      ['two', makeSession('two', 2, true)],
      ['three', makeSession('three', 1, false)],
    ]);

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(
      createUpdateRoutes({
        claudeSessions: sessions,
        updateChecker: {
          getStatus: () => status,
          check: async () => status,
        },
        selfUpdate: {
          isRunning: () => running,
          getState: () => (running ? 'running' : 'idle'),
          getLogTail: () => ['npm warn /home/installer/.npm/_cacache'],
          apply: async (m, dir, sha) => {
            applyCalls.push({ mode: m, dir, sha });
          },
        },
        getUpdateMode: () => ({ mode, packageDir: '/usr/lib/node_modules/code-agents-webcli' }),
        getInstallerUserId: () => installerUserId,
        getInterruptedUpdate: () => null,
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
  });

  function post(url, body) {
    return fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  it('requires a signed-in user on every route', async function () {
    currentUser = null;
    assert.strictEqual((await fetch(`${baseUrl}/api/update/status`)).status, 401);
    assert.strictEqual((await post('/api/update/check')).status, 401);
    assert.strictEqual((await post('/api/update/apply', { confirmed: true })).status, 401);
    assert.strictEqual(applyCalls.length, 0);
  });

  it('tells the installer it can trigger an update', async function () {
    const body = await (await fetch(`${baseUrl}/api/update/status`)).json();
    assert.strictEqual(body.canTrigger, true);
    assert.strictEqual(body.isInstaller, true);
    assert.strictEqual(body.status.state, 'behind');
    // Every user's sessions, since a restart ends all of them.
    assert.strictEqual(body.activeSessions, 2);
  });

  it('shows other users the notice but not the button', async function () {
    currentUser = OTHER;
    const body = await (await fetch(`${baseUrl}/api/update/status`)).json();
    assert.strictEqual(body.canTrigger, false);
    assert.strictEqual(body.isInstaller, false);
    assert.strictEqual(body.status.state, 'behind');
  });

  it('does not leak the install log to a non-installer', async function () {
    currentUser = OTHER;
    const response = await fetch(`${baseUrl}/api/update/status`);
    const text = await response.text();
    // npm output carries absolute paths; the installer can already read them
    // via a terminal session, but nobody else should get them here.
    assert.ok(!text.includes('/home/installer'), 'the log tail must not reach other users');
    assert.deepStrictEqual(JSON.parse(text).logTail, []);
  });

  it('refuses an apply from a user who is not the installer', async function () {
    currentUser = OTHER;
    const response = await post('/api/update/apply', { confirmed: true });
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).error, 'not_installer');
    assert.strictEqual(applyCalls.length, 0);
  });

  // The button must be installer-only in every mode. Written as its own case
  // because `a && b || c` parses as `(a && b) || c`, which would hand every
  // user the button whenever the mode is foreground.
  ['systemd', 'foreground'].forEach(function (candidate) {
    it(`keeps canTrigger false for a non-installer in ${candidate} mode`, async function () {
      mode = candidate;
      currentUser = OTHER;
      const body = await (await fetch(`${baseUrl}/api/update/status`)).json();
      assert.strictEqual(body.canTrigger, false);
    });
  });

  const refusals = [
    ['ephemeral', 'ephemeral_install'],
    ['container', 'container_install'],
    ['source', 'source_install'],
    ['unwritable_prefix', 'unwritable_prefix_install'],
    ['npm_unavailable', 'npm_unavailable_install'],
  ];

  refusals.forEach(function ([candidate, error]) {
    it(`refuses to apply in ${candidate} mode`, async function () {
      mode = candidate;
      const response = await post('/api/update/apply', { confirmed: true });
      assert.strictEqual(response.status, 409);
      assert.strictEqual((await response.json()).error, error);
      assert.strictEqual(applyCalls.length, 0);
    });
  });

  it('refuses to apply when there is nothing to update', async function () {
    status = makeStatus({ state: 'up_to_date' });
    const response = await post('/api/update/apply', { confirmed: true });
    assert.strictEqual(response.status, 409);
    assert.strictEqual((await response.json()).error, 'nothing_to_update');
    assert.strictEqual(applyCalls.length, 0);
  });

  it('requires an explicit confirmation naming the sessions at risk', async function () {
    const response = await post('/api/update/apply', {});
    assert.strictEqual(response.status, 409);
    const body = await response.json();
    assert.strictEqual(body.error, 'confirmation_required');
    assert.strictEqual(body.activeSessions, 2);
    assert.strictEqual(applyCalls.length, 0);
  });

  it('starts the update once confirmed', async function () {
    const response = await post('/api/update/apply', { confirmed: true });
    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(applyCalls, [{
      mode: 'systemd',
      dir: '/usr/lib/node_modules/code-agents-webcli',
      sha: 'b'.repeat(40),
    }]);
  });

  it('refuses a second update while one is running', async function () {
    running = true;
    const response = await post('/api/update/apply', { confirmed: true });
    assert.strictEqual(response.status, 409);
    assert.strictEqual((await response.json()).error, 'update_in_progress');
    assert.strictEqual(applyCalls.length, 0);
  });

  it('refuses everything when no installer has been recorded', async function () {
    installerUserId = null;
    const response = await post('/api/update/apply', { confirmed: true });
    assert.strictEqual(response.status, 403);
    assert.strictEqual(applyCalls.length, 0);
  });
});

describe('installer identity', function () {
  let dir;
  let database;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-installer-'));
    database = new AppDatabase({ dataDir: dir });
  });

  afterEach(function () {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addUser(githubId, login) {
    return database.upsertGitHubUser({ githubId, githubLogin: login });
  }

  it('is the first account that ever signed in', function () {
    const first = addUser('1000', 'primo');
    addUser('2000', 'secondo');
    assert.strictEqual(database.getInstallerUserId(), first.id);
  });

  it('returns null before anyone has signed in', function () {
    assert.strictEqual(database.getInstallerUserId(), null);
  });

  it('does not move when the first user signs in again', function () {
    const first = addUser('1000', 'primo');
    addUser('2000', 'secondo');
    database.getInstallerUserId();
    addUser('1000', 'primo-rinominato');
    assert.strictEqual(database.getInstallerUserId(), first.id);
  });

  it('does not promote the second user when the installer is deleted', function () {
    const first = addUser('1000', 'primo');
    const second = addUser('2000', 'secondo');
    assert.strictEqual(database.getInstallerUserId(), first.id);

    database.raw.prepare('DELETE FROM users WHERE id = ?').run(first.id);

    // Pinned on first resolution: without the pin, deleting the installer
    // would silently hand the update button to whoever signed in next.
    assert.strictEqual(database.getInstallerUserId(), first.id);
    assert.notStrictEqual(database.getInstallerUserId(), second.id);
  });

  it('skips a stored account that is not allowed to sign in', function () {
    // A row left behind by a test run or a restored backup sorts ahead of the
    // real installer on id alone. Handing it the installer rights makes every
    // installer-only screen — runtime profiles, the update button — read-only
    // for everyone, forever, because nobody can ever sign in as it.
    const stray = addUser('g1', 'userA');
    const real = addUser('8649488', 'dnviti');
    database.setInstallerEligibility((githubId) => githubId === '8649488');

    const installer = database.getInstallerUserId();
    assert.strictEqual(installer, real.id);
    assert.notStrictEqual(installer, stray.id);
  });

  it('re-pins away from an installer that has lost access', function () {
    const stray = addUser('g1', 'userA');
    const real = addUser('8649488', 'dnviti');

    // Pinned while everything was still allowed, which is how an install that
    // predates the fix arrives here.
    assert.strictEqual(database.getInstallerUserId(), stray.id);

    database.setInstallerEligibility((githubId) => githubId === '8649488');
    assert.strictEqual(database.getInstallerUserId(), real.id);
    // ...and the correction is written through, not recomputed every call.
    assert.strictEqual(database.getSetting('update.installerUserId'), String(real.id));
  });

  it('still refuses to promote anyone when the pinned row is merely gone', function () {
    // A deleted row and a revoked account are different: only the second means
    // the pin can never be exercised. Deleting must keep its old behaviour.
    const first = addUser('1000', 'primo');
    const second = addUser('2000', 'secondo');
    database.setInstallerEligibility(() => true);
    assert.strictEqual(database.getInstallerUserId(), first.id);

    database.raw.prepare('DELETE FROM users WHERE id = ?').run(first.id);
    assert.strictEqual(database.getInstallerUserId(), first.id);
    assert.notStrictEqual(database.getInstallerUserId(), second.id);
  });

  it('has no installer when nobody stored may sign in', function () {
    addUser('g1', 'userA');
    database.setInstallerEligibility(() => false);
    assert.strictEqual(database.getInstallerUserId(), null);
  });

  it('behaves exactly as before with no eligibility wired', function () {
    // The hook is optional: every other consumer of AppDatabase (tests, the
    // session store) constructs it bare and must keep the original answer.
    const first = addUser('1000', 'primo');
    addUser('2000', 'secondo');
    assert.strictEqual(database.getInstallerUserId(), first.id);
  });
});
