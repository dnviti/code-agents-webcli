import * as React from 'react';

export type TerminalColor = string;

export interface TerminalSegment {
  text?: React.ReactNode;
  color?: TerminalColor;
  bold?: boolean;
}

export interface TerminalLineObject {
  type?: string;
  text?: React.ReactNode;
  color?: TerminalColor;
  cwd?: string;
  branch?: string;
  segments?: TerminalSegment[];
}

export type TerminalLine = string | TerminalLineObject;

export interface TerminalPaneProps {
  lines?: TerminalLine[];
  user?: string;
  cwd?: string;
  branch?: string;
  input?: string;
  focused?: boolean;
  showPrompt?: boolean;
  style?: React.CSSProperties;
}

function resolveColor(c?: TerminalColor): string {
  if (!c) return 'var(--terminal-fg)';
  if (c === 'dim') return 'var(--terminal-dim)';
  if (c === 'prompt') return 'var(--terminal-prompt)';
  if (c === 'fg') return 'var(--terminal-fg)';
  if (c[0] === '#' || c.indexOf('(') !== -1 || c.indexOf('var(') === 0) return c;
  return 'var(--ansi-' + c + ')';
}

interface PromptProps {
  user?: string;
  cwd?: string;
  branch?: string;
}

function Prompt({ user, cwd, branch }: PromptProps): React.JSX.Element {
  return (
    <span>
      <span style={{ color: 'var(--terminal-prompt)' }}>{user}</span>
      <span style={{ color: 'var(--terminal-dim)' }}>{' ' + cwd + ' '}</span>
      {branch ? <span style={{ color: 'var(--ansi-blue)' }}>{branch + ' '}</span> : null}
      <span style={{ color: 'var(--terminal-fg)' }}>$ </span>
    </span>
  );
}

export function TerminalPane({
  lines = [],
  user = 'relay',
  cwd = '~/dev',
  branch = 'main',
  input = '',
  focused = true,
  showPrompt = true,
  style,
}: TerminalPaneProps): React.JSX.Element {
  const rootStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    background: 'var(--terminal-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-ui)',
    lineHeight: 'var(--leading-terminal)',
    color: 'var(--terminal-fg)',
    padding: '12px 14px',
    overflow: 'auto',
    boxSizing: 'border-box',
    ...style,
  };

  const cursorStyle: React.CSSProperties = {
    display: 'inline-block',
    width: 8,
    height: 15,
    marginLeft: 1,
    verticalAlign: 'text-bottom',
    background: focused ? 'var(--terminal-cursor)' : 'transparent',
    border: focused ? 'none' : '1px solid var(--terminal-dim)',
    animation: focused ? 'relay-cursor-blink 1.05s step-end infinite' : 'none',
  };

  return (
    <div style={rootStyle}>
      {lines.map((ln, i) => {
        if (typeof ln === 'string') return <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{ln}</div>;
        if (ln.type === 'cmd') return (
          <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
            <Prompt user={user} cwd={ln.cwd || cwd} branch={ln.branch !== undefined ? ln.branch : branch} />
            <span>{ln.text}</span>
          </div>
        );
        if (Array.isArray(ln.segments)) return (
          <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {ln.segments.map((sg, j) => <span key={j} style={{ color: resolveColor(sg.color), fontWeight: sg.bold ? 600 : 400 }}>{sg.text}</span>)}
          </div>
        );
        return <div key={i} style={{ whiteSpace: 'pre-wrap', color: resolveColor(ln.color) }}>{ln.text}</div>;
      })}
      {showPrompt ? (
        <div style={{ whiteSpace: 'pre-wrap' }}>
          <Prompt user={user} cwd={cwd} branch={branch} />
          <span>{input}</span>
          <span style={cursorStyle} />
        </div>
      ) : null}
    </div>
  );
}
