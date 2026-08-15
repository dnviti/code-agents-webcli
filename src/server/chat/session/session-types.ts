import * as path from 'path';
import type { CodexCostEstimator } from '../../../shared/codex-pricing.js';
import { ChatUsage, PermissionRequest, QuestionRequest } from '../../../shared/chat-events.js';
import { ModelTier } from '../../../shared/runtime-profiles.js';
import { PermissionAnswer, QuestionReply } from '../permission-broker.js';
import { UserEnvironment } from '../../services/environments/types.js';
import { ChatStoreLike } from '../store.js';
import { UsageJobInput } from '../../services/usage/usage-store.js';

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
  /**
   * Prices codex turns at OpenAI list price (issue #182). Handed to the codex
   * adapter so the live header can show a cumulative estimate, and used here to
   * stamp a per-turn estimate onto the durable record. Absent in tests or
   * deployments without it — codex then records tokens with no cost, exactly
   * as before.
   */
  codexPricing?: CodexCostEstimator;
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
  /** Exact executable selected for this launch, when app-managed. */
  command?: string;
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

export type AgentUpdateRestartResult =
  | { ok: true; resumed: boolean }
  | { ok: false; reason: 'not_running' | 'busy' | 'cannot_resume' };

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

export interface PendingApproval {
  request: PermissionRequest;
  /** Set when the question came over the hook broker rather than the adapter. */
  resolve?: (answer: PermissionAnswer) => void;
}

export interface PendingToolQuestion {
  kind: 'tool';
  request: QuestionRequest;
  resolve: (reply: QuestionReply) => void;
  phase?: 'open' | 'resolving';
}

/** A durable question whose model turn ended before the browser was asked. */
export interface PendingHandoffQuestion {
  kind: 'structured_handoff';
  request: QuestionRequest;
  phase?: 'open' | 'resolving';
}

export type PendingQuestion = PendingToolQuestion | PendingHandoffQuestion;

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
