/**
 * Folds a stream of ChatEvents into a transcript.
 *
 * Deliberately shared: the server runs it to answer "what does this session
 * look like right now" for a joining browser, and the client runs it to apply
 * live deltas on top of that answer. One implementation means the two can never
 * disagree about what the conversation is — a class of bug that is miserable to
 * chase once a reconnect has replayed half a turn.
 *
 * The state is mutated in place rather than rebuilt. A streaming turn produces
 * an event per token, and copying an hour-long transcript per token is not a
 * trade worth making; instead every apply reports which message it touched so
 * the UI can re-render exactly that one. This matches the shape the rest of the
 * client already uses: an imperative core that owns state, React that renders it.
 */

import {
  AgentRun,
  AgentStep,
  ChatBlock,
  ChatCapabilities,
  ChatEvent,
  ChatMessage,
  ChatState,
  ChatUsage,
  PermissionRequest,
  PlanItem,
  QuestionRequest,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  mergeUsage,
} from './chat-events.js';

export interface TranscriptState {
  messages: ChatMessage[];
  /** msgId -> index into `messages`. */
  index: Record<string, number>;
  /** toolId -> [message index, block index], so results find their call fast. */
  toolIndex: Record<string, [number, number]>;
  /**
   * Patches for tool calls we have not seen opened yet.
   *
   * Orderings differ between runtimes and a reconnect can deliver a result
   * before the call that produced it. Holding the patch costs nothing and
   * avoids dropping the output of a tool the user is watching.
   */
  orphanToolPatches: Record<string, Partial<ToolBlock>>;
  state: ChatState;
  capabilities: ChatCapabilities;
  usage: ChatUsage;
  plan: PlanItem[];
  pendingPermissions: PermissionRequest[];
  /**
   * Questions the model asked that nobody has answered yet.
   *
   * Held beside the transcript rather than inside a message because a question
   * outlives the block that asked it: the agent stays blocked across a reload,
   * and this is what a rejoining browser reads to know there is still a card to
   * draw. The record of what was *asked and answered* lives in the tool block,
   * which is where scrolling back finds it.
   */
  pendingQuestions: QuestionRequest[];
  /**
   * Answers already given, keyed by the tool call that asked.
   *
   * Keyed on `toolId` rather than `requestId` because the card that needs it is
   * drawn from a tool block, and by the time it asks, the request — the only
   * thing that knew both ids — has been dropped from the pending list. Falls
   * back to the request id for a question that could not be correlated to a
   * call, which is answered from the pinned card instead.
   */
  answeredQuestions: Record<string, string[]>;
  /** Lowest seq present. Non-zero once the log head has been trimmed. */
  firstSeq: number;
  /** Highest seq applied. Events at or below this are ignored as replays. */
  cursor: number;
  currentTurnId: string | null;
  nativeSessionId?: string;
  model?: string;
  lastError?: string;
}

/** What an apply touched, so a renderer can avoid redrawing the whole list. */
export interface TranscriptChange {
  /** Index of the single message that changed, when exactly one did. */
  messageIndex: number | null;
  /** True when the message list itself grew or shrank. */
  structural: boolean;
  /** True when session-level fields (state, usage, plan, permissions) changed. */
  meta: boolean;
  /** False when the event was a replay below the cursor and nothing happened. */
  applied: boolean;
}

const NO_CHANGE: TranscriptChange = {
  messageIndex: null,
  structural: false,
  meta: false,
  applied: false,
};

export function createTranscript(
  capabilities: ChatCapabilities,
  seed?: Partial<TranscriptState>,
): TranscriptState {
  return {
    messages: [],
    index: {},
    toolIndex: {},
    orphanToolPatches: {},
    state: 'starting',
    capabilities,
    usage: {},
    plan: [],
    pendingPermissions: [],
    pendingQuestions: [],
    answeredQuestions: {},
    firstSeq: 0,
    cursor: 0,
    currentTurnId: null,
    ...seed,
  };
}

/** Rebuild the id/tool lookup tables after messages are loaded wholesale. */
export function reindexTranscript(state: TranscriptState): void {
  state.index = {};
  state.toolIndex = {};
  state.messages.forEach((message, messageIndex) => {
    state.index[message.id] = messageIndex;
    message.blocks.forEach((block, blockIndex) => {
      if (block.kind === 'tool') {
        state.toolIndex[block.toolId] = [messageIndex, blockIndex];
      }
    });
  });
}

function messageFor(state: TranscriptState, msgId: string): number | null {
  const at = state.index[msgId];
  return at === undefined ? null : at;
}

