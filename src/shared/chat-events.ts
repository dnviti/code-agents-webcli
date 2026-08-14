/**
 * The chat event model: one vocabulary every runtime is translated into.
 *
 * Facade over the split implementation in `./chat-events/`. Every export the
 * original file surfaced is re-exported here, so all existing importers keep
 * working through this single path.
 */
export type { TurnOutcome } from './turn-outcome.js';

export type {
  ChatSurface,
  ChatRole,
  ToolStatus,
  ToolKind,
  DiffHunk,
  FileDiff,
  PlanItem,
  PlanDocument,
  TextBlock,
  ThinkingBlock,
  ToolBlock,
  AgentStep,
  AgentStepPatch,
  AgentRun,
  WorkflowPhase,
  WorkflowAgentState,
  WorkflowAgent,
  WorkflowRun,
  ImageBlock,
  AttachmentBlock,
  PlanBlock,
  ErrorBlock,
  NoticeBlock,
} from './chat-events/core.js';

export type { InteractiveQuestionBlock, ChatBlock } from './chat-events/chat-block.js';

export type {
  ChatUsage,
  TurnModelUsage,
  ContextWindowSource,
  SpendSource,
  AccountLimitWindow,
  AccountLimits,
} from './chat-events/usage.js';
export { carriesTokens, carriesCost, mergeUsage } from './chat-events/usage.js';

export type { ChatTurnIndexEntry, ChatMessage } from './chat-events/message.js';

export type {
  PermissionOption,
  PermissionRequest,
  QuestionOption,
  QuestionOrigin,
  QuestionRequest,
  QuestionContinuation,
} from './chat-events/request.js';
export { defaultPermissionOptions, isAllowOption } from './chat-events/request.js';

export type {
  ChatState,
  ChatCapabilities,
  SlashCommand,
  ModelChoice,
  ChatModelDefault,
  ModelDefaultSource,
  ChatModelOrigin,
  EffortChoice,
} from './chat-events/model.js';
export { rankedEfforts, NO_CHAT_CAPABILITIES } from './chat-events/model.js';

export type { ChatEvent } from './chat-events/event.js';

export type { ChatAttachment, UserTurn, ChatDraft, QueuedTurn } from './chat-events/draft.js';
export { MAX_QUEUED_TURNS } from './chat-events/draft.js';

export type { BuiltInWorkflowId } from './chat-events/workflow.js';
export {
  BUILT_IN_WORKFLOW_IDS,
  MAX_BUILT_IN_WORKFLOW_PROMPT,
  isBuiltInWorkflowId,
} from './chat-events/workflow.js';

export type { ChatSnapshot } from './chat-events/snapshot.js';

export type { AskedQuestion } from './chat-events/tools.js';
export {
  ASK_MCP_SERVER,
  isSessionMintedMessageId,
  ASK_QUESTION_TOOL,
  QUESTION_FALLBACK_OPEN,
  QUESTION_FALLBACK_CLOSE,
  SUBMIT_PLAN_TOOL,
  SUBMIT_PLAN_TOOL_NAME,
  MAX_PLAN_TEXT,
  SUBMIT_PLAN_TOOL_DESCRIPTION,
  TIER_TOOL,
  TIER_TOOL_NAME,
  ASK_QUESTION_TOOL_NAME,
  OWN_WORDS_LABEL,
  MAX_QUESTION_ANSWER_TEXT,
  withoutQuestionFallbackEnvelope,
  planModeDirective,
  acceptedPlanDirective,
  normalizeQuestionOptions,
  isOwnWordsOption,
  splitOwnWordsOption,
  isAskQuestionTool,
  looksLikeAskCall,
  askedQuestionFrom,
  classifyTool,
} from './chat-events/tools.js';
