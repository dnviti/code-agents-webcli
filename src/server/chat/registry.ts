import {
  ChatCapabilities,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { ChatAdapter, ChatAdapterOptions } from './adapter.js';
import { AcpChatAdapter } from './adapters/acp.js';
import { ClaudeChatAdapter } from './adapters/claude.js';
import { CodexChatAdapter } from './adapters/codex.js';
import { GrokChatAdapter } from './adapters/grok.js';
import { PiChatAdapter } from './adapters/pi.js';

/**
 * Which runtimes can be driven as a chat, and by which adapter.
 *
 * Four adapter families cover them, and the ACP one covers three CLIs by itself
 * because they all speak the Agent Client Protocol — adding a fourth ACP agent
 * is a row in this table, not a new adapter.
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
function acp(runtime: string, acpArgs: string[]): RuntimeChatEntry {
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
  grok: {
    factory: (options) => new GrokChatAdapter(options),
    advertised: { streaming: true, toolCalls: true, usage: true },
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
  kimi: acp('kimi', ['acp']),
  omp: acp('omp', ['acp']),
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
