import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatSnapshot, UserTurn } from '../../shared/chat-events.js';
import { LadderRung, ModelTier } from '../../shared/runtime-profiles.js';
import { SessionRecord } from '../types.js';
import { ChatNotRunningError, ChatSession, ChatSessionStartOptions, ChatUsageSink } from './session.js';
import { ModelCapacityLookup } from './model-capacity.js';
import { ChatStore, ChatTurnIndex } from './store.js';

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
  /** The runtime's plain CLI name, for environments that resolve it themselves. */
  resolveCommandName?: (runtime: string) => string;
  /** Passed through to every session; see ChatSessionDeps.onLifecycle. */
  onLifecycle?: (
    sessionId: string,
    change: {
      nativeSessionId?: string | null;
      exited?: boolean;
      bypassing?: boolean;
      restarting?: boolean;
    },
  ) => void;
  /**
   * The approval preference of a given user; see ChatSessionDeps.resolveBypass.
   *
   * Taken per user rather than per session because a `/clear` is answered for
   * the conversation's *owner*, never for whichever socket happened to type it.
   */
  chatBypassPreference?: (userId: number) => boolean;
  /** Passed through to every session; see ChatSessionDeps.usage. */
  usage?: ChatUsageSink;
  /**
   * The folder a given user is allowed to browse, and now the outer edge of
   * what a conversation of theirs may read and write. See `confine`.
   *
   * Optional so a manager built without it — every test that does not care, and
   * any embedder — keeps the older, tighter behaviour of the session directory
   * alone rather than silently gaining a wider one.
   */
  userBaseFolder?: (userId: number) => string;
}

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly hookScript: string;
  private readonly askScript: string;
  /**
   * One lookup for the whole process, so its catalogue is fetched once rather
   * than once per conversation. Only consulted for models no agent described.
   */
  private readonly capacity = new ModelCapacityLookup();

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
        resolveCommandName: this.deps.resolveCommandName,
        readFile: options.fileAccess
          ? (_sessionId, filePath) => options.fileAccess!.readFile(filePath)
          : (sessionId, filePath) => this.readFile(sessionId, filePath, record.ownerUserId),
        writeFile: options.fileAccess
          ? (_sessionId, filePath, contents) => options.fileAccess!.writeFile(filePath, contents)
          : (sessionId, filePath, contents) =>
            this.writeFile(sessionId, filePath, contents, record.ownerUserId),
        onLifecycle: this.deps.onLifecycle,
        // Closed over this record's owner, so a conversation restarted from
        // inside itself resolves against the preference of the person whose
        // conversation it is.
        resolveBypass: () =>
          this.deps.chatBypassPreference?.(record.ownerUserId) === true,
        usage: this.deps.usage,
        capacity: this.capacity,
      },
    );

    this.sessions.set(record.id, session);

    try {
      await session.start(options);
    } catch (error) {
      // `ChatSession.start` verifies teardown before dropping its adapter. If
      // that proof failed, retain the session so admission remains closed and
      // a later explicit stop can retry the identity-bound control path.
      if (!session.ownsAdapter && this.sessions.get(record.id) === session) {
        this.sessions.delete(record.id);
      }
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
  private async readFile(
    sessionId: string,
    filePath: string,
    ownerUserId?: number,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('no such chat session');
    const resolved = this.confine(session.workingDir, filePath, ownerUserId);
    return fs.promises.readFile(resolved, 'utf8');
  }

  private async writeFile(
    sessionId: string,
    filePath: string,
    contents: string,
    ownerUserId?: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('no such chat session');
    const resolved = this.confine(session.workingDir, filePath, ownerUserId);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, contents, 'utf8');
  }

  /**
   * Resolve a path and prove the agent is allowed to be there.
   *
   * `path.resolve` collapses `..` before the comparison, and the separator on
   * the prefix check stops `/home/u/project-secrets` passing as a child of
   * `/home/u/project`.
   *
   * Three roots are allowed, and the widest of them is deliberate. The session's
   * own directory is the obvious one. The OS temp directory is the second: an
   * agent's write tool and its own shell share the real filesystem, so a handoff
   * like `gh issue create --body-file /tmp/notes.md` only works when the file the
   * agent was told to write lands where its shell will look for it, and scratch
   * space is what a temp dir is for.
   *
   * The third is the owner's base folder — the same boundary the file browser
   * enforces, so this allows exactly what its user could have pointed the
   * conversation at in the first place. The session directory alone was too
   * tight to be either safe or useful (#174): an agent working across a git
   * worktree of its own repository, one directory over, had every read refused
   * while its own shell read the same file freely, and answered by writing the
   * file through a script instead. A boundary that stops only the polite path
   * costs the user a screen of red errors and buys nothing. What this still
   * refuses is what matters and is unchanged: another account's files, anything
   * outside the browsable area, and `/etc` and its neighbours.
   *
   * Without `userBaseFolder` — an embedder that did not supply one, and every
   * test that does not care — the older, tighter rule stands.
   */
  private confine(workingDir: string, filePath: string, ownerUserId?: number): string {
    const root = path.resolve(workingDir);
    const resolved = path.resolve(root, filePath);
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
    if (this.insideTempDir(resolved)) return resolved;
    if (this.insideBaseFolder(resolved, ownerUserId)) return resolved;
    throw new Error('outside the folders this conversation may use');
  }

  /** Whether a resolved path is inside the browsable area of its owner. */
  private insideBaseFolder(resolved: string, ownerUserId?: number): boolean {
    if (!this.deps.userBaseFolder || ownerUserId === undefined) return false;
    try {
      const base = path.resolve(this.deps.userBaseFolder(ownerUserId));
      return resolved === base || resolved.startsWith(base + path.sep);
    } catch {
      // A base folder that cannot be resolved is not an invitation to allow the
      // path: it is one fewer root, and the check simply fails.
      return false;
    }
  }

  private insideTempDir(resolved: string): boolean {
    const tmp = os.tmpdir();
    const roots = new Set<string>([path.resolve(tmp)]);
    try {
      // macOS reports the temp dir through a symlink; an agent that hands us
      // the real path is still asking for scratch space, not escaping.
      roots.add(fs.realpathSync(tmp));
    } catch {
      // No temp dir at all is odd but not fatal: the check simply fails.
    }
    for (const root of roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) return true;
    }
    return false;
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
  /**
   * The conversation's whole run of turns, for the index beside it.
   *
   * Read from the log rather than assembled from what a browser holds, which is
   * the point: an index that starts where the last page happened to stop is
   * useless in exactly the conversations long enough to need one (#86).
   */
  async turnIndex(record: SessionRecord): Promise<ChatTurnIndex> {
    const index = await this.deps.store.turnIndex({
      id: record.id,
      ownerUserId: record.ownerUserId,
    });
    // What each turn cost, joined on from the accounting. Not read from the log
    // beside it: the money on a `turn_end` is a per-turn figure for some
    // runtimes and a running total for others, and the one place that
    // difference has already been worked out is the row the accountant filed.
    const spend = this.deps.usage?.spendByTurn(record.id, record.ownerUserId);
    if (!spend || spend.size === 0) return index;
    return {
      ...index,
      turns: index.turns.map((turn) => {
        const usage = spend.get(turn.turnId);
        return usage ? { ...turn, usage } : turn;
      }),
    };
  }

  readPage(
    record: SessionRecord,
    fromSeq: number,
    count: number,
  ): Promise<{
    events: unknown[];
    firstSeq: number;
    from: number;
    cursor: number;
    openTurnId: string | null;
  }> {
    return this.deps.store
      .read({ id: record.id, ownerUserId: record.ownerUserId }, fromSeq, count)
      .then((page) => ({
        events: page.events,
        firstSeq: page.firstSeq,
        from: page.from,
        cursor: page.cursor,
        // The turn the page starts inside, so the browser replays the slice
        // into the turn the conversation recorded rather than a new one.
        openTurnId: page.openTurnId ?? null,
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

  /**
   * The rung a running session is on, or null when it is not on one.
   *
   * Asked of the session rather than worked out from the profile, because the
   * profile can have changed since the launch and a conversation that launched
   * bare is indistinguishable from one on a rung by anything the record holds.
   */
  ladderOf(sessionId: string): LadderRung | null {
    return this.sessions.get(sessionId)?.ladderRung ?? null;
  }

  /**
   * Move a running conversation onto an edited ladder.
   *
   * Which sessions are on one is the session's own answer to give — the manager
   * has no view of the profile a conversation launched under — so every live
   * session on the runtime is offered the new ladder and the ones not running on
   * a rung decline it.
   */
  async reapplyLadder(
    runtime: string,
    ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null,
  ): Promise<string[]> {
    const moved: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.live || session.runtimeKind !== runtime) continue;
      if (await session.reapplyLadder(ladder)) moved.push(sessionId);
    }
    return moved;
  }

  /** Switch a live session's reasoning effort. False when nothing is running, or the adapter cannot. */
  async setEffort(sessionId: string, effort: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.setEffort(effort);
  }

  /** Carry a new effort level into the options an in-place `/clear` restart replays. */
  rememberEffort(sessionId: string, effort: string | undefined): void {
    this.sessions.get(sessionId)?.rememberEffort(effort);
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
    text?: string,
  ): boolean {
    return (
      this.sessions.get(sessionId)?.answerQuestion(requestId, optionIds, skipped, text) ?? false
    );
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.stop();
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
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
