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
  AccountLimits,
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
  NoticeBlock,
  QuestionRequest,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  ToolStatus,
  carriesCost,
  carriesTokens,
  isSessionMintedMessageId,
  mergeUsage,
} from './chat-events.js';
import { turnOutcomeOf } from './turn-outcome.js';
import { openTurnAfter } from './turn-boundaries.js';
import { TERMINAL_TOOL as TERMINAL_STATUS, isWorkflowLaunch } from './agent-activity.js';

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
  /**
   * Every model the last turn was billed to, when the runtime broke it down.
   *
   * Beside `model` rather than replacing it: `model` is what to call the
   * conversation, and stays the model that answered. This is the honest
   * remainder — a subagent on another model, a fallback — which the header
   * shows as a count rather than pretending the turn ran on one thing.
   */
  turnModels?: string[];
  /**
   * The reasoning-effort level the runtime last said it was running.
   *
   * Only ever set from an `effort` event, which only ever carries something a
   * runtime reported. Absent means nobody has said — which is not the same as
   * "the default", and the control is careful to show the difference.
   */
  effort?: string;
  /**
   * Where the provider last said this account stands.
   *
   * Only ever set from a `limits` event, which only ever carries something a
   * runtime reported about itself. Absent means nobody has said — which the
   * status panel states in a sentence rather than drawing a bar against a
   * number it made up, the way it used to (#137).
   */
  limits?: AccountLimits;
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
 * The turn this conversation was last working on, or undefined for one that has
 * said nothing yet. See `openTurnAfter` for what goes back to it.
 */
function lastTurnId(state: TranscriptState): string | undefined {
  return state.messages[state.messages.length - 1]?.turnId;
}

/**
 * The reply still arriving, or -1.
 *
 * Searched from the end rather than read off it, because the end is not always
 * the reply: a rule drawn across the conversation is pushed there while one is
 * still streaming. Bounded because the answer is always within a message or two
 * of the end — a scan of an hour-long transcript on every error is not.
 */
function lastStreamingIndex(state: TranscriptState): number {
  const floor = Math.max(0, state.messages.length - 8);
  for (let i = state.messages.length - 1; i >= floor; i -= 1) {
    if (state.messages[i].streaming) return i;
  }
  return -1;
}

/**
 * Fold one event's word about the runtime into what is known so far.
 *
 * Split out for the same reason as the usage fold below, and with the same
 * hazard behind it: a snapshot replays only the tail, but what a runtime can do
 * is announced once at the head, so the server has to read this from the whole
 * log without building a transcript. Two implementations would be two answers
 * to "is there a command menu" for the same conversation.
 *
 * An introduction replaces — a process that has just started is describing
 * itself, not adding to whatever the last one said — while a later report
 * merges into it.
 */
export function foldCapabilities(
  capabilities: ChatCapabilities,
  event: ChatEvent,
): ChatCapabilities {
  if (event.t === 'session') return { ...event.capabilities };
  if (event.t === 'capabilities') return { ...capabilities, ...event.capabilities };
  return capabilities;
}

/**
 * What a conversation has spent, folded one event at a time.
 *
 * Split out of the reducer's own cases so there is exactly one answer to it.
 * The server needs this reading of the log *without* building a transcript —
 * a snapshot replays only the tail, and a session's cost is a property of the
 * whole conversation, not of the last forty messages — and two implementations
 * of "how much has this cost" would be two numbers for the browser to show
 * alternately, which is precisely the bug that made a live meter appear to
 * reset on every rejoin.
 *
 * Returns the new running total rather than mutating the one it was given: the
 * browser hands this object straight to the meter, which re-renders on the
 * object changing, so folding in place would leave the number on screen stale.
 */
