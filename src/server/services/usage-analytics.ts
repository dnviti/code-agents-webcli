import { EventEmitter } from 'events';

export interface PlanLimit {
  tokens: number | null;
  cost: number;
  messages: number;
  algorithm: 'fixed' | 'p90';
}

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
  remainingTokens: number;
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

export interface PredictionInfo {
  depletionTime: Date | null;
  confidence: number;
  minutesRemaining: number | null;
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
    remaining: number;
    percentUsed: number;
  } | null;
  burnRate: BurnRateInfo;
  predictions: PredictionInfo;
  plan: {
    type: string;
    limits: PlanLimit;
    p90Limit: number | null;
  };
  windows: RollingWindow[];
  activeSessions: SessionAnalytics[];
}

export interface HistoricalSession {
  totalTokens: number;
}

type VelocityTrend = 'increasing' | 'decreasing' | 'stable';

export interface UsageAnalyticsOptions {
  sessionDurationHours?: number;
  confidenceThreshold?: number;
  burnRateWindow?: number;
  updateInterval?: number;
  plan?: string;
  customCostLimit?: number;
}

export class UsageAnalytics extends EventEmitter {
  private sessionDurationHours: number;
  private burnRateWindow: number;

  public planLimits: Record<string, PlanLimit>;
  public currentPlan: string;

  private activeSessions: Map<string, AnalyticsSession> =
    new Map();
  private sessionHistory: AnalyticsSession[] = [];
  private rollingWindows: Map<string, RollingWindow> =
    new Map();

  private recentUsage: UsageDataPoint[] = [];
  private p90Limit: number | null = null;

  private burnRateHistory: BurnRateEntry[] = [];
  private currentBurnRate: number = 0;
  private velocityTrend: VelocityTrend = 'stable';

  private depletionTime: Date | null = null;
  private depletionConfidence: number = 0;

  constructor(options: UsageAnalyticsOptions = {}) {
    super();

    this.sessionDurationHours =
      options.sessionDurationHours || 5;
    this.burnRateWindow = options.burnRateWindow || 60;

    this.planLimits = {
      pro: {
        tokens: 19000,
        cost: 18.0,
        messages: 250,
        algorithm: 'fixed',
      },
      'claude-pro': {
        tokens: 19000,
        cost: 18.0,
        messages: 250,
        algorithm: 'fixed',
      },
      max5: {
        tokens: 88000,
        cost: 35.0,
        messages: 1000,
        algorithm: 'fixed',
      },
      'claude-max5': {
        tokens: 88000,
        cost: 35.0,
        messages: 1000,
        algorithm: 'fixed',
      },
      max20: {
        tokens: 220000,
        cost: 140.0,
        messages: 2000,
        algorithm: 'fixed',
      },
      'claude-max20': {
        tokens: 220000,
        cost: 140.0,
        messages: 2000,
        algorithm: 'fixed',
      },
      custom: {
        tokens: null,
        cost: options.customCostLimit || 76.89,
        messages: 1019,
        algorithm: 'p90',
      },
    };

    this.currentPlan = options.plan || 'custom';
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
    this.updatePredictions();

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
            remainingTokens: this.getTokenLimit(),
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

  private updatePredictions(): void {
    const currentSession = this.getCurrentSession();
    if (!currentSession || this.currentBurnRate === 0) {
      this.depletionTime = null;
      this.depletionConfidence = 0;
      return;
    }

    const limit = this.getTokenLimit();
    const used = this.getSessionTokens(currentSession.id);
    const remaining = limit - used;

    if (remaining <= 0) {
      this.depletionTime = new Date();
      this.depletionConfidence = 1;
      return;
    }

    const minutesToDepletion =
      remaining / this.currentBurnRate;
    this.depletionTime = new Date(
      Date.now() + minutesToDepletion * 60 * 1000,
    );

    this.depletionConfidence = this.calculateConfidence();

    if (this.velocityTrend === 'increasing') {
      const adjustment = 0.9;
      const adjustedTime =
        Date.now() +
        (this.depletionTime.getTime() - Date.now()) *
          adjustment;
      this.depletionTime = new Date(adjustedTime);
    } else if (this.velocityTrend === 'decreasing') {
      const adjustment = 1.1;
      const adjustedTime =
        Date.now() +
        (this.depletionTime.getTime() - Date.now()) *
          adjustment;
      this.depletionTime = new Date(adjustedTime);
    }

    this.emit('prediction-updated', {
      depletionTime: this.depletionTime,
      confidence: this.depletionConfidence,
      remaining,
      burnRate: this.currentBurnRate,
    });
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

  getTokenLimit(): number {
    const plan = this.planLimits[this.currentPlan];

    if (plan.algorithm === 'fixed' && plan.tokens !== null) {
      return plan.tokens;
    } else if (plan.algorithm === 'p90') {
      return this.p90Limit || 188026;
    }

    return 188026;
  }

  calculateP90Limit(
    historicalSessions: HistoricalSession[],
  ): number | null {
    if (
      !historicalSessions ||
      historicalSessions.length < 10
    ) {
      return null;
    }

    const tokenCounts = historicalSessions
      .map((s) => s.totalTokens)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    if (tokenCounts.length === 0) {
      return null;
    }

    const p90Index = Math.floor(
      tokenCounts.length * 0.9,
    );
    this.p90Limit = tokenCounts[p90Index];

    this.emit('p90-calculated', {
      limit: this.p90Limit,
      sampleSize: tokenCounts.length,
      confidence: Math.min(tokenCounts.length / 100, 1),
    });

    return this.p90Limit;
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
            remaining:
              this.getTokenLimit() -
              this.getSessionTokens(currentSession.id),
            percentUsed:
              (this.getSessionTokens(currentSession.id) /
                this.getTokenLimit()) *
              100,
          }
        : null,

      burnRate: {
        current: this.currentBurnRate,
        trend: this.velocityTrend,
        history: this.burnRateHistory.slice(-10),
      },

      predictions: {
        depletionTime: this.depletionTime,
        confidence: this.depletionConfidence,
        minutesRemaining: this.depletionTime
          ? Math.max(
              0,
              (this.depletionTime.getTime() - Date.now()) /
                1000 /
                60,
            )
          : null,
      },

      plan: {
        type: this.currentPlan,
        limits: this.planLimits[this.currentPlan],
        p90Limit: this.p90Limit,
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

  setPlan(planType: string): void {
    if (this.planLimits[planType]) {
      this.currentPlan = planType;
      this.updatePredictions();
      this.emit('plan-changed', planType);
    }
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
