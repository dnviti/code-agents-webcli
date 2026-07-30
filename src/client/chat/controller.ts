import {
  ChatAttachment,
  ChatCapabilities,
  ChatDraft,
  ChatEvent,
  ChatModelDefault,
  ChatSnapshot,
  ChatTurnIndexEntry,
  ChatUsage,
  QueuedTurn,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { ChatTranscript } from './transcript.js';

/**
 * One conversation's half of the socket.
 *
 * Sits where MessageHandler sits for the terminal: it owns the transcript,
 * applies what arrives, and is the only thing that speaks chat messages to the
 * server for its session. React never touches the socket — it subscribes to the
 * transcript and renders, which is the same split the rest of this client uses.
 *
 * Scoped to a single session id, fixed at construction. There used to be one
 * controller for the whole page, which meant a second chat tab hydrated the one
 * transcript with its own conversation and the first tab went blank while its
 * agent kept working. Sessions are addressed rather than swapped now; see
 * ChatRegistry.
 */

export interface ChatControllerOptions {
  send: (message: Record<string, unknown>) => void;
  /** Called when the surface should redraw for a reason outside the transcript. */
  onChange?: () => void;
  /**
   * This browser's socket id, for telling its own composer edits apart from
   * another screen's.
   *
   * A function rather than a value: the id is handed out in the server's
   * `connected` message, so it does not exist when the controllers are built,
   * and it changes on every reconnect. Absent — or answering null — means every
   * arriving draft is treated as somebody else's, which is the safe way round:
   * the worst it costs is a caret put back where it was a moment ago, whereas
   * mistaking another screen's typing for your own echo loses it entirely.
   */
  origin?: () => string | null;
  /**
   * Called for each event this conversation actually applied.
   *
   * Not called for one the transcript rejected as a replay, which is what makes
   * it usable as an edge: a reconnect redelivers the tail of the log, and
   * anything hung off this must not fire again for what it already knows.
   */
  onEvent?: (event: ChatEvent) => void;
}

/**
 * A conversation whose process is gone, and what can be done about it.
 *
 * The server restarting is the ordinary way to arrive here: chat sessions live
 * in memory, transcripts live on disk, so the conversation outlives the thing
 * that was having it.
 */
export interface ChatUnavailable {
  message: string;
  /** What to call the runtime in the offer, e.g. "Claude". */
  runtimeLabel: string;
  /** True when the agent can be given its own context back. */
  canResume: boolean;
}

/**
 * What actually happened when this browser last asked to change the model.
 *
 * Mirrors the server's own honesty about it: a typed model name is never
 * validated ahead of time, so this reports what was actually possible rather
 * than assuming the best case.
 */
export interface ModelSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared';
  message: string;
}

/**
 * What actually happened when this browser last asked to change the effort level.
 *
 * One state more than the model has. A model name is free text and cannot be
 * judged before it is tried, but an effort level can: the control only offers
 * what the running runtime published, so a level that is not on that list did
 * not come from the control, and the server says `refused` and stores nothing
 * rather than carrying a bad value into every future launch.
 */
export interface EffortSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused';
  message: string;
}

/**
 * Read a `modelDefault` off the wire, or nothing.
 *
 * Field-by-field rather than a cast, like every other payload this file reads.
 * A server that predates #135 sends nothing at all, and a partial one has to
 * read as nothing too: the picker's whole job here is to say *why* a model is
 * in force, and half an answer to that is worse than admitting it does not
 * know.
 */
function readModelDefault(raw: unknown): ChatModelDefault | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const source = value.source;
  if (source !== 'personal' && source !== 'profile' && source !== 'runtime') return null;
  return {
    model: typeof value.model === 'string' && value.model ? value.model : null,
    source,
    ...(typeof value.profileName === 'string' && value.profileName
      ? { profileName: value.profileName }
      : {}),
  };
}

/**
 * How long a page request may go unanswered before the control comes back.
 *
 * Not a latency budget — a page is a positioned read of a local file and comes
 * back in milliseconds. It is the point past which the only explanation is that
 * no reply is coming, and leaving a spinner up for that forever is worse than
 * offering the button again.
 */