export function foldSessionUsage(usage: ChatUsage, event: ChatEvent): ChatUsage {
  switch (event.t) {
    // A clear ends the conversation the figures were about, so they go back to
    // nothing along with it. Handled here rather than only in the reducer
    // because the server folds the log without building a transcript, and the
    // two answers to "what has this cost" have to be the same one.
    case 'marker':
      return event.kind === 'cleared' ? clearedUsage(usage) : usage;
    // Per-message and per-turn reports are deltas, so they sum.
    case 'msg_end':
    case 'turn_end':
      return event.usage ? mergeUsage(usage, event.usage) : usage;
    case 'usage': {
      // A standalone report is a running total — summing it would count the
      // same tokens once per report — so its fields replace. Only the ones it
      // actually carries: a runtime that reports a context window and no money
      // (or money in a currency this cannot show) would otherwise write cost
      // back as `undefined` and blank a figure it never spoke about.
      const next = { ...usage };
      assignDefined(next, event.usage);
      // The one thing `assignDefined` has no way to express, and must not
      // learn: a report that names no window because nobody could size the
      // model is asking for the ceiling to come down, where every other report
      // that leaves the field out is simply not talking about it.
      if (event.usage.contextWindowSource === 'unknown') next.contextWindow = undefined;
      // And the mirror of it, which `assignDefined` cannot express either: a
      // report carrying figures says somebody reports them, so an earlier
      // "this runtime reports nothing" has to come off. `mergeUsage` reaches
      // the same conclusion on the additive path; the two have to agree or the
      // header and the history end up saying different things about one
      // conversation.
      if (carriesTokens(event.usage)) next.usageSource = 'agent';
      if (carriesCost(event.usage)) next.costSource = 'agent';
      return next;
    }
    default:
      return usage;
  }
}

/**
 * What each rule drawn across a conversation says.
 *
 * A table rather than a chain of ternaries because the words are the whole of
 * what a rule communicates: a reader sees one short phrase and has to
 * understand from it that the transcript above is no longer what the agent can
 * see, or was said somewhere else entirely. `cleared` is here for completeness —
 * it empties the window rather than drawing a line, and is handled before this
 * is reached.
 *
 * Keyed by `NoticeBlock['notice']` rather than by marker kind, which is what
 * leaves `approvals` out: it is a marker that draws nothing, and the type says
 * so instead of a comment having to.
 */
const NOTICES: Record<
  NoticeBlock['notice'],
  { notice: NoticeBlock['notice']; text: string }
> = {
  compacted: { notice: 'compacted', text: 'Context compacted' },
  interrupted: { notice: 'interrupted', text: 'Interrupted to send' },
  branched: { notice: 'branched', text: 'Branched from an earlier conversation' },
  cleared: { notice: 'cleared', text: 'New conversation' },
};

/** Every token field a runtime can report, so a reset covers all of them. */
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'contextUsed',
] as const;

/**
 * What the meter reads after a clear: nothing spent, nothing occupied.
 *
 * Zeroed rather than emptied. An empty object renders no meter at all, and a
 * header that goes blank the moment somebody clears looks like a readout that
 * broke rather than one that reset — where zero is the true and useful answer:
 * this conversation has spent nothing yet. Every field the runtime had been
 * reporting is set to zero and no field it had not is invented, so a runtime
 * that reports no money still shows no money.
 *
 * The context *window* survives, because it is a fact about the model rather
 * than about the conversation — a new conversation on the same model has the
 * same capacity, and dropping it would replace "0%" with "size unknown" for a
 * size that is perfectly well known.
 */
