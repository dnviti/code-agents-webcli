import type { ToolStatus, WorkflowAgentState } from '../../../../shared/chat-events.js';
import { REASON_LIMIT } from './constants.js';

/**
 * A failure reason as a sentence, not as a stack trace.
 *
 * What the runtime hands over is a thrown `Error` with its frames glued on —
 * `Error: probe: forced workflow failure…\n    at <anonymous> (workflow.js:15:7)
 * \n    at processTicksAndRejections (native)` in the capture. The frames are
 * the only part a reader cannot act on, and what this becomes is a message in a
 * conversation, read on a phone.
 *
 * Stripped rather than reduced to its first line, because the reasons that
 * matter most here are prose and often more than one sentence: a usage limit
 * says when it resets, a refused model says what to do instead. `AgentRun.error`
 * keeps the whole thing, frames and all, for the popup and the row.
 */
export function failureReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line))
    .join('\n')
    .trim();
  if (!text) return undefined;
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1).trimEnd()}…`;
}

/**
 * A task's own status word, mapped onto the transcript's tool statuses.
 *
 * Anything unrecognised becomes `running` rather than a guess at a terminal
 * state: showing a finished agent as still working is a cosmetic lag the next
 * event corrects, while showing a working agent as finished stops its detail
 * view updating for good.
 */
export function toolStatus(value: string): ToolStatus {
  switch (value) {
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'denied':
      return 'denied';
    case 'pending':
    case 'queued':
      return 'pending';
    default:
      return 'running';
  }
}

/**
 * A workflow agent's reported state, in this app's words.
 *
 * The runtime's four are `start` (queued or just spawned), `progress`, `done`
 * and `error`. Anything else becomes `running` for the same reason `toolStatus`
 * does: an unknown word that settled a row would stop it ever updating again,
 * while one that leaves it working is corrected by the next report.
 */
export function agentState(value: string | undefined): WorkflowAgentState {
  switch (value) {
    case 'start':
      return 'queued';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    default:
      return 'running';
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = record(part);
        return p ? str(p.text) ?? '' : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
