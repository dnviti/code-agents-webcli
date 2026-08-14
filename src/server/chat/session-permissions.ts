/*
 * ChatSessionPermissions: approvals and capability escalation: permission answers, tier requests, ladder reapplies.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionQueue } from './session-queue.js';
import * as crypto from 'crypto';
import { isAllowOption, isAskQuestionTool, PermissionOption, defaultPermissionOptions, PermissionRequest, classifyTool } from '../../shared/chat-events.js';
import { nextRungUp, ModelTier } from '../../shared/runtime-profiles.js';
import { PermissionAsk, PermissionAnswer, TierAsk, TierReply } from './permission-broker.js';
import { describeAsk } from './session-quote.js';
export abstract class ChatSessionPermissions extends ChatSessionQueue {
  respondPermission(requestId: string, optionId: string): boolean {
    const approval = this.pending.get(requestId);
    if (!approval) return false;

    const option = approval.request.options.find((candidate) => candidate.optionId === optionId);
    const allowed = isAllowOption(option);

    if (approval.resolve) {
      approval.resolve({
        allow: allowed,
        reason: allowed ? 'approved in the browser' : 'denied in the browser',
      });
    } else {
      this.adapter?.respondPermission(requestId, optionId);
    }

    this.pending.delete(requestId);
    this.ingest({ t: 'permission_resolved', requestId, optionId, allowed });
    return true;
  }

  /**
   * A tool call arriving over the hook broker, on its way to a person.
   *
   * Resolves only when someone answers, which is the point: the hook is a
   * blocking call in the agent's own process, so the agent genuinely waits
   * rather than running the tool and apologising afterwards.
   */

  protected askUser(ask: PermissionAsk): Promise<PermissionAnswer> {
    // The one tool that must never be gated. Asking someone to approve being
    // asked a question is two prompts for one decision, and the second of them
    // is unanswerable in any useful sense — refusing it just blocks the model
    // from talking to the person sitting in front of it.
    if (isAskQuestionTool(ask.toolName)) {
      return Promise.resolve({ allow: true, reason: 'the user is being asked directly' });
    }
    if (this.bypass) {
      return Promise.resolve({ allow: true, reason: 'permissions are bypassed for this session' });
    }

    return new Promise<PermissionAnswer>((resolve) => {
      const requestId = `perm-${crypto.randomUUID()}`;
      const options: PermissionOption[] = defaultPermissionOptions();
      const request: PermissionRequest = {
        requestId,
        toolId: ask.toolUseId,
        title: describeAsk(ask),
        toolKind: classifyTool(ask.toolName),
        input: ask.toolInput,
        options,
        ts: Date.now(),
      };

      this.pending.set(requestId, { request, resolve });
      this.ingest({ t: 'permission', request });
      this.setState('awaiting_permission');
    });
  }

  /**
   * The agent asking to answer this task from the next model up its ladder.
   *
   * Put to the user as an ordinary approval, because that is exactly what it
   * is: the app gating the agent, with allow and deny the only two meanings an
   * answer can have. It draws the card the browser already has, travels the
   * message the browser already handles, and is recorded in the transcript with
   * every other decision the conversation made — none of which a bespoke
   * request type would have got for free.
   *
   * The grant lasts until the turn ends. See `escalation`.
   */

  protected async requestTier(ask: TierAsk): Promise<TierReply> {
    const ladder = this.ladder;
    if (!ladder) {
      return { granted: false, detail: 'this conversation is not running on a capability ladder.' };
    }
    // From the rung in force, not the rung it started on: two grants in one turn
    // would otherwise both offer the same step up, and the second would look to
    // the user like a request that had already been approved.
    const from = this.escalation?.to ?? ladder.tier;
    const next = nextRungUp({ tiers: ladder.tiers }, from);
    if (!next) {
      return {
        granted: false,
        detail:
          `You are already on the ${from} rung, which is the highest one this profile fills in. `
          + 'Carry on with the model you have.',
      };
    }

    const reason = typeof ask.reason === 'string' ? ask.reason.trim() : '';
    const granted = this.bypass
      ? true
      : await this.askEscalation(from, next.tier, next.model, reason);

    if (!granted) {
      return {
        granted: false,
        detail:
          `The user did not approve moving up to the ${next.tier} rung. `
          + 'Carry on with the model you have, and do not ask again this turn.',
      };
    }

    const applied = await this.applyModel(next.model);
    if (applied === 'no') {
      // Nothing was changed, so nothing is claimed. A model told it moved up
      // when it did not will attempt work it cannot do, and the user will be
      // shown a rung the process was never on.
      return {
        granted: false,
        detail:
          `The user approved moving up to the ${next.tier} rung, but this runtime cannot change `
          + 'its model without being restarted, so nothing moved. Carry on with the model you '
          + 'have and say that the stronger one could not be reached.',
      };
    }

    // A grant made while nothing is running belongs to the turn that has not
    // started yet — the same case as a runtime that can only switch between
    // turns, and it arises whenever a blocked tool call is abandoned while the
    // card is still up.
    const startsNextTurn = applied === 'next-turn' || this.state === 'idle';
    this.escalation = { from, to: next.tier, model: next.model, startsNextTurn };
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: startsNextTurn
        ? `moving up to the ${next.tier} rung for the next turn — ${next.model}`
        : `moved up to the ${next.tier} rung — ${next.model}`,
    });

    return {
      granted: true,
      tier: next.tier,
      model: next.model,
      detail: startsNextTurn
        ? `Approved. The ${next.tier} rung (${next.model}) takes effect on your next turn — the `
          + 'model answering right now cannot be changed mid-turn. Finish or stop here, and the '
          + `stronger model picks it up. The conversation returns to ${from} after that turn.`
        : `Approved. You are now answering from the ${next.tier} rung (${next.model}). `
          + `The conversation returns to ${from} when this turn ends.`,
    };
  }

  /**
   * Put a model in front of the agent, by whichever route its runtime has.
   *
   * Three answers, because there are three outcomes and collapsing them to a
   * boolean is how the escalation came to promise a rung it never reached:
   * `live` (the running process took it), `next-turn` (the runtime spawns per
   * turn, so the next one will), and `no` (nothing changed).
   */

  protected async applyModel(model: string): Promise<'live' | 'next-turn' | 'no'> {
    const adapter = this.adapter;
    if (!adapter?.alive) return 'no';
    if (adapter.setModel) {
      await adapter.setModel(model);
      return 'live';
    }
    if (adapter.setModelNextTurn) {
      adapter.setModelNextTurn(model);
      return 'next-turn';
    }
    return 'no';
  }

  /**
   * Put an escalation to the user and wait.
   *
   * Deliberately not routed through `askUser`: that one has a bypass short
   * circuit and a tool-name exemption, neither of which means anything here, and
   * the request has no tool call behind it to gate.
   */

  protected askEscalation(
    from: ModelTier,
    to: ModelTier,
    model: string,
    reason: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = `tier-${crypto.randomUUID()}`;
      const request: PermissionRequest = {
        requestId,
        title: `Answer from the ${to} rung instead of ${from}?`,
        toolKind: 'other',
        input: { rung: to, model },
        reason: reason || 'The agent gave no reason.',
        // Two options, not the usual three. The standing "Allow for this
        // session" would be a lie on the one control in the app that governs
        // spending: a grant lasts one turn by design, so a user who clicked it
        // believing the expensive model was authorised session-wide would have
        // been told the opposite of the truth.
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow, for this turn' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Stay on this rung' },
        ],
        ts: Date.now(),
      };
      this.pending.set(requestId, {
        request,
        resolve: (answer) => resolve(answer.allow),
      });
      this.ingest({ t: 'permission', request });
      this.setState('awaiting_permission');
    });
  }

  /**
   * The rung this conversation is actually on, or null when it is not on one.
   *
   * The escalated rung while an escalation is in force: what a browser joining
   * mid-turn has to be told is what the process is answering from, not what it
   * will go back to.
   */

  async reapplyLadder(
    ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null,
  ): Promise<boolean> {
    if (!this.ladder) return false;

    if (!ladder) {
      // The ladder is gone — the profile was deleted, deactivated, or had its
      // rungs cleared. Nothing to switch *to*: this conversation keeps the model
      // it is on until it is relaunched, which is when the runtime's own default
      // takes over. Said out loud rather than left to be discovered.
      this.ladder = null;
      this.escalation = null;
      this.ingest({
        t: 'marker',
        kind: 'model',
        detail: 'the ladder this conversation was on is gone; it keeps this model until relaunched',
      });
      return true;
    }

    const model = ladder.tiers[ladder.tier];
    const unchanged = model
      && !this.escalation
      && this.ladder.tier === ladder.tier
      && this.ladder.tiers[this.ladder.tier] === model;
    this.ladder = ladder;
    // Nothing the user would see. Interrupting a turn to change nothing is the
    // worst possible reading of "takes effect immediately".
    if (unchanged) return false;
    if (!model) return false;

    if (this.state !== 'idle') await this.interrupt().catch(() => undefined);
    // Any escalation belonged to the ladder that has just been replaced.
    this.escalation = null;
    const applied = await this.applyModel(model).catch(() => 'no' as const);
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: applied === 'no'
        // Said, not swallowed. The turn was cut short and the model did not
        // change, which is the worst of both and the user is owed the reason.
        ? `the profile changed to the ${ladder.tier} rung, ${model} — this runtime cannot take it `
          + 'without a restart, so this conversation stays on its model until then'
        : applied === 'next-turn'
          ? `the profile changed — the next turn runs on the ${ladder.tier} rung, ${model}`
          : `the profile changed — now on the ${ladder.tier} rung, ${model}`,
    });
    return applied !== 'no';
  }

  /**
   * Put the conversation back on the rung it belongs to.
   *
   * Called when a turn ends, which is the whole lifetime of a grant. Failing to
   * switch back is not treated as an error: the next turn's launch resolves the
   * model again from the ladder, so the worst case is one extra turn at the
   * higher rung rather than a conversation stranded there.
   */

  protected async endEscalation(): Promise<void> {
    const escalation = this.escalation;
    const ladder = this.ladder;
    if (!escalation || !ladder) return;
    this.escalation = null;

    const back = ladder.tiers[escalation.from];
    const applied = back ? await this.applyModel(back).catch(() => 'no' as const) : 'no';
    this.ingest({
      t: 'marker',
      kind: 'model',
      detail: applied === 'no'
        ? `the ${escalation.to} rung ends here; the next launch resolves the ladder again`
        : `back on the ${escalation.from} rung — ${back}`,
    });
  }

  /**
   * Remember a tool call that might be a question, or fill in what it asks.
   *
   * Called for every tool block, so the cheap name check comes first. A call
   * already known is updated rather than duplicated: the same id is reported
   * twice — once on announcement and again when its arguments finish arriving.
   */
}
