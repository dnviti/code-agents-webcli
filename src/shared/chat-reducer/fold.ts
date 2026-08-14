import {
  ChatCapabilities,
  ChatEvent,
  ChatUsage,
  NoticeBlock,
  carriesCost,
  carriesTokens,
  mergeUsage,
} from '../chat-events.js';

/**
 * Fold one event's word about the runtime into what is known so far.
 *
 * Split out for the same reason as the usage fold below, and with the same
 * hazard behind it: a snapshot replays only the tail, but what a runtime can do
 * is announced once at the head, so the server has to read this from the whole
 * log without building a transcript. Two implementations would be two answers
 * to "is there a command menu" for the same conversation.
 *
 * An introduction replaces — a process that has just started is describing
 * itself, not adding to whatever the last one said — while a later report
 * merges into it.
 */
export function foldCapabilities(
  capabilities: ChatCapabilities,
  event: ChatEvent,
): ChatCapabilities {
  if (event.t === 'session') return { ...event.capabilities };
  if (event.t === 'capabilities') return { ...capabilities, ...event.capabilities };
  return capabilities;
}

/**
 * What a conversation has spent, folded one event at a time.
 *
 * Split out of the reducer's own cases so there is exactly one answer to it.
 * The server needs this reading of the log *without* building a transcript —
 * a snapshot replays only the tail, and a session's cost is a property of the
 * whole conversation, not of the last forty messages — and two implementations
 * of "how much has this cost" would be two numbers for the browser to show
 * alternately, which is precisely the bug that made a live meter appear to
 * reset on every rejoin.
 *
 * Returns the new running total rather than mutating the one it was given: the
 * browser hands this object straight to the meter, which re-renders on the
 * object changing, so folding in place would leave the number on screen stale.
 */
export function foldSessionUsage(usage: ChatUsage, event: ChatEvent): ChatUsage {
  switch (event.t) {
    // A clear ends the conversation the figures were about, so they go back to
    // nothing along with it. Handled here rather than only in the reducer
    // because the server folds the log without building a transcript, and the
    // two answers to "what has this cost" have to be the same one.
    case 'marker':
      return event.kind === 'cleared' ? clearedUsage(usage) : usage;
    // Per-message and per-turn reports are deltas, so they sum.
    case 'msg_end':
    case 'turn_end':
      return event.usage ? mergeUsage(usage, event.usage) : usage;
    case 'usage': {
      // A standalone report is a running total — summing it would count the
      // same tokens once per report — so its fields replace. Only the ones it
      // actually carries: a runtime that reports a context window and no money
      // (or money in a currency this cannot show) would otherwise write cost
      // back as `undefined` and blank a figure it never spoke about.
      const next = { ...usage };
      assignDefined(next, event.usage);
      // The one thing `assignDefined` has no way to express, and must not
      // learn: a report that names no window because nobody could size the
      // model is asking for the ceiling to come down, where every other report
      // that leaves the field out is simply not talking about it.
      if (event.usage.contextWindowSource === 'unknown') next.contextWindow = undefined;
      // And the mirror of it, which `assignDefined` cannot express either: a
      // report carrying figures says somebody reports them, so an earlier
      // "this runtime reports nothing" has to come off. `mergeUsage` reaches
      // the same conclusion on the additive path; the two have to agree or the
      // header and the history end up saying different things about one
      // conversation.
      if (carriesTokens(event.usage)) next.usageSource = 'agent';
      // An estimated figure stays labelled estimated (issue #182); only a
      // runtime-reported one becomes the generic 'agent'.
      if (carriesCost(event.usage)) next.costSource = event.usage.costEstimate ? 'estimated' : 'agent';
      return next;
    }
    default:
      return usage;
  }
}

/**
 * What each rule drawn across a conversation says.
 *
 * A table rather than a chain of ternaries because the words are the whole of
 * what a rule communicates: a reader sees one short phrase and has to
 * understand from it that the transcript above is no longer what the agent can
 * see, or was said somewhere else entirely. `cleared` is here for completeness —
 * it empties the window rather than drawing a line, and is handled before this
 * is reached.
 *
 * Keyed by `NoticeBlock['notice']` rather than by marker kind, which is what
 * leaves `approvals` out: it is a marker that draws nothing, and the type says
 * so instead of a comment having to.
 */
