import { basename } from './file-language.js';

/**
 * Which files the browser can show or play rather than edit.
 *
 * A screenshot, a screen recording, a voice note and a PDF are all things an
 * agent produces or is handed, and all four used to open as "this file is
 * binary".
 * The file editor can do better than that, because the browser already knows
 * how to render every one of them.
 *
 * Decided from the name, not from the bytes. That is the opposite of the rule
 * the attachment store follows, and deliberately: this only ever picks which
 * *element* to render — `<img>`, `<video>`, `<audio>` — and getting it wrong
 * costs a broken preview, not a security boundary. What the server sends the
 * bytes back as is a separate decision made from the content (see the raw
 * route), and that one is where being wrong would matter.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

export interface MediaType {
  kind: MediaKind;
  /** The type the element is told to expect. Advisory; the server decides. */
  mime: string;
}

/**
 * Extension → what to render it with.
 *
 * Only formats browsers actually play. A `.mkv` or a `.flac` would produce an
 * element that loads and then silently refuses, which is a worse answer than
 * "this file is binary" — at least that one is true.
 */
const BY_EXTENSION: Record<string, MediaType> = {
  // Images.
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  avif: { kind: 'image', mime: 'image/avif' },
  // SVG is an image here and a hostile document everywhere else: it is XML that
  // can carry script and external references. It is previewed because a repo is
  // full of them and `<img>` never runs their script — and the route that
  // serves it sandboxes it besides, for the case where someone opens the URL
  // directly.
  svg: { kind: 'image', mime: 'image/svg+xml' },

  // Video.
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mov: { kind: 'video', mime: 'video/quicktime' },

  // Audio.
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },

  // Documents the browser has its own viewer for. Nothing here renders the
  // format; the browser does, in a frame, with its own search and page list.
  pdf: { kind: 'pdf', mime: 'application/pdf' },
};

/** What to show this file with, or null when it is not media at all. */
export function mediaTypeForFile(filePath: string): MediaType | null {
  const name = basename(String(filePath || '')).toLowerCase();
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(lastDot + 1)] ?? null;
}

/**
 * Whether a file is markdown, and so worth showing rendered before raw.
 *
 * Separate from `languageForFile`, which answers "which highlighter" and folds
 * `.mdx` onto markdown for that purpose. This is a different question with a
 * different answer: what the file *is*, so the dialog knows which view to open
 * in.
 */
export function isMarkdownFile(filePath: string): boolean {
  return extensionOf(filePath) === 'md'
    || extensionOf(filePath) === 'markdown'
    || extensionOf(filePath) === 'mdx';
}

/**
 * A file the browser can render as a page.
 *
 * Only the two that *are* a document. Deliberately not `.xhtml`, `.svg` or a
 * template language: a Handlebars or JSX file whose extension happens to end in
 * `html` renders as a page full of its own braces, which looks like a broken
 * preview rather than the source it actually is.
 */
export function isHtmlFile(filePath: string): boolean {
  const extension = extensionOf(filePath);
  return extension === 'html' || extension === 'htm';
}

function extensionOf(filePath: string): string {
  const name = basename(String(filePath || '')).toLowerCase();
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return name.slice(lastDot + 1);
}
