#!/usr/bin/env node

const { Command } = require('commander');
const packageJson = require('../package.json');

let ClaudeCodeWebServer;
try {
  ClaudeCodeWebServer = require('../dist/server/index.js').ClaudeCodeWebServer;
} catch (error) {
  console.error('Cannot start code-agents-webcli because the compiled server bundle is missing.');
  console.error('Run `npm run build` first, or reinstall the package if this came from npm.');
  if (error && error.message) {
    console.error(`Original error: ${error.message}`);
  }
  process.exit(1);
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
  .option('--data-dir <path>', 'directory for the SQLite database and local state')
  .option('--dev', 'development mode with additional logging')
  .option('--plan <type>', 'subscription plan (pro, max5, max20)', 'max20')
  .option('--claude-alias <name>', 'display alias for Claude (default: env CLAUDE_ALIAS or "Claude")')
  .option('--codex-alias <name>', 'display alias for Codex (default: env CODEX_ALIAS or "Codex")')
  .option('--agent-alias <name>', 'display alias for Agent (default: env AGENT_ALIAS or "Cursor")')
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
      dataDir: options.dataDir,
      // UI aliases for assistants
      claudeAlias: options.claudeAlias || process.env.CLAUDE_ALIAS || 'Claude',
      codexAlias: options.codexAlias || process.env.CODEX_ALIAS || 'Codex',
      agentAlias: options.agentAlias || process.env.AGENT_ALIAS || 'Cursor',
      folderMode: true // Always use folder mode
    };

    console.log('Starting Code Agents Web CLI...');
    console.log(`Port: ${port}`);
    console.log('Mode: Folder selection mode');
    console.log(`Plan: ${options.plan}`);
    console.log(`Aliases: Claude → "${serverOptions.claudeAlias}", Codex → "${serverOptions.codexAlias}", Agent → "${serverOptions.agentAlias}"`);

    const appServer = new ClaudeCodeWebServer(serverOptions);
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
