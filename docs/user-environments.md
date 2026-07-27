# Per-user environments

By default everyone who signs in shares this machine: the same account, the same
home directory, the same installed tools. On a single-user install that is
exactly right. With more than one person it means they can read each other's
files and credentials, one person's `npm install -g` changes everybody's
environment, and nothing on the host says which process belongs to whom.

Turning on **per-user environments** gives every signed-in account its own
container, named after them, with a home directory that survives the container
being destroyed and rebuilt.

**The feature is off unless you ask for it.** An installation that enables
nothing needs no Docker, no Podman and no `kubectl` — none of them is a
dependency, none is looked for at startup, and none is ever invoked. Terminals,
agents, files and git run directly on the machine the server runs on, in the
account that started it, exactly as they always have. Nothing is created in the
data directory, and the size picker does not appear in Settings.

Enabling it is one flag, and turning it off again is removing that flag: the
server goes straight back to running on the host. The environments and their
data stay on disk until an operator removes them.

## What you get

- A container per account — or a Pod, on Kubernetes — created the first time
  they sign in and reused after that. Its name contains their GitHub login, so
  `docker ps` (or `kubectl get pods`) answers "whose is this?" at a glance.
- A persistent home directory on the host, bind-mounted into the container.
  Packages, shell configuration and agent credentials installed there survive a
  restart, an upgrade, and an explicit teardown of the container.
- Terminals, agent runs, chat runtimes, the file browser and editor, uploads and
  git all operating inside that account's environment rather than on the host.
- CPU and memory limits, so one environment cannot take the whole machine —
  chosen by the user from a catalog you define, or followed automatically from
  their own load.
- Optional idle stopping, with a transparent restart the next time the user
  comes back.

## Sizes, and who picks them

An installation defines a catalog of sizes — the *tiers* it is willing to hand
out — and each user picks one of them for themselves, or picks **Automatic** and
lets their own load pick for them. The choice lives in *Settings → Workspace
environment*.

```bash
cc-web --containers \
       --container-tiers "small=1,1g;medium=2,2g;large=4,4g" \
       --container-default-tier medium
```

Order matters: automatic sizing steps along the list, so the sequence you write
is the ladder it climbs. `--no-container-user-tier-choice` takes the choice away
and sizes everybody centrally.

If you define no catalog, what you get depends on whether you set a flat limit:

| You configured | Users get |
| --- | --- |
| `--container-tiers` | your catalog, and a choice |
| `--container-cpus` / `--container-memory`, no catalog | exactly that one size, no choice |
| neither | the stock ladder above, and a choice |

So the flat limits keep meaning what they always meant, and a catalog is
something you add on purpose.

### Automatic

Automatic starts at the default and samples the environment every 30 seconds:

- **Up** after 3 consecutive samples at or above 85% of the current tier's CPU
  *or* memory.
- **Down** after 10 consecutive samples at or below 30%.
- Five minutes of cooldown after any change, so it cannot oscillate.

Up fast and down slow, deliberately: being a size too small is felt on every
keystroke, while being a size too large costs the operator some headroom for a
few minutes. A user whose size changes is told, with the reason.

If usage cannot be read — a Kubernetes cluster with no metrics-server, most
often — automatic sizing does nothing at all. A missing reading is never treated
as an idle one, because that would shrink every environment on the cluster out
from under its owner.

### When a change takes effect

Docker, Podman and Kubernetes 1.33 or newer can change a running environment's
limits in place, and the change is immediate. Where that is not possible the
environment has to be rebuilt — lossless, because the home is on a volume, but
it ends whatever is running. So a change that needs a rebuild **waits until
nothing is running** and is applied the next time the user starts a session. The
environment panel says so while it is waiting.

## Prerequisites

Any of the three engines works, chosen by configuration rather than by a
different build.

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

**Kubernetes.** The server talks to the cluster through `kubectl`, which must be
on its PATH and able to create, delete, exec into and patch pods in the
namespace you name. Each user's environment is one Pod with `restartPolicy:
Never` running a container that sleeps; the server execs into it.

```bash
cc-web --containers --container-engine kubernetes \
       --kube-context my-cluster \
       --kube-namespace workspaces \
       --kube-storage-claim cawc-environments
