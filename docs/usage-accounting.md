# Usage accounting

Durable, per-user history of what agent work has cost: tokens, dollars,
turns and tool calls, filed as one row per job and kept forever. This is a
different thing from [Usage analytics](analytics.md): that page reads
Claude Code's own local transcripts to estimate a five-hour billing window for
one CLI, and disappears with the file. This page is written by the server
itself, for every runtime, and survives the session, the server restart, and
even the deletion of the conversation the work happened in.

## What is recorded, and what is not

Every job files: who ran it (user id and login, denormalised so the row
outlives the account), which agent and model, when it started and ended, how
it ended, how many turns and tool calls it took, the token and cost figures
the runtime reported, and which tool names were called how many times.

What is never recorded: anything you or the agent said. No prompt text, no
reply text, no file contents, no tool arguments, no tool output. The
accounting record and the conversation transcript are deliberately separate
things that happen to share some numbers — a record that quoted the
conversation would just be a transcript wearing a different name, kept around
after every rule protecting the real one had stopped applying to it.

## What a "job" is

A job is one prompt-to-settle unit: the span from a user's message to the
point the runtime declares the turn over. Two counts are derived from the
transcript rather than asked of the runtime, because almost none of them
report either directly:

- **Turns** — the number of times the model itself spoke inside that span.
  This is the same quantity Claude Code reports as `num_turns`, generalised to
  every runtime so "how many round trips did this take" is answerable for
  agents that have no such field of their own.
- **Tool calls** — the number of tool blocks the transcript opened. A tool
  that is re-announced once its streamed arguments finish parsing (Claude does
  this) is counted once, not twice.

A job that never got a reply — the process died, the session was stopped, the
runtime reported an error — is still filed, with an outcome of `interrupted`
or `error` rather than being dropped. A turn the process died in the middle of
took exactly as many round trips as it got to; that is a fact about the crash,
not an absence of one.

## The per-agent honesty table

Not every runtime reports the same things, and the app does not pretend
otherwise. The figures below come from each adapter's own `capabilities`
declaration under `src/server/chat/adapters/`, which is the same source the
adapters use to decide what they can promise the rest of the UI.

| Agent | Turns / tool calls | Tokens | Cost |
| --- | --- | --- | --- |
| Claude | counted from the transcript | reported | reported (see below) |
| Codex (app-server) | counted from the transcript | reported | **not reported** — nothing in the schema prices a turn |
| Codex (`exec` fallback) | counted from the transcript | **not reported** | **not reported** |
| Grok | counted from the transcript | reported | reported, but see the open question below |
| pi | counted from the transcript | reported | reported |
| ACP agents (omp, kimi, and others behind the ACP bridge) | counted from the transcript | reported | reported |

A figure a runtime never reports is stored as `null` and shown as
**"not reported"** — never as zero. Those are different facts: a job that
cost nothing and a job whose cost nobody measured look the same on a naive
total, and this app keeps them apart all the way to the database. Every
aggregate the store returns carries, alongside its totals, a count of how many
of the jobs in it actually contributed a token figure or a cost figure
(`tokensReportedJobs`, `costReportedJobs`), so "$4.10 across 28 of 40 jobs"
is the shape of the answer, not "$4.10" on its own.

## The reporting-convention problem

Runtimes disagree about what a usage figure even means, and treating them all
the same way silently multiplies somebody's bill.

Claude, Grok, pi and the ACP agents report a figure **for the message or the
turn**. Those add up: sum every turn's tokens and cost, and the sum is the
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

### Grok's cost convention is an open question

Grok's `total_cost_usd` has the same field name and the same shape as
Claude's — which is exactly the pattern that turned out to be cumulative on
Claude. It is currently treated as a **per-turn** figure that sums, on the
strength of the CLI's own documentation describing `end` as carrying that
turn's usage. But that has not been confirmed live: the probe run against the
installed binary hit the account's rate limit before a second successful turn
completed, so there is no captured pair of consecutive `total_cost_usd`
values to check the way Claude's were checked. If Grok's figure turns out to
also be cumulative, every Grok conversation's per-turn cost after the first
turn is currently overstated in exactly the way Claude's was before its fix.
Treat Grok's per-job cost figures with that caveat until someone re-probes it
with working quota.

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

## The API

All routes require a signed-in session and answer `401` otherwise. `scope`
defaults to `self`; passing `scope=everyone` is only honoured for the
installer, as above.

### `GET /api/usage/dashboard`

Everything one dashboard view draws: totals, a trend series, breakdowns by
agent/model/user, effort histograms, and the most-called tools.

Query parameters: `period` (`day` | `week` | `month` | `year`, default `day`),
`anchor` (ISO instant the period is centred on, default now), `tz` (minutes to
add to UTC to reach the viewer's own clock, so "today" means their today),
`scope` (`self` | `everyone`).

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
  "totals": {
    "jobs": 42,
    "turns": 96,
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
  "effortByAgent": [
    {
      "key": "claude",
      "jobs": 30,
      "turnsAvg": 2.4,
      "turnsMax": 11,
      "toolCallsAvg": 3.1,
      "toolCallsMax": 22,
      "turnsHistogram": [10, 8, 7, 4, 1],
      "toolCallsHistogram": [5, 9, 8, 6, 2]
    }
  ],
  "effortByModel": [{ "...": "..." }],
  "topTools": [{ "tool": "Read", "agent": null, "calls": 88, "jobs": 40 }],
  "topToolsByAgent": [{ "tool": "Read", "agent": "claude", "calls": 60, "jobs": 25 }]
}
```

`byUser` is present only when `scope` resolved to `everyone`.

### `GET /api/usage/jobs`

Paged history, newest first. Query parameters: `scope`, `agent`, `model`,
`sessionId`, `from`, `to` (ISO, half-open range on `endedAt`), `limit`
(default 50, capped at 500), `offset`.

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
  ]
}
```

### `GET /api/usage/facets`

The agents and models actually present in the viewer's own scope, for
populating filter menus. Query parameter: `scope`.

```json
{ "agents": ["claude", "codex", "grok"], "models": ["claude-opus-5", "gpt-5.1-codex"] }
```

### `GET /api/usage/export`

Every job in range, oldest first, no paging. Query parameters: `scope`,
`agent`, `model`, `sessionId`, `from`, `to`, `format` (`csv`, the default, or
`json`).

CSV is the same columns as the job record, flattened, with an unreported
figure written as an empty cell rather than `0` — the one place that
distinction would otherwise get lost on the way out:

```
GET /api/usage/export?period=month&format=csv
```

```csv
id,sessionId,nativeSessionId,turnId,userId,userLogin,agent,model,startedAt,endedAt,durationMs,outcome,turns,toolCalls,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,totalTokens,costUsd,reportsUsage,reportsCost
sess-abc:turn-9,sess-abc,claude-native-id,turn-9,7,dnviti,claude,claude-opus-5,2026-07-27T09:14:02.000Z,2026-07-27T09:14:41.000Z,39000,completed,3,5,1200,640,40000,900,,42740,0.0612,true,true
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

Totals lead with jobs, turns, tool calls, tokens and cost, each cost and token
figure qualified by how many of the jobs it counted actually reported one — a
total's own honesty travels with it rather than being a separate number to go
find. The by-agent and by-model breakdowns are the same totals shape, grouped;
the by-user table appears only for the installer viewing `everyone`.

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
