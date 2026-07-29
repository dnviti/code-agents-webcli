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
  SlashCommand,
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
import { isClearingCommand, isSlashCommand, mergeSlashCommands } from '../../shared/slash-commands.js';
import { installedModels } from './installed-models.js';
import { enumeratesInstalledCommands, listInstalledCommands } from './installed-commands.js';
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
import { projectNameFor, tokenTotal } from '../../shared/usage-records.js';

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
   * that is thinking and a chat that is gone. True when the process ends;
   * false when a conversation replaced in place has one running again, which
   * is the only way a record that has been marked finished comes back.
   *
   * `nativeSessionId` is null for a conversation that no longer has one, which
   * is a fact the record has to be able to hold: leaving out the field says
   * "nothing to report about the id", and a clear has something to report (#43).
   */
  onLifecycle?: (
    sessionId: string,
    change: { nativeSessionId?: string | null; exited?: boolean },
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
  /** What each turn of this conversation cost, for the index beside it. */
  spendByTurn(sessionId: string, userId: number): Map<string, ChatUsage>;
}

export interface ChatSessionStartOptions {
  runtime: string;
  workingDir: string;
  model?: string;
  /**
   * Reasoning-effort level to launch at, spelled the way this runtime spells it.
   *
   * Only ever a value the runtime itself published, because it is passed
   * straight through to the CLI: pi warns and then runs at its default when the
   * level is wrong, which is the quietest possible way to get the opposite of
   * what was asked for.
   */
  effort?: string;
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
 * How often to re-ask an adapter whether it can take the next queued turn.
 *
 * Short enough to be indistinguishable from immediate — the thing being waited
 * on is a child process finishing its exit, measured in single milliseconds —
 * and the wait only ever happens for adapters that spawn one process per turn.
 */
const QUEUE_READY_POLL_MS = 25;

/**
 * How long to keep waiting before calling a queued message undeliverable.
 *
 * Generous on purpose: overshooting costs a message that arrives late, and
 * undershooting costs one reported as failed while it would still have gone.
 */
const QUEUE_READY_TIMEOUT_MS = 15_000;

/**
 * How long after an interrupt a `turn_end` still counts as the answer to it.
 *
 * The runtimes here acknowledge in milliseconds, so this is already generous
 * by orders of magnitude, and it is deliberately not more. This window applies
 * to the interrupt path alone — a message that waited its turn in the queue is
 * delivered after the turn ended and starts its own — and the failure it has to
 * stay away from is swallowing a real ending: a turn left open would fold the
 * next queued message into work it has nothing to do with.
 */
const INTERRUPT_ACK_WINDOW_MS = 5_000;

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
  /**
   * Skills and project commands found on disk when this session launched.
   *
   * Kept so a runtime that reports its own command list cannot drop them; see
   * the merge in `ingest`.
   */
  private installedCommands: SlashCommand[] = [];
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
   *
   * `windowStated` is what makes that true of a switch nobody can answer:
   * dropping what this object knows is not enough when the figure is already
   * written into the log and being read off the screen, so it has to be taken
   * down out loud. See `retractContextWindow`.
   */
  private contextModel?: string;
  private contextWindowFromAgent = false;
  private capacityAskedFor?: string;
  private contextWindowStated = false;
  /** The model the standing agent-reported ceiling was stated for, when named. */
  private agentWindowModel?: string;

  /**
   * The history this conversation was branched with, until the first turn takes it.
   *
   * `undefined` means the store has not been asked yet; `null` means it was and
   * there is nothing — which is every conversation that was not branched. Read
   * once and remembered either way, because it is asked for on every delivery
   * and almost every answer is "no".
   */
  private carried: string | null | undefined;

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
   * The turn currently running, by id, or null between turns.
   *
   * Only one thing reads it: a message promoted past the queue while the agent
   * is working continues *this* turn instead of starting one, because it is
   * being delivered into the work rather than waiting for its own (#86).
   */
  private turnInFlightId: string | null = null;
  /**
   * Until when a `turn_end` is the runtime letting go of interrupted work
   * rather than the turn ending. Null when nothing has been interrupted.
   */
  private staleTurnEndUntil: number | null = null;
  /** Runs the drain again once the adapter has finished letting go of the last turn. */
  private drainRetry: ReturnType<typeof setTimeout> | null = null;
  /** When the current wait for a ready adapter began; null when not waiting. */
  private readySince: number | null = null;

  /**
   * Which process the events arriving here belong to.
   *
   * `stop()` signals the child and returns without waiting for it, so a
   * replaced adapter goes on emitting for as long as its process takes to die
   * — and what it emits last is `state: exited`. Landing that in the log after
   * the replacement is already running told every browser, and the session
   * record, that a live conversation had ended: the pane went read-only over a
   * working agent and only a relaunch could talk it round.
   *
   * Bumped by `start()` and again by `restart()` before the old process is
   * signalled, so each adapter's `emit` closure carries the number it was born
   * with and anything from an older one is dropped rather than believed.
   */
  private adapterGeneration = 0;

  /**
   * True while a conversation is being replaced by a new one in place.
   *
   * Only the queue reads it, and only to stay quiet: a turn already in flight
   * when the clear lands will fail against the process being torn down, and
   * "could not be sent" written into the fresh window would be a complaint
   * about the conversation the user just asked to leave.
   */
  private restarting = false;

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
    // A ceiling can only be taken down if something knows one is up, and this
    // object learns that by watching events go past — which a process that has
    // just started has not done. The browser, meanwhile, folds the whole log
    // and is showing whatever it says. So a conversation with a log behind it
    // is assumed to be stating something: at worst the retraction is a log
    // entry that changes nothing on screen, where the other way round is issue
    // #82 surviving every server restart.
    this.contextWindowStated = stats.cursor > 0;

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

    // Claimed before the adapter exists, so its `emit` closure below can be
    // told apart from the one belonging to a process this replaces.
    const generation = ++this.adapterGeneration;

    const adapter = createChatAdapter(options.runtime, {
      sessionId: this.ref.id,
      workingDir: options.workingDir,
      installedCommands,
      command: this.deps.resolveCommand(options.runtime),
      model: options.model,
      effort: options.effort,
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
      // A dying predecessor is not a witness to the conversation that replaced
      // it. See `adapterGeneration`: everything it still has to say — its own
      // exit above all — is about a process nobody is talking to any more.
      emit: (event) => {
        if (generation !== this.adapterGeneration) return;
        this.ingest(event);
      },
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
    // it here — codex and pi never report a command list at all, so without
    // this their menu stays empty for the whole session. Kept on the session as
    // well, because a runtime reporting its own list later must not be able to
    // drop what is installed on disk; see the merge in `ingest`.
    this.installedCommands = installedCommands;
    if (installedCommands.length > 0) {
      adapter.capabilities.commands = mergeSlashCommands(
        adapter.capabilities.commands,
        installedCommands,
      );
    }

    // And the same for the model picker's menu, for the runtimes that publish
    // one only through a command of their own. Not awaited: this spawns a
    // process, the session has nothing to do with its answer, and a menu is
    // not worth delaying a conversation for. It arrives as a `capabilities`
    // event whenever it arrives, which is what that event is for.
    //
    // It never overwrites a list a runtime published itself. Only grok and pi
    // are probed at all — everybody else either says so over their protocol or
    // has no list to give — but the check makes the precedence explicit rather
    // than incidental: what the runtime says always wins.
    void installedModels(options.runtime, this.deps.resolveCommand(options.runtime), env)
      .then((models) => {
        if (models.length === 0) return;
        if (this.adapter !== adapter) return; // restarted since; that session owns its own menu
        if (adapter.capabilities.models?.length) return;
        adapter.capabilities.models = models;
        this.ingest({ t: 'capabilities', capabilities: { models } });
      })
      .catch(() => {
        // installedModels does not reject; this is belt and braces so a chat
        // session can never be taken down by its own picker.
      });

    // Before the first event of the new conversation, so the line lands above
    // it rather than in the middle of it. Only when there is something to draw
    // a line under.
    if (options.startFresh && this.seq > 0) {
      this.ingest({ t: 'marker', kind: 'cleared', detail: 'started a new conversation' });
      // And the conversation it draws a line under is dropped from the log, so
      // the line is where this one begins rather than a marker in the middle
      // of a longer record. Emptying the browser's window was never enough: a
      // reload replays the tail from disk, and the tail still held everything
      // said before the clear — so the conversation the user had just ended
      // came straight back, and paging up walked into the rest of it.
      //
      // Awaited before the new process starts talking, and enqueued behind the
      // marker's own append: the truncation and the events either side of it
      // are ordered by the store's per-log queue, so nothing lands in a log
      // that is being rewritten. Never fatal — a conversation must not fail to
      // start because its predecessor could not be cleaned up.
      try {
        await this.deps.store.truncateBefore(this.ref, this.seq);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not truncate the cleared conversation: ${message}`);
      }
      // And the branch history goes with it, if this conversation had one
      // waiting. `/clear` promises an agent that has never seen any of it, and
      // handing over the very history just dropped from the transcript would be
      // that promise broken in the most confusing possible way.
      this.carried = null;
      void this.deps.store.clearOpeningContext?.(this.ref);

      // Nor does anything go on naming the conversation that was just dropped. The
      // replacement announces an id of its own on its first turn and not
      // before, so a conversation cleared and then left alone kept the pre-clear
      // id: reopening it after a server restart showed the emptied transcript
      // over a banner offering to resume, and taking that offer spawned the
      // runtime against the very memory the clear had destroyed (#43).
      //
      // Said *after* the truncation on purpose. The record is not the only
      // place that answers this question — a record with no id sends the
      // manager and the sessions route to the head of the log for one — so
      // clearing the record while the old `session` event was still readable
      // would have the id put straight back on the next rejoin.
      this.nativeSessionId = null;
      this.deps.onLifecycle?.(this.ref.id, { nativeSessionId: null });
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

    // What is installed on disk is not the runtime's to forget — unless the
    // runtime is one that lists it itself.
    //
    // A runtime that reports its own command list replaces whatever was there,
    // which is right for the runtimes that report everything they accept — and
    // wrong for the one that does not. Grok on ACP announces seven built-ins
    // (`compact`, `context`, ...) and nothing about the skills and project
    // commands sitting in `.grok/skills`, so a wholesale replacement dropped
    // every one of them from the menu the moment the handshake finished (#73).
    // Claude names every skill and plugin command it accepts, so putting the
    // scan back on top of that could only add names Claude has no command for
    // — picking one sent it as prose and nothing ran (#71). Which of the two a
    // runtime is, is knowledge about the runtime and is kept with the rest of
    // it, in `installed-commands.ts`.
    //
    // Merged on the event itself for the same reason the `questions` flag above
    // is: this list is read from the log by the browser and by any snapshot
    // replayed later, so a merge applied only to the local copy would be a menu
    // that differs between the server and every client reading it.
    if (this.installedCommands.length > 0 && !enumeratesInstalledCommands(this.runtime)) {
      if (stamped.t === 'session' && stamped.capabilities.commands) {
        stamped.capabilities = {
          ...stamped.capabilities,
          commands: mergeSlashCommands(stamped.capabilities.commands, this.installedCommands),
        };
      }
      if (stamped.t === 'capabilities' && stamped.capabilities.commands) {
        stamped.capabilities = {
          ...stamped.capabilities,
          commands: mergeSlashCommands(stamped.capabilities.commands, this.installedCommands),
        };
      }
    }

    if (stamped.t === 'turn_end') {
      // The first `turn_end` after an interrupt sent to make room for a message
      // is the runtime letting go of the half it was told to abandon — not this
      // turn ending. The turn is running again, on the correction that caused
      // the interrupt, and every reader downstream is told so on the event
      // itself rather than left to work it out (#86).
      //
      // One deep, time-bounded, and only while a turn is actually open: the
      // runtimes here answer in milliseconds, and a `turn_end` arriving after
      // that window is the redirected work finishing, which really does end the
      // turn. Every one of those bounds is there to fail in the same safe
      // direction — an ending taken for an acknowledgement would leave the turn
      // open and fold the next queued message into it, and a queued message is
      // its own turn by definition, delivered only once this one is over.
      const acknowledging =
        this.staleTurnEndUntil !== null
        && Date.now() <= this.staleTurnEndUntil
        && this.turnInFlightId !== null;
      if (acknowledging) {
        this.staleTurnEndUntil = null;
        stamped.stale = true;
      } else {
        this.staleTurnEndUntil = null;
        // The turn a steer would join, and only for as long as there is one to
        // join. Cleared here rather than where the state changes because
        // `turn_end` is the one event every runtime agrees means "that turn is
        // over", and a stale id would make the next message look like a
        // continuation of work that had already finished — which is the count
        // going wrong in the other direction.
        this.turnInFlightId = null;
      }
    }

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
   * does, the reading says capacity is unknown and means it — including when it
   * had been saying something else a moment earlier.
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
        //
        // Nor does a change the agent has already answered. It states the new
        // model's ceiling the moment the switch is accepted, which is before
        // any message names that model, so this event is the *second* thing to
        // arrive about it. Discarding here would send us asking a catalogue
        // about an id it has never heard of — grok's are internal — and take
        // down a figure grok had just published.
        if (this.contextModel !== undefined && this.agentWindowModel !== model) {
          this.contextWindowFromAgent = false;
          this.capacityAskedFor = undefined;
        }
        this.contextModel = model;
      }
    }

    if (event.t === 'usage') {
      if (event.usage.contextWindow !== undefined) {
        // Only an agent's own figure closes the question. A window this session
        // resolved itself must not mark the agent as having answered, or a
        // later switch back to a model the agent *does* describe would never
        // re-ask.
        if (event.usage.contextWindowSource !== 'provider') {
          this.contextWindowFromAgent = true;
          this.agentWindowModel = event.usage.contextWindowModel;
        }
        this.contextWindowStated = true;
      } else if (event.usage.contextWindowSource === 'unknown') {
        this.contextWindowStated = false;
        this.agentWindowModel = undefined;
      }
    }

    if (this.contextWindowFromAgent || !this.contextModel) return;
    if (this.capacityAskedFor === this.contextModel) return;

    const model = this.contextModel;
    this.capacityAskedFor = model;
    // A lookup that answers null and no lookup at all are the same answer about
    // this model; a lookup that *threw* is not an answer and is kept apart
    // below. All of them travel the same deferred path: this runs inside
    // `ingest`, so emitting from here and now would number an event after the
    // one being handled and put it on the wire ahead of it.
    const asked: Promise<number | null | undefined> = this.deps.capacity
      ? this.deps.capacity.contextWindowFor(model).catch(() => undefined)
      : Promise.resolve(null);
    void asked
      .then((window) => {
        // The conversation may have moved on to another model while this was
        // in flight, and a stale ceiling is the exact failure this guards.
        if (this.contextModel !== model || this.contextWindowFromAgent) return;
        if (window === undefined) {
          // Not reachable is not an answer. Retracting on it would let one bad
          // moment on the network leave a knowable model reading "size unknown"
          // for the rest of the conversation, because nothing re-asks once a
          // model has been asked about. Forget having asked instead.
          if (this.capacityAskedFor === model) this.capacityAskedFor = undefined;
          return;
        }
        if (window === null) {
          // Nobody can size this one — not the agent, and not the catalogue.
          // What is on screen is the model the conversation left, so it comes
          // down rather than being left there to be read as this model's.
          this.retractContextWindow();
          return;
        }
        this.ingest({
          t: 'usage',
          usage: { contextWindow: window, contextWindowSource: 'provider' },
        });
      })
      .catch(() => {
        // Accounting for capacity is a bystander to the conversation, like the
        // accountant above: there is nothing here a person could act on.
      });
  }

  /**
   * Take the ceiling down, and say so.
   *
   * A `usage` report with a source and no window, because leaving the number
   * out is how every other report says "I am not talking about that field" —
   * the rule that keeps a streaming patch from blanking the figures beside it.
   * Only sent when there is something to retract: a conversation whose window
   * was never established already reads as unknown, and an event saying so
   * again would be a log entry that changes nothing.
   */
  private retractContextWindow(): void {
    if (!this.contextWindowStated) return;
    this.ingest({ t: 'usage', usage: { contextWindowSource: 'unknown' } });
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
        modelTurns: job.modelTurns,
        toolCalls: job.toolCalls,
        inputTokens: numeric(job.usage.inputTokens),
        outputTokens: numeric(job.usage.outputTokens),
        cacheReadTokens: numeric(job.usage.cacheReadTokens),
        cacheWriteTokens: numeric(job.usage.cacheWriteTokens),
        reasoningTokens: numeric(job.usage.reasoningTokens),
        // Derived when the runtime gave no total of its own, from the parts it
        // did give — see `tokenTotal`. The alternative, filing the runtime's
        // total or nothing, is what made the history say "not reported" for
        // every job Claude ever ran while the same job's tokens were on screen
        // the whole time it ran (#80). The parts are still filed beside it
        // unchanged, so nothing here invents a figure: it adds one up.
        totalTokens: numeric(tokenTotal(job.usage) ?? undefined),
        costUsd: numeric(job.usage.costUsd),
        reportsUsage: this.capabilities?.usage === true,
        reportsCost: this.capabilities?.cost === true,
        tools: job.tools,
        models: job.models.map((split) => ({
          model: split.model,
          calls: numeric(split.calls),
          inputTokens: numeric(split.usage?.inputTokens),
          outputTokens: numeric(split.usage?.outputTokens),
          cacheReadTokens: numeric(split.usage?.cacheReadTokens),
          cacheWriteTokens: numeric(split.usage?.cacheWriteTokens),
          costUsd: numeric(split.usage?.costUsd),
        })),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not record usage for a job: ${message}`);
      return;
    }

    // Said out loud as well as filed, so the figure beside the turn appears the
    // moment the turn ends rather than the next time the conversation is
    // opened. It is the filed figure, not a second reading of the events: a
    // browser cannot work out what a turn cost on the runtimes that report a
    // running total, and two answers to "what did this cost" is the disagreement
    // #86 exists to remove.
    this.deps.broadcast(this.ref.id, {
      type: 'chat_turn_spend',
      sessionId: this.ref.id,
      turnId: job.turnId,
      usage: job.usage,
    });
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
    // A conversation being replaced has no adapter for a moment, and refusing
    // here is what put the "this chat is not running" recovery offer in front
    // of someone who had just cleared and started typing. It is starting, not
    // gone: the turn waits the way it would for any other busy session and
    // goes out when the new process reports idle.
    if (this.restarting) {
      this.enqueue(turn);
      return;
    }

    if (!this.adapter || !this.adapter.alive) {
      throw new ChatNotRunningError();
    }

    // Never queued. Clearing is not another thing to say to the agent, it is
    // the end of saying things to *this* agent — a `/clear` waiting behind the
    // answer it was meant to cut short would sit there for as long as that
    // answer ran, and anything queued behind it goes to a process that is
    // about to be replaced. Taking it now is also what makes the button and
    // the three spellings one behaviour rather than four.
    if (isClearingCommand(turn.text)) {
      await this.deliver(turn);
      return;
    }

    // `adapterReady` matters here as much as in the drain: pressing Enter the
    // instant a turn ends puts a message through this path, not the queue's,
    // and the adapter is no readier for it (#89). Queued rather than refused —
    // the line is drained the moment it can be.
    const ready = this.adapterReady;
    if (this.state !== 'idle' || this.queue.length > 0 || !ready) {
      this.enqueue(turn);
      // Only this case needs a push. Everything else is waiting on an event
      // that is certain to come — the running turn's end — but a session that
      // is *already* idle has had its last event, and a turn parked here for
      // an adapter still letting go of the previous process would wait for a
      // drain that nothing was ever going to trigger.
      if (this.state === 'idle' && !ready) this.drainQueue();
      return;
    }

    try {
      await this.deliver(turn);
    } catch (error: unknown) {
      // Kept, not thrown back at a browser that has already cleared the box it
      // was typed in. A message that could not be handed over goes into the
      // line with the reason on it, exactly like one that failed on its way out
      // of the queue — same failure, same recovery, whichever path it took.
      const message = error instanceof Error ? error.message : String(error);
      this.failQueuedTurn(
        { id: `queued-${crypto.randomUUID()}`, text: turn.text, attachments: turn.attachments, ts: Date.now() },
        message,
      );
    }
  }

  /**
   * Whether the adapter would accept a turn right now.
   *
   * Adapters that do not answer are always ready, which is true of every one
   * driving a single long-lived process.
   */
  private get adapterReady(): boolean {
    return this.adapter?.readyForTurn !== false;
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

  /**
   * Take one waiting turn out of the line and give it to the agent now.
   *
   * The queue is the right default — most of what you type while an agent works
   * is worth waiting its turn — but some of it is the reason you are typing at
   * all: the wrong file, the wrong database, a test that already exists. Those
   * are worth the interruption, and until this existed the only way to deliver
   * one was the stop button, which discards everything else that was waiting.
   *
   * So: whatever is in flight is cut short, the chosen turn is handed over —
   * or, when the runtime has not let go of the work yet, put back at the head
   * of the line so it is the next thing delivered — and **the rest of the queue
   * stays exactly as it was**, in order, behind it.
   *
   * False when the runtime was not handed the turn on this call — nothing to
   * promote (an unknown id: already delivered, already withdrawn, or a second
   * click on the same row), a session that is no longer running, a delivery
   * already under way, or a runtime that has not finished letting go of the
   * turn it was just told to abandon. Only the last of those leaves the message
   * on its way out, at the head of the line. Silent rather than loud either
   * way: every one of them is a race the user cannot lose in a way that
   * matters, and the queue broadcast that follows tells every browser what is
   * true now.
   */
  async sendQueuedNow(id: string): Promise<boolean> {
    if (!this.adapter?.alive || this.state === 'exited' || this.state === 'error') return false;
    // A drain in progress owns the runtime for the length of one `deliver`.
    // Cutting in here would interrupt a turn that has not finished starting.
    if (this.draining) return false;
    // A runtime that cannot be interrupted cannot be cut in front of either:
    // the interrupt would not end the turn, and the promoted message would
    // reach a process already working on another one — two turns at once, which
    // is the one thing the queue exists to prevent. Checked before the message
    // leaves the line, and here rather than only in the browser, because the
    // browser is not the only thing that can ask.
    const inFlight = this.state !== 'idle';
    if (inFlight && !this.adapter.capabilities.interrupt) return false;

    const index = this.queue.findIndex((turn) => turn.id === id);
    if (index < 0) return false;
    const [turn] = this.queue.splice(index, 1);
    this.publishQueue();

    // Held across the interrupt *and* the delivery, because going idle is what
    // releases the queue: `interrupt` ends in `setState('idle')`, `ingest` runs
    // `drainQueue` after every event, and without this the first message still
    // waiting would overtake the one the user actually chose.
    // Read before the interrupt, because the interrupt is what ends the runtime's
    // own run and ending it is what clears this. A promoted message delivered
    // into work that was running continues that work's turn; one promoted while
    // the session was idle has no work to join and starts its own (#86).
    const steering = inFlight ? this.turnInFlightId : null;

    this.draining = true;
    try {
      if (inFlight) {
        // Every runtime here answers an interrupt by ending its run, and that
        // acknowledgement is not this turn ending — the turn is about to carry
        // on with the correction. Said before the interrupt because the answer
        // to it can arrive during the await.
        this.staleTurnEndUntil = Date.now() + INTERRUPT_ACK_WINDOW_MS;
        await this.cancelTurnInFlight();
        // The record has to say the turn stopped because of this message, not
        // that the agent simply gave up. `marker` rather than an error: being
        // corrected mid-turn is not a failure, and it belongs to the
        // conversation rather than to the turn that was stopped.
        this.ingest({ t: 'marker', kind: 'interrupted', detail: quoteTurn(turn.text) });
      }

      // The gate `send` and the drain have had since #89, missing from the one
      // path that hands a turn over without ever having asked. On pi it is not
      // a race but the rule: `interrupt()` signals the child and returns, and
      // `readyForTurn` stays false until that child's `exit` — a macrotask
      // away, so nothing between here and the send could change the answer and
      // the send threw every single time, taking the promoted message with it
      // (#70). Parked at the head instead, the way `send` parks a turn the
      // adapter cannot take yet: the drain's poll hands it over the moment the
      // process lets go, milliseconds later.
      //
      // The interrupt stands. The work is already dead and the marker above
      // already quotes this message, so the one outcome that is not acceptable
      // here is the message going away with the turn it stopped.
      if (!this.adapterReady) {
        // And it arrives as its own turn rather than as a steer: the work it
        // was going to redirect is over by the time the runtime can take it, so
        // the `turn_end` that closes that work really does close it.
        this.staleTurnEndUntil = null;
        this.queue = [turn, ...this.queue];
        this.publishQueue();
        // Armed here rather than left to the drain, which returns before it
        // reaches this on a session that is not idle yet. Without it a child
        // that ignores the signal and never exits leaves the message sitting at
        // the head with no error on it — and a turn with no error is not one
        // the retry control will touch, so it would be kept and unreachable.
        this.waitForReady();
        return false;
      }

      await this.deliver({ text: turn.text, attachments: turn.attachments }, steering ?? undefined);
      return true;
    } catch (error: unknown) {
      // Back in the line with the reason on it, exactly like a turn that failed
      // on its way out of the queue — same failure, same recovery. Writing the
      // error and stopping there lost the message outright: it had left the
      // queue before the interrupt, so nothing on screen still held what the
      // user had typed and there was nothing to retry (#70). The ack window
      // goes for the same reason it does above — nothing is going to carry on
      // the turn this stopped.
      this.staleTurnEndUntil = null;
      const message = error instanceof Error ? error.message : String(error);
      this.failQueuedTurn(turn, message, { putBack: true });
      return false;
    } finally {
      this.draining = false;
      // A delivery that threw leaves the state where it was, which may be idle
      // with messages still waiting — and nothing else would come along to
      // notice. Harmless in the ordinary case: the agent is working on the
      // promoted turn, so the guard inside returns immediately.
      this.drainQueue();
    }
  }

  /** Drop the whole line. Returns how many turns were discarded. */
  clearQueue(): number {
    this.stopWaitingForReady();
    const dropped = this.queue.length;
    if (!dropped) return 0;
    this.queue = [];
    this.publishQueue();
    return dropped;
  }

  /**
   * Try a turn that failed to be delivered again, now.
   *
   * The failure stopped the line (see `drainQueue`), so this both clears the
   * mark and restarts it. Unknown ids are a no-op rather than an error: the
   * click races the queue's own broadcast, and losing that race costs nothing.
   */
  retryQueued(id: string): boolean {
    const turn = this.queue.find((entry) => entry.id === id);
    if (!turn || !turn.error) return false;
    delete turn.error;
    // To the head, because it was already at the head when it failed and the
    // ones behind it were typed expecting it to have gone first.
    this.queue = [turn, ...this.queue.filter((entry) => entry.id !== id)];
    this.publishQueue();
    this.drainQueue();
    return true;
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

    // A turn that could not be delivered holds the line rather than being
    // skipped past. Everything behind it was typed on the assumption that it
    // had been asked, and asking those against an agent that never saw it is a
    // worse outcome than a queue that visibly stopped and said why (#89). The
    // user's two ways out — retry and remove — are both on the row itself.
    if (this.queue[0].error) return;

    // Before anything is shifted off the line and before a word of it reaches
    // the transcript: the one-shot adapters call a turn over from a line of
    // stdout while the process that ran it is still exiting, and `send` in that
    // window throws. It used to throw *after* `deliver` had already written the
    // user's message into the conversation and moved the state to `thinking`,
    // so the message sat there unanswered forever with the rest of the queue
    // stuck behind it. Asking first costs a tick or two of waiting (#89).
    if (!this.adapterReady) {
      this.waitForReady();
      return;
    }
    this.stopWaitingForReady();

    this.draining = true;
    const next = this.queue.shift()!;
    this.publishQueue();

    // `deliver` moves the state to `thinking` before it awaits anything, so by
    // the time this promise is pending the guard above already holds on its own.
    this.deliver({ text: next.text, attachments: next.attachments })
      .catch((error: unknown) => {
        // Silent when a clear is under way: the turn failed because the
        // process it was for is being replaced, which is what the user asked
        // for. See `restarting`.
        if (this.restarting) return;
        const message = error instanceof Error ? error.message : String(error);
        this.failQueuedTurn(next, message);
      })
      .finally(() => {
        this.draining = false;
        // One more look, because a delivery does not always leave an event
        // behind to trigger the next one. `/clear` is the case: it replaces the
        // process instead of running a turn, and every event that replacement
        // emits arrives while this drain still holds the guard — so whatever
        // was queued behind the clear waited on an event that had already been
        // and gone. Cheap and terminal: a session that is busy or a line that
        // is empty returns immediately, and each pass takes one turn off.
        this.drainQueue();
      });
  }

  /**
   * Poll until the adapter can take a turn, then drain.
   *
   * A poll rather than a fixed settling delay because the wait is a process
   * exiting, not a duration: any delay long enough to be safe would be long
   * enough to feel like throttling, and any delay short enough to feel instant
   * would still be a guess. In the measured case this fires once or twice.
   */
  private waitForReady(): void {
    if (this.drainRetry) return;
    if (this.readySince === null) this.readySince = Date.now();

    if (Date.now() - this.readySince >= QUEUE_READY_TIMEOUT_MS) {
      const head = this.queue[0];
      this.readySince = null;
      if (head) {
        this.failQueuedTurn(
          head,
          `the ${this.runtime || 'agent'} process was still busy ${Math.round(QUEUE_READY_TIMEOUT_MS / 1000)}s after the last turn ended`,
          { putBack: false },
        );
      }
      return;
    }

    this.drainRetry = setTimeout(() => {
      this.drainRetry = null;
      this.drainQueue();
    }, QUEUE_READY_POLL_MS);
    // Nothing here should hold the process open: a session waiting on a child
    // that will never come back must not be the reason the server cannot exit.
    this.drainRetry.unref?.();
  }

  private stopWaitingForReady(): void {
    if (this.drainRetry) {
      clearTimeout(this.drainRetry);
      this.drainRetry = null;
    }
    this.readySince = null;
  }

  /**
   * Put a turn that could not be delivered back, with the reason on it.
   *
   * Kept rather than dropped, and kept *with its text*, so it is recoverable
   * without retyping — the queue exists to be trusted while nobody is
   * watching, and a queue that discards work silently is worse than none.
   *
   * `putBack` is false when the turn never left the line in the first place.
   */
  private failQueuedTurn(turn: QueuedTurn, reason: string, { putBack = true } = {}): void {
    const marked: QueuedTurn = { ...turn, error: reason, attempts: (turn.attempts ?? 0) + 1 };
    if (putBack) {
      this.queue = [marked, ...this.queue];
    } else {
      this.queue = this.queue.map((entry) => (entry.id === turn.id ? marked : entry));
    }
    this.publishQueue();
    this.ingest({ t: 'error', message: `could not send a queued message: ${reason}` });
    // Only the delivery failed, so a session left saying "working" would be
    // claiming a turn that never started — and would never drain again, since
    // a drain needs an idle session.
    if (this.state === 'thinking' || this.state === 'running') {
      this.setState('idle');
    }
  }

  private publishQueue(): void {
    this.deps.broadcast(this.ref.id, {
      type: 'chat_queue',
      sessionId: this.ref.id,
      queued: this.queuedTurns,
    });
  }

  /**
   * Hand one turn to the runtime, recording the user's own message first.
   *
   * @param continuesTurnId The turn this message is being delivered *into*, when
   *   it is a steer — see `sendQueuedNow`. Sharing that turn's id is what makes
   *   the transcript group the two together and the accounting file them as one
   *   turn, which is the definition #86 settled: steering the current work is
   *   part of that work, not a new request. What made that come apart was not
   *   the id but the runtime's acknowledgement of the interrupt arriving as a
   *   `turn_end` — see `staleTurnEndUntil`, which is what keeps the turn open
   *   across it.
   */
  private async deliver(turn: UserTurn, continuesTurnId?: string): Promise<void> {
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
    const turnId = continuesTurnId ?? `turn-${crypto.randomUUID()}`;
    this.turnInFlightId = turnId;
    this.ingest({
      t: 'msg_start',
      id: messageId,
      role: 'user',
      turnId,
      ...(continuesTurnId ? { steer: true as const } : {}),
    });
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

    // A branched conversation opens with the history it was cut from, and this
    // is the only place it can reach the agent: it rides *with* the first thing
    // the user says rather than as a turn of its own, so the transcript above
    // holds the user's own words and nothing else. What the runtime receives and
    // what the record shows are deliberately different here, and that difference
    // is the whole point — see chat/branch.ts.
    //
    // Read after the state has moved, never before: `retryQueued` relies on
    // `deliver` reaching `thinking` before it awaits anything, and a disk read
    // in front of that would open a window where a second turn saw an idle
    // session and overtook this one.
    //
    // Never in front of a command. Everything except `/clear` and `/new`
    // reaches the runtime as ordinary turn text, so a briefing glued to
    // `/review` is not a command any more — it runs as prose, and the history
    // is spent on a turn that was never going to read it. It waits for
    // something the model is actually being asked.
    const carried = isSlashCommand(turn.text) ? null : await this.openingContext();
    await this.adapter.send(carried ? { ...turn, text: `${carried}\n\n${turn.text}` } : turn);

    // Only once it has actually gone. A delivery that threw is put back in the
    // line and tried again, and the retry has to carry what this attempt never
    // handed over. Awaited rather than left to finish on its own: the send has
    // already succeeded, so the cost is nothing, and a process that exits in
    // that gap would come back and hand a whole conversation's history to some
    // later, unrelated turn.
    if (carried) {
      this.carried = null;
      await this.deps.store.clearOpeningContext?.(this.ref);
    }
  }

  /** The branch history still waiting to be handed over, or null. */
  private async openingContext(): Promise<string | null> {
    if (this.carried !== undefined) return this.carried;
    this.carried = (await this.deps.store.openingContext?.(this.ref)) ?? null;
    return this.carried;
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
    this.restarting = true;
    // Before the old process is signalled, not after: whatever it emits from
    // here on belongs to a conversation that is over. See `adapterGeneration`.
    this.adapterGeneration++;
    // The line is *not* carried across, and that is the whole difference #69
    // made: a clear is taken the moment it is typed rather than waiting its
    // turn, so whatever is queued here was typed for the process being
    // replaced and belongs to the conversation the user just left (#69).
    // Anything typed *after* the clear still arrives — `restarting` parks it
    // and the fresh process is handed it as soon as it reports idle — which is
    // the case #89 exists to protect.
    try {
      await this.stop();
      // Stale until the new process's own `init` event reports its id — cleared
      // up front so nothing reads the old conversation's id in the meantime.
      // The record hears it too, but from inside `start`, once the log this
      // one lived in has actually been dropped (#43).
      this.nativeSessionId = null;
      await this.start({ ...options, resumeSessionId: undefined, startFresh: true });
    } catch (error: unknown) {
      // Nothing replaced the conversation that was stopped. `start()` has
      // already written the failure into the transcript and moved the state to
      // `error`; the record has to hear it too, or the tab goes on claiming a
      // process that never started and refuses the relaunch that would fix it.
      this.deps.onLifecycle?.(this.ref.id, { exited: true });
      throw error;
    } finally {
      this.restarting = false;
    }

    // The record outlives every process this session runs, and `stop()` above
    // told it one had gone. Saying so again in the other direction is what
    // keeps the tab a running tab: without it the session lists report a
    // conversation that is answering as finished, and the next launch in this
    // tab is refused because a process it no longer has is still claimed.
    this.deps.onLifecycle?.(this.ref.id, { exited: false });
  }

  async interrupt(): Promise<void> {
    if (!this.adapter) return;
    // Before the state moves: going idle is what releases the queue, and a
    // stop that then fired the three messages waiting behind it would be the
    // opposite of what the button says. Someone who wants them can send them.
    const dropped = this.clearQueue();
    await this.cancelTurnInFlight();
    if (dropped) {
      this.ingest({
        t: 'error',
        message: `Stopped. ${dropped} queued message${dropped === 1 ? ' was' : 's were'} discarded.`,
      });
    }
  }

  /**
   * End the turn in flight, leaving the queue alone.
   *
   * Everything `interrupt` does *except* discarding what was typed ahead —
   * which is the whole difference between the stop button and promoting one
   * waiting message. Kept as one method rather than duplicated, because the
   * part that matters here is not the adapter call: it is that a cancelled
   * turn must not leave a permission card or a question on screen waiting for
   * an answer that can no longer reach anything.
   */
  private async cancelTurnInFlight(): Promise<void> {
    if (!this.adapter) return;
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

  /**
   * Switch the live process to a different reasoning-effort level.
   *
   * Unlike the model, most runtimes can do this: claude answers its own
   * `/effort` command for free, kimi and omp expose it as an ACP config option,
   * grok carries it on a model change, and codex and pi apply it to the next
   * turn they start. What they have in common is that the adapter only resolves
   * once its runtime has taken the level — so `true` here means the session is
   * genuinely running at it, and anything else falls through to the caller's
   * saved-for-next-launch answer rather than claiming a change nobody made.
   */
  async setEffort(effort: string): Promise<boolean> {
    if (!this.adapter?.alive || !this.adapter.setEffort) return false;
    await this.adapter.setEffort(effort);
    return true;
  }

  /**
   * Record the effort level an in-place restart must launch with.
   *
   * The same trap `rememberModel` exists for, and a worse one here: an effort
   * change is confirmed by the runtime and shown as live, so a `/clear` that
   * replayed the launch options verbatim would put the conversation back on the
   * level it opened with while the control went on reporting the level the user
   * chose — a disagreement nothing on screen would explain.
   */
  rememberEffort(effort: string | undefined): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, effort };
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
      // `answeredQuestions` is deliberately NOT overridden here. This map holds
      // only the questions still waiting; what was picked for the ones already
      // answered is in the log, and the store's replay of it is the authority
      // (#113). Overlaying anything from here would narrow it to this process's
      // lifetime, which is exactly the conversation this has to survive.
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

/**
 * The promoted message, short enough to sit on a rule drawn across the column.
 *
 * Enough of it to recognise which message this was, which is what the marker is
 * for — the message itself is directly below, so this is a label, not a copy.
 * Whitespace is collapsed because a queued turn can be many lines, and a line
 * break in a one-line marker breaks the line.
 */
function quoteTurn(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'an attachment';
  return flat.length > 60 ? `“${flat.slice(0, 57)}…”` : `“${flat}”`;
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
