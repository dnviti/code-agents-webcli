// Folder browser: navigate, create, and select working directories
//
// `FolderBrowserDialog` paints it. This class kept everything the dialog is not
// allowed to know about: the folder API, the create-folder call, and the
// session-creation flow that a directory choice kicks off.

import type { App } from '../app';
import type { FolderData } from '../types';
import { shellStore } from '../shell/store';
import { showError } from './overlay';
import {
  getControllerSnapshot,
  parseQualifiedSessionId,
  rememberNewSessionServer,
} from '../controller/transport';

export class FolderBrowser {
  private app: App;
  private projectContext: { projectId: string; sessionId: string } | null = null;
  private currentProjectPath: string | null = null;
  /** Captured when the picker opens so a later global target change cannot reroute it. */
  private targetServerId: string | null = null;

  constructor(app: App) {
    this.app = app;
  }

  async show(options: { host?: boolean; serverId?: string } = {}): Promise<void> {
    const shell = shellStore.getSnapshot();
    const active = shell.tabs.find((tab) => tab.id === shell.activeId);
    this.projectContext = !options.host && active?.projectId
      ? { projectId: active.projectId, sessionId: active.id }
      : null;
    this.currentProjectPath = null;
    const activeOwner = active?.id ? parseQualifiedSessionId(active.id)?.serverId : null;
    this.targetServerId = options.serverId
      || activeOwner
      || (getControllerSnapshot().enabled ? getControllerSnapshot().selectedServerId : null);
    const startingPath = options.host && options.serverId ? null : this.app.currentFolderPath;
    if (options.host && options.serverId) {
      // A path is meaningful only on the server that returned it. Start a new
      // target at its own home instead of sending the previous server's path.
      this.app.currentFolderPath = null;
      this.app.selectedWorkingDir = null;
    }
    shellStore.patchSlice('folder', {
      open: true,
      creating: false,
      ...(this.projectContext || (options.host && options.serverId)
        ? { path: null, parentPath: null, entries: [], workingDirKind: 'container', lifetime: null }
        : {}),
    });
    await this.loadFolders(this.projectContext ? null : startingPath);
  }

  close(): void {
    shellStore.patchSlice('folder', { open: false, creating: false });
    this.app.isCreatingNewSession = false;
  }

