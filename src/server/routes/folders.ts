import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PathValidation, SessionRecord, AuthContext, AuthenticatedUser } from '../types.js';

export interface FolderRoutesDeps {
  baseFolder: string;
  claudeSessions: Map<string, SessionRecord>;
  validatePath(targetPath: string): PathValidation;
  isPathWithinBase(targetPath: string): boolean;
  getSelectedWorkingDir(userId: number): string | null;
  setSelectedWorkingDir(userId: number, value: string | null): void;
  saveSessionsToDisk(): Promise<void>;
}

export function createFolderRoutes(deps: FolderRoutesDeps): Router {
  const router = Router();

  router.post('/api/create-folder', (req: Request, res: Response): void => {
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

    const basePath = parentPath || deps.getSelectedWorkingDir(user.id) || deps.baseFolder;
    const fullPath = path.join(basePath, folderName);

    const parentValidation = deps.validatePath(basePath);
    if (!parentValidation.valid) {
      res.status(403).json({
        message: 'Cannot create folder outside the allowed area',
      });
      return;
    }

    const fullValidation = deps.validatePath(fullPath);
    if (!fullValidation.valid) {
      res.status(403).json({
        message: 'Cannot create folder outside the allowed area',
      });
      return;
    }

    try {
      if (fs.existsSync(fullValidation.path!)) {
        res.status(409).json({ message: 'Folder already exists' });
        return;
      }

      fs.mkdirSync(fullValidation.path!, { recursive: true });

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

  router.get('/api/folders', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const req = _req;
    const requestedPath =
      (req.query.path as string)
      || deps.getSelectedWorkingDir(user.id)
      || deps.baseFolder;

    const validation = deps.validatePath(requestedPath);
    if (!validation.valid) {
      res.status(403).json({
        error: validation.error,
        message: 'Access to this directory is not allowed',
      });
      return;
    }

    const currentPath = validation.path!;

    try {
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
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
      const canGoUp = deps.isPathWithinBase(parentDir) && parentDir !== currentPath;

      res.json({
        currentPath,
        parentPath: canGoUp ? parentDir : null,
        folders,
        home: deps.baseFolder,
        baseFolder: deps.baseFolder,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(403).json({
        error: 'Cannot access directory',
        message,
      });
    }
  });

  router.post('/api/set-working-dir', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { path: selectedPath, sessionId } = req.body as {
      path?: string;
      sessionId?: string;
    };

    const validation = deps.validatePath(selectedPath || '');
    if (!validation.valid) {
      res.status(403).json({
        error: validation.error,
        message: 'Cannot set working directory outside the allowed area',
      });
      return;
    }

    const validatedPath = validation.path!;

    try {
      if (!fs.existsSync(validatedPath)) {
        res.status(404).json({ error: 'Directory does not exist' });
        return;
      }

      const stats = fs.statSync(validatedPath);
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

  router.post('/api/folders/select', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    try {
      const { path: selectedPath } = req.body;
      const validation = deps.validatePath(selectedPath);
      if (!validation.valid) {
        res.status(403).json({
          error: validation.error,
          message: 'Cannot select directory outside the allowed area',
        });
        return;
      }

      const validatedPath = validation.path!;
      if (!fs.existsSync(validatedPath) || !fs.statSync(validatedPath).isDirectory()) {
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
