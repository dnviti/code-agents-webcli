/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this module only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { SqliteDatabase } from '../sqlite.js';
import type { WorkspaceStorageDirectoryLease } from '../workspace-session-storage.js';
import {
  publishLargeWorkspaceCwdFile,
  listWorkspaceCwdEntries,
  readWorkspaceCwdAuthorityClaim,
  readCompleteWorkspaceCwdFile,
  removeWorkspaceCwdEntry,
  runWorkspaceCwdHelper,
} from '../workspace-cwd-helper.js';
import {
  WRITER_LEASE_NAME,
  WRITER_GUARD_NAME,
  WRITER_GUARD_CLAIM_NAME,
  WRITER_LEASE_CLAIM_NAME,
  WRITER_RETIRE_RECOVERY_A,
  WRITER_RETIRE_RECOVERY_B,
  RENAME_RECOVERY_A,
  RENAME_RECOVERY_B,
  MAX_SERIALIZED_DATABASE_BYTES,
  NO_FOLLOW,
} from './constants.js';
import {
  unsafeWorkspaceFile,
  verifyWorkspaceFileBinding,
  hardenWorkspaceFile,
  openExistingWorkspaceFile,
} from './file-utils.js';

function createWorkspaceAuthorityEntry(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
  bytes: Uint8Array,
): { dev: bigint; ino: bigint } {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    try {
      const created = runWorkspaceCwdHelper(lease, {
        operation: 'create', name, data: bytes, mode: 0o600,
      });
      if (created.dev === undefined || created.ino === undefined) {
        throw unsafeWorkspaceFile('Workspace writer authority omitted its created identity');
      }
      return { dev: created.dev, ino: created.ino };
    } catch (error) {
      // The per-attempt owner token makes a completed create distinguishable
      // from a raced entry when the helper mutates durably but loses its reply.
      try {
        const created = readWorkspaceAuthorityEntry(lease, name);
        if (created.bytes.equals(Buffer.from(bytes))) {
          // The helper already fsynced the file and attempted its platform
          // directory durability step before the lost response. Win32/libuv
          // cannot fsync a directory handle; the exact token readback plus cwd
          // binding is the available confirmation there.
          if (process.platform !== 'win32') fs.fsyncSync(lease.fd);
          lease.verify();
          return created.identity;
        }
      } catch { /* Preserve the original helper failure. */ }
      throw error;
    }
  }
  lease.verify();
  const access = path.join(lease.accessPath, name);
  const visible = path.join(lease.canonicalPath, name);
  const fd = fs.openSync(
    access,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, bytes);
    hardenWorkspaceFile(fd);
    fs.fsyncSync(fd);
    verifyWorkspaceFileBinding(visible, fd);
    lease.verify();
    const stat = fs.fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    fs.closeSync(fd);
  }
}

export function readWorkspaceAuthorityEntry(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
): { identity: { dev: bigint; ino: bigint }; bytes: Buffer } {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    const read = readCompleteWorkspaceCwdFile(lease, name, 16_384);
    return { identity: read.identity, bytes: read.data };
  }
  const fd = openExistingWorkspaceFile(lease, path.join(lease.canonicalPath, name));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.size > 16_384n) throw unsafeWorkspaceFile('Workspace writer authority is too large');
    return { identity: { dev: stat.dev, ino: stat.ino }, bytes: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

function readWorkspaceAuthorityClaim(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
): { identity: { dev: bigint; ino: bigint }; bytes: Buffer; nlink: bigint } {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    const read = readWorkspaceCwdAuthorityClaim(lease, name);
    return { identity: read.identity, bytes: read.data, nlink: read.nlink };
  }
  lease.verify();
  const access = path.join(lease.accessPath, name);
  const before = fs.lstatSync(access, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink < 1n || before.nlink > 3n) {
    throw unsafeWorkspaceFile('Workspace writer authority claim is unsafe');
  }
  const fd = fs.openSync(access, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const after = fs.lstatSync(access, { bigint: true });
    if (!opened.isFile() || opened.size > 16_384n
      || opened.dev !== before.dev || opened.ino !== before.ino
      || after.dev !== before.dev || after.ino !== before.ino
      || after.nlink !== opened.nlink || opened.nlink < 1n || opened.nlink > 3n) {
      throw unsafeWorkspaceFile('Workspace writer authority claim changed while opening');
    }
    lease.verify();
    return {
      identity: { dev: opened.dev, ino: opened.ino },
      bytes: fs.readFileSync(fd),
      nlink: opened.nlink,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function unlinkWorkspaceAuthorityEntry(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
  expected: { dev: bigint; ino: bigint },
): void {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    removeWorkspaceCwdEntry(lease, name, expected);
    return;
  }
  lease.verify();
  const access = path.join(lease.accessPath, name);
  const current = fs.lstatSync(access, { bigint: true });
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n
    || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw unsafeWorkspaceFile('Workspace writer authority changed before unlink');
  }
  fs.unlinkSync(access);
  lease.verify();
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processIncarnation(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return startTicks && boot ? `linux:${boot}:${startTicks}` : null;
    } catch { return null; }
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096,
    });
    const start = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
    return start ? `${process.platform}:${start}` : null;
  }
  return null;
}

