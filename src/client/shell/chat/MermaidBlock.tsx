import * as React from 'react';
import { loadMermaid, nextDiagramId } from '../../chat/mermaid.js';
import { Icon } from '../../ui/relay/Icon.js';
import { CodeBlock } from './Markdown.js';

/**
 * Renders a ```mermaid fence as a diagram, falling back to its source.
 *
 * Three states matter and each has a defined answer:
 *
 *   still streaming — show the source. A half-written graph does not parse, and
 *                     flashing an error at every token is worse than waiting.
 *   rendered        — show the SVG, with a toggle back to source.
 *   failed          — show the source plus a quiet note. The diagram is the
 *                     nice-to-have; the text the agent wrote is the content,
 *                     and it must never disappear because a renderer choked.
 */

export interface MermaidBlockProps {
  code: string;
  /** False while the closing fence has not arrived. */
  complete?: boolean;
}

type Status = 'idle' | 'rendering' | 'ready' | 'failed';

function currentTheme(): 'dark' | 'light' {
  try {
    return document.documentElement.classList.contains('light') ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function MermaidBlock({ code, complete = true }: MermaidBlockProps) {
  const [status, setStatus] = React.useState<Status>('idle');
  const [svg, setSvg] = React.useState('');
  const [showSource, setShowSource] = React.useState(false);
  const [theme, setTheme] = React.useState<'dark' | 'light'>(currentTheme);

  // The theme toggle flips a class on the root; a rendered diagram has baked
  // its colours in and has to be drawn again to follow.
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!complete) {
      setStatus('idle');
      return;
    }
    if (!code.trim()) return;

    let cancelled = false;
    setStatus('rendering');

    loadMermaid()
      .then((mermaid) => mermaid.render(nextDiagramId(), code, theme))
      .then((result) => {
        if (cancelled) return;
        setSvg(result.svg);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('failed');
      });

    return () => {
      // A diagram edited mid-render would otherwise commit the stale SVG.
      cancelled = true;
    };
  }, [code, complete, theme]);

  if (!complete || status === 'idle' || status === 'failed' || showSource) {
    return (
      <div>
        <CodeBlock lang="mermaid" text={code} complete={complete} />
        {status === 'failed' ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              margin: '-6px 0 10px',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            <Icon name="circle-alert" size={11} />
            This diagram could not be drawn; its source is above.
          </div>
        ) : null}
        {status === 'ready' && showSource ? (
          <button
            type="button"
            onClick={() => setShowSource(false)}
            style={linkButton}
          >
            <Icon name="file-diff" size={11} /> Show diagram
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <figure
      style={{
        margin: '0 0 10px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '3px 6px 3px 10px',
          borderBottom: '1px solid var(--border)',
          minHeight: 24,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
            letterSpacing: 'var(--tracking-wide)',
          }}
        >
          diagram
        </span>
        <button type="button" onClick={() => setShowSource(true)} style={linkButton}>
          <Icon name="file-text" size={11} /> Source
        </button>
      </div>
      <div
        // Mermaid runs at securityLevel 'strict', which sanitises the SVG it
        // returns and strips the interactive directives its syntax allows. That
        // is what makes injecting the result here safe for model-authored
        // source; see the comment in mermaid-entry.ts before changing it.
        dangerouslySetInnerHTML={{ __html: svg }}
        style={{
          padding: 12,
          overflowX: 'auto',
          display: 'flex',
          justifyContent: 'center',
        }}
      />
      {status === 'rendering' ? (
        <span style={{ display: 'none' }} aria-live="polite">
          Drawing diagram
        </span>
      ) : null}
    </figure>
  );
}

const linkButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 20,
  padding: '0 6px',
  background: 'transparent',
  border: '1px solid transparent',
  color: 'var(--muted-foreground)',
  font: 'inherit',
  fontSize: 'var(--text-2xs)',
  cursor: 'pointer',
  borderRadius: 'var(--radius)',
};
