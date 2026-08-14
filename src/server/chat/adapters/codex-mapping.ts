import { classifyTool } from '../../../shared/chat-events.js';
import type { AgentStepPatch, ToolBlock, ToolKind, ToolStatus } from '../../../shared/chat-events.js';
import { str, num, list, record, safeJson } from './codex-utils.js';
import { fileChangeTitle, fileUpdateChangeToFileDiff } from './codex-diff.js';
import type { CodexSubAgent } from './codex-subagent.js';
import { codexSubAgentToolId, subAgentActivityStatus, subAgentToolBlock } from './codex-subagent.js';

// ------------------------------------------------------------ item mapping

/** codex-rs's four-state statuses (commandExecution, fileChange) and its three-state ones share this. */
function toolStatus(value: unknown): ToolStatus {
  switch (str(value)) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'denied';
    default:
      return 'pending';
  }
}

const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'collabAgentToolCall',
]);

export function isToolItemType(type: string): boolean {
  return TOOL_ITEM_TYPES.has(type);
}

/** Anything this adapter has no dedicated rendering for, described rather than dropped. */
function describeUnmappedItem(item: Record<string, unknown>): string {
  switch (str(item.type)) {
    case 'imageView':
      return `[viewed image: ${str(item.path) || '?'}]`;
    case 'imageGeneration':
      return `[generated image${item.revisedPrompt ? `: ${str(item.revisedPrompt)}` : ''}]`;
    case 'enteredReviewMode':
      return `[entered review mode: ${str(item.review) || ''}]`;
    case 'exitedReviewMode':
      return `[exited review mode: ${str(item.review) || ''}]`;
    case 'contextCompaction':
      // Kept as text for the summary path below; the adapter also emits a
      // `marker` so the transcript draws the line rather than printing a
      // sentence that reads like something the agent said.
      return '[context compacted]';
    default:
      return `[unhandled codex item: ${str(item.type) || 'unknown'}]`;
  }
}

/**
 * One `ThreadItem` -> one `ChatBlock`, or null for items that are not
 * user-facing content (`userMessage` is represented by `send()` itself;
 * `hookPrompt` is internal prompt injection, not something the user typed
 * or the agent said).
 *
 * Shared between `CodexAppServerAdapter` and `CodexExecAdapter` on the
 * assumption in the file-level doc comment that both entry points emit the
 * same item shape.
 */
export function itemToBlock(item: Record<string, unknown>) {
  const type = str(item.type);
  const id = str(item.id) || '';

  switch (type) {
    case 'userMessage':
    case 'hookPrompt':
      return null;

    case 'agentMessage':
      // Not filtered for blankness here: this same mapper opens the block that
      // the streaming deltas are then addressed into by index, and a reply that
      // is empty when it starts is every reply. The blank guard for #132 is at
      // the two places a block is opened for an item that is already finished —
      // see `onItem` and the exec adapter — where the text is final.
      return { kind: 'text' as const, text: str(item.text) || '' };

    case 'reasoning': {
      // `content` is an array of parts (ReasoningTextDeltaNotification streams
      // them by `contentIndex`, which this adapter does not track separately);
      // joined here into the single string ThinkingBlock expects. `summary`
      // is used only when content is empty -- some turns reason without ever
      // populating the full trace, only its summary.
      const content = list(item.content).filter((entry): entry is string => typeof entry === 'string');
      const summary = list(item.summary).filter((entry): entry is string => typeof entry === 'string');
      return { kind: 'thinking' as const, text: (content.length ? content : summary).join('\n\n') };
    }

    case 'plan':
      return { kind: 'plan' as const, items: [{ text: str(item.text) || '', status: 'in_progress' as const }] };

    case 'commandExecution': {
      const status = toolStatus(item.status);
      const output = str(item.aggregatedOutput);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'shell',
        title: str(item.command),
        toolKind: 'execute' as ToolKind,
        status,
        input: { command: item.command, cwd: item.cwd },
        output,
        error: status === 'failed' ? output || 'command failed' : undefined,
        durationMs: num(item.durationMs),
      };
    }

    case 'fileChange': {
      const changes = list(item.changes);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'apply_patch',
        title: fileChangeTitle(changes),
        toolKind: 'edit' as ToolKind,
        status: toolStatus(item.status),
        diffs: changes.map((change) => fileUpdateChangeToFileDiff(record(change))),
        locations: changes.map((change) => str(record(change).path) || '').filter(Boolean),
      };
    }

    case 'mcpToolCall': {
      const tool = str(item.tool) || 'tool';
      const server = str(item.server) || '';
      const error = record(item.error);
      return {
        kind: 'tool' as const,
        toolId: id,
        name: server ? `${server}.${tool}` : tool,
        toolKind: classifyTool(tool),
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.result !== null && item.result !== undefined ? safeJson(item.result) : undefined,
        error: str(error.message),
        durationMs: num(item.durationMs),
      };
    }

    case 'dynamicToolCall': {
      const tool = str(item.tool) || 'tool';
      return {
        kind: 'tool' as const,
        toolId: id,
        name: tool,
        toolKind: classifyTool(tool),
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.contentItems ? safeJson(item.contentItems) : undefined,
        error: item.success === false ? 'the tool call did not succeed' : undefined,
        durationMs: num(item.durationMs),
      };
    }

    case 'webSearch':
      return {
        kind: 'tool' as const,
        toolId: id,
        name: 'web_search',
        title: str(item.query),
        toolKind: 'fetch' as ToolKind,
        status: 'completed' as ToolStatus,
        input: { query: item.query, action: item.action },
      };

    case 'collabAgentToolCall':
      return {
        kind: 'tool' as const,
        toolId: id,
        name: `collab.${str(item.tool) || 'agent'}`,
        toolKind: 'task' as ToolKind,
        status: toolStatus(item.status),
        input: { prompt: item.prompt, model: item.model },
      };

    // App-server mode handles this specially so separate activity call ids are
    // coalesced onto one child thread and its instantaneous item completion is
    // not mistaken for the child finishing. The mapper still knows the shape
    // for `codex exec --json`, where there is no separate routing layer.
    case 'subAgentActivity': {
      const threadId = str(item.agentThreadId) || '';
      if (!threadId) return null;
      const status = subAgentActivityStatus(item.kind) || 'running';
      return subAgentToolBlock({
        threadId,
        toolId: codexSubAgentToolId(threadId),
        path: str(item.agentPath) || '',
        status,
        announced: true,
        toolUses: 0,
        stepIds: new Set<string>(),
      }, false);
    }

    default:
      return { kind: 'text' as const, text: describeUnmappedItem(item) };
  }
}

export function agentStepFrom(block: ToolBlock): AgentStepPatch {
  return {
    id: block.toolId,
    name: block.name,
    toolKind: block.toolKind,
    status: block.status,
    input: block.input,
    output: block.output,
    error: block.error,
  };
}

