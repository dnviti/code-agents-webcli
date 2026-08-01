/**
 * Whether focus is in a control that can actually summon a software keyboard.
 *
 * `inputMode="none"` matters for xterm: its hidden textarea deliberately keeps
 * hardware-key focus without asking the phone to show a keyboard.
 */
function acceptsSoftwareKeyboard(element: Element | null): boolean {
  if (!(element instanceof HTMLElement) || element.inputMode === 'none') return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    if (element.disabled || element.readOnly) return false;
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
      .includes(element.type);
  }
  return element.isContentEditable;
}

/**
 * How much of the layout viewport a software keyboard covers.
 *
 * Pinch zoom also shrinks `visualViewport.height`, but increases its `scale` by
 * the inverse amount. Comparing `height * scale` with the layout height makes
 * a pure zoom resolve to zero while preserving the real obstruction when a
 * keyboard is open — including when somebody zooms before typing.
 */
export function visualViewportKeyboardInset(
  viewport: Pick<VisualViewport, 'height' | 'scale'>,
  layoutHeight: number = window.innerHeight,
  activeElement: Element | null = document.activeElement,
): number {
  if (!acceptsSoftwareKeyboard(activeElement)) return 0;
  const scale = Number.isFinite(viewport.scale) && viewport.scale > 0 ? viewport.scale : 1;
  return Math.max(0, layoutHeight - viewport.height * scale);
}
