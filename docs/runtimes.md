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
run in a structured mode of its own and its output is rendered as a conversation
— message bubbles, tool-call cards, diffs, plans, permission prompts — instead
of as a TUI.

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

### Tool activity

When an agent runs a command or edits a file, that shows up in the conversation
as its own card — separate from the agent's reasoning — and is counted in
**Usage**. This is checked per agent rather than assumed, because each of these
CLIs is driven differently and describes its own work differently.

| Runtime | Reports its work as | Verified against |
| --- | --- | --- |
| Claude Code | `tool_use` blocks | a recorded session |
| Codex | `commandExecution` and `fileChange` items | a recorded app-server turn |
| pi | `tool_execution_start` / `tool_execution_end` | a recorded turn |
| Grok Build | ACP `tool_call` / `tool_call_update` | a live run against 0.2.112 |
| Kimi Code, Oh My Pi | ACP `tool_call` / `tool_call_update` | live runs |

Nothing is shown that the agent did not report doing. Where an agent reports a
tool by name only, the card carries the name and its status and nothing else —
an inferred command in the record would be worse than a missing one.

**Grok Build is driven over ACP (`grok agent stdio`) rather than its headless
mode, and this is why.** Headless mode has no tool channel at all: asked to read
a file and run a command, it emitted eighty-three thought events, one line of
text and a summary, while the file it wrote appeared on disk. A conversation
driven that way showed an agent thinking and answering and never doing, and its
tool counts in Usage read as zero next to agents where the same work was counted
properly. Grok reports the identical work over ACP, so that is the entry point
the app uses. It brings permission prompts, a model list and per-turn cost with
it, and sessions recorded under the old mode still open — Grok kept the record
all along; only its headless output was silent about it.

### What the trace shows of the agent's thinking

A reasoning entry sits on the trace rail beside the tool calls, and expanding it
shows the agent's own words. **How much of them there are to show is the agent's
decision, not this app's**, and the four runtimes fall into three groups —
checked one at a time, because one of them working says nothing about the rest.

| Runtime | Hands over | Checked against |
| --- | --- | --- |
| pi | the reasoning text, as it is produced | a live run at `--thinking high` |
| Kimi Code, Oh My Pi | the reasoning text, as ACP thought chunks | live runs |
| Grok Build | the reasoning text, as ACP thought chunks | its recorded traffic — its own API was erroring when this was written |
| Claude Code | **the size only** — every thinking block on the wire is empty, with a signature beside it and a running token estimate on a side channel | a live run at `--effort high`, 2.1.220 |
| Codex | its reasoning summary, where the model produces one. Where the trace is encrypted and nothing was summarised, nothing | its own schema and 22,987 recorded reasoning items, all of them encrypted — the account was over its usage limit |

**An entry never expands onto an empty panel.** Where the text is missing the
entry says which of the three silences it is: still reasoning, reasoning the
agent measured but withheld — with the size it reported — or reasoning it said
nothing about beyond that it happened. The number beside the brain on a reply's
work counter counts the thinking that happened, whether or not its text came
with it.

The size shown beside a withheld block is the runtime's own live estimate and
is marked `~` for a reason: measured against the same turns' billed thinking
tokens it runs high (114 against 71, 152 against 118). The figures in **Usage**
come from the runtime's accounting, never from this estimate.

### The `/` menu

Typing `/` in the composer — or pressing the **Slash commands and skills**
button beside it — lists what the conversation can run, from the moment it
opens rather than after a first message has been sent.

**What the runtime says about itself wins.** The ACP agents (Grok Build, Kimi
Code, Oh My Pi) volunteer their list as the session starts; Claude Code sends
its own with the first turn. When that list arrives it *replaces* the stand-in.

For Claude Code that is the end of it. Its list names everything it accepts —
your skills, your project commands and every enabled plugin's among them — so
anything kept on top of it would be a name Claude has no command for: the menu
would offer it, and picking it would send the text to the agent as an ordinary
message, with nothing on the other end to run it.

Grok is why the rule is per-runtime rather than absolute. It announces seven
built-ins (`compact`, `context`, and so on) and says nothing about your
`.grok/skills`, so a wholesale replacement would take your own skills off the
menu a few milliseconds after the conversation opened. There — and only for the
runtimes that leave their skills out of their own list — what was found on disk
is added back after the runtime has had its say.

