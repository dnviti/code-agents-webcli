import { ChatEvent } from '../../shared/chat-events.js';
import { AttachmentSessionRef, AttachmentStoreLike, storedAttachmentNameFromUrl } from '../services/attachment-store.js';
import { SessionTeardownContext } from '../services/session-teardown.js';
import { SessionRecord } from '../types.js';
import { announceSessionClosed } from '../websocket/handler.js';
import { SessionRoutesDeps, SessionRouteCoordination, coordinationFor, ProjectBranchAttachmentStoreLike } from './sessions-common.js';

/**
 * Clone every workspace attachment named by carried events and rewrite its URL
 * to the new immutable session namespace.
 *
 * `attachment` blocks are always expected to name app-owned bytes. Older chat
 * logs represented uploaded images as `image` blocks, so those are copied when
 * (and only when) their URL has the exact canonical source-session shape.
 * Runtime-emitted images with data/external URLs remain ordinary carried
 * history. Duplicate references are copied once and all rewritten to the same
 * target URL.
 */
export async function cloneBranchAttachmentEvents(
  source: AttachmentSessionRef,
  target: AttachmentSessionRef,
  events: ChatEvent[],
  attachmentStore?: AttachmentStoreLike & Partial<ProjectBranchAttachmentStoreLike>,
  onClone?: () => void,
  projectWorkspaceRoot?: string,
): Promise<ChatEvent[]> {
  const clones = new Map<string, Awaited<ReturnType<AttachmentStoreLike['cloneForBranch']>>>();
  const rewritten: ChatEvent[] = [];

  for (const event of events) {
    if (event.t !== 'block_start') {
      rewritten.push(event);
      continue;
    }
    const block = event.block;
    const storedImage = block.kind === 'image'
      && storedAttachmentNameFromUrl(block.url, source.id) !== null;
    if (block.kind !== 'attachment' && !storedImage) {
      rewritten.push(event);
      continue;
    }
    if (!attachmentStore) {
      throw new Error('Branch attachment storage is unavailable');
    }

    const requested = block.kind === 'attachment'
      ? { url: block.url, mime: block.mime, name: block.name, size: block.size }
      : { url: block.url, mime: block.mime, name: block.alt || 'attachment', size: 0 };
    let cloned = clones.get(block.url);
    if (!cloned) {
      if (projectWorkspaceRoot) {
        if (
          !source.projectId
          || source.projectId !== target.projectId
          || !attachmentStore.cloneForBranchInProjectWorkspace
        ) {
          throw new Error('Project branch attachment storage is unavailable');
        }
        cloned = await attachmentStore.cloneForBranchInProjectWorkspace(
          source,
          target,
          requested,
          projectWorkspaceRoot,
        );
      } else {
        cloned = await attachmentStore.cloneForBranch(source, target, requested);
      }
      clones.set(block.url, cloned);
      onClone?.();
    }

    rewritten.push({
      ...event,
      block: block.kind === 'attachment'
        ? {
            kind: 'attachment',
            url: cloned.url,
            mime: cloned.mime,
            name: cloned.name,
            size: cloned.size,
          }
        : {
            ...block,
            url: cloned.url,
            mime: cloned.mime,
            alt: block.alt || cloned.name,
          },
    });
  }
  return rewritten;
}

export function attachmentSessionRef(session: SessionRecord): AttachmentSessionRef {
  return {
    id: session.id,
    ownerUserId: session.ownerUserId,
    workingDir: session.workingDir,
    projectId: session.projectId,
    projectWorkingDirKind: session.projectWorkingDirKind,
    storageScope: session.storageScope,
  };
}

interface RollbackCleanupFailure {
  artifact: string;
  error: unknown;
}

/**
 * Retry-safe cleanup while the recovery row remains authoritative.
 * Descriptor-backed core stores finish before the teardown registry closes its
 * workspace directory lease; every owner still runs when an earlier one fails.
 */
