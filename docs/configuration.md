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
| `--data-dir <path>` | `~/.code-agents-webcli` | Where installation-wide state, certificates and logs live. Session records, history and usage live in each workspace's `.cc-web/`. |
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

State is split deliberately between the installation and the workspace. The
data directory — `~/.code-agents-webcli` unless `--data-dir` says otherwise —
contains only installation-wide state. It is created `0700`.

| Path | What it is |
| --- | --- |
| `app.sqlite` (plus `-wal`, `-shm`) | Users and OAuth identities, HTTP auth sessions, account preferences, server configuration, runtime profiles, deploy targets, encrypted credentials, the project catalog, and a path-only catalog used to find authorised workspaces. Created `0600`. It holds no new conversation, terminal, tab, or usage records. |
| `.cc-web-server.lease/` | Private process lease proving that exactly one server may write this installation directory. It contains only a random ownership token, process-incarnation metadata and a heartbeat; no session content. |
| `tls/ca.crt`, `tls/ca.key` | The generated local certificate authority, reused across reissues. |
| `tls/server.crt`, `tls/server.key` | The server certificate, reissued automatically. |
| `runtime-profiles/` | Generated per-runtime tier configuration that cannot be written into a project. |
| `<target-root>/projects/<project-id>/` | Project root on its recorded deploy target. Its repository checkout and ordinary scratch files are disposable during reclaim. The root-level `.cc-web/` archive survives rebuild/reclaim through the verified staging-and-restore sequence described below and is removed only with an explicit project deletion. For the legacy target the default root is `<data-dir>/environments`. |

The database holds OAuth credentials, live auth sessions, and the encryption key
for deploy-target secrets when no `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY` is supplied.
Treat it as sensitive, and include it in an installation backup — losing it
loses users, sign-ins and configuration, but restoring it alone does **not**
restore session history.

Only one server process may use a data directory at a time. The lease is taken
before `app.sqlite` is opened or any legacy migration begins; a second process
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

The workspace-local layout is versioned and owner-scoped:

