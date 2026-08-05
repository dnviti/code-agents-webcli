import type { ChatAttachment } from '../../shared/chat-events.js';
import { controllerFetch } from '../controller/transport.js';

/**
 * The browser's half of the chat attachment route.
 *
 * Raw bytes with the name in the query string, matching what the server
 * accepts — see src/server/routes/chat-attachments.ts for why there is no
 * multipart form here.
 *
 * The response is already a `ChatAttachment`, so nothing in this file reshapes
 * it: the composer holds it and posts it straight back on the turn.
 */

/** Mirrors DEFAULT_MAX_ATTACHMENT_BYTES, so the UI can refuse before uploading. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface UploadFailure {
  error?: string;
  limitBytes?: number;
}

/** What the server's error codes mean, in words a person can act on. */
function describeFailure(status: number, body: UploadFailure, file: File): string {
  switch (body.error) {
    case 'file_too_large':
      return `${file.name} is too large. The limit is ${formatBytes(body.limitBytes ?? MAX_ATTACHMENT_BYTES)}.`;
    case 'quota_exceeded':
      return 'This session has attached as much as it is allowed to. Start a new one, or clear .cc-web/attachments.';
    case 'empty_body':
      return `${file.name} is empty.`;
    case 'cross_origin':
      return 'That upload was refused as cross-origin.';
    case 'session_outside_base':
      return 'This session works outside the allowed folder, so nothing can be attached to it.';
    case 'write_failed':
      return `${file.name} could not be written to the session folder.`;
    default:
      if (status === 401) return 'You have been signed out. Reload the page.';
      if (status === 404) return 'This session is gone.';
      return `${file.name} could not be attached (${status}).`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadAttachment(sessionId: string, file: File): Promise<ChatAttachment> {
  // Checked here as well as on the server: a 20 MB body that is going to be
  // rejected is 20 MB somebody's phone uploaded over a hotel connection first.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is too large. The limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
  }
  if (file.size === 0) {
    throw new Error(`${file.name} is empty.`);
  }

  const url =
    `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments`
    + `?name=${encodeURIComponent(file.name || 'attachment')}`;

  const response = await controllerFetch(url, {
    method: 'POST',
    // The browser's guess at the type. The server records it for display and
    // never serves it back as a content type.
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as UploadFailure;
    throw new Error(describeFailure(response.status, body, file));
  }

  return (await response.json()) as ChatAttachment;
}
