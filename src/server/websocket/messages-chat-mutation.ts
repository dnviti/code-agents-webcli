import path from 'node:path';
import { SessionRecord, WebSocketInfo } from '../types.js';
import { broadcastChat, sendToWebSocket } from './handler.js';
import { ChatAttachment, ChatDraft, BuiltInWorkflowId, MAX_BUILT_IN_WORKFLOW_PROMPT, isBuiltInWorkflowId } from '../../shared/chat-events.js';
import { builtInWorkflowInstructions } from '../chat/builtin-workflows.js';
import { applyDraft, clearDraft, draftOf, readAttachments, readDraft } from '../chat/drafts.js';
import { ChatNotRunningError } from '../chat/session.js';
import { ChatManagerLike } from './messages-types.js';
import { MAX_BUILT_IN_WORKFLOW_ADMISSIONS, MAX_BUILT_IN_WORKFLOW_REQUEST_ID, BuiltInWorkflowAdmissionResult, IncomingMessage, normaliseEffortLevel, normaliseModelName } from './messages-shared.js';
import { MessageProcessorChatLaunchBase } from './messages-chat-launch.js';
export abstract class MessageProcessorChatMutationBase extends MessageProcessorChatLaunchBase {


  /**
   * Take one screen's composer as the conversation's, and tell the others.
   *
   * Routed through `broadcastChat` rather than `sendToUser`, so it follows the
   * conversation: a person may have six tabs open and only some of them are
   * looking at this chat, and the ones that are not have no composer to put it
   * in. Everyone watching gets it, including the screen it came from — which is
   * how that screen learns the revision its own edit was given, and why the
   * origin rides along for it to recognise itself by.
   *
   * Silent on anything it will not take. A draft that arrives malformed, or too
   * large to be worth carrying, leaves the screen that holds it working exactly
   * as it did before any of this existed; an error toast per keystroke would be
   * a worse answer than a feature that quietly stops applying.
   */
  protected async handleChatDraft(wsInfo: WebSocketInfo, data: IncomingMessage): Promise<void> {
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!session || session.surface !== 'chat') return;

    const input = readDraft(data.text, data.attachments, session.id);
    if (!input) return;

