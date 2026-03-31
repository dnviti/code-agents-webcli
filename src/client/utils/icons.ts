// Inline SVG icon helpers. Each function returns an SVG string using currentColor.

interface SvgAttrs {
  width?: number;
  height?: number;
  viewBox?: string;
  strokeWidth?: number;
}

function toSvg(pathOrContent: string, attrs: SvgAttrs = {}): string {
  const base: Record<string, string | number> = {
    width: attrs.width ?? 16,
    height: attrs.height ?? 16,
    viewBox: attrs.viewBox ?? '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': attrs.strokeWidth ?? 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  const attrStr = Object.entries(base)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<svg ${attrStr}>${pathOrContent}</svg>`;
}

export const check = (s = 16): string =>
  toSvg('<polyline points="20 6 9 17 4 12"/>', { width: s, height: s });

export const x = (s = 16): string =>
  toSvg(
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    { width: s, height: s },
  );

export const clipboard = (s = 16): string =>
  toSvg(
    '<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="7" x2="16" y2="7"/>',
    { width: s, height: s },
  );

export const folder = (s = 16): string =>
  toSvg(
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    { width: s, height: s },
  );

export const download = (s = 16): string =>
  toSvg(
    '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 21h14"/>',
    { width: s, height: s },
  );

export const chartLine = (s = 16): string =>
  toSvg(
    '<polyline points="3 17 9 11 13 15 21 7"/><line x1="3" y1="17" x2="3" y2="21"/><line x1="21" y1="7" x2="21" y2="11"/>',
    { width: s, height: s },
  );

export const dot = (s = 10): string =>
  toSvg('<circle cx="12" cy="12" r="5"/>', {
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    strokeWidth: 0,
  });
