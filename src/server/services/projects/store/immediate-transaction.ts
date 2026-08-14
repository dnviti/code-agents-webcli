/** Single-writer transaction helper used by the run-limit and lease paths. */

import type { SqliteDatabase } from '../../sqlite.js';

/**
 * `BEGIN IMMEDIATE`, commit or rollback as a unit.
 *
 * The shared `SqliteDatabase.transaction` opens a deferred transaction, which
 * is right for everything that only writes: the lock arrives with the first
 * write. The run-limit check reads first and writes second, and a deferred
 * transaction would let another connection's writer slip in between the two.
 * IMMEDIATE takes the write lock up front, so the count and the transition
 * are one indivisible observation.
 */
export function immediateTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the one that explains what happened.
    }
    throw error;
  }
}
