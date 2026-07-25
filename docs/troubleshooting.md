# Troubleshooting

Symptom first, then the fix.

## Installing

**`npm error code EALLOWGIT`, or "Fetching packages of type git have been
disabled".**
npm 12 refuses git remotes unless told otherwise. Add `--allow-git=all`, or set
it once with `npm config set allow-git all`.

**"code-agents-webcli needs Node 22.13 or newer".**
The app stores everything in Node's built-in SQLite, which is only available
without a flag from 22.13. Upgrade Node. The check is deliberate — without it
the first symptom would be `Cannot find module 'node:sqlite'` from deep inside
the server.

**"The @lydell/node-pty package could not find the platform-specific package".**
Either your platform has no prebuilt terminal binary, or the install ran with
`--omit=optional`, which skips it. See
[unsupported platforms](installation.md#unsupported-platforms).

**It worked, then a `node_modules` copy broke it.**
The terminal binding is a platform-specific binary. Copying `node_modules`
between machines — or between a host and a container, or WSL and Windows —
carries the wrong one. Install with npm on the target instead.

**The install seems to hang for a minute.**
A git install builds the bundle. That is the one slow part and it happens once.

## Starting

**"HTTPS needs the `openssl` command … and it was not found".**
Install openssl (`dnf install openssl` / `apt install openssl`), or bring
[your own certificate](https-and-certificates.md#using-your-own-certificate).

**The server exits complaining about OAuth credentials.**
It cannot serve a login page without them, and it could not ask because there is
no terminal attached — a detached container, a systemd unit, a CI job. Supply
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`, or run it once
interactively with `--setup`.

**"Cannot start … because the compiled server bundle is missing".**
You are in a checkout that has not been built. `npm run build`.

**Port already in use.**
Usually the background service is already running and you started a second copy
by hand: `systemctl --user status code-agents-webcli.service`.

## Signing in

**Every sign-in is refused.**
The allow-list is empty, or your numeric ID is not in it. Note it is the
**numeric** id, not the login:

```bash
curl -s https://api.github.com/users/<your-login> | grep '"id"'
```

**GitHub returns a redirect_uri error, or sign-in lands on the wrong host.**
The OAuth App's callback URL and the app's public base URL disagree. They must
match exactly, including scheme and port, with `/auth/github/callback` appended.
See [GitHub OAuth](github-oauth.md#create-the-oauth-app).

**Signed in, but the update and profile screens are read-only.**
Those are limited to the
[installer account](github-oauth.md#the-installer-account) — the first account
that ever signed in.

## Certificates and the browser

**"Your connection is not private" / `ERR_CERT_AUTHORITY_INVALID`.**
This device has not trusted the local CA yet.
[Trust it once](https-and-certificates.md#trusting-the-ca-once-per-device).

**On iOS the profile is installed but it still warns.**
Installing is only half of it — enable it under **Settings → General → About →
Certificate Trust Settings**.

**The app will not install as a PWA, and the clipboard does not work.**
Both need a secure context. Either the origin is plain http, or the certificate
is untrusted so the service worker never became ready.

## Using it

**A runtime button fails with "not found".**
That CLI is not installed, or not where the app looks. See
[the search paths](runtimes.md#supported-runtimes). Under a `systemd --user`
unit, note that `~/.local/bin` is often missing from `PATH` — the app searches it
directly for that reason.

**Dragging does not select text.**
Agents enable mouse tracking, so the drag goes to the program. **Hold Shift**
while dragging. See [copy and paste](terminal.md#copy-and-paste).

**Pasting an image fails behind nginx.**
`client_max_body_size 10m;`. The cap is 10 MB per image and the proxy rejects it
before the app sees it.

**An HEIC photo from an iPhone is refused.**
Deliberately — convert it, or set the phone's camera to "Most Compatible".

**Terminals connect and then hang behind a proxy.**
The proxy is not forwarding WebSocket upgrades. See
[reverse proxies](running-as-a-service.md#behind-a-reverse-proxy).

**A session came back "ended" after a restart.**
Expected. The record, history and transcript persist; the live process does not.

## Updating

**No update button.**
Either you are not the installer, or this install
[cannot update itself](updating.md#installs-that-cannot-update-themselves) —
npx, a container, a git clone, or a root-owned global prefix. The banner says
which.

**"A previous update did not finish".**
Reinstall:

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
```

**The update check says the build is unknown.**
The build carries no commit — usually a container built without `BUILD_SHA`. See
[building the image yourself](updating.md#building-the-docker-image-yourself).

## Still stuck

Run the install verification and include its output in a bug report; it exercises
the whole path on a clean prefix:

```bash
npm run verify:install
```

Then open an issue at
<https://github.com/dnviti/code-agents-webcli/issues>.
