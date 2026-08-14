import type { ToolStatus, ToolBlock } from '../../../../shared/chat-events.js';
import { str, record } from './codex-utils.js';

/** One Codex child thread, projected onto the shared delegation vocabulary. */
export interface CodexSubAgent {
  threadId: string;
  toolId: string;
  path: string;
  status: ToolStatus;
  announced: boolean;
  startedAt?: number;
  toolUses: number;
  stepIds: Set<string>;
  prompt?: string;
  model?: string;
}

export interface BufferedSubAgentNotification {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A stable transcript identity for a child, independent of the action that
 * mentioned it. `subAgentActivity.id` is the spawn/send/interrupt call id and
 * therefore changes; `agentThreadId` is the identity that does not.
 */
export function codexSubAgentToolId(threadId: string): string {
  return `codex-agent:${threadId}`;
}

export function subAgentActivityStatus(kind: unknown): ToolStatus | undefined {
  switch (str(kind)) {
    case 'started':
      return 'running';
    case 'interrupted':
      return 'canceled';
    // Contacting an agent says nothing about whether it is currently running:
    // a queued message and a follow-up that starts a turn use the same item.
    case 'interacted':
    default:
      return undefined;
  }
}

export function subAgentActivityLabel(kind: unknown, path: string): string {
  switch (str(kind)) {
    case 'started':
      return path ? `Started ${path}` : 'Started';
    case 'interacted':
      return path ? `Contacted ${path}` : 'Contacted';
    case 'interrupted':
      return path ? `Interrupted ${path}` : 'Interrupted';
    default:
      return path || 'Agent activity';
  }
}

export function threadStatus(value: unknown): ToolStatus | undefined {
  switch (str(record(value).type) || str(value)) {
    case 'active':
      return 'running';
    case 'idle':
      return 'completed';
    case 'systemError':
      return 'failed';
    case 'notLoaded':
      // Dormant, not failed. Unlike `unknown`, completed can be reopened when
      // the same retained child receives a later follow-up and becomes active.
      return 'completed';
    default:
      return undefined;
  }
}

export function childTurnStatus(value: unknown): ToolStatus | undefined {
  switch (str(value)) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

export function collabAgentStateStatus(value: unknown): ToolStatus | undefined {
  switch (str(record(value).status) || str(value)) {
    case 'pendingInit':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
    case 'shutdown':
      return 'canceled';
    case 'errored':
      return 'failed';
    case 'notFound':
      return 'unknown';
    default:
      return undefined;
  }
}

export const TERMINAL_AGENT_STATUS: ReadonlySet<ToolStatus> = new Set([
  'completed',
  'failed',
  'denied',
  'canceled',
  'unknown',
]);

export const BUFFERED_SUB_AGENT_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'thread/status/changed',
  'error',
]);

export const MAX_BUFFERED_SUB_AGENT_THREADS = 32;

export const MAX_BUFFERED_SUB_AGENT_EVENTS = 128;

export function subAgentStatusLabel(status: ToolStatus, path: string): string {
  const target = path || 'agent';
  switch (status) {
    case 'pending':
      return `Waiting to start ${target}`;
    case 'running':
      return `Running ${target}`;
    case 'completed':
      return `Completed ${target}`;
    case 'failed':
      return `Failed ${target}`;
    case 'denied':
      return `Denied ${target}`;
    case 'canceled':
      return `Interrupted ${target}`;
    case 'unknown':
      return `No longer reporting ${target}`;
  }
}

export function subAgentToolBlock(agent: CodexSubAgent, includeRun = true): ToolBlock {
  const label = agent.path || 'Codex agent';
  const block: ToolBlock = {
    kind: 'tool',
    toolId: agent.toolId,
    name: 'Agent',
    toolKind: 'task',
    status: agent.status,
    input: {
      name: label,
      agentThreadId: agent.threadId,
      ...(agent.prompt ? { description: agent.prompt } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    },
  };
  if (includeRun) {
    block.agent = {
      steps: [],
      status: agent.status,
      activity: subAgentStatusLabel(agent.status, agent.path),
      subagentType: label,
      ...(agent.prompt ? { prompt: agent.prompt } : {}),
    };
  }
  return block;
}

