import { UsageReaderCore } from './core.js';
import type {
  BurnRate,
  OverlappingSession,
  RecentSession,
  SessionBoundary,
} from './types.js';

/**
 * Middle layer of the `UsageReader` inheritance chain: session segmentation and
 * boundary logic built on top of the corpus primitives in `UsageReaderCore`.
 */
export abstract class UsageReaderSessions extends UsageReaderCore {
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
