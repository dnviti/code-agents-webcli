// Folder browser: navigate, create, and select working directories
//
// `FolderBrowserDialog` paints it. This class kept everything the dialog is not
// allowed to know about: the folder API, the create-folder call, and the
// session-creation flow that a directory choice kicks off.

import type { App } from '../app';
import type { FolderData } from '../types';
import { shellStore } from '../shell/store';
import { showError } from './overlay';

export class FolderBrowser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async show(): Promise<void> {
    shellStore.patchSlice('folder', { open: true, creating: false });
    await this.loadFolders(this.app.currentFolderPath);
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

    shellStore.patchSlice('folder', { loading: true });

    try {
      const response = await this.app.authFetch(`/api/folders?${params}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to load folders');
      }

      const data: FolderData = await response.json();
      this.app.currentFolderPath = data.currentPath;
      shellStore.patchSlice('folder', {
        path: data.currentPath,
        parentPath: data.parentPath,
        entries: data.folders,
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
    await this.loadFolders(this.app.currentFolderPath);
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
          parentPath: this.app.currentFolderPath || '/',
          folderName: name,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create folder');
      }

      this.hideCreateFolderInput();
      await this.loadFolders(this.app.currentFolderPath);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to create folder:', error);
      showError(`Failed to create folder: ${msg}`);
    }
  }

  async selectCurrentFolder(): Promise<void> {
    if (!this.app.currentFolderPath) {
      showError('No folder selected');
      return;
    }

    this.app.selectedWorkingDir = this.app.currentFolderPath;

    if (!this.app.currentClaudeSessionId || this.app.isCreatingNewSession) {
      await this.createSessionForSelectedFolderAndPrompt();
      return;
    }

    try {
      const response = await this.app.authFetch('/api/set-working-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: this.app.currentFolderPath,
          sessionId: this.app.currentClaudeSessionId,
        }),
      });

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
    const workingDir = this.app.selectedWorkingDir || this.app.currentFolderPath;
    if (!workingDir) {
      showError('No folder selected');
      return;
    }

    const defaultName = workingDir.split('/').pop() || `Session ${new Date().toLocaleString()}`;

    try {
      const response = await this.app.authFetch('/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: defaultName, workingDir }),
      });

      if (!response.ok) throw new Error('Failed to create session');

      const data = await response.json();
      this.close();
      this.app.selectedWorkingDir = data.session.workingDir;
      this.app.startPromptRequested = true;

      if (this.app.sessionTabManager) {
        this.app.sessionTabManager.addTab(
          data.sessionId,
          data.session.name,
          'idle',
          data.session.workingDir,
          false,
        );
        await this.app.sessionTabManager.switchToTab(data.sessionId);
      } else {
        await this.app.joinSession(data.sessionId);
      }

      this.app.loadSessions();
    } catch (error: unknown) {
      this.app.startPromptRequested = false;
      console.error('Failed to create session for selected folder:', error);
      showError('Failed to create session');
    }
  }
}
