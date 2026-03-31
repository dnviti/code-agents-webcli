import { randomUUID } from 'node:crypto';
import {
  AgentKind,
  Aliases,
  BridgeInterface,
  PathValidation,
  RuntimeSession,
  SessionRecord,
  WebSocketInfo,
} from '../types.js';
import { TranscriptStoreLike } from '../services/transcript-store.js';
import { sendToWebSocket, broadcastToSession } from './handler.js';

export interface MessageProcessorDeps {
  dev: boolean;
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  baseFolder: string;
  sessionDurationHours: number;
  aliases: Aliases;
  validatePath(targetPath: string): PathValidation;
  getSelectedWorkingDir(userId: number): string | null;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
  }): SessionRecord;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  saveSessionsToDisk(): Promise<void>;
  transcriptStore: TranscriptStoreLike;
  usageReader: {
    getCurrentSessionStats(): Promise<any>;
    calculateBurnRate(minutes: number): Promise<any>;
    detectOverlappingSessions(): Promise<any[]>;
    getUsageStats(hours: number): Promise<any>;
  };
  usageAnalytics: {
    startSession(sessionId: string, startTime: Date): void;
    addUsageData(data: any): void;
    getAnalytics(): any;
    currentPlan: string;
    planLimits: Record<string, any>;
  };
}

interface IncomingMessage {
  type: string;
  name?: string;
  workingDir?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
  data?: string;
  cols?: number;
  rows?: number;
  command?: string;
}

export class MessageProcessor {
  private deps: MessageProcessorDeps;

  constructor(deps: MessageProcessorDeps) {
    this.deps = deps;
  }

