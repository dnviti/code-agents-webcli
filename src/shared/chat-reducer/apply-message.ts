import {
  ChatEvent,
  ChatMessage,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  isSessionMintedMessageId,
  mergeUsage,
} from '../chat-events.js';
import { openTurnAfter } from '../turn-boundaries.js';
import { foldSessionUsage } from './fold.js';
import { lastTurnId, messageFor } from './core.js';
import { NO_CHANGE, TranscriptChange, TranscriptState } from './types.js';

/**
 * The message and block lifecycle: a message opens, its blocks open, stream
 * deltas and close, and the message itself closes. Delivered addressed, so a
 * missing target means "already known / out of window" rather than an error.
 */
export function applyMessage(state: TranscriptState, event: ChatEvent): TranscriptChange {
  switch (event.t) {
    case 'msg_start': {
      // Idempotent: a replayed start must not fork the message in two.
      if (messageFor(state, event.id) !== null) {
        return NO_CHANGE;
      }
      // A prompt the runtime handed back, in a conversation recorded before the
      // adapters stopped doing it (#129).
      //
      // Every ACP runtime and both codex modes used to write the user's message
      // into the transcript a second time, under a turn id of their own, right
      // after the session had written it — one prompt, two identical bubbles.
      // The adapters no longer do it and the session now refuses it, but the
      // logs already on disk still hold both, and they are replayed through
      // this reducer every time one of those conversations is opened. Drawing
      // them is not something a migration should have to fix.
      //
      // The test is what the echo *is*, not what it looks like: only
      // `ChatSession.deliver` ever writes a user message in this app, and it
      // always mints `user-<uuid>`. So a message claiming to be the user, with
      // an id nothing in this app would have minted, arriving inside a turn
      // that already carries the user's own — that is a runtime repeating the
      // prompt. A real second prompt cannot be caught by it: a real one comes
      // from `deliver`, and is therefore session-minted. `steer` is excluded
      // because a steer is also `deliver`'s and shares the open turn on purpose.
      if (
        event.role === 'user'
        && !event.steer
        && state.currentTurnId
        && event.turnId !== state.currentTurnId
        && !isSessionMintedMessageId(event.id)
        && state.messages.some((m) => m.turnId === state.currentTurnId && m.role === 'user')
      ) {
        return NO_CHANGE;
      }
      // Everything said while a turn is open belongs to that turn, whatever id
      // it arrived with — the accountant's rule, word for word (#86).
      //
      // It has to be that strong, because **no adapter reuses the id this app
      // minted**: the session stamps the user's message `turn-<uuid>` and the
      // runtime answers under a name of its own (`omp-turn-3`, its own uuid),
      // with codex and the ACP agents echoing the prompt back under that name
      // first. Checked against every conversation on this machine: in 46 of 46,
      // the agent's messages share no id with the request that caused them. So
      // grouping on the id as it arrives splits every single turn in two — the
      // ask in one, the answer in another with no prompt to name it by.
      //
      // A turn is open from the user's message to `turn_end`, and `turn_end`,
      // an exit and a `/clear` are the three things that close one — and an
      // agent that speaks again with no request in front of it goes back to the
      // turn it was last working on rather than opening one nobody asked for.
      // See `openTurnAfter`, which is that whole rule and is also what the
      // server's turn index and its windowed reads apply.
      const turnId = openTurnAfter(event, state.currentTurnId, lastTurnId(state)) as string;

      // A new turn's models are not known yet, and last turn's are not this
      // turn's: leaving them would keep a "+1" on the chip for a turn that ran
      // on one model, which is a claim about work that has not happened.
      if (turnId !== state.currentTurnId) state.turnModels = undefined;
      const message: ChatMessage = {
        id: event.id,
        seq: event.seq,
        turnId,
        role: event.role,
        ts: event.ts,
        blocks: [],
        streaming: true,
        model: event.model,
        ...(event.workflow ? { workflow: event.workflow } : {}),
        ...(event.steer ? { steer: true as const } : {}),
      };
      state.index[event.id] = state.messages.length;
      state.messages.push(message);
      state.currentTurnId = turnId;
      return {
        messageIndex: state.messages.length - 1,
        structural: true,
        meta: false,
        applied: true,
      };
    }

    case 'block_start': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const message = state.messages[at];
      // Index is authoritative: runtimes address blocks by position, and a
      // gap means an event was lost, not that the block should be appended.
      while (message.blocks.length < event.index) {
        message.blocks.push({ kind: 'text', text: '' });
      }
      message.blocks[event.index] = event.block;
      if (event.block.kind === 'tool') {
        const toolId = event.block.toolId;
        state.toolIndex[toolId] = [at, event.index];
        const orphan = state.orphanToolPatches[toolId];
        if (orphan) {
          Object.assign(message.blocks[event.index] as ToolBlock, orphan);
          delete state.orphanToolPatches[toolId];
        }
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'block_delta': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const block = state.messages[at].blocks[event.index];
      if (!block) return NO_CHANGE;
      if (event.text !== undefined) {
        if (block.kind === 'text' || block.kind === 'thinking') {
          (block as TextBlock | ThinkingBlock).text += event.text;
        } else if (block.kind === 'tool') {
          // Streaming tool output, as opposed to streaming arguments.
          const tool = block as ToolBlock;
          tool.output = (tool.output || '') + event.text;
        }
      }
      if (event.json !== undefined && block.kind === 'tool') {
        const tool = block as ToolBlock;
        tool.inputPartial = (tool.inputPartial || '') + event.json;
      }
      // Additive, like the text beside it: a runtime that will not show its
      // reasoning still counts it out loud as it goes, and the row's size
      // figure should climb while the model is still thinking rather than
      // appearing all at once when the block closes.
      if (event.tokens !== undefined && block.kind === 'thinking') {
        const thinking = block as ThinkingBlock;
        thinking.tokens = (thinking.tokens ?? 0) + event.tokens;
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'block_end': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const block = state.messages[at].blocks[event.index];
      if (!block) return NO_CHANGE;
      if (event.block) {
        Object.assign(block, event.block);
      }
      if (block.kind === 'tool') {
        const tool = block as ToolBlock;
        // Arguments streamed in as JSON fragments only become usable now.
        if (tool.input === undefined && tool.inputPartial) {
          try {
            tool.input = JSON.parse(tool.inputPartial);
          } catch {
            // Keep the raw fragment: a half-written argument list is still
            // worth showing, and throwing here would lose the whole card.
            tool.input = tool.inputPartial;
          }
          delete tool.inputPartial;
        }
      }
      return { messageIndex: at, structural: false, meta: false, applied: true };
    }

    case 'msg_end': {
      const at = messageFor(state, event.msgId);
      if (at === null) return NO_CHANGE;
      const message = state.messages[at];
      message.streaming = false;
      if (event.stopReason) message.stopReason = event.stopReason;
      if (event.usage) {
        message.usage = mergeUsage(message.usage, event.usage);
        state.usage = foldSessionUsage(state.usage, event);
      }
      return {
        messageIndex: at,
        structural: false,
        meta: Boolean(event.usage),
        applied: true,
      };
    }

    default:
      return NO_CHANGE;
  }
}
