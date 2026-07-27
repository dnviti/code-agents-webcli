import * as React from 'react';
import { ChatCapabilities, ChatUsage } from '../../../shared/chat-events.js';
import { tokenTotal } from '../../../shared/usage-records.js';
import { PHONE_TEXT } from '../../ui/touch.js';

/**
 * Tokens and money for a message, turn or session.
 *
 * Every ChatUsage field is optional because runtimes report wildly different
 * subsets (see the comment on ChatUsage itself), so this renders exactly the
 * fields present and nothing else — a runtime that reports nothing gets no
 * meter at all, never a confident "0 tokens, $0.00" that looks like an answer
 * but is really the absence of one.
 */

export interface UsageMeterProps {
  usage: ChatUsage;
  capabilities: ChatCapabilities;
  compact?: boolean;
  /**
   * Size the figures for a phone.
   *
   * Separate from `compact`, which says how much is written (one line versus
   * the full breakdown) rather than how large it is set. On a phone the compact
   * form is still the right *content* — and it is the one carrying the cost,
   * the single number issue #51 names as too small to read.
   */
  phone?: boolean;
  /**
   * The money only.
   *
   * For the phone's collapsed header strip, which has room for one figure. The
   * cost is the one that earns it: the token count and the context percentage
   * are both readable off it approximately, and neither is what somebody
   * glances down at mid-session.
   */
  costOnly?: boolean;
}

interface TokenField {
  label: string;
  value: number;
}

/** Where "nearly full" starts. Amber on the bar begins earlier, at 70%. */
const WARN_AT_PCT = 80;

