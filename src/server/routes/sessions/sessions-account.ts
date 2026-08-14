import { SessionRecord } from '../../types.js';
import { SessionRoutesDeps } from './sessions-common.js';
import { activityMs } from './sessions-shared.js';

/**
 * Every chat conversation a user owns, most recently active first.
 *
 * The one definition of what a listable conversation is, so the resume list and
 * the full list cannot disagree about it. Three conditions, and each rules
 * something out that is not a conversation the user can open:
 *
 *   - not another user's, obviously.
 *   - not a terminal session, which has no transcript to come back to.
 *   - not a shell opened *inside* a conversation. It is a real session, but it is
 *     reached through the conversation that owns it and only there; a row of its
 *     own would offer a pty as though it were a chat.
 *
 * Sorting here rather than at each call site is what makes the grouping below
 * work: one order, read two ways.
 */
export function chatRecords(deps: SessionRoutesDeps, userId: number): SessionRecord[] {
  return Array.from(deps.claudeSessions.values())
    .filter((session) => session.ownerUserId === userId)
    .filter((session) => session.surface === 'chat')
    .filter((session) => !session.ownerSessionId)
    .sort((a, b) => activityMs(b) - activityMs(a));
}

/** The exact tab-strip membership for one account, in its durable order. */
export function orderedAccountTabs(
  sessions: Map<string, SessionRecord>,
  userId: number,
): SessionRecord[] {
  return Array.from(sessions.values())
    .filter((session) => session.ownerUserId === userId)
    .filter((session) => !session.ownerSessionId)
    // A closed conversation remains in the conversation list, not this strip.
    // Undefined is the pre-feature value and therefore still means open.
    .filter((session) => session.tabOpen !== false)
    .sort((left, right) => {
      const leftOrdered = Number.isFinite(left.tabOrder);
      const rightOrdered = Number.isFinite(right.tabOrder);
      // Legacy rows precede positions assigned to tabs created/reopened after
      // the upgrade. Returning zero preserves their Map order (and, after a
      // restart, SessionStore's created-at load order) exactly.
      if (!leftOrdered && !rightOrdered) return 0;
      if (!leftOrdered) return -1;
      if (!rightOrdered) return 1;
      return left.tabOrder! - right.tabOrder!;
    });
}

/** The append position for a new or genuinely reopened tab in this account. */
export function nextAccountTabOrder(sessions: Map<string, SessionRecord>, userId: number): number {
  let maximum = -1;
  for (const session of sessions.values()) {
    if (session.ownerUserId !== userId || session.ownerSessionId || session.tabOpen === false) {
      continue;
    }
    if (Number.isFinite(session.tabOrder)) maximum = Math.max(maximum, session.tabOrder!);
  }
  return maximum + 1;
}
