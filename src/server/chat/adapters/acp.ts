/**
 * Agent Client Protocol client.
 *
 * One adapter, three CLIs today (kimi, omp, opencode) and any future ACP agent
 * for nothing — which is why this one is written against the protocol rather
 * than against any of them. Where the three disagree the wire log decides:
 * everything below was checked against `.work/probes/raw/{omp,opencode,kimi}-acp.jsonl`.
 *
 * ACP inverts the usual direction of a CLI integration. The agent has no
 * filesystem of its own and no way to ask a human anything; it asks *us*, over
 * the same pipe, and blocks until we answer. So the request half of this class
 * is not an optional nicety — an adapter that only listens deadlocks the agent
 * on its first file read.
 *
 * The implementation lives in the `acp/` subfolder behind this re-export
 * facade: `incoming.ts` holds the concrete `AcpChatAdapter` (the incoming
 * half), completed by the outgoing, message-assembly and handshake partials
 * and the pure conversion helpers. The public surface is unchanged.
 */
export { AcpChatAdapter } from './acp/incoming.js';
export type { AcpChatAdapterOptions } from './acp/types.js';
