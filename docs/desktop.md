# Desktop app

The desktop download is a self-contained CODE AGENTS controller for this
computer and the remote CODE AGENTS servers you choose to save. It always keeps
a permanent **Local computer** entry, starts that local server itself, and opens
one native window. You do **not** need a terminal, Node.js, a separately running
server, or a GitHub OAuth App just to use Local computer.

The bundled local server listens only on `127.0.0.1`, so it is available to the
desktop controller on this computer and never to your LAN. Existing desktop
installations continue to use their existing local sessions, settings, and data;
there is no migration choice when upgrading. If the local server cannot start,
the controller still opens, explains why **Local computer** is unavailable, and
keeps saved remote servers and server management usable.

On the first controller launch, the desktop also makes a one-time, bounded
attempt to carry the previous renderer's appearance and chat-display choices
from its old random loopback origin to the new permanent controller origin. It
copies only validated terminal appearance, notification, theme, chat-view,
chat-effort, split-ratio, and selection-hint values; fills only choices that are
still absent; and never copies credentials, permission grants, session
assignments, transcripts, or arbitrary browser storage. The existing
`userData/server` directory remains in place regardless. This bounded bridge is
best-effort because Chromium may have compacted the old origin store into an
unrecognisable representation; verify the visible preferences as part of an
installed-package upgrade test.

The first launch creates a local keyboard user for this installation. That is a
local identity rather than GitHub sign-in. It does not include any coding agent
or its credentials: install the agents you want to use and sign in to them with
your own accounts. The desktop app finds commands on your normal login-shell
`PATH`; restart it after installing an agent if it is not listed.

## Download and install

Get the package for your operating system and CPU from the project's GitHub
release, then compare it with `SHA256SUMS` before opening it. Every current
desktop package is unsigned, so Windows SmartScreen and macOS Gatekeeper will
show a warning. Only override that warning after checking that you downloaded
the intended release and its checksum.

Maintainers publish these packages by pushing a version tag such as `v6.1.0`
from `main`. The tag must match the version in `package.json`; GitHub Actions
then verifies the source, builds each package on its native operating system,
runs the packaged smoke checks, and attaches all five installers plus
`SHA256SUMS` to the GitHub Release for that exact tag. Rerunning the same tagged
workflow repairs or replaces its assets without creating a different release.

| Your computer | Download | Install or run |
| --- | --- | --- |
| Linux x64 | `*.AppImage` | Make it executable (`chmod +x <file>.AppImage`) and open it. No installation is needed. If it will not start, install FUSE/FUSE2 for your distribution or run it with `--appimage-extract-and-run`. |
| Linux x64 | `*.flatpak` | Run `flatpak install --user <file>.flatpak`, then start **Code Agents Web CLI** from your applications menu. |
| Windows x64 | `*.exe` | Open the NSIS installer and follow its prompts. SmartScreen may require **More info** then **Run anyway** after you have verified the checksum. |
| macOS Intel | `*-x64.dmg` | Open the DMG and drag the app to Applications. |
| macOS Apple Silicon | `*-arm64.dmg` | Open the DMG and drag the app to Applications. Gatekeeper may require opening it from Finder after verification. |

The Flatpak bundle is a single-file package, not a Flathub repository install.
Flatpak's sandbox can prevent it from seeing agent executables, credentials, or
working folders outside the locations it has been allowed to access. If that
gets in the way of an agent you already use on the host, use the AppImage
instead: it is portable and does not add Flatpak sandboxing.

## Local and remote servers

The server strip identifies the currently selected server and its connection,
authentication, compatibility, and certificate state. Open **Settings →
Servers** to see the complete catalog, search it, add a remote server, retry a
connection, sign in or out, or edit a saved entry. **Local computer** is
permanent and cannot be renamed, signed out, or removed. There is no fixed
product limit on remote entries; unique names, search, filters, and status make
larger catalogs manageable.

Sessions from every available server appear together, ordered by most recent
activity. Every row and tab carries its server name, and **Sessions → Filter by
server** can narrow the list. Identical server-local session IDs remain distinct
inside the controller. Connected servers remain attached in the background, so
an attention notification includes the server name and opens the session owned
by that server.

**New Session** always shows the server chooser in the installed app. It
preselects the server confirmed for the previous new session, leaves unavailable
servers visible but disabled, and sends the create request only to the server
you confirm. Projects and other server-owned surfaces use the explicit server
selection as well. A server still decides which features and controls the
signed-in role may use; the controller does not broaden permissions.

Terminal and structured-conversation work, histories, plans, questions,
approvals, attachments, files, Git/GitHub views, projects, usage, runtime
profiles, environments, deploy targets, and server updates continue to belong
to the selected server. Destructive session confirmations name that server.
Appearance, notification, and chat-display preferences belong to this desktop
and follow you between servers; accounts, permissions, runtime profiles,
infrastructure settings, and server configuration do not.

