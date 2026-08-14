import {
  ChatCapabilities,
  EffortChoice,
  ModelChoice,
  PermissionOption,
  rankedEfforts,
} from '../../../../shared/chat-events.js';
import { JsonRpcChatAdapter } from '../../adapter.js';
import { ACP_BASE_CAPABILITIES, NO_SPEND_REPORTING, list, num, record, str } from './convert.js';
import { AcpChatAdapterOptions, OpenMessage } from './types.js';

/**
 * Base of the ACP adapter's partial-class chain: the handshake, the session
 * and config surface, and every field the rest of the split shares.
 *
 * All instance members are `protected` (rather than the original `private`)
 * purely so the partial classes that extend this one can reach them; the
 * externally visible surface is unchanged.
 */
export abstract class AcpChatAdapterCore extends JsonRpcChatAdapter {
  readonly runtime: string;
  capabilities: ChatCapabilities = { ...ACP_BASE_CAPABILITIES };

  protected readonly acpArgs: string[];
  protected nativeSessionId: string | null = null;
  protected model?: string;
  /** Model value -> the window the agent published for it, where it did. */
  protected readonly modelWindows = new Map<string, number>();
  /** The last window announced, so a re-read does not re-emit the same figure. */
  protected reportedWindow?: number;
  /** The last occupancy announced, for the same reason and on the same rule. */
  protected reportedUsed?: number;
  /**
   * The id of the config option that carries this agent's thinking level.
   *
   * The option's own `id`, never the literal `thinking`, because this is what
   * goes back as `configId` on `session/set_config_option` — and an agent that
   * names its option something else would be unsettable from a hardcoded
   * string. Null means the agent published no `thought_level` category at all,
   * which is grok's case and the reason there is a second road below.
   */
  protected effortOptionId: string | null = null;
  /** The `model` config option's own id, where the agent published one. */
  protected modelOptionId: string | null = null;
  /** Model value -> the effort ladder that model's `_meta` published, where it did. */
  protected readonly modelEfforts = new Map<string, EffortChoice[]>();
  /** Model value -> the level that model's `_meta` said it was running at. */
  protected readonly modelEffortLevels = new Map<string, string>();
  /** The level the agent said it is on. Never one this app merely asked for. */
  protected effort: string | null = null;
  /** The last level announced, so a re-read does not re-emit the same one. */
  protected reportedEffort?: string | null;
  protected turnId: string | null = null;
  /**
   * ACP v1 answers `session/prompt` only when the whole turn ends, not when it
   * accepts the prompt. Keep a separate acceptance waiter so `send()` can obey
   * the adapter contract without waiting for the model's complete reply.
   */
  protected promptAcceptance: {
    turnId: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  /** The ACP v1 prompt RPC remains live until its whole turn settles. */
  protected promptRpcTurnId: string | null = null;
  /** Exact runtime echo of the outstanding prompt, accumulated across chunks. */
  protected promptEcho: { turnId: string; expected: string; received: string; valid: boolean } | null = null;
  /** Tool ids already introduced, used to distinguish a new update-only call from a stale patch. */
  protected readonly knownToolIds = new Set<string>();
  protected turnStartedAt = 0;
  protected current: OpenMessage | null = null;
  protected counter = 0;
  /** Options offered with a pending approval, so a reply can be validated. */
  protected readonly permissionOptions = new Map<string, PermissionOption[]>();
  protected loadSupported = false;
  /**
   * Whether existing local credentials were accepted before session/new.
   *
   * Once true, a `session/new` failure is a technical problem (frequently the
   * question-server MCP child) rather than an auth refusal, so `openSession`
   * must not rewrite the error into a login request.
   */
  protected authenticatedWithExistingCredentials = false;
  /**
   * Paths this turn has already been refused, so it is said once.
   *
   * An agent that is told it may not read a file frequently tries again — a
   * different tool, a second attempt after a grep, the same file from a
   * subagent. Eleven identical red errors in one conversation is what that
   * looked like (#174), and repeating a refusal makes it neither truer nor
   * clearer. Cleared at each turn, because "you still cannot" is worth saying
   * again to somebody who has since asked for something new.
   */
  protected readonly refusedThisTurn = new Set<string>();

  constructor(options: AcpChatAdapterOptions) {
    super(options);
    this.runtime = options.runtime || 'acp';
    this.acpArgs = options.acpArgs || ['acp'];
    if (NO_SPEND_REPORTING.has(this.runtime)) {
      this.capabilities = { ...this.capabilities, usage: false, cost: false };
    }
  }

  protected buildArgs(): string[] {
    return [...this.acpArgs, ...(this.options.extraArgs || [])];
  }

  /**
   * ACP requires an agent-auth method to be selected after initialize and
   * before session/new. OMP's method is deliberately non-interactive: it asks
   * the client to reuse the credentials already present in its local store.
   * Terminal auth methods (Kimi, for example) still need a user-facing login
   * flow and must not be invoked blindly from the chat handshake.
   */
  protected async authenticateWithExistingCredentials(init: Record<string, unknown>): Promise<void> {
    const method = list(init.authMethods)
      .map((raw) => record(raw))
      .find((candidate) => {
        const type = str(candidate.type);
        if (type && type !== 'agent') return false;
        const id = (str(candidate.id) || '').toLowerCase();
        const text = `${str(candidate.name)} ${str(candidate.description)}`.toLowerCase();
        return id === 'agent' || text.includes('existing local credentials');
      });
    const methodId = method ? str(method.id) : '';
    if (!methodId) return;
    await this.call('authenticate', { methodId });
    // Session/new refuses an unauthenticated client, but it also refuses an
    // MCP server that fails to start — and omp reports that second failure as
    // `Internal error`, not as an auth error. Once existing credentials have
    // been accepted, the "needs authentication" rewrite in `openSession` must
    // stay off so the real cause (usually the question-server MCP child) is
    // shown instead of a false login prompt.
    this.authenticatedWithExistingCredentials = true;
  }

  /**
   * The MCP servers this client offers the agent.
   *
   * Only ever the question server, and only when the session wired one up. ACP
   * spells a server's environment as a list of name/value pairs rather than an
   * object, which is the one place its shape differs from every other config
   * this app writes.
   *
   * Verified against omp: the entry is accepted on `session/new`, the tool
   * appears to the model, and calling it reaches this app's socket. Note the
   * agent renames it on the way through — omp reports the call as
   * `mcp__ccweb_ask_user_question`, with a single underscore — which is why
   * nothing downstream matches on an exact tool name.
   */
  protected mcpServers(): Array<Record<string, unknown>> {
    const server = this.options.askMcpServer;
    if (!server) return [];
    return [
      {
        name: server.name,
        command: server.command,
        args: server.args,
        env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
      },
    ];
  }

  protected applyInitialize(init: Record<string, unknown>): void {
    const agent = record(init.agentCapabilities);
    const prompt = record(agent.promptCapabilities);

    this.loadSupported = agent.loadSession === true;
    this.capabilities.attachments = prompt.image === true || prompt.embeddedContext === true;
    // `loadSession` alone, because `session/load` is the call `openSession`
    // actually makes. This used to also require `sessionCapabilities.resume`;
    // kimi, omp and opencode all publish that key so the gate never bit, and
    // then grok arrived publishing `loadSession: true` with an empty
    // `sessionCapabilities` — and loads a session perfectly well. Gating a
    // capability on a key that is not the one being used advertises the
    // opposite of the truth in the one place the app promises not to.
    this.capabilities.resume = this.loadSupported;
  }

  /**
   * Resume when we were asked to and the agent can, otherwise start fresh.
   *
   * A failed load falls back rather than aborting: the user asked for this
   * conversation, and a new session with a visible warning is a better outcome
   * than a runtime that refuses to launch because its history moved.
   */
  protected async openSession(init: Record<string, unknown>): Promise<unknown> {
    const resumeId = this.options.resumeSessionId;
    if (resumeId && this.loadSupported) {
      try {
        const loaded = await this.call('session/load', {
          sessionId: resumeId,
          cwd: this.runtimeWorkingDir,
          mcpServers: this.mcpServers(),
        });
        this.nativeSessionId = resumeId;
        return loaded;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `${this.runtime}: could not resume session: ${message}` });
      }
    }

