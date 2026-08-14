import { BuiltInWorkflowId, ChatEvent } from '../../../shared/chat-events.js';

export interface PlanActionFeedback {
  action: 'accept' | 'reject' | 'mode';
  revision?: number;
  accepted?: boolean;
  changed?: boolean;
  message: string;
}

export interface ChatControllerOptions {
  /** `false` means an open socket did not carry this message. */
  send: (message: Record<string, unknown>) => boolean | void;
  /**
   * Whether the connected server advertised app-owned workflow admission.
   *
   * Registry-owned controllers always provide this explicitly. It remains
   * optional for isolated component/tests that do not have a socket handshake.
   */
  builtInWorkflows?: boolean;
  /** Called when the surface should redraw for a reason outside the transcript. */
  onChange?: () => void;
  /**
   * This browser's socket id, for telling its own composer edits apart from
   * another screen's.
   *
   * A function rather than a value: the id is handed out in the server's
   * `connected` message, so it does not exist when the controllers are built,
   * and it changes on every reconnect. Absent — or answering null — means every
   * arriving draft is treated as somebody else's, which is the safe way round:
   * the worst it costs is a caret put back where it was a moment ago, whereas
   * mistaking another screen's typing for your own echo loses it entirely.
   */
  origin?: () => string | null;
  /**
   * Called for each event this conversation actually applied.
   *
   * Not called for one the transcript rejected as a replay, which is what makes
   * it usable as an edge: a reconnect redelivers the tail of the log, and
   * anything hung off this must not fire again for what it already knows.
   */
  onEvent?: (event: ChatEvent) => void;
}

/**
 * A conversation whose process is gone, and what can be done about it.
 *
 * The server restarting is the ordinary way to arrive here: chat sessions live
 * in memory, transcripts live on disk, so the conversation outlives the thing
 * that was having it.
 */
export interface ChatUnavailable {
  message: string;
  /** What to call the runtime in the offer, e.g. "Claude". */
  runtimeLabel: string;
  /** True when the agent can be given its own context back. */
  canResume: boolean;
}

/**
 * What actually happened when this browser last asked to change the model.
 *
 * Mirrors the server's own honesty about it: a typed model name is never
 * validated ahead of time, so this reports what was actually possible rather
 * than assuming the best case.
 */
export interface ModelSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared';
  message: string;
}

/**
 * What actually happened when this browser last asked to change the effort level.
 *
 * One state more than the model has. A model name is free text and cannot be
 * judged before it is tried, but an effort level can: the control only offers
 * what the running runtime published, so a level that is not on that list did
 * not come from the control, and the server says `refused` and stores nothing
 * rather than carrying a bad value into every future launch.
 */
export interface EffortSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused';
  message: string;
}

/** The server accepted a built-in workflow for immediate delivery or its FIFO queue. */
export type BuiltInWorkflowStartResult = 'accepted' | 'queued';

export interface PendingBuiltInWorkflow {
  workflow: BuiltInWorkflowId;
  resolve: (result: BuiltInWorkflowStartResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingQuestionAnswer {
  requestId: string;
  resolve: (accepted: boolean) => void;
}

/**
 * What happened to a jump to a message the browser did not hold.
 *
 * Three answers rather than a boolean, because the caller says something
 * different about each: `arrived` scrolls, `exhausted` has to admit the turn is
 * not on disk any more, and `abandoned` says nothing at all — the user has
 * already gone somewhere else, and a notice about the journey they left is
 * noise about a decision they made.
 */
/**
 * How a jump ended.
 *
 * `exhausted` and `unreachable` are kept apart because they want different
 * words on screen: the first is the log genuinely not holding that turn any
 * more, the second is a read that failed or timed out, which says nothing about
 * whether the turn is there. Telling a user their turn is gone because one
 * page did not come back is a wrong answer given confidently, and on a slow
 * link a long walk has a hundred chances to hit it.
 */
export type SeekOutcome = 'arrived' | 'exhausted' | 'unreachable' | 'abandoned';
