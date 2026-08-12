import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkspaceSessionDirectory,
  openWorkspacePasteDirectorySync,
  workspaceSessionAccessDirectory,
  type WorkspaceStorageDirectoryLease,
  WorkspaceSessionStorageRef,
} from './workspace-session-storage.js';
import {
  openSessionFileForRead,
  replaceSessionFile,
  unlinkSessionEntry,
} from './safe-session-file.js';
import { workspaceSessionFileParentLease } from './workspace-session-storage.js';
import {
  createTemporaryWorkspaceCwdFile,
  removeWorkspaceCwdEntry,
} from './workspace-cwd-helper.js';

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
/** A manifest is untrusted workspace input and must never cause an unbounded allocation. */
export const MAX_PASTE_MANIFEST_BYTES = 1024 * 1024;
/** Keeps parse and quota accounting bounded even for extremely small images. */
export const MAX_PASTE_MANIFEST_ENTRIES = 4096;

export type ImageKind = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp';

export interface PasteSessionRef extends WorkspaceSessionStorageRef {
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
  flush?(session: PasteSessionRef): Promise<void>;
  deletePastes(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'> & WorkspaceSessionStorageRef): Promise<void>;
}

export interface PasteStoreOptions {
  /** Holds the manifests only. The images live in the working directory. */
  storageDir: string;
  maxBytes?: number;
  sessionQuotaBytes?: number;
  now?: () => Date;
  randomId?: () => string;
  /** Deterministic seam for the pathname-only backend used on non-Linux hosts. */
  forcePathFallback?: boolean;
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
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

export class PasteStore implements PasteStoreLike {
  readonly storageDir: string;
  readonly manifestDir: string;
  readonly maxBytes: number;
  readonly sessionQuotaBytes: number;

  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly forcePathFallback: boolean;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ignoredDirs = new Set<string>();
  /** Sessions whose teardown has begun; a late upload must not resurrect them. */
  private readonly tombstoned = new Set<string>();

  constructor(options: PasteStoreOptions) {
    this.storageDir = path.resolve(options.storageDir);
    this.manifestDir = path.join(this.storageDir, 'pastes');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.sessionQuotaBytes = options.sessionQuotaBytes ?? DEFAULT_SESSION_QUOTA_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError('Paste maxBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.sessionQuotaBytes) || this.sessionQuotaBytes < 0) {
      throw new TypeError('Paste sessionQuotaBytes must be a non-negative safe integer');
    }
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomBytes(4).toString('hex'));
    this.forcePathFallback = options.forcePathFallback === true;
  }

  /**
   * Manifest path for a session.
   *
   * Same guard as HistoryStore.basePath, including the '.' and '..' clauses:
   * the regex alone accepts both, and '..' would climb out of the per-owner
   * directory.
   */
  private manifestPath(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'> & WorkspaceSessionStorageRef): string {
    const id = String(session.id);
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(`Refusing unsafe session id for paste storage: ${JSON.stringify(id)}`);
    }

