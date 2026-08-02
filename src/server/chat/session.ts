import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AccountLimits,
  ChatAttachment,
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatState,
  ChatUsage,
  MAX_QUEUED_TURNS,
  PermissionOption,
  PermissionRequest,
  PlanDocument,
  QueuedTurn,
  QuestionOption,
  QuestionRequest,
  SlashCommand,
  UserTurn,
  carriesCost,
  carriesTokens,
  classifyTool,
  defaultPermissionOptions,
  isAllowOption,
  isAskQuestionTool,
  looksLikeAskCall,
  askedQuestionFrom,
  normalizeQuestionOptions,
  ASK_MCP_SERVER,
  ASK_QUESTION_TOOL,
  ASK_QUESTION_TOOL_NAME,
  MAX_PLAN_TEXT,
  SUBMIT_PLAN_TOOL_NAME,
  TIER_TOOL_NAME,
  QUESTION_FALLBACK_CLOSE,
  QUESTION_FALLBACK_OPEN,
  acceptedPlanDirective,
  planModeDirective,
} from '../../shared/chat-events.js';
import {
  LadderRung,
  ModelTier,
  nextRungUp,
} from '../../shared/runtime-profiles.js';
import { isClearingCommand, isSlashCommand, mergeSlashCommands } from '../../shared/slash-commands.js';
import { installedModels } from './installed-models.js';
import { discoverInstalledCommands, enumeratesInstalledCommands } from './installed-commands.js';
import { AdapterEvent, ChatAdapter, ChatAdapterOptions } from './adapter.js';
import {
  PermissionAsk,
  PermissionAnswer,
  PermissionBroker,
  PlanAsk,
  QuestionAsk,
  QuestionReply,
  TierAsk,
  TierReply,
  permissionHookSettings,
} from './permission-broker.js';
import { ASK_SOCKET_ENV, TIER_ENABLED_ENV, askMcpConfig } from './ask-mcp.js';
import { writePiAskExtension } from './pi-ask-extension.js';
import { FileCallbackBroker, FileCallbackEndpoint } from './file-callback.js';
import {
  FILE_CALLBACK_DIR_ENV,
  FILE_CALLBACK_TOKEN_ENV,
  fileMcpConfig,
  writeFileMcpBridge,
} from './file-mcp-bridge.js';
import { UserEnvironment } from '../services/environments/types.js';
import { ChatStoreLike, ChatSessionRef } from './store.js';
import { askChannelFor, askEnvFor, createChatAdapter, supportsChat } from './registry.js';
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
  /**
   * The same lookup, stopping at the plain name.
   *
   * Optional so a caller that has not been updated still works: without it the
   * resolved host path is used, which is correct on the host and only wrong
   * for a runtime running somewhere else.
   */
  resolveCommandName?: (runtime: string) => string;
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
   * `restarting` distinguishes that clear's old adapter exit from a natural
   * exit. Project runtime admission must span the replacement launch rather
   * than opening a stop/reclaim race between the two processes.
   */
  onLifecycle?: (
    sessionId: string,
    change: {
      nativeSessionId?: string | null;
      exited?: boolean;
      bypassing?: boolean;
      planMode?: boolean;
      restarting?: boolean;
    },
  ) => void;
  /**
   * The approval mode a conversation started from inside this one should run in.
   *
   * `/clear` and the composer's New chat button end a conversation and begin
   * another, and a conversation that is beginning takes the owner's preference
   * — the same rule the launcher goes through. Asked here rather than replayed
   * out of the previous launch's options, which is what used to carry one
   * conversation's bypass into every later one in the same tab (#134).
   *
   * Optional: absent means nothing could be asked, and the restart asks for
   * approvals, in line with every other unreadable answer in this rule.
   */
  resolveBypass?: () => boolean;
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
  /** Whether workingDir is already an absolute path inside the container. */
  cwdKind?: 'host' | 'container';
  /** Lease-bound filesystem callbacks for an isolated project runtime. */
  fileAccess?: {
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, contents: string): Promise<void>;
  };
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
  /**
   * Where this conversation's runtime runs. Absent means the host, which is
   * what every caller passed before per-user environments existed.
   */
  environment?: UserEnvironment;
  /**
   * Last-moment launch admission check. Called synchronously immediately
   * before the adapter can spawn, closing a DELETE-vs-start race across the
   * store, broker and command-discovery awaits above it.
   */
  cancelled?: () => boolean;
  /**
   * The capability ladder this conversation is running on, when it is running
   * on one.
   *
   * `tier` is the rung it opened at and returns to; `tiers` is the whole ladder,
   * because escalation has to be able to find what is above the current rung
   * and the profile is server-side configuration the session cannot re-read.
   */
  ladder?: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> };
  /** Durable conversation-level Plan mode. */
  planMode?: boolean;
}

export interface PlanModeResult {
  planMode: boolean;
  changed: boolean;
  detail: string;
}

export interface PlanSubmissionResult {
  accepted: boolean;
  revision?: number;
  detail: string;
}

