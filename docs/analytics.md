# Usage analytics

> **Status: no user interface.** The accounting described here runs on the
> server and works, but nothing in the current UI displays it. The client
> handler for usage updates is an explicit no-op, and nothing asks for one.
>
> It used to have one indirectly: the status panel drew a plan meter on top of
> it. That meter is gone, because the ceiling it was drawn against was invented
> — see [what the status panel knows](usage-accounting.md#what-the-status-panel-knows).
> What is left here is a measurement with no ceiling and no consumer, kept
> because it is a real read of real files.

## What it reads

Claude Code's own transcripts, at `~/.claude/projects/**/*.jsonl` — read
recursively so sub-agent transcripts are counted too, deduplicated by message
and request id, and cached against each file's size and modification time.

This is **Claude Code only**. No other runtime writes transcripts in a format
the reader understands, so sessions on the other CLIs contribute nothing.

Nothing is sent anywhere. It is a local read of files Claude Code already wrote.

## The model

**Rolling five-hour windows.** A window opens with the first message and lasts
five hours, matching how Claude's subscription plans actually meter. Windows can
overlap, and boundaries are inferred from usage rather than declared.

**Burn rate.** Tokens per minute, computed over 5, 10, 15, 30 and 60-minute
windows so a brief spike does not dominate, with a trend (rising, falling,
steady) and a confidence score.

**Cost.** Estimated from per-model input, output and cache token prices compiled
into the reader. Those prices go stale: they are a rough guide, not a bill.

## No plan limits

There used to be a table here: token, dollar and message allowances for `pro`,
`max5`, `max20` and a `custom` tier, selected with a `--plan` flag whose default
was `max20` on every install. None of those figures came from Anthropic. They
were written into this repository, and an unrecognised plan fell through to a
bare `188026` tokens.

They are gone, along with the flag, the `CLAUDE_COST_LIMIT` variable that set
the custom tier's ceiling, and everything derived from them: remaining tokens,
percent used and time to depletion. What this service measures — tokens, cost
and a burn rate, from files Claude Code wrote — has no ceiling to be measured
against, and says so.

One knob is left, and it is environment-only:

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_SESSION_HOURS` | `5` | Length of the rolling window |

## Where it lives in the code

| File | Role |
| --- | --- |
| `src/server/services/usage/usage-reader.ts` | Reads and deduplicates the transcripts, computes tokens, cost, windows and burn rate |
| `src/server/services/usage/usage-analytics.ts` | Rolling windows and a burn rate on top |
| `src/server/websocket/messages.ts` | Answers a `get_usage` message with a `usage_update` |

The wire protocol is intact, so a client that sends `get_usage` gets a real
answer today. That is the whole missing piece.
