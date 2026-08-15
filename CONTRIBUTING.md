# Contributing to Code Agents Web CLI

## Stack

- Node.js 24.16+ and TypeScript
- Express + `ws` for HTTP and WebSocket
- xterm.js in the browser, React for the shell UI
- Pseudo-terminals via `@lydell/node-pty` (prebuilt binaries, never node-gyp)
- Persistence via Node's built-in `node:sqlite`
- Mocha for tests

## Repository layout

See [docs/architecture.md](docs/architecture.md) for how it fits together.

- `bin/cc-web.js` — CLI entry point
- `src/server/` — server, routes, bridges, chat adapters, auth, persistence
- `src/client/` — browser TypeScript; `shell/` is React, `terminal/` is xterm
- `src/shared/` — types and logic used by both sides
- `src/public/` — static HTML, CSS, manifest, service worker
- `scripts/build.js` — the build pipeline
- `test/*.test.js` — unit tests

## Local setup

```bash
git clone https://github.com/dnviti/code-agents-webcli.git
cd code-agents-webcli
npm install
npm run dev
```

## Commands

```bash
npm run build          # compile server, bundle client, copy assets
npm run build:watch    # rebuild on change
npm run dev            # build, then start with extra logging
npm test               # tests available on this host; reports capability-gated files
npm run test:strict    # require every integration capability (used by CI)
npm run typecheck      # server and client
npm run test:browser   # headless browser checks against the real bundle
npm run verify:install # install the working tree into a clean prefix and start it
```

## Coding guidelines

- Keep diffs focused.
- Match the existing TypeScript and CommonJS style where each file already uses
  it.
- 2 spaces, semicolons.
- Comments explain *why*, not *what*. This codebase leans on them heavily for
  decisions that look arbitrary until you know what went wrong last time — keep
  that up.
- Prefer fast, isolated tests. Do not add real network calls or real agent CLIs
  to tests when a mock will do.

## The install surface is a hard constraint

`npx --allow-git=all github:dnviti/code-agents-webcli` has to stay a **single
command that compiles nothing**. That is not a preference — npm 12 blocks
dependency install scripts by default, and an npx run has no project
`package.json` in which to record an approval, so one dependency with an
`install` script silently turns the documented one-liner back into a
toolchain-and-four-commands ritual.

So:

- **Do not add a production dependency that compiles or has an install script.**
  `test/install-surface.test.js` fails if you do, and CI installs the working
  tree into an empty prefix on a clean runner to catch what a local test cannot.
- **Anything only needed to build belongs in `devDependencies`.** React, xterm
  and Mermaid are bundled at build time and never loaded at runtime; shipping
  them as runtime dependencies added ~150 MB to every install for nothing.
  `@xterm/headless` is the exception — the server actually runs it.
- The two platform bindings are isolated in `src/server/services/runtime/terminal/pty.ts` and
  `src/server/services/persistence/app/sqlite.ts`. Change them there, not at the call sites.

Run `npm run verify:install` before touching anything in `package.json`,
`scripts/build.js`, or those two modules.

## Authentication model

- GitHub OAuth is the only supported user authentication flow.
- Internal users are keyed by GitHub numeric IDs.
- Do not reintroduce token-based login paths.
- Treat the SQLite database as sensitive: it stores auth session data and OAuth
  configuration.
- The **installer** account (the first ever to sign in) is the only one that may
  change runtime profiles or apply an update. Both change what runs for
  everybody, so keep new privileged actions on the same footing.

## Persistence model

- One per-user `app.sqlite` owns installation settings, users, auth sessions,
  runtime/session metadata, composer drafts, usage accounting and immutable
  references to each session's project storage scope.
- Projects do not contain SQLite databases. Bulk project data lives in the
  authorised workspace's `.cc-web/`: scrollback, chat events and transcripts
  are append-only files with fixed-width indexes, alongside pasted images and
  attachments.
- Production has no automatic migration from older storage layouts. Leave
  unrecognised legacy files untouched.
- Keep schema changes backward-compatible where possible.
- If you change persisted structures, update the tests and the docs in the same
  change.

## Documentation

User-facing documentation lives in [`docs/`](docs/README.md); the README is
deliberately short and links out. If you change a flag, an environment variable,
an auth flow, the install steps or the release behaviour, update the matching
guide in the same pull request — a wrong flag name in the docs is a real defect.

## Pull requests

- Use Conventional Commits.
- Include screenshots for UI changes.
- Call out auth, persistence, install-surface or workflow risks explicitly.

## Release process

`main` is the release branch.

1. Land the version bump on `main`.
2. `.github/workflows/release-on-main.yml` runs.
3. It validates the build, tags `v<version>`, cuts a GitHub release, and pushes
   the image to GHCR.

The project is distributed from git and as a container image, **not** through the
npm registry, so a release needs no npm account or token. Pushing to GHCR uses
the `GITHUB_TOKEN` Actions provides automatically.
