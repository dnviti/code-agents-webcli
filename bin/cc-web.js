#!/usr/bin/env node

const { Command } = require('commander');
const { execFileSync } = require('child_process');
const packageJson = require('../package.json');
const {
  NATIVE_DEPENDENCIES,
  isGlobalRoot,
  isNativeModuleFailure,
  manualInstructions,
  repairCommands,
  resolveInstallRoot,
  resolveNpm,
} = require('./native-repair.js');

function printLines(lines) {
  for (const line of lines) {
    console.error(line);
  }
}

function askToApprove() {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Approve these install scripts and build them now? [y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

/**
 * Offer to compile the native dependencies, and report whether to retry.
 *
 * Deliberately asks first. npm blocks install scripts as a supply-chain
 * protection, and approving them runs third-party build code — that is the
 * user's call, not something to do silently on their behalf because it happens
 * to be convenient.
 */
async function offerNativeRepair(root) {
  const global = isGlobalRoot(root);
  const commands = repairCommands(root, { global });

  console.error('Cannot start code-agents-webcli: a native dependency was not compiled.');
  console.error('');
  console.error(`These packages need to build native code: ${NATIVE_DEPENDENCIES.join(', ')}`);
  console.error(`They would be built in: ${root}`);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Nobody is there to consent, so do not decide for them.
    printLines(manualInstructions(root, { global }));
    return false;
  }

  console.error('');
  if (!(await askToApprove())) {
    printLines(manualInstructions(root, { global }));
    return false;
  }

  const npm = resolveNpm();
  for (const args of commands) {
    console.error(`\n$ npm ${args.join(' ')}`);
    try {
      execFileSync(npm, args, { stdio: 'inherit' });
    } catch {
      console.error('\nThat step failed, so the build is incomplete.');
      printLines(manualInstructions(root, { global }));
      return false;
    }
  }

  return true;
}

function loadServer() {
  return require('../dist/server/index.js').ClaudeCodeWebServer;
}

async function loadServerOrRepair() {
  try {
    return loadServer();
  } catch (error) {
    const message = (error && error.message) || String(error);

    // Two very different causes: a build that never happened, versus a build
    // that is present but whose native dependencies were never compiled.
    if (!isNativeModuleFailure(message)) {
      console.error('Cannot start code-agents-webcli because the compiled server bundle is missing.');
      console.error('Run `npm run build` first, or reinstall the package if this came from npm.');
      console.error(`Original error: ${message}`);
      process.exit(1);
    }

    const root = resolveInstallRoot();
    if (!root) {
      console.error('Cannot start code-agents-webcli: a native dependency was not compiled.');
      console.error('Run `npm rebuild` in this checkout, or `npm install` if you have not yet.');
      console.error(`Original error: ${message}`);
      process.exit(1);
    }

    if (!(await offerNativeRepair(root))) {
      console.error(`\nOriginal error: ${message}`);
      process.exit(1);
    }

    try {
      // A throwing require is not cached, so this genuinely re-resolves.
      return loadServer();
    } catch (retryError) {
      console.error('\nThe native modules were built, but the server still failed to load.');
      console.error(`Original error: ${(retryError && retryError.message) || retryError}`);
      process.exit(1);
    }
  }
}

const program = new Command();

program
  .name('code-agents-webcli')
  .description('Multiuser web CLI for Claude Code, Codex, and terminal sessions')
  .version(packageJson.version)
  .option('-p, --port <number>', 'port to run the server on', '32352')
  .option('--no-open', 'do not automatically open browser')
  .option('--https', 'enable HTTPS (requires cert files)')
  .option('--cert <path>', 'path to SSL certificate file')
  .option('--key <path>', 'path to SSL private key file')
  .option('--setup', 'run the interactive installation/setup wizard before starting')
  .option('--public-base-url <url>', 'public base URL used for GitHub OAuth callbacks')
  .option('--github-client-id <id>', 'GitHub OAuth client ID')
  .option('--github-client-secret <secret>', 'GitHub OAuth client secret')
  .option('--github-app-token <token>', 'GitHub App token stored during installation')
  .option('--allowed-github-ids <ids>', 'comma-separated GitHub OAuth user IDs allowed to sign in')
  .option('--allow-any-github-user', 'allow ANY GitHub account to sign in (dangerous: signed-in users can run commands on this host)')
  .option('--data-dir <path>', 'directory for the SQLite database and local state')
  .option('--dev', 'development mode with additional logging')
  .option('--plan <type>', 'subscription plan (pro, max5, max20)', 'max20')
  .option('--claude-alias <name>', 'display alias for Claude (default: env CLAUDE_ALIAS or "Claude")')
  .option('--codex-alias <name>', 'display alias for Codex (default: env CODEX_ALIAS or "Codex")')
  .option('--agent-alias <name>', 'display alias for Agent (default: env AGENT_ALIAS or "Cursor")')
  .option('--pi-alias <name>', 'display alias for pi (default: env PI_ALIAS or "Pi")')
  .option('--grok-alias <name>', 'display alias for Grok Build (default: env GROK_ALIAS or "Grok")')
  .option('--ngrok-auth-token <token>', 'ngrok auth token to open a public tunnel')
  .option('--ngrok-domain <domain>', 'ngrok reserved domain to use for the tunnel')
  .parse();

const options = program.opts();

async function openUrl(url) {
  const { default: open } = await import('open');
  await open(url);
}

async function main() {
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
      plan: options.plan,
      publicBaseUrl: options.publicBaseUrl,
      githubClientId: options.githubClientId,
      githubClientSecret: options.githubClientSecret,
      githubAppToken: options.githubAppToken,
      allowedGitHubIds: options.allowedGitHubIds,
      allowAnyGitHubUser: options.allowAnyGitHubUser,
      dataDir: options.dataDir,
      // UI aliases for assistants
      claudeAlias: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codexAlias: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      agentAlias: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor',
      piAlias: options.piAlias || process.env.PI_ALIAS || 'Pi',
      grokAlias: options.grokAlias || process.env.GROK_ALIAS || 'Grok',
      folderMode: true // Always use folder mode
    };

    // Before the banner: repairing an uncompiled native dependency needs to
    // prompt, and announcing "Starting…" only to fail two lines later reads as
    // a crash rather than as a question.
    const ClaudeCodeWebServer = await loadServerOrRepair();

    console.log('Starting Code Agents Web CLI...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Plan: ${options.plan}`);
    console.log(`Aliases: Claude → "${serverOptions.claudeAlias}", Codex → "${serverOptions.codexAlias}", Agent → "${serverOptions.agentAlias}", pi → "${serverOptions.piAlias}", Grok → "${serverOptions.grokAlias}"`);

    const appServer = new ClaudeCodeWebServer(serverOptions);

    // Runs the first-time (or --setup) wizard. Returns false when the user
    // chose to install a background service, in which case systemd now owns
    // the port and this process must not bind it too.
    const shouldRunHere = await appServer.runSetupIfNeeded();
    if (!shouldRunHere) {
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
    
    const protocol = options.https ? 'https' : 'http';
    const url = `${protocol}://localhost:${port}`;
    
    console.log(`\n🚀 Code Agents Web CLI is running at: ${url}`);
    
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

main();
