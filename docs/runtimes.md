# Runtimes and profiles

Which agent CLIs the app can launch, how it finds them, and how to control the
way they start.

## Supported runtimes

None of these are bundled. The app runs whatever is already installed on the
host, and a missing CLI only matters when you press its button.

| Runtime | Default label | Binary | Also searched in |
| --- | --- | --- | --- |
| Claude Code | Claude | `claude` | `~/.claude/local/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Codex | Codex | `codex` | `~/.codex/local/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Cursor Agent | Cursor | `cursor-agent` | `~/.cursor/local/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| pi | Pi | `pi` | `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Grok Build | Grok | `grok` | `~/.grok/bin/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Qwen Code | Qwen | `qwen` | `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Kimi Code | Kimi | `kimi` | `~/.kimi-code/bin/`, `~/.local/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Oh My Pi | Oh My Pi | `omp` | `~/.local/bin/`, `~/.bun/bin/`, `/usr/local/bin/`, `/usr/bin/` |
| Terminal | Terminal | your `$SHELL` | falls back to `zsh`, `bash`, `sh` |

Those explicit directories are searched **in addition to** `PATH`, and searched
first. `~/.local/bin` is there for a specific reason: a `systemd --user` unit
does not reliably have it on `PATH`, and several of these CLIs install there.

Rename any of them in the UI with the
[alias flags](configuration.md#display-names).

### Permission bypass

Each runtime has a "skip permission prompts" launch option, which maps to that
CLI's own flag:

| Runtime | Flag |
| --- | --- |
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Grok Build | `--always-approve` |
| Qwen Code, Kimi Code | `--yolo` |
| Oh My Pi | `--auto-approve` |
| Cursor Agent, pi | *none* — neither CLI has a real equivalent, so the option is not offered |

These do what they say. An agent launched this way edits files and runs commands
without asking.

### Runtime quirks handled for you

**Claude Code** asks "Do you trust the files in this folder?" on first launch in
a directory. The app answers it, so a session does not sit there looking alive
while waiting for a keystroke you cannot see.

**Oh My Pi** silently relocates itself to a temporary directory when started in
your home directory — the session looks fine and the agent is somewhere else
entirely. When the working directory is `$HOME`, the app passes `--allow-home`
so the folder you picked is the folder the agent sees. It checks your `omp`
actually has the flag first, because `omp` exits on an unrecognised one; on an
older build you get a warning in the server log rather than a silent relocation.

## The WebUI (beta)

Alongside the terminal, most runtimes can open as a **chat** surface: the CLI is
run headless and its structured output is rendered as a conversation — message
bubbles, tool-call cards, diffs, plans, permission prompts — instead of as a TUI.

Launch it with the **WebUI (Beta)** button on the runtime's card in the launcher.

| Runtime | WebUI |
| --- | --- |
| Claude Code, Codex, Grok Build, pi, Kimi Code, Oh My Pi | Available |
| Qwen Code, Cursor Agent | Not offered — no verified structured mode yet, so they open in the terminal only |
| Terminal | Not applicable — a shell has no conversation to show |

The surface is chosen **once, at launch**, and fixed for the life of the
session: driving a TUI through a pseudo-terminal and streaming a headless
protocol are different processes, so there is nothing to switch between.

It is beta, and labelled as such in the UI.

### The `/` menu

Typing `/` in the composer — or pressing the **Slash commands and skills**
button beside it — lists what the conversation can run, from the moment it
opens rather than after a first message has been sent.

**What the runtime says about itself always wins.** The ACP agents (Kimi Code,
Oh My Pi) volunteer their list as the session starts; Claude Code sends its own
with the first turn. When that list arrives it *replaces* whatever was shown
before it, entire.

Until then — and permanently, for Codex, Grok Build and pi, which never report
one — the menu shows what is installed for the session, read from the
directories each runtime's own installer writes into:

| Runtime | Read from |
| --- | --- |
| Claude Code | `.claude/skills` and `.claude/commands` in the project and in your home, plus the skills and commands of every enabled plugin |
| Grok Build | `.grok/skills`, `.grok/commands`, `.agents/skills`, and — as Grok itself does by default — your `~/.claude` directories |
| pi | `.pi/skills` and `.agents/skills` in the project, `~/.pi/agent/skills` and `~/.agents/skills` in your home |
| Codex | `~/.codex/skills` and `~/.codex/prompts`, and `.codex/skills` in the project |
| Kimi Code, Oh My Pi | Nothing — both report their own list before the menu can be opened |

Each entry carries the description its author wrote in the skill's frontmatter.
An entry whose author wrote none is shown with none: a sentence invented here
would be a guess presented as documentation.

Two things this is not. It is a list of what is **installed**, not a promise
that the runtime will accept all of it — a runtime is free to refuse something,
and its own list is what settles the question. And it is scoped to the session:
where sessions run in per-user environments each one reads its own home, so the
menu never becomes a window onto what someone else has installed.

### Starting a new conversation

`/clear`, `/new` and `/reset` — or the **New chat** button beside the composer
controls — end the conversation and start another one **in the same tab**. The
tab keeps its name, its place in the strip, its working folder and its runtime,
and it stays a running session: nothing claims it ended, and no recovery offer
appears.

The agent behind it is genuinely new. The runtime is restarted with no resume
id, so the first message afterwards is answered by a process that has never
seen what came before, and the window does not page back into it.

What is *not* carried across: anything queued behind the conversation you left
(those turns were for a process that no longer exists), and any standing
permission granted to it — a bypass belongs to the conversation that asked for
it, and the new one asks for itself.

Nothing is deleted. The previous conversation stays in the session's log for
history, search and export; this changes what the window shows and what the
session is running, not what happened.

There is no confirmation step, on the button or the commands. Asking twice for
something done many times a day costs more than it protects, given that what
is on screen is kept rather than destroyed.

## Runtime profiles

**Settings → Runtime profiles** controls how each CLI is launched. Nothing here
is tied to a vendor: a model is an opaque string passed through untouched, so
anything your CLI accepts — a hosted model, a gateway id, a local endpoint —
works.

A profile targets one runtime and carries four things, all optional:

| Field | What it does |
| --- | --- |
| **Model** | Passed as `--model <value>` to the CLIs that have the flag (all but Cursor Agent and Qwen Code) |
| **Extra arguments** | Appended after the app's own flags, so they win on CLIs where the last flag wins |
| **Environment** | Injected into the spawned process |
| **Capability tiers** | `floor` / `mid` / `high` / `top`, written into the runtime's own config |

Pick which profile is active per runtime; **None** launches the CLI exactly as a
shell would.

Profiles are **server-wide** while sessions are per-user, so only the
[installer account](github-oauth.md#the-installer-account) can change them.
Everyone else sees the page read-only.

Environment names that change *which code runs* rather than how the agent
behaves — `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `PATH`, `SHELL`,
`BASH_ENV`, `IFS` and similar — are rejected on save.

