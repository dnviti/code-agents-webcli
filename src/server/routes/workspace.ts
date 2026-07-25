import express, { Router, Request, Response } from 'express';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { languageForFile } from '../../shared/file-language.js';
import { rankFilePaths } from '../../shared/file-match.js';
import { looksLikeSvg, sniffMediaType } from '../../shared/media-sniff.js';
import { ATTACHMENT_DIR } from '../services/attachment-store.js';
import { PathValidation, SessionRecord } from '../types.js';
import { parseGitStatus, parseUnifiedDiff } from '../../shared/git-status.js';
import { getOwnedSession, requireUser } from './helpers.js';

/**
 * The workspace a chat session is working in: its files, its git state, and —
 * when `gh` is installed and signed in — the pull requests and issues on its
 * remote.
 *
 * Everything here shells out, so the rules are the same throughout and are not
 * negotiable per route:
 *
 *   - fixed argv, never a shell string, so a branch called `; rm -rf ~` is a
 *     branch name and not a command;
 *   - `cwd` is the session's own working directory, which the session layer
 *     already validated against the allowed base;
 *   - a timeout and an output cap, because a repository can be enormous and
 *     these handlers share an event loop with every live terminal;
 *   - `GIT_TERMINAL_PROMPT=0`, so a command that wants credentials fails
 *     instead of hanging forever on a prompt nobody can see.
 *
 * Exactly one route writes, and only to a file that already exists, only
 * inside the session's directory, only when the copy on disk is still the one
 * the browser opened, and never inside `.git`. Everything else is read-only —
 * staging, committing and pushing are things the agent does with the user
 * watching, and putting a second uncontrolled path to them behind a browser
 * button is not a trade this panel needs to make.
 *
 * Confinement follows symlinks (`confineReal`). A lexical check alone passes a
 * link inside the working tree that points at `/etc`, and an agent's working
 * tree is exactly the sort of place a symlink turns up.
 */

export interface WorkspaceRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  /**
   * The same base-directory check the session routes use.
   *
   * A session's working directory was validated when the session was created,
   * but the record is long-lived and persisted, and this is the layer that
   * turns it into filesystem access. Required rather than optional: a check
   * that a caller can leave out is a check that will eventually be left out.
   */
  validatePath(targetPath: string): PathValidation;
  /**
   * The subscription picture, when this server tracks one.
   *
   * Optional because it is genuinely optional: a server pointed at a runtime
   * with no plan attached has nothing true to say here, and the panel would
   * rather show one honest sentence than a meter of invented numbers.
   */
  usageAnalytics?: {
    currentPlan: string;
    planLimits: Record<string, unknown>;
    getAnalytics(): unknown;
  };
  usageReader?: {
    getCurrentSessionStats(): Promise<unknown>;
  };
}

const EXEC_TIMEOUT_MS = 10_000;
/** Enough for a large `git diff`; past it the panel says so rather than truncating silently. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Directory entries returned in one listing. A node_modules has far more. */
const MAX_ENTRIES = 2000;
/** How long a `gh` answer is reused. These are network calls on someone else's rate limit. */
const GH_CACHE_MS = 30_000;
/**
 * Largest file the editor will open. Past this the browser is being asked to
 * hold, highlight and re-render a document per keystroke that it cannot keep up
 * with — and a minified bundle or a lockfile is not what anyone opened the panel
 * to edit.
 */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/**
 * The largest file the browser may put into the project.
 *
 * Well above the editor's limit — this is for images, archives and recordings,
 * which is what people actually drop into a folder — and far below the raw
 * route's, because unlike a read this one is buffered whole in memory before
 * it lands on disk.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Bytes sampled when deciding whether a file is text at all. */
const SNIFF_BYTES = 8192;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Status and diff take the index lock by default to refresh stat
          // information. A panel that polls must not be able to block the
          // agent's own git commands.
          GIT_OPTIONAL_LOCKS: '0',
          // `gh` paginates through a pager when it thinks it has a terminal.
          GH_PAGER: 'cat',
          PAGER: 'cat',
          NO_COLOR: '1',
        },
      },
      (error, stdout, stderr) => {
        const failed = error as (Error & { code?: number | string }) | null;
        resolve({
          ok: !failed,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: typeof failed?.code === 'number' ? failed.code : failed ? -1 : 0,
        });
      },
    );
  });
}

/**
 * Resolve a client-supplied path and prove it stays inside the session.
 *
 * The same shape as ChatSessionManager.confine, and for the same reason: the
 * request arrives from a browser, and "list /etc" is a perfectly well-formed
 * request. The separator on the prefix test stops `/home/u/project-secrets`
 * passing as a child of `/home/u/project`.
 */
