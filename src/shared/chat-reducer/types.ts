import {
  AccountLimits,
  ChatCapabilities,
  ChatMessage,
  ChatState,
  ChatUsage,
  PermissionRequest,
  PlanItem,
  QuestionContinuation,
  QuestionRequest,
  ToolBlock,
} from '../chat-events.js';

export interface TranscriptState {
  messages: ChatMessage[];
  /** msgId -> index into `messages`. */
  index: Record<string, number>;
  /** toolId -> [message index, block index], so results find their call fast. */
  toolIndex: Record<string, [number, number]>;
  /**
   * Patches for tool calls we have not seen opened yet.
   *
   * Orderings differ between runtimes and a reconnect can deliver a result
   * before the call that produced it. Holding the patch costs nothing and
   * avoids dropping the output of a tool the user is watching.
   */
  orphanToolPatches: Record<string, Partial<ToolBlock>>;
  state: ChatState;
  capabilities: ChatCapabilities;
  usage: ChatUsage;
  plan: PlanItem[];
  pendingPermissions: PermissionRequest[];
  /**
   * Questions the model asked that nobody has answered yet.
   *
   * Held beside the transcript rather than inside a message because a question
   * outlives the block that asked it: the agent stays blocked across a reload,
   * and this is what a rejoining browser reads to know there is still a card to
   * draw. The record of what was *asked and answered* lives in the tool block,
   * which is where scrolling back finds it.
   */
  pendingQuestions: QuestionRequest[];
  /** Durable answered-handoff outbox, keyed by its stable dispatch id. */
  pendingQuestionContinuations: Record<string, QuestionContinuation>;
  /**
   * Every question event still retained in the loaded log, including resolved
   * questions with no tool block from which a historical card could be rebuilt.
   */
  questionHistory: QuestionRequest[];
  /**
   * Answers already given, keyed by the tool call that asked.
   *
   * Keyed on `toolId` rather than `requestId` because the card that needs it is
   * drawn from a tool block, and by the time it asks, the request — the only
   * thing that knew both ids — has been dropped from the pending list. Falls
   * back to the request id for a question that could not be correlated to a
   * call, which is answered from the pinned card instead.
   */
  answeredQuestions: Record<string, string[]>;
  /**
   * What was typed for the questions answered in the user's own words, keyed
   * exactly as `answeredQuestions` is.
   *
   * Its own map rather than a sentinel id in that one, because the ids there
   * are checked against the options the question offered — a typed answer
   * belongs to none of them, and giving it one would put a tick on a choice
   * nobody made.
   */
  answeredQuestionText: Record<string, string>;
  /**
   * Questions nobody was given the chance to answer, keyed exactly as
   * `answeredQuestions` is.
   *
   * Its own map for the same reason the text has one: an empty list of picks
   * already means "skipped", and a card the agent stopped waiting for is not a
   * card its user declined. The card reads this to stop offering buttons that
   * would send an answer nowhere.
   */
  abandonedQuestions: Record<string, true>;
  /** Lowest seq present. Non-zero once the log head has been trimmed. */
  firstSeq: number;
  /** Highest seq applied. Events at or below this are ignored as replays. */
  cursor: number;
  currentTurnId: string | null;
  nativeSessionId?: string;
  model?: string;
  /**
   * Every model the last turn was billed to, when the runtime broke it down.
   *
   * Beside `model` rather than replacing it: `model` is what to call the
   * conversation, and stays the model that answered. This is the honest
   * remainder — a subagent on another model, a fallback — which the header
   * shows as a count rather than pretending the turn ran on one thing.
   */
  turnModels?: string[];
  /**
   * The reasoning-effort level the runtime last said it was running.
   *
   * Only ever set from an `effort` event, which only ever carries something a
   * runtime reported. Absent means nobody has said — which is not the same as
   * "the default", and the control is careful to show the difference.
   */
  effort?: string;
  /**
   * Where the provider last said this account stands.
   *
   * Only ever set from a `limits` event, which only ever carries something a
   * runtime reported about itself. Absent means nobody has said — which the
   * status panel states in a sentence rather than drawing a bar against a
   * number it made up, the way it used to (#137).
   */
  limits?: AccountLimits;
  lastError?: string;
}

/** What an apply touched, so a renderer can avoid redrawing the whole list. */
export interface TranscriptChange {
  /** Index of the single message that changed, when exactly one did. */
  messageIndex: number | null;
  /** True when the message list itself grew or shrank. */
  structural: boolean;
  /** True when session-level fields (state, usage, plan, permissions) changed. */
  meta: boolean;
  /** False when the event was a replay below the cursor and nothing happened. */
  applied: boolean;
}

export const NO_CHANGE: TranscriptChange = {
  messageIndex: null,
  structural: false,
  meta: false,
  applied: false,
};
