import path from 'node:path';

import {
  AgentKind,
  BridgeInterface,
  PathValidation,
  SessionRecord,
} from './types.js';
import { ServerCore } from './server-core.js';
import { DATA_DIR_LEASE_LOST_EXIT_CODE } from './services/data-dir-lease.js';
import {
  ActiveTargetResolution,
  createEngine,
  EnvironmentEngine,
} from './services/environments/index.js';
import { ContainerConfig, UserEnvironment } from './services/environments/types.js';
import { agentMaintenanceExecutionKey, type AgentMaintenanceTarget } from './services/agent-maintenance.js';
import { childProcessRunner } from './services/agent-maintenance-runtime.js';
import {
  AGENT_MAINTENANCE_IDS,
  agentCatalogEntry,
  type AgentArchitecture,
  type AgentMaintenanceId,
  type AgentPlatform,
} from '../shared/agent-maintenance.js';
import { nextAccountTabOrder, probeLaunchedAgentVersion } from './server-functions.js';

export abstract class ServerEnvironment extends ServerCore {
  /** Lost lease means stop admission and terminate without a final persistence write. */
  protected failStopDataDirLease(error: Error): never {
    console.error(`Fatal: lost the installation data-directory lease: ${error.message}`);
    this.isShuttingDown = true;
    try { this.projects?.stopSweep(); } catch { /* fail-stop continues */ }
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    if (this.environmentSweep) clearInterval(this.environmentSweep);
    if (this.environmentScale) clearInterval(this.environmentScale);
    try { this.codexPricing?.stop(); } catch { /* fail-stop continues */ }
    try { this.listener?.close(); } catch { /* fail-stop continues */ }
    try { this.server?.closeAllConnections?.(); } catch { /* fail-stop continues */ }
    for (const socket of this.listenerSockets || []) {
      try { socket.destroy(); } catch { /* fail-stop continues */ }
    }
    process.exit(DATA_DIR_LEASE_LOST_EXIT_CODE);
  }

  /** Per-user environments authorize paths against that user's home; otherwise use the server base. */
  protected getUserBaseFolder(userId?: number): string {
    if (!this.environments.enabled || userId === undefined) {
      return this.baseFolder;
    }
    const owner = this.getEnvironmentOwner(userId);
    return owner ? this.environments.homeDirFor(owner) : this.baseFolder;
  }

  protected getEnvironmentOwner(userId: number): { id: number; githubLogin: string } | null {
    const user = this.database.getUserById(userId);
    return user ? { id: user.id, githubLogin: user.githubLogin } : null;
  }

  /** Git identity used by the preservation commit before a project rebuild. */
  protected projectAuthorFor(userId: number): { name: string; email: string } {
    const user = this.database.getUserById(userId);
    if (!user) {
      throw new Error(`project owner ${userId} is unavailable for preservation`);
    }
    const clean = (value: string): string => value
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const login = clean(user.githubLogin) || `user-${user.id}`;
    const name = clean(user.githubName || '') || login;
    const suppliedEmail = clean(user.email || '');
    const safeLogin = login.replace(/[^a-zA-Z0-9_.-]+/gu, '-') || `user-${user.id}`;
    const safeGitHubId = user.githubId.replace(/[^a-zA-Z0-9]+/gu, '') || String(user.id);
    const email = /^[^\s<>@]+@[^\s<>@]+$/u.test(suppliedEmail)
      ? suppliedEmail
      : `${safeGitHubId}+${safeLogin}@users.noreply.github.com`;
    return { name, email };
  }

