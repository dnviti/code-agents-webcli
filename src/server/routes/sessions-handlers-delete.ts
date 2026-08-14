import { announceSessionClosed } from '../websocket/handler.js';
import { getOwnedSession, requireUser } from './helpers.js';
import { SessionRoutesDeps } from './sessions-common.js';
import { EXPORT_PAGE_LINES, FENCE, rejectUnavailablePersistence, toPlainText, displayName, exportFileName } from './sessions-shared.js';
import { retireSessionTree, cleanupRollbackArtifacts } from './sessions-teardown.js';
import { Request, Response } from 'express';

export async function handleDelete(
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

const sessionId = req.params.sessionId as string;
const session = getOwnedSession(deps.claudeSessions, sessionId, user);
if (!session) {
  res.status(404).json({ error: 'Session not found' });
  return;
}
// Workspace unavailability outranks recovery. Without a usable archive this
// process cannot prove that cleanup authority is durable, so DELETE must
// not touch a byte even when both markers are present.
if (session.persistenceUnavailable) {
  rejectUnavailablePersistence(res, session);
  return;
}
if (session.rollbackRecoveryPending) {
  if (session.retiring) {
    res.status(409).json({
      error: 'session_recovery_in_progress',
      message: 'Rollback cleanup is already in progress',
      retryable: true,
    });
    return;
  }
  session.retiring = true;
  const retryCleanup = async (projectLifecycleExclusive: boolean): Promise<void> => {
    // A flag in memory is not cleanup authority: it may be the residue of
    // an anchor save whose commit could not be confirmed. Re-persist the
    // exact flagged row while it is still present, and do not touch one
    // filesystem byte unless that durability boundary succeeds.
    const releaseAnchorMutation = await acquireTabMutation(user.id);
    try {
      if (deps.claudeSessions.get(session.id) !== session) {
        session.retiring = false;
        res.status(409).json({
          error: 'session_recovery_changed',
          message: 'Rollback recovery changed before cleanup could start',
          retryable: true,
        });
        return;
      }
      if (session.persistenceUnavailable) {
        session.retiring = false;
        rejectUnavailablePersistence(res, session);
        return;
      }
      let anchorConfirmed = false;
      try {
        anchorConfirmed = (await deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error(`Failed to confirm rollback recovery ${session.id}:`, error);
      }
      if (!anchorConfirmed) {
        session.retiring = false;
        res.status(503).json({
          error: 'session_recovery_not_durable',
          message: 'Rollback cleanup cannot start until its recovery row is saved',
          sessionId: session.id,
          recoveryPending: true,
          recoveryDurable: false,
          retryable: true,
        });
        return;
      }
    } finally {
      releaseAnchorMutation();
    }
    if (res.headersSent) return;

    const failures = await cleanupRollbackArtifacts(
      deps,
      session,
      { projectLifecycleExclusive },
      true,
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(
          `Failed to retry ${failure.artifact} cleanup for branch ${session.id}:`,
          failure.error,
        );
      }
      session.retiring = false;
      res.status(503).json({
        error: 'session_recovery_incomplete',
        message: 'Rollback cleanup is still incomplete',
        sessionId: session.id,
        recoveryPending: true,
        recoveryDurable: true,
        retryable: true,
      });
      return;
    }

    const release = await acquireTabMutation(user.id);
    try {
      if (deps.claudeSessions.get(session.id) !== session) {
        session.retiring = false;
        res.status(409).json({
          error: 'session_recovery_changed',
          message: 'Rollback recovery changed while cleanup was running',
          retryable: true,
        });
        return;
      }
      deps.claudeSessions.delete(session.id);
      let saved = false;
      try {
        saved = (await deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error(`Failed to remove rollback recovery ${session.id}:`, error);
      }
      if (!saved) {
        deps.claudeSessions.set(session.id, session);
        session.retiring = false;
        res.status(503).json({
          error: 'session_recovery_not_saved',
          message: 'Cleanup completed but its recovery row could not be removed',
          sessionId: session.id,
          recoveryPending: true,
          recoveryDurable: true,
          retryable: true,
        });
        return;
      }
      deps.disposeRecorder(session.id);
      announceSessionClosed(session, deps.webSocketConnections);
      res.json({ success: true, message: 'Session recovery cleaned up' });
    } finally {
      release();
    }
  };

  if (session.projectId) {
    const projects = deps.projectsManager;
    if (!projects?.withProjectWorkspace || !projects.getForUser(user.id, session.projectId)) {
      session.retiring = false;
      res.status(409).json({
        error: 'project_unavailable',
        message: 'Project workspace is unavailable for rollback cleanup',
        retryable: true,
      });
      return;
    }
    try {
      await projects.withProjectWorkspace(
        user.id,
        session.projectId,
        () => retryCleanup(true),
      );
    } catch (error) {
      session.retiring = false;
      if (!res.headersSent) {
        res.status(409).json({
          error: 'project_unavailable',
          message: error instanceof Error ? error.message : 'Project workspace is unavailable',
          retryable: true,
        });
      }
    }
  } else {
    await retryCleanup(false);
  }
  return;
}
if (rejectUnavailablePersistence(res, session)) return;

// Close child admission before looking for children. A create that already
// passed owner validation is drained, then either appears in this cascade
// or rolls itself back; a later create sees `retiring` and is rejected.
// Concurrent deletes join the same cascade instead of tearing records down
// twice.
const saved = await retireSessionTree(deps, session, () => acquireTabMutation(user.id));
if (!saved) {
  res.status(503).json({
    error: 'session_delete_not_saved',
    message: 'The session could not be deleted',
  });
  return;
}

res.json({ success: true, message: 'Session deleted' });
}

/**
 * Download the whole session as Markdown.
 *
 * Streamed in pages straight from the history index rather than buffered:
 * a long session is tens of megabytes, and holding all of it in memory to
 * serve one download would be the same mistake the scrollback paging exists
 * to avoid.
 */

export async function handleExport(
  deps: SessionRoutesDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = getOwnedSession(deps.claudeSessions, sessionId, user);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // History reads can repair or truncate a torn index, so even export must
  // fail closed until the workspace archive is available and authoritative.
  // Recovery anchors are likewise cleanup authority, not an exportable
  // conversation.
  if (rejectUnavailablePersistence(res, session)) return;

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${exportFileName(session)}"`,
  );

  res.write(`# ${displayName(session)}\n\n`);
  res.write(`- Directory: \`${session.workingDir}\`\n`);
  res.write(`- Created: ${session.created.toISOString()}\n`);
  res.write(`- Last activity: ${session.lastActivity.toISOString()}\n\n`);
  res.write(`${FENCE}\n`);

  try {
    const { firstLine, totalLines } = await deps.historyStore.stat(session);
    if (firstLine > 0) {
      res.write(`[... ${firstLine} earlier lines no longer retained ...]\n`);
    }

    for (let cursor = firstLine; cursor < totalLines; ) {
      const page = await deps.historyStore.read(session, cursor, EXPORT_PAGE_LINES);
      if (page.lines.length === 0) {
        break;
      }
      res.write(`${page.lines.map(toPlainText).join('\n')}\n`);
      cursor = page.fromLine + page.lines.length;
    }

    // The newest lines are still on the emulator's screen and have not
    // scrolled into history yet. Taking them from the raw output buffer
    // instead would re-emit whatever of the session that buffer still
    // holds, duplicating most of the export.
    const tail = deps.getScreenSnapshot(sessionId);
    if (tail.length > 0) {
      res.write(`${tail.map(toPlainText).join('\n')}\n`);
    }
  } catch (error) {
    console.error(`Failed to export session ${sessionId}:`, error);
    res.write('\n[... export interrupted by an error ...]\n');
  }

  res.write(`${FENCE}\n`);
  res.end();
}
