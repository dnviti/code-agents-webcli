import type { ChatRole } from './core.js';
import type { ChatBlock } from './chat-block.js';
import type { ChatUsage } from './usage.js';
import type { TurnOutcome } from '../turn-outcome.js';
import type { BuiltInWorkflowId } from './workflow.js';
/** A message as the reducer assembles it. */
/**
 * One turn as the recorded conversation has it, for the index beside it.
 *
 * Sent whole rather than paged: it is the index of the conversation, and an
 * index that begins where the last page happened to stop is not one (#86).
 * Thin enough that "whole" stays cheap — a turn contributes one line of it.
 */
export interface ChatTurnIndexEntry {
  /** The opening message's id, which is what a client scrolls to. */
  id: string;
  turnId: string;
  /** 1-based over the whole conversation, not over what is loaded. */
  index: number;
  /**
   * Where this turn opens in the log, so a reader can cut the conversation at
   * it — which is what branching from a turn needs and nothing else has.
   *
   * Optional because it rides on the wire: a browser talking to a server that
   * predates it must read "not stated" rather than zero, which would name the
   * head of the log as every turn's start.
   */
  startSeq?: number;
  /** The user's first line, or null for a turn nobody prompted. */
  label: string | null;
  startedAt: number;
  /** How the turn ended, or null while it is still running. */
  outcome: TurnOutcome | null;
  /**
   * What this one turn cost, as the accounting recorded it.
   *
   * From the accounting rather than added up from the messages, because the
   * money cannot be added up from the messages: half the runtimes here report a
   * running total rather than a per-turn figure, and turning that into "what
   * this turn cost" means taking the difference against where the turn started
   * — which is what the accountant did when it filed the row this reads back.
   * Taking it from the same place is also the only way the figure beside a turn
   * and the figure on the dashboard can be relied on to agree.
   *
   * Absent for a turn still running, and for one whose runtime reported
   * nothing — which is a different thing from zero, and says so on screen.
   */
  usage?: ChatUsage;
}

export interface ChatMessage {
  id: string;
  /** Monotonic per session. Orders messages and anchors history paging. */
  seq: number;
  turnId: string;
  role: ChatRole;
  ts: number;
  blocks: ChatBlock[];
  /** Set once the message completes. */
  stopReason?: string;
  /**
   * How the turn this message belongs to ended, stamped at `turn_end`.
   *
   * On the messages rather than beside the transcript because the messages are
   * what survives: a browser rebuilds a conversation from `ChatSnapshot`, which
   * carries the message list and the session's own fields and nothing else, and
   * history paging prepends messages alone. Absent means the turn has not ended
   * — which is a different thing from a turn that ended without saying why, and
   * the reason this is an outcome and not a raw stop reason.
   */
  turnOutcome?: TurnOutcome;
  usage?: ChatUsage;
  /** Model that produced this message, when reported. */
  model?: string;
  /**
   * App-owned workflow that produced this user turn.
   *
   * Kept as metadata so retry can restore the runtime-only guidance without
   * putting a slash invocation or the bundled instructions in the transcript.
   */
  workflow?: BuiltInWorkflowId;
  /** True while the runtime is still appending to this message. */
  streaming?: boolean;
  /**
   * Set on a user message delivered into the turn that was already running.
   *
   * It shares that turn's `turnId`, so it is grouped into it rather than
   * starting one — see the event of the same name.
   */
  steer?: true;
}

