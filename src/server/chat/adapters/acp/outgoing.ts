import { UserTurn, isAllowOption } from '../../../../shared/chat-events.js';
import { ACP_PROTOCOL_VERSION, list, record } from './convert.js';
import { AcpChatAdapterMessages } from './messages.js';

/**
 * The handshake and the outgoing requests of the ACP adapter.
 *
 * `handshake` runs the initialize/authenticate/session dance and applies the
 * remembered model and effort; `send`, the setters, `interrupt` and
 * `respondPermission` are the adapter's outward-facing request half. A partial
 * class so the incoming partial and the final concrete class can call into it.
 */
export abstract class AcpChatAdapterOutgoing extends AcpChatAdapterMessages {
  // ---------------------------------------------------------------- handshake

  protected async handshake(): Promise<void> {
    try {
      const init = record(
        await this.call('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            // Advertised from what the caller actually gave us. Claiming a
            // filesystem we cannot serve buys an agent that reads empty files.
            fs: {
              readTextFile: Boolean(this.options.readFile),
              writeTextFile: Boolean(this.options.writeFile),
            },
            terminal: false,
          },
        }),
      );
      this.applyInitialize(init);
      await this.authenticateWithExistingCredentials(init);

      const session = await this.openSession(init);
      this.applySessionConfig(record(session));
      // Before the `session` event rather than after it, which is where the
      // remembered effort goes: this event is what names the model the
      // conversation is running on, and naming the one we are one round trip
      // away from replacing would be a false start every relaunch. It also puts
      // the switch ahead of the effort ladder, which on kimi and grok alike
      // belongs to the model rather than to the session.
      await this.applyLaunchModel();

      this.emit({
        t: 'session',
        nativeSessionId: this.nativeSessionId || undefined,
        model: this.model,
        cwd: this.runtimeWorkingDir,
        capabilities: this.capabilities,
      });
      // What the agent itself said it is thinking at, before this app has asked
      // it for anything. Emitted even when the answer is null, because null is
      // the true answer for an agent with no ladder and the chip has to be told
      // to stay empty rather than keep whatever the last runtime left on it.
      this.emitEffort();
      // Awaited, unlike the codex adapter's `loadModelList`: a level applied
      // after the session reports idle is a level the conversation's first turn
      // did not run at. It costs one round trip, and it cannot fail the
      // handshake — `applyLaunchEffort` swallows the rejection into an error
      // event and lets the conversation open at whatever level the agent is
      // already on.
      await this.applyLaunchEffort();
      this.emit({ t: 'state', state: 'idle' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ t: 'error', message: `${this.runtime} handshake failed: ${message}`, fatal: true });
      this.emit({ t: 'state', state: 'error' });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  // ------------------------------------------------------------- outgoing

