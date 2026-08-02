import path from 'node:path';
import type { Response } from 'express';
import {
  classifyProjectContainerPath,
  execProjectContainerCommand,
  mustRetainProjectLease,
  rethrowIfProjectLeaseMustBeRetained,
  UnverifiedProjectFileProcessError,
  validateProjectContainerPath,
  type ProjectContainerPathLifetime,
  type ProjectSessionFileProcess,
  type ProjectSessionEnvironmentResult,
  type ProjectsSessionApi,
} from './working-dir.js';

export {
  mustRetainProjectLease,
  rethrowIfProjectLeaseMustBeRetained,
  UnverifiedProjectFileProcessError,
} from './working-dir.js';

type PreparedProject = Extract<ProjectSessionEnvironmentResult, { ok: true }>;

export interface ContainerFileStat {
  type: 'file' | 'directory' | 'other';
  size: number;
  mtimeMs: number;
}

export interface ContainerDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

export interface ConfinedContainerPath {
  path: string | null;
  base: string;
  missing: boolean;
}

export interface ContainerCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const REALPATH_SCRIPT = [
  "const fs = require('node:fs');",
  'try { process.stdout.write(fs.realpathSync(process.argv[1])); }',
  'catch { process.exit(2); }',
].join('\n');

const STAT_SCRIPT = [
  "const fs = require('node:fs');",
  'try {',
  '  const stat = fs.statSync(process.argv[1]);',
  "  const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';",
  '  process.stdout.write(JSON.stringify({ type, size: stat.size, mtimeMs: stat.mtimeMs }));',
  '} catch { process.exit(2); }',
].join('\n');

const LIST_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path').posix;",
  'try {',
  '  const root = process.argv[1];',
  '  const limit = Number(process.argv[2]);',
  "  const showHidden = process.argv[3] === '1';",
  '  const found = fs.readdirSync(root, { withFileTypes: true })',
  "    .filter((entry) => showHidden || !entry.name.startsWith('.'));",
  '  const entries = found.slice(0, limit).map((entry) => {',
  '    const full = path.join(root, entry.name);',
  '    let size;',
  '    if (entry.isFile()) { try { size = fs.statSync(full).size; } catch {} }',
  '    return { name: entry.name, path: full, isDirectory: entry.isDirectory(),',
  '      ...(size === undefined ? {} : { size }) };',
  '  });',
  '  process.stdout.write(JSON.stringify({ entries, truncated: found.length > limit }));',
  '} catch { process.exit(2); }',
].join('\n');

const READ_BASE64_SCRIPT = [
  "const fs = require('node:fs');",
  'try {',
  '  const value = fs.readFileSync(process.argv[1]);',
  '  const limit = Number(process.argv[2]);',
  '  if (!Number.isSafeInteger(limit) || limit < 0 || value.length > limit) process.exit(3);',
  "  process.stdout.write(value.toString('base64'));",
  '} catch { process.exit(2); }',
].join('\n');

const READ_HEAD_BASE64_SCRIPT = [
  "const fs = require('node:fs');",
  'let handle;',
  'try {',
  '  const count = Number(process.argv[2]);',
  '  if (!Number.isSafeInteger(count) || count < 0) process.exit(3);',
  "  handle = fs.openSync(process.argv[1], 'r');",
  '  const buffer = Buffer.alloc(count);',
  '  const bytesRead = fs.readSync(handle, buffer, 0, count, 0);',
  "  process.stdout.write(buffer.subarray(0, bytesRead).toString('base64'));",
  '} catch { process.exit(2); }',
  'finally { if (handle !== undefined) { try { fs.closeSync(handle); } catch {} } }',
].join('\n');

const CREATE_DIRECTORY_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path').posix;",
  'try {',
  '  const parent = fs.realpathSync(process.argv[1]);',
  '  const name = process.argv[2];',
  "  if (!name || path.basename(name) !== name || name === '.' || name === '..') process.exit(3);",
  '  const target = path.join(parent, name);',
  '  fs.mkdirSync(target);',
  '  process.stdout.write(fs.realpathSync(target));',
  '} catch (error) {',
  "  if (error && error.code === 'EEXIST') process.exit(17);",
  '  process.exit(2);',
  '}',
].join('\n');