function authorityOwnerIsStale(bytes: Buffer, label: string): boolean {
  let parsed: {
    version?: unknown; pid?: unknown; host?: unknown; token?: unknown;
    startedAt?: unknown; incarnation?: unknown;
  };
  try { parsed = JSON.parse(bytes.toString('utf8')) as typeof parsed; } catch {
    throw unsafeWorkspaceFile(`${label} is malformed`);
  }
  if (parsed.version !== 1 || typeof parsed.token !== 'string'
    || !Number.isInteger(parsed.pid) || typeof parsed.host !== 'string'
    || typeof parsed.startedAt !== 'number') {
    throw unsafeWorkspaceFile(`${label} is ambiguous`);
  }
  if (parsed.host !== os.hostname()) {
    throw unsafeWorkspaceFile(
      `${label} belongs to another host and cannot be safely reclaimed without shared process-incarnation proof`,
    );
  }
  const pid = Number(parsed.pid);
  if (!processIsAlive(pid)) return true;
  if (typeof parsed.incarnation !== 'string' || parsed.incarnation === 'unavailable') return false;
  const current = processIncarnation(pid);
  // A live PID with an unprovable incarnation is deliberately ambiguous.
  return current !== null && current !== parsed.incarnation;
}

function claimAndRetireWorkspaceAuthorityEntry(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
  claimName: string,
  expected: { dev: bigint; ino: bigint },
): void {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    try {
      runWorkspaceCwdHelper(lease, {
        operation: 'claim', name, target: claimName, expectedEntry: expected,
      });
    } catch (error) {
      // Retry is idempotent: the child first removes only exact private links,
      // then either completes an absent fixed claim or accepts the exact
      // source+claim nlink=2 state left by a lost response.
      try {
        runWorkspaceCwdHelper(lease, {
          operation: 'claim', name, target: claimName, expectedEntry: expected,
        });
      } catch {
      // A lost response after link(2) is safe to continue only when both names
      // still denote the exact expected two-link inode.
      const source = readWorkspaceAuthorityClaim(lease, name);
      const claim = readWorkspaceAuthorityClaim(lease, claimName);
      if (source.nlink !== 2n || claim.nlink !== 2n
        || source.identity.dev !== expected.dev || source.identity.ino !== expected.ino
        || claim.identity.dev !== expected.dev || claim.identity.ino !== expected.ino) throw error;
      }
    }
    retireClaimedWorkspaceAuthorityEntry(lease, name, claimName, expected);
    return;
  }
  lease.verify();
  const source = path.join(lease.accessPath, name);
  const claim = path.join(lease.accessPath, claimName);
  fs.linkSync(source, claim);
  retireClaimedWorkspaceAuthorityEntry(lease, name, claimName, expected);
}

