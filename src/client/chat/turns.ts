/**
 * The conversation, grouped into turns.
 *
 * A turn is one thing the user asked for and everything the agent did about it.
 * The transcript is a flat list of messages, which is the right shape to stream
 * into and the wrong shape to navigate: "the twelfth thing I asked" is a unit
 * the user thinks in and the message list has no name for.
 *
 * Pure functions over the reducer's own types — no DOM, no React, no transcript
 * object — so the turn index, the sticky strip and the timeline all read the
 * same answer and the whole thing is unit-testable.
 */

import {
  ChatMessage,
  ChatState,
  ChatUsage,
  mergeUsage,
} from '../../shared/chat-events.js';
import { TurnOutcome } from '../../shared/turn-outcome.js';
import { compactCount, formatDuration } from './tool-meta.js';

/**
 * What a turn's badge says.
 *
 * `done` and `failed` are the two ways a turn can have *ended* — see
 * `TurnOutcome`, which is where that judgement is made from the runtime's own
 * word for it. The other two are states of a turn still in flight and belong to
 * the session, not to the turn's history.
 */
export type TurnStatus = TurnOutcome | 'running' | 'waiting';

/** One glyph per status, shared by every surface that shows a turn's outcome. */
export const STATUS_GLYPH: Record<TurnStatus, { icon: string; color: string; spin?: boolean; word: string }> = {
  done: { icon: 'check', color: 'var(--success)', word: 'done' },
  failed: { icon: 'circle-x', color: 'var(--destructive)', word: 'failed' },
  waiting: { icon: 'shield', color: 'var(--warning)', word: 'waiting for you' },
  running: { icon: 'loader-circle', color: 'var(--info)', spin: true, word: 'running' },
};

export interface TurnSummary {
  /** Id of the message that opened the turn — the user's, where there is one. */
  id: string;
  /**
   * The turn's own id, as the session stamped it.
   *
   * What the recorded conversation is matched on, and it has to be: a turn only
   * half loaded opens on whatever message the replay reached first, which is
   * routinely the agent's rather than the user's, so the opening *message* id is
   * not stable enough to identify a turn by.
   */
  turnId: string;
  /**
   * 1-based number of this turn in the conversation.
   *
   * The conversation's, not the loaded window's — see `reconcileTurns`. A
   * browser holding the last turn of forty-nine says 49.
   */
  index: number;
  /** First line of the user's text, trimmed. */
  label: string;
  status: TurnStatus;
  startedAt: number;
  durationMs?: number;
  toolCount: number;
  /**
   * How many tool calls inside the turn ended failed.
   *
   * Reported and never acted on. It is the count the badge used to be computed
   * from, kept as a number so a surface can say "3 of these steps failed" next
   * to the steps themselves, which is where a failed step belongs.
   */
  failedStepCount: number;
  reasoningCount: number;
  /** Summed over every message in the turn. */
  usage: ChatUsage;
  messageIds: string[];
}

/**
 * Split messages into turns.
 *
 * **By `turnId`, not by user message.** The turn id is minted where the work is
 * accepted and stamped on every message the turn produced, so grouping on it
 * gives the same turns the accounting recorded — which is the whole of #86: the
 * count beside a conversation and the count in the statistics were two different
 * readings of two different things, and neither could be checked against the
 * other. A user message that shares the turn in progress is a steer: it was
 * delivered into that work, so it belongs to it and does not open a turn.
 *
 * Only a request opens one, too. An agent that ends a turn waiting on something
 * — a build, a check, a job it left running — and picks the same work back up
 * when that finishes is still in the turn it was working on: nobody asked a
 * second question. See `openTurnAfter`, which is where the ids are decided.
 *
 * Messages that arrive before the first user turn — a resumed transcript's tail,
 * a compaction marker, a system notice — carry turn ids of their own and group
 * by the same rule. They are on screen, so they need a strip and an index row
 * like everything else.
 *
 * Consecutive-only: a turn id that reappears after another turn has intervened
 * opens a second group rather than reaching back into the first. Runtimes that
 * number their turns from a counter restarting with every process reuse `t1`
 * within one conversation, and merging across the gap would fold two unrelated
 * pieces of work into one row of the index.
 *
 * `chatState` only ever decides the *last* turn's status. An earlier turn cannot
 * be the one that is running, and reading a session-level state onto all of them
 * is how every row in the index ends up spinning at once.
 */
