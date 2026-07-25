import * as React from 'react';
import type { MediaKind } from '../../../shared/file-media.js';
import { Icon } from '../../ui/relay/Icon.js';

/**
 * A file the browser can show or play, shown or played.
 *
 * An image, a screen recording, a voice note and a PDF all used to open as
 * "this file is binary", which is true and useless — an agent produces all four
 * and the browser already knows how to render every one of them.
 *
 * Everything here loads from a URL rather than from bytes this app fetched. The
 * element doing its own loading is what gives a video its range requests and a
 * working seek bar, an image its progressive decode, and a PDF the browser's own
 * viewer; buffering the file ourselves to hand over a blob would take all three
 * away and hold a recording in memory to do it.
 */

export interface MediaViewProps {
  kind: MediaKind;
  /** Where the bytes come from — see `rawFileUrl`. */
  src: string;
  /** Shown as the image's alt text and named in any failure. */
  name: string;
  height: React.CSSProperties['height'];
}

export function MediaView({ kind, src, name, height }: MediaViewProps): React.JSX.Element {
  const [failed, setFailed] = React.useState(false);

  const frame: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height,
    minHeight: 0,
    padding: kind === 'audio' ? 'var(--space-6)' : 0,
    overflow: 'auto',
    background: 'var(--terminal-bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  };

  if (failed) {
    return (
      <div style={frame}>
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: 'var(--space-4)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)',
            color: 'var(--muted-foreground)',
          }}
        >
          <Icon name="circle-alert" size={14} />
          {/* Deliberately not "the file is corrupt": the far more common cause
              is a codec this browser does not have, and blaming the file for
              that sends the user to fix the wrong thing. */}
          This browser could not play {name}.
        </span>
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div style={frame}>
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            // Contained rather than stretched: a 16px favicon blown up to the
            // width of the dialog is not a preview of anything.
            objectFit: 'contain',
            // The checker is what makes a transparent PNG legible against a
            // dark panel; without it an icon with an alpha channel is invisible.
            backgroundImage:
              'linear-gradient(45deg, var(--muted) 25%, transparent 25%),'
              + ' linear-gradient(-45deg, var(--muted) 25%, transparent 25%),'
              + ' linear-gradient(45deg, transparent 75%, var(--muted) 75%),'
              + ' linear-gradient(-45deg, transparent 75%, var(--muted) 75%)',
            backgroundSize: '16px 16px',
            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
          }}
        />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div style={frame}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a file from
            the user's own working tree has no track to offer. */}
        <video
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          style={{ maxWidth: '100%', maxHeight: '100%' }}
        />
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div style={{ ...frame, flexDirection: 'column', gap: 'var(--space-3)' }}>
        <Icon name="volume-2" size={28} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--muted-foreground)',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        <audio src={src} controls preload="metadata" onError={() => setFailed(true)} style={{ width: 'min(420px, 100%)' }} />
      </div>
    );
  }

  // PDF. An iframe rather than <embed>: it is the one that reliably gets the
  // browser's own viewer — with its search, its page list and its zoom — in
  // every engine, and the response is served `application/pdf` so nothing else
  // can be rendered through it.
  return (
    <iframe
      src={src}
      title={name}
      style={{
        width: '100%',
        height,
        minHeight: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--terminal-bg)',
      }}
    />
  );
}
