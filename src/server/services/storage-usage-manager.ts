/** Durable, warning-only orchestration around the non-following storage scanner. */

import type { AuthenticatedUser } from '../types.js';
import { getCompositionCatalog, isConservativeRuntimeVersion, type AgentRuntimeId, type RuntimeId } from './composition/catalog.js';
import { FORGE_CATALOG, type ForgeKind } from './composition/forge.js';
import {
  withOwnerMiseMutationLock,
  withOwnerToolVersionLock,
} from './composition/provisioner.js';
import type {
  Project,
  ProjectComposition,
  ProjectStore,
  StorageUsageBreakdown,
  StorageUsageSnapshot,
} from './projects/store.js';
import {
  measureStorageUsage,
  removeUnreferencedToolVersionsSafely,
  removeStorageCacheSafely,
  type InstalledToolKey,
  type StorageCacheAction,
  type StorageProjectPath,
  type StorageUsageReport,
} from './storage-usage.js';

export interface StorageUsagePathResolver {
  ownerHomePath(user: AuthenticatedUser): string;
  /** Multi-target installations can retain one durable home on each target. */
  ownerHomePaths?(user: AuthenticatedUser, projects: Project[]): string[];
  projectPaths(project: Project, user: AuthenticatedUser): Pick<StorageProjectPath, 'workspacePath' | 'overlayPath'>;
}

export interface AdminStorageUsageReport {
  userId: number;
  login: string;
  report: StorageUsageReport;
}

export interface StorageUsageManagerDeps {
  database: {
    getUserById(userId: number): AuthenticatedUser | null;
    listUsers(): AuthenticatedUser[];
    getUserSetting(userId: number, key: string): string | null;
  };
  store: Pick<ProjectStore,
    'listProjectsForUser' | 'recordStorageUsageSnapshot' | 'latestStorageUsageSnapshot'
    | 'usageWarnUserBytes' | 'usageWarnAdminBytes' | 'getProjectComposition'
    | 'listInstallingCompositionsForUser'>;
  paths: StorageUsagePathResolver;
  measure?: typeof measureStorageUsage;
  now?: () => Date;
  snapshotTtlMs?: number;
}

const USER_WARNING_SETTING = 'deploy.usageWarnUserBytes';
const HOUR_MS = 60 * 60 * 1000;
export const ADMIN_STORAGE_SCAN_CONCURRENCY = 4;

/**
 * This manager deliberately has no environment engine dependency. All host
 * paths are server-resolved by `paths`, so reporting works for stopped and
 * missing projects and cannot turn a browser-provided path into a scan.
 */
export class StorageUsageManager {
  private readonly measure: typeof measureStorageUsage;
  private readonly now: () => Date;
  private readonly snapshotTtlMs: number;

  constructor(private readonly deps: StorageUsageManagerDeps) {
    this.measure = deps.measure ?? measureStorageUsage;
    this.now = deps.now ?? (() => new Date());
    this.snapshotTtlMs = Math.max(0, deps.snapshotTtlMs ?? HOUR_MS);
  }

  async reportForUser(userId: number, refresh = false): Promise<StorageUsageReport> {
    const user = this.deps.database.getUserById(userId);
    if (!user) throw new Error('user not found');
    if (!refresh) {
      const cached = this.freshSnapshot(userId);
      if (cached) {
        try {
          return reportFromSnapshot(cached);
        } catch {
          // A snapshot written by an older/corrupt build is only a cache. It
          // must never make current usage unavailable when it can be measured.
        }
      }
    }
    return this.measureAndPersist(user);
  }

  async reportsForAdmin(refresh = false): Promise<AdminStorageUsageReport[]> {
    const users = this.deps.database.listUsers();
    return mapWithConcurrency(users, ADMIN_STORAGE_SCAN_CONCURRENCY, async (user) => ({
      userId: user.id,
      login: user.githubLogin,
      report: await this.reportForUser(user.id, refresh),
    }));
  }

  async reportForAdmin(userId: number, refresh = false): Promise<AdminStorageUsageReport | null> {
    const user = this.deps.database.getUserById(userId);
    if (!user) return null;
    return { userId: user.id, login: user.githubLogin, report: await this.reportForUser(user.id, refresh) };
  }

