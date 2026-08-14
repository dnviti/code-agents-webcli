import path from 'node:path';
import { SessionRecord, WebSocketInfo } from '../../types.js';
import { sendToWebSocket } from '../handler.js';
import { ResolvedProfile } from '../../../shared/runtime-profiles.js';
import { ChatModelDefault } from '../../../shared/chat-events.js';
import { normaliseModelName } from './messages-shared.js';
import { MessageProcessorBase } from './messages-base.js';
export abstract class MessageProcessorChatBase extends MessageProcessorBase {


  /**
   * The chat session a message is aimed at.
   *
   * Explicit `sessionId` wins, because a browser with several chat tabs open is
   * watching more than the one it happens to be driving; the joined session is
   * the fallback so a client that predates per-tab addressing still works.
   */
  protected chatSessionFor(
    wsInfo: WebSocketInfo,
    sessionId?: string,
  ): SessionRecord | null {
    const target = sessionId || wsInfo.claudeSessionId;
    if (!target) return null;
    // A socket may only address a chat it is driving or has subscribed to.
    if (target !== wsInfo.claudeSessionId && !wsInfo.chatSessionIds.has(target)) {
      return null;
    }
    const session = this.deps.claudeSessions.get(target);
    if (!session || session.ownerUserId !== wsInfo.userId) return null;
    return session;
  }


