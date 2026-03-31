// Mobile-specific UI: detection, mode switching, mobile sessions modal

import type { App } from '../app';
import * as icons from '../utils/icons';

export function detectMobile(): boolean {
  const hasTouchScreen =
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0;

  const mobileUserAgent =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const smallViewport = window.innerWidth <= 1024;

  return hasTouchScreen && (mobileUserAgent || smallViewport);
}

export function disablePullToRefresh(): void {
  let lastY = 0;

  const findScrollableAncestor = (target: EventTarget | null): HTMLElement | null => {
    let node = target instanceof HTMLElement ? target : null;

    while (node && node !== document.body) {
      const styles = window.getComputedStyle(node);
      const overflowY = styles.overflowY;
      const canScroll =
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
        && node.scrollHeight > node.clientHeight;

      if (canScroll) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  };

  document.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      lastY = e.touches[0].clientY;
    },
    { passive: false },
  );

  document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (e.defaultPrevented) {
        lastY = e.touches[0].clientY;
        return;
      }

      const y = e.touches[0].clientY;
      const isPullingDown = y > lastY;
      const scrollableAncestor = findScrollableAncestor(e.target);

      if (scrollableAncestor) {
        const maxScrollTop = Math.max(0, scrollableAncestor.scrollHeight - scrollableAncestor.clientHeight);
        const canUseScrollableAncestor = isPullingDown
          ? scrollableAncestor.scrollTop > 0
          : scrollableAncestor.scrollTop < maxScrollTop;

        if (canUseScrollableAncestor) {
          lastY = y;
          return;
        }
      }

      const scrollTop =
        window.pageYOffset ||
        document.documentElement.scrollTop ||
        document.body.scrollTop ||
        0;

      if (scrollTop === 0 && isPullingDown) {
        e.preventDefault();
      }

      lastY = y;
    },
    { passive: false },
  );
}

export function showModeSwitcher(app: App): void {
  if (document.getElementById('modeSwitcher')) return;

  const modeSwitcher = document.createElement('div');
  modeSwitcher.id = 'modeSwitcher';
  modeSwitcher.className = 'mode-switcher';
  modeSwitcher.innerHTML = `
    <button id="escapeBtn" class="escape-btn" title="Send Escape key">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </button>
    <button id="modeSwitcherBtn" class="mode-switcher-btn" data-mode="${app.currentMode}"
        title="Switch mode (Shift+Tab)">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
      </svg>
    </button>
  `;
  document.body.appendChild(modeSwitcher);

  document.getElementById('modeSwitcherBtn')?.addEventListener('click', () => switchMode(app));
  document.getElementById('escapeBtn')?.addEventListener('click', () => sendEscape(app));
}

export function sendEscape(app: App): void {
  if (app.socket && app.socket.readyState === WebSocket.OPEN) {
    app.send({ type: 'input', data: '\x1b' });
  }

  const btn = document.getElementById('escapeBtn');
  if (btn) {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 200);
  }
}

export function switchMode(app: App): void {
  const modes = ['chat', 'code', 'plan'] as const;
  const currentIndex = modes.indexOf(app.currentMode as (typeof modes)[number]);
  const nextIndex = (currentIndex + 1) % modes.length;
  app.currentMode = modes[nextIndex];

  const btn = document.getElementById('modeSwitcherBtn');
  if (btn) {
    btn.setAttribute('data-mode', app.currentMode);
    btn.title = `Switch mode (Shift+Tab) - Current: ${
      app.currentMode.charAt(0).toUpperCase() + app.currentMode.slice(1)
    }`;
    btn.classList.add('switching');
    setTimeout(() => btn.classList.remove('switching'), 300);
  }

  if (app.socket && app.socket.readyState === WebSocket.OPEN) {
    app.send({ type: 'input', data: '\x1b[Z' });
  }
}

export function toggleMobileMenu(): void {
  const mobileMenu = document.getElementById('mobileMenu');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  mobileMenu?.classList.toggle('active');
  hamburgerBtn?.classList.toggle('active');
}

