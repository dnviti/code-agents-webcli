# Projects

A **project** is a repository-shaped workspace: one project gets one dedicated
container on an administrator-managed [deploy target](deploy-targets.md). The
container belongs to the project, not to a tab or a terminal session. You can
open several sessions in it; closing all of them, or closing the browser, does
not remove the project or its container.

Open **Settings → Projects** to create and manage projects. The target is chosen
by the installation, not by the person creating the project. A project cannot
run when there is no usable target; it fails with that reason rather than
silently running on the server host.

## Create a project

Give the project a name and, normally, an HTTP(S) Git repository URL.
The app creates a container on the configured target and clones the repository
inside it. The build view reports progress. It is safe to close that view:
the build continues, and reopening it rejoins the same build instead of making
another container.

You may create a project with no repository for scratch work. Confirm the
disposability notice before doing so: there is no upstream source and no place
to preserve its project workspace. A rebuild, long-idle reclaim, or deletion
discards that work; only files in your persistent home survive.

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
the container and disposable worktree may be removed; reopening builds a fresh
container and checkout. Active agent work prevents both actions.

## Targets and storage requirements

Projects run where their deploy target runs. They are not migrated merely
because an administrator changes the active target, and the app never falls
back to the server host when a target is unavailable.

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
