# Contributing to Code Agents Web CLI

## Stack

- Node.js + TypeScript
- Express + WebSocket
- xterm.js frontend
- SQLite persistence via `better-sqlite3`
- Mocha for tests

## Repository Layout

- `bin/cc-web.js`: CLI entrypoint
- `src/server/`: server, routes, bridges, auth, persistence
- `src/client/`: frontend TypeScript
- `src/public/`: static HTML, CSS, manifest, service worker
- `scripts/build.js`: build pipeline for server, client, and static assets
- `test/*.test.js`: unit tests

## Local Setup

```bash
git clone https://github.com/dnviti/code-agents-webcli.git
cd code-agents-webcli
npm install
npm run build
npm run dev
```

## Commands

```bash
npm run build
npm run typecheck
npm test
npm run dev
npm start
```

## Coding Guidelines

- Keep diffs focused.
- Match the existing TypeScript and CommonJS style where each file already uses it.
- Use 2 spaces and semicolons.
- Prefer fast, isolated tests.
- Do not add real network or real CLI dependencies to tests when mocks are sufficient.

## Authentication Model

- GitHub OAuth is the only supported user authentication flow.
- Internal users are keyed by GitHub numeric IDs.
- Do not reintroduce token-based login paths.
- Treat the SQLite database as sensitive because it stores auth session data and OAuth configuration.

## Persistence Model

- App settings, users, auth sessions, and runtime sessions live in SQLite.
- Keep schema changes backward-compatible when possible.
- If you change persisted structures, update tests and the README in the same change.

## Pull Requests

- Use Conventional Commits.
- Include screenshots for UI changes.
- Call out auth, persistence, or workflow risks explicitly.
- Update docs when flags, auth flows, release behavior, or deployment steps change.

## Release Process

`main` is the release branch.

1. Land the version bump on `main`.
2. GitHub Actions runs `.github/workflows/release-on-main.yml`.
3. That workflow validates the build, publishes the npm package with trusted publishing, and pushes the Docker image to GHCR.

Prerequisites outside the repo:

- npm trusted publishing must be configured for this repository
- the package name must be available on npm
- GitHub OAuth credentials must be configured for deployed environments

