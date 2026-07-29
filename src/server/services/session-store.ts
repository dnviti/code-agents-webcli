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
  chat_bypass_permissions: number | null;
  chat_model_override: string | null;
  chat_model_pinned: string | null;
  chat_effort_override: string | null;
  custom_name: string | null;
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
          owner_session_id,
          chat_bypass_permissions,
          chat_model_override,
          chat_model_pinned,
          chat_effort_override,
          custom_name
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
          @owner_session_id,
          @chat_bypass_permissions,
          @chat_model_override,
          @chat_model_pinned,
          @chat_effort_override,
          @custom_name
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
        // the user can reach from one that nothing on screen refers to any more.
        owner_session_id: session.ownerSessionId || null,
        // The approval mode the user chose for this conversation. Persisted so a
        // restart brings it back rather than quietly dropping to manual — and so
        // the header can state the mode of a conversation with nothing running.
        chat_bypass_permissions: session.chatBypassPermissions === true ? 1 : null,
        // The conversation-scoped model override, if the user has set one.
        // Persisted so a restart still prefers it over the profile default the
        // next time a session starts for this conversation.
        chat_model_override: session.chatModelOverride || null,
        // The model this conversation is fixed to, from what its last launch
        // actually used. This is the half that has to survive a restart or the
        // guarantee is empty: a server restart is precisely the moment every
        // conversation gets relaunched, and a pin held only in memory would be
        // gone exactly when it is needed (#135).
        //
        // An empty string, not a null, for "launched with no flag at all": null
        // is reserved for "nothing recorded", which is what a row written before
        // this column existed carries and which still reads as the profile.
        chat_model_pinned:
          session.chatModelPinned === undefined ? null : session.chatModelPinned ?? '',
        // The conversation-scoped effort level, if one was chosen. Persisted for
        // the same reason and read back the same way: without it, a rejoin after
        // a server restart shows the chip at the runtime default while the
        // process it describes is still running at the level the user picked.
        chat_effort_override: session.chatEffortOverride || null,
        // The label the user chose. Without this a restart brings a session back
        // under the name it was created with, which is the one thing the user
        // renamed it to get away from.
        custom_name: session.customName || null,
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
            owner_session_id,
            chat_bypass_permissions,
            chat_model_override,
            chat_model_pinned,
            chat_effort_override,
            custom_name
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
          // Only a stored 1 restores the bypass. A null — the value every row
          // written before this column existed carries — reads as "asks first",
          // so a missing answer can never grant a standing permission.
          chatBypassPermissions: row.chat_bypass_permissions === 1 ? true : undefined,
          // A stored empty string never happens — the write side always writes
          // null for "no override" — but an empty string reading as "no
          // override" rather than a call to switch to nothing is the safe
          // direction regardless.
          chatModelOverride: row.chat_model_override || undefined,
          // The opposite treatment, deliberately: here an empty string is a
          // recorded fact — "this conversation launched with no model flag" —
          // and only a null means nothing was ever written down. Reading the
          // empty string as absent would let a profile configured after the
          // launch re-model a conversation that had run bare.
          chatModelPinned:
            row.chat_model_pinned === null || row.chat_model_pinned === undefined
              ? undefined
              : row.chat_model_pinned || null,
          // Same treatment, same reason: an empty string reads as "no level
          // chosen" rather than as an instruction to pass the runtime an empty
          // `--effort`, which every one of them would refuse.
          chatEffortOverride: row.chat_effort_override || undefined,
          // An empty string reads as "never renamed" for the same reason: the
          // write side only ever stores a trimmed non-empty name or null.
          customName: row.custom_name || undefined,
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
