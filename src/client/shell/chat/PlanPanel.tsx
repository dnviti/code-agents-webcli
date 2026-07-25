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

export function PlanPanel({ items, compact = false }: PlanPanelProps) {
  // An agent with no plan yet has nothing to show — a panel with a "0 of 0"
  // header would just be chrome around an empty list.
  if (!items || items.length === 0) return null;

  const completed = items.filter((item) => item.status === 'completed').length;
  const gap = compact ? 3 : 6;

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