function clearedUsage(usage: ChatUsage): ChatUsage {
  const next: ChatUsage = {};
  for (const field of TOKEN_FIELDS) {
    if (usage[field] !== undefined) next[field] = 0;
  }
  if (usage.costUsd !== undefined) next.costUsd = 0;
  if (usage.contextWindow !== undefined) {
    next.contextWindow = usage.contextWindow;
    next.contextWindowSource = usage.contextWindowSource;
  } else if (usage.contextWindowSource === 'unknown') {
    // And so does the absence of one, for the same reason: clearing changes
    // the conversation, not the model, and the model nobody could size is
    // still that model. Carried rather than dropped so a clear cannot quietly
    // turn "we asked and nobody knew" back into "nobody has asked yet".
    next.contextWindowSource = 'unknown';
  }
  // Same rule, third time: what the runtime reports is a fact about the
  // runtime, and a clear replaces the conversation rather than the agent
  // running it. Dropped here, clearing a kimi chat would turn "this agent
  // reports nothing" back into "nobody has said yet", and the header would go
  // quiet again until the next turn ended.
  if (usage.usageSource === 'none') next.usageSource = 'none';
  if (usage.costSource === 'none') next.costSource = 'none';
  return next;
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

/**
 * Fold a reported list into the one already held, keyed by `index`.
 *
 * The runtime sends a complete snapshot on some reports and nothing at all on
 * others, so an absent list leaves what is known standing rather than emptying
 * it. Rows arrive in the order they were started and keep it: an agent that
 * reports again is written back in place, so watching a run does not shuffle
 * the list under the reader.
 */
function upsertByIndex<T extends { index: number }>(target: T[], incoming: T[] | undefined): void {
  if (!incoming) return;
  for (const entry of incoming) {
    const at = target.findIndex((held) => held.index === entry.index);
    if (at >= 0) target[at] = entry;
    else target.push(entry);
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
function settleUnreportedTools(state: TranscriptState, turnId: string | null, force: boolean): boolean {
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
function settleUnobservableWorkflows(state: TranscriptState): void {
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
      state.capabilities = foldCapabilities(state.capabilities, event);
      if (event.nativeSessionId) state.nativeSessionId = event.nativeSessionId;
      if (event.model) state.model = event.model;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'capabilities': {
      state.capabilities = foldCapabilities(state.capabilities, event);
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'effort': {
      // Cleared rather than left standing when the runtime reports null: it has
      // gone back to its own default, and a stale level on the chip would keep
      // claiming a choice nobody is running any more.
      state.effort = event.effort ?? undefined;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'limits': {
      // Replaced whole, not merged: the adapter accumulates the account picture
      // across a conversation and re-sends all of it, so the newest event is
      // always the complete answer. Merging here would keep a window alive
      // after the provider stopped reporting it.
      state.limits = event.limits;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'msg_start': {
      // Idempotent: a replayed start must not fork the message in two.
      if (messageFor(state, event.id) !== null) {
        return NO_CHANGE;
      }
      // A prompt the runtime handed back, in a conversation recorded before the
      // adapters stopped doing it (#129).
      //
      // Every ACP runtime and both codex modes used to write the user's message
      // into the transcript a second time, under a turn id of their own, right
      // after the session had written it — one prompt, two identical bubbles.
      // The adapters no longer do it and the session now refuses it, but the
      // logs already on disk still hold both, and they are replayed through
      // this reducer every time one of those conversations is opened. Drawing
      // them is not something a migration should have to fix.
      //
      // The test is what the echo *is*, not what it looks like: only
      // `ChatSession.deliver` ever writes a user message in this app, and it
      // always mints `user-<uuid>`. So a message claiming to be the user, with
      // an id nothing in this app would have minted, arriving inside a turn
      // that already carries the user's own — that is a runtime repeating the
      // prompt. A real second prompt cannot be caught by it: a real one comes
      // from `deliver`, and is therefore session-minted. `steer` is excluded
      // because a steer is also `deliver`'s and shares the open turn on purpose.
      if (
        event.role === 'user'
        && !event.steer
        && state.currentTurnId
        && event.turnId !== state.currentTurnId
        && !isSessionMintedMessageId(event.id)
        && state.messages.some((m) => m.turnId === state.currentTurnId && m.role === 'user')
      ) {
        return NO_CHANGE;
      }
      // Everything said while a turn is open belongs to that turn, whatever id
      // it arrived with — the accountant's rule, word for word (#86).
      //
      // It has to be that strong, because **no adapter reuses the id this app
      // minted**: the session stamps the user's message `turn-<uuid>` and the
      // runtime answers under a name of its own (`omp-turn-3`, its own uuid),
      // with codex and the ACP agents echoing the prompt back under that name
      // first. Checked against every conversation on this machine: in 46 of 46,
      // the agent's messages share no id with the request that caused them. So
      // grouping on the id as it arrives splits every single turn in two — the
      // ask in one, the answer in another with no prompt to name it by.
      //
      // A turn is open from the user's message to `turn_end`, and `turn_end`,
      // an exit and a `/clear` are the three things that close one — and an
      // agent that speaks again with no request in front of it goes back to the
      // turn it was last working on rather than opening one nobody asked for.
      // See `openTurnAfter`, which is that whole rule and is also what the
      // server's turn index and its windowed reads apply.
      const turnId = openTurnAfter(event, state.currentTurnId, lastTurnId(state)) as string;

      // A new turn's models are not known yet, and last turn's are not this
      // turn's: leaving them would keep a "+1" on the chip for a turn that ran
      // on one model, which is a claim about work that has not happened.
      if (turnId !== state.currentTurnId) state.turnModels = undefined;
      const message: ChatMessage = {
        id: event.id,
        seq: event.seq,
        turnId,
        role: event.role,
        ts: event.ts,
        blocks: [],
        streaming: true,
        model: event.model,
        ...(event.steer ? { steer: true as const } : {}),
      };
      state.index[event.id] = state.messages.length;
      state.messages.push(message);
      state.currentTurnId = turnId;
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
      // Additive, like the text beside it: a runtime that will not show its
      // reasoning still counts it out loud as it goes, and the row's size
      // figure should climb while the model is still thinking rather than
      // appearing all at once when the block closes.
      if (event.tokens !== undefined && block.kind === 'thinking') {
        const thinking = block as ThinkingBlock;
        thinking.tokens = (thinking.tokens ?? 0) + event.tokens;
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
        state.usage = foldSessionUsage(state.usage, event);
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

    case 'plan': {
      state.plan = event.items;
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'usage': {
      // Runtimes that report a running total would double-count if summed, so
      // absolute fields overwrite. See `foldSessionUsage` for why only the
      // fields the report actually carries are written.
      state.usage = foldSessionUsage(state.usage, event);
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
      // A runtime that died did not end its turn, and nothing else will. Left
      // open, the next thing the user typed would be folded into a turn whose
      // process is gone — the mirror of the `turn_end` case, and the same rule
      // the accountant applies when it closes a job on an exit (#86).
      const wasOpen = state.currentTurnId;
      state.currentTurnId = openTurnAfter(event, state.currentTurnId);
      if (event.state === 'exited' || event.state === 'error') {
        // Workflows first: a run left watching nothing gets its own honest
        // ending (#116), and only then is the rest of the dead turn swept —
        // nothing can report once the child is gone, so the exemption for a
        // run still reporting about itself does not apply here (#139).
        settleUnobservableWorkflows(state);
        settleUnreportedTools(state, wasOpen, true);
      }
      return { messageIndex: null, structural: false, meta: true, applied: true };
    }

    case 'error': {
      state.lastError = event.message;
      if (event.fatal) state.state = 'error';
      // Surfaced in the transcript as well as the header: an error that only
      // lives in a status pill is an error the user scrolls past and misses.
      //
      // The last message that is *streaming*, not simply the last one. A rule
      // drawn across a conversation — a compaction, an interruption, a workflow
      // that failed in the background (#140) — is pushed onto the end while a
      // reply is still arriving, and answering "is the last message open?" with
      // that rule dropped every error for the rest of the turn.
      const openIndex = lastStreamingIndex(state);
      const last = openIndex === -1 ? undefined : state.messages[openIndex];
      if (last && last.streaming) {
        // `fatal` carried through rather than flattened away: it is the
        // difference between an error the agent read and moved past and the one
        // it stopped on, and a turn cut short by the second never reaches a
        // `turn_end` that could say so.
        last.blocks.push({ kind: 'error', text: event.message, ...(event.fatal ? { fatal: true } : {}) });
        return { messageIndex: openIndex, structural: false, meta: true, applied: true };
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
        // And the figures above it go back to nothing: the tokens, the money
        // and the context bar were all statements about the conversation that
        // has just ended. Left running, the new conversation opens carrying the
        // last one's bill — and a context bar reading 80% full of a window that
        // is now empty, which is the reading somebody clears in order to fix.
        state.usage = foldSessionUsage(state.usage, event);
        // Including the turn that was open: `/clear` is taken the moment it is
        // typed, mid-turn if need be, and the conversation it interrupted is
        // gone. Anything typed after it starts a turn of its own.
        state.currentTurnId = null;
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

      // And the one that leaves nothing at all.
      //
      // The approval mode has to travel as an event — a conversation restarted
      // from inside itself re-decides it, and this marker is the only thing that
      // reaches the browser with the answer (#134) — but it is a standing fact
      // about the session rather than something that happened in the
      // conversation, and the surfaces that state standing facts say it
      // permanently: the badge in the header and the chip beside the composer,
      // both off `bypassing`.
      //
      // Written into the transcript as well, it was the whole of a conversation
      // nobody had spoken in yet. A chat opened and sat there showing a rule, a
      // turn strip and a row in the index for a turn that had not happened —
      // numbered 1, so the first question the user actually asked opened turn 2,
      // and both rows read "turn 1" until the recorded index arrived to
      // disagree. A conversation starts empty and the user's first prompt starts
      // turn 1.
      //
      // The event itself is untouched: it is still written to the log, so the
      // recording still says which mode each conversation ran in and when that
      // was decided. Only the row it used to draw is gone.
      if (event.kind === 'approvals') {
        return { messageIndex: null, structural: false, meta: false, applied: true };
      }

      // The ones that leave a line rather than empty the window. Compaction is
      // there because everything above it is no longer in the agent's context,
      // and an agent that quietly forgets the first hour is a confusing one.
      // An interruption is there because the turn above it stopped for a
      // reason — the message immediately below — and a transcript that showed
      // the stop without the reason would read as an agent that gave up. A
      // branch is there because everything above it happened in another
      // conversation, and a copied history presented as this one's own would
      // be the same lie in the other direction.
      //
      // What they have in common, and what `approvals` above does not, is that
      // each of them is an event in the conversation's own history: it happened
      // at a point in the transcript and means nothing anywhere else.
      const notice = NOTICES[event.kind];
      const message: ChatMessage = {
        id: `marker-${event.seq}`,
        seq: event.seq,
        // The turn it was drawn in, or the one it was drawn under: a line
        // marking what happened to the conversation is not a turn of its own,
        // and numbering it as one puts a row in the index nobody asked for.
        //
        // Except the one that says where this conversation came from. Joined to
        // the last carried turn it disappears the moment that turn folds, which
        // is the moment the branch is used — so the only statement that the
        // history above belongs to another conversation is the one thing a
        // reader cannot find. It stands on its own instead.
        turnId:
          event.kind === 'branched'
            ? `marker-${event.seq}`
            : state.currentTurnId ?? lastTurnId(state) ?? `marker-${event.seq}`,
        role: 'system',
        ts: event.ts,
        blocks: [{ kind: 'notice', ...notice, detail: event.detail }],
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
      // A turn interrupted to redirect it is not a turn that ended: the
      // message that cut it short was delivered into it and the agent is
      // already working on it again. What the runtime is acknowledging here is
      // the half it abandoned, so this takes the spend and leaves the turn
      // open, running, and unstamped — see `stale` on the event.
      if (!event.stale) {
        if (state.state !== 'error' && state.state !== 'exited') {
          state.state = 'idle';
        }
        // The runtime's own word for how the turn concluded, kept rather than
        // dropped: it is the only statement any of them makes about the turn as
        // a whole, and without it the badge is left inferring one from whichever
        // steps inside it went wrong (issue #74).
        const outcome = turnOutcomeOf(event.stopReason);
        // Against the turn the messages are actually filed under, which is the
        // one this app opened rather than the name the runtime ends it by — see
        // `msg_start`. Comparing the runtime's own id here stamped the outcome
        // onto nothing at all.
        const ended = state.currentTurnId ?? event.turnId;
        for (const message of state.messages) {
          if (message.turnId === ended) {
            message.streaming = false;
            message.turnOutcome = outcome;
          }
        }
        // And the calls inside it that never reported an ending (#139). Inside
        // `!event.stale` on purpose: an interrupt-to-redirect acknowledges the
        // half it abandoned and the turn is still running, so nothing in it has
        // stopped reporting yet.
        settleUnreportedTools(state, ended, false);
        state.currentTurnId = null;
      }
      if (event.usage) {
        state.usage = mergeUsage(state.usage, event.usage);
      }
      if (event.models && event.models.length > 0) {
        state.turnModels = event.models.map((entry) => entry.model);
        // The header takes the model that answered — the one the messages of
        // this turn already carry — and only falls back to the busiest of the
        // reported models when nothing said. Preferring the report outright
        // would rename a claude conversation from what its messages say to the
        // billing alias beside it, which is the same name twice and reads as a
        // model switch nobody made.
        const answered = state.messages.find(
          (message) => message.turnId === event.turnId && message.role === 'assistant' && message.model,
        );
        state.model = answered?.model
          ?? [...event.models].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))[0].model;
        // A message that never carried one gets the answer this turn produced,
        // so scrolling back does not show a blank where the record has a name.
        if (state.turnModels.length === 1) {
          for (const message of state.messages) {
            if (message.turnId === event.turnId && message.role === 'assistant' && !message.model) {
              message.model = state.turnModels[0];
            }
          }
        }
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
