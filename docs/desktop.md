# Desktop app

The desktop download is a self-contained, local version of Code Agents Web CLI.
It starts its own server and opens one native window; you do **not** need a
terminal, Node.js, a separately running server, or a GitHub OAuth App just to
launch it. The bundled server listens only on `127.0.0.1`, so it is available to
the window on this computer, never to your LAN.

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

## Using the window

Opening the app starts the loopback service and shows its local web interface in
one window. The native menu offers the usual edit, view, window, help, and
platform application commands; closing the window stops the local desktop
session unless the operating system keeps the application running in its menu
bar or dock.

Use the same launcher, sessions, terminal, WebUI and local-project workflow as
the server edition. It is deliberately a one-person, one-machine setup: do not
expect GitHub OAuth users, LAN access, remote terminals, or server operator
settings in this mode.

On Windows, create local projects without a repository URL. The repository
inspection path depends on POSIX process/file-size limits and is disabled there
instead of offering a build that will fail or run without its safety bounds;
use the Linux server edition for repository-backed managed projects.

When the app reports a newer build, it shows an update notification. It does not
silently download or install anything: if a release download is offered, verify
the package and install it yourself. Release-download updates are always a
notification and manual choice, never a silent auto-update.

## Alongside the PWA or server

The desktop app does not replace the browser/PWA or a normal server deployment.
Use the PWA or server edition when you need GitHub sign-in, more than one user,
or access from another device. You may keep both installed; they keep separate
local state and the desktop service remains loopback-only.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| An agent is missing | Install it and authenticate with your own account, then restart the desktop app so it can recover your login-shell `PATH`. |
| Repository URL is disabled on Windows | Create the project without a repository, or use a Linux server for repository-backed managed projects. Ordinary work in local folders remains available. |
| A Flatpak cannot reach an agent, credential, or project | This is normally Flatpak sandboxing. Grant the necessary access with Flatpak tooling or use the AppImage. |
| AppImage does not open | Ensure it is executable. On distributions without FUSE2, install the compatible FUSE package or use `--appimage-extract-and-run`. The app refuses `--no-sandbox`; enable unprivileged user namespaces or use Flatpak rather than disabling Chromium's sandbox. |
| SmartScreen or Gatekeeper stops the installer | Confirm the release and `SHA256SUMS`; the packages are unsigned, so these warnings are expected. |
| Another device cannot connect | Expected: desktop binds to `127.0.0.1` only. Use the server/PWA installation for LAN or remote access. |
| The update notification appeared | It is only a notice. Download and install the release yourself; desktop updates are never silent. |
