# Per-user environments

By default everyone who signs in shares this machine: the same account, the same
home directory, the same installed tools. On a single-user install that is
exactly right. With more than one person it means they can read each other's
files and credentials, one person's `npm install -g` changes everybody's
environment, and nothing on the host says which process belongs to whom.

Turning on **per-user environments** gives every signed-in account its own
container, named after them, with a home directory that survives the container
being destroyed and rebuilt.

The feature is off unless you ask for it. An installation that does not enable
it behaves exactly as it did before.

## What you get

- A container per account, created the first time they sign in and reused after
  that. Its name contains their GitHub login, so `docker ps` answers "whose is
  this?" at a glance.
- A persistent home directory on the host, bind-mounted into the container.
  Packages, shell configuration and agent credentials installed there survive a
  restart, an upgrade, and an explicit teardown of the container.
- Terminals, agent runs, chat runtimes, the file browser and editor, uploads and
  git all operating inside that account's environment rather than on the host.
- CPU and memory limits, so one environment cannot take the whole machine.
- Optional idle stopping, with a transparent restart the next time the user
  comes back.

## Prerequisites

Either engine works, chosen by configuration rather than by a different build.

**Docker.** The account running the server must be able to talk to the Docker
daemon — usually membership of the `docker` group. Note what that means: it is
equivalent to root on the host, which is why enabling this is a deliberate
administrator decision.

**Podman.** Rootless Podman is the safer option and needs no daemon. The server
passes `--userns=keep-id` so files created inside the container come back out
owned by the account running the server rather than by a subordinate uid.

On SELinux systems (Fedora, RHEL and derivatives) the bind mounts are labelled
automatically — `:Z` for the user's own home, `:z` for the app's shared,
read-only mount — so no `setsebool` or manual `chcon` is needed.

The base image must contain the agent CLIs you want available and a shell. The
default, `docker.io/library/node:22-bookworm`, has Node and `bash` but no agent
CLIs; install them with `--container-setup` or build your own image.

## Turning it on

```bash
cc-web --containers --container-engine podman \
       --container-image ghcr.io/your-org/agents:latest \
       --container-cpus 2 --container-memory 4g \
       --container-idle-minutes 30
```

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--containers` | `CODE_AGENTS_WEBCLI_CONTAINERS=true` | Enable the feature. Off by default. |
| `--container-engine <engine>` | `CODE_AGENTS_WEBCLI_CONTAINER_ENGINE` | `docker` (default) or `podman`. |
| `--container-image <image>` | `CODE_AGENTS_WEBCLI_CONTAINER_IMAGE` | Base image. Default `docker.io/library/node:22-bookworm`. |
| `--container-cpus <n>` | `CODE_AGENTS_WEBCLI_CONTAINER_CPUS` | CPU limit per environment. Unlimited if unset. |
| `--container-memory <size>` | `CODE_AGENTS_WEBCLI_CONTAINER_MEMORY` | Memory limit, e.g. `4g`. Unlimited if unset. |
| `--container-idle-minutes <n>` | `CODE_AGENTS_WEBCLI_CONTAINER_IDLE_MINUTES` | Stop an environment after this long with no activity. `0` (default) never stops one. |
| `--container-setup <command>` | `CODE_AGENTS_WEBCLI_CONTAINER_SETUP` | Shell run once inside each newly *created* environment. |

`--container-setup` runs on creation, not on reuse — it installs into the
container's own filesystem, which is the half a rebuild throws away, so it runs
again whenever an environment is rebuilt. Anything it writes under the user's
home persists instead and is not reinstalled.

A setup command that fails is logged and tolerated: the user still gets a
working environment, just without the extras.

## Where the data lives

```text
<data-dir>/environments/<prefix>-<login>-<user-id>/
```

`<data-dir>` is `--data-dir` if you set one, otherwise
`~/.code-agents-webcli`. Each directory is created mode `0700` and is
bind-mounted at `/home/<login>-<user-id>` inside that account's container.

That directory **is** the user's data. Everything else — the container, the
image, the installed system packages — can be recreated. Back up that tree and
you have backed up every user's home, agent credentials and work in progress:

```bash
tar -czf environments-$(date +%F).tar.gz -C ~/.code-agents-webcli environments
```

It holds agent credentials and API tokens, so treat it with the same care as
the database beside it.

Two further directories are mounted into every environment: the app's own
installation directory, read-only, and the directory its chat sockets live in.
That is how tool approvals and the model's questions still reach your browser
from a runtime that is not on this host. Neither contains user data.

## Names

An environment is named `<prefix>-<login>-<user-id>` — for example
`cawc-octocat-42`. The login is lowercased and reduced to `[a-z0-9-]`; the
numeric account id, which nobody chooses, is always last. That is what stops a
crafted login from colliding with, or impersonating, somebody else's
environment: `bob1` with id 2 and `bob` with id 12 get different names.

## Operating it

```bash
# What exists, and whose it is
cc-web --container-engine podman env ls

# Revoke someone: remove their environment, keep their data
cc-web env rm cawc-octocat-42

# Revoke someone completely
cc-web env rm cawc-octocat-42 --purge-data
```

`env ls` and `env rm` talk to the container engine directly, so they work
whether or not the server is running.

Removing an environment without `--purge-data` is not destructive: the user's
next sign-in rebuilds the container and reattaches the same home. That is the
supported way to move everybody onto a new base image — change
`--container-image`, remove the old environments, and each is rebuilt on next
use with its data intact.

## When it goes wrong

If an environment cannot be started, the session is refused with a message
telling the user to ask an administrator to check the container engine. It does
**not** silently fall back to running on the host: that would be an isolation
failure dressed up as a recovery.

The server log has the engine's own error. The usual causes are a base image
that has not been pulled, a Docker socket the server's account cannot reach, and
a `--container-memory` value the kernel refuses.

## What this is not

- It does not schedule environments across machines. Everything runs on the host
  the server runs on; there is no cluster mode.
- Users cannot choose or customise their own base image from inside the app.
- Environments are never shared between accounts, and one user cannot see
  another's.
