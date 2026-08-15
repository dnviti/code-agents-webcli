/** Warning-only accounting for the paths that survive a project container. */

import { constants, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface StorageProjectPath {
  id: string;
  name: string;
  workspacePath: string;
  overlayPath: string;
}

export interface StorageThresholds {
  userWarningBytes: number | null;
  adminWarningBytes: number | null;
}

export interface StorageScanError {
  root: string;
  code: 'missing' | 'permission' | 'limit' | 'timeout' | 'io';
  message: string;
}

export interface StorageFilesystemUsage {
  root: string;
  capacityBytes: number;
  freeBytes: number;
}

export interface ProjectStorageUsage {
  id: string;
  name: string;
  workspaceBytes: number;
  overlayBytes: number;
  totalBytes: number;
}

export interface StorageUsageReport {
  recordedAt: string;
  totalBytes: number;
  homeBytes: number;
  agentsBytes: number;
  toolingBytes: number;
  otherHomeBytes: number;
  projects: ProjectStorageUsage[];
  filesystems: StorageFilesystemUsage[];
  warnings: {
    user: boolean;
    admin: boolean;
    userThresholdBytes: number | null;
    adminThresholdBytes: number | null;
  };
  errors: StorageScanError[];
  complete: boolean;
}

export interface StorageUsageInput {
  homePaths: string[];
  projects: StorageProjectPath[];
  thresholds?: Partial<StorageThresholds>;
}

export interface StorageUsageOptions {
  now?: () => Date;
  timeoutMs?: number;
  maxEntries?: number;
  open?: typeof fsp.open;
  lstat?: typeof fsp.lstat;
  opendir?: typeof fsp.opendir;
  stat?: typeof fsp.stat;
  statfs?: typeof fsp.statfs;
  platform?: NodeJS.Platform;
}

type HomeCategory = 'agents' | 'tooling' | 'other';

interface ScanBudget {
  readonly deadline: number;
  readonly maxEntries: number;
  entries: number;
  readonly seenInodes: Set<string>;
}

interface TreeUsage {
  bytes: number;
  categories: Record<HomeCategory, number>;
}

interface TreeScanResult {
  usage: TreeUsage;
  error?: unknown;
}

interface ScanFilesystemOptions {
  open: typeof fsp.open;
  lstat: typeof fsp.lstat;
  opendir: typeof fsp.opendir;
  stat: typeof fsp.stat;
  statfs: typeof fsp.statfs;
  platform: NodeJS.Platform;
}

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** Root plus this many descendants keeps each scan below 34 live descriptors. */
export const STORAGE_SCAN_MAX_DIRECTORY_DEPTH = 32;

const EMPTY_CATEGORIES = (): Record<HomeCategory, number> => ({
  agents: 0,
  tooling: 0,
  other: 0,
});

/**
 * Known durable agent roots. Matching happens by path segment, never substring,
 * so a repository directory called `.codex-backup` is ordinary user data.
 */
const AGENT_PREFIXES = [
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.pi',
  '.config/claude',
  '.config/codex',
  '.config/opencode',
  '.config/omp',
  '.config/github-copilot',
  '.local/share/claude',
  '.local/share/codex',
] as const;

/** User-space runtimes, executable installs and their disposable caches. */
const TOOLING_PREFIXES = [
  '.local/bin',
  '.local/share/code-agents',
  '.local/share/mise',
  '.cache/code-agents/mise',
  '.cache/mise',
  '.config/mise',
  '.cargo',
  '.rustup',
  '.bun',
  '.deno',
  '.npm',
  '.cache/uv',
  '.local/share/uv',
] as const;

function cleanThreshold(value: number | null | undefined): number | null {
  // Zero is a useful explicit setting for smoke-testing the warning path and
  // means "warn for any measured usage". Null, not zero, disables a warning.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function withinPrefix(relative: string, prefix: string): boolean {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

export function storageHomeCategory(relativePath: string): HomeCategory {
  const relative = relativePath.split(path.sep).join('/').replace(/^\.\//u, '');
  if (AGENT_PREFIXES.some((prefix) => withinPrefix(relative, prefix))) return 'agents';
  if (TOOLING_PREFIXES.some((prefix) => withinPrefix(relative, prefix))) return 'tooling';
  return 'other';
}

function allocatedBytes(stat: Pick<Stats, 'blocks' | 'size'>): number {
  // `blocks` is the closest answer to space consumed. Some virtual/test
  // filesystems report zero, so retain logical size as a truthful fallback.
  const blocks = Number(stat.blocks);
  const allocated = Number.isFinite(blocks) && blocks > 0 ? blocks * 512 : Number(stat.size);
  return Number.isSafeInteger(allocated) && allocated > 0 ? allocated : 0;
}

function inodeKey(stat: Pick<Stats, 'dev' | 'ino'>): string | null {
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  return Number.isSafeInteger(dev) && Number.isSafeInteger(ino) && ino > 0
    ? `${dev}:${ino}`
    : null;
}

function scanError(root: string, error: unknown): StorageScanError {
  const detail = error as NodeJS.ErrnoException;
  const code = detail.code === 'ENOENT'
    ? 'missing'
    : detail.code === 'EACCES' || detail.code === 'EPERM'
      ? 'permission'
      : detail.code === 'CAWC_STORAGE_LIMIT'
        ? 'limit'
        : detail.code === 'CAWC_STORAGE_TIMEOUT'
          ? 'timeout'
          : 'io';
  return {
    root,
    code,
    message: detail.message || String(error),
  };
}

function assertBudget(budget: ScanBudget): void {
  if (performance.now() >= budget.deadline) throw storageTimeoutError();
  budget.entries += 1;
  if (budget.entries > budget.maxEntries) {
    throw Object.assign(new Error('storage scan entry limit exceeded'), { code: 'CAWC_STORAGE_LIMIT' });
  }
}

function storageTimeoutError(): NodeJS.ErrnoException {
  return Object.assign(new Error('storage scan timed out'), { code: 'CAWC_STORAGE_TIMEOUT' });
}

function unsupportedProcFdError(): NodeJS.ErrnoException {
  return Object.assign(new Error('secure storage traversal requires Linux /proc/self/fd'), {
    code: 'CAWC_STORAGE_UNSUPPORTED',
  });
}

function changedDuringTraversalError(): NodeJS.ErrnoException {
  return Object.assign(new Error('storage path changed during secure traversal'), {
    code: 'CAWC_STORAGE_RACE',
  });
}

function storageDepthError(): NodeJS.ErrnoException {
  return Object.assign(new Error('storage scan directory depth limit exceeded'), {
    code: 'CAWC_STORAGE_LIMIT',
  });
}

function sameInode(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

function procFdPath(handle: FileHandle): string {
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) throw unsupportedProcFdError();
  return `/proc/self/fd/${handle.fd}`;
}

function anchoredChild(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw changedDuringTraversalError();
  }
  return `${parent}/${name}`;
}

function closeEventually(resource: { close(): Promise<void> }): void {
  void resource.close().catch(() => undefined);
}

async function closeCleanupResource(resource: { close(): Promise<void> }): Promise<void> {
  try {
    await resource.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
  }
}

async function closeWithinDeadline(
  resource: { close(): Promise<void> },
  budget: ScanBudget,
): Promise<void> {
  try {
    await awaitWithinDeadline(budget, () => resource.close());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_DIR_CLOSED') return;
    closeEventually(resource);
    throw error;
  }
}

/**
 * Race a single filesystem await against the report deadline. Opened resources
 * that arrive after the timeout are closed rather than leaked.
 */
function awaitWithinDeadline<T>(
  budget: ScanBudget,
  operation: () => Promise<T>,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  const remaining = budget.deadline - performance.now();
  if (remaining <= 0) return Promise.reject(storageTimeoutError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(storageTimeoutError());
    }, remaining);

    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }

    pending.then((value) => {
      if (settled) {
        if (onLateValue) void Promise.resolve(onLateValue(value)).catch(() => undefined);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function chargeStat(
  stat: Stats,
  relative: string,
  categoryFor: (relative: string) => HomeCategory,
  budget: ScanBudget,
  result: TreeUsage,
): boolean {
  const key = inodeKey(stat);
  if (key && budget.seenInodes.has(key)) return false;
  if (key) budget.seenInodes.add(key);

  const bytes = allocatedBytes(stat);
  const category = categoryFor(relative);
  result.bytes += bytes;
  result.categories[category] += bytes;
  return true;
}

async function verifiedScanAnchor(
  handle: FileHandle,
  expected: Stats,
  budget: ScanBudget,
  stat: typeof fsp.stat,
): Promise<string> {
  const anchor = procFdPath(handle);
  let anchored: Stats;
  try {
    anchored = await awaitWithinDeadline(budget, () => stat(anchor));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw unsupportedProcFdError();
    throw error;
  }
  if (!sameInode(expected, anchored) || !anchored.isDirectory()) throw unsupportedProcFdError();
  return anchor;
}

async function scanOpenedDirectory(
  handle: FileHandle,
  expected: Stats,
  relative: string,
  categoryFor: (relative: string) => HomeCategory,
  budget: ScanBudget,
  options: ScanFilesystemOptions,
  result: TreeUsage,
  depth: number,
): Promise<void> {
  const anchor = await verifiedScanAnchor(handle, expected, budget, options.stat);
  const dir = await awaitWithinDeadline(
    budget,
    () => options.opendir(anchor),
    (late) => late.close(),
  );
  const childDirectories: Array<{ path: string; relative: string; stat: Stats }> = [];
  try {
    while (true) {
      const entry = await awaitWithinDeadline(budget, () => dir.read());
      if (!entry) break;
      if (typeof entry.name !== 'string') throw changedDuringTraversalError();

      assertBudget(budget);
      const childPath = anchoredChild(anchor, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childStat = await awaitWithinDeadline(budget, () => options.lstat(childPath));
      if (!chargeStat(childStat, childRelative, categoryFor, budget, result)) continue;

      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        childDirectories.push({ path: childPath, relative: childRelative, stat: childStat });
      }
    }
    await closeWithinDeadline(dir, budget);
  } catch (error) {
    closeEventually(dir);
    throw error;
  }

  // The enumeration descriptor is closed before descent. Only one directory
  // FileHandle per ancestor remains live, and depth is explicitly capped.
  for (const child of childDirectories) {
    if (depth >= STORAGE_SCAN_MAX_DIRECTORY_DEPTH) throw storageDepthError();
    // lstat charges symlinks for their own inode. Directories are opened with
    // O_NOFOLLOW and identity-checked before their fd is ever traversed.
    let childHandle: FileHandle | undefined;
    try {
      const openedHandle = await awaitWithinDeadline(
        budget,
        () => options.open(child.path, DIRECTORY_OPEN_FLAGS),
        (late) => late.close(),
      );
      childHandle = openedHandle;
      const openedStat = await awaitWithinDeadline(budget, () => openedHandle.stat());
      if (!openedStat.isDirectory() || !sameInode(child.stat, openedStat)) {
        throw changedDuringTraversalError();
      }
      await scanOpenedDirectory(
        openedHandle,
        openedStat,
        child.relative,
        categoryFor,
        budget,
        options,
        result,
        depth + 1,
      );
      await closeWithinDeadline(openedHandle, budget);
      childHandle = undefined;
    } catch (error) {
      if (childHandle) closeEventually(childHandle);
      throw error;
    }
  }
}

async function scanTree(
  root: string,
  categoryFor: (relative: string) => HomeCategory,
  budget: ScanBudget,
  options: ScanFilesystemOptions,
): Promise<TreeScanResult> {
  const result: TreeUsage = { bytes: 0, categories: EMPTY_CATEGORIES() };
  let rootHandle: FileHandle | undefined;
  try {
    if (options.platform !== 'linux') throw unsupportedProcFdError();
    assertBudget(budget);
    rootHandle = await awaitWithinDeadline(
      budget,
      () => options.open(root, DIRECTORY_OPEN_FLAGS),
      (late) => late.close(),
    );
    const rootStat = await awaitWithinDeadline(budget, () => rootHandle!.stat());
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changedDuringTraversalError();
    if (chargeStat(rootStat, '', categoryFor, budget, result)) {
      await scanOpenedDirectory(rootHandle, rootStat, '', categoryFor, budget, options, result, 0);
    }
    await closeWithinDeadline(rootHandle, budget);
    rootHandle = undefined;
    return { usage: result };
  } catch (error) {
    return { usage: result, error };
  } finally {
    if (rootHandle) closeEventually(rootHandle);
  }
}

function uniqueResolved(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

async function filesystemUsage(
  roots: string[],
  budget: ScanBudget,
  options: ScanFilesystemOptions,
  errors: StorageScanError[],
): Promise<StorageFilesystemUsage[]> {
  const reports: StorageFilesystemUsage[] = [];
  // `statfs` exposes no portable filesystem id. Deduplicate exact roots and
  // leave separate mounted roots visible rather than guessing they are one.
  for (const root of uniqueResolved(roots)) {
    let handle: FileHandle | undefined;
    try {
      if (options.platform !== 'linux') throw unsupportedProcFdError();
      handle = await awaitWithinDeadline(
        budget,
        () => options.open(root, DIRECTORY_OPEN_FLAGS),
        (late) => late.close(),
      );
      const openedStat = await awaitWithinDeadline(budget, () => handle!.stat());
      if (!openedStat.isDirectory()) throw changedDuringTraversalError();
      const anchor = await verifiedScanAnchor(handle, openedStat, budget, options.stat);
      const stat = await awaitWithinDeadline(budget, () => options.statfs(anchor));
      const blockSize = Number(stat.bsize);
      const capacityBytes = Number(stat.blocks) * blockSize;
      const freeBytes = Number(stat.bavail) * blockSize;
      reports.push({
        root,
        capacityBytes: Number.isSafeInteger(capacityBytes) && capacityBytes >= 0 ? capacityBytes : 0,
        freeBytes: Number.isSafeInteger(freeBytes) && freeBytes >= 0 ? freeBytes : 0,
      });
      await closeWithinDeadline(handle, budget);
      handle = undefined;
    } catch (error) {
      // Missing project roots are a normal never-built/reclaimed state and do
      // not degrade an otherwise complete report.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(scanError(root, error));
    } finally {
      if (handle) closeEventually(handle);
    }
  }
  return reports;
}

/**
 * Measure one user's server-resolved roots. No client path reaches this API;
 * callers derive every root from owner/project placement first.
 */
export async function measureStorageUsage(
  input: StorageUsageInput,
  options: StorageUsageOptions = {},
): Promise<StorageUsageReport> {
  const now = options.now || (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 250_000;
  const filesystem: ScanFilesystemOptions = {
    open: options.open || fsp.open,
    lstat: options.lstat || fsp.lstat,
    opendir: options.opendir || fsp.opendir,
    stat: options.stat || fsp.stat,
    statfs: options.statfs || fsp.statfs,
    platform: options.platform || process.platform,
  };
  const errors: StorageScanError[] = [];
  const budget: ScanBudget = {
    deadline: performance.now() + Math.max(1, timeoutMs),
    maxEntries: Math.max(1, maxEntries),
    entries: 0,
    seenInodes: new Set(),
  };

  let homeBytes = 0;
  let agentsBytes = 0;
  let toolingBytes = 0;
  let otherHomeBytes = 0;

  const homePaths = uniqueResolved(input.homePaths);
  for (const root of homePaths) {
    const scan = await scanTree(root, storageHomeCategory, budget, filesystem);
    homeBytes += scan.usage.bytes;
    agentsBytes += scan.usage.categories.agents;
    toolingBytes += scan.usage.categories.tooling;
    otherHomeBytes += scan.usage.categories.other;
    if (scan.error) errors.push(scanError(root, scan.error));
  }

  const projects: ProjectStorageUsage[] = [];
  for (const project of input.projects) {
    let workspaceBytes = 0;
    let overlayBytes = 0;
    for (const [kind, root] of [
      ['workspace', project.workspacePath],
      ['overlay', project.overlayPath],
    ] as const) {
      const resolvedRoot = path.resolve(root);
      const scan = await scanTree(resolvedRoot, () => 'other', budget, filesystem);
      if (kind === 'workspace') workspaceBytes = scan.usage.bytes;
      else overlayBytes = scan.usage.bytes;
      if (scan.error) {
        const detail = scan.error as NodeJS.ErrnoException;
        // A never-built/reclaimed project legitimately has no workspace. It is
        // zero usage, not a degraded measurement.
        if (detail.code !== 'ENOENT') errors.push(scanError(resolvedRoot, scan.error));
      }
    }
    projects.push({
      id: project.id,
      name: project.name,
      workspaceBytes,
      overlayBytes,
      totalBytes: workspaceBytes + overlayBytes,
    });
  }

  const totalBytes = homeBytes + projects.reduce((sum, project) => sum + project.totalBytes, 0);
  const userThresholdBytes = cleanThreshold(input.thresholds?.userWarningBytes);
  const adminThresholdBytes = cleanThreshold(input.thresholds?.adminWarningBytes);
  const filesystemRoots = [
    ...homePaths,
    ...input.projects.flatMap((project) => [project.workspacePath, project.overlayPath]),
  ];

  return {
    recordedAt: now().toISOString(),
    totalBytes,
    homeBytes,
    agentsBytes,
    toolingBytes,
    otherHomeBytes,
    projects,
    filesystems: await filesystemUsage(filesystemRoots, budget, filesystem, errors),
    warnings: {
      user: userThresholdBytes !== null && totalBytes >= userThresholdBytes,
      admin: adminThresholdBytes !== null && totalBytes >= adminThresholdBytes,
      userThresholdBytes,
      adminThresholdBytes,
    },
    errors,
    complete: errors.length === 0,
  };
}

/** Public API allowlist. Values are metadata only; no request supplies a path. */
export const STORAGE_CACHE_ACTIONS = {
  miseDownloads: { kind: 'fixed-tree' },
  unusedToolVersions: { kind: 'unreferenced-versions' },
} as const;

export type StorageCacheAction = keyof typeof STORAGE_CACHE_ACTIONS;
export type StorageTreeCacheAction = 'miseDownloads';

const STORAGE_TREE_CACHE_PATHS: Readonly<Record<StorageTreeCacheAction, string>> = {
  miseDownloads: '.cache/code-agents/mise',
};

export interface StorageCacheCleanupOptions {
  platform?: NodeJS.Platform;
  open?: typeof fsp.open;
  lstat?: typeof fsp.lstat;
  opendir?: typeof fsp.opendir;
  stat?: typeof fsp.stat;
  unlink?: typeof fsp.unlink;
  rmdir?: typeof fsp.rmdir;
}

/**
 * Resolve a fixed cleanup action beneath a server-owned home. The browser
 * sends the opaque action id, never a path.
 */
export function storageCachePath(homePath: string, action: StorageCacheAction): string {
  const home = path.resolve(homePath);
  if (action !== 'miseDownloads') {
    throw new Error('storage cleanup action does not resolve to one cache path');
  }
  const target = path.resolve(home, STORAGE_TREE_CACHE_PATHS[action]);
  if (!target.startsWith(`${home}${path.sep}`)) {
    throw new Error('refusing unsafe storage cache path');
  }
  return target;
}

interface CleanupFilesystemOptions {
  open: typeof fsp.open;
  lstat: typeof fsp.lstat;
  opendir: typeof fsp.opendir;
  stat: typeof fsp.stat;
  unlink: typeof fsp.unlink;
  rmdir: typeof fsp.rmdir;
}

interface OpenedCleanupDirectory {
  handle: FileHandle;
  stat: Stats;
  anchor: string;
}

export type InstalledToolKey = 'node' | 'python' | 'php' | 'go' | 'rust' | 'java' | 'dotnet'
  | 'gh' | 'glab' | 'tea'
  | 'agent-claude' | 'agent-codex' | 'agent-pi' | 'agent-grok'
  | 'agent-qwen' | 'agent-kimi' | 'agent-omp';

export interface InstalledToolVersion {
  tool: InstalledToolKey;
  version: string;
}

export interface UnusedToolVersionCleanupPolicy {
  /** The implementation must share the provisioner's owner/tool/version lock. */
  withVersionLock<T>(candidate: InstalledToolVersion, operation: () => Promise<T>): Promise<T>;
  /** Called only after the version lock is held; implementations re-read SQLite. */
  isReferenced(candidate: InstalledToolVersion): boolean | Promise<boolean>;
}

const INSTALLED_TOOL_LOCATIONS: ReadonlyArray<{
  tool: InstalledToolKey;
  segments: readonly string[];
}> = [
  { tool: 'node', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'node'] },
  { tool: 'python', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'python'] },
  { tool: 'php', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'php'] },
  { tool: 'go', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'go'] },
  { tool: 'rust', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'rust'] },
  { tool: 'java', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'java'] },
  { tool: 'dotnet', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'dotnet'] },
  { tool: 'gh', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'github-cli'] },
  { tool: 'glab', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'glab'] },
  { tool: 'tea', segments: ['.local', 'share', 'code-agents', 'tools', 'tea'] },
  { tool: 'agent-claude', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-anthropic-ai-claude-code'] },
  { tool: 'agent-codex', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-openai-codex'] },
  { tool: 'agent-pi', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-mariozechner-pi-coding-agent'] },
  { tool: 'agent-grok', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-xai-official-grok'] },
  { tool: 'agent-qwen', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-qwen-code-qwen-code'] },
  { tool: 'agent-kimi', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'pipx-kimi-cli'] },
  { tool: 'agent-omp', segments: ['.local', 'share', 'code-agents', 'mise', 'installs', 'npm-oh-my-pi-pi-coding-agent'] },
] as const;

const INSTALLED_VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const STORAGE_CLEANUP_MAX_DIRECTORY_DEPTH = 32;

function storageCleanupRaceError(): NodeJS.ErrnoException {
  return Object.assign(new Error('storage cache changed during cleanup'), {
    code: 'CAWC_STORAGE_RACE',
  });
}

function storageCleanupDepthError(): NodeJS.ErrnoException {
  return Object.assign(new Error('storage cache directory depth limit exceeded'), {
    code: 'CAWC_STORAGE_LIMIT',
  });
}

async function openCleanupDirectory(
  candidate: string,
  options: CleanupFilesystemOptions,
): Promise<OpenedCleanupDirectory> {
  const handle = await options.open(candidate, DIRECTORY_OPEN_FLAGS);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory() || openedStat.isSymbolicLink()) throw storageCleanupRaceError();
    const anchor = procFdPath(handle);
    let anchoredStat: Stats;
    try {
      anchoredStat = await options.stat(anchor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw unsupportedProcFdError();
      throw error;
    }
    if (!anchoredStat.isDirectory() || !sameInode(openedStat, anchoredStat)) {
      throw unsupportedProcFdError();
    }
    return { handle, stat: openedStat, anchor };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function unlinkAnchored(
  candidate: string,
  options: CleanupFilesystemOptions,
): Promise<void> {
  try {
    await options.unlink(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertCleanupEntryIdentity(
  candidate: string,
  expected: Stats,
  options: CleanupFilesystemOptions,
): Promise<void> {
  let current: Stats;
  try {
    current = await options.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw storageCleanupRaceError();
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(expected, current)) {
    throw storageCleanupRaceError();
  }
}

async function removeCleanupEntry(
  parent: OpenedCleanupDirectory,
  name: string,
  options: CleanupFilesystemOptions,
  depth = 0,
): Promise<void> {
  const candidate = anchoredChild(parent.anchor, name);
  let entryStat: Stats;
  try {
    entryStat = await options.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // unlink(2) removes a file or symlink entry without following its target.
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    await unlinkAnchored(candidate, options);
    return;
  }

  if (depth >= STORAGE_CLEANUP_MAX_DIRECTORY_DEPTH) throw storageCleanupDepthError();
  let child: OpenedCleanupDirectory;
  try {
    child = await openCleanupDirectory(candidate, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      // The directory became a file/symlink. unlink remains anchored and cannot
      // follow it; if it became a directory again, unlink safely fails.
      await unlinkAnchored(candidate, options);
      return;
    }
    throw error;
  }

  try {
    if (!sameInode(entryStat, child.stat)) throw storageCleanupRaceError();
    await emptyCleanupDirectory(child, options, depth + 1);
    await assertCleanupEntryIdentity(candidate, child.stat, options);
    try {
      await options.rmdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } finally {
    await closeCleanupResource(child.handle);
  }
}

async function emptyCleanupDirectory(
  directory: OpenedCleanupDirectory,
  options: CleanupFilesystemOptions,
  depth = 0,
): Promise<void> {
  const dir = await options.opendir(directory.anchor);
  try {
    while (true) {
      const entry = await dir.read();
      if (!entry) break;
      if (typeof entry.name !== 'string') throw storageCleanupRaceError();
      await removeCleanupEntry(directory, entry.name, options, depth);
    }
  } finally {
    await closeCleanupResource(dir);
  }
}

async function openFixedCleanupDirectory(
  homePath: string,
  segments: readonly string[],
  options: CleanupFilesystemOptions,
): Promise<OpenedCleanupDirectory | null> {
  let current: OpenedCleanupDirectory;
  try {
    current = await openCleanupDirectory(path.resolve(homePath), options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('refusing unsafe storage home');
    throw error;
  }

  for (const segment of segments) {
    const candidate = anchoredChild(current.anchor, segment);
    let next: OpenedCleanupDirectory;
    try {
      next = await openCleanupDirectory(candidate, options);
    } catch (error) {
      await current.handle.close().catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new Error('refusing symlinked installed tool path');
      }
      throw error;
    }
    await current.handle.close();
    current = next;
  }
  return current;
}

function cleanupFilesystemOptions(overrides: StorageCacheCleanupOptions): CleanupFilesystemOptions {
  return {
    open: overrides.open || fsp.open,
    lstat: overrides.lstat || fsp.lstat,
    opendir: overrides.opendir || fsp.opendir,
    stat: overrides.stat || fsp.stat,
    unlink: overrides.unlink || fsp.unlink,
    rmdir: overrides.rmdir || fsp.rmdir,
  };
}

/**
 * Enumerate only fixed app-owned install roots. Candidate names come from
 * those roots, are validated as installer version literals, and are removed
 * only after the caller's shared install lock rechecks durable references.
 */
export async function removeUnreferencedToolVersionsSafely(
  homePath: string,
  policy: UnusedToolVersionCleanupPolicy,
  overrides: StorageCacheCleanupOptions = {},
): Promise<number> {
  if ((overrides.platform || process.platform) !== 'linux') throw unsupportedProcFdError();
  const options = cleanupFilesystemOptions(overrides);
  let removed = 0;

  for (const location of INSTALLED_TOOL_LOCATIONS) {
    const root = await openFixedCleanupDirectory(homePath, location.segments, options);
    if (!root) continue;
    try {
      const dir = await options.opendir(root.anchor);
      const versions: string[] = [];
      try {
        while (true) {
          const entry = await dir.read();
          if (!entry) break;
          if (typeof entry.name !== 'string') throw storageCleanupRaceError();
          if (INSTALLED_VERSION_NAME.test(entry.name)) versions.push(entry.name);
        }
      } finally {
        await closeCleanupResource(dir);
      }

      for (const version of versions) {
        const candidate = { tool: location.tool, version };
        await policy.withVersionLock(candidate, async () => {
          if (await policy.isReferenced(candidate)) return;
          await removeCleanupEntry(root, version, options);
          removed += 1;
        });
      }
    } finally {
      await closeCleanupResource(root.handle);
    }
  }
  return removed;
}

/**
 * Remove a fixed cache through Linux directory descriptors. Every lookup and
 * deletion after opening the owner home is anchored below a held fd, so a
 * tenant rename/symlink swap cannot redirect traversal outside that home.
 * Unsupported platforms and unavailable procfs fail closed.
 */
export async function removeStorageCacheSafely(
  homePath: string,
  action: StorageTreeCacheAction,
  overrides: StorageCacheCleanupOptions = {},
): Promise<boolean> {
  if ((overrides.platform || process.platform) !== 'linux') throw unsupportedProcFdError();
  const options = cleanupFilesystemOptions(overrides);
  const home = path.resolve(homePath);
  let current: OpenedCleanupDirectory;
  try {
    current = await openCleanupDirectory(home, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error('refusing unsafe storage home');
    throw error;
  }

  try {
    const segments = STORAGE_TREE_CACHE_PATHS[action].split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const candidate = anchoredChild(current.anchor, segment);
      let next: OpenedCleanupDirectory;
      try {
        next = await openCleanupDirectory(candidate, options);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return false;
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new Error('refusing symlinked storage cache');
        }
        throw error;
      }

      if (index === segments.length - 1) {
        try {
          await emptyCleanupDirectory(next, options);
          await assertCleanupEntryIdentity(candidate, next.stat, options);
          try {
            await options.rmdir(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          return true;
        } finally {
          await closeCleanupResource(next.handle);
        }
      }

      await closeCleanupResource(current.handle);
      current = next;
    }
    return false;
  } finally {
    await closeCleanupResource(current.handle);
  }
}
