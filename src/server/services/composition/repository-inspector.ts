import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  COMPOSITION_CATALOG,
  COMPOSITION_CATALOG_VERSION,
  RuntimeId,
  getRuntimeCatalogEntry,
  isConservativeRuntimeVersion,
} from './catalog.js';

export interface RepositoryInspectionLimits {
  readonly wallClockMs: number;
  readonly commandMs: number;
  readonly maxTreeEntries: number;
  readonly maxPathDepth: number;
  readonly maxMarkers: number;
  readonly maxBlobBytes: number;
  readonly maxTotalBlobBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Hard cumulative ceiling for the isolated bare repository and metadata. */
  readonly maxRepositoryBytes: number;
}

export const DEFAULT_REPOSITORY_INSPECTION_LIMITS: RepositoryInspectionLimits = Object.freeze({
  wallClockMs: 45_000,
  commandMs: 15_000,
  maxTreeEntries: 20_000,
  maxPathDepth: 12,
  maxMarkers: 64,
  maxBlobBytes: 64 * 1024,
  maxTotalBlobBytes: 512 * 1024,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 32 * 1024,
  maxRepositoryBytes: 64 * 1024 * 1024,
});

export type RepositoryInspectionErrorCode =
  | 'unsupported_platform'
  | 'invalid_url'
  | 'credential_required'
  | 'repository_unavailable'
  | 'invalid_repository'
  | 'limit_exceeded'
  | 'timed_out'
  | 'cancelled';

export class RepositoryInspectionError extends Error {
  constructor(
    public readonly code: RepositoryInspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryInspectionError';
  }
}

/** Internal, secret-free signal that the isolated repository hit its byte cap. */
export class GitStorageLimitError extends Error {
  readonly code = 'CAWC_INSPECTION_STORAGE_LIMIT';

  constructor() {
    super('Git inspection storage limit exceeded');
    this.name = 'GitStorageLimitError';
  }
}

export interface GitRunRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Per-file ceiling inherited by Git and every transport/index helper. */
  readonly maxFileBytes?: number;
  /** Fresh app-owned root used to identify an RLIMIT_FSIZE failure safely. */
  readonly storageRoot?: string;
  readonly signal?: AbortSignal;
}

export interface GitRunResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type GitRunner = (request: GitRunRequest) => Promise<GitRunResult>;

export interface InspectionFetchResponse {
  readonly status: number;
  readonly body?: { cancel(): Promise<void> } | null;
}

