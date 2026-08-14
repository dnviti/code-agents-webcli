import os from 'node:os';
import path from 'node:path';

export const PROJECT_WORKSPACE = '/workspace';
export const PROJECT_OVERLAY = '/opt/code-agents-project';
export const FORGE_SCRATCH = '/run/code-agents-forge';

/** Portable app-owned root used by host-local projects. */
export function localProjectWorkspaceRoot(homeDir = os.homedir(), pathApi: Pick<typeof path, 'join'> = path): string {
  return pathApi.join(homeDir, '.cc-web', 'workspaces');
}

/** Secret-free, application-owned paths exposed in container metadata. */
export function projectContainerEnvironment(containerHome: string, login: string): Record<string, string> {
  const miseData = `${containerHome}/.local/share/code-agents/mise`;
  const miseShims = `${miseData}/shims`;
  return {
    HOME: containerHome,
    USER: login,
    TERM: 'xterm-256color',
    PATH: `${miseShims}:${containerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MISE_DATA_DIR: miseData,
    MISE_CACHE_DIR: `${containerHome}/.cache/code-agents/mise`,
    MISE_STATE_DIR: `${containerHome}/.local/state/code-agents/mise`,
    MISE_CONFIG_DIR: `${PROJECT_OVERLAY}/mise`,
    MISE_CONFIG_FILE: `${PROJECT_OVERLAY}/mise.toml`,
    MISE_SHIMS_DIR: miseShims,
    MISE_AUTO_INSTALL: '0',
    // App-generated project config includes the user's durable ~/.gitconfig
    // and may layer a project-only identity without mutating repository data.
    GIT_CONFIG_GLOBAL: `${PROJECT_OVERLAY}/gitconfig`,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: `${FORGE_SCRATCH}/gh`,
    GLAB_CONFIG_DIR: `${FORGE_SCRATCH}/glab`,
    // tea itself reads XDG_CONFIG_HOME; its app-owned launcher points there.
    // This metadata value names that same tmpfs file without containing a token.
    TEA_CONFIG: `${FORGE_SCRATCH}/xdg/tea/config.yml`,
  };
}
