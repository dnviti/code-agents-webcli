# Usage accounting

Durable, per-user history of what agent work has cost: tokens, dollars,
round trips and tool calls, filed as one row per turn and kept forever. This is a
different thing from [Usage analytics](analytics.md): that page reads
Claude Code's own local transcripts to estimate a five-hour billing window for
one CLI, and disappears with the file. This page is written by the server
itself, for every runtime, and survives the session, the server restart, and
even the deletion of the conversation the work happened in.

## What is recorded, and what is not

Every turn files: who ran it (user id and login, denormalised so the row
outlives the account), which agent and model, when it started and ended, how
it ended, how many tool calls it took, the token and cost figures the runtime
reported, and which tool names were called how many times.

What is never recorded: anything you or the agent said. No prompt text, no
reply text, no file contents, no tool arguments, no tool output. The
accounting record and the conversation transcript are deliberately separate
things that happen to share some numbers — a record that quoted the
conversation would just be a transcript wearing a different name, kept around
after every rule protecting the real one had stopped applying to it.

## What a turn is

**One user request and everything the agent did about it** — the span from a
user's message to the point the runtime declares the turn over. One row of
`usage_jobs` is one turn, which is why there is no turn count stored on the
row: counting turns is counting rows, and every runtime here has that
boundary, so the figure means the same thing whichever agent ran the work.

What a message typed *while the agent is working* belongs to is decided by
where it was delivered, and it is recorded when the work runs because it
cannot be reconstructed afterwards:

- Sent into the turn already running, to redirect it (the "send now" control on
  a queued message) → it **continues that turn**. Steering the current work is
  part of that work, not a new request.
- Left in the queue until the current turn finishes → it is **its own turn**,
  counted when it starts. It was never part of the work that was running.

Two counts sit inside a turn:

- **Model turns** — round trips to the model, and *only* where the runtime
  counts its own: Claude's `num_turns`, or a per-model call count. Where nobody
  says, it is `null` and reads as "not reported". It used to be counted as the
  number of assistant messages the transcript showed, which is a property of
  how an agent chops up its output rather than of the work: identical work
  filed 1 under an agent that answers in one stretch and 6 under one that
  separates its thinking from its answer, and those were the figures the
  dashboard compared agents by.
- **Tool calls** — the number of tool blocks the transcript opened. A tool
  that is re-announced once its streamed arguments finish parsing (Claude does
  this) is counted once, not twice.

A turn that never got a reply — the process died, the session was stopped, the
runtime reported an error — is still filed, with an outcome of `interrupted`
or `error` rather than being dropped. A turn the process died in the middle of
took exactly as many round trips as it got to; that is a fact about the crash,
not an absence of one.

The same definition drives the conversation: the turn strip, the index beside
it and the accounting all group on the turn id the session stamps, so the
count you read next to a conversation and the count in the statistics are the
same number read twice. The index is served from the recorded log rather than
assembled from whatever the browser has loaded, so it lists every turn from the
first one still on disk however little of the conversation is on screen, and
every entry is titled with the user's own ask — a turn with no prompt behind it
says so rather than borrowing a line from the model.

## The unit you read: the conversation

A job is the unit that is *recorded*. It is not the unit anybody thinks in. A
morning's work in one chat tab is one piece of work — "this conversation, about
this thing, cost this much" — and filing it as forty rows makes the tab's own
record less usable the more the tab is used.

So the dashboard's history lists **conversations**, one row per chat tab, and
everything spent in a tab sums into that one entry:

- **Compacting the conversation does not start a new entry.** Neither does
  clearing it, nor starting a new one inside the same tab. Those replace the
  *runtime's* conversation — a new native session id — and the tab goes on
  being the tab.
- **Closing the tab and reopening it, or coming back after a server restart,
  continues the same entry.** The id it is keyed on is the session's own,
  which is durable; a job carries it whether the session row still exists or
  not.
- **A conversation that used more than one agent or model says so**, rather
  than being filed under whichever one happened to be first.
- **The requests are still there**, one level down: open a conversation for its
  own jobs, or take the Requests view to browse them across conversations.

Nothing was migrated to make this work, and no earlier period is counted
differently. The tab's id has been on every job row since the table existed, so
grouping on it reaches back over the whole history.

Two tabs are never merged into one entry because they share a project — the
by-project breakdown is what answers that question, and it goes on summing
jobs. The headline totals and the breakdowns are the same rows grouped other
ways, so they agree with the conversation entries by construction.

## The per-agent honesty table

Not every runtime reports the same things, and the app does not pretend
otherwise. The figures below come from each adapter's own `capabilities`
declaration under `src/server/chat/adapters/`, which is the same source the
adapters use to decide what they can promise the rest of the UI.

Turns and tool calls are always known — they are measured here, from the
boundary and the blocks every runtime produces. Model turns are the runtime's
own figure or nothing at all, which is why they have a column of their own.

