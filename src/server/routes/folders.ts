import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PathValidation, SessionRecord, AuthContext, AuthenticatedUser } from '../types.js';

export interface FolderRoutesDeps {
  baseFolder: string;
  claudeSessions: Map<string, SessionRecord>;
  validatePath(targetPath: string, userId?: number): PathValidation;
  /** Optional: without it the single shared base folder is used, as before. */
  getUserBaseFolder?(userId?: number): string;
  isPathWithinBase(targetPath: string, userId?: number): boolean;
  getSelectedWorkingDir(userId: number): string | null;
  setSelectedWorkingDir(userId: number, value: string | null): void;
  saveSessionsToDisk(): Promise<boolean | void>;
}

export function createFolderRoutes(deps: FolderRoutesDeps): Router {
  const router = Router();

  router.post('/api/create-folder', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { parentPath, folderName } = req.body;

    if (!folderName || !folderName.trim()) {
      res.status(400).json({ message: 'Folder name is required' });
      return;
    }

    if (folderName.includes('/') || folderName.includes('\\')) {
      res.status(400).json({ message: 'Invalid folder name' });
      return;
    }

    const basePath = parentPath || deps.getSelectedWorkingDir(user.id) || (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);
    const fullPath = path.join(basePath, folderName);

    const parentValidation = deps.validatePath(basePath, user.id);
    if (!parentValidation.valid) {
      res.status(403).json({
        message: 'Cannot create folder outside the allowed area',
      });
      return;
    }

    const fullValidation = deps.validatePath(fullPath, user.id);
    if (!fullValidation.valid) {
      res.status(403).json({
        message: 'Cannot create folder outside the allowed area',
      });
      return;
    }

    try {
      // Async fs: these handlers share the event loop with every user's live
      // terminal, so a slow or networked directory would stall all of them.
      const exists = await fsp.access(fullValidation.path!).then(() => true).catch(() => false);
      if (exists) {
        res.status(409).json({ message: 'Folder already exists' });
        return;
      }

      await fsp.mkdir(fullValidation.path!, { recursive: true });

      res.json({
        success: true,
        path: fullValidation.path,
        message: `Folder "${folderName}" created successfully`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to create folder:', error);
      res.status(500).json({
        message: `Failed to create folder: ${message}`,
      });
    }
  });

  router.get('/api/folders', async (_req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const req = _req;
    const requestedPath =
      (req.query.path as string)
      || deps.getSelectedWorkingDir(user.id)
      || (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);

    const validation = deps.validatePath(requestedPath, user.id);
    if (!validation.valid) {
      res.status(403).json({
        error: validation.error,
        message: 'Access to this directory is not allowed',
      });
      return;
    }

    const currentPath = validation.path!;

    try {
      const items = await fsp.readdir(currentPath, { withFileTypes: true });
      const folders = items
        .filter((item) => item.isDirectory())
        .filter((item) => !item.name.startsWith('.') || req.query.showHidden === 'true')
        .map((item) => ({
          name: item.name,
          path: path.join(currentPath, item.name),
          isDirectory: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parentDir = path.dirname(currentPath);
      const canGoUp = deps.isPathWithinBase(parentDir, user.id) && parentDir !== currentPath;

      res.json({
        currentPath,
        parentPath: canGoUp ? parentDir : null,
        folders,
        // The user's own root, not the server's: with per-user environments on
        // these differ, and a browser told the server's would offer a Home
        // button leading somewhere it is not allowed to go.
        home: (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder),
        baseFolder: (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder),
      });
    } catch (error) {
      // fs errors embed absolute paths and errno detail; keep that server-side.
      console.error('Cannot access directory:', error);
      res.status(403).json({
        error: 'Cannot access directory',
        message: 'Cannot access directory',
      });
    }
  });

  router.post('/api/set-working-dir', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { path: selectedPath, sessionId } = req.body as {
      path?: string;
      sessionId?: string;
    };

    const validation = deps.validatePath(selectedPath || '', user.id);
    if (!validation.valid) {
      res.status(403).json({
        error: validation.error,
        message: 'Cannot set working directory outside the allowed area',
      });
      return;
    }

    const validatedPath = validation.path!;

    try {
      let stats;
      try {
        stats = await fsp.stat(validatedPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: 'Directory does not exist' });
          return;
        }
        throw statError;
      }

      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }

      if (sessionId) {
        const session = deps.claudeSessions.get(sessionId);
        if (!session || session.ownerUserId !== user.id) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }

        session.workingDir = validatedPath;
        session.lastActivity = new Date();
        void deps.saveSessionsToDisk();
      }

      deps.setSelectedWorkingDir(user.id, validatedPath);

      res.json({
        success: true,
        workingDir: validatedPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'Failed to set working directory',
        message,
      });
    }
  });

  router.post('/api/folders/select', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    try {
      const { path: selectedPath } = req.body;
      const validation = deps.validatePath(selectedPath, user.id);
      if (!validation.valid) {
        res.status(403).json({
          error: validation.error,
          message: 'Cannot select directory outside the allowed area',
        });
        return;
      }

      const validatedPath = validation.path!;
      const isDir = await fsp.stat(validatedPath).then((s2) => s2.isDirectory()).catch(() => false);
      if (!isDir) {
        res.status(400).json({ error: 'Invalid directory path' });
        return;
      }

      deps.setSelectedWorkingDir(user.id, validatedPath);
      res.json({
        success: true,
        workingDir: validatedPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'Failed to set working directory',
        message,
      });
    }
  });

  router.post('/api/close-session', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    try {
      deps.setSelectedWorkingDir(user.id, null);
      res.json({
        success: true,
        message: 'Working directory cleared',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: 'Failed to clear working directory',
        message,
      });
    }
  });

  return router;
}

function requireUser(res: Response): AuthenticatedUser | null {
  const authContext = (res.locals.authContext as AuthContext | undefined) || {
    user: null,
    authSessionId: null,
  };
  return authContext.user;
}
