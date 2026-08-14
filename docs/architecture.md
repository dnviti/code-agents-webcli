# Architecture

How the pieces fit together, for anyone changing the code.

## Shape

One Node process. It serves the client bundle over HTTPS, terminates WebSocket
connections, and spawns agent CLIs into pseudo-terminals. Installation state
lives in one shared, per-user SQLite file. Project conversation and terminal
bytes live as files in each authorised workspace.

```text
browser ──HTTPS──▶ express ──▶ routes, static bundle, /ca.crt
        ──WSS───▶ WebSocketHandler ──▶ MessageProcessor
                                          │
                                          ├─▶ bridges/*  ─▶ pty ─▶ agent CLI
                                          ├─▶ ChatStore   (headless CLI protocols)
                                          ├─▶ ScrollbackRecorder ─▶ HistoryStore
                                          └─▶ SessionStore ─▶ global app.sqlite

express ──▶ auth/settings/projects/usage ──▶ global app.sqlite
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
| `src/sdk/contracts/` | Platform-neutral wire contracts: qualified session IDs, attachment ownership and controller message rewriting. |
| `src/sdk/browser/` | Browser controller client and renderer-safe target/status types. |
| `src/sdk/node/` | Narrow server lifecycle used by Node hosts; stores and databases are absent from its supported surface. |
| `src/client/` | Browser TypeScript. `shell/` is the React UI, `terminal/` is the xterm layer. |
| `src/shared/` | Types and logic used by both sides — protocol events, update copy, profile validation. |
| `src/public/` | Static HTML, CSS, manifest, service worker. |
| `scripts/build.js` | The whole build. |
| `test/` | Mocha, no network, no real CLIs. |

## Reusable SDK and host boundaries

The npm package exposes three supported SDK entry points:

| Import | Runtime | Purpose |
| --- | --- | --- |
| `code-agents-webcli/sdk/contracts` | Browser or Node | Pure controller/session/attachment codecs. |
| `code-agents-webcli/sdk/browser` | Browser | Controller state, requests and renderer-safe public models. |
| `code-agents-webcli/sdk/node` | Node | `createCodeAgentsServer()` and its setup/start/shutdown lifecycle. |

The web CLI and Electron app are hosts built on the Node SDK. Electron serves
the same compiled React bundle as the web app and places its controller gateway
under that bundle, so extracting the host lifecycle does not fork or duplicate
the UI.

```text
contracts  ◀── browser SDK ◀── React web/desktop bundle
    ▲
    └────── Node SDK ◀────── cc-web CLI
                  └───────── Electron local-server host
```

Imports are one-way: contracts contain no Node, DOM, React, Express or Electron
dependency; the browser SDK may use Web APIs but not server or desktop modules;
the Node SDK may compose server internals but never Electron. OAuth partitions,
certificate approval, loopback secrets, updater policy and native-window state
remain desktop adapters rather than portable SDK policy. The package root and
legacy deep server/shared JavaScript imports remain resolvable for compatibility; they are
not a security boundary or new supported SDK surface. New applications should
use the three SDK subpaths above.

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

1. `tsc` compiles `src/server`, `src/shared` and the SDK entry points to `dist/`.
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

`app.sqlite` holds installation-wide settings, users, auth sessions, runtime
profiles, deploy targets, credentials and projects. It also holds session/tab
metadata, composer drafts, usage tables and each session's immutable workspace
scope. The data-directory lease makes it the single shared SQLite writer for
the installation.

Workspaces contain no SQLite database. Chat events, transcripts, terminal
history, paste metadata and attachment bytes are files under `.cc-web/`, with
per-session files below `.cc-web/sessions/<owner-key>/<session-id>/`. Their
append-only logs use fixed-width indexes, so paging into a week-old session is a
couple of positioned reads rather than a scan. Stores receive the immutable
scope recorded in `app.sqlite`; later working-directory changes cannot move a
session's project data.

Workspace-file persistence is strict on Linux, Windows, and macOS. Linux uses a
descriptor-relative namespace; Windows and macOS use verified-cwd helpers for
race-safe project-file operations. SQLite is never opened or published inside
a workspace.

The workspace catalog admits a canonical root for exactly one immutable account
identity. A conflicting or ambiguous assignment fails closed before any
session artifact is opened. The opaque owner key prevents account namespaces
from colliding inside that archive, while the trusted global row supplies
runtime and resume authority.

See [Configuration](configuration.md#where-state-lives) for the full layout.

## Security model

There is one boundary, and it is the allow-list. Anyone who can sign in can run
commands as the OS user running the server. Sessions are isolated *from each
other* by owner — every route filters on it, and a plaintext workspace archive
cannot be catalogued by two accounts — but unrestricted host commands are not
isolated from the filesystem. Use per-user environments or distinct OS-level
deployments when mutually untrusted accounts require a filesystem boundary.

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
npm test                # available tests; reports capability-gated integration files
npm run test:strict     # require loopback, local sockets, and child processes
npm run typecheck       # server and client
npm run test:browser    # headless browser checks against the real bundle
npm run verify:install  # install the working tree into a clean prefix and start it
```
