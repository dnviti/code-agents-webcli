/**
 * Turning a stream of chat events into one accounting record per job.
 *
 * This watches the same events the transcript is built from and answers a
 * different question: not "what did the agent say" but "what did that cost".
 * It is deliberately a pure observer — it is fed events, it never asks anything
 * of the session, and it holds nothing that could not be recomputed by replaying
 * the log. That is what makes it safe to hang off `ChatSession.ingest`, the one
 * choke point every event already passes through.
 *
 * ## What a job is
 *
 * One prompt, and everything the agent did to answer it: the span from the user's
 * message to the runtime's `turn_end`. **That span is a turn** — the unit is the
 * measurement, so the turn count is the number of these and there is nothing else
 * to count (#86). Every runtime here has that boundary, which is what makes the
 * figure mean the same thing whichever one ran the work.
 *
 * Two quantities live inside the span. *Tool calls* counts the tool blocks that
 * opened, from the transcript, because a tool block is a tool call in every
 * protocol here. *Model turns* — round trips to the model — is taken only where
 * the runtime reports its own, and is null otherwise. It used to be counted as
 * assistant messages, and that was the defect behind #86: an agent that separates
 * its thinking from its answer filed six where an agent that says everything at
 * once filed one, for identical work, and those figures were what the dashboard
 * compared agents by. The two are kept apart by name on every surface: the turn
 * is the unit, a model turn is one round trip inside it.
 *
 * ## What a mid-work message belongs to
 *
 * A message typed while the agent is working is not automatically part of that
 * work. What decides it is where it was delivered:
 *
 * - Queued behind the running turn → it starts its own job when it goes out. It
 *   was never part of the work that was running.
 * - Pushed into the running turn to redirect it (`sendQueuedNow`) → it continues
 *   that job rather than opening one. Steering the current work is part of that
 *   work.
 *
 * The session says which by giving a steer the running turn's own id and marking
 * the message `steer`; this reopens the job it just closed and files one record
 * for the pair. `INSERT OR REPLACE` on `<session>:<turn>` is what makes that
 * safe — the second filing replaces the first rather than adding to it.
 *
 * ## Additive versus absolute reporting
 *
 * Runtimes disagree about what a usage figure means, and getting this wrong
 * silently multiplies somebody's bill:
 *
 * - claude, grok, pi and the ACP agents report a figure *for the message or the
 *   turn*. Those sum.
 * - codex reports a running total for the whole conversation on a standalone
 *   `usage` event, and so does an ACP `usage_update`. Summing those would count
 *   every earlier turn again on every later one.
 *
 * The rule mirrors the shared reducer exactly, which is the point — the number
 * filed here and the number on screen come from the same reading of the same
 * events. Figures on `msg_end`/`turn_end` add up; a standalone `usage` event
 * replaces, and a job's share of it is what it grew by while that job ran.
 *
 * The one thing not handled here is Claude's cumulative *cost*, which is fixed
 * in the adapter that produces it — see `costBaselineUsd` in the claude adapter.
 * Correcting it there rather than here keeps a single invariant for everyone
 * downstream, the live meter included: cost on a turn is that turn's cost.
 */

import { ChatEvent, ChatUsage, TurnModelUsage, mergeUsage } from '../../shared/chat-events.js';
import { UsageOutcome, UsageToolCount } from '../../shared/usage-records.js';

/** Everything the accountant knows about a job it has just closed. */
export interface FinishedJob {
  turnId: string;
  nativeSessionId: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number | null;
  outcome: UsageOutcome;
  /** The runtime's own round-trip count, or null where it does not report one. */
  modelTurns: number | null;
  toolCalls: number;
  usage: ChatUsage;
  tools: UsageToolCount[];
  /**
   * How the spend divides between models, where the runtime divided it.
   *
   * Empty for the runtimes that report one model or none — which is not the
   * same as a single-entry list, and the difference is the point: an entry
   * here means the runtime measured that model's share, and nothing else may
   * put a figure in it. `model` above still names the model that answered, so
   * a reader that does not care about the split is unaffected.
   */
  models: TurnModelUsage[];
}

