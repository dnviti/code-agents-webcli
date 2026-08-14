/**
 * The small, portable database that travels with a workspace.
 *
 * This is intentionally not an AppDatabase.  AppDatabase owns installation
 * state (accounts, OAuth cookies, profiles, ...), while this file only owns
 * work performed in one checkout.  In particular it must be possible to open
 * it before the account which originally made it exists in the current app
 * database.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  openDatabase,
  openSerializedDatabase,
  type SqliteDatabase,
} from '../sqlite.js';
import {
  openWorkspaceStorageDirectorySync,
  type WorkspaceStorageDirectoryLease,
  type WorkspaceStorageIdentity,
} from '../workspace-session-storage.js';
import {
  publishLargeWorkspaceCwdFile,
  readCompleteWorkspaceCwdFile,
} from '../workspace-cwd-helper.js';
import type {
  WorkspaceSessionDatabaseOptions,
  WorkspaceArchiveTrust,
} from './types.js';
import {
  WRITER_LEASE_NAME,
  MAX_SERIALIZED_DATABASE_BYTES,
  type SharedSerializedWorkspaceDatabase,
  sharedSerializedDatabases,
} from './constants.js';
import {
  unsafeWorkspaceFile,
  verifyWorkspaceFileBinding,
  hardenWorkspaceFile,
  openExistingWorkspaceFile,
  rejectUnsafeDatabaseCompanions,
  rejectSerializedDatabaseCompanions,
  openWorkspaceDatabaseFile,
} from './file-utils.js';
import {
  acquireWorkspaceWriterAuthority,
  unlinkWorkspaceAuthorityEntry,
  authorityBoundDatabase,
  verifyWorkspaceWriterToken,
  recoverOrphanedRenameQuarantines,
  readWorkspaceAuthorityEntry,
} from './authority.js';

export abstract class WorkspaceSessionDatabaseBase {
  readonly workspaceRoot: string;
  readonly ownerKey: string;
  readonly storageDir: string;
  readonly dbPath: string;
  protected readonly db: SqliteDatabase;
  private readonly storageLease: WorkspaceStorageDirectoryLease;
  protected readonly archiveTrust: WorkspaceArchiveTrust | null;
  private readonly archiveTrustPayload: string;
  private readonly sharedRegistryKey: string;
  private archiveIsTrusted = false;
  private sharedSerialized: SharedSerializedWorkspaceDatabase | null = null;
  private closed = false;

  constructor(options: WorkspaceSessionDatabaseOptions) {
    if (!options.workspaceRoot || !path.isAbsolute(options.workspaceRoot)) {
      throw new Error('Workspace session storage requires an absolute workspaceRoot');
    }
    if (!options.ownerKey || !/^[A-Za-z0-9_-]{16,}$/.test(options.ownerKey)) {
      throw new Error('Workspace session storage requires a stable ownerKey');
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.ownerKey = options.ownerKey;
    this.storageDir = path.join(this.workspaceRoot, '.cc-web');
    this.dbPath = path.join(this.storageDir, 'session-state.sqlite');
    this.archiveTrust = options.archiveTrust ?? null;
    this.archiveTrustPayload = `cc-web-workspace-trust:v1:${this.ownerKey}:${this.workspaceRoot}`;
    this.storageLease = openWorkspaceStorageDirectorySync(
      this.workspaceRoot,
      {
        ...options.workspaceStorageOpenOptions,
        ...(options.expectedStorageIdentity
          ? { expectedIdentity: options.expectedStorageIdentity, createIfMissing: false }
          : {}),
      },
    );
    if (this.storageLease.entryMutationPolicy === 'deny') {
      this.storageLease.close();
      throw unsafeWorkspaceFile(
        'Workspace database mutations require descriptor-relative or cwd-bound helper access',
      );
    }
    const storageIdentity = fs.fstatSync(this.storageLease.fd, { bigint: true });
    if (!storageIdentity.isDirectory() || storageIdentity.ino === 0n) {
      this.storageLease.close();
      throw unsafeWorkspaceFile('Workspace database storage has no stable shared identity');
    }
    this.sharedRegistryKey = `${storageIdentity.dev}:${storageIdentity.ino}`;
    const existingShared = sharedSerializedDatabases.get(this.sharedRegistryKey);
    if (existingShared) {
      let archiveIsTrusted = false;
      try {
        existingShared.storageLease.verify();
        if (existingShared.poisoned) {
          throw unsafeWorkspaceFile('Workspace database writer is poisoned', existingShared.poisoned);
        }
        if (this.archiveTrust) {
          const row = existingShared.db.prepare(
            'SELECT value FROM workspace_settings WHERE key = ?',
          ).get(this.archiveTrustSetting()) as { value?: unknown } | undefined;
          archiveIsTrusted = typeof row?.value === 'string'
            && this.opensExpectedTrustMarker(row.value);
        }
      } catch (error) {
        this.storageLease.close();
        throw error;
      }
      this.storageLease.close();
      existingShared.refs += 1;
      this.sharedSerialized = existingShared;
      this.storageLease = existingShared.storageLease;
      this.db = this.facadeDatabase(existingShared.db);
      this.archiveIsTrusted = archiveIsTrusted;
      return;
    }
    let authority: ReturnType<typeof acquireWorkspaceWriterAuthority>;
    try {
      authority = acquireWorkspaceWriterAuthority(this.storageLease);
    } catch (error) {
      this.storageLease.close();
      throw error;
    }
    let authorityHeld = true;
    const releaseAuthority = (): void => {
      if (!authorityHeld) return;
      authorityHeld = false;
      unlinkWorkspaceAuthorityEntry(this.storageLease, WRITER_LEASE_NAME, authority.identity);
    };
    if (this.storageLease.entryMutationPolicy === 'cwd-helper') {
      let image: Buffer | undefined;
      try {
        recoverOrphanedRenameQuarantines(this.storageLease);
        rejectSerializedDatabaseCompanions(this.storageLease, this.dbPath);
        try {
          image = readCompleteWorkspaceCwdFile(
            this.storageLease, 'session-state.sqlite', MAX_SERIALIZED_DATABASE_BYTES,
          ).data;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const shared: SharedSerializedWorkspaceDatabase = {
          db: null as unknown as SqliteDatabase,
          storageLease: this.storageLease,
          token: authority.token,
          refs: 1,
          poisoned: null,
          serialized: true,
        };
        const db = authorityBoundDatabase(openSerializedDatabase({
          initialImage: image,
          publish: (next) => {
            if (next.byteLength > MAX_SERIALIZED_DATABASE_BYTES) {
              throw unsafeWorkspaceFile('Workspace database image exceeds the portable size limit');
            }
            this.verifySerializedWriterAuthority(shared);
            publishLargeWorkspaceCwdFile(shared.storageLease, 'session-state.sqlite', next);
            shared.storageLease.verify();
          },
          poison: (error) => { shared.poisoned = error; },
        }), () => { verifyWorkspaceWriterToken(this.storageLease, authority.token); },
        () => shared.poisoned);
        (shared as { db: SqliteDatabase }).db = db;
        this.sharedSerialized = shared;
        this.db = this.facadeDatabase(db);
        sharedSerializedDatabases.set(this.sharedRegistryKey, shared);
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('busy_timeout = 5000');
        this.migrate();
        if (this.archiveTrust) {
          const marker = this.getSetting(this.archiveTrustSetting());
          this.archiveIsTrusted = marker !== null && this.opensExpectedTrustMarker(marker);
          if (!image) this.markArchiveTrusted();
        }
        return;
      } catch (error) {
        try { this.sharedSerialized?.db.close(); } catch { /* Preserve the open failure. */ }
        try { releaseAuthority(); } catch { /* Preserve the open failure. */ }
        this.storageLease.close();
        sharedSerializedDatabases.delete(this.sharedRegistryKey);
        throw error;
      } finally { /* All cwd-helper reads are child-bound and close per request. */ }
    }
    let databaseFile: { fd: number; created: boolean } | null = null;
    let openedDatabase: SqliteDatabase | null = null;
    const shared: SharedSerializedWorkspaceDatabase = {
      db: null as unknown as SqliteDatabase,
      storageLease: this.storageLease,
      token: authority.token,
      refs: 1,
      poisoned: null,
      serialized: false,
    };
    try {
      this.storageLease.verify();
      rejectUnsafeDatabaseCompanions(this.storageLease, this.dbPath);
      databaseFile = openWorkspaceDatabaseFile(this.storageLease, this.dbPath);
      openedDatabase = authorityBoundDatabase(openDatabase(
        path.join(this.storageLease.accessPath, 'session-state.sqlite'),
        {
          fileBinding: {
            expectedFd: databaseFile.fd,
            displayPath: this.dbPath,
            verifyContainer: () => this.storageLease.verify(),
            testHooks: options.sqliteOpenTestHooks,
          },
        },
      ), () => { verifyWorkspaceWriterToken(this.storageLease, authority.token); },
      () => shared.poisoned);
      (shared as { db: SqliteDatabase }).db = openedDatabase;
      this.db = this.facadeDatabase(openedDatabase);
      this.storageLease.verify();
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
    } catch (error) {
      try { openedDatabase?.close(); } catch { /* Preserve the unsafe-storage error. */ }
      if (databaseFile) fs.closeSync(databaseFile.fd);
      try { releaseAuthority(); } catch { /* Preserve the unsafe-storage error. */ }
      this.storageLease.close();
      throw error;
    }
    // Keep the independently opened inode pinned through configuration and
    // migration.  This lets every pre/post-schema check prove the visible name
    // still denotes the exact single-link file inspected before SQLite opened.
    try {
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
      this.hardenDatabaseFiles();
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
      this.db.pragma('journal_mode = WAL');
      // journal_mode may create sidecars.  Bind and validate any such inode
      // before the first schema write, never after chmod has followed a name.
      this.hardenDatabaseFiles();
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.migrate();
      if (this.archiveTrust) {
        const marker = this.getSetting(this.archiveTrustSetting());
        this.archiveIsTrusted = marker !== null && this.opensExpectedTrustMarker(marker);
        if (databaseFile.created) this.markArchiveTrusted();
      }
      this.storageLease.verify();
      this.hardenDatabaseFiles();
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
    } catch (error) {
      try { openedDatabase?.close(); } catch { /* Preserve the unsafe-storage error. */ }
      try { releaseAuthority(); } catch { /* Preserve the unsafe-storage error. */ }
      this.storageLease.close();
      throw error;
    } finally {
      fs.closeSync(databaseFile.fd);
    }
    this.sharedSerialized = shared;
    sharedSerializedDatabases.set(this.sharedRegistryKey, shared);
    // Migration is deliberately explicit. At construction time we know a
    // workspace path, not which of an owner's old sessions belonged to it;
    // importing every row into the first workspace opened would be data loss
    // in disguise once the legacy source is cleaned up.
  }

  get raw(): SqliteDatabase { return this.db; }
  get trustedArchive(): boolean { return this.archiveIsTrusted; }

  private facadeDatabase(database: SqliteDatabase): SqliteDatabase {
    const usable = (): void => {
      if (this.closed) throw new Error('Workspace session database facade is closed');
    };
    const around = <Result>(operation: () => Result): Result => {
      usable();
      return operation();
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
        const transaction = around(() => database.transaction(fn));
        return (...args: Args): Result => around(() => transaction(...args));
      },
      ...(database.verifyFileBindings ? {
        verifyFileBindings: (expected: Parameters<NonNullable<SqliteDatabase['verifyFileBindings']>>[0]) =>
          around(() => database.verifyFileBindings!(expected)),
      } : {}),
      close: () => this.close(),
    };
  }

  /**
   * Return authority from the directory handle that has contained SQLite for
   * this store's entire lifetime. Reopening the visible pathname here would
   * accept a replacement planted while the original database is still live.
   */
  storageIdentity(): WorkspaceStorageIdentity {
    if (this.closed) throw new Error('Workspace session database is closed');
    this.storageLease.verify();
    const before = fs.fstatSync(this.storageLease.fd, { bigint: true });
    if (!before.isDirectory()) throw unsafeWorkspaceFile('Workspace storage lease is not a directory');
    this.storageLease.verify();
    const after = fs.fstatSync(this.storageLease.fd, { bigint: true });
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw unsafeWorkspaceFile('Workspace storage lease changed while its identity was captured');
    }
    return { dev: after.dev, ino: after.ino };
  }

  markArchiveTrusted(): void {
    if (!this.archiveTrust || this.archiveIsTrusted) return;
    this.setSetting(this.archiveTrustSetting(), this.archiveTrust.seal(this.archiveTrustPayload));
    this.archiveIsTrusted = true;
  }

  private archiveTrustSetting(): string {
    return `workspace.archiveTrust.v1.${this.ownerKey}`;
  }

  private opensExpectedTrustMarker(marker: string): boolean {
    try {
      return this.archiveTrust?.open(marker) === this.archiveTrustPayload;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.sharedSerialized) {
      const shared = this.sharedSerialized;
      if (shared.refs > 1) {
        shared.refs -= 1;
        this.sharedSerialized = null;
        this.closed = true;
        return;
      }
      try {
        shared.db.close();
      } catch (error) {
        // The SQLite provider may still own live file/VFS state. Retain the
        // sole-writer token, registry entry and directory lease so no second
        // writer can open. The same facade may retry close after the provider
        // becomes closable; every other facade/open fails stop on `poisoned`.
        shared.poisoned = error;
        throw error;
      }
      try {
        const expectedEntry = this.verifySerializedWriterAuthority(shared);
        unlinkWorkspaceAuthorityEntry(shared.storageLease, WRITER_LEASE_NAME, expectedEntry);
      } catch (error) {
        shared.poisoned = error;
        throw error;
      }
      sharedSerializedDatabases.delete(this.sharedRegistryKey);
      shared.refs = 0;
      this.sharedSerialized = null;
      this.closed = true;
      try {
        shared.storageLease.close();
      } catch (error) {
        // Authority and SQLite are already retired, so reopening is safe even
        // though closing the local validation descriptor reported a failure.
        throw error;
      }
      return;
    }
    throw unsafeWorkspaceFile('Workspace database facade lost its shared close authority');
  }

  private verifySerializedWriterAuthority(
    shared: SharedSerializedWorkspaceDatabase,
  ): { dev: bigint; ino: bigint } {
    const entry = readWorkspaceAuthorityEntry(shared.storageLease, WRITER_LEASE_NAME);
    const parsed = JSON.parse(entry.bytes.toString('utf8')) as { token?: unknown };
    if (parsed.token !== shared.token) throw unsafeWorkspaceFile('Workspace database writer authority was replaced');
    return entry.identity;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM workspace_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM workspace_settings WHERE key = ?').run(key);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL,
        name TEXT NOT NULL, created_at TEXT NOT NULL, last_activity TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0, agent TEXT, last_agent TEXT, runtime_label TEXT,
        terminal_options_json TEXT, working_dir TEXT NOT NULL, output_buffer_json TEXT NOT NULL,
        session_start_time TEXT, session_usage_json TEXT NOT NULL,
        max_buffer_size INTEGER NOT NULL DEFAULT 1000, last_accessed INTEGER NOT NULL DEFAULT 0,
        surface TEXT, native_chat_session_id TEXT, owner_session_id TEXT,
        chat_bypass_permissions INTEGER, chat_model_override TEXT, chat_model_pinned TEXT,
        chat_effort_override TEXT, chat_plan_mode INTEGER, chat_draft_json TEXT, custom_name TEXT,
        tab_open INTEGER, tab_order INTEGER, project_id TEXT, project_working_dir_kind TEXT,
        operational_envelope TEXT, rollback_recovery_pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_key, id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_sessions_owner_created
        ON runtime_sessions(owner_key, created_at);
      CREATE TABLE IF NOT EXISTS usage_jobs (
        id TEXT NOT NULL, owner_key TEXT NOT NULL,
        session_id TEXT NOT NULL, native_session_id TEXT, turn_id TEXT NOT NULL,
        user_id INTEGER NOT NULL, user_login TEXT NOT NULL, agent TEXT NOT NULL, model TEXT,
        project TEXT, project_source TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
        duration_ms INTEGER, outcome TEXT NOT NULL, turns INTEGER NOT NULL,
        model_turns INTEGER, tool_calls INTEGER NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, total_tokens INTEGER, cost_usd REAL,
        reports_usage INTEGER NOT NULL, reports_cost INTEGER NOT NULL,
        PRIMARY KEY (owner_key, id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_usage_owner_ended
        ON usage_jobs(owner_key, ended_at);
      CREATE INDEX IF NOT EXISTS idx_workspace_usage_owner_native
        ON usage_jobs(owner_key, native_session_id);
      CREATE TABLE IF NOT EXISTS usage_job_models (
        owner_key TEXT NOT NULL, job_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, cost_usd REAL, PRIMARY KEY(owner_key, job_id, model)
      );
      CREATE TABLE IF NOT EXISTS usage_job_tools (
        owner_key TEXT NOT NULL, job_id TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL,
        PRIMARY KEY(owner_key, job_id, tool)
      );
    `);
    this.addColumnIfMissing('runtime_sessions', 'operational_envelope', 'TEXT');
    this.addColumnIfMissing('runtime_sessions', 'chat_draft_json', 'TEXT');
    this.addColumnIfMissing(
      'runtime_sessions',
      'rollback_recovery_pending',
      'INTEGER NOT NULL DEFAULT 0',
    );
    // Provenance of a codex cost estimate (issue #182); see the app-db column
    // of the same name. Travels with the row, so removing a usage record
    // removes its estimate.
    this.addColumnIfMissing('usage_jobs', 'cost_estimate', 'TEXT');
  }

  /** Additive, nullable and safe to run again after an interrupted upgrade. */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((existing) => existing.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /** SQLite creates sidecars lazily, so harden every one that exists on open. */
  private hardenDatabaseFiles(): void {
    const opened: Array<{ fd: number; displayPath: string }> = [];
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const visible = `${this.dbPath}${suffix}`;
        try {
          const fd = openExistingWorkspaceFile(this.storageLease, visible);
          opened.push({ fd, displayPath: visible });
          hardenWorkspaceFile(fd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // The visible names and independently opened descriptors above are only
      // half of the proof. Match every persistent regular fd opened by SQLite
      // itself while the safe descriptors are still pinned.
      this.db.verifyFileBindings?.(opened);
    } finally {
      for (const binding of opened.reverse()) fs.closeSync(binding.fd);
    }
  }
}
