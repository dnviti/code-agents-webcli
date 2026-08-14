#!/usr/bin/env node

const { Command } = require('commander');
const packageJson = require('../package.json');

const MIN_NODE_MAJOR = 24;
const MIN_NODE_MINOR = 16;

/** Enforce the Node version needed by the built-in SQLite APIs. */
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

/** Load the compiled SDK late so a missing build gets a useful diagnostic. */
function loadServerFactory() {
  try {
    return require('../dist/sdk/node/index.js').createCodeAgentsServer;
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
const AGENT_ALIASES = [
  ['claude', 'Claude', 'Claude'],
  ['codex', 'Codex', 'Codex'],
  ['agent', 'Agent', 'Cursor'],
  ['pi', 'pi', 'Pi'],
  ['grok', 'Grok', 'Grok', 'Grok Build'],
  ['qwen', 'Qwen', 'Qwen', 'Qwen Code'],
  ['kimi', 'Kimi', 'Kimi', 'Kimi Code'],
  ['omp', 'Oh My Pi', 'Oh My Pi'],
  ['antigravity', 'Antigravity', 'Antigravity', 'Antigravity CLI'],
];

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
  .option('--plan <type>', 'accepted and ignored: plan limits are no longer guessed');

for (const [id, name, fallback, helpName = name] of AGENT_ALIASES) {
  program.option(`--${id}-alias <name>`, `display alias for ${helpName} (default: env ${id.toUpperCase()}_ALIAS or "${fallback}")`);
}

program
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

/** Manage environments directly through their container-engine authority. */
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
      // Commander spells --allowed-github-ids as allowedGithubIds.
      allowedGitHubIds: options.allowedGithubIds,
      allowAnyGitHubUser: options.allowAnyGithubUser,
      dataDir: options.dataDir,
      ...Object.fromEntries(AGENT_ALIASES.map(([id, _name, fallback]) => {
        const key = `${id}Alias`;
        return [key, options[key] || process.env[`${id.toUpperCase()}_ALIAS`] || fallback];
      })),
      // Without containers, work runs directly as the host account.
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
      // Commander turns --no-x into x: false.
      containerUserTierChoice: options.containerUserTierChoice,
      kubeContext: options.kubeContext,
      kubeNamespace: options.kubeNamespace,
      kubeStorageClaim: options.kubeStorageClaim,
      kubeServiceAccount: options.kubeServiceAccount,
      encryptionKey: options.encryptionKey,
      folderMode: true,
    };

    // Fail on a missing build before printing the startup banner.
    const createCodeAgentsServer = loadServerFactory();

    console.log('Starting Code Agents Web CLI...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    const aliasBanner = AGENT_ALIASES
      .map(([id, name]) => `${name} → "${serverOptions[`${id}Alias`]}"`)
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

    const appServer = createCodeAgentsServer(serverOptions);

    // A false setup result means a background service now owns startup.
    const shouldRunHere = await appServer.runSetupIfNeeded();
    if (!shouldRunHere) {
      // Release the database and data-directory lease before that service starts.
      await appServer.shutdown();
      process.exit(0);
    }

    await appServer.start();

    const hasNgrokToken = !!options.ngrokAuthToken;
    const hasNgrokDomain = !!options.ngrokDomain;

    if ((hasNgrokToken && !hasNgrokDomain) || (!hasNgrokToken && hasNgrokDomain)) {
      console.error('Error: Both --ngrok-auth-token and --ngrok-domain are required to enable ngrok tunneling');
      process.exit(1);
    }

    let ngrokListener = null;
    
    // Remote browsers require an HTTPS secure context for the service worker.
    const url = `https://localhost:${port}`;

    console.log(`\n🚀 Code Agents Web CLI is running at: ${url}`);
    console.log(
      'From another device use https://<this-host>:'
      + `${port} and install the local CA once from https://<this-host>:${port}/ca.crt`,
    );
    
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

        publicUrl = typeof ngrokListener?.url === 'function'
          ? ngrokListener.url()
          : ngrokListener?.url || null;
        console.log(publicUrl
          ? `\n🌍 ngrok tunnel established: ${publicUrl}`
          : '\n🌍 ngrok tunnel established');

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
      try {
        await openUrl(url);
      } catch (error) {
        console.warn('Could not automatically open browser:', error.message);
      }
    }

    console.log('\nPress Ctrl+C to stop the server\n');

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

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

// Keep the bare invocation as the root action even though env subcommands exist.
program.action(() => main());

// Environment subcommands perform asynchronous work.
program.parseAsync().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