const WALK_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path').posix;",
  'const root = process.argv[1];',
  'const maxFiles = Number(process.argv[2]);',
  'const maxDirs = Number(process.argv[3]);',
  "const skip = new Set(JSON.parse(process.argv[4] || '[]'));",
  'const paths = [];',
  "const queue = ['.'];",
  'let visited = 0;',
  'let truncated = false;',
  'while (queue.length) {',
  '  if (visited++ >= maxDirs) { truncated = true; break; }',
  '  const relative = queue.shift();',
  '  let entries;',
  '  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }',
  '  catch { continue; }',
  '  for (const entry of entries) {',
  '    if (entry.isSymbolicLink()) continue;',
  "    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;",
  '    if (entry.isDirectory()) { if (!skip.has(entry.name)) queue.push(child); continue; }',
  '    if (!entry.isFile()) continue;',
  '    if (paths.length >= maxFiles) { truncated = true; queue.length = 0; break; }',
  '    paths.push(child);',
  '  }',
  '}',
  "process.stdout.write(JSON.stringify({ paths, truncated, source: 'walk' }));",
].join('\n');

const STREAM_TIMEOUT_MS = 5 * 60_000;
const WRITE_TIMEOUT_MS = 2 * 60_000;
const MAX_BUFFERED_WRITE_BYTES = 64 * 1024 * 1024;
const MAX_ACP_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Lease-bound access to paths that exist only inside one project container.
 *
 * Every executable and helper script is a server-owned constant. Browser text
 * is carried only as a single argv value after lexical confinement; it can
 * never choose a command, engine, container name or shell fragment.
 */
export class ProjectContainerFiles {
  readonly root: string;
  private readonly node: string;

  constructor(
    private readonly manager: ProjectsSessionApi,
    readonly prepared: PreparedProject,
    root: string,
  ) {
    this.root = validateProjectContainerPath(prepared.containerAccess, root);
    this.node = prepared.environment.nodePath;
  }

  lifetime(value: string): ProjectContainerPathLifetime {
    return classifyProjectContainerPath(this.prepared.containerAccess, value);
  }

  /** Lexically confine a request to this browser/session root. */
  lexical(requested: string): string | null {
    let candidate: string;
    try {
      candidate = validateProjectContainerPath(
        this.prepared.containerAccess,
        path.posix.resolve(this.root, requested || '.'),
      );
    } catch {
      return null;
    }
    return inside(this.root, candidate) ? candidate : null;
  }

  /** Follow links and prove the existing target still stays under the root. */
  async confineExisting(requested: string): Promise<ConfinedContainerPath> {
    const lexical = this.lexical(requested);
    if (!lexical) return { path: null, base: this.root, missing: false };
    const [base, target] = await Promise.all([
      this.realpath(this.root),
      this.realpath(lexical),
    ]);
    if (!base) return { path: null, base: this.root, missing: true };
    if (!target) return { path: null, base, missing: true };
    return inside(base, target)
      ? { path: target, base, missing: false }
      : { path: null, base, missing: false };
  }

  async realpath(value: string): Promise<string | null> {
    let requested: string;
    try {
      requested = validateProjectContainerPath(this.prepared.containerAccess, value);
    } catch {
      return null;
    }
    try {
      const result = await execProjectContainerCommand(
        this.manager,
        this.prepared,
        this.prepared.containerAccess.root,
        this.node,
        ['-e', REALPATH_SCRIPT, requested],
      );
      return validateProjectContainerPath(
        this.prepared.containerAccess,
        result.stdout.trim(),
      );
    } catch (error) {
      rethrowIfProjectLeaseMustBeRetained(error);
      return null;
    }
  }

  async stat(value: string): Promise<ContainerFileStat | null> {
    try {
      const result = await this.exec(this.node, ['-e', STAT_SCRIPT, value], '/');
      if (!result.ok) return null;
      const parsed = JSON.parse(result.stdout) as Partial<ContainerFileStat>;
      if (
        (parsed.type !== 'file' && parsed.type !== 'directory' && parsed.type !== 'other')
        || typeof parsed.size !== 'number'
        || typeof parsed.mtimeMs !== 'number'
      ) return null;
      return parsed as ContainerFileStat;
    } catch (error) {
      rethrowIfProjectLeaseMustBeRetained(error);
      return null;
    }
  }