export interface PlanActionResult {
  accepted: boolean;
  action: 'accept' | 'reject';
  planMode: boolean;
  revision?: number;
  detail: string;
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
 * looking at a session whose runtime it could not name. `plan` and `limits`
 * replace rather than append, so re-reporting either costs nothing — and a
 * resumed runtime restating its rate-limit window is a fresh reading of it,
 * which is the one thing that turns a level into a rate.
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
 * Tool statuses that mean the call is over and nothing will be handed back to
 * it.
 *
 * Read only against calls that asked a question, and only to close the card
 * that belongs to one. `completed` is deliberately absent — an ask call
 * completes precisely when somebody answered it, and that resolution has
 * already happened by the time the status lands. `unknown` is here because the
 * reducer writes it onto calls the runtime stopped talking about, which is the
 * same fate arriving by a quieter route.
 */
const DEAD_TOOL_STATUS: ReadonlySet<string> = new Set([
  'failed',
  'denied',
  'canceled',
  'unknown',
]);

/**
 * Turn endings that are the turn being cut short rather than finishing.
 *
 * Only used by `noteSpend`, and only to *decline* to conclude anything. A
 * runtime that was stopped mid-sentence, or that fell over, or that was killed
 * with the process, never reached the point where it reports what the turn
 * spent — Claude prices a turn in its final `result`, an ACP agent in the reply
 * to `session/prompt` — so the absence of a figure says nothing about whether
 * the runtime reports figures. Recording "reports nothing" from one of these
 * would put a permanent, wrong statement about the *runtime* on the log of a
 * conversation the *user* interrupted.
 *
 * Matched on the runtime's own word, lower-cased with separators removed
 * because the vocabulary is not shared: the adapters here emit `error`,
 * `exited`, `failed` and `interrupted` of their own accord, ACP adds
 * `cancelled` and `refusal`, and Claude's subtypes arrive as `error_max_turns`
 * and `error_during_execution` — hence the prefix test rather than a lookup for
 * those. Anything unrecognised is taken as a normal ending, which is the only
 * choice that keeps the feature working for a runtime nobody here has met:
 * `end_turn`, `EndTurn`, `completed`, `success`, `max_tokens` and no stop
 * reason at all are all ordinary endings, and no list could hold them all.
 */
const CUT_SHORT_TURN: ReadonlySet<string> = new Set([
  'aborted',
  'cancel',
  'canceled',
  'cancelled',
  'exited',
  'failed',
  'interrupted',
  'killed',
  'refusal',
  'refused',
  'timedout',
  'timeout',
]);

/** Whether a `turn_end`'s stop reason means the turn never got to finish. */
function wasCutShort(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  const word = stopReason.toLowerCase().replace(/[_\-\s]/g, '');
  return word.startsWith('error') || CUT_SHORT_TURN.has(word);
}

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

/**
 * The approval mode of a conversation, in one phrase, for the line drawn at the
 * top of it.
 *
 * A runtime with no approval channel is named rather than glossed over. pi's
 * chat adapter publishes `permissions: false` — no approval channel exists in
 * its CLI — so its tools run unattended whichever mode the rule computed, and
 * printing "you are asked before each tool call" over one of its conversations
 * would be this app claiming a boundary that is not there.
 */
function approvalNoticeDetail(bypassing: boolean, canAsk: boolean): string {
  if (bypassing) return 'bypassed — tools run without asking';
  if (!canAsk) return 'this runtime cannot ask — tools run without asking';
  return 'on — you are asked before each tool call';
}

/** Thrown by `send` when the line is already as long as it may get. */
export class QueueFullError extends Error {
  constructor() {
    super(`there are already ${MAX_QUEUED_TURNS} messages waiting; let some run first`);
    this.name = 'QueueFullError';
  }
}

// These change only the live conversation's configuration. Every other
// runtime command is opaque to this server and may execute a skill or mutate
// the workspace, so it is refused while Plan mode's no-implementation promise
// is in force. /clear, /new and /reset are handled as lifecycle commands before
// this check and start a genuinely fresh conversation.
const PLAN_SAFE_SLASH_COMMANDS = new Set(['/model', '/effort']);

function questionToolDirective(): string {
  return [
    '[Interactive questions are available in this Web conversation in both Default and Plan mode.]',
    `When the next step needs a user decision, call the ${ASK_QUESTION_TOOL} tool and wait for the answer instead of guessing or asking in prose.`,
    'Use an ordinary response when no user decision is needed.',
  ].join(' ');
}

function questionFallbackDirective(): string {
  return [
    '[Interactive-question fallback for this Web conversation.]',
    'If you need a user decision and the ask_user_question tool is unavailable, stop instead of guessing.',
    `Return exactly ${QUESTION_FALLBACK_OPEN}{"question":"...","header":"2-4 words","multiSelect":false,"options":[{"label":"...","description":"..."}]}${QUESTION_FALLBACK_CLOSE}.`,
    'The Web interface will show the choices and send the answer in a continuation. Use ordinary prose when no decision is needed.',
  ].join(' ');
}

function responseQuestionEnvelope(
  markdown: string,
): { question: QuestionAsk; start: number; end: number } | null {
  const start = markdown.lastIndexOf(QUESTION_FALLBACK_OPEN);
  if (start < 0) return null;
  const from = start + QUESTION_FALLBACK_OPEN.length;
  const end = markdown.indexOf(QUESTION_FALLBACK_CLOSE, from);
  if (end < 0) return null;
  try {
    const value = JSON.parse(markdown.slice(from, end).trim());
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { question: value as QuestionAsk, start, end: end + QUESTION_FALLBACK_CLOSE.length }
      : null;
  } catch {
    return null;
  }
}

function responseQuestion(markdown: string): QuestionAsk | null {
  return responseQuestionEnvelope(markdown)?.question ?? null;
}

function questionContinuation(question: string, answer: QuestionReply): string {
  if (answer.error) {
    return `[The interactive question could not be delivered: ${answer.error}. Ask the user in plain prose.]`;
  }
  if (answer.skipped || (answer.labels.length === 0 && !answer.text)) {
    return `[The user skipped this question without answering: ${question}. Continue with the most reasonable option and state the assumption.]`;
  }
  const selected = answer.labels.length > 0 ? `Selected: ${answer.labels.join(', ')}.` : '';
  const typed = answer.text ? `Their own words: ${answer.text}` : '';
  return `[The user answered the interactive question "${question}". ${selected} ${typed}]`.trim();
}

/**
 * Answers used to settle a question because its turn went away are terminal,
 * not content for a new continuation turn.
 *
 * Kept deliberately narrower than "any error": a delivery failure while the
 * runtime is still alive must still send the prose fallback below, otherwise
 * the agent remains blocked with no way to ask again. These are the three
 * reasons minted by this session when nobody can answer any more.
 */
function cancelledFallbackAnswer(answer: QuestionReply): boolean {
  if (!answer.error) return false;
  return answer.error === 'the turn was interrupted'
    || answer.error === 'the session was stopped'
    || answer.error === 'the agent stopped waiting for an answer';
}

export class ChatSession {
  private adapter: ChatAdapter | null = null;
  private broker: PermissionBroker | null = null;
  private fileBroker: FileCallbackBroker | null = null;
  private seq = 0;
  private state: ChatState = 'starting';
  private capabilities: ChatCapabilities | null = null;
  /** The last account reading the runtime published. See the `limits` overlay in `snapshot()`. */
  private limits: AccountLimits | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  /**
   * The rung this conversation runs on, and the whole ladder behind it.
   *
   * Null for a conversation that is not on a ladder at all, which is what makes
   * the escalation tool absent rather than present-and-always-refusing.
   */
  private ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null = null;
  /**
   * The rung this conversation has been lifted to for the turn in progress.
   *
   * Set the moment an escalation is granted and cleared when the turn ends —
   * which is the observable reading of "once the task that prompted the move is
   * finished". A task that spans turns asks again, and that is deliberate: the
   * approval is the only control on what this spends, and a grant that outlived
   * the work it was granted for would quietly become the conversation's model.
   */
  private escalation: {
    from: ModelTier;
    to: ModelTier;
    model: string;
    /**
     * True while the grant has been made but the turn it applies to has not
     * started — either because the runtime cannot change model mid-turn (pi
     * runs one process per turn) or because the user answered after the turn
     * that asked had already ended.
     *
     * Without it the very next `turn_end` — the one closing the turn the grant
     * was *not* for — cancelled the escalation before the promised turn began,
     * so the model was told it had moved up and then answered from the rung it
     * started on.
     */
    startsNextTurn: boolean;
  } | null = null;
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
  /** Structured final-response fallback for runtimes with no injectable tool channel. */
  private questionFallbackEnabled = false;
  /** Plan mode is available even when a runtime falls back to its final markdown response. */
  private planEnabled = false;
  private planMode = false;
  /** Undefined means the sidecar has not been read for this process yet. */
  private planDocumentCache: PlanDocument | null | undefined;
  /** Serialises tool and response-fallback submissions into numbered revisions. */
  private planMutation: Promise<void> = Promise.resolve();
  /** Invalidates a submission that was started by a conversation since cleared. */
  private planGeneration = 0;
  /** Keeps queued user turns behind response-fallback handling for the turn that just ended. */
  private fallbackResponses = 0;
  /** Text blocks in assistant messages emitted during the current planning turn. */
  private readonly planResponseBlocks = new Map<string, Map<number, string>>();
  /**
   * Prefix-buffered fallback text. Holding only a possible `<ccweb-question>`
   * prefix keeps ordinary replies streaming while preventing protocol JSON
   * from ever becoming transcript content when the envelope is recognised.
   */
  private readonly fallbackTextBlocks = new Map<string, {
    msgId: string;
    index: number;
    text: string;
    events: AdapterEvent[];
  }>();
  private flushingFallbackText = false;
  private planResponseCandidate = '';
  private planSubmittedThisTurn = false;
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
   * Whether this conversation has ever been told what it spent.
   *
   * The four booleans behind the "not reported" the header shows for a runtime
   * that reports nothing. `spoke*` is the observation — any report carrying a
   * token count or a price, on any channel. `stated*` is the answer already
   * being on the log, so it is said once rather than on the end of every turn.
   *
   * Kept here rather than worked out in the browser because the transcript
   * cannot tell an agent that will never speak from one that has not spoken
   * yet, and the difference is only knowable from having watched a turn finish.
   * See `noteSpend`.
   */
  private spokeTokens = false;
  private spokeCost = false;
  private statedTokenSilence = false;
  private statedCostSilence = false;
  /**
   * Whether the runtime has done anything at all in the turn now open.
   *
   * A `/clear` opens and closes a turn before it is recognised as a command,
   * and an empty turn is not evidence about what a runtime reports — filing one
   * as "reports nothing" would put the label on a conversation whose agent had
   * not yet been asked for anything.
   */
  private turnDidWork = false;

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
   * The user message this session wrote for the turn in flight, by id.
   *
   * Held so a second one, minted by the adapter, can be recognised for what it
   * is — see `isForeignUserEcho`.
   */
  private ownUserMessageId: string | null = null;
  /**
   * Message ids an adapter tried to file a user turn under, which this session
   * dropped. Their blocks and their end have to go the same way, or the
   * transcript keeps orphan events pointing at a message that was never opened.
   */
  private readonly droppedUserEchoes = new Set<string>();
  /**
   * Until when a `turn_end` is the runtime letting go of interrupted work
   * rather than the turn ending. Null when nothing has been interrupted.
   */
  private staleTurnEndUntil: number | null = null;
  /**
   * Until when an `error` is the runtime's account of work this session told it
   * to drop, rather than something that went wrong. Null when nothing has been
   * interrupted.
   *
   * Claude reports an interrupted run as `is_error` with the subtype
   * `error_during_execution`, so stopping a turn — or correcting it by sending
   * ahead of it — put a red card reading "claude ended the turn as
   * error_during_execution" in the conversation, with a Retry button offering
   * to run again the thing the user had just stopped. Nothing failed: the run
   * ended because it was told to. The record of that is the `interrupted`
   * marker and the turn's own stop reason, both of which say it in the user's
   * terms.
   *
   * A sibling of `staleTurnEndUntil` and set at the same moment, but a
   * separate field because the two answer different questions — whether the
   * turn is over, and whether anything went wrong — and an interrupt from the
   * stop button ends the turn while still owing no explanation.
   */
  private interruptedErrorUntil: number | null = null;
  /** Runs the drain again once the adapter has finished letting go of the last turn. */
  private drainRetry: ReturnType<typeof setTimeout> | null = null;
  /** When the current wait for a ready adapter began; null when not waiting. */
  private readySince: number | null = null;

  /**
   * Which process the events arriving here belong to.
   *
   * `stop()` signals the child and waits for verified closure, but a replaced
   * adapter can still emit while that asynchronous teardown is in progress
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
   * An adapter may report `state: exited` while its `start()` promise is still
   * deciding whether startup succeeded. Publishing that as a completed
   * lifecycle transition immediately is unsafe: a rejected ladder probe is
   * followed by another adapter in the same session, and its exit would release
   * the project admission the fallback is about to reuse.
   *
   * The event still updates this session's observable state immediately. Only
   * the record/lease notification is deferred until `start()` resolves. If
   * startup rejects, the generation is invalidated before the failed adapter is
   * stopped, so neither that event nor a delayed process-close event can be
   * mistaken for the lifecycle of its replacement.
   */
  private adapterStarting = false;
  private adapterExitedWhileStarting = false;

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

