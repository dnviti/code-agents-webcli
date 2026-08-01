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
| Antigravity CLI | Antigravity | `agy` | `~/.local/bin/`, `~/.gemini/antigravity-cli/bin/`, `/usr/local/bin/`, `/usr/bin/` |
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
| Antigravity CLI | `--dangerously-skip-permissions` |
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

**Antigravity CLI** asks "Do you trust the contents of this project?" the first
time it sees a folder, and does nothing at all until it is answered. The app
answers it, the same way it answers Claude's.

**Antigravity CLI in the WebUI** runs its shell tools in a scratch directory of
its own — `~/.gemini/antigravity-cli/scratch` — rather than in the folder you
picked, whatever directory the process itself was started in. Asked to read a
file that was sitting right there, it reported that no such file existed. The
app passes `--new-project`, which puts it back in the folder you chose; that
project is scoped to the one invocation and does not appear in your
`~/.gemini/projects.json`. The terminal surface does not have the problem and
does not get the flag.

## The WebUI (beta)

Alongside the terminal, most runtimes can open as a **chat** surface: the CLI is
run in a structured mode of its own and its output is rendered as a conversation
— message bubbles, tool-call cards, diffs, plans, permission prompts — instead
of as a TUI.

Launch it with the **WebUI (Beta)** button on the runtime's card in the launcher.

| Runtime | WebUI |
| --- | --- |
| Claude Code, Codex, Grok Build, pi, Kimi Code, Oh My Pi, Antigravity CLI | Available |
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
| Antigravity CLI | `step_update` steps of type `tool` and `subagent` | a live run against 1.1.8 |

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

### Questions the agent asks you

An agent that needs a decision only you can make puts a **card** in the
conversation with the options it wants you to choose between, and stops until
you answer. There is always a free-text box beside the options, so "none of
these" is a real answer rather than a dead end.

| Runtime | How it is given the question tool | Verified against |
| --- | --- | --- |
| Claude Code | an MCP server passed at spawn | a recorded headless session |
| Kimi Code, Oh My Pi | an MCP server passed in the ACP handshake | live runs |
| pi | a generated extension loaded with `-e` | a live run |
| Codex, Grok Build, Antigravity CLI | not offered — no channel anyone has watched work | — |

**The call blocks, and the app now makes sure it can.** Two of these CLIs put a
timer on it that this app has to switch off, or the question expires with nobody
having been asked:

- **Oh My Pi** abandons *any* MCP call after 30 seconds. Measured: two cards in
  one conversation died at 30.001s each, and the agent — told the tool had
  failed — asked the same question again, and again, and eventually carried on
  having guessed. There is no flag and no config key for it, and the ACP
  handshake has nowhere to put one, so the app sets `OMP_MCP_TIMEOUT_MS=0` on
  the process it starts. Its own subagents keep a separate 60-second ceiling
  that nothing can override; a question asked from inside one still expires, and
  the card says so rather than waiting.
- **Kimi Code** does the same at 60 seconds. Its lever, `KIMI_MCP_TOOL_TIMEOUT_MS`,
  accepts 1 to 2147483647 milliseconds and *silently discards* anything else —
  so the app raises the ceiling to the maximum rather than passing the zero that
  works for Oh My Pi and would land kimi back on its default.

**pi asks through an extension**, because it has no MCP support and no ACP. The
file is generated into the session's own `.pi/ccweb/`, is loaded by path, and
registers nothing at all when it is loaded outside a session. The app also
passes `--exclude-tools question`: the widely installed `pi-code` package
registers a tool by that name which, in the mode this app drives, answers itself
with "UI not available" without anybody being asked — and a model offered two
question tools sometimes picks the one that cannot work.

**A card that can no longer be answered says so.** If the agent gives up, or the
turn is stopped, or the conversation is closed, the card stops offering buttons
and reads *"The agent stopped waiting for an answer"* — which is a different
statement from *"Skipped without answering"*, and the app no longer prints the
second one over the first. A question you skip on purpose still reads as
skipped.

