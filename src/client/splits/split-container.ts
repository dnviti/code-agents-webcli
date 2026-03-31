// Split pane management: VS Code-style side-by-side terminals

import type { App } from '../app';
import type { Terminal, ITerminalOptions } from '@xterm/xterm';
import type { TerminalController } from '../terminal/controller';
import { createTerminalController } from '../terminal/controller';
import { stripUnsupportedTerminalSequences } from '../terminal/text';

// ---------------------------------------------------------------------------
// Single split pane with its own terminal + WebSocket
// ---------------------------------------------------------------------------

class Split {
  container: HTMLElement;
  index: number;
  app: App;
  sessionId: string | null;
  isActive: boolean;

  terminal: Terminal | null;
  controller: TerminalController | null;
  socket: WebSocket | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  manualDisconnect: boolean;

  constructor(container: HTMLElement, index: number, app: App) {
    this.container = container;
    this.index = index;
    this.app = app;
    this.sessionId = null;
    this.isActive = false;
    this.terminal = null;
    this.controller = null;
    this.socket = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.manualDisconnect = false;

    this.createTerminal();
  }

  private createTerminal(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'split-terminal-wrapper';

    const terminalDiv = document.createElement('div');
    terminalDiv.id = `split-terminal-${this.index}`;
    terminalDiv.className = 'split-terminal';
    wrapper.appendChild(terminalDiv);

    this.container.appendChild(wrapper);

    this.controller = createTerminalController({
      fontFamily: this.app.terminal?.options.fontFamily || 'JetBrains Mono, monospace',
      fontSize: this.app.terminal?.options.fontSize || 14,
      theme: this.app.terminal?.options.theme,
    });
    this.terminal = this.controller.terminal;
    this.controller.open(terminalDiv);

    this.terminal.onData((data: string) => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        const filteredData = stripUnsupportedTerminalSequences(data);
        if (filteredData) {
          this.socket.send(JSON.stringify({ type: 'input', data: filteredData }));
        }
      }
    });

    this.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    this.fit();
  }

  async setSession(sessionId: string | null): Promise<void> {
    if (this.sessionId === sessionId) return;

    if (this.socket) this.disconnect();
    this.sessionId = sessionId;
    if (sessionId) await this.connect(sessionId);
    this.updateActiveState();
  }

  private async connect(sessionId: string): Promise<void> {
    this.manualDisconnect = false;
    this.clearReconnectTimer();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}?sessionId=${encodeURIComponent(sessionId)}`;

    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;

      if (!this.terminal) {
        return;
      }

      const { cols, rows } = this.terminal;
      this.socket!.send(JSON.stringify({ type: 'resize', cols, rows }));
    };

    this.socket.onmessage = (event: MessageEvent) => {
      try {
        this.handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.error(`[Split ${this.index}] Error handling message:`, error);
      }
    };

    this.socket.onclose = () => {
      this.socket = null;

      if (this.manualDisconnect || !this.sessionId) {
        return;
      }

      this.scheduleReconnect();
    };
    this.socket.onerror = (error: Event) => {
      console.error(`[Split ${this.index}] WebSocket error:`, error);
    };
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'output':
        this.terminal?.write(stripUnsupportedTerminalSequences(msg.data));
        break;

      case 'session_joined':
        this.terminal?.reset();
        if (msg.outputBuffer && msg.outputBuffer.length > 0) {
          this.terminal?.write(stripUnsupportedTerminalSequences(msg.outputBuffer.join('')));
        }
        this.fit();
        break;

      case 'claude_started':
      case 'codex_started':
      case 'agent_started':
        break;

      case 'exit':
        this.terminal?.write('\r\n[Process exited]\r\n');
        break;

      case 'error':
        this.terminal?.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        break;
    }
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();

    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  fit(): void {
    this.controller?.fit();
  }

  updateActiveState(): void {
    if (this.isActive) {
      this.container.classList.add('split-active');
    } else {
      this.container.classList.remove('split-active');
    }
  }

  clear(): void {
    this.disconnect();
    this.sessionId = null;
    this.isActive = false;
    this.terminal?.reset();
    this.updateActiveState();
  }

  destroy(): void {
    this.disconnect();
    this.controller?.dispose();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= this.app.maxReconnectAttempts) {
      return;
    }

    const delay = this.app.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (!this.sessionId) {
        return;
      }

      this.connect(this.sessionId).catch((error) => {
        console.error(`[Split ${this.index}] Reconnection failed:`, error);
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// SplitContainer - orchestrates two side-by-side splits
// ---------------------------------------------------------------------------

export class SplitContainer {
  app: App;
  enabled: boolean;
  splits: Split[];
  activeSplitIndex: number;
  dividerPosition: number;

  private splitContainerEl!: HTMLElement;
  private divider!: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.enabled = false;
    this.splits = [];
    this.activeSplitIndex = 0;
    this.dividerPosition = 50;

    this.createSplitElements();
    this.restoreState();
    this.setupKeyboardShortcuts();
  }

  private createSplitElements(): void {
    const main = document.querySelector('.main');
    if (!main) return;

    this.splitContainerEl = document.createElement('div');
    this.splitContainerEl.className = 'split-container';
    this.splitContainerEl.style.display = 'none';

    const leftSplit = document.createElement('div');
    leftSplit.className = 'split-pane split-left';
    leftSplit.dataset.splitIndex = '0';

    this.divider = document.createElement('div');
    this.divider.className = 'split-divider';
    this.setupDividerDrag();

    const rightSplit = document.createElement('div');
    rightSplit.className = 'split-pane split-right';
    rightSplit.dataset.splitIndex = '1';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'split-close';
    closeBtn.title = 'Close Split (Ctrl+\\)';
    closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
    closeBtn.addEventListener('click', () => this.closeSplit());
    rightSplit.appendChild(closeBtn);

    this.splitContainerEl.appendChild(leftSplit);
    this.splitContainerEl.appendChild(this.divider);
    this.splitContainerEl.appendChild(rightSplit);
    main.appendChild(this.splitContainerEl);

    this.splits.push(new Split(leftSplit, 0, this.app));
    this.splits.push(new Split(rightSplit, 1, this.app));

    this.splits[0].isActive = true;
    this.splits[0].updateActiveState();

    leftSplit.addEventListener('click', () => this.focusSplit(0));
    rightSplit.addEventListener('click', () => this.focusSplit(1));
  }

  private setupDividerDrag(): void {
    let isDragging = false;
    let startX = 0;
    let startPosition = 50;

    this.divider.addEventListener('mousedown', (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      startPosition = this.dividerPosition;
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isDragging) return;
      const container = this.splitContainerEl.getBoundingClientRect();
      const delta = e.clientX - startX;
      const deltaPercent = (delta / container.width) * 100;
      this.dividerPosition = Math.max(20, Math.min(80, startPosition + deltaPercent));
      this.updateDividerPosition();
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.cursor = '';
        this.saveState();
      }
    });
  }

  private updateDividerPosition(): void {
    const leftSplit = this.splitContainerEl.querySelector('.split-left') as HTMLElement | null;
    const rightSplit = this.splitContainerEl.querySelector('.split-right') as HTMLElement | null;

    if (leftSplit && rightSplit) {
      leftSplit.style.width = `${this.dividerPosition}%`;
      rightSplit.style.width = `${100 - this.dividerPosition}%`;
      this.splits.forEach((split) => split.fit());
    }
  }

  async createSplit(sessionId: string): Promise<void> {
    if (this.enabled) return;

    this.enabled = true;

    const terminalContainer = document.getElementById('terminalContainer');
    if (terminalContainer) terminalContainer.style.display = 'none';

    this.splitContainerEl.style.display = 'flex';
    this.updateDividerPosition();

    const currentSessionId = this.app.currentClaudeSessionId;
    await this.splits[0].setSession(currentSessionId);
    await this.splits[1].setSession(sessionId);

    this.focusSplit(1);
    this.saveState();
  }

  closeSplit(): void {
    if (!this.enabled) return;

    this.enabled = false;
    this.splits.forEach((split) => split.disconnect());

    const terminalContainer = document.getElementById('terminalContainer');
    if (terminalContainer) terminalContainer.style.display = 'flex';

    this.splitContainerEl.style.display = 'none';

    this.splits.forEach((split, i) => {
      split.sessionId = null;
      split.isActive = i === 0;
      split.updateActiveState();
      split.terminal?.reset();
    });

    this.activeSplitIndex = 0;

    if (this.app.currentClaudeSessionId) {
      setTimeout(() => this.app.connect(), 100);
    }

    this.saveState();
  }

  focusSplit(index: number): void {
    if (index < 0 || index >= this.splits.length) return;
    if (this.activeSplitIndex === index) return;

    this.splits.forEach((split, i) => {
      split.isActive = i === index;
      split.updateActiveState();
    });

    this.activeSplitIndex = index;

    const split = this.splits[index];
    split.terminal?.focus();

    if (split.sessionId && this.app) {
      this.app.currentClaudeSessionId = split.sessionId;

      if (this.app.sessionTabManager) {
        this.app.sessionTabManager.tabs.forEach((t, id) => {
          if (id === split.sessionId) t.classList.add('active');
          else t.classList.remove('active');
        });
        this.app.sessionTabManager.activeTabId = split.sessionId;
      }
    }
  }

  async onTabSwitch(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const activeSplit = this.splits[this.activeSplitIndex];
    if (activeSplit) await activeSplit.setSession(sessionId);
  }

  applyTerminalAppearance(options: {
    fontSize: number;
    fontFamily: string;
    theme: ITerminalOptions['theme'];
  }): void {
    this.splits.forEach((split) => {
      if (!split.terminal) {
        return;
      }

      split.terminal.options.fontSize = options.fontSize;
      split.terminal.options.fontFamily = options.fontFamily;
      split.terminal.options.theme = options.theme;
      split.controller?.restoreViewport();
    });
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        if (this.enabled) this.closeSplit();
      }

      if ((e.metaKey || e.ctrlKey) && this.enabled) {
        if (e.key === '1') { e.preventDefault(); this.focusSplit(0); }
        else if (e.key === '2') { e.preventDefault(); this.focusSplit(1); }
      }
    });
  }

  private saveState(): void {
    try {
      const state = {
        enabled: this.enabled,
        dividerPosition: this.dividerPosition,
        activeSplitIndex: this.activeSplitIndex,
        sessions: this.splits.map((s) => s.sessionId),
      };
      localStorage.setItem('cc-web-splits', JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save split state:', error);
    }
  }

  private restoreState(): void {
    try {
      const saved = localStorage.getItem('cc-web-splits');
      if (!saved) return;
      const state = JSON.parse(saved);
      if (state.dividerPosition) this.dividerPosition = state.dividerPosition;
    } catch (error) {
      console.error('Failed to restore split state:', error);
    }
  }

  setupDropZones(): void {
    const terminalContainer = document.getElementById('terminalContainer');
    if (!terminalContainer) return;

    const dropZone = document.createElement('div');
    dropZone.className = 'split-drop-zone';
    dropZone.style.display = 'none';
    terminalContainer.appendChild(dropZone);

    terminalContainer.addEventListener('dragover', (e: DragEvent) => {
      if (this.enabled) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';

      const rect = terminalContainer.getBoundingClientRect();
      const isNearRightEdge = e.clientX > rect.right - 100;
      dropZone.style.display = isNearRightEdge ? 'block' : 'none';
    });

    terminalContainer.addEventListener('dragleave', () => {
      dropZone.style.display = 'none';
    });

    terminalContainer.addEventListener('drop', async (e: DragEvent) => {
      const sessionId = e.dataTransfer?.getData('application/x-session-id');
      if (!sessionId || sessionId === this.app.currentClaudeSessionId) {
        dropZone.style.display = 'none';
        return;
      }

      const rect = terminalContainer.getBoundingClientRect();
      const isNearRightEdge = e.clientX > rect.right - 100;

      if (isNearRightEdge && !this.enabled) {
        e.preventDefault();
        await this.createSplit(sessionId);
      }

      dropZone.style.display = 'none';
    });
  }
}