export async function cleanupRollbackArtifacts(
  deps: SessionRoutesDeps,
  session: SessionRecord,
  context: SessionTeardownContext,
  includeHistory = false,
): Promise<RollbackCleanupFailure[]> {
  const failures: RollbackCleanupFailure[] = [];
  const clean = async (artifact: string, operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push({ artifact, error });
    }
  };

  await clean('transcript', () => deps.transcriptStore.deleteTranscript(session));
  if (includeHistory) await clean('history', () => deps.historyStore.deleteHistory(session));
  if (deps.sessionTeardown) {
    if (deps.sessionTeardown.disposeStrict) {
      try {
        const result = await deps.sessionTeardown.disposeStrict(session, context);
        for (const failure of result.failures) {
          failures.push({ artifact: `session:${failure.name}`, error: failure.error });
        }
      } catch (error) {
        failures.push({ artifact: 'session', error });
      }
    } else {
      await clean('session', () => Promise.resolve(deps.sessionTeardown!.dispose(session, context)));
    }
  } else {
    if (deps.chatStore?.deleteChat) {
      await clean('chat', () => deps.chatStore!.deleteChat!(session));
    }
    if (deps.attachmentStore) {
      await clean('attachments', () => deps.attachmentStore!.deleteSessionAttachments(
        attachmentSessionRef(session),
        { projectLifecycleExclusive: context.projectLifecycleExclusive },
      ));
    }
  }
  return failures;
}

/** Restore staged deletions at their exact Map positions after a refused save. */
function restoreSessionMapOrder(
  sessions: Map<string, SessionRecord>,
  removed: SessionRecord[],
  originalIds: string[],
): void {
  const current = new Map(sessions);
  const staged = new Map(removed.map((session) => [session.id, session]));
  sessions.clear();

  for (const id of originalIds) {
    const session = current.get(id) ?? staged.get(id);
    if (session) sessions.set(id, session);
    current.delete(id);
    staged.delete(id);
  }
  // Preserve mutations from other accounts that legitimately completed while
  // this user's persistence was in flight.
  for (const [id, session] of current) sessions.set(id, session);
  for (const [id, session] of staged) sessions.set(id, session);
}

/** Record one child create from owner validation through persistence/rollback. */
export function trackOwnedSessionCreate(
  coordination: SessionRouteCoordination,
  ownerSessionId: string,
): () => void {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let pending = coordination.pendingOwnedCreates.get(ownerSessionId);
  if (!pending) {
    pending = new Set();
    coordination.pendingOwnedCreates.set(ownerSessionId, pending);
  }
  pending.add(completion);

  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    pending!.delete(completion);
    if (pending!.size === 0) coordination.pendingOwnedCreates.delete(ownerSessionId);
    resolveCompletion();
  };
}

/** Record one independent branch while its project retirement gate is open. */
export function trackProjectSessionCreate(
  coordination: SessionRouteCoordination,
  projectId: string,
): () => void {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let pending = coordination.pendingProjectCreates.get(projectId);
  if (!pending) {
    pending = new Set();
    coordination.pendingProjectCreates.set(projectId, pending);
  }
  pending.add(completion);

  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    pending!.delete(completion);
    if (pending!.size === 0) coordination.pendingProjectCreates.delete(projectId);
    resolveCompletion();
  };
}

