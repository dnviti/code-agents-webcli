const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGitIdentityRoutes } = require('../dist/server/routes/git-identity.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { ProjectStore } = require('../dist/server/services/projects/store.js');

const KEY = Buffer.alloc(32, 6).toString('base64');
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-git-identity-routes-')); }
function listen(app) { return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })); }); }
function request(baseUrl, method, url, body, headers = {}) { return fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); }

describe('git identity routes', function () {
  let dir; let database; let store; let owner; let other; let project; let serverInfo;
  beforeEach(function () {
    dir = root(); database = new AppDatabase({ dataDir: dir });
    store = new ProjectStore({ database, keyRing: new EncryptionKeyRing({ settings: database, key: KEY, warn: () => {} }) });
    owner = database.upsertGitHubUser({ githubId: '1234', githubLogin: 'owner', githubName: 'Owner Name', email: null });
    other = database.upsertGitHubUser({ githubId: '5678', githubLogin: 'other', email: 'other@example.test' });
    project = store.createProject({ ownerUserId: owner.id, name: 'owned' });
  });
  afterEach(async function () { if (serverInfo) { serverInfo.server.closeAllConnections?.(); await serverInfo.close(); serverInfo = null; } database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start(user) {
    const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.authContext = { user, authSessionId: null }; next(); });
    app.use(createGitIdentityRoutes({ projectStore: store })); serverInfo = await listen(app); return serverInfo.baseUrl;
  }

  it('returns the GitHub no-reply provider default and only resolution data', async function () {
    const baseUrl = await start(owner);
    const response = await request(baseUrl, 'GET', '/api/git-identity');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { identity: { name: 'Owner Name', email: '1234+owner@users.noreply.github.com' }, source: 'provider' });
  });

  it('writes a global override and resolves it beneath a project override', async function () {
    const baseUrl = await start(owner);
    const global = await request(baseUrl, 'PUT', '/api/git-identity', { name: 'Global', email: 'global@example.test' });
    assert.deepStrictEqual(await global.json(), { identity: { name: 'Global', email: 'global@example.test' }, source: 'global' });
    const inherited = await request(baseUrl, 'GET', `/api/projects/${project.id}/git-identity`);
    assert.deepStrictEqual(await inherited.json(), { identity: { name: 'Global', email: 'global@example.test' }, source: 'global' });
    const local = await request(baseUrl, 'PUT', `/api/projects/${project.id}/git-identity`, { name: 'Project', email: 'project@example.test' });
    assert.deepStrictEqual(await local.json(), { identity: { name: 'Project', email: 'project@example.test' }, source: 'project' });
  });

  it('enforces same-origin writes, validates values, and does not reveal another user project', async function () {
    const baseUrl = await start(owner);
    assert.strictEqual((await request(baseUrl, 'PUT', '/api/git-identity', { name: 'X', email: 'x@example.test' }, { Origin: 'https://evil.test' })).status, 403);
    assert.strictEqual((await request(baseUrl, 'PUT', '/api/git-identity', { name: 'Bad\nName', email: 'x@example.test' })).status, 400);
    assert.strictEqual((await request(baseUrl, 'PUT', '/api/git-identity', { name: 'Good', email: 'not-an-email' })).status, 400);
    serverInfo.server.closeAllConnections?.(); await serverInfo.close(); serverInfo = null;
    const otherUrl = await start(other);
    const hidden = await request(otherUrl, 'GET', `/api/projects/${project.id}/git-identity`);
    assert.strictEqual(hidden.status, 404);
  });
});
