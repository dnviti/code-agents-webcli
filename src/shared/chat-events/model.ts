import { ModelTier, ResolvedProfile } from '../runtime-profiles.js';
/** What a chat session is doing right now, for the header indicator. */
export type ChatState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'running'
  | 'awaiting_permission'
  /** Blocked on a question the model asked, which only a person can answer. */
  | 'awaiting_answer'
  | 'exited'
  | 'error';

/**
 * What a runtime can actually do in chat mode.
 *
 * Published by each adapter and carried to the UI, which hides or disables what
 * a runtime lacks. This is what keeps "chat works for every runtime" honest:
 * a CLI with no approval channel says so, and the UI stops pretending it has a
 * deny button that would do nothing.
 */
export interface ChatCapabilities {
  /** Text arrives incrementally rather than only at end of turn. */
  streaming: boolean;
  /** Reasoning is exposed separately from the answer. */
  thinking: boolean;
  toolCalls: boolean;
  /** File changes arrive as structured diffs rather than prose. */
  diffs: boolean;
  /** The runtime can ask before acting, and honour a refusal. */
  permissions: boolean;
  /**
   * The model can put a multiple-choice question to the user and wait for it.
   *
   * Optional rather than required so a stored snapshot written before this
   * existed still parses; absent reads as false everywhere it is consulted.
   */
  questions?: boolean;
  /** The session can receive and persist a submitted Plan-mode document. */
  planMode?: boolean;
  interrupt: boolean;
  /** A session can be resumed after the process is gone. */
  resume: boolean;
  /** A session can be branched from an earlier point. */
  fork: boolean;
  /** Images or files can be attached to a user turn. */
  attachments: boolean;
  /** Token counts are reported. */
  usage: boolean;
  /** Money is reported, not just tokens. */
  cost: boolean;
  /** The runtime emits a plan / todo list. */
  plan: boolean;
  /** Slash commands the runtime accepts, when it advertises them. */
  commands?: SlashCommand[];
  /** Selectable models, when the runtime advertises a list. */
  models?: ModelChoice[];
  /**
   * Reasoning-effort levels this runtime will accept, cheapest first.
   *
   * Absent means the runtime has no effort knob anyone has watched working, and
   * the control says so instead of offering levels that would be rejected. Every
   * list here came from the runtime itself — either published in its handshake
   * (codex, grok, kimi, omp) or read off its own `--help` and confirmed by
   * feeding it a bad value and reading the complaint (claude, pi).
   *
   * The ladders are not comparable across runtimes: `high` is the top of grok's
   * and the middle of pi's. That is what `rank` is for.
   */
  efforts?: EffortChoice[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  /** Hint for the argument, e.g. "[on|off|status]". */
  hint?: string;
}

export interface ModelChoice {
  value: string;
  name: string;
  description?: string;
}

/**
 * Which model a *new* conversation on this runtime would open on, and why.
 *
 * A statement about the default, never about the process that happens to be
 * running: a conversation with an override of its own is running that instead,
 * and one with neither is running whatever its launch resolved — which travels
 * separately, as `modelPinned`. The picker pairs them rather than letting one
 * stand in for another; using this as the model in force was how the chip came
 * to name a standing choice that had never been applied to the conversation
 * showing it. Said
 * out loud because a model picked out of a menu used to be invisible the moment
 * it was in force — the chip fell back to the literal word "model", and nothing
 * anywhere named the profile that had pinned it (issue #135).
 *
 * `model` is null only for `runtime`, which means nobody has chosen and the CLI
 * will use whatever it considers normal. Nothing here is validated against a
 * catalogue: a model name is free text because only the runtime knows its own.
 */
export interface ChatModelDefault {
  model: string | null;
  source: ModelDefaultSource;
  /** Set for `profile` and `ladder`, and only so the picker can name it. */
  profileName?: string;
  /** Only ever set for `ladder`: which rung of it this model sits on. */
  tier?: ModelTier;
  /**
   * Only on a `ladder` whose chosen rung was blank, naming the rung that was
   * asked for. The nearest filled one answered instead, and a person reading
   * "high" beside a profile set to "mid" is owed the reason.
   */
  requestedTier?: ModelTier;
}

/**
 * Where a model came from, cheapest explanation last.
 *
 * `ladder` is below `profile` deliberately and the issue says so outright: a
 * model somebody typed into a profile, and an account's standing choice, both
 * still beat the rung. The ladder is what answers when nobody typed anything.
 */
export type ModelDefaultSource = 'personal' | 'profile' | 'ladder' | 'runtime';

/**
 * What *this* conversation is running on, and why — as opposed to
 * `ChatModelDefault`, which is what the next one would open on.
 *
 * The two were the same object until the ladder arrived, and conflating them is
 * exactly how the chip came to name a standing choice that had never been
 * applied to the conversation showing it (#135). They are separate now because
 * the ladder makes the difference visible: a conversation pinned to `high` by a
 * one-off escalation and a runtime whose *default* is `mid` are both true at
 * once, and the picker has to say both.
 *
 * `override` is the source no default can have: the person in this conversation
 * picked it out of the menu.
 */
export interface ChatModelOrigin {
  model: string | null;
  source: 'override' | ModelDefaultSource;
  profileName?: string;
  tier?: ModelTier;
  requestedTier?: ModelTier;
  /**
   * Set while a conversation is answering above its usual rung, naming the rung
   * it returns to. Its presence is what the UI reads as "this is temporary".
   */
  escalatedFrom?: ModelTier;
}

/**
 * One reasoning-effort level, as the runtime that offers it named it.
 *
 * `value` is sent back to that runtime verbatim, so it is never a word this app
 * invented: kimi answers `on`/`off`, pi answers `xhigh`, codex answers `ultra`,
 * and a level spelled any other way is refused by name.
 */
export interface EffortChoice {
  value: string;
  name: string;
  description?: string;
  /**
   * Where this level sits on its own runtime's ladder — 0 is the least thinking
   * on offer, 1 the most.
   *
   * Carried rather than derived from list order because the UI colours by it,
   * and a colour derived from position in a list would make kimi's `on` (of two)
   * a different weight from pi's `max` (of seven) when both are that runtime's
   * ceiling. It also gives the levels that are not points on a ladder somewhere
   * honest to sit: omp's `auto` picks per prompt, so it ranks mid.
   */
  rank: number;
}

/**
 * Evenly-spaced ranks for a ladder given cheapest-first.
 *
 * The common case — a runtime whose levels really are a straight line — so the
 * adapters that have one do not each write the same division out.
 */
export function rankedEfforts(
  levels: Array<{ value: string; name?: string; description?: string }>,
): EffortChoice[] {
  const last = Math.max(1, levels.length - 1);
  return levels.map((level, index) => ({
    value: level.value,
    name: level.name ?? level.value,
    ...(level.description ? { description: level.description } : {}),
    rank: index / last,
  }));
}

/** Capabilities for a runtime with no chat adapter at all. */
export const NO_CHAT_CAPABILITIES: ChatCapabilities = {
  streaming: false,
  thinking: false,
  toolCalls: false,
  diffs: false,
  permissions: false,
  interrupt: false,
  resume: false,
  fork: false,
  attachments: false,
  usage: false,
  cost: false,
  plan: false,
  questions: false,
  planMode: false,
};