```text
<workspace>/.cc-web/
  .gitignore
  session-state.sqlite            # session/tab state, composer drafts and per-turn usage
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
verified descriptor-relative path. macOS uses a one-shot helper whose working
directory is pinned to the verified parent inode; the helper owns direct-child
creation, publication, rename and removal. SQLite runs in memory there and
publishes one complete image atomically, so it creates no WAL, SHM or rollback
journal sidecars. Portable images are capped at 384 MiB, and one web or desktop
process owns a workspace's writer lease at a time; account-specific views in
the same server share that connection. Windows uses the same one-shot helper:
the child verifies the exact cwd identity, and Win32 pins a process cwd against
rename or removal while the relative namespace syscall runs. A host that cannot
provide its platform's guarantee fails closed with `UNSAFE_WORKSPACE_STORAGE`;
the app never falls back to installation-level session storage.

Electron/Chromium Web Storage contains presentation preferences only. Draft
text, attachment descriptors, active/closed tab ids, split assignments, child
terminal ids and other session metadata are not written to the desktop
`userData` profile. On the one-time desktop upgrade, the app first extracts the
small presentation-preference allow-list, then clears the old renderer Web
Storage and HTTP cache before loading the new renderer; cookies and isolated
remote-server partitions are not part of that cleanup.

Because the archive contains plaintext conversation and terminal history, one
canonical workspace root is bound to exactly one immutable account identity in
the installation catalog. A second account receives
`workspace_persistence_unavailable`; a legacy catalog that lists the same root
for multiple accounts is quarantined for every claimant until the conflicting
path entry is corrected. This is application-level ownership. Accounts allowed
to run unrestricted host commands still share the operating-system user's
filesystem boundary, as described in [Architecture](architecture.md#security-model).

The installation authenticates the archive's operational controls against the
same canonical workspace root. A copied, force-tracked, or otherwise
unrecognised archive can still contribute its conversation and terminal
history, but approval bypasses, native-runtime resume identifiers, model/runtime
controls, and project paths are reset and revalidated before the sessions are
admitted. This prevents repository contents from importing execution authority.

At startup the server opens only workspaces from the authorised folder and
project catalogs; it never recursively scans the filesystem or follows a
symlink to find history. Opening another authorised folder lazy-loads its
`.cc-web/session-state.sqlite`, so its conversations can reappear without a
server restart.

Managed-project rebuild and reclaim temporarily move the exact pinned
`.cc-web` directory to the deterministic sibling
`.<project-id>.ccweb-session-storage-retained`, outside the project root exposed
to the container. The app synchronises the source and staging parents, removes
the disposable workspace entries, then restores and verifies the same directory
inode before reopening its database. A newly-created `.cc-web` name never
overwrites the staged authority. After a cold crash, boot reconciliation first
makes every reachable managed runtime non-executable and only then restores the
staged archive before session discovery. If runtime quiescence or exact-inode
restoration cannot be proved, the archive remains staged and the workspace is
reported unavailable; the app does not create an empty replacement. Host
projects, which have no managed container runtime to quiesce, can be recovered
directly. See [What survives a rebuild](projects.md#what-survives-a-rebuild).

### Upgrading existing session storage

The first compatible start migrates the old session records and `usage_*` rows
from `app.sqlite`, together with global chat logs, transcript, terminal history,
indexes and paste manifests. Referenced attachments and pasted-image bytes from
the session's prior host working directories are copied into the canonical
workspace archive, and paste manifests are rewritten to those canonical paths.
Migration is per session, restartable, and copy-then-verify: file sizes and
SHA-256 checksums and database row counts are checked before any legacy source
is removed. A missing, ambiguous or conflicting binary retains all of its
sources and blocks the unit. Re-running after a crash is safe.
Each top-level session and all of its child shells form one atomic unit; an
unrelated unit in the same workspace may still complete when another is
blocked. Opening a restored folder retries its blocked units immediately, so a
server restart is not required.

Legacy source roots and their fixed/dynamic namespaces are opened through
verified directory handles and rechecked around every read and retirement;
symlinked, non-regular or multiply-linked files are not trusted. A destination
is copied to a private sibling, flushed, published without clobbering an
existing name, and followed by a directory sync. After target verification, a
legacy source is moved into a deterministic private retirement directory,
identity-checked against the already-open file, retired, and synchronised. A
restart can therefore recover the bounded publish or retirement states
deterministically rather than choosing between two names. Migration markers are
bounded, owner-bound, and accepted only for the immutable owner identity and
session they name.

The migration applies current binary limits before hashing or copying legacy
data. A pasted image is limited to 10 MiB and all pasted images referenced by
one session to 200 MiB. A chat attachment is limited to 20 MiB, with a 400 MiB
and 500-file per-session attachment namespace. Duplicate legacy layout aliases
for one logical attachment are inspected but counted once, using the largest
candidate. Paste manifests are size- and entry-bounded; invalid JSON, an
unsupported shape, duplicate or out-of-root paths, incorrect byte counts, and
over-quota manifests all fail closed while retaining their legacy sources.

If the destination workspace is missing, read-only, symlinked, outside the
authorised area, or conflicts with an already present target, the app keeps the
legacy copy and marks that workspace migration unavailable. It does not resume
writing session data to the data directory. The affected conversation remains
visible as read-only, with its migration reason; rename, branch, upload, runtime
start and deletion return a conflict instead of mutating either copy. Restore
access and open the folder again (or restart the server) to retry.
`GET /api/sessions/persistence` reports
the workspace-local layout, loaded workspaces, unavailable roots, and whether
migration is complete; a folder-specific resume request returns
`workspace_persistence_unavailable` rather than silently falling back.

### Backing up and restoring

For a complete backup, include all three categories:

1. the installation data directory, for accounts, authentication, settings,
   certificates, credentials and project/folder catalogs;
2. `.cc-web/` from every workspace, for session state, conversations, terminal
   history, attachments, paste metadata and usage;
3. persistent user homes and project storage described in
   [Projects](projects.md) and [Per-user environments](user-environments.md).

Stop the server before a filesystem copy, or use a snapshot mechanism that
captures each Linux SQLite database together with its `-wal` and `-shm`
sidecars. The Windows/macOS backend publishes a complete database image and has
no sidecars. Restore `.cc-web` at the same workspace root and preserve its
permissions. Do not use `--data-dir` as a session-history backup destination:
it no longer receives new session artifacts. Restoring both the installation
data directory and each `.cc-web` tree to their original canonical roots
preserves archive authentication; restoring only `.cc-web` keeps the recorded
history but causes the operational controls described above to be reset safely.

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