  /** Active runtimes, sockets, and descendant shells prevent reclaim; dormant records do not. */
  protected hasLiveProjectWork(projectId: string): boolean {
    if (this.messageProcessor?.hasPendingProjectWork(projectId)) return true;
    const related = new Set<string>();
    for (const session of this.claudeSessions.values()) {
      if (session.projectId === projectId) related.add(session.id);
    }

    for (let changed = true; changed;) {
      changed = false;
      for (const session of this.claudeSessions.values()) {
        if (session.ownerSessionId && related.has(session.ownerSessionId) && !related.has(session.id)) {
          related.add(session.id);
          changed = true;
        }
      }
    }

    if (related.size === 0) return false;
    for (const sessionId of related) {
      const session = this.claudeSessions.get(sessionId);
      if (session?.active || (session?.connections.size ?? 0) > 0) return true;
    }
    for (const socket of this.webSocketConnections.values()) {
      if (socket.claudeSessionId && related.has(socket.claudeSessionId)) return true;
      for (const watched of socket.chatSessionIds) {
        if (related.has(watched)) return true;
      }
    }
    return false;
  }

  /** Empty target storage uses legacy startup config; no active stored target resolves to null. */
  protected resolveActiveDeployTarget(): ActiveTargetResolution | null {
    // Reload invalidates this cache, so hot-path checks need not read the store.
    const maps = this.deployTargetMaps;
    if (!maps.targetsExist) {
      return { key: 'legacy', config: this.legacyContainerConfig, name: 'startup configuration' };
    }
    if (!maps.activeKey) {
      return null;
    }
    const config = maps.configs.get(maps.activeKey);
    if (!config) {
      return null;
    }
    return { key: maps.activeKey, config, name: maps.targetNames.get(maps.activeKey) };
  }

  /** Build target engines by id; skip and warn for targets with unusable secrets. */
  protected buildDeployTargetMaps(): {
    engines: Map<string, EnvironmentEngine>;
    configs: Map<string, ContainerConfig>;
    activeKey: string | null;
    targetsExist: boolean;
    targetNames: Map<string, string>;
  } {
    const engines = new Map<string, EnvironmentEngine>();
    const configs = new Map<string, ContainerConfig>();
    if (!this.containerizedEnvironmentsEnabled) {
      return {
        engines,
        configs,
        activeKey: 'legacy',
        targetsExist: false,
        targetNames: new Map(),
      };
    }
    const targets = this.deployTargets.listTargets();
    for (const summary of targets) {
      try {
        const targetConfig = this.deployTargets.configForTarget(
          summary.id,
          this.database.storageDir,
          this.environmentExtraMounts,
        );
        configs.set(summary.id, targetConfig);
        engines.set(summary.id, createEngine(targetConfig));
      } catch (error) {
        console.warn(`deploy target "${summary.name}" is unusable and was skipped:`, error);
      }
    }
    const activeKey = targets.length === 0
      ? 'legacy'
      : this.deployTargets.getActiveTargetId();
    return {
      engines,
      configs,
      activeKey,
      targetsExist: targets.length > 0,
      targetNames: new Map(targets.map((target) => [target.id, target.name])),
    };
  }

  /** Reload target maps without stranding containers owned by previous engines. */
  protected reloadDeployTargets(): void {
    this.deployTargetMaps = this.buildDeployTargetMaps();
    this.environments.reloadTargets(this.deployTargetMaps);
  }

  /** Use host only when environments are disabled or ownerless; provisioning failures propagate. */
  protected async ensureEnvironment(userId?: number): Promise<UserEnvironment> {
    if (!this.environments.enabled || userId === undefined) {
      return this.environments.host();
    }
    const owner = this.getEnvironmentOwner(userId);
    if (!owner) {
      return this.environments.host();
    }
    try {
      return await this.environments.ensureFor(owner);
    } catch (error) {
      console.error(`Could not prepare an environment for ${owner.githubLogin}:`, error);
      throw error;
    }
  }

  protected agentMaintenanceKey(session: SessionRecord, environment: UserEnvironment): string {
    if (session.projectId) return `project:${session.ownerUserId}:${session.projectId}`;
    return agentMaintenanceExecutionKey(session.ownerUserId, environment);
  }

