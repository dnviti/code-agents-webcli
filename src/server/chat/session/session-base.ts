/*
 * ChatSessionBase: holds all instance state, the constructor, the public accessors, and throwing stubs describing the method contract.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatState, ChatCapabilities, AccountLimits, QuestionContinuation, PlanDocument, SlashCommand, QueuedTurn, ChatEvent, UserTurn, QuestionRequest, ChatSnapshot } from '../../../shared/chat-events.js';
import { ModelTier, LadderRung } from '../../../shared/runtime-profiles.js';
import { ChatAdapter, AdapterEvent } from '../adapter.js';
import { PermissionBroker, QuestionReply, PermissionAsk, PermissionAnswer, TierAsk, TierReply, QuestionAsk } from '../permission-broker.js';
import { FileCallbackBroker } from '../file-callback.js';
import { ChatSessionRef } from '../store.js';
import { UsageAccountant, FinishedJob } from '../usage-accounting.js';
import { PendingApproval, PendingQuestion, ChatSessionStartOptions, ChatSessionDeps, AgentUpdateRestartResult, PendingToolQuestion, PlanSubmissionResult, PlanModeResult, PlanActionResult } from './session-types.js';
export abstract class ChatSessionBase {
  protected adapter: ChatAdapter | null = null;
  protected broker: PermissionBroker | null = null;
  protected fileBroker: FileCallbackBroker | null = null;
  protected seq = 0;
  protected state: ChatState = 'starting';
  protected capabilities: ChatCapabilities | null = null;
  /** The last account reading the runtime published. See the `limits` overlay in `snapshot()`. */
  protected limits: AccountLimits | null = null;
  protected readonly pending = new Map<string, PendingApproval>();
  protected readonly questions = new Map<string, PendingQuestion>();
  /** Answered handoffs durably waiting to become one internal runtime turn. */
  protected readonly questionContinuations = new Map<string, QuestionContinuation>();
  /** Serialises open/answer/abandon commits without holding a runtime send open. */
  protected questionTransitionTail: Promise<void> = Promise.resolve();
  protected questionTransitionRunning = false;
  protected readonly questionTransitionQueue: Array<{
    operation: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  /** Single-flight dispatches, keyed by the durable continuation id. */
  protected readonly questionDispatches = new Map<string, Promise<void>>();
  /** Claimed outboxes this process knows never reached adapter.send(). */
  protected readonly knownUnsentQuestionContinuations = new Set<string>();
  /** Adapter events held while a continuation terminal record owns the next seq. */
  /** Raw runtime events held while one durable protocol event owns the next seq. */
  protected durableEventBuffer: AdapterEvent[] | null = null;
  /** Set synchronously so a frame arriving after Stop cannot enter the FIFO. */
  protected acceptingQuestionTransitions = true;
  protected questionStopIntent: 'preserve' | 'abandon' | null = null;
  /** Invalidates a scheduled handoff continuation when Stop/restart wins. */
  protected questionContinuationGeneration = 0;
  /**
   * The rung this conversation runs on, and the whole ladder behind it.
   *
   * Null for a conversation that is not on a ladder at all, which is what makes
   * the escalation tool absent rather than present-and-always-refusing.
   */
  protected ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null = null;
  /**
   * The rung this conversation has been lifted to for the turn in progress.
   *
   * Set the moment an escalation is granted and cleared when the turn ends —
   * which is the observable reading of "once the task that prompted the move is
   * finished". A task that spans turns asks again, and that is deliberate: the
   * approval is the only control on what this spends, and a grant that outlived
   * the work it was granted for would quietly become the conversation's model.
   */
  protected escalation: {
    from: ModelTier;
    to: ModelTier;
    model: string;
    /**
     * True while the grant has been made but the turn it applies to has not
     * started — either because the runtime cannot change model mid-turn (pi
     * runs one process per turn) or because the user answered after the turn
     * that asked had already ended.
     *
     * Without it the very next `turn_end` — the one closing the turn the grant
     * was *not* for — cancelled the escalation before the promised turn began,
     * so the model was told it had moved up and then answered from the rung it
     * started on.
     */
    startsNextTurn: boolean;
  } | null = null;
  /**
   * Question tool calls the transcript has opened and nothing has claimed yet.
   *
   * The MCP server that carries a question has no way to know the tool_use id of
   * the call it is serving — it only ever sees the arguments — so the pairing is
   * made here instead, from the block the adapter already reported.
   *
   * Matched on the question text first, and only then on announcement order.
   * Order alone is not enough, which omp demonstrated: its model got the option
   * schema wrong, the call was rejected before it ever reached the MCP server,
   * and it retried. That leaves *two* announced calls for one question, and
   * claiming the oldest pinned the card to the attempt that failed. Newest match
   * first is the answer, because a retry is the later of the two.
   *
   * An unclaimed entry left by a call that never reached the server would
   * mispair a later question, so the list is emptied at the end of every turn —
   * by which point nothing can still be waiting to claim one.
   */
  protected askCalls: Array<{ toolId: string; question?: string }> = [];
  /** True once this session actually handed a verified timer-free runtime the question tool. */
  protected questionToolEnabled = false;
  /** Structured end-turn handoff for runtimes whose tool wait is finite or unverified. */
  protected questionFallbackEnabled = false;
  /** Plan mode is available even when a runtime falls back to its final markdown response. */
  protected planEnabled = false;
  protected planMode = false;
  /** Undefined means the sidecar has not been read for this process yet. */
  protected planDocumentCache: PlanDocument | null | undefined;
  /** Serialises tool and response-fallback submissions into numbered revisions. */
  protected planMutation: Promise<void> = Promise.resolve();
  /** Invalidates a submission that was started by a conversation since cleared. */
  protected planGeneration = 0;
  /** Keeps queued user turns behind response-fallback handling for the turn that just ended. */
  protected fallbackResponses = 0;
  /** Text blocks in assistant messages emitted during the current planning turn. */
  protected readonly planResponseBlocks = new Map<string, Map<number, string>>();
  /**
   * Prefix-buffered fallback text. Holding only a possible `<ccweb-question>`
   * prefix keeps ordinary replies streaming while preventing protocol JSON
   * from ever becoming transcript content when the envelope is recognised.
   */
  protected readonly fallbackTextBlocks = new Map<string, {
    msgId: string;
    index: number;
    text: string;
    events: AdapterEvent[];
  }>();
  protected flushingFallbackText = false;
  protected planResponseCandidate = '';
  protected planSubmittedThisTurn = false;
  /**
   * Skills and project commands found on disk when this session launched.
   *
   * Kept so a runtime that reports its own command list cannot drop them; see
   * the merge in `ingest`.
   */
  protected installedCommands: SlashCommand[] = [];
  protected runtime = '';
  protected bypass = false;
  protected nativeSessionId: string | null = null;
  protected startedAt = 0;
  protected cwd = '';
  /** The options this session was last launched with, kept for `/clear` and `/new`. */
  protected lastStartOptions: ChatSessionStartOptions | null = null;

  /**
   * The model whose context window is being reported, and where it came from.
   *
   * Four of the agents here publish their own window and this never asks
   * anyone; pi and kimi publish none, and for those the model's provider is
   * asked instead — once per model, not once per turn. `askedFor` is what
   * stops a conversation from re-asking a question that already came back
   * empty on every single message.
   *
   * All three reset when the model changes, because the whole point is that a
   * switch to a smaller model must not carry the larger one's ceiling forward.
   *
   * `windowStated` is what makes that true of a switch nobody can answer:
   * dropping what this object knows is not enough when the figure is already
   * written into the log and being read off the screen, so it has to be taken
   * down out loud. See `retractContextWindow`.
   */
  protected contextModel?: string;
  protected contextWindowFromAgent = false;
  protected capacityAskedFor?: string;
  protected contextWindowStated = false;
  /** The model the standing agent-reported ceiling was stated for, when named. */
  protected agentWindowModel?: string;

  /**
   * Whether this conversation has ever been told what it spent.
   *
   * The four booleans behind the "not reported" the header shows for a runtime
   * that reports nothing. `spoke*` is the observation — any report carrying a
   * token count or a price, on any channel. `stated*` is the answer already
   * being on the log, so it is said once rather than on the end of every turn.
   *
   * Kept here rather than worked out in the browser because the transcript
   * cannot tell an agent that will never speak from one that has not spoken
   * yet, and the difference is only knowable from having watched a turn finish.
   * See `noteSpend`.
   */
  protected spokeTokens = false;
  protected spokeCost = false;
  protected statedTokenSilence = false;
  protected statedCostSilence = false;
  /**
   * Whether the runtime has done anything at all in the turn now open.
   *
   * A `/clear` opens and closes a turn before it is recognised as a command,
   * and an empty turn is not evidence about what a runtime reports — filing one
   * as "reports nothing" would put the label on a conversation whose agent had
   * not yet been asked for anything.
   */
  protected turnDidWork = false;

  /**
   * The history this conversation was branched with, until the first turn takes it.
   *
   * `undefined` means the store has not been asked yet; `null` means it was and
   * there is nothing — which is every conversation that was not branched. Read
   * once and remembered either way, because it is asked for on every delivery
   * and almost every answer is "no".
   */
  protected carried: string | null | undefined;

  /**
   * True between resuming a conversation and the first thing the user says in it.
   *
   * Runtimes differ on what a resume emits: ACP's `session/load` replays the
   * whole history back as notifications, and the others make no promise either
   * way. Every one of those events would be appended to a log that already
   * holds them, and the user would watch their conversation appear underneath
   * itself. Nothing the agent says before it is asked something is new, so the
   * rule needs no per-runtime knowledge: while this is set, content is dropped
   * and only the metadata that describes the *new* process is kept.
   */
  protected replaying = false;

  /**
   * Turns typed while the agent was busy, oldest first.
   *
   * Held here rather than in the browser on purpose: this object outlives every
   * tab watching it, and a queue that died with the tab would contradict the
   * one promise this whole surface makes — that the agent keeps working after
   * you close it. Two browsers on one session see the same line, and a reload
   * gets it back from the snapshot.
   */
  protected queue: QueuedTurn[] = [];
  /** Guards the drain against re-entering itself through `send` -> `ingest`. */
  protected draining = false;
  /**
   * The turn currently running, by id, or null between turns.
   *
   * Only one thing reads it: a message promoted past the queue while the agent
   * is working continues *this* turn instead of starting one, because it is
   * being delivered into the work rather than waiting for its own (#86).
   */
  protected turnInFlightId: string | null = null;
  /**
   * The user message this session wrote for the turn in flight, by id.
   *
   * Held so a second one, minted by the adapter, can be recognised for what it
   * is — see `isForeignUserEcho`.
   */
  protected ownUserMessageId: string | null = null;
  /**
   * Message ids an adapter tried to file a user turn under, which this session
   * dropped. Their blocks and their end have to go the same way, or the
   * transcript keeps orphan events pointing at a message that was never opened.
   */
  protected readonly droppedUserEchoes = new Set<string>();
  /**
   * Until when a `turn_end` is the runtime letting go of interrupted work
   * rather than the turn ending. Null when nothing has been interrupted.
   */
  protected staleTurnEndUntil: number | null = null;
  /**
   * Until when an `error` is the runtime's account of work this session told it
   * to drop, rather than something that went wrong. Null when nothing has been
   * interrupted.
   *
   * Claude reports an interrupted run as `is_error` with the subtype
   * `error_during_execution`, so stopping a turn — or correcting it by sending
   * ahead of it — put a red card reading "claude ended the turn as
   * error_during_execution" in the conversation, with a Retry button offering
   * to run again the thing the user had just stopped. Nothing failed: the run
   * ended because it was told to. The record of that is the `interrupted`
   * marker and the turn's own stop reason, both of which say it in the user's
   * terms.
   *
   * A sibling of `staleTurnEndUntil` and set at the same moment, but a
   * separate field because the two answer different questions — whether the
   * turn is over, and whether anything went wrong — and an interrupt from the
   * stop button ends the turn while still owing no explanation.
   */
  protected interruptedErrorUntil: number | null = null;
  /** Runs the drain again once the adapter has finished letting go of the last turn. */
  protected drainRetry: ReturnType<typeof setTimeout> | null = null;
  /** When the current wait for a ready adapter began; null when not waiting. */
  protected readySince: number | null = null;

  /**
   * Which process the events arriving here belong to.
   *
   * `stop()` signals the child and waits for verified closure, but a replaced
   * adapter can still emit while that asynchronous teardown is in progress
   * — and what it emits last is `state: exited`. Landing that in the log after
   * the replacement is already running told every browser, and the session
   * record, that a live conversation had ended: the pane went read-only over a
   * working agent and only a relaunch could talk it round.
   *
   * Bumped by `start()` and again by `restart()` before the old process is
   * signalled, so each adapter's `emit` closure carries the number it was born
   * with and anything from an older one is dropped rather than believed.
   */
  protected adapterGeneration = 0;

  /**
   * An adapter may report `state: exited` while its `start()` promise is still
   * deciding whether startup succeeded. Publishing that as a completed
   * lifecycle transition immediately is unsafe: a rejected ladder probe is
   * followed by another adapter in the same session, and its exit would release
   * the project admission the fallback is about to reuse.
   *
   * The event still updates this session's observable state immediately. Only
   * the record/lease notification is deferred until `start()` resolves. If
   * startup rejects, the generation is invalidated before the failed adapter is
   * stopped, so neither that event nor a delayed process-close event can be
   * mistaken for the lifecycle of its replacement.
   */
  protected adapterStarting = false;
  protected adapterExitedWhileStarting = false;

  /**
   * True while a conversation is being replaced by a new one in place.
   *
   * Only the queue reads it, and only to stay quiet: a turn already in flight
   * when the clear lands will fail against the process being torn down, and
   * "could not be sent" written into the fresh window would be a complaint
   * about the conversation the user just asked to leave.
   */
  protected restarting = false;

  /**
   * Watches this session's own events and files what each job cost.
   *
   * Rebuilt on every `start()` because the two things it has to know — whether
   * this process resumed a conversation, and what that conversation had already
   * been billed — are properties of the launch, not of the session.
   */
  protected accountant: UsageAccountant | null = null;


  constructor(
    protected readonly ref: ChatSessionRef,
    protected readonly deps: ChatSessionDeps,
  ) {}


  get sessionId(): string {
    return this.ref.id;
  }


  get live(): boolean {
    return Boolean(this.adapter?.alive);
  }

  /**
   * Whether this session still owns an adapter, including one whose local
   * engine client exited but whose container process could not be verified
   * stopped. Manager teardown uses this stronger fact than `live` so a failed
   * stop never drops the only handle capable of retrying it.
   */

  get ownsAdapter(): boolean {
    return this.adapter !== null;
  }


  get currentState(): ChatState {
    return this.state;
  }


  get currentCapabilities(): ChatCapabilities | null {
    return this.capabilities;
  }

  /** The runtime's own session id, needed to resume it in the other surface. */

  get nativeId(): string | null {
    return this.nativeSessionId;
  }


  get bypassing(): boolean {
    return this.bypass;
  }

  /** The directory the agent was launched in, and the root it is confined to. */

  get workingDir(): string {
    return this.cwd;
  }


  get runtimeKind(): string {
    return this.runtime;
  }

  /**
   * The server-side restart gate. A browser snapshot is necessarily stale by
   * the time a click arrives, so only this object can safely decide that no
   * submitted work or interaction will be interrupted.
   */

  get safeForAutomaticAgentRestart(): boolean {
    return this.live
      && this.state === 'idle'
      && this.adapterReady
      && this.turnInFlightId === null
      && this.queue.length === 0
      && this.pending.size === 0
      && this.questions.size === 0
      && this.questionContinuations.size === 0
      && this.questionDispatches.size === 0
      && !this.questionTransitionRunning
      && !this.restarting;
  }

  /** Whether the runtime can carry its native conversation across a process replacement. */

  get resumableForAgentRestart(): boolean {
    return Boolean(
      this.nativeSessionId
      && (this.capabilities?.resume === true || this.adapter?.capabilities.resume === true),
    );
  }

  /**
   * Replace only the live agent process while retaining this ChatSession and
   * its app transcript. Manual callers may interrupt work; automatic callers
   * must pass the atomic idle gate above. A non-resumable restart is explicit
   * because the app transcript survives but the agent's own memory does not.
   */

  get queuedTurns(): QueuedTurn[] {
    return this.queue.map((turn) => ({ ...turn }));
  }

  /**
   * Accept a turn.
   *
   * Idle and nothing waiting means it goes straight to the runtime. Anything
   * else — a turn in flight, an approval on screen, a runtime still starting —
   * means it takes its place in line instead of being refused, which is the
   * whole point: you can keep typing while the agent works.
   *
   * The queue is also checked when the state *is* idle, because a drain is
   * scheduled by the event stream and a turn arriving in that gap must not
   * overtake the ones already waiting.
   */

  get ladderRung(): LadderRung | null {
    if (!this.ladder || !this.live) return null;
    const escalation = this.escalation;
    if (escalation && !escalation.startsNextTurn) {
      return { tier: escalation.to, model: escalation.model };
    }
    const model = this.ladder.tiers[this.ladder.tier];
    return model ? { tier: this.ladder.tier, model } : null;
  }

  /**
   * Move this conversation onto an edited ladder, mid-conversation.
   *
   * Returns false — meaning "not mine" — for a conversation that is not running
   * on a rung: one pinned by a model somebody typed, or by an account's standing
   * choice, was never the ladder's to decide and must not be re-modelled by an
   * edit to it.
   *
   * The turn in progress is interrupted, which #171 asks for outright. It is
   * destructive and deliberately so: the alternative is a conversation that goes
   * on answering from the model the profile no longer names, for as long as the
   * turn runs, with the settings page reporting the change as applied.
   */

  async restartForAgentUpdate(input: {
    automatic: boolean;
    allowFreshContext: boolean;
    command?: string;
  }): Promise<AgentUpdateRestartResult> { throw new Error('unreachable: overridden in split module'); }

  async start(options: ChatSessionStartOptions): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async restorePendingQuestions(canResume: boolean): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  protected isInterruptedRunReport(event: AdapterEvent): boolean { throw new Error('unreachable: overridden in split module'); }

  protected isForeignUserEcho(event: AdapterEvent): boolean { throw new Error('unreachable: overridden in split module'); }

  protected capturePlanResponse(event: ChatEvent): string | null { throw new Error('unreachable: overridden in split module'); }

  protected async handleFallbackResponse(markdown: string): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async continueAfterFallbackQuestion(
    question: string,
    answer: QuestionReply,
    generation = this.questionContinuationGeneration,
    continuationId?: string,
  ): Promise<'delivered' | 'deferred' | 'failed'> { throw new Error('unreachable: overridden in split module'); }

  protected markQuestionContinuationDispatching(
    continuationId: string,
    generation: number,
  ): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  protected markQuestionContinuationPending(continuationId: string): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected dispatchQuestionContinuation(
    continuationId: string,
    generation = this.questionContinuationGeneration,
  ): void { throw new Error('unreachable: overridden in split module'); }

  protected async runQuestionContinuation(
    continuationId: string,
    generation: number,
  ): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected finishQuestionContinuation(
    continuationId: string,
    outcome: 'delivered' | 'abandoned',
    reason?: string,
  ): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async abandonQuestionContinuationsNow(reason: string): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected interceptFallbackQuestionText(event: AdapterEvent): boolean { throw new Error('unreachable: overridden in split module'); }

  protected ingest(event: AdapterEvent, durable = false, durableWriteAttempts = 1): void | Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected setState(state: ChatState): void { throw new Error('unreachable: overridden in split module'); }

  protected noteContext(event: ChatEvent): void { throw new Error('unreachable: overridden in split module'); }

  protected retractContextWindow(): void { throw new Error('unreachable: overridden in split module'); }

  protected noteSpend(event: ChatEvent): void { throw new Error('unreachable: overridden in split module'); }

  protected fileJob(job: FinishedJob): void { throw new Error('unreachable: overridden in split module'); }

  async send(turn: UserTurn): Promise<'accepted' | 'queued'> { throw new Error('unreachable: overridden in split module'); }

  protected get adapterReady(): boolean { throw new Error('unreachable: overridden in split module'); }

  protected enqueue(turn: UserTurn): void { throw new Error('unreachable: overridden in split module'); }

  cancelQueued(id: string): boolean { throw new Error('unreachable: overridden in split module'); }

  async sendQueuedNow(id: string): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  clearQueue(): number { throw new Error('unreachable: overridden in split module'); }

  retryQueued(id: string): boolean { throw new Error('unreachable: overridden in split module'); }

  protected drainQueue(): void { throw new Error('unreachable: overridden in split module'); }

  protected waitForReady(): void { throw new Error('unreachable: overridden in split module'); }

  protected stopWaitingForReady(): void { throw new Error('unreachable: overridden in split module'); }

  protected failQueuedTurn(turn: QueuedTurn, reason: string, { putBack = true } = {}): void { throw new Error('unreachable: overridden in split module'); }

  protected publishQueue(): void { throw new Error('unreachable: overridden in split module'); }

  protected async deliver(turn: UserTurn, continuesTurnId?: string): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async openingContext(): Promise<string | null> { throw new Error('unreachable: overridden in split module'); }

  protected async restart(): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  async interrupt(): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async cancelTurnInFlight(): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  respondPermission(requestId: string, optionId: string): boolean { throw new Error('unreachable: overridden in split module'); }

  protected askUser(ask: PermissionAsk): Promise<PermissionAnswer> { throw new Error('unreachable: overridden in split module'); }

  protected async requestTier(ask: TierAsk): Promise<TierReply> { throw new Error('unreachable: overridden in split module'); }

  protected async applyModel(model: string): Promise<'live' | 'next-turn' | 'no'> { throw new Error('unreachable: overridden in split module'); }

  protected askEscalation(
    from: ModelTier,
    to: ModelTier,
    model: string,
    reason: string,
  ): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  async reapplyLadder(
    ladder: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> } | null,
  ): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  protected async endEscalation(): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected noteAskCall(toolId: string, name: string | undefined, input: unknown): void { throw new Error('unreachable: overridden in split module'); }

  protected claimAskCall(question: string): string | undefined { throw new Error('unreachable: overridden in split module'); }

  protected askQuestion(ask: QuestionAsk, signal?: AbortSignal): Promise<QuestionReply> { throw new Error('unreachable: overridden in split module'); }

  protected async openHandoffQuestion(ask: QuestionAsk): Promise<QuestionReply | null> { throw new Error('unreachable: overridden in split module'); }

  protected mutateQuestions<T>(operation: () => Promise<T>): Promise<T> { throw new Error('unreachable: overridden in split module'); }

  protected runNextQuestionTransition(): void { throw new Error('unreachable: overridden in split module'); }

  protected buildQuestionRequest(
    ask: QuestionAsk,
    origin: 'tool' | 'structured_handoff',
  ): { request: QuestionRequest } | { error: string } { throw new Error('unreachable: overridden in split module'); }

  async answerQuestion(
    requestId: string,
    optionIds: string[],
    skipped = false,
    text?: string,
  ): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  protected questionsFor(toolId: string): string[] { throw new Error('unreachable: overridden in split module'); }

  protected abandonQuestionsFor(toolId: string, reason = 'the agent stopped waiting for an answer'): void { throw new Error('unreachable: overridden in split module'); }

  protected abandonToolQuestions(reason: string): void { throw new Error('unreachable: overridden in split module'); }

  protected abandonQuestionsAfterUnresumableExit(): void { throw new Error('unreachable: overridden in split module'); }

  protected isToolQuestion(entry: PendingQuestion): entry is PendingToolQuestion { throw new Error('unreachable: overridden in split module'); }

  protected abandonQuestion(requestId: string, reason: string): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected abandonQuestions(
    reason: string,
    predicate: (entry: PendingQuestion) => boolean = () => true,
  ): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  protected async abandonQuestionNow(
    requestId: string,
    entry: PendingQuestion,
    reason: string,
  ): Promise<void> { throw new Error('unreachable: overridden in split module'); }

  async setModel(model: string): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  async planDocument(): Promise<PlanDocument | null> { throw new Error('unreachable: overridden in split module'); }

  protected mutatePlan<T>(operation: () => Promise<T>): Promise<T> { throw new Error('unreachable: overridden in split module'); }

  async submitPlan(input: { markdown?: unknown; source?: 'tool' | 'response' }): Promise<PlanSubmissionResult> { throw new Error('unreachable: overridden in split module'); }

  async setPlanMode(on: boolean): Promise<PlanModeResult> { throw new Error('unreachable: overridden in split module'); }

  rememberPlanMode(on: boolean): void { throw new Error('unreachable: overridden in split module'); }

  async acceptPlan(revision: number): Promise<PlanActionResult> { throw new Error('unreachable: overridden in split module'); }

  async rejectPlan(revision: number): Promise<PlanActionResult> { throw new Error('unreachable: overridden in split module'); }

  rememberModel(model: string | undefined): void { throw new Error('unreachable: overridden in split module'); }

  async setEffort(effort: string): Promise<boolean> { throw new Error('unreachable: overridden in split module'); }

  rememberEffort(effort: string | undefined): void { throw new Error('unreachable: overridden in split module'); }

  snapshot(): Promise<ChatSnapshot> { throw new Error('unreachable: overridden in split module'); }

  async stop({ preserveHandoffs = false }: { preserveHandoffs?: boolean } = {}): Promise<void> { throw new Error('unreachable: overridden in split module'); }
}