```

Name the context explicitly. Left unset, the server uses whatever `kubectl` is
currently pointed at, which is not something to leave to chance for a process
whose job is creating pods.

Storage is the part that needs planning: see below.

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
| `--container-engine <engine>` | `CODE_AGENTS_WEBCLI_CONTAINER_ENGINE` | `docker` (default), `podman` or `kubernetes`. |
| `--container-image <image>` | `CODE_AGENTS_WEBCLI_CONTAINER_IMAGE` | Base image. Default `docker.io/library/node:22-bookworm`. |
| `--container-cpus <n>` | `CODE_AGENTS_WEBCLI_CONTAINER_CPUS` | CPU limit per environment. Unlimited if unset. |
| `--container-memory <size>` | `CODE_AGENTS_WEBCLI_CONTAINER_MEMORY` | Memory limit, e.g. `4g`. Unlimited if unset. |
| `--container-idle-minutes <n>` | `CODE_AGENTS_WEBCLI_CONTAINER_IDLE_MINUTES` | Stop an environment after this long with no activity. `0` (default) never stops one. |
| `--container-setup <command>` | `CODE_AGENTS_WEBCLI_CONTAINER_SETUP` | Shell run once inside each newly *created* environment. |
| `--container-tiers <spec>` | `CODE_AGENTS_WEBCLI_CONTAINER_TIERS` | `id=cpus,memory` entries separated by `;`. |
| `--container-default-tier <id>` | `CODE_AGENTS_WEBCLI_CONTAINER_DEFAULT_TIER` | Size for a user who has never chosen. |
| `--no-container-user-tier-choice` | `CODE_AGENTS_WEBCLI_CONTAINER_USER_TIER_CHOICE=false` | Stop users choosing their own size. |
| `--kube-context <name>` | `CODE_AGENTS_WEBCLI_KUBE_CONTEXT` | kubectl context. Unset means whatever kubectl points at. |
| `--kube-namespace <name>` | `CODE_AGENTS_WEBCLI_KUBE_NAMESPACE` | Namespace for the pods. Default `default`. |
| `--kube-storage-claim <name>` | `CODE_AGENTS_WEBCLI_KUBE_STORAGE_CLAIM` | The RWX claim holding every home. |
| `--kube-service-account <name>` | `CODE_AGENTS_WEBCLI_KUBE_SERVICE_ACCOUNT` | Service account for the pods. |

`--container-setup` runs on creation, not on reuse — it installs into the
container's own filesystem, which is the half a rebuild throws away, so it runs
again whenever an environment is rebuilt. Anything it writes under the user's
home persists instead and is not reinstalled.

A setup command that fails is logged and tolerated: the user still gets a
working environment, just without the extras.

## Storage on Kubernetes

Every user's home lives on **one ReadWriteMany claim**, mounted:

- into the server's own pod at the environments root, and
- into each user's pod with `subPath: <environment name>`.

That is the exact analogue of the bind mount used on a single machine, and it is
what keeps the file browser, editor, uploads and git working on ordinary
filesystem calls rather than shipping bytes through `kubectl exec`.

**ReadWriteMany is not optional.** Two pods need the volume at once — the
server's and the user's — and a ReadWriteOnce claim cannot do that. NFS,
CephFS, Azure Files, EFS and Filestore all provide it.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cawc-environments
  namespace: workspaces
spec:
  accessModes: [ReadWriteMany]
  resources:
    requests:
      storage: 100Gi
```

Mount it in the server's deployment at the same path as `--data-dir`'s
`environments/` directory, and the two halves line up.

Two limitations follow from the pod boundary, and both are specific to
Kubernetes:

- **Tool approvals and the model's questions do not reach the browser.** Both
  travel over a unix socket, which does not cross a pod boundary. Conversations
  that bypass approvals are unaffected; conversations that ask for them will not
  get their prompts. Run those on a single-machine engine until this moves to a
  network transport.
- **Automatic sizing needs metrics-server.** Without it `kubectl top` has
  nothing to report, and automatic sizing stays where it is.

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

- Users cannot choose or customise their own base image from inside the app —
  only its size.
- Nothing here autoscales the *cluster*. Automatic sizing changes one user's
  limits; finding room for the result is the cluster's own business.
- Environments are never shared between accounts, and one user cannot see
  another's.
