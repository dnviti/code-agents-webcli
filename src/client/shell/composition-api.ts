/**
 * Browser-only contracts for project composition and durable storage.
 *
 * Keeping these beside the UI (rather than importing server services) makes a
 * small response-envelope adjustment local and keeps server code out of the
 * browser bundle.
 */

import type { ProjectSummary } from './projects-types.js';

export interface RuntimeCatalogItem {
  id: string;
  label: string;
  tool: string;
  defaultVersion: string;
  executable: string;
}

export interface AgentRuntimeCatalogItem extends RuntimeCatalogItem {
  requires: 'node' | 'python';
}

export interface RuntimeDetection {
  runtimeId: string;
  sources: string[];
  versionHints: RuntimeVersionHint[];
  selectedVersion: string;
  versionSource: 'marker' | 'catalog_default';
}

export interface RuntimeVersionHint {
  path: string;
  version: string;
}

export interface RuntimeChoice { runtimeId: string; version: string; }
export type AgentRuntimeChoice = RuntimeChoice;

export interface CompositionInstallation {
  itemId: string;
  status: 'pending' | 'installing' | 'installed' | 'failed';
  attempts: number;
  installedVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface GitIdentity {
  name: string;
  email: string;
  source?: string;
}

export interface ProjectComposition {
  revision: string | null;
  activeRevision: string | null;
  appliedRevision: string | null;
  detected: {
    catalogVersion: string;
    sourceOid: string | null;
    sourceRef: string | null;
    forgeHint: { kind: 'github' | 'gitlab'; host: string } | null;
    detectedRuntimes: RuntimeDetection[];
  } | null;
  chosen: { runtimes: RuntimeChoice[]; agents?: AgentRuntimeChoice[]; forgeKind?: string | null } | null;
  installations: CompositionInstallation[];
  identity: GitIdentity | null;
  identitySource: 'project' | 'global' | 'provider' | 'incomplete';
  forge: { kind: string; host: string; connected: boolean; validationStatus: string | null } | null;
}

export interface ProjectCompositionResponse {
  catalog: { version: string; runtimes: RuntimeCatalogItem[]; agents: AgentRuntimeCatalogItem[] };
  composition: ProjectComposition;
  project: ProjectSummary;
}

export interface StorageProjectUsage {
  projectId: string;
  name: string;
  workspaceBytes: number;
  overlayBytes: number;
  totalBytes: number;
}

export interface StorageUsageReport {
  userId?: number;
  login?: string;
  totalBytes: number;
  home: { totalBytes: number; categories: Record<string, number> };
  projects: StorageProjectUsage[];
  filesystem: unknown;
  warnings: unknown;
  errors: string[];
  complete: boolean;
  measuredAt: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly data: unknown, fallback: string) {
    const body = data as { message?: unknown; detail?: unknown; error?: unknown };
    super(typeof body?.message === 'string' ? body.message
      : typeof body?.detail === 'string' ? body.detail
        : typeof body?.error === 'string' ? body.error : fallback);
  }
}

async function jsonRequest<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data, `HTTP ${response.status}`);
  return data as T;
}

export function getProjectComposition(projectId: string): Promise<ProjectCompositionResponse> {
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/composition`);
}

export function saveProjectComposition(
  projectId: string,
  expectedCurrentRevision: string | null,
  runtimes: RuntimeChoice[],
  agents: AgentRuntimeChoice[],
  forgeKind: string | null,
): Promise<{ composition: ProjectComposition }> {
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/composition`, 'PUT', {
    expectedCurrentRevision, runtimes, agents, forgeKind,
  });
}

export function confirmProjectComposition(
  projectId: string,
  revision: string,
  expectedRevision: string | null,
  acknowledgeRebuild: boolean,
  stopProjectId?: string,
): Promise<{ state: string }> {
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/composition/confirm`, 'POST', {
    revision, expectedRevision, acknowledgeRebuild, ...(stopProjectId ? { stopProjectId } : {}),
  });
}

export function retryProjectComposition(projectId: string): Promise<{ installations: CompositionInstallation[] }> {
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/composition/retry`, 'POST', {});
}