function confine(root: string, requested: string): string | null {
  const base = path.resolve(root);
  const resolved = path.resolve(base, requested || '.');
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * The same check, after following symlinks.
 *
 * `path.resolve` collapses `..` but knows nothing about links, so a symlink
 * inside the working tree pointing at `/etc` passes the lexical test and then
 * reads `/etc` — and an agent's working tree is exactly the kind of place a
 * symlink turns up. Both sides are realpath'd because the working directory
 * itself is often reached through one (`/tmp` on macOS, a home on a network
 * mount), and comparing a resolved child against an unresolved base rejects
 * every legitimate path underneath it.
 *
 * Returns null for "outside" and for "does not exist", which the callers report
 * differently; `missing` distinguishes them.
 */
async function confineReal(
  root: string,
  requested: string,
): Promise<{ path: string | null; base: string; missing: boolean }> {
  const lexical = confine(root, requested);
  if (!lexical) return { path: null, base: root, missing: false };

  let base: string;
  let target: string;
  try {
    base = await fsp.realpath(root);
  } catch {
    // The session's own directory is gone; nothing under it can be resolved.
    return { path: null, base: root, missing: true };
  }
  try {
    target = await fsp.realpath(lexical);
  } catch {
    return { path: null, base, missing: true };
  }

  if (target !== base && !target.startsWith(base + path.sep)) {
    return { path: null, base, missing: false };
  }
  // The resolved base travels with the result: every comparison downstream is
  // against a realpath'd target, and measuring it from an unresolved root gives
  // a relative path full of `..` that no prefix test can read.
  return { path: target, base, missing: false };
}

/**
 * Whether a path sits inside the repository's own metadata.
 *
 * Reading `.git` is harmless and occasionally useful; writing into it by hand
 * from a browser panel is a way to corrupt a repository with no undo, and
 * nothing about "open the file I clicked" implies wanting that.
 */
function insideGitDir(resolvedBase: string, resolvedTarget: string): boolean {
  // Both sides resolved, from confineReal. Comparing a realpath'd target
  // against an unresolved root — /tmp against /private/tmp on macOS, a home
  // behind a network mount — yields a relative path full of `..`, which starts
  // with neither `.git` nor anything else, and the guard fails open.
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (!relative || relative.startsWith('..')) return false;
  // *Any* segment, not just the first: a submodule and a nested checkout both
  // keep their metadata at `<subdir>/.git`, and corrupting those is as bad as
  // corrupting the outer one.
  return relative.split(path.sep).includes('.git');
}

/**
 * The largest file the raw route will stream.
 *
 * Far above MAX_EDIT_BYTES, because this serves screen recordings and nothing
 * is being held in memory — but still bounded, because it is one range request
 * per seek against a disk shared with every live terminal.
 */
const MAX_RAW_BYTES = 512 * 1024 * 1024;

/**
 * Types a previewed page needs its own parts served as.
 *
 * The `/raw` route decides from the bytes and never from the name, because
 * there the name comes from a client and a wrong answer is stored XSS. Here the
 * opposite is true and for a reason worth stating: a stylesheet and a script
 * have no recognisable header — they are just text — so sniffing returns
 * nothing, `nosniff` makes the browser refuse them, and every previewed page
 * renders unstyled. The extension is a fact about a file inside the session's
 * own directory, and everything this route serves is consumed inside a sandbox
 * with an opaque origin, so the worst a wrong answer can do is spoil a preview.
 *
 * Kept to an allowlist rather than a full mime table: anything not on it falls
 * through to sniffing and then to an opaque download, which is the same answer
 * `/raw` gives.
 */
const PREVIEW_TYPES: Record<string, { type: string; sandbox?: boolean }> = {
  css: { type: 'text/css; charset=utf-8' },
  js: { type: 'text/javascript; charset=utf-8' },
  mjs: { type: 'text/javascript; charset=utf-8' },
  json: { type: 'application/json; charset=utf-8' },
  map: { type: 'application/json; charset=utf-8' },
  txt: { type: 'text/plain; charset=utf-8' },
  html: { type: 'text/html; charset=utf-8', sandbox: true },
  htm: { type: 'text/html; charset=utf-8', sandbox: true },
  svg: { type: 'image/svg+xml', sandbox: true },
  woff: { type: 'font/woff' },
  woff2: { type: 'font/woff2' },
  ttf: { type: 'font/ttf' },
};

function previewContentType(head: Buffer, filePath: string): { contentType: string; sandbox: boolean } {
  const name = filePath.toLowerCase();
  const dot = name.lastIndexOf('.');
  const known = dot > 0 ? PREVIEW_TYPES[name.slice(dot + 1)] : undefined;
  if (known) return { contentType: known.type, sandbox: known.sandbox === true };

  const sniffed = rawContentType(head, filePath);
  return { contentType: sniffed.contentType, sandbox: sniffed.sandbox };
}

interface RawServe {
  contentType: string;
  /** False means an opaque download rather than something rendered in place. */
  inline: boolean;
  /** True for SVG, the one image format that is also an executable document. */
  sandbox: boolean;
}

/**
 * What to send a file back as.
 *
 * The sniff decides, with exactly one exception: SVG, which has no signature to
 * sniff for. That case requires the name to say `.svg` *and* the bytes to open
 * like markup, and is served under a `sandbox` CSP regardless — see
 * `looksLikeSvg` for why the shallow check is the right one.
 */
function rawContentType(head: Buffer, filePath: string): RawServe {
  const sniffed = sniffMediaType(head);
  if (sniffed) return { contentType: sniffed.mime, inline: true, sandbox: false };

  if (filePath.toLowerCase().endsWith('.svg') && looksLikeSvg(head)) {
    return { contentType: 'image/svg+xml', inline: true, sandbox: true };
  }

  // Unrecognised: an opaque download, never a type the caller chose.
  return { contentType: 'application/octet-stream', inline: false, sandbox: false };
}

/** The first `count` bytes of a file, for the sniff. */
async function readHead(filePath: string, count: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Parse a `Range` header into byte offsets, or report it unsatisfiable.
 *
 * Only the single-range form, which is the only one a media element sends.
 * Multipart ranges are answered with the whole file — allowed by the spec and
 * far better than a wrong response built from a header nothing here produces.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';

  let start: number;
  let end: number;
  if (!rawStart) {
    // `bytes=-500`: the last 500 bytes, which is how a player reads an index
    // stored at the end of a container.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function streamFile(res: Response, filePath: string, range: { start: number; end: number } | null): void {
  const stream = range
    ? createReadStream(filePath, { start: range.start, end: range.end })
    : createReadStream(filePath);

  stream.on('error', () => {
    // Headers are already out by the time a read fails mid-stream; the only
    // honest signal left is to drop the connection rather than append an error
    // document to a half-sent video.
    if (!res.headersSent) res.status(500).json({ error: 'read_failed' });
    else res.destroy();
  });
  stream.pipe(res);
}

/** True when a buffer is not text the editor can safely round-trip. */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, SNIFF_BYTES);
  // A NUL byte is the classic signal and the one git itself uses.
  if (sample.includes(0)) return true;
  try {
    // Invalid UTF-8 would be replaced with U+FFFD on the way out and written
    // back as that replacement, silently corrupting the file on save.
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

function sessionFor(deps: WorkspaceRoutesDeps, req: Request, res: Response): SessionRecord | null {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return null;
  }

  const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }

  if (!deps.validatePath(session.workingDir).valid) {
    // The allowed base can be narrowed between runs, and a restored session
    // record outlives the configuration that admitted it.
    res.status(403).json({ error: 'This session works outside the allowed area' });
    return null;
  }

  return session;
}

