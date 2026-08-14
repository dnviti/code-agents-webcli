import { ChatControllerModel } from './model.js';
import { BuiltInWorkflowId, PlanDocument } from '../../../shared/chat-events.js';
import { BuiltInWorkflowStartResult, PlanActionFeedback } from './types.js';
import { createBuiltInWorkflowRequestId } from './wire.js';

/**
 * Conversation plan state and app-owned guided workflow admission.
 */
export abstract class ChatControllerPlan extends ChatControllerModel {
  /**
   * Start an app-bundled guided workflow without changing this conversation's
   * composer draft. The popup owns its field until the server explicitly says
   * the turn was accepted or queued.
   */
  startBuiltInWorkflow(
    workflow: BuiltInWorkflowId,
    prompt: string,
    requestId = createBuiltInWorkflowRequestId(),
  ): Promise<BuiltInWorkflowStartResult> {
    if (!this.builtInWorkflows) {
      return Promise.reject(new Error(
        'This server does not support guided workflows. Update or restart the server, then try again.',
      ));
    }
    if (this.workflowRequests.has(requestId)) {
      return Promise.reject(new Error('This guided workflow request is already being submitted.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.workflowRequests.get(requestId);
        if (!pending) return;
        this.workflowRequests.delete(requestId);
        pending.reject(new Error('The guided workflow request timed out. Please try again.'));
      }, 30_000);
      this.workflowRequests.set(requestId, { workflow, resolve, reject, timer });
      this.send({ type: 'chat_start_builtin_workflow', requestId, workflow, text: prompt });
    });
  }

  /**
   * Release the server's dedupe entry only after the caller has completed its
   * local success handoff and will no longer retry this request id.
   */
  acknowledgeBuiltInWorkflow(workflow: BuiltInWorkflowId, requestId: string): void {
    if (!this.builtInWorkflows || !requestId) return;
    this.send({ type: 'chat_builtin_workflow_ack', requestId, workflow });
  }

  /** Whether this server accepts correlated app-owned workflow turns. */
  get builtInWorkflowsAvailable(): boolean {
    return this.builtInWorkflows;
  }

  /** Told by the registry whenever a handshake (including a reconnect) arrives. */
  setBuiltInWorkflowSupport(enabled: boolean): void {
    if (this.builtInWorkflows === enabled) return;
    this.builtInWorkflows = enabled;
    this.options.onChange?.();
  }

  get planModeValue(): boolean { return this.planMode; }

  get planDocumentValue(): PlanDocument | null { return this.planDocument; }

  get planFeedback(): PlanActionFeedback | null { return this.planResult; }

  setPlanMode(planMode: boolean): void {
    this.planResult = null;
    this.options.onChange?.();
    this.send({ type: 'chat_set_plan_mode', planMode });
  }

  acceptPlan(revision: number): void {
    this.planResult = null;
    this.options.onChange?.();
    this.send({ type: 'chat_accept_plan', revision });
  }

  rejectPlan(revision: number): void {
    this.planResult = null;
    this.options.onChange?.();
    this.send({ type: 'chat_reject_plan', revision });
  }
}
