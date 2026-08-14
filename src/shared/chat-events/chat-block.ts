import type { QuestionRequest } from './request.js';
import type {
  AttachmentBlock,
  ErrorBlock,
  ImageBlock,
  NoticeBlock,
  PlanBlock,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
} from './core.js';
/**
 * A durable question that had no tool-call block to render it.
 *
 * Native/MCP questions remain part of their `ToolBlock`. Structured-response
 * fallback questions do not have one, so the shared reducer folds their
 * question event into the assistant message as this block. That gives the
 * answered card a chronological home in copied/reloaded conversation history
 * instead of leaving it permanently pinned beside the composer.
 */
export interface InteractiveQuestionBlock {
  kind: 'question';
  request: QuestionRequest;
  /** The durable outcome, filled when the matching resolution event arrives. */
  answer?: {
    optionIds: string[];
    text?: string;
    skipped?: boolean;
    abandoned?: boolean;
  };
}

export type ChatBlock =
  | TextBlock
  | ThinkingBlock
  | ToolBlock
  | ImageBlock
  | AttachmentBlock
  | PlanBlock
  | ErrorBlock
  | NoticeBlock
  | InteractiveQuestionBlock;

