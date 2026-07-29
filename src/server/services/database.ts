import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, SqliteDatabase } from './sqlite.js';
import { AuthenticatedUser } from '../types.js';

export interface DatabaseOptions {
  dataDir?: string | null;
}

export interface GitHubUserProfile {
  githubId: string;
  githubLogin: string;
  githubName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
}

interface UserRow {
  id: number;
  github_id: string;
  github_login: string;
  github_name: string | null;
  avatar_url: string | null;
  email: string | null;
}

interface AuthSessionRow extends UserRow {
  auth_session_id: string;
  expires_at: string;
}

export class AppDatabase {
  readonly storageDir: string;
  readonly dbPath: string;
  private readonly db: SqliteDatabase;
  private isEligibleInstaller: ((githubId: string) => boolean) | null = null;

  constructor(options: DatabaseOptions = {}) {
    this.storageDir = options.dataDir
      ? path.resolve(options.dataDir)
      : path.join(os.homedir(), '.code-agents-webcli');
    this.dbPath = path.join(this.storageDir, 'app.sqlite');

    this.initializeStorage();
    this.db = openDatabase(this.dbPath);
    this.hardenDatabaseFile();
    this.configureDatabase();
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  get raw(): SqliteDatabase {
    return this.db;
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  /**
   * Teach the installer lookup which accounts are still able to sign in.
   *
   * Wired from the auth service rather than read out of app_settings here: the
   * allow-list can change while the server runs (`--setup`, the settings
   * route), and a copy taken at boot would keep vouching for an account that
   * has since been revoked.
   */
  setInstallerEligibility(isEligible: ((githubId: string) => boolean) | null): void {
    this.isEligibleInstaller = isEligible;
  }

  /**
   * The installer: the account that completed the very first OAuth callback,
   * and the only one allowed to apply a self-update or change runtime profiles.
   *
   * `users.id` is AUTOINCREMENT and `upsertGitHubUser` never rewrites it, so
   * the earliest id is stable across re-logins. The result is pinned into
   * app_settings on first resolution: without the pin, deleting the installer's
   * row would silently promote whoever signed in second, so a pin whose user
   * row is simply gone is still honoured.
   *
   * The one thing that does invalidate a pin is the account behind it no longer
   * being allowed to sign in. Such a pin can never be exercised by anybody, and
   * every installer-only screen is then read-only for everyone forever — which
   * is what a stray row left by a test run or a restored backup produces, since
   * it sorts ahead of the real installer on id alone.
   */
  getInstallerUserId(): number | null {
    const pinned = this.getSetting('update.installerUserId');
    if (pinned && /^\d+$/.test(pinned) && this.isPinnableInstaller(Number(pinned))) {
      return Number(pinned);
    }

    const rows = this.db.prepare('SELECT id, github_id FROM users ORDER BY id ASC').all() as {
      id: number;
      github_id: string;
    }[];
    const installer = rows.find((row) => this.canSignIn(row.github_id));
    if (!installer) {
      return null;
    }

    this.setSetting('update.installerUserId', String(installer.id));
    return installer.id;
  }

  /**
   * Whether a pinned id still stands. A missing user row keeps the pin (see
   * above); only an account that exists and cannot sign in loses it.
   */
  private isPinnableInstaller(userId: number): boolean {
    const row = this.db.prepare('SELECT github_id FROM users WHERE id = ?').get(userId) as
      | { github_id: string }
      | undefined;
    return !row || this.canSignIn(row.github_id);
  }

  /** With no eligibility hook wired, every stored account counts — the old behaviour. */
  private canSignIn(githubId: string): boolean {
    return this.isEligibleInstaller ? this.isEligibleInstaller(githubId) : true;
  }

  /** One account by id, or null once it has been deleted. */
  getUserById(userId: number): AuthenticatedUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
    return row ? mapUserRow(row) : null;
  }

  getUserSetting(userId: number, key: string): string | null {
    return this.getSetting(`user:${userId}:${key}`);
  }

  setUserSetting(userId: number, key: string, value: string): void {
    this.setSetting(`user:${userId}:${key}`, value);
  }

  deleteUserSetting(userId: number, key: string): void {
    this.deleteSetting(`user:${userId}:${key}`);
  }

  upsertGitHubUser(profile: GitHubUserProfile): AuthenticatedUser {
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO users (
          github_id,
          github_login,
          github_name,
          avatar_url,
          email,
          created_at,
          updated_at,
          last_login_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(github_id) DO UPDATE SET
          github_login = excluded.github_login,
          github_name = excluded.github_name,
          avatar_url = excluded.avatar_url,
          email = excluded.email,
          updated_at = excluded.updated_at,
          last_login_at = excluded.last_login_at
      `)
      .run(
        profile.githubId,
        profile.githubLogin,
        profile.githubName ?? null,
        profile.avatarUrl ?? null,
        profile.email ?? null,
        now,
        now,
        now,
      );

    const row = this.db
      .prepare(`
        SELECT id, github_id, github_login, github_name, avatar_url, email
        FROM users
        WHERE github_id = ?
      `)
      .get(profile.githubId) as UserRow | undefined;

    if (!row) {
      throw new Error('Failed to load GitHub user after upsert');
    }

    return mapUserRow(row);
  }

  createAuthSession(sessionId: string, userId: number, expiresAt: Date): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO auth_sessions (
          id,
          user_id,
          expires_at,
          created_at,
          last_seen_at
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sessionId, userId, expiresAt.toISOString(), now, now);
  }

  getAuthSession(sessionId: string): {
    authSessionId: string;
    expiresAt: Date;
    user: AuthenticatedUser;
  } | null {
    const row = this.db
      .prepare(`
        SELECT
          auth_sessions.id AS auth_session_id,
          auth_sessions.expires_at,
          users.id,
          users.github_id,
          users.github_login,
          users.github_name,
          users.avatar_url,
          users.email
        FROM auth_sessions
        INNER JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.id = ?
      `)
      .get(sessionId) as AuthSessionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      authSessionId: row.auth_session_id,
      expiresAt: new Date(row.expires_at),
      user: mapUserRow(row),
    };
  }

  touchAuthSession(sessionId: string, expiresAt: Date): void {
    this.db
      .prepare(`
        UPDATE auth_sessions
        SET last_seen_at = ?, expires_at = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), expiresAt.toISOString(), sessionId);
  }

