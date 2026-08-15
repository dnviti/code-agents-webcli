import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One server is the sole writer of an installation data directory.
 *
 * SQLite serialises individual transactions, but it cannot make the
 * multi-file legacy-session cutover atomic with respect to a second server.
 * This process lease therefore sits outside SQLite and is acquired before
 * startup reads or migrates any session state.
 */
export const DATA_DIR_LEASE_DIRECTORY = '.cc-web-server.lease';
/** `sysexits.h` EX_SOFTWARE: the sole-writer invariant was lost. */
export const DATA_DIR_LEASE_LOST_EXIT_CODE = 70;
const DATA_DIR_LEASE_GUARD_DIRECTORY = '.cc-web-server.lease.guard';
const OWNER_FILE = 'owner.json';
const HEARTBEAT_FILE = 'heartbeat.json';
const OWNER_VERSION = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_GUARD_WAIT_MS = 2_000;
const DEFAULT_GUARD_POLL_MS = 25;
const MAX_METADATA_BYTES = 8 * 1024;
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1_000);

interface LeaseOwner {
  version: 1;
  token: string;
  pid: number;
  processStartIdentity: string;
  acquiredAt: number;
}

interface LeaseHeartbeat {
  version: 1;
  token: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface LeaseSnapshot {
  path: string;
  identity: FileIdentity;
  owner: LeaseOwner | null;
  recoverable: boolean;
  lastHeartbeatAt: number | null;
  reason: string;
}

interface OwnedDirectory {
  path: string;
  identity: FileIdentity;
  owner: LeaseOwner;
  heartbeatFd: number;
}

interface ProcessProbe {
  state: 'alive' | 'dead' | 'unknown';
  startIdentity: string | null;
}

export interface DataDirLeaseOptions {
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  guardWaitMs?: number;
  guardPollMs?: number;
  now?: () => number;
  /** Deterministic test seam; production always uses cryptographic tokens. */
  token?: string;
  onLost?: (error: Error) => void;
}

export class DataDirLeaseBusyError extends Error {
  readonly code = 'data_dir_in_use';
  readonly ownerPid: number | null;
  readonly lastHeartbeatAt: number | null;

