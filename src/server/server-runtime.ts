import {
  type AgentKind,
  type BridgeInterface,
  type SessionRecord,
} from './types.js';
import {
  type ResolvedProfile,
  resolveConversationRung,
} from '../shared/runtime-profiles.js';
import {
  applyTiers,
  supportsTiers,
  tierCapableRuntimes,
} from './services/runtime/profiles/tier-writer.js';
import { type SessionRoutesDeps } from './routes/sessions.js';
import { detectUpdateMode, type UpdateModeResult } from './services/release/self-update.js';
import { sendToUser } from './websocket/handler.js';
import { ServerWorkspace } from './server-workspace.js';

export abstract class ServerRuntime extends ServerWorkspace {
  protected getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null {
    return this.runtimeBridges.get(agentKind) ?? null;
  }

  /**
   * Resolve the active profile for a runtime into launch parameters.
   *
   * Tiers are written through here as well as on save: the generated file has
   * to exist on disk before the process starts, and a profile saved by an
   * earlier build (or a data directory restored from backup) may never have
   * been through the save path at all.
   */
  protected resolveRuntimeProfile(
    agentKind: AgentKind,
    workingDir?: string,
  ): ResolvedProfile | null {
    const profile = this.runtimeProfiles.activeFor(agentKind);
    if (!profile) return null;

    // The session's directory is where pi's tier agents go, so it is part of
    // the context rather than something the writer could guess.
    const tierResult = applyTiers(profile, { ...this.tierContext, workingDir });
    for (const replaced of tierResult.replaced) {
      console.warn(
        `Runtime profile "${profile.name}": replaced ${replaced.file} (${replaced.reason})`,
      );
    }

    const extraArgs = [...tierResult.args, ...(profile.args || [])];

    // A rung is only in force if the ladder behind it reached the runtime. When
    // the write-through failed, the delegated helpers are not configured and the
    // conversation's own model would be the only half of the ladder that landed
    // — so the launch says so and falls back rather than reporting a rung it
    // half applied.
    // `unsupported` is a runtime with no way to express a ladder at all — the
    // non-goal the issue states outright: those launch exactly as they do now.
    // A rung applied anyway would put a `--model` on a claude session whose
    // helper rungs were written nowhere, from a ladder saved for a different
    // runtime and carried across by changing the Runtime dropdown.
    const ladder = tierResult.unsupported ? null : resolveConversationRung(profile);
    // Runtime launches normally always name a host-visible working directory.
    // An omitted one here is the explicit container-only namespace used by a
    // project session. Pi's ladder files cannot be written with host fs in that
    // case; reporting the ladder as active would be a more dangerous lie than
    // starting on the profile's ordinary model without delegated rungs.
    const ladderError = ladder
      ? tierResult.failed
        || (!workingDir && tierResult.deferred
          ? 'Capability tiers cannot be written into this container-only working directory.'
          : undefined)
      : undefined;

    return {
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      extraArgs: extraArgs.length ? extraArgs : undefined,
      env: profile.env,
      ladder: ladderError ? null : ladder,
      tiers: profile.tiers,
      ladderError,
    };
  }

  /**
   * The active profile for a runtime, and nothing written down.
   *
   * The read-only half of `resolveRuntimeProfile` above, which cannot serve
   * this: it writes the profile's tier files every time it is called, and the
   * callers here are questions — a browser joining a conversation, a branch
   * being cut — not launches. Answering them through the other one would
   * rewrite a runtime's config on every tab that opened.
   */
  protected activeProfileFor(runtime: string): ResolvedProfile | null {
    const profile = this.runtimeProfiles.activeFor(runtime);
    if (!profile) return null;
    // The rung is resolved here too: reading a ladder is pure arithmetic over
    // four strings, and it is only *writing* it through that the caller of this
    // one must not trigger.
    const laddered = supportsTiers(runtime);
    return {
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      // Same gate as the launch above, and it has to be: this answers the
      // picker's "where did this model come from", and a rung reported for a
      // runtime that cannot express one would name a model nothing applied.
      ladder: laddered ? resolveConversationRung(profile) : null,
      ...(laddered ? { tiers: profile.tiers } : {}),
    };
  }