interface GhCacheEntry {
  at: number;
  payload: unknown;
}

interface FileIndex {
  paths: string[];
  truncated: boolean;
  source: 'git' | 'walk';
}

interface FindCacheEntry {
  at: number;
  index: FileIndex;
}

/** Shared by every session; keyed by id and working directory. */
const findCache = new Map<string, FindCacheEntry>();

/**
 * Directories the fallback walk never descends into.
 *
 * Only consulted when there is no git index to ask, so this list does not have
 * to be right about anybody's project — it has to keep a picker responsive in
 * a directory that has a `node_modules` and no `.git`, which is the case it
 * exists for.
 */
const WALK_SKIP = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'coverage', '.gradle', '.idea', '.tox', 'vendor', '.terraform', 'Pods', 'DerivedData',
]);

/**
 * The list a `@` picker is built from.
 *
 * Two hard bounds, because both failure modes are real: a monorepo has more
 * files than anyone can usefully be offered, and a walk of one can take longer
 * than the request it is serving. Truncation is reported rather than hidden —
 * a picker that quietly stops at 20,000 files reads as "that file does not
 * exist" for everything after it.
 */
const MAX_INDEXED_FILES = 20_000;
const MAX_WALK_DIRS = 6_000;
const FIND_CACHE_MS = 10_000;

/**
 * Whether a path is part of the user's project rather than of this app.
 *
 * `.cc-web/` is where pasted images and chat attachments are written, inside
 * the working directory because that is the only place every agent CLI can read
 * without a prompt. It is untracked and not ignored by anybody's `.gitignore`,
 * so `git ls-files --others` finds all of it — and a file picker whose top
 * results are the screenshots you attached five minutes ago is offering you
 * your own exhaust.
 */
function isProjectFile(relativePath: string): boolean {
  return !relativePath.startsWith(`${ATTACHMENT_DIR}/`);
}

async function buildFileIndex(workingDir: string): Promise<FileIndex> {
  const root = path.resolve(workingDir);

  // -z, so a filename with a newline in it is still one entry. --cached plus
  // --others --exclude-standard is "tracked, and untracked that git would not
  // ignore" — the same set the user sees in their editor's file switcher.
  const listed = await run(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root,
  );
  if (listed.ok) {
    const paths = listed.stdout.split('\0').filter(Boolean).filter(isProjectFile);
    return {
      paths: paths.slice(0, MAX_INDEXED_FILES),
      truncated: paths.length > MAX_INDEXED_FILES,
      source: 'git',
    };
  }

  const paths: string[] = [];
  let truncated = false;
  let visited = 0;
  const queue: string[] = ['.'];

  while (queue.length > 0) {
    const relative = queue.shift()!;
    if (visited >= MAX_WALK_DIRS) {
      truncated = true;
      break;
    }
    visited += 1;

    const absolute = path.join(root, relative);
    const entries = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // Breadth-first and never through a symlink: a link back up the tree is
      // an infinite walk, and one pointing outside it is an escape from the
      // confinement every other route in this file is careful about.
      if (entry.isSymbolicLink()) continue;
      const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isProjectFile(child)) continue;
      if (paths.length >= MAX_INDEXED_FILES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      paths.push(child);
    }
  }

  return { paths, truncated, source: 'walk' };
}