Browser and installed-PWA access remain single-server experiences. The native
desktop controller hides the browser/PWA installation control, but the same
control remains available in supported browsers.

## Add and verify a remote server

In **Settings → Servers**, enter a unique friendly name and the server's exact
HTTPS origin, for example `https://agents.example.com` or
`https://agents.example.com:8443`. Enter only the origin: no path, query,
fragment, embedded username, or password. Plain HTTP is not supported, and a
non-default port is part of the server identity.

The remote side is an ordinary server installation; the controller does not
provision it or change its operating-system service. Configure its HTTPS and
GitHub OAuth normally using [Installation](installation.md), [GitHub
OAuth](github-oauth.md), and [Running as a
service](running-as-a-service.md). The OAuth callback and the exact origin saved
in the controller must both lead to that intended installation.

The controller connects without credentials first and verifies that the address
returns a compatible CODE AGENTS identity for that exact origin. An unrelated
website or incompatible controller protocol is rejected. A verified server can
be saved while signed out and signed into later. Duplicate canonical addresses
and duplicate friendly names are rejected.

If an unsaved address presents an invalid certificate, its proposed entry and
fingerprint remain temporary until you approve that exact fingerprint. Nothing
is written to the server catalog before that confirmation. **Test** on an
already saved row uses that row's current exact-origin certificate decision;
testing text that has not been saved never borrows an existing exception.

Select **Sign in** to open that server's GitHub sign-in in a dedicated in-app
window. The window can navigate only between the exact server and GitHub, has
no Node access, and uses a persistent Electron storage partition dedicated to
that saved server. Each server therefore remembers at most one account, and its
cookies, site storage, HTTP authentication, and cache are separate from every
other server. Signing out clears only that server's partition and cached session
metadata, closes its live controller connection immediately, and leaves every
other server attached; the saved connection remains.

The controller reconnects interrupted saved servers automatically, records the
last successful contact, and also provides **Retry**. Unreachable, signed-out,
incompatible, and certificate-blocked entries remain visible instead of taking
over the application.

### Rename, change address, and remove

Renaming changes only the local friendly name and does not interrupt the
connection. Changing the address is different: it is a new security
destination. The controller verifies the new exact origin before committing the
change. On success it clears the old remembered sign-in, cookies and other site
data, certificate approval, and cached session metadata while retaining the
friendly name. If verification fails, the old address remains saved.

Removing a remote server deletes this desktop's saved connection, persistent
sign-in partition, certificate approval, and cached session metadata. It does
not contact the remote service to stop sessions and does not delete any remote
data. If the controller knows work is running there, the confirmation warns that
the work will continue but disappear from this desktop's view.

The server catalog, trust decisions, accounts, and cached metadata are local to
this desktop installation. They are not synchronized, imported, or exported.

## Offline servers and cached information

When a remote server becomes unavailable, its last-known sessions remain in the
combined list with their server and offline state. Joining, leaving, deleting,
or otherwise operating on an offline session is disabled; use **Retry**, edit
the connection, manage the saved server, or choose another available server.

The offline cache is intentionally metadata-only: it is for recognizing a
session by its name, server, runtime, status, and last activity. The controller
does not store an offline transcript, terminal or command output, file contents,
downloads, credentials, or approvals. The metadata survives a desktop restart
until the server refreshes it, you sign out, or you remove the saved server.

## Invalid certificates

Normal HTTPS certificate and hostname validation is always the default. If an
exact saved server presents an invalid certificate, the connection pauses and
**Settings → Servers** shows its SHA-256 fingerprint and a certificate warning.
Choosing **Ignore errors for this certificate** requires acknowledging that an
attacker could intercept commands, files, credentials, approvals, and session
content.

Approval is a pin for that fingerprint at that exact HTTPS origin, including
its port. It can permit a self-signed, untrusted, expired, or
hostname-mismatched certificate for that server only. It never weakens another
server, GitHub, or any external page. The server and its sessions keep a
non-color **Insecure connection** badge while the exception is active.

If the server later presents a different invalid certificate, no cookies,
request body, or WebSocket traffic is sent. The controller blocks the
connection, shows the new fingerprint, and requires a new explicit approval.
Confirm the replacement out of band with the server operator before approving
it. Editing the saved address or removing the server also discards the old
approval.

For a private CA, the safer long-term solution is to trust that CA on the
desktop operating system as described in [HTTPS and
certificates](https-and-certificates.md), then use normal validation.

## Find servers on a LAN

Discovery is off at both ends until people opt in:

1. The server operator enables advertising and chooses the exact public HTTPS
   origin.
2. A desktop user explicitly chooses **Find servers** in **Settings → Servers**.

