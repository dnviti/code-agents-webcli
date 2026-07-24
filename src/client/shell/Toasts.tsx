import * as React from 'react';

import { Icon } from '../ui/relay/Icon';
import type { ToastItem } from './store';

export interface ToastsProps {
  toasts: ToastItem[];
  /** Lifts the stack clear of the bottom bar. */
  isMobile: boolean;
  /** Extra clearance, e.g. the key strip's height when it is showing. */
  bottomOffset?: number;
  onDismiss(id: number): void;
}

/**
 * Toast stack.
 *
 * The roles are split by urgency, as they were before: an error is announced
 * immediately because the user has to act on it, while a confirmation waits for
 * a pause so it never cuts a screen reader off mid-sentence. `notifications.ts`
 * still owns the lifetime; this only paints.
 */
export function Toasts({ toasts, isMobile, bottomOffset = 0, onDismiss }: ToastsProps): React.JSX.Element | null {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        left: isMobile ? 12 : 'auto',
        // Clear of whichever bar owns the bottom edge — the mobile bar with its
        // safe-area inset, or the desktop status bar. A toast overlapping either
        // hides the connection state at exactly the moment something failed.
        bottom: isMobile
          ? `calc(var(--mobile-bar-height) + env(safe-area-inset-bottom, 0px) + ${bottomOffset + 12}px)`
          : 'calc(var(--status-bar-height) + 12px)',
        zIndex: 'var(--z-toast)' as unknown as number,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
        maxWidth: isMobile ? undefined : 380,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.variant === 'error' ? 'alert' : 'status'}
          aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 12px',
            background: 'var(--popover)',
            color: 'var(--foreground)',
            border: '1px solid ' + (toast.variant === 'error' ? 'var(--destructive)' : 'var(--border)'),
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-lg)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-normal)',
            animation: 'relay-scale-in var(--duration-base) var(--ease-out)',
          }}
        >
          <span
            style={{
              flex: '0 0 auto',
              marginTop: 1,
              color: toast.variant === 'error' ? 'var(--destructive)' : 'var(--muted-foreground)',
            }}
          >
            <Icon name={toast.variant === 'error' ? 'circle-alert' : 'check'} size={14} />
          </span>
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss"
            style={{
              flex: '0 0 auto',
              border: 'none',
              background: 'transparent',
              color: 'var(--muted-foreground)',
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
