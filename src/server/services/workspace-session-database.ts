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
import { AppDatabase } from './database.js';
import {
  openDatabase,
  type SqliteDatabase,
  type SqliteOpenFileBinding,
} from './sqlite.js';
import {
  openWorkspaceStorageDirectorySync,
  type WorkspaceStorageIdentity,
  type WorkspaceStorageOpenOptions,
  type WorkspaceStorageDirectoryLease,
} from './workspace-session-storage.js';

export interface WorkspaceSessionDatabaseOptions {
  workspaceRoot: string;
  /** A stable, non-reversible account identity (normally SHA-256 of github id). */
  ownerKey: string;
  /** Optional source for the one-time move from pre-workspace storage. */
  legacyDatabase?: AppDatabase;
  legacyOwnerUserId?: number;
  /** Installation-owned authenticated envelope for sensitive restored state. */
  archiveTrust?: WorkspaceArchiveTrust;
  /** Deterministic SQLite pathname-swap seam for security tests only. */
  sqliteOpenTestHooks?: SqliteOpenFileBinding['testHooks'];
  /** Deterministic descriptor-capability seam for security tests only. */
  workspaceStorageOpenOptions?: WorkspaceStorageOpenOptions;
  /** Lifecycle authority captured from the previously-open database lease. */
  expectedStorageIdentity?: WorkspaceStorageIdentity;
}

export interface WorkspaceArchiveTrust {
  seal(value: string): string;
  open(envelope: string): string;
}

/**
 * The subset of a runtime row which can influence what is launched or resumed.
 *
 * Workspace databases are portable user-controlled files.  These values must
 * therefore be authenticated by the installation before they are allowed back
 * into a live SessionRecord.  Keep the keys explicit and ordered: the JSON
 * representation is the authenticated wire format, not a convenience dump of
 * an arbitrary SQLite row.
 */
export interface RuntimeSessionOperationalState {
  id: string;
  rollback_recovery_pending?: number | null;
  working_dir: string;
  surface: string | null;
  last_agent: string | null;
  runtime_label: string | null;
  terminal_options_json: string | null;
  session_start_time: string | null;
  max_buffer_size: number;
  native_chat_session_id: string | null;
  owner_session_id: string | null;
  chat_bypass_permissions: number | null;
  chat_model_override: string | null;
  chat_model_pinned: string | null;
  chat_effort_override: string | null;
  chat_plan_mode: number | null;
  project_id: string | null;
  project_working_dir_kind: string | null;
}

export interface SessionPersistenceDatabase {
  readonly storageDir: string;
  readonly dbPath: string;
  readonly raw: SqliteDatabase;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  close(): void;
  readonly trustedArchive?: boolean;
  markArchiveTrusted?(): void;
  sealRuntimeSessionRecord?(record: RuntimeSessionOperationalState): string | null;
  verifyRuntimeSessionRecord?(
    record: RuntimeSessionOperationalState,
    envelope: string | null,
  ): boolean;
}

const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

function unsafeWorkspaceFile(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE', cause });
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
}

function verifyWorkspaceFileBinding(visible: string, fd: number): void {
  const before = fs.lstatSync(visible);
  const openedBefore = fs.fstatSync(fd);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !openedBefore.isFile()
    || before.nlink !== 1
    || openedBefore.nlink !== 1
    || fs.realpathSync(visible) !== visible
    || !sameFileIdentity(before, openedBefore)
  ) {
    throw unsafeWorkspaceFile(`Workspace database component is unsafe: ${visible}`);
  }
  const after = fs.lstatSync(visible);
  const openedAfter = fs.fstatSync(fd);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || !openedAfter.isFile()
    || after.nlink !== 1
    || openedAfter.nlink !== 1
    || !sameFileIdentity(before, after)
  ) {
    throw unsafeWorkspaceFile(`Workspace database component changed while opening: ${visible}`);
  }
}

