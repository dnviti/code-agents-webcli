import {
  AgentRun,
  ToolBlock,
  ToolStatus,
} from '../chat-events.js';
import { TERMINAL_TOOL as TERMINAL_STATUS, isWorkflowLaunch } from '../agent-activity.js';
import { TranscriptState } from './types.js';

/**
 * The `AgentRun` hanging off a delegation's tool block, created on first use.
 *
 * Nothing is buffered when the block is missing, unlike `orphanToolPatches`:
 * the runtime opens the delegation's own tool call long before it reports
 * anything happening inside it, so a step with no parent means the parent was
 * never in this transcript — a replay that started mid-run, say — and inventing
 * a block to hang it on would put a delegation in the list that the
 * conversation never made.
 */
export function locateAgentRun(
  state: TranscriptState,
  parentToolId: string,
): [number, AgentRun] | null {
  const located = state.toolIndex[parentToolId];
  if (!located) return null;
  const [messageIndex, blockIndex] = located;
  const block = state.messages[messageIndex]?.blocks[blockIndex];
  if (!block || block.kind !== 'tool') return null;
  if (!block.agent) block.agent = { steps: [] };
  return [messageIndex, block.agent];
}

/** The statuses that mean a call is over, whatever happened to it. */
const SETTLED_TOOL: ReadonlySet<ToolStatus> = new Set<ToolStatus>([
  'completed',
  'failed',
  'denied',
  'canceled',
  'unknown',
]);

/**
 * Calls left open inside a turn that has ended, settled honestly (#139).
 *
 * Nothing in this pipeline ever closed a tool block on a turn-level event. The
 * runtimes routinely stop reporting on a call before the turn is over — an ACP
 * agent that backgrounds a task never sends a terminal update at all, and
 * Claude ends a turn with an unresolved block whenever a tool errors during
 * execution — so a delegation would spin as "running" for ever, on its row, in
 * its badge, on the trace rail and in the panel's running count, beside a
 * conversation that had plainly finished and a trace showing no activity at
 * all. `unknown` is the honest word: nobody stopped it and nothing is known to
 * have broken; the runtime simply went quiet and its turn is over.
 *
 * One exemption, and it is the whole reason this is not a blunt sweep. A run
 * that is still reporting about *itself* — a background workflow, whose own
 * report says it is running — outlives the turn that started it by design.
 * Those are left alone here and settle when they say so. `force` removes the
 * exemption, for the one case where nothing can report again: the runtime is
 * gone.
 */
export function settleUnreportedTools(state: TranscriptState, turnId: string | null, force: boolean): boolean {
  if (!turnId) return false;
  let touched = false;
  for (const message of state.messages) {
    if (message.turnId !== turnId) continue;
    for (const block of message.blocks) {
      if (block.kind !== 'tool') continue;
      if (SETTLED_TOOL.has(block.status)) continue;
      const runStatus = block.agent?.status;
      if (!force && runStatus !== undefined && !SETTLED_TOOL.has(runStatus)) continue;
      block.status = 'unknown';
      touched = true;
    }
  }
  return touched;
}

/**
 * A workflow left running when the app stopped being able to watch it.
 *
 * The runtime has exited, or errored fatally. A background workflow outlives
 * the turn that started it by design, and it may well outlive the process that
 * launched it too — but this app has no way of hearing how it ended any more,
 * and a spinner that never stops is a worse answer than an honest one. So the
 * call is settled as cancelled and says, in its own words, that it is our
 * observation that ended, not necessarily the run (#116).
 *
 * Only workflows. An ordinary tool call left open by a dead runtime is a
 * different question with a different answer, and changing it is out of scope.
 */
export function settleUnobservableWorkflows(state: TranscriptState): void {
  for (const located of Object.values(state.toolIndex)) {
    const [messageIndex, blockIndex] = located;
    const block = state.messages[messageIndex]?.blocks[blockIndex];
    if (!block || block.kind !== 'tool') continue;
    if (TERMINAL_STATUS.has(block.status)) continue;
    if (!isWorkflowLaunch(block.name, block.agent?.workflow !== undefined)) continue;
    block.status = 'canceled';
    block.error =
      block.error
      ?? 'The app stopped watching before this run reported an ending, so how it finished is not known.';
  }
}

export { SETTLED_TOOL };
