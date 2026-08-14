import { randomUUID } from 'node:crypto';
import type { ChatUsage } from '../../../../shared/chat-events.js';
import { mapModelUsage } from '../model-usage.js';
import { ClaudeChatAdapterEffort } from './adapter-effort.js';
import { TOKEN_FIELDS } from './constants.js';
import { mapUsage, contextReading } from './usage.js';
import { num, record, str } from './util.js';

/**
 * The cost-and-usage half of the Claude adapter chain: turning the `result`
 * line's cumulative figures into per-turn readings, and closing the turn.
 * Every number here is cumulative or per-turn in ways the runtime does not
 * label, which is why the translation lives together in one place.
 */
export abstract class ClaudeChatAdapterAccounting extends ClaudeChatAdapterEffort {
  /**
   * This turn's own cost, from the running total the CLI reports.
   *
   * `total_cost_usd` on a `result` message is cumulative for the conversation,
   * not for the turn — probed against 2.1.220 by running two prompts through
   * one process (0.1286 then 0.1790, while the token counts stayed at 2 in / 6
   * out both times) and then a third through a `--resume` in a *new* process,
   * which continued from 0.1790 rather than restarting. Its sibling `usage`
   * object is per-turn; only the money is cumulative.
   *
   * Everything downstream sums what a turn reports, so left alone this charged
   * every conversation its own history again on every turn — the second turn of
   * a chat showed roughly triple its real cost, the tenth far worse. The
   * subtraction lives here because this is the one place that knows the
   * convention; `costBaselineUsd` carries the watermark across a restart, since
   * the CLI's counter survives one and an in-process variable does not.
   */
  protected turnCost(reported: number | undefined): number | undefined {
    if (reported === undefined) return undefined;
    if (this.costBaselineUnknown) {
      this.costBaselineUnknown = false;
      this.costWatermark = reported;
      return undefined;
    }
    const spent = reported - this.costWatermark;
    this.costWatermark = Math.max(this.costWatermark, reported);
    // Clamped: a counter that went backwards means the baseline was wrong, and
    // a negative cost is not a measurement anyone can use.
    return spent > 0 ? spent : 0;
  }

  /**
   * The part of the `result` usage this turn has not already reported.
   *
   * Its sibling `total_cost_usd` is cumulative for the conversation and is
   * corrected in `turnCost`; the `usage` object beside it is per-turn, and
   * therefore repeats — field for field — what the turn's own messages already
   * reported on their `message_delta`. Everything downstream sums what a turn
   * reports, so passing it through unchanged counted every Claude token twice:
   * the live session readout, the meter and the recorded history all showed
   * double, consistently enough that nothing looked broken. Measured on the
   * `claude-oneshot` capture, where the two messages report 4 / 97 / 16402 /
   * 47287 between them and the result reports exactly 4 / 97 / 16402 / 47287.
   *
   * The remainder rather than nothing at all, because a turn whose messages
   * reported no usage — an error before the first `message_delta`, a shape a
   * future CLI invents — has nothing to have counted twice, and dropping the
   * result's figures there would lose the turn's only reading of itself.
   */
  protected turnTokensLeft(reported: ChatUsage): ChatUsage | undefined {
    const left: ChatUsage = {};
    let any = false;
    for (const field of TOKEN_FIELDS) {
      const value = reported[field];
      if (typeof value !== 'number') continue;
      const already = this.turnTokensEmitted[field] ?? 0;
      // Clamped: a result that reports less than its own messages did means the
      // two are counting different things, and a negative token count is not a
      // measurement. Zero is, and it is the honest one — the tokens are already
      // on the messages.
      const remainder = value - already;
      left[field] = remainder > 0 ? remainder : 0;
      any = true;
    }
    this.turnTokensEmitted = {};
    return any ? left : undefined;
  }

