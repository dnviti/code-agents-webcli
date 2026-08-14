import { sendToWebSocket } from './handler.js';
import { IncomingMessage } from './messages-shared.js';
import { MessageProcessorChatControlBase } from './messages-chat-control.js';
export class MessageProcessor extends MessageProcessorChatControlBase {


  async handleMessage(wsId: string, data: IncomingMessage): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    switch (data.type) {
      case 'create_session':
        await this.createAndJoinSession(wsId, data.name, data.workingDir);
        break;

      case 'join_session':
        await this.joinSession(wsId, data.sessionId!);
        break;

      case 'leave_session':
        await this.leaveSession(wsId, data.sessionId);
        break;

      case 'start_claude':
        await this.startRuntime(wsId, 'claude', data.options || {});
        break;

      case 'start_codex':
        await this.startRuntime(wsId, 'codex', data.options || {});
        break;

      case 'start_agent':
        await this.startRuntime(wsId, 'agent', data.options || {});
        break;

      case 'start_pi':
        await this.startRuntime(wsId, 'pi', data.options || {});
        break;

      case 'start_grok':
        await this.startRuntime(wsId, 'grok', data.options || {});
        break;

      case 'start_qwen':
        await this.startRuntime(wsId, 'qwen', data.options || {});
        break;

      case 'start_kimi':
        await this.startRuntime(wsId, 'kimi', data.options || {});
        break;

      case 'start_omp':
        await this.startRuntime(wsId, 'omp', data.options || {});
        break;

      case 'start_antigravity':
        await this.startRuntime(wsId, 'antigravity', data.options || {});
        break;

      case 'start_terminal':
        await this.startRuntime(wsId, 'terminal', data.options || {});
        break;

      case 'runtime_restart':
        await this.handleAgentUpdateRestart(wsId, wsInfo, data);
        break;

      case 'start_chat':
        await this.startChat(
          wsId,
          String(data.agentKind || ''),
          data.options || {},
          typeof data.sessionId === 'string' ? data.sessionId : undefined,
        );
        break;

      case 'chat_send':
        await this.handleChatSend(wsInfo, data);
        break;

      case 'chat_start_builtin_workflow':
        await this.handleChatStartBuiltInWorkflow(wsInfo, data);
        break;

      case 'chat_builtin_workflow_ack':
        this.handleChatBuiltInWorkflowAck(wsInfo, data);
        break;

      case 'chat_interrupt':
        await this.handleChatInterrupt(wsInfo, data);
        break;

      case 'chat_set_model':
        await this.handleChatSetModel(wsInfo, data);
        break;

      case 'chat_set_effort':
        await this.handleChatSetEffort(wsInfo, data);
        break;

      case 'chat_set_plan_mode':
        await this.handleChatSetPlanMode(wsInfo, data);
        break;

      case 'chat_accept_plan':
        await this.handleChatPlanAction(wsInfo, data, 'accept');
        break;

      case 'chat_reject_plan':
        await this.handleChatPlanAction(wsInfo, data, 'reject');
        break;

      case 'chat_queue_cancel':
        this.handleChatQueueCancel(wsInfo, data);
        break;

      case 'chat_queue_send_now':
        await this.handleChatQueueSendNow(wsInfo, data);
        break;

      case 'chat_queue_retry':
        this.handleChatQueueRetry(wsInfo, data);
        break;

      case 'chat_permission_response':
        this.handleChatPermission(wsInfo, data);
        break;

      case 'chat_question_answer':
        await this.handleChatQuestion(wsInfo, data);
        break;

      case 'chat_history_request':
        await this.handleChatHistory(wsInfo, data);
        break;

      case 'chat_turn_index_request':
        await this.handleChatTurnIndex(wsInfo, data);
        break;

      case 'chat_draft':
        await this.handleChatDraft(wsInfo, data);
        break;

      case 'chat_subscribe':
        await this.subscribeChat(wsInfo, data.sessionId || '');
        break;

      case 'chat_unsubscribe':
        if (data.sessionId) this.unsubscribeChat(wsInfo, data.sessionId);
        break;

      case 'input':
        await this.handleInput(wsId, wsInfo, data.data || '');
        break;

      case 'resize':
        await this.handleResize(wsId, wsInfo, data.cols || 80, data.rows || 24);
        break;

      case 'stop':
        await this.handleStop(wsInfo);
        break;

      case 'history_request':
        await this.handleHistoryRequest(wsInfo, data);
        break;

      case 'ping':
        sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'get_usage':
        await this.handleGetUsage(wsInfo);
        break;

      // Closing is done over HTTP; the socket message is the client's older
      // half of that call and still arrives. Named explicitly so it stays a
      // no-op rather than being reported as unknown below.
      case 'close_session':
        break;

      default:
        if (this.deps.dev) {
          console.log(`Unknown message type: ${data.type}`);
        }
        // Answered rather than dropped. A request this server has never heard
        // of is almost always a page built against newer code than the running
        // process — which loads its own code once, at boot. Silence left the
        // browser waiting on a reply that was never coming; saying so turns an
        // indefinite spinner into a sentence naming the fix.
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message:
            `This server does not understand "${data.type}". It is probably running ` +
            'an older version than this page — restart the server and reload.',
        });
    }
  }

}
