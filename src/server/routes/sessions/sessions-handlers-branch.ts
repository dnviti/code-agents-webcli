import { projectName } from '../../../shared/conversations.js';
import { planBranch, tooLargeMessage } from '../../chat/branch.js';
import { ChatSessionRef } from '../../chat/store.js';
import { SessionRecord } from '../../types.js';
import { announceSessionOpened } from '../../websocket/handler.js';
import { getOwnedSession, requireUser } from '../helpers.js';
import { nextAccountTabOrder } from './sessions-account.js';
import { SessionRoutesDeps, coordinationFor } from './sessions-common.js';
import { rejectUnavailablePersistence, branchName } from './sessions-shared.js';
import { trackOwnedSessionCreate, trackProjectSessionCreate, cleanupRollbackArtifacts, cloneBranchAttachmentEvents, attachmentSessionRef } from './sessions-teardown.js';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Start a new conversation from a turn of this one.
 *
 * The new conversation gets the history up to and including that turn in its
 * own log — so it is there to read — and the same history waiting as the
 * opening context of its first turn, so the agent it is handed to knows what
 * came before rather than reading over the user's shoulder. See chat/branch.ts
 * for what is actually sent and why it is a rendition.
 *
 * The conversation branched from is not touched. Not one event: the cut is a
 * read, and everything written lands in the record created here.
 *
 * A branch that will not fit the model's window is refused with the figures
 * rather than trimmed to size, and a conversation whose runtime never
 * reported a window is branched with the check skipped and *said* to have
 * been — the alternative is measuring against a ceiling nobody stated, which
 * is the wrong ceiling this app declines to invent everywhere else.
 */

