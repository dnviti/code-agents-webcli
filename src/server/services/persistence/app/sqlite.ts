/**
 * SQLite, backed by Node's built-in `node:sqlite`.
 *
 * This replaced `better-sqlite3`, which was one of only two packages in the
 * whole production tree carrying an install script (`prebuild-install ||
 * node-gyp rebuild`). npm >= 12 blocks dependency install scripts by default,
 * and an `npx` run has no project package.json in which to record an approval —
 * so that one dependency was enough to turn a one-command install into a
 * documented four-step ritual with a C++ toolchain at the end of it. A builtin
 * has no install step to block.
 *
 * The surface below is deliberately shaped like the slice of better-sqlite3 the
 * app actually used, so the call sites did not have to change. Verified
 * equivalent against the real builtin: `@name` parameters bound from bare
 * object keys, `json_each()`, WAL, `ON CONFLICT DO UPDATE`, `ON DELETE
 * CASCADE`, and `{ changes, lastInsertRowid }` returned as plain numbers.
 *
 * `.pragma()` and `.transaction()` are the two things better-sqlite3 had that
 * the builtin does not, and both are re-implemented below.
 *
 * Three behaviours genuinely differ, and none of them fails loudly:
 *
 * 1. **A missing named parameter binds NULL** instead of throwing
 *    `RangeError: Missing named parameter`. Dropping a key from a row literal
 *    silently writes NULL rather than failing the insert. (An extra key is the
 *    other way round: the builtin throws, better-sqlite3 ignored it.)
 * 2. **`undefined` throws** where better-sqlite3 accepted it and wrote NULL. So
 *    one undefined field now aborts a whole transaction instead of storing a
 *    NULL. Booleans throw on both.
 * 3. **Too few positional parameters bind NULL**, and any object argument is
 *    read as a named-parameter bag — so passing a `Date` (no own enumerable
 *    keys) binds nothing and leaves NULL, where better-sqlite3 threw.
 *
 * The rule that follows: this layer no longer catches binding mistakes for you.
 * Callers must pass every field explicitly, with the right arity and no
 * `undefined`. `test/sqlite-adapter.test.js` pins all three so a future Node
 * changing its mind is visible.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';

/** Minimum Node that exposes `node:sqlite` without an --experimental flag. */
const MIN_NODE = '24.16.0';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export type SqlParameters = readonly unknown[];

export interface SqliteStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /**
   * `PRAGMA <body>`, e.g. `pragma('journal_mode = WAL')`.
   *
   * Returns the pragma's result row when it has one — several pragmas answer
   * with the value they actually settled on rather than the one requested, and
   * WAL is one of them (a database on a filesystem that cannot support it comes
   * back `delete`).
   */
  pragma(body: string): unknown;
  /**
   * Wrap `fn` so every statement it runs commits or rolls back as a unit.
   *
   * Nested calls use SAVEPOINTs, matching better-sqlite3: SQLite has no nested
   * BEGIN, so an inner transaction would otherwise throw "cannot start a
   * transaction within a transaction" and take the outer one down with it.
   *
   * The wrapped function must be synchronous. Returning a promise throws,
   * because the COMMIT would run while the body was still suspended — the
   * transaction would bracket nothing and the real writes would land outside
   * it.
   */
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): (...args: Args) => Result;
  /**
   * Re-prove the persistent files held by a security-bound connection.
   *
   * Ordinary installation databases do not expose this method. Workspace
   * callers pass independently opened descriptors for the main database and
   * every currently visible sidecar, so a SQLite fd which followed a swapped
   * name cannot hide behind a later path restoration.
   */
  verifyFileBindings?(expected: readonly SqliteExpectedFileBinding[]): void;
  close(): void;
}

export interface SqliteExpectedFileBinding {
  readonly fd: number;
  readonly displayPath: string;
}