  async loadFolders(path: string | null = null): Promise<void> {
    const { showHidden } = shellStore.getSnapshot().folder;
    const params = new URLSearchParams();
    if (path) params.append('path', path);
    if (showHidden) params.append('showHidden', 'true');
    if (this.projectContext) {
      params.set('projectId', this.projectContext.projectId);
      params.set('sessionId', this.projectContext.sessionId);
    }

    shellStore.patchSlice('folder', { loading: true });

    try {
      const response = await this.app.authFetch(`/api/folders?${params}`, {}, this.targetServerId);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to load folders');
      }

      const data: FolderData = await response.json();
      if (this.projectContext) this.currentProjectPath = data.currentPath;
      else this.app.currentFolderPath = data.currentPath;
      shellStore.patchSlice('folder', {
        path: data.currentPath,
        parentPath: data.parentPath,
        entries: data.folders,
        workingDirKind: data.workingDirKind || (this.projectContext ? 'container' : 'host'),
        lifetime: data.lifetime || null,
        loading: false,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to load folders:', error);
      // Clearing the list matters: leaving the previous directory's entries on
      // screen under a new path would invite a click that navigates somewhere
      // the user did not ask for.
      shellStore.patchSlice('folder', { loading: false, entries: [] });
      showError(`Failed to load folders: ${msg}`);
    }
  }

  async setShowHidden(showHidden: boolean): Promise<void> {
    shellStore.patchSlice('folder', { showHidden });
    await this.loadFolders(this.currentPath());
  }

  async navigateToParent(): Promise<void> {
    const { parentPath } = shellStore.getSnapshot().folder;
    // The server tells us the parent; deriving it by trimming the last path
    // segment got `/` wrong and could not represent a mount boundary.
    if (parentPath) {
      await this.loadFolders(parentPath);
    }
  }

  async navigateToHome(): Promise<void> {
    await this.loadFolders();
  }

  showCreateFolderInput(): void {
    shellStore.patchSlice('folder', { creating: true });
  }

  hideCreateFolderInput(): void {
    shellStore.patchSlice('folder', { creating: false });
  }

  async createFolder(folderName: string): Promise<void> {
    const name = folderName.trim();

    // The dialog refuses both of these before calling, so reaching them means a
    // different caller. Refusing here too keeps the server contract honest.
    if (!name) {
      showError('Please enter a folder name');
      return;
    }

    if (name.includes('/') || name.includes('\\')) {
      showError('Folder name cannot contain path separators');
      return;
    }

    try {
      const response = await this.app.authFetch('/api/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPath: this.currentPath() || '/',
          folderName: name,
          ...(this.projectContext ? { projectId: this.projectContext.projectId } : {}),
        }),
      }, this.targetServerId);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create folder');
      }

      this.hideCreateFolderInput();
      await this.loadFolders(this.currentPath());
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to create folder:', error);
      showError(`Failed to create folder: ${msg}`);
    }
  }

  async selectCurrentFolder(): Promise<void> {
    const currentPath = this.currentPath();
    if (!currentPath) {
      showError('No folder selected');
      return;
    }

    if (!this.projectContext) this.app.selectedWorkingDir = currentPath;

    if (!this.app.currentClaudeSessionId || this.app.isCreatingNewSession) {
      await this.createSessionForSelectedFolderAndPrompt();
      return;
    }

    try {
      const response = await this.app.authFetch('/api/set-working-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: currentPath,
          sessionId: this.projectContext?.sessionId || this.app.currentClaudeSessionId,
          ...(this.projectContext
            ? {
                projectId: this.projectContext.projectId,
                projectWorkingDirKind: 'container',
              }
            : {}),
        }),
      }, this.targetServerId);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to set working directory');
      }

      this.close();
      await this.app.connect();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to set working directory:', error);
      showError(`Failed to set working directory: ${msg}`);
    }
  }

  private async createSessionForSelectedFolderAndPrompt(): Promise<void> {
    const workingDir = this.projectContext
      ? this.currentProjectPath
      : this.app.selectedWorkingDir || this.app.currentFolderPath;
    if (!workingDir) {
      showError('No folder selected');
      return;
    }

    const defaultName = workingDir.split('/').pop() || `Session ${new Date().toLocaleString()}`;

    try {
      const serverId = this.targetServerId;
      const response = await this.app.authFetch('/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: defaultName,
          workingDir,
          ...(serverId ? { serverId } : {}),
          ...(this.projectContext
            ? {
                projectId: this.projectContext.projectId,
                projectWorkingDirKind: 'container',
              }
            : {}),
        }),
      }, serverId);

      if (!response.ok) throw new Error('Failed to create session');

      const data = await response.json();
      this.close();
      if (!this.projectContext) this.app.selectedWorkingDir = data.session.workingDir;
      this.app.startPromptRequested = true;

      if (this.app.sessionTabManager) {
        this.app.sessionTabManager.addTab(
          data.sessionId,
          data.session.name,
          'idle',
          data.session.workingDir,
          false,
          undefined,
          data.session.projectId ?? this.projectContext?.projectId,
          data.session.projectName,
          data.session.projectWorkingDirKind || (this.projectContext ? 'container' : undefined),
        );
        await this.app.sessionTabManager.switchToTab(data.sessionId);
      } else {
        await this.app.joinSession(data.sessionId);
      }

      if (serverId) rememberNewSessionServer(serverId);

      this.app.loadSessions();
    } catch (error: unknown) {
      this.app.startPromptRequested = false;
      console.error('Failed to create session for selected folder:', error);
      showError('Failed to create session');
    }
  }

  private currentPath(): string | null {
    return this.projectContext ? this.currentProjectPath : this.app.currentFolderPath;
  }
}