  protected agentMaintenancePlatform(environment: UserEnvironment): AgentPlatform {
    if (environment.kind === 'container') return 'linux';
    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      return process.platform;
    }
    return 'unsupported';
  }

  protected async agentMaintenanceArchitecture(
    key: string,
    environment: UserEnvironment,
  ): Promise<AgentArchitecture> {
    const cached = this.agentMaintenanceArchitectures.get(key);
    if (cached) return cached;
    let raw: string = process.arch;
    if (environment.kind === 'container') {
      try {
        const wrapped = environment.wrap('uname', ['-m']);
        const result = await childProcessRunner.run(wrapped.command, wrapped.args, {
          env: wrapped.env,
          timeoutMs: 2_000,
          windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
        });
        raw = result.stdout.trim();
      } catch {
        raw = '';
      }
    }
    const architecture: AgentArchitecture = /^(?:arm64|aarch64)$/iu.test(raw)
      ? 'arm64'
      : /^(?:x64|x86_64|amd64)$/iu.test(raw) ? 'x64' : 'unsupported';
    this.agentMaintenanceArchitectures.set(key, architecture);
    return architecture;
  }

  protected async agentMaintenanceTarget(
    session: SessionRecord,
    environment?: UserEnvironment,
  ): Promise<AgentMaintenanceTarget> {
    const resolvedEnvironment = environment || await this.agentMaintenanceEnvironmentForSession(session);
    const key = this.agentMaintenanceKey(session, resolvedEnvironment);
    const runningAgentId = session.agent
      && (AGENT_MAINTENANCE_IDS as readonly string[]).includes(session.agent)
      ? session.agent as AgentMaintenanceId
      : null;
    if (!session.projectId) this.agentMaintenanceEnvironments.set(key, resolvedEnvironment);
    const resolved: AgentMaintenanceTarget = {
      key,
      platform: this.agentMaintenancePlatform(resolvedEnvironment),
      architecture: await this.agentMaintenanceArchitecture(key, resolvedEnvironment),
      scope: resolvedEnvironment.kind === 'container' ? 'private' : 'shared',
      ownerUserId: resolvedEnvironment.kind === 'container' ? session.ownerUserId : null,
      projectManaged: Boolean(session.projectId),
      ...(runningAgentId
        ? {
            runningAgentId,
            ...(session.runningAgentVersion !== undefined
              ? { runningVersion: session.runningAgentVersion }
              : {}),
          }
        : {}),
    };
    // Never infer an active process version from mutable PATH or pointers; unknown stays unknown.
    if (
      !session.projectId
      && session.active
      && runningAgentId
      && session.runningAgentVersion === undefined
    ) {
      session.runningAgentVersion = null;
      session.runningManagedAgentVersion = null;
      resolved.runningAgentId = runningAgentId;
      resolved.runningVersion = null;
    }
    return resolved;
  }

  protected async agentMaintenanceEnvironmentForSession(
    session: SessionRecord,
  ): Promise<UserEnvironment> {
    if (session.active) {
      if (session.runtimeEnvironmentKey) {
        const captured = this.agentMaintenanceEnvironments.get(session.runtimeEnvironmentKey);
        if (!captured) {
          throw new Error('The original execution environment is no longer available.');
        }
        return captured;
      }
      const current = await this.ensureEnvironment(session.ownerUserId);
      if (current.kind === 'container') {
        throw new Error('The running process has no captured immutable environment identity.');
      }
      return current;
    }
    return this.ensureEnvironment(session.ownerUserId);
  }

  protected async probeAgentLaunchVersion(
    environment: UserEnvironment,
    agentKind: AgentKind,
    selectedCommand?: string,
  ): Promise<string | null> {
    const bridge = this.getRuntimeBridge(agentKind) as BridgeInterface & {
      command?: string;
      defaultCommand?: string;
    };
    const actualCommand = selectedCommand || (environment.kind === 'container'
      ? bridge?.defaultCommand
      : bridge?.command);
    return probeLaunchedAgentVersion(environment, agentKind, actualCommand);
  }

  protected async resolveAgentMaintenanceTarget(input: {
    userId: number;
    targetId: string;
  }): Promise<AgentMaintenanceTarget | null> {
    const session = this.claudeSessions.get(input.targetId);
    if (!session || session.ownerUserId !== input.userId) return null;
    // Project status must not start a dormant project merely by opening its picker.
    if (session.projectId) {
      const environment = this.environments.host();
      return this.agentMaintenanceTarget(session, environment);
    }
    return this.agentMaintenanceTarget(session);
  }

  protected resolveManagedAgentLaunch(
    session: SessionRecord,
    environment: UserEnvironment,
    agentKind: AgentKind,
  ): { command: string; version: string } | null {
    if (session.projectId || agentKind === 'terminal') return null;
    const entry = agentCatalogEntry(agentKind);
    if (!entry) return null;
    const key = this.agentMaintenanceKey(session, environment);
    this.agentMaintenanceEnvironments.set(key, environment);
    session.runtimeEnvironmentKey = key;
    const target: AgentMaintenanceTarget = {
      key,
      platform: this.agentMaintenancePlatform(environment),
      architecture: this.agentMaintenanceArchitectures.get(key)
        || (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unsupported'),
      scope: environment.kind === 'container' ? 'private' : 'shared',
      ownerUserId: environment.kind === 'container' ? session.ownerUserId : null,
    };
    const selected = this.agentMaintenanceRuntime.resolveManagedCommand(target, entry, environment);
    return selected?.version ? { command: selected.command, version: selected.version } : null;
  }

  protected isPathWithinBase(targetPath: string, userId?: number): boolean {
    try {
      const resolvedTarget = path.resolve(targetPath);
      const resolvedBase = path.resolve(this.getUserBaseFolder(userId));
      return (
        resolvedTarget === resolvedBase
        || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
      );
    } catch {
      return false;
    }
  }

  protected validatePath(targetPath: string, userId?: number): PathValidation {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }

    const resolvedPath = path.resolve(targetPath);
    if (!this.isPathWithinBase(resolvedPath, userId)) {
      return {
        valid: false,
        error: 'Access denied: Path is outside the allowed directory',
      };
    }

    return { valid: true, path: resolvedPath };
  }

  protected createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    ownerSessionId?: string;
    projectId?: string | null;
    projectWorkingDirKind?: 'host' | 'container';
    /** Trusted canonical workspace root; never accepted from the browser. */
    storageRoot?: string;
  }): SessionRecord {
    const parent = params.ownerSessionId
      ? this.claudeSessions.get(params.ownerSessionId)
      : undefined;
    if (params.ownerSessionId && (!parent || parent.ownerUserId !== params.ownerUserId)) {
      throw new Error('Owner conversation is unavailable for workspace storage');
    }
    const project = !parent && params.projectId
      ? this.projectStore.getProjectForUser(params.projectId, params.ownerUserId)
      : null;
    if (!parent && params.projectId && !project) {
      throw new Error('Project workspace is unavailable for session storage');
    }
    const storageScope = parent?.storageScope
      || (project
        ? this.projectSessionStorageScope(project)
        : this.sessionStorageScope(params.ownerUserId, params.storageRoot || params.workingDir));
    this.assertWorkspaceScopeWritable(storageScope);
    return {
      id: params.id,
      storageScope,
      ownerSessionId: params.ownerSessionId,
      projectId: params.projectId,
      projectWorkingDirKind: params.projectWorkingDirKind,
      ownerUserId: params.ownerUserId,
      name: params.name || `Session ${new Date().toLocaleString()}`,
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      agent: null,
      lastAgent: null,
      runtimeLabel: null,
      // Standalone tabs follow this account's tabs; nested shells are excluded.
      tabOrder: params.ownerSessionId
        ? undefined
        : nextAccountTabOrder(this.claudeSessions, params.ownerUserId),
      terminalOptions: null,
      stopRequested: false,
      workingDir: params.workingDir,
      connections: new Set(params.connections || []),
      outputBuffer: [],
      termCols: 80,
      termRows: 24,
      sessionStartTime: null,
      sessionUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        models: {},
      },
      maxBufferSize: 1000,
    };
  }
}