    if (!Number.isSafeInteger(session.ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for paste storage: ${session.ownerUserId}`);
    }

    const workspaceDir = workspaceSessionAccessDirectory(session, {
      forcePathFallback: this.forcePathFallback,
    });
    return workspaceDir
      ? path.join(workspaceDir, 'paste-manifest.json')
      : path.join(this.manifestDir, String(session.ownerUserId), `${id}.json`);
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  private invalidManifest(file: string, detail: string, cause?: unknown): NodeJS.ErrnoException {
    return Object.assign(new Error(`Unsafe paste manifest ${file}: ${detail}`), {
      code: 'INVALID_PASTE_MANIFEST',
      cause,
    });
  }

  private async readManifest(file: string, tolerateInvalid = false): Promise<Manifest> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      try {
        handle = await openSessionFileForRead(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { version: 1, entries: [] };
        }
        throw error;
      }
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw this.invalidManifest(file, 'is not a private regular file');
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_PASTE_MANIFEST_BYTES) {
        throw this.invalidManifest(file, `exceeds ${MAX_PASTE_MANIFEST_BYTES} bytes`);
      }

      // `readFile()` can allocate past the size observed above if a hostile
      // runtime grows the workspace file concurrently. Read at most cap + 1
      // bytes into one fixed allocation and reject growth beyond the cap.
      const buffer = Buffer.allocUnsafe(MAX_PASTE_MANIFEST_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_PASTE_MANIFEST_BYTES) {
        throw this.invalidManifest(file, `exceeds ${MAX_PASTE_MANIFEST_BYTES} bytes`);
      }

      let parsed: Partial<Manifest>;
      try {
        parsed = JSON.parse(buffer.toString('utf8', 0, offset)) as Partial<Manifest>;
      } catch (error) {
        throw this.invalidManifest(file, 'is not valid JSON', error);
      }
      if (
        parsed.version !== 1
        || !Array.isArray(parsed.entries)
        || parsed.entries.length > MAX_PASTE_MANIFEST_ENTRIES
      ) {
        throw this.invalidManifest(file, 'has an unsupported shape');
      }

      const entries: ManifestEntry[] = [];
      for (const entry of parsed.entries) {
        if (
          !entry
          || typeof entry.path !== 'string'
          || typeof entry.root !== 'string'
          || !Number.isSafeInteger(entry.bytes)
          || (entry.bytes as number) < 0
        ) {
          throw this.invalidManifest(file, 'contains an invalid entry');
        }
        entries.push({ path: entry.path, root: entry.root, bytes: entry.bytes as number });
      }
      return { version: 1, entries };
    } catch (error) {
      if (tolerateInvalid && (error as NodeJS.ErrnoException).code === 'INVALID_PASTE_MANIFEST') {
        // Teardown may retire a corrupt manifest, but must never trust its
        // contents as deletion authority.
        return { version: 1, entries: [] };
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Written via a temp file and rename so a crash cannot truncate it. */
  private async writeManifest(file: string, manifest: Manifest): Promise<void> {
    if (manifest.entries.length > MAX_PASTE_MANIFEST_ENTRIES) {
      throw this.invalidManifest(file, `exceeds ${MAX_PASTE_MANIFEST_ENTRIES} entries`);
    }
    const serialized = JSON.stringify(manifest);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PASTE_MANIFEST_BYTES) {
      throw this.invalidManifest(file, `exceeds ${MAX_PASTE_MANIFEST_BYTES} bytes`);
    }
    if (!workspaceSessionFileParentLease(file)) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
    }
    await replaceSessionFile(file, serialized, 'utf8');
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
      await fs.promises.writeFile(path.join(dir, '.gitignore'), GITIGNORE_BODY, {
        flag: 'wx',
        mode: 0o600,
      });
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
    if (session.persistenceUnavailable) {
      throw Object.assign(new Error(session.persistenceUnavailable), {
        code: 'SESSION_PERSISTENCE_UNAVAILABLE',
      });
    }
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

    // The session's cwd can change; its immutable storage scope cannot. Keep
    // paste bytes and their manifest in the same workspace for the lifetime
    // of the session, falling back only for pre-scope legacy callers.
    const immutableRoot = session.storageScope?.workspaceRoot ?? session.storageRoot;
    const workingDir = path.resolve(immutableRoot ?? session.workingDir);
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

      await ensureWorkspaceSessionDirectory(session);

      const manifest = await this.readManifest(manifestFile);
      let used = 0;
      for (const entry of manifest.entries) {
        if (entry.bytes > Number.MAX_SAFE_INTEGER - used) {
          throw this.invalidManifest(manifestFile, 'contains an overflowing byte total');
        }
        used += entry.bytes;
      }
      if (used > this.sessionQuotaBytes - bytes.length) {
        throw Object.assign(new Error('Session paste quota exceeded'), { code: 'QUOTA_EXCEEDED' });
      }

      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}-${this.randomId()}.${kind}`;
      // Every character comes from Date, randomBytes and a five-element union,
      // so this can only fail if a future caller threads a request value in.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`Refusing generated paste name: ${JSON.stringify(name)}`);
      }

      const pasteLease = openWorkspacePasteDirectorySync(workingDir, {
        forcePathFallback: this.forcePathFallback,
      });
      if (pasteLease.entryMutationPolicy === 'deny') {
        pasteLease.close();
        throw Object.assign(
          new Error('Creating paste entries requires descriptor-relative workspace access'),
          { code: 'UNSAFE_PASTE_DIR' },
        );
      }
      try {
        pasteLease.verify();
      } catch (error) {
        pasteLease.close();
        throw error;
      }
      const realRoot = pasteLease.canonicalPath;
      const accessRoot = pasteLease.accessPath;

      const absolutePath = path.resolve(realRoot, name);
      if (!absolutePath.startsWith(realRoot + path.sep)) {
        pasteLease.close();
        throw new Error('Refusing a paste path outside the paste directory');
      }
      const writePath = path.join(accessRoot, name);

      // wx never follows a symlink at the final component and never clobbers,
      // which closes the window the lstat checks above only narrow.
      let wroteFile = false;
      let helperIdentity: { dev?: bigint; ino?: bigint } | null = null;
      try {
        pasteLease.verify();
        if (pasteLease.entryMutationPolicy === 'cwd-helper') {
          helperIdentity = createTemporaryWorkspaceCwdFile(pasteLease, name, bytes);
          wroteFile = true;
        } else {
          const handle = await fs.promises.open(
            writePath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
            0o600,
          );
          wroteFile = true;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1) {
              throw Object.assign(new Error('Refusing an unsafe pasted image entry'), {
                code: 'UNSAFE_PASTE_DIR',
              });
            }
            await handle.chmod(0o600);
            await handle.writeFile(bytes);
          } finally {
            await handle.close().catch(() => undefined);
          }
        }
        pasteLease.verify();

