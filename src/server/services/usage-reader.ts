import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { createReadStream } from 'fs';

export interface UsageEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  sessionId?: string;
  messageId: string | null;
  requestId: string | null;
}

export interface ModelStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageStats {
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cacheTokens: number;
  totalCost: number;
  periodHours: number;
  firstEntry: string | null;
  lastEntry: string | null;
  models: Record<string, ModelStats>;
  hourlyRate: number;
  projectedDaily: number;
  tokensPerHour?: number;
  costPerHour?: number;
  requestPercentage?: number;
  tokenPercentage?: number;
}

export interface SessionStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheTokens: number;
  totalTokens: number;
  totalCost: number;
  models: Record<string, ModelStats>;
  sessionStartTime: string;
  lastUpdate: string | null;
  sessionId: string;
  sessionNumber: number;
  isExpired: boolean;
  remainingTokens: number | null;
}

export interface AllTimeStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheTokens: number;
  totalTokens: number;
  totalCost: number;
  models: Record<string, ModelStats>;
  firstRequest: string | null;
  lastRequest: string | null;
}

export interface SessionBoundary {
  sessionNumber: number;
  startTime: Date;
  endTime: Date;
  sessionId: string;
}

export interface SessionUsageStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheTokens: number;
  totalTokens: number;
  totalCost: number;
  models: Record<string, ModelStats>;
  sessionId: string;
  lastUpdate: string | null;
  firstRequestTime: string | null;
}

export interface OverlappingSession {
  startTime: string;
  endTime: Date;
  entries: UsageEntry[];
  totalTokens: number;
  totalCost: number;
}

export interface BurnRate {
  rate: number;
  confidence: number;
  dataPoints?: number;
}

export interface RecentSession {
  sessionId: string;
  startTime: string;
  endTime: string;
  requests: number;
  totalTokens: number;
  cost: number;
}

export class UsageReader {
  private claudeProjectsPath: string;
  private cache: UsageStats | null = null;
  private cacheTime: number | null = null;
  private cacheTimeout: number = 5000;
  private sessionDurationHours: number;
  private overlappingSessions: Array<{
    session1: OverlappingSession;
    session2: OverlappingSession;
    overlapStart: Date;
    overlapEnd: Date;
  }> = [];

  constructor(sessionDurationHours: number = 5) {
    this.claudeProjectsPath = path.join(
      process.env.HOME || '',
      '.claude',
      'projects',
    );
    this.sessionDurationHours = sessionDurationHours;
  }

  normalizeModelName(model: string | undefined | null): string {
    if (!model || typeof model !== 'string') {
      return 'unknown';
    }

    const modelLower = model.toLowerCase();

    if (modelLower.includes('opus')) {
      return 'opus';
    } else if (modelLower.includes('sonnet')) {
      return 'sonnet';
    } else if (modelLower.includes('haiku')) {
      return 'haiku';
    }

    return 'unknown';
  }

  createUniqueHash(
    entry: Record<string, unknown>,
  ): string | null {
    const messageId =
      (entry.message_id as string) ||
      (entry.messageId as string) ||
      ((entry.message as Record<string, unknown>)?.id as string) ||
      null;

    const requestId =
      (entry.request_id as string) ||
      (entry.requestId as string) ||
      null;

    if (messageId && requestId) {
      return `${messageId}:${requestId}`;
    }

    return null;
  }

  async getUsageStats(
    hoursBack: number = 24,
  ): Promise<UsageStats | null> {
    if (
      this.cache &&
      this.cacheTime &&
      Date.now() - this.cacheTime < this.cacheTimeout
    ) {
      return this.cache;
    }

    try {
      const cutoffTime = new Date(
        Date.now() - hoursBack * 60 * 60 * 1000,
      );
      const entries = await this.readAllEntries(cutoffTime);

      const stats = this.calculateStats(entries, hoursBack);

      this.cache = stats;
      this.cacheTime = Date.now();

      return stats;
    } catch (error) {
      console.error('Error reading usage stats:', error);
      return null;
    }
  }