  /**
   * Whether this session still owns an adapter, including one whose local
   * engine client exited but whose container process could not be verified
   * stopped. Manager teardown uses this stronger fact than `live` so a failed
   * stop never drops the only handle capable of retrying it.
   */
  get ownsAdapter(): boolean {
    return this.adapter !== null;
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

    this.lastStartOptions = options.startFresh ? { ...options, planMode: false } : options;
    this.runtime = options.runtime;
    this.cwd = options.workingDir;
    this.bypass = Boolean(options.bypassPermissions);
    this.planMode = options.startFresh ? false : options.planMode === true;
    this.planEnabled = true;
    this.questionsEnabled = false;
    this.questionFallbackEnabled = false;
    this.planDocumentCache = undefined;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';
    this.planSubmittedThisTurn = false;
    if (options.startFresh) {
      // Close the old generation before waiting for its last save. A callback
      // that resumes after this point sees the mismatch and cannot recreate a
      // document belonging to the conversation being cleared.
      this.planGeneration += 1;
      await this.planMutation.catch(() => undefined);
      this.turnInFlightId = null;
      this.ownUserMessageId = null;
      this.droppedUserEchoes.clear();
    }
    this.startedAt = Date.now();
    this.replaying = Boolean(options.resumeSessionId);
    if (options.resumeSessionId) this.nativeSessionId = options.resumeSessionId;
    // Restarting into an existing conversation: seq continues from the log so
    // a resumed session does not renumber events a browser already holds.
    const stats = await this.deps.store.stat(this.ref);
    if (options.startFresh && stats.cursor === 0) {
      // There is no truncation boundary for an empty log, but a sidecar can
      // still exist (for example after a crash between its write and the next
      // transcript event). Fresh always means both mode and document are gone.
      await this.deps.store.clearPlanDocument?.(this.ref);
      this.planDocumentCache = null;
    }
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
    // The MCP server has to exist on disk before it can be handed to anybody.
    // pi's channel is exempt because there is nothing to hand over: its tool is
    // a generated extension that carries its own client to the socket.
    const wantsAsk = askChannel === 'extension'
      ? true
      : Boolean(askChannel) && Boolean(askScript) && fs.existsSync(askScript!);
    let askMcpServer: ChatAdapterOptions['askMcpServer'];

    // The rung, recorded before anything can be escalated from it. Held on the
    // session rather than read from the profile on demand, because the profile
    // is server-wide configuration that can change under a running conversation
    // and this is a fact about the process that is about to start.
    this.ladder = options.ladder ?? null;
    this.escalation = null;
    // pi is the runtime with a ladder and no MCP support at all, so its
    // escalation tool arrives as a generated extension instead (see the tier
    // writer). It still dials this socket, so the socket still has to be open.
    const wantsTierExtension = Boolean(this.ladder) && options.runtime === 'pi';

    const environment = options.environment;
    const asSeenByRuntime = (hostPath: string): string => (
      environment ? environment.toContainerPath(hostPath) : hostPath
    );
    const nodePath = environment ? environment.nodePath : process.execPath;
    const useFileTools = wantsAsk && environment?.kind === 'container';
    let fileEndpoint: FileCallbackEndpoint | null = null;
    let fileBridge = '';

    if (useFileTools) {
      try {
        this.fileBroker = new FileCallbackBroker(environment.homeDir);
        fileEndpoint = await this.fileBroker.listen(async (request, signal) => {
          if (request.kind === 'question') {
            return this.askQuestion((request.payload || {}) as QuestionAsk, signal);
          }
          if (request.kind === 'plan') {
            const plan = (request.payload || {}) as PlanAsk;
            return this.submitPlan({ markdown: plan.markdown, source: 'tool' });
          }
          if (request.kind === 'tier') {
            return this.requestTier((request.payload || {}) as TierAsk);
          }
          throw new Error(`unsupported callback kind ${request.kind}`);
        });
        fileBridge = await writeFileMcpBridge(fileEndpoint.directory);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not create the shared-home tool channel: ${detail}`);
        await this.fileBroker?.close().catch(() => undefined);
        this.fileBroker = null;
        fileEndpoint = null;
        fileBridge = '';
      }
    }

    const wantsSocketTools = !useFileTools && (wantsAsk || wantsTierExtension);
    let runtimeSocketPath = '';
    if (wantsHook || wantsSocketTools) {
      // One shared directory, not one per session. A directory named after the
      // session id cost 37 bytes of a 103-byte path budget, which is what put
      // the socket over the kernel's limit; the random socket filename already
      // carries the unguessability that directory was standing in for.
      this.broker = new PermissionBroker(this.deps.socketDir);
      const socketPath = await this.broker.listen({
        permission: (ask) => this.askUser(ask),
        question: (ask, signal) => this.askQuestion(ask, signal),
        tier: (ask) => this.requestTier(ask),
        plan: (ask: PlanAsk) => this.submitPlan({ markdown: ask.markdown, source: 'tool' }),
      });
      runtimeSocketPath = asSeenByRuntime(socketPath);
    }

    if (wantsHook && runtimeSocketPath) {
      extraArgs.push('--settings', permissionHookSettings(
        asSeenByRuntime(this.deps.hookScript),
        runtimeSocketPath,
        nodePath,
      ));
      env.CCWEB_PERMISSION_SOCKET = runtimeSocketPath;
    }

    const laddered = Boolean(this.ladder);
    const runtimeFileDirectory = fileEndpoint ? asSeenByRuntime(fileEndpoint.directory) : '';
    const runtimeFileBridge = fileBridge ? asSeenByRuntime(fileBridge) : '';
    if (fileEndpoint) {
      env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
      env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
    }
    if (wantsTierExtension) {
      if (fileEndpoint) {
        env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
        env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
      } else if (runtimeSocketPath) {
        env[ASK_SOCKET_ENV] = runtimeSocketPath;
      }
      env[TIER_ENABLED_ENV] = '1';
    }

    if (wantsAsk) Object.assign(env, askEnvFor(options.runtime));
    if (wantsAsk && askChannel === 'cli' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const config = fileEndpoint
        ? fileMcpConfig(runtimeFileBridge, runtimeFileDirectory, fileEndpoint.token, nodePath, laddered)
        : askMcpConfig(asSeenByRuntime(askScript!), runtimeSocketPath, nodePath, laddered);
      extraArgs.push('--mcp-config', config);
      extraArgs.push('--allowedTools', ASK_QUESTION_TOOL_NAME);
      extraArgs.push('--allowedTools', SUBMIT_PLAN_TOOL_NAME);
      if (laddered) extraArgs.push('--allowedTools', TIER_TOOL_NAME);
      this.questionsEnabled = true;
    }
    if (wantsAsk && askChannel === 'config' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const script = fileEndpoint ? runtimeFileBridge : asSeenByRuntime(askScript!);
      if (!fileEndpoint) env[ASK_SOCKET_ENV] = runtimeSocketPath;
      if (laddered) env[TIER_ENABLED_ENV] = '1';
      // Codex app-server accepts the same dotted TOML overrides as `codex -c`.
      // They live on this one spawned process and never touch ~/.codex/config.toml.
      extraArgs.push(
        '-c',
        `mcp_servers.${ASK_MCP_SERVER}.command=${JSON.stringify(nodePath)}`,
        '-c',
        `mcp_servers.${ASK_MCP_SERVER}.args=${JSON.stringify([script])}`,
      );
      this.questionsEnabled = true;
    }
    if (wantsAsk && askChannel === 'extension' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const extensionRoot = fileEndpoint ? fileEndpoint.directory : options.workingDir;
      const written = writePiAskExtension(extensionRoot);
      if (written) {
        const extensionPath = fileEndpoint
          ? asSeenByRuntime(path.join(extensionRoot, written))
          : written;
        if (fileEndpoint) {
          env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
          env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
        } else {
          env[ASK_SOCKET_ENV] = runtimeSocketPath;
        }
        extraArgs.push('-e', extensionPath);
        extraArgs.push('--exclude-tools', 'question');
        this.questionsEnabled = true;
      }
    }
    if (wantsAsk && askChannel === 'protocol' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      askMcpServer = fileEndpoint
        ? {
            name: ASK_MCP_SERVER,
            command: nodePath,
            args: [runtimeFileBridge],
            env: {
              [FILE_CALLBACK_DIR_ENV]: runtimeFileDirectory,
              [FILE_CALLBACK_TOKEN_ENV]: fileEndpoint.token,
              ...(laddered ? { [TIER_ENABLED_ENV]: '1' } : {}),
            },
          }
        : {
            name: ASK_MCP_SERVER,
            command: nodePath,
            args: [asSeenByRuntime(askScript!)],
            env: {
              [ASK_SOCKET_ENV]: runtimeSocketPath,
              ...(laddered ? { [TIER_ENABLED_ENV]: '1' } : {}),
            },
          };
      this.questionsEnabled = true;
    }
    // A few CLIs expose no session-scoped MCP/extension hook. They still get
    // the same durable QuestionCard flow through a structured final-response
    // handoff, and the continuation is sent only after the user answers.
    this.questionFallbackEnabled = !this.questionsEnabled;

    // What this session could run, read off disk before the runtime is even
    // spawned, so the command menu has something true in it from the moment the
    // conversation opens rather than after a first message has been sent.
    //
    // The home directory comes from the session's own environment where it has
    // one. That is the whole of the isolation this needs: a session lists what
    // is installed for the person it belongs to, and never what is installed
    // for anybody else on the machine.
    // In a container that home is the user's own: `homeDir` is the host path
    // their container's home is a bind mount of, which is precisely what the
    // ordinary `fs` reads in there can see. On the host it stays the account the
    // runtime actually runs as, because a host environment's `homeDir` is the
    // projects base folder and no runtime keeps its skills under that.
    const installed = discoverInstalledCommands(options.runtime, {
      home: options.environment?.kind === 'container'
        ? options.environment.homeDir
        : env.HOME || process.env.HOME,
      // A container-only path may coincidentally exist on the server (notably
      // `/tmp`) but is a different namespace. Never scan that host directory
      // for commands belonging to this project.
      workingDir: options.cwdKind === 'container'
        ? options.environment?.homeDir || ''
        : options.workingDir,
    });
    const installedCommands = installed.commands;

    // Claimed before the adapter exists, so its `emit` closure below can be
    // told apart from the one belonging to a process this replaces.
    const generation = ++this.adapterGeneration;

    const adapter = createChatAdapter(options.runtime, {
      sessionId: this.ref.id,
      workingDir: options.workingDir,
      cwdKind: options.cwdKind,
      installedCommands,
      // Kept out of `commands`: absolute paths are launch metadata for Codex,
      // not capabilities a browser or transcript should ever receive.
      installedSkills: installed.skills,
      command: this.deps.resolveCommand(options.runtime),
      commandName: this.deps.resolveCommandName?.(options.runtime),
      environment: options.environment,
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
        if (this.isInterruptedRunReport(event)) return;
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
      // that is being rewritten. A log cleanup failure remains non-fatal, but
      // the Plan sidecar is checked separately below: claiming a fresh Plan
      // document while an old one remains durable would make it reappear after
      // the next restart.
      try {
        await this.deps.store.truncateBefore(this.ref, this.seq);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not truncate the cleared conversation: ${message}`);
      }
      try {
        await this.deps.store.clearPlanDocument?.(this.ref);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.ingest({
          t: 'error',
          message: `A fresh conversation could not be started because its saved Plan could not be cleared: ${detail}`,
          fatal: true,
        });
        await this.stop();
        throw error;
      }
      // And the branch history goes with it, if this conversation had one
      // waiting. `/clear` promises an agent that has never seen any of it, and
      // handing over the very history just dropped from the transcript would be
      // that promise broken in the most confusing possible way.
      this.carried = null;
      void this.deps.store.clearOpeningContext?.(this.ref);
      this.planMode = false;
      this.planDocumentCache = null;
      this.lastStartOptions = { ...options, planMode: false };
      this.deps.onLifecycle?.(this.ref.id, { planMode: false });
      this.deps.broadcast(this.ref.id, {
        type: 'chat_plan_mode',
        sessionId: this.ref.id,
        planMode: false,
        changed: true,
        message: 'Plan mode was cleared with the previous conversation.',
      });
      this.deps.broadcast(this.ref.id, {
        type: 'chat_plan_document',
        sessionId: this.ref.id,
        plan: null,
      });

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

    // There is deliberately no await between this check and adapter.start():
    // every adapter reaches its spawn synchronously. A retiring/deleted record
    // therefore cannot materialise a child after its owner drained launch.
    if (options.cancelled?.()) {
      await this.stop();
      throw new Error('chat launch cancelled because the session is closing');
    }

    this.setState('starting');
    this.adapterStarting = true;
    this.adapterExitedWhileStarting = false;

    try {
      await adapter.start();
    } catch (error: unknown) {
      this.adapterStarting = false;
      this.adapterExitedWhileStarting = false;
      // Make every later event from this failed launch stale before verified
      // teardown begins; otherwise its eventual `exited` can release a
      // replacement's lease.
      this.adapterGeneration++;
      const message = error instanceof Error ? error.message : String(error);
      this.ingest({ t: 'error', message: `could not start ${options.runtime}: ${message}`, fatal: true });
      this.setState('error');
      await this.stop();
      throw error;
    }
    this.adapterStarting = false;
    if (this.adapterExitedWhileStarting) {
      this.adapterExitedWhileStarting = false;
      this.deps.onLifecycle?.(this.ref.id, {
        exited: true,
        restarting: this.restarting,
      });
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
    if ((this.questionsEnabled || this.questionFallbackEnabled) && this.capabilities) {
      this.capabilities = { ...this.capabilities, questions: true };
      this.ingest({ t: 'capabilities', capabilities: { questions: true } });
    }
    if (this.planEnabled && this.capabilities) {
      this.capabilities = { ...this.capabilities, planMode: true };
      this.ingest({ t: 'capabilities', capabilities: { planMode: true } });
    }

    // Which approval mode this conversation is running in, said in the
    // conversation itself.
    //
    // The mode is decided at the moment a conversation begins, out of a
    // preference that lives in Settings and may well have changed since the
    // last one — so a conversation that comes up bypassing, or that no longer
    // does, must not do it in silence (#134). Only when one is beginning: a
    // resume returns to a transcript that already carries the line from the day
    // it started, and repeating it on every relaunch would be noise.
    //
    // After the adapter has started, so the phrase can be honest about what
    // this runtime can actually enforce rather than about what was asked for.
    if (!options.resumeSessionId) {
      this.ingest({
        t: 'marker',
        kind: 'approvals',
        detail: approvalNoticeDetail(
          this.bypass,
          // Whether anything can actually stop a tool call in this session:
          // claude asks through the PreToolUse hook rather than through the
          // adapter protocol, so its `permissions` capability is false while it
          // asks perfectly well. Reading that flag alone would print "this
          // runtime cannot ask" over every claude conversation.
          wantsHook || this.capabilities?.permissions === true,
        ),
        // And the same fact structurally, because the phrase is for the reader
        // and this is for the pane. A conversation that begins from *inside*
        // itself — the composer's New chat, `/clear` — never touches the launch
        // path, so `chat_started` is not broadcast and this marker is the only
        // thing that reaches the browser with the mode the restart re-decided
        // (#134).
        bypassing: this.bypass,
      });
    }

    this.setState('idle');
  }

  /**
   * Whether this event is a runtime reporting the run this session stopped.
   *
   * Claude reports an interrupted run the same way it reports one that broke:
   * `is_error`, subtype `error_during_execution`. So pressing stop — or
   * correcting the agent by sending ahead of it — put a red card in the
   * conversation reading "claude ended the turn as error_during_execution",
   * with a Retry button offering to run again the very thing the user had just
   * stopped. Nothing had gone wrong. The run ended because it was told to, and
   * the honest record of that is the `interrupted` marker and the turn's own
   * stop reason, both of which already say it in the user's terms.
   *
   * Asked of adapter events only — this is a filter on what a *runtime* says,
   * and it must not touch what this session writes about the interrupt itself,
   * which is written through `ingest` directly. Bounded twice over: by the same
   * window `staleTurnEndUntil` uses, and by the `turn_end` that closes it, so
   * at most one report is swallowed per interrupt and a failure that happens
   * afterwards is a failure again.
   *
   * A fatal error is never dropped. That is the process itself going away,
   * which is true whatever preceded it, and swallowing it would leave a dead
   * conversation looking live.
   */
  private isInterruptedRunReport(event: AdapterEvent): boolean {
    return (
      event.t === 'error'
      && event.fatal !== true
      && this.interruptedErrorUntil !== null
      && Date.now() <= this.interruptedErrorUntil
    );
  }

  /**
   * Whether this event is an adapter writing the user's turn a second time.
   *
   * Every ACP runtime and both codex modes used to echo the prompt back into
   * the transcript as a user message of their own, on top of the one `deliver`
   * had already written — one prompt, two identical bubbles in the same turn
   * (#129). The adapters no longer do it, and this is what stops it coming
   * back: only `deliver` knows what the user actually typed, because a branched
   * conversation hands the adapter the carried briefing glued in front of the
   * prompt, and only `deliver` knows whether the turn was a steer.
   *
   * Narrow on purpose. It fires only while this session has a turn in flight
   * that it has already written a user message for, and only for a message it
   * did not mint itself — so a runtime that legitimately reports something as
   * the user (a resumed conversation replaying its own history) is untouched.
   * Those arrive while `replaying` is true and are dropped above anyway.
   */
  private isForeignUserEcho(event: AdapterEvent): boolean {
    if (event.t === 'msg_start') {
      if (
        event.role !== 'user'
        || this.turnInFlightId === null
        || this.ownUserMessageId === null
        || event.id === this.ownUserMessageId
      ) {
        return false;
      }
      this.droppedUserEchoes.add(event.id);
      return true;
    }
    // The blocks and the end of a message that was never opened. Left in, they
    // are events pointing at nothing, which every reader has to shrug off.
    if (event.t === 'block_start' || event.t === 'block_delta' || event.t === 'block_end') {
      return this.droppedUserEchoes.has(event.msgId);
    }
    if (event.t === 'msg_end') {
      return this.droppedUserEchoes.has(event.msgId);
    }
    return false;
  }

  /**
   * Capture a final markdown response when a runtime cannot load the submit tool.
   *
   * This is the universal Plan-mode fallback: tool-capable runtimes submit over
   * the callback channel, while a headless runtime can still return the plan as
   * its ordinary final answer. The transcript remains readable and the same
   * markdown is copied into the dedicated Plan control.
   */
  private capturePlanResponse(event: ChatEvent): string | null {
    if (!this.planMode && !this.questionFallbackEnabled) return null;

    if (event.t === 'msg_start' && event.role === 'assistant') {
      this.planResponseBlocks.set(event.id, new Map());
      return null;
    }
    if (event.t === 'block_start') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks && event.block.kind === 'text') blocks.set(event.index, event.block.text);
      return null;
    }
    if (event.t === 'block_delta') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks?.has(event.index) && event.text) {
        blocks.set(event.index, `${blocks.get(event.index) || ''}${event.text}`);
      }
      return null;
    }
    if (event.t === 'block_end') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      const block = event.block as { kind?: string; text?: unknown } | undefined;
      if (blocks?.has(event.index) && block?.kind === 'text' && typeof block.text === 'string') {
        blocks.set(event.index, block.text);
      }
      return null;
    }
    if (event.t === 'msg_end') {
      const blocks = this.planResponseBlocks.get(event.msgId);
      if (blocks) {
        this.planResponseBlocks.delete(event.msgId);
        const markdown = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, text]) => text)
          .join('\n\n')
          .trim();
        if (markdown) this.planResponseCandidate = markdown;
      }
      return null;
    }
    if (event.t !== 'turn_end' || event.stale) return null;

    const fallback = this.planResponseCandidate.trim();
    this.planResponseBlocks.clear();
    this.planResponseCandidate = '';
    return fallback || null;
  }

  private async handleFallbackResponse(markdown: string): Promise<void> {
    const question = this.questionFallbackEnabled ? responseQuestion(markdown) : null;
    if (question) {
      const prompt = typeof question.question === 'string' ? question.question.trim() : '';
      const answer = await this.askQuestion(question);
      // Stop/interrupt resolves every waiting question so its card can settle.
      // That resolution is not an answer to send: starting a continuation here
      // would undo Stop by launching a fresh internal turn after cancellation.
      if (cancelledFallbackAnswer(answer)) return;
      await this.continueAfterFallbackQuestion(prompt, answer);
      return;
    }
    if (this.planMode && !this.planSubmittedThisTurn) {
      const result = await this.submitPlan({ markdown, source: 'response' });
      if (!result.accepted && this.planMode) {
        this.ingest({
          t: 'error',
          message: `The planning response could not become a reviewable plan: ${result.detail} Plan mode is still on; send another planning message to retry.`,
        });
      }
    }
  }

  private async continueAfterFallbackQuestion(
    question: string,
    answer: QuestionReply,
  ): Promise<void> {
    if (!this.adapter?.alive) {
      this.ingest({
        t: 'error',
        message: 'The question was answered, but the runtime stopped before the answer could be delivered.',
      });
      if (this.state === 'awaiting_answer') this.setState('idle');
      return;
    }

    this.planSubmittedThisTurn = false;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';
    this.turnInFlightId = `turn-${crypto.randomUUID()}`;
    this.ownUserMessageId = `internal-${crypto.randomUUID()}`;
    this.droppedUserEchoes.clear();
    const planInstruction = this.planMode
      ? planModeDirective(Boolean(await this.planDocument()))
      : null;
    const questionInstruction = this.questionFallbackEnabled
      ? questionFallbackDirective()
      : null;
    const text = [questionInstruction, planInstruction, questionContinuation(question, answer)]
      .filter(Boolean)
      .join('\n\n');
    // This is a new internal turn just as surely as a composer delivery is.
    // A resumed runtime may still be replaying its own transcript, but the
    // answer and everything it produces must be recorded from this point on.
    this.replaying = false;
    this.setState('thinking');
    try {
      await this.adapter.send({ text });
    } catch (error: unknown) {
      this.turnInFlightId = null;
      this.ownUserMessageId = null;
      const detail = error instanceof Error ? error.message : String(error);
      this.ingest({ t: 'error', message: `The answer could not be delivered: ${detail}` });
      this.setState('idle');
    }
  }

  /**
   * Hold only text that can still be the structured fallback envelope.
   * Ordinary prose is released as soon as its prefix differs, retaining normal
   * streaming. A recognised envelope is converted into a question event later
   * and never written or broadcast as assistant-facing protocol JSON.
   */
  private interceptFallbackQuestionText(event: AdapterEvent): boolean {
    if (!this.questionFallbackEnabled) return false;
    const keyOf = (msgId: string, index: number): string => `${msgId}\u0000${index}`;
    const flush = (events: AdapterEvent[]): void => {
      this.flushingFallbackText = true;
      try {
        for (const held of events) this.ingest(held);
      } finally {
        this.flushingFallbackText = false;
      }
    };
    const canStillBeEnvelope = (text: string): boolean => {
      const trimmed = text.trimStart();
      return !trimmed || QUESTION_FALLBACK_OPEN.startsWith(trimmed)
        || trimmed.startsWith(QUESTION_FALLBACK_OPEN);
    };

    if (event.t === 'block_start' && event.block.kind === 'text') {
      const text = event.block.text || '';
      if (!canStillBeEnvelope(text)) return false;
      this.fallbackTextBlocks.set(keyOf(event.msgId, event.index), {
        msgId: event.msgId,
        index: event.index,
        text,
        events: [event],
      });
      return true;
    }

    if (event.t === 'block_delta' || event.t === 'block_end') {
      const key = keyOf(event.msgId, event.index);
      const held = this.fallbackTextBlocks.get(key);
      if (!held) return false;
      held.events.push(event);
      if (event.t === 'block_delta' && event.text) held.text += event.text;
      if (event.t === 'block_end') {
        const text = (event.block as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string') held.text = text;
      }
      if (canStillBeEnvelope(held.text)) return true;
      this.fallbackTextBlocks.delete(key);
      flush(held.events);
      return true;
    }

    if (event.t !== 'msg_end') return false;
    const heldForMessage = [...this.fallbackTextBlocks.entries()]
      .filter(([, held]) => held.msgId === event.msgId)
      .sort(([, left], [, right]) => left.index - right.index);
    if (heldForMessage.length === 0) return false;

    let recognised: string | null = null;
    for (const [key, held] of heldForMessage) {
      this.fallbackTextBlocks.delete(key);
      const envelope = responseQuestionEnvelope(held.text);
      if (!envelope) {
        flush(held.events);
        continue;
      }
      recognised = held.text;
      const visible = `${held.text.slice(0, envelope.start)}${held.text.slice(envelope.end)}`.trim();
      if (visible) {
        flush([{
          t: 'block_start',
          msgId: held.msgId,
          index: held.index,
          block: { kind: 'text', text: visible },
        }]);
      }
    }
    flush([event]);
    // `msg_end` normally derives the candidate from the blocks just flushed.
    // Put the private envelope back only in the server-side candidate after it
    // has been persisted, so fallback handling sees it while the transcript
    // never does.
    if (recognised) this.planResponseCandidate = recognised;
    return true;
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

    if (this.isForeignUserEcho(event)) {
      return;
    }

    if (!this.flushingFallbackText && this.interceptFallbackQuestionText(event)) {
      return;
    }

    this.seq += 1;
    const stamped = {
      ...event,
      seq: this.seq,
      ts: (event as { ts?: number }).ts ?? Date.now(),
    } as ChatEvent;

    if (stamped.t === 'turn_end') {
      // Decide whether this is the acknowledgement of an interrupted half-turn
      // before any Plan fallback consumes it. A stale ending is not evidence
      // that the corrected planning turn failed to submit a document.
      this.interruptedErrorUntil = null;
      const acknowledging =
        this.staleTurnEndUntil !== null
        && Date.now() <= this.staleTurnEndUntil
        && this.turnInFlightId !== null;
      if (acknowledging) {
        this.staleTurnEndUntil = null;
        stamped.stale = true;
      } else {
        this.staleTurnEndUntil = null;
        this.turnInFlightId = null;
        this.ownUserMessageId = null;
        this.droppedUserEchoes.clear();
      }
    }

    const fallbackPlan = this.capturePlanResponse(stamped);
    const stopReason = stamped.t === 'turn_end' ? (stamped.stopReason || '').toLowerCase() : '';
    const missingPlan = stamped.t === 'turn_end'
      && !stamped.stale
      && this.planMode
      && !this.planSubmittedThisTurn
      && !fallbackPlan
      && !/(interrupt|abort|cancel|blocked)/.test(stopReason);
    if (fallbackPlan) this.fallbackResponses += 1;

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
      // A missing property means the runtime said nothing, not that it
      // positively reported an empty catalogue. Seed the session event too;
      // otherwise a wrapper that announces fresh capabilities can erase the
      // stand-in merely by omitting `commands`.
      if (stamped.t === 'session') {
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

    if (stamped.t === 'session') {
      // Patched on the event itself, not just on the copy kept here. Every
      // reader of this log — this session, the browser's reducer, a snapshot
      // replayed tomorrow — takes `session.capabilities` as a wholesale
      // replacement, so a flag re-applied only locally would be true on the
      // server and false in every browser. Whether the model can ask a question
      // is a fact about what this session wired up; the runtime introducing
      // itself knows nothing about it and must not be able to unset it.
      if ((this.questionsEnabled || this.questionFallbackEnabled) && !stamped.capabilities.questions) {
        stamped.capabilities = { ...stamped.capabilities, questions: true };
      }
      if (this.planEnabled && !stamped.capabilities.planMode) {
        stamped.capabilities = { ...stamped.capabilities, planMode: true };
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
        if (this.adapterStarting) {
          this.adapterExitedWhileStarting = true;
        } else {
          this.deps.onLifecycle?.(this.ref.id, {
            exited: true,
            restarting: this.restarting,
          });
        }
      }
    }
    if (
      stamped.t === 'turn_end'
      && !stamped.stale
      && this.state !== 'error'
      && this.state !== 'exited'
    ) {
      // Mirrors the reducer, which does exactly this. Not emitted as a `state`
      // event: the log already carries turn_end, and every reader of that log
      // reaches the same conclusion from it. Emitting a second event would put
      // the same fact in twice.
      this.state = 'idle';
    }
    // `stale` is the interrupt acknowledgement a steer produces, and it closes
    // no turn — the reducer excludes it from turn accounting for the same
    // reason. Ending an escalation on one cancels a grant the user has paid for
    // while the redirected turn is still running.
    if (stamped.t === 'turn_end' && !stamped.stale && this.escalation) {
      if (this.escalation.startsNextTurn) {
        // This is the turn the grant was *not* for. The promised one starts now.
        this.escalation = { ...this.escalation, startsNextTurn: false };
      } else {
        // The task that prompted the move up is over. Not awaited: `ingest` is
        // synchronous for every one of its callers, and the switch back is a
        // request to a runtime that may take its time answering. The marker it
        // emits arrives after this event, which is the order it happened in.
        void this.endEscalation();
      }
    }
    if (stamped.t === 'capabilities' && this.capabilities) {
      this.capabilities = { ...this.capabilities, ...stamped.capabilities };
    }
    if (stamped.t === 'limits') {
      // Held for the same reason `capabilities` is: the snapshot replays only a
      // window of the log, and a rate-limit window announced at the top of a
      // long conversation would fall off the back of it. This is a latest
      // value, not an append, so keeping it here costs one object.
      this.limits = stamped.limits;
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
    // The call that asked has ended without an answer, so the question ends too.
    // This is the whole of the fix for a card that outlived its own tool call by
    // ten minutes (#174): an agent whose MCP client gives up on the call says so
    // right here, in a patch carrying the very id the question was filed under,
    // and until now nothing read it. A click after this point could never have
    // reached the model — the runtime has already dropped the request — so the
    // card stops offering one.
    //
    // Deferred rather than resolved on the spot, for the reason `noteSpend`
    // spells out below: `ingest` is running, and a second `ingest` from inside
    // it would number and broadcast the resolution *ahead* of the patch that
    // caused it. A microtask is the smallest wait that puts it after.
    if (stamped.t === 'tool' && DEAD_TOOL_STATUS.has(stamped.patch.status as string)) {
      const dead = stamped.toolId;
      if (this.questionsFor(dead).length > 0) {
        queueMicrotask(() => this.abandonQuestionsFor(dead));
      }
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
    this.noteSpend(stamped);

    try {
      this.deps.store.append(this.ref, [stamped]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not persist an event: ${message}`);
    }

    this.deps.broadcast(this.ref.id, { type: 'chat_event', sessionId: this.ref.id, event: stamped });

    if (fallbackPlan) {
      queueMicrotask(() => {
        void this.handleFallbackResponse(fallbackPlan)
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.ingest({ t: 'error', message: `The response could not be handled: ${detail}` });
          })
          .finally(() => {
            this.fallbackResponses = Math.max(0, this.fallbackResponses - 1);
            this.drainQueue();
          });
      });
    } else if (missingPlan) {
      queueMicrotask(() => {
        if (!this.planMode || this.planSubmittedThisTurn) return;
        this.ingest({
          t: 'error',
          message: 'The planning turn ended without a reviewable plan. Plan mode is still on; send another planning message to retry.',
        });
      });
    }

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
   * Say, once, that this runtime reports no tokens and/or no money.
   *
   * Every surface that shows spend had exactly two things to draw: a figure, or
   * nothing. Nothing is what a conversation looks like in its first second, so
   * the header stayed blank for kimi — which reports no `usage_update`, no
   * usage on its prompt reply and no `_meta` at all — and a user could not tell
   * that from a session that simply had not spent anything yet.
   *
   * The statement is a measurement and is made where the measurement finishes:
   * a turn in which the runtime actually did something *ran to its own end*,
   * and nothing on any channel carried a count or a price. Done once per
   * conversation, because the log is a record of what changed.
   *
   * "Ran to its own end" is doing real work there, and it is why the two gates
   * below exist. Three kinds of `turn_end` are not a turn finishing: the
   * acknowledgement of an interrupt sent to steer (`stale`, which the comment
   * on the field calls "not a turn ending" — the turn is still running on the
   * correction), a stop-button cancel, and an ending the adapter wrote because
   * the runtime errored or went away. In all three the runtime was cut off
   * before the moment it would have priced the turn, so its silence is about
   * the interruption and not about the runtime. Concluding from one of them
   * told a user that Claude reports neither tokens nor cost because they had
   * pressed stop, and the statement outlives the turn: it is folded into the
   * transcript, carried through `/clear` and re-read on every rejoin, so it
   * stands until some later turn happens to report a figure. Skipping is free
   * by comparison — the next turn that does finish states it.
   *
   * Written onto the `turn_end` that proves it rather than ingested as its own
   * event. `ingest` is what calls this, so a second `ingest` from in here would
   * number and broadcast the new event *ahead* of the turn_end that caused it —
   * the same re-entrancy the capacity lookup above defers a promise to avoid.
   * Patching the event in hand needs no ordering at all, and it lands on the
   * one event a reader would look at to ask the question.
   */
  private noteSpend(event: ChatEvent): void {
    if (event.t === 'msg_start' && event.role !== 'user') this.turnDidWork = true;
    if (event.t === 'block_start' && event.block.kind === 'tool') this.turnDidWork = true;

    if (event.t === 'usage' || event.t === 'msg_end' || event.t === 'turn_end') {
      if (carriesTokens(event.usage)) this.spokeTokens = true;
      if (carriesCost(event.usage)) this.spokeCost = true;
    }

    if (event.t !== 'turn_end') return;
    // Before the reset, deliberately: the turn this acknowledges is still
    // running, so the work it has already done still belongs to the ending
    // that is yet to come.
    if (event.stale) return;
    const worked = this.turnDidWork;
    this.turnDidWork = false;
    if (!worked) return;
    if (wasCutShort(event.stopReason)) return;

    const silence: ChatUsage = {};
    if (!this.spokeTokens && !this.statedTokenSilence) {
      this.statedTokenSilence = true;
      silence.usageSource = 'none';
    }
    if (!this.spokeCost && !this.statedCostSilence) {
      this.statedCostSilence = true;
      silence.costSource = 'none';
    }
    if (silence.usageSource === undefined && silence.costSource === undefined) return;
    event.usage = { ...event.usage, ...silence };
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
    if (this.draining || this.fallbackResponses > 0 || this.queue.length === 0) return;

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

    this.planSubmittedThisTurn = false;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';

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
    // Set before the ingest, because the gate that recognises an adapter's copy
    // of this message compares against it — see `isForeignUserEcho`.
    this.ownUserMessageId = messageId;
    this.droppedUserEchoes.clear();
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
    const command = isSlashCommand(turn.text);
    if (command && this.planMode) {
      const name = turn.text.trim().split(/\s+/, 1)[0]!.toLowerCase();
      if (!PLAN_SAFE_SLASH_COMMANDS.has(name)) {
        const blockedTurnId = this.turnInFlightId;
        this.ingest({
          t: 'error',
          message: `${name} was not run because Plan mode only allows planning. Turn Plan mode off before running runtime commands.`,
        });
        if (blockedTurnId) {
          this.ingest({ t: 'turn_end', turnId: blockedTurnId, stopReason: 'blocked' });
        }
        return;
      }
    }
    const carried = command ? null : await this.openingContext();
    const planInstruction = !command && this.planMode
      ? planModeDirective(Boolean(await this.planDocument()))
      : null;
    const questionInstruction = !command
      ? this.questionsEnabled
        ? questionToolDirective()
        : this.questionFallbackEnabled
          ? questionFallbackDirective()
          : null
      : null;
    const runtimeText = [questionInstruction, planInstruction, carried, turn.text]
      .filter(Boolean)
      .join('\n\n');
    await this.adapter.send(runtimeText === turn.text ? turn : { ...turn, text: runtimeText });

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
    let oldRuntimeStopped = false;
    try {
      await this.stop();
      oldRuntimeStopped = true;
      // Stale until the new process's own `init` event reports its id — cleared
      // up front so nothing reads the old conversation's id in the meantime.
      // The record hears it too, but from inside `start`, once the log this
      // one lived in has actually been dropped (#43).
      this.nativeSessionId = null;
      // The mode is re-decided rather than replayed. A conversation started
      // from inside this one is a conversation that is *beginning*, so it takes
      // the owner's preference exactly as the launcher's would — which is what
      // makes the composer's New chat and the recovery notice's Start a new
      // chat land in the same place. Replaying `options.bypassPermissions` is
      // what used to carry one conversation's standing permission into every
      // later one in the tab, whatever the preference had since been set to.
      await this.start({
        ...options,
        bypassPermissions: this.deps.resolveBypass?.() === true,
        resumeSessionId: undefined,
        startFresh: true,
      });
    } catch (error: unknown) {
      // Nothing replaced the conversation that was stopped. `start()` has
      // already written the failure into the transcript and moved the state to
      // `error`; the record has to hear it too, or the tab goes on claiming a
      // process that never started and refuses the relaunch that would fix it.
      // If teardown itself could not prove the old process gone, admission has
      // to remain closed. Only a verified stop followed by a failed replacement
      // is an exited conversation.
      if (oldRuntimeStopped) {
        this.deps.onLifecycle?.(this.ref.id, { exited: true, restarting: false });
      }
      throw error;
    } finally {
      this.restarting = false;
    }

    // The record outlives every process this session runs, and `stop()` above
    // told it one had gone. Saying so again in the other direction is what
    // keeps the tab a running tab: without it the session lists report a
    // conversation that is answering as finished, and the next launch in this
    // tab is refused because a process it no longer has is still claimed.
    //
    // And the mode with it, because this restart may well have changed it: left
    // out, a conversation cleared down to asking would still be *recorded* as
    // bypassing, and the next resume would hand it back a permission it no
    // longer had.
    this.deps.onLifecycle?.(this.ref.id, { exited: false, bypassing: this.bypass });
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
    // Said before the interrupt rather than after it, because the answer to it
    // can arrive during the await — and on Claude the answer *is* the report
    // this window exists to swallow. Same reasoning as `staleTurnEndUntil`,
    // which `sendQueuedNow` sets one line before calling this.
    this.interruptedErrorUntil = Date.now() + INTERRUPT_ACK_WINDOW_MS;
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
    //
    // Recorded as abandoned rather than skipped, which it never was: the user
    // pressed stop, and stopping a turn is not the same act as reading a
    // question and declining to answer it. Drawn as "skipped without answering"
    // it read as an accusation — in the conversation that prompted #174 it was
    // the *only* thing on screen about two cards whose tool calls had died ten
    // minutes earlier, so the record blamed the user for the runtime's timeout.
    for (const [requestId, entry] of this.questions) {
      entry.resolve({ labels: [], error: 'the turn was interrupted' });
      this.ingest({
        t: 'question_resolved',
        requestId,
        toolId: entry.request.toolId,
        optionIds: [],
        abandoned: true,
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
   * The agent asking to answer this task from the next model up its ladder.
   *
   * Put to the user as an ordinary approval, because that is exactly what it
   * is: the app gating the agent, with allow and deny the only two meanings an
   * answer can have. It draws the card the browser already has, travels the
   * message the browser already handles, and is recorded in the transcript with
   * every other decision the conversation made — none of which a bespoke
   * request type would have got for free.
   *
   * The grant lasts until the turn ends. See `escalation`.
   */
  private async requestTier(ask: TierAsk): Promise<TierReply> {
    const ladder = this.ladder;
    if (!ladder) {
      return { granted: false, detail: 'this conversation is not running on a capability ladder.' };
    }
    // From the rung in force, not the rung it started on: two grants in one turn
    // would otherwise both offer the same step up, and the second would look to
    // the user like a request that had already been approved.
    const from = this.escalation?.to ?? ladder.tier;
    const next = nextRungUp({ tiers: ladder.tiers }, from);
    if (!next) {
      return {
        granted: false,
        detail:
          `You are already on the ${from} rung, which is the highest one this profile fills in. `
          + 'Carry on with the model you have.',
      };
    }

    const reason = typeof ask.reason === 'string' ? ask.reason.trim() : '';
    const granted = this.bypass
      ? true
      : await this.askEscalation(from, next.tier, next.model, reason);

    if (!granted) {
      return {
        granted: false,
        detail:
          `The user did not approve moving up to the ${next.tier} rung. `
          + 'Carry on with the model you have, and do not ask again this turn.',
      };
    }

    const applied = await this.applyModel(next.model);
    if (applied === 'no') {
      // Nothing was changed, so nothing is claimed. A model told it moved up
      // when it did not will attempt work it cannot do, and the user will be
      // shown a rung the process was never on.
      return {
        granted: false,
        detail:
          `The user approved moving up to the ${next.tier} rung, but this runtime cannot change `
          + 'its model without being restarted, so nothing moved. Carry on with the model you '
          + 'have and say that the stronger one could not be reached.',
      };
    }

    // A grant made while nothing is running belongs to the turn that has not
    // started yet — the same case as a runtime that can only switch between
    // turns, and it arises whenever a blocked tool call is abandoned while the
    // card is still up.
    const startsNextTurn = applied === 'next-turn' || this.state === 'idle';
    this.escalation = { from, to: next.tier, model: next.model, startsNextTurn };
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: startsNextTurn
        ? `moving up to the ${next.tier} rung for the next turn — ${next.model}`
        : `moved up to the ${next.tier} rung — ${next.model}`,
    });

    return {
      granted: true,
      tier: next.tier,
      model: next.model,
      detail: startsNextTurn
        ? `Approved. The ${next.tier} rung (${next.model}) takes effect on your next turn — the `
          + 'model answering right now cannot be changed mid-turn. Finish or stop here, and the '
          + `stronger model picks it up. The conversation returns to ${from} after that turn.`
        : `Approved. You are now answering from the ${next.tier} rung (${next.model}). `
          + `The conversation returns to ${from} when this turn ends.`,
    };
  }

  /**
   * Put a model in front of the agent, by whichever route its runtime has.
   *
   * Three answers, because there are three outcomes and collapsing them to a
   * boolean is how the escalation came to promise a rung it never reached:
   * `live` (the running process took it), `next-turn` (the runtime spawns per
   * turn, so the next one will), and `no` (nothing changed).
   */
  private async applyModel(model: string): Promise<'live' | 'next-turn' | 'no'> {
    const adapter = this.adapter;
    if (!adapter?.alive) return 'no';
    if (adapter.setModel) {
      await adapter.setModel(model);
      return 'live';
    }
    if (adapter.setModelNextTurn) {
      adapter.setModelNextTurn(model);
      return 'next-turn';
    }
    return 'no';
  }

  /**
   * Put an escalation to the user and wait.
   *
   * Deliberately not routed through `askUser`: that one has a bypass short
   * circuit and a tool-name exemption, neither of which means anything here, and
   * the request has no tool call behind it to gate.
   */
  private askEscalation(
    from: ModelTier,
    to: ModelTier,
    model: string,
    reason: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = `tier-${crypto.randomUUID()}`;
      const request: PermissionRequest = {
        requestId,
        title: `Answer from the ${to} rung instead of ${from}?`,
        toolKind: 'other',
        input: { rung: to, model },
        reason: reason || 'The agent gave no reason.',
        // Two options, not the usual three. The standing "Allow for this
        // session" would be a lie on the one control in the app that governs
        // spending: a grant lasts one turn by design, so a user who clicked it
        // believing the expensive model was authorised session-wide would have
        // been told the opposite of the truth.
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow, for this turn' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Stay on this rung' },
        ],
        ts: Date.now(),
      };
      this.pending.set(requestId, {
        request,
        resolve: (answer) => resolve(answer.allow),
      });
      this.ingest({ t: 'permission', request });
      this.setState('awaiting_permission');
    });
  }

  /**
   * The rung this conversation is actually on, or null when it is not on one.
   *
   * The escalated rung while an escalation is in force: what a browser joining
   * mid-turn has to be told is what the process is answering from, not what it
   * will go back to.
   */
  get ladderRung(): LadderRung | null {
    if (!this.ladder || !this.live) return null;
    const escalation = this.escalation;
    if (escalation && !escalation.startsNextTurn) {
      return { tier: escalation.to, model: escalation.model };
    }
    const model = this.ladder.tiers[this.ladder.tier];
    return model ? { tier: this.ladder.tier, model } : null;
  }

  /**
   * Move this conversation onto an edited ladder, mid-conversation.
   *
   * Returns false — meaning "not mine" — for a conversation that is not running
   * on a rung: one pinned by a model somebody typed, or by an account's standing
   * choice, was never the ladder's to decide and must not be re-modelled by an
   * edit to it.
   *
   * The turn in progress is interrupted, which #171 asks for outright. It is
   * destructive and deliberately so: the alternative is a conversation that goes
   * on answering from the model the profile no longer names, for as long as the
   * turn runs, with the settings page reporting the change as applied.
   */
  async reapplyLadder(
    ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null,
  ): Promise<boolean> {
    if (!this.ladder) return false;

    if (!ladder) {
      // The ladder is gone — the profile was deleted, deactivated, or had its
      // rungs cleared. Nothing to switch *to*: this conversation keeps the model
      // it is on until it is relaunched, which is when the runtime's own default
      // takes over. Said out loud rather than left to be discovered.
      this.ladder = null;
      this.escalation = null;
      this.ingest({
        t: 'marker',
        kind: 'model',
        detail: 'the ladder this conversation was on is gone; it keeps this model until relaunched',
      });
      return true;
    }

    const model = ladder.tiers[ladder.tier];
    const unchanged = model
      && !this.escalation
      && this.ladder.tier === ladder.tier
      && this.ladder.tiers[this.ladder.tier] === model;
    this.ladder = ladder;
    // Nothing the user would see. Interrupting a turn to change nothing is the
    // worst possible reading of "takes effect immediately".
    if (unchanged) return false;
    if (!model) return false;

    if (this.state !== 'idle') await this.interrupt().catch(() => undefined);
    // Any escalation belonged to the ladder that has just been replaced.
    this.escalation = null;
    const applied = await this.applyModel(model).catch(() => 'no' as const);
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: applied === 'no'
        // Said, not swallowed. The turn was cut short and the model did not
        // change, which is the worst of both and the user is owed the reason.
        ? `the profile changed to the ${ladder.tier} rung, ${model} — this runtime cannot take it `
          + 'without a restart, so this conversation stays on its model until then'
        : applied === 'next-turn'
          ? `the profile changed — the next turn runs on the ${ladder.tier} rung, ${model}`
          : `the profile changed — now on the ${ladder.tier} rung, ${model}`,
    });
    return applied !== 'no';
  }

  /**
   * Put the conversation back on the rung it belongs to.
   *
   * Called when a turn ends, which is the whole lifetime of a grant. Failing to
   * switch back is not treated as an error: the next turn's launch resolves the
   * model again from the ladder, so the worst case is one extra turn at the
   * higher rung rather than a conversation stranded there.
   */
  private async endEscalation(): Promise<void> {
    const escalation = this.escalation;
    const ladder = this.ladder;
    if (!escalation || !ladder) return;
    this.escalation = null;

    const back = ladder.tiers[escalation.from];
    const applied = back ? await this.applyModel(back).catch(() => 'no' as const) : 'no';
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: applied === 'no'
        ? `the ${escalation.to} rung ends here; the next launch resolves the ladder again`
        : `back on the ${escalation.from} rung — ${back}`,
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
  private askQuestion(ask: QuestionAsk, signal?: AbortSignal): Promise<QuestionReply> {
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
      // The caller giving up is the other way this ends. Registered after the
      // card exists so the listener has something to take down, and harmless
      // if it never fires — the abort controller goes when the call does.
      signal?.addEventListener(
        'abort',
        () => this.abandonQuestion(requestId, 'the agent stopped waiting for an answer'),
        { once: true },
      );
    });
  }

  /**
   * Record the answer a browser sent, and hand it to the waiting tool call.
   *
   * Returns false for a question this session does not have, which is what a
   * second browser answering one that has already been answered looks like.
   */
  answerQuestion(
    requestId: string,
    optionIds: string[],
    skipped = false,
    text?: string,
  ): boolean {
    const entry = this.questions.get(requestId);
    if (!entry) return false;

    // Filtered against the offered options rather than trusted: the ids come
    // from a browser, and the labels they resolve to are about to be handed
    // straight to the model as fact.
    const picked = entry.request.options.filter((option) => optionIds.includes(option.optionId));
    // The one part of an answer that is *not* filtered against the options,
    // because it is by definition not one of them. Bounded at the wire; here it
    // only has to be non-empty to count as having been answered.
    const own = typeof text === 'string' ? text.trim() : '';
    const answered = !skipped && (picked.length > 0 || own.length > 0);

    entry.resolve({
      labels: picked.map((option) => option.label),
      text: answered && own ? own : undefined,
      skipped: !answered,
    });

    this.questions.delete(requestId);
    this.ingest({
      t: 'question_resolved',
      requestId,
      toolId: entry.request.toolId,
      optionIds: picked.map((option) => option.optionId),
      text: answered && own ? own : undefined,
      skipped: !answered,
    });
    return true;
  }

  /** The pending questions asked by one tool call, usually none or one. */
  private questionsFor(toolId: string): string[] {
    const ids: string[] = [];
    for (const [requestId, entry] of this.questions) {
      if (entry.request.toolId === toolId) ids.push(requestId);
    }
    return ids;
  }

  /**
   * End the questions a dead tool call was waiting on, and say so.
   *
   * The counterpart to `answerQuestion` for the case where nobody got to
   * answer. The waiting promise is still resolved — the MCP server on the other
   * end of the socket is holding a `tools/call` open, and abandoning it in
   * silence would strand that process rather than the card — but what goes into
   * the transcript is `abandoned`, not `skipped`. The two look identical on
   * screen if you conflate them and they say opposite things about the user.
   */
  private abandonQuestionsFor(toolId: string, reason = 'the agent stopped waiting for an answer'): void {
    for (const requestId of this.questionsFor(toolId)) {
      this.abandonQuestion(requestId, reason);
    }
  }

  /** The same for one question, which is how a cancelled call arrives. */
  private abandonQuestion(requestId: string, reason: string): void {
    const entry = this.questions.get(requestId);
    if (!entry) return;
    entry.resolve({ labels: [], error: reason });
    this.questions.delete(requestId);
    this.ingest({
      t: 'question_resolved',
      requestId,
      toolId: entry.request.toolId,
      optionIds: [],
      abandoned: true,
    });
    // Nothing left to wait for. Said here rather than left to the next event,
    // because a conversation that goes on reporting `awaiting_answer` with no
    // card to answer is one whose composer stays out of the user's way.
    if (this.questions.size === 0 && this.state === 'awaiting_answer') {
      this.setState(this.live ? 'running' : 'idle');
    }
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

  /** Read the latest submitted plan once per process, then keep the cache current. */
  async planDocument(): Promise<PlanDocument | null> {
    if (this.planDocumentCache !== undefined) return this.planDocumentCache;
    this.planDocumentCache = (await this.deps.store.planDocument?.(this.ref)) ?? null;
    return this.planDocumentCache;
  }

  /** Put every Plan read/change decision behind one per-session boundary. */
  private mutatePlan<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.planMutation.catch(() => undefined).then(operation);
    this.planMutation = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Persist one complete numbered revision from the MCP tool or response fallback. */
  async submitPlan(input: { markdown?: unknown; source?: 'tool' | 'response' }): Promise<PlanSubmissionResult> {
    const markdown = typeof input.markdown === 'string' ? input.markdown.trim() : '';
    if (!this.planMode) {
      return { accepted: false, detail: 'Plan mode is not active for this conversation.' };
    }
    if (!markdown) {
      return { accepted: false, detail: 'A submitted plan cannot be empty.' };
    }
    if (markdown.length > MAX_PLAN_TEXT) {
      return {
        accepted: false,
        detail: `The plan is too large; the limit is ${MAX_PLAN_TEXT} characters.`,
      };
    }
    if (!this.deps.store.setPlanDocument) {
      return { accepted: false, detail: 'This server cannot persist Plan documents.' };
    }
    const generation = this.planGeneration;
    return this.mutatePlan(async () => {
      // The mode and generation are checked again after waiting for earlier
      // Plan actions. Otherwise a submission already in line could write after
      // Accept or /clear had ended the planning conversation.
      if (!this.planMode || generation !== this.planGeneration) {
        return { accepted: false, detail: 'Plan mode is no longer active for this conversation.' };
      }
      try {
        const previous = await this.planDocument();
        if (!this.planMode || generation !== this.planGeneration) {
          return { accepted: false, detail: 'The planning conversation ended before this plan could be stored.' };
        }
        const plan: PlanDocument = {
          markdown,
          revision: (previous?.revision ?? 0) + 1,
          ts: Date.now(),
        };
        await this.deps.store.setPlanDocument!(this.ref, plan);
        if (generation !== this.planGeneration) {
          // A clear waited for this operation and removes the sidecar next; do
          // not republish it into the new conversation while that happens.
          return { accepted: false, detail: 'The planning conversation ended before this plan could be published.' };
        }
        this.planDocumentCache = plan;
        this.planSubmittedThisTurn = true;
        this.deps.broadcast(this.ref.id, {
          type: 'chat_plan_document',
          sessionId: this.ref.id,
          plan,
        });
        return {
          accepted: true,
          revision: plan.revision,
          detail: `Plan saved as revision ${plan.revision}.`,
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { accepted: false, detail: `The plan could not be stored: ${detail}` };
      }
    });
  }

  /** Turn the conversation-level mode on or off while no turn is active. */
  async setPlanMode(on: boolean): Promise<PlanModeResult> {
    return this.mutatePlan(async () => {
      if (this.live && (this.state !== 'idle' || this.draining || this.queue.length > 0)) {
        return {
          planMode: this.planMode,
          changed: false,
          detail: 'Wait for the active turn and queued messages to finish before changing Plan mode.',
        };
      }
      if (this.planMode === on) {
        return {
          planMode: this.planMode,
          changed: false,
          detail: on ? 'Plan mode is already on.' : 'Plan mode is already off.',
        };
      }
      this.planMode = on;
      this.rememberPlanMode(on);
      if (!on) {
        this.planResponseBlocks.clear();
        this.planResponseCandidate = '';
      }
      return {
        planMode: on,
        changed: true,
        detail: on ? 'Plan mode is on.' : 'Plan mode is off. The latest plan was kept.',
      };
    });
  }

  /** Carry Plan mode through an in-place process restart. */
  rememberPlanMode(on: boolean): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, planMode: on };
  }

  /**
   * Accept only the latest revision, then immediately start its implementation.
   * The prompt is internal runtime context: no user-authored transcript bubble
   * is manufactured for an action the user took through the Plan control.
   */
  async acceptPlan(revision: number): Promise<PlanActionResult> {
    return this.mutatePlan(async () => {
      const plan = await this.planDocument();
      if (!this.planMode) {
        return { accepted: false, action: 'accept', planMode: false, detail: 'Plan mode is not active.' };
      }
      if (!plan) {
        return { accepted: false, action: 'accept', planMode: true, detail: 'There is no plan to accept.' };
      }
      if (revision !== plan.revision) {
        return {
          accepted: false,
          action: 'accept',
          planMode: true,
          revision: plan.revision,
          detail: `Revision ${revision} is stale. Review revision ${plan.revision} before accepting.`,
        };
      }
      if (!this.adapter?.alive || this.state !== 'idle' || this.draining || this.queue.length > 0) {
        return {
          accepted: false,
          action: 'accept',
          planMode: true,
          revision: plan.revision,
          detail: 'The conversation must be live and idle before the plan can be accepted.',
        };
      }

      const generation = this.planGeneration;
      this.planMode = false;
      this.rememberPlanMode(false);
      this.turnInFlightId = `turn-${crypto.randomUUID()}`;
      // A few runtimes echo their prompt. This sentinel makes that internal copy
      // pass through the same duplicate-user-message filter as ordinary turns.
      this.ownUserMessageId = `internal-${crypto.randomUUID()}`;
      this.droppedUserEchoes.clear();
      // Accept is an internal new turn. End resume replay before any event from
      // its implementation can pass through the replayable-event gate.
      this.replaying = false;
      this.setState('thinking');
      try {
        const deadline = Date.now() + QUEUE_READY_TIMEOUT_MS;
        while (!this.adapterReady && this.adapter?.alive && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, QUEUE_READY_POLL_MS));
        }
        if (!this.adapter?.alive || !this.adapterReady) {
          throw new Error(`the ${this.runtime || 'agent'} process was not ready for another turn`);
        }
        const questionInstruction = this.questionsEnabled
          ? questionToolDirective()
          : this.questionFallbackEnabled
            ? questionFallbackDirective()
            : null;
        await this.adapter.send({
          text: [questionInstruction, acceptedPlanDirective(plan)].filter(Boolean).join('\n\n'),
        });
      } catch (error: unknown) {
        const sameConversation = generation === this.planGeneration;
        if (sameConversation) {
          this.planMode = true;
          this.rememberPlanMode(true);
          this.turnInFlightId = null;
          this.ownUserMessageId = null;
          this.setState('idle');
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          accepted: false,
          action: 'accept',
          planMode: this.planMode,
          revision: plan.revision,
          detail: sameConversation
            ? `The plan was not accepted because implementation could not start: ${detail}`
            : 'The plan was not accepted because a new conversation started first.',
        };
      }
      return {
        accepted: true,
        action: 'accept',
        planMode: false,
        revision: plan.revision,
        detail: `Plan revision ${plan.revision} accepted. Implementation started.`,
      };
    });
  }

  /** Reject the latest revision without leaving Plan mode or deleting it. */
  async rejectPlan(revision: number): Promise<PlanActionResult> {
    return this.mutatePlan(async () => {
      const plan = await this.planDocument();
      if (!this.planMode) {
        return { accepted: false, action: 'reject', planMode: false, detail: 'Plan mode is not active.' };
      }
      if (!plan) {
        return { accepted: false, action: 'reject', planMode: true, detail: 'There is no plan to reject.' };
      }
      if (revision !== plan.revision) {
        return {
          accepted: false,
          action: 'reject',
          planMode: true,
          revision: plan.revision,
          detail: `Revision ${revision} is stale. Review revision ${plan.revision} instead.`,
        };
      }
      if (this.live && this.state !== 'idle') {
        return {
          accepted: false,
          action: 'reject',
          planMode: true,
          revision: plan.revision,
          detail: 'Wait for the active planning turn to finish before rejecting its plan.',
        };
      }
      return {
        accepted: true,
        action: 'reject',
        planMode: true,
        revision: plan.revision,
        detail: `Plan revision ${plan.revision} rejected. Add feedback in the composer to request a revision.`,
      };
    });
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
    return Promise.all([this.deps.store.snapshot(this.ref), this.planDocument()]).then(([snapshot, planDocument]) => ({
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
      questionHistory: [
        ...(snapshot.questionHistory || []),
        ...Array.from(this.questions.values())
          .map((entry) => entry.request)
          .filter((request) => !(snapshot.questionHistory || [])
            .some((recorded) => recorded.requestId === request.requestId)),
      ],
      // `answeredQuestions` is deliberately NOT overridden here. This map holds
      // only the questions still waiting; what was picked for the ones already
      // answered is in the log, and the store's replay of it is the authority
      // (#113). Overlaying anything from here would narrow it to this process's
      // lifetime, which is exactly the conversation this has to survive.
      queued: this.queuedTurns,
      live: this.live,
      nativeSessionId: this.nativeSessionId || undefined,
      bypassPermissions: this.bypass,
      limits: this.limits || snapshot.limits,
      planMode: this.planMode,
      planDocument,
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
    // Written to the log as well as resolved, which it was not before: a browser
    // already watching this conversation is told the card is over, instead of
    // going on offering buttons until something makes it rejoin and rebuild.
    for (const [requestId, entry] of this.questions) {
      entry.resolve({ labels: [], error: 'the session was stopped' });
      this.ingest({
        t: 'question_resolved',
        requestId,
        toolId: entry.request.toolId,
        optionIds: [],
        abandoned: true,
      });
    }
    this.questions.clear();
    this.clearQueue();

    // Before the adapter goes: a turn that was still running when someone hit
    // stop is work that happened, and losing it would make every deliberate
    // interruption invisible in the record.
    this.accountant?.flush();
    this.accountant = null;

    const adapter = this.adapter;
    try {
      if (adapter) {
        // Resolving is a lifecycle guarantee: the local child and, for a
        // container, its identity-bound remote process group are both gone.
        await adapter.stop();
        if (this.adapter === adapter) this.adapter = null;
      }
    } finally {
      this.broker?.close();
      this.broker = null;
      await this.fileBroker?.close().catch(() => undefined);
      this.fileBroker = null;
    }
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
