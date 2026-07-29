import * as React from 'react';
import { Icon } from '../../ui/relay/Icon.js';

/**
 * The furniture every workspace panel needs: a header with a refresh control,
 * and the four states a panel that fetches can be in.
 *
 * Extracted because the alternative is four copies of the same loading/error/
 * empty branches, which is exactly how three of them end up saying "Loading…"
 * and the fourth says nothing at all.
 */

export function PanelHeader({
  title,
  detail,
  onRefresh,
  busy,
  children,
}: {
  title: string;
  detail?: string;
  onRefresh?: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        padding: '0 6px 0 10px',
        borderBottom: '1px solid var(--border)',
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-xs)',
          fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
          letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase',
          color: 'var(--muted-foreground)',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      {detail ? (
        <span
          title={detail}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {detail}
        </span>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      {children}
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          aria-label={`Refresh ${title.toLowerCase()}`}
          title={`Refresh ${title.toLowerCase()}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            flex: '0 0 auto',
            background: 'transparent',
            border: '1px solid transparent',
            color: 'var(--muted-foreground)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
            borderRadius: 'var(--radius)',
          }}
        >
          <span style={busy ? { animation: 'relay-pulse 1.2s var(--ease-standard) infinite' } : undefined}>
            <Icon name="refresh-cw" size={13} />
          </span>
        </button>
      ) : null}
    </div>
  );
}

export function PanelNote({
  children,
  tone = 'muted',
  icon,
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'warning' | 'destructive';
  icon?: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '12px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        lineHeight: 'var(--leading-snug)',
        color:
          tone === 'destructive'
            ? 'var(--destructive)'
            : tone === 'warning'
              ? 'var(--warning)'
              : 'var(--muted-foreground)',
      }}
    >
      {icon ? (
        <span style={{ marginTop: 1, flex: '0 0 auto' }}>
          <Icon name={icon} size={13} />
        </span>
      ) : null}
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

export function PanelBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>{children}</div>
  );
}

/**
 * A fetch that reloads when its key changes, and can be re-run on demand.
 *
 * Every workspace panel wants the same three things — the value, whether it is
 * in flight, and what went wrong — plus a guarantee that a slow response for a
 * session the user has since switched away from does not land in the panel now
 * showing a different one.
 */
export function useWorkspaceData<T>(
  load: () => Promise<T>,
  deps: React.DependencyList,
  enabled = true,
): { data: T | null; error: string | null; busy: boolean; reload: () => void } {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  const loadRef = React.useRef(load);
  loadRef.current = load;

  React.useEffect(() => {
    if (!enabled) return;

    let live = true;
    setBusy(true);
    setError(null);

    loadRef
      .current()
      .then((value) => {
        if (!live) return;
        setData(value);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, busy, reload };
}