const PAGE_TIMEOUT_MS = 15000;

const PAGE_SIZE = 200;

/**
 * How much a page fetched for an explicit destination asks for.
 *
 * The server's own per-read ceiling, and it is worth asking for all of it here:
 * a jump four thousand events back is eight round trips at this size and twenty
 * at the scrolling one, while the read itself is a positioned file read either
 * way. Scrolling keeps the smaller page, because there the point is to arrive
 * with the least the reader can already use.
 */
const SEEK_PAGE_SIZE = 500;

/**
 * How often a composer being typed into tells the other screens.
 *
 * A quarter of a second, and every keystroke inside one is folded into a single
 * frame carrying the latest text. Fast enough that a phone watching a laptop
 * reads as live rather than as a page that refreshes; slow enough that a
 * hundred-word paragraph is a few dozen small frames instead of six hundred.
 *
 * The first keystroke after a pause goes at once — see `publishDraft`. Waiting
 * out the interval before saying anything would make the *start* of typing the
 * slowest part of it, which is the part being watched.
 */
const DRAFT_PUBLISH_MS = 250;

/** A composer's contents, before the server has numbered them. */
interface DraftPayload {
  text: string;
  attachments: ChatAttachment[];
}

const NO_DRAFT: ChatDraft = { text: '', attachments: [], revision: 0 };

/**
 * Whether two composers hold the same thing.
 *
 * Attachments are compared by url, which is the server's own name for the
 * stored file and the only field of the four that is generated rather than
 * copied from what the browser guessed about it.
 */
function sameDraft(a: DraftPayload, b: DraftPayload): boolean {
  if (a.text !== b.text) return false;
  if (a.attachments.length !== b.attachments.length) return false;
  return a.attachments.every((attachment, index) => attachment.url === b.attachments[index].url);
}

/**
 * Read a draft off the wire, or nothing.
 *
 * Field by field like every other payload this file reads. A server that
 * predates this sends no draft at all, which has to come back as `null` — the
 * surface then keeps whatever it has rather than being cleared by a server that
 * simply has nothing to say about composers.
 */
function readDraft(raw: unknown): ChatDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== 'string') return null;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision)) return null;
  const attachments = Array.isArray(value.attachments)
    ? (value.attachments.filter(
        (item) => item && typeof item === 'object' && typeof (item as ChatAttachment).url === 'string',
      ) as ChatAttachment[])
    : [];
  return { text: value.text, attachments, revision: value.revision };
}

/**
 * What happened to a jump to a message the browser did not hold.
 *
 * Three answers rather than a boolean, because the caller says something
 * different about each: `arrived` scrolls, `exhausted` has to admit the turn is
 * not on disk any more, and `abandoned` says nothing at all — the user has
 * already gone somewhere else, and a notice about the journey they left is
 * noise about a decision they made.
 */
/**
 * How a jump ended.
 *
 * `exhausted` and `unreachable` are kept apart because they want different
 * words on screen: the first is the log genuinely not holding that turn any
 * more, the second is a read that failed or timed out, which says nothing about
 * whether the turn is there. Telling a user their turn is gone because one
 * page did not come back is a wrong answer given confidently, and on a slow
 * link a long walk has a hundred chances to hit it.
 */
export type SeekOutcome = 'arrived' | 'exhausted' | 'unreachable' | 'abandoned';

export class ChatController {
  readonly transcript = new ChatTranscript(NO_CHAT_CAPABILITIES);

  private nextRequestId = 1;
  /** Request id of the page in flight, or null. */
  private pendingPage: string | null = null;
  /**
   * False once the server says the head of the log was trimmed, so the recorded
   * index cannot reach the conversation's own first turn.
   */
  private turnIndexComplete = true;
  private pageTimer: ReturnType<typeof setTimeout> | null = null;

