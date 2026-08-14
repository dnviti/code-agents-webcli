import type { AccountLimits, ChatUsage } from './usage.js';
import type {
  PermissionRequest,
  QuestionContinuation,
  QuestionRequest,
} from './request.js';
import type { ChatCapabilities, ChatState } from './model.js';
import type { PlanDocument, PlanItem } from './core.js';
import type { ChatMessage } from './message.js';
import type { QueuedTurn } from './draft.js';
/**
 * The rolling view a client holds.
 *
 * `cursor` is the highest seq the client has applied, so a reconnect asks for
 * exactly what it missed instead of refetching a transcript it already has.
 */
export interface ChatSnapshot {
  sessionId: string;
  runtime: string;
  messages: ChatMessage[];
  state: ChatState;
  capabilities: ChatCapabilities;
  usage?: ChatUsage;
  plan?: PlanItem[];
  /** Durable Plan-mode state, independent from the runtime's todo-plan output. */
  planMode?: boolean;
  /** The latest complete submitted plan, if the conversation has one. */
  planDocument?: PlanDocument | null;
  /**
   * Where the account stood the last time the provider said anything about it.
   *
   * Optional so a snapshot from a server that predates this reads as "nobody
   * has said", which is exactly what the status panel then shows. A latest
   * value rather than a history, so it survives a rejoin the way the
   * capabilities do — the log's replay window is short and a five-hour window
   * announced at the top of a long conversation would otherwise fall off it.
   */
  limits?: AccountLimits;
  pendingPermissions: PermissionRequest[];
  /**
   * Questions still waiting on an answer.
   *
   * Optional for the same reason `queued` is: a snapshot replayed by a server
   * that predates this should read as "none pending", not as malformed.
   */
  pendingQuestions?: QuestionRequest[];
  /**
   * Answered structured handoffs whose internal continuation has not reached a
   * terminal record yet. Server-internal, but carried by the shared snapshot
   * shape so recovery uses the same replay contract as every other chat fact.
   */
  pendingQuestionContinuations?: QuestionContinuation[];
  /**
   * Questions retained for history, including structured-response fallback
   * questions that have no tool block to own their answered card.
   */
  questionHistory?: QuestionRequest[];
  /**
   * Answers already given, keyed by the tool call that asked — falling back to
   * the request id when there was no call to pair with, exactly as the reducer
   * keys them.
   *
   * An answered question is left in the conversation precisely so that
   * scrolling back past a decision shows the decision, and the card can only
   * draw the marks if the snapshot carries them. Without this the answer
   * survived in the log and was thrown away at the join, so every rejoin —
   * a tab switch, a reload, a reconnect, a second browser — redrew every
   * answered question as one nobody had ever answered (#113).
   *
   * Optional for the same reason `pendingQuestions` is: a snapshot from a
   * server that predates this should read as "none known", not as malformed.
   */
  answeredQuestions?: Record<string, string[]>;
  /**
   * Which of those were never anybody's to answer, keyed the same way.
   *
   * Carried across the join for the same reason the answers are: a card the
   * agent gave up on says so, and a rejoin that dropped this fact would redraw
   * it as a question its user had skipped.
   */
  abandonedQuestions?: Record<string, true>;
  /**
   * What was typed for the questions answered in the user's own words, keyed
   * the same way `answeredQuestions` is.
   *
   * Separate from that map rather than squeezed into it because the two are
   * different kinds of thing — ids the question offered, versus the sentence
   * the user wrote — and a card that showed a typed answer as a tick against
   * an option nobody picked would be inventing a selection.
   */
  answeredQuestionText?: Record<string, string>;
  /**
   * Turns typed ahead, still waiting. Optional so a snapshot replayed from the
   * store — which knows nothing about a live process — is not obliged to
   * invent one; the session fills it in.
   */
  queued?: QueuedTurn[];
  /** Lowest seq still on disk; below this the log has been trimmed. */
  firstSeq: number;
  /**
   * Lowest seq actually folded into `messages`.
   *
   * A snapshot replays only the tail of a long session, so `firstSeq` alone
   * cannot tell a client whether there is anything above what it was given —
   * and comparing it against zero says "yes" for every session ever created,
   * because seq numbering starts at one. This is the honest floor: there is
   * more to page in exactly when `firstSeq < replayFrom`.
   *
   * Optional so a client can tell a server that predates it apart from one
   * reporting a fully-replayed session, and default to offering no paging.
   */
  replayFrom?: number;
  /**
   * The turn still open where the replay ended, or null when none is.
   *
   * A snapshot is a window, and a browser that joins mid-turn has to know which
   * turn the next event belongs to. Without it the first message to arrive
   * after the join opens a turn of its own under the runtime's id — a row in
   * the index with no prompt to name it by, spinning next to the turn it is
   * actually part of.
   *
   * Optional so a snapshot from a server that predates it reads as "nothing
   * open", which is the behaviour this replaces rather than a wrong claim.
   */
  currentTurnId?: string | null;
  /** Highest seq written. */
  cursor: number;
  /** True when the runtime process is alive. */
  live: boolean;
  /**
   * The runtime's own id for this conversation, when one was recorded.
   *
   * Only interesting alongside `live: false`, where it is the difference
   * between offering to *continue* the conversation on screen and offering
   * only to start over: with it the agent comes back knowing what was said,
   * without it a restart is a stranger reading someone else's transcript.
   */
  nativeSessionId?: string;
  /**
   * The reasoning-effort level the runtime last reported, when it reported one.
   *
   * Replayed like everything else here, and needed for the same reason the
   * transcript keeps it at all: an `effort` event is the runtime describing
   * itself, and a browser rejoining a live conversation has no other way to
   * learn what it is thinking at. Without it, a reload of a codex session that
   * opened at `xhigh` — and is still running at `xhigh` — showed the control
   * blank, because the conversation had never *chosen* a level and so the record
   * had nothing to send either.
   *
   * Optional so a snapshot written before this existed reads as "nobody said",
   * which is exactly what it is.
   */
  effort?: string;
  bypassPermissions: boolean;
}

