const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  normalizeUserPreferences,
  resolveApprovalMode,
} = require('../dist/shared/user-preferences.js');
const { UserPreferenceStore } = require('../dist/server/services/user-preferences.js');
const { createPreferenceRoutes } = require('../dist/server/routes/preferences.js');
const { AppDatabase } = require('../dist/server/services/database.js');

// The approval preference, and the rule it feeds (#134).
//
// Two things are being pinned here and they are different in kind. The rule is
// pure and every branch of it is a decision about whether shell commands run
// unattended, so it is asserted exhaustively. The store and the route are the
// answer to "the preference holds for the same user on a second device and in a
// second browser": that is a persistence fact, not a rendering one — a second
// browser is a second GET of a row this process did not write — so it is proved
// here rather than by driving two pages.

describe('the approval rule', function () {
  it('gives a conversation that is beginning the preference', function () {
    assert.strictEqual(resolveApprovalMode({ beginning: true, preference: true }), true);
    assert.strictEqual(resolveApprovalMode({ beginning: true, preference: false }), false);
  });

  it('ignores the preference for a conversation that is continuing', function () {
    // Both directions. A preference switched on afterwards must not widen a
    // conversation that chose to ask, and one switched off must not narrow a
    // conversation that is running without prompts — the process was started
    // with the flag on its command line and cannot be told otherwise.
    assert.strictEqual(
      resolveApprovalMode({ beginning: false, granted: false, preference: true }),
      false,
    );
    assert.strictEqual(
      resolveApprovalMode({ beginning: false, granted: true, preference: false }),
      true,
    );
  });

  it('never inherits a grant into a conversation that is beginning', function () {
    // The trap the rule is shaped to avoid: keyed on the record instead of the
    // route, "start a new chat" would replay the bypass of the conversation it
    // had just abandoned, whatever the preference had since been set to.
    assert.strictEqual(
      resolveApprovalMode({ beginning: true, granted: true, preference: false }),
      false,
    );
  });

  it('lets an explicit narrowing win over everything', function () {
    assert.strictEqual(
      resolveApprovalMode({ beginning: true, preference: true, explicit: false }),
      false,
    );
    assert.strictEqual(
      resolveApprovalMode({ beginning: false, granted: true, explicit: false }),
      false,
    );
  });

  it('asks whenever the answer is missing or unreadable', function () {
    assert.strictEqual(resolveApprovalMode({ beginning: true }), false);
    assert.strictEqual(resolveApprovalMode({ beginning: false }), false);
    assert.strictEqual(resolveApprovalMode({ beginning: false, granted: undefined }), false);
  });

  it('reads only a literal true as a grant', function () {
    // Whatever a hand-edited row or a hand-written request body contains.
    for (const value of ['true', 1, 'yes', {}, [], null]) {
      assert.strictEqual(
        normalizeUserPreferences({ chatBypassPermissions: value }).chatBypassPermissions,
        false,
        `${JSON.stringify(value)} must not read as a standing permission`,
      );
    }
    assert.strictEqual(
      normalizeUserPreferences({ chatBypassPermissions: true }).chatBypassPermissions,
      true,
    );
    assert.strictEqual(normalizeUserPreferences(null).chatBypassPermissions, false);
    assert.strictEqual(normalizeUserPreferences('nonsense').chatBypassPermissions, false);
  });
});

