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
          omp: cfg.aliases.omp || 'Oh My Pi',
          antigravity: cfg.aliases.antigravity || 'Antigravity',
          terminal: 'Terminal',
        };
      }
      if (typeof cfg.folderMode === 'boolean') {
        app.folderMode = cfg.folderMode;
      }

      shellStore.setState({
        user: cfg?.currentUser?.githubLogin ?? null,
        logoutUrl: cfg?.logoutUrl ?? null,
        // The approval preference belongs to the account, so this — the boot
        // request every page already makes — is where it arrives. Anything
        // other than a literal `true` is "ask", which covers an older server
        // that sends no preferences at all as well as a corrupt one.
        chatBypassPermissions: cfg?.preferences?.chatBypassPermissions === true,
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
  if (kind === 'omp') return 'Oh My Pi';
  if (kind === 'antigravity') return 'Antigravity';
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

  if (kind === 'omp') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'omp')} (auto-approving every tool call)...`
      : `Starting ${getAlias(app, 'omp')}...`;
  }

  if (kind === 'antigravity') {
    return options.dangerouslySkipPermissions
      ? `Starting ${getAlias(app, 'antigravity')} (auto-approving every tool permission)...`
      : `Starting ${getAlias(app, 'antigravity')}...`;
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
