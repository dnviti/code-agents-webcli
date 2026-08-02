import * as crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * A filesystem callback channel for agents running somewhere a Unix socket
 * cannot reach (a remote engine or a Kubernetes pod).
 *
 * The shared home is an untrusted transport. Request, reply, cancellation, and
 * heartbeat files are authenticated and encrypted with the endpoint's random
 * session token. The endpoint root is sealed after generated runtime artifacts
 * are installed, and every operation verifies that its directories have not
 * been replaced. Cleanup only unlinks non-directories and never follows a
 * symlink or recursively walks an attacker-controlled path.
 */

export type FileCallbackKind = 'question' | 'plan' | (string & {});

export interface FileCallbackEndpoint {
  /** Absolute path as seen by the process that is going to use it. */
  directory: string;
  /** Secret encryption key material; do not put it in a file, log, or transcript. */
  token: string;
}

export interface FileCallbackRequest {
  id: string;
  kind: FileCallbackKind;
  payload: unknown;
  createdAt: number;
}

export interface FileCallbackReply {
  id: string;
  result?: unknown;
  error?: string;
  cancelled?: boolean;
}

export interface FileCallbackBrokerOptions {
  /** Polling is portable to NFS/claim-backed homes; fs.watch is not. */
  pollMs?: number;
  /** A dead runtime request must not retain its handler forever. */
  requestTimeoutMs?: number;
  /** Age at which orphaned requests/replies/cancellation markers are removed. */
  cleanupAfterMs?: number;
  testHooks?: FileCallbackTestHooks;
}

export type FileCallbackFilesystemOperation = 'read' | 'write' | 'unlink' | 'cleanup';

export interface FileCallbackTestHooks {
  /** Deterministic race injection for security tests; never set by production composition. */
  afterDirectoryOpened?(
    operation: FileCallbackFilesystemOperation,
    directory: string,
  ): void | Promise<void>;
}

export type FileCallbackHandler = (
  request: FileCallbackRequest,
  signal: AbortSignal,
) => Promise<unknown>;

const ID = /^[A-Za-z0-9_-]{12,128}$/;
const ENDPOINT_NAME = /^[a-f0-9]{32}$/;
const DEFAULT_POLL_MS = 200;
// Just under Node's signed 32-bit timer ceiling: a human question may sit over
// a weekend, while the heartbeat below still detects a dead server in seconds.
const DEFAULT_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_CLEANUP_MS = DEFAULT_TIMEOUT_MS + 60 * 60_000;
const HEARTBEAT_MS = 2_000;
const HEARTBEAT_STALE_MS = 10_000;
const MAX_LEASE_MS = 60_000;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const CALLBACK_VERSION = 1;
const AAD_PREFIX = 'ccweb-file-callback-v1:';

type CriticalDirectoryName = 'requests' | 'replies' | 'cancelled';

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface DirectoryRef extends DirectoryIdentity {
  path: string;
}

interface BrokerLayout {
  base: DirectoryRef;
  endpoint: DirectoryRef;
  requests: DirectoryRef;
  replies: DirectoryRef;
  cancelled: DirectoryRef;
  pi: DirectoryRef;
  piCcweb: DirectoryRef;
}

interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface OpenDirectory {
  handle: fsp.FileHandle;
  identity: DirectoryIdentity;
  accessPath: string;
}

class UnsafeCallbackPathError extends Error {
  constructor(file: string) {
    super(`unsafe file callback path: ${file}`);
    this.name = 'UnsafeCallbackPathError';
  }
}

class InvalidCallbackEnvelopeError extends Error {
  constructor() {
    super('invalid encrypted file callback envelope');
    this.name = 'InvalidCallbackEnvelopeError';
  }
}

function requestName(id: string): string { return `${id}.json`; }
function cancelName(id: string): string { return `${id}.cancel`; }
function replyName(id: string): string { return `${id}.json`; }
function aad(kind: 'request' | 'reply' | 'cancel', id: string): string { return `${AAD_PREFIX}${kind}:${id}`; }

function sameDirectory(actual: DirectoryIdentity, expected: DirectoryIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function openDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<OpenDirectory> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new UnsafeCallbackPathError(directory);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new UnsafeCallbackPathError(directory);
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && !sameDirectory(identity, expected)) throw new UnsafeCallbackPathError(directory);
    const accessPath = fdAccessPath(handle);
    const anchored = await fsp.stat(accessPath).catch(() => null);
    if (!anchored || !anchored.isDirectory()
      || anchored.dev !== identity.dev || anchored.ino !== identity.ino) {
      throw new UnsafeCallbackPathError(directory);
    }
    return { handle, identity, accessPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function fdAccessPath(handle: fsp.FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  // BSDs and macOS commonly expose the same descriptor-anchored namespace.
  // If this host does not, openDirectory's stat check fails closed.
  return `/dev/fd/${handle.fd}`;
}

function childName(file: string): string {
  const name = path.basename(file);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new UnsafeCallbackPathError(file);
  }
  return name;
}