interface OpenJob {
  turnId: string;
  startedAt: number;
  model: string | null;
  /** Null until a runtime reports one; summed when a steer continues the turn. */
  modelTurns: number | null;
  /**
   * Whether the agent said anything at all in this turn.
   *
   * Not a count — it never leaves this class — and that is the point. It exists
   * only to tell a turn that happened from one that did not, a job the old
   * assistant-message count did as a side effect. `/clear` is the case it is
   * for: it opens a turn before it is recognised as a command, and filing that
   * would put a blank row in the permanent history for every clear anybody ever
   * typed.
   */
  spoke: boolean;
  tools: Map<string, number>;
  toolCalls: number;
  /** Summed from `msg_end` and `turn_end`. */
  additive: ChatUsage;
  /** The running total as it stood when this job opened, or null if none seen yet. */
  absoluteAtStart: ChatUsage | null;
  /** How many readings had arrived when this job opened. */
  readingsAtStart: number;
  outcome: UsageOutcome;
  /** Per-model spend as the runtime reported it at turn end. */
  models: TurnModelUsage[];
}

/** The token fields that sum. Context-window fields are deliberately absent. */
const COUNTED: Array<keyof ChatUsage> = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
];

export class UsageAccountant {
  private job: OpenJob | null = null;
  /**
   * The job just closed, kept only until the next one opens.
   *
   * A steer arrives immediately after the interrupt that closed the turn it is
   * steering, so this is what it reopens. One deep: any later message is a new
   * turn by definition, and holding more would be holding a history this class
   * has no business having.
   */
  private lastClosed: OpenJob | null = null;
  /** The latest running total from a standalone `usage` event. */
  private absolute: ChatUsage | null = null;
  /**
   * Where this process's running total starts counting from. Settled once, on
   * the first reading, and never revised — see the constructor.
   */
  private floor: ChatUsage | null = null;
  /**
   * How many running totals have arrived.
   *
   * A job that saw none of them reported nothing on that channel, which is not
   * the same as reporting zero — without this counter a quiet turn is filed as
   * a measured zero, and every consumer downstream would believe it.
   */
  private readings = 0;
  private nativeSessionId: string | null = null;
  private sessionModel: string | null = null;
  /** Tool blocks already counted, so a re-announced call is not counted twice. */
  private readonly seenTools = new Set<string>();

  /**
   * @param prior What this conversation has already been recorded as consuming,
   *   when this process resumed one. Omitted for a conversation starting fresh.
   *
   *   It settles where a running total starts counting from, and the two ways of
   *   getting that wrong are both expensive: treat a counter that carries
   *   history as if it started at zero and one job is billed the whole
   *   conversation; treat a counter that restarted as if it carried history and
   *   a job is billed nothing. Which of the two a runtime does is not something
   *   its documentation says, and codex and the ACP agents do not agree.
   *
   *   So it is decided from evidence rather than declared: if the first reading
   *   is at least what we have already recorded, the counter carried the history
   *   and the floor is that recorded figure; if it is less, the counter plainly
   *   restarted and the floor is zero. A fresh conversation has recorded nothing,
   *   which makes the same rule give zero without a special case.
   */
  constructor(
    private readonly onFinished: (job: FinishedJob) => void,
    private readonly prior?: ChatUsage,
  ) {}

