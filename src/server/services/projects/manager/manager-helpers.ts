/** Pure composition/model helpers shared by the ProjectManager partial classes. */

import type { CompositionChoice } from './manager-types.js';
import {
  AgentRuntimeId,
  COMPOSITION_CATALOG_VERSION,
  RuntimeId,
  getAgentRuntimeCatalogEntry,
  getCompositionCatalog,
  isConservativeRuntimeVersion,
} from '../../composition/catalog.js';
import {
  RepositoryInspectionError,
  RepositoryInspectionResult,
} from '../../composition/repository-inspector.js';

export type ChoiceValidation =
  | { ok: true; choice: CompositionChoice }
  | { ok: false; reason: 'validation'; detail: string };

export function validateCompositionChoice(input: {
  runtimes: Array<{ runtimeId: string; version: string }>;
  agents?: Array<{ runtimeId: string; version: string }>;
  forgeKind?: string | null;
}): ChoiceValidation {
  if (!Array.isArray(input.runtimes) || input.runtimes.length > getCompositionCatalog().runtimes.length) {
    return { ok: false, reason: 'validation', detail: 'Runtime selection is invalid' };
  }
  const supported = new Set<RuntimeId>(getCompositionCatalog().runtimes.map((entry) => entry.id));
  const seen = new Set<RuntimeId>();
  const runtimes: CompositionChoice['runtimes'] = [];
  for (const candidate of input.runtimes) {
    if (!candidate || !supported.has(candidate.runtimeId as RuntimeId)) {
      return { ok: false, reason: 'validation', detail: 'Runtime selection contains an unsupported entry' };
    }
    const runtimeId = candidate.runtimeId as RuntimeId;
    if (seen.has(runtimeId) || typeof candidate.version !== 'string'
      || !isConservativeRuntimeVersion(candidate.version)) {
      return { ok: false, reason: 'validation', detail: 'Runtime versions must be unique conservative numeric literals' };
    }
    seen.add(runtimeId);
    runtimes.push({ runtimeId, version: candidate.version });
  }
  const inputAgents = input.agents || [];
  const agentCatalog = getCompositionCatalog().agents;
  if (!Array.isArray(inputAgents) || inputAgents.length > agentCatalog.length) {
    return { ok: false, reason: 'validation', detail: 'Agent runtime selection is invalid' };
  }
  const supportedAgents = new Set<AgentRuntimeId>(agentCatalog.map((entry) => entry.id));
  const seenAgents = new Set<AgentRuntimeId>();
  const agents: CompositionChoice['agents'] = [];
  for (const candidate of inputAgents) {
    if (!candidate || !supportedAgents.has(candidate.runtimeId as AgentRuntimeId)) {
      return { ok: false, reason: 'validation', detail: 'Agent runtime selection contains an unsupported entry' };
    }
    const runtimeId = candidate.runtimeId as AgentRuntimeId;
    const definition = getAgentRuntimeCatalogEntry(runtimeId);
    if (seenAgents.has(runtimeId) || candidate.version !== definition.defaultVersion) {
      return { ok: false, reason: 'validation', detail: 'Agent runtime versions must match the catalog pin' };
    }
    seenAgents.add(runtimeId);
    agents.push({ runtimeId, version: candidate.version });
  }
  const forgeKind = input.forgeKind ?? null;
  if (forgeKind !== null && !['github', 'gitlab', 'gitea', 'forgejo'].includes(forgeKind)) {
    return { ok: false, reason: 'validation', detail: 'Forge selection is invalid' };
  }
  return {
    ok: true,
    choice: {
      runtimes,
      agents,
      forgeKind: forgeKind as CompositionChoice['forgeKind'],
    },
  };
}

export function compositionChoiceFrom(value: unknown): CompositionChoice | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { runtimes?: unknown; agents?: unknown; forgeKind?: unknown };
  if (!Array.isArray(raw.runtimes)) return null;
  const result = validateCompositionChoice({
    runtimes: raw.runtimes as Array<{ runtimeId: string; version: string }>,
    agents: Array.isArray(raw.agents)
      ? raw.agents as Array<{ runtimeId: string; version: string }>
      : [],
    forgeKind: typeof raw.forgeKind === 'string' || raw.forgeKind === null
      ? raw.forgeKind
      : undefined,
  });
  return result.ok ? result.choice : null;
}

export function inspectionFrom(value: unknown): RepositoryInspectionResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RepositoryInspectionResult>;
  if (raw.catalogVersion !== COMPOSITION_CATALOG_VERSION
    || typeof raw.sourceOid !== 'string'
    || typeof raw.sourceRef !== 'string'
    || !Array.isArray(raw.detectedRuntimes)) return null;
  return raw as RepositoryInspectionResult;
}

export function emptyInspection(): Record<string, unknown> {
  return {
    catalogVersion: COMPOSITION_CATALOG_VERSION,
    sourceOid: null,
    sourceRef: null,
    forgeHint: null,
    detectedRuntimes: [],
  };
}

export function knownPublicForge(host: string | null | undefined): CompositionChoice['forgeKind'] {
  const hostname = (host || '').split(':')[0].toLowerCase();
  if (hostname === 'github.com') return 'github';
  if (hostname === 'gitlab.com') return 'gitlab';
  return null;
}

export function installationIds(
  choice: CompositionChoice,
  forgeKind: CompositionChoice['forgeKind'],
): string[] {
  const ids: string[] = choice.runtimes.map((runtime) => runtime.runtimeId);
  const selectedLanguages = new Set(choice.runtimes.map((runtime) => runtime.runtimeId));
  const requirements = new Set(choice.agents.map((agent) => getAgentRuntimeCatalogEntry(agent.runtimeId).requires));
  for (const requirement of requirements) {
    if (!selectedLanguages.has(requirement)) ids.push(`agent-foundation-${requirement}`);
  }
  ids.push(...choice.agents.map((agent) => `agent-${agent.runtimeId}`));
  if (forgeKind === 'github') ids.push('gh');
  else if (forgeKind === 'gitlab') ids.push('glab');
  else if (forgeKind === 'gitea' || forgeKind === 'forgejo') ids.push('tea');
  return ids;
}

export function safeInspectionMessage(error: unknown): string {
  if (!(error instanceof RepositoryInspectionError)) return 'Repository inspection failed';
  switch (error.code) {
    case 'unsupported_platform': return 'Repository inspection is unavailable on Windows; create a project without a repository or use a Linux server';
    case 'credential_required': return 'Repository credential is missing or invalid';
    case 'invalid_url': return 'Repository URL is not eligible for safe inspection';
    case 'invalid_repository': return 'Repository could not be inspected safely';
    case 'limit_exceeded': return 'Repository inspection exceeded a safety limit';
    case 'timed_out': return 'Repository inspection timed out';
    case 'cancelled': return 'Repository inspection was cancelled';
    default: return 'Repository is currently unavailable for inspection';
  }
}
