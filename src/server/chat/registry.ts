import {
  ChatCapabilities,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { ChatAdapter, ChatAdapterOptions } from './adapter.js';
import { AcpChatAdapter } from './adapters/acp.js';
import { AntigravityChatAdapter } from './adapters/antigravity.js';
import { ClaudeChatAdapter } from './adapters/claude.js';
import { CodexChatAdapter } from './adapters/codex.js';
import { PiChatAdapter } from './adapters/pi.js';

/**
 * Which runtimes can be driven as a chat, and by which adapter.
 *
 * Four adapter families cover them, and the ACP one covers three CLIs by itself
 * because they all speak the Agent Client Protocol — adding another ACP agent
 * is a row in this table, not a new adapter, which is exactly how grok moved
 * onto it (see below).
 *
 * A runtime absent from this table is terminal-only, and the launcher says so
 * rather than offering a Chat option that would fail on click. That is the rule
 * this whole feature is built on: never advertise a capability the runtime does
 * not have. Two runtimes sit in that position deliberately —
 *
 *   qwen         — not installed here, so its protocol was never captured.
 *   agent        — cursor-agent's structured mode was likewise never verified.
 *
 * Both are one probe away from a row here; neither gets a guessed adapter,
 * because an adapter written against an imagined schema fails at the worst
 * possible moment, in front of a user, mid-turn.
 */

export type ChatAdapterFactory = (options: ChatAdapterOptions) => ChatAdapter;

/**
 * How a runtime is handed ccweb's session-scoped tools.
 *
 * `cli` — as a `--mcp-config` argument at spawn (claude).
 * `protocol` — in the handshake, as part of `session/new` (ACP agents).
 * `extension` — as a generated file loaded with `-e` (pi), which has no MCP of
 *   its own and no ACP. A different road to the same place: the tool has the
 *   same name, dials the same socket and draws the same card.
 * `config` — as process-local `-c mcp_servers...` overrides (codex app-server).
 *
 * The channel may carry submit_plan and tier escalation without carrying the
 * blocking question tool. `questionDelivery` below decides that independently.
 * Absent means the runtime has no verified way to accept the tool channel;
 * ChatSession still supplies questions through its structured end-turn handoff.
 */
export type AskChannel = 'cli' | 'protocol' | 'extension' | 'config';

/**
 * How a runtime may ask a person for a decision.
 *
 * Blocking is opt-in: it promises that the whole runtime -> tool -> callback
 * path has no elapsed-time ceiling. Every unknown or merely-large timeout uses
 * the structured end-turn handoff instead, which keeps no tool call open while
 * the person is away.
 */
export type QuestionDelivery = 'structured_handoff' | 'blocking_tool';

interface RuntimeChatEntry {
  factory: ChatAdapterFactory;
  /** What the launcher shows before a session exists. */
  advertised: Partial<ChatCapabilities>;
  askChannel?: AskChannel;
  /** Defaults to structured_handoff; only a verified timer-free path opts in. */
  questionDelivery?: QuestionDelivery;
  /**
   * Environment retained for the other ccweb tool calls on this client.
   * This is never the question-delivery guarantee: finite or unverified MCP
   * clients do not receive ask_user_question at all.
   */
  askEnv?: Record<string, string>;
}

/**
 * ACP agents differ only in the argv that starts their protocol server.
 *
 * The real capabilities arrive from the handshake, so what is listed here is
 * only what the launcher shows beforehand; the session replaces it the moment
 * the agent introduces itself.
 */
function acp(
  runtime: string,
  acpArgs: string[],
  advertised: Partial<ChatCapabilities> = {},
): RuntimeChatEntry {
  return {
    factory: (options) => new AcpChatAdapter({ ...options, runtime, acpArgs }),
    askChannel: 'protocol',
    questionDelivery: 'structured_handoff',
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      permissions: true,
      interrupt: true,
      usage: true,
      cost: true,
      ...advertised,
    },
  };
}

