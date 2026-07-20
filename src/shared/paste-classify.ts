/**
 * Decides what to do with a paste or drop, without touching the DOM.
 *
 * Split out from the browser module so the mocha suite can cover it: the
 * highest-blast-radius behaviour here is the *negative* one — a text-only
 * paste must be left completely alone — and CI runs `mocha test/*.test.js`
 * without a browser.
 */

export const MAX_IMAGES_PER_PASTE = 4;

/** Structurally what a DataTransferItem/File gives us, with no DOM types. */
export interface PasteCandidate {
  /** 'file' or 'string'. */
  kind: string;
  /** The client-declared MIME type, which the server does not trust. */
  type: string;
  size: number;
}

export interface PasteClassification {
  /**
   * True when this event carries images we will handle ourselves, and the
   * browser default (and xterm's own handler) must be suppressed.
   */
  handled: boolean;
  /** Indexes of candidates to upload, in clipboard order. */
  accepted: number[];
  /** Indexes rejected for exceeding the per-image cap. */
  oversize: number[];
  /** How many images were dropped because of the per-paste cap. */
  overflow: number;
}

function isImage(candidate: PasteCandidate): boolean {
  return candidate.kind === 'file' && candidate.type.startsWith('image/');
}

/**
 * A paste is ours only if it actually carries an image.
 *
 * The early "no images" answer is what keeps ordinary text pasting untouched:
 * the caller returns without preventing the default, so xterm receives the
 * event exactly as before, including its own bracketed-paste wrapping.
 */
export function classifyPaste(
  candidates: PasteCandidate[],
  maxBytes: number,
): PasteClassification {
  const accepted: number[] = [];
  const oversize: number[] = [];
  let overflow = 0;

  candidates.forEach((candidate, index) => {
    if (!isImage(candidate)) {
      return;
    }
    if (candidate.size > maxBytes) {
      oversize.push(index);
      return;
    }
    if (accepted.length >= MAX_IMAGES_PER_PASTE) {
      // A folder drag can carry hundreds of files, and each one is an upload.
      overflow += 1;
      return;
    }
    accepted.push(index);
  });

  return {
    // An oversize image still counts as handled: the user pasted a picture and
    // deserves to be told it was too big, not to have its bytes typed into the
    // terminal as text.
    handled: accepted.length > 0 || oversize.length > 0 || overflow > 0,
    accepted,
    oversize,
    overflow,
  };
}