export interface SqliteOpenFileBinding {
  /** Independently opened, single-link file SQLite is required to use. */
  readonly expectedFd: number;
  /** Canonical path used only in fail-closed diagnostics. */
  readonly displayPath: string;
  /** Re-check the pinned parent around every path lookup/mutation. */
  readonly verifyContainer?: () => void;
  /** Deterministic swap seam for security tests; never supplied in production. */
  readonly testHooks?: {
    beforeBackendOpen?(): void;
    afterBackendOpen?(): void;
    bindingBackendForTest?: SqliteFileBindingBackend;
  };
}

export interface OpenDatabaseOptions {
  readonly fileBinding?: SqliteOpenFileBinding;
}

export interface SerializedDatabaseOptions {
  readonly initialImage?: Uint8Array;
  readonly publish: (image: Uint8Array) => void;
  readonly poison?: (error: unknown) => void;
}

export type SqliteFileBindingBackend =
  | 'descriptor-inventory'
  | 'windows-mandatory-share'
  | 'unavailable';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (sqliteModule) {
    return sqliteModule;
  }

  // Older Node releases tagged the module experimental and printed a warning on first
  // load. It is not actionable — the app cannot opt out of a builtin's
  // stability tag — and it lands in the middle of the startup banner where it
  // reads as a fault. Swapping `emitWarning` only for the duration of the
  // require keeps the suppression to exactly this one warning, rather than
  // running the whole process under --no-warnings and hiding real ones.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    const first = rest[0];
    const type = typeof first === 'string'
      ? first
      : (first as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) {
      return;
    }
    (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteModule = require('node:sqlite') as SqliteModule;
  } catch (error) {
    // Distinguish the two causes rather than blaming the Node version for
    // both: telling somebody on Node 24.16+ to upgrade their runtime sends
    // them off to fix something that is not wrong.
    const [major, minor] = process.versions.node.split('.').map(Number);
    const tooOld = major < 24 || (major === 24 && minor < 16);
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      tooOld
        ? `This build needs Node ${MIN_NODE} or newer for its built-in SQLite, but it is `
          + `running on ${process.version}.\n`
          + 'Upgrade Node (https://nodejs.org) and start it again.'
        : `Node ${process.version} should have a built-in SQLite, but loading it failed: `
          + `${reason}\n`
          + 'This usually means Node was built without SQLite support, or a policy is '
          + 'blocking the module.',
    );
  } finally {
    process.emitWarning = originalEmitWarning;
  }

  return sqliteModule;
}

/**
 * How long to wait for another writer before giving up, in milliseconds.
 *
 * better-sqlite3 defaulted to 5000; `node:sqlite` defaults to **0**, so without
 * this any momentary overlap fails instantly with "database is locked" where it
 * used to be waited out. The overlap is real: restarting the service runs the
 * old process's final session flush against the new process's migrations, and
 * both hold the same file.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * One name for every nesting level.
 *
 * SAVEPOINT names stack, so `RELEASE` and `ROLLBACK TO` always act on the most
 * recent one with that name. Reusing a single name is what better-sqlite3 does,
 * and it means the nesting level never has to be tracked — which matters,
 * because a counter can drift out of step with the connection (a COMMIT that
 * fails leaves the transaction open) and every later call would then issue the
 * wrong statement.
 */
const SAVEPOINT = 'cawcli_savepoint';

function wrapStatement(statement: StatementSync): SqliteStatement {
  return {
    run: (...params) => statement.run(...(params as never[])) as unknown as RunResult,
    get: (...params) => statement.get(...(params as never[])),
    all: (...params) => statement.all(...(params as never[])) as unknown[],
  };
}

interface OpenDescriptor {
  readonly fd: number;
  readonly stat: fs.BigIntStats;
}

function unsafeFileBinding(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code: 'UNSAFE_WORKSPACE_STORAGE',
    cause,
  });
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

