import { ChatControllerBase } from './base.js';
import { ChatAttachment } from '../../../shared/chat-events.js';
import { ChatUnavailable } from './types.js';
import { createQuestionAnswerSubmissionId } from './wire.js';

/**
 * Connection lifecycle, relaunch, sending turns, and correlated question answers.
 */
export abstract class ChatControllerConnection extends ChatControllerBase {
  /**
   * The recovery offer to show, or null.
   *
   * Two ways in. The snapshot says so on arrival — a tab reopened after the
   * server restarted knows before the user types anything — and `chat_send`
   * says so when the first message finds nothing to send to, which covers the
   * process dying while the tab sat open.
   */
  get unavailableReason(): ChatUnavailable | null {
    if (this.unavailable) return this.unavailable;
    // `cursor`, not the message count: a conversation that was cleared has no
    // messages and every bit as much of a dead runtime behind it. Gating on
    // messages put that case straight back into the failure this exists to
    // replace — an idle-looking pane whose first message comes back as an
    // error. A session where chat has never started has a cursor of 0, which is
    // the case that must *not* be offered a resume.
    if (this.transcript.live || this.transcript.cursor <= 0) return null;
    // Empty label, not a guess: a snapshot does not carry one, and the pane
    // rendering this already knows what the runtime is called. "the agent"
    // written here would win over the real name and read as a downgrade.
    return {
      message: 'this chat session is not running',
      runtimeLabel: '',
      canResume: this.transcript.canResume,
    };
  }

  get connectionAvailable(): boolean {
    return this.transportConnected;
  }

  /**
   * Put a runtime back on this conversation.
   *
   * `resume` is the whole choice: with it the agent is handed its own session
   * back and knows what is on screen; without it the transcript stays as a
   * record and the agent starts fresh. Either way it is this session, in this
   * tab — a new one would leave the conversation behind.
   *
   * Deliberately says nothing about the approval mode. The server has the
   * conversation's own recorded against it and restores that, which is both the
   * right answer and the safe one: a relaunch that carried a mode would be a
   * browser asking for a standing permission, and this browser's copy of it is
   * exactly the thing that used to be wrong after a restart.
   */
  relaunch(agentKind: string, options: { resume: boolean }): void {
    if (!this.transportConnected) return;
    this.unavailable = null;
    this.options.onChange?.();
    this.send({
      type: 'start_chat',
      agentKind,
      options: { resume: options.resume },
    });
  }

  /**
   * Ask the agent something.
   *
   * `fromComposer` is what separates a turn somebody just typed from one being
   * sent again from the transcript, and it is the composer's emptying that hangs
   * on it: "send this turn again" takes its text from the log and never touches
   * the input, so a conversation being retried must not blank a half-written
   * message — here or on any other screen watching it.
   */
  sendTurn(
    text: string,
    attachments: ChatAttachment[] = [],
    { fromComposer = false }: { fromComposer?: boolean } = {},
  ): boolean {
    const trimmed = text.trim();
    if ((!trimmed && !attachments.length) || !this.transportConnected) return false;
    if (fromComposer) {
      // Whatever was waiting for the publish interval is about to be wrong: the
      // composer is empty from this moment on every screen, and a trailing frame
      // landing after the server's own clear would put the sent message straight
      // back into all of them. Dropped rather than flushed, and the local record
      // set to empty so the surface's own clear is not announced either — the
      // server empties the composer as part of accepting the turn, which is both
      // sooner and more truthful than this browser guessing at it.
      this.draftPending = null;
      this.draftPublished = { text: '', attachments: [] };
    }
    return this.send({ type: 'chat_send', text: trimmed, attachments, fromComposer }) !== false;
  }

  /**
   * Answer a multiple-choice question the model asked.
   *
   * `skipped` is explicit rather than inferred from an empty list: "I picked
   * none of these" and "I do not want to answer" reach the model as different
   * sentences, and the agent is blocked either way until one of them arrives.
   *
   * `text` is the third of those sentences — the user answering in their own
   * words — and travels beside the picks rather than as one of them, because
   * the ids name options the question offered and this is the part it did not.
   */
  answerQuestion(
    requestId: string,
    optionIds: string[],
    skipped = false,
    text?: string,
  ): Promise<boolean> {
    const submissionId = createQuestionAnswerSubmissionId();
    return new Promise((resolve) => {
      this.questionAnswers.set(submissionId, { requestId, resolve });
      const sent = this.send({
        type: 'chat_question_answer', requestId, optionIds, skipped, text, submissionId,
      });
      // Undefined remains compatible with isolated controllers and older
      // embedders. A real closed socket returns false and cannot look accepted.
      if (sent === false) this.settleQuestionAnswer(submissionId, false);
    });
  }

  /** Reject unacknowledged answers when their socket goes away; never retry. */
  connectionLost(notify = true): void {
    const changed = this.transportConnected;
    this.transportConnected = false;
    for (const submissionId of Array.from(this.questionAnswers.keys())) {
      this.settleQuestionAnswer(submissionId, false);
    }
    if (changed && notify) this.options.onChange?.();
  }

  connectionRestored(): void {
    if (this.transportConnected) return;
    this.transportConnected = true;
    this.options.onChange?.();
  }

  private settleQuestionAnswer(submissionOrRequestId: string, accepted: boolean): void {
    const direct = this.questionAnswers.get(submissionOrRequestId);
    if (direct) {
      this.questionAnswers.delete(submissionOrRequestId);
      direct.resolve(accepted);
      return;
    }
    for (const [submissionId, pending] of this.questionAnswers) {
      if (pending.requestId !== submissionOrRequestId) continue;
      this.questionAnswers.delete(submissionId);
      // A durable resolution is authoritative; the card reads it from the log.
      pending.resolve(accepted);
    }
  }

  respondPermission(requestId: string, optionId: string): void {
    this.send({ type: 'chat_permission_response', requestId, optionId });
  }
}
