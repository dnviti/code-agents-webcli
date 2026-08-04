import { Router, Request, Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PathValidation, SessionRecord, AuthContext, AuthenticatedUser } from '../types.js';
import {
  canonicalProjectContainerWorkingDir,
  projectHostWorkingDirToContainer,
  releaseProjectSessionLease,
  registerUnverifiedProjectProcess,
  restoreProjectWorkingDir,
  type ProjectSessionEnvironmentResult,
  type ProjectSessionLease,
  type ProjectsSessionApi,
} from '../services/projects/working-dir.js';
import {
  mustRetainProjectLease,
  ProjectContainerFiles,
} from '../services/projects/container-files.js';

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
  projectsManager?: ProjectsSessionApi;
}

type PreparedProject = Extract<ProjectSessionEnvironmentResult, { ok: true }>;

class ProjectFolderUnavailable extends Error {
  constructor(readonly reason: string, detail?: string) {
    super(detail ? `Project environment is ${reason}: ${detail}` : `Project environment is ${reason}`);
  }
}

async function withProjectFolders<T>(
  deps: FolderRoutesDeps,
  user: AuthenticatedUser,
  projectId: string,
  operation: (
    manager: ProjectsSessionApi,
    prepared: PreparedProject,
    files: ProjectContainerFiles,
  ) => Promise<T>,
): Promise<T> {
  const manager = deps.projectsManager;
  if (!manager) throw new ProjectFolderUnavailable('not configured');
  if (!manager.getForUser(user.id, projectId)) throw new ProjectFolderUnavailable('not_found');
  const prepared = await manager.ensureForSession(user.id, projectId);
  if (!prepared.ok) throw new ProjectFolderUnavailable(prepared.reason, prepared.detail);
  if (!prepared.containerAccess) throw new ProjectFolderUnavailable('host_local', 'Use the normal directory picker for local projects');
  const lease: ProjectSessionLease = {
    ownerUserId: user.id,
    projectId,
    leaseId: prepared.leaseId,
  };
  let retainLease = false;
  try {
    manager.touchActivity(projectId);
    return await operation(
      manager,
      prepared,
      new ProjectContainerFiles(manager, prepared, prepared.containerAccess.root),
    );
  } catch (error) {
    retainLease = registerUnverifiedProjectProcess(manager, lease, error);
    throw error;
  } finally {
    if (!retainLease) releaseProjectSessionLease(manager, lease);
  }
}

function projectIdFrom(source: unknown): string | null | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'projectId')) return undefined;
  if (typeof record.projectId !== 'string') return null;
  const id = record.projectId.trim();
  return id || null;
}

function requireValidProjectId(
  res: Response,
  value: string | null | undefined,
): value is string | undefined {
  if (value !== null) return true;
  res.status(400).json({ error: 'invalid_project_id', message: 'Project id must be a non-empty string' });
  return false;
}