  /** The message an explicit jump is still paging back towards, or null. */
  private seeking: string | null = null;
  /**
   * Which jump is the current one.
   *
   * A seek walks the log a page at a time and every step is a round trip, so
   * there is always a window in which the user changes their mind — picks
   * another entry, jumps to the latest, or leaves the conversation. Bumping
   * this abandons whatever is in flight without cancelling the page it is
   * waiting on, which is already on its way and still worth folding in.
   */
  private seekGeneration = 0;

  /** Set while the conversation is readable but has nothing running it. */
  private unavailable: ChatUnavailable | null = null;

  /**
   * The model override this conversation is carrying, independent of what the
   * runtime itself reports through the transcript.
   *
   * Null means "no override" — the surface then falls back to whatever the
   * transcript's own `model` says, which is the runtime's default or the
   * active profile. Kept here rather than folded into the transcript because
   * it is a fact about the *session record*, not something any adapter emits
   * as an event.
   */
  private modelOverride: string | null = null;
  /**
   * Where the model a *new* conversation on this runtime would come from.
   *
   * A statement about the default rather than about this conversation, which is
   * why it sits beside the override instead of replacing it: the two are shown
   * together, and "chosen here" versus "your standing choice" versus "the
   * profile's" is the whole question the picker could not answer before (#135).
   *
   * Null when the server said nothing — an older one, or one built without the
   * user-settings store. The surface then reads exactly as it did before this
   * existed, rather than asserting a source it was never told.
   */
  private modelDefault: ChatModelDefault | null = null;
  /**
   * The model this conversation is fixed to, as its record holds it.
   *
   * A statement about *this* conversation, unlike the default above, and the
   * reason the two cannot be collapsed: on claude the runtime never reports a
   * model at all, so a chip with nothing else to show once fell back to the
   * default — and a default the conversation was never launched on is a name it
   * is not running (#135).
   *
   * Null both for "the runtime was given no flag" and for a server that said
   * nothing, and the chip treats them the same way: it names no model. The
   * distinction only matters on the server, where the launch is resolved.
   */
  private modelPinned: string | null = null;
  /** What the server reported happened to the last model change requested. */
  private modelResult: ModelSwitchResult | null = null;

  /**
   * The effort level this conversation was told to run at, as the record holds it.
   *
   * Beside the transcript's own `effort` rather than inside it for the same
   * reason the model override is: the transcript carries what the *runtime*
   * reported, and this carries what the *record* says was chosen. They agree
   * almost always, and the interesting moment is the one where they do not —
   * a conversation whose process has died still has a chosen level, and nothing
   * is reporting it any more.
   */
  private effortOverride: string | null = null;
  /** What the server reported happened to the last effort change requested. */
  private effortResult: EffortSwitchResult | null = null;

  /**
   * The composer, as the server last numbered it.
   *
   * Revision 0 is "nothing has ever been said about this conversation's
   * composer", which is what a fresh controller holds and what a server too old
   * to carry drafts leaves it at.
   */
  private draft: ChatDraft = NO_DRAFT;
  /**
   * What this browser last put on the wire.
   *
   * Kept so the same text is not announced twice — a caret moving through a
   * draft calls the surface's change handler without changing a character — and,
   * more importantly, so a draft *arriving* from elsewhere is not immediately
   * announced back as though this screen had typed it.
   */
  private draftPublished: DraftPayload = { text: '', attachments: [] };
  /** The newest local edit still waiting for the interval to come round. */
  private draftPending: DraftPayload | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the server on the other end carries composers at all.
   *
   * Off until the handshake says otherwise, for the same reason multi-session
   * is: this server answers an unknown message with a visible error, so a page
   * newer than the server it is talking to would put an error toast on screen
   * per keystroke. See ChatRegistry.setFeatures.
   */
  private draftSync = false;
  private draftListeners = new Set<(draft: ChatDraft | null) => void>();
  /**
   * Whether a join has answered the question "what is in this composer" at all.
   *
   * Apart from `draft.revision === 0`, which cannot tell "the server says
   * nothing has been typed" from "this browser has not asked yet" — and a
   * surface that confuses the two publishes its own stale copy over a newer one
   * that is still in flight, then ignores the answer for being older than the
   * revision its own publish just created.
   */
  private draftAnswered = false;

