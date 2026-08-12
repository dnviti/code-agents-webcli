# Projects

A **project** is a repository-shaped workspace. With containerized environments
explicitly enabled by the server operator and an active
[deploy target](deploy-targets.md), it gets a dedicated container; with target
**None**, it is a normal local workspace under
`~/.cc-web/workspaces/<project-id>`. You can open several sessions in either
kind, and closing the browser does not remove the project.

Open **Settings → Projects** to create and manage projects. New projects use the
installation's active target by default. When that target is configured and
available, turn on **Local Projects** to show, open and create projects on the
server host instead. This is a per-user project choice; it does not change the
active deploy target for anyone else. Selecting target **None** in the
administrator settings still makes host-local placement the installation
default. When the feature flag is off, projects are host-local and deploy-target
configuration is unavailable.

## Create a project

Give the project a name and, normally, an HTTP(S) Git repository URL.
For a repository project, the app first inspects repository metadata and shows
a [build recipe](project-composition.md#review-the-recipe-before-the-build).
Choose the runtimes and review the forge tool before the first build. The app
then creates the configured container, or uses the local machine's installed
tools in host mode, and clones the inspected revision. The build view reports progress. It is safe
to close that view: the build continues, and reopening it rejoins the same build
instead of making another container.

You may create a project with no repository for scratch work. Confirm the
disposability notice before doing so: there is no upstream source and no place
to preserve its project workspace. A rebuild, long-idle reclaim, or deletion
discards ordinary project files. The app preserves its own `.cc-web` artifact
archive across a rebuild or reclaim, and files in your persistent home survive;
neither is a backup of the scratch project's source files.

For a private HTTPS repository, add a connected-host token for its host before
the build begins. The token is used only to clone that repository and to push a
preservation branch if one is needed. It is encrypted at rest, never returned
by the app after saving, and can be removed from **Projects**. A saved token is
not a general-purpose agent sign-in or automatic forge connection; those are
separate capabilities.

If the repository cannot be found or reached during a rebuild, the project is
marked **Unavailable**. It is not opened as an empty workspace. Update its
repository URL if it moved, then retry after restoring access.

## What survives a rebuild

Projects intentionally separate durable user data from disposable workspace
data:

| Location | What happens on a project rebuild or reclaim |
| --- | --- |
| Your persistent home directory mounted in the project container | Kept. Agent sign-ins, installed user tooling, shell configuration and other files stored there survive. |
| Project overlay mounted at `/opt/code-agents-project` | Kept for this project only. Project-specific settings and additions survive. Deleting the project removes the overlay. |
| `.cc-web/` at the canonical project workspace root | Kept across rebuild and reclaim. During the destructive interval, the exact directory is atomically staged in a deterministic sibling outside the container-writable root and then restored to this location. It contains project-specific files such as conversation events, terminal history, attachments and paste data; session/tab metadata, drafts and usage remain in the shared per-user `app.sqlite`. Deleting the project removes the artifact tree with the project. |
| The repository checkout under `/workspace` | Disposable. A rebuild clones it afresh from its repository. |
| Other paths in the project container outside your persistent home | Disposable. Do not use them as the only copy of important work. |

The persistent home is pinned to the account's immutable GitHub identity, not
to its current login spelling. Renaming a GitHub account therefore does not
move it to an empty home. Each account and each project workspace still has a
separate host directory and mount; one user's sessions cannot select another
user's project or persistent-home paths.

New sessions normally open in the repository checkout, but the project folder
picker can navigate to any folder in that project's assigned container. The
picker identifies the durability of the selected location before it is used:
the persistent home survives a rebuild, the repository workspace is preserved
to Git and then freshly cloned, and every other container-local path is
disposable. Container-local paths are executed and browsed through that
project's already owner-checked environment; they are never treated as paths on
the server host or as a way to select another project's container.

Project artifact persistence is always anchored to the canonical project
workspace, even when a session runs in one of those subfolders or container-only
paths. Before replacing a checkout, the project manager flushes the shared
session metadata and project artifact stores, then verifies `.cc-web` without
following symlinks. It atomically
moves that exact pinned directory to
`.<project-id>.ccweb-session-storage-retained`, a deterministic sibling outside
the project root mounted into the container, and synchronises both parent
directories. It can then remove disposable entries and create a fresh checkout.
The manager restores and verifies the same directory inode, makes that rename
durable, and only then re-enables project-file access. A competing `.cc-web`
name is never allowed to replace or overwrite the staged archive.

If a process crashes in this interval, the next startup first reconciles and
quiesces reachable managed runtimes so no old container can mutate the archive,
then restores the deterministic staging slot before session discovery. If the
runtime cannot be quiesced, the slot is unsafe, or exact restoration fails, the
authoritative archive stays staged and the project is reported unavailable; an
empty replacement database is not created. A normal stop does not replace the
worktree and therefore needs no staging cycle.

Before an automatic reclaim or a rebuild of a repository project, the app checks
the checkout for uncommitted work. If it is dirty, it commits that work to a new
`cc-web/wip/<date>-<commit>` branch and pushes it to the repository. The branch
name is made unique (`-1`, `-2`, and so on) and is never used to overwrite an
existing, default, or protected branch.

If that push cannot be completed — for example, the repository is unreachable
or the token cannot push — the project becomes **Blocked**. It stays in place
and states why; it is not rebuilt or reclaimed behind your back. Choose **Retry
preservation** after fixing the cause, or explicitly choose the discard option
to rebuild and lose the uncommitted checkout changes. Deleting a project is
also explicit and removes its container and disposable worktree.

Changing an existing project's build recipe is also a rebuild and takes this
same preservation path. It does not replace the active recipe or container when
preservation fails. The recipe includes the coding-agent CLIs the container can
launch as well as repository languages and forge tooling. A recipe with an
installation failure can still open the project as a partial install; retrying
only failed items does not rebuild or discard work. See
[Project composition and durable storage](project-composition.md).

## Running, stopping and reclaiming

Project creation is unlimited. Running projects are limited per user by a value
set by the administrator. The limit counts projects that are building, running,
or in a counted stop/reclaim transition, not the number of projects you keep.

At the limit, starting another project offers a deliberate swap: it proposes a
running project with no active work, normally the one idle for longest. Nothing
is stopped until you confirm. A project stopped for a swap keeps its worktree,
so opening it again resumes it with the same checkout.

An idle project has no active sessions, attached clients, builds, long-running
commands, or agent turns. After the configured idle-stop period it is stopped,
but its container and worktree remain. After the longer idle-reclaim period,
the container and disposable workspace contents may be removed after the
verified `.cc-web` staging-and-restore cycle; reopening builds a fresh container
and checkout around the restored archive. Active agent work prevents both
actions.

## Targets and storage requirements

Each project keeps the placement chosen when it was created. Changing the
active target or the **Local Projects** toggle does not migrate existing
container or local projects. Selecting **None** places newly-created projects
on the host by default; with a working target active, **Local Projects** applies
the same host placement only to projects that user creates while it is on.

The project worktree and the user's persistent home must be visible both to the
server and to the project container. For Kubernetes, this requires the same
ReadWriteMany storage described in [Per-user environments](user-environments.md#storage-on-kubernetes).
Remote Docker and Podman targets cannot currently host projects: their bind
mount paths belong to another machine, so the server and its file browser would
see a different workspace. Project startup fails loudly on such a target. Use a
local Docker/Podman engine or Kubernetes with the shared claim above.

See [Per-user environments](user-environments.md#projects-and-persistent-homes)
for the relationship between project containers and the user's persistent home,
and [Configuration](configuration.md#project-lifetime-settings) for the
administrator settings.