const RUNTIMES: Record<string, RuntimeChatEntry> = {
  claude: {
    factory: (options) => new ClaudeChatAdapter(options),
    askChannel: 'cli',
    questionDelivery: 'structured_handoff',
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      permissions: true,
      interrupt: true,
      resume: true,
      attachments: true,
      usage: true,
      cost: true,
    },
  },
  codex: {
    factory: (options) => new CodexChatAdapter(options),
    askChannel: 'config',
    questionDelivery: 'structured_handoff',
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      diffs: true,
      permissions: true,
      interrupt: true,
      resume: true,
      usage: true,
      questions: true,
    },
  },
  /**
   * Grok speaks ACP too, and that is the entry point this app drives it on.
   *
   * Its headless mode (`grok -p --output-format streaming-json`) has no tool
   * channel whatsoever — probed against 0.2.112 with a prompt that read a file
   * and ran a command, and the wire carried 83 `thought` events, one `text` and
   * an `end`, while the file it wrote appeared on disk. A conversation driven
   * that way shows an agent thinking and answering and never doing, which is a
   * transparency problem before it is a metrics one (issue #73).
   *
   * `grok agent stdio` reports the identical work as ordinary ACP `tool_call` /
   * `tool_call_update`, and brings permissions, a model list, `loadSession` and
   * per-turn cost with it. `session/load` even loads sessions headless mode
   * created — replaying the tool calls headless never streamed — so nothing
   * already recorded is stranded by the change.
   *
   * `--no-leader` is deliberate: grok will otherwise attach to a shared leader
   * process, and one leader behind every session on a multi-user installation
   * is a state-sharing boundary nobody chose.
   *
   * Grok takes the same inline MCP-server descriptor as the other ACP agents.
   * The descriptor is deliberately transport-agnostic: `ChatSession` supplies
   * the command, arguments and environment, so it can point at either the local
   * socket bridge or the authenticated, encrypted shared-file bridge without
   * the registry acquiring a second, runtime-specific launch path.
   */
  grok: {
    factory: (options) =>
      new AcpChatAdapter({
        ...options,
        runtime: 'grok',
        acpArgs: [
          'agent',
          ...(options.bypassPermissions ? ['--always-approve'] : []),
          '--no-leader',
          'stdio',
        ],
      }),
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      permissions: true,
      interrupt: true,
      resume: true,
      usage: true,
      cost: true,
      // The ACP `session/new` schema accepts the same mcpServers list as the
      // verified kimi/omp path. The live Grok capture records MCP startup and
      // server-status notifications; keeping this capability here makes the
      // pre-launch UI agree with the session wiring below.
      questions: true,
    },
    askChannel: 'protocol',
    questionDelivery: 'structured_handoff',
  },
  /**
   * pi, which asks its questions through an extension rather than a server.
   *
   * `questions` is advertised on the strength of the channel this app supplies
   * it, not of anything pi ships: the tool arrives as a generated `-e` file (see
   * `pi-ask-extension.ts`), registers itself only when the session put a socket
   * in the environment, and draws the same card every other runtime's questions
   * draw. Watched working before it was written down here, which is the rule
   * this table is kept by.
   *
   * `permissions` stays false and is unrelated: pi has no per-call approval
   * channel to offer, and asking the user a question is not approving a tool.
   */
  pi: {
    factory: (options) => new PiChatAdapter(options),
    askChannel: 'extension',
    questionDelivery: 'blocking_tool',
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      questions: true,
      usage: true,
      cost: true,
    },
  },
  // Probed, not assumed: kimi 0.29.1 over ACP sends no `usage_update`, no
  // `usage` on its prompt reply and no `_meta` on any update, so it reports
  // neither tokens nor money. The adapter narrows the *running* session's
  // capabilities the same way (`NO_SPEND_REPORTING` in acp.ts); this row is
  // what the pre-session table says, and the two must not disagree.
  /**
   * Kimi's MCP client accepts only a finite timeout. Questions therefore use
   * structured handoff. Its maximum remains scoped to submit_plan and the
   * optional tier tool, whose ACP descriptor has no per-server timeout field.
   */
  kimi: {
    ...acp('kimi', ['acp'], { usage: false, cost: false }),
    askEnv: { KIMI_MCP_TOOL_TIMEOUT_MS: '2147483647' },
  },
  /**
   * OMP's top-level MCP timeout can be disabled, but nested agents retain a
   * finite ceiling. That makes the end-to-end path ineligible for blocking
   * questions. The setting remains only for submit_plan and tier requests.
   */
  omp: {
    ...acp('omp', ['acp']),
    askEnv: { OMP_MCP_TIMEOUT_MS: '0' },
  },
  /**
   * Antigravity CLI, driven as `agy --print --output-format stream-json`.
   *
   * No ACP: `--experimental-acp` is rejected outright by 1.1.8's flag parser and
   * there is no `acp` subcommand — `agy acp` falls through to the interactive
   * TUI and dies looking for a `/dev/tty`. Its structured mode is the print one,
   * and every row below was read off a live capture of it (see the adapter).
   *
   * `permissions: false` is the honest half of this entry and the one worth
   * reading twice. Headless, agy *cannot* stop and ask: a tool needing approval
   * is denied on the spot and the run carries on around it. There is no channel
   * to offer a person, so nothing here pretends there is — the choice is made at
   * launch, said on the card, and each refusal is explained in the conversation.
   *
   * Agy exposes no session-scoped MCP/extension flag, so its questionnaire uses
   * the structured final-response fallback owned by ChatSession.
   */
  antigravity: {
    factory: (options) => new AntigravityChatAdapter(options),
    questionDelivery: 'structured_handoff',
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      interrupt: true,
      resume: true,
      attachments: true,
      usage: true,
      questions: true,
    },
  },
};

