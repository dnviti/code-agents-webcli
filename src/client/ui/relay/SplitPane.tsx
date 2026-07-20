import * as React from 'react';

export type SplitPaneOrientation = 'vertical' | 'horizontal';

export interface SplitPaneProps {
  orientation?: SplitPaneOrientation;
  ratio?: number;
  first?: React.ReactNode;
  second?: React.ReactNode;
  minRatio?: number;
  style?: React.CSSProperties;
}

export function SplitPane({
  orientation = 'vertical',
  ratio = 0.5,
  first,
  second,
  minRatio = 0.15,
  style,
}: SplitPaneProps) {
  const sideBySide = orientation === 'vertical';
  const [r, setR] = React.useState<number>(ratio);
  const dragging = React.useRef<boolean>(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const onDown = (e: React.MouseEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.preventDefault();
  };
  React.useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !ref.current) return;
      const b = ref.current.getBoundingClientRect();
      const v = sideBySide ? (e.clientX - b.left) / b.width : (e.clientY - b.top) / b.height;
      setR(Math.min(1 - minRatio, Math.max(minRatio, v)));
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [sideBySide, minRatio]);
  const [hover, setHover] = React.useState<boolean>(false);
  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        flexDirection: sideBySide ? 'row' : 'column',
        width: '100%',
        height: '100%',
        ...style,
      }}
    >
      <div style={{ flex: '0 0 ' + r * 100 + '%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {first}
      </div>
      <div
        onMouseDown={onDown}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flex: '0 0 auto',
          position: 'relative',
          width: sideBySide ? 5 : '100%',
          height: sideBySide ? '100%' : 5,
          cursor: sideBySide ? 'col-resize' : 'row-resize',
          background: hover ? 'var(--border-strong)' : 'var(--border)',
          transition: 'background var(--duration-fast)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            margin: 'auto',
            width: sideBySide ? 1 : 22,
            height: sideBySide ? 22 : 1,
            background: 'var(--neutral-500)',
          }}
        />
      </div>
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>{second}</div>
    </div>
  );
}
