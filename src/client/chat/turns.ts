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
  /** 1-based display number. */
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
 * A turn starts at every `role === 'user'` message and ends before the next one.
 * Messages that arrive before the first user turn — a resumed transcript's tail,
 * a compaction marker, a system notice — are a turn of their own rather than
 * being dropped: they are on screen, so they need a strip and an index row like
 * everything else.
 *
 * `chatState` only ever decides the *last* turn's status. An earlier turn cannot
 * be the one that is running, and reading a session-level state onto all of them
 * is how every row in the index ends up spinning at once.
 */
export function groupTurns(messages: ChatMessage[], chatState: ChatState): TurnSummary[] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || groups.length === 0) groups.push([]);
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

  // A session that is gone cannot be running anything, whatever the transcript
  // still says. A message left mid-stream by a runtime that died stays flagged
  // streaming forever — reopening that conversation used to show a turn
  // spinning on a process that ended hours ago.
  const dead = chatState === 'error' || chatState === 'exited';

  const status: TurnStatus = isLast
    && (chatState === 'awaiting_permission' || chatState === 'awaiting_answer')
    ? 'waiting'
    : isLast && !dead
      && (streaming || chatState === 'thinking' || chatState === 'running' || chatState === 'starting')
      ? 'running'
      : endedAs(outcome, diedOn, isLast, chatState);

  const elapsed = lastTs - (opener?.ts ?? lastTs);

  return {
    id: opener ? opener.id : `turn-${index}`,
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

/** The first line of the user's ask, or the best stand-in the group offers. */
function labelFor(group: ChatMessage[]): string {
  const opener = group[0];
  if (opener && opener.role === 'user') {
    const text = firstText(opener);
    if (text) return text;
    // An attachments-only turn still opened one and still needs a name.
    const image = opener.blocks.find((block) => block.kind === 'image');
    if (image) return 'attachment';
  }
  for (const message of group) {
    const text = firstText(message);
    if (text) return text;
  }
  return 'transcript';
}

function firstText(message: ChatMessage): string {
  for (const block of message.blocks) {
    if (block.kind === 'text' && block.text.trim()) {
      return block.text.trim().split('\n')[0].trim();
    }
    if (block.kind === 'notice') return block.text;
  }
  return '';
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
export function formatTurnMeta(turn: TurnSummary): TurnMeta {
  const out = turn.usage.outputTokens;
  return {
    tools: turn.toolCount ? `${turn.toolCount} tool${turn.toolCount === 1 ? '' : 's'}` : '',
    reasoning: turn.reasoningCount ? `${turn.reasoningCount} reasoning` : '',
    duration: turn.durationMs === undefined ? '' : formatDuration(turn.durationMs),
    cost: turn.usage.costUsd === undefined ? '' : `$${turn.usage.costUsd.toFixed(4)}`,
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