  /**
   * The per-model breakdown, with its money put on the same footing as the turn.
   *
   * `modelUsage.*.costUSD` is a slice of `total_cost_usd`, and that counter is
   * cumulative over the conversation (see `turnCost` above — the reason this
   * adapter exists in the shape it does). Passing those figures straight
   * through would put a per-turn cost on the job and a whole-conversation cost
   * on the models inside it, and the by-model view would climb past the total
   * it is a breakdown of, turn after turn.
   *
   * So the *shares* are taken from the report and the turn's own cost is what
   * is divided by them. That is the one thing that stays true whichever way the
   * counter behaves: a runtime reporting per-turn figures gives shares of a
   * total equal to the turn's cost, which divides back to exactly what it
   * reported. Nothing is scaled up — the sum is the turn's own measured cost,
   * always.
   *
   * Tokens are left alone. Claude's `usage` is per-turn, not cumulative, and
   * the per-model token fields track it.
   */
  protected modelBreakdown(raw: Record<string, unknown>, turnCostUsd: number | undefined) {
    const models = mapModelUsage(raw);
    if (!models) return undefined;

    const reported = models.reduce((total, entry) => total + (entry.usage?.costUsd ?? 0), 0);
    if (turnCostUsd === undefined || reported <= 0) {
      // No cost to divide, or nothing to divide it by. The models are still
      // named — which is the fact this exists for — and carry no money rather
      // than a made-up share of one.
      return models.map((entry) => {
        if (entry.usage?.costUsd === undefined) return entry;
        const { costUsd, ...rest } = entry.usage;
        return Object.keys(rest).length > 0 ? { ...entry, usage: rest } : { model: entry.model, calls: entry.calls };
      });
    }

    return models.map((entry) => {
      const share = entry.usage?.costUsd;
      if (share === undefined) return entry;
      return { ...entry, usage: { ...entry.usage, costUsd: (share / reported) * turnCostUsd } };
    });
  }

  protected handleResult(raw: Record<string, unknown>): void {
    if (this.pendingEffort) {
      this.consumeEffortResult(raw);
      return;
    }

    // The answer to a switch that was given up on. Dropped rather than reported:
    // nobody is waiting for it, the level it names may or may not have taken,
    // and letting it through here would close whatever turn is running now. See
    // `staleEffortResults`; `num_turns: 0` is Claude's own mark of a command it
    // answered without going near the model, which is what makes this safe to
    // key on rather than a guess at which result belongs to what.
    if (this.staleEffortResults > 0 && num(raw.num_turns) === 0) {
      this.staleEffortResults -= 1;
      return;
    }

    const subtype = str(raw.subtype);
    const isError = raw.is_error === true;

    const usageRaw = record(raw.usage);
    const costUsd = this.turnCost(num(raw.total_cost_usd));
    // The tokens this turn has not already reported (see `turnTokensLeft`),
    // the turn's own share of the cumulative cost, and the reading of how full
    // the window is — which is the last request's own figures, not the turn's
    // totals, so it is taken from `raw` rather than from what is emitted here.
    const tokens = usageRaw ? this.turnTokensLeft(mapUsage(usageRaw)) : undefined;
    const context = contextReading(raw);
    const usage: ChatUsage | undefined =
      tokens || costUsd !== undefined || Object.keys(context).length > 0
        ? {
            ...(tokens ?? {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...context,
          }
        : undefined;

    const sessionId = str(raw.session_id);
    if (sessionId) this.nativeSessionId = sessionId;

    if (isError) {
      // turn_end has no field for "why" -- surface the failure as its own
      // event so it actually lands in the transcript, the same path a
      // mid-stream error already takes.
      this.emit({
        t: 'error',
        message: str(raw.result) || `claude ended the turn as ${subtype ?? 'an error'}`,
      });
    }

    // `num_turns` is Claude's own count of the round trips this turn took, and
    // it now has somewhere to go (#86). It is not the turn count — the turn is
    // the whole of what this event ends — which is why it travels under its own
    // name, as the one figure here nobody had to infer.
    this.emit({
      t: 'turn_end',
      turnId: this.activeTurnId ?? randomUUID(),
      stopReason: str(raw.stop_reason) ?? subtype,
      usage,
      durationMs: num(raw.duration_ms),
      ...(() => {
        const modelTurns = num(raw.num_turns);
        return modelTurns === undefined ? {} : { modelTurns };
      })(),
      ...(() => {
        const models = this.modelBreakdown(raw, costUsd);
        return models ? { models } : {};
      })(),
      // `modelUsage` is where a Task subagent's spend surfaces: it runs on
      // whatever model it was launched with and appears here as a second key,
      // while the assistant messages in the transcript only ever carry the
      // main agent's. Without this a turn that delegated is filed entirely
      // against the model that did the delegating. Spread above rather than
      // assigned here, so a turn that reported none carries no key at all.
    });
    this.activeTurnId = null;
    this.currentMsgId = null;
  }
}
