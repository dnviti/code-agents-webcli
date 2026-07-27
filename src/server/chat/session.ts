import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatState,
  ChatUsage,
  MAX_QUEUED_TURNS,
  PermissionOption,
  PermissionRequest,
  QueuedTurn,
  QuestionOption,
  QuestionRequest,
  UserTurn,
  classifyTool,
  defaultPermissionOptions,
  isAllowOption,
  isAskQuestionTool,
  looksLikeAskCall,
  askedQuestionFrom,
  normalizeQuestionOptions,
  ASK_MCP_SERVER,
  ASK_QUESTION_TOOL_NAME,
} from '../../shared/chat-events.js';
import { isClearingCommand, mergeSlashCommands } from '../../shared/slash-commands.js';
import { listInstalledCommands } from './installed-commands.js';
import { AdapterEvent, ChatAdapter, ChatAdapterOptions } from './adapter.js';
import {
  PermissionAsk,
  PermissionAnswer,
  PermissionBroker,
  QuestionAsk,
  QuestionReply,
  permissionHookSettings,
} from './permission-broker.js';
import { ASK_SOCKET_ENV, askMcpConfig } from './ask-mcp.js';
import { ChatStoreLike, ChatSessionRef } from './store.js';
import { askChannelFor, createChatAdapter, supportsChat } from './registry.js';
import { FinishedJob, UsageAccountant } from './usage-accounting.js';
import { UsageJobInput } from '../services/usage-store.js';
import { projectNameFor } from '../../shared/usage-records.js';

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
  /**
   * Absolute path to the compiled MCP server that asks the user questions.
   *
   * Optional so a deployment that has not built it (or does not want the
   * capability) simply runs without it, rather than failing to start a session.
   */
  askScript?: string;
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
  /**
   * Where finished work is filed.
   *
   * Optional, and every call site tolerates its absence: accounting is a
   * bystander here, and a session must be able to run without one. Every test
   * fixture that predates it constructs a session with no sink at all.
   */
  usage?: ChatUsageSink;
  /**
   * Who to ask how large a model's context window is, when the agent won't say.
   *
   * Optional in the same spirit as `usage`: a session runs perfectly well
   * without one, and simply reports that capacity is unknown for the agents
   * that publish none.
   */
  capacity?: ModelCapacitySource;
}

/** Asked only for models no agent described; see `model-capacity.ts`. */
export interface ModelCapacitySource {
  contextWindowFor(model: string | undefined): Promise<number | null>;
}

/**
 * The accounting side of a session, as this file needs it.
 *
 * A narrow interface rather than the store itself so the session depends on
 * what it uses — file a job, ask what a conversation has been billed — and not
 * on SQLite.
 */
export interface ChatUsageSink {
  record(job: UsageJobInput): void;
  /**
   * What this conversation has already been recorded as consuming.
   *
   * The baseline for every runtime that reports a running total rather than a
   * per-turn figure — tokens here, and cost through `costBaselineFor` for the
   * one runtime whose cost works that way.
   */
  consumedFor(nativeSessionId: string): ChatUsage;
  /**
   * What this conversation has already been billed, or null when nothing is
   * recorded for it at all. See `costBaselineUsd` on the adapter options.
   */
  costBaselineFor(nativeSessionId: string): number | null;
  /** The login to file the work under, resolved once per job. */
  loginFor(userId: number): string;
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

/** A question put to the browser, and the tool call waiting on the answer. */
interface PendingQuestion {
  request: QuestionRequest;
  resolve: (reply: QuestionReply) => void;
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
  private readonly questions = new Map<string, PendingQuestion>();
  /**
   * Question tool calls the transcript has opened and nothing has claimed yet.
   *
   * The MCP server that carries a question has no way to know the tool_use id of
   * the call it is serving — it only ever sees the arguments — so the pairing is
   * made here instead, from the block the adapter already reported.
   *
   * Matched on the question text first, and only then on announcement order.
   * Order alone is not enough, which omp demonstrated: its model got the option
   * schema wrong, the call was rejected before it ever reached the MCP server,
   * and it retried. That leaves *two* announced calls for one question, and
   * claiming the oldest pinned the card to the attempt that failed. Newest match
   * first is the answer, because a retry is the later of the two.
   *
   * An unclaimed entry left by a call that never reached the server would
   * mispair a later question, so the list is emptied at the end of every turn —
   * by which point nothing can still be waiting to claim one.
   */
  private askCalls: Array<{ toolId: string; question?: string }> = [];
  /** True once this session actually handed a runtime the question tool. */
  private questionsEnabled = false;
  private runtime = '';
  private bypass = false;
  private nativeSessionId: string | null = null;
  private startedAt = 0;
  private cwd = '';
  /** The options this session was last launched with, kept for `/clear` and `/new`. */
  private lastStartOptions: ChatSessionStartOptions | null = null;

