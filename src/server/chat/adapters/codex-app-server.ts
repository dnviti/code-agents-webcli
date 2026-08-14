/**
 * Codex JSON-RPC app-server adapter.
 *
 * Concrete half of the split in codex-app-server-base.ts; leans on that base
 * for the notification/streaming machinery and adds the launch handshake,
 * session-side sends, and approval handling here.
 */
import { defaultPermissionOptions } from '../../../shared/chat-events.js';
import type { ChatCapabilities, ModelChoice, PermissionOption, UserTurn } from '../../../shared/chat-events.js';
import { permissionRequest } from '../adapter.js';
import { record, str, list } from './codex-utils.js';
import { fileChangeToFileDiff } from './codex-diff.js';
import {
  CLIENT_INFO,
  CODEX_BASE_EFFORTS,
  INIT_TIMEOUT_MS,
  MODEL_LIST_TIMEOUT_MS,
  RATE_LIMITS_TIMEOUT_MS,
  THREAD_START_TIMEOUT_MS,
  codexSkillInvocation,
  effortLadder,
  initialCodexCommands,
  reviewDecisionFor,
} from './codex-launch.js';
import { CodexAppServerAgentBase } from './codex-app-server-base.js';

export class CodexAppServerAdapter extends CodexAppServerAgentBase {
  readonly runtime = 'codex';

