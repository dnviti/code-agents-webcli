import { ServerOptions, ServerState, Aliases } from './types.js';

export function createConfig(options: ServerOptions): ServerState {
  const sessionDurationHours = parseFloat(
    process.env.CLAUDE_SESSION_HOURS || String(options.sessionHours || 5)
  );

  const aliases: Aliases = {
    claude: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
    codex: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
    agent: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor',
  };

  return {
    port: options.port || 32352,
    dev: options.dev || false,
    useHttps: options.https || false,
    certFile: options.cert,
    keyFile: options.key,
    setup: options.setup || false,
    folderMode: options.folderMode !== false,
    selectedWorkingDir: null,
    baseFolder: process.cwd(),
    publicBaseUrl: options.publicBaseUrl || process.env.PUBLIC_BASE_URL || null,
    githubClientId:
      options.githubClientId || process.env.GITHUB_OAUTH_CLIENT_ID || null,
    githubClientSecret:
      options.githubClientSecret || process.env.GITHUB_OAUTH_CLIENT_SECRET || null,
    githubAppToken:
      options.githubAppToken || process.env.GITHUB_APP_TOKEN || null,
    allowedGitHubIds: (options.allowedGitHubIds || process.env.GITHUB_ALLOWED_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    dataDir: options.dataDir || process.env.CODE_AGENTS_WEBCLI_DATA_DIR || null,
    sessionDurationHours,
    aliases,
    startTime: Date.now(),
    isShuttingDown: false,
  };
}

export function createUsageAnalyticsOptions(options: ServerOptions, sessionDurationHours: number): {
  sessionDurationHours: number;
  plan: string;
  customCostLimit: number;
} {
  return {
    sessionDurationHours,
    plan: options.plan || process.env.CLAUDE_PLAN || 'max20',
    customCostLimit: parseFloat(
      process.env.CLAUDE_COST_LIMIT || String(options.customCostLimit || 50.00)
    ),
  };
}
