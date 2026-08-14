/**
 * App-owned guided workflows.
 *
 * These names are a wire contract, not slash commands. The server keeps the
 * workflow identity beside a turn so it can add the bundled instructions only
 * at runtime while the transcript continues to contain exactly what the user
 * wrote.
 */
export const BUILT_IN_WORKFLOW_IDS = ['gh-issue'] as const;
export type BuiltInWorkflowId = typeof BUILT_IN_WORKFLOW_IDS[number];

/** The one-field workflow prompt is intentionally bounded before it reaches a runtime. */
export const MAX_BUILT_IN_WORKFLOW_PROMPT = 20_000;

export function isBuiltInWorkflowId(value: unknown): value is BuiltInWorkflowId {
  return typeof value === 'string' && (BUILT_IN_WORKFLOW_IDS as readonly string[]).includes(value);
}