export async function handleBranch(
  deps: SessionRoutesDeps,
  acquireTabMutation: (userId: number) => Promise<() => void>,
  req: Request,
  res: Response,
): Promise<void> {
const user = requireUser(res);
if (!user) {
  res.status(401).json({ error: 'authentication_required' });
  return;
}

const source = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
if (!source || source.surface !== 'chat') {
  res.status(404).json({ error: 'unknown_conversation', message: 'That conversation does not exist' });
  return;
}
if (rejectUnavailablePersistence(res, source)) return;

const turnId = typeof req.body?.turnId === 'string' ? req.body.turnId.trim() : '';
if (!turnId) {
  res.status(400).json({ error: 'invalid_turn', message: 'No turn was named' });
  return;
}

const store = deps.chatStore;
if (!store?.turnCut || !store.append || !store.setOpeningContext || !store.deleteChat) {
  res.status(501).json({
    error: 'branching_unavailable',
    message: 'This server cannot branch conversations',
  });
  return;
}
const turnCut = store.turnCut.bind(store);
const appendBranchChat = store.append.bind(store);
const setBranchOpeningContext = store.setOpeningContext.bind(store);

const branchCoordination = coordinationFor(deps);
if (
  source.retiring
  || (source.projectId && branchCoordination.retiringProjects.has(source.projectId))
) {
  res.status(409).json({
    error: 'source_session_retiring',
    message: 'That conversation is being deleted',
  });
  return;
}

const executeBranch = async (projectWorkspaceRoot?: string): Promise<void> => {
  // A project branch reaches here only after acquiring its no-start
  // lifecycle gate. Register the session/project create gates after that
  // admission, otherwise a deletion which already owns the lifecycle gate
  // could wait on a branch that is itself waiting behind the deletion.
  const currentSource = deps.claudeSessions.get(source.id);
  if (
    currentSource !== source
    || currentSource.ownerUserId !== user.id
    || currentSource.surface !== 'chat'
    || currentSource.retiring
    || (source.projectId && branchCoordination.retiringProjects.has(source.projectId))
  ) {
    res.status(409).json({
      error: 'source_session_retiring',
      message: 'That conversation is being deleted',
    });
    return;
  }

  const completeSourceBranchCreate = trackOwnedSessionCreate(branchCoordination, source.id);
  const completeProjectBranchCreate = source.projectId
    ? trackProjectSessionCreate(branchCoordination, source.projectId)
    : undefined;

  try {

let pendingBranch: SessionRecord | null = null;
let accountMutationHeld = false;
let rollbackStarted = false;
let rollbackAmbiguous = false;
let rollbackAmbiguousBranchId: string | null = null;
let rollbackRecoveryDurable: boolean | undefined;
const rollbackPendingBranch = async (): Promise<void> => {
  const branch = pendingBranch;
  if (!branch || rollbackStarted) return;
  rollbackStarted = true;

  // Never remove a record another operation installed under the same id.
  // UUID collisions are fantastically unlikely, but cleanup must still be
  // exact rather than relying on that likelihood.
  const occupant = deps.claudeSessions.get(branch.id);
  if (occupant && occupant !== branch) {
    // A collision means the target namespace may now contain another live
    // session's artefacts. Preserve everything rather than deleting by id.
    console.error(`Refusing ambiguous rollback for colliding branch ${branch.id}`);
    rollbackAmbiguous = true;
    rollbackAmbiguousBranchId = branch.id;
    pendingBranch = null;
    return;
  }
  // A recovery row is the crash-safe authority for every later filesystem
  // mutation. For failures before the branch's ordinary commit, acquire the
  // same account turn used by tab mutations; failures during commit already
  // call rollback while holding it.
  const releaseRecoveryMutation = accountMutationHeld
    ? undefined
    : await acquireTabMutation(user.id);
  try {
    const recoveryOccupant = deps.claudeSessions.get(branch.id);
    if (recoveryOccupant && recoveryOccupant !== branch) {
      rollbackAmbiguous = true;
      rollbackAmbiguousBranchId = branch.id;
      rollbackRecoveryDurable = false;
      pendingBranch = null;
      return;
    }
    if (branch.tabOrder === undefined) {
      branch.tabOrder = nextAccountTabOrder(deps.claudeSessions, user.id);
    }
    branch.tabOpen = false;
    branch.rollbackRecoveryPending = true;
    deps.claudeSessions.set(branch.id, branch);

    let anchorSaved = false;
    try {
      anchorSaved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error(`Failed to persist rollback anchor for branch ${branch.id}:`, error);
    }
    if (!anchorSaved) {
      // Without a confirmed workspace-local anchor no destructive cleanup
      // may begin. All branch artifacts remain intact and the response says
      // explicitly that recovery durability is not yet confirmed.
      rollbackAmbiguous = true;
      rollbackAmbiguousBranchId = branch.id;
      rollbackRecoveryDurable = false;
      pendingBranch = null;
      return;
    }
    rollbackRecoveryDurable = true;

    const cleanupFailures = await cleanupRollbackArtifacts(deps, branch, {
      projectLifecycleExclusive: Boolean(projectWorkspaceRoot),
    });
    for (const failure of cleanupFailures) {
      console.error(
        `Failed to remove ${failure.artifact} artifacts for branch ${branch.id}:`,
        failure.error,
      );
    }
    if (cleanupFailures.length > 0) {
      rollbackAmbiguous = true;
      rollbackAmbiguousBranchId = branch.id;
      pendingBranch = null;
      return;
    }

    // Cleanup is complete, but the flagged anchor remains authoritative
    // until its removal is confirmed. If this save fails, restore the exact
    // record; boot will reload the flag and DELETE can retry idempotently.
    if (deps.claudeSessions.get(branch.id) === branch) {
      deps.claudeSessions.delete(branch.id);
    }
    let removalSaved = false;
    try {
      removalSaved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error(`Failed to remove rollback anchor for branch ${branch.id}:`, error);
    }
    if (!removalSaved) {
      deps.claudeSessions.set(branch.id, branch);
      rollbackAmbiguous = true;
      rollbackAmbiguousBranchId = branch.id;
    } else {
      rollbackRecoveryDurable = undefined;
    }
    pendingBranch = null;
  } finally {
    releaseRecoveryMutation?.();
  }
};

try {
  const cut = await turnCut(source, turnId);
  if (!cut) {
    res.status(404).json({
      error: 'unknown_turn',
      message: 'That turn is no longer in this conversation',
    });
    return;
  }

  const plan = planBranch(cut);
  if (!plan.fits) {
    // 413 rather than 400: the request was perfectly well formed and the
    // thing it asked for is too big, which is the one distinction that
    // tells a caller retrying with an earlier turn would help.
    res.status(413).json({
      error: 'context_too_large',
      message: tooLargeMessage(plan, cut.turn.index),
      estimatedTokens: plan.estimatedTokens,
      contextWindow: plan.contextWindow,
      budgetTokens: plan.budgetTokens,
    });
    return;
  }

  const sessionId = randomUUID();
  const branch = deps.createSessionRecord({
    id: sessionId,
    ownerUserId: user.id,
    name: branchName(source, cut.turn.index),
    workingDir: source.workingDir,
    // A branch is a continuation in the same checkout. Losing this would
    // make its next launch silently fall back to the user's environment.
    projectId: source.projectId,
    projectWorkingDirKind: source.projectWorkingDirKind,
    storageRoot: source.storageScope?.workspaceRoot || source.workingDir,
  });
  // The conversation this one came from, running the same agent in the same
  // place. Not `agent`, which says a process is up: nothing is running here
  // until the browser launches it.
  branch.surface = 'chat';
  branch.lastAgent = source.lastAgent;
  branch.runtimeLabel = source.runtimeLabel;
  // The model and the effort level travel with it, because they are how
  // this line of work was being done and the branch is a continuation of
  // it — and because the window the history was just measured against is
  // that model's. The bypass flag deliberately does not, and now the reason
  // is complete: a branch is a conversation that is *beginning*, so it takes
  // the owner's preference at launch like every other beginning (#134).
  // Copying the source's grant would instead let one old answer spread from
  // conversation to conversation, outliving the preference that produced it.
  branch.chatModelOverride = source.chatModelOverride;
  // A source with no override of its own still has to arrive fixed, not
  // blank: a blank branch is a conversation that has never chatted, so its
  // launch would take the brancher's *standing* model (#135) — a different
  // model from the one the history above was just measured against, which
  // is the one thing this route is not allowed to get wrong.
  //
  // What the source is fixed to, not what any default now says. The pin the
  // source's own launch left is the only record of which model it actually
  // ran, and it already accounts for every layer that decided it — a
  // standing choice, a profile, or nothing at all. Asking the profile again
  // here would answer a different question, and would answer it wrongly for
  // every source that was launched on a standing choice instead.
  //
  // As a pin rather than as an override, because the user chose nothing:
  // an override would make the branch's picker report a model as "chosen for
  // this conversation" and offer a clear that wipes the account's standing
  // choice along with it.
  //
  // The profile stays as the last resort, for a source recorded before pins
  // existed: it has no pin to copy and the profile is what it launched on.
  // Tested against `undefined` rather than with `??`, because a source
  // pinned to `null` ran with no model flag at all and the branch has to
  // inherit that answer instead of picking up a profile the source never had.
  branch.chatModelPinned =
    source.chatModelPinned !== undefined
      ? source.chatModelPinned
      : deps.activeProfileFor?.(source.lastAgent || '')?.model;
  branch.chatEffortOverride = source.chatEffortOverride;
  pendingBranch = branch;

  const ref: ChatSessionRef = branch;
  const branchEvents = await cloneBranchAttachmentEvents(
    attachmentSessionRef(source),
    attachmentSessionRef(branch),
    plan.events,
    deps.attachmentStore,
    undefined,
    projectWorkspaceRoot,
  );
  // The ordinary event path may fire-and-forget this promise, but branch
  // creation is a durability boundary: no session record is committed
  // until every newly-created artifact is ready. Attachment bytes are
  // cloned first, so a durable log can never point back into the source
  // namespace or outlive bytes that were not flushed yet.
  await appendBranchChat(ref, branchEvents);
  const stats = await store.stat(ref);
  if (stats.cursor < branchEvents.length) {
    await rollbackPendingBranch();
    res.status(500).json({
      error: 'branch_not_written',
      message: 'The branch could not be written to disk',
      ...(rollbackAmbiguousBranchId ? {
        sessionId: rollbackAmbiguousBranchId,
        recoveryPending: true,
        recoveryDurable: rollbackRecoveryDurable === true,
        retryable: true,
      } : {}),
    });
    return;
  }
  await setBranchOpeningContext(ref, plan.context);
  // Prepare the empty transcript before the session row is committed. If
  // this fails, the chat log and opening context can still be rolled back
  // without a durable record ever pointing at missing artifacts.
  await deps.transcriptStore.ensureTranscript(branch);

  const branchProjectName = branch.projectId
    ? deps.projectsManager?.getForUser(branch.ownerUserId, branch.projectId)?.name || null
    : null;
  const release = await acquireTabMutation(user.id);
  accountMutationHeld = true;
  try {
    // Creating the record happened before the durable branch log was built,
    // which can take long enough for another device to reorder or close
    // tabs. Allocate and insert only after that account mutation commits or
    // rolls back, never against its tentative positions.
    branch.tabOrder = nextAccountTabOrder(deps.claudeSessions, user.id);
    deps.claudeSessions.set(sessionId, branch);

    let saved = false;
    try {
      saved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error('Failed to persist branched session:', error);
    }
    if (!saved) {
      await rollbackPendingBranch();
      res.status(503).json({
        error: 'branch_not_saved',
        message: 'The branch could not be saved',
        ...(rollbackAmbiguous ? {
          sessionId,
          recoveryPending: true,
          recoveryDurable: rollbackRecoveryDurable === true,
          retryable: true,
        } : {}),
      });
      return;
    }

    // A branch is a conversation that now exists, so it reaches the user's
    // other screens on the same terms as one started from scratch.
    announceSessionOpened(
      branch,
      deps.webSocketConnections,
      branch.projectId ? branchProjectName : undefined,
    );
    // The durable record is the commit point. Everything that can fail and
    // creates an artifact ran before it; broadcasting and serializing the
    // already-built response do not mutate branch storage.
    pendingBranch = null;
  } finally {
    accountMutationHeld = false;
    release();
  }

  res.json({
    success: true,
    sessionId,
    name: branch.name,
    workingDir: branch.workingDir,
    projectId: branch.projectId,
    projectName: branchProjectName,
    projectWorkingDirKind: branch.projectWorkingDirKind,
    runtime: branch.lastAgent,
    turnIndex: cut.turn.index,
    turns: plan.turns,
    estimatedTokens: plan.estimatedTokens,
    // Absent means no window was ever reported, so nothing was measured.
    // Named rather than left to be inferred from a missing number: a caller
    // has to be able to tell a branch that fits from one nobody could size.
    contextWindow: plan.contextWindow,
    sizeChecked: plan.budgetTokens !== undefined,
  });
} catch (error: unknown) {
  await rollbackPendingBranch();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to branch session ${source.id}:`, error);
  res.status(500).json({
    error: 'branch_failed',
    message,
    ...(rollbackAmbiguousBranchId ? {
      sessionId: rollbackAmbiguousBranchId,
      recoveryPending: true,
      recoveryDurable: rollbackRecoveryDurable === true,
      retryable: true,
    } : {}),
  });
}
  } finally {
    try {
      completeProjectBranchCreate?.();
    } finally {
      completeSourceBranchCreate();
    }
  }
};

if (!source.projectId) {
  await executeBranch();
  return;
}

const projects = deps.projectsManager;
if (!projects || !projects.getForUser(user.id, source.projectId)) {
  res.status(404).json({ error: 'project_not_found', message: 'Project not found' });
  return;
}
if (!projects.withProjectWorkspace) {
  res.status(503).json({
    error: 'project_unavailable',
    message: 'Project lifecycle storage is unavailable',
  });
  return;
}
try {
  // This gate does not start or build a stopped project. It pins the
  // canonical host checkout through source reads, attachment copies, all
  // branch writes, commit and any compensating rollback.
  await projects.withProjectWorkspace(
    user.id,
    source.projectId,
    (workspaceRoot) => executeBranch(workspaceRoot),
  );
} catch (error) {
  if (res.headersSent) return;
  const currentProject = projects.getForUser(user.id, source.projectId);
  res.status(currentProject ? 409 : 404).json({
    error: currentProject ? 'project_unavailable' : 'project_not_found',
    message: error instanceof Error ? error.message : 'Project is unavailable',
  });
}
}
