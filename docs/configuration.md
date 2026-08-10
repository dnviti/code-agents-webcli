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
| `--data-dir <path>` | `~/.code-agents-webcli` | Where the shared per-user database, configuration, certificates and logs live. Bulk chat, transcript, terminal and attachment data lives in each workspace's `.cc-web/`. |
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

State is split deliberately between the per-user application directory and the
workspace. The data directory — `~/.code-agents-webcli` unless `--data-dir`
says otherwise — contains the one shared database and global application
files. It is created `0700`.

| Path | What it is |
| --- | --- |
| `app.sqlite` (plus `-wal`, `-shm`) | The shared per-user database: users and OAuth identities, HTTP auth sessions, account preferences, server configuration, runtime profiles, deploy targets, encrypted credentials, projects, session/tab metadata, composer drafts, usage accounting, and immutable references to authorised workspace scopes. Created `0600`. |
| `.cc-web-server.lease/` | Private process lease proving that exactly one server may write this installation directory. It contains only a random ownership token, process-incarnation metadata and a heartbeat; no session content. |
| `tls/ca.crt`, `tls/ca.key` | The generated local certificate authority, reused across reissues. |
| `tls/server.crt`, `tls/server.key` | The server certificate, reissued automatically. |
| `runtime-profiles/` | Generated per-runtime tier configuration that cannot be written into a project. |
| `<target-root>/projects/<project-id>/` | Project root on its recorded deploy target. Its repository checkout and ordinary scratch files are disposable during reclaim. The root-level `.cc-web/` archive survives rebuild/reclaim through the verified staging-and-restore sequence described below and is removed only with an explicit project deletion. For the legacy target the default root is `<data-dir>/environments`. |

The database holds OAuth credentials, live auth sessions, the encryption key
for deploy-target secrets when no `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY` is
supplied, and the metadata that makes project histories addressable. Treat it
as sensitive and include it in every backup. Losing it loses users, sign-ins,
configuration, tabs, drafts, usage and the session-to-project index; restoring
it alone does **not** restore the bulk chat or terminal files.

Only one server process may use a data directory at a time. The lease is taken
before `app.sqlite` is opened; a second process
fails with `data_dir_in_use` instead of racing the first one. A crashed owner's
lease is reclaimed only when both its heartbeat is stale and that exact process
incarnation is gone. Losing ownership while live is fail-stop: the server closes
network admission and exits rather than risk two writers.

Every session is assigned one immutable workspace scope when it is created. A
normal host session uses the validated folder selected in the launcher. A
managed project uses its canonical workspace root even when the session runs in
a subdirectory or a container-only path. A shell opened from a conversation
inherits that conversation's scope. Later working-directory changes do not move
the archive.

The project-local layout is versioned and owner-scoped:

```text
<workspace>/.cc-web/
  .gitignore
  attachments/<owner-key>/<session-id>/  # chat files and images
  pasted/                         # terminal image bytes, when used
  sessions/<owner-key>/<session-id>/
    chat.jsonl                    # conversation event stream
    chat.idx                      # event index
    chat.ctx                      # opening/branch context, when present
    chat.plan                     # current Plan document, when present
    transcript.md
    history.log
    history.idx
    paste-manifest.json
```

There is deliberately no SQLite file in this tree. Session/tab metadata,
composer drafts, usage and the immutable reference to this workspace live in
the per-user `app.sqlite`; `.cc-web` contains only project-specific bulk data.

The owner key is derived from the account's immutable GitHub identity and does
not expose that identity in clear text. `.cc-web` directories are owner-only
(`0700`) and created without following symlinks; state files are owner-only
(`0600`) where the filesystem supports POSIX modes. The app creates
`.cc-web/.gitignore` only when it is absent and never rewrites the bytes of an
existing file. An existing marker must be a single-link regular file; symlinks,
directories and hard links are refused, and its mode is hardened to `0600`.
The generated ignore covers the whole session archive, so it does not appear
in `git status`. Project source files such as `.pi/agents/` remain separate
from this archive.