function childAccessPath(opened: OpenDirectory, file: string): string {
  return path.join(opened.accessPath, childName(file));
}

async function verifyVisibleDirectory(ref: DirectoryRef, opened: OpenDirectory): Promise<void> {
  const visible = await openDirectory(ref.path, ref).catch(() => null);
  if (!visible) throw new UnsafeCallbackPathError(ref.path);
  try {
    const current = await opened.handle.stat();
    if (!sameDirectory(current, visible.identity)) throw new UnsafeCallbackPathError(ref.path);
  } finally {
    await visible.handle.close();
  }
}

async function withDirectory<T>(
  ref: DirectoryRef,
  operation: FileCallbackFilesystemOperation,
  callback: (opened: OpenDirectory) => Promise<T>,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<T> {
  const opened = await openDirectory(ref.path, ref);
  try {
    await hook?.(operation, ref.path);
    const result = await callback(opened);
    await verifyVisibleDirectory(ref, opened);
    return result;
  } finally {
    await opened.handle.close();
  }
}

async function directoryRef(directory: string, expected?: DirectoryIdentity): Promise<DirectoryRef> {
  const opened = await openDirectory(directory, expected);
  await opened.handle.close();
  return { path: directory, ...opened.identity };
}

async function assertDirectory(ref: DirectoryRef): Promise<void> {
  await withDirectory(ref, 'read', async () => undefined);
}

async function setDirectoryMode(ref: DirectoryRef, mode: number): Promise<void> {
  await withDirectory(ref, 'cleanup', async (opened) => {
    await opened.handle.chmod(mode);
  });
}

async function makeChildDirectory(
  parent: DirectoryRef,
  name: string,
  allowExisting: boolean,
): Promise<DirectoryRef> {
  return withDirectory(parent, 'write', async (openedParent) => {
    const target = childAccessPath(openedParent, name);
    try {
      await fsp.mkdir(target, { mode: 0o700 });
    } catch (error: unknown) {
      if (!allowExisting || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const child = await openChildDirectory(openedParent, name);
    try {
      await child.handle.chmod(0o700);
      return { path: path.join(parent.path, childName(name)), ...child.identity };
    } finally {
      await child.handle.close();
    }
  });
}

async function writeExclusivePlain(directory: DirectoryRef, name: string, contents: string): Promise<void> {
  await withDirectory(directory, 'write', async (opened) => {
    await fsp.writeFile(childAccessPath(opened, name), contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  });
}

function encryptionKey(token: string): Buffer {
  return crypto.createHash('sha256').update('ccweb-file-callback-key-v1\0').update(token).digest();
}

function encrypt(token: string, associatedData: string, value: unknown): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(token), iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    v: CALLBACK_VERSION,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decrypt(token: string, associatedData: string, value: unknown): unknown {
  try {
    const envelope = value as Partial<EncryptedEnvelope> | null;
    if (!envelope || envelope.v !== CALLBACK_VERSION || typeof envelope.iv !== 'string'
      || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
      throw new InvalidCallbackEnvelopeError();
    }
    const iv = Buffer.from(envelope.iv, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new InvalidCallbackEnvelopeError();
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(token), iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    if (error instanceof InvalidCallbackEnvelopeError) throw error;
    throw new InvalidCallbackEnvelopeError();
  }
}

async function atomicEncrypted(
  directory: DirectoryRef,
  file: string,
  token: string,
  associatedData: string,
  value: unknown,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<void> {
  await withDirectory(directory, 'write', async (opened) => {
    const targetName = childName(file);
    const temporaryName = `${targetName}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    const target = childAccessPath(opened, targetName);
    const temporary = childAccessPath(opened, temporaryName);
    try {
      await fsp.writeFile(temporary, JSON.stringify(encrypt(token, associatedData, value)), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }, hook);
}

async function readEncrypted(
  directory: DirectoryRef,
  file: string,
  token: string,
  associatedData: string,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<unknown | null> {
  return withDirectory(directory, 'read', async (opened) => {
    const target = childAccessPath(opened, file);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new UnsafeCallbackPathError(file);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ENVELOPE_BYTES) throw new InvalidCallbackEnvelopeError();
      const serialized = await handle.readFile({ encoding: 'utf8' });
      return decrypt(token, associatedData, JSON.parse(serialized));
    } catch (error) {
      if (error instanceof UnsafeCallbackPathError || error instanceof InvalidCallbackEnvelopeError) throw error;
      throw new InvalidCallbackEnvelopeError();
    } finally {
      await handle.close();
    }
  }, hook);
}

async function safeUnlink(
  directory: DirectoryRef,
  file: string,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<void> {
  await withDirectory(directory, 'unlink', async (opened) => {
    try {
      await fsp.unlink(childAccessPath(opened, file));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }, hook);
}

async function safeCleanupFlat(
  directory: DirectoryRef,
  before?: number,
  hook?: FileCallbackTestHooks['afterDirectoryOpened'],
): Promise<void> {
  await withDirectory(directory, 'cleanup', async (opened) => {
    await cleanupOpenedFlat(opened, before);
  }, hook);
}

async function cleanupOpenedFlat(opened: OpenDirectory, before?: number): Promise<void> {
  const entries = await fsp.readdir(opened.accessPath);
  for (const entry of entries) {
    const file = childAccessPath(opened, entry);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat || stat.isDirectory() || (before !== undefined && stat.mtimeMs >= before)) continue;
    await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function openChildDirectory(
  parent: OpenDirectory,
  name: string,
  expected?: DirectoryIdentity,
): Promise<OpenDirectory> {
  return openDirectory(childAccessPath(parent, name), expected);
}

async function safeRmdir(
  parent: DirectoryRef,
  name: string,
  expected: DirectoryIdentity,
): Promise<void> {
  await withDirectory(parent, 'cleanup', async (openedParent) => {
    const openedChild = await openChildDirectory(openedParent, name, expected);
    try {
      await fsp.rmdir(childAccessPath(openedParent, name)).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
      });
    } finally {
      await openedChild.handle.close();
    }
  });
}

async function assertBrokerLayout(layout: BrokerLayout): Promise<void> {
  await assertDirectory(layout.base);
  await assertDirectory(layout.endpoint);
  await Promise.all([
    assertDirectory(layout.requests),
    assertDirectory(layout.replies),
    assertDirectory(layout.cancelled),
    assertDirectory(layout.pi),
    assertDirectory(layout.piCcweb),
  ]);
}

async function removeKnownEndpoint(layout: BrokerLayout): Promise<void> {
  // A replaced critical directory makes the whole endpoint untrusted. Leave it
  // for a later non-following stale prune instead of touching an attacker path.
  await assertBrokerLayout(layout);
  await Promise.all([
    setDirectoryMode(layout.endpoint, 0o700),
    setDirectoryMode(layout.pi, 0o700),
    setDirectoryMode(layout.piCcweb, 0o700),
  ]);
  await Promise.all([
    safeCleanupFlat(layout.requests),
    safeCleanupFlat(layout.replies),
    safeCleanupFlat(layout.cancelled),
    safeCleanupFlat(layout.piCcweb),
  ]);
  await safeUnlink(layout.endpoint, path.join(layout.endpoint.path, 'ccweb-mcp.mjs'));
  await safeRmdir(layout.pi, 'ccweb', layout.piCcweb);
  await safeRmdir(layout.endpoint, '.pi', layout.pi);
  for (const folder of [layout.requests, layout.replies, layout.cancelled]) {
    await safeRmdir(layout.endpoint, path.basename(folder.path), folder);
  }
  await safeRmdir(layout.base, path.basename(layout.endpoint.path), layout.endpoint);
}

async function cleanOpenedChildDirectory(parent: OpenDirectory, name: string): Promise<void> {
  const target = childAccessPath(parent, name);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await fsp.unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  const child = await openChildDirectory(parent, name, { dev: stat.dev, ino: stat.ino });
  try {
    await child.handle.chmod(0o700);
    await cleanupOpenedFlat(child);
    await fsp.rmdir(target).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
    });
  } finally {
    await child.handle.close();
  }
}

async function pruneOpenedStaleEndpoint(
  base: OpenDirectory,
  endpoint: OpenDirectory,
  endpointName: string,
): Promise<void> {
  await endpoint.handle.chmod(0o700);
  for (const folder of ['requests', 'replies', 'cancelled'] as CriticalDirectoryName[]) {
    await cleanOpenedChildDirectory(endpoint, folder);
  }
  const piTarget = childAccessPath(endpoint, '.pi');
  const piStat = await fsp.lstat(piTarget).catch(() => null);
  if (piStat?.isDirectory() && !piStat.isSymbolicLink()) {
    const pi = await openChildDirectory(endpoint, '.pi', { dev: piStat.dev, ino: piStat.ino });
    try {
      await pi.handle.chmod(0o700);
      await cleanOpenedChildDirectory(pi, 'ccweb');
      await cleanupOpenedFlat(pi);
      await fsp.rmdir(piTarget).catch(() => undefined);
    } finally {
      await pi.handle.close();
    }
  } else if (piStat) {
    await fsp.unlink(piTarget).catch(() => undefined);
  }
  const entries = await fsp.readdir(endpoint.accessPath);
  for (const entry of entries) {
    const child = childAccessPath(endpoint, entry);
    const stat = await fsp.lstat(child).catch(() => null);
    if (stat && !stat.isDirectory()) await fsp.unlink(child).catch(() => undefined);
  }
  await fsp.rmdir(childAccessPath(base, endpointName)).catch(() => undefined);
}

async function pruneStaleEndpoints(base: DirectoryRef, before: number): Promise<void> {
  await withDirectory(base, 'cleanup', async (openedBase) => {
    const entries = await fsp.readdir(openedBase.accessPath);
    for (const entry of entries) {
      if (!ENDPOINT_NAME.test(entry)) continue;
      const target = childAccessPath(openedBase, entry);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        if (stat.mtimeMs < before) await fsp.unlink(target).catch(() => undefined);
        continue;
      }
      const endpoint = await openChildDirectory(openedBase, entry, { dev: stat.dev, ino: stat.ino })
        .catch(() => null);
      if (!endpoint) continue;
      try {
        let freshest = stat.mtimeMs;
        for (const folder of ['requests', 'replies', 'cancelled', '.pi']) {
          const child = await fsp.lstat(childAccessPath(endpoint, folder)).catch(() => null);
          if (child) freshest = Math.max(freshest, child.mtimeMs);
        }
        if (freshest < before) {
          await pruneOpenedStaleEndpoint(openedBase, endpoint, entry).catch(() => undefined);
        }
      } finally {
        await endpoint.handle.close();
      }
    }
  });
}

/** Host-side half. Keep one instance per chat session. */
export class FileCallbackBroker {
  private endpoint_: FileCallbackEndpoint | null = null;
  private layout: BrokerLayout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, AbortController>();
  private polling = false;
  private compromised = false;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;
  private readonly cleanupAfterMs: number;
  private readonly testHooks: FileCallbackTestHooks | undefined;

  constructor(private readonly sharedHome: string, options: FileCallbackBrokerOptions = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cleanupAfterMs = options.cleanupAfterMs ?? DEFAULT_CLEANUP_MS;
    this.testHooks = options.testHooks;
  }

  get endpoint(): FileCallbackEndpoint | null { return this.endpoint_; }

  async listen(handler: FileCallbackHandler): Promise<FileCallbackEndpoint> {
    if (this.endpoint_) return this.endpoint_;
    const home = await directoryRef(path.resolve(this.sharedHome));
    const base = await makeChildDirectory(home, '.ccweb-callback', true);
    await pruneStaleEndpoints(base, Date.now() - this.cleanupAfterMs);
    const endpoint = await makeChildDirectory(base, crypto.randomBytes(16).toString('hex'), false);
    const [requests, replies, cancelled] = await Promise.all([
      makeChildDirectory(endpoint, 'requests', false),
      makeChildDirectory(endpoint, 'replies', false),
      makeChildDirectory(endpoint, 'cancelled', false),
    ]);
    const pi = await makeChildDirectory(endpoint, '.pi', false);
    const piCcweb = await makeChildDirectory(pi, 'ccweb', false);
    this.layout = { base, endpoint, requests, replies, cancelled, pi, piCcweb };
    await writeExclusivePlain(piCcweb, 'ask-user.ts', '');
    await writeExclusivePlain(
      piCcweb,
      '.gitignore',
      [
        '# Written by code-agents-webcli: generated tools for this session.',
        '# Regenerated on every launch; nothing here is yours to keep.',
        '*',
        '',
      ].join('\n'),
    );
    await setDirectoryMode(this.layout.pi, 0o500);
    // Runtime artifacts are populated later, but their names are claimed now.
    // Sealing the parent here removes the validation-to-open window in which a
    // filesystem peer could replace requests/replies/cancelled. The bridge is
    // subsequently filled through this pre-created, O_NOFOLLOW file.
    await writeExclusivePlain(endpoint, 'ccweb-mcp.mjs', '');
    await setDirectoryMode(this.layout.piCcweb, 0o500);
    await setDirectoryMode(this.layout.endpoint, 0o500);
    this.endpoint_ = { directory: endpoint.path, token: crypto.randomBytes(32).toString('base64url') };
    await this.heartbeat();
    await this.lease();
    this.timer = setInterval(() => {
      void this.poll(handler).catch((error) => this.failClosed(error));
    }, this.pollMs);
    this.timer.unref();
    // Kept separate from the request poll: a question handler can intentionally
    // remain pending for hours, but a runtime must still be able to distinguish
    // that healthy wait from a server that disappeared underneath it.
    this.heartbeatTimer = setInterval(() => {
      if (this.active.size > 0) {
        void this.heartbeat().catch((error) => this.failClosed(error));
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
    // An idle but live chat must not look like a crashed endpoint to another
    // server sharing the same persistent home. Keep a low-frequency lease;
    // aggressive cleanup intervals used by tests get a proportionally shorter
    // lease so the invariant remains true there as well.
    const leaseMs = Math.max(10, Math.min(MAX_LEASE_MS, Math.floor(this.cleanupAfterMs / 3)));
    this.leaseTimer = setInterval(() => {
      void this.lease().catch((error) => this.failClosed(error));
    }, leaseMs);
    this.leaseTimer.unref();
    await this.poll(handler);
    return this.endpoint_;
  }

  async close(): Promise<void> {
    this.stopTimers();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    const layout = this.layout;
    this.endpoint_ = null;
    this.layout = null;
    if (layout) await removeKnownEndpoint(layout).catch(() => undefined);
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.leaseTimer = null;
  }

  private failClosed(_error: unknown): void {
    if (this.compromised) return;
    this.compromised = true;
    this.stopTimers();
    for (const controller of this.active.values()) controller.abort();
  }

  private async heartbeat(): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout || this.compromised) return;
    await assertBrokerLayout(layout);
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, 'heartbeat.json'),
      endpoint.token,
      `${AAD_PREFIX}heartbeat`,
      { ts: Date.now() },
    );
  }

  private async lease(): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout || this.compromised) return;
    await assertBrokerLayout(layout);
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, 'lease.json'),
      endpoint.token,
      `${AAD_PREFIX}lease`,
      { ts: Date.now() },
    );
  }

  private async poll(handler: FileCallbackHandler): Promise<void> {
    if (this.polling || !this.endpoint_ || !this.layout || this.compromised) return;
    this.polling = true;
    try {
      const endpoint = this.endpoint_;
      const layout = this.layout;
      await assertBrokerLayout(layout);
      const entries = await withDirectory(
        layout.requests,
        'read',
        async (opened) => fsp.readdir(opened.accessPath),
      );
      await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => {
        const id = entry.slice(0, -5);
        if (!ID.test(id) || this.active.has(id)) return;
        const file = path.join(layout.requests.path, entry);
        let raw: Partial<FileCallbackRequest> | null;
        try {
          raw = await readEncrypted(layout.requests, file, endpoint.token, aad('request', id)) as
            Partial<FileCallbackRequest> | null;
        } catch (error) {
          if (error instanceof InvalidCallbackEnvelopeError) {
            await safeUnlink(layout.requests, file);
            return;
          }
          throw error;
        }
        if (!raw || raw.id !== id || typeof raw.kind !== 'string' || typeof raw.createdAt !== 'number') {
          await safeUnlink(layout.requests, file);
          return;
        }
        // A request left by a stopped pod must never be revived by a later
        // session merely because it happens to be scanning the same home.
        if (raw.createdAt < Date.now() - this.cleanupAfterMs) {
          await safeUnlink(layout.requests, file);
          return;
        }
        const controller = new AbortController();
        this.active.set(id, controller);
        void this.handleRequest(
          handler,
          { id, kind: raw.kind, payload: raw.payload, createdAt: raw.createdAt },
          controller,
          file,
          path.join(layout.cancelled.path, cancelName(id)),
        ).catch((error) => this.failClosed(error));
      }));
      await Promise.all([
        safeCleanupFlat(
          layout.requests,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
        ),
        safeCleanupFlat(
          layout.replies,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
        ),
        safeCleanupFlat(
          layout.cancelled,
          Date.now() - this.cleanupAfterMs,
          this.testHooks?.afterDirectoryOpened,
        ),
      ]);
    } finally {
      this.polling = false;
    }
  }

  private async handleRequest(
    handler: FileCallbackHandler,
    request: FileCallbackRequest,
    controller: AbortController,
    requestFile: string,
    cancelFile: string,
  ): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout) return;
    const checkCancellation = async () => {
      try {
        const marker = await readEncrypted(
          layout.cancelled,
          cancelFile,
          endpoint.token,
          aad('cancel', request.id),
        ) as { id?: unknown } | null;
        if (marker?.id === request.id) controller.abort();
      } catch (error) {
        if (error instanceof InvalidCallbackEnvelopeError) {
          await safeUnlink(layout.cancelled, cancelFile);
          return;
        }
        controller.abort();
        this.failClosed(error);
      }
    };
    const cancelPoll = setInterval(() => { void checkCancellation(); }, this.pollMs);
    cancelPoll.unref();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref();
    try {
      const result = await Promise.race([
        handler(request, controller.signal),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener(
          'abort', () => reject(new Error('file callback cancelled')), { once: true },
        )),
      ]);
      await this.reply(request.id, controller.signal.aborted ? { cancelled: true } : { result });
    } catch (error: unknown) {
      await this.reply(request.id, controller.signal.aborted
        ? { cancelled: true }
        : { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(cancelPoll);
      clearTimeout(timeout);
      this.active.delete(request.id);
      await safeUnlink(layout.requests, requestFile).catch(() => undefined);
      await safeUnlink(layout.cancelled, cancelFile).catch(() => undefined);
    }
  }

  private async reply(id: string, reply: Omit<FileCallbackReply, 'id'>): Promise<void> {
    const endpoint = this.endpoint_;
    const layout = this.layout;
    if (!endpoint || !layout) return;
    await atomicEncrypted(
      layout.replies,
      path.join(layout.replies.path, replyName(id)),
      endpoint.token,
      aad('reply', id),
      { id, ...reply },
    );
  }
}

export interface FileCallbackClientOptions {
  pollMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  testHooks?: FileCallbackTestHooks;
}

interface ClientLayout {
  base: DirectoryRef;
  endpoint: DirectoryRef;
  requests: DirectoryRef;
  replies: DirectoryRef;
  cancelled: DirectoryRef;
}

async function captureClientLayout(directory: string): Promise<ClientLayout> {
  const base = await directoryRef(path.dirname(directory));
  return withDirectory(base, 'read', async (openedBase) => {
    const openedEndpoint = await openChildDirectory(openedBase, path.basename(directory));
    try {
      const endpoint = { path: directory, ...openedEndpoint.identity };
      const openedChildren: OpenDirectory[] = [];
      try {
        for (const name of ['requests', 'replies', 'cancelled']) {
          openedChildren.push(await openChildDirectory(openedEndpoint, name));
        }
        return {
          base,
          endpoint,
          requests: { path: path.join(directory, 'requests'), ...openedChildren[0].identity },
          replies: { path: path.join(directory, 'replies'), ...openedChildren[1].identity },
          cancelled: { path: path.join(directory, 'cancelled'), ...openedChildren[2].identity },
        };
      } finally {
        await Promise.all(openedChildren.map((opened) => opened.handle.close()));
      }
    } finally {
      await openedEndpoint.handle.close();
    }
  });
}

async function assertClientLayout(layout: ClientLayout): Promise<void> {
  await Promise.all([
    assertDirectory(layout.base),
    assertDirectory(layout.endpoint),
    assertDirectory(layout.requests),
    assertDirectory(layout.replies),
    assertDirectory(layout.cancelled),
  ]);
}

/** Runtime-side half; safe to use from a generated stdio MCP bridge. */
export async function requestFileCallback(
  endpoint: FileCallbackEndpoint,
  kind: FileCallbackKind,
  payload: unknown,
  options: FileCallbackClientOptions = {},
): Promise<unknown> {
  const layout = await captureClientLayout(endpoint.directory);
  await assertClientLayout(layout);
  const id = crypto.randomBytes(16).toString('base64url');
  const request = path.join(layout.requests.path, requestName(id));
  const reply = path.join(layout.replies.path, replyName(id));
  const cancel = path.join(layout.cancelled.path, cancelName(id));
  const heartbeat = path.join(layout.replies.path, 'heartbeat.json');
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stopped = false;
  const cancelRequest = () => {
    if (!stopped) {
      void atomicEncrypted(
        layout.cancelled,
        cancel,
        endpoint.token,
        aad('cancel', id),
        { id, cancelledAt: Date.now() },
        options.testHooks?.afterDirectoryOpened,
      ).catch(() => undefined);
    }
  };
  options.signal?.addEventListener('abort', cancelRequest, { once: true });
  await atomicEncrypted(
    layout.requests,
    request,
    endpoint.token,
    aad('request', id),
    { id, kind, payload, createdAt: Date.now() } satisfies FileCallbackRequest,
    options.testHooks?.afterDirectoryOpened,
  );
  const initialPulse = await readEncrypted(
    layout.replies,
    heartbeat,
    endpoint.token,
    `${AAD_PREFIX}heartbeat`,
    options.testHooks?.afterDirectoryOpened,
  ) as { ts?: unknown } | null;
  let lastPulse = typeof initialPulse?.ts === 'number' ? initialPulse.ts : null;
  let lastPulseChange = Date.now();
  const deadline = Date.now() + timeoutMs;
  let nextLivenessCheck = Date.now() + HEARTBEAT_STALE_MS;
  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('file callback cancelled');
      const raw = await readEncrypted(
        layout.replies,
        reply,
        endpoint.token,
        aad('reply', id),
        options.testHooks?.afterDirectoryOpened,
      ) as
        Partial<FileCallbackReply> | null;
      if (raw) {
        if (raw.id !== id) throw new Error('file callback received an invalid reply');
        if (raw.cancelled) throw new Error('file callback cancelled');
        if (raw.error) throw new Error(raw.error);
        return raw.result;
      }
      if (Date.now() >= nextLivenessCheck) {
        const pulse = await readEncrypted(
          layout.replies,
          heartbeat,
          endpoint.token,
          `${AAD_PREFIX}heartbeat`,
          options.testHooks?.afterDirectoryOpened,
        ) as { ts?: unknown } | null;
        if (!pulse || typeof pulse.ts !== 'number') {
          throw new Error('file callback server is unavailable');
        }
        if (pulse.ts !== lastPulse) {
          lastPulse = pulse.ts;
          lastPulseChange = Date.now();
        } else if (Date.now() - lastPulseChange >= HEARTBEAT_STALE_MS) {
          throw new Error('file callback server is unavailable');
        }
        nextLivenessCheck = Date.now() + HEARTBEAT_MS;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('file callback timed out');
  } finally {
    stopped = true;
    options.signal?.removeEventListener('abort', cancelRequest);
    if (Date.now() >= deadline || options.signal?.aborted) {
      await atomicEncrypted(
        layout.cancelled,
        cancel,
        endpoint.token,
        aad('cancel', id),
        { id, cancelledAt: Date.now() },
        options.testHooks?.afterDirectoryOpened,
      ).catch(() => undefined);
    }
    await safeUnlink(layout.requests, request, options.testHooks?.afterDirectoryOpened).catch(() => undefined);
    await safeUnlink(layout.replies, reply, options.testHooks?.afterDirectoryOpened).catch(() => undefined);
  }
}

/**
 * Plain JavaScript embedded into generated remote clients. Keeping one source
 * here prevents the MCP bridge and pi extension from drifting onto different
 * crypto or path-validation protocols.
 */
export const FILE_CALLBACK_GENERATED_CLIENT_SOURCE = String.raw`
const CALLBACK_AAD_PREFIX = 'ccweb-file-callback-v1:';
const CALLBACK_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

function callbackAad(kind, id) { return CALLBACK_AAD_PREFIX + kind + ':' + id; }
function callbackKey(token) {
  return crypto.createHash('sha256').update('ccweb-file-callback-key-v1\0').update(token).digest();
}
function callbackSameDirectory(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
function callbackFdAccessPath(handle) {
  return process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : '/dev/fd/' + handle.fd;
}
function callbackChildName(file) {
  const name = path.basename(file);
  if (!name || name === '.' || name === '..' || name.includes('/') ||
      name.includes('\\') || name.includes('\0')) {
    throw new Error('unsafe callback child: ' + file);
  }
  return name;
}
function callbackChildPath(opened, file) {
  return path.join(opened.accessPath, callbackChildName(file));
}
async function callbackOpenDirectory(directory, expected) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('unsafe callback directory: ' + directory);
  }
  try {
    const stat = await handle.stat();
    const identity = { dev: stat.dev, ino: stat.ino };
    if (!stat.isDirectory() || (expected && !callbackSameDirectory(identity, expected))) {
      throw new Error('unsafe callback directory: ' + directory);
    }
    const accessPath = callbackFdAccessPath(handle);
    const anchored = await fs.stat(accessPath).catch(() => null);
    if (!anchored || !anchored.isDirectory() || !callbackSameDirectory(anchored, identity)) {
      throw new Error('callback fd access is unavailable');
    }
    return { handle, accessPath, path: directory, ...identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
async function callbackDirectory(directory, expected) {
  const opened = await callbackOpenDirectory(directory, expected);
  await opened.handle.close();
  return { path: directory, dev: opened.dev, ino: opened.ino };
}
async function callbackVerifyVisible(directory, opened) {
  const visible = await callbackOpenDirectory(directory.path, directory).catch(() => null);
  if (!visible) throw new Error('unsafe callback directory: ' + directory.path);
  try {
    const current = await opened.handle.stat();
    if (!callbackSameDirectory(current, visible)) {
      throw new Error('unsafe callback directory: ' + directory.path);
    }
  } finally {
    await visible.handle.close();
  }
}
async function callbackWithDirectory(directory, operation) {
  const opened = await callbackOpenDirectory(directory.path, directory);
  try {
    const result = await operation(opened);
    await callbackVerifyVisible(directory, opened);
    return result;
  } finally {
    await opened.handle.close();
  }
}
async function callbackAssertDirectory(directory) {
  await callbackWithDirectory(directory, async () => undefined);
}
async function callbackLayout(directory) {
  const base = await callbackDirectory(path.dirname(directory));
  const layout = await callbackWithDirectory(base, async (openedBase) => {
    const openedEndpoint = await callbackOpenDirectory(
      callbackChildPath(openedBase, path.basename(directory)),
    );
    try {
      const children = [];
      try {
        for (const name of ['requests', 'replies', 'cancelled']) {
          children.push(await callbackOpenDirectory(callbackChildPath(openedEndpoint, name)));
        }
        return {
          base,
          endpoint: { path: directory, dev: openedEndpoint.dev, ino: openedEndpoint.ino },
          requests: { path: path.join(directory, 'requests'), dev: children[0].dev, ino: children[0].ino },
          replies: { path: path.join(directory, 'replies'), dev: children[1].dev, ino: children[1].ino },
          cancelled: { path: path.join(directory, 'cancelled'), dev: children[2].dev, ino: children[2].ino },
        };
      } finally {
        await Promise.all(children.map((child) => child.handle.close()));
      }
    } finally {
      await openedEndpoint.handle.close();
    }
  });
  await callbackAssertLayout(layout);
  return layout;
}
async function callbackAssertLayout(layout) {
  await Promise.all([
    callbackAssertDirectory(layout.base),
    callbackAssertDirectory(layout.endpoint),
    callbackAssertDirectory(layout.requests),
    callbackAssertDirectory(layout.replies),
    callbackAssertDirectory(layout.cancelled),
  ]);
}
function callbackEncrypt(token, associatedData, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', callbackKey(token), iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}
function callbackDecrypt(token, associatedData, value) {
  try {
    if (!value || value.v !== 1 || typeof value.iv !== 'string' ||
        typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') {
      throw new Error('invalid envelope');
    }
    const iv = Buffer.from(value.iv, 'base64url');
    const tag = Buffer.from(value.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', callbackKey(token), iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('invalid encrypted callback envelope');
  }
}
async function callbackAtomic(directory, file, token, associatedData, value) {
  await callbackWithDirectory(directory, async (opened) => {
    const targetName = callbackChildName(file);
    const target = callbackChildPath(opened, targetName);
    const temporary = callbackChildPath(
      opened, targetName + '.' + crypto.randomBytes(12).toString('hex') + '.tmp',
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(callbackEncrypt(token, associatedData, value)), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  });
}
async function callbackRead(directory, file, token, associatedData) {
  return callbackWithDirectory(directory, async (opened) => {
    let handle;
    try {
      handle = await fs.open(callbackChildPath(opened, file), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('unsafe callback file: ' + file);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CALLBACK_MAX_ENVELOPE_BYTES) {
        throw new Error('invalid encrypted callback envelope');
      }
      const serialized = await handle.readFile({ encoding: 'utf8' });
      return callbackDecrypt(token, associatedData, JSON.parse(serialized));
    } catch (error) {
      if (error?.message?.startsWith('unsafe callback')) throw error;
      throw new Error('invalid encrypted callback envelope');
    } finally {
      await handle.close();
    }
  });
}
async function callbackUnlink(directory, file) {
  await callbackWithDirectory(directory, async (opened) => {
    await fs.unlink(callbackChildPath(opened, file))
      .catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  });
}
`;