| Agent | Tool calls | Model turns | Tokens | Cost | Model |
| --- | --- | --- | --- | --- | --- |
| Claude | counted here | reported (`num_turns`) | reported | reported (see below) | reported, per message and per model |
| Codex (app-server) | counted here | **not reported** | reported | **not reported** — nothing in the schema prices a turn | reported, per session |
| Codex (`exec` fallback) | counted here | **not reported** | **not reported** | **not reported** | **not reported** |
| pi | counted here | **not reported** | reported | reported | reported, per message |
| ACP agents (Grok, omp, kimi, and others behind the ACP bridge) | counted here | only where a per-model call count arrives | reported | reported — Grok's in ticks, see below | the runtime's current selection |

A figure a runtime never reports is stored as `null` and shown as
**"not reported"** — never as zero. Those are different facts: a job that
cost nothing and a job whose cost nobody measured look the same on a naive
total, and this app keeps them apart all the way to the database. Every
aggregate the store returns carries, alongside its totals, a count of how many
of the turns in it actually contributed a token figure, a cost figure or a
round-trip count (`tokensReportedTurns`, `costReportedTurns`,
`modelTurnsReportedTurns`), so "$4.10 across 28 of 40 turns" is the shape of
the answer, not "$4.10" on its own. The effort panel averages model turns over
the turns that reported one, never over all of them — reading a silent runtime
as zero would have put it at the top of every efficiency comparison on the page
for having reported nothing.

### Figures recorded before this rule

The turn count needs no correction and older periods are directly comparable:
every row ever written was already one prompt, so the corrected count is a
recount of nothing. The model-turn column is empty for everything recorded
before it existed — the old figure was the discarded meaning, and copying it
across would make an inference indistinguishable from a measurement in the one
place built to keep those apart.

## A job's token total

The Tokens column, the headline total and every breakdown read one number per
job. Where it comes from is worth being precise about, because most runtimes
do not hand one over.

**A total the runtime reported is always used as it stands.** Only where there
is none are the parts added, and only the input, the output and the two cache
buckets — never the reasoning tokens, which are a slice of the output rather
than an addition to it. Both halves of that rule are read off what the agents
actually send: grok reports 7210 input, 1893 output, 41000 cache read and 412
reasoning, and calls the total 50103, which is the first three and not the
fourth. codex is the other way round — its cached input is counted *inside* its
input — and it always reports a total, so the sum is never reached for it.

This matters most for Claude, which reports its four buckets on every message
and a total on none of them, and where the cache is routinely 99% of the
figure. Until this rule existed the history filed nothing for those jobs and
showed **"not reported"** beside a cost that had reported fine.

A job where the runtime reported *nothing* still reads "not reported", and an
agent that cannot report usage at all still reads as `n/a`. Adding up nothing
gives nothing, not zero.

**Old history was corrected in place.** The parts were always recorded, so
jobs filed before this derived their totals from what was already in the row,
once, on the next start — no period of the dashboard is built on a different
rule from any other, and nothing was estimated to get there.

## Which model actually ran

A model name in a spend record is only worth having if the runtime said it.
There are two quite different claims that can hide behind one: the model this
app **asked for** (`--model`, a flag) and the model that **ran** (whatever the
runtime reports back). Only the second is a measurement, and only the second
is recorded. Where a runtime has not confirmed a model yet, the conversation
shows none rather than showing the request — a request rendered plainly reads
as a fact, which is worse than a blank.

Each of these was established by running the installed binary, not by reading
its documentation:

| Agent | What it says the model was | When | Publishes its list? |
| --- | --- | --- | --- |
| Claude | `system/init.model`, every assistant `message.model`, and `result.modelUsage` keyed per model | start, per message, turn end | no — the picker keeps its typed box |
| Codex (app-server) | `thread/start` → `model`, which it names even when nothing was requested | session start | **yes** — `model/list` over the protocol |
| Grok | `models.currentModelId` when the session opens, and `_meta.usage.modelUsage` on the reply that ends a turn — keyed per model with tokens, `modelCalls` and a cost in ten-billionths of a dollar | session start, turn end | **yes** — in that same reply |
| pi | every assistant `message.model`, with its provider | per message | **yes** — `pi --list-models` |
| ACP agents (kimi, omp, …) | the model select's `currentValue` | session start, and on a switch | **yes** — in the select itself |

Two consequences worth stating plainly:

- **Claude's billing name is not its display name.** `modelUsage` is keyed
  `claude-opus-5[1m]` — the same model with a context-window suffix — while the
  messages say `claude-opus-5`. The canonical name wins, so the conversation
  and the usage view cannot disagree about what ran.
