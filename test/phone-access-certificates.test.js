'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const {
  LEAF_VALIDITY_DAYS,
  ensurePhoneAccessCertificates,
} = require('../desktop/phone-access-certificates.js');
const {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} = require('@peculiar/x509');

describe('desktop phone access certificates', function () {
  this.timeout(20_000);
  let directory;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-access-certificates-'));
  });

  afterEach(function () {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates private, TLS-loadable CA and leaf PEM files atomically', async function () {
    const material = await ensurePhoneAccessCertificates({
      dataDir: directory,
      hosts: ['192.168.1.20', 'Phone.Tailnet.TS.NET.', '2001:0db8::20'],
    });
    assert.strictEqual(material.issued, true);
    assert.deepStrictEqual(material.hosts, [
      '192.168.1.20', 'phone.tailnet.ts.net', '2001:db8::20',
    ]);
    assert.match(material.caFingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(material.caFile.includes(path.join('phone-access', 'tls')));

    const caPem = fs.readFileSync(material.caFile, 'utf8');
    const certPem = fs.readFileSync(material.certFile, 'utf8');
    const keyPem = fs.readFileSync(material.keyFile, 'utf8');
    assert.doesNotThrow(() => tls.createSecureContext({ cert: certPem, key: keyPem, ca: caPem }));

    const ca = new X509Certificate(caPem);
    const leaf = new X509Certificate(certPem);
    assert.strictEqual(ca.getExtension(BasicConstraintsExtension).ca, true);
    assert.deepStrictEqual(
      leaf.getExtension(SubjectAlternativeNameExtension).names.toJSON()
        .map(({ type, value }) => `${type}:${value}`),
      ['ip:192.168.1.20', 'dns:phone.tailnet.ts.net', 'ip:2001:db8::20'],
    );
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.dirname(material.caFile)).mode & 0o777, 0o700);
      for (const filename of [material.caFile, material.certFile, material.keyFile]) {
        assert.strictEqual(fs.statSync(filename).mode & 0o777, 0o600);
      }
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(material.caFile)).sort(), [
      'ca.crt', 'ca.key', 'server.crt', 'server.key',
    ]);
  });

  it('reuses the CA and leaf while both remain usable', async function () {
    const options = { dataDir: directory, hosts: ['10.0.0.8'] };
    const first = await ensurePhoneAccessCertificates(options);
    const ca = fs.readFileSync(first.caFile, 'utf8');
    const cert = fs.readFileSync(first.certFile, 'utf8');
    const second = await ensurePhoneAccessCertificates(options);
    assert.strictEqual(second.issued, false);
    assert.strictEqual(second.caFingerprint, first.caFingerprint);
    assert.strictEqual(fs.readFileSync(second.caFile, 'utf8'), ca);
    assert.strictEqual(fs.readFileSync(second.certFile, 'utf8'), cert);
  });

  it('reissues only the leaf for SAN changes, expiry, and leaf corruption', async function () {
    const start = new Date('2026-01-01T00:00:00Z');
    const first = await ensurePhoneAccessCertificates({
      dataDir: directory, hosts: ['10.0.0.8'], now: start,
    });
    const ca = fs.readFileSync(first.caFile, 'utf8');
    const firstCert = fs.readFileSync(first.certFile, 'utf8');

    const changed = await ensurePhoneAccessCertificates({
      dataDir: directory, hosts: ['10.0.0.9'], now: start,
    });
    assert.strictEqual(changed.issued, true);
    assert.strictEqual(fs.readFileSync(changed.caFile, 'utf8'), ca);
    assert.notStrictEqual(fs.readFileSync(changed.certFile, 'utf8'), firstCert);

    const future = new Date(start.getTime() + (LEAF_VALIDITY_DAYS - 20) * 24 * 60 * 60 * 1000);
    const renewed = await ensurePhoneAccessCertificates({
      dataDir: directory, hosts: ['10.0.0.9'], now: future,
    });
    assert.strictEqual(renewed.issued, true);
    assert.strictEqual(fs.readFileSync(renewed.caFile, 'utf8'), ca);

    fs.writeFileSync(renewed.certFile, 'corrupt certificate');
    const repaired = await ensurePhoneAccessCertificates({
      dataDir: directory, hosts: ['10.0.0.9'], now: future,
    });
    assert.strictEqual(repaired.issued, true);
    assert.strictEqual(fs.readFileSync(repaired.caFile, 'utf8'), ca);
    assert.doesNotThrow(() => tls.createSecureContext({
      cert: fs.readFileSync(repaired.certFile), key: fs.readFileSync(repaired.keyFile),
    }));
  });

  it('replaces a corrupt CA and the leaf it authenticated', async function () {
    const first = await ensurePhoneAccessCertificates({ dataDir: directory, hosts: ['10.1.2.3'] });
    fs.writeFileSync(first.caFile, 'corrupt CA');
    const repaired = await ensurePhoneAccessCertificates({ dataDir: directory, hosts: ['10.1.2.3'] });
    assert.strictEqual(repaired.issued, true);
    assert.notStrictEqual(repaired.caFingerprint, first.caFingerprint);
    assert.doesNotThrow(() => tls.createSecureContext({
      ca: fs.readFileSync(repaired.caFile),
      cert: fs.readFileSync(repaired.certFile),
      key: fs.readFileSync(repaired.keyFile),
    }));
  });
});