    const previous = session.chatDraft;
    const next = applyDraft(session, input);
    let saved = false;
    try {
      saved = (await this.deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error(`Failed to persist draft for session ${session.id}:`, error);
    }
    if (!saved) {
      session.chatDraft = previous;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'The draft could not be saved in this workspace.',
      });
      return;
    }
    this.broadcastDraft(session, next, wsInfo.id);
  }


  /**
   * Announce a composer to every screen watching this conversation.
   *
   * `origin` is the socket the edit came from, or null when it was not a screen
   * that caused it — a turn being sent empties the composer, and no browser
   * should treat that as its own echo and skip it.
   */
  protected broadcastDraft(
    session: SessionRecord,
    draft: ChatDraft,
    origin: string | null,
  ): void {
    broadcastChat(
      session.id,
      { type: 'chat_draft', sessionId: session.id, draft, origin },
      this.deps.claudeSessions,
      this.deps.webSocketConnections,
    );
  }


  protected async handleChatSend(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const text = typeof data.text === 'string' ? data.text : '';
    const candidates = readAttachments(data.attachments, session.id);
    if (!candidates) return;
    const verifiedAttachments = this.deps.resolveChatAttachment
      ? (await Promise.all(candidates.map(async (attachment) => {
          try {
            return await this.deps.resolveChatAttachment!(session, attachment);
          } catch {
            return null;
          }
        }))).filter((attachment): attachment is ChatAttachment => attachment !== null)
      : [];
    // Checked after server-side resolution. A frame carrying only a forged or
    // stale attachment path must never become a turn that reaches an adapter.
    if (!text.trim() && verifiedAttachments.length === 0) return;

    // The runtime's own `/model` reaches the same decision by the other door,
    // so it has to leave the same trace. Without this the command is forwarded
    // untouched, the conversation really does change model, and then the next
    // `/clear` restarts it on the model it opened with — the same silent
    // reversion the model picker was fixed for. Recorded, then forwarded
    // unchanged: the runtime still runs its own command, and whether it
    // accepted the name is still its answer to give, not ours.
    const typedModel = /^\/model[ \t]+(\S.*)$/.exec(text.trim());
    if (typedModel) {
      const model = normaliseModelName(typedModel[1]);
      if (model) {
        const previousModel = session.chatModelOverride;
        session.chatModelOverride = model;
        if (!await this.persistChatMutation(
          wsInfo,
          session,
          () => { session.chatModelOverride = previousModel; },
          'model choice',
        )) return;
        manager.rememberModel(session.id, model);
        // And the standing default too, on the same terms the picker records
        // one (#135): the two doors reach the same decision, so they have to
        // leave the same trace, or which one the user happened to use would
        // decide whether the next new chat remembered anything.
        await this.rememberUserModel(session, model, false);
      }
    }

    // And the same for a typed `/effort`, which claude answers itself. Recorded
    // for the same reason and forwarded just as unchanged: a level the user
    // typed is still the runtime's to accept or refuse, but if it accepts, the
    // next `/clear` must not put the conversation back where it started.
    const typedEffort = /^\/effort[ \t]+(\S+)\s*$/.exec(text.trim());
    if (typedEffort) {
      const effort = normaliseEffortLevel(typedEffort[1]);
      // Recorded only when the runtime published this level, which is a
      // narrower test than the one the model equivalent above applies — and it
      // has to be, because a runtime's slash command and its launch flag do not
      // accept the same words. Claude's `/effort` takes `auto` as well as the
      // six on its ladder, and `--effort auto` answers by warning on a stream
      // nobody reads and running at its default. So typing `/effort auto`
      // genuinely changes the running session, and storing it would have made
      // every launch after that one silently ignore the level while the chip
      // still claimed it. The published ladder is the only test that can tell
      // that case from `/effort ultracode`, which the flag does accept.
      //
      // The turn is forwarded either way. What the runtime does with a command
      // is the runtime's business; what this app is willing to *replay* is not.
      const ladder = effort
        ? ((await manager.snapshot(session).catch(() => null)) as {
            capabilities?: { efforts?: { value: string }[] };
          } | null)?.capabilities?.efforts
        : undefined;
      if (effort && ladder?.some((level) => level.value === effort)) {
        const previousEffort = session.chatEffortOverride;
        session.chatEffortOverride = effort;
        if (!await this.persistChatMutation(
          wsInfo,
          session,
          () => { session.chatEffortOverride = previousEffort; },
          'effort choice',
        )) return;
        manager.rememberEffort(session.id, effort);
      }
    }

    // Read before the send, because the send is not instant: `/clear` restarts
    // the agent's whole process behind it, and anything typed on any screen
    // while that runs is a *different* message from the one being sent. Clearing
    // whatever the composer holds when the await finally returns would throw
    // that away.
    const draftAtSend = draftOf(session)?.revision ?? 0;

    try {
      await manager.send(session.id, {
        text,
        attachments: verifiedAttachments.length ? verifiedAttachments : undefined,
      });
      session.lastActivity = new Date();
      this.noteActivity(session);
      // The composer that held this turn is empty now, on every screen. The one
      // that sent it emptied its own box the moment the button was pressed;
      // without this the others would go on offering a prompt that has already
      // been asked, and the next person to press send there would ask it twice.
      //
      // Only for a turn that came *from* a composer. "Send this turn again"
      // takes its text from the transcript and leaves the input alone (see
      // ChatView.retryTurn), so clearing on every accepted turn would blank a
      // message somebody was halfway through writing — on every screen at once,
      // for pressing retry on something else entirely.
      //
      // Tagged with the screen it came from, which is not the throwaway detail
      // it looks like: that screen emptied its own box a round trip ago and may
      // already be typing the next question into it, and applying this would
      // take those keystrokes back out.
      if (data.fromComposer === true && (draftOf(session)?.revision ?? 0) === draftAtSend) {
        const cleared = clearDraft(session);
        if (cleared) {
          // The accepted turn and its empty composer must become durable in the
          // same order. A restart must not offer a prompt that already ran.
          await this.deps.saveSessionsToDisk();
          this.broadcastDraft(session, cleared, wsInfo.id);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // Not a connection failure, and not the whole app's problem: this one
      // session's process is gone, its transcript is intact, and there is
      // something the user can do about it. Reported as its own message so the
      // pane can say so and offer the choice, instead of the generic error
      // overlay covering a conversation with a Retry that cannot work.
      if (error instanceof ChatNotRunningError) {
        sendToWebSocket(wsInfo.ws, {
          type: 'chat_unavailable',
          sessionId: session.id,
          runtime: session.lastAgent || '',
          runtimeLabel: session.runtimeLabel || '',
          canResume: Boolean(session.nativeChatSessionId),
          message,
        });
        return;
      }

      sendToWebSocket(wsInfo.ws, { type: 'error', message });
    }
  }


  /**
   * Admit one app-owned guided workflow without borrowing the composer path.
   *
   * The browser needs a positive, correlated answer before it closes the
   * popup. Ordinary chat sends deliberately do not have that handshake: their
   * composer draft is cleared as soon as the server takes ownership. A workflow
   * prompt is separate so an unrelated synchronized draft remains untouched.
   */
  protected async handleChatStartBuiltInWorkflow(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const requestedSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const workflow = data.workflow;
    const reply = (
      accepted: boolean,
      message: string,
      status?: 'accepted' | 'queued',
      sessionId = requestedSessionId,
    ): void => {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_builtin_workflow_result',
        sessionId,
        requestId,
        workflow,
        accepted,
        ...(status ? { status } : {}),
        message,
      });
    };

    if (!requestId) {
      // A caller without a correlation id cannot safely close a popup. It is
      // still told why on its socket for debugging/version-skew visibility.
      reply(false, 'The workflow request was missing its correlation id.');
      return;
    }
    if (requestId.length > MAX_BUILT_IN_WORKFLOW_REQUEST_ID) {
      reply(false, 'The workflow request correlation id is too large.');
      return;
    }
    if (!isBuiltInWorkflowId(workflow)) {
      reply(false, 'That built-in workflow is unavailable.');
      return;
    }

    const prompt = typeof data.text === 'string' ? data.text : '';
    const trimmed = prompt.trim();
    if (!trimmed) {
      reply(false, 'Describe the issue before starting the guided workflow.');
      return;
    }
    if (prompt.length > MAX_BUILT_IN_WORKFLOW_PROMPT) {
      reply(
        false,
        `The workflow prompt is too large; the limit is ${MAX_BUILT_IN_WORKFLOW_PROMPT.toLocaleString('en-US')} characters.`,
      );
      return;
    }

    const manager = this.deps.chatManager;
    let persistenceBlocked = false;
    const session = this.mutableChatSessionFor(wsInfo, requestedSessionId, (message) => {
      persistenceBlocked = true;
      reply(false, message, undefined, requestedSessionId);
    });
    if (persistenceBlocked) return;
    if (!manager || !session || session.surface !== 'chat') {
      reply(false, 'This conversation is unavailable.');
      return;
    }

    const admissionKey = `${wsInfo.userId}:${session.id}:${requestId}`;
    let admission = this.builtInWorkflowAdmissions.get(admissionKey);
    if (admission && (admission.workflow !== workflow || admission.prompt !== trimmed)) {
      reply(false, 'That workflow request id was already used for a different prompt.', undefined, session.id);
      return;
    }
    if (!admission) {
      if (this.builtInWorkflowAdmissions.size >= MAX_BUILT_IN_WORKFLOW_ADMISSIONS) {
        reply(false, 'Too many guided workflow requests are being admitted. Please try again.', undefined, session.id);
        return;
      }
      admission = {
        workflow,
        prompt: trimmed,
        promise: this.admitBuiltInWorkflow(manager, session, workflow, trimmed),
        accepted: false,
      };
      this.builtInWorkflowAdmissions.set(admissionKey, admission);
    }

    const result = await admission.promise;
    // Rejections must be retryable with the same id once the underlying state
    // changes (Plan mode off, queue space available, runtime resumed). Only a
    // result that took ownership of the turn is safe to replay.
    if (result.accepted) {
      admission.accepted = true;
    } else if (this.builtInWorkflowAdmissions.get(admissionKey) === admission) {
      this.builtInWorkflowAdmissions.delete(admissionKey);
    }
    reply(result.accepted, result.message, result.status, session.id);
  }


  /** Perform the one state-changing admission shared by all duplicate frames. */
  protected async admitBuiltInWorkflow(
    manager: ChatManagerLike,
    session: SessionRecord,
    workflow: BuiltInWorkflowId,
    prompt: string,
  ): Promise<BuiltInWorkflowAdmissionResult> {
    if (session.chatPlanMode === true) {
      return {
        accepted: false,
        message: 'Turn Plan mode off before starting a workflow that can create a GitHub issue.',
      };
    }

    // Check the installed asset before a user message reaches the transcript.
    // A missing package asset is actionable server configuration, not a prompt
    // the agent should attempt to interpret without its required instructions.
    try {
      builtInWorkflowInstructions(workflow);
    } catch (error: unknown) {
      return { accepted: false, message: error instanceof Error ? error.message : String(error) };
    }

    const snapshot = await manager.snapshot(session).catch(() => null);
    if (!snapshot) {
      return { accepted: false, message: 'This conversation could not be checked. Please try again.' };
    }
    if (snapshot.live !== true) {
      return {
        accepted: false,
        message: 'This conversation is not running. Resume it before starting the workflow.',
      };
    }
    if (snapshot.planMode === true) {
      return {
        accepted: false,
        message: 'Turn Plan mode off before starting a workflow that can create a GitHub issue.',
      };
    }

    try {
      const status = await manager.send(session.id, { text: prompt, workflow });
      if (status !== 'accepted' && status !== 'queued') {
        throw new Error('The conversation did not confirm whether the guided workflow started.');
      }
      session.lastActivity = new Date();
      this.noteActivity(session);
      return {
        accepted: true,
        status,
        message: status === 'queued' ? 'The guided workflow is queued.' : 'The guided workflow started.',
      };
    } catch (error: unknown) {
      return { accepted: false, message: error instanceof Error ? error.message : String(error) };
    }
  }


  /**
   * Forget a successful admission once its browser has finished the local
   * handoff and promises not to retry that correlation id.
   *
   * There is deliberately no reply. This frame is cleanup after the correlated
   * result, not another operation the popup must wait for. If it is lost, the
   * bounded cache keeps the safer failure mode: a later replay still dedupes.
   */
  protected handleChatBuiltInWorkflowAck(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const workflow = data.workflow;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!requestId || !isBuiltInWorkflowId(workflow) || !session) return;
    const key = `${wsInfo.userId}:${session.id}:${requestId}`;
    const admission = this.builtInWorkflowAdmissions.get(key);
    if (!admission || admission.workflow !== workflow || !admission.accepted) return;
    this.builtInWorkflowAdmissions.delete(key);
  }


  protected async handleChatInterrupt(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;
    await manager.interrupt(session.id).catch(() => undefined);
  }


  /**
   * Change the model for one conversation, independent of the runtime's own
   * default or the active profile.
   *
   * Never pre-validated: what a typed name actually does is only known by
   * trying it, so this always persists the choice and then reports what
   * happened, in order of how good an answer it is — live, best-effort sent as
   * a turn, or merely saved for the next launch.
   *
   * It is also, since #135, where this account's standing model for the runtime
   * is set — a pick made here is the only place in the app anybody says which
   * model they want, and forgetting it the moment the conversation ended was
   * the whole complaint. The override still belongs to this conversation alone;
   * what travels is a *separate* preference that seeds the next new chat, and
   * only when the runtime is known to take the name. See rememberUserModel.
   */
  protected async handleChatSetModel(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const session = this.mutableChatSessionFor(wsInfo, data.sessionId);
    if (!session) return;

    const raw = typeof data.model === 'string' ? data.model.trim() : '';
    const model = raw ? normaliseModelName(raw) : undefined;
    const previousModel = session.chatModelOverride;
    const previousPinned = session.chatModelPinned;
    session.chatModelOverride = model;
    // Clearing drops the pin as well, and that is what makes "Use the default
    // for this runtime" mean what it says: the pin is the model this
    // conversation happened to be launched on, so leaving it would make the
    // clear fall back to that instead of to the profile and then the runtime's
    // own default. Unlike the seeding above, this is the user asking, in this
    // conversation, for the defaults to decide again — the one case where
    // re-reading them is not a retcon.
    if (!model) session.chatModelPinned = undefined;
    if (!await this.persistChatMutation(
      wsInfo,
      session,
      () => {
        session.chatModelOverride = previousModel;
        session.chatModelPinned = previousPinned;
      },
      'model choice',
    )) return;

    // A live session keeps the options it was launched with so that `/clear`
    // can restart the process in place. The model is the one thing in there
    // this handler can change, so it has to be carried across too — otherwise
    // the next `/clear` reinstates the model the conversation opened with,
    // after the browser has already been told the switch was applied. Resolved
    // the way a launch resolves it, so clearing lands on the profile default.
    //
    // Through the read-only accessor. The other one writes the profile's tier
    // files to disk every time it is called, and picking a model from the chip
    // is a question about this conversation, not a launch — asking it that way
    // rewrote the project's `.pi/agents/*.md` on every click (#171).
    const profile = this.deps.activeProfileFor?.(session.agent || '') ?? null;
    this.deps.chatManager?.rememberModel(
      session.id,
      model || profile?.model || profile?.ladder?.model,
    );

    /**
     * Every answer carries the default as it stands *after* this pick.
     *
     * Without it the picker's source line and its "use the default" entry go
     * stale the moment they matter most: they would still be describing the
     * state the conversation launched in, one click after the user changed it.
     */
    const answer = (
      applied: 'live' | 'sent' | 'pending' | 'cleared',
      value: string | null,
      message: string,
    ): void => {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_model_result',
        sessionId: session.id,
        model: value,
        applied,
        message,
        modelDefault: this.modelDefaultFor(
          session.agent || session.lastAgent,
          session.ownerUserId,
          profile,
        ),
      });
    };

    if (!model) {
      await this.rememberUserModel(session, undefined, false);
      // What it actually falls back to, which a ladder changes: the rung is the
      // profile's standing answer for this runtime, so clearing lands there
      // rather than on the CLI's own default.
      const cleared = this.deps.activeProfileFor?.(session.agent || '') ?? null;
      const under = cleared?.model
        ? `the "${cleared.profileName}" profile’s model, ${cleared.model}`
        : cleared?.ladder
          ? `the ${cleared.ladder.tier} rung of the "${cleared.profileName}" ladder, ${cleared.ladder.model}`
          : 'the runtime default';
      answer(
        'cleared',
        null,
        `Cleared the model override. The next session for this conversation will use ${under}.`,
      );
      return;
    }

    const manager = this.deps.chatManager;
    if (!manager) {
      await this.rememberUserModel(session, model, false);
      answer(
        'pending',
        model,
        `Saved. ${model} will be used the next time a session starts for this conversation.`,
      );
      return;
    }

    try {
      const applied = await manager.setModel(session.id, model);
      if (applied) {
        await this.rememberUserModel(session, model, true);
        answer('live', model, `Switched to ${model} for this conversation.`);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.rememberUserModel(session, model, false);
      answer(
        'pending',
        model,
        `Saved, but switching live failed (${message}). ${model} will be used the next time a session starts.`,
      );
      return;
    }

    // The adapter cannot switch live. If the runtime advertises its own
    // `/model` command, best-effort send it as an ordinary turn — the same
    // mechanism the old switchable picker used — and say so honestly: the
    // CLI's own reply is the real confirmation, not this message.
    const snapshot = await manager.snapshot(session).catch(() => null) as
      | { live?: boolean; capabilities?: { commands?: { name: string }[] } }
      | null;
    const live = snapshot?.live === true;
    const hasModelCommand = snapshot?.capabilities?.commands?.some((c) => c.name === 'model') ?? false;

    if (live && hasModelCommand) {
      try {
        await manager.send(session.id, { text: `/model ${model}` });
        await this.rememberUserModel(session, model, false);
        answer(
          'sent',
          model,
          `Sent "/model ${model}" to the session — check the transcript to confirm it took.`,
        );
        return;
      } catch {
        // Falls through to the saved-for-next-time answer below.
      }
    }

    await this.rememberUserModel(session, model, false);
    answer(
      'pending',
      model,
      `Saved. This runtime cannot change model mid-session — ${model} will be used the next time a new session starts for this conversation.`,
    );
  }

}