### What ships with it

A fresh install arrives with four profiles already written, so the page opens
with something to read and edit rather than an empty list:

| Profile | Runtime | What it sets |
| --- | --- | --- |
| Economy ladder — OpenRouter | pi, Oh My Pi | A cheap reader on `floor`, a code-tuned `mid`, one strong model on `high`/`top` |
| Balanced ladder — OpenRouter | pi, Oh My Pi | A cheap `floor`, then frontier models where judgment costs something to get wrong |
| Opus 5 — most capable | Claude Code | `--model claude-opus-5` |
| Sonnet 5 — faster, cheaper | Claude Code | `--model claude-sonnet-5` |

**None of them starts active.** A fresh install launches every CLI exactly as a
shell would; a profile takes effect only once you pick it. That is deliberate —
profiles are server-wide, so a default that applied itself would change how
everyone's agents start.

They are ordinary profiles: edit, rename or delete them. Nothing is rewritten by
a later upgrade, and deleting them all is remembered rather than undone on the
next restart. The model names are starting points, not a catalogue this project
maintains — model catalogues move faster than releases do, so expect to edit
them.

### Capability tiers

A tier names a *role* rather than a vendor or a size — **the cheapest model that
can still do this step**:

| Tier | For |
| --- | --- |
| `floor` | High-volume, low-judgment, ideally read-only work: searching, scanning noisy output |
| `mid` | The workhorse for most implementation |
| `high` | Tricky debugging, security-sensitive logic, review |
| `top` | Hard design and critical review |

Only runtimes that can delegate to sub-agents have somewhere to put these:

- **pi** — one agent file per tier in the session's `.pi/agents/`, with a
  matching reasoning effort. Written when the session starts, not on save,
  because that is when the directory is known.
- **Oh My Pi** — a `modelRoles` overlay in the app's data directory, passed with
  `--config` so your own `~/.omp/agent/config.yml` is left alone.

Every other runtime says so in the UI rather than accepting values that would go
nowhere.

**Neither writer touches your own configuration.** For pi that is worth spelling
out, because the obvious place to write — `~/.pi/agent/agents/` — is exactly
where a hand-written ladder lives, and there is no flag to point pi elsewhere. So
the app uses pi's own precedence instead: agents resolve from `~/.claude/agents`,
then `~/.pi/agent/agents`, then the project's `.claude/agents`, then the
project's `.pi/agents`, with later directories winning on name conflicts.
Writing into the session's project means the app's tiers **override** yours for
that session while your files stay byte-for-byte intact, keep applying to every
pi session you run outside this app, and any agent the app does not define — a
`planner`, a `reviewer` — still loads from your directory.

Two safety rules: generated files carry a `managed-by: code-agents-webcli`
marker, and **a file without that marker is never overwritten** — if a project
already has its own `.pi/agents/mid.md`, the app leaves it alone and tells you
it did. And the generated directory carries its own `.gitignore`, so it never
shows up in `git status`.

## Working directories

A session runs in the folder you pick, and that folder is what the session
record, the transcript and pasted-image paths all refer to. The file browser is
bounded by the working directory chosen during
[setup](configuration.md#first-run-setup) — only that directory and its
subdirectories are reachable.

Every session on the host runs as the **same OS user** — the one running the
server. There is no per-user sandbox. See
[the security note](github-oauth.md#the-allow-list).
