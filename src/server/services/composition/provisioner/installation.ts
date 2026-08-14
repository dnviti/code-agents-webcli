import type {
  ContainerCommandRunner,
  TargetPlatform,
} from './platform.js';
import { PINNED_TEA_VERSION } from './artifacts.js';
import type {
  MiseArtifact,
  MiseArtifactFetcher,
  TeaArtifact,
  TeaArtifactFetcher,
} from './artifacts.js';

export type InstallationStatus = 'pending' | 'installing' | 'installed' | 'failed';

export interface InstallationItem {
  id: string;
  /** Catalog key such as node, python, gh, glab, or tea. */
  tool: string;
  version: string;
}

export interface InstallationRecord extends InstallationItem {
  status: InstallationStatus;
  attempts: number;
  installedVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** SQLite-backed in production; an in-memory fake is sufficient for tests. */
export interface InstallationStateStore {
  ensureItems(compositionId: string, items: readonly InstallationItem[]): void | Promise<void>;
  list(compositionId: string): readonly InstallationRecord[] | Promise<readonly InstallationRecord[]>;
  markInstalling(compositionId: string, itemId: string): void | Promise<void>;
  markInstalled(compositionId: string, itemId: string, version: string): void | Promise<void>;
  markFailed(
    compositionId: string,
    itemId: string,
    errorCode: string,
    safeMessage: string,
  ): void | Promise<void>;
}

export interface ProvisionRequest {
  compositionId: string;
  ownerHomeHost: string;
  ownerHomeContainer: string;
  projectOverlayHost: string;
  items: readonly InstallationItem[];
}

export interface ProvisionResult {
  platform: TargetPlatform | null;
  misePath: string | null;
  activationFile: string | null;
  items: readonly InstallationRecord[];
}

export type ApprovedTool = Readonly<
  | { installer: 'mise'; miseName: string; executable: string }
  | { installer: 'tea-direct'; binaryName: 'tea'; version: typeof PINNED_TEA_VERSION }
>;

/** Catalog v1 language/agent tools plus the three supported forge clients. */
export const APPROVED_TOOL_CATALOG: Readonly<Record<string, ApprovedTool>> = Object.freeze({
  node: { installer: 'mise', miseName: 'node', executable: 'node' },
  python: { installer: 'mise', miseName: 'python', executable: 'python3' },
  php: { installer: 'mise', miseName: 'php', executable: 'php' },
  go: { installer: 'mise', miseName: 'go', executable: 'go' },
  rust: { installer: 'mise', miseName: 'rust', executable: 'rustc' },
  java: { installer: 'mise', miseName: 'java', executable: 'java' },
  dotnet: { installer: 'mise', miseName: 'dotnet', executable: 'dotnet' },
  gh: { installer: 'mise', miseName: 'github-cli', executable: 'gh' },
  glab: { installer: 'mise', miseName: 'glab', executable: 'glab' },
  tea: { installer: 'tea-direct', binaryName: 'tea', version: PINNED_TEA_VERSION },
  'agent-claude': { installer: 'mise', miseName: 'npm:@anthropic-ai/claude-code', executable: 'claude' },
  'agent-codex': { installer: 'mise', miseName: 'npm:@openai/codex', executable: 'codex' },
  'agent-pi': { installer: 'mise', miseName: 'npm:@mariozechner/pi-coding-agent', executable: 'pi' },
  'agent-grok': { installer: 'mise', miseName: 'npm:@xai-official/grok', executable: 'grok' },
  'agent-qwen': { installer: 'mise', miseName: 'npm:@qwen-code/qwen-code', executable: 'qwen' },
  'agent-kimi': { installer: 'mise', miseName: 'pipx:kimi-cli', executable: 'kimi' },
  'agent-omp': { installer: 'mise', miseName: 'npm:@oh-my-pi/pi-coding-agent', executable: 'omp' },
});

export interface ProjectProvisionerOptions {
  runner: ContainerCommandRunner;
  state: InstallationStateStore;
  /** Must contain exactly pinned, checksummed artifacts. */
  artifacts?: readonly MiseArtifact[];
  fetchArtifact?: MiseArtifactFetcher;
  teaArtifacts?: readonly TeaArtifact[];
  fetchTeaArtifact?: TeaArtifactFetcher;
  probe?: (runner: ContainerCommandRunner) => Promise<TargetPlatform>;
  tools?: Readonly<Record<string, ApprovedTool>>;
}
