/**
 * Shared usage-reading data structures.
 *
 * Every interface here is part of the public surface of the `UsageReader`
 * facade and is re-exported from `../usage-reader.js` unchanged.
 */

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
