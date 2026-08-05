# Updating

CODE AGENTS has two deliberately separate update systems. A normal browser/CLI
server compares its baked Git commit with `main` and shows a server-owned
banner. The installed desktop controller compares its semantic application
version through platform-specific trusted feeds: signed Windows/macOS packages,
a GPG-signed Flatpak repository, and checksum-verified AppImages from the fixed
GitHub release feed. It uses the full-window proposal and status-bar reminder
described in [Desktop updates](desktop.md#updates). A Local embedded server
never creates the server-owned banner.

> This page is about updating **CODE AGENTS itself**. The version row on an
> agent's launcher card updates a managed Claude Code, Codex CLI, pi, Grok,
> Qwen Code, Kimi, Oh My Pi, or Antigravity copy instead; see
> [Installing and updating an agent](runtimes.md#installing-and-updating-an-agent).
> It never turns an external package-manager install into an app update.

## How a server build identifies itself

Installs come from `github:dnviti/code-agents-webcli`, which resolves to whatever
`main`'s HEAD is at the time. The package version therefore says very little —
the running build is identified by **the commit it was built from**, baked into
`dist/build-info.json` during the build.

GitHub is polled at most every 15 minutes however often anyone presses **Check**.
The unauthenticated API allows 60 requests an hour per IP, and no credentials are
ever sent.

## Applying a server update

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

## Server installs that cannot update themselves

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

`main` is the release branch. A maintainer creates a matching `v<version>` tag
only after the `package.json` version is on `main`; the tagged workflow rejects
any tag outside that history or with a different version.

- `.github/workflows/ci.yml` — typecheck, tests on Node 22 and 24, a container
  build, and a full install verification on a clean runner.
- `.github/workflows/release-on-main.yml` — tags `v<version>`, cuts a GitHub
  release, pushes the image to GHCR, and stages trusted desktop update feeds.

The project is not published to npm. Pushing to GHCR uses the `GITHUB_TOKEN`
Actions provides automatically. Desktop promotion is deliberately stricter: a
protected `release` environment must provide the Windows signing identity and
expected publisher, macOS Developer ID plus App Store Connect notarization API
key, and the Flatpak repository GPG key. GitHub Pages must use the
`github-pages` environment at the repository's stable `/flatpak/` URL. The
workflow fails before publishing a stable package feed when any required
identity, platform signature, notarization ticket, updater metadata/checksum,
or Flatpak summary signature is missing or invalid. Never add those credentials
to source control.

Every candidate also needs a protected installed-package qualification. Run the
old-to-new path on signed NSIS, a writable AppImage, repository-installed
Flatpak through the portal, and signed/notarized Intel and Apple Silicon macOS
applications. Each run must exercise discovery, explicit confirmation,
verified replacement, graceful Local shutdown, and relaunch. Then dispatch
`Desktop updater installed qualification` at the candidate tag with the five
successful Actions run URLs. Every run must upload
`desktop-updater-evidence-<package>/desktop-updater-evidence.json`, naming the
base/target versions and exact tested updater payload: EXE, AppImage, signed
macOS ZIP, or signed Flatpak summary/commit. The protected attestation rejects
missing, duplicate, or hash-mismatched evidence.

Set `DESKTOP_UPDATER_QUALIFICATION_RUN_ID` in the protected
`desktop-updater-qualification` environment to that attestation run, then
approve the waiting job. The tagged workflow remains alive and holds the
stable-feed lock while trials run. It rechecks the complete private draft,
versioned Pages candidate, public version tip, and current signed Flatpak tip
immediately before promotion. The first bridge release needs purpose-built
private/staged base packages because older public binaries have no updater.

The protected release configuration uses these exact names:

| Platform | Protected secrets | Protected variables |
| --- | --- | --- |
| Windows | `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` | `WINDOWS_CERT_SUBJECT` |
| macOS | `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | `MACOS_TEAM_ID`, `MACOS_CERT_AUTHORITY` |
| Flatpak | `FLATPAK_GPG_PRIVATE_KEY`, `FLATPAK_GPG_PASSPHRASE`, `FLATPAK_GPG_KEY_ID` | `FLATPAK_UPDATER_BRIDGE_TAG` only for the first remote-less bridge |
| All desktop packages (`desktop-updater-qualification` environment) | — | `DESKTOP_UPDATER_QUALIFICATION_RUN_ID` for the current candidate tag |

`FLATPAK_GPG_KEY_ID` is the full 40-hex primary-key fingerprint. The workflow
derives the public key, embeds it in the Flatpak, publishes it in the repository
descriptors, and verifies the signed commit/version manifest over the deployed
HTTPS origin. Private keys and passphrases are available only to the protected
tagged-release environment, never pull requests or forks.

Flatpak publication is two-phase. The workflow first deploys the candidate at a
versioned `/flatpak-candidates/vX.Y.Z/` path while keeping the old signed ref at
`/flatpak/` and copying the complete `docs/` site into the same Pages artifact.
Only after that candidate is read and verified over HTTPS does it expose the
native GitHub Release and activate the byte-identical repository at `/flatpak/`.
After activation it verifies the exact signed ref over HTTPS. If that fails,
the workflow restores the previous Pages ref and returns the native release to
its byte-identical draft. Retry failed jobs in the same workflow so the retained
canonical artifacts are reused; a fresh signed/notarized rebuild is not assumed
to be byte-identical.

Treat identity rotation as a release migration, not a secret replacement.
Verify a new Windows certificate keeps the configured publisher subject and a
new Apple certificate keeps the configured Team ID before changing protected
values. The current single-key pipeline deliberately does not rotate a Flatpak
trust root in place: replacing the secret would make the old repository
unverifiable. Build and qualify a dedicated old-key-signed, dual-trust bridge
before changing the protected key; until that bridge exists, key rotation is a
release blocker with a documented manual reinstall fallback. Keep the old key
and repository history available through that window.
Revoke the old identity only after installed old-to-new tests pass, then record
the old/new fingerprint, date, operator, and recovery release in the protected
environment's rotation log. Never overwrite assets for a public version.
