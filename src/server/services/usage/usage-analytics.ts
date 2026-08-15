import { EventEmitter } from 'events';

/**
 * What this service measures, and what it deliberately no longer claims.
 *
 * It reads Claude Code's own transcript files on this host and computes tokens,
 * cost and a burn rate from them. That much is a measurement.
 *
 * What it used to do on top was draw those measurements against a plan ceiling
 * — a hand-written table of token, dollar and message allowances per Claude
 * subscription tier, selected by a `--plan` flag whose default was `max20`, with
 * a bare `188026` for anything it did not recognise. None of those figures came
 * from Anthropic; a "78% of your plan used" was arithmetic over a guess. So the
 * table, the flag, the fallback and everything derived from them — remaining
 * tokens, percent used, time to depletion — are gone (#137). Where the account
 * actually stands is now only ever what the provider itself said, on the
 * `limits` chat event.
 */

export interface UsageDataPoint {
  timestamp: Date;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  model: string;
  sessionId?: string;
}

export interface AddUsageData {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost?: number;
  model?: string;
  sessionId?: string;
}

export interface AnalyticsSession {
  id: string;
  startTime: Date;
  endTime: Date;
  tokens: number;
  cost: number;
  messages: number;
  isActive: boolean;
  window: string;
}

export interface RollingWindow {
  startTime: Date;
  endTime: Date;
  sessions: string[];
  totalTokens: number;
  totalCost: number;
  burnRate: number;
}

export interface BurnRateEntry {
  timestamp: Date;
  rate: number;
}

export interface BurnRateInfo {
  current: number;
  trend: VelocityTrend;
  history: BurnRateEntry[];
}

export interface SessionAnalytics {
  id: string;
  startTime: Date;
  endTime: Date;
  isActive: boolean;
  tokens: number;
}

export interface AnalyticsData {
  currentSession: {
    id: string;
    startTime: Date;
    endTime: Date;
    tokens: number;
  } | null;
  burnRate: BurnRateInfo;
  windows: RollingWindow[];
  activeSessions: SessionAnalytics[];
}

type VelocityTrend = 'increasing' | 'decreasing' | 'stable';

export interface UsageAnalyticsOptions {
  sessionDurationHours?: number;
  confidenceThreshold?: number;
  burnRateWindow?: number;
  updateInterval?: number;
}

export class UsageAnalytics extends EventEmitter {
  private sessionDurationHours: number;
  private burnRateWindow: number;

  private activeSessions: Map<string, AnalyticsSession> =
    new Map();
  private sessionHistory: AnalyticsSession[] = [];
  private rollingWindows: Map<string, RollingWindow> =
    new Map();

  private recentUsage: UsageDataPoint[] = [];

  private burnRateHistory: BurnRateEntry[] = [];
  private currentBurnRate: number = 0;
  private velocityTrend: VelocityTrend = 'stable';

  constructor(options: UsageAnalyticsOptions = {}) {
    super();

    this.sessionDurationHours =
      options.sessionDurationHours || 5;
    this.burnRateWindow = options.burnRateWindow || 60;
  }

  addUsageData(data: AddUsageData): void {
    const entry: UsageDataPoint = {
      timestamp: new Date(),
      tokens:
        (data.inputTokens || 0) + (data.outputTokens || 0),
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0,
      cacheCreationTokens: data.cacheCreationTokens || 0,
      cacheReadTokens: data.cacheReadTokens || 0,
      cost: data.cost || 0,
      model: data.model || 'unknown',
      sessionId: data.sessionId,
    };

    this.recentUsage.push(entry);

    const cutoff = new Date(
      Date.now() - this.burnRateWindow * 60 * 1000,
    );
    this.recentUsage = this.recentUsage.filter(
      (e) => e.timestamp > cutoff,
    );

    this.calculateBurnRate();

    this.emit('usage-update', entry);
  }

  startSession(
    sessionId: string,
    startTime: Date = new Date(),
  ): AnalyticsSession {
    const session: AnalyticsSession = {
      id: sessionId,
      startTime,
      endTime: new Date(
        startTime.getTime() +
          this.sessionDurationHours * 60 * 60 * 1000,
      ),
      tokens: 0,
      cost: 0,
      messages: 0,
      isActive: true,
      window: 'current',
    };

    this.activeSessions.set(sessionId, session);
    this.updateRollingWindows();

    this.emit('session-started', session);
    return session;
  }

  private updateRollingWindows(): void {
    const now = new Date();
    this.rollingWindows.clear();

    const fiveHoursAgo = new Date(
      now.getTime() -
        this.sessionDurationHours * 60 * 60 * 1000,
    );

    for (const [id, session] of this.activeSessions) {
      if (session.startTime > fiveHoursAgo) {
        const windowId = `window_${session.startTime.getTime()}`;

        if (!this.rollingWindows.has(windowId)) {
          this.rollingWindows.set(windowId, {
            startTime: session.startTime,
            endTime: session.endTime,
            sessions: [],
            totalTokens: 0,
            totalCost: 0,
            burnRate: 0,
          });
        }

        const window = this.rollingWindows.get(windowId)!;
        window.sessions.push(id);
      }
    }

    this.emit(
      'windows-updated',
      Array.from(this.rollingWindows.values()),
    );
  }