  async send(turn: UserTurn): Promise<void> {
    if (!this.nativeSessionId) {
      this.emit({ t: 'error', message: `${this.runtime}: no ACP session, so the turn was not sent` });
      return;
    }
    if (this.promptRpcTurnId) {
      throw new Error(`${this.runtime}: the previous ACP prompt is still in flight`);
    }

    const turnId = `${this.runtime}-turn-${++this.counter}`;
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    this.refusedThisTurn.clear();
    // Not the user's message: `ChatSession.deliver` has already written it, and
    // a second copy here is a second bubble in the same turn (#129). The close
    // stays, and is the only thing this call was still doing that mattered — it
    // ends an assistant message left streaming by the previous turn.
    this.closeMessage();

    const prompt: unknown[] = [{ type: 'text', text: turn.text }];
    for (const attachment of turn.attachments || []) {
      // A resource_link, not embedded bytes: the file is already on the same
      // disk the agent runs on, and re-encoding it through this process would
      // put megabytes of base64 through a pipe carrying a live transcript.
      if (attachment.path) {
        prompt.push({
          type: 'resource_link',
          uri: `file://${attachment.path}`,
          name: attachment.name,
          mimeType: attachment.mime,
        });
      }
    }

    this.emit({ t: 'state', state: 'thinking' });
    return new Promise<void>((resolve, reject) => {
      this.promptAcceptance = { turnId, resolve, reject };
      this.promptRpcTurnId = turnId;
      this.promptEcho = { turnId, expected: turn.text, received: '', valid: true };
      void this.call('session/prompt', { sessionId: this.nativeSessionId, prompt })
        .then((result) => {
          // A silent turn may produce no update at all. Its successful response
          // is both the first proof of acceptance and the end of the turn.
          this.acceptPrompt(turnId);
          this.finishTurn(turnId, result);
          this.finishPromptRpc(turnId);
        })
        .catch((error: unknown) => {
          // Before any turn activity, an RPC error means the prompt was never
          // accepted and `send()` must reject. After activity it is a failed
          // accepted turn, which `failTurn` records without changing the
          // already-settled acceptance promise.
          const rejectedBeforeAcceptance = this.rejectPrompt(turnId, error);
          if (rejectedBeforeAcceptance) {
            // Let every promise continuation waiting on send() put the refused
            // turn back at the head of its queue before turn_end makes the
            // session idle and drains that queue. The readiness sentinel stays
            // held through that deferred terminalization, so a synchronous
            // retry cannot start a successor prompt first.
            setImmediate(() => {
              this.failTurn(turnId, error);
              this.finishPromptRpc(turnId);
            });
          } else {
            this.failTurn(turnId, error);
            this.finishPromptRpc(turnId);
          }
        });
    });
  }

  get readyForTurn(): boolean {
    // `session/cancel` has no acknowledgement of its own. Keep the next turn
    // parked until the old prompt RPC settles, or its late completion can
    // close the new turn's adapter-global message and emit the wrong turn_end.
    return this.promptRpcTurnId === null;
  }

  cancelPendingSendAcceptance(reason: string): void {
    const pending = this.promptAcceptance;
    if (!pending) return;
    this.promptAcceptance = null;
    pending.reject(new Error(reason));
  }

  /**
   * Switch the model this session runs on, where the agent accepts it.
   *
   * `session/set_model` is the ACP method for this, and grok answers it —
   * probed against 0.2.112, which replied `{"model":{"Ok":"grok-4.5"}}` and
   * followed with a `models/update` naming the new one. An agent that does not
   * implement it answers `-32601` and this rejects, which is what the caller
   * already treats as "could not switch live": it falls back to the runtime's
   * own `/model` command, or to remembering the choice for the next launch.
   *
   * That fallback is why this is worth having rather than dangerous. Grok's
   * headless mode could rewrite `--model` for the next turn, and moving it onto
   * ACP would otherwise have taken a working model switch away — quietly, since
   * the picker would have gone on offering the list grok publishes.
   */
  async setModel(model: string): Promise<void> {
    if (!this.nativeSessionId) {
      throw new Error(`${this.runtime}: no session to set a model on`);
    }
    // Down the config-option road where the agent published one, because that is
    // the only road that brings the rest of the session's configuration back.
    //
    // Probed against kimi this session, switching from `kimi-k2.7-code` to
    // `~openai/gpt-mini-latest`. `session/set_model` succeeds and answers `{}` —
    // nothing about the new model at all. `session/set_config_option` with the
    // *model* option answers with the whole `configOptions` list rebuilt, and
    // the thinking ladder in it has genuinely changed: `off`/`on` before,
    // `off`/`low`/`medium`/`high`/`xhigh` after, with `currentValue` moved from
    // `on` to `high`.
    //
    // That difference is not cosmetic. Taking the `set_model` road left the chip
    // offering `on` — which the new model refuses by name — and hiding the three
    // levels it had just gained, until the conversation was relaunched.
    if (this.modelOptionId) {
      const reply = record(
        await this.call('session/set_config_option', {
          sessionId: this.nativeSessionId,
          configId: this.modelOptionId,
          value: model,
        }),
      );
      this.model = model;
      this.applySessionConfig(reply);
      this.publishEfforts();
      this.emitEffort();
      return;
    }

    await this.call('session/set_model', { sessionId: this.nativeSessionId, modelId: model });
    this.model = model;
    // The ladder belongs to the model on grok, so a model switch can hand the
    // session a different set of levels or none at all. Grok also confirms the
    // switch with a notification that says the same thing, and the second pass
    // through here is a no-op — both `applyModelEffort` and `emitEffort` only
    // speak when something actually moved.
    if (this.applyModelEffort()) this.publishEfforts();
    this.emitEffort();
    // So does the window: grok publishes one per model, and `grok-4.5` is
    // 500,000 where `grok-build` is 512,000. The config-option road gets this
    // for free because it re-reads the whole session; this road has to say it,
    // or the meter goes on measuring against the model that was left behind.
    this.emitContextWindow();
  }

