import * as fs from 'fs';
import * as path from 'path';
import { ChatSnapshot, UserTurn } from '../../shared/chat-events.js';
import { SessionRecord } from '../types.js';
import { ChatNotRunningError, ChatSession, ChatSessionStartOptions, ChatUsageSink } from './session.js';
import { ChatStore } from './store.js';

/**
 * Owns the live chat sessions.
 *
 * The counterpart to the bridge map on the terminal side: sessions live here,
 * not on a socket, which is what makes closing the browser a detach rather than
 * a kill. A session stays until it is explicitly stopped or the server goes
 * down, and any number of browsers can watch it in the meantime.
 */

export interface ChatManagerDeps {
  store: ChatStore;
  /** The app's own storage directory; approval sockets live beneath it. */
  storageDir: string;
  broadcast: (sessionId: string, message: Record<string, unknown>) => void;
  resolveCommand: (runtime: string) => string;
  /** Passed through to every session; see ChatSessionDeps.onLifecycle. */
  onLifecycle?: (
    sessionId: string,
    change: { nativeSessionId?: string; exited?: boolean },
  ) => void;
  /** Passed through to every session; see ChatSessionDeps.usage. */
  usage?: ChatUsageSink;
}

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly hookScript: string;
  private readonly askScript: string;

  constructor(private readonly deps: ChatManagerDeps) {
    // Resolved from this module's own location rather than cwd: the server is
    // routinely started from whatever directory the user happened to be in,
    // and the hook has to be found from the agent's working directory too.
    this.hookScript = path.join(__dirname, 'permission-hook.js');
    this.askScript = path.join(__dirname, 'ask-mcp.js');
  }

  get store(): ChatStore {
    return this.deps.store;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Start a chat for a session that does not have one running.
   *
   * Refuses rather than restarting an existing one: a second adapter on the
   * same session id would write two interleaved event streams into one log,
   * and the transcript would be unreadable in a way no later fix could undo.
   */
  async start(
    record: SessionRecord,
    options: ChatSessionStartOptions,
  ): Promise<ChatSession> {
    const existing = this.sessions.get(record.id);
    if (existing && existing.live) {
      throw new Error('a chat is already running in this session');
    }
    if (existing) {
      await existing.stop();
      this.sessions.delete(record.id);
    }

    const session = new ChatSession(
      { id: record.id, ownerUserId: record.ownerUserId },
      {
        store: this.deps.store,
        socketDir: path.join(this.deps.storageDir, 'cs'),
        hookScript: this.hookScript,
        askScript: this.askScript,
        broadcast: this.deps.broadcast,
        resolveCommand: this.deps.resolveCommand,
        readFile: (sessionId, filePath) => this.readFile(sessionId, filePath),
        writeFile: (sessionId, filePath, contents) =>
          this.writeFile(sessionId, filePath, contents),
        onLifecycle: this.deps.onLifecycle,
        usage: this.deps.usage,
      },
    );

    this.sessions.set(record.id, session);

    try {
      await session.start(options);
    } catch (error) {
      this.sessions.delete(record.id);
      throw error;
    }

    return session;
  }

  /**
   * Read a file on an agent's behalf, confined to its working directory.
   *
   * ACP agents delegate filesystem access to their client, so this is the path
   * by which they see the project at all. It is also the reason the confinement
   * check exists here rather than being left to the agent's own good manners:
   * the request arrives over a socket from a process we launched but do not
   * control, and "read /etc/shadow" is a perfectly well-formed request.
   */
  private async readFile(sessionId: string, filePath: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('no such chat session');
    const resolved = this.confine(session.workingDir, filePath);
    return fs.promises.readFile(resolved, 'utf8');
  }

  private async writeFile(
    sessionId: string,
    filePath: string,
    contents: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('no such chat session');
    const resolved = this.confine(session.workingDir, filePath);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, contents, 'utf8');
  }

  /**
   * Resolve a path and prove it stays inside the session's directory.
   *
   * `path.resolve` collapses `..` before the comparison, and the separator on
   * the prefix check stops `/home/u/project-secrets` passing as a child of
   * `/home/u/project`.
   */
  private confine(workingDir: string, filePath: string): string {
    const root = path.resolve(workingDir);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`refusing to touch ${filePath}: outside the session directory`);
    }
    return resolved;
  }

  async snapshot(record: SessionRecord): Promise<ChatSnapshot> {
    const session = this.sessions.get(record.id);
    if (session) return session.snapshot();
    // No live session: the log is still the truth, so a browser rejoining a
    // finished conversation reads it exactly as it was left.
    const snapshot = await this.deps.store.snapshot(
      { id: record.id, ownerUserId: record.ownerUserId },
      {
        // The mode comes from the record because nothing else here remembers it:
        // the log holds what was said, not how the conversation was set up. Left
        // to the store's default, every conversation whose process is gone came
        // back claiming to ask for approvals — including the ones that do not.
        bypassPermissions: record.chatBypassPermissions === true,
      },
    );
    // The record, not the replayed log: a snapshot replays only the tail, and
    // the id is recorded once at the very top of a conversation. Telling the
    // browser "this cannot be resumed" because the fact scrolled out of the
    // window would be a wrong answer given confidently.
    //
    // The head-scan is the backfill for conversations that were recorded before
    // the id was kept on the record — without it every chat a user already has
    // would come back offering only to start over.
    let nativeSessionId = record.nativeChatSessionId;
    if (!nativeSessionId) {
      nativeSessionId =
        (await this.deps.store
          .nativeSessionId({ id: record.id, ownerUserId: record.ownerUserId })
          .catch(() => null)) || undefined;
      if (nativeSessionId) {
        this.deps.onLifecycle?.(record.id, { nativeSessionId });
      }
    }

    return {
      ...snapshot,
      runtime: snapshot.runtime || record.lastAgent || '',
      nativeSessionId,
    };
  }

  /** One page of older events, for a browser scrolling back through a long chat. */
  readPage(
    record: SessionRecord,
    fromSeq: number,
    count: number,
  ): Promise<{ events: unknown[]; firstSeq: number; from: number; cursor: number }> {
    return this.deps.store
      .read({ id: record.id, ownerUserId: record.ownerUserId }, fromSeq, count)
      .then((page) => ({
        events: page.events,
        firstSeq: page.firstSeq,
        from: page.from,
        cursor: page.cursor,
      }));
  }

  async send(sessionId: string, turn: UserTurn): Promise<void> {
    const session = this.require(sessionId);
    await session.send(turn);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.interrupt();
  }

  /** Switch a live session's model. False when nothing is running, or the adapter cannot. */
  async setModel(sessionId: string, model: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.setModel(model);
  }

  /** Carry a new model into the options an in-place `/clear` restart replays. */
  rememberModel(sessionId: string, model: string | undefined): void {
    this.sessions.get(sessionId)?.rememberModel(model);
  }

  /** Drop a turn that was typed ahead and has not run yet. */
  cancelQueued(sessionId: string, queuedId: string): boolean {
    return this.sessions.get(sessionId)?.cancelQueued(queuedId) ?? false;
  }

  /**
   * Cut the turn in flight short and give the agent one waiting turn now.
   *
   * False when there was nothing to promote — an unknown id, a session that is
   * not running, a delivery already under way.
   */
  async sendQueuedNow(sessionId: string, queuedId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.sendQueuedNow(queuedId);
  }

  retryQueued(sessionId: string, queuedId: string): boolean {
    return this.sessions.get(sessionId)?.retryQueued(queuedId) ?? false;
  }

  respondPermission(sessionId: string, requestId: string, optionId: string): boolean {
    return this.sessions.get(sessionId)?.respondPermission(requestId, optionId) ?? false;
  }

  answerQuestion(
    sessionId: string,
    requestId: string,
    optionIds: string[],
    skipped = false,
  ): boolean {
    return this.sessions.get(sessionId)?.answerQuestion(requestId, optionIds, skipped) ?? false;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.stop();
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private require(sessionId: string): ChatSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ChatNotRunningError();
    return session;
  }
}
