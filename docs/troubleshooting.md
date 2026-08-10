# Troubleshooting

Symptom first, then the fix.

## Installing

**`npm error code EALLOWGIT`, or "Fetching packages of type git have been
disabled".**
npm 12 refuses git remotes unless told otherwise. Add `--allow-git=all`, or set
it once with `npm config set allow-git all`.

**"code-agents-webcli needs Node 24.16 or newer".**
The app uses Node's built-in SQLite serialization APIs to store workspace
databases safely on every supported host. Upgrade Node. The check is deliberate
— without it the first symptom would be a SQLite serialization failure from
deep inside the server.

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

**The server reports `data_dir_in_use`.**
Another process owns the same `--data-dir`, or a crashed process's private lease
has not yet met both recovery checks. Stop the other foreground/service or wait
for its stale-heartbeat window. If an incomplete ownerless lease remains, first
prove that no `cc-web` process uses that data directory and that no update or
migration is running; only then remove `.cc-web-server.lease` and
`.cc-web-server.lease.guard` manually. Never remove a live lease merely to make
the error disappear.

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

**The agent version row says "Unable to check".**
The publisher check is deliberately short (five seconds) and is nonblocking.
Check the network and the publisher's official installer page, then use
**Retry**. The app keeps a successful check for up to 24 hours; Retry asks again
without waiting for that cache to expire.

