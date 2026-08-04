import { ServerOptions, ServerState, Aliases } from './types.js';
import { normalizeDiscoverableAddress, normalizeServerName } from './services/server-identity.js';

export function createConfig(options: ServerOptions): ServerState {
  const requestedDiscoverableUrl = options.publicDiscoverableUrl
    || process.env.CODE_AGENTS_WEBCLI_PUBLIC_DISCOVERABLE_URL
    || null;
  const publicDiscoverableUrl = normalizeDiscoverableAddress(requestedDiscoverableUrl);
  if (requestedDiscoverableUrl && !publicDiscoverableUrl) {
    throw new Error('Public discoverable URL must be an HTTPS origin without a path, query, fragment, or credentials.');
  }
  const lanDiscoverable = options.lanDiscoverable === true
    || process.env.CODE_AGENTS_WEBCLI_LAN_DISCOVERABLE === 'true';
  if (lanDiscoverable && !publicDiscoverableUrl) {
    throw new Error(
      'LAN discovery requires --public-discoverable-url <https-origin> or '
      + 'CODE_AGENTS_WEBCLI_PUBLIC_DISCOVERABLE_URL.',
    );
  }
  const serverName = normalizeServerName(
    options.serverName
    ?? process.env.CODE_AGENTS_WEBCLI_SERVER_NAME
    ?? 'CODE AGENTS server',
  );
  const sessionDurationHours = parseFloat(
    process.env.CLAUDE_SESSION_HOURS || String(options.sessionHours || 5)
  );

  const aliases: Aliases = {
    claude: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
    codex: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
    agent: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor',
    pi: options.piAlias || process.env.PI_ALIAS || 'Pi',
    grok: options.grokAlias || process.env.GROK_ALIAS || 'Grok',
    qwen: options.qwenAlias || process.env.QWEN_ALIAS || 'Qwen',
    kimi: options.kimiAlias || process.env.KIMI_ALIAS || 'Kimi',
    omp: options.ompAlias || process.env.OMP_ALIAS || 'Oh My Pi',
    antigravity:
      options.antigravityAlias || process.env.ANTIGRAVITY_ALIAS || 'Antigravity',
  };

  return {
    // Zero asks Node for an ephemeral port; desktop uses it to avoid colliding
    // with a separately running CLI server.
    port: options.port ?? 32352,
    host: options.host,
    desktop: options.desktop ?? null,
    dev: options.dev || false,
    // Not a choice any more: see the note in start(). `--https` is kept as an
    // accepted no-op so existing scripts and service units do not fail.
    // Plain HTTP is safe only for the API-only desktop mode, which is bound to
    // loopback and still requires its embedder-owned cookie token.
    useHttps: options.desktop ? false : true,
    certFile: options.cert,
    keyFile: options.key,
    setup: options.setup || false,
    folderMode: options.folderMode !== false,
    selectedWorkingDir: null,
    baseFolder: options.baseFolder || process.cwd(),
    publicBaseUrl: options.publicBaseUrl || process.env.PUBLIC_BASE_URL || null,
    // Do not use os.hostname(): the identity endpoint is public before login,
    // and an operator should choose whether their host name is disclosed.
    serverName,
    publicDiscoverableUrl,
    lanDiscoverable,
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
    allowAnyGitHubUser:
      options.allowAnyGitHubUser === true ||
      process.env.GITHUB_ALLOW_ANY_USER === 'true',
    dataDir: options.dataDir || process.env.CODE_AGENTS_WEBCLI_DATA_DIR || null,
    encryptionKey:
      options.encryptionKey || process.env.CODE_AGENTS_WEBCLI_ENCRYPTION_KEY || null,
    // Deliberately environment-only: container execution and deploy-target
    // administration remain dark until the operator opts this installation in.
    containerizedEnvironmentsEnabled:
      process.env.CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED === 'true',
    sessionDurationHours,
    aliases,
    startTime: Date.now(),
    isShuttingDown: false,
  };
}

/**
 * What the usage analytics still take from configuration: the window length.
 *
 * It used to take a plan name and a cost ceiling too, which is what drew the
 * status panel's meters. Both are gone: `--plan` defaulted to `max20` for
 * everybody and selected a row of a hand-written allowance table that no
 * provider publishes, so the ceilings were guesses and the percentages drawn
 * against them were arithmetic over guesses (#137).
 */
export function createUsageAnalyticsOptions(_options: ServerOptions, sessionDurationHours: number): {
  sessionDurationHours: number;
} {
  return { sessionDurationHours };
}