  /** Runs one opaque, server-owned cleanup policy, then refreshes. */
  async clearCache(userId: number, action: StorageCacheAction): Promise<StorageUsageReport> {
    const user = this.deps.database.getUserById(userId);
    if (!user) throw new Error('user not found');
    const projects = this.deps.store.listProjectsForUser(user.id);
    const homes = this.ownerHomes(user, projects);
    for (const home of homes) {
      if (action === 'miseDownloads') {
        await removeStorageCacheSafely(home, action);
      } else if (action === 'unusedToolVersions') {
        await removeUnreferencedToolVersionsSafely(home, {
          withVersionLock: (candidate, operation) => withOwnerToolVersionLock({
            ownerHomeHost: home,
            tool: candidate.tool,
            version: candidate.version,
          }, () => (
            candidate.tool === 'tea'
              ? operation()
              : withOwnerMiseMutationLock(home, operation)
          )),
          // This executes inside the exact-version lock and, for mise-backed
          // tools, the owner-wide mise mutation lock. Re-read SQLite here; an
          // allowlist computed before waiting would be stale.
          isReferenced: (candidate) => this.referencedToolVersions(user.id)
            .has(toolVersionKey(candidate.tool, candidate.version)),
        });
      }
    }
    return this.reportForUser(userId, true);
  }

