import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentKind } from '../../types.js';
import { announceSessionOpened, broadcastChat, sendToWebSocket } from '../handler.js';
import { chatUnavailableReason, isChatRuntime } from '../../../shared/chat-runtimes.js';
import { ChatModelOrigin } from '../../../shared/chat-events.js';
import { resolveApprovalMode } from '../../../shared/user-preferences.js';
import { UserEnvironment } from '../../services/environments/types.js';
import { ladderOf, ladderOrigin } from './messages-shared.js';
import { MessageProcessorSessionsBase } from './messages-sessions.js';
export abstract class MessageProcessorChatLaunchBase extends MessageProcessorSessionsBase {


  /**
   * Open this session as a chat instead of a terminal.
   *
   * The surface is fixed on the session record here and never changes: the two
   * modes run the runtime as different processes — a TUI in a PTY versus a
   * headless protocol stream — so there is nothing meaningful to switch between
   * afterwards. A session that already ran as a terminal is refused rather than
   * converted, because its scrollback and a chat log are not the same history.
   */
  async startChat(
    wsId: string,
    agentKind: string,
    options: Record<string, unknown> = {},
    /**
     * Which conversation to (re)launch, when the browser names one.
     *
     * A relaunch is issued from the pane of a specific chat, and a socket can
     * be watching several — so falling back to "whichever session this socket
     * joined" would restart the wrong conversation. Absent for a first launch,
     * where the joined session is the only candidate.
     */
    targetSessionId?: string,
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
      if (wsInfo?.ws) {
        sendToWebSocket(wsInfo.ws, { type: 'error', message: 'No session joined' });
      }
      return;
    }

