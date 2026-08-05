import {
  ChatEvent,
  ChatMessage,
  ChatUsage,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { applyChatEvent, createTranscript } from '../../shared/chat-reducer.js';
import { TurnCut } from './store.js';

/**
 * Starting a new conversation from a turn of an old one.
 *
 * Issue #34 asked for this beside copy-a-turn, and none of the six runtimes has
 * anything to build it out of: not one of their CLIs can fork a session at a
 * point, which is why every adapter here declares `fork: false` and still does.
 * So a branch is not a runtime feature borrowed — it is two things this app can
 * do for itself.
 *
 * The first is the transcript: the events up to and including that turn are
 * copied into the new conversation's own log, so the history is there to read.
 * The second is the part that makes it a branch rather than a screenshot — the
 * same history is handed to the agent as the opening context of its first turn,
 * so the first thing asked of it is answered by something that knows what came
 * before.
 *
 * Two claims this file is careful not to make. The agent is told plainly that
 * it is reading a record of a conversation it was not in, because an agent led
 * to believe it had said those things would answer for work it never did. And
 * the history reaches it *with* the user's first message rather than as a turn
 * of its own — a wall of quoted transcript standing in the conversation as the
 * user's own words would be the same lie pointed the other way.
 *
 * What is carried is a rendition, and it says so where the agent will read it:
 * every message as it was written, tool calls by name only, reasoning left out.
 * Carrying tool output would put the bulk of a working session into the opening
 * turn, and the whole conversation would then routinely fail to fit.
 */

/**
 * Event kinds that make up the record of what was said.
 *
 * Everything else describes the process that was serving the old conversation
 * rather than the conversation itself, and copying it would make the branch
 * claim things about itself that are not true — most sharply `session`, which
 * carries the runtime's own conversation id: a branch that inherited one would
 * offer to "resume with context" and hand a fresh agent the *source*
 * conversation, which is the opposite of a branch.
 *
 * `usage` goes for the same reason from the other direction: what the old
 * conversation spent is its bill, and a branch whose meter opened at nine
 * dollars would be charging a reader for somebody else's tokens.
 */
const CARRIED: ReadonlySet<string> = new Set([
  'msg_start',
  'block_start',
  'block_delta',
  'block_end',
  'msg_end',
  'tool',
  'agent_step',
  'agent_progress',
  'workflow_progress',
  // A workflow that failed, for the same reason its progress is carried: the
  // run happened, and a branch that replayed only the launch would show it as
  // done all over again — which is the bug #140 was about, reintroduced one
  // conversation along.
  'workflow_failed',
  'turn_end',
  'marker',
]);

/**
 * How much of a model's window the carried history may take.
 *
 * Half, because the other half is the work: a branch that fits and then leaves
 * the agent no room to answer in has not really fitted. Deliberately a share of
 * whatever the runtime reported rather than a token figure written here — the
 * windows in play differ by an order of magnitude and a constant would be wrong
 * for all of them.
 */
const CONTEXT_SHARE = 0.5;

/**
 * Characters per token, for sizing the carried history.
 *
 * An approximation and treated as one. Nothing in this app has a tokeniser for
 * six runtimes' worth of models, and getting one would mean shipping a
 * different one per vendor and keeping them current. Four characters is the
 * rule of thumb every one of these vendors publishes for English prose; code
 * runs denser, so this reads low on a code-heavy conversation, which is the
 * direction that lets one through rather than the direction that refuses one
 * wrongly. It is only ever used against a ceiling that is itself half a window.
 */
const CHARS_PER_TOKEN = 4;

export interface BranchPlan {
  /** The carried log, renumbered from one and closed with the branch rule. */
  events: ChatEvent[];
  /** What the agent is handed with the first thing the user says. */
  context: string;
  /** Turns carried, which is fewer than the branch turn's number if the log was trimmed. */
  turns: number;
  estimatedTokens: number;
  /** The window the estimate was measured against, when the runtime reported one. */
  contextWindow?: number;
  /** The ceiling that window allows the history. Absent when the window is unknown. */
  budgetTokens?: number;
  /**
   * False only when a window was known and the history is over its share of it.
   *
   * A branch that does not fit is refused, never trimmed to size: a
   * conversation quietly missing its middle is the class of thing this whole
   * feature exists to avoid claiming. Unknown-window conversations are `true`
   * here and `budgetTokens` is absent, which is how a caller tells "measured
   * and fits" from "nobody could say" — see the note on the route.
   */
  fits: boolean;
}

/**
 * Turn one conversation's cut into everything the new one needs.
 *
 * Pure, and given the cut rather than the store, so the two halves that have to
 * agree — what the reader sees and what the agent is told — are built from one
 * array of events in one place.
 */
export function planBranch(cut: TurnCut, now = Date.now()): BranchPlan {
  const carried = cut.events.filter(isCarried);
  const messages = replay(carried);
  const groups = groupByTurn(messages);
  // The last carried turn is the one branched from, so its recorded number
  // anchors the rest and the headers below line up with the index the reader
  // was just looking at.
  //
  // Floored at one because the two ways of counting turns can differ by a row
  // at the very head of a trimmed log: a compaction line that survived the trim
  // with no turn above it is a message here and not a turn in the index, and a
  // history labelled from turn zero would be a number that means nothing.
  const firstIndex = Math.max(1, cut.turn.index - groups.length + 1);

  const context = renderContext(groups, firstIndex, cut.turn.index, cut.complete);
  const estimatedTokens = estimateTokens(context);
  const contextWindow = windowOf(cut.usage);
  const budgetTokens =
    contextWindow === undefined ? undefined : Math.floor(contextWindow * CONTEXT_SHARE);

  const events = renumber(carried);
  // Closed here when the log never closed it, which is the ordinary case for
  // the most natural branch there is: the agent is going the wrong way, so you
  // branch from the turn it is still working on. Without this the carried turn
  // stays open, and the rule every reader of this log shares hands the branch's
  // own first question to it — no header, no row in the index, labelled with
  // the *source's* question and billed against the copied turn.
  if (!carried.some((event) => event.t === 'turn_end' && event.turnId === cut.turn.turnId)) {
    events.push({
      t: 'turn_end',
      seq: events.length + 1,
      ts: now,
      turnId: cut.turn.turnId,
      stopReason: 'end_turn',
    });
  }
  events.push({
    t: 'marker',
    seq: events.length + 1,
    ts: now,
    kind: 'branched',
    detail: describeBranch(cut, contextWindow),
  });

  return {
    events,
    context,
    turns: groups.length,
    estimatedTokens,
    contextWindow,
    budgetTokens,
    fits: budgetTokens === undefined || estimatedTokens <= budgetTokens,
  };
}

/** How far off a branch that will not fit is, in the words the user is told it in. */
export function tooLargeMessage(plan: BranchPlan, turnIndex: number): string {
  return (
    `Branching from turn ${turnIndex} would carry about ${thousands(plan.estimatedTokens)} tokens `
    + `of history, and this model's ${thousands(plan.contextWindow ?? 0)}-token window leaves `
    + `${thousands(plan.budgetTokens ?? 0)} for it. Branch from an earlier turn.`
  );
}

/** Roughly how many tokens a piece of text is. See CHARS_PER_TOKEN. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function isCarried(event: ChatEvent): boolean {
  if (!CARRIED.has(event.t)) return false;
  // A `/clear` is the boundary of the conversation it ended, and the log keeps
  // its marker as the first surviving record. Copied across it would draw a
  // line above a branch's history saying the conversation had started over,
  // which is not what happened here.
  return !(event.t === 'marker' && event.kind === 'cleared');
}

/**
 * The carried events under their own numbering, with the old bill left behind.
 *
 * `seq` restarts at one because this is a new conversation's log and its first
 * event is its first event. The store only asks that a log be contiguous, so
 * either numbering would store; starting at one is what makes the branch's own
 * turn index say — truthfully — that it holds everything it has.
 */
function renumber(events: ChatEvent[]): ChatEvent[] {
  return events.map((event, position) => {
    const next = { ...event, seq: position + 1 } as ChatEvent & { usage?: ChatUsage };
    if (next.t === 'msg_end' || next.t === 'turn_end') delete next.usage;
    return next;
  });
}

function replay(events: ChatEvent[]): ChatMessage[] {
  const transcript = createTranscript(NO_CHAT_CAPABILITIES);
  for (const event of events) applyChatEvent(transcript, event);
  return transcript.messages;
}

/** Consecutive messages sharing a turn id, which is the rule everything else uses. */
function groupByTurn(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: string | null = null;
  for (const message of messages) {
    if (message.turnId !== current || groups.length === 0) {
      groups.push([]);
      current = message.turnId;
    }
    groups[groups.length - 1].push(message);
  }
  return groups;
}

function renderContext(
  groups: ChatMessage[][],
  firstIndex: number,
  lastIndex: number,
  complete: boolean,
): string {
  const lines: string[] = [];
  lines.push('=== CARRIED HISTORY: A DIFFERENT CONVERSATION ===');
  lines.push('');
  lines.push(
    `Below is a record of an earlier conversation in this same directory. The user `
    + `branched a new conversation from turn ${lastIndex} of it, and this is that `
    + `history, carried over so you know what came before.`,
  );
  lines.push('');
  lines.push(
    'You were not in it. Nothing below was said by you in this session, and none of '
    + 'the work described in it has been done again here. Treat it as a record you '
    + 'are being shown rather than as your own memory, and check anything you mean '
    + 'to rely on.',
  );
  lines.push('');
  lines.push(
    'It is a rendition, not a replay: every message appears as it was written, tool '
    + 'calls are listed by name only and their output is not carried, and reasoning '
    + 'is left out.',
  );
  if (!complete) {
    lines.push('');
    lines.push(
      'It also does not start at the beginning: the earlier conversation\'s opening '
      + 'turns were no longer on disk, so the record below begins partway through.',
    );
  }

  for (const [offset, group] of groups.entries()) {
    lines.push('');
    lines.push(`--- turn ${firstIndex + offset} ---`);
    for (const message of group) {
      const body = renderMessage(message);
      if (body) lines.push(body);
    }
  }

  lines.push('');
  lines.push('=== END OF CARRIED HISTORY ===');
  lines.push('');
  lines.push(
    'Everything above happened in the earlier conversation. What follows is the '
    + "user's first message in this new one, and it is what you are being asked:",
  );
  return lines.join('\n');
}

function renderMessage(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.kind) {
      case 'text':
        if (block.text.trim()) parts.push(block.text.trim());
        break;
      case 'tool':
        parts.push(`(tool: ${block.title || block.name}${block.status === 'failed' ? ' — failed' : ''})`);
        break;
      case 'image':
        parts.push(`(image: ${block.alt || 'attached'})`);
        break;
      case 'attachment':
        parts.push(`(attached file: ${block.name})`);
        break;
      case 'error':
        parts.push(`(error: ${block.text.trim()})`);
        break;
      case 'notice':
        parts.push(`(${block.text}${block.detail ? `: ${block.detail}` : ''})`);
        break;
      case 'question': {
        const selected = (block.answer?.optionIds ?? [])
          .map((optionId) => block.request.options
            .find((option) => option.optionId === optionId)?.label ?? optionId);
        parts.push([
          `(question: ${block.request.question})`,
          selected.length ? `(answer: ${selected.join(', ')})` : '',
          block.answer?.text ? `(own words: ${block.answer.text})` : '',
          block.answer?.skipped ? '(skipped)' : '',
          block.answer?.abandoned ? '(agent stopped waiting)' : '',
        ].filter(Boolean).join('\n'));
        break;
      }
      // Reasoning is the model working, not the conversation. Plans replace
      // rather than accumulate and the last one said nothing about this turn.
      default:
        break;
    }
  }
  if (parts.length === 0) return '';
  return `[${message.role}] ${parts.join('\n')}`;
}

/** The rule's own caption: which turn, and anything the reader should distrust. */
function describeBranch(cut: TurnCut, contextWindow: number | undefined): string {
  const notes = [`turn ${cut.turn.index}`];
  if (!cut.complete) notes.push('earlier history was no longer on disk');
  // Not "the runtime said nothing": the window is read from the source's own
  // log, and a conversation long enough to have been trimmed has lost the event
  // that carried it. What is true either way is that nothing was measured.
  if (contextWindow === undefined) notes.push('size not checked');
  return notes.join(' · ');
}

/**
 * The window to measure against, or undefined when nobody said.
 *
 * Whatever the conversation last recorded, which is the agent's own figure
 * where it published one and the model catalogue's where it did not — see
 * model-capacity.ts. A conversation that never got either is measured against
 * nothing at all and the caller says so, because inventing a ceiling here is
 * exactly the wrong ceiling that file refuses to invent.
 */
function windowOf(usage: ChatUsage): number | undefined {
  const window = usage.contextWindow;
  return typeof window === 'number' && window > 0 ? window : undefined;
}

function thousands(value: number): string {
  return value.toLocaleString('en-US');
}