/** Wait until every branch admitted before project retirement has settled. */
async function drainProjectSessionCreates(
  coordination: SessionRouteCoordination,
  projectId: string,
): Promise<void> {
  for (;;) {
    const pending = [...(coordination.pendingProjectCreates.get(projectId) || [])];
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

/** Await every create that was admitted before these owners began retiring. */
async function drainOwnedSessionCreates(
  coordination: SessionRouteCoordination,
  ownerSessionIds: Set<string>,
): Promise<void> {
  for (;;) {
    const pending = new Set<Promise<void>>();
    for (const ownerSessionId of ownerSessionIds) {
      for (const completion of coordination.pendingOwnedCreates.get(ownerSessionId) || []) {
        pending.add(completion);
      }
    }
    if (pending.size === 0) return;
    await Promise.all(pending);
  }
}

/**
 * Close admission, drain it, then follow owner links to a fixed point.
 *
 * The loop matters for future child surfaces that may themselves own a child:
 * each newly found record is marked before its own in-flight creates are
 * drained, so no generation can materialise behind the scan.
 */
async function collectRetiringSessionTree(
  deps: SessionRoutesDeps,
  roots: SessionRecord[],
): Promise<Set<string>> {
  const coordination = coordinationFor(deps);
  const ids = new Set<string>();
  for (const root of roots) {
    root.retiring = true;
    ids.add(root.id);
  }

  for (;;) {
    await drainOwnedSessionCreates(coordination, ids);
    let changed = false;
    for (const session of deps.claudeSessions.values()) {
      if (!session.ownerSessionId || !ids.has(session.ownerSessionId) || ids.has(session.id)) {
        continue;
      }
      session.retiring = true;
      ids.add(session.id);
      changed = true;
    }
    if (!changed) return ids;
  }
}

/**
 * Stop every live runtime attached to a project while retaining its session
 * records and transcripts. Admission is closed before any await, then socket
 * claims are detached only after every runtime has been verified as stopped.
 */
export async function suspendProjectSessions(
  deps: SessionRoutesDeps,
  projectId: string,
): Promise<string[]> {
  const roots = Array.from(deps.claudeSessions.values())
    .filter((session) => session.projectId === projectId);
  for (const session of roots) session.retiring = true;
  const ids = await collectRetiringSessionTree(deps, roots);
  const sessions = Array.from(deps.claudeSessions.values())
    .filter((session) => ids.has(session.id));

  try {
    for (const session of sessions) {
      if (deps.stopSessionRuntime) {
        await deps.stopSessionRuntime(session);
      } else if (session.active && session.agent) {
        if (session.surface === 'chat') {
          throw new Error('Cannot stop an active chat session without a chat stop hook');
        }
        const bridge = deps.getRuntimeBridge(session.agent);
        if (!bridge) throw new Error(`Cannot stop runtime ${session.agent}`);
        await bridge.stopSession(session.id);
        session.active = false;
        session.agent = null;
      }
    }

    for (const session of sessions) {
      deps.releaseProjectSessionResources?.(session.id);
      session.connections.clear();
    }
    const saved = (await deps.saveSessionsToDisk()) !== false;
    if (!saved) throw new Error('The stopped project sessions could not be saved');
    return sessions.map((session) => session.id);
  } finally {
    for (const session of sessions) session.retiring = false;
  }
}

/** One user delete cascade, shared by concurrent requests for the same root. */
export function retireSessionTree(
  deps: SessionRoutesDeps,
  root: SessionRecord,
  acquireTabMutation: () => Promise<() => void>,
): Promise<boolean> {
  const coordination = coordinationFor(deps);
  const existing = coordination.retiringTrees.get(root);
  if (existing) return existing;

  // This assignment is deliberately before the async collector's first yield:
  // a create arriving immediately after DELETE cannot pass owner validation.
  root.retiring = true;
  const retirement = (async (): Promise<boolean> => {
    const ids = await collectRetiringSessionTree(deps, [root]);
    const release = await acquireTabMutation();
    try {
      const originalIds = Array.from(deps.claudeSessions.keys());
      const descendants = Array.from(deps.claudeSessions.values())
        .filter((session) => session !== root && ids.has(session.id));
      const removed = [...descendants, root];
      for (const session of removed) deps.claudeSessions.delete(session.id);

      let saved = false;
      try {
        saved = (await deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error('Failed to persist session deletion:', error);
      }
      if (!saved) {
        restoreSessionMapOrder(deps.claudeSessions, removed, originalIds);
        for (const session of removed) session.retiring = false;
        return false;
      }

      // Persistence is the irreversible boundary. Only after SQLite accepts
      // the removal may runtimes, logs and client-visible membership be torn
      // down; a refused save restores the exact Map order above.
      for (const session of descendants) await destroySessionOnce(deps, session);
      await destroySessionOnce(deps, root);
      return true;
    } finally {
      release();
    }
  })();
  coordination.retiringTrees.set(root, retirement);
  void retirement.then(
    () => coordination.retiringTrees.delete(root),
    () => coordination.retiringTrees.delete(root),
  );
  return retirement;
}

/** Share physical teardown when a child delete and a parent/project cascade meet. */
function destroySessionOnce(
  deps: SessionRoutesDeps,
  session: SessionRecord,
  context?: SessionTeardownContext,
): Promise<void> {
  const coordination = coordinationFor(deps);
  const existing = coordination.destroyedSessions.get(session);
  if (existing) return existing;

  const destruction = destroySession(deps, session, context);
  coordination.destroyedSessions.set(session, destruction);
  // A failed stop must remain retryable. Successful promises stay associated
  // with the record object so a stale concurrent cascade cannot tear it down a
  // second time after another request removed it from the map.
  void destruction.catch(() => {
    if (coordination.destroyedSessions.get(session) === destruction) {
      coordination.destroyedSessions.delete(session);
    }
  });
  return destruction;
}

/**
 * Retire every session a deleted project owns, including shells whose only
 * link is their owning project conversation. The project manager calls this
 * before it destroys the project row; clearing `projectId` would turn a stale
 * tab into a legacy-host session on its next launch.
 */
export async function retireProjectSessions(
  deps: SessionRoutesDeps,
  projectId: string,
): Promise<string[]> {
  const coordination = coordinationFor(deps);
  coordination.retiringProjects.add(projectId);
  try {
    let roots = Array.from(deps.claudeSessions.values())
      .filter((session) => session.projectId === projectId);
    // Close admission synchronously, then drain branches which registered
    // before that close. A branch is an independent root rather than an owned
    // shell, so the project set must be rescanned after the drain.
    for (const session of roots) session.retiring = true;
    await drainProjectSessionCreates(coordination, projectId);
    roots = Array.from(deps.claudeSessions.values())
      .filter((session) => session.projectId === projectId);
    for (const session of roots) session.retiring = true;

    const recoveryAnchors = roots.filter((entry) => entry.rollbackRecoveryPending);
    const blockedRecovery = recoveryAnchors.find((entry) => entry.persistenceUnavailable);
    if (blockedRecovery) {
      for (const root of roots) root.retiring = false;
      throw new Error(
        `Project rollback recovery ${blockedRecovery.id} is unavailable: ${blockedRecovery.persistenceUnavailable}`,
      );
    }
    if (recoveryAnchors.length > 0) {
      let anchorsConfirmed = false;
      try {
        anchorsConfirmed = (await deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error(`Failed to confirm project rollback recovery for ${projectId}:`, error);
      }
      if (!anchorsConfirmed) {
        for (const root of roots) root.retiring = false;
        throw new Error('Project rollback recovery rows could not be saved before cleanup');
      }
    }

    // Recovery anchors keep their row as authority until cleanup succeeds.
    // Project removal already owns the lifecycle gate, so retry them here with
    // the exclusive context before the shared snapshot can delete any row.
    for (const session of recoveryAnchors) {
      const failures = await cleanupRollbackArtifacts(
        deps,
        session,
        { projectLifecycleExclusive: true },
        true,
      );
      if (failures.length > 0) {
        for (const root of roots) root.retiring = false;
        throw new Error(
          `Project rollback recovery ${session.id} is incomplete: ${failures.map((failure) => failure.artifact).join(', ')}`,
        );
      }
    }

    const ids = await collectRetiringSessionTree(deps, roots);
    const sessions = Array.from(deps.claudeSessions.values())
      .filter((session) => ids.has(session.id));
    if (sessions.length === 0) return [];

    // A project cascade can remove several tabs at once. Hold each affected
    // account's tab turn in stable order while the shared session snapshot is
    // staged and persisted.
    const releases: Array<() => void> = [];
    try {
      if (deps.tabCoordinator) {
        const ownerIds = [...new Set(sessions.map((session) => session.ownerUserId))]
          .sort((left, right) => left - right);
        for (const ownerUserId of ownerIds) {
          releases.push(await deps.tabCoordinator.acquire(ownerUserId));
        }
      }

      const originalIds = Array.from(deps.claudeSessions.keys());
      for (const session of sessions) deps.claudeSessions.delete(session.id);
      try {
        const saved = (await deps.saveSessionsToDisk()) !== false;
        if (!saved) throw new Error('The project session deletion could not be saved');
      } catch (error) {
        restoreSessionMapOrder(deps.claudeSessions, sessions, originalIds);
        for (const session of sessions) session.retiring = false;
        throw error;
      }

      for (const session of sessions) {
        if (session.rollbackRecoveryPending) {
          deps.disposeRecorder(session.id);
          announceSessionClosed(session, deps.webSocketConnections);
        } else {
          await destroySessionOnce(deps, session, { projectLifecycleExclusive: true });
        }
      }
    } finally {
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]();
    }
    return sessions.map((session) => session.id);
  } finally {
    coordination.retiringProjects.delete(projectId);
  }
}

/**
 * End one session: await its process, then remove its sockets, record and
 * stored transcript/history. The caller persists once for the whole cascade.
 */
async function destroySession(
  deps: SessionRoutesDeps,
  session: SessionRecord,
  context?: SessionTeardownContext,
): Promise<void> {
  if (deps.stopSessionRuntime) {
    // The unified hook also closes launch admission and drains a start that is
    // still awaiting an environment/adapter while `active` is false. Calling
    // it unconditionally is what prevents deletion from orphaning that launch.
    await deps.stopSessionRuntime(session);
  } else if (session.active && session.agent) {
    // Compatibility for embedders/tests that predate the unified hook. Chat
    // sessions require the hook; a bridge is only a correct fallback for the
    // terminal surface.
    if (session.surface === 'chat') {
      throw new Error('Cannot retire an active chat session without a chat stop hook');
    }
    const bridge = deps.getRuntimeBridge(session.agent);
    if (!bridge) throw new Error(`Cannot stop runtime ${session.agent}`);
    await bridge.stopSession(session.id);
  }

  // Runtime teardown above releases the process lease. Clear every remaining
  // join/subscription lease before the record disappears, otherwise a socket
  // can keep a deleted project permanently protected from lifecycle work.
  deps.releaseProjectSessionResources?.(session.id);

  // Whoever was driving this session is no longer driving anything. Only them:
  // a screen that merely had a tab for it was never attached, and clearing a
  // field it does not hold would tell it to let go of the session it *is* on.
  session.connections.forEach((wsId) => {
    const wsInfo = deps.webSocketConnections.get(wsId);
    if (wsInfo) wsInfo.claudeSessionId = null;
  });

  // The news itself goes to every screen this user has open. It used to go down
  // `connections`, which is the set above — so a second device holding the tab
  // but looking elsewhere was never told, and went on offering a session that
  // had ceased to exist.
  announceSessionClosed(session, deps.webSocketConnections);

  session.connections.clear();
  deps.claudeSessions.delete(session.id);
  // Without this the headless emulator for a deleted session would live for
  // as long as the process does.
  deps.disposeRecorder(session.id);
  await Promise.all([
    deps.transcriptStore.deleteTranscript(session),
    deps.historyStore.deleteHistory(session),
  ]);
  // Subsystems that registered their own cleanup (pasted images, and
  // whatever comes next) rather than each appending a line here.
  await deps.sessionTeardown?.dispose(session, context);
}
