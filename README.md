# Code Agents Web CLI

`code-agents-webcli` is a single Node.js web application for running Claude Code, Codex, Cursor Agent, and classic terminal sessions from the browser.

It now supports:

- GitHub OAuth authentication
- multi-user session isolation keyed by GitHub user IDs
- SQLite-backed persistence for users, auth sessions, working directories, and runtime sessions
- xterm.js-based terminals
- Docker image builds and GitHub Actions release automation

## Requirements

- Node.js `>= 20`
- Claude / Codex / Cursor CLI binaries available on the server host `PATH`
- A GitHub OAuth App for sign-in
- A modern browser with WebSocket support

## Quick Start

Run without installing:

```bash
npx code-agents-webcli
```

Or install globally:

```bash
npm install -g code-agents-webcli
code-agents-webcli
```

On the first interactive run, the server asks for:

1. the public base URL
2. the GitHub OAuth client ID
3. the GitHub OAuth client secret
4. the allowed GitHub user IDs, if you want an allowlist
5. the GitHub App token, if your internal setup needs one

Those values are stored in the local SQLite database.

## GitHub OAuth Setup

Create a GitHub OAuth App and set the callback URL to:

```text
https://your-host.example.com/auth/github/callback
```

For local development, this can be:

```text
http://localhost:32352/auth/github/callback
```

After sign-in, each browser user is mapped to an internal user record by GitHub numeric ID. Runtime sessions are filtered by owner, so users only see their own sessions.

## Persistence

By default, local state is stored in:

```text
~/.code-agents-webcli/app.sqlite
```

The database contains:

- app settings
- GitHub users
- auth sessions
- runtime sessions
- per-user selected working directories

Override the storage directory with:

```bash
code-agents-webcli --data-dir /path/to/state
```

## Common Commands

```bash
# interactive setup + normal start
code-agents-webcli --setup

# custom port
code-agents-webcli --port 8080

# HTTPS
code-agents-webcli --https --cert /path/to/cert.pem --key /path/to/key.pem

# explicit GitHub OAuth config
code-agents-webcli \
  --public-base-url https://agents.example.com \
  --github-client-id YOUR_CLIENT_ID \
  --github-client-secret YOUR_CLIENT_SECRET \
  --allowed-github-ids 12345,67890

# development mode
npm run dev
```

## CLI Options

| Option | Description | Default |
| --- | --- | --- |
| `-p, --port <number>` | HTTP port | `32352` |
| `--no-open` | Do not auto-open the browser | `false` |
| `--https` | Enable HTTPS | `false` |
| `--cert <path>` | TLS certificate path | none |
| `--key <path>` | TLS private key path | none |
| `--setup` | Force the interactive setup wizard | `false` |
| `--public-base-url <url>` | Public base URL for OAuth callbacks | `http://localhost:<port>` |
| `--github-client-id <id>` | GitHub OAuth client ID | from SQLite / env |
| `--github-client-secret <secret>` | GitHub OAuth client secret | from SQLite / env |
| `--github-app-token <token>` | Optional GitHub App token stored during setup | from SQLite / env |
| `--allowed-github-ids <ids>` | Comma-separated GitHub numeric IDs allowed to sign in | allow all |
| `--data-dir <path>` | Directory for SQLite and local state | `~/.code-agents-webcli` |
| `--dev` | Extra logging | `false` |
| `--plan <type>` | Usage analytics plan (`pro`, `max5`, `max20`) | `max20` |
| `--claude-alias <name>` | UI label for Claude | `Claude` |
| `--codex-alias <name>` | UI label for Codex | `Codex` |
| `--agent-alias <name>` | UI label for Cursor Agent | `Cursor` |
| `--ngrok-auth-token <token>` | Enable ngrok tunneling | none |
| `--ngrok-domain <domain>` | Reserved ngrok domain | none |

## Docker

Build locally:

```bash
docker build -t code-agents-webcli .
```

Run:

```bash
docker run --rm -it \
  -p 32352:32352 \
  -v code-agents-webcli-data:/home/appuser/.code-agents-webcli \
  -e GITHUB_OAUTH_CLIENT_ID=YOUR_CLIENT_ID \
  -e GITHUB_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  -e PUBLIC_BASE_URL=http://localhost:32352 \
  code-agents-webcli
```

Important:

- the image contains the web server only
- Claude / Codex / Cursor CLIs are not bundled into the container
- if you want assistant runtimes inside Docker, extend the image and install those CLIs there

## Development

```bash
npm install
npm run build
npm run dev
```

Other useful commands:

```bash
npm run typecheck
npm test
```

## GitHub Actions Release Flow

The repository includes:

- `.github/workflows/ci.yml`: typecheck, test, and Docker build validation
- `.github/workflows/release-on-main.yml`: publish the npm package and GHCR container image from `main`

The release workflow is designed for npm trusted publishing with GitHub Actions OIDC.

## What You Still Need To Configure

Publishing cannot succeed until you complete these external steps:

1. Create the GitHub OAuth App and set the callback URL for your deployment.
2. Configure npm trusted publishing for `dnviti/code-agents-webcli` against this repository and the release workflow.
3. If you plan to run the Docker image in production, make sure the required assistant CLIs are installed in the runtime environment or a derived image.

## Repository

- GitHub: `https://github.com/dnviti/code-agents-webcli`
- npm: `https://www.npmjs.com/package/code-agents-webcli`

