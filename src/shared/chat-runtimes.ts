/**
 * Which runtimes can be opened as a web chat.
 *
 * Shared so the launcher and the server cannot disagree. The server's registry
 * holds the adapters; this holds only the list, because the browser needs to
 * know whether to offer the button before any session exists, and a second
 * hand-maintained copy of that list would go stale the first time an adapter
 * was added.
 *
 * A runtime is on this list only once its structured protocol has actually been
 * captured and an adapter written against the capture. Two are deliberately
 * absent: `qwen`, which is not installed here so its protocol was never
 * observed, and `agent` (cursor-agent), whose structured mode was likewise
 * never verified. Both are one probe away from being added, and neither gets a
 * guessed adapter — a protocol written from imagination fails in front of a
 * user, mid-turn, which is the worst place to discover it.
 */
export const CHAT_RUNTIMES = ['claude', 'codex', 'grok', 'pi', 'kimi', 'omp'] as const;

export type ChatRuntime = (typeof CHAT_RUNTIMES)[number];

export function isChatRuntime(runtime: string): boolean {
  return (CHAT_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * Why a runtime offers no chat, phrased for a person.
 *
 * Returns null when it does. Shown in the disabled button's tooltip, so
 * "unavailable" is never left unexplained — the rule this feature is built on
 * is that a control either works or says why it cannot.
 */
export function chatUnavailableReason(runtime: string): string | null {
  if (isChatRuntime(runtime)) return null;
  if (runtime === 'terminal') {
    return 'A shell has no conversation to show — this is a terminal session.';
  }
  return 'This runtime has no verified structured mode yet, so it opens in the terminal only.';
}

/** Label for the control that opens a runtime as a chat. */
export const CHAT_LAUNCH_LABEL = 'WebUI (Beta)';
