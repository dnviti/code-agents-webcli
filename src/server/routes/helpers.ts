import { Response } from 'express';
import { AuthContext, AuthenticatedUser, SessionRecord } from '../types.js';

/** The signed-in user for this request, or null. Populated by attachRequestContext. */
export function requireUser(res: Response): AuthenticatedUser | null {
  const authContext = (res.locals.authContext as AuthContext | undefined) || {
    user: null,
    authSessionId: null,
  };
  return authContext.user;
}

/**
 * Look up a session the caller owns.
 *
 * Returns null for both "does not exist" and "belongs to someone else" so the
 * route can answer 404 either way: distinguishing them would let one user probe
 * for another's session ids.
 */
export function getOwnedSession(
  sessions: Map<string, SessionRecord>,
  sessionId: string,
  user: AuthenticatedUser,
): SessionRecord | null {
  const session = sessions.get(sessionId);
  if (!session || session.ownerUserId !== user.id) {
    return null;
  }

  return session;
}
