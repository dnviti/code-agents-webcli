'use strict';

const cryptoModule = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

// @peculiar/x509 2.0 uses tsyringe, whose CommonJS entry requires the metadata
// proposal API even though x509's registered classes do not use constructor
// parameters. Keep the tiny compatibility layer local until the package ships
// its own runtime polyfill.
function installReflectMetadataCompatibility() {
  if (typeof Reflect.getMetadata === 'function') return;
  const metadata = new WeakMap();
  const properties = (target, propertyKey, create) => {
    let targets = metadata.get(target);
    if (!targets && create) {
      targets = new Map();
      metadata.set(target, targets);
    }
    const key = propertyKey === undefined ? null : propertyKey;
    let values = targets?.get(key);
    if (!values && create) {
      values = new Map();
      targets.set(key, values);
    }
    return values;
  };
  Reflect.defineMetadata = (key, value, target, propertyKey) => {
    properties(target, propertyKey, true).set(key, value);
  };
  Reflect.getOwnMetadata = (key, target, propertyKey) =>
    properties(target, propertyKey, false)?.get(key);
  Reflect.getMetadata = (key, target, propertyKey) => {
    for (let current = target; current; current = Object.getPrototypeOf(current)) {
      const value = Reflect.getOwnMetadata(key, current, propertyKey);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

installReflectMetadataCompatibility();
const x509Module = require('@peculiar/x509');

const CA_VALIDITY_DAYS = 3650;
const LEAF_VALIDITY_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const activeEnsures = new Map();

function phoneAccessCertificatePaths(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('A phone access data directory is required');
  }
  const directory = path.join(dataDir, 'phone-access', 'tls');
  return {
    directory,
    caFile: path.join(directory, 'ca.crt'),
    caKeyFile: path.join(directory, 'ca.key'),
    certFile: path.join(directory, 'server.crt'),
    keyFile: path.join(directory, 'server.key'),
  };
}

function canonicalIpv6(address) {
  try {
    return new URL(`https://[${address.toLowerCase()}]`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function normalizeCertificateHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new TypeError('At least one certificate host is required');
  }
  const normalized = [];
  const seen = new Set();
  for (const item of hosts) {
    const raw = typeof item === 'object' && item ? item.address : item;
    const value = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    const ipFamily = net.isIP(value);
    let host = value;
    if (ipFamily === 6) host = canonicalIpv6(value);
    if (!host || value.includes('%')) throw new TypeError(`Invalid certificate host: ${raw}`);
    if (!ipFamily) {
      if (host.length > 253 || !host.split('.').every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new TypeError(`Invalid certificate host: ${raw}`);
      }
    }
    const key = `${ipFamily ? 'ip' : 'dns'}:${host}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(host);
    }
  }
  return normalized;
}

function pemEncode(label, data) {
  const base64 = Buffer.from(data).toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function safeChmod(fileSystem, filename, mode) {
  try {
    fileSystem.chmodSync(filename, mode);
  } catch (error) {
    if (!['ENOSYS', 'EINVAL', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
  }
}

function atomicWrite(filename, contents, { fileSystem = fs, randomUUID = cryptoModule.randomUUID } = {}) {
  const directory = path.dirname(filename);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  safeChmod(fileSystem, directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fileSystem.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    safeChmod(fileSystem, temporary, 0o600);
    fileSystem.renameSync(temporary, filename);
    safeChmod(fileSystem, filename, 0o600);
  } finally {
    try { fileSystem.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function readText(filename, fileSystem) {
  try {
    return fileSystem.readFileSync(filename, 'utf8');
  } catch {
    return null;
  }
}

function certificateFingerprint(certificate, createHash = cryptoModule.createHash) {
  return createHash('sha256')
    .update(Buffer.from(certificate.rawData))
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');
}

function matchingPrivateKey(certificate, privateKeyPem, dependencies) {
  try {
    const privateKey = dependencies.createPrivateKey(privateKeyPem);
    const publicKey = dependencies.createPublicKey(privateKey);
    const actual = publicKey.export({ format: 'der', type: 'spki' });
    return Buffer.from(certificate.publicKey.rawData).equals(Buffer.from(actual));
  } catch {
    return false;
  }
}

function validAt(certificate, now, renewBeforeMs = 0) {
  const time = now.getTime();
  return certificate.notBefore.getTime() <= time
    && certificate.notAfter.getTime() - time >= renewBeforeMs;
}

async function readUsableCa(paths, dependencies, now) {
  const caPem = readText(paths.caFile, dependencies.fileSystem);
  const caKeyPem = readText(paths.caKeyFile, dependencies.fileSystem);
  if (!caPem || !caKeyPem) return null;
  try {
    const certificate = new dependencies.x509.X509Certificate(caPem);
    const constraints = certificate.getExtension(dependencies.x509.BasicConstraintsExtension);
    if (!constraints?.ca || !validAt(certificate, now, RENEW_BEFORE_MS)) return null;
    if (!matchingPrivateKey(certificate, caKeyPem, dependencies)) return null;
    if (!await certificate.isSelfSigned(dependencies.crypto)) return null;
    safeChmod(dependencies.fileSystem, paths.caFile, 0o600);
    safeChmod(dependencies.fileSystem, paths.caKeyFile, 0o600);
    return { certificate, certificatePem: caPem, privateKeyPem: caKeyPem };
  } catch {
    return null;
  }
}

function certificateSans(certificate, x509) {
  const extension = certificate.getExtension(x509.SubjectAlternativeNameExtension);
  if (!extension) return [];
  return extension.names.toJSON().map(({ type, value }) => {
    const host = type === 'ip' && net.isIP(value) === 6 ? canonicalIpv6(value) : value.toLowerCase();
    return `${type}:${host}`;
  });
}

function wantedSans(hosts) {
  return hosts.map((host) => `${net.isIP(host) ? 'ip' : 'dns'}:${host}`).sort();
}

async function readUsableLeaf(paths, ca, hosts, dependencies, now) {
  const certificatePem = readText(paths.certFile, dependencies.fileSystem);
  const privateKeyPem = readText(paths.keyFile, dependencies.fileSystem);
  if (!certificatePem || !privateKeyPem) return null;
  try {
    const certificate = new dependencies.x509.X509Certificate(certificatePem);
    if (!validAt(certificate, now, RENEW_BEFORE_MS)) return null;
    if (!matchingPrivateKey(certificate, privateKeyPem, dependencies)) return null;
    if (certificate.issuer !== ca.certificate.subject) return null;
    if (!await certificate.verify({ publicKey: ca.certificate, signatureOnly: true }, dependencies.crypto)) {
      return null;
    }
    if (JSON.stringify(certificateSans(certificate, dependencies.x509).sort())
      !== JSON.stringify(wantedSans(hosts))) return null;
    dependencies.createSecureContext({ cert: certificatePem, key: privateKeyPem, ca: ca.certificatePem });
    safeChmod(dependencies.fileSystem, paths.certFile, 0o600);
    safeChmod(dependencies.fileSystem, paths.keyFile, 0o600);
    return { certificate, certificatePem, privateKeyPem };
  } catch {
    return null;
  }
}

async function generateKeyPair(crypto) {
  return crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
}

async function exportPrivateKey(privateKey, crypto) {
  return pemEncode('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', privateKey));
}

async function generateCa(dependencies, now) {
  const keys = await generateKeyPair(dependencies.crypto);
  const subjectKey = await dependencies.x509.SubjectKeyIdentifierExtension.create(
    keys.publicKey,
    false,
    dependencies.crypto,
  );
  const certificate = await dependencies.x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Code Agents Web CLI Phone Access CA, O=Code Agents Web CLI',
    keys,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      new dependencies.x509.BasicConstraintsExtension(true, 0, true),
      new dependencies.x509.KeyUsagesExtension(
        dependencies.x509.KeyUsageFlags.keyCertSign | dependencies.x509.KeyUsageFlags.cRLSign,
        true,
      ),
      subjectKey,
    ],
  }, dependencies.crypto);
  return {
    certificate,
    certificatePem: certificate.toString('pem'),
    privateKeyPem: await exportPrivateKey(keys.privateKey, dependencies.crypto),
    privateKey: keys.privateKey,
  };
}

async function importSigningKey(pem, crypto) {
  const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(base64, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function generateLeaf(ca, hosts, dependencies, now) {
  const keys = await generateKeyPair(dependencies.crypto);
  const subjectKey = await dependencies.x509.SubjectKeyIdentifierExtension.create(
    keys.publicKey,
    false,
    dependencies.crypto,
  );
  const authorityKey = await dependencies.x509.AuthorityKeyIdentifierExtension.create(
    ca.certificate.publicKey,
    false,
    dependencies.crypto,
  );
  const signingKey = ca.privateKey
    || await importSigningKey(ca.privateKeyPem, dependencies.crypto);
  const certificate = await dependencies.x509.X509CertificateGenerator.create({
    subject: 'CN=Code Agents Web CLI Phone Access, O=Code Agents Web CLI',
    issuer: ca.certificate.subject,
    publicKey: keys.publicKey,
    signingKey,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + LEAF_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      new dependencies.x509.BasicConstraintsExtension(false, undefined, true),
      new dependencies.x509.KeyUsagesExtension(
        dependencies.x509.KeyUsageFlags.digitalSignature
          | dependencies.x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new dependencies.x509.ExtendedKeyUsageExtension([
        dependencies.x509.ExtendedKeyUsage.serverAuth,
      ], false),
      new dependencies.x509.SubjectAlternativeNameExtension(hosts.map((host) => ({
        type: net.isIP(host) ? 'ip' : 'dns',
        value: host,
      })), false),
      subjectKey,
      authorityKey,
    ],
  }, dependencies.crypto);
  return {
    certificate,
    certificatePem: certificate.toString('pem'),
    privateKeyPem: await exportPrivateKey(keys.privateKey, dependencies.crypto),
  };
}

async function ensureOnce(options) {
  const hosts = normalizeCertificateHosts(options.hosts);
  const paths = phoneAccessCertificatePaths(options.dataDir);
  const now = options.now instanceof Date ? new Date(options.now) : new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError('The certificate time is invalid');
  const dependencies = {
    fileSystem: options.fileSystem || fs,
    crypto: options.crypto || cryptoModule.webcrypto,
    x509: options.x509 || x509Module,
    createHash: options.createHash || cryptoModule.createHash,
    createPrivateKey: options.createPrivateKey || cryptoModule.createPrivateKey,
    createPublicKey: options.createPublicKey || cryptoModule.createPublicKey,
    createSecureContext: options.createSecureContext || tls.createSecureContext,
    randomUUID: options.randomUUID || cryptoModule.randomUUID,
  };

  dependencies.fileSystem.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  safeChmod(dependencies.fileSystem, paths.directory, 0o700);

  let ca = await readUsableCa(paths, dependencies, now);
  let caCreated = false;
  if (!ca) {
    ca = await generateCa(dependencies, now);
    atomicWrite(paths.caKeyFile, ca.privateKeyPem, dependencies);
    atomicWrite(paths.caFile, ca.certificatePem, dependencies);
    caCreated = true;
  }

  let leaf = caCreated ? null : await readUsableLeaf(paths, ca, hosts, dependencies, now);
  let issued = false;
  if (!leaf) {
    leaf = await generateLeaf(ca, hosts, dependencies, now);
    dependencies.createSecureContext({
      cert: leaf.certificatePem,
      key: leaf.privateKeyPem,
      ca: ca.certificatePem,
    });
    atomicWrite(paths.keyFile, leaf.privateKeyPem, dependencies);
    atomicWrite(paths.certFile, leaf.certificatePem, dependencies);
    issued = true;
  }

  return {
    caFile: paths.caFile,
    certFile: paths.certFile,
    keyFile: paths.keyFile,
    caFingerprint: certificateFingerprint(ca.certificate, dependencies.createHash),
    hosts,
    issued,
  };
}

/** Generate or reuse private TLS material for the desktop phone-access server. */
function ensurePhoneAccessCertificates(options = {}) {
  const paths = phoneAccessCertificatePaths(options.dataDir);
  const key = path.resolve(paths.directory);
  const previous = activeEnsures.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => ensureOnce(options));
  activeEnsures.set(key, current);
  return current.finally(() => {
    if (activeEnsures.get(key) === current) activeEnsures.delete(key);
  });
}

module.exports = {
  CA_VALIDITY_DAYS,
  CLOCK_SKEW_MS,
  LEAF_VALIDITY_DAYS,
  RENEW_BEFORE_MS,
  atomicWrite,
  certificateFingerprint,
  certificateSans,
  ensurePhoneAccessCertificates,
  normalizeCertificateHosts,
  pemEncode,
  phoneAccessCertificatePaths,
};
