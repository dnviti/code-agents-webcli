/**
 * The runtime choices understood by composition revision v1.
 *
 * This is deliberately data, not discovery logic.  A stored composition keeps
 * its catalog version, so changing a default or adding a runtime requires a
 * new catalog rather than silently changing an old project's recipe.
 */

export const COMPOSITION_CATALOG_VERSION = 'v1' as const;

export type RuntimeId = 'node' | 'python' | 'php' | 'go' | 'rust' | 'java' | 'dotnet';
export type AgentRuntimeId = 'claude' | 'codex' | 'pi' | 'grok' | 'qwen' | 'kimi' | 'omp';

export interface RuntimeCatalogEntry {
  readonly id: RuntimeId;
  readonly label: string;
  /** Tool name passed to the app-owned runtime installer. */
  readonly tool: string;
  /** Exact, pinned fallback shown when a repository has no safe literal. */
  readonly defaultVersion: string;
  readonly executable: string;
}

export interface AgentRuntimeCatalogEntry {
  readonly id: AgentRuntimeId;
  readonly label: string;
  /** Separate installer key: agent CLIs must never collide with language ids. */
  readonly tool: string;
  /** Immutable catalog pin. Agent versions are not inferred from repositories. */
  readonly defaultVersion: string;
  readonly executable: string;
  readonly requires: 'node' | 'python';
}

export interface CompositionCatalog {
  readonly version: typeof COMPOSITION_CATALOG_VERSION;
  readonly runtimes: readonly RuntimeCatalogEntry[];
  readonly agents: readonly AgentRuntimeCatalogEntry[];
}

const runtimeDefinitions: RuntimeCatalogEntry[] = [
  { id: 'node', label: 'Node.js', tool: 'node', defaultVersion: '22.14.0', executable: 'node' },
  { id: 'python', label: 'Python', tool: 'python', defaultVersion: '3.13.2', executable: 'python3' },
  { id: 'php', label: 'PHP', tool: 'php', defaultVersion: '8.4.22', executable: 'php' },
  { id: 'go', label: 'Go', tool: 'go', defaultVersion: '1.24.1', executable: 'go' },
  { id: 'rust', label: 'Rust', tool: 'rust', defaultVersion: '1.85.1', executable: 'rustc' },
  { id: 'java', label: 'Java', tool: 'java', defaultVersion: '21.0.6', executable: 'java' },
  { id: 'dotnet', label: '.NET', tool: 'dotnet', defaultVersion: '9.0.203', executable: 'dotnet' },
];

const runtimes: readonly RuntimeCatalogEntry[] = runtimeDefinitions.map((entry) => Object.freeze(entry));

const agentDefinitions: AgentRuntimeCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', tool: 'agent-claude', defaultVersion: '2.1.220', executable: 'claude', requires: 'node' },
  { id: 'codex', label: 'Codex', tool: 'agent-codex', defaultVersion: '0.146.0', executable: 'codex', requires: 'node' },
  { id: 'pi', label: 'pi', tool: 'agent-pi', defaultVersion: '0.73.1', executable: 'pi', requires: 'node' },
  { id: 'grok', label: 'Grok Build', tool: 'agent-grok', defaultVersion: '0.2.118', executable: 'grok', requires: 'node' },
  { id: 'qwen', label: 'Qwen Code', tool: 'agent-qwen', defaultVersion: '0.21.4', executable: 'qwen', requires: 'node' },
  { id: 'kimi', label: 'Kimi Code', tool: 'agent-kimi', defaultVersion: '1.49.0', executable: 'kimi', requires: 'python' },
  { id: 'omp', label: 'Oh My Pi', tool: 'agent-omp', defaultVersion: '17.2.6', executable: 'omp', requires: 'node' },
];

const agents: readonly AgentRuntimeCatalogEntry[] = agentDefinitions.map((entry) => Object.freeze(entry));

export const COMPOSITION_CATALOG: CompositionCatalog = Object.freeze({
  version: COMPOSITION_CATALOG_VERSION,
  runtimes: Object.freeze(runtimes),
  agents: Object.freeze(agents),
});

const runtimeById = new Map<RuntimeId, RuntimeCatalogEntry>(
  COMPOSITION_CATALOG.runtimes.map((entry) => [entry.id, entry]),
);
const agentById = new Map<AgentRuntimeId, AgentRuntimeCatalogEntry>(
  COMPOSITION_CATALOG.agents.map((entry) => [entry.id, entry]),
);

/** Return the immutable catalog object suitable for an API response. */
export function getCompositionCatalog(): CompositionCatalog {
  return COMPOSITION_CATALOG;
}

export function getRuntimeCatalogEntry(id: RuntimeId): RuntimeCatalogEntry {
  const entry = runtimeById.get(id);
  if (!entry) throw new Error(`Unknown composition runtime: ${String(id)}`);
  return entry;
}

export function getAgentRuntimeCatalogEntry(id: AgentRuntimeId): AgentRuntimeCatalogEntry {
  const entry = agentById.get(id);
  if (!entry) throw new Error(`Unknown agent runtime: ${String(id)}`);
  return entry;
}

/**
 * Installer-facing validation.  Inspection accepts only literal numeric
 * versions, never tags, ranges, shell fragments, or configuration expressions.
 */
export function isConservativeRuntimeVersion(value: string): boolean {
  return /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,3})){0,3}$/.test(value);
}
