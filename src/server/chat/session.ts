import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatState,
  MAX_QUEUED_TURNS,
  PermissionOption,
  PermissionRequest,
  QueuedTurn,
  UserTurn,
  classifyTool,
  defaultPermissionOptions,
  isAllowOption,
} from '../../shared/chat-events.js';
import { isClearingCommand } from '../../shared/slash-commands.js';
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
  /**
   * Called when the runtime names its own conversation, and again when the
   * process ends.
   *
   * The session record is the only thing that outlives this process, so a fact
   * that has to survive a restart has to be handed to it while there still is
   * one. `exited` is what lets a browser be told the difference between a chat
   * that is thinking and a chat that is gone.
   */
  onLifecycle?: (
    sessionId: string,
    change: { nativeSessionId?: string; exited?: boolean },
  ) => void;
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
  /**
   * Begin a new conversation in this session, leaving the old one behind.
   *
   * Draws the same line `/clear` does. Chosen explicitly by the user rather
   * than inferred from "not resuming", because the two other callers that
   * start without a resume id — a first launch and a surface switch — must not
   * silently move the floor of a transcript nobody asked to close.
   */
  startFresh?: boolean;
}

interface PendingApproval {
  request: PermissionRequest;
  /** Set when the question came over the hook broker rather than the adapter. */
  resolve?: (answer: PermissionAnswer) => void;
}

/**
 * Event kinds a resuming runtime may re-emit from history.
 *
 * Precisely the events that *append* to the transcript, which the log already
 * holds. `tool` is here because it patches a block by id, and the block it
 * would patch is one of the ones being dropped.
 *
 * Deliberately excluded: `session`, `capabilities`, `state`, `usage`, `error`
 * and `permission` describe the process that just started rather than the
 * conversation it was handed, and suppressing them would leave the browser
 * looking at a session whose runtime it could not name. `plan` replaces rather
 * than appends, so re-reporting it costs nothing.
 */
const REPLAYABLE = new Set([
  'msg_start',
  'block_start',
  'block_delta',
  'block_end',
  'msg_end',
  'tool',
  'turn_end',
]);

/**
 * Thrown when the session id is known but nothing is running under it.
 *
 * A distinct type rather than a message to match on, because the recovery for
 * it is specific and offering the wrong one is worse than offering none: this
 * is the condition where the transcript is intact and the conversation can be
 * picked back up, and every other failure here is not.
 */
export class ChatNotRunningError extends Error {
  constructor() {
    super('this chat session is not running');
    this.name = 'ChatNotRunningError';
  }
}

/** Thrown by `send` when the line is already as long as it may get. */
export class QueueFullError extends Error {
  constructor() {
    super(`there are already ${MAX_QUEUED_TURNS} messages waiting; let some run first`);
    this.name = 'QueueFullError';
  }
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

  /**
   * True between resuming a conversation and the first thing the user says in it.
   *
   * Runtimes differ on what a resume emits: ACP's `session/load` replays the
   * whole history back as notifications, and the others make no promise either
   * way. Every one of those events would be appended to a log that already
   * holds them, and the user would watch their conversation appear underneath
   * itself. Nothing the agent says before it is asked something is new, so the
   * rule needs no per-runtime knowledge: while this is set, content is dropped
   * and only the metadata that describes the *new* process is kept.
   */
  private replaying = false;

  /**
   * Turns typed while the agent was busy, oldest first.
   *
   * Held here rather than in the browser on purpose: this object outlives every
   * tab watching it, and a queue that died with the tab would contradict the
   * one promise this whole surface makes — that the agent keeps working after
   * you close it. Two browsers on one session see the same line, and a reload
   * gets it back from the snapshot.
   */
  private queue: QueuedTurn[] = [];
  /** Guards the drain against re-entering itself through `send` -> `ingest`. */
  private draining = false;

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
    this.replaying = Boolean(options.resumeSessionId);
    if (options.resumeSessionId) this.nativeSessionId = options.resumeSessionId;
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
      // One shared directory, not one per session. A directory named after the
      // session id cost 37 bytes of a 103-byte path budget, which is what put
      // the socket over the kernel's limit; the random socket filename already
      // carries the unguessability that directory was standing in for.
      this.broker = new PermissionBroker(this.deps.socketDir);
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

    // Before the first event of the new conversation, so the line lands above
    // it rather than in the middle of it. Only when there is something to draw
    // a line under.
    if (options.startFresh && this.seq > 0) {
      this.ingest({ t: 'marker', kind: 'cleared', detail: 'started a new conversation' });
    }

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

