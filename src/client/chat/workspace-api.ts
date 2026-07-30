import type { AccountLimits, FileDiff } from '../../shared/chat-events.js';
import type { UsageBurn } from '../../shared/usage-records.js';
import type { GitChange } from '../../shared/git-status.js';

/**
 * The browser's half of the workspace routes.
 *
 * Thin on purpose: every one of these is a plain GET whose shape is decided by
 * `src/server/routes/workspace.ts`, and the panels are easier to read when the
 * fetch boilerplate is not repeated five times inside them.
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

export interface WorkspaceFiles {
  root: string;
  path: string;
  truncated: boolean;
  entries: WorkspaceEntry[];
}

export interface GitHead {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitOverview {
  repo: boolean;
  reason?: string;
  error?: string;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  changes?: GitChange[];
  remoteUrl?: string | null;
  head?: GitHead | null;
}

/**
 * The GitHub shapes live in `shared` and are re-exported here.
 *
 * The server normalises `gh`'s JSON into them before it answers, so the
 * definition the panel draws from and the definition the route produces are one
 * file. They were declared twice while the panel showed a title and an author;
 * they stopped being worth declaring twice the moment either side grew a field.
 */
export type {
  GitHubActor,
  GitHubChecks,
  GitHubIssue,
  GitHubLabel,
  GitHubOverview,
  GitHubPull,
  GitHubRef,
  GitHubRelation,
  GitHubReview,
} from '../../shared/github-items.js';
export { relationLabel, repoFromUrl, reviewDecisionLabel } from '../../shared/github-items.js';

export interface WorkspaceFile {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  language: string | null;
  content: string;
  binary: boolean;
  tooLarge: boolean;
  writable: boolean;
  /** Set when the file is offered read-only, saying which limit applies. */
  reason?: string;
}

export interface SaveResult {
  saved: boolean;
  mtimeMs: number;
  size: number;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    // A 404 that is not JSON is Express's own "no such route", not this API
    // answering. That is what a page newer than the server it is talking to
    // gets, and "Request failed (404)" gives the user nothing to act on —
    // least of all the one thing that fixes it.
    const contentType = response.headers.get('content-type') || '';
    if (response.status === 404 && !contentType.includes('json')) {
      throw new Error(
        'This server has no workspace API. It is running an older version than this page — '
          + 'restart the server and reload.',
      );
    }

