#!/usr/bin/env node

const { Command } = require('commander');
const packageJson = require('../package.json');

const MIN_NODE_MAJOR = 24;
const MIN_NODE_MINOR = 16;

/**
 * Refuse a Node too old for the built-in SQLite serialization APIs, before
 * anything else runs.
 *
 * `engines` in package.json is advisory — npm prints a warning and installs
 * anyway — so without this check the first symptom of an unsupported Node is a
 * bare SQLite serialization failure from three frames deep inside the server.
 */
function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
    return;
  }
  console.error(
    `code-agents-webcli needs Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer `
    + `(it uses Node's built-in SQLite serialization APIs), but this is ${process.version}.`,
  );
  console.error('Upgrade Node from https://nodejs.org and run it again.');
  process.exit(1);
}

/**
 * Load the compiled server.
 *
 * There used to be a whole recovery path here that offered to compile
 * `node-pty` and `better-sqlite3` when they arrived uncompiled from a global
 * install. Neither package is a dependency any more — the pty ships as a
 * prebuilt binary and SQLite comes from Node itself — so nothing in the tree
 * has an install script left to be blocked, and the only remaining way this
 * fails is a package whose build never ran at all.
 */
function loadServer() {
  try {
    return require('../dist/server/index.js').ClaudeCodeWebServer;
  } catch (error) {
    const message = (error && error.message) || String(error);
    console.error('Cannot start code-agents-webcli because the compiled server bundle is missing.');
    console.error('Run `npm run build` in this checkout, or reinstall the package.');
    console.error(`Original error: ${message}`);
    process.exit(1);
  }
}

checkNodeVersion();

const program = new Command();

program
  .name('code-agents-webcli')
  .description('Multiuser web CLI for Claude Code, Codex, and terminal sessions')
  .version(packageJson.version)
  .option('-p, --port <number>', 'port to run the server on', '32352')
  .option('--no-open', 'do not automatically open browser')
  .option('--https', 'accepted and ignored: HTTPS is always on')
  .option('--cert <path>', 'TLS certificate to use instead of the generated one')
  .option('--key <path>', 'private key for --cert')
  .option('--setup', 'run the interactive installation/setup wizard before starting')
  .option('--public-base-url <url>', 'public base URL used for GitHub OAuth callbacks')
  .option('--server-name <name>', 'operator-provided name exposed before sign-in')
  .option('--public-discoverable-url <url>', 'canonical HTTPS URL exposed by server identity and LAN discovery')
  .option('--lan-discoverable', 'answer explicit LAN discovery probes (off by default)')
  .option('--github-client-id <id>', 'GitHub OAuth client ID')
  .option('--github-client-secret <secret>', 'GitHub OAuth client secret')
  .option('--github-app-token <token>', 'GitHub App token stored during installation')
  .option('--allowed-github-ids <ids>', 'comma-separated GitHub OAuth user IDs allowed to sign in')
  .option('--allow-any-github-user', 'allow ANY GitHub account to sign in (dangerous: signed-in users can run commands on this host)')
  .option('--data-dir <path>', 'directory for the SQLite database and local state')
  .option('--dev', 'development mode with additional logging')
  .option('--plan <type>', 'accepted and ignored: plan limits are no longer guessed')
  .option('--claude-alias <name>', 'display alias for Claude (default: env CLAUDE_ALIAS or "Claude")')
  .option('--codex-alias <name>', 'display alias for Codex (default: env CODEX_ALIAS or "Codex")')
  .option('--agent-alias <name>', 'display alias for Agent (default: env AGENT_ALIAS or "Cursor")')
  .option('--pi-alias <name>', 'display alias for pi (default: env PI_ALIAS or "Pi")')
  .option('--grok-alias <name>', 'display alias for Grok Build (default: env GROK_ALIAS or "Grok")')
  .option('--qwen-alias <name>', 'display alias for Qwen Code (default: env QWEN_ALIAS or "Qwen")')
  .option('--kimi-alias <name>', 'display alias for Kimi Code (default: env KIMI_ALIAS or "Kimi")')
  .option('--omp-alias <name>', 'display alias for Oh My Pi (default: env OMP_ALIAS or "Oh My Pi")')
  .option('--antigravity-alias <name>', 'display alias for Antigravity CLI (default: env ANTIGRAVITY_ALIAS or "Antigravity")')
  .option('--ngrok-auth-token <token>', 'ngrok auth token to open a public tunnel')
  .option('--ngrok-domain <domain>', 'ngrok reserved domain to use for the tunnel')
  .option('--containers', 'give every signed-in user their own isolated container')
  .option('--container-engine <engine>', 'docker or podman (default: docker)')
  .option('--container-image <image>', 'base image each user environment starts from')
  .option('--container-cpus <cpus>', 'CPU limit per user environment, e.g. 2')
  .option('--container-memory <size>', 'memory limit per user environment, e.g. 2g')
  .option('--container-idle-minutes <minutes>', 'stop an environment after this long idle (0 = never)')
  .option('--container-setup <command>', 'shell run once inside each newly created environment')
  .option('--container-tiers <spec>', 'sizes users may pick, e.g. "small=1,1g;medium=2,2g;large=4,4g"')
  .option('--container-default-tier <id>', 'size a user who has never chosen gets')
  .option('--no-container-user-tier-choice', 'stop users choosing their own size')
  .option('--kube-context <name>', 'kubectl context to create environments in')
  .option('--kube-namespace <name>', 'namespace for the environment pods (default: default)')
  .option('--kube-storage-claim <name>', 'ReadWriteMany claim holding every user home')
  .option('--kube-service-account <name>', 'service account for the environment pods')
  .option('--encryption-key <key>', 'base64 or hex 32-byte key encrypting deploy-target secrets at rest');