  /**
   * The model whose context window is being reported, and where it came from.
   *
   * Four of the agents here publish their own window and this never asks
   * anyone; pi and kimi publish none, and for those the model's provider is
   * asked instead — once per model, not once per turn. `askedFor` is what
   * stops a conversation from re-asking a question that already came back
   * empty on every single message.
   *
   * All three reset when the model changes, because the whole point is that a
   * switch to a smaller model must not carry the larger one's ceiling forward.
   */
  private contextModel?: string;
  private contextWindowFromAgent = false;
  private capacityAskedFor?: string;

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

  /**
   * Watches this session's own events and files what each job cost.
   *
   * Rebuilt on every `start()` because the two things it has to know — whether
   * this process resumed a conversation, and what that conversation had already
   * been billed — are properties of the launch, not of the session.
   */
  private accountant: UsageAccountant | null = null;

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

    this.lastStartOptions = options;
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

    // Anything still open belongs to the process that just went away, not to
    // the one about to start, and a relaunch is exactly where an interrupted
    // job would otherwise be lost.
    this.accountant?.flush();
    this.accountant = this.deps.usage
      ? new UsageAccountant(
          (job) => this.fileJob(job),
          // Only when resuming, and it is what this conversation has already
          // been recorded as using — the evidence the accountant needs to tell
          // a counter that carried its history from one that restarted.
          options.resumeSessionId
            ? this.deps.usage.consumedFor(options.resumeSessionId)
            : undefined,
        )
      : null;

    const env = { ...(options.env || {}) };
    const extraArgs = [...(options.extraArgs || [])];

    // Claude reaches the browser over a unix socket for two different reasons:
    // a PreToolUse hook asking whether a tool may run, and an MCP server asking
    // the user a question. Both dial the same socket, so it is opened whenever
    // either of them will be installed.
    //
    // The hook is skipped when bypassing — there is nothing to approve — but the
    // question channel is not. Bypassing approvals means "stop asking me before
    // you act"; it has never meant "answer my questions on my behalf", and a
    // model that asks which of three approaches to take still needs a person.
    const wantsHook = !this.bypass && options.runtime === 'claude' && fs.existsSync(this.deps.hookScript);
    const askScript = this.deps.askScript;
    const askChannel = askChannelFor(options.runtime);
    const wantsAsk = Boolean(askChannel) && Boolean(askScript) && fs.existsSync(askScript!);
    let askMcpServer: ChatAdapterOptions['askMcpServer'];

    if (wantsHook || wantsAsk) {
      // One shared directory, not one per session. A directory named after the
      // session id cost 37 bytes of a 103-byte path budget, which is what put
      // the socket over the kernel's limit; the random socket filename already
      // carries the unguessability that directory was standing in for.
      this.broker = new PermissionBroker(this.deps.socketDir);
      const socketPath = await this.broker.listen({
        permission: (ask) => this.askUser(ask),
        question: (ask) => this.askQuestion(ask),
      });

      if (wantsHook) {
        extraArgs.push('--settings', permissionHookSettings(this.deps.hookScript, socketPath));
        env.CCWEB_PERMISSION_SOCKET = socketPath;
      }
      if (wantsAsk && askChannel === 'cli') {
        extraArgs.push('--mcp-config', askMcpConfig(askScript!, socketPath));
        // Named explicitly rather than relying on the hook to wave it through:
        // with approvals bypassed there is no hook at all, and without this the
        // one tool whose whole purpose is to ask the user something would be the
        // one tool the runtime refused to run.
        extraArgs.push('--allowedTools', ASK_QUESTION_TOOL_NAME);
        this.questionsEnabled = true;
      }
      if (wantsAsk && askChannel === 'protocol') {
        // ACP agents take their MCP servers in the handshake rather than on the
        // command line, so this goes to the adapter and is sent with
        // `session/new`. Same script, same socket, same tool.
        askMcpServer = {
          name: ASK_MCP_SERVER,
          command: process.execPath,
          args: [askScript!],
          env: { [ASK_SOCKET_ENV]: socketPath },
        };
        this.questionsEnabled = true;
      }
    }