  constructor(
    readonly sessionId: string,
    private readonly options: ChatControllerOptions,
  ) {}

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
    'chat_turn_index',
    'chat_turn_index_failed',
    'chat_turn_spend',
  ]);

  get currentSessionId(): string {
    return this.sessionId;
  }

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
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
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
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
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

  /**
   * Fold an older page into the front of the transcript.
   *
   * Replays the page through a throwaway transcript first: a page is a slice of
   * the same event stream, and the only thing that knows how to turn events
   * into messages is the reducer. Rebuilding that logic here is how the two
   * halves of a paged conversation start disagreeing.
   */
  private absorbPage(
    events: ChatEvent[],
    firstSeq: number,
    from?: number,
    openTurnId?: string | null,
  ): void {
    if (!events.length) {
      this.transcript.prepend([], firstSeq, from);
      return;
    }

    const scratch = new ChatTranscript(this.transcript.capabilities);
    // A page starts wherever the scroll reached, which is routinely inside a
    // turn: without the turn the server says was open there, every paged-in
    // message is filed under the runtime's id and the history fills with rows
    // that have no prompt to name them.
    scratch.seedOpenTurn(openTurnId);
    scratch.applyAll(events);
    // The scratch folded any `question_resolved` in this page correctly; hand
    // those over too, or a question scrolled in from history comes back with
    // every option unticked (#113).
    this.transcript.prepend(
      scratch.messages,
      firstSeq,
      from,
      scratch.answeredQuestions,
      scratch.answeredQuestionText,
    );
  }

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
    this.unavailable = null;
    this.options.onChange?.();
    this.options.send({
      type: 'start_chat',
      agentKind,
      sessionId: this.sessionId,
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
  ): void {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return;
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
    this.send({ type: 'chat_send', text: trimmed, attachments, fromComposer });
  }

  /** What this conversation's composer holds, as far as this browser knows. */
  get draftValue(): ChatDraft {
    return this.draft;
  }

  /**
   * Whether a join has said anything about the composer yet.
   *
   * What a surface mounting into an already-open conversation asks, because it
   * may have missed the answer: a tab switched away from and back keeps its
   * controller and its subscription, so the snapshot that carried the composer
   * arrived while nothing was rendering it.
   */
  get draftAnswer(): 'unheard' | 'held' | 'none' {
    if (!this.draftAnswered) return 'unheard';
    return this.draft.revision > 0 ? 'held' : 'none';
  }

  /**
   * Hear about composers that came from somewhere else.
   *
   * `null` means the server has no composer for this conversation at all, which
   * is a different statement from an empty one: it is what a server that has
   * restarted says, and the surface answers it by publishing whatever it kept in
   * session storage rather than by clearing itself.
   *
   * Its own subscription rather than a redraw through `onChange`, because a
   * composer being typed into on another screen must not re-render a
   * conversation four times a second — the transcript, the turn grouping and the
   * whole activity projection hang off that path.
   */
  subscribeDraft(listener: (draft: ChatDraft | null) => void): () => void {
    this.draftListeners.add(listener);
    return () => {
      this.draftListeners.delete(listener);
    };
  }

  /** Whether this server carries the composer between screens at all. */
  get draftSyncAvailable(): boolean {
    return this.draftSync;
  }

  /** Told by the registry once the server's feature list has arrived. */
  setDraftSync(enabled: boolean): void {
    this.draftSync = enabled;
  }

  /**
   * Say what is in this browser's composer.
   *
   * Rate-limited rather than debounced, and the difference is what typing feels
   * like on the screen that is only watching: the first keystroke after a pause
   * goes immediately, and everything within the interval after it is folded into
   * one frame carrying the latest text. A debounce would send nothing at all
   * until the typing stopped, which for a long paragraph is the entire time
   * somebody is watching it being written.
   */
  publishDraft(text: string, attachments: ChatAttachment[] = []): void {
    if (!this.draftSync) return;
    const payload: DraftPayload = { text, attachments };
    // Nothing changed — a caret moved, or this is the surface handing back a
    // draft that arrived from another screen a moment ago.
    if (sameDraft(payload, this.draftPublished)) {
      this.draftPending = null;
      return;
    }
    if (this.draftTimer) {
      this.draftPending = payload;
      return;
    }
    this.sendDraft(payload);
    this.draftTimer = setTimeout(() => this.releaseDraft(), DRAFT_PUBLISH_MS);
  }

  /**
   * Send whatever is waiting for the interval, now.
   *
   * For the moments where waiting a quarter of a second is a quarter of a second
   * too long: the field losing focus, and the page being hidden or closed. The
   * last thing typed before somebody picks up their phone is exactly the thing
   * they picked it up to finish.
   */
  flushDraft(): void {
    const pending = this.draftPending;
    this.draftPending = null;
    if (pending) this.sendDraft(pending);
  }

  private sendDraft(payload: DraftPayload): void {
    this.draftPublished = payload;
    this.send({ type: 'chat_draft', text: payload.text, attachments: payload.attachments });
  }

  private releaseDraft(): void {
    this.draftTimer = null;
    const pending = this.draftPending;
    this.draftPending = null;
    if (pending) this.publishDraft(pending.text, pending.attachments);
  }

  /**
   * Take the composer a join reported, or say that there was not one.
   *
   * The revision check is what makes a rejoin harmless: a snapshot answers with
   * whatever the server holds, which is routinely older than a broadcast this
   * browser has already applied.
   */
  private adoptDraft(draft: ChatDraft | null): void {
    this.draftAnswered = true;
    if (!draft) {
      // Not "the composer is empty" — "nobody has told this server anything
      // about it". The surface decides what to do with that, and what it does is
      // offer up the copy it kept.
      //
      // The count goes back to nothing with it, and that is the part that is
      // easy to miss: a server that says it holds no composer is a server that
      // will number the next one from 1. A browser still holding 7 from before
      // the restart would then read the next seven edits as older than what it
      // has and drop every one of them — and it heals itself after a few
      // seconds of typing, which is exactly what would make it invisible.
      this.draft = NO_DRAFT;
      this.draftPublished = { text: '', attachments: [] };
      this.emitDraft(null);
      return;
    }
    // What the server holds is, by definition, what this browser has managed to
    // publish — whether or not it is newer than what the browser has. The two
    // come apart in one ordinary case and it is a case worth surviving: a frame
    // handed to a socket that was already closing is dropped without a word (see
    // WebSocketConnection.send), and the browser would otherwise spend the rest
    // of the conversation believing it had said something it never did, refusing
    // to repeat it because it matched what it thought it had sent.
    this.draftPublished = { text: draft.text, attachments: draft.attachments };
    if (draft.revision > this.draft.revision) {
      this.draft = draft;
      // Same reason as the broadcast path: the field this screen was about to
      // announce has just been overwritten by what arrived, so announcing it
      // now would replace the newer text everywhere except here.
      this.draftPending = null;
      this.emitDraft(draft);
      return;
    }
    // Nothing newer than what this browser already applied. Told anyway, as the
    // same "the server has nothing for you" the surface answers by offering
    // whatever it is holding — which after a reconnect is the repair for the
    // dropped frame above, and the rest of the time is a comparison that finds
    // the two already agree and says nothing.
    this.emitDraft(null);
  }

  private emitDraft(draft: ChatDraft | null): void {
    for (const listener of this.draftListeners) listener(draft);
  }

  interrupt(): void {
    this.send({ type: 'chat_interrupt' });
  }

  /**
   * Withdraw a turn that has not run yet.
   *
   * Nothing is removed locally: the server answers with the whole queue, and
   * guessing at the outcome first would make the chip flicker back when the
   * turn had already started.
   */
  cancelQueued(queuedId: string): void {
    this.send({ type: 'chat_queue_cancel', queuedId });
  }

  /**
   * Send a waiting turn now, cutting short whatever is running.
   *
   * Nothing optimistic here either, and for a stronger reason than above: the
   * server decides whether this turn is still promotable at all, and a chip
   * removed locally on a click that arrived too late would leave the browser
   * showing a queue the session does not have.
   */
  sendQueuedNow(queuedId: string): void {
    this.send({ type: 'chat_queue_send_now', queuedId });
  }

  /**
   * Try a turn that could not be delivered again.
   *
   * Same rule as cancelling: the server owns the queue and answers with all of
   * it, so nothing is guessed at here.
   */
  retryQueued(queuedId: string): void {
    this.send({ type: 'chat_queue_retry', queuedId });
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
  answerQuestion(requestId: string, optionIds: string[], skipped = false, text?: string): void {
    this.send({ type: 'chat_question_answer', requestId, optionIds, skipped, text });
  }

  respondPermission(requestId: string, optionId: string): void {
    this.send({ type: 'chat_permission_response', requestId, optionId });
  }

  /** The model override in force for this conversation, or null if there is none. */
  get modelOverrideValue(): string | null {
    return this.modelOverride;
  }

  /**
   * Where a new conversation on this runtime would get its model, or null when
   * the server did not say.
   */
  get modelDefaultValue(): ChatModelDefault | null {
    return this.modelDefault;
  }

  /**
   * The model this conversation is fixed to, or null when nothing says.
   */
  get modelPinnedValue(): string | null {
    return this.modelPinned;
  }

  /** What happened the last time this browser asked to change the model. */
  get modelFeedback(): ModelSwitchResult | null {
    return this.modelResult;
  }

  /**
   * Ask the server to switch this conversation's model, or clear the override
   * with an empty string.
   *
   * Never validated here: the composer sends whatever was typed, and the
   * server's reply — live, sent, or saved-for-next-time — is what actually
   * tells the user what happened.
   */
  setModel(model: string): void {
    this.send({ type: 'chat_set_model', model });
  }

  /** The effort level chosen for this conversation, or null if none was. */
  get effortOverrideValue(): string | null {
    return this.effortOverride;
  }

  /** What happened the last time this browser asked to change the effort level. */
  get effortFeedback(): EffortSwitchResult | null {
    return this.effortResult;
  }

  /**
   * Ask the server to change how hard this conversation thinks, or clear the
   * choice with an empty string.
   *
   * Unlike the model, the server does check this one against what the runtime
   * published — but the check belongs there and not here, because only the
   * server can see the live session's capabilities, and a browser holding a
   * stale menu is exactly the case the check exists for.
   */
  setEffort(effort: string): void {
    this.send({ type: 'chat_set_effort', effort });
  }

  /** Tell the server this browser wants this conversation's live events. */
  subscribe(): void {
    this.send({ type: 'chat_subscribe' });
  }

  unsubscribe(): void {
    this.send({ type: 'chat_unsubscribe' });
  }

  /**
   * Ask for the page above what is held.
   *
   * Guarded rather than debounced: a scroll to the top fires repeatedly while
   * the momentum settles, and each one would otherwise fetch the same page.
   */
  loadMore(): void {
    this.requestPage(PAGE_SIZE);
  }

  /**
   * The page request itself, at whatever size the caller is reading for.
   *
   * Scrolling asks for a screenful; a jump to a named turn asks for as much as
   * the server will read at once, because there the pages are a journey rather
   * than the thing being read. See `SEEK_PAGE_SIZE`.
   */
  private requestPage(size: number): void {
    if (this.transcript.loadingMore || !this.transcript.hasMore) return;

    const fromSeq = Math.max(this.transcript.firstSeq, this.transcript.oldestSeq - size);
    const requestId = `chat-page-${this.nextRequestId++}`;
    this.pendingPage = requestId;
    this.transcript.setLoadingMore(true);

    this.pageTimer = setTimeout(() => {
      this.pageTimer = null;
      this.settlePage();
    }, PAGE_TIMEOUT_MS);

    this.send({
      type: 'chat_history_request',
      fromSeq,
      count: size,
      requestId,
    });
  }

  /** Whether the recorded index reaches the conversation's first turn. */
  get recordedTurnsComplete(): boolean {
    return this.turnIndexComplete;
  }

  private requestTurnIndex(): void {
    this.send({
      type: 'chat_turn_index_request',
      requestId: `chat-turns-${this.nextRequestId++}`,
    });
  }

  /**
   * Page back until a message is held, however far back it is.
   *
   * The index lists the whole conversation, so selecting an entry from before
   * what is loaded has to fetch it rather than quietly do nothing — which is
   * what "selecting an older one should take the user there" means (#86).
   *
   * **No page ceiling.** There used to be one, twenty pages of two hundred
   * events, and in the conversations an index exists for that ceiling was the
   * ordinary case rather than the guard: a click four thousand events above the
   * window ran out of pages, resolved false, and left a highlighted row over a
   * transcript that had not moved. Clicking again walked another four thousand
   * and eventually landed, with nothing on screen to say that was what was
   * happening. The reason a ceiling exists at all — that ordinary scrolling
   * must not be able to walk a whole log into a browser — is about scrolling,
   * and scrolling still asks for one page at a time through `loadMore`. This is
   * an address the user typed, and it arrives.
   *
   * What replaces the ceiling as the guard against a loop that cannot end is
   * progress: a page that does not lower the paging floor has fetched nothing,
   * which is what a failed read and a server that has clamped the request both
   * look like from here, and there is no point asking the same question again.
   *
   * One page at a time, awaited, so the surface keeps painting between them and
   * the user can leave at any point — see `cancelSeek`.
   */
  async seekTo(messageId: string): Promise<SeekOutcome> {
    const mine = ++this.seekGeneration;
    this.seeking = messageId;
    this.options.onChange?.();
    try {
      let floor = this.transcript.oldestSeq;
      for (;;) {
        if (this.seekGeneration !== mine) return 'abandoned';
        if (this.transcript.messages.some((message) => message.id === messageId)) return 'arrived';
        if (!this.transcript.hasMore) return 'exhausted';
        const settled = await this.nextPage(SEEK_PAGE_SIZE);
        // Checked again on this side of the await, not only at the top: a
        // rejoin, a disposal or a tab switch all land during a page, and
        // reading the outcome off what the page did would announce "that turn
        // is no longer in this conversation" for a jump the user simply left.
        if (this.seekGeneration !== mine) return 'abandoned';
        // A read that failed or timed out says nothing about whether the turn
        // is there — only that this attempt did not reach it. Kept apart from
        // the log genuinely ending, because the two want different words.
        if (!settled) return 'unreachable';
        if (this.transcript.oldestSeq >= floor) return 'unreachable';
        floor = this.transcript.oldestSeq;
      }
    } finally {
      // Only if this is still the jump in flight: a later one owns the flag now
      // and clearing it here would take its indicator down with it.
      if (this.seekGeneration === mine) {
        this.seeking = null;
        this.options.onChange?.();
      }
    }
  }

  /**
   * Stop going backwards.
   *
   * For everything that means "I am done with where I was going": jumping to
   * the latest turn, sending a message, closing the conversation. The pages
   * already asked for still arrive and are still folded in — they are history
   * this browser now holds — but nothing scrolls and nothing is announced.
   */
  cancelSeek(): void {
    if (this.seeking === null) return;
    this.seekGeneration += 1;
    this.seeking = null;
    this.options.onChange?.();
  }

  /** The message a jump is being fetched for, so a surface can say it is working. */
  get seekingMessageId(): string | null {
    return this.seeking;
  }

  /**
   * One page, resolved when its reply lands or its timeout fires.
   *
   * A page already in flight is joined rather than refused. Scrolling to the
   * top of a short transcript fetches one on its own, so a click on the index
   * arriving in that window would otherwise give up on the first step and go
   * nowhere — which looks exactly like the index not being wired up at all.
   */
  private nextPage(size = PAGE_SIZE): Promise<boolean> {
    if (!this.transcript.loadingMore && !this.transcript.hasMore) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pageWaiters.push(resolve);
      if (!this.transcript.loadingMore) this.requestPage(size);
    });
  }

  private pageWaiters: Array<(settled: boolean) => void> = [];

  get isLoadingMore(): boolean {
    return this.transcript.loadingMore;
  }

  /** A page request is over, however it ended. */
  private settlePage(): void {
    if (this.pageTimer !== null) {
      clearTimeout(this.pageTimer);
      this.pageTimer = null;
    }
    this.pendingPage = null;
    this.transcript.setLoadingMore(false);
    const waiters = this.pageWaiters;
    this.pageWaiters = [];
    for (const resolve of waiters) resolve(true);
  }

  /** Every outgoing message names its session; a browser drives several. */
  private send(message: Record<string, unknown>): void {
    this.options.send({ ...message, sessionId: this.sessionId });
  }

  /**
   * Show the mode a list row already knew, before this pane has heard anything.
   *
   * Display only — see ChatTranscript.seedBypass. Never echoed back in a
   * launch: the browser does not assert approval modes, it reports them.
   */
  seedBypass(bypassing: boolean): void {
    this.transcript.seedBypass(bypassing);
    this.options.onChange?.();
  }

  /** Release timers, e.g. when the session's tab is closed. */
  dispose(): void {
    this.cancelSeek();
    this.settlePage();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.draftPending = null;
    this.draftListeners.clear();
  }

  /**
   * Drop everything, e.g. when the session is being restarted.
   *
   * Nothing in the client calls this today — the registry drops a closed tab
   * through `drop()` -> `dispose()`, and a restart in place keeps the pane. It
   * is kept correct rather than deleted because it is the one entry point that
   * would wipe a live pane, but nothing here is load-bearing for any user-facing
   * guarantee: what a restarted conversation shows is decided by the mode its
   * opening `approvals` marker carries (see `chat_event` above), not by this.
   */
  reset(): void {
    this.cancelSeek();
    this.settlePage();
    // Not a claim either way: the next snapshot or chat_started carries the
    // record's real override, and showing a stale one in the meantime would
    // be worse than showing nothing.
    this.modelOverride = null;
    // The pin goes with it, and for the same reason: the record's own answer is
    // on its way, and a conversation being relaunched may well come back on a
    // different model — naming the old one in the meantime would be the exact
    // claim this field exists to stop the chip making.
    this.modelPinned = null;
    // The default deliberately survives: it is a fact about the account and the
    // runtime, not about the conversation being restarted, and the picker would
    // otherwise lose the only sentence that explains what the restart will open
    // on until the next join answered.
    this.modelResult = null;
    // And the effort level with it, for the same reason: the record's own value
    // is on its way and a stale one on the chip in the meantime would claim the
    // conversation is thinking at a level nothing has confirmed.
    this.effortOverride = null;
    this.effortResult = null;
    // Likewise the trimmed-history flag: it describes a log this controller is
    // no longer pointed at.
    this.turnIndexComplete = true;
    // `hydrate` clears the queue from the (absent) snapshot field, so the line
    // does not survive into a session that never accepted it.
    this.transcript.hydrate({
      sessionId: this.sessionId,
      runtime: '',
      messages: [],
      state: 'starting',
      capabilities: NO_CHAT_CAPABILITIES,
      pendingPermissions: [],
      pendingQuestions: [],
      firstSeq: 0,
      replayFrom: 0,
      cursor: 0,
      live: false,
      // Carried across the wipe rather than asserted as manual. The next
      // snapshot or `chat_started` still has the last word, but until it lands
      // the honest answer is the one the server last stated — and dropping a
      // known bypass to "asks first" for that interval is the one direction of
      // wrongness that matters, a user relaxing because the badge says the
      // agent will stop and ask (#134).
      bypassPermissions: this.transcript.bypassing,
    });
    this.options.onChange?.();
  }
}
