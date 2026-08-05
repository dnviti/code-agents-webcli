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

/**
 * Return a transcript attachment URL only when it has the canonical route
 * shape emitted by the server. Workspace chat logs are user-editable files;
 * never turn an arbitrary value from one into a clickable browser URL.
 */
export function safeAttachmentDownloadUrl(raw: unknown, expectedSessionId?: string): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^\/api\/sessions\/([^/?#]+)\/chat-attachments\/([^/?#]+)$/.exec(raw);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]);
    if (encodeURIComponent(sessionId) !== match[1]) return null;
    if (expectedSessionId !== undefined && sessionId !== expectedSessionId) return null;
    const storedName = decodeURIComponent(match[2]);
    if (encodeURIComponent(storedName) !== match[2]) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(storedName) || storedName === '.' || storedName === '..') return null;
    return raw;
  } catch {
    return null;
  }
}

interface UploadFailure {
  error?: string;
  limitBytes?: number;
  message?: string;
  reason?: string;
  server?: { name?: string };
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
    case 'forbidden_origin':
      return 'That upload was refused as cross-origin.';
    case 'session_outside_base':
      return 'This session works outside the allowed folder, so nothing can be attached to it.';
    case 'write_failed':
      if (body.reason === 'disk_full') return `There is not enough disk space to attach ${file.name}.`;
      if (body.reason === 'permission') return `The session folder is not writable, so ${file.name} could not be attached.`;
      return `${file.name} could not be written to the session folder.`;
    case 'unsafe_attachment_dir':
      return 'The workspace attachment folder is unsafe or changed while the upload was running.';
    case 'unsupported_attachment_namespace':
      return 'This project runtime cannot safely receive attachments in its current namespace.';
    case 'session_deleted':
      return 'This session was deleted before the upload completed.';
    case 'session_persistence_unavailable':
      return body.message || 'This conversation is read-only until its workspace storage is available again.';
    case 'target_server_unavailable':
      return `${body.server?.name || 'The selected server'} is unavailable. Reconnect it, then retry the upload.`;
    case 'unknown_target_server':
    case 'target_server_required':
    case 'wrong_target_server':
    case 'qualified_session_id_invalid':
    case 'qualified_session_id_required':
      return 'The desktop app could not match this conversation to its server. Reopen the conversation and retry.';
    case 'controller_authentication_required':
    case 'authentication_required':
      return 'The desktop connection has expired. Reload the app.';
    case 'controller_request_failed':
      return body.message || `The desktop app could not transfer ${file.name}. Retry when the server is reachable.`;
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

function validatedAttachmentResponse(
  sessionId: string,
  value: unknown,
  file: File,
): ChatAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file.name} could not be attached because the server returned an invalid response.`);
  }
  const attachment = value as Partial<ChatAttachment>;
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/`;
  const encodedName = typeof attachment.url === 'string' && attachment.url.startsWith(prefix)
    ? attachment.url.slice(prefix.length)
    : '';
  let storedName = '';
  try { storedName = decodeURIComponent(encodedName); } catch { /* Rejected below. */ }
  if (
    !encodedName
    || encodedName.includes('/')
    || encodedName.includes('?')
    || encodedName.includes('#')
    || encodeURIComponent(storedName) !== encodedName
    || !/^[A-Za-z0-9._-]+$/.test(storedName)
    || storedName === '.'
    || storedName === '..'
    || typeof attachment.name !== 'string'
    || !attachment.name
    || typeof attachment.mime !== 'string'
    || !Number.isSafeInteger(attachment.size)
    || (attachment.size as number) < 0
    || (attachment.size as number) > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error(`${file.name} could not be attached because the server returned an unsafe attachment URL.`);
  }
  return attachment as ChatAttachment;
}

export async function uploadAttachment(
  sessionId: string,
  file: File,
  signal?: AbortSignal,
): Promise<ChatAttachment> {
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
    signal,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as UploadFailure;
    throw new Error(describeFailure(response.status, body, file));
  }

  return validatedAttachmentResponse(sessionId, await response.json(), file);
}