  /**
   * Refuse every file-backed read while workspace persistence is unavailable.
   * Chat/history readers normally repair torn derived indexes; permitting that
   * on `persistenceUnavailable` would make a list, join or page request write
   * through a storage gate whose archive authority has not been established.
   */
  protected rejectUnavailableRead(
    wsInfo: WebSocketInfo,
    session: SessionRecord,
  ): boolean {
    if (session.persistenceUnavailable) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `This session is unavailable until workspace persistence succeeds: ${session.persistenceUnavailable}`,
      });
      return true;
    }
    if (session.rollbackRecoveryPending) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'This session is retained only to retry an incomplete rollback',
      });
      return true;
    }
    return false;
  }


  /**
   * Resolve one state-changing chat request and fail closed while its workspace
   * archive is unavailable or not authoritative.
   */
  protected mutableChatSessionFor(
    wsInfo: WebSocketInfo,
    sessionId?: string,
    onBlocked?: (message: string) => void,
  ): SessionRecord | null {
    const session = this.chatSessionFor(wsInfo, sessionId);
    if (!session) return null;
    if (session.persistenceUnavailable) {
      const message =
        `This conversation is read-only until workspace persistence succeeds: ${session.persistenceUnavailable}`;
      if (onBlocked) onBlocked(message);
      else sendToWebSocket(wsInfo.ws, { type: 'error', message });
      return null;
    }
    if (session.rollbackRecoveryPending) {
      const message = 'This conversation is retained only to retry an incomplete rollback';
      if (onBlocked) onBlocked(message);
      else sendToWebSocket(wsInfo.ws, { type: 'error', message });
      return null;
    }
    return session;
  }


  /** Persist a control mutation before exposing it to the live runtime or UI. */
  protected async persistChatMutation(
    wsInfo: WebSocketInfo,
    session: SessionRecord,
    rollback: () => void | Promise<void>,
    label: string,
  ): Promise<boolean> {
    try {
      if ((await this.deps.saveSessionsToDisk()) !== false) return true;
    } catch (error) {
      console.error(`Failed to persist ${label} for session ${session.id}:`, error);
    }
    try {
      await rollback();
    } catch (error) {
      console.error(`Failed to roll back ${label} for session ${session.id}:`, error);
    }
    sendToWebSocket(wsInfo.ws, {
      type: 'error',
      message:
        `The ${label} could not be saved in this workspace. `
        + 'Verify the conversation state before taking another action.',
    });
    return false;
  }


  /**
   * Serve a page of scrollback.
   *
   * The ownership check is the important part: session ids are guessable enough
   * that without it any signed-in user could page through another user's
   * terminal history, which is exactly the content this app exists to protect.
   */

  // ----------------------------------------------------------------- chat mode

  /**
   * Which model a *new* conversation on this runtime would open on, and why.
   *
   * Three layers, in this order: the account's own standing choice, a model
   * typed into the active profile, then that profile's ladder rung. The personal
   * one wins because a per-conversation override has always outranked the
   * profile (see the launch below), so a profile was never a pin an installer
   * could stop a user escaping — and because the only ordering under which the
   * picker's "Use the default for this runtime" entry does anything is one where
   * the thing it clears is above the profile.
   *
   * The rung sits *below* the typed model, which #171 asks for in as many
   * words: a ladder is what answers when nobody typed anything. Both of the
   * layers above it are reported by name so the dialog can say which one is
   * overriding a ladder somebody configured and cannot see working.
   *
   * Re-normalised on the way out. What comes back is a database row, and a
   * hand-edited one must not become an argv on every future launch.
   *
   * `profile` is passed in rather than looked up: a launch has already resolved
   * it (through the accessor that writes tier files, which it must), and a join
   * resolves it through the read-only one. Same answer, two different costs.
   */
  protected modelDefaultFor(
    runtime: string | null,
    userId: number,
    profile: ResolvedProfile | null,
  ): ChatModelDefault {
    const stored = runtime ? this.deps.getUserModelDefault?.(userId, runtime) || '' : '';
    const personal = stored ? normaliseModelName(stored) : undefined;
    if (personal) return { model: personal, source: 'personal' };
    if (profile?.model) {
      return { model: profile.model, source: 'profile', profileName: profile.profileName };
    }
    if (profile?.ladder) {
      return {
        model: profile.ladder.model,
        source: 'ladder',
        profileName: profile.profileName,
        tier: profile.ladder.tier,
        ...(profile.ladder.requested ? { requestedTier: profile.ladder.requested } : {}),
      };
    }
    return { model: null, source: 'runtime' };
  }


  /**
   * Has this conversation ever actually been a conversation?
   *
   * `sessionStartTime` alone is not the test, and getting that wrong is a real
   * failure rather than a nicety: the terminal launch path sets it too, so a
   * session whose first run was a shell command would have its first *chat*
   * treated as a continuation and silently skip the account's default. The
   * surface is what says which kind of run it was, and it is only ever set to
   * 'chat' by the launch below.
   *
   * Both halves are needed. A chat launch that failed leaves the surface on
   * 'chat' with no start time behind it — the retry is still this
   * conversation's first, and must still take the user's default.
   */
  protected hasNeverChatted(session: SessionRecord): boolean {
    return session.surface !== 'chat' || !session.sessionStartTime;
  }


  /**
   * Remember, or forget, this account's standing model for a runtime.
   *
   * Only from a name the runtime is known to take. A model is free text —
   * nothing here can pre-judge one, and that is deliberate — but the cost of a
   * typo is different once the name outlives the conversation it was typed in:
   * an override lasts until the next pick, a standing default becomes
   * `--model <typo>` on every new chat for that runtime until somebody finds
   * the entry that clears it. So the evidence has to be positive: either the
   * adapter took the switch live, or the name is on the list the session
   * published. A runtime that published no list at all is recorded from — there
   * is nothing to check against, exactly as the effort handler treats a runtime
   * that published no ladder, and claude publishes no model list at all.
   *
   * The clear is unconditional: forgetting takes no evidence.
   */
  protected async rememberUserModel(
    session: SessionRecord,
    model: string | undefined,
    appliedLive: boolean,
  ): Promise<void> {
    const write = this.deps.setUserModelDefault;
    const runtime = session.agent || session.lastAgent;
    if (!write || !runtime) return;

    if (!model) {
      // Clearing an override in one chat also drops the standing default, which
      // is what makes "Use the default for this runtime" mean what it says: the
      // conversation, and every new one after it, falls back to the profile and
      // then to the runtime's own default. Nothing else in the app can undo a
      // standing choice, so this entry has to be able to.
      write(session.ownerUserId, runtime, null);
      return;
    }

    if (!appliedLive) {
      const published = (await this.deps.chatManager?.snapshot(session).catch(() => null)) as
        | { capabilities?: { models?: { value: string; name: string }[] } }
        | null;
      const listed = published?.capabilities?.models;
      if (listed?.length && !listed.some((m) => m.value === model || m.name === model)) return;
    }

    write(session.ownerUserId, runtime, model);
  }

}