  /**
   * Feed one event.
   *
   * Nothing here throws: accounting must never be able to take a conversation
   * down with it. Callers wrap this anyway, but the code is written as if they
   * did not.
   */
  observe(event: ChatEvent): void {
    switch (event.t) {
      case 'session':
        if (event.nativeSessionId) this.nativeSessionId = event.nativeSessionId;
        if (event.model) this.sessionModel = event.model;
        return;

      case 'msg_start':
        if (event.role === 'user') {
          // The user's own message is what opens a job — it is emitted with the
          // turn id the moment the turn is accepted, before the runtime has
          // said anything at all.
          this.openJob(event.turnId, event.ts, event.steer === true);
        } else {
          // The agent speaking with no job open is the agent picking its own
          // work back up: it ended the turn waiting on something — a build, a
          // check, a job running in the background — and carried on when that
          // finished. Nobody asked a second question, so this is the same turn,
          // and it is reopened rather than left to run untracked. It used to be
          // exactly that: **more than half of a long conversation's spend was
          // never filed at all**, because a job is opened by a user's message
          // and there was not one.
          if (!this.job) this.resume();
          if (this.job) this.job.spoke = true;
        }
        if (event.model) {
          this.sessionModel = event.model;
          if (this.job) this.job.model = event.model;
        }
        return;

      case 'msg_end': {
        if (!this.job) return;
        if (event.usage) this.job.additive = mergeUsage(this.job.additive, event.usage);
        return;
      }

      case 'block_start': {
        if (!this.job || event.block.kind !== 'tool') return;
        // Keyed on the tool id rather than counted blindly: a runtime that
        // re-announces a call it already opened (claude does, once its streamed
        // arguments parse) would otherwise inflate every tool count.
        if (this.seenTools.has(event.block.toolId)) return;
        this.seenTools.add(event.block.toolId);
        this.job.toolCalls += 1;
        const name = event.block.name || 'unnamed';
        this.job.tools.set(name, (this.job.tools.get(name) ?? 0) + 1);
        return;
      }

      case 'usage': {
        // Absolute: replaces, never sums. See the note at the top of the file.
        //
        // Field by field, and only where a figure was actually given: ACP sends
        // a context-size update with the cost key present but undefined
        // whenever the runtime omits a cost or quotes a currency that is not
        // USD, and spreading that over the stored total erased the watermark —
        // so the next reading was measured against zero and one job was billed
        // the entire conversation again.
        const first = this.absolute === null;
        const merged: ChatUsage = { ...(this.absolute ?? {}) };
        for (const [field, value] of Object.entries(event.usage)) {
          if (value !== undefined) (merged as Record<string, unknown>)[field] = value;
        }
        this.absolute = merged;
        this.readings += 1;
        if (first && this.floor === null) this.floor = floorFor(merged, this.prior);
        if (this.job && this.job.absoluteAtStart === null) {
          this.job.absoluteAtStart = this.floor ?? {};
          this.job.readingsAtStart = this.readings - 1;
        }
        return;
      }

      case 'error':
        if (this.job && event.fatal !== false) this.job.outcome = 'error';
        return;

      case 'turn_end':
        if (event.usage && this.job) this.job.additive = mergeUsage(this.job.additive, event.usage);
        if (event.stale) {
          // The runtime letting go of a half it was told to abandon. The job
          // stays open — the same turn is running again on the correction —
          // and what that half cost has already been taken above, because it
          // was spent on this turn like everything else in it.
          return;
        }
        if (this.job) {
          // Added rather than assigned: a steered turn ends twice, once at the
          // interrupt and once when the redirected work finishes, and the round
          // trips of both halves were spent on the one turn.
          const reported = reportedModelTurns(event.modelTurns, event.models);
          if (reported !== null) this.job.modelTurns = (this.job.modelTurns ?? 0) + reported;
        }
        if (event.models && this.job) {
          // Late by nature — a runtime only knows the split once the turn is
          // over — so this lands on the job that is closing, one line before
          // it closes. It also corrects the job's own model: a grok
          // conversation opens with none at all, and the name arrives here.
          this.job.models = event.models;
          if (event.models.length === 1) this.job.model = event.models[0].model;
          else if (!this.job.model) {
            // Several models and nothing said which answered. The busiest is
            // the closest thing to a main one that was actually measured;
            // the split beside it keeps the rest from being folded into it.
            this.job.model = [...event.models].sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0))[0].model;
          }
        }
        this.close(event.ts, event.durationMs ?? null, event.turnId);
        return;