export function groupTurns(messages: ChatMessage[], chatState: ChatState): TurnSummary[] {
  const groups: ChatMessage[][] = [];
  let openTurnId: string | undefined;
  for (const message of messages) {
    if (groups.length === 0 || message.turnId !== openTurnId) {
      groups.push([]);
      openTurnId = message.turnId;
    }
    groups[groups.length - 1].push(message);
  }

  const turns: TurnSummary[] = [];
  groups.forEach((group, i) => {
    const last = i === groups.length - 1;
    turns.push(summarise(group, i + 1, last, chatState));
  });

  return turns;
}

function summarise(
  group: ChatMessage[],
  index: number,
  isLast: boolean,
  chatState: ChatState,
): TurnSummary {
  const opener = group[0];
  let toolCount = 0;
  let reasoningCount = 0;
  let failedSteps = 0;
  let diedOn = false;
  let outcome: TurnOutcome | undefined;
  let streaming = false;
  let usage: ChatUsage = {};
  let lastTs = opener?.ts ?? 0;

  for (const message of group) {
    if (message.streaming) streaming = true;
    if (message.usage) usage = mergeUsage(usage, message.usage);
    // The last word wins: a group split at user messages normally holds one
    // turn, but the tail of a resumed transcript can hold several, and the one
    // that ended last is the one the badge is about.
    if (message.turnOutcome) outcome = message.turnOutcome;
    if (message.ts > lastTs) lastTs = message.ts;
    for (const block of message.blocks) {
      if (block.kind === 'tool') {
        toolCount += 1;
        // Counted, not promoted. A failed step stays visible on the step —
        // this is only here so the turn can say how many there were, never so
        // it can call itself failed because of them.
        if (block.status === 'failed') failedSteps += 1;
        if (block.durationMs !== undefined) {
          // The runtime's own timings beat wall-clock between message stamps,
          // which include however long the user spent reading.
          lastTs = Math.max(lastTs, message.ts + block.durationMs);
        }
      } else if (block.kind === 'thinking') {
        reasoningCount += 1;
      } else if (block.kind === 'error' && block.fatal) {
        // Only the fatal ones. An error the agent read and worked around is a
        // step, and a step is not a verdict; this one is the runtime saying it
        // could go no further, which is a turn that never reached a `turn_end`.
        diedOn = true;
      }
    }
  }

  // The session decides, not the message flags. A message left mid-stream stays
  // flagged streaming forever — by a runtime that died, by a `msg_end` that was
  // lost, by a window that was cut before it arrived — and a turn read off that
  // flag alone spins on work that finished hours ago.
  //
  // So `streaming` is only ever corroboration: it can say a turn is running
  // while the session is *between* its own state events, and it can say nothing
  // at all once the session has settled. Idle is settled — every adapter says
  // so as it ends a turn — and so are the two ways a session ends.
  const settled = chatState === 'idle' || chatState === 'error' || chatState === 'exited';

  const status: TurnStatus = isLast
    && (chatState === 'awaiting_permission' || chatState === 'awaiting_answer')
    ? 'waiting'
    : isLast && !settled
      && (streaming || chatState === 'thinking' || chatState === 'running' || chatState === 'starting')
      ? 'running'
      : endedAs(outcome, diedOn, isLast, chatState);

  const elapsed = lastTs - (opener?.ts ?? lastTs);

  return {
    id: opener ? opener.id : `turn-${index}`,
    turnId: opener ? opener.turnId : `turn-${index}`,
    index,
    label: labelFor(group),
    status,
    startedAt: opener?.ts ?? 0,
    // Only when the turn is over: a running turn's "duration so far" would be
    // frozen at whatever the last event happened to stamp, which reads as a
    // finished number and is not one.
    durationMs: status === 'running' || elapsed <= 0 ? undefined : elapsed,
    toolCount,
    failedStepCount: failedSteps,
    reasoningCount,
    usage,
    messageIds: group.map((message) => message.id),
  };
}

