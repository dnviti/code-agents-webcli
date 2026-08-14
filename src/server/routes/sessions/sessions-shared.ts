import { stripAnsi } from '../../services/ansi.js';
import { SessionRecord } from '../../types.js';
import { Response } from 'express';

/**
 * How many past conversations one folder offers.
 *
 * A list to choose from, not an archive to browse: past this many the useful
 * one is not findable by scrolling anyway, and every entry costs a read.
 */
export const MAX_RESUMABLE = 25;

/**
 * How many conversations one full listing describes.
 *
 * Far above the "hundreds across a dozen projects" this is built for, and it is
 * a backstop rather than a design: every described conversation costs a bounded
 * read of its log, and an account with ten thousand of them must not be able to
 * turn opening a list into a minute of disk. What is dropped is always the least
 * recently active, and the answer says it was dropped.
 */
export const MAX_LISTED_CONVERSATIONS = 400;

/** Long enough for any label worth reading on a tab, short enough to store freely. */
export const MAX_NAME_LENGTH = 200;

export function rejectUnavailablePersistence(res: Response, session: SessionRecord): boolean {
  if (session.persistenceUnavailable) {
    res.status(409).json({
      error: 'session_persistence_unavailable',
      message: session.persistenceUnavailable,
      retryable: true,
    });
    return true;
  }
  if (session.rollbackRecoveryPending) {
    res.status(409).json({
      error: 'session_recovery_pending',
      message: 'This session is retained only to retry an incomplete rollback',
      retryable: true,
    });
    return true;
  }
  return false;
}

export function reportWorkspacePersistenceUnavailable(res: Response, error: unknown): void {
  res.status(409).json({
    error: 'workspace_persistence_unavailable',
    message: error instanceof Error ? error.message : 'Workspace persistence is unavailable',
    retryable: true,
  });
}

/**
 * When a session was last active, in milliseconds.
 *
 * Tolerant of a string because the field crosses SQLite: `loadSessions` revives
 * it as a Date, but a record hand-built by a caller — or one revived by an older
 * build — can carry the ISO string it was stored as, and `.getTime()` on a string
 * is a TypeError that would take the whole listing down rather than one row's
 * timestamp.
 */
export function activityMs(session: SessionRecord): number {
  const value = session.lastActivity as Date | string | undefined;
  const at = value instanceof Date ? value.getTime() : new Date(value ?? 0).getTime();
  return Number.isFinite(at) ? at : 0;
}

export const EXPORT_PAGE_LINES = 500;

/** Long enough that ordinary fenced output inside the transcript cannot close it. */
export const FENCE = '``````````';

export function toPlainText(value: string): string {
  // Markdown is plain text, so the whole escape vocabulary goes.
  return stripAnsi(value)
    .replace(/\r\n?/g, '\n')
    // Shorten any run that could close the fence; 9 still renders as backticks.
    .replace(/`{10,}/g, '`````````');
}

/** What to call a session in front of the user: their name for it if they gave one. */
export function displayName(session: SessionRecord): string {
  return session.customName || session.name;
}

/**
 * What a branch's tab is called.
 *
 * Named after where it came from, because that is the only thing that
 * distinguishes it from the conversation beside it in the strip: same folder,
 * same agent, same first thirty turns. Capped like any other stored name.
 */
export function branchName(source: SessionRecord, turnIndex: number): string {
  return `${displayName(source)} — branch at turn ${turnIndex}`.slice(0, MAX_NAME_LENGTH);
}

export function exportFileName(session: SessionRecord): string {
  const safe = displayName(session).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = session.created.toISOString().slice(0, 10);
  return `${safe || 'session'}-${stamp}.md`;
}

export function countUserSessions(
  sessions: Map<string, SessionRecord>,
  userId: number,
): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerUserId === userId) {
      count++;
    }
  }
  return count;
}