Until that list arrives — and permanently, for Codex and pi, which never report
one — the menu is only what is installed for the session, read from the
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

### How hard the agent thinks

Every runtime the WebUI drives has a reasoning-effort knob, and no two spell it
the same way. The button beside the model in the composer offers **exactly what
the runtime you are talking to published, in its own words** — nothing is
translated, and no level is offered that the agent would refuse.

| Runtime | Levels | How it is set | Live? |
| --- | --- | --- | --- |
| Claude Code | `low` `medium` `high` `xhigh` `max` `ultracode` | `--effort` at launch; `/effort` mid-session | yes |
| Codex | whatever `model/list` reports for the model in use — `low` through `xhigh`, and as far as `max` and `ultra` on some | `model_reasoning_effort` at launch, the turn's own `effort` after that | from the next turn |
| Grok Build | the levels the current model publishes — `low` `medium` `high` on Grok 4.5, none at all on Grok Build | carried on a model change | yes |
| Kimi Code | `off` `on` | an ACP config option | yes |
| Oh My Pi | `off` `auto` `low` `high` `max` | an ACP config option | yes |
| pi | `off` `minimal` `low` `medium` `high` `xhigh` `max` | `--thinking`, on the next turn's process | from the next turn |

**The button is not there when there is nothing to offer.** Grok on its default
model publishes no ladder, so no control appears — rather than one that could
only ever refuse. This is the one place the effort control behaves differently
from the model picker beside it, which always lets you type a name and try it: a
model name can only be judged by trying it, and a level cannot. Sending pi a
level it does not have is the worst case of all, because pi does not fail — it
prints a warning to a log nobody reads and answers at its own default, which
would leave the button reporting a level that was never running.

**The colour is the level.** At the bottom of a runtime's ladder the chip is the
same grey as everything else on the row; as the level climbs it gains colour and
a slow pulse, and at the top it is the loudest thing in the composer. That is
deliberate — maximum effort is the most expensive setting available, sometimes
by a wide margin, and a control that looked the same at `low` and at `max` would
be hiding the one figure worth noticing. The colour is never the only signal:
the level is named in text, and the little meter beside the name fills in
proportion to where the level sits on **its own runtime's** ladder, which is the
only honest way to compare Kimi's `on` against Claude's `xhigh`. If you have
asked your system for reduced motion, the pulse does not run and nothing is
lost.

**What is remembered, and where.** Two things, answering two questions. The
level *this conversation* runs at is kept on the server with the conversation,
so it survives a reload, a rejoin, and a `/clear` — which restarts the process
in place and would otherwise put it back where it started. The level to open the
*next* conversation at is kept in your browser, per runtime, so somebody who
runs Claude at `max` and Kimi at `on` gets both back rather than one setting
fighting over two ladders that have nothing in common.

Typing `/effort high` into the composer reaches the same place as the button:
the runtime runs its own command, and the choice is recorded so a later `/clear`
does not quietly undo it.

One caveat worth knowing, because Claude has two vocabularies rather than one.
Its `/effort` command answers `Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>`
— seven words. Its `--effort` launch flag takes six of them: `ultracode` is
accepted in silence, and `auto` answers with a warning to a log nobody reads and
then runs at Claude's own default.

`ultracode` is therefore on the menu — it is Claude's most expensive setting, and
worth reading before reaching for: the reasoning depth is `xhigh`, and what it
adds on top is breadth, fanning the work out across orchestrated agents. `auto`
is not on the menu, and typing `/effort auto` is deliberately **not** recorded:
it really does change the session you are in, but a level that cannot be passed
at launch would be silently dropped by every session after this one while the
control went on claiming it. Only levels the runtime published are remembered.

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

### Typing while the agent works

The composer never refuses a message. Send one while a turn is running and it
takes its place in line, listed above the field with the others waiting.

Each waiting message carries two controls: one removes it, and one sends it
**now**. "Now" means now — the turn in flight is cut short, that message is
handed over as a real turn of its own, and the conversation records the stop and
which message caused it. Everything else still waiting stays waiting, in the
order it was typed, and goes over afterwards as usual.

That is the difference from the stop button, which still discards the whole
line. Correcting one thing used to cost you the two messages you had already
lined up.

