import path from 'node:path';
import { WebSocketInfo } from '../types.js';
import { broadcastChat, sendToWebSocket } from './handler.js';
import { MAX_QUESTION_ANSWER_TEXT } from '../../shared/chat-events.js';
import { MAX_QUESTION_ANSWER_SUBMISSION_ID, IncomingMessage, normaliseEffortLevel } from './messages-shared.js';
import { MessageProcessorChatMutationBase } from './messages-chat-mutation.js';
export abstract class MessageProcessorChatControlBase extends MessageProcessorChatMutationBase {


  /**
   * Change how hard the agent thinks, for one conversation.
   *
   * Shaped like the model handler and different from it in one deciding way:
   * this level *is* pre-validated. The control only ever offers what the running
   * runtime published, so a level that is not on that list did not come from the
   * control, and sending it on would be one of two bad outcomes — a runtime that
   * refuses it mid-turn, or pi, which prints a warning nobody sees and then
   * quietly runs at its default. Neither is a thing to find out about later.
   *
   * The ladder is only consulted when the session has actually published one.
   * Choosing a level before anything has launched is legitimate and lands in the
   * same saved-for-next-launch state a model choice does.
   */
  protected async handleChatSetPlanMode(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!session) return;

    const requested = data.planMode === true;
    // The live lifecycle updates the registry record synchronously. Capture
    // the durable value first, otherwise comparing only after the call makes a
    // real change look already saved and an app restart silently restores the
    // previous mode.
    const previousPlanMode = session.chatPlanMode;
    const running = await this.deps.chatManager?.setPlanMode?.(session.id, requested) ?? null;
    const result = running ?? {
      planMode: requested,
      changed: session.chatPlanMode === requested ? false : true,
      detail: requested
        ? 'Plan mode is on and will apply when this conversation runs.'
        : 'Plan mode is off. The latest plan was kept.',
    };

    session.chatPlanMode = result.planMode;
    if (previousPlanMode !== result.planMode) {
      if (!await this.persistChatMutation(
        wsInfo,
        session,
        async () => {
          try {
            await this.deps.chatManager?.setPlanMode?.(session.id, previousPlanMode === true);
          } finally {
            session.chatPlanMode = previousPlanMode;
            this.deps.chatManager?.rememberPlanMode?.(session.id, previousPlanMode === true);
          }
        },
        'Plan mode change',
      )) return;
    }
    this.deps.chatManager?.rememberPlanMode?.(session.id, result.planMode);

