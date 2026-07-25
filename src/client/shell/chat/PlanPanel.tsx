import * as React from 'react';
import { PlanItem } from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon, IconName } from '../../ui/relay/Icon.js';

/**
 * The agent's own todo list, as it reports progress through it.
 *
 * Status is never colour-only: pending/in-progress/completed each get a
 * distinct icon and completed additionally strikes through, the same
 * belt-and-braces approach TaskRow in Markdown.tsx uses for checklists, so
 * the state reads the same whether or not colour is perceptible.
 */

export interface PlanPanelProps {
  items: PlanItem[];
  /** Tighter spacing for the header/sidebar, where the panel is a summary. */
  compact?: boolean;
  /**
   * `rail` drops the card frame and takes the top of the trace rail: a 28px
   * caps header, a counter and a progress bar. The panel is the region there
   * rather than an object floating inside one, so a border around it would be a
   * second edge a few pixels inside the rail's own.
   */
  variant?: 'card' | 'rail';
}

const STATUS_ICON: Record<PlanItem['status'], IconName> = {
  pending: 'circle',
  in_progress: 'loader-circle',
  completed: 'check',
};

const STATUS_LABEL: Record<PlanItem['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
};

export function PlanPanel({ items, compact = false, variant = 'card' }: PlanPanelProps) {
  // An agent with no plan yet has nothing to show — a panel with a "0 of 0"
  // header would just be chrome around an empty list.
  if (!items || items.length === 0) return null;

  const completed = items.filter((item) => item.status === 'completed').length;
  const gap = compact ? 3 : 6;

  if (variant === 'rail') {
    const pct = Math.round((completed / items.length) * 100);
    return (
      <section aria-label="Plan" style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            padding: '0 12px',
            borderBottom: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted-foreground)',
          }}
        >
          <Icon name="list-todo" size={12} />
          <span style={{ letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase' }}>plan</span>
          <span style={{ marginLeft: 'auto' }}>
            {completed} / {items.length}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            padding: '8px 12px 10px',
            // The list can outgrow the rail; the timeline below it must keep
            // its own scroller rather than being pushed off the bottom.
            maxHeight: '38vh',
            overflowY: 'auto',
          }}
        >
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Plan progress"
            style={{ height: 3, background: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: 'var(--success)',
                transition: 'width var(--duration-base) var(--ease-standard)',
              }}
            />
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
            {items.map((item, i) => (
              <PlanRow key={i} item={item} compact />
            ))}
          </ul>
        </div>
      </section>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--card)',
        display: 'grid',
        gap: compact ? 6 : 8,
        padding: compact ? 8 : 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="list-todo" size={13} style={{ color: 'var(--muted-foreground)' }} />
        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--font-semibold)',
            color: 'var(--foreground)',
            letterSpacing: 'var(--tracking-wide)',
          }}
        >
          Plan
        </span>
        <Badge variant="neutral" style={{ marginLeft: 'auto' }}>
          {completed} of {items.length}
        </Badge>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap }}>
        {items.map((item, i) => (
          <PlanRow key={i} item={item} compact={compact} />
        ))}
      </ul>
    </div>
  );
}

function PlanRow({ item, compact }: { item: PlanItem; compact: boolean }) {
  const active = item.status === 'in_progress';
  const done = item.status === 'completed';
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: active ? '3px 6px' : '3px 6px',
        background: active ? 'var(--accent)' : undefined,
        borderLeft: active ? '2px solid var(--foreground)' : '2px solid transparent',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          marginTop: 2,
          color: done ? 'var(--success)' : active ? 'var(--foreground)' : 'var(--muted-foreground)',
          animation: active ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
        }}
      >
        <Icon name={STATUS_ICON[item.status]} size={12} />
      </span>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        {STATUS_LABEL[item.status]}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: compact ? 'var(--text-xs)' : 'var(--text-sm)',
          lineHeight: 'var(--leading-snug)',
          color: done ? 'var(--muted-foreground)' : 'var(--foreground)',
          fontWeight: active ? 'var(--font-medium)' : 'var(--font-normal)',
          textDecoration: done ? 'line-through' : undefined,
          opacity: done ? 0.7 : 1,
          wordBreak: 'break-word',
        }}
      >
        {item.text}
      </span>
      {item.priority && !compact ? (
        <Badge variant="outline" style={{ flex: '0 0 auto' }}>
          {item.priority}
        </Badge>
      ) : null}
    </li>
  );
}
