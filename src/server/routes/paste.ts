import express, { NextFunction, Request, Response, Router } from 'express';
import { PathValidation, SessionRecord } from '../types.js';
import { DEFAULT_MAX_BYTES, PasteStoreLike } from '../services/paste-store.js';
import { getOwnedSession, requireUser } from './helpers.js';

export const PASTE_MAX_BYTES = DEFAULT_MAX_BYTES;

export interface PasteRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  pasteStore: PasteStoreLike;
  validatePath(targetPath: string, userId?: number): PathValidation;
  publicBaseUrl?: string | null;
}

interface BodyParserError extends Error {
  type?: string;
}

/**
 * Reject a cross-origin write.
 *
 * The auth cookie is SameSite=Lax, which is site-scoped rather than
 * origin-scoped: on a deployment at app.example.com, any other *.example.com
 * the attacker controls counts as same-site, so its POST would carry the
 * cookie. This endpoint writes a file and injects text into a PTY, so an
 * unreadable response is no protection at all.
 */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    // Same-origin fetches from a page omit Origin on some browsers for GET,
    // but every fetch() POST sends it. A missing one is not proof of anything,
    // so it is allowed — the cookie plus SameSite still bounds it.
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

export function createPasteRoutes(deps: PasteRoutesDeps): Router {
  const router = Router();

  router.post(
    '/api/sessions/:sessionId/paste-image',
    // Route-scoped, so the app-wide express.json() 100 kB default stays where
    // it is. Raising that instead would lift the ceiling on every JSON route.
    express.raw({ type: () => true, limit: PASTE_MAX_BYTES }),
    async (req: Request, res: Response): Promise<void> => {
      const user = requireUser(res);
      if (!user) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }

      if (!isSameOrigin(req)) {
        res.status(403).json({ error: 'cross_origin' });
        return;
      }

      const sessionId = req.params.sessionId as string;
      const session = getOwnedSession(deps.claudeSessions, sessionId, user);
      if (!session) {
        // 404 rather than 403, so nobody can probe for another user's ids.
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // SessionStore restores working_dir straight from SQLite without a
      // re-check, so a database written by a looser build — or a base folder
      // narrowed since — must not turn into a write outside the sandbox.
      const validation = deps.validatePath(session.workingDir, session.ownerUserId);
      if (!validation.valid || !validation.path) {
        res.status(403).json({ error: 'session_outside_base' });
        return;
      }

      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        const result = await deps.pasteStore.save(
          { id: session.id, ownerUserId: session.ownerUserId, workingDir: validation.path },
          bytes,
        );
        res.json({ path: result.absolutePath, insertText: result.insertText, bytes: result.bytes });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        switch (code) {
          case 'EMPTY_BODY':
            res.status(400).json({ error: 'empty_body' });
            return;
          case 'IMAGE_TOO_LARGE':
            res.status(413).json({ error: 'image_too_large', limitBytes: PASTE_MAX_BYTES });
            return;
          case 'UNSUPPORTED_TYPE':
            res.status(415).json({ error: 'unsupported_image_type' });
            return;
          case 'UNSAFE_PASTE_DIR':
            res.status(403).json({ error: 'unsafe_paste_dir' });
            return;
          case 'SESSION_GONE':
            res.status(410).json({ error: 'session_gone' });
            return;
          case 'QUOTA_EXCEEDED':
            res.status(507).json({ error: 'quota_exceeded' });
            return;
          case 'EACCES':
          case 'EPERM':
            res.status(500).json({ error: 'write_failed', reason: 'permission' });
            return;
          case 'ENOSPC':
            res.status(500).json({ error: 'write_failed', reason: 'disk_full' });
            return;
          default:
            // The errno string can carry a path outside the working directory.
            console.error('Failed to store a pasted image:', error);
            res.status(500).json({ error: 'write_failed', reason: 'unknown' });
        }
      }
    },
  );

  // Registered after the route so body-parser's own rejection lands here
  // rather than in the app-wide handler, and reports the same limit the
  // client checks against.
  router.use((
    error: BodyParserError,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'image_too_large', limitBytes: PASTE_MAX_BYTES });
      return;
    }
    next(error);
  });

  return router;
}
