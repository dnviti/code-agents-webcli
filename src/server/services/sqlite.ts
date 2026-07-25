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

import type { StatementSync } from 'node:sqlite';

/** Minimum Node that exposes `node:sqlite` without an --experimental flag. */
const MIN_NODE = '22.13.0';

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
  close(): void;
}

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (sqliteModule) {
    return sqliteModule;
  }

  // Node 22.x still tags the module experimental and prints a warning on first
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
    // both: telling somebody on Node 24 to "upgrade to 22.13" sends them off
    // to fix something that is not wrong.
    const [major, minor] = process.versions.node.split('.').map(Number);
    const tooOld = major < 22 || (major === 22 && minor < 13);
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

export function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync: Ctor } = loadSqlite();
  const db = new Ctor(path, { timeout: BUSY_TIMEOUT_MS });
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
    close: () => {
      // better-sqlite3 tolerated a second close; the builtin throws
      // ERR_INVALID_STATE. Shutdown paths that close defensively should not
      // turn into an error report.
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
  };

  return database;
}
