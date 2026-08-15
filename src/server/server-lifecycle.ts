import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import cors from 'cors';

import { registerRoutes } from './routes/index.js';
import { isChatAttachmentUploadRequest } from './routes/chat-attachments.js';
import { PromptSession } from './setup/prompts.js';
import { runRunModeWizard } from './setup/wizard.js';
import { INSTALL_COMMAND } from '../shared/update.js';
import { closeWorkspaceSessionDirectoryLeases } from './services/workspace/session/workspace-session-storage.js';
import { closeWorkspaceCwdHelpers } from './services/workspace/session/io/workspace-cwd-helper.js';
import { registerServerIdentityRoute } from './services/network/server-identity.js';
import { readCachedClaudeAccount } from './services/identity/claude-account.js';
import { DESKTOP_AUTH_COOKIE_NAME } from './services/identity/auth.js';
import { createEngine } from './services/environments/index.js';
import { ensureCertificates, createHttpsOnlyPort, caCertificateHandler } from './services/network/tls.js';
import { ServerRuntime } from './server-runtime.js';

export abstract class ServerLifecycle extends ServerRuntime {
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.isShuttingDown = true;
    if (this.shutdownExecution) return await this.shutdownExecution;
    if (this.startInProgress) {
      return await this.waitForShutdownExecution();
    }
    return await this.beginShutdown();
  }

  protected waitForShutdownExecution(): Promise<void> {
    if (this.shutdownExecution) return this.shutdownExecution;
    if (!this.shutdownWaiter) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.shutdownWaiter = { promise, resolve, reject };
    }
    return this.shutdownWaiter.promise;
  }

  protected beginShutdown(): Promise<void> {
    if (this.shutdownExecution) return this.shutdownExecution;
    this.shutdownRequested = true;
    this.isShuttingDown = true;
    const execution = this.shutdownAndReleaseDataDirLease();
    this.shutdownExecution = execution;
    void execution.then(
      () => this.shutdownWaiter?.resolve(),
      (error) => {
        this.shutdownWaiter?.reject(error);
        this.shutdownWaiter = null;
        // Retry only pending idempotent finalizers; never replay earlier teardown.
        if (this.shutdownFinalizationPending && this.shutdownExecution === execution) {
          this.shutdownExecution = null;
        }
      },
    );
    return execution;
  }

  protected async shutdownAndReleaseDataDirLease(): Promise<void> {

    let shutdownError: unknown;
    try {
      if (this.shutdownFinalizationPending) await this.finishShutdownStorage();
      else await this.shutdownWithDataDirLeaseHeld();
    } catch (error) {
      shutdownError = error;
    }

    let leaseError: unknown;
    // Release the lease only after all data-directory writers are closed.
    if (this.dataDirWritersClosed && this.dataDirLease) {
      const lease = this.dataDirLease;
      try {
        if (!await lease.release()) {
          leaseError = new Error('Data-directory lease ownership changed before shutdown');
        } else {
          this.dataDirLease = null;
        }
      } catch (error) {
        leaseError = error;
      }
    }

    if (shutdownError) {
      if (leaseError && shutdownError instanceof Error) {
        Object.assign(shutdownError, { leaseReleaseError: leaseError });
      }
      throw shutdownError;
    }
    if (leaseError) throw leaseError;
  }

  protected async shutdownWithDataDirLeaseHeld(): Promise<void> {

    console.log('\nGracefully shutting down...');
    // Stop project work and network admission before draining live resources.
    this.projects.stopSweep();
    const closeListener = new Promise<void>((resolve) => {
      const bound = this.listener || this.server;
      if (!bound || !bound.listening) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        // Force-close HTTP(S) and raw demux sockets, then await the close callback.
        this.server?.closeAllConnections?.();
        for (const socket of this.listenerSockets) socket.destroy();
        const closable = bound as net.Server & { closeAllConnections?(): void };
        closable.closeAllConnections?.();
      }, 5000);
      timeout.unref?.();
      bound.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    if (this.environmentSweep) {
      clearInterval(this.environmentSweep);
      this.environmentSweep = null;
    }
    if (this.environmentScale) {
      clearInterval(this.environmentScale);
      this.environmentScale = null;
    }
    this.updateChecker.stop();
    this.lanDiscovery.stop();
    this.codexPricing.stop();

    if (this.wss) {
      // Terminate connected clients while the listener blocks new handshakes.
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          // Already gone.
        }
      }
      this.wss.close();
      this.wss = null;
    }

    // Release every connection lease before persistence and runtime drain.
    await Promise.all(
      [...this.webSocketConnections.keys()].map((wsId) => this.wsHandler.cleanupConnection(wsId)),
    );

    // Drain recorder parsers before flushing.
    await this.messageProcessor.drainAllRecorders();

    // Wait for admitted runtime starts before scanning active runtimes.
    await this.messageProcessor.drainPendingRuntimeStarts();

    for (const [sessionId, session] of this.claudeSessions.entries()) {
      if (session.active && session.agent) {
        await this.messageProcessor.stopRuntime(sessionId, session.agent);
      }
    }

    // Stop all reachable chat owners before clearing admission; preserve handoffs.
    await this.chatManager.stopAll({ preserveHandoffs: true });

    for (const sessionId of this.claudeSessions.keys()) {
      // Idempotently release any project admission acquired at runtime completion.
      this.messageProcessor.releaseProjectSessionResources(sessionId);
    }

    let finalPersistenceError: Error | null = null;
    try {
      if ((await this.saveSessionsToDisk()) === false) {
        finalPersistenceError = new Error(
          'Workspace session state could not be flushed during shutdown',
        );
      }
    } catch (error) {
      finalPersistenceError = Object.assign(
        new Error('Workspace session state could not be flushed during shutdown'),
        { cause: error },
      );
    }

    // Let workspace requests release project leases before closing SQLite.
    await closeListener;

    this.claudeSessions.clear();
    this.webSocketConnections.clear();

    // Drain SQLite writers after runtime release and before environment/database teardown.
    await this.projects.shutdown();

    // Stop containers without removing user data.
    if (this.environments.enabled) {
      await this.environments.stopAll();
    }

    this.listener = null;
    this.server = null;
    this.listenerSockets.clear();
    // Close artifact leases before the final database handle.
    this.shutdownTerminalError = finalPersistenceError;
    this.shutdownFinalizationPending = true;
    await this.finishShutdownStorage();
  }

  protected async finishShutdownStorage(): Promise<void> {
    let shutdownFailure: unknown = null;
    const finish = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { shutdownFailure ??= error; }
    };
    await finish(() => this.sessionStore.closeWorkspaces());
    await finish(() => closeWorkspaceSessionDirectoryLeases());
    await finish(() => closeWorkspaceCwdHelpers());
    try {
      this.database.close();
      this.dataDirWritersClosed = true;
    } catch (error) {
      shutdownFailure ??= error;
    }
    if (shutdownFailure) throw shutdownFailure;
    this.shutdownFinalizationPending = false;
    if (this.shutdownTerminalError) throw this.shutdownTerminalError;
  }

  protected setupExpress(): void {
    const publicDir = path.join(__dirname, '..', 'public');

    if (this.desktop) {
      this.app.use((req, res, next) => {
        const expected = this.localUrl;
        const origin = req.headers.origin;
        const fetchSite = req.headers['sec-fetch-site'];
        if (
          !expected
          || req.headers.host !== new URL(expected).host
          || (origin !== undefined && origin !== expected)
          // Require expected desktop host and any provided origin; Fetch Metadata distinguishes loopback ports.
          || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
        ) {
          res.status(403).json({ error: 'desktop_origin_required' });
          return;
        }
        next();
      });
    } else {
      // Desktop requires exact origin; browser deployments retain CORS reads.
      this.app.use(cors());
    }
    // Never persist conversation or session API data in browser storage.
    this.app.use('/api', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    const jsonParser = express.json();
    this.app.use((req, res, next) => {
      // Leave uploads unread for the route-scoped raw parser and its 20 MiB limit.
      if (
        isChatAttachmentUploadRequest(req.method, req.path)
      ) {
        next();
        return;
      }
      jsonParser(req, res, next);
    });
    registerServerIdentityRoute(this.app, this.serverIdentity);
    this.app.use(this.authService.attachRequestContext());

    this.app.get('/login', this.authService.handleLoginPage);
    this.app.get('/auth/github/login', this.authService.handleGitHubLogin);
    this.app.get('/auth/github/callback', this.authService.handleGitHubCallback);
    this.app.get('/auth/logout', this.authService.handleLogout);
    this.app.get('/api/auth/me', this.authService.handleCurrentUser);

    // Offer the public, no-private-key CA before sign-in so clients can establish trusted TLS.
    this.app.get('/ca.crt', caCertificateHandler(() => this.caFile));

    this.app.get('/manifest.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.sendFile('manifest.json', { root: publicDir });
    });

    // Protect direct index requests before static middleware can serve them.
    this.app.get(
      ['/', '/index.html'],
      this.authService.requireAuth(),
      (_req, res) => {
        res.sendFile('index.html', { root: publicDir });
      },
    );

    this.app.use(express.static(publicDir, { index: false }));

    // Static, build-generated icon assets include the required PNG touch icon.

    registerRoutes(this.app, {
      ...this.sessionRouteDeps(),
      folderMode: this.folderMode,
      aliases: this.aliases,
      supportedShells: this.terminalBridge.getSupportedShells(),
      logoutUrl: this.desktop ? null : '/auth/logout',
      repositoryInspectionSupported: process.platform !== 'win32',
      containerizedEnvironmentsEnabled: this.containerizedEnvironmentsEnabled,
      isPathWithinBase: (targetPath: string, userId?: number) =>
        this.isPathWithinBase(targetPath, userId),
      ensureEnvironment: (userId?: number) => this.ensureEnvironment(userId),
      environments: this.environments,
      getUserEnvironmentTier: (userId: number) => this.database.getUserSetting(userId, 'environmentTier'),
      setUserEnvironmentTier: (userId: number, tier: string | null) => {
        if (tier) {
          this.database.setUserSetting(userId, 'environmentTier', tier);
        } else {
          this.database.deleteUserSetting(userId, 'environmentTier');
        }
      },
      userHasLiveSession: (userId: number) => this.userHasLiveSession(userId),
      setSelectedWorkingDir: (userId: number, value: string | null) =>
        this.setSelectedWorkingDir(userId, value),
      pasteStore: this.pasteStore,
      attachmentStore: this.attachmentStore,
      runtimeProfiles: this.runtimeProfiles,
      userPreferences: this.userPreferences,
      getUserPreferences: (userId: number) => this.userPreferences.get(userId),
      tierContext: this.tierContext,
      applyProfilesToOpenChats: () => this.applyProfilesToOpenChats(),
      getUserModelDefaults: (userId: number) => this.getUserModelDefaults(userId),
      updateChecker: this.updateChecker,
      selfUpdate: this.selfUpdate,
      getUpdateMode: () => this.getUpdateMode(),
      getInstallerUserId: () => this.database.getInstallerUserId(),
      maintenance: this.agentMaintenance,
      resolveTarget: (input) => this.resolveAgentMaintenanceTarget(input),
      deployTargetsEnabled: this.containerizedEnvironmentsEnabled,
      deployTargets: this.deployTargets,
      deployTargetDataDir: this.database.storageDir,
      createDeployEngine: (deployConfig) => createEngine(deployConfig),
      // Use manager-owned engines so edited/deleted target containers remain visible.
      enginesForDeployTargets: () => this.environments.reachableEngines(),
      legacyContainersEnabled: this.legacyContainerConfig.enabled,
      reloadDeployTargets: () => this.reloadDeployTargets(),
      projectIdsForTarget: (targetId: string) => this.projectStore.projectIdsForTarget(targetId),
      getDeploySetting: (key: string) => this.database.getSetting(key),
      setDeploySetting: (key: string, value: string) => this.database.setSetting(key, value),
      deleteDeploySetting: (key: string) => this.database.deleteSetting(key),
      manager: this.projects,
      projectStore: this.projectStore,
      storageUsage: this.storageUsage,
      tokenValidator: this.connectedHostValidator,
      synchronizeHostCredentialReplacement: (userId, host, mutation) =>
        this.projects.synchronizeHostCredentialReplacement(userId, host, mutation),
      disconnectHostCredentials: async (userId: number, host: string) => {
        const result = await this.projects.disconnectHostCredentials(userId, host);
        if (!result.ok) throw new Error(result.detail || result.reason);
        return true;
      },
      providerDefault: (user) => this.projectAuthorFor(user.id),
      targetNameFor: (project) => this.projects.targetNameFor(project),
      projectAvailability: () => {
        try {
          return {
            available: true,
            defaultExecutionKind: this.environments.newProjectPlacement().kind,
          };
        } catch (error) {
          return {
            available: false,
            message: error instanceof Error ? error.message : 'Project placement is unavailable.',
          };
        }
      },
      getInterruptedUpdate: () => {
        // Consume once so the browser can retry an interrupted update.
        const interrupted = this.interruptedUpdate;
        this.interruptedUpdate = null;
        return interrupted;
      },
      // Omit unavailable usage rather than report a misleading zero.
      usageStore: this.usageStore,
      usageBurn: (userId, agent, hours) => this.usageStore.burn(userId, agent, hours),
      readCachedClaudeAccount: () => readCachedClaudeAccount(),
    });

  }

  /** Returns false when setup installs a background service that owns the port. */
  async runSetupIfNeeded(): Promise<boolean> {
    if (this.desktop) return true;
    const needsAuthSetup = this.setup || !this.authService.isConfigured();
    if (!needsAuthSetup) {
      return true;
    }

    const session = new PromptSession();
    try {
      await this.authService.ensureConfiguredInteractive(this.setup, session);

      const action = await runRunModeWizard(
        {
          port: this.port,
          dataDir: this.dataDir,
          cwd: process.cwd(),
        },
        session,
      );
      return action === 'run-foreground';
    } finally {
      session.close();
    }
  }

  /** Actual loopback URL after start; useful when port: 0 was requested. */
  get localUrl(): string | null {
    const address = this.listener?.address();
    if (!address || typeof address === 'string') return null;
    return `${this.useHttps ? 'https' : 'http'}://${address.address}:${address.port}`;
  }

  /** Cookie metadata for an Electron/WebView session API to set before loading. */
  get desktopAuthCookie(): { name: string; value: string; httpOnly: true; sameSite: 'strict' } | null {
    if (!this.desktop) return null;
    return {
      name: DESKTOP_AUTH_COOKIE_NAME,
      value: this.desktop.authToken,
      httpOnly: true,
      sameSite: 'strict',
    };
  }

  async start(): Promise<http.Server | https.Server> {
    if (this.startAttempted || this.isShuttingDown || !this.dataDirLease) {
      throw new Error('This server instance cannot be started more than once');
    }
    this.startAttempted = true;
    this.startInProgress = true;
    try {
      const server = await this.startWithDataDirLeaseHeld();
      this.throwIfStartupWasCancelled();
      return server;
    } catch (error) {
      this.shutdownRequested = true;
      this.isShuttingDown = true;
      try {
        // Avoid public shutdown(), which waits for this in-flight start.
        await this.beginShutdown();
      } catch (cleanupError) {
        if (error instanceof Error) Object.assign(error, { cleanupError });
      }
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  protected throwIfStartupWasCancelled(): void {
    if (!this.shutdownRequested) return;
    throw Object.assign(new Error('Server startup was cancelled by shutdown'), {
      code: 'server_shutdown',
    });
  }

  protected async startWithDataDirLeaseHeld(): Promise<http.Server | https.Server> {
    // Quiesce managed runtimes before restoring staged plaintext archives.
    if (this.containerizedEnvironmentsEnabled) {
      await this.projects.reconcileOnBoot();
      this.throwIfStartupWasCancelled();
    } else {
      // Disabled containers must not contact or reconcile deploy engines.
      this.projectStore.clearSessionLeases();
    }
    await this.restoreStagedProjectSessionArchives();
    this.throwIfStartupWasCancelled();
    // Load sessions only after staged archives are restored or marked unavailable.
    await this.loadPersistedSessions();
    this.throwIfStartupWasCancelled();
    // Start autosave only after restoration and workspace discovery.
    this.setupAutoSave();

    // Surface an interrupted update marker instead of claiming update health.
    this.interruptedUpdate = this.selfUpdate.takeInterrupted();
    if (this.interruptedUpdate) {
      console.warn(
        'A previous self-update did not finish. If the server misbehaves, reinstall with:\n'
        + `  ${INSTALL_COMMAND}`,
      );
    }

    if (!this.desktop) {
      // Delay the nonblocking server update check; desktop uses its own updater.
      const firstCheck = setTimeout(() => {
        void this.updateChecker.check(false).catch(() => undefined);
      }, 60_000);
      firstCheck.unref?.();
      this.updateChecker.start();
    }

    // Direct start() callers still require configured authentication.
    await this.authService.ensureConfiguredInteractive(false);
    this.throwIfStartupWasCancelled();

    if (this.desktop) {
      const server = http.createServer(this.app);
      this.wss = new WebSocket.Server({ server });
      this.wss.on('connection', (ws: WebSocket, req) => {
        const expected = this.localUrl;
        if (
          !expected
          || req.headers.host !== new URL(expected).host
          || req.headers.origin !== expected
        ) {
          ws.close(4403, 'Desktop origin required');
          return;
        }
        this.wsHandler.handleConnection(ws, req);
      });
      server.on('connection', (socket) => {
        this.listenerSockets.add(socket);
        socket.once('close', () => this.listenerSockets.delete(socket));
      });
      this.projects.startSweep();
      return await new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          this.projects.stopSweep();
          reject(error);
        };
        server.once('error', onError);
        server.listen(this.port, this.host, () => {
          server.off('error', onError);
          this.server = server;
          this.listener = server;
          if (this.shutdownRequested) {
            reject(Object.assign(new Error('Server startup was cancelled by shutdown'), {
              code: 'server_shutdown',
            }));
            return;
          }
          // Discovery only responds to explicit LAN protocol requests.
          this.lanDiscovery.start();
          resolve(server);
        });
      });
    }

    // HTTPS is required for secure non-loopback browser features; explicit certs win,
    // otherwise generate a local CA certificate.
    if (!this.certFile || !this.keyFile) {
      const material = ensureCertificates(this.dataDir);
      this.certFile = material.certFile;
      this.keyFile = material.keyFile;
      this.caFile = material.caFile;
      if (material.issued) {
        console.log(`Issued a TLS certificate for: ${material.hosts.join(', ')}`);
      }
    }

    const secure = https.createServer(
      { cert: fs.readFileSync(this.certFile), key: fs.readFileSync(this.keyFile) },
      this.app,
    );

    this.wss = new WebSocket.Server({ server: secure });
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.wsHandler.handleConnection(ws, req);
    });

    const server = createHttpsOnlyPort(secure);
    server.on('connection', (socket) => {
      this.listenerSockets.add(socket);
      socket.once('close', () => this.listenerSockets.delete(socket));
    });

    // Start sweeping only after all pre-bind work succeeds.
    this.throwIfStartupWasCancelled();
    this.projects.startSweep();
    return await new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.projects.stopSweep();
        reject(error);
      };
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        this.server = secure;
        this.listener = server;
        if (this.shutdownRequested) {
          reject(Object.assign(new Error('Server startup was cancelled by shutdown'), {
            code: 'server_shutdown',
          }));
          return;
        }
        // The HTTP(S) listener is live before discovery can advertise it.
        this.lanDiscovery.start();
        resolve(secure);
      });
    });
  }


  close(): void {
    void this.shutdown();
  }

}