        manifest.entries.push({ path: absolutePath, root: realRoot, bytes: bytes.length });
        await this.writeManifest(manifestFile, manifest);
        pasteLease.verify();
      } catch (error) {
        // Durability and cleanup are one operation. Returning a path here would
        // leave an attachment the session can use but can never account for or
        // retire. Unlink the unpredictable file we just created and surface a
        // retryable failure instead.
        if (wroteFile) {
          if (pasteLease.entryMutationPolicy === 'cwd-helper') {
            try {
              if (helperIdentity?.dev !== undefined && helperIdentity.ino !== undefined) {
                removeWorkspaceCwdEntry(
                  pasteLease, name, { dev: helperIdentity.dev, ino: helperIdentity.ino },
                );
              }
            } catch { /* cleanup */ }
          } else {
            await fs.promises.unlink(writePath).catch(() => undefined);
          }
        }
        throw error;
      } finally {
        pasteLease.close();
      }

      return { absolutePath, insertText: insertTextFor(absolutePath), bytes: bytes.length };
    });
  }

  async flush(session: PasteSessionRef): Promise<void> {
    const manifestFile = this.manifestPath(session);
    await this.enqueue(manifestFile, async () => undefined);
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
  async deletePastes(session: Pick<PasteSessionRef, 'id' | 'ownerUserId'> & WorkspaceSessionStorageRef): Promise<void> {
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
      const pasteLeases = new Map<string, WorkspaceStorageDirectoryLease>();
      try {
        const manifest = await this.readManifest(manifestFile, true);
        const immutableRoot = session.storageScope?.workspaceRoot ?? session.storageRoot;
        const scopedRoot = immutableRoot
          ? path.resolve(immutableRoot, PASTE_DIR, PASTE_SUBDIR)
          : null;
        const authorized: Array<{ root: string; candidate: string }> = [];

        for (const entry of manifest.entries) {
          const root = path.resolve(entry.root);
          const candidate = path.resolve(entry.path);
          // A workspace-local manifest is writable by the runtime and is not
          // authority over the host filesystem. Recompute its only permitted
          // root from immutable storageScope, then accept direct generated
          // children only. Legacy global manifests retain their old root but
          // still have to name a canonical `.cc-web/pasted` directory.
          const legacyShape = !scopedRoot
            && path.basename(root) === PASTE_SUBDIR
            && path.basename(path.dirname(root)) === PASTE_DIR;
          if (
            (scopedRoot ? root !== scopedRoot : !legacyShape)
            || entry.root !== root
            || entry.path !== candidate
            || path.dirname(candidate) !== root
            || !/^[A-Za-z0-9._-]+\.(?:png|jpg|gif|webp|bmp)$/.test(path.basename(candidate))
          ) continue;
          authorized.push({ root, candidate });
        }

        // Resolve and pin every authorized root before the first deletion, so
        // a later unsafe/missing root cannot leave a partially path-deleted
        // cleanup. Legacy manifests may legitimately span prior working dirs.
        for (const { root } of authorized) {
          if (pasteLeases.has(root)) continue;
          const workspaceRoot = scopedRoot
            ? immutableRoot as string
            : path.dirname(path.dirname(root));
          const lease = openWorkspacePasteDirectorySync(workspaceRoot, {
            forcePathFallback: this.forcePathFallback,
            createIfMissing: false,
          });
          if (lease.canonicalPath !== root || lease.entryMutationPolicy === 'deny') {
            lease.close();
            throw Object.assign(new Error('Refusing an unsafe paste cleanup root'), {
              code: 'UNSAFE_PASTE_DIR',
            });
          }
          lease.verify();
          pasteLeases.set(root, lease);
        }

        for (const { root, candidate } of authorized) {
          const lease = pasteLeases.get(root);
          if (!lease) throw new Error('Paste cleanup root lease is unavailable');
          const entryPath = path.join(lease.accessPath, path.basename(candidate));
          lease.verify();
          const state = await fs.promises.lstat(entryPath, { bigint: true }).catch(() => null);
          if (!state || state.isSymbolicLink() || !state.isFile()) continue;
          if (lease.entryMutationPolicy === 'cwd-helper') {
            removeWorkspaceCwdEntry(
              lease, path.basename(candidate), { dev: state.dev, ino: state.ino },
            );
          } else {
            await fs.promises.unlink(entryPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
          lease.verify();
        }

        await unlinkSessionEntry(manifestFile);
      } catch (error) {
        console.error('Failed to delete pasted images:', error);
      } finally {
        for (const lease of pasteLeases.values()) lease.close();
      }
    }).catch(() => undefined);
  }
}