/**
 * How this runtime takes the question server, or undefined if it does not.
 *
 * Only channels actually supported by the runtime are named here. A runtime
 * with no entry is handled by ChatSession's structured-response fallback.
 */
export function askChannelFor(runtime: string): AskChannel | undefined {
  return RUNTIMES[runtime]?.askChannel;
}

/**
 * The conservative question policy for this runtime.
 *
 * Kept separate from askChannelFor: Codex, Claude and ACP runtimes still need
 * the ccweb tool server for Plan submission and tier requests even though the
 * timed question tool itself is deliberately absent.
 */
export function questionDeliveryFor(runtime: string): QuestionDelivery {
  return RUNTIMES[runtime]?.questionDelivery ?? 'structured_handoff';
}

/**
 * Client settings retained for the non-question tools on ccweb's MCP server.
 * They are applied to the runtime process and never make a runtime eligible
 * for `blocking_tool`; that decision requires a timer-free end-to-end path.
 */
export function askEnvFor(runtime: string): Record<string, string> {
  return { ...(RUNTIMES[runtime]?.askEnv || {}) };
}

/** Whether this runtime can be driven as a chat at all. */
export function supportsChat(runtime: string): boolean {
  return runtime in RUNTIMES;
}

export function chatCapableRuntimes(): string[] {
  return Object.keys(RUNTIMES);
}

/**
 * What the launcher should show for a runtime before anything is running.
 *
 * Provisional by nature: several of these CLIs only reveal what they can do
 * during their handshake, so a live session's capabilities always win over
 * this. It exists so the launcher can grey out a Chat button honestly rather
 * than starting a process to find out.
 *
 * Not the answer for a conversation whose process is gone, which is the obvious
 * place to reach for it and was the wrong one (#30). This table is a runtime's
 * shape, and what goes missing from a resumed conversation is everything that
 * is not: the slash commands claude found in *this* project, the model list a
 * probe went and read, the effort ladder. Those were recorded in the log when
 * the runtime said them, so the store reads them back out of it — see
 * `sessionCapabilities` in store.ts. A row from this table would have restored
 * none of the three, and would have stated the rest on behalf of a process that
 * is not running to be asked.
 */
export function advertisedChatCapabilities(runtime: string): ChatCapabilities {
  const entry = RUNTIMES[runtime];
  if (!entry) return { ...NO_CHAT_CAPABILITIES };
  return {
    ...NO_CHAT_CAPABILITIES,
    ...entry.advertised,
    // Both are app-supplied capabilities. A runtime without an injectable tool
    // channel uses the normalized response fallback after it starts.
    questions: true,
    planMode: true,
  };
}

export function createChatAdapter(
  runtime: string,
  options: ChatAdapterOptions,
): ChatAdapter | null {
  const entry = RUNTIMES[runtime];
  if (!entry) return null;
  return entry.factory(options);
}

/**
 * Why a runtime has no chat mode, phrased for a person.
 *
 * Returns null when it does. The launcher shows this in a tooltip, so "Chat is
 * unavailable" is never left unexplained.
 */
export function chatUnavailableReason(runtime: string): string | null {
  if (supportsChat(runtime)) return null;
  if (runtime === 'terminal') {
    return 'A shell has no conversation to show — this is a terminal session.';
  }
  return 'This runtime has no verified structured mode yet, so it runs in the terminal only.';
}