    try {
      const created = record(
        await this.call('session/new', {
          cwd: this.runtimeWorkingDir,
          mcpServers: this.mcpServers(),
        }),
      );
      this.nativeSessionId = str(created.sessionId) || null;
      return created;
    } catch (error: unknown) {
      // An unauthenticated agent refuses here and nowhere else, and the fix is
      // a login in a terminal — so name the method it offered instead of
      // surfacing a bare RPC error. Once existing credentials were accepted,
      // the refusal is a technical failure (mostly the ccweb MCP child failing
      // to start — omp reports that as `Internal error`), and rewriting it as
      // "needs authentication" would point the user at the wrong fix.
      const methods = list(init.authMethods)
        .map((method) => str(record(method).name) || str(record(method).id))
        .filter(Boolean);
      if (methods.length && !this.authenticatedWithExistingCredentials) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} — this agent needs authentication (${methods.join(', ')})`);
      }
      throw error;
    }
  }

  /**
   * `session/new` answers with the agent's config surface, not just an id.
   *
   * The model select is the only place any of these agents publishes what it can
   * run, so it is the source for `capabilities.models` and for the model the
   * session reports. Nothing here *sets* a model: no capture shows the call that
   * would, and `setModel` is left unimplemented rather than guessed.
   *
   * Two spellings, both captured live. kimi, omp and opencode answer with a
   * `configOptions` list holding a `model` option; grok answers with a `models`
   * object of its own. Reading both is not a guess at a third — an agent that
   * sends neither simply publishes no list, which is what claude does and what
   * the picker already handles.
   */
  protected applySessionConfig(session: Record<string, unknown>): void {
    this.applyModelState(record(session.models));

    for (const raw of list(session.configOptions)) {
      const option = record(raw);
      if (str(option.category) !== 'model' && str(option.id) !== 'model') continue;

      const models: ModelChoice[] = [];
      for (const rawChoice of list(option.options)) {
        const choice = record(rawChoice);
        const value = str(choice.value);
        if (!value) continue;
        models.push({ value, name: str(choice.name) || value, description: str(choice.description) });
      }
      if (models.length) this.capabilities.models = models;
      this.model = str(option.currentValue) || undefined;
      // Kept for `setModel`, which needs it back as `configId`. See there for
      // why the config-option road is preferred over `session/set_model`.
      this.modelOptionId = str(option.id) || 'model';
    }
    this.applyEffortOptions(list(session.configOptions));
    this.readModelWindows(record(session.models));
    // After both spellings of the model have been read, because grok's ladder
    // belongs to a model rather than to the session and picking the wrong
    // model's would publish levels the agent will refuse.
    this.applyModelEffort();
    this.emitContextWindow();
  }

  /**
   * The thinking level, where the agent publishes it as an ACP config option.
   *
   * Alongside the `model` and `mode` categories `applySessionConfig` already
   * walks there is a `thought_level` one, and it is where kimi and omp both put
   * this. Read off `session/new` live this session — kimi answers
   * `{"type":"select","id":"thinking","name":"Thinking","category":"thought_level",
   * "currentValue":"on","options":[{"value":"off"...},{"value":"on"...}]}` and
   * omp the same shape with five levels, `off`, `auto`, `low`, `high`, `max`,
   * where `auto` carries the description "Auto-detect per prompt (low–xhigh)".
   *
   * Matched on the category first and the id second, mirroring the two-way
   * match on the model option directly above: the category is what the protocol
   * names, the id is only what these two agents happen to call theirs.
   *
   * Both publish their options cheapest-first, which is the order
   * `rankedEfforts` wants, so the list is ranked as it arrives. That puts omp's
   * `auto` in the middle of its ladder, which is where a level that picks per
   * prompt honestly belongs.
   *
   * `currentValue` is the agent describing itself, and is the only thing this
   * adapter will emit an `effort` event on the strength of. The option's id is
   * kept for the setter, which wants it back as `configId`.
   */
  protected applyEffortOptions(options: unknown[]): void {
    for (const raw of options) {
      const option = record(raw);
      if (str(option.category) !== 'thought_level' && str(option.id) !== 'thinking') continue;
      const id = str(option.id);
      if (!id) continue;

      const levels: Array<{ value: string; name?: string; description?: string }> = [];
      for (const rawChoice of list(option.options)) {
        const choice = record(rawChoice);
        const value = str(choice.value);
        if (!value) continue;
        levels.push({ value, name: str(choice.name) || value, description: str(choice.description) });
      }
      if (levels.length) this.capabilities.efforts = rankedEfforts(levels);
      this.effortOptionId = id;
      this.effort = str(option.currentValue) ?? null;
    }
  }

  /**
   * Model windows, where the agent publishes them next to the model list.
   *
   * Grok does, in the `models` block of its `session/new` reply — every entry
   * carries `_meta.totalContextTokens`. That is the most authoritative source
   * there is for a window, because it is the agent describing the model it
   * will actually run: grok reports 512,000 for `grok-build` where the nearest
   * provider-catalogue entry says 256,000. Half.
   *
   * Parsed from a real capture (`.work/probes/raw/ctx-grok.jsonl`), not from a
   * schema anyone imagined. It reads nothing on the agents wired up here
   * today, which all publish their models through `configOptions` and none of
   * them a window — it starts answering the moment grok moves onto ACP (#73).
   *
   * The same `_meta` is also where grok keeps its thinking ladder, so this walk
   * collects that too rather than making a second pass over the same list. The
   * two facts arrive together because they are the same kind of fact: what this
   * particular model, as this particular agent will run it, can do.
   */
  protected readModelWindows(models: Record<string, unknown>): void {
    for (const raw of list(models.availableModels)) {
      const model = record(raw);
      const id = str(model.modelId);
      const meta = record(model._meta);
      const window = num(meta.totalContextTokens);
      if (id && window !== undefined && window > 0) this.modelWindows.set(id, window);
      if (id) this.readModelEffort(id, meta);
    }
    const current = str(models.currentModelId);
    if (current) this.model = current;
  }

  /**
   * One model's thinking ladder, as grok publishes it on the model itself.
   *
   * `grok agent --no-leader stdio` (0.2.x, probed live) publishes no
   * `thought_level` config option at all. What it publishes instead is, on each
   * entry of `models.availableModels`, a `_meta` carrying
   * `supportsReasoningEffort: true`, the level that model is currently on as
   * `reasoningEffort`, and the ladder as
   * `reasoningEfforts: [{id,value,label,description,default}]`.
   *
   * That list arrives **ceiling-first** — `high`, `medium`, `low` — and
   * `rankedEfforts` ranks a list cheapest-first, so it is reversed before
   * ranking. Ranked as published, grok's cheapest level would be painted as its
   * most expensive one, which is the one thing the rank exists to get right.
   * Copied before reversing because `reverse()` is in-place and the array
   * belongs to the parsed message, not to us.
   *
   * A model with no `supportsReasoningEffort` gets no entry, and that is not an
   * omission: grok's default model `grok-build` genuinely has no such knob, so a
   * session that opens on it publishes no ladder and the control says so.
   */
  protected readModelEffort(id: string, meta: Record<string, unknown>): void {
    if (meta.supportsReasoningEffort !== true) return;

    const levels: Array<{ value: string; name?: string; description?: string }> = [];
    for (const raw of list(meta.reasoningEfforts).slice().reverse()) {
      const level = record(raw);
      // `value` and `id` are the same string on every entry captured; reading
      // both means an entry that carries only one of them is still usable.
      const value = str(level.value) || str(level.id);
      if (!value) continue;
      levels.push({ value, name: str(level.label) || value, description: str(level.description) });
    }
    if (levels.length) this.modelEfforts.set(id, rankedEfforts(levels));
    const current = str(meta.reasoningEffort);
    if (current) this.modelEffortLevels.set(id, current);
  }

  /**
   * Publish the current model's ladder, for the agents that hang it there.
   *
   * Only the current model's, because only the current model's can be set:
   * grok's setter is `session/set_model`, which carries the level for the model
   * it names. Switching model therefore switches ladder, and switching to a
   * model that cannot think harder takes the ladder away entirely — which is
   * why this clears rather than leaves the previous model's levels standing.
   *
   * Returns whether the published ladder changed, so a mid-session model change
   * can tell the browser and a handshake — which is about to send the whole
   * capability set with the `session` event anyway — does not have to.
   */
  protected applyModelEffort(): boolean {
    // A config option wins where the agent published one: it is the protocol's
    // own place for this, and no captured agent publishes both.
    if (this.effortOptionId) return false;

    const previous = this.capabilities.efforts;
    const efforts = this.model ? this.modelEfforts.get(this.model) : undefined;
    if (efforts) {
      this.capabilities.efforts = efforts;
      this.effort = (this.model ? this.modelEffortLevels.get(this.model) : undefined) ?? null;
    } else {
      delete this.capabilities.efforts;
      this.effort = null;
    }
    return this.capabilities.efforts !== previous;
  }

  /**
   * Announce the level the agent said it is running at.
   *
   * Deduplicated against the last one announced, exactly as the context window
   * is and for the same reason: re-reading a config surface is not news, and
   * the transcript is a durable record of what changed rather than of what was
   * checked. The first call always announces, null included.
   */
  protected emitEffort(): void {
    if (this.effort === this.reportedEffort) return;
    this.reportedEffort = this.effort;
    this.emit({ t: 'effort', effort: this.effort });
  }

  /**
   * Tell the session the ladder itself changed under it.
   *
   * Sent as an empty list rather than left out when there is no ladder any
   * more: a `capabilities` event is merged field by field, so omitting the key
   * would leave the previous model's levels on offer for a model that will
   * refuse every one of them.
   */
  protected publishEfforts(): void {
    this.emit({ t: 'capabilities', capabilities: { efforts: this.capabilities.efforts || [] } });
  }

  /**
   * Tell the session how big the current model's window is, if the agent said.
   *
   * Sent as its own `usage` event because it arrives at handshake time, long
   * before any turn has spent anything — waiting to attach it to a turn's
   * figures would leave the first conversation without a reading at all.
   */
  protected emitContextWindow(): void {
    const window = this.model ? this.modelWindows.get(this.model) : undefined;
    if (window === undefined || window === this.reportedWindow) return;
    this.reportedWindow = window;
    // Named, because this arrives ahead of anything that says which model is
    // running now: a switch is confirmed on its own channel and the next
    // message to carry a model belongs to the turn after it. Unnamed, the
    // session files grok-4.5's 500,000 against grok-build and then retracts it.
    this.emit({
      t: 'usage',
      usage: { contextWindow: window, contextWindowSource: 'agent', contextWindowModel: this.model },
    });
  }

  /**
   * Tell the session how much of that window is occupied right now.
   *
   * ACP's own channel for this is `usage_update.used`, which omp and opencode
   * send and grok does not send once — so a grok conversation had a 512,000
   * ceiling, no reading against it, and no 80% warning it could ever reach.
   *
   * What grok sends instead is `totalTokens` in the `_meta` of every
   * `session/update`, and it is the right figure rather than a near one: across
   * the captured turn it moves 1038 → 8363 → 16,381 → 16,641 → 16,812 while
   * that turn's four requests *totalled* 65,943 tokens. It is the last
   * request's own occupancy, which is the definition this product measures
   * against; filing the turn's total here would have drawn a bar four times too
   * full and been worse than the blank it replaced.
   *
   * Deduplicated like the window above, because grok repeats the same figure on
   * every chunk of a streamed answer and a durable log should record what
   * changed rather than how often it was mentioned.
   */
  protected emitContextUsed(used: number | undefined): void {
    if (used === undefined || used === this.reportedUsed) return;
    this.reportedUsed = used;
    this.emit({ t: 'usage', usage: { contextUsed: used } });
  }

  /**
   * Grok's model state: `{ currentModelId, availableModels: [{ modelId, ... }] }`.
   *
   * Captured from `session/new` and `session/load`; the same object also arrives
   * unprompted on `_x.ai/models/update`, which this client ignores because a
   * model list is not worth an extension-specific code path when the handshake
   * already carries it.
   */
  protected applyModelState(state: Record<string, unknown>): void {
    const models: ModelChoice[] = [];
    for (const raw of list(state.availableModels)) {
      const choice = record(raw);
      const value = str(choice.modelId);
      if (!value) continue;
      models.push({ value, name: str(choice.name) || value, description: str(choice.description) });
    }
    if (models.length) this.capabilities.models = models;
    const current = str(state.currentModelId);
    if (current) this.model = current;
  }
}
