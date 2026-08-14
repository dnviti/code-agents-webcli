import type {
  AgentRun,
  AgentStepPatch,
  ChatRole,
  PlanItem,
  ToolBlock,
  WorkflowAgent,
  WorkflowPhase,
} from './core.js';
import type { AccountLimits, ChatUsage, TurnModelUsage } from './usage.js';
import type {
  PermissionRequest,
  QuestionContinuation,
  QuestionRequest,
} from './request.js';
import type { ChatCapabilities, ChatState } from './model.js';
import type { ChatBlock } from './chat-block.js';
import type { BuiltInWorkflowId } from './workflow.js';
/**
 * The event union adapters emit.
 *
 * Deltas rather than snapshots: a turn can run for minutes and re-sending the
 * whole transcript per token would be untenable. `seq` is assigned by the
 * session (not the adapter) and is the ordering authority — it numbers the
 * event log, drives history paging, and lets a reconnecting browser say
 * exactly how much it already has.
 */
export type ChatEvent =
  /** Emitted once the runtime is up; carries what it told us about itself. */
  | {
      t: 'session';
      seq: number;
      ts: number;
      /** The runtime's own session id, needed to resume it later. */
      nativeSessionId?: string;
      model?: string;
      cwd?: string;
      capabilities: ChatCapabilities;
    }
  | {
      t: 'msg_start';
      seq: number;
      ts: number;
      id: string;
      role: ChatRole;
      turnId: string;
      model?: string;
      /** Internal app-owned workflow intent, set only on the recorded user prompt. */
      workflow?: BuiltInWorkflowId;
      /**
       * Set on a user message that was delivered *into* the turn already
       * running, rather than waiting for its own (#86).
       *
       * Recorded rather than worked out later, because it cannot be worked out
       * later: two messages typed while the agent was busy look identical
       * afterwards, and which of them steered the running work and which waited
       * its turn is the whole of what decides the turn count. A steer carries
       * the running turn's own `turnId`, so the transcript and the accounting
       * both fold it into the turn it belongs to; this flag is what says that
       * was deliberate.
       */
      steer?: true;
    }
  | { t: 'block_start'; seq: number; ts: number; msgId: string; index: number; block: ChatBlock }
  /**
   * Append to an open block. `text` extends a text/thinking block; `json`
   * extends a tool block's streaming arguments; `tokens` adds to a thinking
   * block's reported size, for a runtime that reports the size of reasoning it
   * will not show (see `ThinkingBlock.tokens`).
   */
  | {
      t: 'block_delta';
      seq: number;
      ts: number;
      msgId: string;
      index: number;
      text?: string;
      json?: string;
      tokens?: number;
    }
  | { t: 'block_end'; seq: number; ts: number; msgId: string; index: number; block?: Partial<ChatBlock> }
  | { t: 'msg_end'; seq: number; ts: number; msgId: string; stopReason?: string; usage?: ChatUsage }
  /**
   * Patch a tool block found by `toolId`, wherever it sits in the transcript.
   *
   * Tool results arrive out of band in every protocol here — after the message
   * that opened the call has already closed — so they cannot be a block_delta.
   */
  | { t: 'tool'; seq: number; ts: number; toolId: string; patch: Partial<ToolBlock> }
  /**
   * One step a delegated agent took, addressed to the delegation that owns it.
   *
   * Separate from `tool` because it is keyed twice over: `parentToolId` finds
   * the delegation's block, and `step.id` finds (or creates) the step inside
   * it. Routing this through `tool` would put sub-agent tool ids into the
   * transcript's own index, where a later top-level patch could hit them.
   */
  | { t: 'agent_step'; seq: number; ts: number; parentToolId: string; step: AgentStepPatch }
  /** Progress for the run as a whole, merged over whatever is already known. */
  | {
      t: 'agent_progress';
      seq: number;
      ts: number;
      parentToolId: string;
      patch: Partial<Omit<AgentRun, 'steps'>>;
    }
  /**
   * The structure of a workflow run, addressed to the call that started it.
   *
   * Separate from `agent_progress` because the merge is different: that patch
   * is a shallow assign over the run, and these are lists whose rows have to
   * survive a report that does not mention them. See `WorkflowRun`.
   */
  | {
      t: 'workflow_progress';
      seq: number;
      ts: number;
      parentToolId: string;
      phases?: WorkflowPhase[];
      agents?: WorkflowAgent[];
    }
  /**
   * A workflow run ended badly, addressed to the call that started it.
   *
   * Its own event rather than an `error` or a `tool` patch, because it is one
   * fact with three consequences and they have to happen together: the call
   * that launched the run is no longer a success, the conversation has to say
   * so where the person will read it, and somebody who is not looking has to be
   * told. Sending three events would let a replay apply two of them.
   *
   * Raised only for the run's *own* verdict. Agents inside a workflow fail
   * routinely and by design — `parallel()` resolves a thrown agent to `null`
   * rather than rejecting — so a failed agent is counted (see
   * `summarizeWorkflow`) and never announced as the run failing (#140).
   */
  | {
      t: 'workflow_failed';
      seq: number;
      ts: number;
      /** The tool call that launched the run. */
      parentToolId: string;
      /** The run's own name, when it has one. */
      name?: string;
      /** Why it ended, in the runtime's own words. */
      reason?: string;
    }
  | { t: 'plan'; seq: number; ts: number; items: PlanItem[] }
  | { t: 'usage'; seq: number; ts: number; usage: ChatUsage }
  | { t: 'permission'; seq: number; ts: number; request: PermissionRequest }
  | {
      t: 'permission_resolved';
      seq: number;
      ts: number;
      requestId: string;
      optionId: string;
      /** True when the choice let the tool run. */
      allowed: boolean;
      /** Set when the decision came from the bypass setting, not a person. */
      automatic?: boolean;
    }
  | { t: 'question'; seq: number; ts: number; request: QuestionRequest }
  | {
      t: 'question_resolved';
      seq: number;
      ts: number;
      requestId: string;
      /**
       * The tool call that asked, repeated from the request.
       *
       * Carried on the resolution as well so a card rebuilt from the log alone
       * can find its own answer: the request is dropped from the pending list
       * the moment it resolves, and the id would otherwise go with it.
       */
      toolId?: string;
      /** Every option the user picked, in the order the question offered them. */
      optionIds: string[];
      /**
       * What the user typed instead of, or alongside, picking.
       *
       * The card always offers a free-text answer, because "none of these is
       * quite right" is a real answer and an option list the model wrote cannot
       * anticipate it. Recorded beside the picks rather than folded into them:
       * an id names something the question offered, and this is the one part of
       * the answer that it did not.
       */
      text?: string;
      /**
       * True when the user chose to answer nothing.
       *
       * The model is still told — it is blocked and something has to come back —
       * but the transcript says "skipped" rather than inventing a selection.
       */
      skipped?: boolean;
      /**
       * True when nobody was given the chance: the call that asked died first.
       *
       * A different fact from `skipped`, and worth its own field because the two
       * are opposite accusations. "Skipped" says a person saw the question and
       * declined it. This says the agent stopped listening — its tool call timed
       * out, the turn was cancelled, the session was closed — and an answer
       * given now would reach nothing. Drawing that as a skip blamed the user
       * for a card they were never able to answer (#174).
       */
      abandoned?: boolean;
      /**
       * Present only for an answered structured handoff. Its presence is the
       * durable outbox marker: the answer is acknowledged only after this
       * payload and the resolution are one committed log record.
       */
      continuation?: QuestionContinuation;
    }
  | {
      /** Durable pre-send claim for one structured-handoff continuation. */
      t: 'question_continuation_dispatching';
      seq: number;
      ts: number;
      requestId: string;
      continuationId: string;
    }
  | {
      /** The live process withdrew a pre-send claim before invoking the adapter. */
      t: 'question_continuation_pending';
      seq: number;
      ts: number;
      requestId: string;
      continuationId: string;
    }
  | {
      /** Terminal record for the structured-handoff continuation outbox. */
      t: 'question_continuation';
      seq: number;
      ts: number;
      requestId: string;
      continuationId: string;
      outcome: 'delivered' | 'abandoned';
      reason?: string;
    }
  | { t: 'state'; seq: number; ts: number; state: ChatState }
  | { t: 'error'; seq: number; ts: number; message: string; fatal?: boolean }
  | {
      t: 'turn_end';
      seq: number;
      ts: number;
      turnId: string;
      stopReason?: string;
      usage?: ChatUsage;
      durationMs?: number;
      /**
       * How many round trips to the model the turn took, where the runtime
       * counts them itself — Claude's `num_turns`.
       *
       * Only ever the runtime's own figure. Counting the messages that came out
       * instead is what made this number mean a different thing per agent, so
       * there is nowhere here for a derived one to go: a runtime that does not
       * report it leaves this unset, and every surface downstream says "not
       * reported" rather than showing a count it inferred (#86).
       */
      modelTurns?: number;
      /**
       * Which models actually ran this turn, when the runtime said.
       *
       * Late by nature: a runtime that breaks its spend down per model does it
       * at the end, once it knows. So this is a correction as much as a
       * report — it is what lets a conversation that opened with no model at
       * all end the turn naming the one that answered.
       */
      models?: TurnModelUsage[];
      /**
       * The runtime letting go of work that was cut short, not a turn ending.
       *
       * Sending a message ahead of the queue interrupts the agent, and every
       * runtime here answers an interrupt by ending its own run — but the turn
       * is not over: the message was delivered *into* it and the agent carries
       * straight on with it. Left unmarked, that acknowledgement closed the
       * turn a moment before the redirected work began, so the answer to the
       * correction arrived in a turn of its own with nobody's question in it.
       *
       * What it still carries is what the cut-short half spent, which is real
       * money and stays on the turn's bill. Only the ending is suppressed.
       */
      stale?: true;
    }
  /** The runtime revised what it can do — new slash commands, a model switch. */
  | { t: 'capabilities'; seq: number; ts: number; capabilities: Partial<ChatCapabilities> }
  /**
   * The runtime said which reasoning-effort level it is now running.
   *
   * Emitted only where the runtime itself reported the level — at a handshake
   * that names it, or after a change the runtime acknowledged. Nothing emits
   * this on the strength of having *asked*: the whole point of a separate event
   * is that the chip shows what the agent said it is doing, not what this app
   * requested and hopes it got. A request that was accepted but not confirmed
   * travels the same road a model switch does, as `applied: 'sent'`.
   *
   * `null` means the runtime is back on its own default.
   */
  | { t: 'effort'; seq: number; ts: number; effort: string | null }
  /**
   * The provider stated where this account stands against its rate limits.
   *
   * Named `limits` and not `plan` because `plan` is already taken by plan
   * *mode* — the checklist an agent publishes while it thinks — and the two
   * would be indistinguishable in a log.
   *
   * Carries the whole picture every time rather than a patch: the adapter that
   * emits it is the thing accumulating windows across a conversation, so the
   * reducer can replace wholesale and a browser that joined late is not left
   * assembling a half-window out of events it never saw.
   */
  | { t: 'limits'; seq: number; ts: number; limits: AccountLimits }
  /**
   * Something happened to the conversation itself.
   *
   * `compacted` leaves a marker in place and keeps the transcript: what was
   * said still happened and is still worth scrolling back to, even though the
   * agent can no longer see it. `cleared` empties the transcript, because that
   * is what the user asked for — `/clear` means "start again", and a window
   * still full of the previous conversation would be the opposite of that.
   * `interrupted` records a turn cut short so the message waiting behind it
   * could be answered first: without it the transcript reads as an agent that
   * stopped for no reason, and the message that follows looks unrelated to the
   * work that stopped. `detail` carries what that message was.
   *
   * `branched` closes the history a new conversation was started from. What is
   * above it was said somewhere else and copied here to be read; what is below
   * it is this conversation's own. The agent is handed the same history as its
   * opening context, and the line is where a reader is told so — a branch that
   * looked like an ordinary transcript would be claiming the agent lived
   * through it (#34).
   *
   * `approvals` is the one that draws nothing. The mode is decided when a
   * conversation begins, from a preference that lives in Settings and may have
   * been changed since the last one, so it has to travel — but it is a standing
   * fact about the session rather than something that happened in it, and the
   * two indicators that state standing facts (the header badge and the chip
   * beside the composer) both read it off `bypassing` (#134). Drawn in the
   * transcript as well, it was the only thing on screen in a conversation
   * nobody had spoken in yet, and it took turn 1 from the user's first question.
   * `detail` carries the phrase those indicators do not need.
   */
  | {
      t: 'marker';
      seq: number;
      ts: number;
      kind: 'compacted' | 'cleared' | 'interrupted' | 'branched' | 'approvals' | 'model';
      detail?: string;
      /**
       * On an `approvals` marker: the mode the conversation actually started
       * in, as a fact rather than as the phrase `detail` renders.
       *
       * This is the *only* thing that tells a browser the mode changed under an
       * in-conversation `/clear`. `chat_started` is broadcast from the launch
       * path alone, and a restart from inside a conversation never goes through
       * it — so without this field a pane goes on drawing the mode the
       * conversation had before the clear, indefinitely, and a chip reading
       * "asks first" over an agent now running unattended is the one direction
       * of wrongness this feature exists to remove (#134).
       *
       * Optional because every other marker kind has no mode, and because a
       * transcript recorded before this field existed must still replay.
       */
      bypassing?: boolean;
    };

