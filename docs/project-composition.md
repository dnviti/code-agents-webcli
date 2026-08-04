# Project composition and durable storage

Before the first container for a repository project is built, the app reads a
small, fixed set of repository metadata and presents a **build recipe**. The
recipe says which language runtimes, agent CLIs and forge command-line tool the
container will get. It is a project choice, rather than a property of the base
image, so a service with a Node front end and a Python back end can receive both
and can launch the user's selected coding agent immediately.

## Review the recipe before the build

For a repository project, the app inspects the repository first and then opens
the recipe review. It can recognise Node.js, Python, Go, Rust, Java and .NET.
Version hints are shown when they are safe to read; otherwise the recipe shows
the catalog's explicit default version. You can remove detected runtimes or add
other catalog entries before confirming.

Agent CLIs are a separate explicit choice because they cannot be inferred from
repository files. The managed catalog contains Claude Code, Codex, pi, Grok
Build, Qwen Code, Kimi Code and Oh My Pi. Each entry has an immutable package
version in the catalog. Selecting an npm-backed agent also installs the pinned
Node foundation it needs when Node is not already a selected project language;
Kimi does the same with Python. Those implementation dependencies are shown in
installation status without being presented as detected repository languages.

For a project without a repository, or a repository with no recognised marker,
the same chooser is shown with no detected entries. Nothing is silently
installed merely because the base image happens to contain it.

