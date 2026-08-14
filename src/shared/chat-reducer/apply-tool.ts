import {
  AgentStep,
  ChatEvent,
  ChatMessage,
  ToolBlock,
} from '../chat-events.js';
import { assignDefined, omitUndefined, upsertByIndex } from './fold.js';
import { lastTurnId } from './core.js';
import { locateAgentRun, SETTLED_TOOL } from './settle.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * Delegation and workflow events, all addressed to the tool call that owns
 * them. A missing call leaves what is held standing — orphaned tool patches
 * wait for the block that will own them.
 */
export function applyTool(state: TranscriptState, event: ChatEvent): TranscriptChange {
  switch (event.t) {
    case 'tool': {
      const located = state.toolIndex[event.toolId];
      if (!located) {
        state.orphanToolPatches[event.toolId] = {
          ...(state.orphanToolPatches[event.toolId] || {}),
          ...event.patch,
        };
        return { messageIndex: null, structural: false, meta: false, applied: true };
      }
      const [messageIndex, blockIndex] = located;
      const block = state.messages[messageIndex]?.blocks[blockIndex];
      if (!block || block.kind !== 'tool') return NO_CHANGE;
      // A completion that arrives after the turn ended still lands: the whole
      // point of settling a call as `unknown` is that it is the answer until a
      // better one turns up. What must not land is a patch that puts it back to
      // running — a progress report from a runtime that has already gone quiet
      // once would restart a spinner nothing will ever stop (#139).
      const reopens =
        block.status === 'unknown'
        && (event.patch.status === undefined || !SETTLED_TOOL.has(event.patch.status));
      Object.assign(block, event.patch);
      if (reopens) block.status = 'unknown';
      return { messageIndex, structural: false, meta: false, applied: true };
    }

    case 'agent_step': {
      const found = locateAgentRun(state, event.parentToolId);
      if (!found) return NO_CHANGE;
      const [messageIndex, run] = found;
      // Upserted by id: a step is opened when the agent calls the tool and
      // completed by a result that arrives later, and the two have to land on
      // the same row rather than showing the same call twice.
      const existing = run.steps.findIndex((step) => step.id === event.step.id);
      if (existing >= 0) {
        assignDefined(run.steps[existing], event.step);
      } else {
        run.steps.push({
          name: 'tool',
          toolKind: 'other',
          status: 'running',
          ts: event.ts,
          ...omitUndefined(event.step),
        } as AgentStep);
      }
      return { messageIndex, structural: false, meta: false, applied: true };
    }

    case 'agent_progress': {
      const found = locateAgentRun(state, event.parentToolId);
      if (!found) return NO_CHANGE;
      const [messageIndex, run] = found;
      assignDefined(run, event.patch);
      return { messageIndex, structural: false, meta: false, applied: true };
    }

    case 'workflow_progress': {
      const found = locateAgentRun(state, event.parentToolId);
      if (!found) return NO_CHANGE;
      const [messageIndex, run] = found;
      if (!run.workflow) run.workflow = { phases: [], agents: [] };
      // Replaced by index, not merged into: each entry the runtime sends is
      // that agent's whole current state, and a retry clears fields — the
      // `error` of a first attempt above all — by omitting them. Merging would
      // leave a row reading "failed" while its second attempt was working.
      upsertByIndex(run.workflow.phases, event.phases);
      upsertByIndex(run.workflow.agents, event.agents);
      return { messageIndex, structural: false, meta: false, applied: true };
    }

    case 'workflow_failed': {
      // The call that launched the run stops claiming success. Written onto the
      // block rather than derived beside it, so every surface that reads a tool
      // call's status — the Agents row, the popup title, the card on the trace
      // rail — agrees without any of them having to know what a workflow is.
      //
      // `output` is left alone: for a workflow it holds the "launched in
      // background" acknowledgement, and the popup tells the failure from the
      // log by comparing the two (see `Header` in WorkflowPopup.tsx).
      const patch: Partial<ToolBlock> = event.reason
        ? { status: 'failed', error: event.reason }
        : { status: 'failed' };
      const located = state.toolIndex[event.parentToolId];
      if (located) {
        const block = state.messages[located[0]]?.blocks[located[1]];
        if (block && block.kind === 'tool') Object.assign(block, patch);
      } else {
        // Held for a block that has not arrived, exactly as a `tool` patch is.
        // A snapshot replays only the tail of the log, and a workflow that runs
        // for half an hour can outlive its own launching call's place in that
        // window — the failure would otherwise be dropped for the one runs that
        // take longest, which are the runs this is for.
        state.orphanToolPatches[event.parentToolId] = {
          ...(state.orphanToolPatches[event.parentToolId] || {}),
          ...patch,
        };
      }

      // And the conversation says so, in a message of its own.
      //
      // A message of its own because of when this arrives. A workflow outlives
      // the turn that started it — that is what launching it in the background
      // means — so by the time it fails there is usually nothing streaming to
      // append to, and the `error` event's own rule (see above) drops a block
      // it cannot find a home for. That drop is the whole second half of #140:
      // the failure reached `lastError`, the header pill, and nowhere a person
      // scrolling the conversation would ever find it.
      //
      // Filed under the turn in progress, or the last one there was, exactly as
      // a marker is: only the newest turn is open (`isTurnOpen`), so a synthetic
      // turn of its own would fold itself shut the moment the conversation
      // carried on. Under the last turn it is where the reader is looking — and
      // in the case this is written for, a run that outlived its turn, that is
      // the open one.
      const text = event.name
        ? `Workflow "${event.name}" failed`
        : 'A workflow failed';
      const message: ChatMessage = {
        id: `workflow-failed-${event.seq}`,
        seq: event.seq,
        turnId: state.currentTurnId ?? lastTurnId(state) ?? `workflow-failed-${event.seq}`,
        role: 'system',
        ts: event.ts,
        blocks: [{ kind: 'error', text: event.reason ? `${text}: ${event.reason}` : `${text}.` }],
      };
      state.messages.push(message);
      state.index[message.id] = state.messages.length - 1;
      return {
        messageIndex: state.messages.length - 1,
        structural: true,
        meta: true,
        applied: true,
      };
    }

    default:
      return NO_CHANGE;
  }
}
