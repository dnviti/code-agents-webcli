import * as React from "react";

/**
 * Relay icon set — Lucide (ISC license), vendored from the Relay design system.
 *
 * Each entry is an inline SVG string themed with `currentColor` and no explicit
 * size, so the surrounding element's `color` and box drive both. They are static
 * build-time assets from this repo, never user input, which is why rendering
 * them as markup is safe here.
 */
export const RELAY_ICONS: Record<string, string> = {
  "chevron-down": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"m6 9 6 6 6-6\"></path>\n</svg>",
  "chevron-right": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"m9 18 6-6-6-6\"></path>\n</svg>",
  "circle": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <circle cx=\"12\" cy=\"12\" r=\"10\"></circle>\n</svg>",
  "command": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\"></path>\n</svg>",
  "copy": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"></rect>\n  <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"></path>\n</svg>",
  "corner-down-left": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M20 4v7a4 4 0 0 1-4 4H4\"></path>\n  <path d=\"m9 10-5 5 5 5\"></path>\n</svg>",
  "cpu": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M12 20v2\"></path>\n  <path d=\"M12 2v2\"></path>\n  <path d=\"M17 20v2\"></path>\n  <path d=\"M17 2v2\"></path>\n  <path d=\"M2 12h2\"></path>\n  <path d=\"M2 17h2\"></path>\n  <path d=\"M2 7h2\"></path>\n  <path d=\"M20 12h2\"></path>\n  <path d=\"M20 17h2\"></path>\n  <path d=\"M20 7h2\"></path>\n  <path d=\"M7 20v2\"></path>\n  <path d=\"M7 2v2\"></path>\n  <rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"></rect>\n  <rect x=\"8\" y=\"8\" width=\"8\" height=\"8\" rx=\"1\"></rect>\n</svg>",
  "ellipsis": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <circle cx=\"12\" cy=\"12\" r=\"1\"></circle>\n  <circle cx=\"19\" cy=\"12\" r=\"1\"></circle>\n  <circle cx=\"5\" cy=\"12\" r=\"1\"></circle>\n</svg>",
  "folder": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"></path>\n</svg>",
  "git-branch": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M15 6a9 9 0 0 0-9 9V3\"></path>\n  <circle cx=\"18\" cy=\"6\" r=\"3\"></circle>\n  <circle cx=\"6\" cy=\"18\" r=\"3\"></circle>\n</svg>",
  "hard-drive": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M10 16h.01\"></path>\n  <path d=\"M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"></path>\n  <path d=\"M21.946 12.013H2.054\"></path>\n  <path d=\"M6 16h.01\"></path>\n</svg>",
  "keyboard": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M10 8h.01\"></path>\n  <path d=\"M12 12h.01\"></path>\n  <path d=\"M14 8h.01\"></path>\n  <path d=\"M16 12h.01\"></path>\n  <path d=\"M18 8h.01\"></path>\n  <path d=\"M6 8h.01\"></path>\n  <path d=\"M7 16h10\"></path>\n  <path d=\"M8 12h.01\"></path>\n  <rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"></rect>\n</svg>",
  "monitor": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"></rect>\n  <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"></line>\n  <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"></line>\n</svg>",
  "panel-left": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect>\n  <path d=\"M9 3v18\"></path>\n</svg>",
  "plug": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M12 22v-5\"></path>\n  <path d=\"M15 8V2\"></path>\n  <path d=\"M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z\"></path>\n  <path d=\"M9 8V2\"></path>\n</svg>",
  "plus": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M5 12h14\"></path>\n  <path d=\"M12 5v14\"></path>\n</svg>",
  "search": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"m21 21-4.34-4.34\"></path>\n  <circle cx=\"11\" cy=\"11\" r=\"8\"></circle>\n</svg>",
  "server": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"></rect>\n  <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"></rect>\n  <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"></line>\n  <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"></line>\n</svg>",
  "settings": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"></path>\n  <circle cx=\"12\" cy=\"12\" r=\"3\"></circle>\n</svg>",
  "square-split-horizontal": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M8 19H5c-1 0-2-1-2-2V7c0-1 1-2 2-2h3\"></path>\n  <path d=\"M16 5h3c1 0 2 1 2 2v10c0 1-1 2-2 2h-3\"></path>\n  <line x1=\"12\" x2=\"12\" y1=\"4\" y2=\"20\"></line>\n</svg>",
  "square-split-vertical": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M5 8V5c0-1 1-2 2-2h10c1 0 2 1 2 2v3\"></path>\n  <path d=\"M19 16v3c0 1-1 2-2 2H7c-1 0-2-1-2-2v-3\"></path>\n  <line x1=\"4\" x2=\"20\" y1=\"12\" y2=\"12\"></line>\n</svg>",
  "terminal": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M12 19h8\"></path>\n  <path d=\"m4 17 6-6-6-6\"></path>\n</svg>",
  "trash-2": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M10 11v6\"></path>\n  <path d=\"M14 11v6\"></path>\n  <path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"></path>\n  <path d=\"M3 6h18\"></path>\n  <path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"></path>\n</svg>",
  "wifi": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M12 20h.01\"></path>\n  <path d=\"M2 8.82a15 15 0 0 1 20 0\"></path>\n  <path d=\"M5 12.859a10 10 0 0 1 14 0\"></path>\n  <path d=\"M8.5 16.429a5 5 0 0 1 7 0\"></path>\n</svg>",
  "x": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n  <path d=\"M18 6 6 18\"></path>\n  <path d=\"m6 6 12 12\"></path>\n</svg>",
};

export type IconName = keyof typeof RELAY_ICONS;

export interface IconProps {
  name: string;
  size?: number;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 14, style }: IconProps): React.ReactElement | null {
  const svg = RELAY_ICONS[name];
  if (!svg) {
    // A missing icon should leave a gap, not tear down the surrounding tree.
    return null;
  }
  return (
    <span
      className="ricon"
      aria-hidden="true"
      style={{ display: "inline-block", width: size, height: size, flex: "0 0 auto", ...style }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