/**
 * Locate a descriptor namespace which exposes every fd in this process.
 *
 * Linux procfs is the production backend. Some Unix hosts expose the same
 * enumeration through `/dev/fd`; it is accepted only when it is actually
 * readable. Windows has no equivalent and uses its mandatory handle-sharing
 * proof below instead.
 */
function descriptorNamespace(): string | null {
  const candidates = process.platform === 'linux'
    ? ['/proc/self/fd', '/dev/fd']
    : ['/dev/fd'];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        fs.readdirSync(candidate);
        return candidate;
      }
    } catch {
      // Try the next real descriptor namespace, if the platform has one.
    }
  }
  return null;
}

/** Pure platform routing, exported so non-Windows CI pins the portability decision. */
export function resolveSqliteFileBindingBackend(
  platform: NodeJS.Platform = process.platform,
  descriptorInventoryAvailable = descriptorNamespace() !== null,
): SqliteFileBindingBackend {
  if (platform === 'win32') return 'windows-mandatory-share';
  if (descriptorInventoryAvailable) return 'descriptor-inventory';
  return 'unavailable';
}

function snapshotDescriptors(namespace: string, displayPath: string): Map<number, OpenDescriptor> {
  let names: string[];
  try {
    names = fs.readdirSync(namespace);
  } catch (error) {
    throw unsafeFileBinding(
      `Cannot prove the SQLite file descriptor for workspace database: ${displayPath}`,
      error,
    );
  }
  const descriptors = new Map<number, OpenDescriptor>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const fd = Number(name);
    try {
      descriptors.set(fd, { fd, stat: fs.fstatSync(fd, { bigint: true }) });
    } catch (error) {
      // Enumerating the namespace briefly opens its own directory descriptor;
      // it may be gone before fstat. Persistent backend descriptors remain.
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') {
        throw unsafeFileBinding(
          `Cannot inspect SQLite file descriptors for workspace database: ${displayPath}`,
          error,
        );
      }
    }
  }
  return descriptors;
}

function checkedExpectedDescriptor(binding: SqliteExpectedFileBinding): OpenDescriptor {
  let stat: fs.BigIntStats;
  try {
    stat = fs.fstatSync(binding.fd, { bigint: true });
  } catch (error) {
    throw unsafeFileBinding(`Workspace database binding was closed: ${binding.displayPath}`, error);
  }
  if (!stat.isFile() || stat.nlink !== 1n || stat.ino === 0n) {
    throw unsafeFileBinding(`Workspace database binding is unsafe: ${binding.displayPath}`);
  }
  return { fd: binding.fd, stat };
}

function verifyVisibleExpectedDescriptor(
  binding: SqliteExpectedFileBinding,
  expected = checkedExpectedDescriptor(binding),
): OpenDescriptor {
  let visible: fs.BigIntStats;
  try {
    visible = fs.lstatSync(binding.displayPath, { bigint: true });
  } catch (error) {
    throw unsafeFileBinding(`Workspace database path disappeared: ${binding.displayPath}`, error);
  }
  if (
    visible.isSymbolicLink()
    || !visible.isFile()
    || visible.nlink !== 1n
    || visible.ino === 0n
    || !sameFileIdentity(visible, expected.stat)
  ) {
    throw unsafeFileBinding(`Workspace database path changed while SQLite opened: ${binding.displayPath}`);
  }
  return expected;
}

const WINDOWS_SHARING_DENIALS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

/**
 * Prove the exact Windows VFS property on which path binding relies.
 *
 * SQLite's built-in win32 VFS opens database files with FILE_SHARE_READ and
 * FILE_SHARE_WRITE, deliberately omitting FILE_SHARE_DELETE. Windows enforces
 * that share mask across the system: while DatabaseSync owns the handle, the
 * directory entry cannot be renamed, deleted or replaced. Therefore an
 * attacker can swap a name before sqlite3_open or after our check, but cannot
 * perform the dangerous swap-and-restore between those two events.
 *
 * Do not trust the platform string alone. A zero-byte sibling proves that an
 * unlocked rename works on this directory, is denied only while this build's
 * DatabaseSync handle is live, and works again immediately after close. An
 * alternate VFS/provider which does not enforce the contract fails closed
 * before the real database is opened.
 */
