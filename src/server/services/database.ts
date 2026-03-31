import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
  private readonly db: Database.Database;

  constructor(options: DatabaseOptions = {}) {
    this.storageDir = options.dataDir
      ? path.resolve(options.dataDir)
      : path.join(os.homedir(), '.code-agents-webcli');
    this.dbPath = path.join(this.storageDir, 'app.sqlite');

    this.initializeStorage();
    this.db = new Database(this.dbPath);
    this.hardenDatabaseFile();
    this.configureDatabase();
    this.runMigrations();
  }

  close(): void {
    this.db.close();
  }

  get raw(): Database.Database {
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

      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_owner
        ON runtime_sessions(owner_user_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_created_at
        ON runtime_sessions(created_at);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
        ON auth_sessions(user_id);

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
        ON auth_sessions(expires_at);
    `);
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
