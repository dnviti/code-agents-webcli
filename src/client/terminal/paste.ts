// Clipboard and drag-and-drop image support for a terminal.
//
// A browser cannot hand an image to a PTY, so the bytes are uploaded, written
// into the session's working directory, and the resulting path is typed into
// the terminal for the agent to read.

import { classifyPaste, MAX_IMAGES_PER_PASTE, PasteCandidate } from '../../shared/paste-classify';
import { showNotification } from '../ui/notifications';
import { controllerFetch, getControllerSnapshot, parseQualifiedSessionId } from '../controller/transport';

/** Must match PASTE_MAX_BYTES on the server. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface ImagePasteTarget {
  /** The element handed to controller.open(). */
  element: HTMLElement;
  getSessionId(): string | null;
  /**
   * Re-emit clipboard text as a paste.
   *
   * Delegates to xterm rather than writing the bytes ourselves, because only
   * xterm knows whether the attached program has enabled bracketed paste. Sent
   * raw, a multi-line clipboard would execute line by line in a shell instead
   * of arriving as one inert block.
   */
  pasteText(text: string): void;
  isConnected(): boolean;
}

/** One upload at a time per session — a split and the main terminal share one. */
const busySessions = new Set<string>();

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toCandidates(files: File[]): PasteCandidate[] {
  return files.map((file) => ({ kind: 'file', type: file.type, size: file.size }));
}

function filesFrom(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }

  // dt.files is the best-supported source; items covers the browsers that
  // expose a pasted screenshot only there.
  if (data.files && data.files.length > 0) {
    return Array.from(data.files);
  }

  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        out.push(file);
      }
    }
  }
  return out;
}

