// TLS material for the local deployment.
//
// The app is served over HTTPS unconditionally. That is not about secrecy on a
// home LAN — it is because a browser gives a plain-http origin that is not
// localhost almost nothing: no service worker, so no installable app and no
// offline shell; no clipboard API; no notifications. Everything worked when
// tested at http://localhost and broke for anyone opening the same server at
// http://192.168.x.x, which is how it is actually used.
//
// There is no public DNS name and no ACME here, so the certificate is signed by
// a CA generated on this machine and kept in the data directory. That CA has to
// be trusted once per device; `caFile` is what a device installs, and the
// server also offers it at /ca.crt for exactly that.

import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';

export interface TlsMaterial {
  certFile: string;
  keyFile: string;
  /** The local CA a device must trust; safe to hand out, it holds no key. */
  caFile: string;
  /** Names and addresses the certificate is valid for. */
  hosts: string[];
  /** True when this call had to (re)issue the certificate. */
  issued: boolean;
}

/**
 * Chrome and Safari reject server certificates with a lifetime over 398 days.
 * Locally-trusted roots are exempt today, but issuing inside the public limit
 * costs nothing and removes a failure mode that would appear months later on
 * one browser only. Expiry is not a problem because startup reissues.
 */
const CERT_DAYS = 397;
const CA_DAYS = 3650;

/** Reissue this far ahead of expiry, so a long-running server never serves an expired cert. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export function tlsDir(dataDir: string | null): string {
  const base = dataDir || path.join(os.homedir(), '.code-agents-webcli');
  return path.join(base, 'tls');
}

/**
 * Every name this machine can be reached by.
 *
 * The LAN address matters most and is also the one that changes: a laptop that
 * moves between networks gets a new IP, and a certificate that does not cover
 * it fails in a way that looks like the server is broken. This list is compared
 * against the certificate on every start, so a changed address reissues.
 */
export function localHosts(): { dns: string[]; ip: string[] } {
  const dns = new Set<string>(['localhost']);
  const ip = new Set<string>(['127.0.0.1', '::1']);

  const hostname = os.hostname();
  if (hostname && hostname !== 'localhost') {
    dns.add(hostname);
    // Avahi/Bonjour resolve <hostname>.local on most home networks.
    if (!hostname.includes('.')) dns.add(`${hostname}.local`);
  }

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      // Link-local IPv6 carries a zone index that no certificate can express.
      if (addr.family === 'IPv6' && addr.address.startsWith('fe80')) continue;
      ip.add(addr.address);
    }
  }

  return { dns: [...dns], ip: [...ip] };
}

