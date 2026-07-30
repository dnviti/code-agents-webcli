# Code Agents Web CLI

Run Claude Code, Codex, Cursor Agent, pi, Grok, Qwen, Kimi, Oh My Pi,
Antigravity CLI and plain shells from a browser — on your phone, on a tablet,
from another machine on your network. One Node process, GitHub sign-in, real
terminals, sessions that survive a reload.

```bash
npx --allow-git=all github:dnviti/code-agents-webcli
```

That is the whole install. Nothing compiles, nothing needs a C++ toolchain, and
there is no second command.

---

## What it does

- **Real terminals, not a chat box.** Full pseudo-terminals over WebSocket with
  xterm.js — TUIs, colours, Ctrl-C, the lot.
- **Whatever agent you already use.** Eight agent CLIs plus plain shell sessions.
  Each is optional; the app only ever runs what is on the host's `PATH`.
- **Multi-user, properly isolated.** GitHub OAuth, an explicit allow-list, and
  sessions keyed to the account that made them.
- **Sessions that outlive the tab.** Reload, switch devices, come back tomorrow —
  the session is still there, with its scrollback.
- **Scrollback that does not melt the browser.** The recent tail stays live;
  everything older is paged in from the server a screen at a time, and exports as
  Markdown.
- **Built for the phone it will actually be used on.** On-screen terminal keys,
  touch scrolling, a tab sheet, and an installable PWA.
- **Paste an image into the prompt.** It lands in the working directory and the
  path is typed for you.
- **Per-runtime launch profiles.** Model, extra arguments, environment and
  capability tiers, configured in the UI.
- **HTTPS everywhere**, with a certificate authority the server generates itself
  so LAN devices get a secure context.

## Before you start

You need two things:

1. **Node 22.13 or newer** — `node --version`.
2. **A GitHub OAuth App** — sign-in is GitHub-only, so the app cannot serve a
   login page without one. It takes a minute:
   [how to create it](docs/github-oauth.md).

## Getting started

Run it without installing anything permanent:

```bash
npx --allow-git=all github:dnviti/code-agents-webcli
```

Or install it properly — needed for the background service and self-update:

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
cc-web
```

Either way, the first start asks for your public URL, your OAuth credentials and
which GitHub accounts may sign in, then opens
`https://localhost:32352`. To reach it from another device on your network, use
`https://<this-host>:32352` and install the local CA once from `/ca.crt`.

> `--allow-git=all` is required on npm 12 and ignored by older npm, so the same
> command works everywhere. Set it once with `npm config set allow-git all` if
> you would rather not type it.

Full detail: **[Installation](docs/installation.md)**.

## Docker

```bash
docker run -d --name code-agents-webcli \
  -p 32352:32352 \
  -v code-agents-webcli-data:/home/appuser/.code-agents-webcli \
  -e GITHUB_OAUTH_CLIENT_ID=... \
  -e GITHUB_OAUTH_CLIENT_SECRET=... \
  -e GITHUB_ALLOWED_USER_IDS=... \
  -e PUBLIC_BASE_URL=https://agents.example.com \
  ghcr.io/dnviti/code-agents-webcli:latest
```

The image ships the web server only — the agent CLIs are not bundled. See
[Running as a service](docs/running-as-a-service.md#docker).

## Documentation

| Guide | What is in it |
| --- | --- |
| [Installation](docs/installation.md) | Every install path, platform support, uninstalling, install troubleshooting |
| [GitHub OAuth](docs/github-oauth.md) | Creating the OAuth App, the allow-list, the installer account |
| [Configuration](docs/configuration.md) | Every CLI flag and environment variable, the setup wizard, where state is stored |
| [Runtimes and profiles](docs/runtimes.md) | The supported agent CLIs, launch profiles, models, capability tiers |
| [Using the terminal](docs/terminal.md) | Scrollback and history, copy/paste, images, mobile, the PWA |
| [HTTPS and certificates](docs/https-and-certificates.md) | Why HTTPS-only, the local CA, trusting it per device, using your own certificate |
| [Running as a service](docs/running-as-a-service.md) | systemd, Docker and Compose, reverse proxies, ngrok |
| [Per-user environments](docs/user-environments.md) | Giving every signed-in user their own container, with persistent storage |
| [Updating](docs/updating.md) | The update banner, who may apply it, which installs can and cannot |
| [Usage analytics](docs/analytics.md) | What the usage screens read and how the numbers are derived |
| [Usage accounting](docs/usage-accounting.md) | The durable per-user job history and dashboard: what is recorded, per-agent honesty, the API |
| [Architecture](docs/architecture.md) | How the pieces fit together |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, causes, fixes |

## Security

Anyone you add to the allow-list can open a shell on the host as the user
running the server. That is the point of the app, and it is also the whole
security model — list only accounts you would give SSH to. The allow-list is not
optional: an empty one denies every sign-in. See
[GitHub OAuth](docs/github-oauth.md#the-allow-list).

## Development

```bash
git clone https://github.com/dnviti/code-agents-webcli.git
cd code-agents-webcli
npm install
npm run dev
```

```bash
npm test              # unit tests
npm run typecheck     # server + client
npm run verify:install # install the working tree into a clean prefix and start it
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/architecture.md](docs/architecture.md).

## Links

- Source: <https://github.com/dnviti/code-agents-webcli>
- Container image: `ghcr.io/dnviti/code-agents-webcli`
- Licence: [MIT](LICENSE)
