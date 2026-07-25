/**
 * What a file really is, from its first bytes.
 *
 * This decides the `Content-Type` the raw file route sends back, which makes it
 * a security boundary rather than a convenience: a file called `photo.png` that
 * is actually HTML must not come back as HTML from this app's own origin, and
 * the only thing that cannot be talked into it is the content itself. The name
 * is never consulted here — except for SVG, which has no magic number at all
 * and is handled explicitly and narrowly below.
 *
 * Anything not recognised is deliberately *not* identified. The caller turns
 * that into `application/octet-stream` and a download, which is the honest
 * answer for a file this module cannot vouch for.
 */

export type SniffedKind = 'image' | 'video' | 'audio' | 'pdf';

export interface SniffedType {
  kind: SniffedKind;
  mime: string;
}

const ascii = (bytes: Uint8Array, from: number, to: number): string => {
  let out = '';
  for (let i = from; i < to && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

const startsWith = (bytes: Uint8Array, signature: number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
};

/**
 * Identify a file from its head.
 *
 * `head` need only be the first few hundred bytes; every signature here lives
 * in the first sixteen except the Ogg codec probe, which reads a little
 * further to tell a video stream from an audio one.
 */
export function sniffMediaType(head: Uint8Array): SniffedType | null {
  if (head.length < 12) return null;

  // ---- Documents -------------------------------------------------------
  if (ascii(head, 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };

  // ---- Images ----------------------------------------------------------
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(head, 0, 3) === 'GIF') return { kind: 'image', mime: 'image/gif' };
  if (startsWith(head, [0x42, 0x4d])) return { kind: 'image', mime: 'image/bmp' };
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return { kind: 'image', mime: 'image/x-icon' };

  // RIFF containers carry their real type at offset 8: WEBP is an image, WAVE
  // is audio, and AVI is a video nothing here plays.
  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 12);
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' };
    if (form === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
    return null;
  }

  // ---- ISO base media (MP4 / M4A / MOV / AVIF) -------------------------
  // The box length occupies the first four bytes, so the signature is at 4.
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand.startsWith('avif') || brand.startsWith('avis')) {
      return { kind: 'image', mime: 'image/avif' };
    }
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) {
      return { kind: 'audio', mime: 'audio/mp4' };
    }
    if (brand.startsWith('qt')) return { kind: 'video', mime: 'video/quicktime' };
    return { kind: 'video', mime: 'video/mp4' };
  }

  // ---- Matroska / WebM -------------------------------------------------
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    // The doctype string appears within the first few dozen bytes. Only WebM is
    // worth claiming: a browser told `video/webm` about a general Matroska file
    // loads it and then silently refuses to play.
    return ascii(head, 0, 64).includes('webm') ? { kind: 'video', mime: 'video/webm' } : null;
  }

  // ---- Ogg -------------------------------------------------------------
  if (ascii(head, 0, 4) === 'OggS') {
    // The codec name sits in the first page header. Theora means it is a video
    // stream; anything else here is one of the audio codecs.
    const window = ascii(head, 0, Math.min(head.length, 256));
    if (window.includes('theora')) return { kind: 'video', mime: 'video/ogg' };
    return { kind: 'audio', mime: 'audio/ogg' };
  }

  // ---- Bare audio streams ---------------------------------------------
  if (ascii(head, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac' };
  if (ascii(head, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg' };
  // MPEG frame sync: eleven set bits. Also matches ADTS AAC, which browsers
  // decode from an `audio/mpeg` response anyway.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }

  return null;
}

/**
 * Whether these bytes are plausibly the SVG the filename claims.
 *
 * SVG is the one format with no magic number, and identifying it properly means
 * parsing untrusted XML — which the paste store refuses to do for exactly the
 * reasons that make SVG dangerous. So this is deliberately shallow: it is only
 * ever consulted when the *name* already said `.svg`, it only has to reject a
 * file that is obviously something else, and whatever it lets through is served
 * under a `sandbox` CSP that stops the format's script from mattering.
 */
export function looksLikeSvg(head: Uint8Array): boolean {
  const text = ascii(head, 0, Math.min(head.length, 1024)).trimStart().toLowerCase();
  if (!text.startsWith('<')) return false;
  return text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!doctype svg');
}
