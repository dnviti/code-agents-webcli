/*
 * ChatSessionPlans: plan document and model/effort controls: submit/accept/reject plan, set model, effort, snapshot.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionAsk } from './session-ask.js';
import * as crypto from 'crypto';
import { PlanDocument, MAX_PLAN_TEXT, acceptedPlanDirective, ChatSnapshot } from '../../shared/chat-events.js';
import { PlanSubmissionResult, PlanModeResult, PlanActionResult } from './session-types.js';
import { QUEUE_READY_TIMEOUT_MS, QUEUE_READY_POLL_MS } from './session-constants.js';
import { questionToolDirective, questionFallbackDirective } from './session-question-helpers.js';
export abstract class ChatSessionPlans extends ChatSessionAsk {
  async setModel(model: string): Promise<boolean> {
    if (!this.adapter?.alive || !this.adapter.setModel) return false;
    await this.adapter.setModel(model);
    return true;
  }

  /** Read the latest submitted plan once per process, then keep the cache current. */

  async planDocument(): Promise<PlanDocument | null> {
    if (this.planDocumentCache !== undefined) return this.planDocumentCache;
    this.planDocumentCache = (await this.deps.store.planDocument?.(this.ref)) ?? null;
    return this.planDocumentCache;
  }

  /** Put every Plan read/change decision behind one per-session boundary. */

  protected mutatePlan<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.planMutation.catch(() => undefined).then(operation);
    this.planMutation = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Persist one complete numbered revision from the MCP tool or response fallback. */

  async submitPlan(input: { markdown?: unknown; source?: 'tool' | 'response' }): Promise<PlanSubmissionResult> {
    const markdown = typeof input.markdown === 'string' ? input.markdown.trim() : '';
    if (!this.planMode) {
      return { accepted: false, detail: 'Plan mode is not active for this conversation.' };
    }
    if (!markdown) {
      return { accepted: false, detail: 'A submitted plan cannot be empty.' };
    }
    if (markdown.length > MAX_PLAN_TEXT) {
      return {
        accepted: false,
        detail: `The plan is too large; the limit is ${MAX_PLAN_TEXT} characters.`,
      };
    }
    if (!this.deps.store.setPlanDocument) {
      return { accepted: false, detail: 'This server cannot persist Plan documents.' };
    }
    const generation = this.planGeneration;
    return this.mutatePlan(async () => {
      // The mode and generation are checked again after waiting for earlier
      // Plan actions. Otherwise a submission already in line could write after
      // Accept or /clear had ended the planning conversation.
      if (!this.planMode || generation !== this.planGeneration) {
        return { accepted: false, detail: 'Plan mode is no longer active for this conversation.' };
      }
      try {
        const previous = await this.planDocument();
        if (!this.planMode || generation !== this.planGeneration) {
          return { accepted: false, detail: 'The planning conversation ended before this plan could be stored.' };
        }
        const plan: PlanDocument = {
          markdown,
          revision: (previous?.revision ?? 0) + 1,
          ts: Date.now(),
        };
        await this.deps.store.setPlanDocument!(this.ref, plan);
        if (generation !== this.planGeneration) {
          // A clear waited for this operation and removes the sidecar next; do
          // not republish it into the new conversation while that happens.
          return { accepted: false, detail: 'The planning conversation ended before this plan could be published.' };
        }
        this.planDocumentCache = plan;
        this.planSubmittedThisTurn = true;
        this.deps.broadcast(this.ref.id, {
          type: 'chat_plan_document',
          sessionId: this.ref.id,
          plan,
        });
        return {
          accepted: true,
          revision: plan.revision,
          detail: `Plan saved as revision ${plan.revision}.`,
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { accepted: false, detail: `The plan could not be stored: ${detail}` };
      }
    });
  }

  /** Turn the conversation-level mode on or off while no turn is active. */

  async setPlanMode(on: boolean): Promise<PlanModeResult> {
    return this.mutatePlan(async () => {
      if (this.live && (this.state !== 'idle' || this.draining || this.queue.length > 0)) {
        return {
          planMode: this.planMode,
          changed: false,
          detail: 'Wait for the active turn and queued messages to finish before changing Plan mode.',
        };
      }
      if (this.planMode === on) {
        return {
          planMode: this.planMode,
          changed: false,
          detail: on ? 'Plan mode is already on.' : 'Plan mode is already off.',
        };
      }
      this.planMode = on;
      this.rememberPlanMode(on);
      if (!on) {
        this.planResponseBlocks.clear();
        this.planResponseCandidate = '';
      }
      return {
        planMode: on,
        changed: true,
        detail: on ? 'Plan mode is on.' : 'Plan mode is off. The latest plan was kept.',
      };
    });
  }

  /** Carry Plan mode through an in-place process restart. */

  rememberPlanMode(on: boolean): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, planMode: on };
  }

  /**
   * Accept only the latest revision, then immediately start its implementation.
   * The prompt is internal runtime context: no user-authored transcript bubble
   * is manufactured for an action the user took through the Plan control.
   */

  async acceptPlan(revision: number): Promise<PlanActionResult> {
    return this.mutatePlan(async () => {
      const plan = await this.planDocument();
      if (!this.planMode) {
        return { accepted: false, action: 'accept', planMode: false, detail: 'Plan mode is not active.' };
      }
      if (!plan) {
        return { accepted: false, action: 'accept', planMode: true, detail: 'There is no plan to accept.' };
      }
      if (revision !== plan.revision) {
        return {
          accepted: false,
          action: 'accept',
          planMode: true,
          revision: plan.revision,
          detail: `Revision ${revision} is stale. Review revision ${plan.revision} before accepting.`,
        };
      }
      if (!this.adapter?.alive || this.state !== 'idle' || this.draining || this.queue.length > 0) {
        return {
          accepted: false,
          action: 'accept',
          planMode: true,
          revision: plan.revision,
          detail: 'The conversation must be live and idle before the plan can be accepted.',
        };
      }

      const generation = this.planGeneration;
      this.planMode = false;
      this.rememberPlanMode(false);
      this.turnInFlightId = `turn-${crypto.randomUUID()}`;
      // A few runtimes echo their prompt. This sentinel makes that internal copy
      // pass through the same duplicate-user-message filter as ordinary turns.
      this.ownUserMessageId = `internal-${crypto.randomUUID()}`;
      this.droppedUserEchoes.clear();
      // Accept is an internal new turn. End resume replay before any event from
      // its implementation can pass through the replayable-event gate.
      this.replaying = false;
      this.setState('thinking');
      try {
        const deadline = Date.now() + QUEUE_READY_TIMEOUT_MS;
        while (!this.adapterReady && this.adapter?.alive && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, QUEUE_READY_POLL_MS));
        }
        if (!this.adapter?.alive || !this.adapterReady) {
          throw new Error(`the ${this.runtime || 'agent'} process was not ready for another turn`);
        }
        const questionInstruction = this.questionToolEnabled
          ? questionToolDirective()
          : this.questionFallbackEnabled
            ? questionFallbackDirective()
            : null;
        await this.adapter.send({
          text: [questionInstruction, acceptedPlanDirective(plan)].filter(Boolean).join('\n\n'),
        });
      } catch (error: unknown) {
        const sameConversation = generation === this.planGeneration;
        if (sameConversation) {
          this.planMode = true;
          this.rememberPlanMode(true);
          this.turnInFlightId = null;
          this.ownUserMessageId = null;
          this.setState('idle');
        }
        const detail = error instanceof Error ? error.message : String(error);
        return {
          accepted: false,
          action: 'accept',
          planMode: this.planMode,
          revision: plan.revision,
          detail: sameConversation
            ? `The plan was not accepted because implementation could not start: ${detail}`
            : 'The plan was not accepted because a new conversation started first.',
        };
      }
      return {
        accepted: true,
        action: 'accept',
        planMode: false,
        revision: plan.revision,
        detail: `Plan revision ${plan.revision} accepted. Implementation started.`,
      };
    });
  }

  /** Reject the latest revision without leaving Plan mode or deleting it. */

  async rejectPlan(revision: number): Promise<PlanActionResult> {
    return this.mutatePlan(async () => {
      const plan = await this.planDocument();
      if (!this.planMode) {
        return { accepted: false, action: 'reject', planMode: false, detail: 'Plan mode is not active.' };
      }
      if (!plan) {
        return { accepted: false, action: 'reject', planMode: true, detail: 'There is no plan to reject.' };
      }
      if (revision !== plan.revision) {
        return {
          accepted: false,
          action: 'reject',
          planMode: true,
          revision: plan.revision,
          detail: `Revision ${revision} is stale. Review revision ${plan.revision} instead.`,
        };
      }
      if (this.live && this.state !== 'idle') {
        return {
          accepted: false,
          action: 'reject',
          planMode: true,
          revision: plan.revision,
          detail: 'Wait for the active planning turn to finish before rejecting its plan.',
        };
      }
      return {
        accepted: true,
        action: 'reject',
        planMode: true,
        revision: plan.revision,
        detail: `Plan revision ${plan.revision} rejected. Add feedback in the composer to request a revision.`,
      };
    });
  }

  /**
   * Record the model an in-place restart must launch with.
   *
   * `restart()` replays the options this session was last started with, and
   * those were resolved once, at launch. Everything in them is fixed for the
   * life of the conversation except the model, which `chat_set_model` can
   * change underneath them — so without this a `/clear` would quietly
   * reinstate the model the conversation happened to open with, discarding a
   * choice the browser has already been told was applied.
   *
   * Takes the effective model rather than the override, so clearing an
   * override lands on the profile default here exactly as it would on a fresh
   * launch.
   */

  rememberModel(model: string | undefined): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, model };
  }

  /**
   * Switch the live process to a different reasoning-effort level.
   *
   * Unlike the model, most runtimes can do this: claude answers its own
   * `/effort` command for free, kimi and omp expose it as an ACP config option,
   * grok carries it on a model change, and codex and pi apply it to the next
   * turn they start. What they have in common is that the adapter only resolves
   * once its runtime has taken the level — so `true` here means the session is
   * genuinely running at it, and anything else falls through to the caller's
   * saved-for-next-launch answer rather than claiming a change nobody made.
   */

  async setEffort(effort: string): Promise<boolean> {
    if (!this.adapter?.alive || !this.adapter.setEffort) return false;
    await this.adapter.setEffort(effort);
    return true;
  }

  /**
   * Record the effort level an in-place restart must launch with.
   *
   * The same trap `rememberModel` exists for, and a worse one here: an effort
   * change is confirmed by the runtime and shown as live, so a `/clear` that
   * replayed the launch options verbatim would put the conversation back on the
   * level it opened with while the control went on reporting the level the user
   * chose — a disagreement nothing on screen would explain.
   */

  rememberEffort(effort: string | undefined): void {
    if (!this.lastStartOptions) return;
    this.lastStartOptions = { ...this.lastStartOptions, effort };
  }


  snapshot(): Promise<ChatSnapshot> {
    return Promise.all([this.deps.store.snapshot(this.ref), this.planDocument()]).then(([snapshot, planDocument]) => ({
      ...snapshot,
      runtime: this.runtime || snapshot.runtime,
      // The replayed state is computed by the same reducer the browser runs,
      // so it is the authority on what has happened in the conversation. This
      // object only knows better about the process: whether it is still alive.
      //
      // It used to override with `this.state`, which is only moved by an
      // explicit `state` event — and Claude ends a turn with `turn_end`, not
      // with `state: idle`. So every rejoin of a finished turn came back
      // saying "Thinking", with a composer that looked stuck.
      state: this.live ? snapshot.state : 'exited',
      capabilities: this.capabilities || snapshot.capabilities,
      pendingPermissions: Array.from(this.pending.values()).map((entry) => entry.request),
      pendingQuestions: [
        ...(snapshot.pendingQuestions || []),
        ...Array.from(this.questions.values()).map((entry) => entry.request),
      ].filter((request, index, all) => (
        all.findIndex((candidate) => candidate.requestId === request.requestId) === index
      )),
      pendingQuestionContinuations: [
        ...(snapshot.pendingQuestionContinuations || []),
        ...Array.from(this.questionContinuations.values()),
      ].filter((continuation, index, all) => (
        all.findIndex((candidate) => (
          candidate.continuationId === continuation.continuationId
        )) === index
      )),
      questionHistory: [
        ...(snapshot.questionHistory || []),
        ...Array.from(this.questions.values())
          .map((entry) => entry.request)
          .filter((request) => !(snapshot.questionHistory || [])
            .some((recorded) => recorded.requestId === request.requestId)),
      ],
      // `answeredQuestions` is deliberately NOT overridden here. This map holds
      // only the questions still waiting; what was picked for the ones already
      // answered is in the log, and the store's replay of it is the authority
      // (#113). Overlaying anything from here would narrow it to this process's
      // lifetime, which is exactly the conversation this has to survive.
      queued: this.queuedTurns,
      live: this.live,
      nativeSessionId: this.nativeSessionId || undefined,
      bypassPermissions: this.bypass,
      limits: this.limits || snapshot.limits,
      planMode: this.planMode,
      planDocument,
    }));
  }

}
