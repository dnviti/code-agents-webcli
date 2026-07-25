import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatState,
  PermissionOption,
  PermissionRequest,
  UserTurn,
  classifyTool,
  defaultPermissionOptions,
  isAllowOption,
} from '../../shared/chat-events.js';
import { AdapterEvent, ChatAdapter } from './adapter.js';
import { PermissionAsk, PermissionAnswer, PermissionBroker, permissionHookSettings } from './permission-broker.js';
import { ChatStoreLike, ChatSessionRef } from './store.js';
import { createChatAdapter, supportsChat } from './registry.js';

/**
 * One chat conversation, owned by the server.
 *
 * This is where the "your agent keeps working after you close the tab"
 * guarantee actually lives. The adapter's process belongs to this object, not
 * to a WebSocket: browsers attach and detach, and all that changes is who is
 * listening. Everything the adapter emits is stamped with a sequence number,
 * appended to the durable log, and only then broadcast — so a browser that
 * reconnects mid-turn is reading the same numbered stream it left, and can say
 * exactly where it stopped.
 *
 * It also owns approvals. Adapters that have their own permission channel
 * (ACP, codex) emit permission events and answer through the adapter; Claude
 * has no such channel, so its approvals arrive over the hook broker instead.
 * Both converge here, and the browser sees one kind of question either way.
 */

export interface ChatSessionDeps {
  store: ChatStoreLike;
  /** Where per-session approval sockets live. Must be the app's own data dir. */
  socketDir: string;
  /** Absolute path to the compiled permission hook script. */
  hookScript: string;
  /** Push an event to every browser watching this session. */
  broadcast: (sessionId: string, message: Record<string, unknown>) => void;
  /** Resolve the executable for a runtime, from the existing bridge lookup. */
  resolveCommand: (runtime: string) => string;
  /** Read a file for an agent that delegates filesystem access to its client. */
  readFile?: (sessionId: string, filePath: string) => Promise<string>;
  writeFile?: (sessionId: string, filePath: string, contents: string) => Promise<void>;
}

export interface ChatSessionStartOptions {
  runtime: string;
  workingDir: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  bypassPermissions?: boolean;
  /** Native session to resume — set when switching surfaces or restarting. */
  resumeSessionId?: string;
}

interface PendingApproval {
  request: PermissionRequest;
  /** Set when the question came over the hook broker rather than the adapter. */
  resolve?: (answer: PermissionAnswer) => void;
}

export class ChatSession {
  private adapter: ChatAdapter | null = null;
  private broker: PermissionBroker | null = null;
  private seq = 0;
  private state: ChatState = 'starting';
  private capabilities: ChatCapabilities | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private runtime = '';
  private bypass = false;
  private nativeSessionId: string | null = null;
  private startedAt = 0;
  private cwd = '';

  constructor(
    private readonly ref: ChatSessionRef,
    private readonly deps: ChatSessionDeps,
  ) {}

  get sessionId(): string {
    return this.ref.id;
  }

  get live(): boolean {
    return Boolean(this.adapter?.alive);
  }

  get currentState(): ChatState {
    return this.state;
  }

  get currentCapabilities(): ChatCapabilities | null {
    return this.capabilities;
  }

  /** The runtime's own session id, needed to resume it in the other surface. */
  get nativeId(): string | null {
    return this.nativeSessionId;
  }

  get bypassing(): boolean {
    return this.bypass;
  }

  /** The directory the agent was launched in, and the root it is confined to. */
  get workingDir(): string {
    return this.cwd;
  }

  get runtimeKind(): string {
    return this.runtime;
  }