function hardenWorkspaceFile(fd: number): void {
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function openExistingWorkspaceFile(
  lease: WorkspaceStorageDirectoryLease,
  visible: string,
): number {
  lease.verify();
  const access = path.join(lease.accessPath, path.basename(visible));
  let fd: number;
  try {
    fd = fs.openSync(access, fs.constants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw unsafeWorkspaceFile(`Refusing a symlinked workspace database component: ${visible}`, error);
    }
    throw error;
  }
  try {
    verifyWorkspaceFileBinding(visible, fd);
    lease.verify();
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openWorkspaceDatabaseFile(
  lease: WorkspaceStorageDirectoryLease,
  visible: string,
): { fd: number; created: boolean } {
  lease.verify();
  const access = path.join(lease.accessPath, path.basename(visible));
  try {
    const fd = fs.openSync(
      access,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      verifyWorkspaceFileBinding(visible, fd);
      lease.verify();
      return { fd, created: true };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { fd: openExistingWorkspaceFile(lease, visible), created: false };
  }
}

function rejectUnsafeDatabaseCompanions(
  lease: WorkspaceStorageDirectoryLease,
  dbPath: string,
): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let fd: number | null = null;
    try {
      fd = openExistingWorkspaceFile(lease, `${dbPath}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}

function normalizeRuntimeSessionOperationalState(
  record: RuntimeSessionOperationalState,
): RuntimeSessionOperationalState {
  const nullableText = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : String(value);
  const nullableInteger = (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);
  return {
    id: String(record.id),
    rollback_recovery_pending: nullableInteger(record.rollback_recovery_pending),
    working_dir: String(record.working_dir),
    surface: nullableText(record.surface),
    last_agent: nullableText(record.last_agent),
    runtime_label: nullableText(record.runtime_label),
    terminal_options_json: nullableText(record.terminal_options_json),
    session_start_time: nullableText(record.session_start_time),
    max_buffer_size: Number(record.max_buffer_size),
    native_chat_session_id: nullableText(record.native_chat_session_id),
    owner_session_id: nullableText(record.owner_session_id),
    chat_bypass_permissions: nullableInteger(record.chat_bypass_permissions),
    chat_model_override: nullableText(record.chat_model_override),
    chat_model_pinned: nullableText(record.chat_model_pinned),
    chat_effort_override: nullableText(record.chat_effort_override),
    chat_plan_mode: nullableInteger(record.chat_plan_mode),
    project_id: nullableText(record.project_id),
    project_working_dir_kind: nullableText(record.project_working_dir_kind),
  };
}

function operationalStateFromDatabaseRow(
  row: Record<string, unknown>,
): RuntimeSessionOperationalState {
  const text = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  const integer = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return normalizeRuntimeSessionOperationalState({
    id: String(row.id),
    rollback_recovery_pending: integer('rollback_recovery_pending'),
    working_dir: String(row.working_dir),
    surface: text('surface'),
    last_agent: text('last_agent'),
    runtime_label: text('runtime_label'),
    terminal_options_json: text('terminal_options_json'),
    session_start_time: text('session_start_time'),
    max_buffer_size: Number(row.max_buffer_size),
    native_chat_session_id: text('native_chat_session_id'),
    owner_session_id: text('owner_session_id'),
    chat_bypass_permissions: integer('chat_bypass_permissions'),
    chat_model_override: text('chat_model_override'),
    chat_model_pinned: text('chat_model_pinned'),
    chat_effort_override: text('chat_effort_override'),
    chat_plan_mode: integer('chat_plan_mode'),
    project_id: text('project_id'),
    project_working_dir_kind: text('project_working_dir_kind'),
  });
}

/** A workspace-local state file, shared safely by accounts through owner_key. */
export class WorkspaceSessionDatabase implements SessionPersistenceDatabase {
  readonly workspaceRoot: string;
  readonly ownerKey: string;
  readonly storageDir: string;
  readonly dbPath: string;
  private readonly db: SqliteDatabase;
  private readonly storageLease: WorkspaceStorageDirectoryLease;
  private readonly archiveTrust: WorkspaceArchiveTrust | null;
  private readonly archiveTrustPayload: string;
  private archiveIsTrusted = false;
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
        'Workspace database mutations require descriptor-relative or proven handle-pinned access',
      );
    }
    let databaseFile: { fd: number; created: boolean } | null = null;
    let openedDatabase: SqliteDatabase | null = null;
    try {
      this.storageLease.verify();
      rejectUnsafeDatabaseCompanions(this.storageLease, this.dbPath);
      databaseFile = openWorkspaceDatabaseFile(this.storageLease, this.dbPath);
      openedDatabase = openDatabase(
        path.join(this.storageLease.accessPath, 'session-state.sqlite'),
        {
          fileBinding: {
            expectedFd: databaseFile.fd,
            displayPath: this.dbPath,
            verifyContainer: () => this.storageLease.verify(),
            testHooks: options.sqliteOpenTestHooks,
          },
        },
      );
      this.db = openedDatabase;
      this.storageLease.verify();
      verifyWorkspaceFileBinding(this.dbPath, databaseFile.fd);
    } catch (error) {
      try { openedDatabase?.close(); } catch { /* Preserve the unsafe-storage error. */ }
      if (databaseFile) fs.closeSync(databaseFile.fd);
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
      try { this.db.close(); } catch { /* Preserve the unsafe-storage error. */ }
      this.storageLease.close();
      throw error;
    } finally {
      fs.closeSync(databaseFile.fd);
    }
    // Migration is deliberately explicit. At construction time we know a
    // workspace path, not which of an owner's old sessions belonged to it;
    // importing every row into the first workspace opened would be data loss
    // in disguise once the legacy source is cleaned up.
  }

  get raw(): SqliteDatabase { return this.db; }
  get trustedArchive(): boolean { return this.archiveIsTrusted; }

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

  sealRuntimeSessionRecord(record: RuntimeSessionOperationalState): string | null {
    if (!this.archiveTrust) return null;
    return this.archiveTrust.seal(this.runtimeSessionTrustPayload(record));
  }

  verifyRuntimeSessionRecord(
    record: RuntimeSessionOperationalState,
    envelope: string | null,
  ): boolean {
    // A bound/custom backend without installation key material cannot prove a
    // portable row's execution authority. History remains readable, but every
    // runtime/resume/approval control must fail closed just as an invalid
    // envelope does. Production supplies archiveTrust through the coordinator;
    // keeping this branch strict prevents a future composition omission from
    // silently turning a workspace-controlled SQLite row into authority.
    if (!this.archiveTrust) return false;
    if (!envelope) return false;
    try {
      const opened = this.archiveTrust.open(envelope);
      const current = this.runtimeSessionTrustPayload(record, 2);
      if (opened === current) return true;

      const normalized = normalizeRuntimeSessionOperationalState(record);
      // Version 1 predates rollback anchors, so it cannot authenticate a true
      // recovery bit. It remains a valid authority only for an ordinary row;
      // immediately replace it with v2 so the compatibility path is one-shot.
      if (
        normalized.rollback_recovery_pending !== 1
        && opened === this.runtimeSessionTrustPayload(record, 1)
      ) {
        const resealed = this.archiveTrust.seal(current);
        const updated = this.db.prepare(`UPDATE runtime_sessions
          SET operational_envelope = ?
          WHERE owner_key = ? AND id = ? AND operational_envelope = ?`)
          .run(resealed, this.ownerKey, normalized.id, envelope);
        return Number(updated.changes ?? 0) === 1;
      }
      return false;
    } catch {
      return false;
    }
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

  private runtimeSessionTrustPayload(
    record: RuntimeSessionOperationalState,
    version: 1 | 2 = 2,
  ): string {
    const normalized = normalizeRuntimeSessionOperationalState(record);
    return JSON.stringify({
      version,
      ownerKey: this.ownerKey,
      workspaceRoot: this.workspaceRoot,
      sessionId: normalized.id,
      operational: {
        ...(version === 2 ? {
          rollbackRecoveryPending: normalized.rollback_recovery_pending,
        } : {}),
        workingDir: normalized.working_dir,
        surface: normalized.surface,
        lastAgent: normalized.last_agent,
        runtimeLabel: normalized.runtime_label,
        terminalOptionsJson: normalized.terminal_options_json,
        sessionStartTime: normalized.session_start_time,
        maxBufferSize: normalized.max_buffer_size,
        nativeChatSessionId: normalized.native_chat_session_id,
        ownerSessionId: normalized.owner_session_id,
        chatBypassPermissions: normalized.chat_bypass_permissions,
        chatModelOverride: normalized.chat_model_override,
        chatModelPinned: normalized.chat_model_pinned,
        chatEffortOverride: normalized.chat_effort_override,
        chatPlanMode: normalized.chat_plan_mode,
        projectId: normalized.project_id,
        projectWorkingDirKind: normalized.project_working_dir_kind,
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.storageLease.close();
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

  /** Refresh installation-local ids after an authorised owner-key match. */
  rebindOwnerIdentity(ownerUserId: number, ownerLogin: string): void {
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0 || !ownerLogin) {
      throw new Error('Workspace owner identity is invalid');
    }
    const rebind = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE runtime_sessions SET owner_user_id = ? WHERE owner_key = ?',
      ).run(ownerUserId, this.ownerKey);
      this.db.prepare(
        'UPDATE usage_jobs SET user_id = ?, user_login = ? WHERE owner_key = ?',
      ).run(ownerUserId, ownerLogin, this.ownerKey);
    });
    rebind();
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

  /**
   * Move rows only after they have been copied and counted in this file.
   *
   * There is no transaction spanning the installation and workspace files.
   * Holding an IMMEDIATE transaction on the source is therefore load-bearing:
   * it prevents a legacy writer from committing a newer row after our SELECT
   * but before cleanup.  The destination commits first, so a crash can still
   * duplicate a row (the primary keys make that harmless) but cannot lose the
   * only copy or delete an update which was never verified.
   */
  migrateLegacySessions(
    legacy: AppDatabase,
    legacyOwnerUserId: number,
    sessionIds: Iterable<string>,
  ): boolean {
    const ids = [...new Set(Array.from(sessionIds, String).filter(Boolean))];
    if (ids.length === 0) return true;
    const source = legacy.raw;
    try {
      this.withLegacyWriteLock(source, () => {
        const requested = new Set(ids);
        const requestedSlots = ids.map(() => '?').join(', ');
        const sessions = source.prepare(
          `SELECT * FROM runtime_sessions WHERE owner_user_id = ? AND id IN (${requestedSlots})`,
        ).all(legacyOwnerUserId, ...ids) as Array<Record<string, unknown>>;
        const sourceIds = new Set(sessions.map((row) => String(row.id)));
        const targetExists = this.db.prepare(
          'SELECT 1 AS present FROM runtime_sessions WHERE owner_key = ? AND id = ? LIMIT 1',
        );
        // A retry can legitimately name members whose source rows disappeared
        // after an earlier successful cutover. Treat them as complete only
        // when this exact owner archive already contains their destination.
        for (const id of ids) {
          if (!sourceIds.has(id) && !targetExists.get(this.ownerKey, id)) {
            throw new Error('legacy session source changed before migration');
          }
        }

        const dependencyRows = source.prepare(`
          SELECT id, owner_session_id
          FROM runtime_sessions
          WHERE owner_user_id = ?
        `).all(legacyOwnerUserId) as Array<{ id: string; owner_session_id: string | null }>;
        const sourceDependencies = new Map(
          dependencyRows.map((row) => [String(row.id), row.owner_session_id || null]),
        );

        // Enforce the unit boundary while the source writer reservation is
        // held. The orchestrator is not a security boundary: no direct caller
        // may cut over a child without naming its parent, or a parent while
        // leaving any transitive descendant in app.sqlite.
        for (const row of sessions) {
          let currentId = String(row.id);
          const seen = new Set<string>();
          for (;;) {
            if (seen.has(currentId)) {
              throw new Error('legacy session ownership contains a cycle');
            }
            seen.add(currentId);
            const parentId = sourceDependencies.get(currentId);
            if (!parentId) break;
            if (!requested.has(parentId)) {
              throw new Error('legacy migration unit omitted a parent session');
            }
            if (!sourceDependencies.has(parentId) && !targetExists.get(this.ownerKey, parentId)) {
              throw new Error('legacy migration unit parent is unavailable');
            }
            currentId = parentId;
          }
        }
        for (const row of dependencyRows) {
          if (requested.has(String(row.id))) continue;
          let parentId = row.owner_session_id || null;
          const seen = new Set<string>([String(row.id)]);
          while (parentId) {
            if (seen.has(parentId)) {
              // An unrelated corrupt unit must not block an independent one.
              // Cycles intersecting the requested unit are rejected above.
              break;
            }
            seen.add(parentId);
            if (requested.has(parentId)) {
              throw new Error('legacy migration unit omitted a descendant session');
            }
            parentId = sourceDependencies.get(parentId) ?? null;
          }
        }

        // Every requested member is already authoritative locally.
        if (sessions.length === 0) return;
        const remainingIds = sessions.map((row) => String(row.id));
        const slots = remainingIds.map(() => '?').join(', ');
        // Usage follows the application session id, not the native runtime id:
        // clearing/compacting a chat replaces the latter but it is still one
        // workspace record and must move with it.
        const jobs = source.prepare(
          `SELECT * FROM usage_jobs WHERE user_id = ? AND session_id IN (${slots})`,
        ).all(legacyOwnerUserId, ...remainingIds) as Array<Record<string, unknown>>;
        const copy = this.db.transaction(() => {
          for (const row of sessions) this.copyLegacySession(row);
          for (const row of jobs) this.copyLegacyJob(source, row);
        });
        copy();
        const copiedSessions = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM runtime_sessions WHERE owner_key = ? AND id IN (${slots})`,
        ).get(this.ownerKey, ...remainingIds) as { n: number }).n);
        const jobIds = jobs.map((row) => String(row.id));
        const copiedJobs = jobIds.length === 0 ? 0 : Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_jobs WHERE owner_key = ? AND id IN (${jobIds.map(() => '?').join(', ')})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        if (copiedSessions !== sessions.length || copiedJobs !== jobs.length) {
          throw new Error('workspace copy verification did not find every legacy row');
        }
        // Seal the already-verified destination before releasing the source
        // lock. If the source COMMIT fails, both copies remain and retry is
        // idempotent; if sealing fails, the source transaction rolls back.
        this.markArchiveTrusted();
        // Verification succeeded. Delete only this owner's records; settings
        // and other accounts remain in the installation database.
        source.prepare(`DELETE FROM runtime_sessions WHERE owner_user_id = ? AND id IN (${slots})`)
          .run(legacyOwnerUserId, ...remainingIds);
        source.prepare(`DELETE FROM usage_jobs WHERE user_id = ? AND session_id IN (${slots})`)
          .run(legacyOwnerUserId, ...remainingIds);
      });
      return true;
    } catch (error) {
      // The source deliberately remains intact. A later construction retries
      // the idempotent inserts and gets another opportunity to verify.
      console.error('Workspace session migration did not complete:', error);
      return false;
    }
  }

  /**
   * Preserve usage whose conversation row was deleted by an older release.
   * Those rows no longer carry a recoverable workspace path, so the caller
   * selects one authorised owner archive explicitly; they are never guessed
   * into a project and never left invisible in the global database.
   */
  migrateLegacyOrphanUsage(legacy: AppDatabase, legacyOwnerUserId: number): boolean {
    const source = legacy.raw;
    try {
      this.withLegacyWriteLock(source, () => {
        const jobs = source.prepare(`
          SELECT usage_jobs.*
          FROM usage_jobs
          LEFT JOIN runtime_sessions
            ON runtime_sessions.id = usage_jobs.session_id
           AND runtime_sessions.owner_user_id = usage_jobs.user_id
          WHERE usage_jobs.user_id = ? AND runtime_sessions.id IS NULL
        `).all(legacyOwnerUserId) as Array<Record<string, unknown>>;
        if (jobs.length === 0) return;

        const copy = this.db.transaction(() => {
          for (const row of jobs) this.copyLegacyJob(source, row);
        });
        copy();

        const jobIds = jobs.map((row) => String(row.id));
        const slots = jobIds.map(() => '?').join(', ');
        const copiedJobs = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_jobs WHERE owner_key = ? AND id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        const sourceModels = Number((source.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_models WHERE job_id IN (${slots})`,
        ).get(...jobIds) as { n: number }).n);
        const copiedModels = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_models WHERE owner_key = ? AND job_id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        const sourceTools = Number((source.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_tools WHERE job_id IN (${slots})`,
        ).get(...jobIds) as { n: number }).n);
        const copiedTools = Number((this.db.prepare(
          `SELECT COUNT(*) AS n FROM usage_job_tools WHERE owner_key = ? AND job_id IN (${slots})`,
        ).get(this.ownerKey, ...jobIds) as { n: number }).n);
        if (
          copiedJobs !== jobs.length
          || copiedModels !== sourceModels
          || copiedTools !== sourceTools
        ) {
          throw new Error('orphan usage copy verification did not match source rows');
        }

        source.prepare(
          `DELETE FROM usage_jobs WHERE user_id = ? AND id IN (${slots})`,
        ).run(legacyOwnerUserId, ...jobIds);
      });
      return true;
    } catch (error) {
      console.error('Legacy orphan usage migration did not complete:', error);
      return false;
    }
  }

  /**
   * Acquire SQLite's writer reservation before the first legacy SELECT.
   * A deferred transaction would only pin a read snapshot; in WAL mode a
   * second connection could still commit an update and our later DELETE would
   * either erase unseen data or strand a stale destination collision.
   */
  private withLegacyWriteLock<Result>(source: SqliteDatabase, operation: () => Result): Result {
    source.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      source.exec('COMMIT');
      return result;
    } catch (error) {
      try { source.exec('ROLLBACK'); } catch { /* Preserve the cutover error. */ }
      throw error;
    }
  }

  private copyLegacySession(row: Record<string, unknown>): void {
    const cols = [
      'id', 'owner_user_id', 'name', 'created_at', 'last_activity', 'active', 'agent', 'last_agent',
      'runtime_label', 'terminal_options_json', 'working_dir', 'output_buffer_json',
      'session_start_time', 'session_usage_json', 'max_buffer_size', 'last_accessed', 'surface',
      'native_chat_session_id', 'owner_session_id', 'chat_bypass_permissions', 'chat_model_override',
      'chat_model_pinned', 'chat_effort_override', 'chat_plan_mode', 'custom_name', 'tab_open',
      'tab_order', 'project_id', 'project_working_dir_kind',
    ];
    const values = cols.map((key) => row[key] ?? null);
    const envelope = this.sealRuntimeSessionRecord({
      ...operationalStateFromDatabaseRow(row),
      // Legacy installation rows cannot be rollback anchors. The workspace
      // target column is additive and defaults to the only safe legacy value.
      rollback_recovery_pending: 0,
    });
    this.db.prepare(`INSERT OR IGNORE INTO runtime_sessions
      (owner_key, ${cols.join(', ')}, operational_envelope)
      VALUES (${['?'].concat(cols.map(() => '?'), ['?']).join(', ')})`)
      .run(this.ownerKey, ...values, envelope);
    const target = this.db.prepare(
      `SELECT ${cols.join(', ')} FROM runtime_sessions WHERE owner_key = ? AND id = ?`,
    ).get(this.ownerKey, row.id) as Record<string, unknown> | undefined;
    this.assertEquivalentLegacyRow('session', row, target, cols, new Set(['owner_user_id']));
    // INSERT OR IGNORE makes crash recovery idempotent; refresh the envelope
    // only after the pre-existing row has been proven equivalent to source.
    this.db.prepare(`UPDATE runtime_sessions SET operational_envelope = ?
      WHERE owner_key = ? AND id = ?`).run(envelope, this.ownerKey, row.id);
  }

  private copyLegacyJob(source: SqliteDatabase, row: Record<string, unknown>): void {
    // Derived compatibility fields used to be backfilled in app.sqlite on
    // every boot. The installation database is now import-only: preserve its
    // exact row and apply the historical normalisation solely to the verified
    // workspace destination.
    const normalized: Record<string, unknown> = { ...row };
    if (normalized.project !== null && normalized.project !== undefined
      && (normalized.project_source === null || normalized.project_source === undefined)) {
      normalized.project_source = 'observed';
    }
    if (normalized.total_tokens === null || normalized.total_tokens === undefined) {
      const tokenParts = [
        normalized.input_tokens,
        normalized.output_tokens,
        normalized.cache_read_tokens,
        normalized.cache_write_tokens,
      ];
      if (tokenParts.some((value) => value !== null && value !== undefined)) {
        normalized.total_tokens = tokenParts.reduce<number>(
          (sum, value) => sum + (typeof value === 'number' ? value : 0),
          0,
        );
      } else if (typeof normalized.reasoning_tokens === 'number') {
        normalized.total_tokens = normalized.reasoning_tokens;
      }
    }
    const cols = [
      'id', 'session_id', 'native_session_id', 'turn_id', 'user_id', 'user_login', 'agent', 'model',
      'project', 'project_source', 'started_at', 'ended_at', 'duration_ms', 'outcome', 'turns',
      'model_turns', 'tool_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens',
      'cache_write_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'reports_usage', 'reports_cost',
    ];
    this.db.prepare(`INSERT OR IGNORE INTO usage_jobs (owner_key, ${cols.join(', ')})
      VALUES (${['?'].concat(cols.map(() => '?')).join(', ')})`).run(
      this.ownerKey, ...cols.map((key) => normalized[key] ?? null),
    );
    const id = String(row.id);
    const selectTarget = this.db.prepare(
      `SELECT ${cols.join(', ')} FROM usage_jobs WHERE owner_key = ? AND id = ?`,
    );
    let target = selectTarget.get(this.ownerKey, id) as Record<string, unknown> | undefined;
    try {
      this.assertEquivalentLegacyRow(
        'usage job',
        normalized,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
    } catch {
      // A crash from a build predating destination-only normalisation can
      // leave an otherwise exact local row with the two source-null fields.
      // Prove that raw equivalence before upgrading only this workspace copy;
      // an unrelated collision still fails the raw comparison and is never
      // overwritten.
      this.assertEquivalentLegacyRow(
        'usage job',
        row,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
      this.db.prepare(`UPDATE usage_jobs
        SET project_source = ?, total_tokens = ?
        WHERE owner_key = ? AND id = ?`).run(
        normalized.project_source ?? null,
        normalized.total_tokens ?? null,
        this.ownerKey,
        id,
      );
      target = selectTarget.get(this.ownerKey, id) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow(
        'usage job',
        normalized,
        target,
        cols,
        new Set(['user_id', 'user_login']),
      );
    }
    const models = source.prepare('SELECT * FROM usage_job_models WHERE job_id = ?').all(id) as Array<Record<string, unknown>>;
    const modelCols = [
      'job_id', 'model', 'calls', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'cost_usd',
    ];
    for (const model of models) {
      this.db.prepare(`INSERT OR IGNORE INTO usage_job_models
        (owner_key, ${modelCols.join(', ')}) VALUES (?, ${modelCols.map(() => '?').join(', ')})`)
        .run(this.ownerKey, ...modelCols.map((key) => model[key] ?? null));
      const copied = this.db.prepare(`SELECT ${modelCols.join(', ')} FROM usage_job_models
        WHERE owner_key = ? AND job_id = ? AND model = ?`)
        .get(this.ownerKey, model.job_id, model.model) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow('usage model', model, copied, modelCols);
    }
    const tools = source.prepare('SELECT * FROM usage_job_tools WHERE job_id = ?').all(id) as Array<Record<string, unknown>>;
    const toolCols = ['job_id', 'tool', 'calls'];
    for (const tool of tools) {
      this.db.prepare('INSERT OR IGNORE INTO usage_job_tools (owner_key, job_id, tool, calls) VALUES (?, ?, ?, ?)')
        .run(this.ownerKey, tool.job_id, tool.tool, tool.calls);
      const copied = this.db.prepare(`SELECT ${toolCols.join(', ')} FROM usage_job_tools
        WHERE owner_key = ? AND job_id = ? AND tool = ?`)
        .get(this.ownerKey, tool.job_id, tool.tool) as Record<string, unknown> | undefined;
      this.assertEquivalentLegacyRow('usage tool', tool, copied, toolCols);
    }
    const targetModels = Number((this.db.prepare(
      'SELECT COUNT(*) AS n FROM usage_job_models WHERE owner_key = ? AND job_id = ?',
    ).get(this.ownerKey, id) as { n: number }).n);
    const targetTools = Number((this.db.prepare(
      'SELECT COUNT(*) AS n FROM usage_job_tools WHERE owner_key = ? AND job_id = ?',
    ).get(this.ownerKey, id) as { n: number }).n);
    if (targetModels !== models.length || targetTools !== tools.length) {
      throw new Error(`legacy usage child collision for ${id}`);
    }
  }

  private assertEquivalentLegacyRow(
    label: string,
    source: Record<string, unknown>,
    target: Record<string, unknown> | undefined,
    columns: string[],
    ignored = new Set<string>(),
  ): void {
    if (!target) throw new Error(`legacy ${label} copy is missing`);
    for (const column of columns) {
      if (ignored.has(column)) continue;
      const expected = source[column] ?? null;
      const actual = target[column] ?? null;
      if (!Object.is(actual, expected)) {
        throw new Error(`legacy ${label} collision in ${column}`);
      }
    }
  }
}
