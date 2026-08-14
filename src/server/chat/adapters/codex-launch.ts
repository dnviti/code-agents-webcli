import { mergeSlashCommands } from '../../../shared/slash-commands.js';
import { rankedEfforts } from '../../../shared/chat-events.js';
import type { EffortChoice, SlashCommand } from '../../../shared/chat-events.js';
import type { ChatAdapterOptions } from '../adapter.js';
import { str, record, list } from './codex-utils.js';

// ------------------------------------------------------------ effort ladder

/**
 * One `model/list` entry's reasoning-effort ladder, as codex published it.
 *
 * Read off a live `model/list` against codex-cli 0.145.0 rather than inferred
 * from the vendored schema: every entry came back carrying
 * `supportedReasoningEfforts: Array<{ reasoningEffort, description }>` next to a
 * `defaultReasoningEffort`, and the arrays arrived cheapest-first —
 * `low, medium, high, xhigh, max, ultra` for gpt-5.6-terra, the same list
 * stopping at `xhigh` for gpt-5.5. That order *is* the ladder, so it is kept
 * exactly as sent and `rankedEfforts` spaces the ranks along whatever length it
 * turns out to be.
 *
 * Which is also why the offered levels come from here and not from the
 * `ReasoningEffort` union in `.work/probes/raw/codex-ts/ReasoningEffort.ts`:
 * that enum stops at `xhigh`, while the running build offers `max` and `ultra`
 * on its newer models. Where the generated schema and the process disagree
 * about what the process accepts, the process wins.
 *
 * The descriptions are codex's own, verbatim ("Balances speed and reasoning
 * depth for everyday tasks"), and so are the names: there is no table here
 * turning `xhigh` into "Extra high", because the value is the exact string that
 * gets handed back to codex and a label that differs from it only makes a
 * mismatch harder to see.
 *
 * Undefined rather than an empty array when the field is missing, so a build
 * that predates it leaves the control saying this runtime publishes no ladder
 * instead of opening an empty menu.
 */
export function effortLadder(model: Record<string, unknown> | undefined): EffortChoice[] | undefined {
  const levels: Array<{ value: string; description?: string }> = [];
  for (const raw of list(model?.supportedReasoningEfforts)) {
    const option = record(raw);
    const value = str(option.reasoningEffort);
    if (!value) continue;
    const description = str(option.description);
    levels.push({ value, ...(description ? { description } : {}) });
  }
  return levels.length ? rankedEfforts(levels) : undefined;
}

/** codex's `ReviewDecision` for the two option kinds this adapter offers; anything else means "no". */
export function reviewDecisionFor(optionId: string): string {
  if (optionId === 'allow_once') return 'approved';
  if (optionId === 'allow_always') return 'approved_for_session';
  return 'denied';
}

export const CLIENT_INFO = { name: 'code-agents-webcli', title: 'Code Agents Web CLI', version: '1.0.0' };

/**
 * Commands implemented by the web chat itself rather than by Codex.
 *
 * `ChatSession` intercepts all three and starts a genuinely fresh process, so
 * they work in app-server and exec mode alike. They also keep the command
 * control reachable on a machine with no skills installed.
 */
export const CODEX_APP_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation, forgetting everything above' },
  { name: 'new', description: 'Start a new conversation — the same thing as /clear' },
  { name: 'reset', description: 'Start a new conversation — the same thing as /clear' },
];

/** A fresh array: adapter capability objects are mutable and must not share one. */
export function initialCodexCommands(options: ChatAdapterOptions): SlashCommand[] {
  return mergeSlashCommands(CODEX_APP_COMMANDS, options.installedCommands);
}

export interface CodexSkillReference {
  name: string;
  path: string;
}

export function initialCodexSkills(options: ChatAdapterOptions): Map<string, CodexSkillReference> {
  const found = new Map<string, CodexSkillReference>();
  for (const skill of options.installedSkills ?? []) {
    const name = String(skill.name || '').trim();
    const hostPath = String(skill.path || '').trim();
    if (!name || !hostPath || found.has(name.toLowerCase())) continue;
    const runtimePath = options.environment
      ? options.environment.toContainerPath(hostPath)
      : hostPath;
    found.set(name.toLowerCase(), { name, path: runtimePath });
  }
  return found;
}

/** `/name args` -> Codex's `$name args`, but only for a known skill. */
export function codexSkillInvocation(
  text: string,
  skills: Map<string, CodexSkillReference>,
): { text: string; skill?: CodexSkillReference } {
  const selected = /^\s*\/([^\s]+)([\s\S]*)$/.exec(text);
  const skill = selected ? skills.get(selected[1]!.toLowerCase()) : undefined;
  return skill && selected
    ? { text: `$${skill.name}${selected[2] || ''}`, skill }
    : { text };
}

/**
 * How long the handshake waits before giving up on a build that never
 * responds.
 *
 * BaseChatAdapter's own `exit` handler never rejects a pending JSON-RPC
 * call -- it only emits an `error`/`state` event -- so a codex old enough to
 * reject `app-server` outright (and exit without ever writing a line) would
 * otherwise leave `start()` hanging forever instead of letting
 * `CodexChatAdapter` fall back to `exec --json`.
 */
export const INIT_TIMEOUT_MS = 8_000;

export const THREAD_START_TIMEOUT_MS = 15_000;

/** Short on purpose: the picker is worth waiting for, but not worth a delayed session. */
export const MODEL_LIST_TIMEOUT_MS = 5_000;

/** Local discovery, useful but never worth holding the conversation open for. */
export const SKILLS_LIST_TIMEOUT_MS = 5_000;

/**
 * How long to wait for `account/rateLimits/read`.
 *
 * It has a timer of its own because `call()` has none: an app-server old enough
 * not to implement the method may simply never answer, and an unanswered
 * request sits in the pending map until the session stops.
 */
export const RATE_LIMITS_TIMEOUT_MS = 5_000;

/**
 * The baseline accepted by Codex's reasoning-capable models and by both the
 * launch config and `turn/start` protocol fields.
 *
 * `model/list` remains authoritative and replaces this with the selected
 * model's exact ladder (including xhigh/max/ultra where offered). Keeping the
 * baseline in the launch capabilities matters when discovery is slow or an
 * installed container build omits the optional ladder metadata: the composer
 * must not remove the effort control even though the running protocol can
 * still apply these levels.
 */
export const CODEX_BASE_EFFORTS: EffortChoice[] = rankedEfforts([
  { value: 'low', description: 'Faster responses with less reasoning' },
  { value: 'medium', description: 'Balanced speed and reasoning depth' },
  { value: 'high', description: 'More reasoning for harder tasks' },
]);