export function createWorkspaceRoutes(deps: WorkspaceRoutesDeps): Router {
  const router = Router();
  const ghCache = new Map<string, GhCacheEntry>();

  // ------------------------------------------------------------------ files

  router.get(
    '/api/workspace/:sessionId/files',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const { path: target, missing } = await confineReal(
        session.workingDir,
        String(req.query.path || '.'),
      );
      if (!target) {
        if (missing) {
          res.status(404).json({ error: 'Cannot read this directory' });
          return;
        }
        res.status(403).json({ error: 'Path is outside the session directory' });
        return;
      }

      try {
        const found = await fsp.readdir(target, { withFileTypes: true });
        const entries = await Promise.all(
          found.slice(0, MAX_ENTRIES).map(async (entry) => {
            const full = path.join(target, entry.name);
            // Size is best-effort: a broken symlink or a file removed between
            // the readdir and the stat must not fail the whole listing.
            let size: number | undefined;
            if (entry.isFile()) {
              size = await fsp
                .stat(full)
                .then((stat) => stat.size)
                .catch(() => undefined);
            }
            return {
              name: entry.name,
              path: full,
              isDirectory: entry.isDirectory(),
              ...(size === undefined ? {} : { size }),
            };
          }),
        );

        res.json({
          root: session.workingDir,
          path: target,
          truncated: found.length > MAX_ENTRIES,
          entries,
        });
      } catch (error) {
        // fs errors embed absolute paths and errno detail; keep that server-side.
        console.error('Cannot list workspace directory:', error);
        res.status(404).json({ error: 'Cannot read this directory' });
      }
    },
  );

  // -------------------------------------------------------------- raw bytes

  /**
   * A file's bytes, for the things the browser renders rather than edits.
   *
   * The `file` route above answers with JSON and refuses anything that is not
   * text, which is the right answer for an editor and the wrong one for a
   * screenshot. This is the other half: an image, a video or a voice note goes
   * straight into an `<img>`, a `<video>` or an `<audio>`.
   *
   * Two properties do the safety work, and neither is optional:
   *
   *   - **The content type comes from the bytes, never from the name.** A file
   *     called `notes.png` that is really HTML must not come back as HTML from
   *     this app's own origin, which would be a stored XSS with a file tree in
   *     front of it. Anything the sniff does not recognise is an opaque
   *     download. Same rule the attachment store documents at length.
   *   - **SVG is sandboxed.** It is the one format that is both a legitimate
   *     image and an executable document, and `<img>` never runs its script but
   *     a browser navigated straight at this URL would. The CSP below is what
   *     makes that case inert rather than trusting nobody will try it.
   *
   * Range requests are answered because they are not a nicety: Safari will not
   * begin playing a video at all from a server that ignores `Range`, and
   * seeking anywhere in a long recording depends on it everywhere else.
   */
  router.get(
    '/api/workspace/:sessionId/raw',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const requested = typeof req.query.path === 'string' ? req.query.path : '';
      const { path: target, base, missing } = await confineReal(session.workingDir, requested);
      if (!target) {
        res.status(missing ? 404 : 403).json({ error: missing ? 'not_found' : 'outside_session' });
        return;
      }
      // Reading `.git` is harmless, but nothing in "preview this file" means
      // streaming a pack file, and the write path already refuses it.
      if (insideGitDir(base, target)) {
        res.status(403).json({ error: 'inside_git' });
        return;
      }

      const stat = await fsp.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (stat.size > MAX_RAW_BYTES) {
        res.status(413).json({ error: 'too_large', limitBytes: MAX_RAW_BYTES });
        return;
      }

      const head = await readHead(target, SNIFF_BYTES);
      const serve = rawContentType(head, target);

      res.setHeader('Content-Type', serve.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      // One user's file behind a cookie: a shared cache holding it would be the
      // one place the ownership check does not run.
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      if (serve.sandbox) {
        // Neutralises an SVG opened directly at this URL: no script, no fetch,
        // no embedded anything. `<img>` was already safe; this covers the rest.
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      if (!serve.inline) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${path.basename(target).replace(/["\\]/g, '')}"`,
        );
      }

      const range = parseRange(req.headers.range, stat.size);
      if (range === 'invalid') {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }

      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
        streamFile(res, target, range);
        return;
      }

      res.setHeader('Content-Length', String(stat.size));
      streamFile(res, target, null);
    },
  );

  // ------------------------------------------------------------- find files

  /**
   * Every file in the working tree, ranked against a query.
   *
   * Feeds the composer's `@` picker, which is why it answers with paths and
   * nothing else — no sizes, no stats, no per-entry syscalls. It is typed
   * against, one request per keystroke-ish, so the whole index is built once
   * and reused for `FIND_CACHE_MS`; only the ranking runs per request.
   *
   * `git ls-files` first, and not as an optimisation: it is the only source
   * that already knows what `.gitignore` says, and a picker that offers 40,000
   * files out of `node_modules` before it offers `src/index.ts` is a picker
   * nobody will use twice. The walk below is the fallback for a directory that
   * is not a repository, and it carries its own hardcoded skip list because it
   * has nothing better to go on.
   */
  router.get(
    '/api/workspace/:sessionId/find',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));

      const cacheKey = `${session.id}:${session.workingDir}`;
      const cached = findCache.get(cacheKey);
      let index: FileIndex;
      if (cached && Date.now() - cached.at < FIND_CACHE_MS && req.query.refresh !== '1') {
        index = cached.index;
      } else {
        index = await buildFileIndex(session.workingDir);
        findCache.set(cacheKey, { at: Date.now(), index });
      }

      res.json({
        root: session.workingDir,
        total: index.paths.length,
        truncated: index.truncated,
        source: index.source,
        matches: rankFilePaths(index.paths, query, limit).map((match) => match.path),
      });
    },
  );

  // -------------------------------------------------------------------- git

  router.get(
    '/api/workspace/:sessionId/git',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], session.workingDir);
      if (!inside.ok || inside.stdout.trim() !== 'true') {
        res.json({ repo: false, reason: 'This folder is not a git repository.' });
        return;
      }

      const [status, remote, head, top] = await Promise.all([
        // `-- .` scopes the listing to this session's own directory. Without it
        // a session opened in a subdirectory lists the whole repository —
        // including files it is not allowed to open.
        run('git', ['status', '--porcelain=v1', '-z', '--branch', '--', '.'], session.workingDir),
        run('git', ['remote', 'get-url', 'origin'], session.workingDir),
        run('git', ['log', '-1', '--format=%h%x00%s%x00%an%x00%aI'], session.workingDir),
        run('git', ['rev-parse', '--show-toplevel'], session.workingDir),
      ]);

      if (!status.ok) {
        res.json({ repo: true, error: 'git status failed', changes: [] });
        return;
      }

      const [sha, subject, author, date] = head.ok ? head.stdout.split('\0') : [];
      const parsed = parseGitStatus(status.stdout);

      // Porcelain paths are relative to the repository root whatever directory
      // git was run from — verified, not assumed. Every consumer of this list
      // resolves against the *session* directory, so a session opened in a
      // subdirectory would otherwise ask for `<dir>/<repo-relative-path>` and
      // get a file that does not exist.
      const repoRoot = top.ok ? top.stdout.trim() : session.workingDir;
      const toSession = (value: string): string =>
        path.relative(session.workingDir, path.resolve(repoRoot, value)) || '.';

      res.json({
        repo: true,
        ...parsed,
        changes: parsed.changes.map((change) => ({
          ...change,
          path: toSession(change.path),
          ...(change.oldPath ? { oldPath: toSession(change.oldPath) } : {}),
        })),
        repoRoot,
        remoteUrl: remote.ok ? remote.stdout.trim() : null,
        head: head.ok && sha
          ? { sha, subject: subject || '', author: author || '', date: date ? date.trim() : '' }
          : null,
      });
    },
  );

  router.get(
    '/api/workspace/:sessionId/git/diff',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const staged = req.query.staged === '1' || req.query.staged === 'true';
      const requested = typeof req.query.path === 'string' ? req.query.path : '';

      let relative: string | undefined;
      if (requested) {
        const { path: resolved, missing } = await confineReal(session.workingDir, requested);
        if (!resolved) {
          // A path that is merely gone is not a diff to refuse; it is a diff
          // with nothing in it, which is what a just-deleted file looks like.
          if (missing) {
            res.json({ diffs: [] });
            return;
          }
          res.status(403).json({ error: 'Path is outside the session directory' });
          return;
        }
        // Relative to the *lexical* root: git resolves its own pathspecs, and
        // handing it a realpath from a different mount would miss the file.
        const lexical = confine(session.workingDir, requested);
        relative = path.relative(session.workingDir, lexical || resolved) || '.';
      }

      // `--no-color` and a fixed context: the parser reads the machine format,
      // and a user's diff.external or color.ui config must not reach it.
      const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
      if (staged) args.push('--cached');
      // `--` terminates options, so a file literally named `--cached` is a path.
      if (relative) args.push('--', relative);

      const result = await run('git', args, session.workingDir);
      if (!result.ok && !result.stdout) {
        res.json({ diffs: [], error: result.stderr.trim() || 'git diff failed' });
        return;
      }

      let diffs = parseUnifiedDiff(result.stdout);

      // An untracked file has no diff at all — git does not know about it — so
      // asking for one returns nothing and the panel would show a changed file
      // with no changes. The whole file is its addition.
      if (relative && diffs.length === 0 && !staged) {
        const untracked = await run(
          'git',
          ['status', '--porcelain=v1', '-z', '--', relative],
          session.workingDir,
        );
        if (untracked.ok && untracked.stdout.startsWith('??')) {
          const shown = await run(
            'git',
            [
              'diff', '--no-color', '--no-ext-diff', '--no-index', '--unified=3',
              // `--` is not optional here. Without it git parses a file called
              // `--output=notes.txt` as an option and *truncates* notes.txt —
              // verified against git, from a plain GET.
              '--', '/dev/null', relative,
            ],
            session.workingDir,
          );
          // --no-index exits 1 when the files differ, which is always here.
          diffs = parseUnifiedDiff(shown.stdout).map((diff) => ({
            ...diff,
            path: relative as string,
            kind: 'create' as const,
          }));
        }
      }

      res.json({ diffs });
    },
  );

  // ------------------------------------------------------------------- file

  /**
   * One file's contents, for the editor.
   *
   * Answers with a *reason* rather than an error for the two cases the editor
   * can still show something useful for — a binary file and an oversized one —
   * because "this is a PNG" and "this request failed" need different words on
   * screen and only one of them is true.
   */
  router.get(
    '/api/workspace/:sessionId/file',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const requested = typeof req.query.path === 'string' ? req.query.path : '';
      if (!requested) {
        res.status(400).json({ error: 'No file was named' });
        return;
      }

      const { path: target, base, missing } = await confineReal(session.workingDir, requested);
      if (!target) {
        res
          .status(missing ? 404 : 403)
          .json({ error: missing ? 'That file no longer exists' : 'Path is outside the session directory' });
        return;
      }

      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        res.status(404).json({ error: 'That file no longer exists' });
        return;
      }
      if (stat.isDirectory()) {
        res.status(400).json({ error: 'That is a directory, not a file' });
        return;
      }
      if (!stat.isFile()) {
        // Not merely "not a directory": reading a FIFO never returns, and it
        // holds one of libuv's four threadpool slots for the life of the
        // process. Four of those and every fs operation on the server stops.
        res.status(400).json({ error: 'That is not a regular file' });
        return;
      }

      const info = {
        path: target,
        name: path.basename(target),
        relativePath: path.relative(base, target) || path.basename(target),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        language: languageForFile(target),
        // The editor keeps its Save button off for anything it cannot write
        // back byte-for-byte, and says which of the reasons applies.
        writable: !insideGitDir(base, target),
      };

      if (stat.size > MAX_EDIT_BYTES) {
        res.json({
          ...info,
          content: '',
          binary: false,
          tooLarge: true,
          writable: false,
          reason: `This file is ${formatBytes(stat.size)}, past the ${formatBytes(MAX_EDIT_BYTES)} the editor opens.`,
        });
        return;
      }

      let buffer: Buffer;
      try {
        buffer = await fsp.readFile(target);
      } catch {
        res.status(403).json({ error: 'That file could not be read' });
        return;
      }

      if (looksBinary(buffer)) {
        res.json({
          ...info,
          content: '',
          binary: true,
          tooLarge: false,
          writable: false,
          reason: 'This file is not text, so there is nothing to edit here.',
        });
        return;
      }

      res.json({
        ...info,
        content: buffer.toString('utf8'),
        binary: false,
        tooLarge: false,
      });
    },
  );

  /**
   * Write a file back.
   *
   * `mtimeMs` is the version the browser opened, and a mismatch is a refusal
   * rather than a merge: an agent is working in this same tree, and the whole
   * point of having the panel open is watching it do that. Overwriting its edit
   * with a copy the user started reading two minutes ago is the one outcome
   * nobody would ask for.
   *
   * Creating files is deliberately not offered. Editing what you clicked is the
   * feature; a browser endpoint that writes to an arbitrary new path inside the
   * tree is a larger thing to own than this panel needs.
   */
  router.put(
    '/api/workspace/:sessionId/file',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const body = (req.body || {}) as { path?: unknown; content?: unknown; mtimeMs?: unknown };
      if (typeof body.path !== 'string' || !body.path) {
        res.status(400).json({ error: 'No file was named' });
        return;
      }
      if (typeof body.content !== 'string') {
        res.status(400).json({ error: 'No contents were sent' });
        return;
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_EDIT_BYTES) {
        res.status(413).json({ error: 'That is larger than this editor will write' });
        return;
      }

      const { path: target, base, missing } = await confineReal(session.workingDir, body.path);
      if (!target) {
        res
          .status(missing ? 404 : 403)
          .json({ error: missing ? 'That file no longer exists' : 'Path is outside the session directory' });
        return;
      }
      if (insideGitDir(base, target)) {
        res.status(403).json({ error: 'Files inside .git are not editable here' });
        return;
      }

      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        res.status(404).json({ error: 'That file no longer exists' });
        return;
      }
      if (!stat.isFile()) {
        res.status(400).json({ error: 'That is not a file' });
        return;
      }

      // Required, not optional. Left conditional, a caller that simply omitted
      // the field turned off the only thing standing between the agent's work
      // and a blind overwrite — and "forgot a field" is not a decision anyone
      // makes on purpose.
      if (typeof body.mtimeMs !== 'number' || !Number.isFinite(body.mtimeMs)) {
        res.status(400).json({ error: 'A save must say which version of the file it is based on' });
        return;
      }
      if (Math.abs(stat.mtimeMs - body.mtimeMs) > 1) {
        res.status(409).json({
          error: 'This file changed on disk since you opened it. Reload it before saving.',
          mtimeMs: stat.mtimeMs,
        });
        return;
      }

      // The editor already refuses to open a binary file, but that is a
      // decision made in the browser and this endpoint is not only reachable
      // from the browser. Writing UTF-8 over a PNG is not an edit.
      try {
        const handle = await fsp.open(target, 'r');
        try {
          const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
          if (sniff.length > 0) {
            await handle.read(sniff, 0, sniff.length, 0);
            if (looksBinary(sniff)) {
              res.status(400).json({ error: 'That file is not text' });
              return;
            }
          }
        } finally {
          await handle.close();
        }
      } catch {
        res.status(403).json({ error: 'That file could not be read' });
        return;
      }

      try {
        await fsp.writeFile(target, body.content, 'utf8');
      } catch {
        res.status(403).json({ error: 'That file could not be written' });
        return;
      }

      const after = await fsp.stat(target);
      res.json({ saved: true, mtimeMs: after.mtimeMs, size: after.size });
    },
  );

  // ------------------------------------------------------------------ asset

  /**
   * The same bytes as `/raw`, addressed by path instead of by query.
   *
   * Only for previewing a page. An HTML file is the one kind of file whose
   * *relative* references matter — `./style.css`, `img/logo.png` — and a
   * query-string route gives a browser nothing to resolve them against: every
   * one of them would resolve to a sibling of `/raw` and 404. Addressing the
   * file by path makes the folder a real folder to the browser, so a preview
   * loads the page the way the page expects.
   *
   * Same confinement, same sniffing, same refusal to echo a client-supplied
   * type as `/raw`; the only difference is where the path is read from.
   */
  router.get(
    /^\/api\/workspace\/([^/]+)\/asset\/(.*)$/,
    async (req: Request, res: Response): Promise<void> => {
      // A regex route, because a path parameter cannot contain slashes and the
      // whole point here is that it can. The captures arrive as an object keyed
      // by position, not as an array.
      const captures = req.params as unknown as Record<string, string>;
      const rawSessionId = captures['0'] || '';
      const rawPath = captures['1'] || '';
      req.params = { ...req.params, sessionId: decodeURIComponent(rawSessionId) };

      const session = sessionFor(deps, req, res);
      if (!session) return;

      let requested: string;
      try {
        requested = decodeURIComponent(rawPath || '');
      } catch {
        res.status(400).json({ error: 'That path could not be read' });
        return;
      }

      const { path: target, base, missing } = await confineReal(session.workingDir, requested);
      if (!target || missing) {
        res.status(missing ? 404 : 403).end();
        return;
      }
      if (insideGitDir(base, target)) {
        res.status(403).end();
        return;
      }

      const stat = await fsp.stat(target).catch(() => null);
      if (!stat?.isFile()) {
        res.status(404).end();
        return;
      }
      if (stat.size > MAX_RAW_BYTES) {
        res.status(413).end();
        return;
      }

      const head = await readHead(target, SNIFF_BYTES);
      const serve = previewContentType(head, target);
      res.setHeader('Content-Type', serve.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The `sandbox` directive is what makes serving a project's own HTML and
      // SVG safe: it forces an opaque origin even when the URL is opened in a
      // top-level tab, so a page in someone's working tree cannot read this
      // app's cookies whatever it contains. Scripts are allowed *within* that
      // sandbox, because a page whose scripts do not run is not a preview.
      if (serve.sandbox) {
        res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms');
      }
      res.setHeader('Cache-Control', 'no-store');
      streamFile(res, target, null);
    },
  );

  // ----------------------------------------------------------------- status

  /**
   * What is left: of the context window, of the plan, and of the branch.
   *
   * One route rather than three because they are read together — the question
   * is "can I keep going, and on what" — and three requests to answer one
   * question is three chances for the panel to show a half-drawn picture.
   *
   * Every section is independently optional and says which of "no" and "not
   * known" applies. A plan meter that reads zero because nothing was tracked is
   * indistinguishable from one that reads zero because nothing is left, and
   * those call for opposite reactions.
   */
  router.get(
    '/api/workspace/:sessionId/status',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const status = await run(
        'git',
        ['status', '--porcelain=v1', '-z', '--branch'],
        session.workingDir,
      );
      const branch = status.ok
        ? parseGitStatus(status.stdout)
        : null;

      let plan: Record<string, unknown> | null = null;
      if (deps.usageAnalytics) {
        const analytics = deps.usageAnalytics.getAnalytics() as Record<string, unknown>;
        const sessionStats = await deps.usageReader
          ?.getCurrentSessionStats()
          .catch(() => null);
        plan = {
          type: deps.usageAnalytics.currentPlan,
          limits: deps.usageAnalytics.planLimits[deps.usageAnalytics.currentPlan] ?? null,
          predictions: analytics?.predictions ?? null,
          windows: analytics?.windows ?? null,
          sessionStats: sessionStats ?? null,
        };
      }

      res.json({
        git: branch
          ? {
              repo: true,
              branch: branch.branch,
              upstream: branch.upstream,
              ahead: branch.ahead,
              behind: branch.behind,
              detached: branch.detached,
              changed: branch.changes.length,
            }
          : { repo: false },
        plan,
        // The working directory is part of "where am I", and the header shows
        // only its last segment.
        workingDir: session.workingDir,
      });
    },
  );

  // ----------------------------------------------------------------- upload

  /**
   * Put a file from the browser into the project.
   *
   * The counterpart to the raw route: that one takes a file out, this one puts
   * one in. Deliberately narrower than the editor's PUT — it writes bytes, not
   * text, so it is the path for an image or an archive, which is most of what
   * anyone drags into a project folder.
   *
   * `overwrite` has to be asked for. A silent replace is the one outcome that
   * cannot be undone from here, and "upload into this folder" does not imply
   * consent to destroy what is already in it.
   */
  router.post(
    '/api/workspace/:sessionId/upload',
    // Route-scoped, so the app-wide express.json() limit is unaffected.
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const dir = typeof req.query.dir === 'string' ? req.query.dir : '.';
      const rawName = typeof req.query.name === 'string' ? req.query.name : '';
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      // The name is a name, never a path. A browser can send
      // `../../.ssh/authorized_keys` as a filename, and joining that onto a
      // directory that passed its own check would walk straight back out of it.
      const name = path.basename(rawName).replace(/^\.+/, '').trim();
      if (!name) {
        res.status(400).json({ error: 'That upload had no usable filename' });
        return;
      }
      if (!bytes.length) {
        res.status(400).json({ error: 'That file was empty' });
        return;
      }

      const { path: folder, base, missing } = await confineReal(session.workingDir, dir);
      if (!folder) {
        res
          .status(missing ? 404 : 403)
          .json({ error: missing ? 'That folder no longer exists' : 'Path is outside the session directory' });
        return;
      }

      const folderStat = await fsp.stat(folder).catch(() => null);
      if (!folderStat?.isDirectory()) {
        res.status(400).json({ error: 'That is not a folder' });
        return;
      }

      const target = path.join(folder, name);
      if (insideGitDir(base, target)) {
        res.status(403).json({ error: 'Files inside .git are not writable here' });
        return;
      }

      const overwrite = req.query.overwrite === '1';
      try {
        // `wx` unless overwrite was asked for: the flag does the check and the
        // write as one operation, so nothing can appear in between.
        await fsp.writeFile(target, bytes, { flag: overwrite ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          res.status(409).json({ error: 'A file with that name is already there', name });
          return;
        }
        res.status(403).json({ error: 'That file could not be written' });
        return;
      }

      res.json({
        saved: true,
        name,
        path: path.relative(base, target),
        size: bytes.length,
      });
    },
  );

  // ----------------------------------------------------------------- github

  router.get(
    '/api/workspace/:sessionId/github',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const cacheKey = `${session.id}:${session.workingDir}`;
      const cached = ghCache.get(cacheKey);
      if (cached && Date.now() - cached.at < GH_CACHE_MS && req.query.refresh !== '1') {
        res.json(cached.payload);
        return;
      }

      const payload = await readGitHub(session.workingDir);
      ghCache.set(cacheKey, { at: Date.now(), payload });
      res.json(payload);
    },
  );

  /**
   * One issue or pull request, in full.
   *
   * So the panel can open it in the app rather than sending the user to a new
   * browser window. Not an iframe of github.com: GitHub refuses to be framed,
   * and even if it did not, the page it serves is a whole application to load
   * beside this one. `gh` is already the panel's source and already signed in.
   */
  router.get(
    '/api/workspace/:sessionId/github/:kind/:number',
    async (req: Request, res: Response): Promise<void> => {
      const session = sessionFor(deps, req, res);
      if (!session) return;

      const kind = req.params.kind === 'pr' ? 'pr' : 'issue';
      // A number, not a string that looks like one: this becomes an argument to
      // a subprocess, and the type is the guard.
      const number = Number.parseInt(String(req.params.number), 10);
      if (!Number.isSafeInteger(number) || number <= 0) {
        res.status(400).json({ error: 'That is not an issue number' });
        return;
      }

      const fields = kind === 'pr'
        ? 'number,title,body,url,state,isDraft,author,createdAt,updatedAt,headRefName,baseRefName,additions,deletions,changedFiles,comments,labels'
        : 'number,title,body,url,state,author,createdAt,updatedAt,comments,labels,assignees';

      const view = await run(
        'gh',
        [kind, 'view', String(number), '--json', fields],
        session.workingDir,
      );
      if (!view.ok) {
        res.status(404).json({
          error: `That ${kind === 'pr' ? 'pull request' : 'issue'} could not be read`,
          detail: view.stderr.trim().slice(0, 400),
        });
        return;
      }

      res.json({ kind, item: parseJson(view.stdout, null) });
    },
  );

  return router;
}

/**
 * Ask `gh` about this repository, and say plainly when it cannot be asked.
 *
 * Three separate reasons this can come back empty — no `gh`, `gh` not signed
 * in, folder is not a GitHub repository — and they need different answers from
 * the user, so they are reported as different reasons rather than as one empty
 * list. A panel that just shows nothing is indistinguishable from a repository
 * with no open work.
 */
async function readGitHub(workingDir: string): Promise<Record<string, unknown>> {
  const version = await run('gh', ['--version'], workingDir);
  if (!version.ok) {
    return {
      available: false,
      reason: 'The GitHub CLI (`gh`) is not installed, or is not on this server\'s PATH.',
    };
  }

  const auth = await run('gh', ['auth', 'status'], workingDir);
  if (!auth.ok) {
    return {
      available: false,
      reason: 'The GitHub CLI is installed but not signed in. Run `gh auth login` on the server.',
    };
  }

  const repo = await run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'],
    workingDir,
  );
  if (!repo.ok) {
    return {
      available: false,
      reason: 'This folder has no GitHub repository that `gh` can resolve.',
    };
  }

  const [prs, issues] = await Promise.all([
    run(
      'gh',
      [
        'pr', 'list', '--state', 'open', '--limit', '20',
        '--json', 'number,title,url,state,isDraft,author,headRefName,updatedAt',
      ],
      workingDir,
    ),
    run(
      'gh',
      [
        'issue', 'list', '--state', 'open', '--limit', '20',
        '--json', 'number,title,url,state,author,labels,updatedAt',
      ],
      workingDir,
    ),
  ]);

  return {
    available: true,
    repo: parseJson(repo.stdout, null),
    prs: parseJson(prs.stdout, []),
    issues: parseJson(issues.stdout, []),
  };
}

/** Sizes as a person reads them, for the two limits the editor has to explain. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