function answerProjectError(res: Response, error: unknown): boolean {
  if (mustRetainProjectLease(error)) {
    res.status(503).json({
      error: 'project_process_stop_unverified',
      message: 'A project helper could not be verified as stopped',
    });
    return true;
  }
  if (!(error instanceof ProjectFolderUnavailable)) return false;
  const status = error.reason === 'not_found'
    ? 404
    : error.reason === 'shutting_down'
      ? 503
      : 409;
  res.status(status).json({ error: 'project_unavailable', message: error.message });
  return true;
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
    const projectId = projectIdFrom(req.body);
    if (!requireValidProjectId(res, projectId)) return;

    if (typeof folderName !== 'string' || !folderName.trim()) {
      res.status(400).json({ message: 'Folder name is required' });
      return;
    }

    const trimmedFolderName = folderName.trim();
    if (
      folderName.includes('/')
      || folderName.includes('\\')
      || folderName.includes('\0')
      || trimmedFolderName === '.'
      || trimmedFolderName === '..'
    ) {
      res.status(400).json({ message: 'Invalid folder name' });
      return;
    }

    if (projectId) {
      try {
        const created = await withProjectFolders(
          deps,
          user,
          projectId,
          async (_manager, _prepared, files) => {
            const confined = await files.confineExisting(
              typeof parentPath === 'string' ? parentPath : '/',
            );
            if (!confined.path) {
              const error = new Error(confined.missing ? 'Parent folder does not exist' : 'Parent folder is outside the project container') as Error & { status?: number };
              error.status = confined.missing ? 404 : 403;
              throw error;
            }
            const stat = await files.stat(confined.path);
            if (!stat || stat.type !== 'directory') {
              const error = new Error('Parent path is not a directory') as Error & { status?: number };
              error.status = 400;
              throw error;
            }
            const createdPath = await files.createDirectory(confined.path, trimmedFolderName);
            return { path: createdPath, lifetime: files.lifetime(createdPath) };
          },
        );
        res.json({
          success: true,
          path: created.path,
          workingDirKind: 'container',
          lifetime: created.lifetime,
          message: `Folder "${trimmedFolderName}" created successfully`,
        });
      } catch (error) {
        if (answerProjectError(res, error)) return;
        const status = (error as Error & { status?: number }).status;
        if (status) {
          res.status(status).json({ message: (error as Error).message });
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          res.status(409).json({ message: 'Folder already exists' });
          return;
        }
        console.error('Failed to create project container folder:', error);
        res.status(500).json({ message: 'Failed to create folder' });
      }
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
    const projectId = projectIdFrom(req.query);
    if (!requireValidProjectId(res, projectId)) return;
    if (projectId) {
      try {
        const data = await withProjectFolders(
          deps,
          user,
          projectId,
          async (manager, prepared, files) => {
            const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
            const session = sessionId ? deps.claudeSessions.get(sessionId) : undefined;
            if (sessionId && (
              !session
              || session.ownerUserId !== user.id
              || session.projectId !== projectId
            )) {
              throw new ProjectFolderUnavailable('not_found');
            }

            let defaultPath: string | null = null;
            if (session) {
              const restored = await restoreProjectWorkingDir(
                manager,
                prepared,
                session.workingDir,
                session.projectWorkingDirKind,
              );
              const cwdChanged = session.workingDir !== restored.workingDir
                || session.projectWorkingDirKind !== restored.kind;
              session.workingDir = restored.workingDir;
              session.projectWorkingDirKind = restored.kind;
              if (cwdChanged) await deps.saveSessionsToDisk();
              defaultPath = restored.kind === 'container'
                ? restored.workingDir
                : await projectHostWorkingDirToContainer(prepared, restored.workingDir);
            }
            defaultPath ??= await projectHostWorkingDirToContainer(prepared, prepared.workingDir);
            defaultPath ??= prepared.containerAccess!.workspaceRoot;

            const requested = typeof req.query.path === 'string' && req.query.path
              ? req.query.path
              : defaultPath;
            const currentPath = await canonicalProjectContainerWorkingDir(
              manager,
              prepared,
              requested,
            );
            if (!currentPath) {
              const error = new Error('Cannot access directory') as Error & { status?: number };
              error.status = 403;
              throw error;
            }
            const listed = await files.list(
              currentPath,
              2000,
              req.query.showHidden === 'true',
            );
            const folders = listed.entries
              .filter((entry) => entry.isDirectory)
              .map((entry) => ({
                name: entry.name,
                path: entry.path,
                isDirectory: true,
                workingDirKind: 'container' as const,
                lifetime: files.lifetime(entry.path),
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            const parent = path.posix.dirname(currentPath);
            return {
              currentPath,
              parentPath: currentPath === '/' ? null : parent,
              folders,
              home: defaultPath,
              baseFolder: '/',
              workingDirKind: 'container' as const,
              lifetime: files.lifetime(currentPath),
              truncated: listed.truncated,
            };
          },
        );
        res.json(data);
      } catch (error) {
        if (answerProjectError(res, error)) return;
        const status = (error as Error & { status?: number }).status || 500;
        if (status === 500) console.error('Cannot access project container directory:', error);
        res.status(status).json({ error: 'Cannot access directory', message: 'Cannot access directory' });
      }
      return;
    }
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
    const projectId = projectIdFrom(req.body);
    if (!requireValidProjectId(res, projectId)) return;
    if (projectId) {
      try {
        if (!sessionId) {
          res.status(400).json({ error: 'A project session is required' });
          return;
        }
        const result = await withProjectFolders(
          deps,
          user,
          projectId,
          async (manager, prepared, files) => {
            const session = deps.claudeSessions.get(sessionId);
            if (
              !session
              || session.ownerUserId !== user.id
              || session.projectId !== projectId
            ) {
              throw new ProjectFolderUnavailable('not_found');
            }
            const canonical = await canonicalProjectContainerWorkingDir(
              manager,
              prepared,
              selectedPath || '',
            );
            if (!canonical) {
              const error = new Error('Directory does not exist in this project container') as Error & { status?: number };
              error.status = 404;
              throw error;
            }
            session.workingDir = canonical;
            session.projectWorkingDirKind = 'container';
            session.lastActivity = new Date();
            await deps.saveSessionsToDisk();
            return { canonical, lifetime: files.lifetime(canonical) };
          },
        );
        res.json({
          success: true,
          workingDir: result.canonical,
          workingDirKind: 'container',
          lifetime: result.lifetime,
        });
      } catch (error) {
        if (answerProjectError(res, error)) return;
        const status = (error as Error & { status?: number }).status || 500;
        res.status(status).json({ error: (error as Error).message });
      }
      return;
    }

    let legacySession: SessionRecord | undefined;
    if (sessionId) {
      legacySession = deps.claudeSessions.get(sessionId);
      // Ownership is decided before inspecting any discriminator on the
      // record. A guessed foreign id must look exactly like a missing id, not
      // reveal through a 409 that it names somebody else's project session.
      if (!legacySession || legacySession.ownerUserId !== user.id) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (legacySession.projectId) {
        res.status(409).json({
          error: 'project_context_required',
          message: 'Project working directories require an explicit project container context',
        });
        return;
      }
    }

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

      if (legacySession) {
        legacySession.workingDir = validatedPath;
        legacySession.lastActivity = new Date();
        await deps.saveSessionsToDisk();
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
      const projectId = projectIdFrom(req.body);
      if (!requireValidProjectId(res, projectId)) return;
      if (projectId) {
        const selected = await withProjectFolders(
          deps,
          user,
          projectId,
          async (manager, prepared, files) => {
            const canonical = await canonicalProjectContainerWorkingDir(
              manager,
              prepared,
              typeof selectedPath === 'string' ? selectedPath : '',
            );
            if (!canonical) {
              const error = new Error('Invalid project container directory') as Error & { status?: number };
              error.status = 400;
              throw error;
            }
            return { canonical, lifetime: files.lifetime(canonical) };
          },
        );
        // A project selection is session-scoped. In particular it must not
        // poison the user's legacy global host-directory preference with a
        // same-spelled container path such as `/tmp`.
        res.json({
          success: true,
          workingDir: selected.canonical,
          workingDirKind: 'container',
          lifetime: selected.lifetime,
        });
        return;
      }
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
      if (answerProjectError(res, error)) return;
      const status = (error as Error & { status?: number }).status;
      if (status) {
        res.status(status).json({ error: (error as Error).message });
        return;
      }
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
