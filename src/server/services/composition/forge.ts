/** Fixed forge client selection and tmpfs-only credential materialisation. */

import path from 'node:path';
import {
  PINNED_TEA_VERSION,
  TEA_TMPFS_XDG_CONFIG_HOME,
  type ContainerCommandRunner,
} from './provisioner.js';

export type ForgeKind = 'github' | 'gitlab' | 'gitea' | 'forgejo';
export type ForgeCli = 'gh' | 'glab' | 'tea';

export interface ForgeDefinition {
  kind: ForgeKind;
  cli: ForgeCli;
  version: string;
  installer: 'mise' | 'direct';
}

export const FORGE_CATALOG: Readonly<Record<ForgeKind, ForgeDefinition>> = Object.freeze({
  github: { kind: 'github', cli: 'gh', version: '2.97.0', installer: 'mise' },
  gitlab: { kind: 'gitlab', cli: 'glab', version: '1.111.0', installer: 'mise' },
  gitea: { kind: 'gitea', cli: 'tea', version: PINNED_TEA_VERSION, installer: 'direct' },
  forgejo: { kind: 'forgejo', cli: 'tea', version: PINNED_TEA_VERSION, installer: 'direct' },
});

/** Public hosts are unambiguous; enterprise/unknown hosts require a user choice. */
export function forgeForHost(hostInput: string, chosenKind?: ForgeKind): ForgeDefinition | null {
  const host = normaliseHost(hostInput);
  if (chosenKind) return FORGE_CATALOG[chosenKind];
  if (host === 'github.com') return FORGE_CATALOG.github;
  if (host === 'gitlab.com') return FORGE_CATALOG.gitlab;
  return null;
}

export const FORGE_SCRATCH_ROOT = '/run/code-agents-forge';

export function forgeEnvironment(): Readonly<Record<string, string>> {
  return {
    HOME: `${FORGE_SCRATCH_ROOT}/home`,
    XDG_CONFIG_HOME: `${FORGE_SCRATCH_ROOT}/xdg`,
    GH_CONFIG_DIR: `${FORGE_SCRATCH_ROOT}/gh`,
    GLAB_CONFIG_DIR: `${FORGE_SCRATCH_ROOT}/glab`,
    TEA_CONFIG: `${TEA_TMPFS_XDG_CONFIG_HOME}/tea/config.yml`,
  };
}

export class ForgeCredentialMaterializer {
  constructor(private readonly runner: ContainerCommandRunner) {}

  /**
   * Tokens are sent only as stdin. The returned value is non-secret metadata
   * safe for logs and container inspection.
   */
  async materialize(input: {
    host: string;
    kind: ForgeKind;
    token: string;
  }): Promise<{ cli: ForgeCli; host: string; configRoot: string }> {
    const host = normaliseHost(input.host);
    validateToken(input.token);
    const definition = FORGE_CATALOG[input.kind];
    const env = forgeEnvironment();

    if (definition.cli === 'gh') {
      await this.runner.run('gh', ['auth', 'login', '--hostname', host, '--with-token'], {
        cwd: FORGE_SCRATCH_ROOT,
        env,
        input: `${input.token}\n`,
      });
    } else if (definition.cli === 'glab') {
      await this.runner.run('glab', ['auth', 'login', '--hostname', host, '--stdin'], {
        cwd: FORGE_SCRATCH_ROOT,
        env,
        input: `${input.token}\n`,
      });
    } else {
      const directory = path.posix.dirname(env.TEA_CONFIG);
      await this.runner.run('mkdir', ['-p', '-m', '0700', directory], {
        cwd: FORGE_SCRATCH_ROOT,
        env,
      });
      // JSON is valid YAML and gives token/host escaping a well-defined parser.
      const contents = JSON.stringify({
        logins: [{ name: host, url: `https://${host}`, token: input.token, default: true }],
      });
      await this.runner.run('install', ['-m', '0600', '/dev/stdin', env.TEA_CONFIG], {
        cwd: FORGE_SCRATCH_ROOT,
        env,
        input: contents,
      });
    }
    return {
      cli: definition.cli,
      host,
      configRoot: definition.cli === 'tea'
        ? path.posix.dirname(env.TEA_CONFIG)
        : env[definition.cli === 'gh' ? 'GH_CONFIG_DIR' : 'GLAB_CONFIG_DIR'],
    };
  }
}

function normaliseHost(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('@')) {
    throw new Error('forge host is invalid');
  }
  let url: URL;
  try {
    url = new URL(`https://${input}`);
  } catch {
    throw new Error('forge host is invalid');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || url.hostname !== url.hostname.toLowerCase()) {
    throw new Error('forge host is invalid');
  }
  const host = url.host.toLowerCase();
  if (host !== input.toLowerCase() || host.length > 253) throw new Error('forge host is invalid');
  return host;
}

function validateToken(token: string): void {
  if (typeof token !== 'string' || !token || token.length > 16_384
    || token.includes('\0') || token.includes('\r') || token.includes('\n')) {
    throw new Error('forge credential is invalid');
  }
}
