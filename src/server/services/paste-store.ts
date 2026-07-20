import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Stores images pasted from the browser and hands back the path to type into
 * the terminal.
 *
 * Files land inside the session's own working directory because that is the
 * only place all three agent CLIs can read without a prompt: Claude Code asks
 * before reading outside its cwd, and a sandboxed Codex can refuse outright.
 *
 * Deliberately not in scope: decompression-bomb and dimension limits. The
 * server never decodes an image, it only writes bytes and hands over a path,
 * so the only resource that needs bounding is disk.
 */

export const PASTE_DIR = '.cc-web';
export const PASTE_SUBDIR = 'pasted';
/** Per image. The route enforces the same number at the body-parser level. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Per session, so a loop of pastes cannot fill the disk. */
export const DEFAULT_SESSION_QUOTA_BYTES = 200 * 1024 * 1024;

export type ImageKind = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp';

export interface PasteSessionRef {
  id: string;
  ownerUserId: number;
  workingDir: string;
}

export interface PasteResult {
  absolutePath: string;
  insertText: string;
  bytes: number;
}

export interface PasteStoreLike {
  save(session: PasteSessionRef, bytes: Buffer): Promise<PasteResult>;
  deletePastes(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'>): Promise<void>;
}

export interface PasteStoreOptions {
  /** Holds the manifests only. The images live in the working directory. */
  storageDir: string;
  maxBytes?: number;
  sessionQuotaBytes?: number;
  now?: () => Date;
  randomId?: () => string;
}

interface ManifestEntry {
  path: string;
  root: string;
  bytes: number;
}

interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}

/**
 * Identify an image by its content.
 *
 * The Content-Type header and the browser's File.type are both untrusted — the
 * latter is just an extension lookup on the client's machine — so neither is
 * read. SVG is rejected on purpose: it has no magic number (sniffing it means
 * parsing untrusted XML) and it can carry script and external entities.
 */
export function sniffImageType(bytes: Buffer): ImageKind | null {
  if (bytes.length < 12) {
    return null;
  }

  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'png';
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }

  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return 'gif';
  }

  if (
    bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    // The size field is little-endian at offset 2 and should roughly match the
    // payload; "BM" alone is two bytes and matches far too much.
    const declared = bytes.readUInt32LE(2);
    if (declared > 0 && Math.abs(declared - bytes.length) <= 1024) {
      return 'bmp';
    }
  }

  return null;
}

const SAFE_BARE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/**
 * Quote a path for a POSIX shell.
 *
 * Single quotes are the only rule that is total over arbitrary bytes: inside
 * '...' a shell interprets nothing, and '\'' closes, escapes and reopens to
 * represent a literal quote. Double quotes would leave $, ` and \ live.
 *
 * The generated basename never needs quoting; everything that can force it
 * comes from the working directory, which can contain spaces or apostrophes.
 */