Mutating an archive also requires a filesystem primitive that can prove the
opened `.cc-web` directory did not change during the operation. Linux uses a
verified descriptor-relative path. Windows and macOS use a helper whose working
directory is pinned to the verified parent; the helper owns direct-child file
creation, publication, rename and removal. The per-user `app.sqlite` is never
opened or published through this project-file path, and `.cc-web` has no SQLite
sidecars or writer lease. A host that cannot provide its platform's guarantee
fails closed with `UNSAFE_WORKSPACE_STORAGE`; the app never falls back to
installation-level storage for project-specific files.

Electron/Chromium Web Storage contains presentation preferences only. Draft
text, attachment descriptors, active/closed tab ids, split assignments, child
terminal ids and other session metadata are rows in the server's per-user
`app.sqlite`, which the desktop build keeps below its `userData` directory.
Attachment bodies and other project-specific content remain in `.cc-web`. The
renderer does not duplicate either class of durable state in Web Storage.

Because the archive contains plaintext conversation and terminal history, one
canonical workspace root is bound to exactly one immutable account identity in
the installation catalog. A second account receives
`workspace_persistence_unavailable`; any catalog that assigns the same root to
multiple accounts is quarantined for every claimant until the conflicting path
entry is corrected. This is application-level ownership. Accounts allowed
to run unrestricted host commands still share the operating-system user's
filesystem boundary, as described in [Architecture](architecture.md#security-model).

Operational controls, approval state, runtime identifiers and authorised scope
references live in the per-user database, not in `.cc-web`. Project files are
parsed defensively and never import execution authority, authentication state or
scope grants when they are copied from another checkout.

At startup the server loads session metadata and immutable scope references from
the per-user database, then revalidates the referenced canonical workspace
roots. It never recursively scans the filesystem, follows a symlink to find
history, or discovers sessions by opening a project database.

Managed-project rebuild and reclaim temporarily move the exact pinned
`.cc-web` directory to the deterministic sibling
`.<project-id>.ccweb-session-storage-retained`, outside the project root exposed
to the container. The app synchronises the source and staging parents, removes
the disposable workspace entries, then restores and verifies the same directory
inode before project-file access resumes. A newly-created `.cc-web` name never
overwrites the staged authority. After a cold crash, boot reconciliation first
makes every reachable managed runtime non-executable and only then restores the
staged archive before session discovery. If runtime quiescence or exact-inode
restoration cannot be proved, the archive remains staged and the workspace is
reported unavailable; the app does not create an empty replacement archive.
Host projects, which have no managed container runtime to quiesce, can be
recovered directly. See [What survives a rebuild](projects.md#what-survives-a-rebuild).

### Fresh installations and existing files

There is no automatic migration from an older storage layout. A fresh
installation creates a new per-user `app.sqlite`; old database files and project
artifacts are left untouched and are not imported, copied or deleted. In
particular, an existing `.cc-web` tree does not recreate the global session
catalog, tabs, drafts, usage rows or scope references.

If an expected workspace is missing, read-only, symlinked, outside the
authorised area, owned by another account, or conflicts with another scope, the
server reports `workspace_persistence_unavailable`. It does not replace an
unsafe archive and never moves project-specific files into the application data
directory. Restore both matching halves of a backup and access to the original
canonical root, then open the folder again or restart the server. Persistence
diagnostics report the loaded global records, their workspace scopes and any
unavailable roots.

### Backing up and restoring

For a complete backup, include all three categories:

1. the per-user application data directory, including `app.sqlite`, for
   accounts, authentication, settings, certificates, credentials, project and
   folder catalogs, session/tab metadata, drafts, usage and scope references;
2. `.cc-web/` from every workspace, for chat events, transcripts, terminal
   history, attachments and pasted content;
3. persistent user homes and project storage described in
   [Projects](projects.md) and [Per-user environments](user-environments.md).

Stop the server before a filesystem copy, or use a snapshot mechanism that
captures `app.sqlite` together with its `-wal` and `-shm` sidecars. Project
`.cc-web` trees contain no SQLite database or SQLite sidecars. Restore each tree
at the same canonical workspace root and preserve its permissions. A complete
restore requires both the application data directory and every relevant
`.cc-web` tree; neither half reconstructs the other, and pointing `--data-dir`
at a project archive is not a migration mechanism.

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
