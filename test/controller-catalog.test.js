'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ControllerCatalog,
  LOCAL_TARGET,
  canonicalOrigin,
  sanitizeOfflineMetadataCache,
  sanitizeServerIdentity,
} = require('../desktop/controller/catalog.js');

describe('desktop controller catalog', function () {
  let directory;
  let filename;
  let nextId;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-controller-catalog-'));
    filename = path.join(directory, 'private', 'controllers.json');
    nextId = 0;
  });
  afterEach(function () { fs.rmSync(directory, { recursive: true, force: true }); });
  function catalog() {
    return new ControllerCatalog({ filename, randomUUID: () => `remote-${++nextId}`, now: () => '2026-08-04T10:00:00.000Z' });
  }

  it('always exposes an immutable local target and persists remote targets across restart', function () {
    const first = catalog();
    assert.deepStrictEqual(first.list(), [LOCAL_TARGET]);
    assert.ok(Object.isFrozen(first.list()[0]));
    assert.throws(() => first.rename('local', 'Elsewhere'), /permanent and immutable/);
    assert.throws(() => first.remove('local'), /permanent and immutable/);
    const added = first.add({ name: '  Work Controller  ', address: 'https://EXAMPLE.com:443/' });
    assert.deepStrictEqual(added, { id: 'remote-1', type: 'remote', name: 'Work Controller', origin: 'https://example.com', status: 'disconnected', error: null });
    const second = catalog();
    assert.deepStrictEqual(second.list(), [LOCAL_TARGET, added]);
  });

  it('writes private, atomic JSON and falls back safely for corrupt or invalid schemas', function () {
    const target = catalog().add({ name: 'One', address: 'https://one.example' });
    assert.strictEqual(fs.statSync(filename).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).targets[0].id, target.id);
    fs.writeFileSync(filename, '{');
    assert.deepStrictEqual(catalog().list(), [LOCAL_TARGET]);
    fs.writeFileSync(filename, JSON.stringify({ version: 999, targets: [] }));
    assert.deepStrictEqual(catalog().list(), [LOCAL_TARGET]);
  });

  it('canonicalizes only bare HTTPS origins and rejects normalized duplicates', function () {
    assert.strictEqual(canonicalOrigin('https://BÜCHER.example:443/'), 'https://xn--bcher-kva.example');
    assert.strictEqual(canonicalOrigin('https://example.com:32352/'), 'https://example.com:32352');
    for (const invalid of ['http://example.com', 'https://user@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'https://example.com/#x']) {
      assert.throws(() => canonicalOrigin(invalid), /HTTPS origin/);
    }
    const instance = catalog();
    instance.add({ name: 'Alpha', address: 'https://EXAMPLE.com/' });
    assert.throws(() => instance.add({ name: ' alpha ', address: 'https://other.example' }), /names must be unique/);
    assert.throws(() => instance.add({ name: 'Other', address: 'https://example.com:443' }), /origin already exists/);
  });

  it('treats an address change as a fresh destination while retaining the friendly name', function () {
    const instance = catalog();
    const target = instance.add({ name: 'Office', address: 'https://old.example' });
    instance.setAuthMarker(target.id);
    instance.setCertificateOverride(target.id, 'sha256:old');
    instance.setOfflineMetadata(target.id, [{ id: 's1', runtime: 'running' }]);
    instance.recordSuccessfulContact(target.id, '2026-01-01T00:00:00.000Z');
    const updated = instance.editAddress(target.id, 'https://new.example/');
    assert.deepStrictEqual(updated, { id: target.id, type: 'remote', name: 'Office', origin: 'https://new.example', status: 'disconnected', error: null });
    assert.throws(() => instance.setCertificateOverride('local', 'nope'), /permanent and immutable/);
  });

  it('keeps status, errors, exact-origin trust and contact state per server', function () {
    const instance = catalog();
    const target = instance.add({ name: 'Office', address: 'https://office.example' });
    instance.setStatus(target.id, 'failed', { code: 'CERT_CHANGED', message: 'Certificate fingerprint changed', secret: 'never persisted' });
    instance.setCertificateOverride(target.id, 'sha256:abc');
    const connected = instance.recordSuccessfulContact(target.id);
    assert.deepStrictEqual(connected.error, null);
    assert.strictEqual(connected.status, 'connected');
    assert.strictEqual(connected.lastSuccessfulContact, '2026-08-04T10:00:00.000Z');
    assert.deepStrictEqual(connected.certificateOverride, { origin: 'https://office.example', fingerprint: 'sha256:abc' });
  });

  it('persists only a verified minimal identity for the exact origin', function () {
    const instance = catalog();
    const target = instance.add({ name: 'Office', address: 'https://office.example:32352' });
    const identity = {
      product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
      version: '6.1.0',
      protocolVersion: 1,
      capabilities: ['remote-controller', 'lan-discovery', 'remote-controller'],
      serverName: 'Office build host',
      address: 'https://office.example:32352',
      users: ['must not persist'],
      credentials: { token: 'must not persist' },
    };
    const updated = instance.setIdentity(target.id, identity);
    assert.deepStrictEqual(updated.identity, {
      product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
      version: '6.1.0',
      protocolVersion: 1,
      capabilities: ['remote-controller', 'lan-discovery'],
      serverName: 'Office build host',
      address: 'https://office.example:32352',
    });
    assert.deepStrictEqual(catalog().get(target.id).identity, updated.identity);
    assert.strictEqual(sanitizeServerIdentity({ ...identity, address: 'https://other.example' }, target.origin), null);
    assert.throws(() => instance.setIdentity(target.id, { ...identity, address: 'https://other.example' }), /exact server origin/);
  });

  it('structurally sanitizes offline metadata without product-count limits, and sign-out clears it', function () {
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      id: `session-${index}`, name: 'Session', server: { id: 'remote-1', origin: 'https://office.example', token: 'secret' }, runtime: 'codex', status: 'ready', active: index === 0, lastActivity: 'today', transcript: 'do not retain', output: 'do not retain', files: ['/secret'], credentials: { cookie: 'no' }, nested: { nope: true },
    }));
    const clean = sanitizeOfflineMetadataCache({ sessions, password: 'no' });
    assert.strictEqual(clean.sessions.length, 120);
    assert.deepStrictEqual(clean.sessions[0], {
      id: 'session-0', name: 'Session', runtime: 'codex', status: 'active', lastActivity: 'today',
    });
    const instance = catalog();
    const target = instance.add({ name: 'Office', address: 'https://office.example' });
    instance.setAuthMarker(target.id);
    instance.setOfflineMetadata(target.id, { sessions });
    const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.strictEqual(
      Object.hasOwn(persisted.targets[0], 'offlineMetadataCache'),
      false,
      'session metadata must remain memory-only and never enter servers.json',
    );
    assert.strictEqual(catalog().get(target.id).offlineMetadataCache, undefined);
    assert.strictEqual(instance.removalWarning(target.id), true);
    const result = instance.remove(target.id);
    assert.strictEqual(result.warning, true);
    assert.strictEqual(result.removed, true);
    const another = instance.add({ name: 'Other', address: 'https://other.example' });
    instance.setAuthMarker(another.id);
    instance.setOfflineMetadata(another.id, [{ id: 'active-session', runtime: 'codex', status: 'active' }]);
    assert.strictEqual(instance.remove(another.id).warning, true);
    const signedOutTarget = instance.add({ name: 'Signed out', address: 'https://signed-out.example' });
    instance.setAuthMarker(signedOutTarget.id);
    instance.setOfflineMetadata(signedOutTarget.id, sessions);
    const signedOut = instance.signOut(signedOutTarget.id);
    assert.ok(!Object.hasOwn(signedOut, 'authMarker'));
    assert.ok(!Object.hasOwn(signedOut, 'offlineMetadataCache'));
  });

  it('removes a legacy persisted session cache without losing target configuration', function () {
    const first = catalog();
    const target = first.add({ name: 'Legacy cache', address: 'https://legacy.example' });
    first.setAuthMarker(target.id);
    const legacy = JSON.parse(fs.readFileSync(filename, 'utf8'));
    legacy.targets[0].offlineMetadataCache = {
      sessions: [{
        id: 'private-session-id',
        name: 'Private title',
        runtime: 'codex',
        lastActivity: '2026-08-05T12:00:00.000Z',
      }],
    };
    fs.writeFileSync(filename, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const restarted = catalog();
    assert.strictEqual(restarted.get(target.id).offlineMetadataCache, undefined);
    assert.strictEqual(restarted.get(target.id).authMarker, true);
    assert.strictEqual(restarted.get(target.id).origin, 'https://legacy.example');
    const cleaned = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.strictEqual(Object.hasOwn(cleaned.targets[0], 'offlineMetadataCache'), false);
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /private-session-id|Private title/);
  });
});
