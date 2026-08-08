/** Client-safe contract for the managed coding-agent lifecycle. */

export const AGENT_MAINTENANCE_IDS = [
  'claude', 'codex', 'pi', 'grok', 'qwen', 'kimi', 'omp', 'antigravity',
] as const;
export type AgentMaintenanceId = typeof AGENT_MAINTENANCE_IDS[number];
export type AgentPlatform = 'darwin' | 'linux' | 'win32' | 'unsupported';
export type AgentArchitecture = 'x64' | 'arm64' | 'unsupported';
export type AgentInstallState = 'missing' | 'external' | 'managed' | 'project_managed';
export type AgentCheckState = 'checking' | 'current' | 'update_available' | 'unable_to_check';
export type AgentOperationPhase = 'queued' | 'downloading' | 'installing' | 'verifying' | 'activating' | 'complete' | 'failed' | 'cancelled';

export interface AgentPlatformSupport {
  platform: AgentPlatform;
  architectures: readonly AgentArchitecture[];
  guidance?: string;
}

export interface AgentMaintenanceCatalogEntry {
  id: AgentMaintenanceId;
  label: string;
  binary: string;
  versionArgs: readonly string[];
  officialSource: string;
  channel: 'stable' | 'preview';
  channelLabel: string;
  platformSupport: readonly AgentPlatformSupport[];
  manualGuidance: string;
  prerequisiteGuidance?: string;
}

const all = (guidance?: string): readonly AgentPlatformSupport[] => [
  { platform: 'darwin', architectures: ['x64', 'arm64'], guidance },
  { platform: 'linux', architectures: ['x64', 'arm64'], guidance },
  { platform: 'win32', architectures: ['x64', 'arm64'], guidance },
];
const unix = (guidance?: string): readonly AgentPlatformSupport[] => [
  { platform: 'darwin', architectures: ['x64', 'arm64'], guidance },
  { platform: 'linux', architectures: ['x64', 'arm64'], guidance },
];

/** Official-source metadata. Absence from this matrix deliberately fails closed. */
export const AGENT_MAINTENANCE_CATALOG: readonly AgentMaintenanceCatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', binary: 'claude', versionArgs: ['--version'], officialSource: 'https://code.claude.com/docs/en/setup', channel: 'stable', channelLabel: 'Stable', platformSupport: all(), manualGuidance: 'Use the official Claude Code installer. Native Windows is supported; Git Bash is optional and WSL2 is only needed for Linux tooling or sandboxing.' },
  { id: 'codex', label: 'Codex CLI', binary: 'codex', versionArgs: ['--version'], officialSource: 'https://learn.chatgpt.com/docs/codex/cli', channel: 'stable', channelLabel: 'Stable', platformSupport: all(), manualGuidance: 'Use the official Codex installer. Native 64-bit Windows is supported.' },
  { id: 'pi', label: 'pi', binary: 'pi', versionArgs: ['--version'], officialSource: 'https://pi.dev/docs/latest', channel: 'stable', channelLabel: 'Stable', platformSupport: [...unix(), { platform: 'win32', architectures: ['x64', 'arm64'], guidance: 'Managed installation includes Node.js; Git Bash is needed when Pi runs shell tools.' }], manualGuidance: 'Use the official pi installer. On Windows, Git Bash is a runtime requirement for shell tools.', prerequisiteGuidance: 'Git Bash is needed when Pi runs shell tools on Windows.' },
  { id: 'grok', label: 'Grok', binary: 'grok', versionArgs: ['--version'], officialSource: 'https://docs.x.ai/build/overview', channel: 'stable', channelLabel: 'Stable', platformSupport: all(), manualGuidance: 'Use the official stable xAI CLI installer; native Windows supports x64 and ARM64.' },
  { id: 'qwen', label: 'Qwen Code', binary: 'qwen', versionArgs: ['--version'], officialSource: 'https://github.com/QwenLM/qwen-code', channel: 'stable', channelLabel: 'Stable', platformSupport: [{ platform: 'darwin', architectures: ['x64', 'arm64'] }, { platform: 'linux', architectures: ['x64', 'arm64'] }, { platform: 'win32', architectures: ['x64', 'arm64'], guidance: 'Managed installation includes a private Node.js 22 runtime on Windows.' }], manualGuidance: 'Use the official Qwen Code package. Managed Windows installs include Node.js and support x64 and ARM64.' },
  { id: 'kimi', label: 'Kimi', binary: 'kimi', versionArgs: ['--version'], officialSource: 'https://github.com/MoonshotAI/kimi-code', channel: 'stable', channelLabel: 'Stable', platformSupport: [...unix(), { platform: 'win32', architectures: ['x64', 'arm64'], guidance: 'Install Git for Windows or configure KIMI_SHELL_PATH.' }], manualGuidance: 'Use the official Kimi installer. Windows requires Git for Windows or KIMI_SHELL_PATH.', prerequisiteGuidance: 'Install Git for Windows or configure KIMI_SHELL_PATH.' },
  { id: 'omp', label: 'Oh My Pi', binary: 'omp', versionArgs: ['--version'], officialSource: 'https://github.com/can1357/oh-my-pi', channel: 'stable', channelLabel: 'Stable', platformSupport: [{ platform: 'darwin', architectures: ['x64', 'arm64'] }, { platform: 'linux', architectures: ['x64', 'arm64'], guidance: 'Alpine requires libstdc++ and libgcc.' }, { platform: 'win32', architectures: ['x64'] }], manualGuidance: 'Use the official Oh My Pi installer. Windows ARM64 is unsupported; Alpine needs libstdc++ and libgcc.', prerequisiteGuidance: 'Alpine Linux requires libstdc++ and libgcc.' },
  { id: 'antigravity', label: 'Antigravity', binary: 'agy', versionArgs: ['--version'], officialSource: 'https://antigravity.google/docs/cli/install', channel: 'preview', channelLabel: 'Preview', platformSupport: all(), manualGuidance: 'Use Antigravity’s official CLI installer.' },
];

export function agentCatalogEntry(id: string): AgentMaintenanceCatalogEntry | null {
  return AGENT_MAINTENANCE_CATALOG.find((entry) => entry.id === id) ?? null;
}

export function agentSupported(entry: AgentMaintenanceCatalogEntry, platform: string, architecture: string): boolean {
  return entry.platformSupport.some((item) => item.platform === platform && item.architectures.includes(architecture as AgentArchitecture));
}

export interface AgentMaintenanceStatus {
  agentId: AgentMaintenanceId;
  state: AgentInstallState;
  version: string | null;
  managedVersion: string | null;
  check: AgentCheckState;
  latestVersion: string | null;
  checkedAt: number | null;
  canInstall: boolean;
  canManageCopy: boolean;
  /** Shared-host changes need a second, explicit user decision. */
  requiresConfirmation: boolean;
  disabledReason: string | null;
  guidance: string | null;
}

export interface AgentMaintenanceOperation {
  id: string;
  targetKey: string;
  /** Account that started the operation; absent only on legacy persisted rows. */
  ownerUserId?: number;
  agentId: AgentMaintenanceId;
  kind: 'install' | 'update';
  phase: AgentOperationPhase;
  createdAt: number;
  updatedAt: number;
  version: string | null;
  error: string | null;
  retryable: boolean;
  canCancel: boolean;
  cancelReason: string | null;
}