export type InspectionFetch = (
  url: string,
  init: {
    method: 'GET';
    redirect: 'error';
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<InspectionFetchResponse>;

export interface RepositoryInspectorDependencies {
  readonly runner?: GitRunner;
  readonly fetch?: InspectionFetch;
  readonly tempRoot?: string;
  readonly limits?: Partial<RepositoryInspectionLimits>;
  /** Injectable so Windows's explicit unsupported path is testable on Unix. */
  readonly platform?: NodeJS.Platform;
}

export interface InspectRepositoryOptions {
  readonly repoUrl: string;
  readonly credential?: string | null;
  readonly signal?: AbortSignal;
}

export interface DetectedVersionHint {
  readonly path: string;
  /** A validated numeric literal. Invalid/dynamic source text is never echoed. */
  readonly version: string;
}

export interface DetectedRuntime {
  readonly runtimeId: RuntimeId;
  readonly sources: readonly string[];
  readonly versionHints: readonly DetectedVersionHint[];
  readonly selectedVersion: string;
  readonly versionSource: 'marker' | 'catalog_default';
}

export interface RepositoryInspectionResult {
  readonly catalogVersion: typeof COMPOSITION_CATALOG_VERSION;
  readonly sourceOid: string;
  readonly sourceRef: string;
  readonly forgeHint: Readonly<{ kind: 'github' | 'gitlab'; host: string }> | null;
  readonly detectedRuntimes: readonly DetectedRuntime[];
}

interface Marker {
  path: string;
  oid: string;
  runtimes: readonly RuntimeId[];
  contentRequired: boolean;
}

interface MutableDetection {
  sources: Set<string>;
  hints: DetectedVersionHint[];
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+$/;
const VERSION_LITERAL = /^(?:v|node-|python-|go)?((?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,3})){0,3})$/i;

function inspectionUrl(input: string): URL | null {
  try {
    if (input.includes('?') || input.includes('#')) return null;
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function fixedGitArgs(args: readonly string[], authenticated: boolean): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    // One incoming pack is enforceable with RLIMIT_FSIZE. A value of zero
    // disables this threshold; one forces every non-empty fetch through
    // index-pack instead of expanding it into arbitrarily many loose objects.
    '-c', 'fetch.unpackLimit=1',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'http.followRedirects=false',
    '-c', 'http.lowSpeedLimit=1024',
    '-c', 'http.lowSpeedTime=10',
    ...(authenticated ? ['--config-env=http.extraHeader=CAWC_INSPECTION_HTTP_HEADER'] : []),
    ...args,
  ];
}

function safeErrorMessage(error: unknown, credential?: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutCredential = credential ? raw.split(credential).join('***') : raw;
  // Git/curl errors can reflect URL userinfo or arbitrary server text.  The
  // public error is intentionally a small app-owned vocabulary.
  return withoutCredential.slice(0, 240).replace(/[\r\n\0]/g, ' ');
}

const POSIX_FILE_LIMIT_BLOCK_BYTES = 512;
const LIMITED_GIT_SCRIPT = 'limit_blocks=$1; shift; ulimit -c 0 || exit 125; ulimit -f "$limit_blocks" || exit 125; exec git "$@"';

interface InspectionStorageMeasurement {
  totalBytes: number;
  largestFileBytes: number;
}

function chargedStorageBytes(stat: Awaited<ReturnType<typeof lstat>>): number {
  const logical = Number(stat.size);
  const blocks = Number(stat.blocks);
  const allocated = Number.isSafeInteger(blocks) && blocks > 0
    ? blocks * POSIX_FILE_LIMIT_BLOCK_BYTES
    : 0;
  return Math.max(
    Number.isSafeInteger(logical) && logical > 0 ? logical : 0,
    Number.isSafeInteger(allocated) && allocated > 0 ? allocated : 0,
  );
}

function storageInodeKey(stat: Awaited<ReturnType<typeof lstat>>): string | null {
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  return Number.isSafeInteger(dev) && Number.isSafeInteger(ino) && ino > 0
    ? `${dev}:${ino}`
    : null;
}

/** Count a fresh inspector tree without following repository-created links. */
async function measureInspectionStorage(
  root: string,
  stopAfterBytes = Number.MAX_SAFE_INTEGER,
): Promise<InspectionStorageMeasurement> {
  const pending = [root];
  const seen = new Set<string>();
  let totalBytes = 0;
  let largestFileBytes = 0;
  while (pending.length) {
    const candidate = pending.pop()!;
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const key = storageInodeKey(stat);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const charged = chargedStorageBytes(stat);
    totalBytes += charged;
    if (stat.isFile()) largestFileBytes = Math.max(largestFileBytes, Number(stat.size));
    if (totalBytes > stopAfterBytes) return { totalBytes, largestFileBytes };
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    const directory = await opendir(candidate);
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        pending.push(join(candidate, entry.name));
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return { totalBytes, largestFileBytes };
}

async function assertInspectionStorageBound(root: string, maxBytes: number): Promise<void> {
  const measured = await measureInspectionStorage(root, maxBytes);
  if (measured.totalBytes > maxBytes) throw new GitStorageLimitError();
}

function effectiveFileLimit(maxBytes: number): { blocks: number; bytes: number } {
  // POSIX specifies ulimit -f in 512-byte blocks. Round down so the inherited
  // per-file hard stop never exceeds the requested cumulative limit. Limits
  // below one block still get the smallest enforceable ceiling and are caught
  // exactly by the cumulative post-command walk.
  const blocks = Math.max(1, Math.floor(maxBytes / POSIX_FILE_LIMIT_BLOCK_BYTES));
  return { blocks, bytes: blocks * POSIX_FILE_LIMIT_BLOCK_BYTES };
}

export const defaultGitRunner: GitRunner = (request) => new Promise((resolvePromise, reject) => {
  if (request.maxFileBytes !== undefined
    && (!Number.isSafeInteger(request.maxFileBytes) || request.maxFileBytes <= 0)) {
    reject(new Error('Git file size limit is invalid'));
    return;
  }
  const fileLimit = request.maxFileBytes === undefined
    ? null
    : effectiveFileLimit(request.maxFileBytes);
  const child = spawn(fileLimit ? '/bin/sh' : 'git', fileLimit
    ? ['-c', LIMITED_GIT_SCRIPT, 'sh', String(fileLimit.blocks), ...request.args]
    : [...request.args], {
    cwd: request.cwd,
    env: { ...request.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Timeouts and byte-limit failures must retire transport/index helpers too,
    // not merely the top-level git process while a grandchild keeps writing.
    detached: process.platform !== 'win32',
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: Error | null = null;
  let settled = false;

  const stop = (error: Error): void => {
    if (!failure) failure = error;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // The process group can already have exited between the event and kill.
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > request.maxStdoutBytes) stop(new Error('Git stdout limit exceeded'));
    else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > request.maxStderrBytes) stop(new Error('Git stderr limit exceeded'));
    else stderr.push(chunk);
  });
  child.on('error', (error) => stop(error));

  const timer = setTimeout(() => stop(new Error('Git command timed out')), request.timeoutMs);
  timer.unref();
  const cancel = (): void => stop(new Error('Git command cancelled'));
  request.signal?.addEventListener('abort', cancel, { once: true });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
    if (failure) return reject(failure);
    const stdoutResult = Buffer.concat(stdout);
    const stderrResult = Buffer.concat(stderr);
    void (async () => {
      if (code !== 0) {
        const capText = stderrResult.toString('utf8');
        let reachedFileLimit = signal === 'SIGXFSZ'
          || /(?:signal 25|file size limit exceeded|file too large)/i.test(capText);
        if (!reachedFileLimit && fileLimit && request.storageRoot) {
          try {
            reachedFileLimit = (await measureInspectionStorage(
              request.storageRoot,
              request.maxFileBytes,
            )).largestFileBytes >= fileLimit.bytes;
          } catch {
            // Keep the original private Git failure if measuring it also failed.
          }
        }
        if (reachedFileLimit) throw new GitStorageLimitError();
        throw new Error(`Git command failed with status ${code ?? signal ?? 'unknown'}`);
      }
      resolvePromise({ stdout: stdoutResult, stderr: stderrResult });
    })().catch(reject);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(request.input || '');
});

function defaultFetch(url: string, init: Parameters<InspectionFetch>[1]): Promise<InspectionFetchResponse> {
  return globalThis.fetch(url, init) as Promise<InspectionFetchResponse>;
}

export class RepositoryInspector {
  private readonly runner: GitRunner;
  private readonly fetch_: InspectionFetch;
  private readonly tempRoot: string;
  private readonly limits: RepositoryInspectionLimits;
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: RepositoryInspectorDependencies = {}) {
    this.runner = dependencies.runner || defaultGitRunner;
    this.fetch_ = dependencies.fetch || defaultFetch;
    this.tempRoot = resolve(dependencies.tempRoot || tmpdir());
    this.platform = dependencies.platform || process.platform;
    this.limits = Object.freeze({
      ...DEFAULT_REPOSITORY_INSPECTION_LIMITS,
      ...dependencies.limits,
    });
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Repository inspection limit ${name} must be a positive integer`);
      }
    }
  }

  async inspect(options: InspectRepositoryOptions): Promise<RepositoryInspectionResult> {
    if (this.platform === 'win32') {
      // The isolated fetch relies on POSIX RLIMIT_FSIZE and deliberately
      // minimal Unix process paths. Fail explicitly instead of exposing a
      // repository launcher path that cannot complete safely on Windows.
      throw new RepositoryInspectionError(
        'unsupported_platform',
        'Repository inspection is unavailable on Windows; create a project without a repository or use the server edition on Linux.',
      );
    }
    if (options.signal?.aborted) {
      throw new RepositoryInspectionError('cancelled', 'Repository inspection was cancelled');
    }
    if (options.repoUrl.length > 4_096) {
      throw new RepositoryInspectionError('invalid_url', 'Repository URL is too long');
    }
    const url = inspectionUrl(options.repoUrl);
    if (!url) {
      throw new RepositoryInspectionError(
        'invalid_url',
        'Repository URL must be plain HTTPS without credentials, query, or fragment',
      );
    }
    if (options.credential && (options.credential.length > 16_384
      || options.credential.includes('\0')
      || options.credential.includes('\r')
      || options.credential.includes('\n'))) {
      throw new RepositoryInspectionError('credential_required', 'Repository credential is invalid');
    }
    const started = Date.now();
    let inspectionRoot: string | null = null;
    try {
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      inspectionRoot = await mkdtemp(join(this.tempRoot, 'composition-inspect-'));
      const home = join(inspectionRoot, 'home');
      const template = join(inspectionRoot, 'git-template');
      const gitDir = join(inspectionRoot, 'repository.git');
      const globalConfig = join(inspectionRoot, 'empty-gitconfig');
      await Promise.all([
        mkdir(home, { mode: 0o700 }),
        mkdir(template, { mode: 0o700 }),
        writeFile(globalConfig, '', { mode: 0o600 }),
      ]);

      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        XDG_CONFIG_HOME: home,
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_TEMPLATE_DIR: template,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_PROTOCOL_FROM_USER: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CEILING_DIRECTORIES: inspectionRoot,
        ...(options.credential
          ? { CAWC_INSPECTION_HTTP_HEADER: `Authorization: Bearer ${options.credential}` }
          : {}),
      };

      await this.preflight(url, options, started);
      await this.git(['init', '--bare', `--template=${template}`, gitDir], false, inspectionRoot, env, options, started);
      const remote = await this.git(
        ['ls-remote', '--symref', options.repoUrl, 'HEAD'],
        true,
        inspectionRoot,
        env,
        options,
        started,
      );
      const { oid, ref } = parseRemoteHead(remote.stdout);

      await this.git(
        ['--git-dir', gitDir, 'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', options.repoUrl, oid],
        true,
        inspectionRoot,
        env,
        options,
        started,
      );
      const fetched = (await this.git(
        ['--git-dir', gitDir, 'rev-parse', '--verify', 'FETCH_HEAD'],
        false,
        inspectionRoot,
        env,
        options,
        started,
      )).stdout.toString('ascii').trim();
      if (fetched !== oid) {
        throw new RepositoryInspectionError('invalid_repository', 'Repository changed while its immutable revision was fetched');
      }
      const type = (await this.git(
        ['--git-dir', gitDir, 'cat-file', '-t', oid],
        false,
        inspectionRoot,
        env,
        options,
        started,
      )).stdout.toString('ascii').trim();
      if (type !== 'commit') {
        throw new RepositoryInspectionError('invalid_repository', 'Repository HEAD is not a commit');
      }

      const tree = await this.git(
        ['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--full-tree', oid],
        false,
        inspectionRoot,
        env,
        options,
        started,
      );
      const markers = parseTreeMarkers(tree.stdout, this.limits);
      const detections = new Map<RuntimeId, MutableDetection>();
      let totalBytes = 0;
      for (const marker of markers) {
        for (const runtimeId of marker.runtimes) {
          let detection = detections.get(runtimeId);
          if (!detection) {
            detection = { sources: new Set(), hints: [] };
            detections.set(runtimeId, detection);
          }
          detection.sources.add(marker.path);
        }
        if (!marker.contentRequired) continue;
        const sizeText = (await this.git(
          ['--git-dir', gitDir, 'cat-file', '-s', marker.oid],
          false,
          inspectionRoot,
          env,
          options,
          started,
        )).stdout.toString('ascii').trim();
        if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText)) {
          throw new RepositoryInspectionError('invalid_repository', 'Repository returned an invalid marker size');
        }
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size) || size > this.limits.maxBlobBytes) {
          throw new RepositoryInspectionError('limit_exceeded', 'A repository marker exceeds the inspection size limit');
        }
        totalBytes += size;
        if (totalBytes > this.limits.maxTotalBlobBytes) {
          throw new RepositoryInspectionError('limit_exceeded', 'Repository markers exceed the total inspection size limit');
        }
        const blob = (await this.git(
          ['--git-dir', gitDir, 'cat-file', 'blob', marker.oid],
          false,
          inspectionRoot,
          env,
          options,
          started,
          Math.min(this.limits.maxStdoutBytes, this.limits.maxBlobBytes + 1),
        )).stdout;
        if (blob.length !== size) {
          throw new RepositoryInspectionError('invalid_repository', 'Repository marker size changed during inspection');
        }
        addHints(detections, marker, blob.toString('utf8'));
      }

      const detectedRuntimes = COMPOSITION_CATALOG.runtimes
        .filter((entry) => detections.has(entry.id))
        .map((entry): DetectedRuntime => {
          const detection = detections.get(entry.id)!;
          const versionHints = [...detection.hints]
            .sort((a, b) => a.path.localeCompare(b.path) || a.version.localeCompare(b.version));
          return Object.freeze({
            runtimeId: entry.id,
            sources: Object.freeze([...detection.sources].sort()),
            versionHints: Object.freeze(versionHints),
            selectedVersion: versionHints[0]?.version || getRuntimeCatalogEntry(entry.id).defaultVersion,
            versionSource: versionHints.length ? 'marker' : 'catalog_default',
          });
        });
      return Object.freeze({
        catalogVersion: COMPOSITION_CATALOG_VERSION,
        sourceOid: oid,
        sourceRef: ref,
        forgeHint: forgeHint(url),
        detectedRuntimes: Object.freeze(detectedRuntimes),
      });
    } catch (error) {
      if (error instanceof RepositoryInspectionError) throw error;
      if (error instanceof GitStorageLimitError) {
        throw new RepositoryInspectionError(
          'limit_exceeded',
          'Repository inspection exceeded its temporary storage limit',
        );
      }
      if (options.signal?.aborted) {
        throw new RepositoryInspectionError('cancelled', 'Repository inspection was cancelled');
      }
      const message = safeErrorMessage(error, options.credential);
      const timedOut = /timed out/i.test(message) || Date.now() - started >= this.limits.wallClockMs;
      if (/limit exceeded/i.test(message)) {
        throw new RepositoryInspectionError('limit_exceeded', 'Repository inspection exceeded a safety limit');
      }
      throw new RepositoryInspectionError(
        timedOut ? 'timed_out' : 'repository_unavailable',
        timedOut ? 'Repository inspection timed out' : `Repository inspection failed: ${message}`,
      );
    } finally {
      if (inspectionRoot) {
        try {
          await rm(inspectionRoot, { recursive: true, force: true });
        } catch {
          throw new RepositoryInspectionError('repository_unavailable', 'Repository inspection cleanup failed');
        }
      }
    }
  }

  private async preflight(
    url: URL,
    options: InspectRepositoryOptions,
    started: number,
  ): Promise<void> {
    const refs = new URL(`${url.pathname.replace(/\/+$/, '')}/info/refs`, url);
    refs.searchParams.set('service', 'git-upload-pack');
    const controller = new AbortController();
    const remaining = this.remaining(started);
    let rejectDeadline: ((error: RepositoryInspectionError) => void) | null = null;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline?.(new RepositoryInspectionError('timed_out', 'Repository access check timed out'));
    }, Math.min(this.limits.commandMs, remaining));
    timer.unref();
    const cancel = (): void => {
      controller.abort();
      rejectDeadline?.(new RepositoryInspectionError('cancelled', 'Repository inspection was cancelled'));
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await Promise.race([
        this.fetch_(refs.toString(), {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/x-git-upload-pack-advertisement',
            ...(options.credential ? { Authorization: `Bearer ${options.credential}` } : {}),
          },
          signal: controller.signal,
        }),
        deadline,
      ]);
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new RepositoryInspectionError('credential_required', 'Repository credentials are required or invalid');
      }
      if (response.status !== 200) {
        throw new RepositoryInspectionError('repository_unavailable', `Repository access returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof RepositoryInspectionError) throw error;
      if (options.signal?.aborted) throw new RepositoryInspectionError('cancelled', 'Repository inspection was cancelled');
      if (controller.signal.aborted) throw new RepositoryInspectionError('timed_out', 'Repository access check timed out');
      throw new RepositoryInspectionError('repository_unavailable', 'Repository access check failed');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  private remaining(started: number): number {
    const remaining = this.limits.wallClockMs - (Date.now() - started);
    if (remaining <= 0) throw new RepositoryInspectionError('timed_out', 'Repository inspection timed out');
    return remaining;
  }

  private async git(
    args: readonly string[],
    network: boolean,
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: InspectRepositoryOptions,
    started: number,
    maxStdoutBytes = this.limits.maxStdoutBytes,
  ): Promise<GitRunResult> {
    if (options.signal?.aborted) {
      throw new RepositoryInspectionError('cancelled', 'Repository inspection was cancelled');
    }
    const processEnv = { ...env };
    if (!network) delete processEnv.CAWC_INSPECTION_HTTP_HEADER;
    try {
      const result = await this.runner({
        args: fixedGitArgs(args, network && Boolean(options.credential)),
        cwd,
        env: processEnv,
        timeoutMs: Math.min(this.limits.commandMs, this.remaining(started)),
        maxStdoutBytes,
        maxStderrBytes: this.limits.maxStderrBytes,
        maxFileBytes: this.limits.maxRepositoryBytes,
        storageRoot: cwd,
        signal: options.signal,
      });
      await assertInspectionStorageBound(cwd, this.limits.maxRepositoryBytes);
      return result;
    } catch (error) {
      if (error instanceof GitStorageLimitError) throw error;
      // A custom runner or a Git failure can leave multiple individually-small
      // files. Check the cumulative cap on the failure path before translating
      // the private runner error into a public repository-unavailable result.
      await assertInspectionStorageBound(cwd, this.limits.maxRepositoryBytes);
      throw error;
    }
  }
}

export async function inspectRepository(
  options: InspectRepositoryOptions,
  dependencies: RepositoryInspectorDependencies = {},
): Promise<RepositoryInspectionResult> {
  return new RepositoryInspector(dependencies).inspect(options);
}

function parseRemoteHead(stdout: Buffer): { oid: string; ref: string } {
  const lines = stdout.toString('utf8').split('\n').filter(Boolean);
  let ref = 'HEAD';
  let oid: string | null = null;
  for (const line of lines) {
    const [value, name, extra] = line.split('\t');
    if (extra !== undefined || name !== 'HEAD') continue;
    if (value.startsWith('ref: ')) {
      const candidate = value.slice(5);
      if (SAFE_REF.test(candidate) && !candidate.includes('..') && !candidate.includes('//')) ref = candidate;
    } else if (OID.test(value)) {
      oid = value;
    }
  }
  if (!oid) throw new RepositoryInspectionError('invalid_repository', 'Repository HEAD could not be resolved');
  return { oid, ref };
}

function markerForPath(path: string): Omit<Marker, 'path' | 'oid'> | null {
  const name = basename(path).toLowerCase();
  if (name === 'package.json' || name === '.nvmrc' || name === '.node-version') {
    return { runtimes: ['node'], contentRequired: true };
  }
  if (['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(name)) {
    return { runtimes: ['node'], contentRequired: false };
  }
  if (name === 'pyproject.toml' || name === '.python-version' || name === 'runtime.txt') {
    return { runtimes: ['python'], contentRequired: true };
  }
  if (['requirements.txt', 'setup.py', 'setup.cfg', 'pipfile', 'poetry.lock'].includes(name)) {
    return { runtimes: ['python'], contentRequired: false };
  }
  if (name === '.php-version' || name === 'composer.json') {
    return { runtimes: ['php'], contentRequired: true };
  }
  if (name === 'composer.lock') return { runtimes: ['php'], contentRequired: false };
  if (name === 'go.mod') return { runtimes: ['go'], contentRequired: true };
  if (name === 'go.sum') return { runtimes: ['go'], contentRequired: false };
  if (name === 'rust-toolchain' || name === 'rust-toolchain.toml') {
    return { runtimes: ['rust'], contentRequired: true };
  }
  if (name === 'cargo.toml' || name === 'cargo.lock') return { runtimes: ['rust'], contentRequired: false };
  if (name === '.java-version' || name === 'pom.xml') return { runtimes: ['java'], contentRequired: true };
  if (['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew'].includes(name)) {
    return { runtimes: ['java'], contentRequired: false };
  }
  if (name === 'global.json' || /\.(?:csproj|fsproj|vbproj)$/.test(name)) {
    return { runtimes: ['dotnet'], contentRequired: true };
  }
  if (/\.sln$/.test(name)) return { runtimes: ['dotnet'], contentRequired: false };
  return null;
}

function parseTreeMarkers(stdout: Buffer, limits: RepositoryInspectionLimits): Marker[] {
  const entries = stdout.toString('utf8').split('\0');
  if (entries[entries.length - 1] === '') entries.pop();
  if (entries.length > limits.maxTreeEntries) {
    throw new RepositoryInspectionError('limit_exceeded', 'Repository tree exceeds the inspection entry limit');
  }
  const markers: Marker[] = [];
  for (const entry of entries) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(entry);
    if (!match || match[2] !== 'blob') continue;
    const path = match[4];
    if (path.includes('\uFFFD') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) continue;
    if (path.split('/').length > limits.maxPathDepth) continue;
    const descriptor = markerForPath(path);
    if (!descriptor) continue;
    markers.push({ path, oid: match[3], ...descriptor });
    if (markers.length > limits.maxMarkers) {
      throw new RepositoryInspectionError('limit_exceeded', 'Repository contains too many runtime markers');
    }
  }
  return markers.sort((a, b) => a.path.localeCompare(b.path) || a.oid.localeCompare(b.oid));
}

function forgeHint(url: URL): RepositoryInspectionResult['forgeHint'] {
  const host = url.host.toLowerCase();
  if (url.hostname.toLowerCase() === 'github.com') return Object.freeze({ kind: 'github', host });
  if (url.hostname.toLowerCase() === 'gitlab.com') return Object.freeze({ kind: 'gitlab', host });
  return null;
}

function literal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = VERSION_LITERAL.exec(value.trim());
  const version = match?.[1] || '';
  return isConservativeRuntimeVersion(version) ? version : null;
}

function jsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function versionsFor(marker: Marker, content: string): Array<{ runtimeId: RuntimeId; version: string }> {
  const name = basename(marker.path).toLowerCase();
  const found: Array<{ runtimeId: RuntimeId; version: string | null }> = [];
  if (name === '.nvmrc' || name === '.node-version') found.push({ runtimeId: 'node', version: literal(content) });
  if (name === 'package.json') {
    const json = jsonObject(content);
    const engines = json?.engines;
    found.push({
      runtimeId: 'node',
      version: literal(engines && typeof engines === 'object' && !Array.isArray(engines)
        ? (engines as Record<string, unknown>).node
        : null),
    });
  }
  if (name === '.python-version') found.push({ runtimeId: 'python', version: literal(content) });
  if (name === 'runtime.txt') found.push({ runtimeId: 'python', version: literal(content) });
  if (name === 'pyproject.toml') {
    found.push({ runtimeId: 'python', version: literal(/(?:^|\n)\s*requires-python\s*=\s*["']([^"']+)["']/.exec(content)?.[1]) });
  }
  if (name === '.php-version') found.push({ runtimeId: 'php', version: literal(content) });
  if (name === 'composer.json') {
    const json = jsonObject(content);
    const require = json?.require;
    found.push({
      runtimeId: 'php',
      version: literal(require && typeof require === 'object' && !Array.isArray(require)
        ? (require as Record<string, unknown>).php
        : null),
    });
  }
  if (name === 'go.mod') {
    found.push({ runtimeId: 'go', version: literal(/(?:^|\n)\s*(?:toolchain\s+go|go\s+)([^\s#]+)/.exec(content)?.[1]) });
  }
  if (name === 'rust-toolchain') found.push({ runtimeId: 'rust', version: literal(content) });
  if (name === 'rust-toolchain.toml') {
    found.push({ runtimeId: 'rust', version: literal(/(?:^|\n)\s*channel\s*=\s*["']([^"']+)["']/.exec(content)?.[1]) });
  }
  if (name === '.java-version') found.push({ runtimeId: 'java', version: literal(content) });
  if (name === 'pom.xml') {
    found.push({ runtimeId: 'java', version: literal(/<maven\.compiler\.(?:release|source)>\s*([^<\s]+)\s*</.exec(content)?.[1]) });
  }
  if (name === 'global.json') {
    const json = jsonObject(content);
    const sdk = json?.sdk;
    found.push({
      runtimeId: 'dotnet',
      version: literal(sdk && typeof sdk === 'object' && !Array.isArray(sdk)
        ? (sdk as Record<string, unknown>).version
        : null),
    });
  }
  if (/\.(?:csproj|fsproj|vbproj)$/.test(name)) {
    const framework = /<TargetFramework>\s*net([0-9]+(?:\.[0-9]+){0,3})\s*</.exec(content)?.[1];
    found.push({ runtimeId: 'dotnet', version: literal(framework) });
  }
  return found
    .filter((item): item is { runtimeId: RuntimeId; version: string } => item.version !== null)
    .map((item) => ({ runtimeId: item.runtimeId, version: item.version }));
}

function addHints(detections: Map<RuntimeId, MutableDetection>, marker: Marker, content: string): void {
  for (const hint of versionsFor(marker, content)) {
    const detection = detections.get(hint.runtimeId);
    if (!detection || detection.hints.some((item) => item.path === marker.path && item.version === hint.version)) continue;
    detection.hints.push(Object.freeze({ path: marker.path, version: hint.version }));
  }
}