    broadcastChat(
      session.id,
      {
        type: 'chat_plan_mode',
        sessionId: session.id,
        planMode: result.planMode,
        changed: result.changed,
        message: result.detail,
      },
      this.deps.claudeSessions,
      this.deps.webSocketConnections,
    );
  }


  protected async handleChatPlanAction(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    const manager = this.deps.chatManager;
    if (!session || !manager) return;
    // Accept may turn Plan mode off inside ChatSession before returning. The
    // pre-action value is what tells us whether that mutation still needs its
    // awaited registry save.
    const previousPlanMode = session.chatPlanMode;

    const revision = Number.isSafeInteger(data.revision) && Number(data.revision) > 0
      ? Number(data.revision)
      : 0;
    let snapshot = action === 'accept'
      ? await manager.snapshot(session).catch(() => null)
      : null;
    // Do not ask a retained, exited ChatSession to accept first. Its ordinary
    // rejection says only that it is not live; the useful operation here is to
    // bring the durable conversation back and deliver the implementation turn.
    let result = action === 'accept' && snapshot?.live === false
      ? null
      : action === 'accept'
        ? await manager.acceptPlan?.(session.id, revision) ?? null
        : await manager.rejectPlan?.(session.id, revision) ?? null;

    // A stopped conversation can keep/reject a plan. Accept is different: once
    // the durable document and reviewed revision have been checked, relaunch
    // the same conversation and immediately hand the plan to the live session.
    if (!result) {
      snapshot ??= await manager.snapshot(session).catch(() => null);
      const plan = snapshot?.planDocument ?? null;
      if (action === 'accept') {
        if (!session.chatPlanMode) {
          result = { accepted: false, action, planMode: false, detail: 'Plan mode is not active.' };
        } else if (!plan) {
          result = { accepted: false, action, planMode: true, detail: 'There is no plan to accept.' };
        } else if (revision !== plan.revision) {
          result = {
            accepted: false,
            action,
            planMode: true,
            revision: plan.revision,
            detail: `Revision ${revision} is stale. Review revision ${plan.revision} before accepting.`,
          };
        } else if (!manager.acceptPlan) {
          result = {
            accepted: false,
            action,
            planMode: true,
            revision: plan.revision,
            detail: 'This server cannot start implementation from the Plan control.',
          };
        } else {
          const runtime = session.lastAgent || session.agent || snapshot?.runtime || '';
          if (!runtime) {
            result = {
              accepted: false,
              action,
              planMode: true,
              revision: plan.revision,
              detail: 'The conversation runtime is unknown, so implementation could not be started.',
            };
          } else {
            // `resume: true` is continuation semantics even for a runtime that
            // never supplied a native id: it preserves the durable Plan and the
            // conversation's approval mode instead of treating this as Start
            // fresh. When an id exists, startChat passes it through normally.
            await this.startChat(wsInfo.id, runtime, { resume: true }, session.id);
            result = await manager.acceptPlan(session.id, revision);
            if (!result) {
              result = {
                accepted: false,
                action,
                planMode: true,
                revision: plan.revision,
                detail: 'The conversation could not be resumed to implement this plan. Retry Accept.',
              };
            }
          }
        }
      } else if (!session.chatPlanMode) {
        result = { accepted: false, action, planMode: false, detail: 'Plan mode is not active.' };
      } else if (!plan) {
        result = { accepted: false, action, planMode: true, detail: 'There is no plan to reject.' };
      } else if (revision !== plan.revision) {
        result = {
          accepted: false,
          action,
          planMode: true,
          revision: plan.revision,
          detail: `Revision ${revision} is stale. Review revision ${plan.revision} instead.`,
        };
      } else {
        result = {
          accepted: true,
          action,
          planMode: true,
          revision: plan.revision,
          detail: `Plan revision ${plan.revision} rejected. Add feedback in the composer to request a revision.`,
        };
      }
    }

    session.chatPlanMode = result.planMode;
    if (previousPlanMode !== result.planMode) {
      if (!await this.persistChatMutation(
        wsInfo,
        session,
        async () => {
          try {
            await manager.setPlanMode?.(session.id, previousPlanMode === true);
          } finally {
            session.chatPlanMode = previousPlanMode;
            manager.rememberPlanMode?.(session.id, previousPlanMode === true);
          }
        },
        'Plan action state',
      )) return;
    }

    broadcastChat(
      session.id,
      {
        type: 'chat_plan_action',
        sessionId: session.id,
        action,
        accepted: result.accepted,
        planMode: result.planMode,
        revision: result.revision,
        message: result.detail,
      },
      this.deps.claudeSessions,
      this.deps.webSocketConnections,
    );
  }


  protected async handleChatSetEffort(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!session) return;

    const raw = typeof data.effort === 'string' ? data.effort.trim() : '';
    const effort = raw ? normaliseEffortLevel(raw) : undefined;
    const manager = this.deps.chatManager;

    const reply = (
      applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused',
      message: string,
      level: string | null,
    ): void => {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_effort_result',
        sessionId: session.id,
        effort: level,
        applied,
        message,
      });
    };

    // Nothing is stored on a refusal, so the conversation keeps running at
    // whatever it was already on rather than being moved somewhere neither the
    // user nor the runtime asked for.
    if (raw && !effort) {
      reply('refused', 'That is not a level any runtime here offers.', null);
      return;
    }

    const snapshot = manager
      ? ((await manager.snapshot(session).catch(() => null)) as {
          live?: boolean;
          capabilities?: { efforts?: { value: string }[]; commands?: { name: string }[] };
        } | null)
      : null;
    const ladder = snapshot?.capabilities?.efforts;

    if (effort && ladder?.length && !ladder.some((level) => level.value === effort)) {
      reply(
        'refused',
        `${session.agent} does not offer "${effort}". It accepts: ${ladder
          .map((level) => level.value)
          .join(', ')}.`,
        null,
      );
      return;
    }

    const previousEffort = session.chatEffortOverride;
    session.chatEffortOverride = effort;
    if (!await this.persistChatMutation(
      wsInfo,
      session,
      () => { session.chatEffortOverride = previousEffort; },
      'effort choice',
    )) return;
    // The same trap the model has, and the reason `rememberEffort` exists: a
    // `/clear` restarts the process in place from the options it was launched
    // with, so without this it would silently go back to the level the
    // conversation opened at after the browser was told the change was live.
    manager?.rememberEffort(session.id, effort);

    if (!effort) {
      reply(
        'cleared',
        'Back to the runtime’s own default. It applies from the next session for this conversation.',
        null,
      );
      return;
    }

    if (!manager) {
      reply('pending', `Saved. This conversation will run at ${effort} from its next session.`, effort);
      return;
    }

    try {
      if (await manager.setEffort(session.id, effort)) {
        reply('live', `Now thinking at ${effort}.`, effort);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      reply(
        'pending',
        `Saved, but the running session would not take it (${message}). ${effort} applies from its next session.`,
        effort,
      );
      return;
    }

    // The adapter cannot change it on a live process. Where the runtime
    // advertises an `/effort` command of its own, send it as a turn and say so
    // honestly — the CLI's own reply in the transcript is the confirmation, not
    // this message. Claude is the one that answers this today, and it answers
    // for free; its adapter takes the direct road above, so this is the path a
    // future runtime with the command and no protocol for it will arrive on.
    const hasEffortCommand =
      snapshot?.capabilities?.commands?.some((command) => command.name === 'effort') ?? false;

    if (snapshot?.live === true && hasEffortCommand) {
      try {
        await manager.send(session.id, { text: `/effort ${effort}` });
        reply(
          'sent',
          `Sent "/effort ${effort}" to the session — the transcript will show whether it took.`,
          effort,
        );
        return;
      } catch {
        // Falls through to the saved-for-next-time answer below.
      }
    }

    reply(
      'pending',
      `Saved. This runtime cannot change how hard it thinks mid-session — ${effort} applies from its next session.`,
      effort,
    );
  }


  /**
   * Withdraw a turn the user typed ahead.
   *
   * Silent when the id is unknown: by the time a click arrives the turn may
   * already have started running, and the session's own `chat_queue` broadcast
   * has told every browser so. An error for that would be noise about a race
   * the user cannot lose in any way that matters.
   */
  protected handleChatQueueCancel(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    manager.cancelQueued(session.id, queuedId);
  }


  /**
   * Send a turn the user typed ahead, now, in front of whatever is running.
   *
   * Silent for the same reason the withdrawal above is: by the time the click
   * arrives that turn may already have started, and the session broadcasts the
   * queue on every change, so both browsers already agree on what is true. The
   * one thing that must not happen is a double delivery from a double click,
   * and that is settled in the session — the id leaves the queue before
   * anything is interrupted, so the second call finds nothing to promote.
   */
  protected async handleChatQueueSendNow(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    await manager.sendQueuedNow(session.id, queuedId);
  }


  /**
   * Try a queued turn that could not be delivered again.
   *
   * Silent on an unknown id for the same reason as cancelling: the click races
   * the queue's own broadcast, and the session answers with the whole queue
   * either way.
   */
  protected handleChatQueueRetry(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    manager.retryQueued(session.id, queuedId);
  }


  protected handleChatPermission(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const optionId = typeof data.optionId === 'string' ? data.optionId : '';
    if (!requestId || !optionId) return;

    manager.respondPermission(session.id, requestId, optionId);
  }


  /**
   * Answer a multiple-choice question the model asked.
   *
   * Separate from the approval route rather than reusing it with a list: an
   * approval is one decision out of a set this app defines, and a question is an
   * arbitrary selection out of a set the model wrote. Routing both through one
   * handler would mean a browser could answer a question with an approval id.
   */
  protected async handleChatQuestion(wsInfo: WebSocketInfo, data: IncomingMessage): Promise<void> {
    const submissionId = typeof data.submissionId === 'string' ? data.submissionId : '';
    // Older browsers have no way to match this reply, so preserve their
    // previous fire-and-forget handling instead of sending a meaningless ack.
    const acknowledge = (accepted: boolean, sessionId = data.sessionId || ''): void => {
      if (!submissionId || submissionId.length > MAX_QUESTION_ANSWER_SUBMISSION_ID) return;
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_question_answer_ack',
        sessionId,
        requestId: typeof data.requestId === 'string' ? data.requestId : '',
        submissionId,
        accepted,
      });
    };

    if (submissionId && submissionId.length > MAX_QUESTION_ANSWER_SUBMISSION_ID) return;

    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) {
      acknowledge(false);
      return;
    }

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!requestId) {
      acknowledge(false, session.id);
      return;
    }

    const optionIds = Array.isArray(data.optionIds)
      ? data.optionIds.filter((id): id is string => typeof id === 'string')
      : [];
    // Free text the user typed instead of picking. Trimmed and bounded here
    // rather than trusted: it is written to the conversation log and handed to
    // the model, and this is the edge of the system that a browser writes to.
    const text =
      typeof data.text === 'string'
        ? data.text.trim().slice(0, MAX_QUESTION_ANSWER_TEXT)
        : undefined;
    const accepted = await manager.answerQuestion(
      session.id,
      requestId,
      optionIds,
      data.skipped === true,
      text,
    );
    acknowledge(accepted, session.id);
  }


  protected async handleChatHistory(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;
    if (this.rejectUnavailableRead(wsInfo, session)) return;

    const fromSeq = Math.max(0, Math.floor(Number(data.fromSeq) || 0));
    const count = Math.max(1, Math.floor(Number(data.count) || 200));

    try {
      const page = await manager.readPage(session, fromSeq, count);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_page',
        sessionId: session.id,
        requestId: data.requestId || null,
        ...page,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Answered on the chat channel too. A bare `error` leaves the requesting
      // tab's "loading earlier messages" spinner running against a reply that
      // is never coming, which is precisely the state it was stuck in.
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_page_failed',
        sessionId: session.id,
        requestId: data.requestId || null,
        message,
      });
      sendToWebSocket(wsInfo.ws, { type: 'error', message });
    }
  }


  /**
   * The full turn index of one conversation.
   *
   * Answered from the recorded log, so the list is the same however much of the
   * conversation the asking browser has loaded (#86). A failure is answered on
   * the chat channel for the same reason a page failure is: the index shows a
   * spinner while it waits, and silence leaves it spinning forever.
   */
  protected async handleChatTurnIndex(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;
    if (this.rejectUnavailableRead(wsInfo, session)) return;

    try {
      const index = await manager.turnIndex(session);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_turn_index',
        sessionId: session.id,
        requestId: data.requestId || null,
        ...index,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_turn_index_failed',
        sessionId: session.id,
        requestId: data.requestId || null,
        message,
      });
    }
  }


  protected async handleHistoryRequest(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const sessionId = data.sessionId || wsInfo.claudeSessionId;
    if (!sessionId) {
      return;
    }

    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found',
      });
      return;
    }
    if (this.rejectUnavailableRead(wsInfo, session)) return;

    try {
      const page = await this.deps.historyStore.read(
        session,
        typeof data.fromLine === 'number' ? data.fromLine : 0,
        typeof data.count === 'number' ? data.count : 0,
      );

      sendToWebSocket(wsInfo.ws, {
        type: 'history_chunk',
        sessionId,
        requestId: data.requestId ?? null,
        ...page,
      });
    } catch (error) {
      console.error(`Failed to read history for session ${sessionId}:`, error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to read session history',
      });
    }
  }

}