  async start(options: ChatSessionStartOptions): Promise<void> {
    if (this.adapter) {
      throw new Error(`chat session ${this.ref.id} is already running`);
    }
    if (!supportsChat(options.runtime)) {
      throw new Error(`${options.runtime} has no chat adapter`);
    }

    this.runtime = options.runtime;
    this.cwd = options.workingDir;
    this.bypass = Boolean(options.bypassPermissions);
    this.startedAt = Date.now();
    // Restarting into an existing conversation: seq continues from the log so
    // a resumed session does not renumber events a browser already holds.
    const stats = await this.deps.store.stat(this.ref);
    this.seq = Math.max(this.seq, stats.cursor);

    const env = { ...(options.env || {}) };
    const extraArgs = [...(options.extraArgs || [])];

    // Claude gates tools through a PreToolUse hook rather than a protocol
    // message, so its approval channel is a socket the hook dials back into.
    // Skipped entirely when bypassing: there is nothing to ask.
    if (!this.bypass && options.runtime === 'claude' && fs.existsSync(this.deps.hookScript)) {
      this.broker = new PermissionBroker(path.join(this.deps.socketDir, this.ref.id));
      const socketPath = await this.broker.listen((ask) => this.askUser(ask));
      extraArgs.push('--settings', permissionHookSettings(this.deps.hookScript, socketPath));
      env.CCWEB_PERMISSION_SOCKET = socketPath;
    }

    const adapter = createChatAdapter(options.runtime, {
      sessionId: this.ref.id,
      workingDir: options.workingDir,
      command: this.deps.resolveCommand(options.runtime),
      model: options.model,
      extraArgs,
      env,
      bypassPermissions: this.bypass,
      resumeSessionId: options.resumeSessionId,
      emit: (event) => this.ingest(event),
      readFile: this.deps.readFile
        ? (filePath) => this.deps.readFile!(this.ref.id, filePath)
        : undefined,
      writeFile: this.deps.writeFile
        ? (filePath, contents) => this.deps.writeFile!(this.ref.id, filePath, contents)
        : undefined,
    });

    if (!adapter) {
      throw new Error(`${options.runtime} has no chat adapter`);
    }

    this.adapter = adapter;
    this.setState('starting');

    try {
      await adapter.start();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.ingest({ t: 'error', message: `could not start ${options.runtime}: ${message}`, fatal: true });
      this.setState('error');
      await this.stop();
      throw error;
    }

    this.capabilities = adapter.capabilities;
    this.setState('idle');
  }

