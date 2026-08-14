/*
 * ChatSessionLifecycle: launch, restart-for-update, in-place restart, stop, interrupt, opening-context retrieval.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionBase } from './session-base.js';
import * as fs from 'fs';
import * as path from 'path';
import { ASK_QUESTION_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, TIER_TOOL_NAME, ASK_MCP_SERVER } from '../../../shared/chat-events.js';
import { mergeSlashCommands } from '../../../shared/slash-commands.js';
import { installedModels } from '../installed-models.js';
import { discoverInstalledCommands } from '../installed-commands.js';
import { ChatAdapterOptions } from '../adapter.js';
import { QuestionAsk, PlanAsk, TierAsk, PermissionBroker, permissionHookSettings } from '../permission-broker.js';
import { QUESTION_TOOL_ENABLED_ENV, ASK_SOCKET_ENV, TIER_ENABLED_ENV, askMcpConfig } from '../ask-mcp.js';
import { writePiAskExtension } from '../pi-ask-extension.js';
import { FileCallbackEndpoint, FileCallbackBroker } from '../file-callback.js';
import { writeFileMcpBridge, FILE_CALLBACK_DIR_ENV, FILE_CALLBACK_TOKEN_ENV, fileMcpConfig } from '../file-mcp-bridge.js';
import { electronAsNodeEnv } from '../node-as-node.js';
import { supportsChat, askChannelFor, questionDeliveryFor, askEnvFor, createChatAdapter } from '../registry.js';
import { UsageAccountant } from '../usage-accounting.js';
import { AgentUpdateRestartResult, ChatSessionStartOptions } from './session-types.js';
import { approvalNoticeDetail } from './session-errors.js';
import { INTERRUPT_ACK_WINDOW_MS } from './session-constants.js';
export abstract class ChatSessionLifecycle extends ChatSessionBase {
  async restartForAgentUpdate(input: {
    automatic: boolean;
    allowFreshContext: boolean;
    command?: string;
  }): Promise<AgentUpdateRestartResult> {
    if (!this.live || !this.lastStartOptions) return { ok: false, reason: 'not_running' };
    if (this.restarting) return { ok: false, reason: 'busy' };
    if (input.automatic && !this.safeForAutomaticAgentRestart) {
      return { ok: false, reason: 'busy' };
    }

    const resumeSessionId = this.resumableForAgentRestart
      ? this.nativeSessionId || undefined
      : undefined;
    if (!resumeSessionId && !input.allowFreshContext) {
      return { ok: false, reason: 'cannot_resume' };
    }

    const options = this.lastStartOptions;
    this.restarting = true;
    this.adapterGeneration++;
    let oldRuntimeStopped = false;
    try {
      await this.stop({ preserveHandoffs: Boolean(resumeSessionId) });
      oldRuntimeStopped = true;
      await this.start({
        ...options,
        command: input.command || options.command,
        resumeSessionId,
        // Starting without native context must not truncate the app transcript.
        startFresh: false,
      });
    } catch (error) {
      if (oldRuntimeStopped) {
        this.deps.onLifecycle?.(this.ref.id, { exited: true, restarting: false });
      }
      throw error;
    } finally {
      this.restarting = false;
    }

    this.deps.onLifecycle?.(this.ref.id, { exited: false, bypassing: this.bypass });
    return { ok: true, resumed: Boolean(resumeSessionId) };
  }


  async start(options: ChatSessionStartOptions): Promise<void> {
    if (this.adapter) {
      throw new Error(`chat session ${this.ref.id} is already running`);
    }
    if (!supportsChat(options.runtime)) {
      throw new Error(`${options.runtime} has no chat adapter`);
    }

    this.lastStartOptions = options.startFresh ? { ...options, planMode: false } : options;
    this.runtime = options.runtime;
    this.cwd = options.workingDir;
    this.bypass = Boolean(options.bypassPermissions);
    this.planMode = options.startFresh ? false : options.planMode === true;
    this.planEnabled = true;
    this.questionToolEnabled = false;
    this.questionFallbackEnabled = false;
    this.acceptingQuestionTransitions = true;
    this.questionStopIntent = null;
    this.planDocumentCache = undefined;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';
    this.planSubmittedThisTurn = false;
    if (options.startFresh) {
      // Close the old generation before waiting for its last save. A callback
      // that resumes after this point sees the mismatch and cannot recreate a
      // document belonging to the conversation being cleared.
      this.planGeneration += 1;
      await this.planMutation.catch(() => undefined);
      this.turnInFlightId = null;
      this.ownUserMessageId = null;
      this.droppedUserEchoes.clear();
    }
    this.startedAt = Date.now();
    this.replaying = Boolean(options.resumeSessionId);
    if (options.resumeSessionId) this.nativeSessionId = options.resumeSessionId;
    // Restarting into an existing conversation: seq continues from the log so
    // a resumed session does not renumber events a browser already holds.
    const stats = await this.deps.store.stat(this.ref);
    if (options.startFresh && stats.cursor === 0) {
      // There is no truncation boundary for an empty log, but a sidecar can
      // still exist (for example after a crash between its write and the next
      // transcript event). Fresh always means both mode and document are gone.
      await this.deps.store.clearPlanDocument?.(this.ref);
      this.planDocumentCache = null;
    }
    this.seq = Math.max(this.seq, stats.cursor);
    // A ceiling can only be taken down if something knows one is up, and this
    // object learns that by watching events go past — which a process that has
    // just started has not done. The browser, meanwhile, folds the whole log
    // and is showing whatever it says. So a conversation with a log behind it
    // is assumed to be stating something: at worst the retraction is a log
    // entry that changes nothing on screen, where the other way round is issue
    // #82 surviving every server restart.
    this.contextWindowStated = stats.cursor > 0;

    // Anything still open belongs to the process that just went away, not to
    // the one about to start, and a relaunch is exactly where an interrupted
    // job would otherwise be lost.
    this.accountant?.flush();
    this.accountant = this.deps.usage
      ? new UsageAccountant(
          (job) => this.fileJob(job),
          // Only when resuming, and it is what this conversation has already
          // been recorded as using — the evidence the accountant needs to tell
          // a counter that carried its history from one that restarted.
          options.resumeSessionId
            ? this.deps.usage.consumedFor(options.resumeSessionId)
            : undefined,
        )
      : null;

    const env = { ...(options.env || {}) };
    const extraArgs = [...(options.extraArgs || [])];

    // Claude reaches the browser over a unix socket for two different reasons:
    // a PreToolUse hook asking whether a tool may run, and an MCP server asking
    // the user a question. Both dial the same socket, so it is opened whenever
    // either of them will be installed.
    //
    // The hook is skipped when bypassing — there is nothing to approve — but the
    // question channel is not. Bypassing approvals means "stop asking me before
    // you act"; it has never meant "answer my questions on my behalf", and a
    // model that asks which of three approaches to take still needs a person.
    const wantsHook = !this.bypass && options.runtime === 'claude' && fs.existsSync(this.deps.hookScript);
    const askScript = this.deps.askScript;
    const askChannel = askChannelFor(options.runtime);
    const questionToolRequested = questionDeliveryFor(options.runtime) === 'blocking_tool';
    // The MCP server has to exist on disk before it can be handed to anybody.
    // pi's channel is exempt because there is nothing to hand over: its tool is
    // a generated extension that carries its own client to the socket.
    const wantsCcwebTools = askChannel === 'extension'
      ? true
      : Boolean(askChannel) && Boolean(askScript) && fs.existsSync(askScript!);
    let askMcpServer: ChatAdapterOptions['askMcpServer'];
    let ccwebToolsWired = false;

    // The rung, recorded before anything can be escalated from it. Held on the
    // session rather than read from the profile on demand, because the profile
    // is server-wide configuration that can change under a running conversation
    // and this is a fact about the process that is about to start.
    this.ladder = options.ladder ?? null;
    this.escalation = null;
    // pi is the runtime with a ladder and no MCP support at all, so its
    // escalation tool arrives as a generated extension instead (see the tier
    // writer). It still dials this socket, so the socket still has to be open.
    const wantsTierExtension = Boolean(this.ladder) && options.runtime === 'pi';

    const environment = options.environment;
    const asSeenByRuntime = (hostPath: string): string => (
      environment ? environment.toContainerPath(hostPath) : hostPath
    );
    const nodePath = environment ? environment.nodePath : process.execPath;
    const useFileTools = wantsCcwebTools && environment?.kind === 'container';
    let fileEndpoint: FileCallbackEndpoint | null = null;
    let fileBridge = '';

    if (useFileTools) {
      try {
        this.fileBroker = new FileCallbackBroker(environment.homeDir);
        fileEndpoint = await this.fileBroker.listen(async (request, signal) => {
          if (request.kind === 'question') {
            return this.askQuestion((request.payload || {}) as QuestionAsk, signal);
          }
          if (request.kind === 'plan') {
            const plan = (request.payload || {}) as PlanAsk;
            return this.submitPlan({ markdown: plan.markdown, source: 'tool' });
          }
          if (request.kind === 'tier') {
            return this.requestTier((request.payload || {}) as TierAsk);
          }
          throw new Error(`unsupported callback kind ${request.kind}`);
        });
        fileBridge = await writeFileMcpBridge(fileEndpoint.directory);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not create the shared-home tool channel: ${detail}`);
        await this.fileBroker?.close().catch(() => undefined);
        this.fileBroker = null;
        fileEndpoint = null;
        fileBridge = '';
      }
    }

    const wantsSocketTools = !useFileTools && (wantsCcwebTools || wantsTierExtension);
    let runtimeSocketPath = '';
    if (wantsHook || wantsSocketTools) {
      // One shared directory, not one per session. A directory named after the
      // session id cost 37 bytes of a 103-byte path budget, which is what put
      // the socket over the kernel's limit; the random socket filename already
      // carries the unguessability that directory was standing in for.
      this.broker = new PermissionBroker(this.deps.socketDir);
      const socketPath = await this.broker.listen({
        permission: (ask) => this.askUser(ask),
        question: (ask, signal) => this.askQuestion(ask, signal),
        tier: (ask) => this.requestTier(ask),
        plan: (ask: PlanAsk) => this.submitPlan({ markdown: ask.markdown, source: 'tool' }),
      });
      runtimeSocketPath = asSeenByRuntime(socketPath);
    }

    if (wantsHook && runtimeSocketPath) {
      extraArgs.push('--settings', permissionHookSettings(
        asSeenByRuntime(this.deps.hookScript),
        runtimeSocketPath,
        nodePath,
      ));
      env.CCWEB_PERMISSION_SOCKET = runtimeSocketPath;
    }

    const laddered = Boolean(this.ladder);
    env[QUESTION_TOOL_ENABLED_ENV] = questionToolRequested ? '1' : '0';
    const runtimeFileDirectory = fileEndpoint ? asSeenByRuntime(fileEndpoint.directory) : '';
    const runtimeFileBridge = fileBridge ? asSeenByRuntime(fileBridge) : '';
    if (fileEndpoint) {
      env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
      env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
    }
    if (wantsTierExtension) {
      if (fileEndpoint) {
        env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
        env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
      } else if (runtimeSocketPath) {
        env[ASK_SOCKET_ENV] = runtimeSocketPath;
      }
      env[TIER_ENABLED_ENV] = '1';
    }

    if (wantsCcwebTools) Object.assign(env, askEnvFor(options.runtime));
    if (wantsCcwebTools && askChannel === 'cli' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const config = fileEndpoint
        ? fileMcpConfig(runtimeFileBridge, runtimeFileDirectory, fileEndpoint.token, nodePath, laddered)
        : askMcpConfig(
            asSeenByRuntime(askScript!),
            runtimeSocketPath,
            nodePath,
            laddered,
            questionToolRequested,
          );
      extraArgs.push('--mcp-config', config);
      if (questionToolRequested) extraArgs.push('--allowedTools', ASK_QUESTION_TOOL_NAME);
      extraArgs.push('--allowedTools', SUBMIT_PLAN_TOOL_NAME);
      if (laddered) extraArgs.push('--allowedTools', TIER_TOOL_NAME);
      ccwebToolsWired = true;
    }
    if (wantsCcwebTools && askChannel === 'config' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const script = fileEndpoint ? runtimeFileBridge : asSeenByRuntime(askScript!);
      if (!fileEndpoint) env[ASK_SOCKET_ENV] = runtimeSocketPath;
      if (laddered) env[TIER_ENABLED_ENV] = '1';
      const forwardedMcpEnv = [
        ...(fileEndpoint ? [FILE_CALLBACK_DIR_ENV, FILE_CALLBACK_TOKEN_ENV] : [ASK_SOCKET_ENV]),
        QUESTION_TOOL_ENABLED_ENV,
        ...(laddered ? [TIER_ENABLED_ENV] : []),
      ];
      // Codex app-server accepts the same dotted TOML overrides as `codex -c`.
      // It deliberately gives MCP children only variables named in `env_vars`,
      // rather than inheriting the app-server environment. Pass the names, not
      // their values: the file callback token must never appear in process argv.
      // These overrides live on this one process and never touch ~/.codex/config.toml.
      extraArgs.push(
        '-c',
        `mcp_servers.${ASK_MCP_SERVER}.command=${JSON.stringify(nodePath)}`,
        '-c',
        `mcp_servers.${ASK_MCP_SERVER}.args=${JSON.stringify([script])}`,
        '-c',
        `mcp_servers.${ASK_MCP_SERVER}.env_vars=${JSON.stringify(forwardedMcpEnv)}`,
      );
      ccwebToolsWired = true;
    }
    if (wantsCcwebTools && askChannel === 'extension' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      const extensionRoot = fileEndpoint ? fileEndpoint.directory : options.workingDir;
      const written = writePiAskExtension(extensionRoot);
      if (written) {
        const extensionPath = fileEndpoint
          ? asSeenByRuntime(path.join(extensionRoot, written))
          : written;
        if (fileEndpoint) {
          env[FILE_CALLBACK_DIR_ENV] = runtimeFileDirectory;
          env[FILE_CALLBACK_TOKEN_ENV] = fileEndpoint.token;
        } else {
          env[ASK_SOCKET_ENV] = runtimeSocketPath;
        }
        extraArgs.push('-e', extensionPath);
        extraArgs.push('--exclude-tools', 'question');
        ccwebToolsWired = true;
      }
    }
    if (wantsCcwebTools && askChannel === 'protocol' && (fileEndpoint || (!useFileTools && runtimeSocketPath))) {
      askMcpServer = fileEndpoint
        ? {
            name: ASK_MCP_SERVER,
            command: nodePath,
            args: [runtimeFileBridge],
            env: {
              [FILE_CALLBACK_DIR_ENV]: runtimeFileDirectory,
              [FILE_CALLBACK_TOKEN_ENV]: fileEndpoint.token,
              [QUESTION_TOOL_ENABLED_ENV]: questionToolRequested ? '1' : '0',
              ...(laddered ? { [TIER_ENABLED_ENV]: '1' } : {}),
              ...electronAsNodeEnv(nodePath),
            },
          }
        : {
            name: ASK_MCP_SERVER,
            command: nodePath,
            args: [asSeenByRuntime(askScript!)],
            env: {
              [ASK_SOCKET_ENV]: runtimeSocketPath,
              [QUESTION_TOOL_ENABLED_ENV]: questionToolRequested ? '1' : '0',
              ...(laddered ? { [TIER_ENABLED_ENV]: '1' } : {}),
              ...electronAsNodeEnv(nodePath),
            },
          };
      ccwebToolsWired = true;
    }
    // Tool availability and question availability are deliberately separate:
    // timed runtimes keep submit_plan/tier over the ccweb server but never see
    // the blocking ask tool. Their model turn ends in a durable handoff instead.
    this.questionToolEnabled = questionToolRequested && ccwebToolsWired;
    this.questionFallbackEnabled = !this.questionToolEnabled;

    // What this session could run, read off disk before the runtime is even
    // spawned, so the command menu has something true in it from the moment the
    // conversation opens rather than after a first message has been sent.
    //
    // The home directory comes from the session's own environment where it has
    // one. That is the whole of the isolation this needs: a session lists what
    // is installed for the person it belongs to, and never what is installed
    // for anybody else on the machine.
    // In a container that home is the user's own: `homeDir` is the host path
    // their container's home is a bind mount of, which is precisely what the
    // ordinary `fs` reads in there can see. On the host it stays the account the
    // runtime actually runs as, because a host environment's `homeDir` is the
    // projects base folder and no runtime keeps its skills under that.
    const installed = discoverInstalledCommands(options.runtime, {
      home: options.environment?.kind === 'container'
        ? options.environment.homeDir
        : env.HOME || process.env.HOME,
      // A container-only path may coincidentally exist on the server (notably
      // `/tmp`) but is a different namespace. Never scan that host directory
      // for commands belonging to this project.
      workingDir: options.cwdKind === 'container'
        ? options.environment?.homeDir || ''
        : options.workingDir,
    });
    const installedCommands = installed.commands;

    // Claimed before the adapter exists, so its `emit` closure below can be
    // told apart from the one belonging to a process this replaces.
    const generation = ++this.adapterGeneration;

    const adapter = createChatAdapter(options.runtime, {
      sessionId: this.ref.id,
      workingDir: options.workingDir,
      cwdKind: options.cwdKind,
      installedCommands,
      // Kept out of `commands`: absolute paths are launch metadata for Codex,
      // not capabilities a browser or transcript should ever receive.
      installedSkills: installed.skills,
      command: options.command || this.deps.resolveCommand(options.runtime),
      commandName: this.deps.resolveCommandName?.(options.runtime),
      environment: options.environment,
      model: options.model,
      effort: options.effort,
      extraArgs,
      env,
      bypassPermissions: this.bypass,
      resumeSessionId: options.resumeSessionId,
      // Only when resuming: a conversation the runtime is starting fresh has a
      // counter that starts at zero, and handing it a baseline would suppress
      // the whole first turn's cost.
      costBaselineUsd: options.resumeSessionId
        ? this.deps.usage?.costBaselineFor(options.resumeSessionId)
        : undefined,
      askMcpServer,
      // A dying predecessor is not a witness to the conversation that replaced
      // it. See `adapterGeneration`: everything it still has to say — its own
      // exit above all — is about a process nobody is talking to any more.
      emit: (event) => {
        if (generation !== this.adapterGeneration) return;
        if (this.isInterruptedRunReport(event)) return;
        this.ingest(event);
      },
      readFile: this.deps.readFile
        ? (filePath) => this.deps.readFile!(this.ref.id, filePath)
        : undefined,
      writeFile: this.deps.writeFile
        ? (filePath, contents) => this.deps.writeFile!(this.ref.id, filePath, contents)
        : undefined,
      codexPricing: this.deps.codexPricing,
    });

    if (!adapter) {
      throw new Error(`${options.runtime} has no chat adapter`);
    }

    this.adapter = adapter;

    // Every runtime that has not already accounted for what is installed gets
    // it here — codex and pi never report a command list at all, so without
    // this their menu stays empty for the whole session. Kept on the session as
    // well, because a runtime reporting its own list later must not be able to
    // drop what is installed on disk; see the merge in `ingest`.
    this.installedCommands = installedCommands;
    if (installedCommands.length > 0) {
      adapter.capabilities.commands = mergeSlashCommands(
        adapter.capabilities.commands,
        installedCommands,
      );
    }

    // And the same for the model picker's menu, for the runtimes that publish
    // one only through a command of their own. Not awaited: this spawns a
    // process, the session has nothing to do with its answer, and a menu is
    // not worth delaying a conversation for. It arrives as a `capabilities`
    // event whenever it arrives, which is what that event is for.
    //
    // It never overwrites a list a runtime published itself. Only grok and pi
    // are probed at all — everybody else either says so over their protocol or
    // has no list to give — but the check makes the precedence explicit rather
    // than incidental: what the runtime says always wins.
    void installedModels(
      options.runtime,
      options.command || this.deps.resolveCommand(options.runtime),
      env,
    )
      .then((models) => {
        if (models.length === 0) return;
        if (this.adapter !== adapter) return; // restarted since; that session owns its own menu
        if (adapter.capabilities.models?.length) return;
        adapter.capabilities.models = models;
        this.ingest({ t: 'capabilities', capabilities: { models } });
      })
      .catch(() => {
        // installedModels does not reject; this is belt and braces so a chat
        // session can never be taken down by its own picker.
      });

    // Before the first event of the new conversation, so the line lands above
    // it rather than in the middle of it. Only when there is something to draw
    // a line under.
    if (options.startFresh && this.seq > 0) {
      this.ingest({ t: 'marker', kind: 'cleared', detail: 'started a new conversation' });
      // And the conversation it draws a line under is dropped from the log, so
      // the line is where this one begins rather than a marker in the middle
      // of a longer record. Emptying the browser's window was never enough: a
      // reload replays the tail from disk, and the tail still held everything
      // said before the clear — so the conversation the user had just ended
      // came straight back, and paging up walked into the rest of it.
      //
      // Awaited before the new process starts talking, and enqueued behind the
      // marker's own append: the truncation and the events either side of it
      // are ordered by the store's per-log queue, so nothing lands in a log
      // that is being rewritten. A log cleanup failure remains non-fatal, but
      // the Plan sidecar is checked separately below: claiming a fresh Plan
      // document while an old one remains durable would make it reappear after
      // the next restart.
      try {
        await this.deps.store.truncateBefore(this.ref, this.seq);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not truncate the cleared conversation: ${message}`);
      }
      try {
        await this.deps.store.clearPlanDocument?.(this.ref);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.ingest({
          t: 'error',
          message: `A fresh conversation could not be started because its saved Plan could not be cleared: ${detail}`,
          fatal: true,
        });
        await this.stop();
        throw error;
      }
      // And the branch history goes with it, if this conversation had one
      // waiting. `/clear` promises an agent that has never seen any of it, and
      // handing over the very history just dropped from the transcript would be
      // that promise broken in the most confusing possible way.
      this.carried = null;
      void this.deps.store.clearOpeningContext?.(this.ref);
      this.planMode = false;
      this.planDocumentCache = null;
      this.lastStartOptions = { ...options, planMode: false };
      this.deps.onLifecycle?.(this.ref.id, { planMode: false });
      this.deps.broadcast(this.ref.id, {
        type: 'chat_plan_mode',
        sessionId: this.ref.id,
        planMode: false,
        changed: true,
        message: 'Plan mode was cleared with the previous conversation.',
      });
      this.deps.broadcast(this.ref.id, {
        type: 'chat_plan_document',
        sessionId: this.ref.id,
        plan: null,
      });

      // Nor does anything go on naming the conversation that was just dropped. The
      // replacement announces an id of its own on its first turn and not
      // before, so a conversation cleared and then left alone kept the pre-clear
      // id: reopening it after a server restart showed the emptied transcript
      // over a banner offering to resume, and taking that offer spawned the
      // runtime against the very memory the clear had destroyed (#43).
      //
      // Said *after* the truncation on purpose. The record is not the only
      // place that answers this question — a record with no id sends the
      // manager and the sessions route to the head of the log for one — so
      // clearing the record while the old `session` event was still readable
      // would have the id put straight back on the next rejoin.
      this.nativeSessionId = null;
      this.deps.onLifecycle?.(this.ref.id, { nativeSessionId: null });
    }

    // There is deliberately no await between this check and adapter.start():
    // every adapter reaches its spawn synchronously. A retiring/deleted record
    // therefore cannot materialise a child after its owner drained launch.
    if (options.cancelled?.()) {
      await this.stop();
      throw new Error('chat launch cancelled because the session is closing');
    }

    this.setState('starting');
    this.adapterStarting = true;
    this.adapterExitedWhileStarting = false;

    try {
      await adapter.start();
    } catch (error: unknown) {
      this.adapterStarting = false;
      this.adapterExitedWhileStarting = false;
      // Make every later event from this failed launch stale before verified
      // teardown begins; otherwise its eventual `exited` can release a
      // replacement's lease.
      this.adapterGeneration++;
      const message = error instanceof Error ? error.message : String(error);
      this.ingest({ t: 'error', message: `could not start ${options.runtime}: ${message}`, fatal: true });
      this.setState('error');
      // A handoff kept across shutdown is actionable only if this runtime can
      // resume. Once that attempt has definitively failed, leave an explicit
      // abandoned outcome instead of a durable card no future caller owns.
      if (options.resumeSessionId) await this.restorePendingQuestions(false);
      await this.stop();
      throw error;
    }
    this.adapterStarting = false;
    if (this.adapterExitedWhileStarting) {
      this.adapterExitedWhileStarting = false;
      this.deps.onLifecycle?.(this.ref.id, {
        exited: true,
        restarting: this.restarting,
      });
    }

    // The adapter's static declaration is a floor, not an override: a runtime
    // that has already reported its own — Claude sends its slash commands with
    // the first turn's `init` — knows more than this does.
    if (!this.capabilities) {
      this.capabilities = adapter.capabilities;
    }
    // Not an adapter capability: whether the model can ask a question is a fact
    // about what this session wired up, not about what the runtime can parse.
    // The same adapter has it or does not depending on whether the MCP server
    // was built and found.
    if ((this.questionToolEnabled || this.questionFallbackEnabled) && this.capabilities) {
      this.capabilities = { ...this.capabilities, questions: true };
      this.ingest({ t: 'capabilities', capabilities: { questions: true } });
    }
    if (this.planEnabled && this.capabilities) {
      this.capabilities = { ...this.capabilities, planMode: true };
      this.ingest({ t: 'capabilities', capabilities: { planMode: true } });
    }

    // Which approval mode this conversation is running in, said in the
    // conversation itself.
    //
    // The mode is decided at the moment a conversation begins, out of a
    // preference that lives in Settings and may well have changed since the
    // last one — so a conversation that comes up bypassing, or that no longer
    // does, must not do it in silence (#134). Only when one is beginning: a
    // resume returns to a transcript that already carries the line from the day
    // it started, and repeating it on every relaunch would be noise.
    //
    // After the adapter has started, so the phrase can be honest about what
    // this runtime can actually enforce rather than about what was asked for.
    if (!options.resumeSessionId) {
      this.ingest({
        t: 'marker',
        kind: 'approvals',
        detail: approvalNoticeDetail(
          this.bypass,
          // Whether anything can actually stop a tool call in this session:
          // claude asks through the PreToolUse hook rather than through the
          // adapter protocol, so its `permissions` capability is false while it
          // asks perfectly well. Reading that flag alone would print "this
          // runtime cannot ask" over every claude conversation.
          wantsHook || this.capabilities?.permissions === true,
        ),
        // And the same fact structurally, because the phrase is for the reader
        // and this is for the pane. A conversation that begins from *inside*
        // itself — the composer's New chat, `/clear` — never touches the launch
        // path, so `chat_started` is not broadcast and this marker is the only
        // thing that reaches the browser with the mode the restart re-decided
        // (#134).
        bypassing: this.bypass,
      });
    }

    const restoredQuestion = await this.restorePendingQuestions(
      !options.startFresh && Boolean(options.resumeSessionId) && adapter.alive,
    );
    this.setState(restoredQuestion ? 'awaiting_answer' : 'idle');
    if (!restoredQuestion) {
      for (const continuationId of this.questionContinuations.keys()) {
        this.dispatchQuestionContinuation(continuationId);
      }
    }
  }

  /**
   * Reconcile questions that survived in the durable event log.
   *
   * Only structured handoffs are resumable: their original model turn already
   * ended, so the request itself is everything needed to send a continuation.
   * A tool question belonged to a promise in the dead process and must become
   * honest, non-actionable history instead of a button wired to nothing.
   */

  protected async openingContext(): Promise<string | null> {
    if (this.carried !== undefined) return this.carried;
    this.carried = (await this.deps.store.openingContext?.(this.ref)) ?? null;
    return this.carried;
  }

  /**
   * Stop the running adapter and start a brand new one with no resume id, in
   * place, without tearing down the `ChatSession` itself.
   *
   * The marker that tells a rejoining browser to stop paging back past this
   * point is emitted by `start()` itself (`startFresh`), so this only has to
   * get a fresh process running — the same path a manual "start fresh"
   * relaunch takes, just triggered from inside a live conversation instead of
   * from the recovery banner.
   */

  protected async restart(): Promise<void> {
    const options = this.lastStartOptions;
    if (!options) return;
    this.restarting = true;
    // Before the old process is signalled, not after: whatever it emits from
    // here on belongs to a conversation that is over. See `adapterGeneration`.
    this.adapterGeneration++;
    // The line is *not* carried across, and that is the whole difference #69
    // made: a clear is taken the moment it is typed rather than waiting its
    // turn, so whatever is queued here was typed for the process being
    // replaced and belongs to the conversation the user just left (#69).
    // Anything typed *after* the clear still arrives — `restarting` parks it
    // and the fresh process is handed it as soon as it reports idle — which is
    // the case #89 exists to protect.
    let oldRuntimeStopped = false;
    try {
      await this.stop();
      oldRuntimeStopped = true;
      // Stale until the new process's own `init` event reports its id — cleared
      // up front so nothing reads the old conversation's id in the meantime.
      // The record hears it too, but from inside `start`, once the log this
      // one lived in has actually been dropped (#43).
      this.nativeSessionId = null;
      // The mode is re-decided rather than replayed. A conversation started
      // from inside this one is a conversation that is *beginning*, so it takes
      // the owner's preference exactly as the launcher's would — which is what
      // makes the composer's New chat and the recovery notice's Start a new
      // chat land in the same place. Replaying `options.bypassPermissions` is
      // what used to carry one conversation's standing permission into every
      // later one in the tab, whatever the preference had since been set to.
      await this.start({
        ...options,
        bypassPermissions: this.deps.resolveBypass?.() === true,
        resumeSessionId: undefined,
        startFresh: true,
      });
    } catch (error: unknown) {
      // Nothing replaced the conversation that was stopped. `start()` has
      // already written the failure into the transcript and moved the state to
      // `error`; the record has to hear it too, or the tab goes on claiming a
      // process that never started and refuses the relaunch that would fix it.
      // If teardown itself could not prove the old process gone, admission has
      // to remain closed. Only a verified stop followed by a failed replacement
      // is an exited conversation.
      if (oldRuntimeStopped) {
        this.deps.onLifecycle?.(this.ref.id, { exited: true, restarting: false });
      }
      throw error;
    } finally {
      this.restarting = false;
    }

    // The record outlives every process this session runs, and `stop()` above
    // told it one had gone. Saying so again in the other direction is what
    // keeps the tab a running tab: without it the session lists report a
    // conversation that is answering as finished, and the next launch in this
    // tab is refused because a process it no longer has is still claimed.
    //
    // And the mode with it, because this restart may well have changed it: left
    // out, a conversation cleared down to asking would still be *recorded* as
    // bypassing, and the next resume would hand it back a permission it no
    // longer had.
    this.deps.onLifecycle?.(this.ref.id, { exited: false, bypassing: this.bypass });
  }


  async interrupt(): Promise<void> {
    if (!this.adapter) return;
    // Before the state moves: going idle is what releases the queue, and a
    // stop that then fired the three messages waiting behind it would be the
    // opposite of what the button says. Someone who wants them can send them.
    const dropped = this.clearQueue();
    await this.cancelTurnInFlight();
    if (dropped) {
      this.ingest({
        t: 'error',
        message: `Stopped. ${dropped} queued message${dropped === 1 ? ' was' : 's were'} discarded.`,
      });
    }
  }

  /**
   * End the turn in flight, leaving the queue alone.
   *
   * Everything `interrupt` does *except* discarding what was typed ahead —
   * which is the whole difference between the stop button and promoting one
   * waiting message. Kept as one method rather than duplicated, because the
   * part that matters here is not the adapter call: it is that a cancelled
   * turn must not leave a permission card or a question on screen waiting for
   * an answer that can no longer reach anything.
   */

  protected async cancelTurnInFlight(): Promise<void> {
    if (!this.adapter) return;
    this.acceptingQuestionTransitions = false;
    this.questionStopIntent = 'abandon';
    this.questionContinuationGeneration += 1;
    // Said before the interrupt rather than after it, because the answer to it
    // can arrive during the await — and on Claude the answer *is* the report
    // this window exists to swallow. Same reasoning as `staleTurnEndUntil`,
    // which `sendQueuedNow` sets one line before calling this.
    this.interruptedErrorUntil = Date.now() + INTERRUPT_ACK_WINDOW_MS;
    try {
      this.adapter.cancelPendingSendAcceptance?.('the turn was interrupted before acceptance was confirmed');
      await this.adapter.interrupt();
      // Anything still waiting on a person is moot once the turn is cancelled,
      // and leaving the cards on screen would invite answers that go nowhere.
      for (const [requestId, approval] of this.pending) {
        approval.resolve?.({ allow: false, reason: 'the turn was interrupted' });
        this.ingest({ t: 'permission_resolved', requestId, optionId: 'reject_once', allowed: false });
      }
      this.pending.clear();
      // Anything admitted before Stop is linearised first. Readiness waiters
      // see the intent/generation and withdraw; a send that already crossed its
      // final gate is allowed to commit delivered before termination continues.
      await this.questionTransitionTail.catch(() => undefined);
      await Promise.allSettled([...this.questionDispatches.values()]);
      await this.mutateQuestions(async () => {
        for (const [requestId, entry] of [...this.questions]) {
          await this.abandonQuestionNow(requestId, entry, 'the turn was interrupted');
        }
        await this.abandonQuestionContinuationsNow('the turn was interrupted');
      });
      this.setState('idle');
    } finally {
      this.questionStopIntent = null;
      this.acceptingQuestionTransitions = true;
    }
  }

  /**
   * Answer a pending approval.
   *
   * Two routes converge here. A hook-broker question has a promise waiting on
   * it; an adapter-native question is answered by the adapter. Either way the
   * transcript records the decision, so the conversation shows what was allowed
   * and what was refused.
   */

  async stop({ preserveHandoffs = false }: { preserveHandoffs?: boolean } = {}): Promise<void> {
    this.acceptingQuestionTransitions = false;
    this.questionStopIntent = preserveHandoffs ? 'preserve' : 'abandon';
    this.questionContinuationGeneration += 1;
    this.adapter?.cancelPendingSendAcceptance?.('the session stopped before acceptance was confirmed');
    for (const [, approval] of this.pending) {
      approval.resolve?.({ allow: false, reason: 'the session was stopped' });
    }
    this.pending.clear();
    // The MCP server's socket is about to go with the process, but it is the
    // one waiting on these promises: resolving them here is what turns a
    // shutdown into a tool result rather than a connection that simply stops
    // answering.
    // Written to the log as well as resolved, which it was not before: a browser
    // already watching this conversation is told the card is over, instead of
    // going on offering buttons until something makes it rejoin and rebuild.
    await this.questionTransitionTail.catch(() => undefined);
    await Promise.allSettled([...this.questionDispatches.values()]);
    if (preserveHandoffs) {
      // A withdrawal may have lost one transient store write while Stop was
      // already waiting on its dispatch task. Retry it here and do not clear
      // the in-memory fact if durability is still unavailable: returning a
      // successful shutdown would make recovery discard a provably unsent
      // accepted answer as ambiguous.
      for (const continuationId of [...this.knownUnsentQuestionContinuations]) {
        await this.markQuestionContinuationPending(continuationId);
      }
    }
    await this.mutateQuestions(async () => {
      for (const [requestId, entry] of [...this.questions]) {
        if (preserveHandoffs && entry.kind === 'structured_handoff') continue;
        await this.abandonQuestionNow(requestId, entry, 'the session was stopped');
      }
      if (!preserveHandoffs) {
        await this.abandonQuestionContinuationsNow('the session was stopped');
      }
    });
    // Preserved handoffs remain in the event log, not in a process that is
    // about to die. The replacement session rehydrates them after its adapter
    // has successfully resumed.
    this.questions.clear();
    this.questionContinuations.clear();
    this.knownUnsentQuestionContinuations.clear();
    this.clearQueue();

    // Before the adapter goes: a turn that was still running when someone hit
    // stop is work that happened, and losing it would make every deliberate
    // interruption invisible in the record.
    this.accountant?.flush();
    this.accountant = null;

    const adapter = this.adapter;
    try {
      if (adapter) {
        // Resolving is a lifecycle guarantee: the local child and, for a
        // container, its identity-bound remote process group are both gone.
        await adapter.stop();
        if (this.adapter === adapter) this.adapter = null;
      }
    } finally {
      this.broker?.close();
      this.broker = null;
      await this.fileBroker?.close().catch(() => undefined);
      this.fileBroker = null;
    }
  }
}