function proveWindowsMandatoryDeleteSharing(
  Ctor: SqliteModule['DatabaseSync'],
  databasePath: string,
  displayPath: string,
  verifyContainer: () => void,
): void {
  const directory = path.dirname(databasePath);
  const nonce = randomBytes(12).toString('hex');
  const probe = path.join(directory, `.ccweb-sqlite-binding-${process.pid}-${nonce}`);
  const moved = `${probe}.moved`;
  let probeFd: number | null = null;
  let probeDatabase: InstanceType<SqliteModule['DatabaseSync']> | null = null;
  const mutate = <Result>(operation: () => Result): Result => {
    verifyContainer();
    try {
      return operation();
    } finally {
      verifyContainer();
    }
  };
  try {
    probeFd = mutate(() => fs.openSync(
      probe,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    ));
    fs.closeSync(probeFd);
    probeFd = null;

    // Establish that this directory/provider permits an ordinary rename. A
    // later EACCES is evidence only when the identical operation works here.
    mutate(() => fs.renameSync(probe, moved));
    mutate(() => fs.renameSync(moved, probe));

    verifyContainer();
    probeDatabase = new Ctor(probe, { timeout: BUSY_TIMEOUT_MS });
    verifyContainer();
    let denied = false;
    try {
      mutate(() => fs.renameSync(probe, moved));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!WINDOWS_SHARING_DENIALS.has(code)) {
        throw unsafeFileBinding(
          `Cannot establish SQLite mandatory delete sharing for workspace database: ${displayPath}`,
          error,
        );
      }
      denied = true;
    }
    if (!denied) {
      // An unexpected permissive provider may have moved the disposable probe;
      // restore it while that same behavior is still available, then fail.
      mutate(() => fs.renameSync(moved, probe));
      throw unsafeFileBinding(
        `SQLite does not enforce mandatory delete sharing for workspace database: ${displayPath}`,
      );
    }

    probeDatabase.close();
    probeDatabase = null;
    // Prove the denial came from the live SQLite handle, not a coincidental ACL
    // or provider error which would leave swap-and-restore possible.
    mutate(() => fs.renameSync(probe, moved));
    mutate(() => fs.renameSync(moved, probe));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'UNSAFE_WORKSPACE_STORAGE') throw error;
    throw unsafeFileBinding(
      `Cannot establish SQLite mandatory delete sharing for workspace database: ${displayPath}`,
      error,
    );
  } finally {
    if (probeFd !== null) {
      try { fs.closeSync(probeFd); } catch { /* Preserve the binding failure. */ }
    }
    try { probeDatabase?.close(); } catch { /* Preserve the binding failure. */ }
    for (const candidate of [probe, moved]) {
      try { mutate(() => fs.unlinkSync(candidate)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'UNSAFE_WORKSPACE_STORAGE') throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Cleanup is best effort. Both names are random, direct, non-recursive
          // children and unlink never follows a raced symlink target.
        }
      }
    }
  }
}

function changedRegularDescriptors(
  before: ReadonlyMap<number, OpenDescriptor>,
  after: ReadonlyMap<number, OpenDescriptor>,
): OpenDescriptor[] {
  const changed: OpenDescriptor[] = [];
  for (const descriptor of after.values()) {
    const previous = before.get(descriptor.fd);
    if (previous && sameFileIdentity(previous.stat, descriptor.stat)) continue;
    if (descriptor.stat.isFile()) changed.push(descriptor);
  }
  return changed;
}

type SerializableDatabaseSync = InstanceType<SqliteModule['DatabaseSync']> & {
  serialize(): Uint8Array;
  deserialize(image: Uint8Array): void;
};

