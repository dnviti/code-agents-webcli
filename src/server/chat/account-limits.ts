import type { AccountLimits, AccountLimitWindow } from '../../shared/chat-events.js';

/**
 * Accumulates what a provider has said about the account behind a conversation.
 *
 * The providers dribble this out. Claude sends one window per `rate_limit_event`
 * — a five-hour one most turns, a seven-day one when a threshold is crossed —
 * and states the billing mode somewhere else entirely, on the handshake. Codex
 * answers with both of its windows at once but only when asked. So each adapter
 * keeps one of these and re-emits the whole picture, which is what lets the
 * reducer replace wholesale and a browser that joined late see a complete
 * answer rather than the last fragment.
 *
 * Nothing is ever invented here. A window with no percentage keeps no
 * percentage, because "the provider did not say" and "0% spent" are opposite
 * facts and the status panel used to show the second when it meant the first
 * (#137).
 */
export class AccountLimitTracker {
  private planName?: string;
  private billing?: AccountLimits['billing'];
  private readonly windows = new Map<string, AccountLimitWindow>();
  /**
   * The first reading taken of each window, so a second one becomes a rate.
   *
   * Keyed by window *and* reset time: when the reset moves, this is a different
   * window that happens to share a name, and carrying the old sample across
   * would compute a rate from two unrelated levels.
   */
  private readonly firstReading = new Map<string, { utilization: number; at: number }>();

  /** True when nothing has been reported yet, so callers can stay silent. */
  get empty(): boolean {
    return this.windows.size === 0 && this.planName === undefined && this.billing === undefined;
  }

  /** Returns true when this actually changed anything worth re-emitting. */
  noteBilling(billing: AccountLimits['billing']): boolean {
    if (this.billing === billing) return false;
    this.billing = billing;
    return true;
  }

  notePlanName(planName: string | undefined): boolean {
    if (!planName || this.planName === planName) return false;
    this.planName = planName;
    return true;
  }

  /** Fold one window reading in. Returns true when the picture changed. */
  noteWindow(reading: AccountLimitWindow, at = Date.now()): boolean {
    const key = `${reading.kind}|${reading.resetsAt ?? ''}`;
    const window: AccountLimitWindow = { ...reading };

    if (typeof window.utilization === 'number') {
      const first = this.firstReading.get(key);
      if (!first || window.utilization < first.utilization) {
        // Either the first sight of this window, or a level that went
        // backwards — which is not something a filling window does, so the
        // earlier reading is the one to distrust.
        this.firstReading.set(key, { utilization: window.utilization, at });
      } else {
        const hours = (at - first.at) / 3_600_000;
        // A rate needs elapsed time as well as two readings. Two events in the
        // same millisecond divide by zero and would report an infinite burn.
        if (hours > 0 && window.utilization > first.utilization) {
          window.utilizationPerHour = (window.utilization - first.utilization) / hours;
        }
      }
    }

    const previous = this.windows.get(reading.kind);
    // Keyed by kind rather than by key: a five-hour window that has rolled over
    // replaces the one before it. Two entries called "five_hour" would read as
    // two separate allowances.
    this.windows.set(reading.kind, window);
    return JSON.stringify(previous) !== JSON.stringify(window);
  }

  snapshot(): AccountLimits {
    return {
      ...(this.planName ? { planName: this.planName } : {}),
      ...(this.billing ? { billing: this.billing } : {}),
      windows: Array.from(this.windows.values()),
    };
  }
}

/**
 * Epoch seconds to ISO, the way both providers report a reset.
 *
 * Both Claude's `resetsAt` and Codex's are seconds, and both are around 1.78e9
 * today — read as milliseconds they land in January 1970, which is a plausible
 * enough date that the mistake renders as a reset that already happened rather
 * than as an obvious failure. Anything that is not a finite positive number
 * yields undefined, so a provider that changes the units stops reporting rather
 * than starts lying.
 */
export function resetIsoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
