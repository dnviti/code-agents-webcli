# Installation

Every install path, and what each one is good for.

Nothing here compiles anything. The package has no native dependencies: the
pseudo-terminal ships as a prebuilt binary and SQLite comes from Node itself.
You do not need a C++ toolchain, and there is no `npm rebuild` step.

## Requirements

| | |
| --- | --- |
| **Node** | 22.13 or newer. That is the first release with an unflagged `node:sqlite`, which the app stores everything in. Check with `node --version`. |
| **A GitHub OAuth App** | Sign-in is GitHub-only, and the app cannot serve a login page without one. [Set it up first](github-oauth.md) — it takes about a minute. |
| **`openssl`** | On `PATH`. The server shells out to it to generate its own certificate authority on first start. Almost every system already has it; `dnf install openssl` / `apt install openssl` if not. Not needed if you bring [your own certificate](https-and-certificates.md#using-your-own-certificate). |
| **A browser** | Anything current. The UI installs as a PWA if you want it to. |
| **The agent CLIs** | Optional, and only the ones you intend to use. See [Runtimes](runtimes.md). |

Supported platforms: **linux-x64, linux-arm64, macOS (Intel and Apple Silicon),
Windows x64 and arm64**. Linux needs glibc 2.28 or newer — Debian 10+,
Ubuntu 18.10+, RHEL 8+. Alpine/musl and 32-bit ARM are not covered; see
[Unsupported platforms](#unsupported-platforms).

## Try it without installing

```bash
npx --allow-git=all github:dnviti/code-agents-webcli
```

That is the whole thing. It fetches, builds the bundle, and starts the server,
which walks you through [first-run setup](configuration.md#first-run-setup).

`--allow-git=all` is needed on **npm 12**, which refuses to fetch from a git
remote unless you say so. On npm 10 and 11 the flag is simply ignored, so the
same command is correct everywhere. To stop typing it:

```bash
npm config set allow-git all
npx github:dnviti/code-agents-webcli
```

`npx` runs from a cache npm may clear at any time. That is fine for trying it
out, and it means each run picks up the latest commit — but it is also why an
npx install [cannot install the background service](running-as-a-service.md) or
update itself.

## Install it

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
cc-web
```

This is the one to use for anything you intend to keep: it can install a
[background service](running-as-a-service.md), and it can
[update itself](updating.md) from the web UI.

Both `cc-web` and `code-agents-webcli` are installed; they are the same program.

### Uninstalling

```bash
# if you installed the background service, remove it first
systemctl --user disable --now code-agents-webcli.service
rm ~/.config/systemd/user/code-agents-webcli.service

npm uninstall -g code-agents-webcli
```

Your data is not removed with the package. Delete `~/.code-agents-webcli/` to
also discard the database, the generated certificates and the local CA.

## Docker

The image is published to GHCR on every release:

```bash
docker pull ghcr.io/dnviti/code-agents-webcli:latest
```

See [Running as a service](running-as-a-service.md#docker) for how to run it —
a container has no terminal for the setup wizard, so its configuration arrives
as environment variables instead.

## From source

For working on the app itself. See [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
git clone https://github.com/dnviti/code-agents-webcli.git
cd code-agents-webcli
npm install
npm run build
npm start
```

## Why it is not on npm

`npx code-agents-webcli` would be shorter, and it does not work: the package is
distributed from git and as a container image, not through the npm registry. The
git spec is what the extra `--allow-git=all` pays for.

A GitHub release tarball is no shorter — npm 12 blocks remote tarball URLs by
default too, under a matching `--allow-remote=all`.

## Unsupported platforms

The pseudo-terminal binding ships as a prebuilt binary rather than compiling on
install, which is what makes the one-command install possible. The cost is that
platforms without a prebuilt binary are not covered: **Alpine/musl** and
**32-bit ARM**.

On such a host, install upstream `node-pty` yourself and the app will use it
instead — that one does compile, so it needs `python3`, `make` and a C++
compiler:

```bash
npm install -g node-pty --allow-scripts=node-pty
```

The [container image](#docker) is built on Debian and avoids the problem
entirely.

## Verifying the install

The repository ships the check that CI runs, and you can run it against a
checkout yourself:

```bash
npm run verify:install
```

It snapshots your working tree into a throwaway git repository, installs *that*
by git URL into an empty prefix with an isolated npm cache, then asserts that
nothing compiled, no install scripts were blocked, and the installed binary
starts.

## Troubleshooting

**`npm error code EALLOWGIT` / "Fetching packages of type git have been
disabled"** — npm 12 without the flag. Add `--allow-git=all`, or set it once
with `npm config set allow-git all`.

**"needs Node 22.13 or newer"** — exactly what it says; the app refuses to start
rather than failing later with a confusing `Cannot find module 'node:sqlite'`.
Upgrade Node.

**"The @lydell/node-pty package could not find the platform-specific
package"** — either the platform has no prebuilt binary (see
[above](#unsupported-platforms)), or the install ran with `--omit=optional`,
which skips the binary. Reinstall without that flag.

**A `node_modules` copied between machines, or between a host and a
container** — the prebuilt binary is platform-specific. Install with npm on the
target rather than copying the directory across.

**The browser refuses to connect, or warns about the certificate** — expected on
first contact from a new device. See
[HTTPS and certificates](https-and-certificates.md).

More in [Troubleshooting](troubleshooting.md).