/**
 * Avoid copying a potentially hundreds-of-megabytes image for ordinary reads.
 * SQLite's less obvious write forms (`WITH ... INSERT`, DML `RETURNING`, and
 * PRAGMA) deliberately take the conservative path below. `EXPLAIN` never runs
 * the statement it describes, and a top-level SELECT/VALUES cannot mutate this
 * connection because this adapter registers no user-defined SQL functions.
 */
function serializedSqlBody(sql: string): string {
  let remaining = sql;
  for (;;) {
    remaining = remaining.trimStart();
    if (remaining.startsWith('--')) {
      const newline = remaining.indexOf('\n');
      if (newline < 0) return '';
      remaining = remaining.slice(newline + 1);
      continue;
    }
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      if (end < 0) return remaining;
      remaining = remaining.slice(end + 2);
      continue;
    }
    break;
  }
  return remaining;
}

function serializedStatementMayMutate(sql: string): boolean {
  const keyword = /^[A-Za-z]+/u.exec(serializedSqlBody(sql))?.[0]?.toUpperCase();
  return keyword !== 'SELECT' && keyword !== 'VALUES' && keyword !== 'EXPLAIN';
}

function splitSerializedStatements(sql: string): string[] {
  const raw: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '[') { quote = ']'; continue; }
    if (char === ';') {
      const statement = sql.slice(start, index).trim();
      if (serializedSqlBody(statement)) raw.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (serializedSqlBody(tail)) raw.push(tail);

  // Trigger bodies contain semicolon-delimited statements between BEGIN/END;
  // those are one SQLite statement, not autocommit transaction controls.
  const statements: string[] = [];
  let trigger = '';
  for (const statement of raw) {
    const body = serializedSqlBody(statement);
    if (!trigger && /^CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b[\s\S]*\bBEGIN\b/iu.test(body)) {
      trigger = statement;
      continue;
    }
    if (trigger) {
      trigger += `; ${statement}`;
      if (/^END\b/iu.test(body)) {
        statements.push(trigger);
        trigger = '';
      }
      continue;
    }
    statements.push(statement);
  }
  if (trigger) statements.push(trigger);
  return statements;
}

function serializedTransactionControl(sql: string): boolean {
  return /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?|COMMIT|END|ROLLBACK(?:\s+TO(?:\s+SAVEPOINT)?\s+[A-Za-z0-9_]+)?|SAVEPOINT\s+[A-Za-z0-9_]+|RELEASE(?:\s+SAVEPOINT)?\s+[A-Za-z0-9_]+)\s*;?\s*$/iu
    .test(sql);
}

