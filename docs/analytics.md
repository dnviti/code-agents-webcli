# Usage analytics

> **Status: no user interface.** The accounting described here runs on the
> server and works, but nothing in the current UI displays it. The client
> handler for usage updates is an explicit no-op, and nothing asks for one.
>
> This page documents what exists so the `--plan` flag and the environment
> variables are not a mystery, and so whoever builds the screen back has the
> model written down. If you are looking for a token meter in the app, there
> isn't one yet.

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

**Depletion estimate.** When the current window's allowance would run out at the
present rate. Only produced when confidence passes 50% — an estimate from three
data points is worse than no estimate.

**Cost.** Estimated from per-model input, output and cache token prices compiled
into the reader. Those prices go stale: they are a rough guide, not a bill.

## Plans

Selected with [`--plan`](configuration.md#usage-accounting).

| Plan | Tokens | Cost | Messages |
| --- | --- | --- | --- |
| `pro` | 19,000 | $18 | 250 |
| `max5` | 88,000 | $35 | 1,000 |
| `max20` *(default)* | 220,000 | $140 | 2,000 |
| custom | derived from your own p90 usage | `CLAUDE_COST_LIMIT`, default $50 | 250+ |

Two knobs have no CLI flag and are environment-only:

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_SESSION_HOURS` | `5` | Length of the rolling window |
| `CLAUDE_COST_LIMIT` | `50.00` | Ceiling for the custom plan |

## Where it lives in the code

| File | Role |
| --- | --- |
| `src/server/services/usage-reader.ts` | Reads and deduplicates the transcripts, computes tokens, cost, windows and burn rate |
| `src/server/services/usage-analytics.ts` | Applies plan limits and projections on top |
| `src/server/websocket/messages.ts` | Answers a `get_usage` message with a `usage_update` |

The wire protocol is intact, so a client that sends `get_usage` gets a real
answer today. That is the whole missing piece.
