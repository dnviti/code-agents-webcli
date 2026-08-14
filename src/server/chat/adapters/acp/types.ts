import { ChatAdapterOptions } from '../../adapter.js';
import { ChatRole } from '../../../../shared/chat-events.js';

export interface AcpChatAdapterOptions extends ChatAdapterOptions {
  /** Which CLI this instance drives. Labels errors; never changes behaviour. */
  runtime?: string;
  /** Argv that puts the CLI into ACP mode. All three spell it `acp`. */
  acpArgs?: string[];
}

/**
 * A message being assembled.
 *
 * `nativeId` is the agent's own messageId, carried on every chunk. Two chunks
 * with different ids are two different messages even inside one turn — omp
 * closes its thinking message and opens a fresh one for the answer — so this is
 * tracked rather than assuming one assistant message per prompt.
 */
export interface OpenMessage {
  id: string;
  nativeId: string | null;
  role: ChatRole;
  nextIndex: number;
  /** The text/thinking block currently accepting deltas, if any. */
  open: { kind: 'text' | 'thinking'; index: number } | null;
}
