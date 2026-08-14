/**
 * One chat conversation, owned by the server.
 *
 * This file is a thin facade that re-exports the full public surface of the
 * session. The implementation lives in sibling modules:
 *   session-types.ts         - interfaces and internal question types
 *   session-errors.ts        - error classes
 *   session-constants.ts     - constants and small predicates
 *   session-question-helpers.ts - question directive/envelope helpers
 *   session-quote.ts         - quoteTurn / describeAsk
 *   session-base.ts          - state, constructor, accessors, method contract
 *   session-lifecycle.ts .. session-plans.ts  - the implementation chain
 *   session-class.ts         - final composed ChatSession
 */
export type {
  ChatSessionDeps,
  ModelCapacitySource,
  ChatUsageSink,
  ChatSessionStartOptions,
  PlanModeResult,
  AgentUpdateRestartResult,
  PlanSubmissionResult,
  PlanActionResult,
} from './session/session-types.js';
export { ChatNotRunningError, QueueFullError } from './session/session-errors.js';
export { ChatSession } from './session/session-class.js';
