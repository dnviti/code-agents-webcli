import { projectName } from '../../../shared/conversations.js';
import { canonicalProjectContainerWorkingDir, canonicalProjectWorkingDir, classifyProjectContainerPath, projectWorkingDirOrDefault, restoreProjectWorkingDir, releaseProjectSessionLease, ProjectSessionEnvironmentResult, ProjectSessionLease } from '../../services/projects/working-dir.js';
import { SessionRecord } from '../../types.js';
import { announceSessionOpened } from '../../websocket/handler.js';
import { getOwnedSession, requireUser } from '../helpers.js';
import { nextAccountTabOrder } from './sessions-account.js';
import { SessionRoutesDeps, coordinationFor } from './sessions-common.js';
import { rejectUnavailablePersistence, reportWorkspacePersistenceUnavailable } from './sessions-shared.js';
import { trackOwnedSessionCreate } from './sessions-teardown.js';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function handleCreate(
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

const { name, workingDir, ownerSessionId, projectId, projectWorkingDirKind } = req.body;
const sessionId = randomUUID();

// The name is bound into a SQLite statement on every autosave, and SQLite
// refuses to bind anything that is not a string, number, null, bigint or
// buffer. One bad value therefore throws inside the replaceAll transaction
// and aborts the save — for every user's sessions, not just this one, since
// they are all written in that single transaction. Rejecting it here keeps
// the failure at the request that caused it.
if (name !== undefined && typeof name !== 'string') {
  res.status(400).json({ error: 'invalid_name', message: 'Session name must be a string' });
  return;
}
if (workingDir !== undefined && workingDir !== null && typeof workingDir !== 'string') {
  res.status(400).json({
    error: 'invalid_working_dir',
    message: 'Working directory must be a string',
  });
  return;
}
if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
  res.status(400).json({ error: 'invalid_project_id', message: 'Project id must be a string' });
  return;
}
if (typeof projectId === 'string' && projectId.trim().length === 0) {
  res.status(400).json({ error: 'invalid_project_id', message: 'Project id cannot be empty' });
  return;
}
if (
  projectWorkingDirKind !== undefined
  && projectWorkingDirKind !== 'host'
  && projectWorkingDirKind !== 'container'
) {
  res.status(400).json({
    error: 'invalid_project_working_dir_kind',
    message: 'Project working directory kind must be host or container',
  });
  return;
}

// A session can declare that it belongs to a conversation, which is what
// keeps it out of the listings and ties its lifetime to that conversation's.
// Only a conversation this user owns will do: accepting an arbitrary id
// would let one request hide a session from its own owner's tab strip, or
// attach it to somebody else's teardown.
let owner: string | undefined;
let ownerRecord: SessionRecord | undefined;
if (ownerSessionId !== undefined && ownerSessionId !== null) {
  if (typeof ownerSessionId !== 'string') {
    res.status(400).json({
      error: 'invalid_owner_session',
      message: 'Owner session id must be a string',
    });
    return;
  }
  const parent = getOwnedSession(deps.claudeSessions, ownerSessionId, user);
  if (!parent || parent.surface !== 'chat') {
    res.status(400).json({
      error: 'unknown_owner_session',
      message: 'That conversation does not exist',
    });
    return;
  }
  if (rejectUnavailablePersistence(res, parent)) return;
  if (parent.retiring) {
    res.status(409).json({
      error: 'owner_session_retiring',
      message: 'That conversation is being deleted',
    });
    return;
  }
  owner = parent.id;
  ownerRecord = parent;
}

const submittedProjectId = typeof projectId === 'string' ? projectId.trim() : undefined;
const inheritedProjectId = ownerRecord?.projectId || undefined;
if (
  ownerRecord
  && projectId !== undefined
  && (projectId === null ? undefined : submittedProjectId) !== inheritedProjectId
) {
  res.status(400).json({
    error: 'owner_project_mismatch',
    message: 'A conversation terminal must use the conversation project',
  });
  return;
}
const effectiveProjectId = ownerRecord ? inheritedProjectId : submittedProjectId;
if (projectWorkingDirKind !== undefined && !effectiveProjectId) {
  res.status(400).json({
    error: 'project_working_dir_without_project',
    message: 'A container working directory requires a project',
  });
  return;
}
if (projectWorkingDirKind !== undefined && !workingDir) {
  res.status(400).json({
    error: 'project_working_dir_kind_without_path',
    message: 'A project working directory kind requires a working directory',
  });
  return;
}

