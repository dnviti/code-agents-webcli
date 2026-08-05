import * as React from 'react';

import { Button } from '../ui/relay/Button';
import { Dialog } from '../ui/relay/Dialog';
import { Icon } from '../ui/relay/Icon';
import type { DesktopUpdateView } from './store';

const RELEASES_URL = 'https://github.com/dnviti/code-agents-webcli/releases';

export interface DesktopUpdateDialogProps {
  update: DesktopUpdateView | null;
  localRunningWorkCount: number | null;
  onDefer(): void;
  onInstall(): void;
  onRetry(): void;
}

export function localWorkWarning(count: number | null): string {
  if (count === 0) {
    return 'The app will close and reopen. No Local work is currently running. Save any unsent text first.';
  }
  if (count === 1) {
    return 'The app will close and reopen. 1 running Local session will end. Save any unsent text first.';
  }
  if (count !== null && count > 1) {
    return `The app will close and reopen. ${count} running Local sessions will end. Save any unsent text first.`;
  }
  return 'The app will close and reopen. Running Local work will end. Save any unsent text first.';
}

function progressLabel(update: DesktopUpdateView): string {
  if (update.phase === 'downloading') {
    if (update.progress === null) return 'Downloading update…';
    const coarse = update.progress >= 100 ? 100 : Math.floor(update.progress / 10) * 10;
    return coarse === 0 ? 'Downloading update… less than 10%' : `Downloading update… ${coarse}%`;
  }
  if (update.phase === 'ready') return 'Update verified. Restarting…';
  if (update.phase === 'installing') return 'Installing update…';
  if (update.phase === 'restarting') return 'Restarting the application…';
  return '';
}

function releaseDateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Whole-window proposal for a trusted native package update. */
export function DesktopUpdateDialog({ update, localRunningWorkCount, onDefer, onInstall, onRetry }: DesktopUpdateDialogProps): React.JSX.Element | null {
  if (!update?.promptOpen || !update.targetVersion) return null;
  const busy = update.phase === 'downloading' || update.phase === 'ready'
    || update.phase === 'installing' || update.phase === 'restarting';
  const error = update.phase === 'error';
  const progress = progressLabel(update);
  const title = error
    ? 'Update needs attention'
    : update.phase === 'available'
      ? `Version ${update.targetVersion} is available`
      : update.phase === 'downloading'
        ? `Updating to version ${update.targetVersion}`
        : `Finishing version ${update.targetVersion}`;
  const releaseDate = releaseDateLabel(update.releaseDate);

  return (
    <Dialog
      open
      title={title}
      description={error
        ? update.retryable
          ? 'The update did not finish. You can retry it from this device.'
          : 'The update needs a manual installation step on this device.'
        : `Code Agents will update from ${update.currentVersion || 'the current version'} and restart.`}
      width={520}
      overlayZIndex="var(--z-blocking-modal)"
      onClose={busy ? undefined : () => onDefer()}
      footer={busy ? undefined : (
        <>
          <Button variant="ghost" onClick={onDefer} autoFocus>
            {error ? 'Close' : 'Not now'}
          </Button>
          {error && update.retryable ? (
            <Button variant="primary" onClick={onRetry} disabled={!update.retryable} iconLeft={<Icon name="refresh-cw" size={15} />}>
              Retry update
            </Button>
          ) : !error ? (
            <Button variant="primary" onClick={onInstall} iconLeft={<Icon name="download" size={15} />}>
              Update and restart
            </Button>
          ) : null}
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div aria-label={`Update from version ${update.currentVersion || 'current'} to ${update.targetVersion}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
          <span>{update.currentVersion || 'Current'}</span>
          <span aria-hidden="true" style={{ color: 'var(--muted-foreground)' }}>→</span>
          <strong>{update.targetVersion}</strong>
          {releaseDate ? <span style={{ marginLeft: 'auto', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}>Released {releaseDate}</span> : null}
        </div>
        {update.summary ? (
          <p style={{ margin: 0, lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-wrap' }}>{update.summary}</p>
        ) : null}
        {!busy ? (
          <div style={{ padding: 12, borderLeft: '3px solid var(--ansi-yellow)', background: 'var(--accent)', lineHeight: 'var(--leading-normal)' }}>
            {localWorkWarning(localRunningWorkCount)}
          </div>
        ) : null}
        {progress ? (
          <div aria-live="polite" style={{ display: 'grid', gap: 8 }}>
            <span>{progress}</span>
            {update.progress !== null ? (
              <div role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.progress)} style={{ height: 6, overflow: 'hidden', background: 'var(--accent)', borderRadius: 'var(--radius-full)' }}>
                <div style={{ width: `${update.progress}%`, height: '100%', background: 'var(--primary)', transition: 'width var(--duration-base) var(--ease-standard)' }} />
              </div>
            ) : null}
          </div>
        ) : null}
        {error && update.error ? (
          <p role="alert" style={{ margin: 0, color: 'var(--destructive)', lineHeight: 'var(--leading-normal)' }}>{update.error}</p>
        ) : null}
        {error && !update.retryable ? (
          <p style={{ margin: 0, lineHeight: 'var(--leading-normal)' }}>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">Open the signed releases and manual installation options</a>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