      case 'state':
        // A runtime that died mid-turn still did work, and the record says so
        // rather than losing it. `idle` is not a close: turn_end already is one,
        // and the session sets idle straight after it.
        if (event.state === 'exited' || event.state === 'error') {
          if (this.job) this.job.outcome = 'interrupted';
          this.close(event.ts, null, null);
        }
        return;

      default:
        return;
    }
  }

  /** Close anything still open — the session is going away. */
  flush(at = Date.now()): void {
    if (this.job) this.job.outcome = 'interrupted';
    this.close(at, null, null);
  }

  /**
   * Pick the job that just closed back up, if there is one.
   *
   * Two things reach here, and they are the same thing seen twice: a steer,
   * which is more of the turn the interrupt cut short, and an agent resuming
   * work of its own accord after ending a turn. Neither is a new request, and
   * only a request is a new turn — so this is the same job, with its counters,
   * its start and its id, and when it closes again the filing replaces the
   * first rather than standing beside it. The outcome starts over because the
   * turn is running again: how it paused is not how it ended.
   */
  private resume(): void {
    const resumed = this.lastClosed;
    this.lastClosed = null;
    if (!resumed) return;
    this.job = { ...resumed, outcome: 'completed' };
    // `seenTools` is deliberately not cleared: a tool the runtime re-announces
    // across the pause is the same call, and the whole point of the set is that
    // it is only counted once.
  }

  private openJob(turnId: string, ts: number, steer: boolean): void {
    // The first user message of a prompt opens the job and every later one is
    // ignored, because more than one arrives. `deliver` emits ours with the
    // turn id it minted, and then codex and the ACP agents echo the prompt back
    // with a turn id of their own — which, when that echo was allowed to close
    // and reopen, filed a second empty job for every single prompt those agents
    // ever answered. Half their history was blank rows, and their turns- and
    // tool-calls-per-job averages came out at exactly half the truth, in the
    // one comparison those figures exist to support.
    if (this.job) return;

    // A steer is not a new turn, it is more of the one that was just cut short
    // (#86). The interrupt has already closed and filed that job, so this picks
    // it back up: same id, same start, its counters carried, and when it closes
    // again the filing replaces the first rather than standing beside it. The
    // outcome starts over because the turn is running again — being redirected
    // is not how it ended, and it has not ended yet.
    if (steer && this.lastClosed?.turnId === turnId) {
      this.resume();
      return;
    }
    this.lastClosed = null;

    this.job = {
      turnId,
      startedAt: ts,
      model: this.sessionModel,
      modelTurns: null,
      spoke: false,
      tools: new Map(),
      toolCalls: 0,
      additive: {},
      absoluteAtStart: this.absolute ? { ...this.absolute } : null,
      readingsAtStart: this.readings,
      outcome: 'completed',
      models: [],
    };
    this.seenTools.clear();
  }

  private close(ts: number, durationMs: number | null, turnId: string | null): void {
    const job = this.job;
    if (!job) return;
    this.job = null;
    // Before the empty check, not after: a turn interrupted before it said
    // anything is filed nowhere, but it is still the turn a steer arriving next
    // is continuing, and it still owns its id.
    this.lastClosed = job;

    // Only when a reading actually arrived while this job was open. A job that
    // saw none of them was told nothing on that channel, and subtracting an
    // unmoved counter from itself would file a row of measured zeros — the one
    // thing this whole record is built not to do. The spend those zeros stood
    // for is not lost: it is still inside the next reading, and lands on the
    // job that was open when it arrived. That is the most a cumulative counter
    // can honestly support.
    const sawReading = this.readings > job.readingsAtStart;
    const grown =
      sawReading && job.absoluteAtStart ? subtract(this.absolute ?? {}, job.absoluteAtStart) : {};
    const usage = mergeUsage(job.additive, grown);

    // Nothing was said, nothing was called, nothing was reported: there is no
    // work here to account for. `/clear` produces one of these — it opens a
    // turn before it is recognised as a command — and filing it would put a
    // blank row in the permanent history and count it against every "N of M
    // jobs reported" figure on the dashboard.
    const empty =
      !job.spoke && job.toolCalls === 0 && !COUNTED.some((f) => usage[f] !== undefined);
    if (empty) return;

    this.onFinished({
      // Always the id this app minted when it accepted the prompt, never the
      // one the runtime put on `turn_end`. grok and pi number their turns from
      // a counter that restarts with every process — so after a restart or a
      // `/clear` their second conversation reuses `t1`, `t2`, and since a
      // record is keyed on session and turn, the new jobs overwrote the old
      // ones. Half a conversation's history disappeared, and the spend with it.
      turnId: job.turnId,
      nativeSessionId: this.nativeSessionId,
      model: job.model,
      startedAt: job.startedAt,
      endedAt: ts,
      durationMs: durationMs ?? (ts > job.startedAt ? ts - job.startedAt : null),
      outcome: job.outcome,
      modelTurns: job.modelTurns,
      toolCalls: job.toolCalls,
      usage,
      tools: [...job.tools].map(([tool, calls]) => ({ tool, calls })),
      // Only a real split is worth carrying: one model that ran is already
      // said by `model` above, and a one-row breakdown beside it would be the
      // same fact stored twice, free to drift.
      models: job.models.length > 1 ? job.models : [],
    });
  }
}