- **Grok used to report nothing at all.** Its model was neither on the session
  line nor on a message, so every Grok job was filed against no model and the
  by-model view had a nameless row absorbing all of it. The name was there the
  whole time, at the end of the turn, in the one place nothing was reading.
  That map is read now, and it brought the only round-trip count Grok publishes
  anywhere with it — `modelCalls`, which is why the Model turns column stopped
  saying "not reported" on every Grok row.

### A turn that ran on more than one model

A subagent runs on its own model; a runtime can fall back after a failure.
Claude and Grok both report this, as extra keys in the same `modelUsage` map,
and pi says it by naming a different model on a later message in the same turn.

Where that happens the job is **not** filed as though one model did all of it.
`usage_jobs.model` still names the model that answered — that is what to call
the conversation — and a `usage_job_models` row is written per model carrying
that model's own tokens, cost and round-trip count as the runtime reported
them. The by-model breakdown reads those rows where they exist and the job's
own figures where they do not, so it still adds up to exactly the headline
total.

Three things deliberately stay unattributed in that split:

- **Tool calls.** No runtime says which model asked for which tool, so a split
  job contributes no tool calls to any model rather than a made-up share.
- **Reasoning tokens.** Reported for the turn, not per model.
- **Effort by model.** That panel is about turns, and a turn is one prompt; it
  groups by the model that answered.

Claude's per-model cost gets one correction on the way in. Its `total_cost_usd`
is cumulative (see below) and `modelUsage.costUSD` is a slice of that same
counter, so the *shares* are taken from the report and the turn's own cost is
what is divided by them. The models in a turn can therefore never add up to
more than the turn did.

### Choosing a model

Where a runtime publishes the models it accepts, those are offered as a menu:
Codex over its protocol, the ACP agents in their own model select, and Grok
and pi through the command each of them ships for it (run once per process and
cached, the same idea as the installed-commands fallback for the `/` menu).
Where a runtime publishes nothing — Claude — the picker keeps its typed field
and says the runtime listed nothing, rather than showing an empty menu.

The field doubles as a filter, because pi lists several hundred models and an
unfiltered menu that long is a scroll nobody reads. A name that matches
nothing listed can still be sent: a runtime's list is what it advertises, not
a promise about what it will refuse.

## The context window

The most useful thing to know mid-session is how much of the model's context is
left, and it is the one figure a wrong answer is worse than no answer for: a bar
that is confidently under-full invites you to keep going up to a limit that is
not there. So nothing in this product writes down how big any model is.

Capacity comes from one of two places, in this order:

1. **The agent said so.** Claude reports it in `modelUsage[…].contextWindow`,
   codex in `tokenUsage.modelContextWindow`, omp and the other ACP agents in
   `usage_update.size`, and grok publishes one per model in its `session/new`
   reply. An agent's own figure always wins — it is describing the model it will
   actually run.
