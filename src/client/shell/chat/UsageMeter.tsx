import * as React from 'react';
import { ChatCapabilities, ChatUsage } from '../../../shared/chat-events.js';
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
}

interface TokenField {
  label: string;
  value: number;
}

export function UsageMeter({ usage, capabilities, compact = false, phone = false }: UsageMeterProps) {
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

  if (fields.length === 0 && !hasTotal && !hasCost && !hasContext) {
    return null;
  }

  const contextPct = hasContext
    ? Math.min(100, Math.max(0, (usage.contextUsed! / Math.max(1, usage.contextWindow!)) * 100))
    : 0;
  const barColor = contextPct >= 90 ? 'var(--destructive)' : contextPct >= 70 ? 'var(--warning)' : 'var(--success)';

  const fontSize = phone ? PHONE_TEXT.label : compact ? 'var(--text-2xs)' : 'var(--text-xs)';

  if (compact) {
    const parts: string[] = [];
    if (hasTotal) {
      parts.push(`${formatTokens(usage.totalTokens!)} tok`);
    } else if (fields.length) {
      parts.push(`${formatTokens(fields.reduce((sum, f) => sum + f.value, 0))} tok`);
    }
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
        {parts.length ? <span>{parts.join(' · ')}</span> : null}
        {hasContext ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ContextBar pct={contextPct} color={barColor} width={40} height={phone ? 6 : 4} />
            {Math.round(contextPct)}%
          </span>
        ) : null}
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
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>context</span>
            <span style={{ color: 'var(--foreground)' }}>
              {formatTokens(usage.contextUsed!)} / {formatTokens(usage.contextWindow!)} · {Math.round(contextPct)}%
            </span>
          </div>
          <ContextBar pct={contextPct} color={barColor} width="100%" height={5} />
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