describe('where the approval preference lives', function () {
  let dataDir;
  let database;
  let store;
  let alice;
  let bob;

  beforeEach(function () {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-prefs-'));
    database = new AppDatabase({ dataDir });
    store = new UserPreferenceStore({ database });
    alice = database.upsertGitHubUser({
      githubId: '2001', githubLogin: 'alice', githubName: 'Alice', email: 'a@example.com',
    });
    bob = database.upsertGitHubUser({
      githubId: '2002', githubLogin: 'bob', githubName: 'Bob', email: 'b@example.com',
    });
  });

  afterEach(function () {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads as “ask” for a user who has never chosen', function () {
    assert.strictEqual(store.get(alice.id).chatBypassPermissions, false);
  });

  it('holds the choice for the same user in a second browser', function () {
    // A second browser is a second process reading the same row, which is what
    // this reopens: nothing about the preference is cached in the page.
    store.set(alice.id, { chatBypassPermissions: true });
    database.close();

    const reopened = new AppDatabase({ dataDir });
    try {
      const second = new UserPreferenceStore({ database: reopened });
      assert.strictEqual(second.get(alice.id).chatBypassPermissions, true);
    } finally {
      reopened.close();
      database = new AppDatabase({ dataDir });
    }
  });

  it('keeps one user’s permission away from another’s', function () {
    store.set(alice.id, { chatBypassPermissions: true });
    assert.strictEqual(store.get(bob.id).chatBypassPermissions, false);
  });

  it('reads an unreadable row as “ask” rather than throwing', function () {
    // The launch path calls this synchronously. A row somebody hand-edited must
    // not be able to fail a launch — nor to grant one anything.
    database.setUserSetting(alice.id, 'preferences', '{not json');
    assert.strictEqual(store.get(alice.id).chatBypassPermissions, false);
  });

  it('applies a change immediately, because /clear reads it later', function () {
    store.set(alice.id, { chatBypassPermissions: true });
    assert.strictEqual(store.get(alice.id).chatBypassPermissions, true);
    store.set(alice.id, { chatBypassPermissions: false });
    assert.strictEqual(
      store.get(alice.id).chatBypassPermissions,
      false,
      'a cached grant would restart a cleared conversation in the mode it just left',
    );
  });
});

describe('the preferences route', function () {
  let dataDir;
  let database;
  let server;
  let base;
  let signedInAs;

  beforeEach(async function () {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-prefs-route-'));
    database = new AppDatabase({ dataDir });
    const alice = database.upsertGitHubUser({
      githubId: '3001', githubLogin: 'alice', githubName: 'Alice', email: 'a@example.com',
    });
    const bob = database.upsertGitHubUser({
      githubId: '3002', githubLogin: 'bob', githubName: 'Bob', email: 'b@example.com',
    });
    signedInAs = alice;

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: signedInAs, authSessionId: 'a' };
      next();
    });
    app.use(createPreferenceRoutes({
      userPreferences: new UserPreferenceStore({ database }),
    }));

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    server.users = { alice, bob };
  });

  afterEach(async function () {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const put = (body) =>
    fetch(`${base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('stores and hands back what was actually kept', async function () {
    const response = await put({ preferences: { chatBypassPermissions: true } });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).preferences.chatBypassPermissions, true);

    const read = await fetch(`${base}/api/preferences`);
    assert.strictEqual((await read.json()).preferences.chatBypassPermissions, true);
  });

  it('normalises before storing, so the dialog reflects the real answer', async function () {
    const response = await put({ preferences: { chatBypassPermissions: 'yes' } });
    assert.strictEqual((await response.json()).preferences.chatBypassPermissions, false);
  });

  it('writes for the signed-in user and nobody named in the body', async function () {
    // There is no id to send, and a body that invents one changes nothing.
    await put({ userId: server.users.bob.id, preferences: { chatBypassPermissions: true } });
    signedInAs = server.users.bob;
    const read = await fetch(`${base}/api/preferences`);
    assert.strictEqual(
      (await read.json()).preferences.chatBypassPermissions,
      false,
      'one account must not be able to grant another a standing permission',
    );
  });

  it('refuses a cross-origin write', async function () {
    // The auth cookie is SameSite=Lax, which is site-scoped rather than
    // origin-scoped, and this endpoint decides whether shell commands run
    // without asking.
    const response = await fetch(`${base}/api/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ preferences: { chatBypassPermissions: true } }),
    });
    assert.strictEqual(response.status, 403);
  });

  it('refuses both verbs to a caller who is not signed in', async function () {
    signedInAs = null;
    assert.strictEqual((await fetch(`${base}/api/preferences`)).status, 401);
    assert.strictEqual((await put({ preferences: {} })).status, 401);
  });
});