2. **The provider says so.** pi and kimi report no capacity at all, but both
   name an OpenRouter model id (kimi's are literally `openrouter/<id>`), so the
   provider they are already talking to is asked what its own models are. The
   catalogue is fetched once and matched on the exact id — never on a
   neighbouring name.

That second step is the one outbound request this feature makes. Nothing about
the conversation goes with it: the whole catalogue is fetched and matched on
this machine, so the provider is never told which model is being asked about.
Set `CODE_AGENTS_WEBCLI_NO_MODEL_CATALOGUE=1` to switch it off — capacity is
then whatever the agents report, and unknown otherwise.

If neither can answer, the reading says **"size unknown"** and draws no bar.
That is the same rule as everywhere else here: an absence is reported as an
absence.

Why the order matters, concretely: grok reports **512,000** tokens for
`grok-build`, while the nearest catalogue entry (`x-ai/grok-build-0.1`) says
**256,000**. Half. Matching loosely would have put that number in front of a
user with no way to tell it was wrong.

**Occupancy** is the *last* request's own figures — input + cache read + cache
write + output — not the turn's totals. A three-round-trip turn measured today
totalled 105,027 tokens across its requests while only 37,387 were ever in the
window at once: a bar built on the totals would have read 10.5% full where the
truth was 3.7%.

Where that figure comes from differs per agent — Claude's own last `result`,
codex's `tokenUsage.last`, `usage_update.used` from omp and opencode — and Grok
is the one that puts it somewhere the protocol does not name: `_meta.totalTokens`,
on nearly every `session/update` it sends — 287 of the 289 captured; the
exceptions echo back what the user typed, which is why a reading that is absent
is skipped rather than taken as zero. It sends no `usage_update` whatsoever, so until that was read a Grok
conversation had a 512,000-token ceiling with nothing measured against it: no
percentage, no bar, and no 80% warning it could ever reach. The reply that ends
one of its turns carries both figures a line apart — `_meta.totalTokens` for the
last request, `_meta.usage.totalTokens` for the turn — and on the turn measured
here they are 16,637 and 65,943. Filing the second as occupancy would have been
four times worse than the blank it replaced.

The reading follows a mid-conversation model switch: everything known about the
old model is discarded on the switch rather than carried forward, so moving from
a million-token model to a 200,000-token one immediately reads against the
smaller ceiling.

Above 80% the display says so in words and says what is left; above 90% it says
it more urgently. The header strip, which is a fixed width, carries the colour
and the percentage only — the sentence is in the status panel and in the
expanded meter, because a warning that overflows its own row at 95% is one
nobody can read at the moment it matters.

## Cost is a list price, not a bill

Every runtime prices a turn the same way: the tokens it moved, at the
provider's published API rates. It does that whether or not the account behind
it is paying by the token. On a subscription — Claude Max, ChatGPT Plus, a
Grok plan — the bill is flat and monthly, and no job in this ledger was ever
charged for individually. The figure is still worth recording, because it is
the only comparable measure of how expensive a piece of work was, but it
answers *what would this have cost through the API*, not *what did you pay*.

Nothing in any adapter's event stream says which of the two an account is on:
the runtimes report a price, not a billing relationship. So the dashboard
states the caveat in plain sight under the totals rather than trying to detect
a plan and getting it wrong. Anyone reconciling these numbers against a
provider's invoice should expect them not to match, and on a subscription
should expect them not to be related at all.

## The reporting-convention problem

Runtimes disagree about what a usage figure even means, and treating them all
the same way silently multiplies somebody's bill.

Claude, pi and the ACP agents — Grok among them — report a figure **for the
message or the turn**. Those add up: sum every turn's tokens and cost, and the sum is the
conversation's total.

Codex and the ACP agents' `usage_update` instead report **a running total for
the whole conversation**, on a standalone event that stands apart from any one
turn. Summing those the same way would charge every earlier turn again on
every later one — the second turn of a chat would show roughly triple its real
cost, the tenth far worse. For these, a job is credited only what the running
total *grew by* while that job was open: the reading at the start of the job
is subtracted from the reading at the end.

This distinction is enforced in one place, `src/server/chat/usage-accounting.ts`,
so the number filed to the database and the number the live in-conversation
meter shows come from the same reading of the same events rather than two
implementations that can drift apart.

### Claude's cost is cumulative even across a process restart

Claude's `total_cost_usd`, specifically, turned out to be cumulative for the
whole conversation rather than per turn or per message — and this was not
read off any Anthropic document, because none was found that says so. It was
established by probing the running CLI directly: two prompts through one
process reported `0.1286` then `0.1790` while the token counts held steady at
2 in / 6 out both times, and a third prompt through a fresh process that
`--resume`d the same conversation continued from `0.1790` rather than
restarting at zero. The counter survives the CLI restarting; only an
in-process variable would not.

Left uncorrected, this double-charges a conversation on every turn after its
first — turn two shows roughly its own cost plus turn one's, turn ten shows
nine turns' worth of history layered under its own. The fix lives in the
Claude adapter itself (`turnCost` in `src/server/chat/adapters/claude.ts`),
which subtracts a watermark — the highest cumulative figure seen so far,
seeded from whatever the conversation was already billed when the process
started — before the figure goes anywhere. Fixing it in the adapter rather
than in the accounting layer keeps a single invariant for every consumer
downstream, the live cost meter included: cost on a turn is that turn's own
cost, full stop.

This was also a user-visible bug in its own right, independent of the
accounting feature: before this correction, the live in-conversation cost
meter over-counted on every turn after the first.

### Claude repeats a turn's tokens on the way out

The `result` message that ends a Claude turn carries a `usage` object, and that
object is the whole turn's aggregate — every token in it has already been
reported by the turn's own messages as they streamed. Everything downstream
adds up what a turn reports, so passing it through counted each of those tokens
twice: the live meter, the composer's session line and the recorded history all
showed double, consistently enough that nothing looked wrong.

The adapter now reports only the part the turn's messages did not: usually
nothing, and the full aggregate for a turn that failed before its first message
and so has nothing that could have been counted twice. The cost on the same
event is cumulative in a different way and is corrected separately, just above.

### Grok quotes cost in ticks, and it is per-turn

Grok never sends a dollar figure. It sends **ticks** — an integer count of
ten-billionths of a dollar, which is how you carry money without floating point.
The ratio is not documented; it is read off a run that reported the same turn
both ways, as `total_cost_usd: 0.02338` and `total_cost_usd_ticks: 233800000`.
The app converts once, in the adapter, and stores dollars like everyone else.

Whether that figure was per-turn or cumulative was an open question here for a
while, and for good reason: Claude's has the same shape and turned out to be
cumulative, which over-counted every turn after the first until it was fixed.
Grok's is **per-turn**, confirmed by two consecutive turns in one session —
163,726,000 ticks, then 34,682,000. A cumulative counter cannot go down. So the
figures sum, which is how the app already treated them.

The cost arrives in `_meta.usage` on the reply to `session/prompt`, not in the
`usage` field the other ACP agents use. Reading only the field the others use
filed every Grok turn as free.

### A resumed conversation, and where its counter starts

A running total raises a second question the moment a conversation is picked
back up: does the runtime's counter carry the history across the resume, or
does it start again from zero? Getting it wrong is expensive in both
directions — assume it carried when it restarted and a turn is billed nothing;
assume it restarted when it carried and one turn is billed the entire
conversation.

No runtime documents which it does, and they do not all agree, so it is decided
from evidence rather than declared. On resuming, the accounting layer looks up
what this conversation has already been *recorded* as consuming. If the first
reading from the new process comes back at or above that figure, the counter
plainly carried its history and the recorded figure becomes the floor; if it
comes back below, the counter plainly restarted and the floor is zero. A
conversation starting fresh has recorded nothing, so the same rule gives zero
without needing a special case.

### A turn the runtime said nothing about

For a running-total runtime, a turn during which no new reading arrived is
recorded as **not reported** — not as zero. A counter that did not move is not
a measurement, and filing it as one would be exactly the dishonesty the rest of
this design is built to avoid.

The consumption that turn represents is not lost: it is still inside the next
reading, and lands on whichever job was open when that reading arrived. That is
as precise as a cumulative counter allows, and the alternative — inventing a
split — would be a number nobody could reconcile against anything.

### Conversations that predate this feature

On an install that is upgrading, conversations already in progress have a
cumulative counter that is already somewhere well above zero, and nothing here
knows how far. The first turn after such a resume therefore reports **no cost**
rather than a figure: the first reading is adopted as the watermark, and the
turn is recorded as unknown. Charging one turn for a fortnight of earlier work
would be a confident wrong answer, where "we cannot tell" is a true one. From
the second turn onwards the figures are exact.

### Which project a job belongs to

A project is the **name of the folder the session was working in** — the same
label the session tab, the session list and the conversation header already
carry. It is read when the job is filed, from the folder the session is pointed
at at that moment.

Two consequences, both deliberate:

- **A session re-pointed at another folder keeps its earlier work where it
  was.** Attribution is a fact about where the work ran, not about where the
  session ended up. Resolving it at reporting time instead would rewrite last
  month's figures every time somebody moved a folder.
- **Two folders with the same name in different parents are one project.** The
  grouping is by name because that is what "which project is this spend on" is
  a question about — grouping by absolute path splits one project across every
  machine and every checkout it was ever opened from. If you have `api` under
  two different customers, give the folders distinguishable names.

Work recorded before this existed has no project on it, and none is invented
for it. It groups under **unattributed** — visible, counted in the totals, and
never quietly folded into a real project's figures.

### Attributing work by hand

Unattributed work can be assigned to a project after the fact. Open any job
from the history under the dashboard and use **Attribute…** on its project
field; by default the attribution applies to every unattributed job in that
conversation, which is the unit people actually fix — a conversation ran in one
folder.

The rules are narrow on purpose:

- **A project that was observed cannot be overwritten**, and no control is
  offered to try. It is what the session was pointed at while the work ran. If
  a person could edit it, every project figure in the dashboard would become a
  claim rather than a record.
- **A hand-made attribution can be corrected or withdrawn.** A typo that could
  never be fixed would be worse than no attribution at all. Withdrawing it
  returns the work to unattributed.
- **You can only attribute work you can already see.** The installer, who sees
  everyone's figures, can also fix anyone's missing attribution; everybody else
  is confined to their own, and asking for a wider scope resolves back to their
  own exactly as it does on every read.

The two are kept apart on the record and on screen: a hand-attributed job is
labelled *by hand* in its detail view, marked in the job list, and carries
`projectSource` of `manual` in the export. A figure somebody typed and a figure
something measured are not the same fact, which is the same rule this whole
subsystem applies to costs.

## What is not covered

Accounting covers **chat-surface sessions**. A terminal-surface session runs
the CLI in a PTY and is a stream of bytes with no structured usage in it at
all, so there is nothing there to record without parsing terminal output — and
a figure guessed from scraped text would be worse than an honest absence. Work
run in a terminal tab is not in the dashboard, and the dashboard does not
pretend otherwise.

## Who can see what

A signed-in user sees only their own jobs, their own totals, their own
history. There is no role system in this app, so the cross-user view —
"everyone's" figures, broken down by user — is restricted to the single
account already distinguished for something else: the
[installer](github-oauth.md#the-installer-account), the account that
completed the very first OAuth sign-in and is the same one that gates
applying a self-update. Anyone else who asks for `scope=everyone` is silently
answered with their own scope instead — a query parameter never widens what a
viewer can see.

Export inherits the same restriction as the dashboard or history view it was
generated from: a non-installer's CSV or JSON export contains only their own
jobs, however the request is shaped.

Narrowing does not widen. Filtering by project, agent, model or user is a
predicate applied *inside* the scope the request already resolved to, so a
viewer scoped to themselves who asks for another person's project — or another
person's login — is answered with their own empty set, not with somebody
else's figures. The project filter menu is scoped the same way, so it does not
even name the projects they cannot see.

## The API

All routes require a signed-in session and answer `401` otherwise. `scope`
defaults to `self`; passing `scope=everyone` is only honoured for the
installer, as above.

### `GET /api/usage/dashboard`

Everything one dashboard view draws: totals, a trend series, breakdowns by
project/agent/model/user, effort histograms, and the most-called tools.

Query parameters: `period` (`day` | `week` | `month` | `year`, default `day`),
`anchor` (ISO instant the period is centred on, default now), `tz` (minutes to
add to UTC to reach the viewer's own clock, so "today" means their today),
`scope` (`self` | `everyone`).

It also takes the same narrowing the job history does — `project`, `agent`,
`model`, `user`, and an explicit `from`/`to` window — and applies it to *every*
panel it returns, not only to the matching breakdown. Narrowing to one project
narrows the totals, the trend, all four breakdowns, the effort histograms and
the tool counts together, so no two parts of one view can end up answering
different questions.

`from`/`to` override the range the period would have produced, and are honoured
only as a pair: one end alone, or an end before its start, is ignored rather
than half-applied. When a window *is* applied, the trend is re-bucketed to suit
its width — a day-wide window comes back as hours, a month-wide one as days —
which is what makes selecting a point on the chart and drilling into it work
without a separate notion of zoom. The `bucket` field says which width was
used, and `filters` echoes back the narrowing that was actually applied, so a
client never offers to clear something the server ignored.

```
GET /api/usage/dashboard?period=week&tz=120
```

```json
{
  "scope": "self",
  "canSeeEveryone": false,
  "period": "week",
  "from": "2026-07-20T00:00:00.000Z",
  "to": "2026-07-27T00:00:00.000Z",
  "bucket": "day",
  "filters": {},
  "totals": {
    "turns": 42,
    "modelTurns": 96,
    "toolCalls": 210,
    "inputTokens": 154200,
    "outputTokens": 38900,
    "cacheReadTokens": 601400,
    "cacheWriteTokens": 12300,
    "reasoningTokens": 0,
    "totalTokens": 806800,
    "costUsd": 4.37,
    "tokensReportedJobs": 42,
    "costReportedJobs": 30
  },
  "series": [{ "key": "2026-07-20", "totals": { "...": "..." } }],
  "byAgent": [{ "key": "claude", "totals": { "...": "..." } }],
  "byModel": [{ "key": "claude-opus-5", "totals": { "...": "..." } }],
  "byProject": [{ "key": "billing-api", "totals": { "...": "..." } }],
  "effortByAgent": [
    {
      "key": "claude",
      "turns": 30,
      "modelTurnsReportedTurns": 30,
      "modelTurnsAvg": 2.4,
      "modelTurnsMax": 11,
      "toolCallsAvg": 3.1,
      "toolCallsMax": 22,
      "modelTurnsHistogram": [10, 8, 7, 4, 1],
      "toolCallsHistogram": [5, 9, 8, 6, 2]
    }
  ],
  "effortByModel": [{ "...": "..." }],
  "topTools": [{ "tool": "Read", "agent": null, "calls": 88, "turns": 40 }],
  "topToolsByAgent": [{ "tool": "Read", "agent": "claude", "calls": 60, "turns": 25 }]
}
```

`byUser` is present only when `scope` resolved to `everyone`.

A breakdown row for work with nothing to group it under — a job whose runtime
never named a model, or one recorded before projects were tracked — comes back
under the key `" unattributed"` (with the leading space). It is a sentinel
rather than an empty string precisely so it can be sent straight back as a
filter value: an empty query parameter is indistinguishable from an absent one,
and "show me only the unattributed work" is a real question.

### `GET /api/usage/conversations`

Paged history **one entry per chat tab**, most recently active first. Takes
exactly the same query parameters as `/api/usage/jobs` below and means the same
thing by them — the two are one list at two levels of detail.

Each entry carries the tab's totals, when it started and when it was last
active, and the agents, models and projects used over its life as *lists*: a
conversation that changed agent half way through says so rather than being
filed under one of them. `name` is the tab's own name, or `null` once the tab
has been deleted — a job outlives its conversation, and the entry survives
without a name rather than disappearing.

```
GET /api/usage/conversations?limit=20
```

```json
{
  "total": 2,
  "conversations": [
    {
      "sessionId": "sess-abc",
      "name": "Refactoring the parser",
      "agents": ["claude", "codex"],
      "models": ["claude-opus-5", "gpt-5"],
      "projects": ["billing-api"],
      "startedAt": "2026-07-27T09:00:00.000Z",
      "lastActiveAt": "2026-07-27T12:30:00.000Z",
      "totals": { "turns": 40, "costUsd": 7.25, "...": "..." }
    }
  ]
}
```

### `GET /api/usage/jobs`

Paged history, newest first. Query parameters: `scope`, `agent`, `model`,
`project`, `user`, `sessionId`, `from`, `to` (ISO, half-open range on
`endedAt`), `limit` (default 50, capped at 500), `offset`. They are the same
filters the dashboard takes and mean the same thing, which is what makes
drilling from a chart into the jobs behind it a matter of carrying the filters
across rather than re-deriving them.

```
GET /api/usage/jobs?agent=claude&limit=20
```

```json
{
  "jobs": [
    {
      "id": "sess-abc:turn-9",
      "sessionId": "sess-abc",
      "nativeSessionId": "claude-native-id",
      "turnId": "turn-9",
      "userId": 7,
      "userLogin": "dnviti",
      "agent": "claude",
      "model": "claude-opus-5",
      "project": "billing-api",
      "projectSource": "observed",
      "startedAt": "2026-07-27T09:14:02.000Z",
      "endedAt": "2026-07-27T09:14:41.000Z",
      "durationMs": 39000,
      "outcome": "completed",
      "turns": 3,
      "toolCalls": 5,
      "inputTokens": 1200,
      "outputTokens": 640,
      "cacheReadTokens": 40000,
      "cacheWriteTokens": 900,
      "reasoningTokens": null,
      "totalTokens": 42740,
      "costUsd": 0.0612,
      "reportsUsage": true,
      "reportsCost": true
    }
  ],
  "total": 137
}
```

### `GET /api/usage/jobs/:id`

One job with its full tool breakdown. Query parameter: `scope`. A job that
does not exist and a job that exists but is not this viewer's answer
identically — `404 { "error": "not_found" }` — so a caller cannot use the
response to probe for another user's job ids.

```json
{
  "id": "sess-abc:turn-9",
  "...": "all the fields above",
  "tools": [
    { "tool": "Read", "calls": 3 },
    { "tool": "Edit", "calls": 2 }
  ],
  "models": [
    {
      "model": "claude-opus-5",
      "calls": 3,
      "inputTokens": 800,
      "outputTokens": 150,
      "cacheReadTokens": null,
      "cacheWriteTokens": null,
      "costUsd": 0.75
    },
    {
      "model": "claude-haiku-4-5",
      "calls": 1,
      "inputTokens": 200,
      "outputTokens": 50,
      "cacheReadTokens": null,
      "cacheWriteTokens": null,
      "costUsd": 0.25
    }
  ]
}
```

`models` is empty for the ordinary case — a turn that ran on one model is
already described by the `model` field — and non-empty only where the runtime
reported a genuine split. See "A turn that ran on more than one model" above.

### `POST /api/usage/jobs/:id/project`

Attribute a job — or every unattributed job in its conversation — to a project
by hand. Query parameter: `scope`. Body:

```json
{ "project": "billing-api", "applyToSession": true }
```

`project` is trimmed and capped at 120 characters; a blank string is refused
with `400 empty_project` rather than creating a project whose name is nothing.
Send `null` to withdraw an attribution made this way.

The response says how many rows actually changed, which is not the same as how
many were named:

```json
{ "updated": 2, "project": "billing-api" }
```

An `updated` of `0` means every job in range already had an observed project —
those are never overwritten. A job that does not exist and a job that is not
this viewer's answer identically with `404`, the same as reading one does.

### `GET /api/usage/facets`

The agents, models and projects actually present in the viewer's own scope, for
populating filter menus. Query parameter: `scope`.

A viewer scoped to themselves sees only the projects their own work ran in.
The menu is a directory of what exists, and one that named every project in the
installation would leak the shape of everyone else's work to someone who cannot
see the figures behind it.

```json
{
  "agents": ["claude", "codex", "grok"],
  "models": ["claude-opus-5", "gpt-5.1-codex"],
  "projects": ["billing-api", "web"]
}
```

### `GET /api/usage/export`

Every job in range, oldest first, no paging. Query parameters: `scope`,
`agent`, `model`, `project`, `user`, `sessionId`, `from`, `to`, `format`
(`csv`, the default, or `json`). Again the same filters, so an export taken
while the dashboard is narrowed to one project contains that project and
reconciles against what was on screen.

CSV is the same columns as the job record, flattened, with an unreported
figure written as an empty cell rather than `0` — the one place that
distinction would otherwise get lost on the way out:

```
GET /api/usage/export?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&format=csv
```

```csv
id,sessionId,nativeSessionId,turnId,userId,userLogin,agent,model,project,projectSource,startedAt,endedAt,durationMs,outcome,turns,toolCalls,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,totalTokens,costUsd,reportsUsage,reportsCost
sess-abc:turn-9,sess-abc,claude-native-id,turn-9,7,dnviti,claude,claude-opus-5,billing-api,observed,2026-07-27T09:14:02.000Z,2026-07-27T09:14:41.000Z,39000,completed,3,5,1200,640,40000,900,,42740,0.0612,true,true
```

`format=json` returns the same rows as a JSON array instead, with the usual
`null` for a figure nobody reported.

## Reading the dashboard

The period selector (day / week / month / year) drives both the range and the
trend line's bucket size — hours within a day, days within a week or month,
months within a year — computed against the viewer's own timezone offset so
"today" is their calendar day, not the server's. A quiet hour or day still
appears on the trend as a gap rather than disappearing and making the shape
read as continuous when it was not.

### Exploring it

The charts are controls, not pictures.

- **The trend plots whichever measure you pick** — cost, tokens, jobs, turns or
  tool calls — rather than cost alone.
- **Every point is a button.** Hover it, tab to it, or tap it on a touch screen,
  and its period and exact figures appear above the chart; a screen reader is
  told the same thing. This is the part an `<svg><title>` cannot do, which is
  why the chart is not one.
- **Selecting a point narrows everything to it.** Press a bar and the totals,
  the breakdowns, the effort and tool figures and the job list below all
  re-ask the question for that slice of time, and the trend redraws itself one
  level finer — a month becomes its days, a day becomes its hours — so you can
  press again and go further in.
- **Selecting a breakdown row narrows to that project, agent, model or person**,
  and selections combine: one project, one agent, one afternoon.
- **Whatever is selected is named on screen**, as a row of chips, each of which
  clears just that one thing; one more control clears the lot. Nothing can be
  selected that cannot be undone in a single action.
- **The job history under the charts is narrowed by the same selection**, so
  drilling from a total down to the individual jobs behind it takes no
  re-entering of filters — and neither does the export, which carries the
  selection with it.
- **Breakdowns sort by any column**, and each row carries a bar showing its
  share of whichever measure is sorted on.

A bucket that reported nothing is drawn as a dashed stub in the border colour,
never as a bar of height zero. On a chart those two facts — "nothing here
reported a cost" and "this hour cost nothing" — are a pixel apart, and they are
the distinction this whole subsystem is built to keep.

Selections do not survive closing the dashboard: reopening it asks the
unnarrowed question again, rather than showing a total that is not the total
for a reason several screens further down.

Totals lead with jobs, turns, tool calls, tokens and cost, each cost and token
figure qualified by how many of the jobs it counted actually reported one — a
total's own honesty travels with it rather than being a separate number to go
find. Directly under them sits the line that no figure can carry on its own:
these are API list prices, so on a subscription plan they are what the work
would have cost rather than what anyone was charged. The by-agent and
by-model breakdowns are the same totals shape, grouped;
the by-user table appears only for the installer viewing `everyone`. The
by-project table groups by the folder each job ran in, with work recorded
before that was tracked under **unattributed** — which can be
[assigned by hand](#attributing-work-by-hand) — per-project figures always add
up to the overall total for the same range and scope, because nothing is
dropped to make the grouping tidy.

The effort tables answer a different question from the cost ones: not "how
much did this cost" but "does this agent usually finish in one round trip or
does it flail". They are histograms of turns and tool calls per completed job,
in fixed buckets (1 / 2 / 3-5 / 6-10 / 11+), rather than an average or a
percentile — a shape says where an agent sits on that spectrum where a single
number does not, and fixed buckets let two agents be read side by side.
Interrupted and errored jobs are excluded from effort: a turn the process died
inside of took exactly as many round trips as it got to before dying, which
describes the crash rather than the agent's usual behaviour.

The top-tools list, overall and broken down by agent, is exactly the calls
counted while building each job's record — nothing here is filtered or
sampled.

## Where the data lives

Two tables in the app's own SQLite file (`app.sqlite` in the
[data directory](configuration.md#where-state-lives), alongside settings,
users and runtime session records): `usage_jobs`, one row per job, and
`usage_job_tools`, the per-tool call counts for each job, cascading if a job
row is ever removed.

Jobs are kept **forever**. There is no retention window and no automatic
pruning. A record outlives the runtime session it was made in, the
conversation it happened inside of, and the server process that wrote it —
deleting a conversation removes its transcript, not the accounting history
that was filed while it ran. Recording a job is idempotent (it is keyed on
`<sessionId>:<turnId>` and replaces rather than duplicates), so recovering
from a crash between the write and the acknowledgement never doubles anybody's
bill.
