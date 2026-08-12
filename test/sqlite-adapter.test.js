const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openDatabase,
  openSerializedDatabase,
  resolveSqliteFileBindingBackend,
} = require('../dist/server/services/sqlite.js');

/**
 * The SQLite adapter's own semantics.
 *
 * Everything else in the suite exercises this module through AppDatabase and
 * SessionStore, which only ever take the happy path: one flat transaction that
 * commits. The parts most likely to be wrong — a transaction that throws, a
 * nested one, the depth bookkeeping that decides between BEGIN and SAVEPOINT —
 * have no coverage there at all, and a mistake in them does not fail loudly. It
 * leaves the connection stuck inside a transaction, and every later write in
 * the process fails with something that reads like an unrelated bug.
 *
 * These also pin the better-sqlite3 behaviours the call sites still assume,
 * since the point of the swap was that nothing above this file had to change.
 */
describe('sqlite adapter', function () {
  let dir;
  let db;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawcli-sqlite-'));
    db = openDatabase(path.join(dir, 'test.sqlite'));
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  });

  afterEach(function () {
    try {
      db.close();
    } catch {
      // A test may have closed it already.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = () => db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
  const insert = (name) => db.prepare('INSERT INTO items (name) VALUES (?)').run(name);

  describe('pragma', function () {
    it('applies the settings the app depends on, and reads them back', function () {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = NORMAL');

      assert.strictEqual(db.pragma('journal_mode').journal_mode, 'wal');
      assert.strictEqual(db.pragma('foreign_keys').foreign_keys, 1);
      assert.strictEqual(db.pragma('synchronous').synchronous, 1);
    });

    it('really enables foreign keys, rather than only reporting that it did', function () {
      // The read-back above passes even if the pragma were a no-op on a
      // different connection, so prove it with an actual cascade.
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE
        );
      `);
      db.prepare('INSERT INTO parents (id) VALUES (1)').run();
      db.prepare('INSERT INTO children (id, parent_id) VALUES (1, 1)').run();
      db.prepare('DELETE FROM parents WHERE id = 1').run();

      assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM children').get().c, 0);
    });

    it('returns null for a pragma that answers with no rows', function () {
      assert.strictEqual(db.pragma('foreign_keys = ON'), null);
    });
  });

  describe('transaction', function () {
    it('commits everything the function did, and returns its value', function () {
      const result = db.transaction((n) => {
        for (let i = 0; i < n; i += 1) {
          insert(`item-${i}`);
        }
        return `wrote ${n}`;
      })(3);

      assert.strictEqual(result, 'wrote 3');
      assert.strictEqual(count(), 3);
    });

    it('rolls back every write when the function throws, and rethrows', function () {
      insert('survivor');

      assert.throws(
        () => db.transaction(() => {
          insert('doomed-1');
          insert('doomed-2');
          throw new Error('nope');
        })(),
        /nope/,
      );

      assert.strictEqual(count(), 1);
      assert.strictEqual(db.prepare('SELECT name FROM items').get().name, 'survivor');
    });

    it('leaves the connection usable after a rollback', function () {
      // The failure this guards against is the nasty one: a transaction that
      // aborts without releasing leaves every later write failing with "cannot
      // start a transaction within a transaction", nowhere near the real cause.
      assert.throws(() => db.transaction(() => { throw new Error('boom'); })());

      insert('after');
      assert.strictEqual(count(), 1);

      const value = db.transaction(() => { insert('later'); return 'ok'; })();
      assert.strictEqual(value, 'ok');
      assert.strictEqual(count(), 2);
    });

    it('nests via savepoints instead of failing on a second BEGIN', function () {
      const inner = db.transaction(() => insert('inner'));
      const outer = db.transaction(() => {
        insert('outer');
        inner();
        return 'done';
      });

      assert.strictEqual(outer(), 'done');
      assert.strictEqual(count(), 2);
    });

    it('rolls the inner savepoint back without losing the outer transaction', function () {
      const inner = db.transaction(() => {
        insert('inner');
        throw new Error('inner failed');
      });

      const outer = db.transaction(() => {
        insert('outer');
        try {
          inner();
        } catch {
          // Deliberately swallowed: the outer work should still commit.
        }
        insert('after-inner');
      });

      outer();

      const names = db.prepare('SELECT name FROM items ORDER BY id').all().map((r) => r.name);
      assert.deepStrictEqual(names, ['outer', 'after-inner']);
    });

    it('stays usable across repeated failures', function () {
      for (let i = 0; i < 5; i += 1) {
        assert.throws(() => db.transaction(() => { throw new Error(`fail-${i}`); })());
      }
      db.transaction(() => insert('final'))();
      assert.strictEqual(count(), 1);
    });

    it('recovers when the COMMIT itself fails', function () {
      // The one that matters most. COMMIT is where SQLITE_BUSY, SQLITE_FULL and
      // deferred constraint violations surface, and when it fails SQLite leaves
      // the transaction OPEN. An implementation that commits outside its
      // try/catch loses the connection permanently: the error escapes, nothing
      // rolls back, and from then on every BEGIN fails with "cannot start a
      // transaction within a transaction" while the process holds a write lock
      // on the database file. Only a restart clears it.
      //
      // A deferred foreign key gives that failure deterministically — the
      // violation is not detected until commit time — with no need to race a
      // second connection.
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE owners (id INTEGER PRIMARY KEY);
        CREATE TABLE owned (
          id INTEGER PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED
        );
      `);

      assert.throws(
        () => db.transaction(() => {
          db.prepare('INSERT INTO owned (id, owner_id) VALUES (1, 999)').run();
        })(),
        /FOREIGN KEY constraint failed/,
      );

      // The whole point: the connection is still usable.
      db.transaction(() => insert('after-failed-commit'))();
      assert.strictEqual(count(), 1);
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM owned').get().c, 0);
    });

    it('refuses an async transaction function instead of committing nothing', function () {
      // An async function returns at its first await, so the COMMIT would run
      // while the body was still suspended: the transaction would bracket
      // nothing and the real writes would land outside it. better-sqlite3
      // rejected this outright and so does the adapter.
      assert.throws(
        () => db.transaction(async () => { insert('async'); })(),
        /must not return a promise/,
      );

      // And the empty transaction it opened was rolled back, not left hanging.
      db.transaction(() => insert('sync'))();
      assert.strictEqual(count(), 1);
    });
  });

  describe('connection', function () {
    it('waits for a busy database rather than failing instantly', function () {
      // better-sqlite3 defaulted to a 5s busy timeout; node:sqlite defaults to
      // 0. Without restoring it, a momentary overlap between two processes —
      // exactly what a service restart produces — fails immediately with
      // "database is locked" instead of being waited out.
      assert.strictEqual(db.pragma('busy_timeout').timeout, 5000);
    });

    it('tolerates being closed twice', function () {
      db.close();
      assert.doesNotThrow(() => db.close());
    });

    it('retries the same native handle when DatabaseSync.close throws', function () {
      const { DatabaseSync } = require('node:sqlite');
      const originalClose = DatabaseSync.prototype.close;
      let fail = true;
      DatabaseSync.prototype.close = function closeWithOneFailure() {
        if (fail) throw new Error('injected native close failure');
        return originalClose.call(this);
      };
      try {
        assert.throws(() => db.close(), /injected native close failure/);
        fail = false;
        assert.doesNotThrow(() => db.close());
      } finally {
        DatabaseSync.prototype.close = originalClose;
      }
    });

    it('routes Windows to mandatory sharing and Unix to descriptor proof when available', function () {
      assert.strictEqual(
        resolveSqliteFileBindingBackend('win32', false),
        'windows-mandatory-share',
      );
      assert.strictEqual(
        resolveSqliteFileBindingBackend('linux', true),
        'descriptor-inventory',
      );
      assert.strictEqual(
        resolveSqliteFileBindingBackend('darwin', true),
        'descriptor-inventory',
      );
      assert.strictEqual(
        resolveSqliteFileBindingBackend('darwin', false),
        'unavailable',
      );
    });

    it('fails closed when the modeled Windows provider permits rename with SQLite open', function () {
      if (process.platform === 'win32') this.skip();
      const boundPath = path.join(dir, 'portable-bound.sqlite');
      fs.writeFileSync(boundPath, 'unchanged', { mode: 0o600 });
      const expectedFd = fs.openSync(boundPath, 'r+');
      try {
        assert.throws(
          () => openDatabase(boundPath, {
            fileBinding: {
              expectedFd,
              displayPath: boundPath,
              testHooks: { bindingBackendForTest: 'windows-mandatory-share' },
            },
          }),
          /does not enforce mandatory delete sharing/,
        );
        assert.strictEqual(fs.readFileSync(boundPath, 'utf8'), 'unchanged');
        assert.deepStrictEqual(
          fs.readdirSync(dir).filter((name) => name.startsWith('.ccweb-sqlite-binding-')),
          [],
        );
      } finally {
        fs.closeSync(expectedFd);
      }
    });

    it('opens a bound database on Windows only after proving mandatory delete sharing', function () {
      if (process.platform !== 'win32') this.skip();
      const boundPath = path.join(dir, 'windows-bound.sqlite');
      fs.writeFileSync(boundPath, '', { mode: 0o600 });
      const expectedFd = fs.openSync(boundPath, 'r+');
      let bound;
      try {
        bound = openDatabase(boundPath, {
          fileBinding: { expectedFd, displayPath: boundPath },
        });
        bound.exec('CREATE TABLE windows_binding (value TEXT)');
        assert.strictEqual(
          bound.prepare("SELECT name FROM sqlite_master WHERE name = 'windows_binding'").get().name,
          'windows_binding',
        );
      } finally {
        try { bound?.close(); } catch { /* Preserve the test result. */ }
        fs.closeSync(expectedFd);
      }
    });
  });

  describe('statement behaviour the call sites rely on', function () {
    it('reports changes and lastInsertRowid as plain numbers', function () {
      const result = insert('first');
      assert.strictEqual(typeof result.changes, 'number');
      assert.strictEqual(result.changes, 1);
      assert.strictEqual(Number(result.lastInsertRowid), 1);
    });

    it('binds named @parameters from bare object keys', function () {
      // session-store.ts passes whole row objects to a statement using @name
      // placeholders. If this ever stopped working it would take session
      // persistence with it.
      db.prepare('INSERT INTO items (id, name) VALUES (@id, @name)')
        .run({ id: 7, name: 'named' });
      assert.strictEqual(db.prepare('SELECT name FROM items WHERE id = 7').get().name, 'named');
    });

    it('returns undefined for a missing row and an array for none', function () {
      assert.strictEqual(db.prepare('SELECT * FROM items WHERE id = ?').get(999), undefined);
      assert.deepStrictEqual(db.prepare('SELECT * FROM items WHERE id = ?').all(999), []);
    });

    it('rejects undefined and boolean bindings', function () {
      // Booleans threw on better-sqlite3 too. `undefined` did NOT — it was
      // accepted and written as NULL — so this is a real behaviour change:
      // a single undefined field now aborts the whole surrounding transaction
      // where it used to store a NULL and carry on. Pinned because callers have
      // to pass explicit nulls now, and because a future Node relaxing this
      // should be a visible decision rather than a silent one.
      assert.throws(() => insert(undefined), TypeError);
      assert.throws(() => insert(true), TypeError);
    });

    it('binds NULL for a missing named parameter instead of throwing', function () {
      // The opposite direction, and the more dangerous one. better-sqlite3
      // threw `RangeError: Missing named parameter`; the builtin quietly writes
      // NULL. Dropping a field from a row literal is therefore no longer caught
      // at the boundary — see the note at the top of
      // src/server/services/sqlite.ts.
      db.prepare('INSERT INTO items (id, name) VALUES (@id, @name)').run({ id: 3 });
      assert.strictEqual(db.prepare('SELECT name FROM items WHERE id = 3').get().name, null);
    });

    it('rejects an unknown named parameter', function () {
      // Also inverted: better-sqlite3 ignored extra keys, the builtin throws.
      assert.throws(
        () => db.prepare('INSERT INTO items (id, name) VALUES (@id, @name)')
          .run({ id: 4, name: 'x', surplus: 'y' }),
        /surplus/,
      );
    });

    it('binds NULL when positional parameters are missing', function () {
      // better-sqlite3 threw `RangeError: Too few parameter values`. Worth
      // knowing: any object argument is read as a named-parameter bag, so
      // passing something like a Date — which has no own enumerable keys —
      // binds nothing and leaves NULL rather than failing.
      db.prepare('INSERT INTO items (name) VALUES (?)').run();
      assert.strictEqual(db.prepare('SELECT name FROM items').get().name, null);
    });

    it('accepts null', function () {
      assert.strictEqual(insert(null).changes, 1);
      assert.strictEqual(db.prepare('SELECT name FROM items').get().name, null);
    });

    it('supports json_each, which the session cleanup query needs', function () {
      insert('a');
      insert('b');
      insert('c');
      const removed = db
        .prepare('DELETE FROM items WHERE id NOT IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify([1, 3]));

      assert.strictEqual(removed.changes, 1);
      assert.strictEqual(count(), 2);
    });
  });

  it('persists across reopening the same file', function () {
    insert('durable');
    db.close();

    db = openDatabase(path.join(dir, 'test.sqlite'));
    assert.strictEqual(count(), 1);
  });

  describe('serialized in-memory publication', function () {
    it('does not serialize the database image for read-only get/all statements', function () {
      const { DatabaseSync } = require('node:sqlite');
      const originalSerialize = DatabaseSync.prototype.serialize;
      let serializeCalls = 0;
      let serialized;
      DatabaseSync.prototype.serialize = function countedSerialize(...args) {
        serializeCalls += 1;
        return originalSerialize.apply(this, args);
      };
      try {
        serialized = openSerializedDatabase({ publish: () => {} });
        serialized.exec('CREATE TABLE portable (value TEXT)');
        serialized.prepare('INSERT INTO portable VALUES (?)').run('read-only');
        const beforeReads = serializeCalls;

        assert.strictEqual(
          serialized.prepare('SELECT value FROM portable').get().value,
          'read-only',
        );
        assert.deepStrictEqual(
          serialized.prepare('SELECT value FROM portable').all().map((row) => row.value),
          ['read-only'],
        );
        assert.strictEqual(serializeCalls, beforeReads);
      } finally {
        try { serialized?.close(); } finally {
          DatabaseSync.prototype.serialize = originalSerialize;
        }
      }
    });

    it('reopens the last published image and publishes only the outer transaction', function () {
      const images = [];
      const first = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      first.exec('CREATE TABLE portable (value TEXT)');
      const before = images.length;
      const outer = first.transaction(() => {
        first.prepare('INSERT INTO portable VALUES (?)').run('outer');
        const inner = first.transaction(() => first.prepare('INSERT INTO portable VALUES (?)').run('inner'));
        inner();
      });
      outer();
      assert.strictEqual(images.length, before + 1);
      first.close();

      const reopened = openSerializedDatabase({
        initialImage: images.at(-1),
        publish: () => assert.fail('read-only reopen unexpectedly published'),
      });
      assert.deepStrictEqual(
        reopened.prepare('SELECT value FROM portable ORDER BY rowid').all().map((row) => row.value),
        ['outer', 'inner'],
      );
      reopened.close();
    });

    it('restores the last durable image and becomes fail-stop after publication failure', function () {
      let fail = false;
      const serialized = openSerializedDatabase({
        publish: () => { if (fail) throw new Error('injected publication failure'); },
      });
      serialized.exec('CREATE TABLE portable (value TEXT)');
      fail = true;
      assert.throws(
        () => serialized.prepare('INSERT INTO portable VALUES (?)').run('lost'),
        (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
      );
      assert.throws(
        () => serialized.prepare('SELECT * FROM portable').all(),
        (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
      );
      serialized.close();
    });

    it('publishes DML RETURNING through get/all and mutating pragmas', function () {
      const images = [];
      const serialized = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      serialized.exec('CREATE TABLE portable (value TEXT)');
      const beforeReturning = images.length;
      assert.strictEqual(
        serialized.prepare('INSERT INTO portable VALUES (?) RETURNING value').get('one').value,
        'one',
      );
      assert.deepStrictEqual(
        serialized.prepare('INSERT INTO portable VALUES (?) RETURNING value').all('two').map((row) => row.value),
        ['two'],
      );
      assert.strictEqual(images.length, beforeReturning + 2);
      const beforePragma = images.length;
      serialized.pragma('user_version = 7');
      assert.strictEqual(images.length, beforePragma + 1);
      serialized.close();

      const reopened = openSerializedDatabase({
        initialImage: images.at(-1),
        publish: () => assert.fail('read-only verification unexpectedly published'),
      });
      assert.deepStrictEqual(
        reopened.prepare('SELECT value FROM portable ORDER BY rowid').all().map((row) => row.value),
        ['one', 'two'],
      );
      assert.strictEqual(reopened.pragma('user_version').user_version, 7);
      reopened.close();
    });

    it('rolls back partial autocommit exec changes when a later statement is invalid', function () {
      const images = [];
      const serialized = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      serialized.exec('CREATE TABLE portable (value TEXT)');
      const durableBeforeFailure = images.length;
      assert.throws(
        () => serialized.exec("INSERT INTO portable VALUES ('must-rollback'); THIS IS NOT SQL"),
      );
      assert.throws(
        () => serialized.exec("INSERT INTO portable VALUES ('must-not-commit'); /* boundary */ COMMIT; THIS IS NOT SQL"),
        /one standalone exec call/i,
      );
      assert.strictEqual(images.length, durableBeforeFailure);
      assert.deepStrictEqual(serialized.prepare('SELECT value FROM portable').all(), []);
      serialized.exec("INSERT INTO portable VALUES ('durable; quoted'); -- trailing ; comment\n");
      serialized.close();

      const reopened = openSerializedDatabase({
        initialImage: images.at(-1),
        publish: () => assert.fail('read-only verification unexpectedly published'),
      });
      assert.deepStrictEqual(
        reopened.prepare('SELECT value FROM portable').all().map((row) => row.value),
        ['durable; quoted'],
      );
      reopened.close();
    });

    it('rolls back prepared OR FAIL rows instead of leaking them into a later publish', function () {
      const images = [];
      const serialized = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      serialized.exec('CREATE TABLE portable (value TEXT UNIQUE)');
      serialized.prepare('INSERT INTO portable VALUES (?)').run('existing');
      const durableBeforeFailure = images.length;
      assert.throws(
        () => serialized.prepare("INSERT OR FAIL INTO portable VALUES ('partial'), ('existing')").run(),
        /constraint|unique/i,
      );
      assert.strictEqual(images.length, durableBeforeFailure);
      assert.deepStrictEqual(
        serialized.prepare('SELECT value FROM portable ORDER BY value').all().map((row) => row.value),
        ['existing'],
      );
      serialized.prepare('INSERT INTO portable VALUES (?)').run('durable');
      serialized.close();

      const reopened = openSerializedDatabase({
        initialImage: images.at(-1), publish: () => assert.fail('read-only reopen unexpectedly published'),
      });
      assert.deepStrictEqual(
        reopened.prepare('SELECT value FROM portable ORDER BY value').all().map((row) => row.value),
        ['durable', 'existing'],
      );
      reopened.close();
    });
  });
});
