import * as React from 'react';

import { Button } from '../ui/relay/Button';
import { Icon } from '../ui/relay/Icon';
import type { OverlayView } from './store';

export interface OverlayHostProps {
  view: OverlayView;
  /** Runtime-specific line for the loading view; empty falls back to the default. */
  message: string;
  errorText: string;
  onRetry(): void;
  /** The runtime picker, passed in so this file stays free of session logic. */
  launcher: React.ReactNode;
}

/**
 * The connection overlay: connecting, pick-a-runtime, or failed.
 *
 * It covers the terminal rather than the whole window on purpose — the tab strip
 * stays reachable while a session is starting, so a user waiting on one runtime
 * can still switch to another that is already running.
 */
export function OverlayHost({ view, message, errorText, onRetry, launcher }: OverlayHostProps): React.JSX.Element | null {
  if (view === null) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 'var(--z-overlay)' as unknown as number,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflowY: 'auto',
        background: 'var(--overlay)',
        backdropFilter: 'blur(4px)',
        animation: 'relay-fade-in var(--duration-base)',
      }}
    >
      {view === 'start' ? (
        launcher
      ) : (
        <div
          role={view === 'error' ? 'alert' : 'status'}
          aria-live={view === 'error' ? 'assertive' : 'polite'}
          style={{
            width: 400,
            maxWidth: '100%',
            padding: '28px 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            textAlign: 'center',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-lg)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {view === 'loading' ? (
            <>
              <span
                aria-hidden="true"
                style={{
                  color: 'var(--muted-foreground)',
                  animation: 'relay-spin 900ms linear infinite',
                  display: 'inline-flex',
                }}
              >
                <Icon name="loader-circle" size={22} />
              </span>
              {/* The runtime-start paths pass the specific line — which agent
                  is starting, and whether it is starting with permissions
                  bypassed. That distinction is worth showing. */}
              <div style={{ fontSize: 'var(--text-body)', color: 'var(--foreground)' }}>
                {message || 'Connecting…'}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
                Attaching to the session on the server.
              </div>
            </>
          ) : (
            <>
              <span aria-hidden="true" style={{ color: 'var(--destructive)', display: 'inline-flex' }}>
                <Icon name="circle-alert" size={22} />
              </span>
              <div style={{ fontSize: 'var(--text-body)', fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'] }}>
                Connection error
              </div>
              {/* Server-supplied text: rendered as a React child, never as markup. */}
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', wordBreak: 'break-word' }}>
                {errorText}
              </div>
              <Button variant="primary" onClick={onRetry}>Retry</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
