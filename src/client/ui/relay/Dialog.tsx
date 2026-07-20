import * as React from 'react';

export interface DialogProps {
  open?: boolean;
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: React.MouseEventHandler<HTMLElement>;
  width?: React.CSSProperties['width'];
  children?: React.ReactNode;
}

export function Dialog({
  open = true,
  title,
  description,
  footer,
  onClose,
  width = 440,
  children,
}: DialogProps): React.JSX.Element | null {
  if (!open) return null;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, background: 'var(--overlay)', animation: 'relay-fade-in var(--duration-base)',
  };
  const panelStyle: React.CSSProperties = {
    width, maxWidth: '100%', background: 'var(--popover)', border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius)', animation: 'relay-scale-in var(--duration-base) var(--ease-out)',
  };
  const headerStyle: React.CSSProperties = { padding: '16px 18px', borderBottom: '1px solid var(--border)' };
  const headerRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
  const titleStyle: React.CSSProperties = { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'], color: 'var(--foreground)' };
  const closeStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2 };
  const descriptionStyle: React.CSSProperties = { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-normal)' };
  const bodyStyle: React.CSSProperties = { padding: '16px 18px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)', color: 'var(--foreground)' };
  const footerStyle: React.CSSProperties = { padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 };

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} style={panelStyle}>
        <div style={headerStyle}>
          <div style={headerRowStyle}>
            <h2 style={titleStyle}>{title}</h2>
            {onClose ? <button onClick={onClose} aria-label="Close" style={closeStyle}>✕</button> : null}
          </div>
          {description ? <p style={descriptionStyle}>{description}</p> : null}
        </div>
        {children ? <div style={bodyStyle}>{children}</div> : null}
        {footer ? <div style={footerStyle}>{footer}</div> : null}
      </div>
    </div>
  );
}
