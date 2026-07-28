/**
 * Every reasoning block and every tool call, as one ordered list.
 *
 * A projection, not a copy: each event holds a reference to the live block the
 * reducer mutates in place, so a tool call that is still running updates on the
 * timeline without anything being rebuilt. Copying the block here would freeze
 * the row at whatever the arguments looked like when the list was last derived.
 *
 * Ids are `${messageId}:${blockIndex}` — stable across re-derivation, which is
 * what lets "this row is expanded" survive the next token arriving.
 */

import {
  ChatBlock,
  ChatMessage,
  FileDiff,
  ThinkingBlock,
  ToolBlock,
  ToolKind,
  ToolStatus,
} from '../../shared/chat-events.js';
import { compactCount, diffTally, formatDuration, oneLine, shorten, summarize } from './tool-meta.js';
import type { TurnSummary } from './turns.js';

export type ActivityKind = 'reasoning' | 'tool';

export interface ActivityEvent {
  /** `${messageId}:${blockIndex}`. Stable, so expansion state survives. */
  id: string;
  messageId: string;
  blockIndex: number;
  kind: ActivityKind;
  /** The runtime's own tool name; absent for reasoning. */
  name?: string;
  toolKind?: ToolKind;
  /** What it acted on — the path, the command, the pattern. */
  target: string;
  status: ToolStatus;
  durationMs?: number;
  /**
   * A reasoning block's size as the runtime reported it, snapshotted here.
   *
   * On the event rather than read off `block` at render time for the same
   * reason `status` and `target` are: the reducer mutates blocks in place, so
   * two derivations of the same row hold the *same* block object and a row
   * memoised on it would never notice the figure climbing (see the comparator
   * in ActivityTimeline).
   */
  tokens?: number;
  diffs?: FileDiff[];
  /** True when the call touched files, which is what the `files` filter means. */
  touchesFiles: boolean;
  /** The live block, rendered when the row is expanded. */
  block: ChatBlock;
  ts: number;
}

export type ActivityFilter = 'all' | 'tools' | 'reasoning' | 'files';

export const ACTIVITY_FILTERS: ActivityFilter[] = ['all', 'tools', 'reasoning', 'files'];

export interface ActivityOptions {
  /** Off drops reasoning from the projection, per the chat display settings. */
  reasoning?: boolean;
  /** Off drops tool calls. A view choice only — the tools still run. */
  tools?: boolean;
}

export function activityEvents(
  messages: ChatMessage[],
  options: ActivityOptions = {},
): ActivityEvent[] {
  const wantReasoning = options.reasoning !== false;
  const wantTools = options.tools !== false;

  const events: ActivityEvent[] = [];
  for (const message of messages) {
    message.blocks.forEach((block, blockIndex) => {
      if (block.kind === 'thinking') {
        if (!wantReasoning) return;
        events.push(reasoningEvent(message, block, blockIndex));
      } else if (block.kind === 'tool') {
        if (!wantTools) return;
        events.push(toolEvent(message, block, blockIndex));
      }
    });
  }
  return events;
}

function reasoningEvent(
  message: ChatMessage,
  block: ThinkingBlock,
  blockIndex: number,
): ActivityEvent {
  // Still arriving exactly when the message is open and this is its last block:
  // a reasoning block earlier in an open message has already been closed out.
  const open = Boolean(message.streaming) && blockIndex === message.blocks.length - 1;
  const first = (block.text || '').trim().split('\n')[0] || '';
  return {
    id: `${message.id}:${blockIndex}`,
    messageId: message.id,
    blockIndex,
    kind: 'reasoning',
    // A row with nothing to preview says which of the two silences it is,
    // rather than leaving the line blank and letting the reader guess whether
    // the app lost the text or the agent never sent it (#120).
    target: first
      ? shorten(oneLine(first), 140)
      : open
        ? 'thinking…'
        : 'text not reported by this agent',
    status: open ? 'running' : 'completed',
    tokens: block.tokens,
    touchesFiles: false,
    block,
    ts: message.ts,
  };
}

