/**
 * Which subagents and workflows a conversation has run, derived from its own
 * transcript.
 *
 * Deliberately derived rather than reported. No runtime this app launches
 * publishes a "here are my running agents" channel — what they all do publish
 * is the tool call that spawned one, with a status that moves from pending to
 * running to completed. That is the same fact, already in the event log, and
 * reading it there means the panel is correct for every runtime rather than for
 * whichever one grew a bespoke API.
 *
 * The cost of deriving is that this is only as good as the tool names, so the
 * matching is deliberately conservative: something has to look like a delegation
 * before it is called one.
 */

import type { ChatMessage, ToolBlock, ToolStatus } from './chat-events.js';

export type AgentActivityKind = 'agent' | 'workflow';

export interface AgentActivity {
  /** The tool call this came from; stable across updates to the same call. */
  toolId: string;
  kind: AgentActivityKind;
  /** The runtime's own tool name, e.g. "Agent", "Task", "Workflow". */
  tool: string;
  /** Subagent type or workflow name, when the arguments carry one. */
  name: string | null;
  /** One line describing what it was asked to do. */
  description: string | null;
  status: ToolStatus;
  /** When the call was announced, from the message that opened it. */
  startedAt: number;
  durationMs?: number;
  /** True while the call has not reported a terminal status. */
  running: boolean;
}

const WORKFLOW_PATTERN = /workflow/i;
/**
 * `Agent` and `Task` are the two names the CLIs in this app use for "run a
 * subagent". Anchored rather than substring-matched: `TaskList`, `TodoWrite`
 * and `MultiEdit` all contain one of these words and none of them delegates
 * anything.
 */
const AGENT_PATTERN = /^(agent|task|subagent|dispatch_agent|run_agent)$/i;

const TERMINAL: ReadonlySet<ToolStatus> = new Set<ToolStatus>([
  'completed',
  'failed',
  'denied',
  'canceled',
]);

function classify(name: string): AgentActivityKind | null {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  if (WORKFLOW_PATTERN.test(trimmed)) return 'workflow';
  if (AGENT_PATTERN.test(trimmed)) return 'agent';
  return null;
}

function readInput(block: ToolBlock): Record<string, unknown> | null {
  const input = block.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return null;
}

function firstString(
  input: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** One line, from whichever field the runtime happened to put it in. */
function describe(block: ToolBlock, input: Record<string, unknown> | null): string | null {
  const text =
    firstString(input, ['description', 'prompt', 'task', 'instructions', 'query']) ??
    block.title ??
    null;
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
}

/**
 * Every delegation in the transcript, oldest first.
 *
 * A tool call appears once however many times it was patched: the reducer
 * mutates the block in place, so walking the messages sees the current state of
 * each call rather than a history of its updates.
 */
export function collectAgentActivity(messages: ChatMessage[]): AgentActivity[] {
  const activity: AgentActivity[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== 'tool') continue;

      const kind = classify(block.name);
      if (!kind) continue;
      if (seen.has(block.toolId)) continue;
      seen.add(block.toolId);

      const input = readInput(block);
      activity.push({
        toolId: block.toolId,
        kind,
        tool: block.name,
        name: firstString(input, ['subagent_type', 'agent_type', 'name', 'workflow', 'agentType']),
        description: describe(block, input),
        status: block.status,
        startedAt: message.ts,
        durationMs: block.durationMs,
        running: !TERMINAL.has(block.status),
      });
    }
  }

  return activity;
}

/** How many are still going, for the panel's badge. */
export function countRunning(activity: AgentActivity[]): number {
  return activity.reduce((total, entry) => total + (entry.running ? 1 : 0), 0);
}
