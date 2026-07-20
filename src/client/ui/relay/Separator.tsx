import * as React from 'react';

export type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps {
  orientation?: SeparatorOrientation;
  style?: React.CSSProperties;
}

export function Separator({ orientation = 'horizontal', style }: SeparatorProps) {
  const resolved: React.CSSProperties =
    orientation === 'vertical'
      ? { width: 1, alignSelf: 'stretch', background: 'var(--border)', ...style }
      : { height: 1, width: '100%', background: 'var(--border)', ...style };

  return <div role="separator" style={resolved} />;
}
