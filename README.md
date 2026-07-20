# Code Agents Web CLI

`code-agents-webcli` is a single Node.js web application for running Claude Code, Codex, Cursor
Agent, pi, Grok Build, and classic terminal sessions from the browser.

It now supports:

- GitHub OAuth authentication
- multi-user session isolation keyed by GitHub user IDs
- SQLite-backed persistence for users, auth sessions, working directories, and runtime sessions
- xterm.js-based terminals
- Docker image builds and GitHub Actions release automation

## Requirements

- Node.js `>= 20`
- The agent CLIs you intend to use on the server host `PATH`: `claude`, `codex`, `cursor-agent`,
  `pi`, `grok`. Each is optional — a missing one only fails when you press its button.
- A GitHub OAuth App for sign-in
- A modern browser with WebSocket support

## Quick Start

This package is not published to npm; it installs straight from GitHub.

Before you start, create a [GitHub OAuth App](https://github.com/settings/developers) and set its
callback URL to `<your base URL>/auth/github/callback` — for a local install that is
`http://localhost:32352/auth/github/callback`. You will also want your own GitHub numeric user ID,
which `curl -s https://api.github.com/users/<your-login> | grep '"id"'` will tell you.

Try it without installing:

```bash
npx --allow-git=all github:dnviti/code-agents-webcli
```

Install it properly (required if you want the background service):

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
npm rebuild --prefix "$(npm root -g)/code-agents-webcli"
cc-web
```

The install compiles the package, so the first run takes a minute and needs a C++ toolchain for the
native dependencies (`python3`, `make`, `g++` on Linux).

<details>
<summary>Why two commands, and why <code>--allow-git=all</code>?</summary>

npm 12 changed two defaults, and a GitHub install trips both.

**`allow-git` now defaults to `none`**, so npm refuses to fetch from a git remote at all. Set it once
instead of per command with `npm config set allow-git all`. On npm 11 and earlier this is unnecessary.

**Install scripts are blocked**, and `node-pty` and `better-sqlite3` are native modules that must be
compiled. This package permits them through the `allowScripts` field in its `package.json`, which
covers the build that happens while npm prepares the git checkout — but *not* the dependencies of the
global install itself, which is why they arrive uncompiled and `npm rebuild` is needed afterwards.

Do **not** try to solve this by adding `--allow-scripts`: npm forwards it into the project-scoped
install it runs while preparing the git checkout, and that inner install rejects it outright, so the
whole install fails:

```
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

Putting `allow-scripts` in `.npmrc` fails the same way.

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
npm rebuild --prefix "$(npm root -g)/code-agents-webcli"
```

If an update is interrupted — a reboot, an OOM kill — the next start says so. The same two commands
are the recovery.

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
| `--pi-alias <name>` | UI label for pi | `Pi` |
| `--grok-alias <name>` | UI label for Grok Build | `Grok` |
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