**Install is unavailable, or the row names a platform/architecture.**
The automatic managed installer only runs on publisher-supported targets. See
the exact WSL, Bash, Git for Windows, Windows arm64, and Alpine guidance in
[platform and prerequisite guidance](runtimes.md#platform-and-prerequisite-guidance).
The app will not provision WSL, Git Bash, Git for Windows, or system libraries.

**The row says "External copy" and there is no update button.**
That executable belongs to your existing package-manager or manual installation.
CODE AGENTS will not modify it. Use that installer's update mechanism, or choose
**Install managed copy** to create a separate app-owned copy.

**The row says "Project managed".**
The runtime is pinned by the project's reviewed build recipe. Rebuild the
project to update it; the agent-maintenance control does not alter a project
environment.

**An agent update finished but the old version is still running.**
Use the version row above that terminal or conversation. An idle resumable WebUI
conversation can restart safely; a busy/non-resumable conversation and every
terminal require confirmation. A terminal keeps its tab, directory, and
scrollback, but its agent interaction may not resume.

**Dragging does not select text.**
Agents enable mouse tracking, so the drag goes to the program. **Hold Shift**
while dragging. See [copy and paste](terminal.md#copy-and-paste).

**Pasting an image fails behind nginx.**
`client_max_body_size 10m;`. The cap is 10 MB per image and the proxy rejects it
before the app sees it.

**A chat attachment fails, or stops near 1 MiB/16 MiB in the desktop app.**
Current desktop uploads are streamed end to end and accept a non-empty file up
to 20 MiB, subject to the session's 400 MiB and 500-file attachment quota. If a
proxy fronts the selected server, set its body limit to at least 20 MiB and
allow chunked request bodies. Read the failed chip: it distinguishes file size,
session quota, unsafe/read-only workspace, sign-in, cross-origin, disk-full, and
target-server errors. Remove the failed chip and attach again; the failed upload
is never included in the turn. See [desktop
attachments](desktop.md#attach-files-and-images).

**Attach does nothing, or drag/paste works in a browser but not in Flatpak.**
The desktop keeps Electron's sandbox and does not grant general filesystem or
programmatic clipboard access. Use the user-initiated **Attach** picker, focus
the composer before pasting an image, and verify the Flatpak portal permits the
folder. If host agent files or folders remain outside the sandbox, use the
AppImage. Text-only clipboard content is intentionally treated as text.

**An HEIC photo from an iPhone is refused.**
Deliberately — convert it, or set the phone's camera to "Most Compatible".

**Terminals connect and then hang behind a proxy.**
The proxy is not forwarding WebSocket upgrades. See
[reverse proxies](running-as-a-service.md#behind-a-reverse-proxy).

## Opening desktop Local computer on a phone

**The LAN QR does not open.**
Phone access must be running, the phone must be on a network that can reach the
selected Ethernet/Wi-Fi address, and the chosen port must pass the desktop
firewall. Guest Wi-Fi often isolates clients. If the interface address changed,
stop access and restart it on the current address; do not keep using the stale
QR. LAN mode intentionally omits globally routable interface addresses; use
private Tailscale Serve for access away from a private LAN.

**The phone still shows a certificate warning.**
Install and fully trust the dedicated desktop phone-access CA, then compare its
SHA-256 fingerprint with the trusted desktop dialog. iOS requires the separate
Certificate Trust Settings step. Completely close and reopen the browser after
changing trust. See [certificate trust and removal](phone-access.md#trusting-or-removing-the-lan-certificate).

**The port is already in use.**
Choose another unprivileged port in **Open on phone**. Use that exact port in the
displayed `tailscale serve` command too. A failed start leaves phone sharing off
instead of starting only one listener.

**Tailscale Serve cannot be reached from mobile data.**
Leave the displayed Serve command running in the foreground. Confirm both
devices are connected to the same tailnet (or explicitly shared), the phone
accepted its VPN permission, the desktop is awake, Shields Up is not blocking
inbound access, and the tailnet access policy permits the phone. Select **Check
setup** again after any change, then confirm the checked address. The app will
not publish the route unless a fresh inspection finds the exact root proxy and
port with Funnel off. Funnel is public and is not a workaround for this feature.

**An installed PWA keeps opening an old address.**
LAN IP and `ts.net` addresses are separate browser origins. Open the current
exact link, pair that origin, and install it again; cookies, service workers and
storage cannot migrate to a new origin.

**A file opens in the plainer editor, with "the full editor could not be
loaded".**
The code editor is a separate chunk fetched the first time you open a file, and
either its script or its stylesheet did not arrive — a restart under an open
page, or a moment with no route to the server. Opening a file again fetches it
again. The editor you get meanwhile is the app's own: it highlights, edits and
saves, it is simply plainer. It is offered deliberately in preference to the
full editor without its stylesheet, which would draw the file in the wrong
order rather than say anything was wrong.
**A turn is marked failed and the work looks fine.**
The badge says how the turn *ended*, not whether anything inside it went wrong.
A search with no matches, a test run that reported failures or a command that
came back non-zero leaves the turn marked done, and the step itself stays marked
failed where the step is shown. Red means the turn did not finish: the agent
stopped on an error it could not get past, the runtime went away mid-turn, or it
ended with no answer. A turn you interrupted yourself reads as done.

**A typed-ahead message says "Not sent".**
It is still there, with its text, on the row above the composer — press **Try
again**, or the ✕ to discard it. The rest of the line waits behind it on
purpose: those messages were typed expecting this one to have been asked first.
Messages are only ever taken out of the queue once the agent has really been
handed them, so a message shown in the conversation was genuinely sent.

**A session came back "ended" after a restart.**
Expected. The record, history and transcript persist; the live process does not.

**Conversations are missing after moving or restoring a workspace.**
Session history now belongs to that workspace's `.cc-web/`, not to
`--data-dir`. Open the authorised workspace root so the server can lazy-load
`session-state.sqlite`; do not point it at the filesystem root or through a
symlink. A restore must include the complete `.cc-web` tree and, for a live
Linux SQLite snapshot, its `-wal` and `-shm` files. Windows and macOS atomically
publish a complete database image and create no sidecars. See [backing up
and restoring](configuration.md#backing-up-and-restoring).

If the workspace was copied to a different root, or restored without the
installation data directory that authenticated it, the history is retained but
the server treats its operational state as unrecognised. Reopen the real
workspace and choose the runtime/approval settings again; native resume IDs and
archived project paths are deliberately not trusted across that boundary.

**The API reports `workspace_persistence_unavailable` on Windows or macOS.**
Workspace-local storage is supported on Windows and macOS through the app's verified-cwd
helper. Check that the workspace is a local, canonical directory without
symlinked `.cc-web` components, that the current user can write it, and that no
other web or desktop process owns its `.session-state.writer` lease. A packaged
app must also retain its complete `app.asar`; moving individual JavaScript files
out of the application bundle breaks the helper and is unsupported.

An unclean shutdown is reclaimed automatically only when the app can prove the
recorded process incarnation is gone on this machine. A workspace copied from
another host deliberately keeps an unprovable writer record fail-closed. If the
copy is private and the source machine cannot access it, close every app using
the copy and remove only `.cc-web/.session-state.writer*`; never do this to a
shared or network-mounted workspace.

Windows has no `openat` namespace either. The helper verifies the exact working
directory before each relative mutation, while Win32 prevents that process cwd
from being renamed or removed. Providers which cannot preserve those semantics
fail closed; keep the workspace on a local filesystem. `GET
/api/sessions/persistence` reports which roots are loaded and unavailable.

**The API reports `workspace_persistence_unavailable`, or migration is
incomplete.**
The destination is missing, read-only, unsafe, or conflicts with an existing
archive. The legacy copy is deliberately retained and the server will not fall
back to writing new history under the data directory. Fix ownership and free
space, restore the real non-symlink workspace path, and open it again or restart
the server. Until then the conversation remains visible but read-only, and
mutating actions return a conflict carrying the same persistence reason.
`GET /api/sessions/persistence` lists unavailable roots and their errors. Do not
delete the legacy files until the endpoint reports migration complete.

If the error says that the root is already assigned to another account, do not
copy or merge the two `.cc-web` trees. The canonical root may belong to only one
immutable GitHub identity because it contains plaintext history. Correct the
folder selection (or the stale path-only catalog entry) and retry; ambiguous
legacy assignments remain quarantined rather than choosing an owner silently.

If the error contains `UNSAFE_WORKSPACE_STORAGE`, the current filesystem could
not prove race-safe directory/file binding. Remove symlinks and check ownership
first. On network or FUSE filesystems, or unusual Windows volumes, move the
workspace to a local filesystem that supports the required cwd/descriptor semantics.
The server intentionally has no global-data fallback.

**A managed project reports that its session archive is crash-staged.**
Do not rename, copy or delete the deterministic
`.<project-id>.ccweb-session-storage-retained` sibling. It is the authoritative
`.cc-web` inode left outside the container-writable project root by an
interrupted rebuild/reclaim. Restore access to the deploy target and enable the
project-environment lifecycle so startup can reconcile and quiesce the old
runtime before restoring it. A conflict at the canonical `.cc-web` name, an
unsafe staging slot, or an unquiesced runtime deliberately keeps the project
unavailable rather than choosing an archive or creating an empty database.

## Updating

**I expected the CODE AGENTS update banner to update an agent CLI.**
They are different operations. The banner updates the web application and may
restart the service. The runtime version row updates only a managed agent copy;
see [runtimes](runtimes.md#installing-and-updating-an-agent).

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