Past one waiting message the line **collapses to a single row**: the message you
added last, with a count of the rest beside it. Twenty waiting messages take up
as much room as one — which is the point, because twenty full-width rows are
taller than a phone screen, and the conversation and the composer both go with
them. Opening the count shows every message in order, in a box that scrolls
inside itself rather than growing; everything each message offers is offered on
the rows on screen, whichever state the list is in.

The list stays as you left it: adding a message never opens a list you closed or
closes one you opened. Drain back to one message and the plain row returns on
its own.

Two cases where the control is not offered, because it could not do anything:
when the agent is idle and already working through the line, and on a runtime
that cannot be interrupted at all (`codex exec` — see
[capability tiers](#capability-tiers)). It *is* offered while the agent waits on
an approval or a question, which is where a correction is most often typed;
sending then clears the card rather than leaving it waiting for an answer that
can no longer arrive.

### A long conversation

A conversation is grouped into **turns** — one thing you asked for and
everything the agent did about it — and every turn but the newest is folded
shut. A folded turn is not drawn until you open it: its code blocks, diffs,
diagrams and tool output are not built, and neither is the browser memory they
would occupy. Entering a tab therefore costs about the same whether the
conversation behind it is three turns long or three hundred.

Nothing is hidden by this. Every turn keeps its strip and its row in the turn
index, opens on a click, and opens on a jump from the index or from search —
which lands on the turn's contents, not on an empty one.

What has been opened is kept, so folding a turn and opening it again is
immediate rather than a second rebuild. What is kept is bounded by how much
content it holds rather than by a number of turns, because a conversation of
one-line exchanges and one full of large files are nothing alike at the same
turn count. Past that bound the material you looked at longest ago is released,
and built again if you go back to it — so a conversation can run all day
without the browser's memory use running with it.

The turn in progress is never treated this way. It is prepared whether it is
folded or open, and a turn that kept running while folded shows its real,
current state when you open it — not a snapshot from when you folded it.

### Being told when a conversation needs you

Agent work is slow enough that nobody watches it. A conversation you have left
tells you when it **finishes**, when a turn **fails**, and — the one that costs
real time — when it has **stopped to ask you** for an approval or an answer, at
which point it does nothing at all until it is answered.

None of this is guessed. A conversation knows when a turn ended and how the
runtime said it ended, and it knows when it is blocked rather than working, so
these come from the events themselves: no timer that decides silence means
finished, and no matching of the words that scroll past.

- **Acting on a notification opens that conversation**, whether the app is
  already open behind something else or has to be started.
- **The conversation you are looking at never notifies.** Looking at it means
  its tab is the one on screen *and* the window has focus — a window sitting
  behind your editor is not one you are watching, which is exactly the case this
  is for.
- **They do not pile up.** There is one notification at a time: a second
  conversation replaces it with a summary of both, and a conversation that
  finishes four times replaces its own.
- **Where they are refused, the app still says so.** A waiting conversation is
  marked in the tab strip and in the session list on a phone, in its own colour
  and in words, and the mark stays until the thing it is waiting for is
  answered — including when it is answered from another window or another
  device.

**Settings → Conversation notifications** switches the whole thing off, or any
of the four events separately, and the choice survives a reload. The browser has
to allow notifications first, which it is asked from that switch and nowhere
else — a page that asks the moment it loads is refused outright by Firefox and
Safari, and a refusal cannot be taken back from inside the page.

**What notifications say** turns the detail off: on, they name the conversation
and quote what happened; off, they say only that a conversation needs you.
Notifications are read on lock screens and on shared devices, outside the
boundary that signing in protects, so what leaves the app is your choice.

Reaching a phone whose screen is off needs a push subscription and is not part
of this yet; today a notification reaches another tab, another window, another
application, and the installed app while it is open in the background.

## Runtime profiles

**Settings → Runtime profiles** controls how each CLI is launched. Nothing here
is tied to a vendor: a model is an opaque string passed through untouched, so
anything your CLI accepts — a hosted model, a gateway id, a local endpoint —
works.

A profile targets one runtime and carries four things, all optional:

| Field | What it does |
| --- | --- |
| **Model** | Passed as `--model <value>` to the CLIs that have the flag (all but Cursor Agent and Qwen Code). A chat conversation on an ACP agent — Grok Build, Kimi Code, Oh My Pi — has no flag to pass it on, so the value is applied over the protocol the moment the session opens, and again after anything that restarts it: `/clear`, a server restart, the unavailable banner |
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
