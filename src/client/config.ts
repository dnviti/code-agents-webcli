// Configuration: load server config and provide alias helpers

import type { App } from './app';
import type { AgentKind, Aliases, RuntimeStartOptions } from './types';
import * as icons from './utils/icons';

export async function loadConfig(app: App): Promise<void> {
  try {
    const res = await app.authFetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      if (cfg?.aliases) {
        app.aliases = {
          claude: cfg.aliases.claude || 'Claude',
          codex: cfg.aliases.codex || 'Codex',
          agent: cfg.aliases.agent || 'Cursor',
          terminal: 'Terminal',
        };
      }
      if (typeof cfg.folderMode === 'boolean') {
        app.folderMode = cfg.folderMode;
      }

      const currentUserBadge = document.getElementById('currentUserBadge');
      const logoutLink = document.getElementById('logoutLink') as HTMLAnchorElement | null;
      if (cfg?.currentUser && currentUserBadge) {
        currentUserBadge.textContent = `@${cfg.currentUser.githubLogin}`;
        currentUserBadge.style.display = 'inline-flex';
      }
      if (cfg?.logoutUrl && logoutLink) {
        logoutLink.href = cfg.logoutUrl;
        logoutLink.style.display = 'inline-flex';
      }
    }
  } catch {
    // best-effort
  }
}

export function getAlias(app: App, kind: AgentKind | string): string {
  if (app.aliases && (app.aliases as any)[kind]) {
    return (app.aliases as any)[kind];
  }
  if (kind === 'codex') return 'Codex';
  if (kind === 'agent') return 'Cursor';
  if (kind === 'terminal') return 'Terminal';
  return 'Claude';
}

export function getRuntimeLabel(
  app: App,
  kind: AgentKind | string | undefined,
  runtimeLabel: string | undefined,
  fallback = 'Claude',
): string {
  if (runtimeLabel) return runtimeLabel;
  if (kind) return getAlias(app, kind);
  return fallback;
}

export function getRuntimeStartMessage(
  app: App,
  kind: AgentKind,
  options: RuntimeStartOptions = {},
): string {
  if (kind === 'codex') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'codex')} (bypassing approvals and sandbox)...`
      : `Starting ${getAlias(app, 'codex')}...`;
  }

  if (kind === 'agent') {
    return `Starting ${getAlias(app, 'agent')}...`;
  }

  if (kind === 'terminal') {
    if (options.mode === 'command') {
      return `Running ${options.command}...`;
    }
    return `Starting ${options.shell || getAlias(app, 'terminal')}...`;
  }

  return options.dangerouslySkipPermissions
    ? `Starting ${getAlias(app, 'claude')} (skipping permissions)...`
    : `Starting ${getAlias(app, 'claude')}...`;
}

export function applyAliasesToUI(app: App): void {
  const startBtn = document.getElementById('startBtn');
  const dangerousSkipBtn = document.getElementById('dangerousSkipBtn');
  const startCodexBtn = document.getElementById('startCodexBtn');
  const dangerousCodexBtn = document.getElementById('dangerousCodexBtn');
  const startAgentBtn = document.getElementById('startAgentBtn');
  const startTerminalBtn = document.getElementById('startTerminalBtn');

  if (startBtn) startBtn.textContent = `Start ${getAlias(app, 'claude')}`;
  if (dangerousSkipBtn) dangerousSkipBtn.textContent = `Dangerous ${getAlias(app, 'claude')}`;
  if (startCodexBtn) startCodexBtn.textContent = `Start ${getAlias(app, 'codex')}`;
  if (dangerousCodexBtn) dangerousCodexBtn.textContent = `Dangerous ${getAlias(app, 'codex')}`;
  if (startAgentBtn) startAgentBtn.textContent = `Start ${getAlias(app, 'agent')}`;
  if (startTerminalBtn) startTerminalBtn.textContent = `Start ${getAlias(app, 'terminal')}`;

  const planTitle = document.querySelector('#planModal .modal-header h2');
  if (planTitle) {
    planTitle.innerHTML = `<span class="icon" aria-hidden="true">${icons.clipboard(18)}</span> ${getAlias(app, 'claude')}'s Plan`;
  }
}