    // The adapter's static declaration is a floor, not an override: a runtime
    // that has already reported its own — Claude sends its slash commands with
    // the first turn's `init` — knows more than this does.
    if (!this.capabilities) {
      this.capabilities = adapter.capabilities;
    }
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
    // Dropped before the sequence number is spent, so a resumed conversation
    // does not leave a hole in its own numbering for events that were never
    // written. See `replaying`.
    if (this.replaying && REPLAYABLE.has(event.t)) {
      return;
    }

    this.seq += 1;
    const stamped = {
      ...event,
      seq: this.seq,
      ts: (event as { ts?: number }).ts ?? Date.now(),
    } as ChatEvent;

    if (stamped.t === 'session') {
      if (stamped.nativeSessionId) {
        this.nativeSessionId = stamped.nativeSessionId;
        this.deps.onLifecycle?.(this.ref.id, { nativeSessionId: stamped.nativeSessionId });
      }
      // Kept, not just forwarded. This is where a runtime reports what it can
      // actually do — including the slash commands it accepts — and `start()`
      // overwrites this field with the adapter's *static* capabilities once it
      // returns. Without this the command list survived only until the browser
      // rejoined, at which point the snapshot handed back a capability set that
      // had never heard of it.
      this.capabilities = stamped.capabilities;
    }
    if (stamped.t === 'state') {
      this.state = stamped.state;
      // The record carries `active` for the whole app; leaving it true after
      // the process died is what made a relaunch in the same session come back
      // as "A process is already running in this session" — a lie the user
      // could only escape by making a new tab.
      if (stamped.state === 'exited') {
        this.deps.onLifecycle?.(this.ref.id, { exited: true });
      }
    }
    if (stamped.t === 'turn_end' && this.state !== 'error' && this.state !== 'exited') {
      // Mirrors the reducer, which does exactly this. Not emitted as a `state`
      // event: the log already carries turn_end, and every reader of that log
      // reaches the same conclusion from it. Emitting a second event would put
      // the same fact in twice.
      this.state = 'idle';
    }
    if (stamped.t === 'capabilities' && this.capabilities) {
      this.capabilities = { ...this.capabilities, ...stamped.capabilities };
    }
    if (stamped.t === 'permission') {
      // Merged, never replaced. `askUser` records the resolver *before* it
      // emits this event, and a plain `set` here threw that resolver away —
      // so answering in the browser found nothing to resolve, fell through to
      // the adapter (a no-op for Claude, which has no permission channel), and
      // the hook waited on a reply that was never written. Every approval in a
      // Claude chat hung the turn: the tool never ran, and the UI kept its
      // stop button and its "Working" indicator forever.
      const existing = this.pending.get(stamped.request.requestId);
      this.pending.set(stamped.request.requestId, {
        request: stamped.request,
        resolve: existing?.resolve,
      });
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

    // Last, and only after the event is on the wire: this is where a turn that
    // ended hands the runtime to whatever was typed while it ran. Doing it here
    // rather than on a timer means the line advances the instant the state
    // says it may, and the events of the next turn are numbered after the ones
    // that closed the last.
    this.drainQueue();
  }

  private setState(state: ChatState): void {
    if (this.state === state) return;
    this.ingest({ t: 'state', state });
  }

  // -------------------------------------------------------------- the queue

  /** Everything still waiting, oldest first. A copy; callers cannot reorder it. */
  get queuedTurns(): QueuedTurn[] {
    return this.queue.map((turn) => ({ ...turn }));
  }

  /**
   * Accept a turn.
   *
   * Idle and nothing waiting means it goes straight to the runtime. Anything
   * else — a turn in flight, an approval on screen, a runtime still starting —
   * means it takes its place in line instead of being refused, which is the
   * whole point: you can keep typing while the agent works.
   *
   * The queue is also checked when the state *is* idle, because a drain is
   * scheduled by the event stream and a turn arriving in that gap must not
   * overtake the ones already waiting.
   */
  async send(turn: UserTurn): Promise<void> {
    if (!this.adapter || !this.adapter.alive) {
      throw new ChatNotRunningError();
    }

    if (this.state !== 'idle' || this.queue.length > 0) {
      this.enqueue(turn);
      return;
    }

    await this.deliver(turn);
  }

  private enqueue(turn: UserTurn): void {
    if (this.queue.length >= MAX_QUEUED_TURNS) {
      throw new QueueFullError();
    }
    this.queue.push({
      id: `queued-${crypto.randomUUID()}`,
      text: turn.text,
      attachments: turn.attachments,
      ts: Date.now(),
    });
    this.publishQueue();
  }