/**
 * Operator commands for the per-user environments.
 *
 * Deliberately outside the running server: an operator revoking somebody's
 * access needs to remove their environment whether or not the server is up,
 * and the container engine — not the app — is the authority on what exists.
 */
function environmentManager() {
  const {
    EnvironmentManager,
    createContainerConfig,
  } = require('../dist/server/services/environments/index.js');
  const opts = program.opts();
  const config = createContainerConfig({
    containers: true,
    containerEngine: opts.containerEngine,
    dataDir: opts.dataDir,
    kubeContext: opts.kubeContext,
    kubeNamespace: opts.kubeNamespace,
    kubeStorageClaim: opts.kubeStorageClaim,
  });
  return { manager: new EnvironmentManager({ config, hostHome: process.cwd() }), engine: config.engine };
}

/** Turn a missing engine binary into a sentence instead of a spawn errno. */
async function withEngine(work) {
  const { manager, engine } = environmentManager();
  try {
    return await work(manager);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(
        `${engine} is not installed on this machine, or is not on PATH. `
        + 'Install it, or name the other engine with --container-engine.',
      );
      process.exit(1);
    }
    throw error;
  }
}

const environments = program
  .command('env')
  .description('list and remove per-user container environments');

environments
  .command('ls')
  .description('list environments with their owners')
  .action(async () => {
    const list = await withEngine((manager) => manager.list());
    if (!list.length) {
      console.log('No per-user environments exist.');
      return;
    }
    console.log(['NAME', 'OWNER', 'USER ID', 'STATUS', 'IMAGE'].join('\t'));
    for (const item of list) {
      console.log([
        item.name,
        item.githubLogin || '?',
        item.userId ?? '?',
        item.status,
        item.image,
      ].join('\t'));
    }
  });

environments
  .command('rm <name>')
  .description('remove an environment')
  .option('--purge-data', "also delete the user's persistent home directory")
  .action(async (name, commandOptions) => {
    await withEngine((manager) => manager.remove(name, {
      purgeData: commandOptions.purgeData === true,
    }));
    console.log(
      commandOptions.purgeData
        ? `Removed ${name} and deleted its data.`
        : `Removed ${name}. Its data is still on disk; pass --purge-data to delete it too.`,
    );
  });

async function openUrl(url) {
  const { default: open } = await import('open');
  await open(url);
}

