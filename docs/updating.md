# Updating

The app checks GitHub for newer commits and shows a banner when the running
build is behind.

> This page is about updating **CODE AGENTS itself**. The version row on an
> agent's launcher card updates a managed Claude Code, Codex CLI, pi, Grok,
> Qwen Code, Kimi, Oh My Pi, or Antigravity copy instead; see
> [Installing and updating an agent](runtimes.md#installing-and-updating-an-agent).
> It never turns an external package-manager install into an app update.

## How a build identifies itself

Installs come from `github:dnviti/code-agents-webcli`, which resolves to whatever
`main`'s HEAD is at the time. The package version therefore says very little —
the running build is identified by **the commit it was built from**, baked into
`dist/build-info.json` during the build.

GitHub is polled at most every 15 minutes however often anyone presses **Check**.
The unauthenticated API allows 60 requests an hour per IP, and no credentials are
ever sent.

## Applying an update

Everyone signed in sees the banner. Only the
[installer account](github-oauth.md#the-installer-account) can apply it.

Applying it:

1. runs the install,
2. checks that the newly installed build actually loads,
3. and only then restarts the service.

If either of the first two fails, **nothing is restarted** and the running
version is untouched.

> There used to be an `npm rebuild` between steps 1 and 2, because npm ≥ 12
> blocks dependency install scripts and the native modules arrived uncompiled.
> There are no native modules any more, so that step — and the class of failure
> it existed to catch — is gone.

**A restart ends every user's agent sessions**, not just the installer's. The
confirmation names how many are running. Sessions, transcripts and history
survive the restart; in-flight conversations do not.

If an update is interrupted — a reboot, an OOM kill — the next start says so, and
reinstalling is the recovery:

```bash
npm i -g --allow-git=all github:dnviti/code-agents-webcli
```

## Installs that cannot update themselves

These say so, rather than offering a button that would do nothing.

| Situation | Why, and what to do instead |
| --- | --- |
| Running via `npx` | The npx cache is temporary and npm may clear it. The next `npx` run already fetches the latest commit; [install globally](installation.md#install-it) to make it durable. |
| Running in a container | A self-install would write into a layer that the next `docker pull` discards. Pull and recreate the container. |
| Running from a git clone | A global install would not replace the code that is actually running. Use `git pull && npm run build`. |
| Global prefix not writable | A `sudo npm i -g` install is root-owned while the service runs as you. Reinstall from a shell. |

## Building the Docker image yourself

`.dockerignore` excludes `.git`, so the build cannot read the commit on its own.
Pass it in, or the image reports an unknown build and cannot check for updates:

```bash
docker build \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_DATE="$(git show -s --format=%cI HEAD)" \
  -t code-agents-webcli .
```

## Release flow

`main` is the release branch. A release fires when `package.json`'s version
changes on `main` and no matching tag exists yet.

- `.github/workflows/ci.yml` — typecheck, tests on Node 22 and 24, a container
  build, and a full install verification on a clean runner.
- `.github/workflows/release-on-main.yml` — tags `v<version>`, cuts a GitHub
  release, and pushes the image to GHCR.

The project is not published to npm, so the workflow needs no npm account or
token. Pushing to GHCR uses the `GITHUB_TOKEN` Actions provides automatically,
so there is nothing to configure for a release to work.
