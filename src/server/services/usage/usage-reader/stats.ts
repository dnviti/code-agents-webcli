import * as fs from 'fs/promises';
import * as path from 'path';

import { UsageReaderSessions } from './sessions.js';
import type {
  AllTimeStats,
  SessionStats,
  SessionUsageStats,
  UsageEntry,
  UsageStats,
} from './types.js';

/**
 * Top layer of the `UsageReader` inheritance chain: aggregates parsed entries
 * into the stats objects the rest of the app consumes.
 */
export abstract class UsageReaderStats extends UsageReaderSessions {
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
}
