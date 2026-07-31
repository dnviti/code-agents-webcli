const assert = require('assert');

const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');

/** app_settings without the database: the ring only reads and writes strings. */
function fakeSettings() {
  const map = new Map();
  return {
    map,
    getSetting: (key) => (map.has(key) ? map.get(key) : null),
    setSetting: (key, value) => { map.set(key, value); },
  };
}

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const KEY_A_HEX = Buffer.alloc(32, 1).toString('hex');

function decodeEnvelope(envelope) {
  return JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
}

describe('encryption key ring', function () {
  it('round-trips a string through an envelope', function () {
    const ring = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    const envelope = ring.encrypt('a kubeconfig worth protecting');
    assert.notStrictEqual(envelope.includes('kubeconfig'), true);
    assert.strictEqual(ring.decrypt(envelope), 'a kubeconfig worth protecting');
  });

  it('writes a versioned envelope that names its key', function () {
    const ring = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    const envelope = decodeEnvelope(ring.encrypt('secret'));
    assert.strictEqual(envelope.v, 1);
    assert.strictEqual(envelope.kid, ring.activeKeyId());
    assert.ok(envelope.iv);
    assert.ok(envelope.tag);
    assert.ok(envelope.data);
  });

  it('accepts the key as base64 or as 64 hex characters', function () {
    const fromBase64 = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    const fromHex = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A_HEX });
    assert.strictEqual(fromHex.activeKeyId(), fromBase64.activeKeyId());
    assert.strictEqual(fromHex.decrypt(fromBase64.encrypt('same key')), 'same key');
  });

  it('never derives a key id from the key material itself', function () {
    // The id rides in every envelope next to the ciphertext; a slice of the
    // key would hand out key material one ciphertext at a time.
    const ring = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    assert.strictEqual(KEY_A.startsWith(ring.activeKeyId()), false);
    assert.strictEqual(
      Buffer.from(KEY_A, 'base64').toString('base64url').startsWith(ring.activeKeyId()),
      false,
    );
  });

  it('refuses to decrypt under the wrong key', function () {
    // Same kid, wrong material: GCM authentication fails loudly.
    const ringA = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A, kid: 'k1' });
    const ringB = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_B, kid: 'k1' });
    const envelope = ringA.encrypt('not for you');
    assert.throws(() => ringB.decrypt(envelope), /decrypt failed/);

    // A key the ring has never seen and the settings do not hold: also loud.
    const ringC = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_B });
    const foreign = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    assert.throws(() => ringC.decrypt(foreign.encrypt('nor for you')), /not found in settings/);
  });

  it('keeps a supplied key out of the settings entirely', function () {
    // Production passes the key through the environment precisely so the
    // database alone cannot decrypt what it holds.
    const settings = fakeSettings();
    new EncryptionKeyRing({ settings, key: KEY_A });
    assert.strictEqual(settings.getSetting('deploy.encryptionKeyId'), null);
    for (const key of settings.map.keys()) {
      assert.ok(!key.startsWith('deploy.encryptionKeys.'), `${key} must not be persisted`);
    }
  });

  it('generates and stores a dev key when none is supplied, and warns', function () {
    const settings = fakeSettings();
    const warnings = [];
    const ring = new EncryptionKeyRing({ settings, warn: (...args) => warnings.push(args.join(' ')) });

    const kid = ring.activeKeyId();
    assert.strictEqual(settings.getSetting('deploy.encryptionKeyId'), kid);
    assert.ok(settings.getSetting(`deploy.encryptionKeys.${kid}`));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /dev-grade/);

    // A second process over the same settings reads the same key back.
    const reopened = new EncryptionKeyRing({ settings, warn: () => {} });
    assert.strictEqual(reopened.activeKeyId(), kid);
    assert.strictEqual(reopened.decrypt(ring.encrypt('still mine')), 'still mine');
  });

  it('decrypts by the envelope’s kid, not by whatever is active now', function () {
    // An installation that started on a generated dev key and later passed a
    // real one must still read everything the dev key wrote.
    const settings = fakeSettings();
    const dev = new EncryptionKeyRing({ settings, warn: () => {} });
    const oldEnvelope = dev.encrypt('written before the real key arrived');

    const production = new EncryptionKeyRing({ settings, key: KEY_A });
    assert.strictEqual(production.decrypt(oldEnvelope), 'written before the real key arrived');
    // New writes name the supplied key, not the dev one.
    assert.strictEqual(decodeEnvelope(production.encrypt('fresh')).kid, production.activeKeyId());
  });

  it('re-encrypts an old envelope under the active key', function () {
    const settings = fakeSettings();
    const dev = new EncryptionKeyRing({ settings, warn: () => {} });
    const oldEnvelope = dev.encrypt('rotate me');

    const production = new EncryptionKeyRing({ settings, key: KEY_A });
    const rotated = production.reEncrypt(oldEnvelope);
    assert.strictEqual(decodeEnvelope(rotated).kid, production.activeKeyId());
    assert.strictEqual(production.decrypt(rotated), 'rotate me');
  });

  it('rejects key material that is not 32 bytes', function () {
    assert.throws(
      () => new EncryptionKeyRing({ settings: fakeSettings(), key: 'c2hvcnQ=' }),
      /32 bytes/,
    );
  });

  it('rejects malformed envelopes rather than guessing', function () {
    const ring = new EncryptionKeyRing({ settings: fakeSettings(), key: KEY_A });
    assert.throws(() => ring.decrypt('not-base64-json'), /invalid envelope|malformed/);
    const tampered = Buffer.from(JSON.stringify({ v: 2, kid: 'x', iv: 'y', tag: 'z', data: 'w' }))
      .toString('base64');
    assert.throws(() => ring.decrypt(tampered), /malformed envelope/);
  });
});