async function upload(sessionId: string, file: File): Promise<string | null> {
  const controller = new AbortController();
  // fetch has no timeout of its own, and a stalled mobile connection would
  // otherwise leave the session's busy flag set until a page reload.
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await controllerFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/paste-image`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: controller.signal,
      },
    );

    if (response.ok) {
      const body = (await response.json()) as { insertText?: string };
      return typeof body.insertText === 'string' ? body.insertText : null;
    }

    if (response.status === 401) {
      const controllerState = getControllerSnapshot();
      if (controllerState.enabled) {
        const owner = parseQualifiedSessionId(sessionId)?.serverId;
        const target = controllerState.targets.find((item) => item.id === owner);
        showNotification(`Sign in to ${target?.name || 'this server'} to upload the image.`, 'error');
        return null;
      }
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
      return null;
    }

    showNotification(await describeFailure(response), 'error');
    return null;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      showNotification('The image upload timed out.', 'error');
    } else {
      showNotification('Could not reach the server to upload the image.', 'error');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a failed response into something worth reading.
 *
 * Parsed defensively: a fronting nginx answers 413 with its own HTML, so
 * res.json() would throw exactly when the most likely error occurs.
 */
async function describeFailure(response: Response): Promise<string> {
  let error = '';
  if (response.headers.get('content-type')?.includes('json')) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    error = body.error ?? '';
  }

  switch (error) {
    case 'image_too_large':
      return `That image is over the ${formatBytes(MAX_IMAGE_BYTES)} limit.`;
    case 'unsupported_image_type':
      // SVG is refused deliberately, and HEIC is what an iPhone library hands
      // over when the browser does not convert it.
      return 'Unsupported image format. Use PNG, JPEG, GIF, WebP or BMP — SVG and HEIC are not accepted.';
    case 'session_outside_base':
      return 'This session\'s working directory is no longer allowed. Pick another folder.';
    case 'unsafe_paste_dir':
      return 'The .cc-web directory is a symlink, so writing there was refused.';
    case 'session_gone':
      return 'That session was deleted while the image was uploading.';
    case 'quota_exceeded':
      return 'This session has stored as many pasted images as it is allowed.';
    case 'write_failed':
      return 'The image could not be written to the working directory.';
    case 'empty_body':
      return 'That image was empty.';
    default:
      break;
  }

  if (response.status === 413) {
    // Often a reverse proxy rather than us; the limit is the same either way.
    return `That image is over the ${formatBytes(MAX_IMAGE_BYTES)} limit.`;
  }
  if (response.status === 404) {
    return 'That session no longer exists.';
  }
  return `The image could not be saved (HTTP ${response.status}).`;
}

async function handleImages(
  target: ImagePasteTarget,
  files: File[],
  trailingText: string,
): Promise<void> {
  const sessionId = target.getSessionId();
  if (!sessionId) {
    showNotification('Open a session before pasting an image.', 'error');
    return;
  }

  if (busySessions.has(sessionId)) {
    showNotification('An image is still uploading.', 'error');
    return;
  }

  const classification = classifyPaste(toCandidates(files), MAX_IMAGE_BYTES);

  for (const index of classification.oversize) {
    showNotification(
      `${files[index].name || 'That image'} is ${formatBytes(files[index].size)}, over the `
      + `${formatBytes(MAX_IMAGE_BYTES)} limit.`,
      'error',
    );
  }
  if (classification.overflow > 0) {
    showNotification(
      `Only the first ${MAX_IMAGES_PER_PASTE} images were attached; `
      + `${classification.overflow} more were skipped.`,
      'error',
    );
  }

  if (classification.accepted.length === 0) {
    // The text half of a mixed paste must not be lost just because the image
    // half was refused.
    if (trailingText) {
      target.pasteText(trailingText);
    }
    return;
  }

  busySessions.add(sessionId);
  target.element.classList.add('terminal-upload-active');

  try {
    // Sequential, so the injected paths keep clipboard order.
    for (const index of classification.accepted) {
      const insertText = await upload(sessionId, files[index]);
      if (!insertText) {
        continue;
      }

      // The upload takes seconds; the user may have switched tabs since. The
      // path must never land in a different session's terminal.
      if (target.getSessionId() !== sessionId) {
        showNotification(`Image saved, but the session changed: ${insertText.trim()}`, 'error');
        continue;
      }

      if (!target.isConnected()) {
        showNotification(`Image saved: ${insertText.trim()}`);
        continue;
      }

      // Through xterm's paste path rather than a raw socket write, so the
      // markers go out exactly when the attached program has asked for them.
      // That is what tells an agent the path was pasted rather than typed, and
      // it is the difference between an attachment and a filename sitting at
      // the prompt (issue #18); a plain shell gets what it always got.
      target.pasteText(insertText);
    }

    if (trailingText && target.getSessionId() === sessionId && target.isConnected()) {
      // Last, so the caret ends after the user's own words.
      target.pasteText(trailingText);
    }
  } finally {
    busySessions.delete(sessionId);
    target.element.classList.remove('terminal-upload-active');
  }
}

/**
 * Intercept image pastes on a terminal.
 *
 * Registered in the CAPTURE phase, which is not optional: xterm's own paste
 * handler calls stopPropagation() and is attached to both its helper textarea
 * and its .xterm div, so a bubble-phase listener on the container never sees a
 * paste at all while the terminal has focus.
 */
export function attachImagePaste(target: ImagePasteTarget): () => void {
  const onPaste = (event: ClipboardEvent): void => {
    const data = event.clipboardData;
    if (!data) {
      return;
    }

    const files = filesFrom(data);
    const classification = classifyPaste(toCandidates(files), MAX_IMAGE_BYTES);
    if (!classification.handled) {
      // THE load-bearing early return: a text-only paste is left entirely to
      // xterm, default not prevented, propagation not stopped.
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void handleImages(target, files, data.getData('text/plain'));
  };

  target.element.addEventListener('paste', onPaste, { capture: true });
  return () => target.element.removeEventListener('paste', onPaste, { capture: true });
}

/** Drag-and-drop onto a terminal, using the same upload path. */
export function attachImageDrop(target: ImagePasteTarget): () => void {
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) {
      return;
    }
    // Mandatory: without preventDefault the browser navigates to the dropped
    // file on drop, which would take every live session down with it.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    target.element.classList.add('terminal-drop-active');
  };

  const onDragLeave = (): void => {
    target.element.classList.remove('terminal-drop-active');
  };

  const onDrop = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    // Keeps the drop off the session-tab drop zone on the ancestor container.
    event.stopPropagation();
    target.element.classList.remove('terminal-drop-active');
    void handleImages(target, filesFrom(event.dataTransfer), '');
  };

  target.element.addEventListener('dragover', onDragOver);
  target.element.addEventListener('dragleave', onDragLeave);
  target.element.addEventListener('drop', onDrop);

  return () => {
    target.element.removeEventListener('dragover', onDragOver);
    target.element.removeEventListener('dragleave', onDragLeave);
    target.element.removeEventListener('drop', onDrop);
  };
}

/**
 * Swallow file drags that land anywhere outside a terminal.
 *
 * Without this the browser navigates to the dropped file, which tears down the
 * page and every live session with it. It has to be global rather than on
 * #terminalContainer: that element is hidden entirely in split view, and it
 * excludes the gutter around it and the header above it.
 *
 * The per-terminal handlers call stopPropagation(), so a drop on an actual
 * terminal never reaches this and still uploads.
 */
export function installFileDropGuard(): void {
  const swallowIfFiles = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
    }
  };

  window.addEventListener('dragover', swallowIfFiles);
  window.addEventListener('drop', swallowIfFiles);
}

/**
 * A file picker, for touch devices with no drag source and for anyone who
 * would rather not use the clipboard.
 */
export function pickImage(target: ImagePasteTarget): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';
  input.multiple = true;
  input.setAttribute('aria-label', 'Attach an image to this session');
  input.style.display = 'none';

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length > 0) {
      void handleImages(target, files, '');
    }
  });

  document.body.appendChild(input);
  input.click();
}
