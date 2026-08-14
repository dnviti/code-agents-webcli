import path from 'node:path';
import { SessionRecord, WebSocketInfo } from '../types.js';
import { sendToWebSocket } from './handler.js';
import { draftOf } from '../chat/drafts.js';
import { HeldProjectSessionLease, ladderOf } from './messages-shared.js';
import { MessageProcessorChatBase } from './messages-chat-base.js';
export abstract class MessageProcessorChatSubscriptionBase extends MessageProcessorChatBase {


  /**
   * Start watching a chat session's event stream, and hand over its transcript.
   *
   * The reply is a full `chat_snapshot` rather than "subscribed": a tab that has
   * just been told it may watch has nothing to watch *from*, and asking it to
   * make a second round trip for the transcript would leave a window in which
   * live events arrive for a conversation the client cannot place them in.
   */
  protected async retainChatSubscription(
    wsInfo: WebSocketInfo,
    session: SessionRecord,
  ): Promise<boolean> {
    const existing = this.subscribedProjectLeases.get(wsInfo.id)?.get(session.id);
    if (wsInfo.chatSessionIds.has(session.id) && (!session.projectId || existing)) return true;

    let lease: HeldProjectSessionLease | undefined;
    if (session.projectId) {
      try {
        lease = (await this.environmentForSession(session)).lease;
      } catch (error) {
        wsInfo.chatSessionIds.delete(session.id);
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: error instanceof Error
            ? error.message
            : 'This project is not available right now.',
        });
        return false;
      }
    }

    if (this.deps.webSocketConnections.get(wsInfo.id) !== wsInfo) {
      this.releaseHeldProjectLease(lease);
      return false;
    }

    wsInfo.chatSessionIds.add(session.id);
    if (lease) {
      let bySession = this.subscribedProjectLeases.get(wsInfo.id);
      if (!bySession) {
        bySession = new Map();
        this.subscribedProjectLeases.set(wsInfo.id, bySession);
      }
      bySession.set(session.id, lease);
    }
    return true;
  }


  protected unsubscribeChat(wsInfo: WebSocketInfo, sessionId: string): void {
    wsInfo.chatSessionIds.delete(sessionId);
    this.releaseSubscribedProjectLease(wsInfo.id, sessionId);
  }


  async subscribeChat(wsInfo: WebSocketInfo, sessionId: string): Promise<boolean> {
    const manager = this.deps.chatManager;
    if (!manager || !sessionId) return false;

    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, { type: 'error', message: 'Session not found' });
      return false;
    }
    if (session.surface !== 'chat') return false;
    if (this.rejectUnavailableRead(wsInfo, session)) return false;

    const alreadyRetained = wsInfo.chatSessionIds.has(sessionId)
      && (!session.projectId
        || this.subscribedProjectLeases.get(wsInfo.id)?.has(sessionId) === true);
    if (!(await this.retainChatSubscription(wsInfo, session))) return false;

    try {
      const snapshot = await manager.snapshot(session);
      const runtime = session.agent || session.lastAgent;
      const active = this.deps.activeProfileFor?.(runtime || '') ?? null;
      const modelDefault = this.modelDefaultFor(runtime, session.ownerUserId, active);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_snapshot',
        sessionId,
        snapshot,
        modelOverride: session.chatModelOverride || null,
        // The model this conversation is fixed to, from the record rather than
        // from the process: a reload is exactly the case where the runtime has
        // reported nothing to this browser yet, and it is the case in which the
        // chip used to fall through to a default it was never launched on.
        // `undefined` — a conversation that has not launched since pins existed
        // — goes out as null, so the client reads it as "unsaid" and degrades to
        // the wording that shipped before rather than asserting a model.
        modelPinned: session.chatModelPinned ?? null,
        // Re-sent on every join, because it is the only thing on the wire that
        // can tell the picker why a model is in force. Resolved through the
        // read-only profile accessor — see the dep — since a join must not
        // rewrite a runtime's tier files.
        modelDefault,
        // And where the model this conversation is on came from, which a join
        // has to answer from the record: the process may be gone, and a rung is
        // exactly the kind of provenance no runtime reports about itself.
        //
        // A pin of `null` under a laddered profile is the rung — that is what
        // the launch records for one, so it can be re-read — and the origin has
        // to reach the same conclusion the next launch will, or a reload would
        // rename the model between one screen and the next.
        //
        // The rung comes from the *running* session rather than from the
        // profile, and that distinction is the whole of #135 said again: a
        // conversation that launched bare also carries a null pin, so reading
        // the profile's current rung here would draw the chip as running a model
        // the process is not on. A session that is not running has no rung in
        // force to report, and says nothing rather than guessing one.
        //
        // Which is why the last branch is gated on the conversation being live.
        // A null pin says "launched with no model flag" and nothing more: under
        // a ladder that is what a rung records, so the two are indistinguishable
        // once the process is gone. While it runs they are not — a rung answers
        // through `ladderOf` above and never reaches here — but a stopped
        // laddered conversation would otherwise be announced as running on the
        // runtime's own default, which is a different model from the one it was
        // on and from the one its next launch will use. A conversation whose
        // model was chosen, or which is pinned to one, is still answered for
        // when it is not running: those are facts the record holds outright.
        //
        // The snapshot's own liveness, not `session.active`. They disagree in
        // both directions and the snapshot is the half that agrees with
        // `ladderOf`, since both read the chat session: a process that died
        // through the adapter's error path never reports `exited`, so the
        // record still calls it active, and codex's abandoned handshake probe
        // reports one for a conversation whose fallback is running fine.
        modelOrigin: ladderOf(manager, sessionId, active)
          ?? (session.chatModelOverride
            ? { model: session.chatModelOverride, source: 'override' }
            : session.chatModelPinned
              ? { model: session.chatModelPinned, source: 'override' }
              : session.chatModelPinned === null && snapshot.live
                ? { model: null, source: 'runtime' }
                : null),
        // The same answer the launch gave, for a screen that was not there for
        // it. A conversation that has launched under this server speaks for
        // itself — including when it has nothing to report, which is why this
        // tests for `undefined` rather than falsiness: a clean launch under a
        // profile that has failed to write since must not inherit a failure
        // that was not its own. One that has not launched here falls back to
        // the profile, which is the same answer its next launch would give.
        ladderError:
          session.chatLadderError !== undefined
            ? session.chatLadderError
            : active?.ladderError ?? null,
        // Rides on the join for the same reason the model does: the snapshot
        // carries the runtime's own reported level only if it ever reported one,
        // and a conversation whose process has since died reports nothing at
        // all. The record is the only thing that still knows what was chosen.
        effortOverride: session.chatEffortOverride || null,
        // What is in the composer, so a screen that has just opened this
        // conversation opens it at the sentence the other screen is in the
        // middle of. Null means nothing has been typed since the server came
        // up. Composer contents are persisted in shared app SQLite; the browser
        // deliberately keeps no fallback in Electron userData.
        draft: draftOf(session),
      });
      return true;
    } catch (error: unknown) {
      if (!alreadyRetained) this.unsubscribeChat(wsInfo, sessionId);
      const message = error instanceof Error ? error.message : String(error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Could not load the conversation: ${message}`,
      });
      return false;
    }
  }

}
