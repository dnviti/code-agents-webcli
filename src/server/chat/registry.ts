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
 * How a runtime is handed the MCP server that asks the user questions.
 *
 * `cli` — as a `--mcp-config` argument at spawn (claude).
 * `protocol` — in the handshake, as part of `session/new` (ACP agents).
 *
 * Absent means the runtime has no verified way to accept one, and it simply
 * reports `questions: false` rather than being handed a flag nobody has watched
 * it parse.
 *
 * A wired channel is not a promise the model will use it. kimi accepts the
 * server, spawns it and exposes the tool — verified — but ships a native
 * `AskUserQuestion` of its own that it often reaches for first, and that one
 * answers itself with "the user dismissed this" without anybody being asked.
 * Nothing here can redirect it: refusing the native call through the permission
 * channel just ends the turn, because ACP carries no reason back to the model.
 * Wiring it anyway is still strictly better than not — when the model does pick
 * this tool the question reaches a person, and when it does not, the outcome is
 * the one kimi would have produced regardless.
 */
export type AskChannel = 'cli' | 'protocol';

interface RuntimeChatEntry {
  factory: ChatAdapterFactory;
  /** What the launcher shows before a session exists. */
  advertised: Partial<ChatCapabilities>;
  askChannel?: AskChannel;
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
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      diffs: true,
      permissions: true,
      interrupt: true,
      resume: true,
      usage: true,
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
   * `askChannel` stays unset. Grok accepts `mcpServers` on `session/new`, but
   * nobody has watched a question from it reach this app's socket, and this
   * table does not advertise what has not been seen working.
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
    },
  },
  pi: {
    factory: (options) => new PiChatAdapter(options),
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      usage: true,
      cost: true,
    },
  },
  // Probed, not assumed: kimi 0.29.1 over ACP sends no `usage_update`, no
  // `usage` on its prompt reply and no `_meta` on any update, so it reports
  // neither tokens nor money. The adapter narrows the *running* session's
  // capabilities the same way (`NO_SPEND_REPORTING` in acp.ts); this row is
  // what the pre-session table says, and the two must not disagree.
  kimi: acp('kimi', ['acp'], { usage: false, cost: false }),
  omp: acp('omp', ['acp']),
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
   * `askChannel` stays unset for the same reason it is unset for grok: agy
   * accepts MCP servers through a config file of its own, but nobody has watched
   * a question from it reach this app's socket, and this table does not
   * advertise what has not been seen working.
   */
  antigravity: {
    factory: (options) => new AntigravityChatAdapter(options),
    advertised: {
      streaming: true,
      thinking: true,
      toolCalls: true,
      interrupt: true,
      resume: true,
      attachments: true,
      usage: true,
    },
  },
};

/**
 * How this runtime takes the question server, or undefined if it does not.
 *
 * Only the runtimes it has actually been watched working on: claude and the ACP
 * agents. Codex, pi and grok are one probe away, and get `questions: false`
 * until someone runs it.
 */
export function askChannelFor(runtime: string): AskChannel | undefined {
  return RUNTIMES[runtime]?.askChannel;
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
  return { ...NO_CHAT_CAPABILITIES, ...entry.advertised };
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