  private calculateBurnRate(): void {
    if (this.recentUsage.length < 2) {
      this.currentBurnRate = 0;
      return;
    }

    const sorted = [...this.recentUsage].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    interface WindowRate {
      window: number;
      rate: number;
      weight: number;
    }

    const rates: WindowRate[] = [];
    const windows = [5, 10, 15, 30, 60];

    for (const window of windows) {
      const cutoff = new Date(
        Date.now() - window * 60 * 1000,
      );
      const windowData = sorted.filter(
        (e) => e.timestamp > cutoff,
      );

      if (windowData.length >= 2) {
        const duration =
          (windowData[windowData.length - 1].timestamp.getTime() -
            windowData[0].timestamp.getTime()) /
          1000 /
          60;
        const totalTokens = windowData.reduce(
          (sum, e) => sum + e.inputTokens + e.outputTokens,
          0,
        );

        if (duration > 0) {
          rates.push({
            window,
            rate: totalTokens / duration,
            weight: Math.min(windowData.length / 10, 1),
          });
        }
      }
    }

    if (rates.length === 0) {
      this.currentBurnRate = 0;
      return;
    }

    const totalWeight = rates.reduce(
      (sum, r) => sum + r.weight,
      0,
    );
    this.currentBurnRate =
      rates.reduce(
        (sum, r) => sum + r.rate * r.weight,
        0,
      ) / totalWeight;

    this.burnRateHistory.push({
      timestamp: new Date(),
      rate: this.currentBurnRate,
    });

    const histCutoff = new Date(
      Date.now() - 60 * 60 * 1000,
    );
    this.burnRateHistory = this.burnRateHistory.filter(
      (e) => e.timestamp > histCutoff,
    );

    this.analyzeTrend();

    this.emit('burn-rate-updated', {
      rate: this.currentBurnRate,
      trend: this.velocityTrend,
      confidence: this.calculateConfidence(),
    });
  }

  private analyzeTrend(): void {
    if (this.burnRateHistory.length < 5) {
      this.velocityTrend = 'stable';
      return;
    }

    const mid = Math.floor(this.burnRateHistory.length / 2);
    const oldRates = this.burnRateHistory.slice(0, mid);
    const newRates = this.burnRateHistory.slice(mid);

    const oldAvg =
      oldRates.reduce((sum, e) => sum + e.rate, 0) /
      oldRates.length;
    const newAvg =
      newRates.reduce((sum, e) => sum + e.rate, 0) /
      newRates.length;

    const change = (newAvg - oldAvg) / oldAvg;

    if (change > 0.15) {
      this.velocityTrend = 'increasing';
    } else if (change < -0.15) {
      this.velocityTrend = 'decreasing';
    } else {
      this.velocityTrend = 'stable';
    }
  }

  private calculateConfidence(): number {
    let confidence = 0;
    let factors = 0;

    if (this.recentUsage.length > 0) {
      const dataScore = Math.min(
        this.recentUsage.length / 20,
        1,
      );
      confidence += dataScore * 0.3;
      factors++;
    }

    if (this.burnRateHistory.length > 3) {
      const rates = this.burnRateHistory.map((e) => e.rate);
      const mean =
        rates.reduce((a, b) => a + b, 0) / rates.length;
      const variance =
        rates.reduce(
          (sum, r) => sum + Math.pow(r - mean, 2),
          0,
        ) / rates.length;
      const cv =
        mean > 0 ? Math.sqrt(variance) / mean : 1;
      const consistencyScore = Math.max(0, 1 - cv);
      confidence += consistencyScore * 0.4;
      factors++;
    }

    const trendScore =
      this.velocityTrend === 'stable' ? 1 : 0.7;
    confidence += trendScore * 0.3;
    factors++;

    return factors > 0 ? confidence / factors : 0;
  }

  getCurrentSession(): AnalyticsSession | null {
    const now = new Date();
    for (const [, session] of this.activeSessions) {
      if (
        session.startTime <= now &&
        session.endTime > now
      ) {
        return session;
      }
    }
    return null;
  }

  getSessionTokens(sessionId: string): number {
    const sessionData = this.recentUsage.filter(
      (e) => e.sessionId === sessionId,
    );
    return sessionData.reduce(
      (sum, e) => sum + e.tokens,
      0,
    );
  }

  getAnalytics(): AnalyticsData {
    const currentSession = this.getCurrentSession();

    return {
      currentSession: currentSession
        ? {
            id: currentSession.id,
            startTime: currentSession.startTime,
            endTime: currentSession.endTime,
            tokens: this.getSessionTokens(
              currentSession.id,
            ),
          }
        : null,

      burnRate: {
        current: this.currentBurnRate,
        trend: this.velocityTrend,
        history: this.burnRateHistory.slice(-10),
      },

      windows: Array.from(this.rollingWindows.values()),

      activeSessions: Array.from(
        this.activeSessions.values(),
      ).map((s) => ({
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        isActive: s.isActive,
        tokens: this.getSessionTokens(s.id),
      })),
    };
  }

  cleanup(): void {
    const now = new Date();

    for (const [id, session] of this.activeSessions) {
      if (session.endTime < now) {
        this.sessionHistory.push(session);
        this.activeSessions.delete(id);
      }
    }

    const cutoff = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    );
    this.sessionHistory = this.sessionHistory.filter(
      (s) => s.endTime > cutoff,
    );
  }
}

export default UsageAnalytics;