  async list(
    directory: string,
    limit: number,
    showHidden = true,
  ): Promise<{ entries: ContainerDirectoryEntry[]; truncated: boolean }> {
    const result = await this.exec(
      this.node,
      ['-e', LIST_SCRIPT, directory, String(limit), showHidden ? '1' : '0'],
      '/',
    );
    if (!result.ok) throw new Error('cannot list project container directory');
    const parsed = JSON.parse(result.stdout) as {
      entries?: ContainerDirectoryEntry[];
      truncated?: boolean;
    };
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      truncated: parsed.truncated === true,
    };
  }

  async readBuffer(value: string, limit: number): Promise<Buffer> {
    const result = await this.exec(
      this.node,
      ['-e', READ_BASE64_SCRIPT, value, String(limit)],
      '/',
    );
    if (!result.ok) throw new Error('cannot read project container file');
    const buffer = Buffer.from(result.stdout, 'base64');
    if (buffer.length > limit) throw new Error('project container file exceeded read limit');
    return buffer;
  }

  async readHead(value: string, count: number): Promise<Buffer> {
    const result = await this.exec(
      this.node,
      ['-e', READ_HEAD_BASE64_SCRIPT, value, String(count)],
      '/',
    );
    if (!result.ok) throw new Error('cannot read project container file');
    const buffer = Buffer.from(result.stdout, 'base64');
    if (buffer.length > count) throw new Error('project container head exceeded read limit');
    return buffer;
  }

  async walkFiles(
    maxFiles: number,
    maxDirectories: number,
    skippedDirectories: readonly string[],
  ): Promise<{ paths: string[]; truncated: boolean; source: 'walk' }> {
    const result = await this.exec(
      this.node,
      [
        '-e',
        WALK_SCRIPT,
        this.root,
        String(maxFiles),
        String(maxDirectories),
        JSON.stringify(skippedDirectories),
      ],
      '/',
    );
    if (!result.ok) return { paths: [], truncated: false, source: 'walk' };
    const parsed = JSON.parse(result.stdout) as { paths?: unknown; truncated?: unknown };
    return {
      paths: Array.isArray(parsed.paths)
        ? parsed.paths.filter((entry): entry is string => typeof entry === 'string').slice(0, maxFiles)
        : [],
      truncated: parsed.truncated === true,
      source: 'walk',
    };
  }

  async createDirectory(parent: string, name: string): Promise<string> {
    const result = await this.exec(
      this.node,
      ['-e', CREATE_DIRECTORY_SCRIPT, parent, name],
      '/',
    );
    if (!result.ok) {
      const error = new Error('cannot create project container directory') as Error & { code?: string };
      if (result.code === 17) error.code = 'EEXIST';
      throw error;
    }
    return validateProjectContainerPath(
      this.prepared.containerAccess,
      result.stdout.trim(),
    );
  }

  /** Read one ACP text file after canonical, symlink-aware confinement. */
  async readText(requested: string): Promise<string> {
    const confined = await this.confineExisting(requested);
    if (!confined.path) {
      throw new Error(
        confined.missing
          ? `no such project container file: ${requested}`
          : `refusing to read ${requested}: outside the session directory`,
      );
    }
    const stat = await this.stat(confined.path);
    if (!stat || stat.type !== 'file') throw new Error(`not a regular file: ${requested}`);
    if (stat.size > MAX_ACP_TEXT_BYTES) {
      throw new Error('project container text file exceeds the ACP read limit');
    }
    return (await this.readBuffer(confined.path, MAX_ACP_TEXT_BYTES)).toString('utf8');
  }

  /**
   * Write one ACP text file, creating missing parent directories one safe path
   * segment at a time. Existing links are canonicalised and must remain below
   * the session root; a newly created leaf is written exclusively so a link
   * cannot be swapped in between validation and creation.
   */
  async writeText(requested: string, contents: string): Promise<void> {
    const bytes = Buffer.from(contents, 'utf8');
    if (bytes.length > MAX_ACP_TEXT_BYTES) {
      throw new Error('project container text file exceeds the ACP write limit');
    }
    const destination = await this.confineWritable(requested);
    await this.writeFile(destination.path, bytes, destination.exclusive);
  }

  private async confineWritable(
    requested: string,
  ): Promise<{ path: string; exclusive: boolean }> {
    const lexical = this.lexical(requested);
    if (!lexical) {
      throw new Error(`refusing to write ${requested}: outside the session directory`);
    }
    const base = await this.realpath(this.root);
    if (!base) throw new Error('the session directory no longer exists');

    const existing = await this.realpath(lexical);
    if (existing) {
      if (!inside(base, existing)) {
        throw new Error(`refusing to write ${requested}: outside the session directory`);
      }
      const stat = await this.stat(existing);
      if (!stat || stat.type !== 'file') throw new Error(`not a regular file: ${requested}`);
      return { path: existing, exclusive: false };
    }

    const relative = path.posix.relative(this.root, lexical);
    const pieces = relative.split('/').filter(Boolean);
    const leaf = pieces.pop();
    if (!leaf) throw new Error('the session directory is not a writable file');

    let parent = base;
    for (const piece of pieces) {
      const candidate = path.posix.join(parent, piece);
      let canonical = await this.realpath(candidate);
      if (!canonical) {
        try {
          canonical = await this.createDirectory(parent, piece);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          canonical = await this.realpath(candidate);
          if (!canonical) throw error;
        }
      }
      if (!inside(base, canonical)) {
        throw new Error(`refusing to write ${requested}: outside the session directory`);
      }
      const stat = await this.stat(canonical);
      if (!stat || stat.type !== 'directory') {
        throw new Error(`not a directory in project container path: ${piece}`);
      }
      parent = canonical;
    }

    return { path: path.posix.join(parent, leaf), exclusive: true };
  }

  async exec(
    command: string,
    args: string[],
    cwd = this.root,
    timeoutMs = 10_000,
  ): Promise<ContainerCommandResult> {
    try {
      const result = await execProjectContainerCommand(
        this.manager,
        this.prepared,
        cwd,
        command,
        args,
        timeoutMs,
      );
      return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      rethrowIfProjectLeaseMustBeRetained(error);
      const failed = error as Error & {
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
      };
      return {
        ok: false,
        stdout: String(failed.stdout || ''),
        stderr: String(failed.stderr || failed.message || ''),
        code: typeof failed.code === 'number' ? failed.code : -1,
      };
    }
  }

  /** Pipe a bounded byte range to an HTTP response and finish on child exit. */
  async streamFile(
    res: Response,
    value: string,
    range: { start: number; end: number } | null,
  ): Promise<void> {
    const child = await this.manager.spawnSessionFileCommand(
      this.prepared.containerAccess.ownerUserId,
      this.prepared.containerAccess.projectId,
      this.prepared.leaseId,
      {
        operation: 'read',
        path: value,
        ...(range
          ? { offset: range.start, length: range.end - range.start + 1 }
          : {}),
      },
    );
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      let settled = false;
      let closeObserved = false;
      let terminationError: Error | undefined;
      let verification: Promise<void> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        res.off('close', onResponseClose);
        if (error) reject(error);
        else resolve();
      };
      const terminate = (error: Error): void => {
        terminationError ??= error;
        child.stdout.unpipe(res);
        verification ??= stopProjectFileProcess(child, true);
        void verification.then(
          () => finish(terminationError),
          (stopError) => finish(stopError),
        );
      };
      const onResponseClose = (): void => {
        if (res.writableEnded) return;
        terminate(new Error('project container file response closed'));
      };
      const deadline = setTimeout(() => {
        terminate(new Error('project container file read timed out'));
      }, STREAM_TIMEOUT_MS);
      deadline.unref?.();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
      });
      child.once('error', (error) => {
        // Node guarantees `close` after an emitted child error. Keep the lease
        // until that close; the deadline remains as the kill backstop.
        terminationError ??= error;
      });
      const onClose = (code: number | null): void => {
        if (closeObserved) return;
        closeObserved = true;
        verification ??= stopProjectFileProcess(child, false, true);
        void verification.then(() => {
          if (terminationError) finish(terminationError);
          else if (code === 0) finish();
          else finish(new Error(stderr.trim() || 'project container file read failed'));
        }, finish);
      };
      child.once('close', onClose);
      res.once('close', onResponseClose);
      child.stdin.end();
      child.stdout.pipe(res);
      // The manager may need an asynchronous immutable-identity check after
      // spawning. A tiny helper can close during that check, before ownership
      // reaches this listener. Closed streams make that missed event explicit.
      if (localProjectFileClientClosed(child)) {
        queueMicrotask(() => onClose(child.exitCode));
      }
    });
  }

  /** Write raw bytes through the manager's fixed binary-safe descriptor. */
  async writeFile(value: string, bytes: Buffer, exclusive = false): Promise<void> {
    if (bytes.length > MAX_BUFFERED_WRITE_BYTES) {
      throw new Error('project container file exceeds the buffered write limit');
    }
    const child = await this.manager.spawnSessionFileCommand(
      this.prepared.containerAccess.ownerUserId,
      this.prepared.containerAccess.projectId,
      this.prepared.leaseId,
      { operation: 'write', path: value, exclusive },
    );
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      let settled = false;
      let closeObserved = false;
      let terminationError: Error | undefined;
      let verification: Promise<void> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      const terminate = (error: Error): void => {
        terminationError ??= error;
        verification ??= stopProjectFileProcess(child, true);
        void verification.then(
          () => finish(terminationError),
          (stopError) => finish(stopError),
        );
      };
      const deadline = setTimeout(() => {
        terminate(new Error('project container file write timed out'));
      }, WRITE_TIMEOUT_MS);
      deadline.unref?.();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
      });
      child.once('error', (error) => {
        terminationError ??= error;
      });
      child.stdin.once('error', (error) => {
        // EPIPE is the ordinary companion to a writer that rejected `wx`.
        // Its process close carries the useful stderr/code, and the deadline
        // still kills a child that somehow stays alive.
        terminationError ??= error;
      });
      const onClose = (code: number | null): void => {
        if (closeObserved) return;
        closeObserved = true;
        verification ??= stopProjectFileProcess(child, false, true);
        void verification.then(() => {
          if (typeof code === 'number' && code !== 0) {
            const error = new Error(stderr.trim() || 'project container file write failed') as
              Error & { code?: string };
            if (exclusive && /exist/i.test(stderr)) error.code = 'EEXIST';
            finish(error);
          } else if (terminationError) finish(terminationError);
          else if (code === 0) finish();
          else finish(new Error('project container file write failed'));
        }, finish);
      };
      child.once('close', onClose);
      child.stdin.end(bytes);
      if (localProjectFileClientClosed(child)) {
        queueMicrotask(() => onClose(child.exitCode));
      }
    });
  }
}