const NOTICES: Record<
  NoticeBlock['notice'],
  { notice: NoticeBlock['notice']; text: string }
> = {
  compacted: { notice: 'compacted', text: 'Context compacted' },
  interrupted: { notice: 'interrupted', text: 'Interrupted to send' },
  branched: { notice: 'branched', text: 'Branched from an earlier conversation' },
  cleared: { notice: 'cleared', text: 'New conversation' },
  // Only ever drawn for a change made *during* a conversation — an escalation
  // granted, the rung it returns to, a profile edited under a running chat.
  // Never at launch: which model a conversation opened on is a standing fact,
  // and standing facts belong on the chip beside the composer, which is the
  // lesson `approvals` above cost us (#134).
  model: { notice: 'model', text: 'Model changed' },
};

/** Every token field a runtime can report, so a reset covers all of them. */
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'contextUsed',
] as const;

/**
 * What the meter reads after a clear: nothing spent, nothing occupied.
 *
 * Zeroed rather than emptied. An empty object renders no meter at all, and a
 * header that goes blank the moment somebody clears looks like a readout that
 * broke rather than one that reset — where zero is the true and useful answer:
 * this conversation has spent nothing yet. Every field the runtime had been
 * reporting is set to zero and no field it had not is invented, so a runtime
 * that reports no money still shows no money.
 *
 * The context *window* survives, because it is a fact about the model rather
 * than about the conversation — a new conversation on the same model has the
 * same capacity, and dropping it would replace "0%" with "size unknown" for a
 * size that is perfectly well known.
 */
function clearedUsage(usage: ChatUsage): ChatUsage {
  const next: ChatUsage = {};
  for (const field of TOKEN_FIELDS) {
    if (usage[field] !== undefined) next[field] = 0;
  }
  if (usage.costUsd !== undefined) next.costUsd = 0;
  if (usage.contextWindow !== undefined) {
    next.contextWindow = usage.contextWindow;
    next.contextWindowSource = usage.contextWindowSource;
  } else if (usage.contextWindowSource === 'unknown') {
    // And so does the absence of one, for the same reason: clearing changes
    // the conversation, not the model, and the model nobody could size is
    // still that model. Carried rather than dropped so a clear cannot quietly
    // turn "we asked and nobody knew" back into "nobody has asked yet".
    next.contextWindowSource = 'unknown';
  }
  // Same rule, third time: what the runtime reports is a fact about the
  // runtime, and a clear replaces the conversation rather than the agent
  // running it. Dropped here, clearing a kimi chat would turn "this agent
  // reports nothing" back into "nobody has said yet", and the header would go
  // quiet again until the next turn ended.
  if (usage.usageSource === 'none') next.usageSource = 'none';
  if (usage.costSource === 'none') next.costSource = 'none';
  // The estimate's provenance describes the work that cleared: it must not
  // survive onto a fresh conversation any more than the cost figure it prices.
  delete next.costEstimate;
  return next;
}

/**
 * Merge only the keys that carry a value.
 *
 * A progress report names one thing at a time — the activity now, the tool
 * name now — and a plain `Object.assign` would write the absent keys back as
 * `undefined`, erasing what the previous report established. That reads as an
 * agent whose detail view keeps blanking out mid-run.
 */
export function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

/**
 * Fold a reported list into the one already held, keyed by `index`.
 *
 * The runtime sends a complete snapshot on some reports and nothing at all on
 * others, so an absent list leaves what is known standing rather than emptying
 * it. Rows arrive in the order they were started and keep it: an agent that
 * reports again is written back in place, so watching a run does not shuffle
 * the list under the reader.
 */
export function upsertByIndex<T extends { index: number }>(target: T[], incoming: T[] | undefined): void {
  if (!incoming) return;
  for (const entry of incoming) {
    const at = target.findIndex((held) => held.index === entry.index);
    if (at >= 0) target[at] = entry;
    else target.push(entry);
  }
}

export function omitUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Partial<T>;
}

export { NOTICES };