function retireClaimedWorkspaceAuthorityEntry(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
  claimName: string,
  expected: { dev: bigint; ino: bigint },
): void {
  if (lease.entryMutationPolicy === 'cwd-helper') {
    try {
      runWorkspaceCwdHelper(lease, {
        operation: 'retire', name, target: claimName, expectedEntry: expected,
      });
    } catch (error) {
      try {
        runWorkspaceCwdHelper(lease, {
          operation: 'retire', name, target: claimName, expectedEntry: expected,
        });
        return;
      } catch { /* Fall through to the final exact fixed-name check. */ }
      let sourceAbsent = false;
      let claimAbsent = false;
      try { readWorkspaceAuthorityClaim(lease, name); } catch (sourceError) {
        sourceAbsent = (sourceError as NodeJS.ErrnoException).code === 'ENOENT';
      }
      try { readWorkspaceAuthorityClaim(lease, claimName); } catch (claimError) {
        claimAbsent = (claimError as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (!sourceAbsent || !claimAbsent) throw error;
      lease.verify();
    }
    return;
  }
  lease.verify();
  const source = path.join(lease.accessPath, name);
  const claim = path.join(lease.accessPath, claimName);
  const sourceStat = fs.lstatSync(source, { bigint: true });
  const claimStat = fs.lstatSync(claim, { bigint: true });
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
    || !claimStat.isFile() || claimStat.isSymbolicLink()
    || sourceStat.nlink !== 2n || claimStat.nlink !== 2n
    || sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino
    || claimStat.dev !== expected.dev || claimStat.ino !== expected.ino) {
    throw unsafeWorkspaceFile('Workspace writer acquisition guard claim is ambiguous');
  }
  fs.unlinkSync(source);
  fs.unlinkSync(claim);
  lease.verify();
}

function recoverOrphanedAuthorityRetireQuarantines(
  lease: WorkspaceStorageDirectoryLease,
): void {
  if (lease.entryMutationPolicy !== 'cwd-helper') return;
  lease.verify();
  const names = listWorkspaceCwdEntries(lease)
    .filter((entry) => entry.name.startsWith('.ccweb-quarantine-retire-'))
    .map((entry) => entry.name);
  if (names.length > 128) {
    throw unsafeWorkspaceFile('Workspace writer retirement has too many recovery entries');
  }
  const groups = new Map<string, ReturnType<typeof readWorkspaceAuthorityClaim>>();
  for (const name of names) {
    const entry = readWorkspaceAuthorityClaim(lease, name);
    const key = `${entry.identity.dev}:${entry.identity.ino}`;
    groups.set(key, entry);
  }
  for (const entry of groups.values()) {
    if (!authorityOwnerIsStale(entry.bytes, 'Workspace database writer retirement quarantine')) {
      throw unsafeWorkspaceFile('Workspace database writer retirement quarantine belongs to a live process');
    }
    runWorkspaceCwdHelper(lease, {
      operation: 'retire',
      name: WRITER_RETIRE_RECOVERY_A,
      target: WRITER_RETIRE_RECOVERY_B,
      expectedEntry: entry.identity,
    });
  }
}

export function recoverOrphanedRenameQuarantines(lease: WorkspaceStorageDirectoryLease): void {
  if (lease.entryMutationPolicy !== 'cwd-helper') return;
  lease.verify();
  const entries = listWorkspaceCwdEntries(lease)
    .filter((entry) => entry.name.startsWith('.ccweb-quarantine-rename-'));
  if (entries.length > 128) throw unsafeWorkspaceFile('Workspace has too many rename recovery entries');
  for (const entry of entries) {
    if (entry.type !== 'file' || entry.nlink !== 1n
      || entry.size > BigInt(MAX_SERIALIZED_DATABASE_BYTES)) {
      throw unsafeWorkspaceFile('Workspace rename recovery entry is unsafe');
    }
    runWorkspaceCwdHelper(lease, {
      operation: 'retire', name: RENAME_RECOVERY_A, target: RENAME_RECOVERY_B,
      expectedEntry: { dev: entry.dev, ino: entry.ino },
    });
  }
}

function recoverInterruptedAuthorityClaim(
  lease: WorkspaceStorageDirectoryLease,
  name: string,
  claimName: string,
  label: string,
): void {
  let claim: ReturnType<typeof readWorkspaceAuthorityClaim> | null = null;
  try { claim = readWorkspaceAuthorityClaim(lease, claimName); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let source: ReturnType<typeof readWorkspaceAuthorityClaim> | null = null;
  try { source = readWorkspaceAuthorityClaim(lease, name); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!claim) {
    if (!source || source.nlink === 1n) return;
    if (!authorityOwnerIsStale(source.bytes, label)) {
      throw unsafeWorkspaceFile(`${label} belongs to a live or ambiguous process`);
    }
    if (lease.entryMutationPolicy !== 'cwd-helper') {
      throw unsafeWorkspaceFile(`${label} has an ambiguous private-link binding`);
    }
    claimAndRetireWorkspaceAuthorityEntry(lease, name, claimName, source.identity);
    return;
  }
  if (!authorityOwnerIsStale(claim.bytes, label)) {
    throw unsafeWorkspaceFile(`${label} belongs to a live or ambiguous process`);
  }
  if (source) {
    if (source.nlink < 2n || source.nlink > 3n || claim.nlink !== source.nlink
      || source.identity.dev !== claim.identity.dev || source.identity.ino !== claim.identity.ino) {
      throw unsafeWorkspaceFile(`${label} has an ambiguous multi-name binding`);
    }
    if (lease.entryMutationPolicy === 'cwd-helper') {
      claimAndRetireWorkspaceAuthorityEntry(lease, name, claimName, claim.identity);
      return;
    }
    if (source.nlink !== 2n) throw unsafeWorkspaceFile(`${label} has an ambiguous link count`);
    retireClaimedWorkspaceAuthorityEntry(lease, name, claimName, claim.identity);
    return;
  }
  if (lease.entryMutationPolicy === 'cwd-helper' && claim.nlink <= 3n) {
    retireClaimedWorkspaceAuthorityEntry(lease, name, claimName, claim.identity);
    return;
  }
  if (claim.nlink !== 1n) throw unsafeWorkspaceFile(`${label} has an ambiguous orphan binding`);
  unlinkWorkspaceAuthorityEntry(lease, claimName, claim.identity);
}

export function acquireWorkspaceWriterAuthority(
  lease: WorkspaceStorageDirectoryLease,
): { token: string; identity: { dev: bigint; ino: bigint } } {
  const token = `${process.pid}:${os.hostname()}:${randomBytes(24).toString('hex')}`;
  const incarnation = processIncarnation(process.pid);
  const owner = Buffer.from(JSON.stringify({
    version: 1, pid: process.pid, host: os.hostname(), token,
    startedAt: Math.floor(Date.now() - process.uptime() * 1000),
    ...(incarnation === null ? {} : { incarnation }),
  }));
  recoverOrphanedAuthorityRetireQuarantines(lease);
  recoverInterruptedAuthorityClaim(
    lease, WRITER_GUARD_NAME, WRITER_GUARD_CLAIM_NAME,
    'Workspace database writer acquisition claim',
  );
  let guard: { dev: bigint; ino: bigint };
  try {
    guard = createWorkspaceAuthorityEntry(lease, WRITER_GUARD_NAME, owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw unsafeWorkspaceFile('Workspace database writer acquisition failed', error);
    }
    const previousGuard = readWorkspaceAuthorityEntry(lease, WRITER_GUARD_NAME);
    if (!authorityOwnerIsStale(previousGuard.bytes, 'Workspace database writer acquisition guard')) {
      throw unsafeWorkspaceFile('Workspace database writer acquisition is already in progress', error);
    }
    claimAndRetireWorkspaceAuthorityEntry(
      lease,
      WRITER_GUARD_NAME,
      WRITER_GUARD_CLAIM_NAME,
      previousGuard.identity,
    );
    guard = createWorkspaceAuthorityEntry(lease, WRITER_GUARD_NAME, owner);
  }
  let acquired: { token: string; identity: { dev: bigint; ino: bigint } } | null = null;
  try {
    recoverInterruptedAuthorityClaim(
      lease, WRITER_LEASE_NAME, WRITER_LEASE_CLAIM_NAME,
      'Workspace database writer retirement claim',
    );
    try {
      acquired = { token, identity: createWorkspaceAuthorityEntry(lease, WRITER_LEASE_NAME, owner) };
      return acquired;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stale = readWorkspaceAuthorityEntry(lease, WRITER_LEASE_NAME);
    if (!authorityOwnerIsStale(stale.bytes, 'Workspace database writer authority')) {
      throw unsafeWorkspaceFile('Another process owns the workspace database writer lease');
    }
    // The O_EXCL guard serializes the exact-inode retirement and replacement.
    // A guard left by a crash is conservatively ambiguous rather than guessed stale.
    claimAndRetireWorkspaceAuthorityEntry(
      lease,
      WRITER_LEASE_NAME,
      WRITER_LEASE_CLAIM_NAME,
      stale.identity,
    );
    acquired = { token, identity: createWorkspaceAuthorityEntry(lease, WRITER_LEASE_NAME, owner) };
    return acquired;
  } finally {
    try {
      unlinkWorkspaceAuthorityEntry(lease, WRITER_GUARD_NAME, guard);
    } catch (guardError) {
      let recovered = false;
      try {
        unlinkWorkspaceAuthorityEntry(lease, WRITER_GUARD_NAME, guard);
        recovered = true;
      } catch { /* Persistent exact guard cleanup failure remains fail-closed. */ }
      if (!recovered && acquired) {
        try {
          unlinkWorkspaceAuthorityEntry(lease, WRITER_LEASE_NAME, acquired.identity);
        } catch (writerError) {
          throw Object.assign(
            new Error('Workspace writer authority and acquisition guard cleanup both failed'),
            { cause: guardError, errors: [guardError, writerError] },
          );
        }
      }
      if (!recovered) throw guardError;
    }
  }
}

export function verifyWorkspaceWriterToken(
  lease: WorkspaceStorageDirectoryLease,
  token: string,
): { dev: bigint; ino: bigint } {
  const entry = readWorkspaceAuthorityEntry(lease, WRITER_LEASE_NAME);
  let parsed: { token?: unknown };
  try { parsed = JSON.parse(entry.bytes.toString('utf8')) as typeof parsed; } catch {
    throw unsafeWorkspaceFile('Workspace database writer authority is malformed');
  }
  if (parsed.token !== token) throw unsafeWorkspaceFile('Workspace database writer authority was replaced');
  return entry.identity;
}

export function authorityBoundDatabase(
  database: SqliteDatabase,
  verify: () => void,
  externallyPoisoned?: () => unknown | null,
): SqliteDatabase {
  let poisoned: unknown = null;
  const prove = (): void => {
    const external = externallyPoisoned?.();
    if (external) throw Object.assign(new Error('Workspace database writer authority is poisoned'), {
      code: 'WORKSPACE_DATABASE_POISONED', cause: external,
    });
    if (poisoned) throw Object.assign(new Error('Workspace database writer authority is poisoned'), {
      code: 'WORKSPACE_DATABASE_POISONED', cause: poisoned,
    });
    try { verify(); } catch (error) {
      poisoned = error;
      throw Object.assign(new Error('Workspace database writer authority was lost'), {
        code: 'WORKSPACE_DATABASE_POISONED', cause: error,
      });
    }
  };
  const around = <Result>(operation: () => Result): Result => {
    prove();
    const result = operation();
    prove();
    return result;
  };
  return {
    prepare: (sql) => {
      const statement = around(() => database.prepare(sql));
      return {
        run: (...params) => around(() => statement.run(...params)),
        get: (...params) => around(() => statement.get(...params)),
        all: (...params) => around(() => statement.all(...params)),
      };
    },
    exec: (sql) => around(() => database.exec(sql)),
    pragma: (body) => around(() => database.pragma(body)),
    transaction: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
      const transaction = database.transaction(fn);
      return (...args: Args): Result => around(() => transaction(...args));
    },
    ...(database.verifyFileBindings ? {
      verifyFileBindings: (expected: Parameters<NonNullable<SqliteDatabase['verifyFileBindings']>>[0]) =>
        around(() => database.verifyFileBindings!(expected)),
    } : {}),
    close: () => {
      // SQLite must not release its OS handles after the writer token has been
      // replaced. This check deliberately ignores prior operation poison so a
      // still-owned connection can always be retired during shutdown.
      verify();
      database.close();
    },
  };
}