    // What this session could run, read off disk before the runtime is even
    // spawned, so the command menu has something true in it from the moment the
    // conversation opens rather than after a first message has been sent.
    //
    // The home directory comes from the session's own environment where it has
    // one. That is the whole of the isolation this needs: a session lists what
    // is installed for the person it belongs to, and never what is installed
    // for anybody else on the machine.
    const installedCommands = listInstalledCommands(options.runtime, {
      home: env.HOME || process.env.HOME,
      workingDir: options.workingDir,
    });

    const adapter = createChatAdapter(options.runtime, {
      sessionId: this.ref.id,
      workingDir: options.workingDir,
      installedCommands,
      command: this.deps.resolveCommand(options.runtime),
      model: options.model,
      extraArgs,
      env,
      bypassPermissions: this.bypass,
      resumeSessionId: options.resumeSessionId,
      // Only when resuming: a conversation the runtime is starting fresh has a
      // counter that starts at zero, and handing it a baseline would suppress
      // the whole first turn's cost.
      costBaselineUsd: options.resumeSessionId
        ? this.deps.usage?.costBaselineFor(options.resumeSessionId)
        : undefined,
      askMcpServer,
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

    // Every runtime that has not already accounted for what is installed gets
    // it here — codex, grok and pi never report a command list at all, so
    // without this their menu stays empty for the whole session. Nothing is
    // running yet, so nothing can be overwritten: the moment a runtime does
    // report its own list, that list replaces this one entire.
    if (installedCommands.length > 0) {
      adapter.capabilities.commands = mergeSlashCommands(
        adapter.capabilities.commands,
        installedCommands,
      );
    }

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
    // Not an adapter capability: whether the model can ask a question is a fact
    // about what this session wired up, not about what the runtime can parse.
    // The same adapter has it or does not depending on whether the MCP server
    // was built and found.
    if (this.questionsEnabled && this.capabilities) {
      this.capabilities = { ...this.capabilities, questions: true };
      this.ingest({ t: 'capabilities', capabilities: { questions: true } });
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
      // Patched on the event itself, not just on the copy kept here. Every
      // reader of this log — this session, the browser's reducer, a snapshot
      // replayed tomorrow — takes `session.capabilities` as a wholesale
      // replacement, so a flag re-applied only locally would be true on the
      // server and false in every browser. Whether the model can ask a question
      // is a fact about what this session wired up; the runtime introducing
      // itself knows nothing about it and must not be able to unset it.
      if (this.questionsEnabled && !stamped.capabilities.questions) {
        stamped.capabilities = { ...stamped.capabilities, questions: true };
      }
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
    // A question tool call opening is the only chance to learn its id: by the
    // time the MCP server relays the question itself, the arguments are all it
    // knows. `block_start` carries the name, `tool` patches carry only the id,
    // so this is the one event that can make the pairing.
    if (stamped.t === 'block_start' && stamped.block.kind === 'tool') {
      this.noteAskCall(stamped.block.toolId, stamped.block.name, stamped.block.input);
    }
    // Claude streams its arguments in as JSON fragments, so a question tool call
    // is announced before anything says what it asks. The parsed input lands
    // later as a patch, which is the first point the text is knowable.
    if (stamped.t === 'tool' && stamped.patch.input !== undefined) {
      this.noteAskCall(stamped.toolId, stamped.patch.name, stamped.patch.input);
    }
    if (stamped.t === 'turn_end') {
      this.askCalls = [];
    }
    if (stamped.t === 'question') {
      const existing = this.questions.get(stamped.request.requestId);
      if (existing) {
        // Same merge-don't-replace rule the approval path learned the hard way:
        // `askQuestion` records the resolver before it emits this event, and
        // overwriting the entry here would throw away the only thing that can
        // unblock the waiting tool call.
        this.questions.set(stamped.request.requestId, { request: stamped.request, resolve: existing.resolve });
      }
    }
    if (stamped.t === 'question_resolved') {
      this.questions.delete(stamped.requestId);
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
    this.noteContext(stamped);

    try {
      this.deps.store.append(this.ref, [stamped]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not persist an event: ${message}`);
    }

    this.deps.broadcast(this.ref.id, { type: 'chat_event', sessionId: this.ref.id, event: stamped });

    // After the log and the socket, and wrapped: accounting is a bystander to
    // this conversation and must never be able to stop one. A dropped record is
    // a hole in a report; a throw here would be a chat that stops mid-turn.
    try {
      this.accountant?.observe(stamped);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not account for an event: ${message}`);
    }

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

  /**
   * Keep the context reading pointed at the model that is actually running.
   *
   * Two jobs. The first is noticing when the model changes: a conversation
   * that switches from a million-token model to a two-hundred-thousand one and
   * keeps the old ceiling would show a bar that is comfortably under a quarter
   * full while the real window is nearly gone. Everything learned about the
   * old model is dropped on the switch rather than adjusted.
   *
   * The second is filling the gap for the agents that publish no capacity at
   * all, by asking the provider whose model they named. That is a network call,
   * so it happens once per model and never blocks the conversation: the answer
   * arrives as an ordinary `usage` event whenever it arrives, and if it never
   * does, the reading says capacity is unknown and means it.
   */
  private noteContext(event: ChatEvent): void {
    if (event.t === 'session' || event.t === 'msg_start') {
      const model = event.model;
      if (model && model !== this.contextModel) {
        // Only a *change* discards what is known. Learning the model for the
        // first time must not: an ACP agent announces its window during the
        // handshake and names the model a beat later, and treating that as a
        // switch would throw away the agent's own figure and go asking a
        // catalogue for a worse one.
        if (this.contextModel !== undefined) {
          this.contextWindowFromAgent = false;
          this.capacityAskedFor = undefined;
        }
        this.contextModel = model;
      }
    }

    if (event.t === 'usage' && event.usage.contextWindow !== undefined) {
      // Only an agent's own figure closes the question. A window this session
      // resolved itself must not mark the agent as having answered, or a later
      // switch back to a model the agent *does* describe would never re-ask.
      if (event.usage.contextWindowSource !== 'provider') this.contextWindowFromAgent = true;
    }

    if (this.contextWindowFromAgent || !this.contextModel) return;
    if (this.capacityAskedFor === this.contextModel) return;
    const capacity = this.deps.capacity;
    if (!capacity) return;

    const model = this.contextModel;
    this.capacityAskedFor = model;
    void capacity
      .contextWindowFor(model)
      .then((window) => {
        // The conversation may have moved on to another model while this was
        // in flight, and a stale ceiling is the exact failure this guards.
        if (window === null || this.contextModel !== model) return;
        if (this.contextWindowFromAgent) return;
        this.ingest({
          t: 'usage',
          usage: { contextWindow: window, contextWindowSource: 'provider' },
        });
      })
      .catch(() => {
        // A lookup that fails is not an event: the reading already says
        // unknown, which is the truthful state, and there is nothing here a
        // person could act on.
      });
  }

  /**
   * File a finished job.
   *
   * Note what is *not* here: nothing the user typed, nothing the agent said,
   * no tool arguments. The record is measurements and identifiers, which is
   * what lets it be kept forever under rules the transcript could never meet.
   *
   * A figure the runtime never reported stays null rather than becoming zero —
   * the capability flags recorded alongside are what let a reader tell "this
   * agent cannot report cost" from "this job cost nothing".
   */
  private fileJob(job: FinishedJob): void {
    const usage = this.deps.usage;
    if (!usage) return;
    const numeric = (value: number | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    try {
      usage.record({
        sessionId: this.ref.id,
        nativeSessionId: job.nativeSessionId ?? this.nativeSessionId,
        turnId: job.turnId,
        userId: this.ref.ownerUserId,
        userLogin: usage.loginFor(this.ref.ownerUserId),
        agent: this.runtime,
        model: job.model,
        // Read now, from the folder this session is pointed at now. A session
        // that is re-pointed mid-flight leaves the work it already did filed
        // under the project it actually ran in — the alternative, resolving it
        // when the dashboard asks, would rewrite last month's figures every
        // time somebody moved a folder.
        project: projectNameFor(this.cwd),
        startedAt: new Date(job.startedAt).toISOString(),
        endedAt: new Date(job.endedAt).toISOString(),
        durationMs: job.durationMs,
        outcome: job.outcome,
        turns: job.turns,
        toolCalls: job.toolCalls,
        inputTokens: numeric(job.usage.inputTokens),
        outputTokens: numeric(job.usage.outputTokens),
        cacheReadTokens: numeric(job.usage.cacheReadTokens),
        cacheWriteTokens: numeric(job.usage.cacheWriteTokens),
        reasoningTokens: numeric(job.usage.reasoningTokens),
        totalTokens: numeric(job.usage.totalTokens),
        costUsd: numeric(job.usage.costUsd),
        reportsUsage: this.capabilities?.usage === true,
        reportsCost: this.capabilities?.cost === true,
        tools: job.tools,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not record usage for a job: ${message}`);
    }
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

    // `/clear` and `/new` promise a conversation the agent has never seen
    // before, not one that only looks that way. Forwarding the text to the
    // still-alive process would just add "/clear" to its own context — the
    // process would still remember everything said before it. A real reset
    // means a new process with no resume id, the same thing a manual "start
    // fresh" relaunch already does.
    if (isClearingCommand(turn.text)) {
      await this.restart();
      return;
    }

    this.setState('thinking');
    await this.adapter.send(turn);
  }

  /**
   * Stop the running adapter and start a brand new one with no resume id, in
   * place, without tearing down the `ChatSession` itself.
   *
   * The marker that tells a rejoining browser to stop paging back past this
   * point is emitted by `start()` itself (`startFresh`), so this only has to
   * get a fresh process running — the same path a manual "start fresh"
   * relaunch takes, just triggered from inside a live conversation instead of
   * from the recovery banner.
   */
  private async restart(): Promise<void> {
    const options = this.lastStartOptions;
    if (!options) return;
    await this.stop();
    // Stale until the new process's own `init` event reports its id — cleared
    // up front so nothing reads the old conversation's id in the meantime.
    this.nativeSessionId = null;
    await this.start({ ...options, resumeSessionId: undefined, startFresh: true });
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
    // A question is moot once the turn it belongs to is cancelled, and a card
    // left on screen would invite an answer with nothing left to receive it.
    for (const [requestId, entry] of this.questions) {
      entry.resolve({ labels: [], error: 'the turn was interrupted' });
      this.ingest({
        t: 'question_resolved',
        requestId,
        toolId: entry.request.toolId,
        optionIds: [],
        skipped: true,
      });
    }
    this.questions.clear();
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
    // The one tool that must never be gated. Asking someone to approve being
    // asked a question is two prompts for one decision, and the second of them
    // is unanswerable in any useful sense — refusing it just blocks the model
    // from talking to the person sitting in front of it.
    if (isAskQuestionTool(ask.toolName)) {
      return Promise.resolve({ allow: true, reason: 'the user is being asked directly' });
    }
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

  /**
   * Remember a tool call that might be a question, or fill in what it asks.
   *
   * Called for every tool block, so the cheap name check comes first. A call
   * already known is updated rather than duplicated: the same id is reported
   * twice — once on announcement and again when its arguments finish arriving.
   */
  private noteAskCall(toolId: string, name: string | undefined, input: unknown): void {
    const existing = this.askCalls.find((call) => call.toolId === toolId);
    if (!existing && !looksLikeAskCall(name, input)) return;

    const question = askedQuestionFrom(input)?.question;
    if (existing) {
      if (question) existing.question = question;
      return;
    }
    this.askCalls.push({ toolId, question });
  }

  /**
   * Which announced call a question belongs to, if any.
   *
   * Claimed as it is answered, so a second question cannot attach itself to the
   * same block — two cards in one place, one of them unanswerable, is worse than
   * one card in the pinned fallback.
   */
  private claimAskCall(question: string): string | undefined {
    // Newest text match wins; see the note on `askCalls` for why a retry makes
    // that the right end to start from.
    for (let at = this.askCalls.length - 1; at >= 0; at -= 1) {
      if (this.askCalls[at].question === question) {
        return this.askCalls.splice(at, 1)[0].toolId;
      }
    }
    // Nothing matched on text — a runtime that reports no arguments, or reports
    // them in a shape nothing here parses. Order is the fallback, oldest first.
    return this.askCalls.shift()?.toolId;
  }

  /**
   * A question from the model, on its way to a person.
   *
   * The promise is the tool call: it resolves when someone clicks, and the MCP
   * server does not answer the runtime until it does. Everything here is
   * defensive about shape because the payload is whatever the model wrote — a
   * question with no options is a question nobody can answer, and coming back
   * with an error the model can read is better than putting an empty card on
   * screen and blocking the turn behind it.
   */
  private askQuestion(ask: QuestionAsk): Promise<QuestionReply> {
    const question = typeof ask.question === 'string' ? ask.question.trim() : '';
    const options = normalizeQuestionOptions(ask.options);

    if (!question || options.length === 0) {
      return Promise.resolve({
        labels: [],
        error: 'the question needs a question and at least one option',
      });
    }

    return new Promise<QuestionReply>((resolve) => {
      const requestId = `ask-${crypto.randomUUID()}`;
      const request: QuestionRequest = {
        requestId,
        // Claimed, not merely read: a second question must not attach itself to
        // the same tool block, which would draw two cards in one place and
        // leave the later one unanswerable.
        toolId: this.claimAskCall(question),
        question,
        header: typeof ask.header === 'string' && ask.header.trim() ? ask.header.trim() : undefined,
        multiSelect: ask.multiSelect === true,
        options,
        ts: Date.now(),
      };
      this.questions.set(requestId, { request, resolve });
      this.ingest({ t: 'question', request });
      this.setState('awaiting_answer');
    });
  }

  /**
   * Record the answer a browser sent, and hand it to the waiting tool call.
   *
   * Returns false for a question this session does not have, which is what a
   * second browser answering one that has already been answered looks like.
   */
  answerQuestion(requestId: string, optionIds: string[], skipped = false): boolean {
    const entry = this.questions.get(requestId);
    if (!entry) return false;

    // Filtered against the offered options rather than trusted: the ids come
    // from a browser, and the labels they resolve to are about to be handed
    // straight to the model as fact.
    const picked = entry.request.options.filter((option) => optionIds.includes(option.optionId));
    const answered = !skipped && picked.length > 0;

    entry.resolve({
      labels: picked.map((option) => option.label),
      skipped: !answered,
    });

    this.questions.delete(requestId);
    this.ingest({
      t: 'question_resolved',
      requestId,
      toolId: entry.request.toolId,
      optionIds: picked.map((option) => option.optionId),
      skipped: !answered,
    });
    return true;
  }

  /**
   * Switch the live process to a different model, for the adapters that can.
   *
   * Only Grok exposes this today — its model is a per-invocation flag it can
   * rewrite for the next turn without a restart. Every other adapter's model
   * is fixed at spawn, so this reports it could not and the caller falls back
   * to the runtime's own `/model` command (best-effort) or to persisting the
   * choice for the next session.
   */
  async setModel(model: string): Promise<boolean> {
    if (!this.adapter?.alive || !this.adapter.setModel) return false;
    await this.adapter.setModel(model);
    return true;
  }

  /**
   * Record the model an in-place restart must launch with.
   *
   * `restart()` replays the options this session was last started with, and
   * those were resolved once, at launch. Everything in them is fixed for the
   * life of the conversation except the model, which `chat_set_model` can
   * change underneath them — so without this a `/clear` would quietly
   * reinstate the model the conversation happened to open with, discarding a
   * choice the browser has already been told was applied.
   *
   * Takes the effective model rather than the override, so clearing an
   * override lands on the profile default here exactly as it would on a fresh
   * launch.
   */
  rememberModel(model: string | undefined): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, model };
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
      pendingQuestions: Array.from(this.questions.values()).map((entry) => entry.request),
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
    // The MCP server's socket is about to go with the process, but it is the
    // one waiting on these promises: resolving them here is what turns a
    // shutdown into a tool result rather than a connection that simply stops
    // answering.
    for (const [, entry] of this.questions) {
      entry.resolve({ labels: [], error: 'the session was stopped' });
    }
    this.questions.clear();
    this.clearQueue();

    // Before the adapter goes: a turn that was still running when someone hit
    // stop is work that happened, and losing it would make every deliberate
    // interruption invisible in the record.
    this.accountant?.flush();
    this.accountant = null;

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
