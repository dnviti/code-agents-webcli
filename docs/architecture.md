# Architecture

How the pieces fit together, for anyone changing the code.

## Shape

One Node process. It serves the client bundle over HTTPS, terminates WebSocket
connections, spawns agent CLIs into pseudo-terminals, and keeps everything in a
single SQLite file.

```text
browser ──HTTPS──▶ express ──▶ routes, static bundle, /ca.crt
        ──WSS───▶ WebSocketHandler ──▶ MessageProcessor
                                          │
                                          ├─▶ bridges/*  ─▶ pty ─▶ agent CLI
                                          ├─▶ ChatStore   (headless CLI protocols)
                                          ├─▶ ScrollbackRecorder ─▶ HistoryStore
                                          └─▶ SessionStore ─▶ node:sqlite
```

## Layout

| Path | What lives there |
| --- | --- |
| `bin/cc-web.js` | CLI entry point. Parses flags, checks the Node version, loads the compiled server. |
| `src/server/index.ts` | Wiring: express, TLS, WebSocket, session persistence, the setup wizard. |
| `src/server/routes/` | HTTP endpoints. |
| `src/server/websocket/` | Connection handling and the message protocol. |
| `src/server/bridges/` | One per runtime. Finds the CLI, builds its argv, owns its pseudo-terminal. |
| `src/server/chat/` | The headless [WebUI](runtimes.md#the-webui-beta) surface: per-CLI protocol adapters, event store, permission broker. |
| `src/server/services/` | Everything else: auth, database, TLS, scrollback, history, pastes, updates, profiles. |
| `src/client/` | Browser TypeScript. `shell/` is the React UI, `terminal/` is the xterm layer. |
| `src/shared/` | Types and logic used by both sides — protocol events, update copy, profile validation. |
| `src/public/` | Static HTML, CSS, manifest, service worker. |
| `scripts/build.js` | The whole build. |
| `test/` | Mocha, no network, no real CLIs. |

## The two platform bindings

Both are deliberately chosen so **nothing in the dependency tree compiles**,
which is what makes the one-command install possible. Both are isolated behind a
single module so the choice is reversible.

| Concern | Module | Backed by |
| --- | --- | --- |
| Pseudo-terminals | `src/server/services/pty.ts` | `@lydell/node-pty` — prebuilt per-platform binaries via `optionalDependencies`, never node-gyp. Falls back to upstream `node-pty` if a user installs it, for platforms with no prebuilt binary. |
| SQLite | `src/server/services/sqlite.ts` | `node:sqlite`, Node's builtin. Adds the two things better-sqlite3 had that the builtin lacks: `pragma()` and `transaction()`. |

This is enforced, not documented: `test/install-surface.test.js` fails if any
production dependency gains an install script, and CI installs the working tree
into an empty prefix on a clean runner.

## Build

`npm run build` does four things:

1. `tsc` compiles `src/server` and `src/shared` to `dist/`.
2. esbuild bundles `src/client` into `dist/public/app.bundle.js`.
3. esbuild bundles Mermaid into its own chunk, loaded only when a message
   actually contains a diagram. It is bundled rather than pulled from a CDN
   because this app is routinely run on a LAN with no outbound internet.
4. Icons are rasterised and static assets copied, with the service worker's cache
   name stamped with the build id so a new build evicts the old client.

`dist/build-info.json` records the commit, which is how a running server knows
whether it is [behind](updating.md).

The client libraries — React, xterm, Mermaid — are **devDependencies**: they are
bundled at build time and never loaded at runtime, so shipping them as runtime
dependencies would have added about 150 MB to every install for nothing.
`@xterm/headless` is the exception, and stays a real dependency: the server runs
it to reconstruct scrollback.

## Storage

One SQLite file, `app.sqlite`, holding settings, users, auth sessions and
runtime-session records. Bulk data does not go in it — scrollback, chat events
and transcripts are append-only files with fixed-width indexes, so paging into a
week-old session is a couple of positioned reads rather than a scan.

See [Configuration](configuration.md#where-state-lives) for the full layout.

## Security model

There is one boundary, and it is the allow-list. Anyone who can sign in can run
commands as the OS user running the server. Sessions are isolated *from each
other* by owner — every route filters on it — but not from the filesystem.

The parts that get specific care:

- The [installer account](github-oauth.md#the-installer-account) is the only one
  that can change runtime profiles or apply an update, because both change what
  runs for everybody.
- Profile environment variables that change *which code runs* are rejected.
- The self-update argv is a frozen literal — nothing from a request, a database
  row or a GitHub response is ever interpolated into it.
- The database is `0600` inside a `0700` directory.

## Testing

```bash
npm test                # mocha, no network, no real CLIs
npm run typecheck       # server and client
npm run test:browser    # headless browser checks against the real bundle
npm run verify:install  # install the working tree into a clean prefix and start it
```