export function closeMobileMenu(): void {
  const mobileMenu = document.getElementById('mobileMenu');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  mobileMenu?.classList.remove('active');
  hamburgerBtn?.classList.remove('active');
}

export function showMobileSessionsModal(app: App): void {
  const modal = document.getElementById('mobileSessionsModal');
  if (modal) modal.classList.add('active');

  if (app.isMobile) {
    document.body.style.overflow = 'hidden';
  }

  loadMobileSessions(app);
}

export function hideMobileSessionsModal(app: App): void {
  const modal = document.getElementById('mobileSessionsModal');
  if (modal) modal.classList.remove('active');

  if (app.isMobile) {
    document.body.style.overflow = '';
  }
}

export async function loadMobileSessions(app: App): Promise<void> {
  try {
    const response = await app.authFetch('/api/sessions/list');
    if (!response.ok) throw new Error('Failed to load sessions');

    const data = await response.json();
    app.claudeSessions = data.sessions;
    renderMobileSessionList(app);
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

export function renderMobileSessionList(app: App): void {
  const sessionList = document.getElementById('mobileSessionList');
  if (!sessionList) return;
  sessionList.innerHTML = '';

  if (app.claudeSessions.length === 0) {
    sessionList.innerHTML = '<div class="no-sessions">No active sessions</div>';
    return;
  }

  app.claudeSessions.forEach((session) => {
    const sessionItem = document.createElement('div');
    sessionItem.className = 'session-item';
    if (session.id === app.currentClaudeSessionId) {
      sessionItem.classList.add('active');
    }

    const statusIcon = `<span class="dot ${session.active ? 'dot-on' : 'dot-idle'}"></span>`;
    const clientsText =
      session.connectedClients === 1 ? '1 client' : `${session.connectedClients} clients`;

    const folderIcon = icons.folder(14);
    const workingDirHtml = session.workingDir
      ? `<div class="session-folder" title="${session.workingDir}"><span class="icon" aria-hidden="true">${folderIcon}</span> ${session.workingDir.split('/').pop() || '/'}</div>`
      : '';

    sessionItem.innerHTML = `
      <div class="session-info">
        <span class="session-status">${statusIcon}</span>
        <div class="session-details">
          <div class="session-name">${session.name}</div>
          <div class="session-meta">${clientsText} &bull; ${new Date(session.created).toLocaleTimeString()}</div>
          ${workingDirHtml}
        </div>
      </div>
      <div class="session-actions">
        ${
          session.id === app.currentClaudeSessionId
            ? '<button class="btn-icon" title="Leave session" data-action="leave"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></button>'
            : '<button class="btn-icon" title="Join session" data-action="join"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></button>'
        }
        <button class="btn-icon" title="Delete session" data-action="delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;

    sessionItem.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = (btn as HTMLElement).dataset.action;
        if (action === 'join') {
          if (app.sessionTabManager) {
            await app.sessionTabManager.switchToTab(session.id);
          } else {
            await app.joinSession(session.id);
          }
          hideMobileSessionsModal(app);
        } else if (action === 'leave') {
          app.leaveSession();
          hideMobileSessionsModal(app);
        } else if (action === 'delete') {
          if (confirm(`Delete session "${session.name}"?`)) {
            app.deleteSession(session.id);
          }
        }
      });
    });

    sessionList.appendChild(sessionItem);
  });
}

export function setupMobileSessionsModal(app: App): void {
  const closeMobileSessionsBtn = document.getElementById('closeMobileSessionsModal');
  const newSessionBtnMobile = document.getElementById('newSessionBtnMobile');

  closeMobileSessionsBtn?.addEventListener('click', () => hideMobileSessionsModal(app));

  newSessionBtnMobile?.addEventListener('click', () => {
    hideMobileSessionsModal(app);
    app.isCreatingNewSession = true;
    app.selectedWorkingDir = null;
    app.currentFolderPath = null;
    app.folderBrowser.show();
  });
}