/**
 * How a turn that is no longer in flight should read.
 *
 * In order of authority:
 *
 *   1. What the runtime said when it ended the turn. This is the only statement
 *      any of them makes about the turn as a whole, so it wins outright —
 *      including over a fatal error that arrived afterwards, which is what a
 *      one-shot CLI exiting *after* it answered looks like from here.
 *   2. An error the agent could not get past, when no `turn_end` ever arrived.
 *      A runtime whose process goes mid-turn never sends one.
 *   3. The session having died, for the turn that was open when it did. Only
 *      the last turn can be that one.
 *
 * Everything else is `done`. A turn that ran to completion succeeded, whatever
 * happened inside it and whatever the answer turned out to say — reading an
 * answer's meaning is not something a badge can do honestly.
 */
function endedAs(
  outcome: TurnOutcome | undefined,
  diedOn: boolean,
  isLast: boolean,
  chatState: ChatState,
): TurnStatus {
  if (outcome) return outcome;
  if (diedOn) return 'failed';
  if (isLast && (chatState === 'error' || chatState === 'exited')) return 'failed';
  return 'done';
}

/**
 * The first line of the user's ask — and nothing else, ever.
 *
 * The index is scanned for the one thing the reader remembers, which is what
 * they asked. An entry titled with something the model said is not merely
 * unhelpful, it is unsearchable by the only key anybody has, and it was what a
 * turn ended up carrying whenever the user's own text was not the first text the
 * group offered (#86). So a turn with no prompt behind it says so plainly rather
 * than borrowing a sentence from the answer.
 *
 * Any user message in the group will do, not just the opener: a steer is a user
 * message inside a turn it did not open, and a turn whose opener carried only
 * attachments is better named by the words that came with them than by the word
 * "attachment".
 */
function labelFor(group: ChatMessage[]): string {
  for (const message of group) {
    if (message.role !== 'user') continue;
    const text = firstText(message);
    if (text) return text;
  }
  // An attachments-only turn still opened one and still needs a name.
  const attached = group.some(
    (message) => message.role === 'user' && message.blocks.some((block) => block.kind === 'image'),
  );
  if (attached) return 'attachment';

  // A notice is the app's own word for what happened — a compaction, a fresh
  // start — and naming a turn with one is not the thing being prohibited here.
  // What may never title a turn is the *model's* output, which is why this
  // reads notices only and only off messages the model did not write.
  for (const message of group) {
    if (message.role === 'assistant') continue;
    for (const block of message.blocks) {
      if (block.kind === 'notice' && block.text.trim()) return block.text;
    }
  }

  return NO_PROMPT_LABEL;
}

/**
 * What a turn with no user prompt is called.
 *
 * These are real: the tail of a resumed conversation, a compaction marker, a
 * system notice. They are on screen and need a row, and naming them for what
 * they are keeps the index honest — every other row is a quotation of something
 * the reader typed, and this one visibly is not.
 */
export const NO_PROMPT_LABEL = 'no prompt';

function firstText(message: ChatMessage): string {
  for (const block of message.blocks) {
    if (block.kind === 'text' && block.text.trim()) {
      return block.text.trim().split('\n')[0].trim();
    }
    if (block.kind === 'notice') return block.text;
  }
  return '';
}

/**
 * What the recorded conversation says about one turn. See `ChatTurnIndexEntry`.
 *
 * Structural rather than the imported type so this file stays free of the wire
 * vocabulary, and so a caller with no index at all can pass an empty list.
 */
export interface RecordedTurn {
  id: string;
  turnId: string;
  index: number;
  label: string | null;
  outcome: TurnOutcome | null;
}

/**
 * What each finished turn cost, by turn id.
 *
 * Taken from the accounting rather than added up from the messages on screen,
 * and it has to be: the money is only reported per turn by some runtimes, while
 * the rest report a running total that has to be differenced against where the
 * turn began. That is the accountant's job and it has already done it. Adding
 * up what a browser happens to hold would also mean a turn's cost changed with
 * how much of it had been scrolled into view.
 */
export type TurnSpend = ReadonlyMap<string, ChatUsage>;

/**
 * Number and name the loaded turns from the conversation they belong to.
 *
 * A browser holds a window, not a conversation, and everything derived from
 * that window inherits its edges. Numbering was one of them: a reload landed on
 * the last turn of forty-nine and called it "Turn 1", and it stayed 1 until
 * enough history had been paged in for the count to be right by accident. The
 * number is a fact about the conversation, so it is read from the conversation.
 *
 * Labels come back the same way. A turn only half loaded opens on whatever
 * message the replay reached first — routinely the agent's — so it has no user
 * text in the window to be named from and read as "no prompt" beside a question
 * that was asked perfectly clearly, and is still on file.
 *
 * Matched on `turnId` for the same reason: the opening *message* of a partly
 * loaded turn is not the message that opened it.
 *
 * With no recorded index — it has not arrived yet, or the server is older than
 * this page — the turns are returned exactly as they came, which is the
 * positional numbering this has always had.
 */