/**
 * A turn's round-trip count, strictly as the runtime gave it.
 *
 * Two runtimes report one, in two shapes: Claude puts `num_turns` on the line
 * that ends the turn, and a per-model breakdown carries a `calls` for each model
 * that ran. The breakdown is only usable when *every* entry has a figure —
 * adding up the ones that answered and ignoring the ones that did not would
 * produce a confident number that undercounts, which is the exact failure this
 * whole change is about.
 *
 * Null means nobody said, and null is carried all the way to the screen.
 */
function reportedModelTurns(
  modelTurns: number | undefined,
  models: TurnModelUsage[] | undefined,
): number | null {
  if (typeof modelTurns === 'number' && Number.isFinite(modelTurns) && modelTurns >= 0) {
    return modelTurns;
  }
  if (!models || models.length === 0) return null;
  let sum = 0;
  for (const model of models) {
    if (typeof model.calls !== 'number' || !Number.isFinite(model.calls)) return null;
    sum += model.calls;
  }
  return sum;
}

/**
 * Where a running total starts counting from, decided from the first reading.
 *
 * See the constructor. A reading at or above what this conversation has already
 * been recorded as using means the counter carried its history across the
 * resume, so the floor is that recorded figure; a reading below it means the
 * counter restarted and the floor is zero. Per field, because a runtime is free
 * to reset some of them and not others.
 */
function floorFor(first: ChatUsage, prior: ChatUsage | undefined): ChatUsage {
  if (!prior) return {};
  const out: ChatUsage = {};
  for (const field of COUNTED) {
    const already = prior[field];
    const reading = first[field];
    if (typeof already !== 'number' || already <= 0) continue;
    if (typeof reading === 'number' && reading >= already) {
      (out as Record<string, number>)[field] = already;
    }
  }
  return out;
}

/**
 * `a - b`, over the fields that count.
 *
 * Clamped at zero: a runtime that resets its own counter — a fresh process on a
 * conversation it is resuming, most obviously — would otherwise hand back a
 * negative figure, and a negative token count is not a measurement, it is a
 * missing baseline. Fields absent from `a` stay absent, so "never reported"
 * survives the subtraction as a null rather than becoming a zero.
 */
function subtract(a: ChatUsage, b: ChatUsage): ChatUsage {
  const out: ChatUsage = {};
  for (const field of COUNTED) {
    const left = a[field];
    if (typeof left !== 'number') continue;
    const right = b[field];
    const value = left - (typeof right === 'number' ? right : 0);
    (out as Record<string, number>)[field] = value > 0 ? value : 0;
  }
  return out;
}
