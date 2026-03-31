// Folder browser: navigate, create, and select working directories

import type { App } from '../app';
import type { FolderData } from '../types';
import { showError } from './overlay';

export class FolderBrowser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  setup(): void {
    const modal = document.getElementById('folderBrowserModal');
    const upBtn = document.getElementById('folderUpBtn');
    const homeBtn = document.getElementById('folderHomeBtn');
    const selectBtn = document.getElementById('selectFolderBtn');
    const cancelBtn = document.getElementById('cancelFolderBtn');
    const showHiddenCheckbox = document.getElementById('showHiddenFolders') as HTMLInputElement | null;
    const createFolderBtn = document.getElementById('createFolderBtn');
    const confirmCreateBtn = document.getElementById('confirmCreateFolderBtn');
    const cancelCreateBtn = document.getElementById('cancelCreateFolderBtn');
    const newFolderInput = document.getElementById('newFolderNameInput') as HTMLInputElement | null;

    upBtn?.addEventListener('click', () => this.navigateToParent());
    homeBtn?.addEventListener('click', () => this.navigateToHome());
    selectBtn?.addEventListener('click', () => this.selectCurrentFolder());
    cancelBtn?.addEventListener('click', () => this.close());
    showHiddenCheckbox?.addEventListener('change', () =>
      this.loadFolders(this.app.currentFolderPath),
    );
    createFolderBtn?.addEventListener('click', () => this.showCreateFolderInput());
    confirmCreateBtn?.addEventListener('click', () => this.createFolder());
    cancelCreateBtn?.addEventListener('click', () => this.hideCreateFolderInput());

    newFolderInput?.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        this.createFolder();
      } else if (e.key === 'Escape') {
        this.hideCreateFolderInput();
      }
    });

    modal?.addEventListener('click', (e: Event) => {
      if (e.target === modal) {
        this.close();
      }
    });
  }

  async show(): Promise<void> {
    const modal = document.getElementById('folderBrowserModal');
    if (!modal) return;
    modal.classList.add('active');

    if (this.app.isMobile) {
      document.body.style.overflow = 'hidden';
    }

    await this.loadFolders();
  }

  close(): void {
    const modal = document.getElementById('folderBrowserModal');
    if (modal) modal.classList.remove('active');

    if (this.app.isMobile) {
      document.body.style.overflow = '';
    }

    this.app.isCreatingNewSession = false;
  }

  async loadFolders(path: string | null = null): Promise<void> {
    const showHidden = (document.getElementById('showHiddenFolders') as HTMLInputElement | null)
      ?.checked;
    const params = new URLSearchParams();
    if (path) params.append('path', path);
    if (showHidden) params.append('showHidden', 'true');

    try {
      const response = await this.app.authFetch(`/api/folders?${params}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to load folders');
      }

      const data: FolderData = await response.json();
      this.app.currentFolderPath = data.currentPath;
      this.renderFolders(data);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to load folders:', error);
      showError(`Failed to load folders: ${msg}`);
    }
  }

  renderFolders(data: FolderData): void {
    const pathInput = document.getElementById('currentPathInput') as HTMLInputElement | null;
    const folderList = document.getElementById('folderList');
    const upBtn = document.getElementById('folderUpBtn') as HTMLButtonElement | null;

    if (pathInput) pathInput.value = data.currentPath;
    if (upBtn) upBtn.disabled = !data.parentPath;

    if (!folderList) return;
    folderList.innerHTML = '';

    if (data.folders.length === 0) {
      folderList.innerHTML = '<div class="empty-folder-message">No folders found</div>';
      return;
    }

    data.folders.forEach((folder) => {
      const folderItem = document.createElement('div');
      folderItem.className = 'folder-item';
      folderItem.innerHTML = `
        <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="folder-name">${folder.name}</span>
      `;
      folderItem.addEventListener('click', () => this.loadFolders(folder.path));
      folderList.appendChild(folderItem);
    });
  }

  async navigateToParent(): Promise<void> {
    if (this.app.currentFolderPath) {
      const parentPath =
        this.app.currentFolderPath.split('/').slice(0, -1).join('/') || '/';
      await this.loadFolders(parentPath);
    }
  }

  async navigateToHome(): Promise<void> {
    await this.loadFolders();
  }

  private showCreateFolderInput(): void {
    const createBar = document.getElementById('folderCreateBar');
    const input = document.getElementById('newFolderNameInput') as HTMLInputElement | null;
    if (createBar) createBar.style.display = 'flex';
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  private hideCreateFolderInput(): void {
    const createBar = document.getElementById('folderCreateBar');
    const input = document.getElementById('newFolderNameInput') as HTMLInputElement | null;
    if (createBar) createBar.style.display = 'none';
    if (input) input.value = '';
  }

  async createFolder(): Promise<void> {
    const input = document.getElementById('newFolderNameInput') as HTMLInputElement | null;
    const folderName = input?.value.trim();

    if (!folderName) {
      showError('Please enter a folder name');
      return;
    }

    if (folderName.includes('/') || folderName.includes('\\')) {
      showError('Folder name cannot contain path separators');
      return;
    }

    try {
      const response = await this.app.authFetch('/api/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPath: this.app.currentFolderPath || '/',
          folderName,
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
