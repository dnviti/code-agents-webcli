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

export interface PreserveAuthor {
  name: string;
  email: string;
}

export interface PreserveOptions {
  engine: EnvironmentEngine;
  /** The project's container, which must be running for git to execute in. */
  containerName: string;
  /** The checkout inside the container, e.g. `/workspace/my-repo`. */
  repoContainerPath: string;
  /** Who the WIP commit is attributed to: the user's GitHub name and email. */
  author: PreserveAuthor;
  /**
   * The connected-host token, when one is stored for the repo's host.
   * Passed as a one-shot `http.extraHeader` so it never lands in the repo's
   * own config, and redacted from every error this module produces.
   */
  credential?: string | null;
  now?: () => Date;
}

export type PreserveResult =
  | { preserved: false; clean: true }
  | { preserved: true; clean: false; branch: string; commit: string };

/** Preservation failed; the message is safe to show (credential-redacted). */
export class PreserveError extends Error {}

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

/**
 * Commit and push uncommitted work, or report there was none.
 *
 * Throws PreserveError on any failure — no credential, push denied, host
 * unreachable — because the caller's only safe response to a failed
 * preservation is to hold the rebuild and say why.
 */
export async function preserveProjectWork(options: PreserveOptions): Promise<PreserveResult> {
  const { engine, containerName, repoContainerPath, author, credential } = options;
  const now = options.now || (() => new Date());

  const exec = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await engine.exec({ name: containerName }, 'git', args);
      return stdout;
    } catch (error) {
      const err = error as Error & { stderr?: string };
      throw new PreserveError(
        redact((err.stderr || err.message || String(error)).trim(), credential),
      );
    }
  };

  // `-c http.extraHeader` rides on the single command that needs it. Writing
  // it into the repo's config would persist the token in the worktree — the
  // one place whose whole purpose is to be cloned from and discarded.
  const authArgs = credential ? ['-c', `http.extraHeader=AUTHORIZATION: bearer ${credential}`] : [];
  const inRepo = (args: string[]) => exec(['-C', repoContainerPath, ...authArgs, ...args]);

  let status: string;
  try {
    status = await inRepo(['status', '--porcelain']);
  } catch (error) {
    // A checkout that is not a git repository — a partial clone left by a
    // failed build — has nothing to preserve, and must not block the rebuild
    // that exists precisely to replace it.
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      return { preserved: false, clean: true };
    }
    throw error;
  }

  if (!status.trim()) {
    return { preserved: false, clean: true };
  }

  const head = (await inRepo(['rev-parse', '--short', 'HEAD'])).trim();
  const base = `cc-web/wip/${wipDate(now())}-${head}`;

  // The branch must not exist upstream: `ls-remote` answers empty for a free
  // name, and a taken name gets `-1`, `-2`, … until one is. Never force-push,
  // never reuse — a WIP branch somebody already fetched is a fact.
  let branch = base;
  for (let counter = 1; ; counter += 1) {
    const found = await inRepo(['ls-remote', '--heads', 'origin', branch]);
    if (!found.trim()) {
      break;
    }
    branch = `${base}-${counter}`;
  }

  await inRepo(['add', '-A']);
  await exec([
    '-C', repoContainerPath,
    '-c', `user.name=${author.name}`,
    '-c', `user.email=${author.email}`,
    'commit', '-m', `wip: preserve uncommitted work (${branch})`,
  ]);
  await inRepo(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const commit = (await inRepo(['rev-parse', 'HEAD'])).trim();

  return { preserved: true, clean: false, branch, commit };
}