export function shellQuote(value: string): string {
  if (SAFE_BARE.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What gets typed into the terminal: the path and a single space.
 *
 * No newline, ever — the user has to be able to add their question before
 * submitting, and in a bare shell an appended newline would execute the path.
 * Not bracketed either: the paste markers belong to whatever TUI is attached,
 * and emitting them for a runtime that has not enabled DECSET 2004 would put
 * literal "[200~" on the command line.
 */
export function insertTextFor(absolutePath: string): string {
  return `${shellQuote(absolutePath)} `;
}

const GITIGNORE_BODY = `# Written by code-agents-webcli. Pasted images are scratch, never commit them.
*
`;

export class PasteStore implements PasteStoreLike {
  readonly storageDir: string;
  readonly manifestDir: string;
  readonly maxBytes: number;
  readonly sessionQuotaBytes: number;

  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ignoredDirs = new Set<string>();
  /** Sessions whose teardown has begun; a late upload must not resurrect them. */
  private readonly tombstoned = new Set<string>();

  constructor(options: PasteStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.manifestDir = path.join(this.storageDir, 'pastes');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.sessionQuotaBytes = options.sessionQuotaBytes ?? DEFAULT_SESSION_QUOTA_BYTES;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomBytes(4).toString('hex'));
  }

  /**
   * Manifest path for a session.
   *
   * Same guard as HistoryStore.basePath, including the '.' and '..' clauses:
   * the regex alone accepts both, and '..' would climb out of the per-owner
   * directory.
   */
  private manifestPath(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'>): string {
    const id = String(session.id);
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(`Refusing unsafe session id for paste storage: ${JSON.stringify(id)}`);
    }

    if (!Number.isSafeInteger(session.ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for paste storage: ${session.ownerUserId}`);
    }

    return path.join(this.manifestDir, String(session.ownerUserId), `${id}.json`);
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  private async readManifest(file: string): Promise<Manifest> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Partial<Manifest>;
      if (!Array.isArray(parsed.entries)) {
        return { version: 1, entries: [] };
      }
      return {
        version: 1,
        entries: parsed.entries.filter(
          (entry): entry is ManifestEntry =>
            !!entry && typeof entry.path === 'string' && typeof entry.root === 'string',
        ),
      };
    } catch {
      // Missing, or truncated by a crash mid-write. Either way there is
      // nothing trustworthy to read; deletion falls back to the recorded root.
      return { version: 1, entries: [] };
    }
  }

  /** Written via a temp file and rename so a crash cannot truncate it. */
  private async writeManifest(file: string, manifest: Manifest): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${this.randomId()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(manifest), { mode: 0o600 });
    await fs.promises.rename(temp, file);
  }

  /**
   * Create one directory level, refusing to follow a symlink.
   *
   * The check has to happen before the mkdir, and the mkdir has to be
   * non-recursive: `mkdir -p` follows an existing symlink, so an agent or a
   * hostile checkout that plants `.cc-web -> /home/other/.ssh` would get a
   * directory created there before any later check could refuse.
   */
  private async ensureDir(target: string): Promise<void> {
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw Object.assign(
        new Error(`Refusing to write through a symlinked paste directory: ${target}`),
        { code: 'UNSAFE_PASTE_DIR' },
      );
    }
    if (stat && !stat.isDirectory()) {
      throw Object.assign(
        new Error(`Refusing to write: ${target} exists and is not a directory`),
        { code: 'UNSAFE_PASTE_DIR' },
      );
    }
    if (!stat) {
      await fs.promises.mkdir(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });
    }
  }

  /**
   * A nested .gitignore rather than an edit to the repo's own.
   *
   * `*` in a subdirectory ignores that directory's contents and the ignore
   * file itself, so git stays clean at any depth, inside submodules and linked
   * worktrees alike — none of which a root-relative pattern gets right. It also
   * never touches a user-owned tracked file that the agent may be editing in
   * the same second.
   *
   * No git is invoked: no cwd trust, no PATH dependency, and no way for a
   * hostile repo's config to get a subprocess run.
   */
  private async ensureGitignore(dir: string): Promise<void> {
    if (this.ignoredDirs.has(dir)) {
      return;
    }

    try {
      // wx: an existing file is left exactly as the user left it.
      await fs.promises.writeFile(path.join(dir, '.gitignore'), GITIGNORE_BODY, { flag: 'wx' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Memoised only on success, so a transient failure — a full disk, a
        // momentarily read-only directory — is retried on the next paste
        // rather than leaving every later image in this project unignored.
        console.error('Could not write the paste .gitignore:', error);
        return;
      }
    }

    this.ignoredDirs.add(dir);
  }

  /**
   * Remove `.cc-web` once nothing but our own ignore file is left in it.
   *
   * The ignore file must not be deleted before that is known. Sessions can
   * share a working directory, so another session's images may still be
   * sitting under `.cc-web/pasted` — removing the marker first would leave
   * those images visible to git, and an agent running `git add -A` would
   * commit them.
   */
  private async removeContainerIfEmpty(container: string): Promise<void> {
    const remaining = await fs.promises.readdir(container).catch(() => null);
    if (remaining === null) {
      return;
    }
    if (remaining.length > 0 && !(remaining.length === 1 && remaining[0] === '.gitignore')) {
      return;
    }

    // The marker has to go before the rmdir, since a directory holding it is
    // not empty — but another session can create pasted/ in the window between
    // the readdir above and the rmdir below, so the removal must be reversible.
    await fs.promises.rm(path.join(container, '.gitignore'), { force: true }).catch(() => undefined);
    const removed = await fs.promises
      .rmdir(container)
      .then(() => true)
      .catch(() => false);

    // The memo is what stops ensureGitignore rewriting the file, so it has to
    // be dropped either way: on success so a recreated directory is ignored
    // again, on failure so the restore below is allowed to proceed.
    this.ignoredDirs.delete(container);

    if (!removed) {
      // Something raced in, or the directory could not be removed. Put the
      // marker back rather than leave the images inside it visible to git.
      await this.ensureGitignore(container);
    }
  }

  async save(session: PasteSessionRef, bytes: Buffer): Promise<PasteResult> {
    if (bytes.length === 0) {
      throw Object.assign(new Error('Empty body'), { code: 'EMPTY_BODY' });
    }
    if (bytes.length > this.maxBytes) {
      throw Object.assign(new Error('Image too large'), { code: 'IMAGE_TOO_LARGE' });
    }

    const kind = sniffImageType(bytes);
    if (!kind) {
      throw Object.assign(new Error('Unsupported image type'), { code: 'UNSUPPORTED_TYPE' });
    }

    // Validated before anything is created, so a rejected session id or owner
    // never results in a directory appearing.
    const manifestFile = this.manifestPath(session);

    const workingDir = path.resolve(session.workingDir);
    if (!workingDir || workingDir === path.parse(workingDir).root) {
      throw Object.assign(new Error('Refusing to write to a filesystem root'), {
        code: 'UNSAFE_PASTE_DIR',
      });
    }

    return this.enqueue(manifestFile, async () => {
      if (this.tombstoned.has(manifestFile)) {
        // The session was deleted while this upload was in flight. Writing now
        // would leave a file nothing will ever clean up.
        throw Object.assign(new Error('Session is gone'), { code: 'SESSION_GONE' });
      }

      const manifest = await this.readManifest(manifestFile);
      const used = manifest.entries.reduce((total, entry) => total + (entry.bytes || 0), 0);
      if (used + bytes.length > this.sessionQuotaBytes) {
        throw Object.assign(new Error('Session paste quota exceeded'), { code: 'QUOTA_EXCEEDED' });
      }

      const container = path.join(workingDir, PASTE_DIR);
      const root = path.join(container, PASTE_SUBDIR);

      // One level at a time, each checked for a symlink first.
      await this.ensureDir(container);
      await this.ensureDir(root);
      await this.ensureGitignore(container);

      // path.resolve is purely lexical, so after the directories exist the
      // real paths are compared too: the working directory itself may sit
      // under a symlink, but the paste root must not escape it.
      const realRoot = await fs.promises.realpath(root);
      const realWorkingDir = await fs.promises.realpath(workingDir);
      if (
        realRoot !== realWorkingDir
        && !realRoot.startsWith(realWorkingDir + path.sep)
      ) {
        throw Object.assign(new Error('Paste directory escapes the working directory'), {
          code: 'UNSAFE_PASTE_DIR',
        });
      }

      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}-${this.randomId()}.${kind}`;
      // Every character comes from Date, randomBytes and a five-element union,
      // so this can only fail if a future caller threads a request value in.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`Refusing generated paste name: ${JSON.stringify(name)}`);
      }

      const absolutePath = path.resolve(realRoot, name);
      if (!absolutePath.startsWith(realRoot + path.sep)) {
        throw new Error('Refusing a paste path outside the paste directory');
      }

      // wx never follows a symlink at the final component and never clobbers,
      // which closes the window the lstat checks above only narrow.
      await fs.promises.writeFile(absolutePath, bytes, { mode: 0o600, flag: 'wx' });

      manifest.entries.push({ path: absolutePath, root: realRoot, bytes: bytes.length });
      try {
        await this.writeManifest(manifestFile, manifest);
      } catch (error) {
        // The image is already on disk and usable; an unrecorded entry only
        // costs cleanup later, so this must not fail the paste.
        console.error('Could not record the pasted image for cleanup:', error);
      }

      return { absolutePath, insertText: insertTextFor(absolutePath), bytes: bytes.length };
    });
  }

  /**
   * Remove everything a session pasted.
   *
   * Driven by the manifest rather than the live working directory, because
   * POST /api/set-working-dir mutates that in place: recomputing the path at
   * deletion time would miss files written under the previous directory and
   * could delete another session's files under the new one.
   *
   * Never rejects — the caller is fire-and-forget.
   */
  async deletePastes(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'>): Promise<void> {
    let manifestFile: string;
    try {
      manifestFile = this.manifestPath(session);
    } catch (error) {
      console.error('Refusing to delete pastes for an unsafe session ref:', error);
      return;
    }

    // Marked before the queue, so an upload that is still in flight refuses
    // rather than re-creating what is being torn down.
    this.tombstoned.add(manifestFile);

    await this.enqueue(manifestFile, async () => {
      try {
        const manifest = await this.readManifest(manifestFile);
        const roots = new Set<string>();

        for (const entry of manifest.entries) {
          // The recorded root is server-generated and is what the file was
          // actually written under; the live workingDir may have moved.
          if (entry.path !== entry.root && !entry.path.startsWith(entry.root + path.sep)) {
            continue;
          }
          roots.add(entry.root);
          await fs.promises.rm(entry.path, { force: true });
        }

        for (const root of roots) {
          // Non-recursive on purpose: a directory that gained the user's own
          // files must survive.
          await fs.promises.rmdir(root).catch(() => undefined);
          await this.removeContainerIfEmpty(path.dirname(root));
        }

        await fs.promises.rm(manifestFile, { force: true });
      } catch (error) {
        console.error('Failed to delete pasted images:', error);
      }
    }).catch(() => undefined);
  }
}