  deleteAuthSession(sessionId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
  }

  pruneExpiredAuthSessions(referenceTime = new Date()): number {
    const result = this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at <= ?')
      .run(referenceTime.toISOString());
    return result.changes;
  }

  private initializeStorage(): void {
    fs.mkdirSync(this.storageDir, { recursive: true });
    try {
      fs.chmodSync(this.storageDir, 0o700);
    } catch {
      // best-effort
    }
  }

  private hardenDatabaseFile(): void {
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // best-effort
    }
  }

  private configureDatabase(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id TEXT NOT NULL UNIQUE,
        github_login TEXT NOT NULL,
        github_name TEXT,
        avatar_url TEXT,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        agent TEXT,
        last_agent TEXT,
        runtime_label TEXT,
        terminal_options_json TEXT,
        working_dir TEXT NOT NULL,
        output_buffer_json TEXT NOT NULL,
        session_start_time TEXT,
        session_usage_json TEXT NOT NULL,
        max_buffer_size INTEGER NOT NULL DEFAULT 1000,
        last_accessed INTEGER NOT NULL DEFAULT 0
      );

      /*
       * One row per unit of agent work, kept forever.
       *
       * No foreign key to users, and the login stored alongside the id: this
       * table is meant to outlive the accounts in it. A cascade would delete
       * last quarter's spending along with somebody's access, and a bare id
       * would leave a history nobody can read. The same reasoning keeps
       * session_id free of a reference — a job is still a job after its
       * conversation has been deleted, which is most of the point.
       *
       * Every measured column is nullable, and a null is load-bearing: it means
       * the runtime reported nothing, which is a different fact from reporting
       * zero. Nothing in this table describes what was said, only what it cost.
       */
      CREATE TABLE IF NOT EXISTS usage_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        native_session_id TEXT,
        turn_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_login TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        project TEXT,
        project_source TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER,
        outcome TEXT NOT NULL,
        /* Superseded by model_turns, and read by nothing here — see the
           migration below. Still declared, still written, because it is NOT NULL
           and a build from before #86 opening this same file inserts into it. A
           downgrade is a normal part of how this app is updated, so the column
           an older build needs outlives the meaning this one gave up. */
        turns INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd REAL,
        reports_usage INTEGER NOT NULL,
        reports_cost INTEGER NOT NULL
      );

      /* How one job's spend divided between models, for the runtimes that say.
         Rows exist only where a turn genuinely used more than one — a subagent
         on another model, a fallback after a failure — because a single-model
         job is already fully described by usage_jobs.model.

         The figures are the runtime's own, not a share worked out here: claude
         and grok both publish a per-model breakdown of the same turn they
         publish a total for. The calls column is that runtime's own count of
         round trips to the model. There is deliberately no tool_calls: no runtime
         attributes a tool call to a model, and a column nobody can fill
         honestly invites somebody to fill it dishonestly. */
      CREATE TABLE IF NOT EXISTS usage_job_models (
        job_id TEXT NOT NULL REFERENCES usage_jobs(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        calls INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL,
        PRIMARY KEY (job_id, model)
      );

      /* Which tools a job called, and how often. Cascades: a tool count with no
         job is not a fact anybody can use. */
      CREATE TABLE IF NOT EXISTS usage_job_tools (
        job_id TEXT NOT NULL REFERENCES usage_jobs(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL,
        PRIMARY KEY (job_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_jobs_user_ended
        ON usage_jobs(user_id, ended_at);

      CREATE INDEX IF NOT EXISTS idx_usage_jobs_ended
        ON usage_jobs(ended_at);

      CREATE INDEX IF NOT EXISTS idx_usage_jobs_native
        ON usage_jobs(native_session_id);

      CREATE INDEX IF NOT EXISTS idx_usage_job_models_model
        ON usage_job_models(model);

      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_owner
        ON runtime_sessions(owner_user_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_created_at
        ON runtime_sessions(created_at);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
        ON auth_sessions(user_id);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
        ON auth_sessions(expires_at);
    `);

    // Which surface a session runs on. Added after the fact, so it is nullable
    // and a null reads as 'terminal' — every row that predates chat mode is a
    // terminal session, which makes the backfill a no-op rather than a guess.
    this.addColumnIfMissing('runtime_sessions', 'surface', 'TEXT');

    // The runtime's own id for the conversation, so a chat can be resumed with
    // its context after the server restarts. It lives on the record rather than
    // being read back out of the event log because the log is replayed from its
    // tail: in a long conversation the `session` event that carries the id is
    // thousands of events above the window, and a fact needed to *start* a
    // session should not require replaying the session to learn.
    this.addColumnIfMissing('runtime_sessions', 'native_chat_session_id', 'TEXT');

    // The conversation a shell belongs to, when it is not a session of its own.
    // Nullable and null-by-default: every row written before conversations could
    // open their own terminal is a standalone session, which is exactly what a
    // null means here.
    this.addColumnIfMissing('runtime_sessions', 'owner_session_id', 'TEXT');

    // Whether the conversation runs with tool approvals bypassed. Nullable, and
    // a null reads as "asks first": the only mode a row written before this
    // column existed could have *recorded* is none, and defaulting a standing
    // permission on because a column was absent is not a mistake to leave
    // available. INTEGER because SQLite has no boolean.
    this.addColumnIfMissing('runtime_sessions', 'chat_bypass_permissions', 'INTEGER');

    // The model this conversation overrides its runtime/profile default with.
    // Nullable and null-by-default: every row written before this column
    // existed has no override recorded, which is exactly what a null means.
    this.addColumnIfMissing('runtime_sessions', 'chat_model_override', 'TEXT');

    // The model this conversation is fixed to, written from what its last launch
    // actually used. Nullable, and the null is doing real work: it is "nothing
    // recorded", which is true of every row written before this column existed
    // and reads as the profile, exactly as it did then. A conversation that
    // launched with no model flag at all stores an empty string instead, so the
    // two cases stay apart — see `chatModelPinned`.
    this.addColumnIfMissing('runtime_sessions', 'chat_model_pinned', 'TEXT');

    // The reasoning-effort level this conversation overrides its runtime's
    // default with. Nullable and null-by-default for the same reason as the
    // model above: a row written before this column existed chose no level, and
    // null is what "chose no level" has always meant.
    this.addColumnIfMissing('runtime_sessions', 'chat_effort_override', 'TEXT');

    // The label the user chose for this session. Nullable and null-by-default:
    // a null is "never renamed", which is true of every row written before
    // renaming outlived the page that did it.
    this.addColumnIfMissing('runtime_sessions', 'custom_name', 'TEXT');

    // Which project — which working folder, by name — a recorded job ran in.
    // Nullable and null-by-default, and the null is load-bearing: work filed
    // before this column existed ran somewhere nobody wrote down, and the
    // dashboard shows it as unattributed rather than charging it to whichever
    // project happened to be handy.
    this.addColumnIfMissing('usage_jobs', 'project', 'TEXT');

    // Where a job's project came from: 'observed' when the session was pointed
    // at that folder as the work ran, 'manual' when a person attributed it
    // afterwards. Null for a job with no project at all — there is nothing to
    // have a provenance — and, for exactly one build's worth of rows, for a
    // project recorded before this column existed. Those are backfilled just
    // below rather than left ambiguous: every project recorded up to that point
    // could only have been observed.
    this.addColumnIfMissing('usage_jobs', 'project_source', 'TEXT');
    this.db.exec(`
      UPDATE usage_jobs SET project_source = 'observed'
        WHERE project IS NOT NULL AND project_source IS NULL;
    `);

    // How many round trips to the model a turn took, where the runtime says.
    //
    // The column beside it, `turns`, held a different quantity under the same
    // name: the number of assistant messages the transcript happened to show,
    // which is how an agent chops up its output rather than how much work it
    // did (#86). A turn is now one row of this table — see `UsageJobRecord` —
    // so the count nobody can disagree about is `COUNT(*)`, and this column
    // holds the other quantity under a name that says which one it is.
    //
    // The old column is left where it is and read by nothing. Dropping it would
    // rewrite the whole table, and an older build reading the same file still
    // expects it to be there — a downgrade is a normal part of updating here.
    // The old values are *not* copied across: they were derived, this column is
    // reported-only, and moving one into the other would make an inference
    // indistinguishable from a measurement in the one place built to keep those
    // apart. Rows from before this change read "not reported", which is what
    // they are.
    this.addColumnIfMissing('usage_jobs', 'model_turns', 'INTEGER');

    // Declared here rather than with the other indexes above, because the
    // column it covers is only guaranteed to exist by the line before it.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_jobs_project
        ON usage_jobs(project, ended_at);
    `);

    // A total for the jobs filed before one was derived from the parts.
    //
    // Until #80 a job's total was whatever the runtime volunteered, and Claude
    // volunteers none — so most of the history read "not reported" for work
    // whose tokens were on screen while it ran, and every dashboard figure
    // built on the column skipped those rows. The parts were always recorded,
    // so this adds up what is already in the row rather than estimating
    // anything, and it matches `tokenTotal` exactly: the cache buckets count,
    // reasoning does not (it is a slice of the output, not an addition to it).
    //
    // Idempotent, and safe to run on every boot: the WHERE clause excludes
    // every row it has already written, and a row where the runtime reported
    // nothing at all has nothing to add up and is left as the null it is.
    this.db.exec(`
      UPDATE usage_jobs
         SET total_tokens = COALESCE(input_tokens, 0)
                          + COALESCE(output_tokens, 0)
                          + COALESCE(cache_read_tokens, 0)
                          + COALESCE(cache_write_tokens, 0)
       WHERE total_tokens IS NULL
         AND (input_tokens IS NOT NULL
           OR output_tokens IS NOT NULL
           OR cache_read_tokens IS NOT NULL
           OR cache_write_tokens IS NOT NULL);

      UPDATE usage_jobs
         SET total_tokens = reasoning_tokens
       WHERE total_tokens IS NULL AND reasoning_tokens IS NOT NULL;
    `);
  }

  /**
   * Additive schema change that is safe to run on every boot.
   *
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, and `ALTER TABLE` on an existing
   * column is an error rather than a no-op, so the table is asked what it has
   * first. Additive-and-nullable is the only shape allowed here: it leaves an
   * older build able to read the same file, which matters because a downgrade
   * is a normal part of how this app is updated.
   */
  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((existing) => existing.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapUserRow(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    githubId: row.github_id,
    githubLogin: row.github_login,
    githubName: row.github_name,
    avatarUrl: row.avatar_url,
    email: row.email,
  };
}
