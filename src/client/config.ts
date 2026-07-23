// Configuration: load server config and provide alias helpers

import type { App } from './app';
import type { AgentKind, RuntimeStartOptions } from './types';
import { shellStore } from './shell/store';

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
          pi: cfg.aliases.pi || 'Pi',
          grok: cfg.aliases.grok || 'Grok',
          qwen: cfg.aliases.qwen || 'Qwen',
          kimi: cfg.aliases.kimi || 'Kimi',
          terminal: 'Terminal',
        };
      }
      if (typeof cfg.folderMode === 'boolean') {
        app.folderMode = cfg.folderMode;
      }

      shellStore.setState({
        user: cfg?.currentUser?.githubLogin ?? null,
        logoutUrl: cfg?.logoutUrl ?? null,
      });
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
  if (kind === 'pi') return 'Pi';
  if (kind === 'grok') return 'Grok';
  if (kind === 'qwen') return 'Qwen';
  if (kind === 'kimi') return 'Kimi';
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

  if (kind === 'pi') {
    return `Starting ${getAlias(app, 'pi')}...`;
  }

  if (kind === 'grok') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'grok')} (auto-approving every tool call)...`
      : `Starting ${getAlias(app, 'grok')}...`;
  }

  if (kind === 'qwen') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'qwen')} (auto-accepting every action)...`
      : `Starting ${getAlias(app, 'qwen')}...`;
  }

  if (kind === 'kimi') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'kimi')} (auto-approving every action)...`
      : `Starting ${getAlias(app, 'kimi')}...`;
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