async function stopProjectFileProcess(
  child: ProjectSessionFileProcess,
  signalLocal: boolean,
  localAlreadyClosed = false,
): Promise<void> {
  let escalation: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const localClosed = localAlreadyClosed || localProjectFileClientClosed(child)
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const close = (): void => {
          if (escalation) clearTimeout(escalation);
          if (deadline) clearTimeout(deadline);
          resolve();
        };
        child.once('close', close);
        if (signalLocal) {
          try { child.kill('SIGTERM'); } catch { /* close remains authoritative */ }
          escalation = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try { child.kill('SIGKILL'); } catch { /* close remains authoritative */ }
            }
          }, 500);
          escalation.unref?.();
        }
        deadline = setTimeout(() => {
          child.off('close', close);
          reject(new Error('local project container file client did not close'));
        }, 12_000);
        deadline.unref?.();
      });

  const hasRemoteControl = typeof child.processControl?.stop === 'function';
  const remoteClosed = hasRemoteControl
    ? Promise.resolve().then(() => child.processControl.stop())
    : Promise.reject(new Error('project file helper has no remote process control'));
  const [localResult, remoteResult] = await Promise.allSettled([localClosed, remoteClosed]);
  if (remoteResult.status === 'rejected') {
    const detail = remoteResult.reason instanceof Error
      ? remoteResult.reason.message
      : String(remoteResult.reason);
    throw new UnverifiedProjectFileProcessError(
      `Could not verify that the project file helper stopped: ${detail}`,
      hasRemoteControl
        ? () => stopProjectFileProcess(
            child,
            true,
            localResult.status === 'fulfilled' || localProjectFileClientClosed(child),
          )
        : undefined,
    );
  }
  if (localResult.status === 'rejected') {
    throw new UnverifiedProjectFileProcessError(
      (localResult.reason as Error).message,
      () => stopProjectFileProcess(child, true, localProjectFileClientClosed(child)),
    );
  }
}

function localProjectFileClientClosed(child: ProjectSessionFileProcess): boolean {
  return (child.exitCode !== null || child.signalCode !== null)
    && child.stdin.destroyed
    && child.stdout.destroyed
    && child.stderr.destroyed;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
}