/** In-memory SQLite whose only durable write is a caller-provided atomic image publication. */
export function openSerializedDatabase(options: SerializedDatabaseOptions): SqliteDatabase {
  const { DatabaseSync: Ctor } = loadSqlite();
  const db = new Ctor(':memory:', { timeout: BUSY_TIMEOUT_MS }) as SerializableDatabaseSync;
  if (typeof db.serialize !== 'function' || typeof db.deserialize !== 'function') {
    db.close();
    throw new Error(`This build needs Node ${MIN_NODE} or newer for serialized workspace SQLite.`);
  }
  if (options.initialImage?.byteLength) db.deserialize(options.initialImage);
  let durable = Buffer.from(db.serialize());
  let closed = false;
  let poisoned: unknown = null;

  const usable = (): void => {
    if (closed) throw new Error('Workspace SQLite connection is closed');
    if (poisoned) throw Object.assign(new Error('Workspace SQLite connection is poisoned'), {
      code: 'WORKSPACE_DATABASE_POISONED', cause: poisoned,
    });
  };
  const publish = (before: Uint8Array): void => {
    usable();
    const next = Buffer.from(db.serialize());
    if (next.equals(durable)) return;
    try {
      options.publish(next);
      durable = next;
    } catch (error) {
      try { db.deserialize(before); } catch { /* The connection is fail-stop below. */ }
      poisoned = error;
      options.poison?.(error);
      throw Object.assign(new Error('Workspace database image publication failed'), {
        code: 'WORKSPACE_DATABASE_POISONED', cause: error,
      });
    }
  };
  const mutateOutsideTransaction = <Result>(operation: () => Result): Result => {
    usable();
    const wasTransaction = db.isTransaction;
    // At every autocommit boundary the in-memory image is exactly `durable`.
    // Reusing that immutable snapshot avoids one full image copy per write.
    const before = durable;
    const result = operation();
    if ((!wasTransaction && !db.isTransaction) || (wasTransaction && !db.isTransaction)) publish(before);
    return result;
  };
  const readOnly = <Result>(operation: () => Result): Result => {
    usable();
    return operation();
  };
  const mutateAtomically = <Result>(operation: () => Result): Result => {
    usable();
    if (db.isTransaction) return mutateOutsideTransaction(operation);
    const before = durable;
    const savepoint = `${SAVEPOINT}_autocommit`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = operation();
      db.exec(`RELEASE ${savepoint}`);
      publish(before);
      return result;
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec(`ROLLBACK TO ${savepoint}`);
          db.exec(`RELEASE ${savepoint}`);
        } catch { /* Preserve the original SQLite failure. */ }
      }
      throw error;
    }
  };
  const execAtomically = (sql: string): void => {
    usable();
    const statements = splitSerializedStatements(sql);
    const transactionBoundary = statements.some((statement) => {
      const keyword = /^[A-Za-z]+/u.exec(serializedSqlBody(statement))?.[0]?.toUpperCase();
      return keyword !== undefined
        && new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']).has(keyword);
    });
    if (transactionBoundary) {
      if (statements.length !== 1 || !serializedTransactionControl(serializedSqlBody(statements[0]))) {
        throw new TypeError('Serialized SQLite transaction control must be one standalone exec call.');
      }
      mutateOutsideTransaction(() => db.exec(sql));
      return;
    }
    mutateAtomically(() => db.exec(sql));
  };

  return {
    prepare: (sql) => {
      usable();
      const statement = db.prepare(sql);
      const mayMutate = serializedStatementMayMutate(sql);
      const get = (...params: unknown[]): unknown =>
        statement.get(...(params as never[]));
      const all = (...params: unknown[]): unknown[] =>
        statement.all(...(params as never[])) as unknown[];
      return {
        run: (...params) => mutateAtomically(
          () => statement.run(...(params as never[])) as unknown as RunResult,
        ),
        // SQLite permits DML with RETURNING through get/all. Keep those durable
        // without serializing the whole database for the common SELECT path.
        get: (...params) => mayMutate
          ? mutateAtomically(() => get(...params))
          : readOnly(() => get(...params)),
        all: (...params) => mayMutate
          ? mutateAtomically(() => all(...params))
          : readOnly(() => all(...params)),
      };
    },
    exec: execAtomically,
    pragma: (body) => mutateOutsideTransaction(() => {
      const rows = db.prepare(`PRAGMA ${body}`).all();
      return rows.length ? rows[0] : null;
    }),
    transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
      return (...args: Args): Result => {
        usable();
        const nested = db.isTransaction;
        const before = durable;
        db.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN');
        try {
          const result = fn(...args);
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new TypeError('A transaction function must not return a promise.');
          }
          db.exec(nested ? `RELEASE ${SAVEPOINT}` : 'COMMIT');
          if (!nested) publish(before);
          return result;
        } catch (error) {
          if (db.isTransaction) {
            try {
              db.exec(nested ? `ROLLBACK TO ${SAVEPOINT}` : 'ROLLBACK');
              if (nested) db.exec(`RELEASE ${SAVEPOINT}`);
            } catch { /* Preserve the original failure. */ }
          }
          throw error;
        }
      };
    },
    close: () => {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}