    // Otherwise the body carries the server's own sentence; the status alone
    // tells a user nothing they can act on.
    const detail = await response
      .json()
      .then((body: { error?: string; message?: string }) => body.error || body.message)
      .catch(() => null);
    throw new Error(detail || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export function fetchFiles(sessionId: string, path?: string): Promise<WorkspaceFiles> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return getJson<WorkspaceFiles>(`/api/workspace/${encodeURIComponent(sessionId)}/files${query}`);
}

export function fetchGit(sessionId: string): Promise<GitOverview> {
  return getJson<GitOverview>(`/api/workspace/${encodeURIComponent(sessionId)}/git`);
}

export function fetchDiff(
  sessionId: string,
  options: { path?: string; staged?: boolean } = {},
): Promise<{ diffs: FileDiff[]; error?: string }> {
  const params = new URLSearchParams();
  if (options.path) params.set('path', options.path);
  if (options.staged) params.set('staged', '1');
  const query = params.toString();
  return getJson<{ diffs: FileDiff[]; error?: string }>(
    `/api/workspace/${encodeURIComponent(sessionId)}/git/diff${query ? `?${query}` : ''}`,
  );
}

export function fetchFile(sessionId: string, filePath: string): Promise<WorkspaceFile> {
  return getJson<WorkspaceFile>(
    `/api/workspace/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`,
  );
}

/**
 * Write a file back, carrying the version the editor opened.
 *
 * The server refuses when that version is stale, which is the case that
 * actually happens here: the agent is editing this same tree while the panel is
 * open. The refusal surfaces as a message the user can act on rather than as a
 * silent overwrite of work they never saw.
 */
export async function saveFile(
  sessionId: string,
  filePath: string,
  content: string,
  mtimeMs: number,
): Promise<SaveResult> {
  const response = await fetch(`/api/workspace/${encodeURIComponent(sessionId)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ path: filePath, content, mtimeMs }),
  });

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string; message?: string }) => body.error || body.message)
      .catch(() => null);
    throw new Error(detail || `Could not save (${response.status})`);
  }

  return (await response.json()) as SaveResult;
}

export function fetchGitHub(sessionId: string, refresh = false): Promise<GitHubOverview> {
  return getJson<GitHubOverview>(
    `/api/workspace/${encodeURIComponent(sessionId)}/github${refresh ? '?refresh=1' : ''}`,
  );
}

/**
 * What the account half of the status panel reads.
 *
 * Everything here is either a measurement this app took or a sentence about
 * what a runtime will say. Nothing is a ceiling: this replaced a `plan` object
 * carrying a token, dollar and message allowance selected out of a hand-written
 * table by a CLI flag whose default was the same for every install (#137).
 *
 * What the *provider* said about the account does not come through here at all.
 * It arrives on the conversation's own `limits` event and is read off the
 * transcript, because it is a fact about that conversation's work.
 */
export interface AccountStatus {
  /** The runtime this session runs, or null for one that has never started. */
  runtime: string | null;
  /** One sentence naming what this runtime reports about an account. */
  reporting: string;
  /**
   * The Claude CLI's own cached reading on this host, when it is recent enough
   * to stand behind. Describes the account the *server* is signed in as, never
   * the browser user's, which is why the panel says so beside it.
   */
  cached: (AccountLimits & { asOf: string }) | null;
  /** What this app measured for the signed-in user on this agent. */
  measured: UsageBurn | null;
}

/** What the status panel reads: the account, and the branch. */
export interface WorkspaceStatus {
  workingDir?: string;
  git: {
    repo: boolean;
    branch?: string | null;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    detached?: boolean;
    changed?: number;
  } | null;
  account: AccountStatus | null;
}

export function fetchStatus(sessionId: string): Promise<WorkspaceStatus> {
  return getJson<WorkspaceStatus>(`/api/workspace/${encodeURIComponent(sessionId)}/status`);
}

export type { GitHubComment, GitHubItem } from '../../shared/github-items.js';

/**
 * One issue or pull request, in full.
 *
 * `repo` names which repository it belongs to, and is only passed when the
 * reader followed a reference out of the session's own — where #5 is a
 * different issue with the same number, which is a worse failure than a link
 * that does not open.
 */
export function fetchGitHubItem(
  sessionId: string,
  kind: 'issue' | 'pr',
  number: number,
  repo?: string,
): Promise<{ kind: string; item: GitHubItem }> {
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return getJson(
    `/api/workspace/${encodeURIComponent(sessionId)}/github/${kind}/${number}${query}`,
  );
}

export interface FileFindResult {
  root: string;
  total: number;
  truncated: boolean;
  source: 'git' | 'walk';
  /** Paths relative to the working directory, best match first. */
  matches: string[];
}

/**
 * Rank the working tree against what has been typed after `@`.
 *
 * Ranked server-side rather than here: the index can be twenty thousand paths,
 * and shipping all of them to the browser so it can throw 19,960 of them away
 * would cost more than the request it saves.
 */
export function findFiles(
  sessionId: string,
  query: string,
  limit = 40,
): Promise<FileFindResult> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return getJson<FileFindResult>(
    `/api/workspace/${encodeURIComponent(sessionId)}/find?${params.toString()}`,
  );
}

/**
 * The URL a media element loads a file's bytes from.
 *
 * A URL rather than a fetch: an `<img>`, `<video>`, `<audio>` or PDF frame has
 * to do its own loading — that is what gives it progressive decoding, range
 * requests and a seek bar. Handing it a blob we fetched ourselves would mean
 * buffering a whole recording in memory to take all three away.
 */
export function rawFileUrl(sessionId: string, filePath: string): string {
  return (
    `/api/workspace/${encodeURIComponent(sessionId)}/raw`
    + `?path=${encodeURIComponent(filePath)}`
  );
}

/**
 * The folder a previewed page's relative references resolve against.
 *
 * A path-shaped URL, unlike `rawFileUrl`, because that is the whole point: a
 * browser resolves `./style.css` against the *directory* of the document's
 * URL, and a query string gives it no directory to work with. Each segment is
 * encoded on its own so the slashes survive as slashes.
 */
export function assetBaseUrl(sessionId: string, filePath: string): string {
  const parts = String(filePath || '').split('/').filter(Boolean);
  // The file's folder, not the file: a base href ending in a filename resolves
  // siblings against the folder above it.
  parts.pop();
  const directory = parts.map(encodeURIComponent).join('/');
  return (
    `/api/workspace/${encodeURIComponent(sessionId)}/asset/`
    + (directory ? `${directory}/` : '')
  );
}

/**
 * Save a file out of the project to wherever the browser puts downloads.
 *
 * A plain anchor with `download`, not a fetch: the file is already served by a
 * route that streams and supports ranges, and fetching it here would buffer a
 * recording in memory only to hand the same bytes back to the browser.
 */
export function downloadFile(sessionId: string, filePath: string): void {
  const anchor = document.createElement('a');
  anchor.href = rawFileUrl(sessionId, filePath);
  // The name the browser suggests. Without it the download is named after the
  // route — every file arriving as "raw".
  anchor.download = filePath.split('/').pop() || 'download';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export interface UploadResult {
  name: string;
  path: string;
  size: number;
}

/**
 * Put a file from the browser into a folder of the project.
 *
 * `overwrite` is false by default and the caller is expected to ask: a 409 here
 * means the name is taken, which is a question for the user rather than a
 * failure to report.
 */
export async function uploadIntoWorkspace(
  sessionId: string,
  directory: string,
  file: File,
  options: { overwrite?: boolean } = {},
): Promise<UploadResult> {
  const query = new URLSearchParams({ dir: directory || '.', name: file.name });
  if (options.overwrite) query.set('overwrite', '1');

  const response = await fetch(
    `/api/workspace/${encodeURIComponent(sessionId)}/upload?${query.toString()}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    },
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(payload.error || 'That file could not be uploaded'));
    // Carried so the caller can tell "name taken" from "refused", and offer to
    // replace rather than repeating the same failure.
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return {
    name: String(payload.name || file.name),
    path: String(payload.path || ''),
    size: Number(payload.size) || 0,
  };
}
