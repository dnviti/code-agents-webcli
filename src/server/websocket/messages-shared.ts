import { ChatManagerLike } from './messages-types.js';
import { ChatModelOrigin, BuiltInWorkflowId } from '../../shared/chat-events.js';
import { LadderRung, ResolvedProfile } from '../../shared/runtime-profiles.js';
import type { ProjectSessionLease } from '../services/projects/working-dir.js';

/**
 * The rung a *running* session is actually on, told as an origin.
 *
 * Null when nothing is running, or when what is running is not on a rung. The
 * profile is only consulted for the name to put on it.
 */
export function ladderOf(
  manager: ChatManagerLike,
  sessionId: string,
  profile: ResolvedProfile | null,
): ChatModelOrigin | null {
  const rung = manager.ladderOf?.(sessionId);
  if (!rung) return null;
  // Which rung is running is the session's to answer; which rung was *asked
  // for* is only ever the profile's, because falling to the nearest filled one
  // happens while the profile is being resolved and the session is handed the
  // answer rather than the question. Grafted on only while the two still
  // describe the same resolution, so a conversation moved to another rung since
  // does not inherit an explanation that belongs to a rung it left.
  const requested =
    profile?.ladder?.requested && profile.ladder.tier === rung.tier
      ? profile.ladder.requested
      : undefined;
  return ladderOrigin(requested ? { ...rung, requested } : rung, profile);
}

/** One rung, told as an origin — the same three facts, said the way the UI reads them. */
export function ladderOrigin(rung: LadderRung, profile: ResolvedProfile | null): ChatModelOrigin {
  return {
    model: rung.model,
    source: 'ladder',
    ...(profile?.profileName ? { profileName: profile.profileName } : {}),
    tier: rung.tier,
    ...(rung.requested ? { requestedTier: rung.requested } : {}),
  };
}

/**
 * The longest model name worth storing. Real ones are far shorter; this only
 * has to stop an unbounded string from being persisted and then handed to a
 * spawn on every future launch of the conversation.
 */
export const MAX_MODEL_NAME = 200;
/** Bounded because this client-generated id is reflected in an acknowledgement. */
export const MAX_QUESTION_ANSWER_SUBMISSION_ID = 200;

/**
 * How often a working session says so to the screens that are not attached to it.
 *
 * Not a latency budget: the tab strip calls a session quiet after ninety
 * seconds without a sign of life, so anything comfortably under that keeps
 * every screen agreeing. A second is the point where the announcement costs
 * nothing measurable next to the output it stands in for.
 */
export const ACTIVITY_ANNOUNCE_MS = 1000;

/** A bounded process-lifetime cache prevents arbitrary ids becoming retained state. */
export const MAX_BUILT_IN_WORKFLOW_ADMISSIONS = 512;
export const MAX_BUILT_IN_WORKFLOW_REQUEST_ID = 200;

export interface BuiltInWorkflowAdmissionResult {
  accepted: boolean;
  message: string;
  status?: 'accepted' | 'queued';
}

export interface BuiltInWorkflowAdmission {
  workflow: BuiltInWorkflowId;
  prompt: string;
  promise: Promise<BuiltInWorkflowAdmissionResult>;
  /** True only after the state-changing admission took ownership of the turn. */
  accepted: boolean;
}

/**
 * Tidy a typed model name into something safe to keep.
 *
 * Names are never validated against a list — a runtime knows its own models
 * and new ones appear without us — so this only removes what can't belong in
 * one: control characters, which would otherwise ride into the best-effort
 * `/model <name>` turn as extra lines, and unbounded length.
 */
export function normaliseModelName(raw: string): string | undefined {
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  // Sliced by code point, not by code unit: cutting mid-character would store
  // half a surrogate pair.
  const cleaned = [...stripped].slice(0, MAX_MODEL_NAME).join('').trim();
  return cleaned || undefined;
}

/**
 * Tidy a reasoning-effort level into something safe to keep.
 *
 * Far stricter than the model equivalent, and deliberately so. A model name is
 * free text because only the runtime knows its own catalogue; an effort level is
 * not — every one this app will ever send came out of a list the runtime
 * published, and the whole set observed across the six runtimes is a handful of
 * bare words: `off`, `on`, `auto`, `none`, `minimal`, `low`, `medium`, `high`,
 * `xhigh`, `max`, `ultra`. So anything that is not a short lower-case token is
 * not a level anybody offered, and is dropped rather than stored and then pushed
 * onto the command line of every future launch of this conversation.
 */
export function normaliseEffortLevel(raw: string): string | undefined {
  const cleaned = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(cleaned) ? cleaned : undefined;
}

export interface IncomingMessage {
  type: string;
  name?: string;
  workingDir?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
  data?: string;
  cols?: number;
  rows?: number;
  command?: string;
  fromLine?: number;
  count?: number;
  requestId?: string;
  /** Client-generated id correlated with `chat_question_answer_ack`. */
  submissionId?: string;
  /** Correlates an app-owned workflow request with its admission result. */
  workflow?: string;
  /**
   * The one free-text field a frame carries: a turn on `chat_send`, and what
   * the user typed in their own words on `chat_question_answer`. Shared rather
   * than split in two, because the handler that reads it knows which message it
   * is holding and a second name would only be the same string twice.
   */
  text?: string;
  attachments?: unknown[];
  /**
   * Whether this turn is the composer being emptied, rather than a turn from
   * the transcript being asked again.
   *
   * Only the first empties the conversation's shared draft. Absent on every
   * frame from a page that predates the shared composer, which then behaves
   * exactly as it did: nothing to clear, because nothing was being shared.
   */
  fromComposer?: boolean;
  optionId?: string;
  /** Every option picked for a multiple-choice question the model asked. */
  optionIds?: unknown[];
  /** True when the user chose to answer a question with nothing. */
  skipped?: boolean;
  fromSeq?: number;
  agentKind?: string;
  /** Identifies one turn waiting in the send-ahead queue. */
  queuedId?: string;
  /** A conversation-scoped model to switch to, or null/empty to clear the override. */
  model?: string | null;
  /**
   * A conversation-scoped reasoning-effort level, or null/empty to clear it.
   *
   * Unlike the model this is never free text: the control only offers levels the
   * running runtime published, so anything arriving here that the runtime does
   * not know is a bug or a hand-crafted socket frame, and is refused rather than
   * stored and replayed into every future launch.
   */
  effort?: string | null;
  planMode?: boolean;
  revision?: number;
  /** Agent-update restart policy; the server re-checks all live state. */
  automatic?: boolean;
  allowFreshContext?: boolean;
}

export interface HeldProjectSessionLease extends ProjectSessionLease {
  sessionId: string;
}