  async handleMessage(wsId: string, data: IncomingMessage): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    switch (data.type) {
      case 'create_session':
        await this.createAndJoinSession(wsId, data.name, data.workingDir);
        break;

      case 'join_session':
        await this.joinSession(wsId, data.sessionId!);
        break;

      case 'leave_session':
        await this.leaveSession(wsId);
        break;

      case 'start_claude':
        await this.startRuntime(wsId, 'claude', data.options || {});
        break;

      case 'start_codex':
        await this.startRuntime(wsId, 'codex', data.options || {});
        break;

      case 'start_agent':
        await this.startRuntime(wsId, 'agent', data.options || {});
        break;

      case 'start_terminal':
        await this.startRuntime(wsId, 'terminal', data.options || {});
        break;

      case 'input':
        await this.handleInput(wsId, wsInfo, data.data || '');
        break;

      case 'resize':
        await this.handleResize(wsId, wsInfo, data.cols || 80, data.rows || 24);
        break;

      case 'stop':
        await this.handleStop(wsInfo);
        break;

      case 'ping':
        sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'get_usage':
        await this.handleGetUsage(wsInfo);
        break;

      default:
        if (this.deps.dev) {
          console.log(`Unknown message type: ${data.type}`);
        }
    }
  }

  async createAndJoinSession(
    wsId: string,
    name?: string,
    workingDir?: string
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    let validWorkingDir = this.deps.baseFolder;
    if (workingDir) {
      const validation = this.deps.validatePath(workingDir);
      if (!validation.valid) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    } else {
      validWorkingDir = this.deps.getSelectedWorkingDir(wsInfo.userId) || this.deps.baseFolder;
    }

    const sessionId = randomUUID();
    const session = this.deps.createSessionRecord({
      id: sessionId,
      ownerUserId: wsInfo.userId,
      name,
      workingDir: validWorkingDir,
      connections: [wsId],
    });

    this.deps.claudeSessions.set(sessionId, session);
    wsInfo.claudeSessionId = sessionId;
    void this.deps.transcriptStore.ensureTranscript(session);

    this.deps.saveSessionsToDisk();

    sendToWebSocket(wsInfo.ws, {
      type: 'session_created',
      sessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
    });
  }

  async joinSession(wsId: string, claudeSessionId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.deps.claudeSessions.get(claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found',
      });
      return;
    }

    // Leave current session if any
    if (wsInfo.claudeSessionId) {
      await this.leaveSession(wsId);
    }

    // Join new session
    wsInfo.claudeSessionId = claudeSessionId;
    session.connections.add(wsId);
    session.lastActivity = new Date();
    session.lastAccessed = Date.now();

    const transcriptChunks = await this.deps.transcriptStore.readTranscriptChunks(session);
    const replayBuffer =
      transcriptChunks.length > 0 ? transcriptChunks : session.outputBuffer.slice(-200);

    // Send session info and replay buffer
    sendToWebSocket(wsInfo.ws, {
      type: 'session_joined',
      sessionId: claudeSessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      active: session.active,
      agent: session.agent,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
      outputBuffer: replayBuffer,
    });

    if (this.deps.dev) {
      console.log(`WebSocket ${wsId} joined Claude session ${claudeSessionId}`);
    }
  }

  async leaveSession(wsId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session) {
      session.connections.delete(wsId);
      session.lastActivity = new Date();
    }

    wsInfo.claudeSessionId = null;

    sendToWebSocket(wsInfo.ws, {
      type: 'session_left',
    });
  }

  async startRuntime(
    wsId: string,
    agentKind: AgentKind,
    options: Record<string, unknown> = {}
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
      if (wsInfo?.ws) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'No session joined',
        });
      }
      return;
    }

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) return;

    if (session.active) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'A process is already running in this session',
      });
      return;
    }

    const bridge = this.deps.getRuntimeBridge(agentKind);
    if (!bridge) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Unsupported runtime: ${agentKind}`,
      });
      return;
    }

    const sessionId = wsInfo.claudeSessionId;
    const previousOutputBuffer = [...session.outputBuffer];
    session.outputBuffer = [];

    try {
      const runtimeSession = (await bridge.startSession(sessionId, {
        workingDir: session.workingDir,
        onOutput: (data: string) => {
          this.appendOutputToSession(sessionId, data);
          broadcastToSession(
            sessionId,
            { type: 'output', data },
            this.deps.claudeSessions,
            this.deps.webSocketConnections
          );
        },
        onExit: (code: number | null, signal: string | null) => {
          const currentSession = this.deps.claudeSessions.get(sessionId);
          if (!currentSession) return;

          const stopRequested = currentSession.stopRequested;
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

          if (!stopRequested) {
            broadcastToSession(
              sessionId,
              {
                type: 'exit',
                code,
                signal,
                agent: currentSession.lastAgent,
                runtimeLabel: currentSession.runtimeLabel,
              },
              this.deps.claudeSessions,
              this.deps.webSocketConnections
            );
          }
        },
        onError: (error: Error) => {
          const currentSession = this.deps.claudeSessions.get(sessionId);
          if (!currentSession) return;

          const stopRequested = currentSession.stopRequested;
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

          if (!stopRequested) {
            broadcastToSession(
              sessionId,
              {
                type: 'error',
                message: error.message,
              },
              this.deps.claudeSessions,
              this.deps.webSocketConnections
            );
          }
        },
        ...options,
      })) as RuntimeSession;

      session.active = true;
      session.agent = agentKind;
      session.lastAgent = agentKind;
      session.stopRequested = false;
      session.lastActivity = new Date();
      session.runtimeLabel =
        agentKind === 'terminal'
          ? runtimeSession.runtimeLabel || 'Terminal'
          : this.getRuntimeLabel(agentKind, session);
      session.terminalOptions =
        agentKind === 'terminal'
          ? {
              mode: (runtimeSession.terminalMode as 'shell' | 'command') || 'shell',
              shell: runtimeSession.shell || '/bin/sh',
              command:
                runtimeSession.terminalMode === 'command'
                  ? typeof options.command === 'string'
                    ? options.command.trim()
                    : ''
                  : null,
            }
          : null;

      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }

      broadcastToSession(
        sessionId,
        {
          type: `${agentKind}_started`,
          sessionId,
          agent: agentKind,
          runtimeLabel: session.runtimeLabel,
        },
        this.deps.claudeSessions,
        this.deps.webSocketConnections
      );
    } catch (error: unknown) {
      session.outputBuffer = previousOutputBuffer;

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.deps.dev) {
        console.error(
          `Error starting ${agentKind} in session ${wsInfo.claudeSessionId}:`,
          error
        );
      }
      const message = errorMessage.startsWith('Failed to start')
        ? errorMessage
        : `Failed to start ${this.getRuntimeErrorLabel(agentKind)}: ${errorMessage}`;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message,
      });
    }
  }

  async stopRuntime(sessionId: string, agentKind: AgentKind): Promise<void> {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || !session.active) return;

    const bridge = this.deps.getRuntimeBridge(agentKind);
    if (!bridge) return;

    session.stopRequested = true;
    await bridge.stopSession(sessionId);
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();

    broadcastToSession(
      sessionId,
      {
        type: `${agentKind}_stopped`,
        sessionId,
        agent: agentKind,
        runtimeLabel: session.runtimeLabel,
      },
      this.deps.claudeSessions,
      this.deps.webSocketConnections
    );
  }

  private async handleInput(
    wsId: string,
    wsInfo: WebSocketInfo,
    inputData: string
  ): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || !session.connections.has(wsId)) return;

    if (session.active && session.agent) {
      try {
        const bridge = this.deps.getRuntimeBridge(session.agent);
        if (bridge) {
          await bridge.sendInput(wsInfo.claudeSessionId, inputData);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this.deps.dev) {
          console.error(
            `Failed to send input to session ${wsInfo.claudeSessionId}:`,
            errorMessage
          );
        }
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Nothing is running in this session. Please start one first.',
        });
      }
    } else {
      sendToWebSocket(wsInfo.ws, {
        type: 'info',
        message: 'No process is running. Choose an option to start.',
      });
    }
  }

  private async handleResize(
    wsId: string,
    wsInfo: WebSocketInfo,
    cols: number,
    rows: number
  ): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || !session.connections.has(wsId)) return;

    if (session.active && session.agent) {
      try {
        const bridge = this.deps.getRuntimeBridge(session.agent);
        if (bridge) {
          await bridge.resize(wsInfo.claudeSessionId, cols, rows);
        }
      } catch (error) {
        if (this.deps.dev) {
          console.log(
            `Resize ignored - process not active in session ${wsInfo.claudeSessionId}`
          );
        }
      }
    }
  }

  private async handleStop(wsInfo: WebSocketInfo): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session?.active && session?.agent) {
      await this.stopRuntime(wsInfo.claudeSessionId, session.agent);
    }
  }

  private async handleGetUsage(wsInfo: WebSocketInfo): Promise<void> {
    try {
      const currentSessionStats = await this.deps.usageReader.getCurrentSessionStats();
      const burnRateData = await this.deps.usageReader.calculateBurnRate(60);
      const overlappingSessions = await this.deps.usageReader.detectOverlappingSessions();
      const dailyStats = await this.deps.usageReader.getUsageStats(24);

      // Update analytics with current session data
      const stats = currentSessionStats as Record<string, unknown> | null;
      if (stats && stats.sessionStartTime) {
        this.deps.usageAnalytics.startSession(
          stats.sessionId as string,
          new Date(stats.sessionStartTime as string)
        );

        if ((stats.totalTokens as number) > 0) {
          const models = stats.models as Record<string, unknown>;
          this.deps.usageAnalytics.addUsageData({
            tokens: stats.totalTokens,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            cacheCreationTokens: stats.cacheCreationTokens,
            cacheReadTokens: stats.cacheReadTokens,
            cost: stats.totalCost,
            model: Object.keys(models)[0] || 'unknown',
            sessionId: stats.sessionId,
          });
        }
      }

      const analytics = this.deps.usageAnalytics.getAnalytics();

      // Calculate session timer
      let sessionTimer: Record<string, unknown> | null = null;
      if (stats && stats.sessionStartTime) {
        const startTime = new Date(stats.sessionStartTime as string);
        const now = new Date();
        const elapsedMs = now.getTime() - startTime.getTime();

        const sessionDurationMs = this.deps.sessionDurationHours * 60 * 60 * 1000;
        const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);

        const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
        const minutes = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((elapsedMs % (1000 * 60)) / 1000);

        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor(
          (remainingMs % (1000 * 60 * 60)) / (1000 * 60)
        );

        const analyticsData = analytics as { predictions?: { depletionTime?: unknown; confidence?: unknown } };
        const burnRate = burnRateData as { rate?: unknown; confidence?: unknown };

        sessionTimer = {
          startTime: stats.sessionStartTime,
          elapsed: elapsedMs,
          remaining: remainingMs,
          formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
          remainingFormatted: `${String(remainingHours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`,
          hours,
          minutes,
          seconds,
          remainingMs,
          sessionDurationHours: this.deps.sessionDurationHours,
          sessionNumber: (stats.sessionNumber as number) || 1,
          isExpired: remainingMs === 0,
          burnRate: burnRate.rate,
          burnRateConfidence: burnRate.confidence,
          depletionTime: analyticsData.predictions?.depletionTime,
          depletionConfidence: analyticsData.predictions?.confidence,
        };
      }

      sendToWebSocket(wsInfo.ws, {
        type: 'usage_update',
        sessionStats: stats || {
          requests: 0,
          totalTokens: 0,
          totalCost: 0,
          message: 'No active Claude session',
        },
        dailyStats,
        sessionTimer,
        analytics,
        burnRate: burnRateData,
        overlappingSessions: overlappingSessions.length,
        plan: this.deps.usageAnalytics.currentPlan,
        limits:
          this.deps.usageAnalytics.planLimits[this.deps.usageAnalytics.currentPlan],
      });
    } catch (error) {
      console.error('Error getting usage stats:', error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to retrieve usage statistics',
      });
    }
  }

  private appendOutputToSession(sessionId: string, data: string): void {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session) return;

    session.outputBuffer.push(data);
    if (session.outputBuffer.length > session.maxBufferSize) {
      session.outputBuffer.shift();
    }

    this.deps.transcriptStore.appendOutput(session, data);
  }

  private getRuntimeLabel(agentKind: AgentKind, session: SessionRecord | null = null): string {
    switch (agentKind) {
      case 'codex':
        return this.deps.aliases.codex;
      case 'agent':
        return this.deps.aliases.agent;
      case 'terminal':
        return session?.runtimeLabel || 'Terminal';
      case 'claude':
      default:
        return this.deps.aliases.claude;
    }
  }

  private getRuntimeErrorLabel(agentKind: AgentKind): string {
    switch (agentKind) {
      case 'codex':
        return 'Codex Code';
      case 'agent':
        return 'Agent';
      case 'terminal':
        return 'terminal';
      case 'claude':
      default:
        return 'Claude Code';
    }
  }
}