  async getCurrentSessionStats(): Promise<SessionStats | null> {
    try {
      const currentSession = await this.getCurrentSession();

      if (!currentSession) {
        return null;
      }

      const startOfDay = this.getStartOfCurrentDay();
      const allTodayEntries =
        await this.readAllEntries(startOfDay);

      if (allTodayEntries.length === 0) {
        return null;
      }

      const sessionEntries = allTodayEntries.filter((entry) => {
        const entryTime = new Date(entry.timestamp);
        return (
          entryTime >= currentSession.startTime &&
          entryTime <= currentSession.endTime
        );
      });

      sessionEntries.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime(),
      );

      const stats: SessionStats = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: {},
        sessionStartTime: currentSession.startTime.toISOString(),
        lastUpdate: null,
        sessionId: currentSession.sessionId,
        sessionNumber: currentSession.sessionNumber,
        isExpired: new Date() > currentSession.endTime,
        remainingTokens: null,
      };

      for (const entry of sessionEntries) {
        stats.requests++;
        stats.inputTokens += entry.inputTokens;
        stats.outputTokens += entry.outputTokens;
        stats.cacheCreationTokens += entry.cacheCreationTokens;
        stats.cacheReadTokens += entry.cacheReadTokens;
        stats.totalCost += entry.totalCost;
        stats.lastUpdate = entry.timestamp;

        const model = entry.model || 'unknown';
        if (!stats.models[model]) {
          stats.models[model] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          };
        }

