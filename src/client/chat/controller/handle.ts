import { ChatControllerPlan } from './plan.js';
import {
  ChatCapabilities,
  ChatEvent,
  ChatSnapshot,
  ChatTurnIndexEntry,
  ChatUsage,
  QueuedTurn,
} from '../../../shared/chat-events.js';
import { EffortSwitchResult, ModelSwitchResult } from './types.js';
import { readDraft, readModelDefault, readModelOrigin, readPlanDocument } from './wire.js';

/**
 * The socket message dispatcher: MESSAGE_TYPES and handle().
 */
export abstract class ChatControllerHandle extends ChatControllerPlan {
  /**
   * Every message type this class answers to, for whoever routes to it.
   *
   * Beside the switch it describes, because it is the same list twice and the
   * copy that lived elsewhere fell behind: `chat_turn_index`, `chat_turn_spend`
   * and `chat_model_result` were all added here and never added there, so the
   * registry dropped them before a controller ever saw them. That is not a
   * missing handler — the message goes to the terminal's handler, which has no
   * idea what a chat message is, and it is discarded in silence. What it cost:
   * a conversation numbered by the window instead of by the recording, and no
   * per-turn spend on screen at all.
   */
  static readonly MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'chat_snapshot',
    'chat_started',
    'chat_event',
    'chat_draft',
    'chat_queue',
    'chat_page',
    'chat_page_failed',
    'chat_unavailable',
    'chat_model_result',
    'chat_effort_result',
    'chat_plan_mode',
    'chat_plan_document',
    'chat_plan_action',
    'chat_plan_result',
    'chat_plan_accept_result',
    'chat_plan_reject_result',
    'chat_builtin_workflow_result',
    'chat_question_answer_ack',
    'chat_turn_index',
    'chat_turn_index_failed',
    'chat_turn_spend',
  ]);

  /**
   * Apply a server message already known to belong to this session.
   *
   * Returns whether it belonged to the chat surface, so the terminal's own
   * handler can go on ignoring everything it does not recognise rather than
   * needing to know this exists.
   */
  handle(message: Record<string, unknown>): boolean {
    const type = String(message.type || '');

    switch (type) {
      case 'chat_snapshot': {
        const snapshot = message.snapshot as ChatSnapshot | undefined;
        if (!snapshot) return true;
        this.settlePage();
        // A rejoin replaces the window a jump was walking back through, and its
        // paging floor with it. Whatever it was looking for has to be asked for
        // again from where the conversation now stands.
        this.cancelSeek();
        this.transcript.hydrate(snapshot);
        // Asked for once per open. The list only grows at the end, and the end
        // is the part this browser is certain to be holding.
        this.requestTurnIndex();
        this.modelOverride =
          typeof message.modelOverride === 'string' ? message.modelOverride : null;
        this.modelDefault = readModelDefault(message.modelDefault);
        this.modelPinned = typeof message.modelPinned === 'string' ? message.modelPinned : null;
        this.modelOrigin = readModelOrigin(message.modelOrigin);
        this.ladderError =
          typeof message.ladderError === 'string' && message.ladderError
            ? message.ladderError
            : null;
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
        const planSnapshot = snapshot as ChatSnapshot & { planMode?: unknown; planDocument?: unknown };
        this.planMode = planSnapshot.planMode === true || message.planMode === true;
        this.planDocument = readPlanDocument(planSnapshot.planDocument ?? message.planDocument);
        // The composer rides on the join, so a conversation opened on a second
        // screen opens at the sentence the first one is in the middle of. A
        // server with nothing to say about it — one that predates this, or one
        // that has restarted since anybody typed — leaves this browser's own
        // copy alone and is told about it instead; see `adoptDraft`.
        this.adoptDraft(readDraft(message.draft));
        this.options.onChange?.();
        return true;
      }

      case 'chat_draft': {
        const draft = readDraft(message.draft);
        // Stale, and the only ordinary way to arrive here is a rejoin: the
        // snapshot carries the composer too, so a draft already folded in from
        // it must not be applied a second time on the broadcast that follows.
        if (!draft || draft.revision <= this.draft.revision) return true;
        this.draft = draft;

        // This screen's own typing, numbered and handed back. The field already
        // holds every character of it and has moved on since — writing it back
        // would take the caret with it, a quarter of a second into the past.
        const origin = this.options.origin?.() ?? null;
        if (origin && message.origin === origin) return true;

        // Recorded as though this browser had sent it, so the surface applying
        // it does not announce it straight back and set the two screens echoing.
        this.draftPublished = { text: draft.text, attachments: draft.attachments };
        // And whatever this screen still had queued is dropped, because it is
        // now an answer to a question nobody asked: the field it came from has
        // just been overwritten with this. Left in, it would go out a moment
        // later, replace the arriving text on the server and on the screen that
        // sent it — while this screen went on showing what it had adopted. Two
        // screens, each showing what the other one is not, and nothing left to
        // correct either of them.
        this.draftPending = null;
        this.emitDraft(draft);
        return true;
      }

      case 'chat_started': {
        // Whatever went wrong is over: something is running again.
        //
        // Both halves are needed. Clearing the stored reason alone left the
        // derived one — which reads `transcript.live` — reporting the same
        // thing a moment later, so the offer stayed on screen over a
        // conversation that was already running and only a page reload fixed
        // it. The transcript is where "is anything behind this" actually lives.
        this.unavailable = null;
        this.transcript.setLive(true);
        // The launch announces the mode it actually started in, which is not
        // necessarily the one this browser asked for: a relaunch names no mode
        // at all and the server restores the conversation's own. Taken from the
        // message rather than assumed, so the badge cannot claim a mode the
        // process is not running in.
        this.transcript.setBypassing(message.bypassPermissions === true);
        // And what the thing that just started can do, which nothing else on
        // this path will say. The launch has carried them all along and this
        // handler read past them: a conversation resumed from history kept the
        // capabilities its snapshot arrived with, so a browser that hydrated
        // with none — every conversation longer than the replay window, before
        // the store learned to recover them (#30) — stayed without a command
        // menu, an attachment control or a working stop button until the user
        // sent a throwaway message.
        //
        // Nothing re-requests a snapshot here, and that is not an oversight to
        // route around: the surface is already 'chat', so no re-subscribe
        // fires, and hydrating a live conversation from the log to learn one
        // field would throw away everything arriving on it.
        //
        // All of them except the command list, when the conversation already
        // holds one. What a launch announces there is this app's stand-in —
        // the built-ins plus whatever the disk scan found — and claude does not
        // publish its real list until the `init` of its first turn, so folding
        // the stand-in in on every relaunch would take the runtime's own names
        // back off the menu and put names it has no command for back on.
        const capabilities = message.capabilities as Partial<ChatCapabilities> | undefined;
        if (capabilities) {
          const held = this.transcript.capabilities.commands;
          const { commands, ...rest } = capabilities;
          this.transcript.setCapabilities(held && held.length ? rest : capabilities);
        }
        this.modelOverride =
          typeof message.modelOverride === 'string' ? message.modelOverride : null;
        this.modelDefault = readModelDefault(message.modelDefault);
        this.modelPinned = typeof message.modelPinned === 'string' ? message.modelPinned : null;
        this.modelOrigin = readModelOrigin(message.modelOrigin);
        this.ladderError =
          typeof message.ladderError === 'string' && message.ladderError
            ? message.ladderError
            : null;
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
        this.planMode = message.planMode === true;
        this.options.onChange?.();
        return true;
      }

      case 'chat_model_result': {
        const applied = (message.applied as ModelSwitchResult['applied']) || 'pending';
        // Only 'live'/'cleared' mean the session is actually running this model now.
        // 'sent'/'pending' are best-effort or deferred-to-next-launch — adopting the
        // label for those would claim a model is active when it is not yet, or may
        // never be without a relaunch.
        if (applied === 'live' || applied === 'cleared') {
          this.modelOverride = typeof message.model === 'string' ? message.model : null;
        }
        // Unconditionally, unlike the label above, and that is the point: a
        // pick the running session could not take still changed what the *next*
        // new conversation opens on, and a clear still forgot the standing
        // choice. Left to the next join, the picker would spend the rest of the
        // conversation describing the state before the click.
        const nextDefault = readModelDefault(message.modelDefault);
        if (nextDefault) this.modelDefault = nextDefault;
        this.modelResult = {
          applied,
          message: String(message.message || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_effort_result': {
        const applied = (message.applied as EffortSwitchResult['applied']) || 'pending';
        // Same rule as the model, and the same reason: only 'live' and 'cleared'
        // mean the conversation is running at this level now. 'sent' is awaiting
        // the runtime's own word for it, 'pending' will not be true until a
        // relaunch that may never come, and 'refused' was never stored at all —
        // showing any of them on the chip would put a number on the screen that
        // nothing is actually running at.
        if (applied === 'live' || applied === 'cleared') {
          this.effortOverride = typeof message.effort === 'string' ? message.effort : null;
        }
        this.effortResult = {
          applied,
          message: String(message.message || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_plan_mode': {
        this.planMode = message.planMode === true;
        this.planResult = {
          action: 'mode',
          changed: message.changed !== false,
          message: String(message.message || message.detail || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_plan_document': {
        // Null is a meaningful value here: `/clear` uses it to remove the
        // retained document. Nullish coalescing would turn that into undefined
        // and leave an old plan painted indefinitely.
        const raw = Object.prototype.hasOwnProperty.call(message, 'plan')
          ? message.plan
          : message.planDocument;
        const plan = readPlanDocument(raw);
        if (raw === null) {
          this.planDocument = null;
          this.planResult = null;
        } else if (plan) {
          if (plan.revision !== this.planDocument?.revision) this.planResult = null;
          this.planDocument = plan;
        }
        this.options.onChange?.();
        return true;
      }

      case 'chat_plan_action':
      case 'chat_plan_result':
      case 'chat_plan_accept_result':
      case 'chat_plan_reject_result': {
        const action = message.action === 'reject' || type === 'chat_plan_reject_result' ? 'reject' : 'accept';
        const raw = Object.prototype.hasOwnProperty.call(message, 'plan')
          ? message.plan
          : message.planDocument;
        const plan = readPlanDocument(raw);
        if (raw === null) this.planDocument = null;
        if (plan) this.planDocument = plan;
        if (typeof message.planMode === 'boolean') this.planMode = message.planMode;
        this.planResult = {
          action,
          revision: typeof message.revision === 'number' ? message.revision : undefined,
          accepted: message.accepted !== false && message.ok !== false,
          message: String(message.message || message.detail || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_unavailable': {
        // The conversation is intact and nothing is running it. Held rather
        // than shown as an error, because the useful response is a choice
        // between two ways forward, not an acknowledgement.
        this.unavailable = {
          message: String(message.message || 'this chat session is not running'),
          runtimeLabel: String(message.runtimeLabel || message.runtime || ''),
          canResume: message.canResume === true,
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_event': {
        const event = message.event as ChatEvent | undefined;
        if (event && this.transcript.apply(event)) this.options.onEvent?.(event);
        // `/clear` replaces the conversation in this tab, so the index of the
        // one it replaced is not an index of anything on screen. Dropped and
        // asked for again rather than patched: the server reads it from the
        // log, which is where the boundary is recorded.
        if (event && event.t === 'marker' && event.kind === 'cleared') {
          this.transcript.setRecordedTurns([]);
          // And with it the claim that older turns were trimmed away. A clear
          // starts the numbering over by construction, so an emptied
          // conversation carrying that flag draws "0+" and "earlier turns
          // trimmed" for the one round trip until the fresh index lands —
          // exactly the false statement the flag exists to prevent.
          this.turnIndexComplete = true;
          this.requestTurnIndex();
        }
        // A conversation that begins states the mode it begins in, and this is
        // the only place that statement reaches a pane whose conversation was
        // restarted from inside itself. `chat_started` is broadcast from the
        // launch path only; `/clear` re-decides the mode against the account's
        // preference and never goes near it, so without this the chip beside
        // the composer and the header badge would go on naming the mode of the
        // conversation the clear replaced — "asks first" over an agent now
        // running unattended, until the tab was reloaded (#134).
        //
        // Live events only. Replayed history reaches the transcript through
        // `hydrate` and `chat_page`, neither of which comes through here, so an
        // old conversation's opening line cannot overwrite the current mode.
        if (event && event.t === 'marker' && event.kind === 'approvals') {
          this.transcript.setBypassing(event.bypassing === true);
          this.options.onChange?.();
        }
        return true;
      }

      case 'chat_question_answer_ack': {
        const submissionId = typeof message.submissionId === 'string' ? message.submissionId : '';
        const pending = this.questionAnswers.get(submissionId);
        if (!pending || message.sessionId !== this.sessionId) return true;
        this.questionAnswers.delete(submissionId);
        pending.resolve(message.accepted === true);
        return true;
      }

      case 'chat_turn_index': {
        const turns = message.turns as ChatTurnIndexEntry[] | undefined;
        // Onto the transcript, not held here: it has to travel on the version
        // counter the views subscribe to, or it lands after every memo that
        // would read it has already been computed (#86).
        this.transcript.setRecordedTurns(Array.isArray(turns) ? turns : []);
        this.turnIndexComplete = message.complete !== false;
        this.options.onChange?.();
        return true;
      }

      case 'chat_turn_spend': {
        // One turn's bill, the moment the accounting files it. Same figure the
        // index carries on open, so a turn's cost appears as it finishes rather
        // than the next time the conversation is opened.
        const turnId = typeof message.turnId === 'string' ? message.turnId : '';
        const usage = message.usage as ChatUsage | undefined;
        if (turnId && usage) this.transcript.setTurnSpend(turnId, usage);
        this.options.onChange?.();
        return true;
      }

      case 'chat_turn_index_failed': {
        // Nothing to recover: the index falls back to the turns this browser
        // holds, which is what it showed before there was a recorded one.
        return true;
      }

      case 'chat_page': {
        // Older events arriving from a scroll-back. They are all below the
        // cursor, so they are folded in as history rather than replayed —
        // the reducer would correctly refuse them as duplicates.
        const events = (message.events as ChatEvent[] | undefined) || [];
        const firstSeq = Number(message.firstSeq) || 0;
        const from = typeof message.from === 'number' ? message.from : undefined;
        const openTurnId = typeof message.openTurnId === 'string' ? message.openTurnId : null;
        this.absorbPage(events, firstSeq, from, openTurnId);
        this.settlePage();
        this.options.onChange?.();
        return true;
      }

      case 'chat_queue': {
        // Authoritative and whole, never a delta: the server is the only thing
        // that knows what is still waiting — a turn can leave the queue because
        // this browser cancelled it, because another one did, or because it
        // just started running — and reconciling three sources of removal
        // against a local copy is how the two fall out of step.
        const queued = message.queued as QueuedTurn[] | undefined;
        this.transcript.setQueued(Array.isArray(queued) ? queued : []);
        return true;
      }

      case 'chat_builtin_workflow_result': {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const pending = this.workflowRequests.get(requestId);
        if (!pending) return true;
        this.workflowRequests.delete(requestId);
        clearTimeout(pending.timer);
        if (message.workflow !== pending.workflow) {
          pending.reject(new Error('The server answered for a different guided workflow.'));
          return true;
        }
        const status = message.status;
        if (
          message.accepted === true
          && (status === 'accepted' || status === 'queued')
          && message.sessionId === this.sessionId
        ) {
          pending.resolve(status);
        } else {
          pending.reject(new Error(
            typeof message.message === 'string' && message.message
              ? message.message
              : 'The guided workflow could not be started.',
          ));
        }
        return true;
      }

      case 'chat_page_failed': {
        // The read threw server-side. The error itself is surfaced by the
        // shell's own error path; all this owes the user is the button back.
        this.settlePage();
        return true;
      }

      default:
        return false;
    }
  }
}