### Antigravity CLI: what was checked, and what was not

The whole runtime is driven through one entry point — `agy --print
--output-format stream-json` — and everything the WebUI claims about it was read
off live runs of agy 1.1.8 rather than from a schema. Each turn is its own
process; `--conversation <id>` is what carries the conversation between them.

Watched working:

| Claim | How |
| --- | --- |
| Replies arrive as they are produced | a step arrives `ACTIVE` with the opening of the reply and `DONE` with the rest, and the two concatenate into the run's own final text |
| Commands, edits and searches show as cards, with output, duration and errors | a turn that read a file, edited it and created another |
| Work it hands to an agent of its own appears in **Agents** | a delegation reported as a `subagent` step, carrying the role and the prompt it was given |
| Tokens per turn, thinking and cached input included | the run's own totals, checked against the sum of its steps line by line |
| A refusal explains itself | the auto-denial, in the conversation, naming the command and the way to allow it |
| The model list is the CLI's own | `agy models`, one id per line |
| Reopening a conversation and carrying on in it | the app restarted, the conversation resumed, and the agent answered from history without going back to the file |
| The folder you picked is the folder it works in | `pwd` and a file read, in a directory agy had never seen |
| A first launch in an unseen folder reaches a usable session | the terminal surface, past the trust question, with the prompt drawn |
| An attached file reaches the agent | a PNG dropped into the composer, opened by the agent with `view_file` at the path it was saved to, and the product name read out of the pixels |
| A skill picked from the `/` menu runs | `/release-check` in a project holding `.agents/skills/release-check/SKILL.md`, answered with that skill's own token |
| A skill above the working directory is found | the same, invoked from `<repo>/packages/web` against a skill at `<repo>/.agents/skills/` |

Not offered, because the runtime does not provide it:

| Not offered | Why |
| --- | --- |
| Diffs | `replace_file_content` reports its `TargetFile` and nothing else — no old text, no new text, no hunk. A diff here would be one this app computed, not one the agent reported. |
| Cost | Nothing in `init`, in any step or in the result prices a turn. The meter says *cost not reported* rather than showing a zero. |
| Approval prompts | Headless, it cannot stop and ask. See [Approval mode](#approval-mode). |
| A plan or todo list | No step type carries one. |
| Its own slash commands | Forty of them, all belonging to its terminal UI, and it interprets none in this mode. `/agents` — which the CLI answers instantly at its own prompt — went to the model instead and came back with 18,441 tokens of prose *about* subagents. The menu offers what an Antigravity conversation can really run instead: your skills, and this app's own `/clear`, `/new` and `/reset`. |
| An account or plan reading | Its terminal UI shows the plan in its header; none of that reaches the headless stream. |

**Attachments reach it by path.** agy has no attachment flag and no `@file`
mention syntax — `@notes.txt` in a prompt arrives at the model as literal text.
What it does have is a working directory it can read, and every upload this app
accepts is written *inside* that directory, at `.cc-web/attachments/`. So the
paths are named at the end of the prompt and the agent opens them with its own
tools. That covers images as well as text: a PNG attached in the composer was
opened with `view_file` and the product name and version read out of the pixels.

**The `/` menu lists your skills and this app's commands, not agy's.** agy's own
forty are absent on purpose — it interprets none of them in this mode, and
offering one would spend a turn's tokens producing a paragraph about what it
would have done.

What it *does* act on is a **skill** named in the prompt, and that is what the
menu is for. A skill written to `.agents/skills/release-check/SKILL.md` and
picked from the menu made agy open that `SKILL.md` and answer with the token the
skill specifies.

Every directory the menu reads was checked by planting a skill in it and asking
agy which ones it could see. All four spellings of the workspace root it
documents — `.agents`, `_agents`, `.agent`, `_agent` — are live, as is a
`plugins/<name>/skills/` folder under any of them (agy does **not** namespace a
plugin's skills, so they appear under their own names). The workspace roots are
searched **up to the repository root**, the way agy searches them, so a skill at
the top of a monorepo is on the menu of a session opened three directories down.
Personally-installed skills come from `~/.gemini/config/skills` and
`~/.gemini/config/plugins`.

Two things are deliberately left off. agy's own **built-in** skills, because
only one of the three is actually live — `/antigravity_guide` answers from the
skill, `/permissioned-github` answers "no such skill", and
`/agy-customizations` quietly opens the wrong file — and two undeliverable
entries to gain one documentation skill is the wrong trade. And skills reached
through agy's **`skills.json` / `plugins.json`** pointer files, which can name
any directory on disk and chain through `inherits`: those work in agy and will
not appear here. That is the menu under-reporting, which is the safe direction,
but it is worth knowing if your project uses one.

`~/.agents/skills` is not on the list either, though pi and grok both read it —
agy's personal root is `~/.gemini/config`. The exception is a home directory
that is itself a git repository with the session opened underneath it: there the
workspace walk passes through `~/.agents` and those skills *do* appear, which is
correct, because agy loads them there too.

Alongside them, `/clear`, `/new` and `/reset`: this app intercepts those itself
and never sends them to any runtime, so they work here exactly as they do
everywhere else.

**Not verified: what a sign-in failure looks like.** The credentials on the
machine this was built on could not be taken away for a test — clearing `HOME`
was not enough, and the runs kept succeeding. A run that fails for any reason
reports `status: "ERROR"` with the CLI's own sentence, and the app puts that
sentence in the conversation verbatim (a bad model id, which *is* reproducible,
comes through that way and reads *"model zzz is not recognized as a known model
…"* followed by the list it does have). A sign-in failure is expected to arrive
on the same channel, but nobody here has watched one, and this is the sentence
saying so.

### Watching a workflow

The **Agents** panel lists everything a conversation has delegated: subagents,
and workflows. A workflow row says how many agents the run holds and how many
are still going, because a workflow is not one worker but a structure — named
phases in order, with several agents running inside each.

Opening one shows that structure. The phases in the order the run declared them,
each marked *not started*, *running* or *finished*; under each, the agents it
started, each with its own state and what it is doing right now — the tool it
last reached for while it works, what it returned once it is done, and the
failure if it broke. Across the top: how many agents are running, queued, done
and failed, out of how many, and which phase the run is currently in. It all
moves while the run moves; nothing needs reopening, and the whole structure
stays readable afterwards, above the final output.

A failed agent is red on its own row with its error spelled out — you do not
have to open one to find out something went wrong. Opening an agent adds what it
was asked to do, its model, what it spent in tools, tokens and time, and what it
came back with. Phases are open by default and fold shut one click at a time,
for a run large enough to want that.

**A run that fails says so everywhere, and tells the conversation.** The row
reads *failed*, the popup title reads *failed*, and the chat gets a message with
whatever reason the runtime gave — a usage limit, a runtime error, a throw
inside the script. You are told rather than left to find it: a workflow can run
for twenty minutes after the turn that started it is over, and the notification
a failed turn raises is raised for this too.

A failed *agent* is not a failed run. A workflow that returned a result still
reads as done however many of its agents died, because agents inside one fail by
design — a thrown agent resolves to nothing rather than stopping the run, and a
script that probes for failures expects some. What their failure gets is a count
in red beside the run, and the phase they died in marked failed. Only the run's
own verdict turns the badge red.

**Only Claude Code reports workflows**, and only Claude Code has the concept.
The phase and agent states here are derived from what the agents themselves
report rather than from the tool call that launched the run — that call returns
as soon as the run is launched, long before it finishes. A runtime that reports
no structure gets the single activity line and the run's output, as before;
nothing is stubbed for a runtime that has no workflows to report.

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
| Antigravity CLI | **the size only** — every step's usage carries a `thinking_tokens` count and no event anywhere carries a word of the reasoning | a live run on `gemini-3.1-pro-low`, 1.1.8 |

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
Code, Oh My Pi) volunteer their list as the session starts; Codex is asked for
its enabled skills through `skills/list`; Claude Code sends its own list with
the first turn. When that list arrives it *replaces* the stand-in in the
adapter.

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

Until that list arrives — and permanently for pi and Codex's older exec
fallback, which cannot report one — the menu is what is installed for the
session, read from the directories each runtime's own installer writes into.
Codex also always offers the app-owned `/clear`, `/new` and `/reset`, including
on a machine with no installed skills:

| Runtime | Read from |
| --- | --- |
| Claude Code | `.claude/skills` and `.claude/commands` in the project and in your home, plus the skills and commands of every enabled plugin |
| Grok Build | `.grok/skills`, `.grok/commands`, `.agents/skills`, and — as Grok itself does by default — your `~/.claude` directories |
| pi | `.pi/skills` and `.agents/skills` in the project, `~/.pi/agent/skills` and `~/.agents/skills` in your home |
| Codex | App-server's effective list (shared Agent Skills, enabled plugins and system skills included); fallback: `.codex/skills` and `.agents/skills` in the project, `~/.codex/skills`, `~/.agents/skills`, `~/.codex/prompts`, and Codex's system skills |
| Kimi Code, Oh My Pi | Nothing — both report their own list before the menu can be opened |
| Antigravity CLI | `skills/` and `plugins/` under `.agents`, `_agents`, `.agent` or `_agent` in the project **and in every directory up to the repository root**, and the same two under `~/.gemini/config` |

Each entry carries the description its author wrote in the skill's frontmatter.
An entry whose author wrote none is shown with none: a sentence invented here
would be a guess presented as documentation.

Two things this is not. It is a list of what is **installed**, not a promise
that the runtime will accept all of it — a runtime is free to refuse something,
and its own list is what settles the question. And it is scoped to the session:
where sessions run in per-user environments each one reads its own home, so the
menu never becomes a window onto what someone else has installed.

### Which model runs

The chip beside the composer both names the model in force and changes it. It
always accepts a typed name as well as offering whatever the runtime published,
because a model name can only be judged by trying it.

Four things can decide the model a conversation opens on, and they are consulted
in this order:

| Layer | Set from | Applies to |
| --- | --- | --- |
| **This conversation** | picking a model in the chip, or typing `/model <name>` | this conversation only, until it is cleared |
| **Your standing choice** | the same pick — a model you choose is remembered for that agent | every **new** chat you open on that agent |
| **The active runtime profile** | Settings → Runtime profiles, installer-only | every new chat on that agent, for everybody |
| **The profile's ladder rung** | the same page: which rung **Runs on** names | every chat on that agent, for everybody — see [Which rung the conversation runs on](#which-rung-the-conversation-runs-on) |

Below all four, the CLI is launched with no model flag at all and uses its own
default.

The chip names the rung beside the model when a ladder is what chose it, and the
line above the list says which of the four layers it came from.

**The picker says which of them is in force**, in a line above the list and on
the chip's hover, so a model pinned by a profile is visible as a pin rather than
appearing out of nowhere. Choosing **Use the default for this runtime** clears
the conversation's own choice *and* forgets your standing one for that agent, so
the next new chat falls back to the profile and then to the CLI's own default.
That is the only way back, which is why it is the one thing in the menu that
does more than set a name — an id typed with a typo would otherwise stay in
force for every new chat on that runtime.

**Your standing choice is per account and per agent**, stored on the server
rather than in the browser, so it travels between your phone and your desk.
Effort works the other way round — it is kept per browser — and the difference is
not taste: Claude, Codex and pi fix the model when the process starts, so a
preference held in the browser could only be applied *after* the launch, which
on Claude means a visible `/model` turn pushed into a conversation you have not
typed in yet. It is scoped to your account and never readable from another.

**A conversation already under way is never re-modelled.** Every chat records
the model its launch actually used, and that is what it comes back on: a
relaunch, a resume from the launcher and the recovery banner's restart all return
to the model that conversation was already using — including across a server
restart, which is the moment every open conversation gets relaunched. Changing
your standing choice, or the active profile's **Model**, affects the next new
chat and nothing that is open, and a conversation that launched with no model
flag at all keeps that answer too.

A **ladder rung is the exception**, and deliberately so: it is the profile's
standing answer to "which model runs this conversation" rather than an unrelated
edit, so a conversation running on a rung re-reads it on every launch and an
edited ladder also reaches conversations that are already open. That exception is
also what moves conversations older than the ladder onto it — all of them
recorded "launched with no model flag", and honouring that would have meant the
ladder never reached one of them.

The chip names that recorded model rather than the default, which is the
difference between describing this conversation and describing the next one. When
the two differ the line above the list says which model the conversation is
staying on, and then what a new chat would open on instead.

A **branch** opens on the model its source was actually running, for the same
reason: the context estimate that decided whether the branch fits was measured
against that model's window.

Two deliberate omissions. A **terminal** session takes no standing choice: it
runs the CLI's own interface, where the model is yours to change inside the tool
and nothing here could keep a preference in step with it. (A profile's model and
its ladder rung *are* applied at launch — that is the one thing decided before
the interface exists.) And the **launcher screen** — the
one before a chat has started — has no model control, so the source line is only
readable once the conversation is open.

A standing choice is only recorded from a name the runtime is known to take:
either the switch applied live, or the name is on the list the runtime published.
A runtime that publishes no list at all (Claude is one) has nothing to check
against, so a name typed there is taken at face value — the same rule the effort
control applies to a runtime that publishes no ladder.

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
| Antigravity CLI | `low` `medium` `high`, and only the ones the model in use has an id for | usually the model id itself — see below | from the next turn |

**Antigravity spells the level inside the model name, so the control switches
models.** Its `--effort` flag exists and takes `low`, `medium` or `high` — but it
is refused whenever a model is named: `--model gemini-3.6-flash-low --effort
high` answers *"conflicts with --effort=high"*, and `--model claude-sonnet-4-6
--effort high` answers *"--effort is not supported for model"*. What `agy models`
publishes instead is one id per level — `gemini-3.6-flash-high`, `-medium`,
`-low`. So the levels offered are exactly the sibling ids agy printed, and
picking one moves the conversation onto that model for its next turn.
`gemini-3.1-pro` has only `high` and `low` ids, so only those two are offered;
`claude-sonnet-4-6` has none, so no control appears at all. A conversation that
pins no model gets the flag itself, which is the one case agy accepts it in.

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
fighting over two ladders that have nothing in common. (The model above is
remembered the same way but on the *server*, per account — see
[Which model runs](#which-model-runs) for why the two differ.)

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

### Finding a conversation again

The button beside **Search transcript** at the top of the chat surface opens
**every conversation you have** — on a phone it is in the actions sheet, beside
the same search. It lists conversations, not sessions: the ones with no tab open
and the ones nothing is running are in it too.

Conversations are grouped under the project folder each belongs to, newest first
inside a group, with the groups ordered by their own newest conversation — so the
folder you were working in this morning is at the top. A project with no
conversations does not appear; this is a list of conversations that happen to be
filed under folders, not a folder browser.

Each row is **what was asked** — the first thing you said in it, which is what
you actually recognise a conversation by — with the agent it ran, when it was
last active, and whether it is running now. Two things are said before you pick
one rather than discovered afterwards: whether it comes back with **approvals
bypassed**, and whether its agent can carry on from where it left off or is
meeting the transcript for the first time (`transcript only`).

Typing narrows the list on what was asked, the conversation's name and its
folder. A group with no match drops out, so a search across a dozen projects
stays a short list. Groups fold, and searching opens them all.

Picking a conversation **joins** it if something is running it, and otherwise
brings it back with its transcript — handing the agent its own context where the
conversation recorded one.

Past 400 conversations the list describes the most recent ones and says so.

### Approval mode

Whether a web chat asks before each tool call is settled by one rule, and every
way into a conversation follows it:

- A conversation that is **beginning** takes your **Web chat approvals**
  preference from Settings. That covers a launch from the runtime launcher, a
  branch cut from a turn, *Start a new chat* on the recovery notice after a
  server restart, and `/clear` inside a live conversation.
- A conversation that is **continuing** — resumed from the launcher, opened from
  the conversations list, or brought back with *Resume this conversation* —
  comes back in the mode it was already running in. The preference is not
  re-read in either direction, so switching it on later cannot widen a
  conversation that chose to ask, and switching it off cannot take the mode away
  from one that is running without prompts.
- Anything missing or unreadable means **ask**. That includes a conversation
  resumed with nothing recorded about its mode.

The preference belongs to your account, not to the browser you set it in, so it
holds on a second device and in a second browser. It is stored on the server and
is never taken from the page at launch time: the launcher's chat button reports
what the server is going to do rather than requesting it.

Every conversation says which mode it is in, on the chip beside the input box and
in its header, for as long as it is on screen — including while nothing is running
it. It is said there rather than in the transcript: the mode is a standing fact
about the session and not something that happened in the conversation, so a chat
that has just opened is empty and the first prompt is turn 1. The two buttons on
the recovery notice name the mode each of them lands in, so a bypass is never
restored, or dropped, in silence.

**pi is the exception, and the app says so rather than pretending.** pi's chat
adapter has no approval channel at all — its `--approve` trusts project-local
files for the whole run instead of gating individual tool calls — so a pi
conversation runs its tools without asking whichever mode the rule computes.
Its opening line says `this runtime cannot ask` instead of claiming a boundary
that is not there.

**Antigravity CLI is the other exception, and it is a sharper one.** Driven
headlessly the CLI *cannot stop and ask*: a tool that needs the `command`
permission is refused on the spot and the run continues around it. It is not
that nobody answered — nobody was asked. So the choice has to be made when the
conversation starts, and the two modes mean:

- **Ask first** — shell commands are refused as they come up and the turn carries
  on without them. Each refusal gets its own entry in the conversation naming
  what was refused and how to allow it, so it never arrives as an unexplained
  failure. File edits inside the workspace are *not* affected: they go through in
  this mode, which was measured rather than assumed.
- **Approvals bypassed** — `--dangerously-skip-permissions`, and nothing is
  refused.

`--mode accept-edits` and `--mode plan` are deliberately not wired to anything.
Both parse and neither changes what actually happens: three runs of the same
"write this file" prompt — no flag, `accept-edits`, `plan` — all reported
`request-review` and all three wrote the file.

The terminal surface's own **No prompts** button is a separate, per-launch
choice on a different surface, and is not covered by this preference. In the
terminal Antigravity *can* ask, and does: it shows its own four-way approval
prompt inline, the way it does outside this app.

### Closing a conversation, and deleting one

**Closing** a conversation takes it off your screen. The record, the transcript,
whatever is running it and whatever shells were opened inside it all stay, and it
is still in the list above to be reopened — on this device or another one. A
conversation you closed stays closed here across a reload.

Closing a **terminal** still ends it. A shell is reached through its tab and
nowhere else, so one closed without being ended would hold a working directory
open with nothing in the app able to reach it again.

**Deleting** is the only way to lose a conversation. It is a separate action, it
asks first, and it takes the transcript, the usage record and any shells the
conversation owned with it.

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
(those turns were for a process that no longer exists), and the approval mode
the conversation you left was running in. The new one is a conversation that is
*beginning*, so it takes your **Web chat approvals** preference — the same
answer the launcher's chat button and the recovery notice's *Start a new chat*
would give it. See [Approval mode](#approval-mode) above.

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

### What each runtime tells you about tokens, cost and the context window

The header strip, the line under the composer and the **Status** panel all read
the same four figures, and every one of them is a figure a runtime actually
sent. Nothing here is estimated, averaged or priced from a table this app keeps:
if a runtime does not report something, the interface says **"not reported"**
rather than drawing a zero that looks like an answer.

The table below is an audit, not a promise. Each row was read off a capture in
`test/fixtures/chat/` or a live probe, and the captures are what the tests
replay.

| Runtime | Context window | How full it is | Tokens per turn | Cost | Read from |
| --- | --- | --- | --- | --- | --- |
| Claude | reported, per model | reported, from the last round trip | reported, four buckets | reported | `claude-model-usage.jsonl`, `claude-multi-turn-result.jsonl` |
| Codex (app-server) | reported | reported | reported | **not reported** — nothing in the schema prices a turn | `codex-appserver-text-turn.jsonl` |
| Oh My Pi | reported | reported | reported | reported, as a session running total | `acp-omp.jsonl` |
| opencode | reported | reported | reported | reported | `acp-opencode.jsonl` |
| Grok | reported, on `session/new` | reported, off the update envelope | reported | reported, per turn, in ticks | `acp-grok.jsonl`, `acp-grok-session-new.json` |
| pi | **not reported** — the provider is asked instead | reported | reported | reported | `pi-final-turn.jsonl` |
| Kimi | **not reported** — the provider is asked instead | **not reported** | **not reported** | **not reported** | `acp-kimi-tools.jsonl`, probe of 0.29.1 |

Two things follow from it that are worth knowing before you read a header:

- **A window can come from somewhere other than the agent.** Where a runtime
  publishes no window, the model's provider is asked for one, once per model,
  and the panel says which of the two you are looking at. An agent's own figure
  always wins — grok reports 512,000 tokens for `grok-build` where the nearest
  catalogue entry says half that. With no network, or with the catalogue turned
  off, a runtime in that position simply has no window and says so.
- **"Not reported" is only ever said after a turn has finished.** A conversation
  that has not run yet shows nothing, because nothing is known about it yet, and
  the two states are deliberately different: one means *this agent will never
  tell you*, the other means *hold on*.

## Runtime profiles

**Settings → Runtime profiles** controls how each CLI is launched. Nothing here
is tied to a vendor: a model is an opaque string passed through untouched, so
anything your CLI accepts — a hosted model, a gateway id, a local endpoint —
works.

A profile targets one runtime and carries five things, all optional:

| Field | What it does |
| --- | --- |
| **Model** | Passed as `--model <value>` to the CLIs that have the flag (all but Cursor Agent and Qwen Code). A chat conversation on an ACP agent — Grok Build, Kimi Code, Oh My Pi — has no flag to pass it on, so the value is applied over the protocol the moment the session opens, and again after anything that restarts it: `/clear`, a server restart, the unavailable banner. This is a **default, not a pin**: a conversation's own choice has always outranked it, and since 5.3.3 a user's standing choice does too — see [Which model runs](#which-model-runs) |
| **Extra arguments** | Appended after the app's own flags, so they win on CLIs where the last flag wins |
| **Environment** | Injected into the spawned process |
| **Capability tiers** | `floor` / `mid` / `high` / `top`, written into the runtime's own config |
| **Runs on** | Which of those four rungs the conversation itself answers from. Defaults to `mid` — see [Which rung the conversation runs on](#which-rung-the-conversation-runs-on) |

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

For pi, the *location* is worth spelling out. The obvious place to write —
`~/.pi/agent/agents/` — is exactly where a hand-written ladder lives, and there
is no flag to point pi elsewhere. So the app uses pi's own precedence instead:
agents resolve from `~/.claude/agents`, then `~/.pi/agent/agents`, then the
project's `.claude/agents`, then the project's `.pi/agents`, with later
directories winning on name conflicts. Writing into the session's project means
the app's tiers override yours *for that session* while your home directory
stays byte-for-byte intact, keeps applying to every pi session you run outside
this app, and any agent the app does not define — a `planner`, a `reviewer` —
still loads from there.

The generated directory carries its own `.gitignore`, so it never shows up in
`git status`.

### Which rung the conversation runs on

The four rungs above configure the helpers an agent delegates to. **Runs on**
names the rung the conversation *itself* answers from — the model that replies
to what you type. It defaults to `mid`.

That rung's model is used unless something outranks it. In order:

1. A model you picked in this conversation.
2. Your standing model for that runtime — what you last picked and kept.
3. A model typed into the profile's **Model** box.
4. **The rung.**
5. The runtime's own default, if the ladder cannot answer.

Where a ladder is configured and one of the first three is deciding instead, the
profile says so rather than letting a filled-in ladder look like a working one.
Every conversation names the model it is on, the rung that model sits on, and
which of those five supplied it.

If the rung you chose is blank, the nearest filled one is used — downwards when
two are equally near, because a ladder that cannot answer should not answer
expensively. If a provider refuses the rung's model, the session starts on the
runtime's own default and says so; it is then not on a rung at all, so there is
no rung to move up from either. If the ladder cannot be written through at all,
the session still starts, and the header says the ladder was not applied. Either
way the reason stays on screen for the rest of the conversation, on every screen
watching it rather than only the one that started it.

A ladder decides on the **first launch after upgrading**: nothing has to be
re-ticked or re-saved, and conversations that predate this move onto it when
they are next relaunched. Saving a profile also reaches conversations that are
already open, interrupting a turn in progress — only the ones actually running
on the rung, and only when the rung has changed.

Terminal sessions started from the app run on the ladder in the same way.
Escalation, below, is a conversation asking you a question, so it is chat only:
a terminal runs the CLI's own interface, which this app has no channel into.

### Moving up a rung

An agent that meets work beyond the model it is on can ask to answer from the
next rung up. The request reaches you as an ordinary approval, with the agent's
own one-line reason, and nothing moves until you allow it. Once the turn that
prompted it ends, the conversation goes back to its usual rung — a task that
spans turns asks again, which keeps the approval the real control on what this
spends.

**In a conversation with approvals bypassed, the move happens without asking**,
along with everything else that mode stops asking about.

Runtimes that take an MCP server get the tool that way. pi has no MCP support at
all, so it gets the same tool as a generated extension in the session's
`.pi/ccweb/`, loaded with `-e`. Where a runtime cannot change model mid-turn —
pi runs one process per turn — the agent is told the stronger model picks up on
its next turn, rather than being told it is already on it.

### The profile wins

**A runtime configuration file this app manages is replaced, even if you wrote
it.** Earlier versions did the opposite: a file without the
`managed-by: code-agents-webcli` marker was left alone and the tier was reported
as not applied. That was reversed deliberately. A ladder that decides which model
answers every turn, silently doing nothing because of a file left in a project a
year ago, is a worse failure than an overwrite.

So: the profile is the single source of truth for the runtimes it covers. What
was there is copied once to `<file>.bak` beside it and the replacement is
reported in the dialog, but **nothing in the app restores it** — if you maintain
a ladder outside this app for use outside this app, keep it somewhere the app
does not write, which for pi means your home directory rather than the project.

Escalation also spends real money on a more expensive model. The approval step is
the control on that.

## Working directories

A session runs in the folder you pick, and that folder is what the session
record, the transcript and pasted-image paths all refer to. The file browser is
bounded by the working directory chosen during
[setup](configuration.md#first-run-setup) — only that directory and its
subdirectories are reachable.

**What an agent may read and write is that same boundary**, not the one folder
the conversation started in. It matters for the ACP agents (Kimi Code, Oh My Pi,
Grok Build), which do not open files themselves: they ask the app to, and the
app decides. Confined to the session's own directory, a conversation working
across a git worktree of its own repository — one directory over, and somewhere
the folder picker would happily have sent it — had every read of it refused,
while the agent's own shell read the same file freely and wrote it back through
a script. What is still refused is unchanged: anything outside the browsable
area, and anything belonging to another account. The OS temp directory stays
reachable, because an agent's write tool and its own shell hand files to each
other through it.

Every session on the host runs as the **same OS user** — the one running the
server. There is no per-user sandbox. See
[the security note](github-oauth.md#the-allow-list).
