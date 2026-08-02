/** Safe, HTTP-only repository access and cloning for project workspaces. */

import { EnvironmentEngine } from '../environments/engine.js';
import { randomUUID } from 'node:crypto';

export type RepositoryAccess =
  | { ok: true; host: string }
  | { ok: false; reason: 'validation' | 'credential_required' | 'repo_gone' | 'unreachable'; message: string; host?: string };

export interface FetchResponseLike {
  status: number;
}

export type FetchLike = (url: string, init?: {
  method?: string;
  redirect?: 'error';
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<FetchResponseLike>;

export const REPOSITORY_PREFLIGHT_TIMEOUT_MS = 10_000;
export const REPOSITORY_CLONE_TIMEOUT_MS = 5 * 60_000;

export function repositoryUrl(input: string): URL | null {
  try {
    // URL normalisation erases a trailing empty `?`/`#`; reject the raw
    // delimiters too so the persisted form is unambiguously request-free.
    if (input.includes('?') || input.includes('#')) return null;
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Credentials and request modifiers belong to the connected-host record,
    // never to the durable URL copied into errors, git argv and the database.
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

/** The smart-HTTP advertisement is a read-only access check; no git runs here. */
export async function checkRepositoryAccess(
  repoUrl: string,
  fetch_: FetchLike = fetch,
  credential?: string | null,
  timeoutMs = REPOSITORY_PREFLIGHT_TIMEOUT_MS,
): Promise<RepositoryAccess> {
  const url = repositoryUrl(repoUrl);
  if (!url) {
    return { ok: false, reason: 'validation', message: 'Repository URL must be plain HTTP(S) without credentials, query or fragment' };
  }
  if (credential && url.protocol !== 'https:') {
    return { ok: false, reason: 'validation', message: 'Repository credentials require HTTPS', host: url.host.toLowerCase() };
  }
  const refs = new URL(`${url.pathname.replace(/\/+$/, '')}/info/refs`, url);
  refs.searchParams.set('service', 'git-upload-pack');
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref();
    });
    const response = await Promise.race([
      fetch_(refs.toString(), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        ...(credential ? { headers: { Authorization: `bearer ${credential}` } } : {}),
      }),
      timedOut,
    ]);
    if (response.status === 200) {
      return { ok: true, host: url.host.toLowerCase() };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'credential_required', host: url.host.toLowerCase(), message: 'Repository credentials are required' };
    }
    if (response.status === 404) {
      return credential
        ? { ok: false, reason: 'repo_gone', host: url.host.toLowerCase(), message: 'Repository was not found' }
        : { ok: false, reason: 'credential_required', host: url.host.toLowerCase(), message: 'Repository credentials may be required' };
    }
    return { ok: false, reason: 'unreachable', host: url.host.toLowerCase(), message: `Repository access check returned HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      host: url.host.toLowerCase(),
      message: redact(`Repository access check failed: ${(error as Error).message}`, credential),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class CloneError extends Error {}

export function repoBaseName(repoUrl: string): string {
  const url = repositoryUrl(repoUrl);
  const last = (url?.pathname.split('/').filter(Boolean).pop() || 'repository').replace(/\.git$/i, '');
  return last || 'repository';
}

function redact(message: string, token: string | null | undefined): string {
  return token ? message.split(token).join('***') : message;
}

/**
 * Configuration for a Git transport that must not inherit a project's Git
 * settings. In particular, `url.*.insteadOf` and `pushInsteadOf` could turn
 * the recorded URL into an attacker endpoint after we attach a host token.
 */
export function isolatedGitNetworkInvocation(
  gitArgs: string[],
  credential?: string | null,
  alternateObjects?: string,
): { command: string; args: string[]; input?: string } {
  const assignments = [
    'PATH=/usr/local/bin:/usr/bin:/bin',
    // Do not let curl/Git discover a user-controlled .netrc or XDG file.
    'HOME=/nonexistent',
    'XDG_CONFIG_HOME=/nonexistent',
    'LC_ALL=C',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_CONFIG_SYSTEM=/dev/null',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_ASKPASS=/bin/false',
    'GIT_TERMINAL_PROMPT=0',
    'GIT_ALLOW_PROTOCOL=http:https',
  ];
  const git = `exec git ${credential ? '--config-env=http.extraHeader=CAWC_GIT_HTTP_EXTRA_HEADER ' : ''}-c core.hooksPath=/dev/null -c credential.helper= -c http.followRedirects=false -c protocol.allow=never -c protocol.http.allow=always -c protocol.https.allow=always "$@"`;
  const inner = credential
    ? `IFS= read -r CAWC_GIT_BEARER_TOKEN || exit 1; CAWC_GIT_HTTP_EXTRA_HEADER="AUTHORIZATION: bearer $CAWC_GIT_BEARER_TOKEN"; export CAWC_GIT_HTTP_EXTRA_HEADER; ${git}`
    : git;
  const outer = alternateObjects
    ? `CAWC_GIT_ALTERNATE_OBJECTS=$1; shift; exec /usr/bin/env -i ${assignments.join(' ')} GIT_ALTERNATE_OBJECT_DIRECTORIES="$CAWC_GIT_ALTERNATE_OBJECTS" /bin/sh -c '${inner}' sh "$@"`
    : `exec /usr/bin/env -i ${assignments.join(' ')} /bin/sh -c '${inner}' sh "$@"`;
  return {
    // `env -i` drops inherited Git config, proxy, trace and credential-helper
    // variables. The shell program is fixed; Git arguments are passed as `$@`.
    command: '/bin/sh',
    args: ['-c', outer, 'sh', ...(alternateObjects ? [alternateObjects] : []), ...gitArgs],
    ...(credential ? { input: `${credential}\n` } : {}),
  };
}

/** Clone inside the project container without ever writing an auth token to disk. */
export async function cloneRepository(options: {
  engine: EnvironmentEngine;
  containerName: string;
  containerIdentity: string;
  repoUrl: string;
  destination: string;
  credential?: string | null;
  timeoutMs?: number;
}): Promise<void> {
  const { engine, containerName, containerIdentity, repoUrl, destination, credential } = options;
  const timeoutMs = options.timeoutMs ?? REPOSITORY_CLONE_TIMEOUT_MS;
  if (!containerIdentity) throw new CloneError('Verified project container identity is required');
  const url = repositoryUrl(repoUrl);
  if (!url || (credential && url.protocol !== 'https:')) {
    throw new CloneError(credential ? 'Repository credentials require HTTPS' : 'Invalid repository URL');
  }
  if (credential && /[\r\n\0]/.test(credential)) throw new CloneError('Repository credential contains an unsafe line break');
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  let didTimeout = false;
  const isolatedCwd = `/tmp/cawc-clone-${randomUUID()}`;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reject(new CloneError(`Repository clone timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));
    timeout.unref();
  });
  try {
    await Promise.race([
      engine.exec(
        { name: containerName, identity: containerIdentity, signal: controller.signal },
        'mkdir',
        ['-m', '700', '--', isolatedCwd],
      ),
      timedOut,
    ]);
    const transport = isolatedGitNetworkInvocation(['clone', '--', repoUrl, destination], credential);
    await Promise.race([
      engine.exec(
        { name: containerName, identity: containerIdentity, cwd: isolatedCwd, signal: controller.signal, input: transport.input },
        transport.command,
        transport.args,
      ),
      timedOut,
    ]);
  } catch (error) {
    if (didTimeout) throw new CloneError(`Repository clone timed out after ${timeoutMs}ms`);
    if (error instanceof CloneError) throw error;
    const err = error as Error & { stderr?: string };
    throw new CloneError(redact((err.stderr || err.message || String(error)).trim(), credential));
  } finally {
    if (timeout) clearTimeout(timeout);
    const cleanupController = new AbortController();
    let cleanupTimeout: NodeJS.Timeout | null = null;
    try {
      const cleanupTimedOut = new Promise<never>((_resolve, reject) => {
        cleanupTimeout = setTimeout(() => {
          cleanupController.abort();
          reject(new Error('isolated clone cleanup timed out'));
        }, Math.min(Math.max(1, timeoutMs), 10_000));
        cleanupTimeout.unref();
      });
      await Promise.race([
        engine.exec(
          { name: containerName, identity: containerIdentity, signal: cleanupController.signal },
          'rm',
          ['-rf', '--', isolatedCwd],
        ),
        cleanupTimedOut,
      ]);
    } catch { /* The isolated cwd contains no owner work or credentials. */ }
    finally { if (cleanupTimeout) clearTimeout(cleanupTimeout); }
  }
}