  readonly capabilities: ChatCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    diffs: true,
    permissions: true,
    interrupt: true,
    resume: true,
    // No capture or schema note shows a fork-then-continue call keyed to a
    // specific earlier point; `thread/fork` forks the thread's current head
    // only, which is not what this capability promises the UI.
    fork: false,
    attachments: true,
    usage: true,
    // Tokens always; cost as an API-list-price estimate computed by this app
    // from the confirmed model and reported tokens (issue #182). The runtime
    // itself never prices a turn; the estimated figure is stamped with its
    // provenance and never presented as a bill.
    cost: true,
    plan: true,
    commands: initialCodexCommands(this.options),
    efforts: CODEX_BASE_EFFORTS.map((level) => ({ ...level })),
  };

  protected buildArgs(): string[] {
    return ['app-server', ...(this.options.extraArgs || [])];
  }

  protected async handshake(): Promise<void> {
    await this.withTimeout(
      this.call('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false },
      }),
      INIT_TIMEOUT_MS,
      'initialize',
    );
    // Required before any other request; app-server accepts nothing sent
    // ahead of it, which reads as a silent hang rather than a rejection.
    this.notify('initialized');

    const params: Record<string, unknown> = { cwd: this.runtimeWorkingDir };
    if (this.options.model) params.model = this.options.model;
    if (this.options.effort) {
      // There is no `effort` parameter on `thread/start`; the level travels in
      // the free-form `config` map, under the same key codex's own
      // `-c model_reasoning_effort=…` writes into. Probed live against
      // codex-cli 0.145.0 by opening three threads on gpt-5.5 and reading the
      // reply back each time: no `config` answered `reasoningEffort: "xhigh"`
      // (the configured default on this machine), `{"model_reasoning_effort":
      // "low"}` answered `"low"` and `{"model_reasoning_effort":"xhigh"}`
      // answered `"xhigh"`. So the key is read, and read at thread start rather
      // than accepted and ignored.
      //
      // That this lands in `thread/resume` too — `params` is spread into both —
      // is wanted, and the schema agrees: `ThreadResumeParams` carries the same
      // optional `config` map, documented there as "configuration overrides for
      // the resumed thread". A conversation deliberately moved off the default
      // level should come back on the level it was left on, not silently revert
      // to whatever the profile says.
      params.config = { model_reasoning_effort: this.options.effort };
    }
    if (this.options.bypassPermissions) {
      // Belt-and-braces alongside handleServerRequest's own auto-approve:
      // this asks codex not to send approval requests at all, but the
      // interception below is what actually holds if a build ignores it.
      params.approvalPolicy = 'never';
    }

    const response = record(
      await this.withTimeout(
        this.options.resumeSessionId
          ? this.call('thread/resume', { threadId: this.options.resumeSessionId, ...params })
          : this.call('thread/start', params),
        THREAD_START_TIMEOUT_MS,
        this.options.resumeSessionId ? 'thread/resume' : 'thread/start',
      ),
    );

    const thread = record(response.thread);
    this.threadId = str(thread.id) || null;
    this.model = str(response.model);
    // Not what was asked for — what codex says it got. The two differ whenever
    // nothing was asked for at all, and the reply is the only place the answer
    // appears: `reasoningEffort` sits at the top level of both the
    // `thread/start` and the `thread/resume` response, alongside `model` and
    // `cwd`, in the schema and in the live capture both.
    this.reportedEffort = str(response.reasoningEffort) ?? null;
    // Codex resolves the effective catalogue for this cwd itself: shared Agent
    // Skills, enabled plugins and system skills included, in the environment
    // where the runtime is actually running. The stand-in above keeps the menu
    // usable while this deliberately non-blocking request completes.
    void this.loadSkillList();
    // Not awaited. The picker's menu is worth having but not worth holding a
    // conversation open for, and the answer arrives on its own event whenever
    // it arrives — `capabilities` exists for exactly this, a runtime revising
    // what it can do after it has introduced itself.
    void this.loadModelList();
    // Same treatment, for the same reason: worth having, not worth holding a
    // conversation open for. It is also the only account figure any runtime
    // here reports at launch rather than mid-turn.
    void this.loadRateLimits();

    this.emit({
      t: 'session',
      nativeSessionId: this.threadId || undefined,
      model: this.model,
      // App-server runs inside the selected environment and therefore answers
      // with that environment's path. The rest of this app addresses the
      // workspace through its host mount, so keep the public/session cwd in
      // the host namespace while RPC requests use `runtimeWorkingDir`.
      cwd: this.options.environment?.kind === 'container'
        ? this.options.workingDir
        : str(response.cwd) || this.options.workingDir,
      capabilities: this.capabilities,
    });
    // After `session`, because that event is what introduces the runtime and a
    // level arriving ahead of it has nothing to be shown against. `null` here
    // is codex's own answer rather than a hole in ours: `reasoningEffort` is
    // `ReasoningEffort | null` in the generated reply type, and null means the
    // thread is running on the model's own default with nothing overriding it —
    // which is exactly what the event's null already means.
    this.emit({ t: 'effort', effort: this.reportedEffort });
    this.emit({ t: 'state', state: 'idle' });
  }

  /**
   * Ask codex which models it will accept, and how hard each will think.
   *
   * `model/list` is a real request on this protocol — confirmed against the
   * running app-server, which rejects an unknown method by name and answers
   * this one with `{ data: [{ id, displayName, description, isDefault, hidden }] }`.
   * So codex's picker offers what codex says, rather than asking somebody to
   * remember a model id and type it correctly.
   *
   * The same entries carry the effort ladder, which is why one call feeds both
   * controls: a live `model/list` on codex-cli 0.145.0 returned
   * `supportedReasoningEfforts` and `defaultReasoningEffort` per model, and the
   * ladders are genuinely per model — gpt-5.6-terra offers six levels up to
   * `ultra`, gpt-5.5 four stopping at `xhigh`. Publishing a union of them all
   * would offer levels the running model refuses, so only the current model's
   * ladder is published: the entry matching what `thread/start` said is running,
   * and failing that the one codex flagged `isDefault`, which is the model that
   * same thread would have been given.
   *
   * Best-effort by construction: a build that does not have the method, or is
   * slow to answer it, must not stop a conversation opening. The catch leaves
   * `capabilities.models` and `capabilities.efforts` unset, which is the same
   * state as a runtime that publishes nothing — and both controls already say so
   * rather than showing an empty menu. The same guard applies field by field
   * within a successful answer: a build old enough to list models without
   * listing their efforts publishes the models and stays quiet about the rest.
   */
  private async loadModelList(): Promise<void> {
    try {
      const response = record(
        await this.withTimeout(this.call('model/list', {}), MODEL_LIST_TIMEOUT_MS, 'model/list'),
      );
      const entries = Array.isArray(response.data) ? response.data : [];
      const models: ModelChoice[] = [];
      let running: Record<string, unknown> | undefined;
      let byDefault: Record<string, unknown> | undefined;
      for (const entry of entries) {
        const item = record(entry);
        // Matched ahead of the `hidden` filter, and on both spellings. Ahead of
        // it because hidden means "do not offer this in the picker", not "this
        // cannot be what the thread is running" — and if it is what the thread
        // is running, its ladder is the one that applies. Both spellings because
        // the entry carries `id` and `model` separately and they are not always
        // the same string; matching on one alone would quietly fall through to
        // the default entry's ladder for a model that has its own.
        if (this.model && (str(item.id) === this.model || str(item.model) === this.model)) {
          running = item;
        }
        if (!byDefault && item.isDefault === true) byDefault = item;

        if (!item || item.hidden === true) continue;
        const value = str(item.id) || str(item.model);
        if (!value) continue;
        models.push({
          value,
          name: str(item.displayName) || value,
          ...(str(item.description) ? { description: str(item.description) as string } : {}),
        });
      }

      const efforts = effortLadder(running || byDefault);
      const patch: Partial<ChatCapabilities> = {};
      if (models.length > 0) {
        this.capabilities.models = models;
        patch.models = models;
      }
      if (efforts) {
        this.capabilities.efforts = efforts;
        patch.efforts = efforts;
      }
      if (Object.keys(patch).length > 0) {
        this.emit({ t: 'capabilities', capabilities: patch });
      }
    } catch {
      // Deliberately silent: nothing about a missing menu is worth an error
      // event in a transcript, and the conversation is about to start fine.
    }
  }

  /**
   * Ask codex where the account stands, which it will actually tell you.
   *
   * Probed live against codex-cli 0.146.0 on 2026-07-29: `account/rateLimits/read`
   * (no params) answers with `rateLimits: { limitId, limitName, primary,
   * secondary, credits, planType, spendControlReached, rateLimitReachedType }`,
   * where each window is `{ usedPercent, windowDurationMins, resetsAt }` and
   * `resetsAt` is epoch seconds. The captured reply is
   * `test/fixtures/chat/codex-appserver-ratelimits.jsonl`.
   *
   * That `planType` is the reason this app never reads `~/.codex/auth.json`:
   * the plan name is also inside the id_token there, but that file holds the
   * access and refresh tokens beside it, and a status readout is not worth
   * teaching this server to open a credentials file. Codex volunteers the same
   * fact over a protocol it already speaks.
   *
   * Best-effort by construction, like `loadModelList`: a build without the
   * method must not stop a conversation opening, and a silent one must not hold
   * the pending map open — hence the timeout.
   */
  private async loadRateLimits(): Promise<void> {
    try {
      const response = record(
        await this.withTimeout(
          this.call('account/rateLimits/read', {}),
          RATE_LIMITS_TIMEOUT_MS,
          'account/rateLimits/read',
        ),
      );
      this.onRateLimits(response);
    } catch {
      // Deliberately silent. "Codex would not say" is a state the panel already
      // renders in words; an error event would put a protocol detail in a
      // transcript over something nobody asked for.
    }
  }

  // ------------------------------------------------------------- outgoing
  async send(turn: UserTurn): Promise<void> {
    if (!this.threadId) {
      this.emit({ t: 'error', message: 'codex: no active thread, so the turn was not sent' });
      return;
    }

    // The shared composer speaks `/name`, while Codex's app-server explicitly
    // invokes skills with `$name` plus a structured skill item. Keep the slash
    // in the transcript (the session already wrote the person's exact text)
    // and translate only a name from Codex's own latest catalogue. Unknown
    // slashes remain untouched instead of being guessed into a different
    // command, and the private manifest path never enters capabilities/logs.
    const invocation = codexSkillInvocation(turn.text, this.skillPaths);
    const skill = invocation.skill;
    const input: Array<Record<string, unknown>> = [
      { type: 'text', text: invocation.text, text_elements: [] },
    ];
    if (skill?.path) input.push({ type: 'skill', name: skill.name, path: skill.path });
    for (const attachment of turn.attachments || []) {
      input.push(
        attachment.path ? { type: 'localImage', path: attachment.path } : { type: 'image', url: attachment.url },
      );
    }

    const params: Record<string, unknown> = { threadId: this.threadId, input };
    if (this.turnEffort) {
      // Only ever a level `setEffort` was given, and `setEffort` is only ever
      // given one off the menu `model/list` published. That chain matters here
      // rather than at the far end of it, because `turn/start` does not check
      // this field: a probe sent a level codex has never heard of and got back
      // `OK` with a perfectly ordinary turn object. A typo would therefore not
      // fail — it would run the whole turn at some level nobody can name.
      params.effort = this.turnEffort;
    }

    const response = record(await this.call('turn/start', params));
    const turnId = str(record(response.turn).id) || `turn-${Date.now()}`;

    this.turnId = turnId;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.itemBlockIndex.clear();
    this.planText.clear();
    this.reasoningChannel.clear();

    // The user's own message is not written here. `ChatSession.deliver` has
    // already put it in the transcript, with the turn id it minted and the text
    // the user actually typed — a copy from this side is a second bubble in the
    // same turn (#129), and on a branched conversation it is the briefing glued
    // in front of the prompt rather than the prompt.
    this.emit({ t: 'state', state: 'thinking' });
  }

  /**
   * Move this thread onto a different reasoning-effort level.
   *
   * There is no method for it. Nothing in the vendored bindings is shaped like
   * `thread/set_effort`, and guessing an RPC name to see whether it answers
   * only puts a `-32601` in somebody's transcript. What does exist is
   * `turn/start`'s own `effort`, documented in
   * `.work/probes/raw/codex-ts/v2/TurnStartParams.ts` as "Override the
   * reasoning effort for this turn and subsequent turns" — the same wording its
   * neighbours `model`, `cwd` and `approvalPolicy` carry, all of which are
   * thread-level settings reached through a turn. So the level is remembered
   * here and attached to every turn from now on, which `send()` does.
   *
   * That is also why this resolves at once instead of waiting for a turn to
   * prove it. Resolving is a claim about what happens next, and what happens
   * next is that the very next `turn/start` carries the new level: the
   * parameter rides on the request that *begins* a turn, so there is no window
   * in which a turn could still run at the old one. The alternative — staying
   * silent until the user happens to send a message — would leave the control
   * showing a level the session is no longer going to use, for as long as they
   * did not, and a control that lies for an unbounded stretch is worse than one
   * that admits it cannot switch at all.
   *
   * The `effort` event is emitted from here on the same footing, and it is
   * worth being exact about what it claims. Codex has not been asked anything
   * yet and has not answered; what is being reported is not "codex confirmed"
   * but "this is the level the next turn runs at", which this adapter is the
   * thing that decides. There is no later confirmation to wait for either:
   * `TurnStartResponse` is `{ turn }` and nothing else, so a turn that accepts
   * the override says nothing about it.
   */
  async setEffort(effort: string): Promise<void> {
    this.turnEffort = effort;
    this.emit({ t: 'effort', effort });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return; // nothing running
    try {
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // The turn may already have finished between the click and this
      // landing; that races turn_end harmlessly and is not worth surfacing.
    }
  }

  respondPermission(requestId: string, optionId: string): void {
    const id = this.permissionWaiters.get(requestId);
    if (id === undefined) return; // already answered, or an id we never issued
    this.permissionWaiters.delete(requestId);
    this.respond(id, reviewDecisionFor(optionId));
    this.emit({
      t: 'permission_resolved',
      requestId,
      optionId,
      allowed: optionId === 'allow_once' || optionId === 'allow_always',
    });
  }

  protected handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.handleApproval(id, method, params);
      return;
    }
    // Every other server request (elicitations, dynamic tool calls, auth
    // token refresh, ...) is outside this adapter's scope. Declining rather
    // than staying silent keeps the agent's turn moving instead of stalling
    // on an answer that will never come.
    this.respondError(id, -32601, `codex adapter does not handle ${method}`);
  }

  private handleApproval(id: number | string, method: string, params: Record<string, unknown>): void {
    const requestId = String(id);
    const callId = str(params.callId) || undefined;

    if (this.options.bypassPermissions) {
      // Pre-answered by the bypass setting; nothing is asked and nothing
      // waits, so there is no `permission` event to pair this with.
      this.respond(id, 'approved_for_session');
      this.emit({
        t: 'permission_resolved',
        requestId,
        optionId: 'allow_always',
        allowed: true,
        automatic: true,
      });
      return;
    }

    const options: PermissionOption[] = defaultPermissionOptions();
    let request;
    if (method === 'execCommandApproval') {
      const command = list(params.command).map(String);
      request = permissionRequest({
        requestId,
        toolId: callId,
        title: command.length ? `Run: ${command.join(' ')}` : 'Run a command',
        toolKind: 'execute',
        input: { command, cwd: str(params.cwd), reason: str(params.reason) },
        reason: str(params.reason),
        options,
      });
    } else {
      const fileChanges = record(params.fileChanges);
      const diffs = Object.entries(fileChanges).map(([path, change]) =>
        fileChangeToFileDiff(path, record(change)),
      );
      request = permissionRequest({
        requestId,
        toolId: callId,
        title: diffs.length === 1 ? `Apply patch: ${diffs[0].path}` : `Apply patch to ${diffs.length} files`,
        toolKind: 'edit',
        diffs,
        reason: str(params.reason),
        options,
      });
    }

    this.permissionWaiters.set(requestId, id);
    this.emit({ t: 'permission', request });
  }
}