async function main() {
  // Read after parsing, not before: this is the object commander fills in.
  const options = program.opts();

  try {
    const port = parseInt(options.port, 10);
    
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Port must be a number between 1 and 65535');
      process.exit(1);
    }

    const serverOptions = {
      port,
      https: options.https,
      cert: options.cert,
      key: options.key,
      setup: options.setup,
      dev: options.dev,
      publicBaseUrl: options.publicBaseUrl,
      serverName: options.serverName,
      publicDiscoverableUrl: options.publicDiscoverableUrl,
      lanDiscoverable: options.lanDiscoverable === true,
      githubClientId: options.githubClientId,
      githubClientSecret: options.githubClientSecret,
      githubAppToken: options.githubAppToken,
      // commander derives the property name mechanically — `--allowed-github-ids`
      // becomes `allowedGithubIds`, with a lower-case `h`. Reading the
      // `GitHub`-cased spelling the rest of the codebase uses silently yielded
      // `undefined`, so both of these flags did nothing at all: the allow-list
      // fell through to the environment (usually empty, refusing every sign-in)
      // and the deliberate "let anyone in" opt-in could not be expressed.
      allowedGitHubIds: options.allowedGithubIds,
      allowAnyGitHubUser: options.allowAnyGithubUser,
      dataDir: options.dataDir,
      // UI aliases for assistants
      claudeAlias: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codexAlias: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      agentAlias: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor',
      piAlias: options.piAlias || process.env.PI_ALIAS || 'Pi',
      grokAlias: options.grokAlias || process.env.GROK_ALIAS || 'Grok',
      qwenAlias: options.qwenAlias || process.env.QWEN_ALIAS || 'Qwen',
      kimiAlias: options.kimiAlias || process.env.KIMI_ALIAS || 'Kimi',
      ompAlias: options.ompAlias || process.env.OMP_ALIAS || 'Oh My Pi',
      antigravityAlias:
        options.antigravityAlias || process.env.ANTIGRAVITY_ALIAS || 'Antigravity',
      // Per-user container environments. Absent means the historical
      // behaviour: everything runs on this host, as this account.
      containers: options.containers === true,
      containerEngine: options.containerEngine,
      containerImage: options.containerImage,
      containerCpus: options.containerCpus,
      containerMemory: options.containerMemory,
      containerIdleMinutes: options.containerIdleMinutes !== undefined
        ? Number(options.containerIdleMinutes)
        : undefined,
      containerSetupCommand: options.containerSetup,
      containerTiers: options.containerTiers,
      containerDefaultTier: options.containerDefaultTier,
      // commander turns `--no-x` into `x: false`, so this is only ever false
      // when the operator asked for it.
      containerUserTierChoice: options.containerUserTierChoice,
      kubeContext: options.kubeContext,
      kubeNamespace: options.kubeNamespace,
      kubeStorageClaim: options.kubeStorageClaim,
      kubeServiceAccount: options.kubeServiceAccount,
      encryptionKey: options.encryptionKey,
      folderMode: true // Always use folder mode
    };

    // Before the banner: announcing "Starting…" only to fail two lines later
    // reads as a crash rather than as a missing build.
    const ClaudeCodeWebServer = loadServer();

    console.log('Starting Code Agents Web CLI...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    // Built from a table rather than one template string: the line grew past
    // terminal width every time a runtime was added, and each addition meant
    // editing a 200-character literal.
    const aliasBanner = [
      ['Claude', serverOptions.claudeAlias],
      ['Codex', serverOptions.codexAlias],
      ['Agent', serverOptions.agentAlias],
      ['pi', serverOptions.piAlias],
      ['Grok', serverOptions.grokAlias],
      ['Qwen', serverOptions.qwenAlias],
      ['Kimi', serverOptions.kimiAlias],
      ['Oh My Pi', serverOptions.ompAlias],
      ['Antigravity', serverOptions.antigravityAlias],
    ]
      .map(([name, alias]) => `${name} → "${alias}"`)
      .join(', ');
    console.log(`Aliases: ${aliasBanner}`);
    const deployTargetsEnabled =
      process.env.CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED === 'true';
    const legacyContainersRequested =
      serverOptions.containers || process.env.CODE_AGENTS_WEBCLI_CONTAINERS === 'true';
    if (deployTargetsEnabled && legacyContainersRequested) {
      const engine = serverOptions.containerEngine
        || process.env.CODE_AGENTS_WEBCLI_CONTAINER_ENGINE
        || 'docker';
      console.log(
        engine === 'kubernetes'
          ? `Environments: one pod per user, in namespace ${serverOptions.kubeNamespace || process.env.CODE_AGENTS_WEBCLI_KUBE_NAMESPACE || 'default'}`
          : `Environments: one container per user, via ${engine}`,
      );
    } else if (legacyContainersRequested) {
      console.warn(
        'Containerized environments are disabled. Set '
        + 'CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED=true to enable them.',
      );
    }

    const appServer = new ClaudeCodeWebServer(serverOptions);

    // Runs the first-time (or --setup) wizard. Returns false when the user
    // chose to install a background service, in which case systemd now owns
    // the port and this process must not bind it too.
    const shouldRunHere = await appServer.runSetupIfNeeded();
    if (!shouldRunHere) {
      // The constructor owns the installation data-directory lease before it
      // opens SQLite. A setup flow which hands execution to systemd must close
      // those writers and release the lease before the service starts.
      await appServer.shutdown();
      process.exit(0);
    }

    await appServer.start();

    // ngrok setup
    const hasNgrokToken = !!options.ngrokAuthToken;
    const hasNgrokDomain = !!options.ngrokDomain;

    if ((hasNgrokToken && !hasNgrokDomain) || (!hasNgrokToken && hasNgrokDomain)) {
      console.error('Error: Both --ngrok-auth-token and --ngrok-domain are required to enable ngrok tunneling');
      process.exit(1);
    }

    let ngrokListener = null;
    
    // Always https: the server refuses to serve content over anything else,
    // because a plain-http origin off localhost is not a secure context and the
    // browser then withholds the service worker the app needs.
    const url = `https://localhost:${port}`;

    console.log(`\n🚀 Code Agents Web CLI is running at: ${url}`);
    console.log(
      'From another device use https://<this-host>:'
      + `${port} and install the local CA once from https://<this-host>:${port}/ca.crt`,
    );
    
    // Start ngrok tunnel if both flags provided
    let publicUrl = null;
    if (hasNgrokToken && hasNgrokDomain) {
      console.log('\n🌐 Starting ngrok tunnel...');
      try {
        const mod = await import('@ngrok/ngrok');
        const ngrok = mod.default || mod;

        if (typeof ngrok.authtoken === 'function') {
          try { await ngrok.authtoken(options.ngrokAuthToken); } catch (_) {}
        }

        ngrokListener = await ngrok.connect({
          addr: port,
          authtoken: options.ngrokAuthToken,
          domain: options.ngrokDomain
        });

        if (ngrokListener && typeof ngrokListener.url === 'function') {
          publicUrl = ngrokListener.url();
        }

        if (!publicUrl && ngrokListener && ngrokListener.url) {
          publicUrl = ngrokListener.url; // fallback in case API exposes property
        }

        if (publicUrl) {
          console.log(`\n🌍 ngrok tunnel established: ${publicUrl}`);
        } else {
          console.log('\n🌍 ngrok tunnel established');
        }

        if (options.open && publicUrl) {
          try {
            await openUrl(publicUrl);
          } catch (error) {
            console.warn('Could not automatically open browser:', error.message);
          }
        }

      } catch (error) {
        console.error('Failed to start ngrok tunnel:', error.message);
      }
    } else if (options.open) {
      // Open local URL only when ngrok not used and auto-open enabled
      try {
        await openUrl(url);
      } catch (error) {
        console.warn('Could not automatically open browser:', error.message);
      }
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      // Close ngrok tunnel first if active
      if (ngrokListener && typeof ngrokListener.close === 'function') {
        try { await ngrokListener.close(); } catch (_) {}
      }

      await appServer.shutdown();
      console.log('Server closed');
      process.exit(0);
    };

    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });

  } catch (error) {
    console.error('Error starting server:', error.message);
    process.exit(1);
  }
}

// Starting the server is the root command's own action, not something done
// after parsing. Once a program has subcommands, commander answers a bare
// invocation with the help text unless the root has an action of its own — so
// leaving this out stopped `cc-web` from starting at all, which is the one
// thing it must always do.
program.action(() => main());

// parseAsync, not parse: the `env` subcommands do real work and their actions
// are async.
program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
