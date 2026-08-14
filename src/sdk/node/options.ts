/** Opaque, high-entropy identity for an embedded desktop host. */
export interface DesktopServerOptions {
  authToken: string;
  username: string;
  name?: string | null;
}

/** Supported configuration accepted by {@link createCodeAgentsServer}. */
export interface ServerOptions {
  port?: number;
  host?: string;
  desktop?: DesktopServerOptions;
  dev?: boolean;
  https?: boolean;
  cert?: string;
  key?: string;
  setup?: boolean;
  folderMode?: boolean;
  sessionHours?: number;
  claudeAlias?: string;
  codexAlias?: string;
  agentAlias?: string;
  piAlias?: string;
  grokAlias?: string;
  qwenAlias?: string;
  kimiAlias?: string;
  ompAlias?: string;
  antigravityAlias?: string;
  publicBaseUrl?: string;
  serverName?: string;
  publicDiscoverableUrl?: string;
  lanDiscoverable?: boolean;
  githubClientId?: string;
  githubClientSecret?: string;
  githubAppToken?: string;
  allowedGitHubIds?: string;
  allowAnyGitHubUser?: boolean;
  dataDir?: string;
  baseFolder?: string;
  containers?: boolean;
  containerEngine?: string;
  containerImage?: string;
  containerCpus?: string;
  containerMemory?: string;
  containerIdleMinutes?: number;
  containerSetupCommand?: string;
  containerTiers?: string;
  containerDefaultTier?: string;
  containerUserTierChoice?: boolean;
  kubeContext?: string;
  kubeNamespace?: string;
  kubeStorageClaim?: string;
  kubeServiceAccount?: string;
  encryptionKey?: string;
}
