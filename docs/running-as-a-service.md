# Running as a service

Keeping the server up: systemd, Docker, reverse proxies and tunnels.

## systemd (Linux)

The [first-run wizard](configuration.md#first-run-setup) offers to install a
`systemd --user` unit. Choosing it writes the unit, enables it at boot, and
enables lingering so it survives logout.

```bash
systemctl --user status code-agents-webcli.service
systemctl --user restart code-agents-webcli.service
journalctl --user -u code-agents-webcli.service -f
```

Re-run the wizard at any time with `cc-web --setup`.

Two limits worth knowing:

- **Not available under `npx`.** npx unpacks into a cache npm can delete at any
  time, and a unit pointing into it would break later.
  [Install globally](installation.md#install-it) first.
- **Linux only.** Elsewhere the wizard offers foreground mode only.

The wizard also asks for a working directory. That bounds the file browser in the
web UI — only that directory and its subdirectories are reachable.

### Removing it

```bash
systemctl --user disable --now code-agents-webcli.service
rm ~/.config/systemd/user/code-agents-webcli.service
systemctl --user daemon-reload
```

## Docker

```bash
docker pull ghcr.io/dnviti/code-agents-webcli:latest
```

```bash
docker run -d --name code-agents-webcli \
  -p 32352:32352 \
  -v code-agents-webcli-data:/home/appuser/.code-agents-webcli \
  -e GITHUB_OAUTH_CLIENT_ID=YOUR_CLIENT_ID \
  -e GITHUB_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  -e GITHUB_ALLOWED_USER_IDS=YOUR_NUMERIC_ID \
  -e PUBLIC_BASE_URL=https://agents.example.com \
  ghcr.io/dnviti/code-agents-webcli:latest
```

Images are tagged `latest`, `<version>` and `v<version>`.

### All four variables are required

Unlike a local install, a container cannot fall back on the setup wizard — the
wizard needs a terminal to ask its questions, and a detached container has none
(nor does one started by Compose or Kubernetes).

| Variable | Why |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | Without them the server exits at startup. |
| `GITHUB_ALLOWED_USER_IDS` | Without it every sign-in is refused. |
| `PUBLIC_BASE_URL` | The OAuth callback is built from it; a wrong value returns sign-in to the wrong host. |

Running with `-it` *does* give the wizard a TTY, so you can complete it
interactively once — but only if the volume below is in place to keep the
answers.

### The volume is not optional either

The SQLite database holds your users, sessions and settings. Without a volume
they are gone the moment the container is replaced.

### What the image does and does not contain

- It contains **the web server only**.
- The agent CLIs (`claude`, `codex`, `cursor-agent`, `pi`, `grok`, `qwen`,
  `kimi`, `omp`) are **not bundled**, so only terminal sessions work out of the
  box. To use the agents, derive an image and install the CLIs into it.
- The folder browser is bounded by the container's working directory (`/app`), so
  mount your projects and point sessions at them.
- The update banner reports "running in a container" and offers no update button,
  [by design](updating.md#installs-that-cannot-update-themselves).

### Compose

```yaml
services:
  code-agents-webcli:
    image: ghcr.io/dnviti/code-agents-webcli:latest
    restart: unless-stopped
    ports:
      - "32352:32352"
    volumes:
      - data:/home/appuser/.code-agents-webcli
      - /srv/projects:/srv/projects
    environment:
      GITHUB_OAUTH_CLIENT_ID: ${GITHUB_OAUTH_CLIENT_ID}
      GITHUB_OAUTH_CLIENT_SECRET: ${GITHUB_OAUTH_CLIENT_SECRET}
      GITHUB_ALLOWED_USER_IDS: ${GITHUB_ALLOWED_USER_IDS}
      PUBLIC_BASE_URL: https://agents.example.com

volumes:
  data:
```

## Behind a reverse proxy

The app serves HTTPS itself and does not have an http mode, so the proxy has to
speak https upstream.

- Set `PUBLIC_BASE_URL` (or `--public-base-url`) to the **public** URL, and make
  the [OAuth callback](github-oauth.md) match it.
- The proxy must forward **WebSocket upgrades**, or terminals will connect and
  then hang.
- Set `client_max_body_size 10m;` on nginx, or
  [image pasting](terminal.md#pasting-images) fails at the proxy rather than in
  the app.
- The upstream certificate is self-signed unless you gave the app
  [your own](https-and-certificates.md#using-your-own-certificate); nginx needs
  `proxy_ssl_verify off;` in that case.

## ngrok

For a public URL without a reverse proxy. Both flags are required together —
passing one without the other is an error:

```bash
cc-web \
  --ngrok-auth-token "$NGROK_AUTHTOKEN" \
  --ngrok-domain agents.ngrok.app
```

Set your [OAuth callback](github-oauth.md) to the ngrok domain, which is why the
domain has to be a reserved one rather than an ephemeral URL that changes every
restart.
