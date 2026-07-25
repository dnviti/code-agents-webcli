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
    target: shorten(oneLine(first), 140),
    status: open ? 'running' : 'completed',
    touchesFiles: false,
    block,
    ts: message.ts,
  };
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
    const text = (event.block as ThinkingBlock).text || '';
    if (!text) return '';
    const lines = text.split('\n').length;
    // Four characters per token is the usual rough ratio; a size cue, not an
    // accounting figure, so an approximation is honest enough.
    return `${lines} ${lines === 1 ? 'line' : 'lines'} · ~${compactCount(Math.ceil(text.length / 4))} tok`;
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