// Register before the first await. A deletion marks the owner retiring and
// drains this promise before it scans children, so this request either
// commits in full and is found by that scan or observes retirement and
// commits nothing.
const completeOwnedCreate = owner
  ? trackOwnedSessionCreate(coordinationFor(deps), owner)
  : undefined;
let projectLease: ProjectSessionLease | undefined;
try {
  let persistedProjectId: string | undefined;
  let persistedProjectName: string | null = null;
  let preparedProject:
    | Extract<ProjectSessionEnvironmentResult, { ok: true }>
    | undefined;
  let validWorkingDir = (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);
  let validWorkingDirKind: 'host' | 'container' | undefined;
  let projectWorkingDirLifetime: 'workspace' | 'owner_home' | 'disposable' | undefined;
  if (effectiveProjectId) {
    // Check owner scope before provisioning anything. A guessed id must not
    // start another user's project or disclose whether it can be started.
    const projects = deps.projectsManager;
    const ownedProject = projects?.getForUser(user.id, effectiveProjectId);
    if (!projects || !ownedProject) {
      res.status(404).json({ error: 'project_not_found', message: 'Project not found' });
      return;
    }

    const prepared = await projects.ensureForSession(user.id, effectiveProjectId);
    if (!prepared.ok) {
      if (prepared.reason === 'not_found') {
        res.status(404).json({ error: 'project_not_found', message: 'Project not found' });
      } else if (prepared.reason === 'run_limit') {
        res.status(409).json({ error: 'run_limit', running: prepared.running || [] });
      } else if (prepared.reason === 'shutting_down') {
        res.status(503).json({
          error: 'project_unavailable',
          detail: prepared.detail || 'The project service is shutting down',
        });
      } else {
        res.status(409).json({
          error: prepared.reason === 'building' ? 'project_building' : 'project_unavailable',
          detail: prepared.detail,
        });
      }
      return;
    }
    projectLease = {
      ownerUserId: user.id,
      projectId: effectiveProjectId,
      leaseId: prepared.leaseId,
    };
    persistedProjectId = effectiveProjectId;
    persistedProjectName = ownedProject.name || null;
    preparedProject = prepared;
    if (ownerRecord?.projectId === effectiveProjectId && !workingDir) {
      // A split terminal stays in its conversation's exact namespace. A
      // disposable container path that vanished on rebuild safely falls
      // back to the current checkout and changes its discriminator too.
      const inherited = await restoreProjectWorkingDir(
        projects,
        prepared,
        ownerRecord.workingDir,
        ownerRecord.projectWorkingDirKind,
      );
      validWorkingDir = inherited.workingDir;
      validWorkingDirKind = inherited.kind;
    } else {
      validWorkingDir = await projectWorkingDirOrDefault(prepared);
      validWorkingDirKind = 'host';
    }
  }

  if (workingDir) {
    if (persistedProjectId && preparedProject) {
      const requestedKind = projectWorkingDirKind
        ?? ownerRecord?.projectWorkingDirKind
        ?? 'host';
      const confined = requestedKind === 'container'
        ? await canonicalProjectContainerWorkingDir(
            deps.projectsManager!,
            preparedProject,
            workingDir,
          )
        : await canonicalProjectWorkingDir(
            preparedProject.allowedWorkingDirs,
            workingDir,
          );
      if (!confined) {
        res.status(403).json({
          error: 'invalid_project_working_dir',
          message: requestedKind === 'container'
            ? 'That directory does not exist in the project container'
            : 'That host directory is not mounted into this project',
        });
        return;
      }
      validWorkingDir = confined;
      validWorkingDirKind = requestedKind;
    } else {
      const validation = deps.validatePath(workingDir, user.id);
      if (!validation.valid) {
        res.status(403).json({
          error: validation.error,
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    }
  } else if (!persistedProjectId) {
    const selected = deps.getSelectedWorkingDir(user.id);
    validWorkingDir = selected && deps.validatePath(selected, user.id).valid
      ? selected
      : (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);
  }

  if (preparedProject?.containerAccess && validWorkingDirKind === 'container') {
    projectWorkingDirLifetime = classifyProjectContainerPath(
      preparedProject.containerAccess,
      validWorkingDir,
    );
  }

  // The owner was authorised before project provisioning and cwd
  // canonicalisation, both of which may await. Bind the child to the exact
  // same owned record at commit time; an id removed and reused meanwhile is
  // not the conversation this request was allowed to join.
  if (ownerRecord) {
    const currentOwner = deps.claudeSessions.get(ownerRecord.id);
    if (
      currentOwner !== ownerRecord
      || currentOwner.ownerUserId !== user.id
      || currentOwner.surface !== 'chat'
      || currentOwner.retiring
    ) {
      res.status(409).json({
        error: 'owner_session_retiring',
        message: 'That conversation is being deleted',
      });
      return;
    }
  }

  const sessionStorageRoot = ownerRecord?.storageScope?.workspaceRoot
    || preparedProject?.allowedWorkingDirs[0]
    || validWorkingDir;
  const release = await acquireTabMutation(user.id);
  let session: SessionRecord;
  try {
    try {
      await deps.loadWorkspaceSessions?.(user.id, sessionStorageRoot);
    } catch (error) {
      reportWorkspacePersistenceUnavailable(res, error);
      return;
    }
    // Project preparation may await for long enough that the owner is
    // retired or replaced. Revalidate the exact record under the same
    // account turn that allocates tab membership and persists it.
    if (ownerRecord) {
      const currentOwner = deps.claudeSessions.get(ownerRecord.id);
      if (
        currentOwner !== ownerRecord
        || currentOwner.ownerUserId !== user.id
        || currentOwner.surface !== 'chat'
        || currentOwner.retiring
      ) {
        res.status(409).json({
          error: 'owner_session_retiring',
          message: 'That conversation is being deleted',
        });
        return;
      }
    }

    // Allocate and insert inside the same account turn as visibility/order.
    // Otherwise a close that later rolls back can leave this new tab sharing
    // its tentative append position.
    try {
      session = deps.createSessionRecord({
        id: sessionId,
        ownerUserId: user.id,
        name,
        workingDir: validWorkingDir,
        ownerSessionId: owner,
        projectId: persistedProjectId,
        projectWorkingDirKind: persistedProjectId ? validWorkingDirKind : undefined,
        storageRoot: sessionStorageRoot,
      });
    } catch (error) {
      reportWorkspacePersistenceUnavailable(res, error);
      return;
    }
    if (!owner) session.tabOrder = nextAccountTabOrder(deps.claudeSessions, user.id);
    // Provision the project-local durability anchor before publishing its
    // shared SQLite reference. A failed artifact write must not leave a
    // durable metadata row pointing at an archive that never existed.
    try {
      await deps.transcriptStore.ensureTranscript(session);
    } catch (error) {
      reportWorkspacePersistenceUnavailable(res, error);
      return;
    }
    deps.claudeSessions.set(sessionId, session);

    // Keep both the project admission lease and the account tab turn until
    // the association is durable. A refused SQLite save commits nothing and
    // must not leak a visible tab or transcript.
    let saved = false;
    try {
      saved = (await deps.saveSessionsToDisk()) !== false;
    } catch (error) {
      console.error('Failed to persist new session:', error);
    }
    if (!saved) {
      deps.claudeSessions.delete(sessionId);
      try {
        await deps.transcriptStore.deleteTranscript(session);
      } catch (error) {
        console.error(`Failed to clean transcript for uncommitted session ${sessionId}:`, error);
      }
      res.status(503).json({
        error: 'session_not_saved',
        message: 'The new session could not be saved',
      });
      return;
    }

    // Every screen this person has open, including the one that asked — which
    // adds the tab from this response and folds the announcement into it. A
    // shell created *inside* a conversation announces nothing; see the helper.
    announceSessionOpened(
      session,
      deps.webSocketConnections,
      persistedProjectId ? persistedProjectName : undefined,
    );
  } finally {
    release();
  }

  if (deps.dev) {
    console.log(`Created new session: ${sessionId} for GitHub user ${user.githubLogin}`);
  }

  res.json({
    success: true,
    sessionId,
    session: {
      id: sessionId,
      name: session.name,
      workingDir: session.workingDir,
      projectId: session.projectId,
      projectName: persistedProjectName,
      projectWorkingDirKind: session.projectWorkingDirKind,
      projectWorkingDirLifetime,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
    },
  });
} finally {
  // Creating an inactive record is not active project work. The lease only
  // closes the admission-vs-stop race while the record and its cwd are
  // validated and persisted; runtime and socket paths take their own.
  try {
    releaseProjectSessionLease(deps.projectsManager, projectLease);
  } finally {
    completeOwnedCreate?.();
  }
}
}
