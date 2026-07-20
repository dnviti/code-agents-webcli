import * as React from 'react';

/**
 * Hosts the live terminal DOM inside the React tree without React owning it.
 *
 * xterm.js writes into a node it was handed at construction and keeps its own
 * renderer, viewport and selection bound to it. If React were allowed to create
 * that node, any re-render that unmounted or re-keyed this component would
 * destroy a running session: the PTY stays open on the server, but the client's
 * scrollback, cursor and selection are gone and the terminal has to be rebuilt.
 *
 * So the node is created once, outside React, and adopted here. React renders
 * only the empty frame around it and never sees its children. The effect is
 * keyed on the node itself, which never changes, so the adoption happens once
 * and re-renders are inert.
 */
export interface TerminalHostProps {
  /** Created once at startup and owned by the imperative terminal modules. */
  node: HTMLElement;
  /** Called after the node is adopted or the frame resizes, to re-fit xterm. */
  onResize?: () => void;
}

export function TerminalHost({ node, onResize }: TerminalHostProps): React.JSX.Element {
  const frameRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // Guarded rather than unconditional: re-appending a node that is already
    // in place still detaches and re-inserts it, and xterm reacts to that by
    // losing the viewport scroll position.
    if (node.parentElement !== frame) {
      frame.appendChild(node);
      onResize?.();
    }
  }, [node, onResize]);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;

    // The chrome around the terminal changes size for reasons xterm cannot see
    // (sidebar toggled, status bar appearing), and a stale fit leaves the PTY
    // on the wrong cols/rows.
    const observer = new ResizeObserver(() => onResize?.());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [onResize]);

  return (
    <div
      ref={frameRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        background: 'var(--terminal-bg)',
        overflow: 'hidden',
      }}
    />
  );
}