  private freshSnapshot(userId: number): StorageUsageSnapshot | null {
    const snapshot = this.deps.store.latestStorageUsageSnapshot(userId);
    if (!snapshot) return null;
    const age = this.now().getTime() - new Date(snapshot.createdAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < this.snapshotTtlMs ? snapshot : null;
  }

  private async measureAndPersist(user: AuthenticatedUser): Promise<StorageUsageReport> {
    const ownedProjects = this.deps.store.listProjectsForUser(user.id);
    const homePaths = this.ownerHomes(user, ownedProjects);
    const projects = ownedProjects.map((project) => ({
      id: project.id,
      name: project.name,
      ...this.deps.paths.projectPaths(project, user),
    }));
    const override = optionalNonNegativeInt(this.deps.database.getUserSetting(user.id, USER_WARNING_SETTING));
    const measured = await this.measure({
      homePaths,
      projects,
      thresholds: {
        // A user-owned setting wins; the deploy setting remains the default.
        userWarningBytes: override ?? this.deps.store.usageWarnUserBytes(),
        adminWarningBytes: this.deps.store.usageWarnAdminBytes(),
      },
    }, { now: this.now });
    // Host/PVC paths and operating-system error text are deployment details,
    // not part of the owner/admin API. Preserve actionable categories and
    // project labels while keeping filesystem topology private.
    const report = publicStorageReport(measured, homePaths, projects);
    const freeBytes = report.filesystems.length ? Math.min(...report.filesystems.map((item) => item.freeBytes)) : null;
    this.deps.store.recordStorageUsageSnapshot({
      userId: user.id,
      totalBytes: report.totalBytes,
      breakdown: report as unknown as StorageUsageBreakdown,
      errors: report.errors.map((error) => `${error.code}: ${error.message}`),
      freeBytes,
    });
    return report;
  }

  private ownerHomes(user: AuthenticatedUser, projects: Project[]): string[] {
    const resolved = this.deps.paths.ownerHomePaths?.(user, projects)
      ?? [this.deps.paths.ownerHomePath(user)];
    return [...new Set(resolved)];
  }

  private referencedToolVersions(userId: number): Set<string> {
    const recipes = new Map<string, ProjectComposition>();
    for (const project of this.deps.store.listProjectsForUser(userId)) {
      const latest = this.deps.store.getProjectComposition(project.id, userId);
      if (latest) recipes.set(latest.id, latest);
      for (const revision of [project.compositionRevision, project.appliedCompositionRevision]) {
        if (!revision || recipes.has(revision)) continue;
        const composition = this.deps.store.getProjectComposition(project.id, userId, revision);
        // A dangling active/applied revision makes a destructive allowlist
        // unknowable. Refuse cleanup rather than guessing it is unreferenced.
        if (!composition) throw new Error('referenced composition recipe is unavailable');
        recipes.set(composition.id, composition);
      }
    }
    for (const composition of this.deps.store.listInstallingCompositionsForUser(userId)) {
      recipes.set(composition.id, composition);
    }

    const referenced = new Set<string>();
    for (const composition of recipes.values()) {
      for (const item of toolVersionsFromComposition(composition)) {
        referenced.add(toolVersionKey(item.tool, item.version));
      }
    }
    return referenced;
  }
}

function toolVersionKey(tool: InstalledToolKey, version: string): string {
  return `${tool}\0${version}`;
}

function toolVersionsFromComposition(
  composition: ProjectComposition,
): Array<{ tool: InstalledToolKey; version: string }> {
  const catalog = getCompositionCatalog();
  if (composition.catalogVersion !== catalog.version || !composition.chosen
    || typeof composition.chosen !== 'object') {
    throw new Error('composition recipe cannot be used for storage cleanup');
  }
  const raw = composition.chosen as { runtimes?: unknown; agents?: unknown; forgeKind?: unknown };
  if (!Array.isArray(raw.runtimes) || raw.runtimes.length > catalog.runtimes.length) {
    throw new Error('composition recipe cannot be used for storage cleanup');
  }
  const supported = new Map(catalog.runtimes.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const result: Array<{ tool: InstalledToolKey; version: string }> = [];
  for (const value of raw.runtimes) {
    if (!value || typeof value !== 'object') throw new Error('composition recipe cannot be used for storage cleanup');
    const runtime = value as { runtimeId?: unknown; version?: unknown };
    const entry = supported.get(runtime.runtimeId as RuntimeId);
    if (!entry || seen.has(entry.id) || typeof runtime.version !== 'string'
      || !isConservativeRuntimeVersion(runtime.version)) {
      throw new Error('composition recipe cannot be used for storage cleanup');
    }
    seen.add(entry.id);
    result.push({ tool: entry.id, version: runtime.version });
  }

  const rawAgents = raw.agents === undefined ? [] : raw.agents;
  if (!Array.isArray(rawAgents) || rawAgents.length > catalog.agents.length) {
    throw new Error('composition recipe cannot be used for storage cleanup');
  }
  const supportedAgents = new Map(catalog.agents.map((entry) => [entry.id, entry]));
  const seenAgents = new Set<string>();
  const requirements = new Set<'node' | 'python'>();
  for (const value of rawAgents) {
    if (!value || typeof value !== 'object') throw new Error('composition recipe cannot be used for storage cleanup');
    const agent = value as { runtimeId?: unknown; version?: unknown };
    const entry = supportedAgents.get(agent.runtimeId as AgentRuntimeId);
    if (!entry || seenAgents.has(entry.id) || agent.version !== entry.defaultVersion) {
      throw new Error('composition recipe cannot be used for storage cleanup');
    }
    seenAgents.add(entry.id);
    requirements.add(entry.requires);
    result.push({ tool: entry.tool as InstalledToolKey, version: entry.defaultVersion });
  }
  for (const requirement of requirements) {
    if (!seen.has(requirement)) {
      const entry = catalog.runtimes.find((runtime) => runtime.id === requirement);
      if (!entry) throw new Error('composition recipe cannot be used for storage cleanup');
      result.push({ tool: requirement, version: entry.defaultVersion });
    }
  }

  if (raw.forgeKind !== undefined && raw.forgeKind !== null) {
    if (typeof raw.forgeKind !== 'string'
      || !Object.prototype.hasOwnProperty.call(FORGE_CATALOG, raw.forgeKind)) {
      throw new Error('composition recipe cannot be used for storage cleanup');
    }
    const forge = FORGE_CATALOG[raw.forgeKind as ForgeKind];
    result.push({ tool: forge.cli, version: forge.version });
  }
  return result;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await map(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function publicStorageReport(
  report: StorageUsageReport,
  homePaths: string[],
  projects: StorageProjectPath[],
): StorageUsageReport {
  const labels = new Map<string, string>();
  homePaths.forEach((root, index) => labels.set(root, homePaths.length === 1 ? 'user home' : `user home ${index + 1}`));
  for (const project of projects) {
    labels.set(project.workspacePath, `${project.name} workspace`);
    labels.set(project.overlayPath, `${project.name} project setup`);
  }
  const safeMessage: Record<StorageUsageReport['errors'][number]['code'], string> = {
    missing: 'A durable storage path is unavailable',
    permission: 'A durable storage path could not be read',
    limit: 'The storage measurement reached its entry limit',
    timeout: 'The storage measurement timed out',
    io: 'Part of durable storage could not be measured',
  };
  return {
    ...report,
    filesystems: report.filesystems.map((filesystem, index) => ({
      ...filesystem,
      root: `durable filesystem ${index + 1}`,
    })),
    errors: report.errors.map((error) => ({
      root: labels.get(error.root) || 'durable storage',
      code: error.code,
      message: safeMessage[error.code],
    })),
  };
}

function optionalNonNegativeInt(raw: string | null): number | null {
  const value = Number(raw);
  return raw !== null && raw.trim() !== '' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reportFromSnapshot(snapshot: StorageUsageSnapshot): StorageUsageReport {
  // Only this manager writes snapshots. A corrupt/old opaque record cannot be
  // trusted as a report; callers receive a fresh measurement instead of a
  // partially invented one.
  const value = snapshot.breakdown as unknown;
  if (!isStorageUsageReport(value)) throw new Error('storage snapshot is not a report');
  return value;
}

function isStorageUsageReport(value: unknown): value is StorageUsageReport {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as { totalBytes?: unknown }).totalBytes === 'number'
    && Array.isArray((value as { projects?: unknown }).projects)
    && Array.isArray((value as { errors?: unknown }).errors)
    && typeof (value as { warnings?: unknown }).warnings === 'object';
}