export function UsageMeter({ usage, capabilities, compact = false, phone = false, costOnly = false }: UsageMeterProps) {
  // A runtime that advertised no usage/cost reporting can still leave a stale
  // field behind on a reused object; the capability is what says the number is
  // meant to be trusted, not merely present.
  const showTokens = capabilities.usage !== false;
  const showCost = capabilities.cost !== false;

  const fields: TokenField[] = showTokens
    ? [
        { label: 'in', value: usage.inputTokens },
        { label: 'out', value: usage.outputTokens },
        { label: 'cache read', value: usage.cacheReadTokens },
        { label: 'cache write', value: usage.cacheWriteTokens },
        { label: 'reasoning', value: usage.reasoningTokens },
      ].filter((f): f is TokenField => f.value !== undefined)
    : [];

  const hasTotal = showTokens && usage.totalTokens !== undefined;
  const hasCost = showCost && usage.costUsd !== undefined;
  const hasContext = showTokens && usage.contextWindow !== undefined && usage.contextUsed !== undefined;
  /**
   * Occupied, but against a ceiling nobody could establish.
   *
   * Written out rather than left blank. A conversation that quietly shows no
   * context line is indistinguishable from one whose context is fine, and the
   * whole reason capacity is never guessed here is that a confidently wrong
   * ceiling invites someone to keep going up to a limit that is not there.
   */
  const capacityUnknown =
    showTokens && usage.contextWindow === undefined && usage.contextUsed !== undefined;

  if (fields.length === 0 && !hasTotal && !hasCost && !hasContext && !capacityUnknown) {
    return null;
  }

  const contextPct = hasContext
    ? Math.min(100, Math.max(0, (usage.contextUsed! / Math.max(1, usage.contextWindow!)) * 100))
    : 0;
  const barColor = contextPct >= 90 ? 'var(--destructive)' : contextPct >= 70 ? 'var(--warning)' : 'var(--success)';
  // Far enough from the edge that there is still room to finish a thought,
  // compact, or start fresh — which is the whole point of saying anything.
  //
  // In the compact strip this only weights and colours the percentage: that
  // row is the fixed-width header, and the words that fit here comfortably at
  // 4% push it past its own width at 95%, which is precisely when a person
  // needs to be able to read it. The sentence lives in the expanded meter and
  // in the status panel, and the tooltip carries it either way.
  const contextWarning = hasContext && contextPct >= WARN_AT_PCT;

  const fontSize = phone ? PHONE_TEXT.label : compact ? 'var(--text-2xs)' : 'var(--text-xs)';

  if (compact) {
    const parts: string[] = [];
    // The same function the historical dashboard files a job's total with, so
    // the figure on screen and the figure in the history cannot be two
    // different readings of the same work — which is what they were (#80).
    const total = showTokens ? tokenTotal(usage) : null;
    if (total !== null) parts.push(`${formatTokens(total)} tok`);
    if (hasCost) parts.push(formatCost(usage.costUsd!));

    return (
      <div
        // Named, because it is one of the readouts a phone layout has to keep
        // legible and there is otherwise no way to ask for it — by role it is
        // an anonymous div, and by text it is whatever this session has cost.
        // The role is what makes the name land: `aria-label` on a plain div is
        // ignored by most screen readers.
        role="group"
        aria-label="Session usage"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
          fontSize,
          color: 'var(--muted-foreground)',
        }}
      >
        {parts.length ? <span>{costOnly && hasCost ? formatCost(usage.costUsd!) : parts.join(' · ')}</span> : null}
        {hasContext && !costOnly ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              ...(contextWarning ? { color: barColor, fontWeight: 'var(--font-semibold)' } : {}),
            }}
            title={contextTitle(usage, contextPct)}
          >
            <ContextBar pct={contextPct} color={barColor} width={40} height={phone ? 6 : 4} />
            {Math.round(contextPct)}%
          </span>
        ) : null}
        {/* Nothing about an unknown capacity in the compact strip. It is the
            fixed-width header, and the sentence that fits beside a short token
            count does not fit beside a long one — the same overflow the
            warning wording hits at 95%. The expanded meter and the status
            panel both say it, and neither is width-bound. */}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize,
        color: 'var(--muted-foreground)',
      }}
    >
      {fields.length > 0 || hasTotal || hasCost ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {fields.map((f) => (
            <span key={f.label}>
              <span>{f.label} </span>
              <span style={{ color: 'var(--foreground)' }}>{formatTokens(f.value)}</span>
            </span>
          ))}
          {hasTotal ? (
            <span>
              <span>total </span>
              <span style={{ color: 'var(--foreground)', fontWeight: 'var(--font-semibold)' }}>
                {formatTokens(usage.totalTokens!)}
              </span>
            </span>
          ) : null}
          {hasCost ? (
            <span>
              <span>cost </span>
              <span style={{ color: 'var(--foreground)' }}>{formatCost(usage.costUsd!)}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {hasContext ? (
        <div style={{ display: 'grid', gap: 3 }} title={contextTitle(usage, contextPct)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>context</span>
            <span style={{ color: 'var(--foreground)' }}>
              {formatTokens(usage.contextUsed!)} / {formatTokens(usage.contextWindow!)} · {Math.round(contextPct)}%
            </span>
          </div>
          <ContextBar pct={contextPct} color={barColor} width="100%" height={5} />
          {contextWarning ? (
            // A percentage alone is a number to interpret; this says what to do
            // about it while there is still room to do it.
            <div role="status" style={{ color: barColor, fontWeight: 'var(--font-semibold)' }}>
              {contextPct >= 90 ? 'context almost full' : 'context filling up'} —{' '}
              {formatTokens(Math.max(0, usage.contextWindow! - usage.contextUsed!))} left. Compact or
              start a new conversation.
            </div>
          ) : null}
        </div>
      ) : null}

      {capacityUnknown ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span>context</span>
          <span style={{ color: 'var(--foreground)' }}>
            {formatTokens(usage.contextUsed!)} used · size unknown
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ContextBar({
  pct,
  color,
  width,
  height,
}: {
  pct: number;
  color: string;
  width: number | string;
  height: number;
}) {
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Context window used"
      style={{
        width,
        height,
        flex: '0 0 auto',
        background: 'var(--muted)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          transition: 'width var(--duration-base) var(--ease-standard)',
        }}
      />
    </div>
  );
}

/**
 * The long form of the reading, including who vouched for the ceiling.
 *
 * The provenance matters enough to say: an agent reporting its own window is
 * describing what it will actually run, while a provider catalogue is a
 * second-best consulted only when the agent said nothing.
 */
function contextTitle(usage: ChatUsage, pct: number): string {
  const used = usage.contextUsed ?? 0;
  const window = usage.contextWindow ?? 0;
  const source =
    usage.contextWindowSource === 'provider'
      ? " (window size from the model's provider)"
      : usage.contextWindowSource === 'agent'
        ? ' (window size reported by the agent)'
        : '';
  return `${used.toLocaleString()} of ${window.toLocaleString()} tokens · ${Math.round(pct)}% full${source}`;
}

/** 1234 -> "1.2k", 12421 -> "12.4k", 984123 -> "984k", 1_400_000 -> "1.4M". */
function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) {
    const v = n / 1000;
    return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)}k`;
  }
  const v = n / 1_000_000;
  return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)}M`;
}

/**
 * Money at whatever precision keeps it meaningful. A turn can cost fractions
 * of a cent, and rounding that to "$0.00" is indistinguishable from free.
 */
function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