/**
 * What an expanded reasoning row says when there are no words to show, or null
 * when there are.
 *
 * Three silences, and they are not the same thing: the model is still thinking,
 * the runtime counted the reasoning but withheld it, or the runtime said only
 * that it happened. Claude Code is the second — it sends `"thinking": ""` with
 * a signature and reports the size on the side (see `ThinkingBlock.tokens`) —
 * and codex is the third whenever its trace is encrypted and it summarises
 * nothing. Both used to render as an empty panel, which reads as a bug in this
 * app rather than as a fact about the agent.
 */
export function reasoningNote(block: ThinkingBlock, running: boolean): string | null {
  if ((block.text || '').trim()) return null;
  if (running) return 'Reasoning now. Nothing has arrived from the agent yet.';
  return block.tokens
    ? `This agent reported about ${compactCount(block.tokens)} tokens of reasoning `
      + 'here, but not the text of it.'
    : 'This agent reported that it reasoned here, but not the text of it.';
}

function toolEvent(message: ChatMessage, block: ToolBlock, blockIndex: number): ActivityEvent {
  return {
    id: `${message.id}:${blockIndex}`,
    messageId: message.id,
    blockIndex,
    kind: 'tool',
    name: block.name || 'tool',
    toolKind: block.toolKind,
    target: summarize(block),
    status: block.status,
    durationMs: block.durationMs,
    diffs: block.diffs,
    touchesFiles: Boolean(
      (block.diffs && block.diffs.length)
      || (block.locations && block.locations.length)
      || block.toolKind === 'edit'
      || block.toolKind === 'delete'
      || block.toolKind === 'move'
      || block.toolKind === 'read',
    ),
    block,
    ts: message.ts,
  };
}

/** The slice of the timeline belonging to one turn. */
export function activityForTurn(turn: TurnSummary, all: ActivityEvent[]): ActivityEvent[] {
  const ids = new Set(turn.messageIds);
  return all.filter((event) => ids.has(event.messageId));
}

export function filterActivity(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  switch (filter) {
    case 'tools':
      return events.filter((event) => event.kind === 'tool');
    case 'reasoning':
      return events.filter((event) => event.kind === 'reasoning');
    case 'files':
      return events.filter((event) => event.kind === 'tool' && event.touchesFiles);
    default:
      return events;
  }
}

/**
 * The row's right-hand figure.
 *
 * Diffs beat duration: `+12 −4` says what the call did, where `0.4s` only says
 * how long it took to do it. Reasoning has neither, so it reports its own size.
 */
export function activityMeta(event: ActivityEvent): string {
  if (event.kind === 'reasoning') {
    const block = event.block as ThinkingBlock;
    const text = block.text || '';
    // Four characters per token is the usual rough ratio; a size cue, not an
    // accounting figure, so an approximation is honest enough. The runtime's
    // own figure beats it wherever there is one — and it is the only figure
    // there is for a runtime that reports the size and withholds the words.
    const tokens = event.tokens ?? (text ? Math.ceil(text.length / 4) : undefined);
    const size = tokens === undefined ? '' : `~${compactCount(tokens)} tok`;
    if (!text) return size;
    const lines = text.split('\n').length;
    return `${lines} ${lines === 1 ? 'line' : 'lines'}${size ? ` · ${size}` : ''}`;
  }
  const tally = diffTally(event.diffs);
  if (tally) return tally;
  return event.durationMs === undefined ? '' : formatDuration(event.durationMs);
}

/** The one-line summary the work pill shows, e.g. "3 commands · 2 reasoning · 8.1s". */
export function workSummary(events: ActivityEvent[], durationMs?: number): string {
  const tools = events.filter((event) => event.kind === 'tool').length;
  const reasoning = events.filter((event) => event.kind === 'reasoning').length;
  const bits: string[] = [];
  if (tools) bits.push(`${tools} command${tools === 1 ? '' : 's'}`);
  if (reasoning) bits.push(`${reasoning} reasoning`);
  if (durationMs !== undefined) {
    const formatted = formatDuration(durationMs);
    if (formatted) bits.push(formatted);
  }
  return bits.join(' · ');
}
