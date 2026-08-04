import express, { NextFunction, Request, Response, Router } from 'express';
import { PathValidation, SessionRecord } from '../types.js';
import {
  AttachmentSessionRef,
  AttachmentStoreLike,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  attachmentUrlFor,
} from '../services/attachment-store.js';
import { getOwnedSession, requireUser } from './helpers.js';

/**
 * Upload and serve the files attached to a chat turn.
 *
 * Two routes and nothing else: put a file where the agent can read it, and give
 * it back to the browser that has to draw it in the transcript.
 *
 * The body is raw bytes rather than multipart. Multipart would mean a parser
 * dependency for a form with exactly one field in it, and the two things the
 * form would have carried — the filename and the browser's guess at the type —
 * are already on the request as a query parameter and a header. Neither is
 * trusted: the name is reduced to a safe basename before it touches the disk,
 * and the type is never echoed back as a response content type (see
 * `serveKind` in the store).
 *
 * Both routes are the same shape as the paste route next door, on purpose: the
 * ownership check, the re-validation of a working directory that was admitted
 * by a configuration which may since have narrowed, and the same-origin refusal
 * on the write are the properties that make either of them safe, and they are
 * easier to keep in step when they read the same way.
 */

export const ATTACHMENT_MAX_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES;

export interface ChatAttachmentRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  attachmentStore: AttachmentStoreLike;
  validatePath(targetPath: string, userId?: number): PathValidation;
}

interface BodyParserError extends Error {
  type?: string;
}

/**
 * The URL a browser fetches an attachment back from.
 *
 * Exported because the upload response, the transcript's image blocks and the
 * tests all need to agree on it, and three string templates is how they stop
 * agreeing.
 */
export function attachmentUrl(sessionId: string, storedName: string): string {
  return attachmentUrlFor(sessionId, storedName);
}

/** Same reasoning as the paste route's copy: SameSite=Lax is site-, not origin-scoped. */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sessionFor(
  deps: ChatAttachmentRoutesDeps,
  req: Request,
  res: Response,
): (SessionRecord & { validatedDir: string }) | null {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return null;
  }

  const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
  if (!session) {
    // 404 rather than 403, so nobody can probe for another user's ids.
    res.status(404).json({ error: 'Session not found' });
    return null;
  }

  // A project cwd can be a container path (`/tmp`, `/etc`, ...), whose string
  // may also name an unrelated host path. Never pass it through host path
  // validation: the project-aware attachment store acquires the manager lease,
  // restores the authoritative namespace and performs confinement there.
  if (
    (session.projectId !== undefined && session.projectId !== null)
    || session.projectWorkingDirKind !== undefined
  ) {
    return Object.assign(session, { validatedDir: session.workingDir });
  }

  const validation = deps.validatePath(session.workingDir, session.ownerUserId);
  if (!validation.valid || !validation.path) {
    res.status(403).json({ error: 'session_outside_base' });
    return null;
  }

  return Object.assign(session, { validatedDir: validation.path });
}

function attachmentSessionRef(
  session: SessionRecord & { validatedDir: string },
): AttachmentSessionRef {
  // Preserve the actual project record so an authoritative cwd repair made
  // during manager admission is persisted on the same object. Non-project
  // sessions still use the revalidated host path rather than the stale string
  // from their record.
  if (session.projectId) {
    return Object.assign(session, {
      projectId: session.projectId,
      projectWorkingDirKind: session.projectWorkingDirKind,
    });
  }
  return {
    id: session.id,
    ownerUserId: session.ownerUserId,
    workingDir: session.validatedDir,
    projectId: session.projectId,
    projectWorkingDirKind: session.projectWorkingDirKind,
  };
}

export function createChatAttachmentRoutes(deps: ChatAttachmentRoutesDeps): Router {
  const router = Router();

  router.post(
    '/api/sessions/:sessionId/chat-attachments',
    // Route-scoped so the app-wide express.json() 100 kB default stays put.
    express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES }),
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      if (!isSameOrigin(req)) {
        res.status(403).json({ error: 'cross_origin' });
        return;
      }

      const filename = typeof req.query.name === 'string' ? req.query.name : 'attachment';
      const declaredMime = String(req.headers['content-type'] || '');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        const stored = await deps.attachmentStore.save(
          attachmentSessionRef(session),
          { filename, declaredMime, bytes },
        );

        // Exactly a ChatAttachment: the client posts this straight back on the
        // turn, so anything reshaped in between is a chance to reshape it wrong.
        res.json({
          url: attachmentUrl(session.id, stored.storedName),
          mime: stored.mime,
          name: stored.name,
          size: stored.bytes,
          path: stored.absolutePath,
          relativePath: stored.relativePath,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        switch (code) {
          case 'EMPTY_BODY':
            res.status(400).json({ error: 'empty_body' });
            return;
          case 'FILE_TOO_LARGE':
            res.status(413).json({ error: 'file_too_large', limitBytes: ATTACHMENT_MAX_BYTES });
            return;
          case 'QUOTA_EXCEEDED':
            res.status(507).json({ error: 'quota_exceeded' });
            return;
          case 'UNSUPPORTED_ATTACHMENT_NAMESPACE':
            res.status(409).json({ error: 'unsupported_attachment_namespace' });
            return;
          case 'UNSAFE_ATTACHMENT_DIR':
            res.status(403).json({ error: 'unsafe_attachment_dir' });
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
            console.error('Failed to store a chat attachment:', error);
            res.status(500).json({ error: 'write_failed', reason: 'unknown' });
        }
      }
    },
  );

  router.get(
    '/api/sessions/:sessionId/chat-attachments/:name',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      try {
        const { stream, serve, bytes } = await deps.attachmentStore.openForDownload(
          attachmentSessionRef(session),
          req.params.name as string,
        );

        res.setHeader('Content-Type', serve.contentType);
        res.setHeader('Content-Length', String(bytes));
        // Belt and braces around the two-outcome rule in `serveKind`: even for
        // the inline case the browser must not go looking for a better type
        // than the one the sniff produced.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Disposition',
          `${serve.inline ? 'inline' : 'attachment'}; filename="${serve.filename.replace(/["\\]/g, '')}"`,
        );
        // Private: this is one user's file behind a cookie, and a shared cache
        // holding it would be the one place the ownership check does not run.
        res.setHeader('Cache-Control', 'private, max-age=3600');

        stream.on('error', () => {
          if (!res.headersSent) res.status(500).json({ error: 'read_failed' });
          else res.destroy();
        });
        res.once('close', () => stream.destroy());
        stream.pipe(res);
      } catch {
        res.status(404).json({ error: 'not_found' });
      }
    },
  );

  // Registered after the routes so body-parser's own rejection lands here and
  // reports the same limit the client checks against.
  router.use((error: BodyParserError, _req: Request, res: Response, next: NextFunction): void => {
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'file_too_large', limitBytes: ATTACHMENT_MAX_BYTES });
      return;
    }
    next(error);
  });

  return router;
}