/**
 * Merge only the keys that carry a value.
 *
 * A progress report names one thing at a time — the activity now, the tool
 * name now — and a plain `Object.assign` would write the absent keys back as
 * `undefined`, erasing what the previous report established. That reads as an
 * agent whose detail view keeps blanking out mid-run.
 */
function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Partial<T>;
}

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
function locateAgentRun(
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

/**
 * Apply one event.
 *
 * Events at or below the cursor are dropped rather than reapplied: a browser
 * that reconnects mid-turn receives a snapshot and then the tail, and the two
 * legitimately overlap. Making apply idempotent here is what lets the socket
 * layer stay simple about that overlap.
 */
export function applyChatEvent(state: TranscriptState, event: ChatEvent): TranscriptChange {
  if (event.seq !== undefined && event.seq <= state.cursor) {
    return NO_CHANGE;
  }
  if (event.seq !== undefined) {
    state.cursor = event.seq;
  }

  switch (event.t) {
    case 'session': {
      state.capabilities = event.capabilities;
      if (event.nativeSessionId) state.nativeSessionId = event.nativeSessionId;
      if (event.model) state.model = event.model;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'capabilities': {
      state.capabilities = { ...state.capabilities, ...event.capabilities };
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'msg_start': {
      // Idempotent: a replayed start must not fork the message in two.
      if (messageFor(state, event.id) !== null) {
        return NO_CHANGE;
      }
      const message: ChatMessage = {
        id: event.id,
        seq: event.seq,
        turnId: event.turnId,
        role: event.role,
        ts: event.ts,
        blocks: [],
        streaming: true,
        model: event.model,
      };
      state.index[event.id] = state.messages.length;
      state.messages.push(message);
      state.currentTurnId = event.turnId;
      return {
        messageIndex: state.messages.length - 1,
        structural: true,
        meta: false,
        applied: true,
      };
    }

    case 'block_start': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const message = state.messages[at];
      // Index is authoritative: runtimes address blocks by position, and a
      // gap means an event was lost, not that the block should be appended.
      while (message.blocks.length < event.index) {
        message.blocks.push({ kind: 'text', text: '' });
      }
      message.blocks[event.index] = event.block;
      if (event.block.kind === 'tool') {
        const toolId = event.block.toolId;
        state.toolIndex[toolId] = [at, event.index];
        const orphan = state.orphanToolPatches[toolId];
        if (orphan) {
          Object.assign(message.blocks[event.index] as ToolBlock, orphan);
          delete state.orphanToolPatches[toolId];
        }
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'block_delta': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const block = state.messages[at].blocks[event.index];
      if (!block) return NO_CHANGE;
      if (event.text !== undefined) {
        if (block.kind === 'text' || block.kind === 'thinking') {
          (block as TextBlock | ThinkingBlock).text += event.text;
        } else if (block.kind === 'tool') {
          // Streaming tool output, as opposed to streaming arguments.
          const tool = block as ToolBlock;
          tool.output = (tool.output || '') + event.text;
        }
      }
      if (event.json !== undefined && block.kind === 'tool') {
        const tool = block as ToolBlock;
        tool.inputPartial = (tool.inputPartial || '') + event.json;
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'block_end': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const block = state.messages[at].blocks[event.index];
      if (!block) return NO_CHANGE;
      if (event.block) {
        Object.assign(block, event.block);
      }
      if (block.kind === 'tool') {
        const tool = block as ToolBlock;
        // Arguments streamed in as JSON fragments only become usable now.
        if (tool.input === undefined && tool.inputPartial) {
          try {
            tool.input = JSON.parse(tool.inputPartial);
          } catch {
            // Keep the raw fragment: a half-written argument list is still
            // worth showing, and throwing here would lose the whole card.
            tool.input = tool.inputPartial;
          }
          delete tool.inputPartial;
        }
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'msg_end': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const message = state.messages[at];
      message.streaming = false;
      if (event.stopReason) message.stopReason = event.stopReason;
      if (event.usage) {
        message.usage = mergeUsage(message.usage, event.usage);
        state.usage = mergeUsage(state.usage, event.usage);
      }
      return {
        messageIndex: at,
        structural: false,
        meta: Boolean(event.usage),
        applied: true,
      };
    }

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
      Object.assign(block, event.patch);
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

    case 'plan': {
      state.plan = event.items;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'usage': {
      // Runtimes that report a running total would double-count if summed, so
      // absolute fields overwrite and only cost accumulates across turns.
      state.usage = { ...state.usage, ...event.usage };
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'permission': {
      const already = state.pendingPermissions.some(
        (pending) => pending.requestId === event.request.requestId,
      );
      if (!already) {
        state.pendingPermissions.push(event.request);
      }
      state.state = 'awaiting_permission';
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'permission_resolved': {
      state.pendingPermissions = state.pendingPermissions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      if (state.state === 'awaiting_permission' && state.pendingPermissions.length === 0) {
        state.state = 'running';
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'question': {
      const already = state.pendingQuestions.some(
        (pending) => pending.requestId === event.request.requestId,
      );
      if (!already) {
        state.pendingQuestions.push(event.request);
      }
      // Not folded into `awaiting_permission`: the composer, the header and the
      // stop button all read this, and "waiting for approval" over a question
      // about which of three approaches to take is simply the wrong sentence.
      state.state = 'awaiting_answer';
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'question_resolved': {
      const asked = state.pendingQuestions.find((pending) => pending.requestId === event.requestId);
      state.pendingQuestions = state.pendingQuestions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      // Kept after the fact so the card keeps showing what was picked once the
      // request itself is gone, without waiting for the runtime to echo a tool
      // result back.
      state.answeredQuestions[event.toolId ?? asked?.toolId ?? event.requestId] = event.skipped
        ? []
        : [...event.optionIds];
      if (state.state === 'awaiting_answer' && state.pendingQuestions.length === 0) {
        state.state = 'running';
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'state': {
      state.state = event.state;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'error': {
      state.lastError = event.message;
      if (event.fatal) state.state = 'error';
      // Surfaced in the transcript as well as the header: an error that only
      // lives in a status pill is an error the user scrolls past and misses.
      const last = state.messages[state.messages.length - 1];
      if (last && last.streaming) {
        last.blocks.push({ kind: 'error', text: event.message });
        return {
          messageIndex: state.messages.length - 1,
          structural: false,
          meta: true,
          applied: true,
        };
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'marker': {
      if (event.kind === 'cleared') {
        // Emptied, not annotated. `/clear` means "start again", and a window
        // still holding the previous conversation is the opposite of that —
        // and worse, it would show a history the agent can no longer see.
        state.messages = [];
        state.index = {};
        state.plan = [];
        state.lastError = undefined;
        // The cards go with the conversation they were asked in. A question
        // card left behind would be drawn against a tool block that is no
        // longer on screen, and answering it would reach a turn that no longer
        // exists — the session resolves them at the same moment on its side.
        state.pendingQuestions = [];
        state.answeredQuestions = {};
        // And the approvals with them, for the same reason and one more: an
        // approval card is drawn above the composer rather than inside the
        // conversation, so it is the one piece of the old conversation that
        // would still be on screen — asking whether a tool may run in a
        // process that has already been replaced. The session drops its side
        // as it stops.
        state.pendingPermissions = [];
        // And no paging back past it. The log still holds what was said — this
        // is a view, not a delete — but offering "load earlier messages" right
        // after someone asked for a clean window would undo the thing they
        // just asked for, one scroll at a time.
        state.firstSeq = event.seq;
        return { messageIndex: null, structural: true, meta: true, applied: true };
      }

      // Compaction keeps the transcript and draws a line across it. What was
      // said still happened and is still worth scrolling back to; the marker
      // is there because everything above it is no longer in the agent's
      // context, and an agent that quietly forgets the first hour is a
      // confusing one.
      const message: ChatMessage = {
        id: `marker-${event.seq}`,
        seq: event.seq,
        turnId: state.currentTurnId ?? `marker-${event.seq}`,
        role: 'system',
        ts: event.ts,
        blocks: [{
          kind: 'notice',
          notice: 'compacted',
          text: 'Context compacted',
          detail: event.detail,
        }],
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

    case 'turn_end': {
      state.currentTurnId = null;
      if (state.state !== 'error' && state.state !== 'exited') {
        state.state = 'idle';
      }
      for (const message of state.messages) {
        if (message.turnId === event.turnId) message.streaming = false;
      }
      if (event.usage) {
        state.usage = mergeUsage(state.usage, event.usage);
      }
      return { messageIndex: null, structural: true, meta: true, applied: true };
    }

    default:
      return NO_CHANGE;
  }
}

/** Convenience for replaying a whole log, e.g. when building a snapshot. */
export function applyAll(state: TranscriptState, events: ChatEvent[]): TranscriptState {
  for (const event of events) {
    applyChatEvent(state, event);
  }
  return state;
}

/** Plain text of a message, for search indexing and export. */
export function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    parts.push(blockText(block));
  }
  return parts.filter(Boolean).join('\n');
}

function blockText(block: ChatBlock): string {
  switch (block.kind) {
    case 'text':
    case 'thinking':
      return block.text;
    case 'error':
      return block.text;
    case 'tool':
      return [block.title || block.name, block.output].filter(Boolean).join('\n');
    case 'plan':
      return block.items.map((item) => `- [${item.status}] ${item.text}`).join('\n');
    case 'image':
      return block.alt || '';
    default:
      return '';
  }
}