  /** Drop one waiting turn. False when it had already been sent or removed. */
  cancelQueued(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((turn) => turn.id !== id);
    if (this.queue.length === before) return false;
    this.publishQueue();
    return true;
  }

  /** Drop the whole line. Returns how many turns were discarded. */
  clearQueue(): number {
    const dropped = this.queue.length;
    if (!dropped) return 0;
    this.queue = [];
    this.publishQueue();
    return dropped;
  }

  /**
   * Hand the runtime the next waiting turn, if it is free to take one.
   *
   * Called from `ingest`, which is to say after every event — so the guard
   * matters more than the trigger. `draining` closes the loop this would
   * otherwise be: delivering a turn ingests its own events, and each of those
   * would come straight back here.
   */
  private drainQueue(): void {
    if (this.draining || this.queue.length === 0) return;

    // A dead session cannot work through its backlog, and leaving the turns
    // on screen forever would suggest it might.
    if (!this.adapter?.alive || this.state === 'exited' || this.state === 'error') {
      const dropped = this.clearQueue();
      this.ingest({
        t: 'error',
        message: `${dropped} queued message${dropped === 1 ? '' : 's'} could not be sent: the session is no longer running.`,
      });
      return;
    }

    if (this.state !== 'idle') return;

    this.draining = true;
    const next = this.queue.shift()!;
    this.publishQueue();

    // `deliver` moves the state to `thinking` before it awaits anything, so by
    // the time this promise is pending the guard above already holds on its own.
    this.deliver({ text: next.text, attachments: next.attachments })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.ingest({ t: 'error', message: `could not send a queued message: ${message}` });
      })
      .finally(() => {
        this.draining = false;
      });
  }

  private publishQueue(): void {
    this.deps.broadcast(this.ref.id, {
      type: 'chat_queue',
      sessionId: this.ref.id,
      queued: this.queuedTurns,
    });
  }

  private async deliver(turn: UserTurn): Promise<void> {
    if (!this.adapter || !this.adapter.alive) {
      throw new ChatNotRunningError();
    }

    // Before the first ingest, not after: the user's own message goes through
    // the same gate, and clearing this late would swallow the very turn that
    // ends the replay.
    this.replaying = false;

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

    // After the runtime has accepted it, not before: if the send throws, the
    // conversation is still there and clearing the window would have thrown
    // away a transcript for a command that never ran.
    //
    // The marker goes in the durable log like everything else, so a browser
    // that rejoins later replays the clear rather than being handed back the
    // messages this was supposed to remove.
    if (isClearingCommand(turn.text)) {
      this.ingest({ t: 'marker', kind: 'cleared' });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.adapter) return;
    // Before the state moves: going idle is what releases the queue, and a
    // stop that then fired the three messages waiting behind it would be the
    // opposite of what the button says. Someone who wants them can send them.
    const dropped = this.clearQueue();
    await this.adapter.interrupt();
    // Anything still waiting on a person is moot once the turn is cancelled,
    // and leaving the cards on screen would invite answers that go nowhere.
    for (const [requestId, approval] of this.pending) {
      approval.resolve?.({ allow: false, reason: 'the turn was interrupted' });
      this.ingest({ t: 'permission_resolved', requestId, optionId: 'reject_once', allowed: false });
    }
    this.pending.clear();
    if (dropped) {
      this.ingest({
        t: 'error',
        message: `Stopped. ${dropped} queued message${dropped === 1 ? ' was' : 's were'} discarded.`,
      });
    }
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
      // The replayed state is computed by the same reducer the browser runs,
      // so it is the authority on what has happened in the conversation. This
      // object only knows better about the process: whether it is still alive.
      //
      // It used to override with `this.state`, which is only moved by an
      // explicit `state` event — and Claude ends a turn with `turn_end`, not
      // with `state: idle`. So every rejoin of a finished turn came back
      // saying "Thinking", with a composer that looked stuck.
      state: this.live ? snapshot.state : 'exited',
      capabilities: this.capabilities || snapshot.capabilities,
      pendingPermissions: Array.from(this.pending.values()).map((entry) => entry.request),
      queued: this.queuedTurns,
      live: this.live,
      nativeSessionId: this.nativeSessionId || undefined,
      bypassPermissions: this.bypass,
    }));
  }

  async stop(): Promise<void> {
    for (const [, approval] of this.pending) {
      approval.resolve?.({ allow: false, reason: 'the session was stopped' });
    }
    this.pending.clear();
    this.clearQueue();

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
