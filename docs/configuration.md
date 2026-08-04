# Configuration

Every flag, every environment variable, where state lives, and what the setup
wizard asks.

## Precedence

Each value is resolved once at startup:

```text
CLI flag  >  environment variable  >  built-in default
```

The OAuth settings have one more layer. Anything the
[setup wizard](#first-run-setup) stored in the database is used **only where the
CLI and environment left the value empty**:

```text
CLI flag  >  environment variable  >  value stored by a previous wizard run  >  unconfigured
```

`--data-dir` is the exception that cannot be persisted — the database lives
inside it — so it is CLI or environment only.

## First-run setup

The wizard runs on first start, and any time you pass `--setup`. It needs an
interactive terminal; without one the server tells you to supply
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` instead (which is the
situation [in a container](running-as-a-service.md#docker)).

**Stage 1 — sign-in.** Five questions, stored in the database immediately:

1. **Public base URL** — defaults to `https://localhost:<port>`. Required.
2. **GitHub OAuth Client ID** — required.
3. **GitHub OAuth Client Secret** — not echoed as you type.
4. **Allowed GitHub user IDs**, comma-separated — required, and an empty answer
   is refused, because an empty allow-list denies everyone. See
   [the allow-list](github-oauth.md#the-allow-list).
5. **GitHub App token** — optional, press Enter to skip.

**Stage 2 — how to run.** Only on Linux with a systemd user manager, and only
when not running from the npx cache:

1. **Run mode** — foreground (default), or install a
   [background service](running-as-a-service.md#systemd-linux).
2. If you chose the service: **working directory**, which bounds the file
   browser in the web UI. It must exist, be a directory, and not be the
   filesystem root; you are shown what that exposes and asked to confirm.

Credentials are written to the database, never into the systemd unit or a
command line that would show up in `ps`.

## CLI flags

```bash
cc-web --help
```

### Server

| Flag | Default | What it does |
| --- | --- | --- |
| `-p, --port <number>` | `32352` | HTTPS port. Validated 1–65535. |
| `--no-open` | opens | Do not open a browser after starting. |
| `--data-dir <path>` | `~/.code-agents-webcli` | Where the database, certificates and logs live. |
| `--setup` | — | Force the setup wizard even when already configured. |
| `--dev` | off | Extra diagnostics from the WebSocket layer. |
| `--https` | — | **Accepted and ignored.** HTTPS is always on; the flag exists so older scripts and units do not break. |

### Per-user environments

The entire containerized-environment and deploy-target capability is off by
default. Set `CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED=true` before starting
the server to expose it, then select a deploy target or use the legacy flags
below. See [Per-user environments](user-environments.md) for the prerequisites,
where the data lives, and the operator commands.

| Flag | Default | What it does |
| --- | --- | --- |
| `--containers` | off | Request legacy per-user containers. Has no effect unless `CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED=true`. |
| `--container-engine <engine>` | `docker` | `docker` or `podman`. |
| `--container-image <image>` | `docker.io/library/node:22-bookworm` | Base image each environment starts from. |
| `--container-cpus <n>` | unlimited | CPU limit per environment. |
| `--container-memory <size>` | unlimited | Memory limit per environment, e.g. `4g`. |
| `--container-idle-minutes <n>` | `0` | Stop an idle environment after this long; `0` never does. |
| `--container-setup <command>` | — | Shell run once inside each newly created environment. |
| `--encryption-key <key>` | — | base64 or hex 32-byte key for deploy-target secrets. |

Two subcommands operate on them, and work whether or not the server is running:

```bash
cc-web env ls                                # what exists, and whose it is
cc-web env rm <name> [--purge-data]          # remove one, optionally with its data
```

### Deploy targets

After `CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED=true` is set and the server is
restarted, the place environments run can be configured in the web UI
as a set of deploy targets rather than through these flags. You can name
several targets, switch the active one at runtime, and let each carry its own
connection secrets. See [Deploy targets](deploy-targets.md).

### Project lifetime settings

Projects use deploy targets, but their lifetime policy is installation-wide and
is configured by the installer in **Settings → Deploy targets**. These values are
stored in the application database and survive a restart; they are not CLI
flags or environment variables.

| Setting | Default | What it does |
| --- | --- | --- |
| Maximum running projects per user | `3` | Limits one user's building/running projects. It does not limit how many projects they may create or keep stopped. |
| Idle stop | `60 minutes` | Stops a project with no active sessions, attachments, builds, commands, or agent work. Its worktree remains. |
| Idle reclaim | `7 days` | Reclaims a long-stopped idle project after preservation succeeds; its next open builds a fresh container and checkout. |

The reclaim period is intentionally longer than idle stop. Repository changes
are preserved to a non-overwriting WIP branch before a reclaim or rebuild; a
failed preservation blocks the operation until its user retries or explicitly
discards the uncommitted checkout work. See [Projects](projects.md).

### TLS

| Flag | Default | What it does |
| --- | --- | --- |
| `--cert <path>` | generated | Use this certificate instead of the generated one. |
| `--key <path>` | generated | Private key for `--cert`. |

Pass both or neither — supplying only one fails at startup. See
[HTTPS and certificates](https-and-certificates.md).

### Sign-in

| Flag | Default | What it does |
| --- | --- | --- |
| `--public-base-url <url>` | `https://localhost:<port>` | Public URL the OAuth callback is built from. |
| `--github-client-id <id>` | from DB/env | GitHub OAuth client ID. |
| `--github-client-secret <secret>` | from DB/env | GitHub OAuth client secret. |
| `--github-app-token <token>` | from DB/env | Optional GitHub App token. |
| `--allowed-github-ids <ids>` | from DB/env | Comma-separated **numeric** GitHub user IDs allowed to sign in. |
| `--allow-any-github-user` | off | Let any GitHub account sign in. Only consulted when the allow-list is empty. Dangerous — see [the allow-list](github-oauth.md#the-allow-list). |

### Tunnel

| Flag | Default | What it does |
| --- | --- | --- |
| `--ngrok-auth-token <token>` | none | ngrok auth token. |
| `--ngrok-domain <domain>` | none | Reserved ngrok domain. |

Both or neither — one without the other exits with an error.

### Display names

Each renames one runtime in the UI, and each has a matching environment
variable.

| Flag | Environment | Default |
| --- | --- | --- |
| `--claude-alias <name>` | `CLAUDE_ALIAS` | `Claude` |
| `--codex-alias <name>` | `CODEX_ALIAS` | `Codex` |
| `--agent-alias <name>` | `AGENT_ALIAS` | `Cursor` |
| `--pi-alias <name>` | `PI_ALIAS` | `Pi` |
| `--grok-alias <name>` | `GROK_ALIAS` | `Grok` |
| `--qwen-alias <name>` | `QWEN_ALIAS` | `Qwen` |
| `--kimi-alias <name>` | `KIMI_ALIAS` | `Kimi` |
| `--omp-alias <name>` | `OMP_ALIAS` | `Oh My Pi` |
| `--antigravity-alias <name>` | `ANTIGRAVITY_ALIAS` | `Antigravity` |

### Usage accounting

There is nothing to configure. `--plan` used to select a table of subscription
allowances compiled into this app; it is still accepted and now does nothing,
so an existing unit file or container command keeps starting. See
[what the status panel knows](usage-accounting.md#what-the-status-panel-knows)
for what replaced it.

## Environment variables

Useful in a container or a unit file, where flags are awkward.

| Variable | Equivalent flag | Default |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `--public-base-url` | — |
| `GITHUB_OAUTH_CLIENT_ID` | `--github-client-id` | — |
| `GITHUB_OAUTH_CLIENT_SECRET` | `--github-client-secret` | — |
| `GITHUB_APP_TOKEN` | `--github-app-token` | — |
| `GITHUB_ALLOWED_USER_IDS` | `--allowed-github-ids` | empty |
| `GITHUB_ALLOW_ANY_USER` | `--allow-any-github-user` | `false` — only the exact string `true` enables it |
| `CODE_AGENTS_WEBCLI_DATA_DIR` | `--data-dir` | `~/.code-agents-webcli` |
| `CODE_AGENTS_WEBCLI_CONTAINERS` | `--containers` | `false` — requests legacy container mode after the feature gate is enabled |
| `CODE_AGENTS_WEBCLI_CONTAINER_ENGINE` | `--container-engine` | `docker` |
| `CODE_AGENTS_WEBCLI_CONTAINER_IMAGE` | `--container-image` | `docker.io/library/node:22-bookworm` |
| `CODE_AGENTS_WEBCLI_CONTAINER_CPUS` | `--container-cpus` | unlimited |
| `CODE_AGENTS_WEBCLI_CONTAINER_MEMORY` | `--container-memory` | unlimited |
| `CODE_AGENTS_WEBCLI_CONTAINER_IDLE_MINUTES` | `--container-idle-minutes` | `0` |
| `CODE_AGENTS_WEBCLI_CONTAINER_SETUP` | `--container-setup` | — |
| `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY` | `--encryption-key` | — |
| `CLAUDE_ALIAS` … `ANTIGRAVITY_ALIAS` | `--*-alias` | see above |

These have **no flag** and can only be set through the environment:

| Variable | Default | What it does |
| --- | --- | --- |
| `CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED` | `false` | Only the exact string `true` enables containerized environments and exposes deploy-target configuration. Stored targets are ignored while off. |
| `CLAUDE_SESSION_HOURS` | `5` | Length of the rolling usage window, in hours. |
| `CLAUDE_CONFIG_DIR` | `$HOME` | Where the Claude CLI keeps `.claude.json`. Read for a cached account reading, never for credentials. |
| `DEBUG` | unset | If set, logs raw pseudo-terminal output per session. Extremely noisy, and independent of `--dev`. |

Two more are read from the ambient environment rather than configured: `HOME`
(used to find each agent CLI's install location) and `SHELL` (the login shell a
terminal session starts).

## Where state lives

With per-user environments on, each account also gets
`environments/<prefix>-<login>-<user-id>/` under the data directory — that
directory is the user's home inside their container, and it is what a backup
has to include. See [Per-user environments](user-environments.md#where-the-data-lives).

Everything sits under the data directory — `~/.code-agents-webcli` unless
`--data-dir` says otherwise. The directory is created `0700`.

| Path | What it is |
| --- | --- |
| `app.sqlite` (plus `-wal`, `-shm`) | Settings, users, auth sessions, runtime session records, runtime profiles. Created `0600`. |
| `tls/ca.crt`, `tls/ca.key` | The generated local certificate authority, reused across reissues. |
| `tls/server.crt`, `tls/server.key` | The server certificate, reissued automatically. |
| `history/<user>/<session>` | Server-side scrollback, as an append-only log plus a fixed-width index. |
| `transcripts/` | Session transcripts. |
| `pastes/<user>/<session>.json` | Manifests for [pasted images](terminal.md#pasting-images). The image bytes live in the project directory. |
| `<user>/<session>.jsonl` | Event log for a [WebUI chat](runtimes.md#the-webui-beta) session. |
| `runtime-profiles/` | Generated per-runtime tier configuration that cannot be written into a project. |
| `<target-root>/projects/<project-id>/` | Disposable project worktree on its recorded deploy target. For the legacy target the default root is `<data-dir>/environments`; it can be removed during reclaim and rebuilt from its repository. |

The database holds OAuth credentials, live auth sessions, and the encryption key
for deploy-target secrets when no `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY` is supplied.
Treat it as sensitive, and include it in whatever you back up — losing it loses
your users, their sessions and your configuration.

Some files are written **inside your project directory** rather than the data
directory, because the agent CLIs have to be able to read them:

- `.cc-web/pasted/` — [pasted images](terminal.md#pasting-images)
- `.pi/agents/` — [capability tiers](runtimes.md#capability-tiers) for pi

Both get a generated `.gitignore`, so neither shows up in `git status`.

## Examples

```bash
# Re-run setup, then start
cc-web --setup

# A different port and data directory
cc-web --port 8443 --data-dir /srv/agents-state

# A real certificate instead of the generated one
cc-web --cert /etc/letsencrypt/live/example.com/fullchain.pem \
       --key  /etc/letsencrypt/live/example.com/privkey.pem

# Fully non-interactive
cc-web \
  --public-base-url https://agents.example.com \
  --github-client-id "$CLIENT_ID" \
  --github-client-secret "$CLIENT_SECRET" \
  --allowed-github-ids 12345,67890 \
  --no-open
```