function openssl(args: string[]): string {
  return execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function hasOpenssl(): boolean {
  try {
    openssl(['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare hosts on what they mean, not on how they are spelled.
 *
 * openssl prints IPv6 SANs fully expanded — `::1` comes back as
 * `0:0:0:0:0:0:0:1` — so a literal comparison never matches and the server
 * reissues its certificate on every single start. URL parsing collapses both
 * spellings to the same canonical form.
 */
function normaliseHost(host: string): string {
  const lower = host.trim().toLowerCase();
  if (!lower.includes(':')) return lower;
  try {
    return new URL(`http://[${lower}]`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return lower;
  }
}

/** Read the SANs already baked into a certificate. */
function certificateHosts(certFile: string): string[] {
  try {
    const text = openssl(['x509', '-in', certFile, '-noout', '-ext', 'subjectAltName']);
    return [...text.matchAll(/(?:DNS|IP Address):\s*([^,\s]+)/g)].map((m) => normaliseHost(m[1]));
  } catch {
    return [];
  }
}

function certificateExpiry(certFile: string): number {
  try {
    const text = openssl(['x509', '-in', certFile, '-noout', '-enddate']);
    const match = text.match(/notAfter=(.+)/);
    return match ? Date.parse(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Does the certificate on disk still cover how this machine is reached, and
 * for long enough? Anything else is reissued rather than repaired.
 */
function isUsable(certFile: string, keyFile: string, caFile: string, wanted: string[]): boolean {
  if (![certFile, keyFile, caFile].every((f) => fs.existsSync(f))) return false;

  const expiry = certificateExpiry(certFile);
  if (!expiry || expiry - Date.now() < RENEW_BEFORE_MS) return false;

  const covered = new Set(certificateHosts(certFile));
  return wanted.every((host) => covered.has(normaliseHost(host)));
}

/**
 * Return usable certificate paths, generating a CA and a server certificate on
 * first run and whenever the existing one no longer fits this machine.
 */
export function ensureCertificates(dataDir: string | null): TlsMaterial {
  const dir = tlsDir(dataDir);
  const caFile = path.join(dir, 'ca.crt');
  const caKeyFile = path.join(dir, 'ca.key');
  const certFile = path.join(dir, 'server.crt');
  const keyFile = path.join(dir, 'server.key');

  const { dns, ip } = localHosts();
  const hosts = [...dns, ...ip];

  if (isUsable(certFile, keyFile, caFile, hosts)) {
    return { certFile, keyFile, caFile, hosts, issued: false };
  }

  if (!hasOpenssl()) {
    throw new Error(
      'HTTPS needs the `openssl` command to generate a local certificate, and it was not found.\n'
      + 'Install it (dnf install openssl / apt install openssl), or pass your own with '
      + '--cert and --key.',
    );
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The CA is reused across reissues where possible: replacing it would mean
  // re-trusting the server on every device again, which is the one manual step
  // in this whole arrangement.
  if (!fs.existsSync(caFile) || !fs.existsSync(caKeyFile)) {
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-days', String(CA_DAYS),
      '-keyout', caKeyFile,
      '-out', caFile,
      '-subj', `/O=Code Agents Web CLI/CN=Code Agents Web CLI local CA (${os.hostname()})`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    fs.chmodSync(caKeyFile, 0o600);
    fs.chmodSync(caFile, 0o644);
  }

  const san = [...dns.map((d) => `DNS:${d}`), ...ip.map((a) => `IP:${a}`)].join(',');
  const extFile = path.join(dir, 'server.ext');
  const csrFile = path.join(dir, 'server.csr');

  fs.writeFileSync(extFile, [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${san}`,
    '',
  ].join('\n'));

  try {
    openssl([
      'req', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile,
      '-out', csrFile,
      '-subj', `/O=Code Agents Web CLI/CN=${dns[1] || 'localhost'}`,
    ]);
    openssl([
      'x509', '-req',
      '-in', csrFile,
      '-CA', caFile, '-CAkey', caKeyFile, '-CAcreateserial',
      '-out', certFile,
      '-days', String(CERT_DAYS),
      '-sha256',
      '-extfile', extFile,
    ]);
    fs.chmodSync(keyFile, 0o600);
    fs.chmodSync(certFile, 0o644);
    // Fail here, with the files still in hand, rather than at listen() time
    // with a TLS error that says nothing about which of the two is wrong.
    tls.createSecureContext({
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
    });
  } finally {
    fs.rmSync(csrFile, { force: true });
    fs.rmSync(extFile, { force: true });
  }

  return { certFile, keyFile, caFile, hosts, issued: true };
}

/**
 * One port that speaks TLS, and answers plain http with a redirect to itself.
 *
 * Without this, every bookmark, shell history entry and typed `host:32352` on
 * the network answers with a bare connection error, because a TLS server hands
 * a plaintext request nothing a browser can render. No content is served over
 * http — the redirect only says where the app went.
 */
export function createHttpsOnlyPort(secure: https.Server): net.Server {
  const redirector = http.createServer((req, res) => {
    const host = req.headers.host || 'localhost';
    res.writeHead(308, { Location: `https://${host}${req.url || '/'}` });
    res.end('This server is HTTPS only.\n');
  });

  return net.createServer((socket) => {
    // A client that connects and says nothing would otherwise hold the socket
    // open forever, since the branch below needs the first byte to decide.
    socket.setTimeout(10_000, () => socket.destroy());

    socket.once('data', (chunk) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(chunk);
      // 0x16 is a TLS handshake record; anything else is someone typing
      // http:// at an https port.
      (chunk[0] === 0x16 ? secure : redirector).emit('connection', socket);
      // Next tick, not now: emit() returns before the server it just handed the
      // socket to has finished attaching its own readable handlers, and
      // resuming synchronously replays the unshifted bytes into a stream nobody
      // is reading yet — the handshake then never completes and the connection
      // hangs with no error on either side.
      process.nextTick(() => socket.resume());
    });

    socket.on('error', () => socket.destroy());
  });
}