  /**
   * Change how hard this agent thinks, down whichever road it published.
   *
   * Two roads, because the agents this adapter serves genuinely have two, and
   * both were probed live against the installed CLIs this session.
   *
   * kimi and omp put the level in a `thought_level` config option, and the
   * setter is `session/set_config_option` with `{ sessionId, configId, value }`.
   * It is `configId` and not `optionId`: the wrong spelling came back from kimi
   * as `-32602 Invalid params` with
   * `{"configId":{"_errors":["Invalid input: expected string, received undefined"]}}`,
   * which is about as unambiguous as a protocol gets. Every other name for the
   * method itself — `session/set_config`, `session/select_config_option`,
   * `session/set_option`, `session/setConfigOption` — answered `-32601`.
   * The reply is the whole `configOptions` list again with `currentValue`
   * already moved, so it is fed back through the same parser the handshake uses
   * rather than assuming we got the level we asked for; kimi's ladder depends on
   * the model, so a menu that changed shape is picked up in the same pass.
   *
   * grok has no such option and no `session/set_reasoning_effort` either
   * (`-32601`), and ignores `--reasoning-effort` on the `agent stdio` path —
   * launching with `low`, `medium`, `high` and a bogus value all left the level
   * it reported at `high`, because that flag belongs to headless mode. What does
   * move it is `session/set_model` carrying `_meta.reasoningEffort`, and only
   * that: `reasoningEffort` at the top level, `effort`, `reasoningEffortId` and
   * a `modelId` of `grok-4.5:low` all either errored or left the level where it
   * was.
   *
   * A rejection is left to propagate. The caller reports a failed change as
   * pending-with-reason and shows the message, and these agents write a good
   * one — kimi refuses with `Unknown thinking effort for model
   * "openrouter/moonshotai/kimi-k2.7-code": bogus_xyz` and omp with `Unknown ACP
   * thinking level: bogus_xyz`, each naming the level it would not take.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.nativeSessionId) {
      throw new Error(`${this.runtime}: no session to set a reasoning effort on`);
    }

    if (this.effortOptionId) {
      const updated = record(
        await this.call('session/set_config_option', {
          sessionId: this.nativeSessionId,
          configId: this.effortOptionId,
          value: effort,
        }),
      );
      this.applyEffortOptions(list(updated.configOptions));
      // Published unconditionally rather than on a comparison: the reply is a
      // freshly built list every time, and one capability event per level the
      // user chose is a great deal cheaper than a menu that quietly went stale.
      this.publishEfforts();
      this.emitEffort();
      return;
    }

    if (this.model && this.modelEfforts.has(this.model)) {
      // Resolving here means grok accepted the call — its reply is only
      // `{"_meta":{"model":{"Ok":"grok-4.5"}}}`. What actually moves the chip is
      // the `_x.ai/session_notification` that follows, carrying
      // `reasoning_effort`, and `handleModelChanged` emits the event off that.
      // Resolving on the acceptance is still honest: grok validates the level on
      // this call, so a level it will not run rejects here rather than being
      // silently dropped on the floor.
      await this.call('session/set_model', {
        sessionId: this.nativeSessionId,
        modelId: this.model,
        _meta: { reasoningEffort: effort },
      });
      return;
    }

    throw new Error(
      `${this.runtime} published no reasoning-effort levels${
        this.model ? ` for ${this.model}` : ''
      }, so its thinking cannot be changed from here`,
    );
  }

  /**
   * Put a launched-with model into effect, once there is a session to set it on.
   *
   * ACP has no launch flag for this either. `session/new` takes a cwd and a
   * list of MCP servers and nothing else, and the `--model` flag the bridges
   * pass belongs to these CLIs' interactive modes — nobody has watched
   * `grok agent stdio` or `kimi acp` read one, and a flag an agent refuses at
   * spawn takes the whole conversation down, which is precisely what a
   * remembered preference must never do. So the choice is applied immediately
   * afterwards, down exactly the road `setModel` takes.
   *
   * Without this the choice survived right up to the next process start and
   * then silently did not. `/clear` restarts the process in place and replays
   * the options the session was started with; so does relaunching after the
   * server restarted, or from the unavailable banner. Every turn after one of
   * those was answered and billed on the profile's model while the composer
   * went on asserting the chosen one, because the chip renders the override
   * ahead of the reported model and the per-turn "also ran" hint that would
   * have exposed it is suppressed while an override exists.
   *
   * Best-effort in the same sense as the level below: a model this agent will
   * not take must not stop the conversation opening, and it is a live
   * possibility — a model remembered from another runtime's picker is a name
   * this one has never heard of. The failure is worth a line in the transcript
   * because it is the one thing the picker cannot show by itself.
   */
  protected async applyLaunchModel(): Promise<void> {
    const wanted = this.options.model;
    if (!wanted || wanted === this.model) return;
    try {
      await this.setModel(wanted);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        t: 'error',
        message: `${this.runtime}: could not start on model "${wanted}": ${message}`,
      });
    }
  }

  /**
   * Put a launched-with level into effect, once there is a session to put it on.
   *
   * ACP has no launch flag for this. `session/new` takes a cwd and a list of MCP
   * servers and nothing else, and the level lives in a config option — or, on
   * grok, on a model — that does not exist until the session does. So a
   * remembered choice is applied immediately afterwards, down exactly the road
   * `setEffort` takes, and the agent confirms it exactly as it would confirm a
   * change made mid-conversation.
   *
   * Best-effort in the sense the codex adapter's `loadModelList` is: a level
   * this agent will not take must not stop the conversation opening. It is a
   * live possibility rather than a theoretical one, because kimi's ladder
   * depends on the model — a level remembered under one model is refused under
   * another. Unlike a missing model list this is worth a line in the transcript,
   * since the user asked for this level and would otherwise watch the chip
   * silently disagree with the picker.
   */
  protected async applyLaunchEffort(): Promise<void> {
    const wanted = this.options.effort;
    if (!wanted || wanted === this.effort) return;
    try {
      await this.setEffort(wanted);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        t: 'error',
        message: `${this.runtime}: could not start at reasoning effort "${wanted}": ${message}`,
      });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.nativeSessionId) return;
    // A notification, not a call: the acknowledgement is the pending
    // `session/prompt` resolving with a cancelled stop reason, which the normal
    // turn-completion path already handles.
    this.notify('session/cancel', { sessionId: this.nativeSessionId });
  }

  respondPermission(requestId: string, optionId: string): void {
    const id = this.permissionWaiters.get(requestId);
    if (id === undefined) return;
    const options = this.permissionOptions.get(requestId) || [];
    this.permissionWaiters.delete(requestId);
    this.permissionOptions.delete(requestId);

    const chosen = options.find((option) => option.optionId === optionId);
    if (!chosen) {
      // An id the agent never offered cannot be selected, but the request still
      // has to be answered or the turn hangs on it forever.
      this.respond(id, { outcome: { outcome: 'cancelled' } });
      this.emit({ t: 'permission_resolved', requestId, optionId, allowed: false });
      return;
    }

    this.respond(id, { outcome: { outcome: 'selected', optionId } });
    this.emit({ t: 'permission_resolved', requestId, optionId, allowed: isAllowOption(chosen) });
  }
}
