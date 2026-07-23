import * as React from 'react';

import { Button } from '../ui/relay/Button';
import type { BannerView } from './store';

export interface UpdateBannerViewProps {
  banner: BannerView | null;
  onAction(): void;
  onToggleLog(): void;
  onDismiss(): void;
}

const TONE: Record<string, string> = {
  info: 'var(--muted-foreground)',
  warn: 'var(--ansi-yellow)',
  error: 'var(--destructive)',
  ok: 'var(--ansi-green)',
};

/**
 * The build-update notice.
 *
 * `update-banner.ts` still owns polling, the apply request and the restart poll;
 * it hands over a flat view model. Rendered above the shell rather than over it
 * so it pushes the terminal down instead of covering the top of the output.
 */
export function UpdateBannerView({
  banner, onAction, onToggleLog, onDismiss,
}: UpdateBannerViewProps): React.JSX.Element | null {
  const logRef = React.useRef<HTMLPreElement | null>(null);

  // Follow the tail: an npm install streams for a while and the interesting line
  // is always the last one.
  React.useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [banner?.log, banner?.logOpen]);

  if (!banner) return null;

  return (
    <div
      style={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--border)',
        background: 'var(--card)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
        <span
          aria-hidden="true"
          style={{
            width: 7, height: 7, flex: '0 0 auto', borderRadius: 'var(--radius-full)',
            background: TONE[banner.tone] ?? 'var(--muted-foreground)',
          }}
        />
        {/* The commit subject is whatever text landed on main, and is not
            trusted: a React child, never markup. */}
        <span
          role="status"
          aria-live="polite"
          style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--foreground)' }}
        >
          {banner.text}
        </span>
        {banner.actionLabel ? (
          <Button size="sm" variant="secondary" onClick={onAction}>{banner.actionLabel}</Button>
        ) : null}
        {banner.showLog ? (
          <Button size="sm" variant="ghost" onClick={onToggleLog} aria-expanded={banner.logOpen}>
            {banner.logOpen ? 'Hide log' : 'Show log'}
          </Button>
        ) : null}
        {banner.dismissible ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide update notice"
            style={{
              border: 'none', background: 'transparent', color: 'var(--muted-foreground)',
              cursor: 'pointer', padding: 2, lineHeight: 1, fontSize: 13,
            }}
          >✕</button>
        ) : null}
      </div>
      {banner.showLog && banner.logOpen ? (
        <pre
          ref={logRef}
          // aria-live="off": every streamed npm line would otherwise be announced.
          aria-live="off"
          style={{
            margin: 0,
            padding: '8px 12px',
            maxHeight: 180,
            overflow: 'auto',
            borderTop: '1px solid var(--border)',
            background: 'var(--muted)',
            color: 'var(--muted-foreground)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-normal)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >{banner.log}</pre>
      ) : null}
    </div>
  );
}