        stats.models[model].requests++;
        stats.models[model].inputTokens += entry.inputTokens;
        stats.models[model].outputTokens += entry.outputTokens;
        stats.models[model].cost += entry.totalCost;
      }

      stats.cacheTokens =
        stats.cacheCreationTokens + stats.cacheReadTokens;
      stats.totalTokens = stats.inputTokens + stats.outputTokens;

      return stats;
    } catch (error) {
      console.error(
        'Error reading current session stats:',
        error,
      );
      return null;
    }
  }

  async getAllTimeUsageStats(): Promise<AllTimeStats | null> {
    try {
      const entries = await this.readAllEntries(new Date(0));

      const stats: AllTimeStats = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: {},
        firstRequest: null,
        lastRequest: null,
      };

      for (const entry of entries) {
        stats.requests++;
        stats.inputTokens += entry.inputTokens;
        stats.outputTokens += entry.outputTokens;
        stats.cacheCreationTokens += entry.cacheCreationTokens;
        stats.cacheReadTokens += entry.cacheReadTokens;
        stats.totalCost += entry.totalCost;

        if (
          !stats.firstRequest ||
          new Date(entry.timestamp) <
            new Date(stats.firstRequest)
        ) {
          stats.firstRequest = entry.timestamp;
        }
        if (
          !stats.lastRequest ||
          new Date(entry.timestamp) >
            new Date(stats.lastRequest)
        ) {
          stats.lastRequest = entry.timestamp;
        }

        const model = entry.model || 'unknown';
        if (!stats.models[model]) {
          stats.models[model] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          };
        }

        stats.models[model].requests++;
        stats.models[model].inputTokens += entry.inputTokens;
        stats.models[model].outputTokens += entry.outputTokens;
        stats.models[model].cost += entry.totalCost;
      }

      stats.cacheTokens =
        stats.cacheCreationTokens + stats.cacheReadTokens;
      stats.totalTokens = stats.inputTokens + stats.outputTokens;

      return stats;
    } catch (error) {
      console.error(
        'Error reading all-time usage stats:',
        error,
      );
      return null;
    }
  }

  async readAllEntries(cutoffTime: Date): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];

    try {
      const files = await this.findJsonlFiles();

      for (const file of files) {
        const fileEntries = await this.readJsonlFile(
          file,
          cutoffTime,
        );
        entries.push(...fileEntries);
      }

      entries.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime(),
      );

      return entries;
    } catch (error) {
      console.error('Error reading entries:', error);
      return [];
    }
  }

  async readRecentEntries(
    cutoffTime: Date,
  ): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];

    try {
      const files = await this.findJsonlFiles(true);

      for (const file of files) {
        const fileEntries = await this.readJsonlFile(
          file,
          cutoffTime,
        );
        entries.push(...fileEntries);
      }

      entries.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime(),
      );

      return entries;
    } catch (error) {
      console.error('Error reading recent entries:', error);
      return [];
    }
  }

  async getMostRecentSessionFile(): Promise<string | null> {
    try {
      const cwd = process.cwd();
      const projectDirName = cwd.replace(/\//g, '-');
      const projectPath = path.join(
        this.claudeProjectsPath,
        projectDirName,
      );

      try {
        await fs.access(projectPath);
      } catch {
        console.log(
          `Project directory not found: ${projectPath}`,
        );
        return null;
      }

      const files = await fs.readdir(projectPath);
      const jsonlFiles = files.filter((f) =>
        f.endsWith('.jsonl'),
      );

      if (jsonlFiles.length === 0) {
        return null;
      }

      let mostRecentFile: string | null = null;
      let mostRecentTime = 0;

      for (const file of jsonlFiles) {
        const filePath = path.join(projectPath, file);
        const stat = await fs.stat(filePath);

        if (stat.mtime.getTime() > mostRecentTime) {
          mostRecentTime = stat.mtime.getTime();
          mostRecentFile = filePath;
        }
      }

      return mostRecentFile;
    } catch (error) {
      console.error(
        'Error finding most recent session file:',
        error,
      );
      return null;
    }
  }

  async findJsonlFiles(
    onlyRecent: boolean = false,
  ): Promise<string[]> {
    const files: string[] = [];

    try {
      const projectDirs = await fs.readdir(
        this.claudeProjectsPath,
      );

      for (const projectDir of projectDirs) {
        const projectPath = path.join(
          this.claudeProjectsPath,
          projectDir,
        );
        const stat = await fs.stat(projectPath);

        if (stat.isDirectory()) {
          const projectFiles = await fs.readdir(projectPath);
          const jsonlFiles = projectFiles.filter((f) =>
            f.endsWith('.jsonl'),
          );

          for (const jsonlFile of jsonlFiles) {
            const filePath = path.join(projectPath, jsonlFile);

            if (onlyRecent) {
              const fileStat = await fs.stat(filePath);
              const hoursSinceModified =
                (Date.now() - fileStat.mtime.getTime()) /
                (1000 * 60 * 60);

              if (hoursSinceModified <= 24) {
                files.push(filePath);
              }
            } else {
              files.push(filePath);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error finding JSONL files:', error);
    }

    return files;
  }

  async readJsonlFile(
    filePath: string,
    cutoffTime: Date,
  ): Promise<UsageEntry[]> {
    const entries: UsageEntry[] = [];
    const fileProcessedEntries = new Set<string>();

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => {
        try {
          const entry = JSON.parse(line) as Record<
            string,
            unknown
          >;

          if (
            entry.timestamp &&
            new Date(entry.timestamp as string) >= cutoffTime
          ) {
            const uniqueHash = this.createUniqueHash(entry);
            if (
              uniqueHash &&
              fileProcessedEntries.has(uniqueHash)
            ) {
              return;
            }

            const message = entry.message as
              | Record<string, unknown>
              | undefined;
            const usage = (entry.usage ||
              (message && message.usage)) as
              | Record<string, number>
              | undefined;
            const rawModel =
              (entry.model as string) ||
              (message && (message.model as string)) ||
              'unknown';
            const model = this.normalizeModelName(rawModel);

            const isAssistant =
              entry.type === 'assistant' ||
              (message && message.role === 'assistant');

            if (isAssistant && usage) {
              const inputTokens =
                usage.input_tokens || 0;
              const outputTokens =
                usage.output_tokens || 0;
              const cacheCreationTokens =
                usage.cache_creation_input_tokens || 0;
              const cacheReadTokens =
                usage.cache_read_input_tokens || 0;

              let totalCost = 0;
              if (model === 'opus') {
                totalCost =
                  inputTokens * 0.000015 +
                  outputTokens * 0.000075;
                totalCost +=
                  cacheCreationTokens * 0.000015 +
                  cacheReadTokens * 0.0000015;
              } else if (model === 'sonnet') {
                totalCost =
                  inputTokens * 0.000003 +
                  outputTokens * 0.000015;
                totalCost +=
                  cacheCreationTokens * 0.000003 +
                  cacheReadTokens * 0.0000003;
              } else if (model === 'haiku') {
                totalCost =
                  inputTokens * 0.00000025 +
                  outputTokens * 0.00000125;
                totalCost +=
                  cacheCreationTokens * 0.00000025 +
                  cacheReadTokens * 0.000000025;
              }

              let finalCost = totalCost;
              if (usage.total_cost !== undefined) {
                finalCost =
                  usage.total_cost > 1
                    ? usage.total_cost / 100
                    : usage.total_cost;
              }

              const processedEntry: UsageEntry = {
                timestamp: entry.timestamp as string,
                model,
                inputTokens,
                outputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                totalCost: finalCost,
                sessionId: entry.sessionId as
                  | string
                  | undefined,
                messageId:
                  (entry.message_id as string) ||
                  (entry.messageId as string) ||
                  (message &&
                    (message.id as string)) ||
                  null,
                requestId:
                  (entry.request_id as string) ||
                  (entry.requestId as string) ||
                  null,
              };

              entries.push(processedEntry);

              if (uniqueHash) {
                fileProcessedEntries.add(uniqueHash);
              }
            }
          }
        } catch {
          // Ignore malformed lines
        }
      });

      rl.on('close', () => {
        resolve(entries);
      });

      rl.on('error', (error: Error) => {
        console.error('Error reading file:', filePath, error);
        resolve(entries);
      });
    });
  }

  calculateStats(
    entries: UsageEntry[],
    hoursBack: number,
  ): UsageStats {
    if (!entries || entries.length === 0) {
      return {
        requests: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        periodHours: hoursBack,
        firstEntry: null,
        lastEntry: null,
        models: {},
        hourlyRate: 0,
        projectedDaily: 0,
      };
    }

    const stats: UsageStats = {
      requests: entries.length,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheTokens: 0,
      totalCost: 0,
      periodHours: hoursBack,
      firstEntry: entries[0].timestamp,
      lastEntry: entries[entries.length - 1].timestamp,
      models: {},
      hourlyRate: 0,
      projectedDaily: 0,
    };

    for (const entry of entries) {
      stats.inputTokens += entry.inputTokens;
      stats.outputTokens += entry.outputTokens;
      stats.cacheCreationTokens =
        (stats.cacheCreationTokens || 0) +
        entry.cacheCreationTokens;
      stats.cacheReadTokens =
        (stats.cacheReadTokens || 0) + entry.cacheReadTokens;
      stats.totalCost += entry.totalCost;

      if (!stats.models[entry.model]) {
        stats.models[entry.model] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }

      stats.models[entry.model].requests++;
      stats.models[entry.model].inputTokens +=
        entry.inputTokens;
      stats.models[entry.model].outputTokens +=
        entry.outputTokens;
      stats.models[entry.model].cost += entry.totalCost;
    }

    stats.cacheTokens =
      (stats.cacheCreationTokens || 0) +
      (stats.cacheReadTokens || 0);
    stats.totalTokens = stats.inputTokens + stats.outputTokens;

    if (entries.length > 0) {
      const actualHours =
        (new Date(stats.lastEntry!).getTime() -
          new Date(stats.firstEntry!).getTime()) /
        (1000 * 60 * 60);
      if (actualHours > 0) {
        stats.hourlyRate = stats.requests / actualHours;
        stats.projectedDaily = stats.hourlyRate * 24;
        stats.tokensPerHour =
          stats.totalTokens / actualHours;
        stats.costPerHour = stats.totalCost / actualHours;
      }
    }

    const estimatedDailyLimit = 100;
    const estimatedTokenLimit = 1000000;

    stats.requestPercentage =
      (stats.projectedDaily / estimatedDailyLimit) * 100;
    stats.tokenPercentage =
      (((stats.tokensPerHour || 0) * 24) /
        estimatedTokenLimit) *
      100;

    return stats;
  }

  async getSessionUsageById(
    sessionId: string,
  ): Promise<SessionUsageStats | null> {
    try {
      if (!sessionId) {
        return null;
      }

      const sessionFile = path.join(
        this.claudeProjectsPath,
        path
          .basename(process.cwd())
          .replace(/[^a-zA-Z0-9-]/g, '-'),
        `${sessionId}.jsonl`,
      );

      try {
        await fs.access(sessionFile);
      } catch {
        return null;
      }

      const entries = await this.readJsonlFile(
        sessionFile,
        new Date(0),
      );

      const sessionStats: SessionUsageStats = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: {},
        sessionId,
        lastUpdate: null,
        firstRequestTime: null,
      };

      for (const entry of entries) {
        sessionStats.requests++;
        sessionStats.inputTokens += entry.inputTokens;
        sessionStats.outputTokens += entry.outputTokens;
        sessionStats.cacheCreationTokens +=
          entry.cacheCreationTokens;
        sessionStats.cacheReadTokens +=
          entry.cacheReadTokens;
        sessionStats.totalCost += entry.totalCost;
        sessionStats.lastUpdate = entry.timestamp;

        if (!sessionStats.firstRequestTime) {
          sessionStats.firstRequestTime = entry.timestamp;
        }

        const model = entry.model || 'unknown';
        if (!sessionStats.models[model]) {
          sessionStats.models[model] = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          };
        }

        sessionStats.models[model].requests++;
        sessionStats.models[model].inputTokens +=
          entry.inputTokens;
        sessionStats.models[model].outputTokens +=
          entry.outputTokens;
        sessionStats.models[model].cost += entry.totalCost;
      }

      sessionStats.cacheTokens =
        sessionStats.cacheCreationTokens +
        sessionStats.cacheReadTokens;
      sessionStats.totalTokens =
        sessionStats.inputTokens + sessionStats.outputTokens;

      return sessionStats;
    } catch (error) {
      console.error('Error getting session usage:', error);
      return null;
    }
  }

  async detectOverlappingSessions(): Promise<
    OverlappingSession[]
  > {
    try {
      const now = new Date();
      const lookbackHours = this.sessionDurationHours * 2;
      const cutoff = new Date(
        now.getTime() - lookbackHours * 60 * 60 * 1000,
      );
      const entries = await this.readAllEntries(cutoff);

      if (entries.length === 0) return [];

      const sessions: OverlappingSession[] = [];
      let currentSession: OverlappingSession | null = null;

      for (const entry of entries) {
        if (!currentSession) {
          currentSession = {
            startTime: entry.timestamp,
            endTime: new Date(
              new Date(entry.timestamp).getTime() +
                this.sessionDurationHours * 60 * 60 * 1000,
            ),
            entries: [entry],
            totalTokens:
              entry.inputTokens + entry.outputTokens,
            totalCost: entry.totalCost,
          };
        } else {
          const lastEntry =
            currentSession.entries[
              currentSession.entries.length - 1
            ];
          const timeSinceLastEntry =
            new Date(entry.timestamp).getTime() -
            new Date(lastEntry.timestamp).getTime();
          const gapHours =
            timeSinceLastEntry / (1000 * 60 * 60);

          if (gapHours < this.sessionDurationHours) {
            currentSession.entries.push(entry);
            currentSession.totalTokens +=
              entry.inputTokens + entry.outputTokens;
            currentSession.totalCost += entry.totalCost;
          } else {
            sessions.push(currentSession);
            currentSession = {
              startTime: entry.timestamp,
              endTime: new Date(
                new Date(entry.timestamp).getTime() +
                  this.sessionDurationHours *
                    60 *
                    60 *
                    1000,
              ),
              entries: [entry],
              totalTokens:
                entry.inputTokens + entry.outputTokens,
              totalCost: entry.totalCost,
            };
          }
        }
      }

      if (currentSession) {
        sessions.push(currentSession);
      }

      const overlapping: Array<{
        session1: OverlappingSession;
        session2: OverlappingSession;
        overlapStart: Date;
        overlapEnd: Date;
      }> = [];

      for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
          const s1 = sessions[i];
          const s2 = sessions[j];

          if (
            new Date(s1.startTime) < s2.endTime &&
            new Date(s2.startTime) < s1.endTime
          ) {
            overlapping.push({
              session1: s1,
              session2: s2,
              overlapStart: new Date(
                Math.max(
                  new Date(s1.startTime).getTime(),
                  new Date(s2.startTime).getTime(),
                ),
              ),
              overlapEnd: new Date(
                Math.min(
                  s1.endTime.getTime(),
                  s2.endTime.getTime(),
                ),
              ),
            });
          }
        }
      }

      this.overlappingSessions = overlapping;
      return sessions;
    } catch (error) {
      console.error(
        'Error detecting overlapping sessions:',
        error,
      );
      return [];
    }
  }

  generateSessionId(timestamp: string): string {
    return `session_${new Date(timestamp).getTime()}`;
  }

  async calculateBurnRate(
    minutes: number = 60,
  ): Promise<BurnRate> {
    try {
      const cutoff = new Date(
        Date.now() - minutes * 60 * 1000,
      );
      const entries = await this.readRecentEntries(cutoff);

      if (entries.length < 2) {
        return { rate: 0, confidence: 0 };
      }

      const totalTokens = entries.reduce(
        (sum, e) => sum + e.inputTokens + e.outputTokens,
        0,
      );
      const duration =
        (new Date(
          entries[entries.length - 1].timestamp,
        ).getTime() -
          new Date(entries[0].timestamp).getTime()) /
        1000 /
        60;

      if (duration === 0) {
        return { rate: 0, confidence: 0 };
      }

      const rate = totalTokens / duration;
      const confidence = Math.min(entries.length / 10, 1);

      return { rate, confidence, dataPoints: entries.length };
    } catch (error) {
      console.error('Error calculating burn rate:', error);
      return { rate: 0, confidence: 0 };
    }
  }

  async getRecentSessions(
    limit: number = 5,
  ): Promise<RecentSession[]> {
    try {
      const entries = await this.readAllEntries(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );

      const sessions: Record<string, RecentSession> = {};
      for (const entry of entries) {
        const sessionId = entry.sessionId || 'unknown';
        if (!sessions[sessionId]) {
          sessions[sessionId] = {
            sessionId,
            startTime: entry.timestamp,
            endTime: entry.timestamp,
            requests: 0,
            totalTokens: 0,
            cost: 0,
          };
        }

        sessions[sessionId].endTime = entry.timestamp;
        sessions[sessionId].requests++;
        sessions[sessionId].totalTokens +=
          entry.inputTokens + entry.outputTokens;
        sessions[sessionId].cost += entry.totalCost;
      }

      const sessionArray = Object.values(sessions);
      sessionArray.sort(
        (a, b) =>
          new Date(b.endTime).getTime() -
          new Date(a.endTime).getTime(),
      );

      return sessionArray.slice(0, limit);
    } catch (error) {
      console.error('Error getting recent sessions:', error);
      return [];
    }
  }

  getStartOfCurrentDay(): Date {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay;
  }

  async getDailySessionBoundaries(): Promise<
    SessionBoundary[]
  > {
    try {
      const startOfDay = this.getStartOfCurrentDay();
      const endOfDay = new Date(startOfDay);
      endOfDay.setHours(23, 59, 59, 999);

      const entries = await this.readAllEntries(startOfDay);

      if (entries.length === 0) {
        return [];
      }

      const todayEntries = entries.filter((entry) => {
        const entryTime = new Date(entry.timestamp);
        return entryTime >= startOfDay && entryTime <= endOfDay;
      });

      if (todayEntries.length === 0) {
        return [];
      }

      todayEntries.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime(),
      );

      const sessions: SessionBoundary[] = [];
      let sessionNumber = 1;
      let currentSessionStart: Date | null = null;
      const processedEntries = new Set<string>();

      for (const entry of todayEntries) {
        if (processedEntries.has(entry.timestamp)) {
          continue;
        }

        const entryTime = new Date(entry.timestamp);

        if (
          !currentSessionStart ||
          entryTime >=
            new Date(
              currentSessionStart.getTime() +
                this.sessionDurationHours * 60 * 60 * 1000,
            )
        ) {
          const sessionStart = new Date(entryTime);
          sessionStart.setMinutes(0, 0, 0);

          const sessionEnd = new Date(
            sessionStart.getTime() +
              this.sessionDurationHours * 60 * 60 * 1000,
          );
          const midnightEnd = new Date(endOfDay);
          const actualSessionEnd =
            sessionEnd > midnightEnd
              ? midnightEnd
              : sessionEnd;

          sessions.push({
            sessionNumber,
            startTime: sessionStart,
            endTime: actualSessionEnd,
            sessionId: this.generateSessionId(
              sessionStart.toISOString(),
            ),
          });

          currentSessionStart = sessionStart;
          sessionNumber++;

          for (const e of todayEntries) {
            const eTime = new Date(e.timestamp);
            if (
              eTime >= sessionStart &&
              eTime <= actualSessionEnd
            ) {
              processedEntries.add(e.timestamp);
            }
          }
        }
      }

      return sessions;
    } catch (error) {
      console.error(
        'Error getting daily session boundaries:',
        error,
      );
      return [];
    }
  }

  async getCurrentSession(): Promise<SessionBoundary | null> {
    try {
      const now = new Date();
      const sessions =
        await this.getDailySessionBoundaries();

      for (const session of sessions) {
        if (
          now >= session.startTime &&
          now <= session.endTime
        ) {
          return session;
        }
      }

      return null;
    } catch (error) {
      console.error('Error getting current session:', error);
      return null;
    }
  }
}

export default UsageReader;