The confirmed recipe is immutable: later edits create a new revision. For an
existing project, applying that revision rebuilds the container. The app makes
that consequence clear and asks for confirmation. It first uses the normal
[project preservation](projects.md#what-survives-a-rebuild) gate; if
uncommitted work cannot be preserved, the new recipe is not activated and the
old container is kept.

Inspection is deliberately not a build step. The server uses isolated Git
metadata operations to read allowlisted manifest and lockfile blobs from the
resolved revision. It does not check out the repository or run package scripts,
hooks, filters, submodules, repository configuration, or any repository code.
The build checks out the exact revision that was inspected; if upstream changes
first, the project returns to recipe review rather than building a different
tree.

## Installation and retry

Each selected language runtime, agent runtime and forge tool is installed
independently before the repository is cloned into `/workspace`. A failure does
not make the project unusable: it opens with a **partial install** status naming
the unsatisfied items and their safe error details. The recipe is not shown as
satisfied until every selected item succeeded.

Use **Retry failed items** after fixing a transient problem. Retry works in the
same verified container and attempts only failed entries. It does not rebuild,
wipe, re-clone, or run the preservation process again.

## Runtimes and base images

The app uses a pinned, checksum-verified, user-space copy of
[mise](https://mise.jdx.dev/) for the selected runtimes and the `gh`/`glab`
clients. Each Linux architecture and libc binary is kept in the durable owner
home; the stable `~/.local/bin/mise` launcher selects the current container's
x64/arm64 and glibc/musl binary, so deploy targets with different platforms can
safely share that home. Installation needs no root and later projects reuse the
download. Repository configuration is never passed to mise; the app supplies
the selected catalog tools, validated versions, its own working directory, and
isolated mise configuration and cache directories. See the
[mise documentation](https://mise.jdx.dev/getting-started.html) for the tool
manager itself.

Managed agent packages use mise's npm or pipx backend with the exact package
and version held in the catalog. Their executable shims are published into the
durable owner home already present on the project container's `PATH`. Agent
authentication, configuration, skills and conversation state therefore remain
available to every project and survive container replacement. Cursor Agent and
Antigravity CLI remain launchable when installed manually in that persistent
home, but are not recipe choices: neither currently provides a version-pinned
official package compatible with this installer's immutable allowlist.

`tea` is not taken from the mise registry. Gitea's official
[`tea` v0.15.1 release](https://gitea.com/gitea/tea/releases/tag/v0.15.1) is
installed from its checksum-verified Linux x64 or arm64 binary into the same
durable owner tooling area. Its stable launcher chooses the current
architecture and points `tea` at the memory-backed XDG credential directory.
The [Gitea product page](https://about.gitea.com/products/tea/) identifies
`tea` as Gitea's command-line client.

The selected base image still needs the operating-system facilities that the
app cannot safely add to an arbitrary image: Linux `sh`, Bash for the user's
interactive terminal, CA certificates, Git, a readable `/proc`, and `setsid`.
The compatibility check reports a missing
requirement before project work starts. This applies to Docker, Podman, and
Kubernetes targets. In particular, the app does not try to install system Git
in an image where it lacks root access.

## Forge access and Git identity

The forge tool follows the repository host: GitHub and GitHub Enterprise use
`gh`, GitLab uses `glab`, and Gitea or Forgejo use `tea`. For an unknown host,
choose the applicable forge rather than relying on a global default.

Tokens connected for a host are encrypted at rest and never returned in a list,
admin view, log, or export. At container start they pass only through process
standard input while the app populates an owner-only memory-backed credential
area, which the forge CLI then reads: Docker and Podman use a tmpfs mount;
Kubernetes uses an `emptyDir` with `medium: Memory`. Only the directory path,
never a credential, is present in container environment or inspection
metadata. Disconnecting a host deletes its stored credential and removes its
material from that owner's running projects.

Credential validation targets the exact host supplied for GitHub Enterprise,
GitLab, Gitea, and Forgejo. The sole fixed catalog exception is `github.com`,
whose validation endpoint is `api.github.com`. Redirects are disabled, and the
validator never derives an authority from a response or from user-provided
endpoint data.

This release provides token connections and a provider-neutral seam. It does
**not** yet provide automatic GitLab/Gitea sign-in-derived access, approval
flows through every configured sign-in provider, linked-identity selection, or
identity-only-provider notices; those are the boundary of issue #170. Add or
replace a token for a host when validation reports it expired, was revoked, or
is otherwise invalid—doing so does not recreate the project.

Git identity resolves in this order: project override, user-wide override,
then the current sign-in's published default. A user-wide choice is retained
in the durable Git configuration; a project choice is written to the
app-generated, project-only Git config in the durable project overlay, not to
checkout-local configuration. If the current GitHub account has a private
email, the app uses GitHub's published immutable-id/login no-reply address. It
does not guess an email for another provider or when no published address
exists: enter a valid name and email before confirming the recipe.

## What persists, and where

| Layer | Purpose | Lifetime |
| --- | --- | --- |
| Owner home | Agent sign-ins, personal skills/settings, connected hosts, shell configuration, user-installed tooling, mise data and cache | Survives every container, project rebuild and reclaim for that owner. |
| Project overlay (`/opt/code-agents-project`) | App-generated project settings and project-only additions | Survives that project's rebuild/reclaim; is mounted only into that project and is deleted with it. |
| Workspace (`/workspace`) | Repository checkout and repository-carried agent files | Disposable; rebuilt from the inspected revision, with the preservation gate described above. |
| Container/image outside those mounts | Operating-system and temporary container state | Disposable. |

The owner home and project overlay must be reachable by both the server and the
runtime. Local Docker and Podman use their recorded host paths as bind mounts.
Remote Docker/Podman project targets remain unsupported because the server
cannot safely browse a different host's workspace. Kubernetes requires the
same ReadWriteMany storage planning described in
[Per-user environments](user-environments.md#storage-on-kubernetes); its pod
UID/GID and `fsGroup` are aligned so the shared paths retain the same ownership
semantics.

## Storage usage and reclaiming space

**Storage** in project settings shows measured usage for the current user:
agent data, user-space tooling and cache, other owner-home files, and each
project's workspace and overlay. It also reports free filesystem space and any
partial scan errors. The scanner does not follow symlinks and counts hard links
once, so a report does not wander outside the assigned paths.

The installer can see the same per-user breakdown and configures the user and
administrator warning thresholds. Warnings are informational only: there is
no per-user quota, no admission control, and crossing a warning never blocks a
build, session, or project. Underlying storage may still become full. When it
does, normal writes and installs fail with the filesystem's disk-full error;
the app cannot reserve capacity or make a failed write safe.

Users can clear downloaded mise cache from their own storage and remove
app-installed tool versions that no recipe still references. Version cleanup
derives its keep-set on the server from every project's latest, active, and
applied recipes plus installations currently in progress; the browser sends
only the opaque cleanup action, never a tool, version, or path. Cleanup is
serialized with installation of the same owner/tool/version and refuses
symlink traversal. Workspace cleanup continues to use project reclaim or
deletion, including its preservation rules. Administrators should investigate
the breakdown first, ask the owner to clean up where possible, and reclaim or
delete a project only through those lifecycle actions. When access is revoked,
an administrator may remove the owner's durable storage and connected-host
credentials as part of revocation; that is destructive and prevents recovery.

For the broader target and storage setup, see [Deploy targets](deploy-targets.md)
and [Per-user environments](user-environments.md).