export function reconcileTurns(
  turns: TurnSummary[],
  recorded: ReadonlyArray<RecordedTurn> | null,
  spend?: TurnSpend,
): TurnSummary[] {
  if (!recorded || recorded.length === 0) {
    return spend && spend.size > 0 ? turns.map((turn) => withSpend(turn, spend)) : turns;
  }
  const byTurnId = new Map(recorded.map((turn) => [turn.turnId, turn]));
  const filed = turns.map((turn) => byTurnId.get(turn.turnId));

  // Turns the index has not heard of are the ones that happened since it was
  // fetched — the turn being typed into, most of all. They continue from
  // whatever came before them rather than restarting at 1.
  //
  // Including the ones the window holds *above* the first turn the recording
  // names: those count back from it. Anything else numbers a turn by its
  // position in this array, and that position is a fact about how much of the
  // conversation this browser happens to hold — it put a turn numbered 1
  // directly above turn 4,001 in a conversation long enough for the head of its
  // log to have been trimmed, which is the one place the number matters.
  const first = filed.findIndex(Boolean);
  const firstIndex = first >= 0 ? (filed[first] as RecordedTurn).index : 0;
  let next = 0;
  return turns.map((turn, at) => {
    const known = filed[at];
    // Above the first turn the recording names, count back from it and floor at
    // 1. Counting *forward* from a floored anchor is what put 1,2,3 above a
    // turn the recording calls 2: numbers repeated and then running backwards
    // in a list that reads by number. Clamped per turn, the crowding all lands
    // on 1, which is the honest shape of "we know these came first and no more
    // than that".
    const index = known
      ? known.index
      : at < first
        ? Math.max(1, firstIndex - (first - at))
        : next + 1;
    next = index;
    // The live label wins only where the recording has none: a turn still being
    // typed is not in the index yet, and one recorded without a prompt did not
    // have one.
    const label = known?.label ?? (turn.label === NO_PROMPT_LABEL ? NO_PROMPT_LABEL : turn.label);
    const same = index === turn.index && label === turn.label;
    return withSpend(same ? turn : { ...turn, index, label }, spend);
  });
}

/**
 * Put the recorded bill on a turn, keeping what the messages already say.
 *
 * Merged rather than replaced: the tokens on the messages are live and arrive
 * as the turn runs, while the money only exists once the turn has ended and the
 * accounting has filed it. The filed figures win where they exist, because they
 * are the ones the dashboard shows.
 */
function withSpend(turn: TurnSummary, spend?: TurnSpend): TurnSummary {
  const recorded = spend?.get(turn.turnId);
  if (!recorded) return turn;
  return { ...turn, usage: mergeUsage(turn.usage, recorded) };
}

/**
 * One row of the index beside a conversation.
 *
 * Less than a `TurnSummary` on purpose: most of a conversation is not loaded,
 * and the index still has to list all of it. Everything here can be answered
 * from the recorded log — a number, what was asked, how it ended — while tool
 * counts, durations and spend need the messages and stay on `TurnSummary`.
 */
export interface TurnIndexRow {
  /**
   * What selecting the row goes to: the opening message, as loaded where the
   * turn is loaded and as recorded where it is not — which is also the message
   * paging back has to reach, so one field says both.
   */
  id: string;
  index: number;
  label: string;
  status: TurnStatus;
  /** False when the turn is recorded but not held by this browser yet. */
  loaded: boolean;
  /**
   * What this turn cost, or undefined where nothing was recorded for it — a
   * turn still running, or a runtime that reports no money at all. Undefined is
   * not zero and the row says so by showing nothing.
   */
  costUsd?: number;
}

/**
 * The conversation's whole run of turns: what was recorded, corrected by what
 * is live.
 *
 * The recorded list is the spine, because it is the only one that reaches back
 * to the first turn however little has been loaded (#86). The live turns are
 * laid over it for two things the log cannot answer: the status of a turn still
 * running, and turns that have happened since the list was fetched — which is
 * always at least the one being typed into.
 *
 * With no recorded list — an old server, a store that failed — this degrades to
 * exactly what the index showed before, rather than to nothing.
 */
