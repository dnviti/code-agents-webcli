import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SessionRecord } from '../types.js';
import { announceSessionOpened, sendToWebSocket } from './handler.js';
import { HeldProjectSessionLease } from './messages-shared.js';
import { MessageProcessorRuntimeBase } from './messages-runtime.js';
export abstract class MessageProcessorSessionsBase extends MessageProcessorRuntimeBase {


  async createAndJoinSession(
    wsId: string,
    name?: string,
    workingDir?: string
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    const requestedFromSessionId = wsInfo.claudeSessionId;

    let validWorkingDir = this.userBaseFolder(wsInfo.userId);
    if (workingDir) {
      const validation = this.deps.validatePath(workingDir, wsInfo.userId);
      if (!validation.valid) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    } else {
      const selected = this.deps.getSelectedWorkingDir(wsInfo.userId);
      // A directory chosen before per-user environments were switched on can
      // point outside the user's own home; re-checked here rather than trusted,
      // so enabling the feature cannot leave anyone pointed at the host.
      validWorkingDir = selected && this.deps.validatePath(selected, wsInfo.userId).valid
        ? selected
        : this.userBaseFolder(wsInfo.userId);
    }

    const release = this.deps.tabCoordinator
      ? await this.deps.tabCoordinator.acquire(wsInfo.userId)
      : () => {};
    try {
      try {
        await this.deps.loadWorkspaceSessions?.(wsInfo.userId, validWorkingDir);
      } catch (error) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: `Workspace persistence is unavailable: ${
            error instanceof Error ? error.message : 'unknown storage error'
          }`,
        });
        return;
      }
      // Waiting behind an account write gives this socket time to disconnect or
      // choose a newer destination. A delayed create must not overwrite that
      // newer join (nor create an unattached session for a dead socket).
      const currentInfo = this.deps.webSocketConnections.get(wsId);
      if (currentInfo !== wsInfo || wsInfo.claudeSessionId !== requestedFromSessionId) return;

      const sessionId = randomUUID();
      // Construct inside the account turn: the real factory allocates the
      // append position from the live map, which is now guaranteed committed.
      let session: SessionRecord;
      try {
        session = this.deps.createSessionRecord({
          id: sessionId,
          ownerUserId: wsInfo.userId,
          name,
          workingDir: validWorkingDir,
          storageRoot: validWorkingDir,
        });
      } catch (error) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: `Workspace persistence is unavailable: ${
            error instanceof Error ? error.message : 'unknown storage error'
          }`,
        });
        return;
      }

      try {
        await this.deps.transcriptStore.ensureTranscript(session);
      } catch (error) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: `Workspace persistence is unavailable: ${
            error instanceof Error ? error.message : 'unknown storage error'
          }`,
        });
        return;
      }
      this.deps.claudeSessions.set(sessionId, session);
      let saved = false;
      try {
        saved = (await this.deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error('Failed to persist socket-created session:', error);
      }
      if (!saved) {
        this.deps.claudeSessions.delete(sessionId);
        try {
          await this.deps.transcriptStore.deleteTranscript(session);
        } catch (error) {
          console.error(`Failed to clean transcript for uncommitted session ${sessionId}:`, error);
        }
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'The new session could not be saved',
        });
        return;
      }

      // Persistence itself can be deferred. Recheck once more before attaching:
      // a newer join that won while SQLite was pending must stay the destination.
      const intentStillCurrent =
        this.deps.webSocketConnections.get(wsId) === wsInfo
        && wsInfo.claudeSessionId === requestedFromSessionId;
      if (intentStillCurrent) {
        session.connections.add(wsId);
        wsInfo.claudeSessionId = sessionId;
        sendToWebSocket(wsInfo.ws, {
          type: 'session_created',
          sessionId,
          sessionName: session.name,
          workingDir: session.workingDir,
          projectWorkingDirKind: session.projectWorkingDirKind,
          lastAgent: session.lastAgent,
          runtimeLabel: session.runtimeLabel,
          ...this.projectIdentity(session),
        });
      }

      // And every other screen this person has open. After `session_created`,
      // so the asking socket has switched before the account announcement. If
      // it moved meanwhile, this is deliberately the only message it receives:
      // the new tab still exists account-wide but never steals that newer focus.
      announceSessionOpened(session, this.deps.webSocketConnections);
    } finally {
      release();
    }
  }


  async joinSession(wsId: string, claudeSessionId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.deps.claudeSessions.get(claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      // Named rather than reported as a generic error, because the client can
      // only act on the specific answer. An `error` says nothing about *which*
      // session failed, so the page attributed it to the session it was still
      // on — painting a healthy tab red for a click on a dead one, and leaving
      // the dead tab in the strip to do it again. `session_gone` says which,
      // and the tab goes.
      //
      // The same answer for a session that belongs to somebody else: as far as
      // this user is concerned there is no such session, and saying more would
      // be telling them one exists.
      sendToWebSocket(wsInfo.ws, {
        type: 'session_gone',
        sessionId: claudeSessionId,
        message: 'This session no longer exists.',
      });
      return;
    }
    if (this.rejectUnavailableRead(wsInfo, session)) return;

    let joinedLease: HeldProjectSessionLease | undefined;
    if (session.projectId) {
      try {
        joinedLease = (await this.environmentForSession(session)).lease;
      } catch (error) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: error instanceof Error
            ? error.message
            : 'This project is not available right now.',
        });
        return;
      }
    }
    if (this.deps.webSocketConnections.get(wsId) !== wsInfo) {
      this.releaseHeldProjectLease(joinedLease);
      return;
    }

    // Leave current session if any
    if (wsInfo.claudeSessionId) {
      await this.leaveSession(wsId);
    }
    if (this.deps.webSocketConnections.get(wsId) !== wsInfo) {
      this.releaseHeldProjectLease(joinedLease);
      return;
    }

    // Join new session
    wsInfo.claudeSessionId = claudeSessionId;
    session.connections.add(wsId);
    if (joinedLease) this.joinedProjectLeases.set(wsId, joinedLease);
    session.lastActivity = new Date();
    session.lastAccessed = Date.now();

    try {
      const transcriptChunks = await this.deps.transcriptStore.readTranscriptChunks(session);
      if (this.deps.webSocketConnections.get(wsId) !== wsInfo) {
        throw new Error('WebSocket disconnected while joining the session');
      }
      const replayBuffer =
        transcriptChunks.length > 0 ? transcriptChunks : session.outputBuffer.slice(-200);

      // Tells the client how far back it can page. The replayed tail restores the
      // live terminal; anything above it is fetched a screen at a time.
      const history = await this.deps.historyStore.stat(session).catch(() => ({
        firstLine: 0,
        totalLines: 0,
      }));

      // Joins for one socket can overlap because WebSocket message callbacks are
      // async. If a newer join won while transcript/history reads were awaited,
      // this answer is obsolete: emitting it would paint the old destination and
      // prompt the client to leave the newer one as an "orphan".
      if (wsInfo.claudeSessionId !== claudeSessionId || !session.connections.has(wsId)) return;

      // Send session info and replay buffer
      sendToWebSocket(wsInfo.ws, {
        type: 'session_joined',
        history,
        sessionId: claudeSessionId,
        sessionName: session.name,
        workingDir: session.workingDir,
        projectWorkingDirKind: session.projectWorkingDirKind,
        active: session.active,
        agent: session.agent,
        lastAgent: session.lastAgent,
        runtimeLabel: session.runtimeLabel,
        surface: session.surface || 'terminal',
        outputBuffer: replayBuffer,
        ...this.projectIdentity(session),
      });

      // A chat session's transcript is not in the PTY replay above — it is a
      // separate event log — so it is sent as its own snapshot. Sent after
      // session_joined so the client has already switched surfaces and has
      // somewhere to put it. Subscribing here as well as sending the snapshot is
      // what keeps the conversation live once the user moves to another tab.
      if (session.surface === 'chat' && !(await this.subscribeChat(wsInfo, claudeSessionId))) {
        throw new Error('Could not subscribe to the conversation');
      }

      if (this.deps.dev) {
        console.log(`WebSocket ${wsId} joined Claude session ${claudeSessionId}`);
      }
    } catch (error) {
      // Admission is ownership, not a best-effort side effect. If replay or the
      // chat snapshot fails, roll back every mutation made for this join.
      session.connections.delete(wsId);
      if (wsInfo.claudeSessionId === claudeSessionId) wsInfo.claudeSessionId = null;
      this.releaseJoinedProjectLease(wsId);
      throw error;
    }
  }


  async leaveSession(wsId: string, expectedSessionId?: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;
    // A client rejecting a late join names the obsolete destination. If the
    // socket has already joined something newer, that cleanup must not detach
    // the winner.
    if (expectedSessionId && wsInfo.claudeSessionId !== expectedSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session) {
      session.connections.delete(wsId);
      session.lastActivity = new Date();
    }

    this.releaseJoinedProjectLease(wsId);
    wsInfo.claudeSessionId = null;

    sendToWebSocket(wsInfo.ws, {
      type: 'session_left',
    });
  }


  /**
   * Drop every non-runtime claim owned by one socket. Called by both WebSocket
   * `close` and `error`; deleting maps before release makes the double callback
   * idempotent.
   */
  cleanupConnection(wsId: string): void {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) {
      this.releaseJoinedProjectLease(wsId);
      const orphaned = this.subscribedProjectLeases.get(wsId);
      if (orphaned) {
        for (const sessionId of Array.from(orphaned.keys())) {
          this.releaseSubscribedProjectLease(wsId, sessionId);
        }
      }
      return;
    }

    for (const sessionId of Array.from(wsInfo.chatSessionIds)) {
      this.unsubscribeChat(wsInfo, sessionId);
    }
    if (wsInfo.claudeSessionId) {
      const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
      if (session) {
        session.connections.delete(wsId);
        session.lastActivity = new Date();
      }
    }
    this.releaseJoinedProjectLease(wsId);
    this.deps.webSocketConnections.delete(wsId);
  }


  /** Release every process/attachment claim associated with a retiring record. */
  releaseProjectSessionResources(sessionId: string): void {
    this.releaseRuntimeProjectLease(sessionId);

    for (const [wsId, lease] of Array.from(this.joinedProjectLeases)) {
      if (lease.sessionId !== sessionId) continue;
      this.releaseJoinedProjectLease(wsId);
      const wsInfo = this.deps.webSocketConnections.get(wsId);
      if (wsInfo?.claudeSessionId === sessionId) wsInfo.claudeSessionId = null;
    }
    for (const [wsId, bySession] of Array.from(this.subscribedProjectLeases)) {
      if (!bySession.has(sessionId)) continue;
      this.releaseSubscribedProjectLease(wsId, sessionId);
      this.deps.webSocketConnections.get(wsId)?.chatSessionIds.delete(sessionId);
    }

    // Defensive cleanup for sockets restored/constructed without a lease map.
    for (const wsInfo of this.deps.webSocketConnections.values()) {
      if (wsInfo.claudeSessionId === sessionId) wsInfo.claudeSessionId = null;
      wsInfo.chatSessionIds.delete(sessionId);
    }
  }


  /**
   * Mirror chat-process lifecycle into the project admission layer.
   *
   * Terminal exits arrive through the bridge callbacks above. Chat exits are
   * learned by ChatSessionManager in the composition root, which must call this
   * hook whenever `change.exited` is present. A `/clear` marks its old adapter
   * as a restarting exit, so the existing claim spans the replacement launch.
   */
  handleChatLifecycle(
    sessionId: string,
    change: { exited?: boolean; restarting?: boolean },
  ): void {
    if (change.exited === undefined) return;
    const session = this.deps.claudeSessions.get(sessionId);
    if (change.exited) {
      if (change.restarting === true) {
        // The old adapter is gone, but its replacement is already committed to
        // start inside ChatSession.restart(). Keep the same admission across
        // that hand-off so stop/reclaim never sees an unprotected gap.
        return;
      }
      this.releaseRuntimeProjectLease(sessionId);
      return;
    }
    if (!session?.projectId) return;
    if (this.runtimeProjectLeases.has(sessionId)) {
      return;
    }

    // Every legitimate chat start acquires before spawning, and a restart
    // retains that same lease above. Reaching a live process without one is an
    // invariant failure: do not leave it running while an asynchronous
    // re-admission races project stop/reclaim. The in-memory active flag keeps
    // lifecycle claims closed until verified stop completes.
    console.error(`Chat ${sessionId} became live without a project runtime lease; stopping it`);
    session.active = true;
    session.agent ||= session.lastAgent || 'claude';
    this.persistActive(session, true);
    const stop = this.deps.chatManager?.stop(sessionId);
    if (!stop) {
      console.error(`Chat ${sessionId} cannot be stopped: chat manager unavailable`);
      return;
    }
    void stop.then(() => {
      const current = this.deps.claudeSessions.get(sessionId);
      if (!current) return;
      current.active = false;
      current.agent = null;
      current.lastActivity = new Date();
      this.persistActive(current, false);
      this.noteStopped(current);
    }).catch((error: unknown) => {
      // The manager deliberately retains its adapter on rejection. Preserve
      // the active record too so reclaim/delete remain closed and an explicit
      // stop can retry the same identity-bound handle.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Could not verify that lease-less chat ${sessionId} stopped: ${detail}`);
    });
  }


  /** Included by ProjectManager.hasLiveProjectWork during pre-lease launch admission. */
  hasPendingProjectWork(projectId: string): boolean {
    for (const sessionId of this.runtimeStarts) {
      if (this.deps.claudeSessions.get(sessionId)?.projectId === projectId) return true;
    }
    return false;
  }


  /**
   * Close launch admission before a session record is deleted, drain anything
   * already admitted, then stop the process it produced. If verification
   * fails this rejects, leaving the record and every project lease intact.
   */
  async retireSessionRuntime(session: SessionRecord): Promise<void> {
    if (this.deps.claudeSessions.get(session.id) !== session) return;
    session.retiring = true;
    await this.drainRuntimeStart(session.id);
    if (this.deps.claudeSessions.get(session.id) !== session) return;
    const chatOwned = session.surface === 'chat'
      && this.deps.chatManager?.has(session.id) === true;
    if ((session.active && session.agent) || chatOwned) {
      await this.stopRuntime(
        session.id,
        session.agent || session.lastAgent || 'claude',
      );
    }
  }


  /** Wait until every launch already admitted by a WebSocket has settled. */
  async drainPendingRuntimeStarts(): Promise<void> {
    while (this.runtimeStartDrains.size > 0) {
      await Promise.all(Array.from(this.runtimeStartDrains.values(), (entry) => entry.promise));
    }
  }

}