  /**
   * Stamp, persist, broadcast.
   *
   * Ordering matters and is deliberate: the log is written before the socket
   * sees anything, so a browser can never hold an event the server would not
   * replay after a restart. The reverse order would make a reconnect look like
   * history had been rewritten.
   */
  private ingest(event: AdapterEvent): void {
    this.seq += 1;
    const stamped = {
      ...event,
      seq: this.seq,
      ts: (event as { ts?: number }).ts ?? Date.now(),
    } as ChatEvent;

    if (stamped.t === 'session' && stamped.nativeSessionId) {
      this.nativeSessionId = stamped.nativeSessionId;
    }
    if (stamped.t === 'state') {
      this.state = stamped.state;
    }
    if (stamped.t === 'capabilities' && this.capabilities) {
      this.capabilities = { ...this.capabilities, ...stamped.capabilities };
    }
    if (stamped.t === 'permission') {
      this.pending.set(stamped.request.requestId, { request: stamped.request });
    }
    if (stamped.t === 'permission_resolved') {
      this.pending.delete(stamped.requestId);
    }

    try {
      this.deps.store.append(this.ref, [stamped]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not persist an event: ${message}`);
    }

    this.deps.broadcast(this.ref.id, { type: 'chat_event', sessionId: this.ref.id, event: stamped });
  }

  private setState(state: ChatState): void {
    if (this.state === state) return;
    this.ingest({ t: 'state', state });
  }

  async send(turn: UserTurn): Promise<void> {
    if (!this.adapter || !this.adapter.alive) {
      throw new Error('this chat session is not running');
    }

    // The user's own turn is recorded here rather than left to each adapter:
    // it is the same in every protocol, and a transcript missing what the user
    // asked is useless for resuming, exporting or searching.
    const messageId = `user-${crypto.randomUUID()}`;
    const turnId = `turn-${crypto.randomUUID()}`;
    this.ingest({ t: 'msg_start', id: messageId, role: 'user', turnId });
    this.ingest({
      t: 'block_start',
      msgId: messageId,
      index: 0,
      block: { kind: 'text', text: turn.text },
    });
    for (const [offset, attachment] of (turn.attachments || []).entries()) {
      this.ingest({
        t: 'block_start',
        msgId: messageId,
        index: offset + 1,
        block: attachment.mime.startsWith('image/')
          ? { kind: 'image', mime: attachment.mime, url: attachment.url, alt: attachment.name }
          : { kind: 'text', text: `Attached: ${attachment.name}` },
      });
    }
    this.ingest({ t: 'msg_end', msgId: messageId });
    this.setState('thinking');

    await this.adapter.send(turn);
  }

  async interrupt(): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.interrupt();
    // Anything still waiting on a person is moot once the turn is cancelled,
    // and leaving the cards on screen would invite answers that go nowhere.
    for (const [requestId, approval] of this.pending) {
      approval.resolve?.({ allow: false, reason: 'the turn was interrupted' });
      this.ingest({ t: 'permission_resolved', requestId, optionId: 'reject_once', allowed: false });
    }
    this.pending.clear();
    this.setState('idle');
  }

  /**
   * Answer a pending approval.
   *
   * Two routes converge here. A hook-broker question has a promise waiting on
   * it; an adapter-native question is answered by the adapter. Either way the
   * transcript records the decision, so the conversation shows what was allowed
   * and what was refused.
   */
  respondPermission(requestId: string, optionId: string): boolean {
    const approval = this.pending.get(requestId);
    if (!approval) return false;

    const option = approval.request.options.find((candidate) => candidate.optionId === optionId);
    const allowed = isAllowOption(option);

    if (approval.resolve) {
      approval.resolve({
        allow: allowed,
        reason: allowed ? 'approved in the browser' : 'denied in the browser',
      });
    } else {
      this.adapter?.respondPermission(requestId, optionId);
    }

    this.pending.delete(requestId);
    this.ingest({ t: 'permission_resolved', requestId, optionId, allowed });
    return true;
  }

  /**
   * A tool call arriving over the hook broker, on its way to a person.
   *
   * Resolves only when someone answers, which is the point: the hook is a
   * blocking call in the agent's own process, so the agent genuinely waits
   * rather than running the tool and apologising afterwards.
   */
  private askUser(ask: PermissionAsk): Promise<PermissionAnswer> {
    if (this.bypass) {
      return Promise.resolve({ allow: true, reason: 'permissions are bypassed for this session' });
    }

    return new Promise<PermissionAnswer>((resolve) => {
      const requestId = `perm-${crypto.randomUUID()}`;
      const options: PermissionOption[] = defaultPermissionOptions();
      const request: PermissionRequest = {
        requestId,
        toolId: ask.toolUseId,
        title: describeAsk(ask),
        toolKind: classifyTool(ask.toolName),
        input: ask.toolInput,
        options,
        ts: Date.now(),
      };

      this.pending.set(requestId, { request, resolve });
      this.ingest({ t: 'permission', request });
      this.setState('awaiting_permission');
    });
  }

  snapshot(): Promise<ChatSnapshot> {
    return this.deps.store.snapshot(this.ref).then((snapshot) => ({
      ...snapshot,
      runtime: this.runtime || snapshot.runtime,
      state: this.state,
      capabilities: this.capabilities || snapshot.capabilities,
      pendingPermissions: Array.from(this.pending.values()).map((entry) => entry.request),
      live: this.live,
      bypassPermissions: this.bypass,
    }));
  }

  async stop(): Promise<void> {
    for (const [, approval] of this.pending) {
      approval.resolve?.({ allow: false, reason: 'the session was stopped' });
    }
    this.pending.clear();

    const adapter = this.adapter;
    this.adapter = null;
    if (adapter) {
      await adapter.stop().catch(() => undefined);
    }

    this.broker?.close();
    this.broker = null;
  }
}

/** One line describing what is being approved, for the card's heading. */
function describeAsk(ask: PermissionAsk): string {
  const input = ask.toolInput as Record<string, unknown> | undefined;
  const command = typeof input?.command === 'string' ? input.command : null;
  if (command) {
    return command.length > 120 ? `${command.slice(0, 117)}...` : command;
  }
  const filePath = typeof input?.file_path === 'string' ? input.file_path : null;
  if (filePath) return `${ask.toolName} ${filePath}`;
  return ask.toolName;
}
