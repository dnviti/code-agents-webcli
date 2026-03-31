// Session tab management: create, switch, reorder, and close tabs

import type { App } from '../app';
import type { SessionInfo } from '../types';

export class SessionTabManager {
  app: App;
  tabs: Map<string, HTMLElement>;
  activeSessions: Map<string, SessionInfo>;
  activeTabId: string | null;
  tabOrder: string[];
  tabHistory: string[];
  notificationsEnabled: boolean;

  constructor(app: App) {
    this.app = app;
    this.tabs = new Map();
    this.activeSessions = new Map();
    this.activeTabId = null;
    this.tabOrder = [];
    this.tabHistory = [];
    this.notificationsEnabled = false;
    this.requestNotificationPermission();
  }

  getAlias(kind: string): string {
    return this.app.getAlias(kind as any);
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  requestNotificationPermission(): void {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      this.notificationsEnabled = true;
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => {
        this.notificationsEnabled = permission === 'granted';
      });
    }
  }

  sendNotification(title: string, body: string, sessionId: string): void {
    if (sessionId === this.activeTabId) return;
    if (document.visibilityState === 'visible') return;

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag: sessionId,
          requireInteraction: false,
          silent: false,
        });

        notification.onclick = () => {
          window.focus();
          this.switchToTab(sessionId);
          notification.close();
        };

        setTimeout(() => notification.close(), 5000);
        return;
      } catch {
        // fall through to mobile fallback
      }
    }

    this.showMobileNotification(title, body, sessionId);
  }

  private showMobileNotification(title: string, body: string, sessionId: string): void {
    const originalTitle = document.title;
    let flashCount = 0;
    const flashInterval = setInterval(() => {
      document.title = flashCount % 2 === 0 ? `\u2022 ${title}` : originalTitle;
      flashCount++;
      if (flashCount > 6) {
        clearInterval(flashInterval);
        document.title = originalTitle;
      }
    }, 1000);

    if ('vibrate' in navigator) {
      try { navigator.vibrate([200, 100, 200]); } catch { /* unsupported */ }
    }

    const toast = document.createElement('div');
    toast.className = 'mobile-notification';
    toast.style.cssText = `
      position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
      background: #3b82f6; color: white; padding: 12px 20px;
      border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10001; max-width: 90%; text-align: center; cursor: pointer;
      animation: slideDown 0.3s ease-out;
    `;
    toast.innerHTML = `
      <div style="font-weight:bold;margin-bottom:4px;">${title}</div>
      <div style="font-size:14px;opacity:0.9;">${body}</div>
    `;

    this.injectMobileNotificationStyles();

    toast.onclick = () => {
      this.switchToTab(sessionId);
      toast.style.animation = 'slideUp 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    };

    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.animation = 'slideUp 0.3s ease-out';
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);

    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      // audio not available
    }
  }

  private injectMobileNotificationStyles(): void {
    if (document.querySelector('#mobileNotificationStyles')) return;
    const style = document.createElement('style');
    style.id = 'mobileNotificationStyles';
    style.textContent = `
      @keyframes slideDown {
        from { transform: translateX(-50%) translateY(-100%); opacity: 0; }
        to   { transform: translateX(-50%) translateY(0);     opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateX(-50%) translateY(0);     opacity: 1; }
        to   { transform: translateX(-50%) translateY(-100%); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Tab ordering helpers
  // ---------------------------------------------------------------------------

  getOrderedTabIds(): string[] {
    this.tabOrder = this.tabOrder.filter((id) => this.tabs.has(id));
    return [...this.tabOrder];
  }

  getOrderedTabElements(): HTMLElement[] {
    return this.getOrderedTabIds()
      .map((id) => this.tabs.get(id))
      .filter(Boolean) as HTMLElement[];
  }

  syncOrderFromDom(): void {
    const tabsContainer = document.getElementById('tabsContainer');
    if (!tabsContainer) return;
    const ids = Array.from(tabsContainer.querySelectorAll<HTMLElement>('.session-tab'))
      .map((tab) => tab.dataset.sessionId)
      .filter(Boolean) as string[];
    if (ids.length) this.tabOrder = ids;
  }

  ensureTabVisible(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    const scrollContainer = tab.closest('.tabs-section');
    if (!scrollContainer) return;
    const tabRect = tab.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    if (tabRect.left < containerRect.left) {
      scrollContainer.scrollLeft += tabRect.left - containerRect.left - 16;
    } else if (tabRect.right > containerRect.right) {
      scrollContainer.scrollLeft += tabRect.right - containerRect.right + 16;
    }
  }

  updateTabHistory(sessionId: string): void {
    this.tabHistory = this.tabHistory.filter((id) => id !== sessionId && this.tabs.has(id));
    this.tabHistory.unshift(sessionId);
    if (this.tabHistory.length > 50) this.tabHistory.length = 50;
  }

  removeFromHistory(sessionId: string): void {
    this.tabHistory = this.tabHistory.filter((id) => id !== sessionId);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    this.setupTabBar();
    this.setupKeyboardShortcuts();
    this.setupOverflowDropdown();
    await this.loadSessions();
    this.updateTabOverflow();

    setTimeout(() => this.checkAndPromptForNotifications(), 2000);
  }

  private checkAndPromptForNotifications(): void {
    if (!('Notification' in window) || Notification.permission !== 'default') return;

    const promptDiv = document.createElement('div');
    promptDiv.style.cssText = `
      position: fixed; top: 60px; right: 20px;
      background: #1e293b; border: 1px solid #475569;
      border-radius: 8px; padding: 12px 16px;
      color: #e2e8f0; font-size: 14px; z-index: 10000;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3); max-width: 300px;
    `;
    promptDiv.innerHTML = `
      <div style="margin-bottom:10px;">
        <strong>Enable Desktop Notifications?</strong><br>
        Get notified when ${this.getAlias('claude')} completes tasks in background tabs.
      </div>
      <div style="display:flex;gap:10px;">
        <button id="enableNotifications" style="background:#3b82f6;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px;">Enable</button>
        <button id="dismissNotifications" style="background:#475569;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px;">Not Now</button>
      </div>
    `;
    document.body.appendChild(promptDiv);

    document.getElementById('enableNotifications')!.onclick = () => {
      this.requestNotificationPermission();
      promptDiv.remove();
    };
    document.getElementById('dismissNotifications')!.onclick = () => promptDiv.remove();

    setTimeout(() => { if (promptDiv.parentNode) promptDiv.remove(); }, 10000);
  }

  // ---------------------------------------------------------------------------
  // Tab bar setup
  // ---------------------------------------------------------------------------

  setupTabBar(): void {
    const tabsContainer = document.getElementById('tabsContainer');
    const newTabBtn = document.getElementById('tabNewBtn');

    newTabBtn?.addEventListener('click', () => this.createNewSession());

    if (!tabsContainer) return;

    tabsContainer.addEventListener('dragstart', (e: DragEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('session-tab')) return;
      e.dataTransfer!.effectAllowed = 'copyMove';
      const sid = target.dataset.sessionId;
      if (sid) {
        e.dataTransfer!.setData('text/plain', sid);
        e.dataTransfer!.setData('application/x-session-id', sid);
        e.dataTransfer!.setData('x-source-pane', '-1');
      }
      target.classList.add('dragging');
    });

    tabsContainer.addEventListener('dragend', (e: DragEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('session-tab')) {
        target.classList.remove('dragging');
        this.syncOrderFromDom();
        this.updateTabOverflow();
        this.updateOverflowMenu();
      }
    });

    tabsContainer.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      const draggingTab = tabsContainer.querySelector('.dragging');
      if (!draggingTab) return;
      const afterElement = this.getDragAfterElement(tabsContainer, e.clientX);
      if (!afterElement) {
        tabsContainer.appendChild(draggingTab);
      } else {
        tabsContainer.insertBefore(draggingTab, afterElement);
      }
    });

    tabsContainer.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
    });
  }

  setupOverflowDropdown(): void {
    const overflowBtn = document.getElementById('tabOverflowBtn');
    const overflowMenu = document.getElementById('tabOverflowMenu');

    overflowBtn?.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      overflowMenu?.classList.toggle('active');
      this.updateOverflowMenu();
    });

    document.addEventListener('click', (e: Event) => {
      if (
        !overflowMenu?.contains(e.target as Node) &&
        !overflowBtn?.contains(e.target as Node)
      ) {
        overflowMenu?.classList.remove('active');
      }
    });

    window.addEventListener('resize', () => {
      this.updateTabOverflow();
      this.updateOverflowMenu();
    });
  }

  updateTabOverflow(): void {
    const isMobile = window.innerWidth <= 768;
    const overflowWrapper = document.getElementById('tabOverflowWrapper');
    const overflowCount = document.querySelector('.tab-overflow-count');

    if (!isMobile) {
      this.tabs.forEach((tab) => { tab.style.display = ''; });
      if (overflowWrapper) overflowWrapper.style.display = 'none';
      if (overflowCount) overflowCount.textContent = '';
      return;
    }

    const tabsArray = this.getOrderedTabElements();
    tabsArray.forEach((tab, index) => {
      tab.style.display = index < 2 ? '' : 'none';
    });

    if (tabsArray.length > 2) {
      if (overflowWrapper) {
        overflowWrapper.style.display = 'flex';
        if (overflowCount) overflowCount.textContent = String(tabsArray.length - 2);
      }
    } else {
      if (overflowWrapper) overflowWrapper.style.display = 'none';
      if (overflowCount) overflowCount.textContent = '';
    }
  }

  updateOverflowMenu(): void {
    const menu = document.getElementById('tabOverflowMenu');
    if (!menu) return;

    const overflowIds = this.getOrderedTabIds().slice(2);
    menu.innerHTML = '';

    overflowIds.forEach((sessionId) => {
      const tabElement = this.tabs.get(sessionId);
      const session = this.activeSessions.get(sessionId);
      if (!tabElement || !session) return;

      const item = document.createElement('div');
      item.className = 'overflow-tab-item';
      if (sessionId === this.activeTabId) item.classList.add('active');

      const nameEl = tabElement.querySelector('.tab-name');
      item.innerHTML = `
        <span class="overflow-tab-name">${nameEl?.textContent ?? ''}</span>
        <span class="overflow-tab-close" data-session-id="${sessionId}" title="Close tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </span>
      `;

      item.addEventListener('click', async (e: Event) => {
        if (!(e.target as HTMLElement).classList.contains('overflow-tab-close')) {
          await this.switchToTab(sessionId);
          menu.classList.remove('active');
          setTimeout(() => {
            this.updateTabOverflow();
            this.updateOverflowMenu();
          }, 150);
        }
      });

      const closeBtn = item.querySelector('.overflow-tab-close');
      closeBtn?.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        this.closeSession(sessionId);
        menu.classList.remove('active');
      });

      menu.appendChild(item);
    });
  }

  setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        this.createNewSession();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) this.closeSession(this.activeTabId);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        this.switchToNextTab();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        this.switchToPreviousTab();
      }
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        this.switchToTabByIndex(parseInt(e.key) - 1);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Session loading
  // ---------------------------------------------------------------------------

  async loadSessions(): Promise<any[]> {
    try {
      const response = await fetch('/api/sessions/list');
      const data = await response.json();
      const sessions: any[] = data.sessions || [];

      sessions.forEach((session: any, index: number) => {
        this.addTab(session.id, session.name, session.active ? 'active' : 'idle', session.workingDir, false);
        const sessionData = this.activeSessions.get(session.id);
        if (sessionData) {
          sessionData.lastAccessed = Date.now() - (sessions.length - index) * 1000;
        }
      });

      if (window.innerWidth <= 768) {
        this.reorderTabsByLastAccessed();
      }

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Tab CRUD
  // ---------------------------------------------------------------------------

  addTab(
    sessionId: string,
    sessionName: string,
    status: SessionInfo['status'] = 'idle',
    workingDir: string | null = null,
    autoSwitch = true,
  ): void {
    const tabsContainer = document.getElementById('tabsContainer');
    if (!tabsContainer || this.tabs.has(sessionId)) return;

    const tab = document.createElement('div');
    tab.className = 'session-tab';
    tab.dataset.sessionId = sessionId;
    tab.draggable = true;

    const isDefaultSessionName = sessionName.startsWith('Session ') && sessionName.includes(':');
    const folderName = workingDir ? workingDir.split('/').pop() || '/' : null;
    const displayName = !isDefaultSessionName ? sessionName : (folderName || sessionName);

    tab.innerHTML = `
      <div class="tab-content">
        <span class="tab-status ${status}"></span>
        <span class="tab-name" title="${workingDir || sessionName}">${displayName}</span>
      </div>
      <span class="tab-close" title="Close tab">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </span>
    `;

    tab.addEventListener('click', async (e: Event) => {
      if (!(e.target as HTMLElement).closest('.tab-close')) {
        await this.switchToTab(sessionId);
      }
    });

    tab.querySelector('.tab-close')?.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      this.closeSession(sessionId);
    });

    tab.addEventListener('dblclick', (e: Event) => {
      if (!(e.target as HTMLElement).closest('.tab-close')) {
        this.renameTab(sessionId);
      }
    });

    tab.addEventListener('auxclick', (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        this.closeSession(sessionId);
      }
    });

    tab.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.openTabContextMenu(sessionId, e.clientX, e.clientY);
    });

    tabsContainer.appendChild(tab);
    this.tabs.set(sessionId, tab);
    if (!this.tabOrder.includes(sessionId)) {
      this.tabOrder.push(sessionId);
    }

    this.activeSessions.set(sessionId, {
      id: sessionId,
      name: sessionName,
      status,
      workingDir,
      lastAccessed: Date.now(),
      lastActivity: Date.now(),
      unreadOutput: false,
      hasError: false,
    });

    this.updateTabOverflow();
    this.updateOverflowMenu();

    if (this.tabs.size === 1 && autoSwitch) {
      this.switchToTab(sessionId);
    }
  }

  async switchToTab(sessionId: string, options: { skipHistoryUpdate?: boolean } = {}): Promise<void> {
    if (!this.tabs.has(sessionId)) return;

    if (
      this.activeTabId === sessionId &&
      this.app.currentClaudeSessionId === sessionId
    ) {
      this.updateHeaderInfo(sessionId);
      return;
    }

    this.tabs.forEach((tab) => tab.classList.remove('active'));

    const tab = this.tabs.get(sessionId);
    if (!tab) return;
    tab.classList.add('active');
    this.activeTabId = sessionId;
    this.ensureTabVisible(sessionId);

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
      if (session.unreadOutput) this.updateUnreadIndicator(sessionId, false);
    }

    if (!options.skipHistoryUpdate) {
      this.updateTabHistory(sessionId);
    }

    if (window.innerWidth <= 768) {
      const tabIndex = this.getOrderedTabIds().indexOf(sessionId);
      if (tabIndex >= 2) this.reorderTabsByLastAccessed();
    }

    this.updateOverflowMenu();

    await this.app.joinSession(sessionId);
    this.updateHeaderInfo(sessionId);
  }

  reorderTabsByLastAccessed(): void {
    const tabsContainer = document.getElementById('tabsContainer');
    if (!tabsContainer) return;

    const sortedIds = this.getOrderedTabIds().sort((a, b) => {
      const sa = this.activeSessions.get(a);
      const sb = this.activeSessions.get(b);
      return (sb?.lastAccessed ?? 0) - (sa?.lastAccessed ?? 0);
    });

    sortedIds.forEach((sessionId) => {
      const el = this.tabs.get(sessionId);
      if (el) tabsContainer.appendChild(el);
    });

    this.tabOrder = sortedIds;
    this.updateTabOverflow();
  }

  closeSession(sessionId: string, { skipServerRequest = false } = {}): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;

    const orderedIds = this.getOrderedTabIds();
    const closedIndex = orderedIds.indexOf(sessionId);

    tab.remove();
    this.tabs.delete(sessionId);
    this.activeSessions.delete(sessionId);
    this.tabOrder = orderedIds.filter((id) => id !== sessionId);
    this.removeFromHistory(sessionId);

    this.updateTabOverflow();
    this.updateOverflowMenu();

    if (!skipServerRequest) {
      fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(
        (err) => console.error('Failed to delete session:', err),
      );
    }

    if (this.activeTabId === sessionId) {
      this.activeTabId = null;
      let fallbackId = this.tabHistory.find((id) => this.tabs.has(id));
      if (!fallbackId && this.tabOrder.length > 0) {
        const nextIndex = closedIndex >= 0 ? Math.min(closedIndex, this.tabOrder.length - 1) : 0;
        fallbackId = this.tabOrder[nextIndex];
      }
      if (fallbackId) {
        this.switchToTab(fallbackId);
      }
    }
  }

  renameTab(sessionId: string): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;

    const nameSpan = tab.querySelector('.tab-name') as HTMLElement | null;
    if (!nameSpan) return;
    const currentName = nameSpan.textContent || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'tab-name-input';
    input.style.width = '100%';

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const saveNewName = () => {
      const newName = input.value.trim() || currentName;
      const newNameSpan = document.createElement('span');
      newNameSpan.className = 'tab-name';
      newNameSpan.textContent = newName;
      input.replaceWith(newNameSpan);

      const session = this.activeSessions.get(sessionId);
      if (session) session.name = newName;
    };

    input.addEventListener('blur', saveNewName);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveNewName();
      else if (e.key === 'Escape') {
        input.value = currentName;
        saveNewName();
      }
    });
  }

  closeOthers(sessionId: string): void {
    this.getOrderedTabIds().forEach((id) => {
      if (id !== sessionId) this.closeSession(id);
    });
  }

  openTabContextMenu(sessionId: string, clientX: number, clientY: number): void {
    document.querySelectorAll('.pane-session-menu').forEach((m) => m.remove());

    const menu = document.createElement('div');
    menu.className = 'pane-session-menu';

    const addItem = (label: string, fn: () => void) => {
      const el = document.createElement('div');
      el.className = 'pane-session-item';
      el.textContent = label;
      el.onclick = () => { try { fn(); } finally { menu.remove(); } };
      return el;
    };

    menu.appendChild(addItem('Close Others', () => this.closeOthers(sessionId)));
    document.body.appendChild(menu);
    menu.style.top = `${clientY + 4}px`;
    menu.style.left = `${clientX + 4}px`;

    const close = (ev: Event) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  createNewSession(): void {
    this.app.isCreatingNewSession = true;
    this.app.folderBrowser.show();
  }

  // ---------------------------------------------------------------------------
  // Tab navigation
  // ---------------------------------------------------------------------------

  switchToNextTab(): void {
    if (this.tabHistory.length > 1) {
      const nextId = this.tabHistory.find((id) => id !== this.activeTabId && this.tabs.has(id));
      if (nextId) { this.switchToTab(nextId); return; }
    }
    const tabIds = this.getOrderedTabIds();
    if (tabIds.length === 0) return;
    const currentIndex = tabIds.indexOf(this.activeTabId || '');
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tabIds.length : 0;
    this.switchToTab(tabIds[nextIndex]);
  }

  switchToPreviousTab(): void {
    const tabIds = this.getOrderedTabIds();
    if (tabIds.length === 0) return;
    const currentIndex = tabIds.indexOf(this.activeTabId || '');
    const prevIndex = currentIndex >= 0 ? (currentIndex - 1 + tabIds.length) % tabIds.length : tabIds.length - 1;
    this.switchToTab(tabIds[prevIndex]);
  }

  switchToTabByIndex(index: number): void {
    const tabIds = this.getOrderedTabIds();
    if (index < tabIds.length) this.switchToTab(tabIds[index]);
  }

  // ---------------------------------------------------------------------------
  // Status updates
  // ---------------------------------------------------------------------------

  updateHeaderInfo(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      const workingDirEl = document.getElementById('workingDir');
      if (workingDirEl && session.workingDir) {
        workingDirEl.textContent = session.workingDir;
      }
    }
  }

  updateTabStatus(sessionId: string, status: SessionInfo['status']): void {
    const tab = this.tabs.get(sessionId);
    if (!tab) return;

    const statusEl = tab.querySelector('.tab-status');
    if (statusEl) {
      const session = this.activeSessions.get(sessionId);
      const wasActive = session?.status === 'active';
      const hasUnread = statusEl.classList.contains('unread');

      statusEl.className = `tab-status ${status}`;

      if (wasActive && status === 'idle' && sessionId !== this.activeTabId) {
        statusEl.classList.add('unread');
        if (session) session.unreadOutput = true;
      } else if (hasUnread) {
        statusEl.classList.add('unread');
      }

      if (status === 'active') {
        statusEl.classList.add('pulse');
      } else {
        statusEl.classList.remove('pulse');
      }
    }

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastActivity = Date.now();
      if (status !== 'error') session.hasError = false;
    }
  }

  markSessionActivity(sessionId: string, hasOutput = false, outputData = ''): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const previousActivity = session.lastActivity || 0;
    const wasActive = session.status === 'active';
    session.lastActivity = Date.now();

    if (hasOutput) {
      this.updateTabStatus(sessionId, 'active');

      clearTimeout(session.idleTimeout);
      clearTimeout(session.workCompleteTimeout);

      session.workCompleteTimeout = setTimeout(() => {
        const s = this.activeSessions.get(sessionId);
        if (s && s.status === 'active') {
          this.updateTabStatus(sessionId, 'idle');
          if (wasActive && sessionId !== this.activeTabId) {
            const sessionName = s.name || 'Session';
            const duration = Date.now() - previousActivity;
            s.unreadOutput = true;
            this.updateUnreadIndicator(sessionId, true);
            this.sendNotification(
              `${sessionName} -- ${this.getAlias('claude')} appears finished`,
              `No output for 90 seconds (worked for ${Math.round(duration / 1000)}s)`,
              sessionId,
            );
          }
        }
      }, 90000);

      session.idleTimeout = setTimeout(() => {
        // 5-minute backstop; the 90-second timeout handles the transition
      }, 300000);
    }

    if (hasOutput && outputData) {
      this.checkForCommandCompletion(sessionId, outputData, previousActivity);
    }
  }

  private checkForCommandCompletion(
    sessionId: string,
    outputData: string,
    previousActivity: number,
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const completionPatterns = [
      /build\s+successful/i,
      /compilation\s+finished/i,
      /tests?\s+passed/i,
      /deployment\s+complete/i,
      /npm\s+install.*completed/i,
      /successfully\s+compiled/i,
      /\u2713\s+All\s+tests\s+passed/i,
      /Done\s+in\s+\d+\.\d+s/i,
    ];

    const hasCompletion = completionPatterns.some((p) => p.test(outputData));

    if (hasCompletion && sessionId !== this.activeTabId) {
      let message = 'Task completed successfully';
      if (/build\s+successful/i.test(outputData)) message = 'Build completed successfully';
      else if (/tests?\s+passed/i.test(outputData)) message = 'All tests passed';
      else if (/deployment\s+complete/i.test(outputData)) message = 'Deployment completed';

      session.unreadOutput = true;
      this.updateUnreadIndicator(sessionId, true);
      this.sendNotification(session.name || 'Session', message, sessionId);
    }
  }

  updateUnreadIndicator(sessionId: string, hasUnread: boolean): void {
    const tab = this.tabs.get(sessionId);
    if (tab) {
      const statusEl = tab.querySelector('.tab-status');
      if (hasUnread) {
        tab.classList.add('has-unread');
        statusEl?.classList.add('unread');
      } else {
        tab.classList.remove('has-unread');
        statusEl?.classList.remove('unread');
      }
    }

    const session = this.activeSessions.get(sessionId);
    if (session) session.unreadOutput = hasUnread;
  }

  markSessionError(sessionId: string, hasError = true): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.hasError = hasError;
    if (hasError) {
      this.updateTabStatus(sessionId, 'error');
      this.sendNotification(
        `Error in ${session.name || 'Session'}`,
        'A command has failed or the session encountered an error',
        sessionId,
      );
    }
  }

  getDragAfterElement(container: HTMLElement, x: number): HTMLElement | undefined {
    const draggableElements = Array.from(
      container.querySelectorAll<HTMLElement>('.session-tab:not(.dragging)'),
    );

    return draggableElements.reduce<{ offset: number; element: HTMLElement | undefined }>(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = x - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: undefined },
    ).element;
  }
}