export function reinspectProjectComposition(projectId: string): Promise<{ composition: ProjectComposition; project: ProjectSummary }> {
  return jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/composition/inspect`, 'POST', {});
}

function identityFrom(value: unknown): GitIdentity | null {
  const body = value as { identity?: unknown; name?: unknown; email?: unknown; source?: unknown };
  const candidate = (body?.identity && typeof body.identity === 'object' ? body.identity : body) as {
    name?: unknown; email?: unknown; source?: unknown;
  };
  return typeof candidate?.name === 'string' && typeof candidate?.email === 'string'
    ? {
        name: candidate.name,
        email: candidate.email,
        source: typeof candidate.source === 'string' ? candidate.source : typeof body.source === 'string' ? body.source : undefined,
      }
    : null;
}

export async function getGitIdentity(projectId?: string): Promise<GitIdentity | null> {
  const data = await jsonRequest<unknown>(projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/git-identity`
    : '/api/git-identity');
  return identityFrom(data);
}

export async function putGitIdentity(identity: GitIdentity, projectId?: string): Promise<GitIdentity> {
  const data = await jsonRequest<unknown>(projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/git-identity`
    : '/api/git-identity', 'PUT', { name: identity.name, email: identity.email });
  return identityFrom(data) || identity;
}

/** Accept the fixed #169 report and the early server envelope used during integration. */
export function normalizeStorageReport(value: unknown): StorageUsageReport {
  const outer = value as { report?: unknown };
  const raw = (outer?.report && typeof outer.report === 'object' ? outer.report : value) as Record<string, unknown>;
  const home = raw.home as { totalBytes?: unknown; categories?: unknown } | undefined;
  const legacyProjects = Array.isArray(raw.projects) ? raw.projects as Array<Record<string, unknown>> : [];
  const categories = home?.categories && typeof home.categories === 'object'
    ? home.categories as Record<string, number>
    : {
        agents: Number(raw.agentsBytes || 0),
        tooling: Number(raw.toolingBytes || 0),
        other: Number(raw.otherHomeBytes || 0),
      };
  return {
    userId: typeof raw.userId === 'number' ? raw.userId : undefined,
    login: typeof raw.login === 'string' ? raw.login : undefined,
    totalBytes: Number(raw.totalBytes || 0),
    home: { totalBytes: Number(home?.totalBytes ?? raw.homeBytes ?? 0), categories },
    projects: legacyProjects.map((project) => ({
      projectId: String(project.projectId ?? project.id ?? ''),
      name: String(project.name ?? project.projectId ?? 'Project'),
      workspaceBytes: Number(project.workspaceBytes || 0),
      overlayBytes: Number(project.overlayBytes || 0),
      totalBytes: Number(project.totalBytes ?? (Number(project.workspaceBytes || 0) + Number(project.overlayBytes || 0))),
    })),
    filesystem: raw.filesystem ?? raw.filesystems ?? null,
    warnings: raw.warnings ?? [],
    errors: Array.isArray(raw.errors) ? raw.errors.map((item) => {
      if (typeof item === 'string') return item;
      const error = item as { code?: unknown; message?: unknown };
      return [error.code, error.message].filter((part) => typeof part === 'string').join(': ') || 'Storage measurement error';
    }) : [],
    complete: raw.complete !== false,
    measuredAt: String(raw.measuredAt ?? raw.recordedAt ?? ''),
  };
}

export async function getStorageUsage(refresh = false): Promise<StorageUsageReport> {
  return normalizeStorageReport(await jsonRequest(`/api/usage/storage${refresh ? '?refresh=1' : ''}`));
}

export async function clearStorageCache(action: 'miseDownloads' | 'unusedToolVersions'): Promise<StorageUsageReport> {
  return normalizeStorageReport(await jsonRequest(`/api/usage/storage/cache/${action}`, 'DELETE'));
}

export async function getAdminStorageUsage(): Promise<StorageUsageReport[] | null> {
  try {
    const data = await jsonRequest<unknown>('/api/admin/usage/storage');
    const body = data as { users?: unknown; reports?: unknown };
    const rows = Array.isArray(data) ? data : Array.isArray(body?.users) ? body.users : Array.isArray(body?.reports) ? body.reports : [];
    return (rows as unknown[]).map((row) => {
      const normalized = normalizeStorageReport(row);
      const wrapped = row as { userId?: unknown; login?: unknown };
      return {
        ...normalized,
        userId: typeof wrapped.userId === 'number' ? wrapped.userId : normalized.userId,
        login: typeof wrapped.login === 'string' ? wrapped.login : normalized.login,
      };
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return null;
    throw error;
  }
}