  /**
   * Carry edited ladders into the conversations that are open right now.
   *
   * Every tier-capable runtime, not only the ones whose profile changed: a save
   * rewrites the whole configuration at once, and working out which runtimes
   * actually moved would mean diffing a config against itself. The sessions
   * decide — one already on the rung it is being offered declines, so an
   * unrelated save interrupts nobody.
   */
  protected async applyProfilesToOpenChats(): Promise<void> {
    for (const runtime of tierCapableRuntimes()) {
      const profile = this.activeProfileFor(runtime);
      // Only when the ladder is what decides: a model typed into the profile,
      // like an account's standing choice, outranks it, and a conversation
      // running on one of those was never the ladder's to move.
      const ladder = profile && !profile.model && profile.ladder && profile.tiers
        ? { tier: profile.ladder.tier, tiers: profile.tiers }
        : null;
      const moved = await this.chatManager.reapplyLadder(runtime, ladder);
      if (moved.length) {
        console.log(`Runtime profiles: moved ${moved.length} open ${runtime} conversation(s)`);
      }
    }
  }

  /** This account's standing model per runtime, for the profiles dialog. */
  protected getUserModelDefaults(userId: number): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const runtime of tierCapableRuntimes()) {
      const model = this.database.getUserSetting(userId, `chatModel:${runtime}`);
      if (model) defaults[runtime] = model;
    }
    return defaults;
  }

  /**
   * Cached: detection shells out to `npm root -g` and `systemctl is-active`,
   * and neither answer changes while the process is alive.
   */
  protected getUpdateMode(): UpdateModeResult {
    if (this.desktop) {
      // A packaged app must never run npm over its own asar/resources tree.
      // Desktop releases notify here and are replaced by their OS installer.
      return { mode: 'desktop', packageDir: null };
    }
    if (!this.updateMode) {
      this.updateMode = detectUpdateMode();
    }
    return this.updateMode;
  }

  protected getSelectedWorkingDir(userId: number): string | null {
    return this.database.getUserSetting(userId, 'selectedWorkingDir');
  }

  protected setSelectedWorkingDir(userId: number, value: string | null): void {
    if (value) {
      this.database.setUserSetting(userId, 'selectedWorkingDir', value);
    } else {
      this.database.deleteUserSetting(userId, 'selectedWorkingDir');
    }
  }

  protected async loadPersistedSessions(): Promise<void> {
    this.claudeSessions.clear();
    try {
      await this.sessionStore.resetActiveFlags();
      const loaded = await this.sessionStore.loadSessions();
      for (const session of loaded.values()) {
        const scope = session.storageScope;
        // Rows written before the global-scope layout are not imported. They
        // remain untouched in app.sqlite and cannot select a filesystem path.
        if (!scope) continue;
        try {
          if (scope.ownerKey !== this.sessionOwnerKey(session.ownerUserId)) {
            throw new Error('Stored workspace owner does not match the global account identity');
          }
          const admitted = this.sessionStorageScope(session.ownerUserId, scope.workspaceRoot);
          if (admitted.ownerKey !== scope.ownerKey || admitted.workspaceRoot !== scope.workspaceRoot) {
            throw new Error('Stored workspace scope is no longer canonical');
          }
          this.assertWorkspaceScopeWritable(admitted);
          this.revalidateRestoredSession(session, admitted, session.ownerUserId);
          this.admitWorkspaceArtifactArchive(admitted, false);
          const key = this.workspaceScopeKey(admitted);
          this.loadedWorkspaceScopes.add(key);
          const earlierBlocked = [...this.claudeSessions.values()].some((entry) =>
            entry.storageScope && this.sameWorkspaceScope(entry.storageScope, admitted)
            && Boolean(entry.persistenceUnavailable));
          if (!earlierBlocked) this.workspacePersistenceErrors.delete(key);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          session.persistenceUnavailable = reason;
          this.workspacePersistenceErrors.set(
            `${scope.ownerKey}\u0000${scope.workspaceRoot}`,
            reason,
          );
        }
        this.claudeSessions.set(session.id, session);
      }
      if (this.claudeSessions.size > 0) {
        console.log(`Loaded ${this.claudeSessions.size} sessions from shared app SQLite`);
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
      this.claudeSessions.clear();
      throw error;
    }
  }

  /**
   * Stop environments nobody has used lately.
   *
   * Safe because the data is on the host: a stopped environment starts again
   * on the owner's next session with their home exactly as they left it, so
   * this is a resource decision rather than a lifecycle one. Runs on a
   * fixed minute tick rather than at the configured interval so that changing
   * the idle window does not mean restarting the server to feel it.
   */
  protected setupEnvironmentSweep(): void {
    if (!this.environments.enabled) {
      return;
    }
    this.environmentScale = setInterval(() => {
      void this.environments.sampleAndScale((userId) => this.userHasLiveSession(userId))
        .then((changes) => {
          for (const change of changes) {
            console.log(
              `Environment ${change.name}: ${change.from} → ${change.to} (${change.reason}) [${change.outcome}]`,
            );
            // Told, not discovered: a size that changes under someone without
            // a word is indistinguishable from the machine misbehaving.
            sendToUser(
              change.userId,
              {
                type: 'environment_tier_changed',
                tier: change.to,
                previousTier: change.from,
                reason: change.reason,
                outcome: change.outcome,
              },
              this.webSocketConnections,
            );
          }
        })
        .catch((error) => {
          console.error('Automatic environment sizing failed:', error);
        });
    }, 30_000);
    this.environmentScale.unref?.();

    this.environmentSweep = setInterval(() => {
      void this.environments.sweepIdle((userId) => this.userHasLiveSession(userId)).then((stopped) => {
        for (const name of stopped) {
          console.log(`Stopped idle environment ${name}`);
        }
      }).catch((error) => {
        console.error('Idle environment sweep failed:', error);
      });
    }, 60_000);
    // Never the reason the process stays up.
    this.environmentSweep.unref?.();
  }

  /** Whether anything is running for this user right now. */
  protected userHasLiveSession(userId: number): boolean {
    for (const session of this.claudeSessions.values()) {
      if (session.ownerUserId === userId && session.active) {
        return true;
      }
    }
    return false;
  }

  protected setupAutoSave(): void {
    if (this.autoSaveInterval) return;
    this.autoSaveInterval = setInterval(() => {
      void this.saveSessionsToDisk();
    }, 30000);
    process.on('beforeExit', () => {
      if (!this.isShuttingDown) void this.saveSessionsToDisk();
    });
  }

  protected async saveSessionsToDisk(
    sessions: Map<string, SessionRecord> = this.claudeSessions,
  ): Promise<boolean> {
    return this.sessionStore.saveSessions(sessions);
  }

  /**
   * One composition object for both public session routes and project
   * retirement, so deletion cannot accidentally take a weaker teardown path.
   */
  protected sessionRouteDeps(): SessionRoutesDeps {
    return {
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      baseFolder: this.baseFolder,
      dev: this.dev,
      validatePath: (targetPath: string, userId?: number) => this.validatePath(targetPath, userId),
      getUserBaseFolder: (userId?: number) => this.getUserBaseFolder(userId),
      createSessionRecord: (params) => this.createSessionRecord(params),
      loadWorkspaceSessions: (userId, storageRoot) =>
        this.loadWorkspaceSessions(userId, storageRoot),
      loadProjectWorkspaceSessions: (userId, projectId) =>
        this.loadProjectWorkspaceSessions(userId, projectId),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      stopSessionRuntime: (session) =>
        this.messageProcessor.retireSessionRuntime(session),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      transcriptStore: this.transcriptStore,
      historyStore: this.historyStore,
      getScreenSnapshot: (sessionId: string) => this.messageProcessor.getScreenSnapshot(sessionId),
      disposeRecorder: (sessionId: string) => this.messageProcessor.disposeRecorder(sessionId),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      activeProfileFor: (runtime: string) => this.activeProfileFor(runtime),
      tabCoordinator: this.tabCoordinator,
      sessionStore: {
        getSessionMetadata: (userId) => this.workspaceSessionMetadata(userId),
        setActive: (id, active) => this.sessionStore.setActive(
          id,
          active,
          this.claudeSessions.get(id)?.storageScope,
        ),
        resetActiveFlags: () => this.sessionStore.resetActiveFlags(),
      },
      projectsManager: this.projects,
      releaseProjectSessionResources: (sessionId) =>
        this.messageProcessor.releaseProjectSessionResources(sessionId),
      sessionTeardown: this.sessionTeardown,
      attachmentStore: this.attachmentStore,
      chatStore: this.chatStore,
    };
  }
}