export function turnIndexRows(
  recorded: ReadonlyArray<RecordedTurn> | null,
  live: TurnSummary[],
  spend?: TurnSpend,
): TurnIndexRow[] {
  const byTurnId = new Map(live.map((turn) => [turn.turnId, turn]));
  const rows: TurnIndexRow[] = [];
  const seen = new Set<string>();

  for (const turn of recorded ?? []) {
    seen.add(turn.turnId);
    const loaded = byTurnId.get(turn.turnId);
    rows.push({
      // The loaded turn's opening message where there is one: a turn cut off by
      // the loading window opens on a different message than the recording says,
      // and scrolling to a message this browser does not have goes nowhere.
      id: loaded ? loaded.id : turn.id,
      index: turn.index,
      label: turn.label ?? loaded?.label ?? NO_PROMPT_LABEL,
      status: loaded ? loaded.status : turn.outcome ?? 'done',
      loaded: Boolean(loaded),
      costUsd: spend?.get(turn.turnId)?.costUsd,
    });
  }

  for (const turn of live) {
    if (seen.has(turn.turnId)) continue;
    rows.push({
      id: turn.id,
      index: turn.index,
      label: turn.label,
      status: turn.status,
      loaded: true,
      costUsd: spend?.get(turn.turnId)?.costUsd ?? turn.usage.costUsd,
    });
  }
  // Live turns the recording has not heard of are appended, and they are almost
  // always the newest ones — but not necessarily: a window that reaches above
  // the first turn the recording names holds turns that belong at the *top*,
  // and one of those tacked onto the end reads as the newest turn in the
  // conversation. The number says where each row goes, so it decides.
  return rows.sort((a, b) => a.index - b.index);
}

export function turnOf(messageId: string, turns: TurnSummary[]): TurnSummary | undefined {
  return turns.find((turn) => turn.messageIds.includes(messageId));
}

/**
 * Whether a turn's contents should be shown, folded history vs. the one in
 * progress.
 *
 * The default is "only the newest turn is open" — an unset entry in
 * `overrides` reads as that default rather than as closed, which is what
 * makes a brand-new turn open itself and everything before it fold without
 * either one needing its own entry written first. An override, once made,
 * wins regardless of which turn is newest — that persistence is what stops
 * the next turn starting from slamming shut something the user deliberately
 * opened.
 */
export function isTurnOpen(
  turnId: string,
  lastTurnId: string,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const override = overrides.get(turnId);
  return override === undefined ? turnId === lastTurnId : override;
}

export interface TurnMeta {
  tools: string;
  reasoning: string;
  duration: string;
  cost: string;
  tokens: string;
}

/**
 * The strip's right-hand group, as strings.
 *
 * Empty rather than zero: "0 tools" is a fact nobody needed, and every one of
 * these sits on a 28px row that has to hold a number without wrapping.
 */
/**
 * A turn's bill, as short as it can be without lying about it.
 *
 * Two decimals once there are two worth showing, and four below a cent — a turn
 * that cost $0.0031 is not a turn that cost nothing, and rounding it to "$0.00"
 * would say it was. Zero stays "$0", which is a figure a runtime actually
 * reported; a turn nobody measured shows nothing at all rather than a zero,
 * which is decided by the caller, not here.
 */
export function formatTurnCost(costUsd: number): string {
  if (costUsd === 0) return '$0';
  if (costUsd >= 0.01) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(4)}`;
}

export function formatTurnMeta(turn: TurnSummary): TurnMeta {
  const out = turn.usage.outputTokens;
  return {
    tools: turn.toolCount ? `${turn.toolCount} tool${turn.toolCount === 1 ? '' : 's'}` : '',
    reasoning: turn.reasoningCount ? `${turn.reasoningCount} reasoning` : '',
    duration: turn.durationMs === undefined ? '' : formatDuration(turn.durationMs),
    cost: turn.usage.costUsd === undefined ? '' : formatTurnCost(turn.usage.costUsd),
    tokens: out === undefined ? '' : `${compactCount(out)} out`,
  };
}

/** Clock time of a turn's opening message, in the viewer's locale. */
export function turnTime(turn: TurnSummary): string {
  if (!turn.startedAt) return '';
  const date = new Date(turn.startedAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