export function openDatabase(databasePath: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const { DatabaseSync: Ctor } = loadSqlite();
  const fileBinding = options.fileBinding;
  let bindingVerifier: ((expected: readonly SqliteExpectedFileBinding[]) => void) | undefined;
  let db: InstanceType<SqliteModule['DatabaseSync']>;

  if (!fileBinding) {
    db = new Ctor(databasePath, { timeout: BUSY_TIMEOUT_MS });
  } else {
    const namespace = descriptorNamespace();
    const backend = fileBinding.testHooks?.bindingBackendForTest
      ?? resolveSqliteFileBindingBackend(process.platform, namespace !== null);
    if (backend === 'unavailable' || (backend === 'descriptor-inventory' && !namespace)) {
      throw unsafeFileBinding(
        `Cannot prove the SQLite file descriptor for workspace database: ${fileBinding.displayPath}`,
      );
    }
    const expectedBefore = checkedExpectedDescriptor({
      fd: fileBinding.expectedFd,
      displayPath: fileBinding.displayPath,
    });
    if (backend === 'windows-mandatory-share') {
      proveWindowsMandatoryDeleteSharing(
        Ctor,
        databasePath,
        fileBinding.displayPath,
        fileBinding.verifyContainer ?? (() => {}),
      );
    }
    const before = backend === 'descriptor-inventory'
      ? snapshotDescriptors(namespace!, fileBinding.displayPath)
      : null;
    let opened: InstanceType<SqliteModule['DatabaseSync']> | null = null;
    let failure: unknown = null;
    let hookStarted = false;
    try {
      hookStarted = true;
      fileBinding.testHooks?.beforeBackendOpen?.();
      fileBinding.verifyContainer?.();
      opened = new Ctor(databasePath, { timeout: BUSY_TIMEOUT_MS });
      fileBinding.verifyContainer?.();
    } catch (error) {
      failure = error;
    } finally {
      if (hookStarted) {
        try {
          fileBinding.testHooks?.afterBackendOpen?.();
        } catch (error) {
          if (failure === null) failure = error;
        }
      }
    }
    if (!opened || failure !== null) {
      try { opened?.close(); } catch { /* Preserve the open/hook failure. */ }
      throw failure ?? unsafeFileBinding(`SQLite did not open workspace database: ${fileBinding.displayPath}`);
    }

    const expectedAfter = checkedExpectedDescriptor({
      fd: fileBinding.expectedFd,
      displayPath: fileBinding.displayPath,
    });
    if (!sameFileIdentity(expectedBefore.stat, expectedAfter.stat)) {
      opened.close();
      throw unsafeFileBinding(`Workspace database binding changed while SQLite opened: ${fileBinding.displayPath}`);
    }
    if (backend === 'descriptor-inventory') {
      const after = snapshotDescriptors(namespace!, fileBinding.displayPath);
      const backendFiles = changedRegularDescriptors(before!, after);
      if (
        backendFiles.length !== 1
        || backendFiles[0].stat.nlink !== 1n
        || !sameFileIdentity(backendFiles[0].stat, expectedBefore.stat)
      ) {
        opened.close();
        throw unsafeFileBinding(
          `SQLite did not bind the verified workspace database inode: ${fileBinding.displayPath}`,
        );
      }

      const backendMainFd = backendFiles[0].fd;
      bindingVerifier = (expectedBindings) => {
        const expected = expectedBindings.map(checkedExpectedDescriptor);
        const current = snapshotDescriptors(namespace!, fileBinding.displayPath);
        const actualMain = current.get(backendMainFd);
        if (
          !actualMain
          || !actualMain.stat.isFile()
          || actualMain.stat.nlink !== 1n
          || !sameFileIdentity(actualMain.stat, expectedBefore.stat)
        ) {
          throw unsafeFileBinding(
            `SQLite workspace database descriptor changed: ${fileBinding.displayPath}`,
          );
        }
        for (const actual of changedRegularDescriptors(before!, current)) {
          if (
            actual.stat.nlink !== 1n
            || !expected.some((candidate) => sameFileIdentity(candidate.stat, actual.stat))
          ) {
            throw unsafeFileBinding(
              `SQLite opened an unverified workspace database component: ${fileBinding.displayPath}`,
            );
          }
        }
      };
    } else {
      // The capability probe proved that every SQLite-owned Windows name is
      // immovable until close. A post-open identity match therefore cannot be
      // fooled by swapping a canary in for open and restoring the original for
      // verification. Apply the same proof to persistent sidecars as they
      // appear; single-link checks prevent an outside hardlink alias.
      bindingVerifier = (expectedBindings) => {
        verifyVisibleExpectedDescriptor({
          fd: fileBinding.expectedFd,
          displayPath: fileBinding.displayPath,
        }, expectedBefore);
        for (const candidate of expectedBindings) {
          if (candidate.displayPath === fileBinding.displayPath) continue;
          verifyVisibleExpectedDescriptor(candidate);
        }
      };
    }
    // Prove the backend again through the same reusable verifier before the
    // wrapper exposes even PRAGMA/prepare to its caller.
    try {
      bindingVerifier([{
        fd: fileBinding.expectedFd,
        displayPath: fileBinding.displayPath,
      }]);
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
  }
  let closed = false;

  const database: SqliteDatabase = {
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    pragma: (body) => {
      // Read back through the pragma's own name rather than assuming the write
      // form returns anything: `PRAGMA foreign_keys = ON` answers with no rows
      // at all, while `PRAGMA journal_mode = WAL` answers with one.
      const statement = db.prepare(`PRAGMA ${body}`);
      const rows = statement.all();
      return rows.length > 0 ? rows[0] : null;
    },
    transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
      return (...args: Args): Result => {
        // Asked of the connection, not of a counter we maintain: this is the
        // real `sqlite3_get_autocommit` state, so it stays correct even after a
        // COMMIT that failed and left the transaction open.
        const nested = db.isTransaction;

        db.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN');

        try {
          const result = fn(...args);

          if (result && typeof (result as { then?: unknown }).then === 'function') {
            // Refusing here matches better-sqlite3. An async function returns
            // at its first await, so the COMMIT below would run before the body
            // had done its work: the transaction would wrap nothing and the
            // writes would land afterwards, unprotected.
            throw new TypeError('A transaction function must not return a promise.');
          }

          // Inside the try, deliberately. COMMIT is not merely bookkeeping — it
          // is where SQLITE_BUSY, SQLITE_FULL and I/O errors surface, and when
          // it fails the transaction is still open. Committing outside the try
          // meant that failure escaped with the connection left inside a
          // transaction it could never leave: every later write silently joined
          // it and was discarded, and the process held a write lock on the
          // database file until it exited.
          db.exec(nested ? `RELEASE ${SAVEPOINT}` : 'COMMIT');
          return result;
        } catch (error) {
          if (db.isTransaction) {
            try {
              db.exec(nested ? `ROLLBACK TO ${SAVEPOINT}` : 'ROLLBACK');
              if (nested) {
                // ROLLBACK TO rewinds the savepoint but leaves it on the stack.
                db.exec(`RELEASE ${SAVEPOINT}`);
              }
            } catch {
              // Nothing useful to do, and the original error is the one that
              // explains what happened.
            }
          }
          throw error;
        }
      };
    },
    ...(bindingVerifier ? { verifyFileBindings: bindingVerifier } : {}),
    close: () => {
      // better-sqlite3 tolerated a second close; the builtin throws
      // ERR_INVALID_STATE. Shutdown paths that close defensively should not
      // turn into an error report.
      if (closed) {
        return;
      }
      db.close();
      closed = true;
    },
  };

  return database;
}
