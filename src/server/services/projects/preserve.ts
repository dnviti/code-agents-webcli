/**
 * Preservation: the reason a rebuild never destroys uncommitted work.
 *
 * Before a project with a repo loses its container, whatever is uncommitted
 * in the working tree is committed to a `cc-web/wip/<date>-<short-sha>`
 * branch and pushed. The branch is always new — a name that already exists
 * upstream gets a counter appended until it is free — so preservation can
 * never overwrite a real branch, and never touches the default branch at
 * all. A project whose tree is clean preserves nothing and rebuilds
 * immediately; a project whose push fails blocks the rebuild rather than
 * gambling with the work.
 */

import { EnvironmentEngine } from '../environments/engine.js';
import { isolatedGitNetworkInvocation, repositoryUrl } from './clone.js';
import { REPOSITORY_CLONE_TIMEOUT_MS } from './clone.js';
import { randomUUID } from 'node:crypto';

export interface PreserveAuthor {
  name: string;
  email: string;
}

export interface PreserveOptions {
  engine: EnvironmentEngine;
  /** The project's container, which must be running for git to execute in. */
  containerName: string;
  /** Immutable Docker ID/Kubernetes UID verified for this lifecycle operation. */
  containerIdentity: string;
  /** The checkout inside the container, e.g. `/workspace/my-repo`. */
  repoContainerPath: string;
  /** Immutable URL recorded on the project row; never trust mutable `origin`. */
  repoUrl: string;
  /** Who the WIP commit is attributed to: the user's GitHub name and email. */
  author: PreserveAuthor;
  /**
   * The connected-host token, when one is stored for the repo's host.
   * Passed as a one-shot `http.extraHeader` so it never lands in the repo's
   * own config, and redacted from every error this module produces.
   */
  credential?: string | null;
  now?: () => Date;
  /** Bound ls-remote and push; abort reaches the engine subprocess. */
  timeoutMs?: number;
}

export type PreserveResult =
  | { preserved: false; clean: true }
  | { preserved: true; clean: false; branch: string; commit: string };

/** Preservation failed; the message is safe to show (credential-redacted). */
export class PreserveError extends Error {}

/** A collision storm must not turn a shutdown drain into an unbounded loop. */
const MAX_WIP_COLLISION_RETRIES = 8;

/** The date part of a WIP branch name: `2026-07-31`. */
function wipDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Any credential reaching an error message ends here instead. */
function redact(text: string, credential: string | null | undefined): string {
  if (!credential) {
    return text;
  }
  return text.split(credential).join('***');
}

/** Git's ref-lease rejection is the sole preservation error worth retrying. */
function isExpectedAbsentCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:stale info|\[rejected\]|already exists|cannot lock ref|fetch first)/i.test(message);
}

/**
 * Find nested Git worktrees which a top-level WIP commit cannot preserve.
 *
 * A top-level `git add -A` treats an embedded repository as a gitlink. That
 * records its HEAD, but cannot transfer its Git objects to the parent remote.
 * Even a clean nested repository can therefore contain a local-only commit
 * that reclaim would destroy. Search for both directory and file `.git`
 * entries: normal repositories use the former, while submodule worktrees
 * commonly use the latter.
 */