    const manager = this.deps.chatManager;
    if (!manager) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Chat mode is not available on this server',
      });
      return;
    }

    // Same ownership rule either way: `chatSessionFor` refuses an id this
    // socket has neither joined nor subscribed to, so naming a session cannot
    // be used to reach one that is not this browser's to reach.
    const session = targetSessionId
      ? this.chatSessionFor(wsInfo, targetSessionId)
      : this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) return;

    if (session.persistenceUnavailable) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `This conversation is read-only while workspace persistence is unavailable: ${session.persistenceUnavailable}`,
      });
      return;
    }
    if (session.rollbackRecoveryPending) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'This conversation is retained only to retry an incomplete rollback',
      });
      return;
    }

    if (session.retiring) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'This session is being closed',
      });
      return;
    }

    if (!isChatRuntime(agentKind)) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message:
          chatUnavailableReason(agentKind) || `${agentKind} cannot be opened as a chat`,
      });
      return;
    }

    if (session.active) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'A process is already running in this session',
      });
      return;
    }

    if (!this.beginRuntimeStart(session.id)) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'A process is already starting in this session',
      });
      return;
    }

    const runId = randomUUID();
    const previousRunId = session.runId;
    session.runId = runId;

    try {

    // Nothing that shapes the launch is taken from the browser any more. Model,
    // arguments and environment come from the server-side profile below, for the
    // same reason they do on the terminal path — a client must not be able to
    // forge a launch configuration — and since #134 the approval mode comes from
    // the owner's stored preference rather than from a flag the page sends. The
    // one thing still honoured from the browser is a `false`, because narrowing
    // is safe from anywhere.
    //
    // Two ways to relaunch a chat whose process is gone, and the difference is
    // the whole point of the choice the user is offered: resume hands the agent
    // back its own context, so the conversation on screen is one it remembers;
    // without it the transcript stays but the agent is new to it.
    const resumeSessionId =
      options.resume === true ? session.nativeChatSessionId : undefined;
    // Only when the browser said so: see ChatSessionStartOptions.startFresh.
    const startFresh = options.resume === false;

    // The rule, and it is decided by the route rather than by what happens to be
    // on the record: only `resume: true` continues a conversation, and every
    // other way in — a first launch, a branch, a start-over — begins one. A
    // conversation that is beginning takes the owner's preference; one that is
    // continuing replays its own recorded grant and re-reads nothing.
    //
    // Keying on the record instead ("has this ever been granted anything?") is
    // the trap: every launched conversation carries a grant, so *Start a new
    // chat* would inherit the bypass of the conversation it had just abandoned.
    //
    // The preference is read for the record's owner, which is also the socket's
    // user — the ownership check above refuses anything else — so one account's
    // preference can never decide another's conversation.
    const bypassPermissions = resolveApprovalMode({
      beginning: options.resume !== true,
      granted: session.chatBypassPermissions,
      preference: this.deps.getUserPreferences?.(session.ownerUserId).chatBypassPermissions,
      explicit: options.dangerouslySkipPermissions === false ? false : undefined,
    });

    const profile = this.deps.resolveRuntimeProfile(
      agentKind as AgentKind,
      session.projectWorkingDirKind === 'container' ? undefined : session.workingDir,
    );
    const modelDefault = this.modelDefaultFor(agentKind, wsInfo.userId, profile);
    // Read before `surface` is set below, because that is half of what it reads.
    //
    // A standing preference is for opening the *next* conversation, never for
    // reaching back into one already under way. The pin below is what enforces
    // that for every conversation launched since #135; this remains the answer
    // for the ones that predate it, whose records carry no pin at all and which
    // must keep falling to the profile rather than picking up a default they
    // were never launched on.
    const seedFromAccount = this.hasNeverChatted(session);

    // A model name is only ever the vocabulary of the runtime that took it, so
    // a pin left by another runtime is not a fact about this launch. Keyed on
    // `lastAgent`, not `agent`: `agent` is null on every record restored from
    // disk, and a server restart is precisely when conversations are relaunched.
    if (session.lastAgent && session.lastAgent !== agentKind) {
      session.chatModelPinned = undefined;
    }

    session.surface = 'chat';
    // A level is only ever a word one runtime published, so it means nothing to
    // the next one — and worse than nothing, because the runtimes that take it
    // as a flag do not refuse an unknown value. Both claude and pi print a
    // warning to a stream nobody is reading and then run at their own default,
    // so a codex `ultra` or a kimi `on` surviving into a claude launch would
    // leave the control reporting a level the conversation was never on.
    //
    // Cleared here rather than filtered at the adapter because this is the one
    // place the change of runtime is visible; the adapters guard themselves as
    // well, for the records this misses.
    if (session.agent && session.agent !== agentKind) {
      session.chatEffortOverride = undefined;
    }
    session.agent = agentKind as AgentKind;
    session.lastAgent = agentKind as AgentKind;
    session.runtimeLabel = this.getRuntimeLabel(agentKind as AgentKind, session);
    session.lastActivity = new Date();

    if (!session.projectId && !this.deps.validatePath(session.workingDir, session.ownerUserId).valid) {
      // Same reasoning as the pty path above.
      session.workingDir = this.userBaseFolder(session.ownerUserId);
    }

    let chatEnvironment: UserEnvironment;
    let chatFileAccess:
      | {
          readFile(filePath: string): Promise<string>;
          writeFile(filePath: string, contents: string): Promise<void>;
        }
      | undefined;
    try {
      const prepared = await this.environmentForSession(session);
      chatEnvironment = prepared.environment;
      if (!this.launchIsCurrent(session, runId)) {
        this.releaseHeldProjectLease(prepared.lease);
        if (session.runId === runId) session.runId = previousRunId;
        return;
      }
      // The manager contract always supplies containerAccess. The runtime
      // guard keeps older embedders/test doubles that predate project-local
      // file delegation on their established host-only behaviour.
      if (prepared.project?.containerAccess) {
        chatFileAccess = this.projectChatFileAccess(session, prepared.project);
      }
      if (prepared.lease) {
        this.releaseRuntimeProjectLease(session.id);
        this.runtimeProjectLeases.set(session.id, prepared.lease);
      }
    } catch (error) {
      if (session.runId === runId) session.runId = previousRunId;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: error instanceof Error
          ? session.projectId
            ? error.message
            : `Your workspace environment could not be started: ${error.message}`
          : 'Your workspace environment could not be started.',
      });
      return;
    }

    const managedLaunch = this.deps.resolveAgentLaunch?.(
      session,
      chatEnvironment,
      agentKind as AgentKind,
    ) ?? null;

    /**
     * Which model this launch actually uses — resolved once, because the record
     * has to be told what it was.
     *
     * The conversation's own choice first. Then whatever it is already fixed to,
     * which is the whole guarantee: a relaunch, a resume from the launcher and
     * the recovery banner's restart are continuations, and a continuation must
     * not be re-modelled by a standing choice or a profile that changed
     * somewhere else since. A branch arrives here already pinned to its source's
     * model, so it opens on the model its carried history was measured against.
     *
     * Only a conversation with no pin at all reaches a default: the account's
     * standing choice if it has never chatted, and otherwise — a record written
     * before pins existed — the profile, exactly as before #135.
     *
     * `pinned === undefined` is "nothing recorded"; a recorded `null` is the
     * answer "it launched with no flag", and it has to outrank the *profile* or
     * a profile configured mid-conversation would retcon a conversation that had
     * deliberately run bare. That is why this is not a chain of `||`.
     *
     * The ladder is the one thing a `null` pin does not outrank, and #171 asks
     * for that in as many words: "conversations that predate this change move
     * onto the ladder the next time they are relaunched". Every one of them
     * carries `null`, so honouring it here would mean the ladder never reached a
     * single conversation that existed before the upgrade. The exception is
     * narrow — it is only the rung, never `profile.model`, so the guarantee
     * #135 bought is intact — and it cannot misfire afterwards: once a laddered
     * runtime is launched, the rung *is* the model, so a fresh `null` pin can
     * only be recorded for a profile that has no ladder to fall to.
     */
    const pinned = session.chatModelPinned;
    const ladder = profile?.ladder ?? null;

    // The chain, resolved to a model *and* the layer that supplied it in one
    // pass. Deriving the layer afterwards by comparing the answer to each
    // candidate reads well and is wrong twice over: a pin that happens to equal
    // the current rung is credited to the ladder — and then not pinned, so a
    // string coincidence quietly enrolls a conversation in every future ladder
    // edit — and a pin that matches nothing is credited to an override the user
    // never made, which the picker renders as "chosen for this conversation
    // only" with no way to clear it.
    let decided: ChatModelOrigin;
    if (session.chatModelOverride) {
      decided = { model: session.chatModelOverride, source: 'override' };
    } else if (pinned) {
      // A continuation. It is on this model because it launched on it, whatever
      // the layers below would say today.
      decided = { model: pinned, source: 'override' };
    } else if (pinned === null && ladder) {
      decided = ladderOrigin(ladder, profile);
    } else if (pinned === null) {
      decided = { model: null, source: 'runtime' };
    } else if (seedFromAccount && modelDefault.model) {
      decided = { ...modelDefault };
    } else if (profile?.model) {
      decided = { model: profile.model, source: 'profile', profileName: profile.profileName };
    } else if (ladder) {
      decided = ladderOrigin(ladder, profile);
    } else {
      decided = { model: null, source: 'runtime' };
    }

    // Not const: a rung the provider refuses is retried bare below, and what
    // the record and the browser are told has to be what actually started.
    let launchModel = decided.model || undefined;
    let modelOrigin = decided;
    let ladderError = profile?.ladderError ?? null;

    let chatMayBeAlive = false;
    try {
      // Starting fresh is a new conversation even when the old one never
      // produced an event. In that empty-log case ChatSession has no truncation
      // boundary at which to report the reset back, so clear the durable record
      // here as well and make the launch announcement agree with the process.
      if (startFresh) session.chatPlanMode = false;
      const startWith = async (model: string | undefined) => manager.start(session, {
        runtime: agentKind,
        command: managedLaunch?.command,
        environment: chatEnvironment,
        workingDir: session.workingDir,
        cwdKind: session.projectWorkingDirKind,
        fileAccess: chatFileAccess,
        model,
        // No profile fallback behind it: profiles are server-wide and keyed by
        // runtime, and an effort level is a per-conversation decision that has
        // never had a profile default to fall back to. Absent means the runtime
        // gets no flag at all and uses whatever it considers normal.
        effort: session.chatEffortOverride,
        extraArgs: profile?.extraArgs,
        env: profile?.env,
        // Only when the rung is what this conversation is actually running on.
        // A profile-typed model or an account's standing choice outranks the
        // ladder, and offering an escalation from a rung nobody is on would ask
        // the user to approve a move that changes nothing they can see.
        ladder:
          modelOrigin.source === 'ladder' && profile?.ladder && profile.tiers
            ? { tier: profile.ladder.tier, tiers: profile.tiers }
            : undefined,
        bypassPermissions,
        planMode: startFresh ? false : session.chatPlanMode === true,
        resumeSessionId,
        startFresh,
        cancelled: () => (
          this.deps.claudeSessions.get(session.id) !== session
          || session.retiring === true
        ),
      });

      let chat;
      try {
        chat = await startWith(launchModel);
      } catch (error: unknown) {
        // A rung whose model the provider will not serve — retired, not on this
        // account's plan, spelled for a gateway this install is not pointed at.
        // The conversation carries on at the runtime's own default rather than
        // refusing to open, and says which of the two it is on. Only for the
        // ladder: a model somebody typed in themselves is a request to make,
        // and quietly starting on a different one would answer their question
        // wrongly rather than not at all.
        if (modelOrigin.source !== 'ladder') throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`runtime profiles: ${agentKind} refused ${launchModel}: ${message}`);
        // Corrected *before* the retry, not after it. `startWith` reads the
        // origin to decide whether to install the ladder on the session, so a
        // retry launched while it still said 'ladder' put the conversation on a
        // rung it had just been refused: the escalation tool would be offered
        // from a rung nobody is on, and a browser rejoining would be told by
        // `ladderOf` that it is running the very model the provider would not
        // serve — contradicting the launch, which said the opposite.
        launchModel = undefined;
        modelOrigin = { model: null, source: 'runtime' };
        ladderError =
          `${agentKind} would not start on the ${profile?.ladder?.tier} rung’s model `
          + `(${message.trim()}), so this conversation is on its own default instead.`;
        chat = await startWith(undefined);
      }

      chatMayBeAlive = chat.live !== false;

      if (!this.launchIsCurrent(session, runId)) {
        session.active = true;
        session.agent = agentKind as AgentKind;
        session.stopRequested = true;
        this.persistActive(session, true);
        await this.stopRuntime(session.id, agentKind as AgentKind);
        return;
      }

      // Like a PTY bridge, a chat adapter can exit synchronously while its
      // start promise is still resolving. The lifecycle callback has already
      // marked the record inactive and released its project lease in that case;
      // never resurrect either fact from the stale success value below.
      if (
        chat.live === false
        || (session.projectId && !this.runtimeProjectLeases.has(session.id))
      ) {
        session.active = false;
        session.agent = null;
        session.lastActivity = new Date();
        this.persistActive(session, false);
        this.releaseRuntimeProjectLease(session.id);
        sendToWebSocket(wsInfo.ws, {
          type: 'chat_unavailable',
          sessionId: session.id,
          runtime: agentKind,
          runtimeLabel: session.runtimeLabel || '',
          canResume: Boolean(session.nativeChatSessionId),
          message: `${this.getRuntimeLabel(agentKind as AgentKind, session)} exited while starting.`,
        });
        return;
      }

      session.active = true;
      const verifiedVersion = await this.deps.probeAgentLaunchVersion?.(
        chatEnvironment,
        agentKind as AgentKind,
        managedLaunch?.command,
      ) ?? null;
      session.runningAgentVersion = verifiedVersion;
      session.runningManagedAgentVersion = managedLaunch && verifiedVersion === managedLaunch.version
        ? verifiedVersion
        : null;
      this.persistActive(session, true);
      session.stopRequested = false;
      session.sessionStartTime = session.sessionStartTime || new Date();
      // Recorded on the record, not just handed to the process: the process is
      // the thing that will be gone when this has to be answered again. After
      // the launch rather than before it, so a bypass that never actually ran
      // does not become the standing answer for the next attempt — persisting a
      // permission has to follow from a conversation that really started in it.
      //
      // A real boolean either way, never `undefined`: "this conversation was
      // granted approvals" is a decision the record has to be able to hold, or
      // a preference switched on afterwards would silently widen a conversation
      // that had already chosen to ask.
      session.chatBypassPermissions = chat.bypassing === true;
      // And what it launched on, for the same reason and on the same terms: the
      // answer has to survive the process that is about to hold it. After the
      // launch, so a model that never actually started does not become the one
      // this conversation is fixed to. `null` rather than absent when there was
      // no flag — "the runtime's own default" is an answer, and it is the one a
      // profile added later must not be allowed to overwrite.
      //
      // A rung is deliberately *not* pinned. The pin exists so an unrelated
      // profile edit cannot re-model a conversation already under way, but the
      // rung is not an unrelated edit — it is the profile's standing answer to
      // the question "which model runs this conversation", and #171 asks for a
      // changed ladder to reach conversations that are already open. Recording
      // `null` leaves the rung to be re-read on every relaunch, which is the
      // same thing one restart later.
      session.chatModelPinned = modelOrigin.source === 'ladder' ? null : launchModel ?? null;
      // Beside it, and for the same reason: the browser that asked for the
      // launch is told this in `chat_started`, and every other screen — a
      // reload, a reconnect, a second tab — arrives at a `chat_snapshot`
      // instead. Without it on the record the badge saying the ladder is not
      // applied lasts exactly as long as the tab that watched it start.
      session.chatLadderError = ladderError;

      // Before the broadcast, so the socket that asked for the launch is
      // already a watcher when the very first event goes out. The subscription
      // owns its own admission: it can outlive both this runtime and the
      // socket's foreground join.
      await this.retainChatSubscription(wsInfo, session);

      if (!this.launchIsCurrent(session, runId)) {
        await this.stopRuntime(session.id, agentKind as AgentKind);
        return;
      }

      // The session already existed as a terminal on every other screen — this
      // is where it becomes a conversation, and a screen that still thinks it is
      // a terminal never subscribes to its events, so the tab sits there frozen
      // at whatever it looked like when it was one. Re-announced rather than
      // given its own message: "here is a session, and here is what it is" is
      // one fact, and the client already folds a repeat into the tab it has.
      announceSessionOpened(
        session,
        this.deps.webSocketConnections,
        this.projectIdentity(session).projectName,
      );

      // `session.id`, not the socket's joined id: a relaunch names its own
      // conversation, and announcing it under the joined one would tell every
      // watcher the wrong chat had come back.
      broadcastChat(
        session.id,
        {
          type: 'chat_started',
          sessionId: session.id,
          agent: agentKind,
          runtimeLabel: session.runtimeLabel,
          workingDir: session.workingDir,
          projectWorkingDirKind: session.projectWorkingDirKind,
          capabilities: chat.currentCapabilities,
          bypassPermissions: chat.bypassing,
          modelOverride: session.chatModelOverride || null,
          // What this conversation is actually running on, when nothing the user
          // chose and nothing the runtime says can answer that. On claude the
          // runtime never reports a model at all, so without this the chip has
          // only the *default* to fall back on — and a default is not a fact
          // about this conversation, which is how the chip came to name a
          // standing choice that had never been applied to it (#135).
          modelPinned: launchModel ?? null,
          // What a new conversation on this runtime would open on, so the
          // picker can say where the model came from instead of leaving a
          // profile-pinned default indistinguishable from no default at all.
          modelDefault,
          // And where *this* conversation's model came from, which is a
          // different question the moment a ladder can answer either one.
          modelOrigin,
          // Said rather than swallowed: a ladder that could not be written
          // through has not configured the delegated helpers, so a conversation
          // that reported the rung anyway would be claiming half a feature.
          ladderError,
          effortOverride: session.chatEffortOverride || null,
          planMode: session.chatPlanMode === true,
        },
        this.deps.claudeSessions,
        this.deps.webSocketConnections,
      );

      await this.deps.saveSessionsToDisk();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed adapter start is safe to release only when ChatSession proved
      // its child stopped and the manager dropped it. A retained manager entry
      // is the fail-closed handle for an unverifiable container process.
      chatMayBeAlive ||= manager.has(session.id);
      if (chatMayBeAlive) {
        session.active = true;
        session.agent = agentKind as AgentKind;
        this.persistActive(session, true);
      } else {
        session.active = false;
        this.persistActive(session, false);
        this.releaseRuntimeProjectLease(session.id);
        if (session.runId === runId) session.runId = previousRunId;
      }
      // Left on 'chat' deliberately: the conversation log for this session is
      // a chat log, and flipping the surface back would show the user an empty
      // terminal as the explanation for a failed chat launch.
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Could not start ${agentKind}: ${message}`,
      });
    }
    } finally {
      this.finishRuntimeStart(session.id);
    }
  }

}
