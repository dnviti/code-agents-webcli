# Deploy targets

A **deploy target** is one place this server runs per-user environments: a
Docker host, a Podman machine, or a Kubernetes cluster. You can define several
targets and switch between them without restarting the server. Only one is
active at a time; that is where new environments are created.

This page is about managing targets from the web UI. For what per-user
environments do and how the engines behave, see
[Per-user environments](user-environments.md).

## What a target stores

Each target has:

- a name, an engine (`docker`, `podman` or `kubernetes`), and a base image;
- connection secrets — a Docker/Podman remote host and optional TLS material, or
  a Kubernetes kubeconfig plus context, namespace, storage claim and service
  account;
- the same sizing policy a legacy install accepts through flags: tier catalog,
  default tier, whether users may choose, and flat CPU/memory limits;
- an idle timeout and an optional setup command.

Every target image must be Linux-based and provide `sh`, a readable `/proc`, and
`setsid`. Terminals and agents use them to keep remote process lifecycles tied to
project admission; an image missing one can be created, but cannot safely run a
session.

Secrets are encrypted in the database. The only place they appear on disk in
plaintext is `<data-dir>/deploy-targets/<target-id>/`, and that is only so the
engine CLI can read them.

## Who can manage targets

Only the [installer account](github-oauth.md#the-installer-account) can view,
add, edit, check, switch or remove deploy targets — the panel is installer-only
end to end, and the server answers every other account with `403`, reads
included. Writes additionally require a same-origin request, the same rule the
runtime-profiles route uses.

## Per-engine prerequisites and caveats

The engine prerequisites are the same as for a legacy install. Targets add a few
caveats that the panel shows before you save.

For every engine, the selected image must be Linux-based and include `sh`, a
readable `/proc`, and `setsid`. This prerequisite is shown beside the image field
and in each engine's caveats.

### Docker and Podman

- The server's account must be able to reach the engine. For Docker that
  usually means membership of the `docker` group, which is equivalent to root on
  the host.
- A remote host needs the host URL; TLS requires the CA, certificate and key
  PEMs. The panel stores them encrypted and never shows them back.
- Per-user homes and the server's helper directories are bind-mounted by their
  absolute server paths. A remote engine host must therefore see the server's
  data directory (and every configured extra mount) through shared storage at
  those exact same paths; without it, environment creation cannot produce a
  usable home.
- **Tool approvals and agent questions from a remote Docker or Podman host do
  not reach the browser.** Their channel is a Unix socket on the server host;
  sharing the directory exposes its path but does not forward that socket to a
  different machine. Conversations that bypass approvals are unaffected.
- Remote Docker and Podman targets can run per-user environments, but they
  cannot host [projects](projects.md): project workspaces must also be visible
  to the server-side file browser. Project creation fails loudly instead of
  attaching a different directory from the remote host.
- `env ls` and `env rm` on the server command line see only the legacy startup
  configuration, not the deploy-targets table. Use the web panel to check or
  remove targets.

### Kubernetes

- `kubectl` must be on the server's PATH and able to create, delete, exec into
  and patch pods in the namespace you name.
- Storage must be a **ReadWriteMany** claim; see
  [Per-user environments → Storage on Kubernetes](user-environments.md#storage-on-kubernetes).
- **Tool approvals and agent questions from inside a pod do not reach the
  browser.** Both travel over a unix socket, which does not cross a pod boundary.
  Conversations that bypass approvals are unaffected; conversations that ask for
  them will not get their prompts. This is a hard limitation of the pod
  boundary, not a setting.
- **Automatic sizing needs metrics-server.** Without it `kubectl top` has nothing
  to report, and automatic sizing stays where it is.

## Adding a target

Open *Settings → Deploy targets* and choose **Add target**. Pick an engine, fill
in the connection details, and set the policy fields. The panel shows that
engine's caveats before you save. Secret fields are write-only: leave them
blank to keep an existing value, or enter a value to replace it. The
non-secret Kubernetes fields (context, namespace, storage claim, service
account) show their current values, and editing one leaves the stored
kubeconfig untouched.

After saving, run **Check** on the target. A check calls the engine's own
`info`-level command (Docker/Podman) or fetches the namespace (Kubernetes) and
stores the result. It never creates a container. If it fails, the error text is
scrubbed of credential material before it is stored or displayed.

## Checking a target

The **Check** button next to each target asks the engine whether it is reachable
with the stored secrets. The outcome is recorded on the target so you can see
which ones are healthy without opening each one.

A check can fail for ordinary reasons: the kubeconfig has expired, the Docker
socket is not reachable, the TLS certificate has changed. The stored error is
meant to help you fix it, but it deliberately omits anything that could be a
secret.

## Switching the active target

Pick one target as active. New environments are created there. Existing
containers stay on the target they started on: switching does not migrate or
restart running work. If you need an existing environment on the new target,
remove it and have the user sign in again; the new environment is created on the
currently active target.

If no target is active, or the active target has been deleted, new work fails
loudly with "no active deploy target". The server does not fall back to the host
or to the legacy startup flags while any target exists in the table.

## Removing a target

A target that still has containers cannot be deleted. The delete button tells
you which container names are in the way; stop or remove them first. Deleting
the active target clears the active selection, so new work becomes unplaceable
until you activate another target.

## Secrets handling

Deploy-target secrets are encrypted with AES-256-GCM. The key comes from one of
two places, in this order:

1. `CODE_AGENTS_WEBCLI_ENCRYPTION_KEY` in the environment, or `--encryption-key`
   on the command line. Pass a 32-byte key in base64 or hex. A supplied key is
   held in memory only and is never written into the database.
2. If no key is supplied, the server generates one at first start and stores it
   in `app_settings` alongside the ciphertext.

The generated key is fine for development, but it puts the key next to the data
it protects. The server logs a warning when this happens. For production, always
pass a key through the environment or CLI.

Secrets are never returned to the browser. Lists and details carry `hasHost`
and `hasKubernetesConfig` flags only.

## Relationship to legacy startup flags

Deploy targets and the legacy `--containers`, `--container-engine`,
`--kube-namespace` and similar flags are mutually exclusive as sources of truth:

- If the `deploy_targets` table is **empty**, the startup flags rule exactly as
covered in [Configuration](configuration.md) and
[Per-user environments](user-environments.md). Nothing is read from the targets
system.

- If the `deploy_targets` table has **one or more rows**, the panel rules.
  Startup flags for engine selection and container policy are ignored. The
  active target produces the effective configuration for new environments.

- On first boot after an upgrade, if the table is empty and the legacy
  configuration has containers enabled, the server seeds a single target named
  `default` from those flags, marks it active, and sets a flag so it never seeds
  again. A disabled legacy configuration seeds nothing, so turning containers on
  later still captures that config once.

This means an existing install keeps working after upgrade, and you can then open
the panel and add, edit or switch targets at runtime.