async function nestedRepositories(
  run: (command: string, args: string[]) => Promise<string>,
  repoContainerPath: string,
): Promise<string[]> {
  const normalizedRoot = repoContainerPath.replace(/\/+$/, '') || '/';
  const rootGitDir = normalizedRoot === '/' ? '/.git' : `${normalizedRoot}/.git`;
  let found: string;
  try {
    found = await run('find', [
      normalizedRoot,
      '-path', rootGitDir, '-prune',
      '-o', '(', '-type', 'd', '-name', '.git', '-print0', '-prune', ')',
      '-o', '(', '-type', 'f', '-name', '.git', '-print0', ')',
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PreserveError(`Could not inspect nested repositories (${message}); retained workspace requires manual recovery or explicit discard`);
  }

  return found.split('\0').filter(Boolean).map((gitPath) => gitPath.slice(0, -'/.git'.length));
}

/**
 * Commit and push uncommitted work, or report there was none.
 *
 * Throws PreserveError on any failure — no credential, push denied, host
 * unreachable — because the caller's only safe response to a failed
 * preservation is to hold the rebuild and say why.
 */
export async function preserveProjectWork(options: PreserveOptions): Promise<PreserveResult> {
  const { engine, containerName, containerIdentity, repoContainerPath, repoUrl, author, credential } = options;
  const now = options.now || (() => new Date());
  if (!containerIdentity) throw new PreserveError('Verified project container identity is required');
  const recorded = repositoryUrl(repoUrl);
  if (!recorded) throw new PreserveError('Invalid recorded repository URL');
  if (credential && recorded.protocol !== 'https:') {
    throw new PreserveError('Repository credentials require HTTPS');
  }
  if (credential && /[\r\n\0]/.test(credential)) throw new PreserveError('Repository credential contains an unsafe line break');

  const timeoutMs = options.timeoutMs ?? REPOSITORY_CLONE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  /** Every helper subprocess is bounded against one operation deadline. */
  const run = async (command: string, args: string[], env?: Record<string, string>, recovery = false, input?: string): Promise<string> => {
    const remaining = recovery ? timeoutMs : Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    try {
      const timedOutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new PreserveError(`Repository preservation timed out after ${timeoutMs}ms`));
        }, remaining);
        timeout.unref();
      });
      const { stdout } = await Promise.race([
        engine.exec({ name: containerName, identity: containerIdentity, signal: controller.signal, env, input }, command, args),
        timedOutPromise,
      ]);
      return stdout;
    } catch (error) {
      if (timedOut) throw new PreserveError(`Repository preservation timed out after ${timeoutMs}ms`);
      const err = error as Error & { stderr?: string };
      throw new PreserveError(
        redact((err.stderr || err.message || String(error)).trim(), credential),
      );
    } finally { if (timeout) clearTimeout(timeout); }
  };
  const exec = (args: string[], env?: Record<string, string>) => run('git', args, env);

  const inRepo = (args: string[]) => exec(['-C', repoContainerPath, ...args]);

  // Do this before treating a clean top-level status as permission to reclaim:
  // a clean nested HEAD may still exist only in this workspace.
  const nested = await nestedRepositories(run, repoContainerPath);
  if (nested.length) {
    const normalizedRoot = repoContainerPath.replace(/\/+$/, '') || '/';
    const rootPrefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
    const displayPaths = nested.map((nestedRoot) => nestedRoot.startsWith(rootPrefix)
      ? nestedRoot.slice(rootPrefix.length)
      : nestedRoot);
    throw new PreserveError(`Nested repositories cannot be preserved by the top-level WIP commit (${displayPaths.join(', ')}); push or back up each nested repository, then retry recovery, or discard explicitly`);
  }

  let status: string;
  try {
    status = await inRepo(['status', '--porcelain']);
  } catch (error) {
    // A non-repository may still contain the only copy of user work. It is
    // never evidence of cleanliness and therefore must block destruction.
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      throw new PreserveError('Repository metadata is missing or corrupt; retained workspace requires manual recovery or explicit discard');
    }
    throw error;
  }

  if (!status.trim()) {
    return { preserved: false, clean: true };
  }

  const originRaw = (await inRepo(['remote', 'get-url', 'origin'])).trim();
  const origin = repositoryUrl(originRaw);
  if (!origin || origin.protocol !== recorded.protocol || origin.host.toLowerCase() !== recorded.host.toLowerCase()) {
    throw new PreserveError('Repository origin no longer matches the recorded repository host');
  }

  const priorHead = (await inRepo(['rev-parse', 'HEAD'])).trim();
  const head = (await inRepo(['rev-parse', '--short', 'HEAD'])).trim();
  const sourceObjectLookup = isolatedGitNetworkInvocation([
    '-C', repoContainerPath,
    'rev-parse', '--path-format=absolute', '--git-path', 'objects',
  ]);
  const sourceObjects = (await run(sourceObjectLookup.command, sourceObjectLookup.args)).trim();
  if (!sourceObjects.startsWith('/')) throw new PreserveError('Could not locate repository objects for safe preservation');
  const base = `cc-web/wip/${wipDate(now())}-${head}`;

  // Do not use a check-then-push decision. A ref can be created after
  // ls-remote answers but before push. The empty expected value makes the
  // push itself an atomic "create only if absent" operation.
  let branch = base;
  const temporaryIndex = `/tmp/cawc-preserve-${randomUUID()}.index`;
  const indexEnv = {
    GIT_INDEX_FILE: temporaryIndex,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  let commit = '';
  let transportDirectory = '';
  try {
    // A private index plus commit-tree records tracked, staged and untracked
    // bytes without moving HEAD or changing the owner's real index/worktree.
    await exec(['-C', repoContainerPath, 'read-tree', 'HEAD'], indexEnv);
    await exec(['-C', repoContainerPath, 'add', '-A'], indexEnv);
    const tree = (await exec(['-C', repoContainerPath, 'write-tree'], indexEnv)).trim();
    commit = (await exec([
      '-C', repoContainerPath,
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      'commit-tree', tree, '-p', priorHead,
      '-m', `wip: preserve uncommitted work (${branch})`,
    ], indexEnv)).trim();
    if (!commit) throw new PreserveError('Git did not return a WIP commit id');
    transportDirectory = `/tmp/cawc-preserve-transport-${randomUUID()}`;
    await run('mkdir', ['-m', '700', '--', transportDirectory]);
    const transportInit = isolatedGitNetworkInvocation(['init', '--bare', '--quiet', transportDirectory], null, sourceObjects);
    await run(transportInit.command, transportInit.args);
    // The temporary bare repository has no project-local config. Its only view
    // of project data is the source object database, read as an alternate so
    // the WIP commit can be packed for the immutable recorded URL.
    const network = (args: string[]) => {
      const transport = isolatedGitNetworkInvocation([
        '--git-dir', transportDirectory,
        ...args,
      ], credential, sourceObjects);
      return run(transport.command, transport.args, undefined, false, transport.input);
    };
    for (let counter = 0; counter <= MAX_WIP_COLLISION_RETRIES; counter += 1) {
      branch = counter === 0 ? base : `${base}-${counter}`;
      try {
        await network([
          'push',
          `--force-with-lease=refs/heads/${branch}:`,
          repoUrl,
          `${commit}:refs/heads/${branch}`,
        ]);
        break;
      } catch (error) {
        if (!isExpectedAbsentCollision(error)) throw error;
        // Retry only after an authoritative post-failure lookup says this exact
        // candidate exists. Network/auth failures remain preservation failures.
        const found = await network(['ls-remote', '--heads', repoUrl, branch]);
        if (!found.trim()) throw error;
        if (counter === MAX_WIP_COLLISION_RETRIES) {
          throw new PreserveError(`Repository preservation branch collision limit (${MAX_WIP_COLLISION_RETRIES}) reached`);
        }
      }
    }
  } finally {
    // The private index contains path metadata but no credentials. Remove it
    // on every outcome; failure is non-destructive because HEAD/index/worktree
    // were never changed.
    try {
      await run('rm', ['-f', '--', temporaryIndex], undefined, true);
    } catch { /* A stale private index cannot make destructive continuation unsafe. */ }
    if (transportDirectory) {
      try {
        await run('rm', ['-rf', '--', transportDirectory], undefined, true);
      } catch { /* A stale isolated transport contains no owner work or credentials. */ }
    }
  }

  return { preserved: true, clean: false, branch, commit };
}
