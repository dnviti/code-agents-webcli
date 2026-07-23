# Code Agents Web CLI

`code-agents-webcli` is a single Node.js web application for running Claude Code, Codex, Cursor
Agent, pi, Grok Build, Qwen Code, Kimi Code, and classic terminal sessions from the browser.

It now supports:

- GitHub OAuth authentication
- multi-user session isolation keyed by GitHub user IDs
- SQLite-backed persistence for users, auth sessions, working directories, and runtime sessions
- xterm.js-based terminals
- Docker image builds and GitHub Actions release automation

## Requirements

- Node.js `>= 20`
- The agent CLIs you intend to use on the server host `PATH`: `claude`, `codex`, `cursor-agent`,
  `pi`, `grok`, `qwen`, `kimi`. Each is optional — a missing one only fails when you press its
  button.
- A GitHub OAuth App for sign-in
- A modern browser with WebSocket support

## Quick Start

This package is not published to npm; it installs straight from GitHub.

Before you start, create a [GitHub OAuth App](https://github.com/settings/developers) and set its
callback URL to `<your base URL>/auth/github/callback` — for a local install that is
`https://localhost:32352/auth/github/callback`. The server is HTTPS only, so the callback is
too. You will also want your own GitHub numeric user ID,
which `curl -s https://api.github.com/users/<your-login> | grep '"id"'` will tell you.

Try it without installing:

```bash
npx --allow-git=all github:dnviti/code-agents-webcli
```

On npm 12 the first run stops and asks permission to build `node-pty` and
`better-sqlite3`. npm blocks dependency install scripts by default, and for an npx run there is no
project file in which to pre-approve them — the root `package.json` is one npm generates itself.
Answering `y` approves and builds them in the npx cache; answering `n` prints the two commands to run
by hand. Either way it needs a C++ toolchain.

Install it properly (required if you want the background service):

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
npm rebuild -g --allow-scripts=node-pty,better-sqlite3
cc-web
```

The install compiles the package, so the first run takes a minute and needs a C++ toolchain for the
native dependencies (`python3`, `make`, `g++` on Linux).

The second command is what actually builds `node-pty` and `better-sqlite3`. npm 12 blocks dependency
install scripts, and the first command cannot approve them itself — see below. Skipping it leaves the
server unable to start; it will tell you so, and print that same command.

> **Use npm 11 or newer for the global install.** On npm 10 — the version bundled with Node 20 — a
> git install fails while preparing the checkout with `Cannot find module 'esbuild'`, because npm 10
> runs this package's `prepare` script before its dev dependencies are in place. `npm i -g npm@latest`
> first, or use `npx`, which is unaffected.

<details>
<summary>Why two commands, and why <code>--allow-git=all</code>?</summary>

npm 12 changed two defaults, and a GitHub install trips both.

**`allow-git` now defaults to `none`**, so npm refuses to fetch from a git remote at all. Set it once
instead of per command with `npm config set allow-git all`. On npm 11 and earlier this is unnecessary.

**Install scripts are blocked**, and `node-pty` and `better-sqlite3` are native modules that must be
compiled. This package permits them through the `allowScripts` field in its `package.json`, which
covers the build that happens while npm prepares the git checkout — but *not* the dependencies of the
install itself, which is why they arrive uncompiled.

`npm rebuild` alone does **not** fix that: it reports `rebuilt dependencies successfully` while
skipping every package whose scripts are blocked. The approval has to come first, and it is written
into the *root* `package.json` of wherever the install landed:

```bash
npm install-scripts approve node-pty better-sqlite3 --prefix <install root>
npm rebuild --prefix <install root>
```

The server prints those two lines, with the real directory filled in, if it ever hits this.

Do **not** try to solve this by adding `--allow-scripts` to the *install*: npm forwards it into the
project-scoped install it runs while preparing the git checkout, and that inner install rejects it
outright, so the whole install fails:

```
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

Putting `allow-scripts` in `.npmrc` fails the same way. The flag does work on `npm rebuild -g`, which
is why the install is two commands: the first cannot accept it, and the second requires it.

npm's own warning suggests `npm install -g --allow-scripts=… github:…` as a one-liner. That does not
work for a git spec, for exactly the reason above.

The two approval mechanisms are mirror images, and each is rejected in the other's context:

| Install | Approve with | Rejected |
| --- | --- | --- |
| global | `npm rebuild -g --allow-scripts=<pkgs>` | `npm install-scripts` → `EGLOBAL` |
| project-scoped, incl. `npx` | `npm install-scripts approve <pkgs>` then `npm rebuild` | `--allow-scripts` → `EALLOWSCRIPTS` |

`npm rebuild` without either is never enough: it reports `rebuilt dependencies successfully` while
skipping every blocked package.

</details>

On the first run — or any time you pass `--setup` — a wizard asks for:

1. the public base URL
2. the GitHub OAuth client ID
3. the GitHub OAuth client secret (not echoed as you type)
4. the allowed GitHub user IDs
5. the GitHub App token, if your internal setup needs one
6. whether to run in the foreground or install a background service

Those values are stored in the local SQLite database, never in the systemd unit or the command line.

> **The allow-list is not optional.** An empty list denies every sign-in. Anyone you list can sign in
> and run commands on the host, so list only the accounts you intend to give a shell to.

### Background service

Choosing the service option writes a `systemd --user` unit, enables it at boot and enables lingering
so it survives logout:

```bash
systemctl --user status code-agents-webcli.service
journalctl --user -u code-agents-webcli.service -f
```

The wizard asks for a working directory, which bounds the file browser in the web UI — only that
directory and its subdirectories are reachable.

The service option is unavailable when running through `npx`, because npx unpacks into a cache that
npm can delete at any time; a unit pointing there would break later. Use the global install for that.
It is also Linux/systemd-only; elsewhere the wizard offers foreground mode only.

## Scrollback and history

Long sessions used to bog the browser down: the terminal held a 20,000-line buffer, reflowed all of
it on every resize, and forced a full repaint per streamed chunk.

The live terminal now keeps only the recent tail. Everything older is rebuilt server-side and paged
in a screen at a time, so scrolling back is bounded by the size of your screen rather than by the
length of the session.

- The server runs a headless copy of the same terminal emulator the browser runs, and freezes each
  line as it scrolls off. Those lines go to an append-only log with a fixed-width index, so fetching
  "lines 812,340 to 812,390" is two positioned reads and costs the same whether the session is a
  minute or a week old.
- Scroll to the top of the live buffer (or keep scrolling up once you are there) to enter the
  history viewer. Scroll to the bottom, press Escape, or use **Back to live** to come back.
- Full-screen programs are not recorded: the alternate screen buffer is isolated, so a TUI redrawing
  itself does not fill your history with frames.
- **Download .md** in the history bar downloads the whole session as Markdown, ANSI stripped and
  streamed page by page. It is also available at `GET /api/sessions/<id>/export.md`.

History is per user and enforced on every request, the same as sessions themselves.

Known limits:

- History lines are wrapped at the width the PTY was rendering at. Viewing from a window of a
  different width shows the PTY's wrapping, not your own.
- Oldest lines are dropped past a per-session cap (200,000 lines by default). Line numbers stay
  absolute, and the viewer tells you how many were dropped.
- If a program emits more scrollback in a single burst than the emulator holds, the gap is recorded
  in the history rather than passed over silently.
- Text selection inside the history viewer is not supported yet; use the Markdown export to get
  content out.
- A scrollback emulator costs roughly 2 MB per session while a runtime is running. It is released
  when the process exits, the session is deleted, or the server shuts down.

## Updating

The app checks GitHub for newer commits and shows a banner when this build is behind.

Installs come from `github:dnviti/code-agents-webcli`, which resolves to whatever `main` HEAD is, so
the running build is identified by the commit it was built from rather than by the package version.
That commit is baked into `dist/build-info.json` during the build.

- Everyone signed in sees the banner. Only the **first account that ever signed in** — the installer
  — can apply the update, and that identity is pinned, so deleting that account does not promote
  anyone else.
- Applying it runs the install, then `npm rebuild`, then a check that the new build actually loads,
  and only restarts the service if all three succeed. If any step fails, nothing is restarted and the
  running version is untouched.
- **A restart ends every user's agent sessions**, not just the installer's. The confirmation names
  how many are running. Sessions, transcripts and history survive; in-flight conversations do not.
- GitHub is polled at most every 15 minutes however often anyone presses Check, because the
  unauthenticated API allows 60 requests an hour per IP. No credentials are ever sent.

Some installs cannot update themselves, and say so instead of offering a button that would do
nothing:

| Situation | Why, and what to do instead |
| --- | --- |
| Running via `npx` | The npx cache is temporary. The next `npx` run already fetches the latest commit; install globally to make it durable. |
| Running in a container | `docker pull` and recreate the container. |
| Running from a git clone | A global install would not replace the code that is running. Use `git pull && npm run build`. |
| Global prefix not writable | A `sudo npm i -g` install is root-owned while the service runs as you. Reinstall from a shell. |

Existing installs made before this release carry no commit identity and report that update checks are
unavailable until they are reinstalled once:

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
```

If an update is interrupted — a reboot, an OOM kill — the next start says so, and the same command is
the recovery.

Building the Docker image yourself? Pass the commit, or the image reports an unknown build:

```bash
docker build --build-arg BUILD_SHA="$(git rev-parse HEAD)" -t code-agents-webcli .
```

## Pasting images

Paste an image into a terminal, or drag one onto it, and it is written into the session's working
directory; the path is then typed into the prompt for the agent to read. On a phone, **Attach Image**
in the menu opens the picker.

Nothing is submitted for you: the path arrives followed by a single space, so you can say what you
want done with it before pressing Enter.

- Files land in `<working directory>/.cc-web/pasted/`. That location is deliberate — it is the only
  place all the agent CLIs read without a permission prompt, since Claude Code asks before reading
  outside its working directory and a sandboxed Codex can refuse outright.
- A `.gitignore` is written inside `.cc-web/` so the images never show up in `git status`. Your own
  `.gitignore` is never touched. If you edit the generated one, your version is kept.
- Images are deleted when the session is deleted.
- PNG, JPEG, GIF, WebP and BMP are accepted, decided by content rather than by the name or the type
  the browser claims. SVG is refused: it has no magic number and can carry script.
- The cap is 10 MB per image. Behind nginx, `client_max_body_size 10m;` is needed or the upload fails
  at the proxy.

Known limits:

- iPhone photo libraries hand over HEIC unless the browser converts it; HEIC is refused with a
  message saying so.
- Every session on the host runs as the same OS user, so a user who points a session at another
  user's working directory can read images pasted there. This is the same boundary the rest of the
  app has — anyone signed in can already open a shell — but it is worth stating.
- Text pasting is untouched: an event with no image in it is left entirely to the terminal.

## HTTPS and the local certificate

The server speaks HTTPS only. This is not about secrecy on a home network: a browser treats a
plain-http origin that is not `localhost` as an insecure context and withholds the service worker,
which means no installable app, no offline shell, no clipboard API and no notifications. Those
features all worked when tested at `http://localhost` and were silently missing for anyone opening
the same server at `http://192.168.x.x`, which is how it is normally reached.

On first start the server generates a certificate authority and a server certificate in
`~/.code-agents-webcli/tls/`, covering `localhost`, this machine's hostname, `<hostname>.local` and
every non-internal IP address it answers on. It reissues automatically when the certificate is
close to expiry or when the machine's addresses change — a laptop moving between networks gets a
new certificate rather than a confusing TLS error. The CA itself is reused, so devices do not have
to be re-trusted.

Because the CA is local, each device has to trust it once. Download it from `/ca.crt` — that route
is deliberately reachable without signing in, since a device that does not trust the certificate
cannot get as far as the login page:

```bash
# Linux, Chrome/Chromium (no root needed)
curl -k https://<host>:32352/ca.crt -o ca.crt
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Code Agents Web CLI local CA" -i ca.crt

# Linux, system-wide
sudo cp ca.crt /etc/pki/ca-trust/source/anchors/   # Fedora/RHEL
sudo update-ca-trust
```

On iOS, open `https://<host>:32352/ca.crt` in Safari, install the downloaded profile, then enable it
under Settings → General → About → Certificate Trust Settings. On Android, install it under
Settings → Security → Encryption & credentials → Install a certificate → CA certificate.

To use a real certificate instead, pass `--cert` and `--key`; nothing is generated in that case.

Plain http requests to the port are answered with a 308 redirect to the https URL, so existing
bookmarks keep working. No content is served over http.

## GitHub OAuth Setup

Create a GitHub OAuth App and set the callback URL to:

```text
https://your-host.example.com/auth/github/callback
```

For local development, this can be:

```text
https://localhost:32352/auth/github/callback
```

The scheme is `https` even locally: the server does not serve content over plain http.

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

# HTTPS is always on. To use your own certificate instead of the generated one:
code-agents-webcli --cert /path/to/cert.pem --key /path/to/key.pem

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
| `-p, --port <number>` | HTTPS port | `32352` |
| `--no-open` | Do not auto-open the browser | `false` |
| `--https` | Accepted and ignored; HTTPS is always on | n/a |
| `--cert <path>` | TLS certificate to use instead of the generated one | generated |
| `--key <path>` | Private key for `--cert` | generated |
| `--setup` | Force the interactive setup wizard | `false` |
| `--public-base-url <url>` | Public base URL for OAuth callbacks | `https://localhost:<port>` |
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
| `--pi-alias <name>` | UI label for pi | `Pi` |
| `--grok-alias <name>` | UI label for Grok Build | `Grok` |
| `--qwen-alias <name>` | UI label for Qwen Code | `Qwen` |
| `--kimi-alias <name>` | UI label for Kimi Code | `Kimi` |
| `--ngrok-auth-token <token>` | Enable ngrok tunneling | none |
| `--ngrok-domain <domain>` | Reserved ngrok domain | none |

## Docker

Images are published to GHCR on every release, tagged `latest`, `<version>` and `v<version>`:

```bash
docker pull ghcr.io/dnviti/code-agents-webcli:latest
```

Run it:

```bash
docker run -d --name code-agents-webcli \
  -p 32352:32352 \
  -v code-agents-webcli-data:/home/appuser/.code-agents-webcli \
  -e GITHUB_OAUTH_CLIENT_ID=YOUR_CLIENT_ID \
  -e GITHUB_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  -e GITHUB_ALLOWED_USER_IDS=YOUR_NUMERIC_ID \
  -e PUBLIC_BASE_URL=http://localhost:32352 \
  ghcr.io/dnviti/code-agents-webcli:latest
```

All four environment variables are needed:

| Variable | Why |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | Without them the server exits at startup. |
| `GITHUB_ALLOWED_USER_IDS` | Without it every sign-in is refused. |
| `PUBLIC_BASE_URL` | The OAuth callback is built from it; a wrong value means sign-in returns to the wrong host. |

They are not optional the way they are for a local install, because the setup wizard needs a terminal
to ask its questions. A detached container has none — nor does one started by Compose or Kubernetes —
so the configuration has to arrive as environment variables instead. (Running with `-it` *does* give
the wizard a TTY, so it can be completed interactively once, but only if the volume below is in place
to keep the answers.)

The volume matters just as much: the SQLite database holds your users, sessions and settings, and
without it they are gone the moment the container is replaced.

Build it yourself instead, passing the commit so the image can report its own version:

```bash
docker build \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_DATE="$(git show -s --format=%cI HEAD)" \
  -t code-agents-webcli .
```

Without those build args the image still runs, but reports an unknown build and cannot check for
updates — `.dockerignore` excludes `.git`, so the build cannot read the commit on its own.

Important:

- the image contains the web server only
- the agent CLIs (`claude`, `codex`, `cursor-agent`, `pi`, `grok`, `qwen`, `kimi`) are **not**
  bundled; only terminal
  sessions work out of the box
- to use the assistants in Docker, derive an image and install those CLIs in it
- the folder browser is bounded by the container's working directory (`/app`), so mount your projects
  and point sessions at them
- the update banner reports "running in a container" and offers no update button, by design: a
  self-install would write into a layer that the next `docker pull` discards

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
- `.github/workflows/release-on-main.yml`: tag `v<version>`, cut a GitHub release, and push the GHCR
  container image from `main`

A release fires when `package.json`'s version changes and no matching tag exists yet. This project is
not published to npm — it is distributed from git and as a container image — so the workflow needs no
npm account or token. Pushing to GHCR uses the `GITHUB_TOKEN` that Actions provides automatically,
so there is nothing to configure for a release to work.

## What You Still Need To Configure

The app cannot serve sign-ins until you complete these external steps:

1. Create the GitHub OAuth App and set the callback URL for your deployment.
2. If you plan to run the Docker image in production, make sure the required assistant CLIs are installed in the runtime environment or a derived image.

## Repository

- GitHub: `https://github.com/dnviti/code-agents-webcli`
- Container image: `ghcr.io/dnviti/code-agents-webcli`