  constructor(snapshot: LeaseSnapshot | null, detail?: string) {
    const owner = snapshot?.owner;
    super(
      detail
        || (owner
          ? `Data directory is already owned by server process ${owner.pid}`
          : 'Data directory is already owned by another server process'),
    );
    this.name = 'DataDirLeaseBusyError';
    this.ownerPid = owner?.pid ?? null;
    this.lastHeartbeatAt = snapshot?.lastHeartbeatAt ?? null;
  }
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validOwner(value: unknown): value is LeaseOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<LeaseOwner>;
  return owner.version === OWNER_VERSION
    && validToken(owner.token)
    && Number.isSafeInteger(owner.pid)
    && Number(owner.pid) > 0
    && typeof owner.processStartIdentity === 'string'
    && owner.processStartIdentity.length > 0
    && owner.processStartIdentity.length <= 512
    && Number.isFinite(owner.acquiredAt)
    && Number(owner.acquiredAt) > 0;
}

function validHeartbeat(value: unknown): value is LeaseHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const heartbeat = value as Partial<LeaseHeartbeat>;
  return heartbeat.version === OWNER_VERSION && validToken(heartbeat.token);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // Some platforms report inode zero for handles which cannot establish file
  // identity. Failing closed is safer than retiring an unproven directory.
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function directoryIdentity(target: string): FileIdentity {
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe data-directory lease entry: ${target}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function statMtimeMs(stat: fs.BigIntStats): number {
  return Number(stat.mtimeNs / 1_000_000n);
}

function readSmallJson(target: string): { value: unknown; stat: fs.BigIntStats } | null {
  let visible: fs.BigIntStats;
  try {
    visible = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (visible.isSymbolicLink() || !visible.isFile() || visible.size > BigInt(MAX_METADATA_BYTES)) {
    throw new Error(`Unsafe data-directory lease metadata: ${target}`);
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile()
      || opened.size > BigInt(MAX_METADATA_BYTES)
      || !sameIdentity(
        { dev: visible.dev, ino: visible.ino },
        { dev: opened.dev, ino: opened.ino },
      )
    ) {
      throw new Error(`Data-directory lease metadata changed while opening: ${target}`);
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_METADATA_BYTES) {
      throw new Error(`Oversized data-directory lease metadata: ${target}`);
    }
    return { value: JSON.parse(bytes.toString('utf8')), stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}

function linuxProcessStartIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // Fields after the command begin at field 3. Process start ticks are field
    // 22, therefore index 19 in this tail.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) return null;
    let bootId = 'unknown-boot';
    try {
      bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || bootId;
    } catch {
      // The kernel start tick is still a process-incarnation identity within
      // this boot; the fallback only loses cross-boot diagnostics.
    }
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

function psProcessStartIdentity(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const started = String(result.stdout || '').trim().replace(/\s+/gu, ' ');
  return started ? `${process.platform}:${started}` : null;
}

function windowsProcessStartIdentity(pid: number): string | null {
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    '[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const ticks = String(result.stdout || '').trim();
  return /^\d+$/u.test(ticks) ? `win32:${ticks}` : null;
}

function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxProcessStartIdentity(pid);
  if (process.platform === 'win32') return windowsProcessStartIdentity(pid);
  return psProcessStartIdentity(pid);
}

function currentProcessStartIdentity(): string {
  return processStartIdentity(process.pid)
    || `runtime:${process.platform}:${PROCESS_STARTED_AT_MS}`;
}

function probeProcess(owner: LeaseOwner): ProcessProbe {
  const observedIdentity = processStartIdentity(owner.pid);
  if (observedIdentity) {
    return { state: 'alive', startIdentity: observedIdentity };
  }
  try {
    process.kill(owner.pid, 0);
    // The process exists, but its incarnation cannot be proved. Never reclaim
    // from that ambiguous state.
    return { state: 'alive', startIdentity: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { state: 'alive', startIdentity: null };
    if (code === 'ESRCH') return { state: 'dead', startIdentity: null };
    return { state: 'unknown', startIdentity: null };
  }
}

function writePrivateJson(target: string, value: unknown): number {
  const fd = fs.openSync(
    target,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function createOwnedDirectory(
  target: string,
  token: string,
  now: number,
): OwnedDirectory {
  fs.mkdirSync(target, { mode: 0o700 });
  let heartbeatFd = -1;
  try {
    fs.chmodSync(target, 0o700);
    const owner: LeaseOwner = {
      version: OWNER_VERSION,
      token,
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
      acquiredAt: now,
    };
    const ownerFd = writePrivateJson(path.join(target, OWNER_FILE), owner);
    fs.closeSync(ownerFd);
    heartbeatFd = writePrivateJson(path.join(target, HEARTBEAT_FILE), {
      version: OWNER_VERSION,
      token,
    } satisfies LeaseHeartbeat);
    const seconds = now / 1_000;
    fs.futimesSync(heartbeatFd, seconds, seconds);
    const identity = directoryIdentity(target);
    // Persist the two directory entries before another process is allowed past
    // the operation guard.
    try {
      const directoryFd = fs.openSync(target, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch (error) {
      // Windows and a few network filesystems do not permit opening/fsyncing a
      // directory handle. The exclusively-created metadata files themselves
      // remain durable and ownership-safe there.
      if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(
        String((error as NodeJS.ErrnoException).code || ''),
      )) {
        throw error;
      }
    }
    return { path: target, identity, owner, heartbeatFd };
  } catch (error) {
    if (heartbeatFd >= 0) fs.closeSync(heartbeatFd);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Preserve the creation error. A partial directory remains fail-closed
      // until the conservative stale-initialisation threshold passes.
    }
    throw error;
  }
}

function inspectOwnedDirectory(
  target: string,
  now: number,
  staleAfterMs: number,
): LeaseSnapshot | null {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe data-directory lease entry: ${target}`);
  }
  const identity = { dev: stat.dev, ino: stat.ino };
  let ownerRead: ReturnType<typeof readSmallJson>;
  try {
    ownerRead = readSmallJson(path.join(target, OWNER_FILE));
  } catch (error) {
    return {
      path: target,
      identity,
      owner: null,
      recoverable: false,
      lastHeartbeatAt: null,
      reason: error instanceof Error ? error.message : 'invalid owner metadata',
    };
  }
  if (!ownerRead) {
    const empty = fs.readdirSync(target).length === 0;
    return {
      path: target,
      identity,
      owner: null,
      // A process can be stopped in the tiny interval between mkdir and its
      // first metadata write. With no PID/incarnation there is no proof that
      // process is dead, so even an old empty directory must fail closed.
      recoverable: false,
      lastHeartbeatAt: statMtimeMs(stat),
      reason: empty ? 'incomplete lease initialisation' : 'lease owner metadata is missing',
    };
  }
  if (!validOwner(ownerRead.value)) {
    return {
      path: target,
      identity,
      owner: null,
      recoverable: false,
      lastHeartbeatAt: statMtimeMs(ownerRead.stat),
      reason: 'invalid lease owner metadata',
    };
  }
  const owner = ownerRead.value;
  let heartbeatRead: ReturnType<typeof readSmallJson>;
  try {
    heartbeatRead = readSmallJson(path.join(target, HEARTBEAT_FILE));
  } catch (error) {
    return {
      path: target,
      identity,
      owner,
      recoverable: false,
      lastHeartbeatAt: null,
      reason: error instanceof Error ? error.message : 'invalid heartbeat metadata',
    };
  }
  if (heartbeatRead && (!validHeartbeat(heartbeatRead.value) || heartbeatRead.value.token !== owner.token)) {
    return {
      path: target,
      identity,
      owner,
      recoverable: false,
      lastHeartbeatAt: statMtimeMs(heartbeatRead.stat),
      reason: 'heartbeat ownership does not match the lease owner',
    };
  }
  const lastHeartbeatAt = Math.max(
    owner.acquiredAt,
    statMtimeMs(ownerRead.stat),
    heartbeatRead ? statMtimeMs(heartbeatRead.stat) : 0,
  );
  if (now - lastHeartbeatAt <= staleAfterMs) {
    return {
      path: target,
      identity,
      owner,
      recoverable: false,
      lastHeartbeatAt,
      reason: 'lease heartbeat is current',
    };
  }
  const processProbe = probeProcess(owner);
  const ownerIdentityIsVerifiable = !owner.processStartIdentity.startsWith('runtime:')
    && !owner.processStartIdentity.includes(':unknown-boot:');
  const exactOwnerAlive = processProbe.state === 'alive'
    && (
      processProbe.startIdentity === null
      || !ownerIdentityIsVerifiable
      || processProbe.startIdentity === owner.processStartIdentity
    );
  if (exactOwnerAlive || processProbe.state === 'unknown') {
    return {
      path: target,
      identity,
      owner,
      recoverable: false,
      lastHeartbeatAt,
      reason: exactOwnerAlive
        ? 'lease process incarnation is still alive'
        : 'lease process state is unknown',
    };
  }
  return {
    path: target,
    identity,
    owner,
    recoverable: true,
    lastHeartbeatAt,
    reason: processProbe.state === 'dead'
      ? 'lease process is gone and its heartbeat is stale'
      : 'lease PID belongs to a different process incarnation and its heartbeat is stale',
  };
}

function removeClaimedDirectory(target: string, expected: LeaseSnapshot): void {
  const visible = directoryIdentity(target);
  if (!sameIdentity(visible, expected.identity)) {
    throw new Error('Data-directory lease changed before it could be claimed');
  }
  const currentOwner = readSmallJson(path.join(target, OWNER_FILE));
  if (expected.owner) {
    if (!currentOwner || !validOwner(currentOwner.value) || currentOwner.value.token !== expected.owner.token) {
      throw new Error('Data-directory lease ownership changed before it could be claimed');
    }
  } else if (currentOwner) {
    throw new Error('Incomplete data-directory lease gained an owner before it could be claimed');
  }

  const retired = `${target}.retired-${randomBytes(16).toString('hex')}`;
  fs.renameSync(target, retired);
  const claimed = directoryIdentity(retired);
  if (!sameIdentity(claimed, expected.identity)) {
    // This should be unreachable for a same-filesystem rename, but never
    // recursively remove an inode whose identity was not proved.
    if (!fs.existsSync(target)) fs.renameSync(retired, target);
    throw new Error('Claimed data-directory lease has an unexpected identity');
  }
  fs.rmSync(retired, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return resolved;
}

export class DataDirLease {
  readonly dataDir: string;
  readonly leasePath: string;
  private readonly guardPath: string;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly guardWaitMs: number;
  private readonly guardPollMs: number;
  private readonly now: () => number;
  private readonly token: string;
  private readonly onLost?: (error: Error) => void;
  private owned: OwnedDirectory | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private releasing = false;

  private constructor(dataDir: string, options: DataDirLeaseOptions) {
    const requested = path.resolve(dataDir);
    try {
      fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const resolved = fs.realpathSync(requested);
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The server data directory must be a real directory');
    }
    if (resolved === path.parse(resolved).root) {
      throw new Error('Refusing to lease a filesystem root as the server data directory');
    }
    this.dataDir = resolved;
    this.leasePath = path.join(resolved, DATA_DIR_LEASE_DIRECTORY);
    this.guardPath = path.join(resolved, DATA_DIR_LEASE_GUARD_DIRECTORY);
    this.heartbeatIntervalMs = positiveNumber(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs',
    );
    this.staleAfterMs = positiveNumber(
      options.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
      'staleAfterMs',
    );
    if (this.staleAfterMs <= this.heartbeatIntervalMs) {
      throw new Error('staleAfterMs must be greater than heartbeatIntervalMs');
    }
    this.guardWaitMs = positiveNumber(options.guardWaitMs, DEFAULT_GUARD_WAIT_MS, 'guardWaitMs');
    this.guardPollMs = positiveNumber(options.guardPollMs, DEFAULT_GUARD_POLL_MS, 'guardPollMs');
    this.now = options.now ?? Date.now;
    this.token = options.token ?? randomBytes(32).toString('hex');
    if (!validToken(this.token)) throw new Error('Lease token must be 32-byte lowercase hex');
    this.onLost = options.onLost;
  }

  static async acquire(dataDir: string, options: DataDirLeaseOptions = {}): Promise<DataDirLease> {
    const lease = new DataDirLease(dataDir, options);
    await lease.acquireInternal();
    return lease;
  }

  /** Constructor-safe acquisition used before AppDatabase opens or migrates. */
  static acquireSync(dataDir: string, options: DataDirLeaseOptions = {}): DataDirLease {
    const lease = new DataDirLease(dataDir, options);
    lease.acquireInternalSync();
    return lease;
  }

  private async acquireGuard(): Promise<OwnedDirectory> {
    const deadline = this.now() + this.guardWaitMs;
    for (;;) {
      const guardToken = randomBytes(32).toString('hex');
      try {
        return createOwnedDirectory(this.guardPath, guardToken, this.now());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const snapshot = inspectOwnedDirectory(this.guardPath, this.now(), this.staleAfterMs);
      if (snapshot?.recoverable) {
        removeClaimedDirectory(this.guardPath, snapshot);
        continue;
      }
      if (this.now() >= deadline) {
        throw new DataDirLeaseBusyError(snapshot, 'Data-directory lease operation is already in progress');
      }
      await delay(this.guardPollMs);
    }
  }

  private acquireGuardSync(): OwnedDirectory {
    const deadline = this.now() + this.guardWaitMs;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      const guardToken = randomBytes(32).toString('hex');
      try {
        return createOwnedDirectory(this.guardPath, guardToken, this.now());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const snapshot = inspectOwnedDirectory(this.guardPath, this.now(), this.staleAfterMs);
      if (snapshot?.recoverable) {
        removeClaimedDirectory(this.guardPath, snapshot);
        continue;
      }
      if (this.now() >= deadline) {
        throw new DataDirLeaseBusyError(snapshot, 'Data-directory lease operation is already in progress');
      }
      Atomics.wait(
        sleeper,
        0,
        0,
        Math.min(this.guardPollMs, Math.max(1, deadline - this.now())),
      );
    }
  }

  private releaseOwnedDirectory(owned: OwnedDirectory): boolean {
    try {
      fs.closeSync(owned.heartbeatFd);
    } catch {
      // Closing twice is harmless to ownership validation below.
    }
    const snapshot = inspectOwnedDirectory(owned.path, this.now(), this.staleAfterMs);
    if (!snapshot) return true;
    if (
      !snapshot.owner
      || snapshot.owner.token !== owned.owner.token
      || !sameIdentity(snapshot.identity, owned.identity)
    ) {
      return false;
    }
    removeClaimedDirectory(owned.path, snapshot);
    return true;
  }

  private async withGuard<T>(operation: () => T | Promise<T>): Promise<T> {
    const guard = await this.acquireGuard();
    try {
      return await operation();
    } finally {
      if (!this.releaseOwnedDirectory(guard)) {
        throw new Error('Lost ownership of the data-directory lease operation guard');
      }
    }
  }

  private withGuardSync<T>(operation: () => T): T {
    const guard = this.acquireGuardSync();
    try {
      return operation();
    } finally {
      if (!this.releaseOwnedDirectory(guard)) {
        throw new Error('Lost ownership of the data-directory lease operation guard');
      }
    }
  }

  private beginHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async acquireInternal(): Promise<void> {
    await this.withGuard(() => {
      const existing = inspectOwnedDirectory(this.leasePath, this.now(), this.staleAfterMs);
      if (existing) {
        if (!existing.recoverable) throw new DataDirLeaseBusyError(existing);
        removeClaimedDirectory(this.leasePath, existing);
      }
      this.owned = createOwnedDirectory(this.leasePath, this.token, this.now());
    });
    this.beginHeartbeat();
  }

  private acquireInternalSync(): void {
    this.withGuardSync(() => {
      const existing = inspectOwnedDirectory(this.leasePath, this.now(), this.staleAfterMs);
      if (existing) {
        if (!existing.recoverable) throw new DataDirLeaseBusyError(existing);
        removeClaimedDirectory(this.leasePath, existing);
      }
      this.owned = createOwnedDirectory(this.leasePath, this.token, this.now());
    });
    this.beginHeartbeat();
  }

  private heartbeat(): void {
    const owned = this.owned;
    if (!owned || this.releasing) return;
    try {
      const visible = directoryIdentity(owned.path);
      if (!sameIdentity(visible, owned.identity)) {
        throw new Error('Data-directory lease directory was replaced');
      }
      const ownerRead = readSmallJson(path.join(owned.path, OWNER_FILE));
      if (!ownerRead || !validOwner(ownerRead.value) || ownerRead.value.token !== owned.owner.token) {
        throw new Error('Data-directory lease ownership was replaced');
      }
      const seconds = this.now() / 1_000;
      fs.futimesSync(owned.heartbeatFd, seconds, seconds);
      const heartbeatRead = readSmallJson(path.join(owned.path, HEARTBEAT_FILE));
      if (
        !heartbeatRead
        || !validHeartbeat(heartbeatRead.value)
        || heartbeatRead.value.token !== owned.owner.token
      ) {
        throw new Error('Data-directory lease heartbeat was replaced');
      }
      const opened = fs.fstatSync(owned.heartbeatFd, { bigint: true });
      if (!sameIdentity(
        { dev: opened.dev, ino: opened.ino },
        { dev: heartbeatRead.stat.dev, ino: heartbeatRead.stat.ino },
      )) {
        throw new Error('Data-directory lease heartbeat inode was replaced');
      }
    } catch (error) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.onLost?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Remove only the lease created by this instance. A replaced token or inode
   * is left untouched and reported as `false`.
   */
  async release(): Promise<boolean> {
    if (this.releasing) return false;
    const owned = this.owned;
    if (!owned) return true;
    this.releasing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      const released = await this.withGuard(() => this.releaseOwnedDirectory(owned));
      this.owned = null;
      return released;
    } finally {
      this.releasing = false;
    }
  }

  /** Synchronous counterpart for constructor failure and `process.exit()`. */
  releaseSync(): boolean {
    if (this.releasing) return false;
    const owned = this.owned;
    if (!owned) return true;
    this.releasing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      const released = this.withGuardSync(() => this.releaseOwnedDirectory(owned));
      this.owned = null;
      return released;
    } finally {
      this.releasing = false;
    }
  }
}