The desktop does not scan at startup or in the background. A found server is
only a candidate: **Review and add** still requires a friendly name, exact
HTTPS/identity verification, normal sign-in, and the same certificate decision
as a manually entered address. Discovery finds existing servers; it never
installs, starts, stops, or configures one.

To make a normal server answer explicit LAN probes, start it with:

```bash
cc-web \
  --server-name "Office build server" \
  --public-discoverable-url https://agents.office.example:32352 \
  --lan-discoverable
```

The equivalent environment variables are:

```text
CODE_AGENTS_WEBCLI_SERVER_NAME=Office build server
CODE_AGENTS_WEBCLI_PUBLIC_DISCOVERABLE_URL=https://agents.office.example:32352
CODE_AGENTS_WEBCLI_LAN_DISCOVERABLE=true
```

`--public-discoverable-url` must be the exact origin that another machine will
connect to and must match the server's TLS certificate/trust decision. It is
separate from `--public-base-url`, which continues to define GitHub OAuth
callbacks; deployments commonly set both to the same external origin. The
discovery responder uses UDP port `32353`, so the local firewall must allow
that port on the intended LAN. It answers only the versioned CODE AGENTS probe.

Before sign-in, the HTTPS identity endpoint and LAN response expose only the
operator-provided server name, connection address, CODE AGENTS product and
version, controller protocol version, and capability names. They expose no
users, sessions, files, credentials, or usage information. Servers without
`--lan-discoverable` create no discovery listener, and the embedded Local
computer server never advertises itself.

## Updates

Two installations can need an update, and their notices name different owners:

- **Desktop-package update** means this installed Electron application. It is a
  release download and manual reinstall; the app never silently downloads or
  installs it.
- **Server update · _server name_** means the selected CODE AGENTS server. Its
  availability and action depend on that server's installation mode and your
  role there. Updating one server does not update the desktop package or another
  server.

Treat simultaneous notices independently and verify the affected name before
confirming a server-owned update. For a desktop package, verify the release and
`SHA256SUMS` before installing it.

## Alongside the PWA or server

The desktop app does not replace browser/PWA access or normal server
deployment. You may keep all of them installed. The desktop's embedded server
remains loopback-only, each remote remains an independently operated server,
and browser/PWA state remains separate from the desktop controller catalog.

Use a browser/PWA when you want direct access to one server from another device.
Use the desktop app when one native window should control Local computer and
several saved servers.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Local computer is unavailable | Read the reason shown beside **Local computer**. Remote servers and **Settings → Servers** remain usable. Resolve the local port, state-directory, certificate, or agent startup problem, then relaunch the app. |
| A remote address is rejected | Enter an exact `https://host[:port]` origin with no path, query, fragment, or credentials. Confirm `/api/identity` belongs to a compatible CODE AGENTS server and advertises the same origin. |
| A server is signed out | Use **Settings → Servers → Sign in**. If a remembered session expired, sign in again; other server accounts are unaffected. |
| A server is offline | Check its displayed error and last contact, then use **Retry**. You can still edit its connection or use another server. Offline session content is not available. |
| A server is incompatible | Upgrade that server to a controller-compatible CODE AGENTS version. Its saved entry remains visible while incompatible. |
| The certificate changed | Do not approve it merely to clear the warning. Compare the displayed SHA-256 fingerprint with the server operator, then approve the replacement only if it is expected. |
| Find servers returns nothing | Discovery must be enabled on the server, **Find servers** must be started manually, both devices must share a broadcast-reachable IPv4 LAN, and UDP `32353` must pass the firewall. You can always enter the HTTPS origin manually. |
| An agent is missing on Local computer | Install it and authenticate with your own account, then restart the desktop app so it can recover your login-shell `PATH`. |
| Repository URL is disabled on Windows | Create the project without a repository, or use a Linux server for repository-backed managed projects. Ordinary work in local folders remains available. |
| A Flatpak cannot reach an agent, credential, or project | This is normally Flatpak sandboxing. Grant the necessary access with Flatpak tooling or use the AppImage. |
| AppImage does not open | Ensure it is executable. On distributions without FUSE2, install the compatible FUSE package or use `--appimage-extract-and-run`. The app refuses `--no-sandbox`; enable unprivileged user namespaces or use Flatpak rather than disabling Chromium's sandbox. |
| SmartScreen or Gatekeeper stops the installer | Confirm the release and `SHA256SUMS`; the packages are unsigned, so these warnings are expected. |
| Another device cannot connect to Local computer | Expected: the embedded server binds to `127.0.0.1` only. Run a normal server installation for LAN or remote access, then save it in the desktop controller if desired. |
| An update notice appeared | Check whether it names the desktop package or a particular server. Desktop updates are manual release installs; server updates affect only the named server. |
