import { AppDatabase, DatabaseOptions } from './database.js';
import { AgentKind, SessionRecord, TerminalOptions } from '../types.js';

export interface SessionMetadata {
  exists: boolean;
  savedAt?: string;
  sessionCount?: number;
  fileSize?: number;
  version?: string;
  error?: string;
}

export interface SessionStoreOptions extends DatabaseOptions {
  database?: AppDatabase;
}

interface RuntimeSessionRow {
  id: string;
  owner_user_id: number;
  name: string;
  created_at: string;
  last_activity: string;
  active: number;
  agent: AgentKind | null;
  last_agent: AgentKind | null;
  runtime_label: string | null;
  terminal_options_json: string | null;
  working_dir: string;
  output_buffer_json: string;
  session_start_time: string | null;
  session_usage_json: string;
  max_buffer_size: number;
  last_accessed: number;
  surface: string | null;
  native_chat_session_id: string | null;
  owner_session_id: string | null;
}

export class SessionStore {
  readonly database: AppDatabase;
  readonly storageDir: string;
  readonly dbPath: string;

  constructor(options: SessionStoreOptions = {}) {
    this.database = options.database || new AppDatabase(options);
    this.storageDir = this.database.storageDir;
    this.dbPath = this.database.dbPath;
  }

  async saveSessions(sessions: Map<string, SessionRecord>): Promise<boolean> {
    try {
      const db = this.database.raw;
      const insert = db.prepare(`
        INSERT OR REPLACE INTO runtime_sessions (
          id,
          owner_user_id,
          name,
          created_at,
          last_activity,
          active,
          agent,
          last_agent,
          runtime_label,
          terminal_options_json,
          working_dir,
          output_buffer_json,
          session_start_time,
          session_usage_json,
          max_buffer_size,
          last_accessed,
          surface,
          native_chat_session_id,
          owner_session_id
        )
        VALUES (
          @id,
          @owner_user_id,
          @name,
          @created_at,
          @last_activity,
          @active,
          @agent,
          @last_agent,
          @runtime_label,
          @terminal_options_json,
          @working_dir,
          @output_buffer_json,
          @session_start_time,
          @session_usage_json,
          @max_buffer_size,
          @last_accessed,
          @surface,
          @native_chat_session_id,
          @owner_session_id
        )
      `);

      // Upsert the current rows, then delete only the ids that are genuinely
      // gone. The previous DELETE-everything-then-reinsert meant any save with
      // a partial or empty in-memory map destroyed every other persisted
      // session.
      const deleteMissing = db.prepare(
        'DELETE FROM runtime_sessions WHERE id NOT IN (SELECT value FROM json_each(?))',
      );

      const replaceAll = db.transaction((sessionRows: Array<Record<string, unknown>>) => {
        for (const row of sessionRows) {
          insert.run(row);
        }
        deleteMissing.run(JSON.stringify(sessionRows.map((row) => row.id)));
      });

      const rows = Array.from(sessions.values()).map((session) => ({
        id: session.id,
        owner_user_id: session.ownerUserId,
        name: session.name || 'Unnamed Session',
        created_at: toIsoString(session.created),
        last_activity: toIsoString(session.lastActivity),
        active: 0,
        agent: null,
        last_agent: session.lastAgent,
        runtime_label: session.runtimeLabel,
        terminal_options_json: session.terminalOptions
          ? JSON.stringify(session.terminalOptions)
          : null,
        working_dir: session.workingDir,
        output_buffer_json: JSON.stringify((session.outputBuffer || []).slice(-1000)),
        session_start_time: session.sessionStartTime
          ? toIsoString(session.sessionStartTime)
          : null,
        session_usage_json: JSON.stringify(
          session.sessionUsage || {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalCost: 0,
            models: {},
          },
        ),
        max_buffer_size: session.maxBufferSize || 1000,
        last_accessed: session.lastAccessed || Date.now(),
        // Persisted so a restart does not show an empty terminal as the whole
        // history of what was a conversation.
        surface: session.surface || null,
        // Without this a restart can still show the conversation but not
        // continue it: the agent would come back with no memory of a transcript
        // the user is looking at.
        native_chat_session_id: session.nativeChatSessionId || null,
        // Which conversation owns this shell, so a restart can tell a session
        // the user can reach from one nothing on screen refers to any more.
        owner_session_id: session.ownerSessionId || null,
      }));

      replaceAll(rows);
      this.database.setSetting('runtime_sessions.saved_at', new Date().toISOString());
      this.database.setSetting('runtime_sessions.version', '2');
      return true;
    } catch (error) {
      console.error('Failed to save sessions:', error);
      return false;
    }
  }

  async loadSessions(): Promise<Map<string, SessionRecord>> {
    try {
      const rows = this.database.raw
        .prepare(`
          SELECT
            id,
            owner_user_id,
            name,
            created_at,
            last_activity,
            active,
            agent,
            last_agent,
            runtime_label,
            terminal_options_json,
            working_dir,
            output_buffer_json,
            session_start_time,
            session_usage_json,
            max_buffer_size,
            last_accessed,
            surface,
            native_chat_session_id,
            owner_session_id
          FROM runtime_sessions
          ORDER BY created_at ASC
        `)
        .all() as RuntimeSessionRow[];

      const sessions = new Map<string, SessionRecord>();
      for (const row of rows) {
        sessions.set(row.id, {
          id: row.id,
          ownerUserId: row.owner_user_id,
          name: row.name,
          created: new Date(row.created_at),
          lastActivity: new Date(row.last_activity),
          active: false,
          agent: null,
          lastAgent: row.last_agent,
          runtimeLabel: row.runtime_label,
          terminalOptions: parseJson<TerminalOptions | null>(row.terminal_options_json, null),
          stopRequested: false,
          workingDir: row.working_dir,
          connections: new Set(),
          outputBuffer: parseJson<string[]>(row.output_buffer_json, []),
          // Geometry is runtime state, not persisted: the next client resize
          // re-establishes it before the recorder sees any output.
          termCols: 80,
          termRows: 24,
          sessionStartTime: row.session_start_time ? new Date(row.session_start_time) : null,
          sessionUsage: parseJson(row.session_usage_json, {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            totalCost: 0,
            models: {},
          }),
          maxBufferSize: row.max_buffer_size || 1000,
          lastAccessed: row.last_accessed || Date.now(),
          surface: row.surface === 'chat' ? 'chat' : undefined,
          nativeChatSessionId: row.native_chat_session_id || undefined,
          ownerSessionId: row.owner_session_id || undefined,
        });
      }

      if (sessions.size > 0) {
        console.log(`Restored ${sessions.size} sessions from SQLite`);
      }

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return new Map();
    }
  }

  async clearOldSessions(): Promise<boolean> {
    try {
      this.database.raw.prepare('DELETE FROM runtime_sessions').run();
      return true;
    } catch (error) {
      console.error('Failed to clear sessions:', error);
      return false;
    }
  }

  async getSessionMetadata(): Promise<SessionMetadata> {
    try {
      const row = this.database.raw
        .prepare('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get() as { count: number };
      const savedAt = this.database.getSetting('runtime_sessions.saved_at') || undefined;
      const version = this.database.getSetting('runtime_sessions.version') || '2';

      return {
        exists: true,
        savedAt,
        sessionCount: row.count,
        version,
      };
    } catch (error) {
      return {
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export default SessionStore;
