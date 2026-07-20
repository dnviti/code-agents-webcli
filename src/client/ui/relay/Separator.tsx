import * as React from 'react';

export type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps {
  orientation?: SeparatorOrientation;
  /**
   * Drop the separator out of the accessibility tree entirely.
   *
   * Leave this false (the default) whenever the rule marks a real boundary
   * between groups of content — that is a structural separator and screen
   * reader users benefit from hearing it. Set it true only for rules that are
   * pure decoration, e.g. the hairline between icon buttons in a toolbar,
   * where announcing a separator adds noise without adding structure.
   */
  decorative?: boolean;
  style?: React.CSSProperties;
}

export function Separator({ orientation = 'horizontal', decorative = false, style }: SeparatorProps) {
  const resolved: React.CSSProperties =
    orientation === 'vertical'
      ? { width: 1, alignSelf: 'stretch', background: 'var(--border)', ...style }
      : { height: 1, width: '100%', background: 'var(--border)', ...style };

  // ARIA defaults role="separator" to horizontal, so a vertical rule was being
  // announced as a horizontal one. The orientation is stated explicitly in both
  // directions rather than only on the vertical branch: relying on the implicit
  // default means any AT that gets that default wrong reads the common case
  // wrong too, and the attribute costs nothing.
  //
  // The role itself stays. A non-focusable separator is a legitimate ARIA
  // structural separator — it is exactly what a native <hr> maps to — and it
  // conveys a content boundary that is otherwise carried only by a 1px line
  // nobody using a screen reader can see. What it deliberately does NOT get is
  // tabIndex: a *focusable* separator is the splitter widget, which owes the
  // user aria-valuenow/valuemin/valuemax and arrow-key resizing. This component
  // resizes nothing, so making it focusable would plant a tab stop that does
  // nothing when landed on — strictly worse for keyboard users than staying out
  // of the tab order. Callers that want a draggable divider want SplitPane.
  if (decorative) {
    return <div aria-hidden="true" style={resolved} />;
  }

  return <div role="separator" aria-orientation={orientation} style={resolved} />;
}
