export const QUALIFIED_PREFIX = 'ccs1.';
export const CONTROLLER_PRODUCT_ID = 'code-agents-webcli';
export const CONTROLLER_PROTOCOL_VERSION = 1;

export interface QualifiedSessionId { serverId: string; sessionId: string; }
export interface AttachmentDescriptor { name: string; mime: string; size: number; url: string; }
export interface ControllerSessionOwner { id: string; name: string; status?: string; insecure?: boolean; }
export interface SessionDescriptor { id: string; }

export interface QualifiedSessionMetadata {
  id: string;
  serverId: string;
  serverName: string;
  serverStatus: string;
  serverInsecure: boolean;
  offline: boolean;
}

export interface ResolvedClientMessage { serverId: string; message: Record<string, unknown>; }

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Qualify a server-local session id without exposing either id as route syntax. */
export function qualifySessionId(serverId: string, sessionId: string): string {
  const pair = [
    requireIdentifier(serverId, 'Server id'),
    requireIdentifier(sessionId, 'Session id'),
  ];
  return QUALIFIED_PREFIX + encodeBase64Url(new TextEncoder().encode(JSON.stringify(pair)));
}

/** Decode only the one canonical spelling emitted by {@link qualifySessionId}. */
export function parseQualifiedSessionId(value: unknown): QualifiedSessionId | null {
  if (typeof value !== 'string' || !value.startsWith(QUALIFIED_PREFIX)) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(
      decodeBase64Url(value.slice(QUALIFIED_PREFIX.length)),
    ));
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== 'string'
      || !decoded[0]
      || typeof decoded[1] !== 'string'
      || !decoded[1]
      || qualifySessionId(decoded[0], decoded[1]) !== value
    ) return null;
    return { serverId: decoded[0], sessionId: decoded[1] };
  } catch {
    return null;
  }
}

function mapAttachmentUrls<T>(value: T, mapUrl: (url: string) => string): T {
  if (Array.isArray(value)) return value.map((entry) => mapAttachmentUrls(entry, mapUrl)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'url' && typeof entry === 'string'
      ? mapUrl(entry)
      : mapAttachmentUrls(entry, mapUrl),
  ])) as T;
}

function attachmentUrlParts(value: unknown): {
  prefix: string;
  encodedSessionId: string;
  sessionId: string;
  suffix: string;
} | null {
  if (typeof value !== 'string') return null;
  const match = /^(\/api\/sessions\/)([^/?#]+)(\/chat-attachments\/[^?#]+)([?#].*)?$/.exec(value);
  if (!match) return null;
  let sessionId;
  try { sessionId = decodeURIComponent(match[2]); } catch { return null; }
  return {
    prefix: match[1],
    encodedSessionId: match[2],
    sessionId,
    suffix: `${match[3]}${match[4] || ''}`,
  };
}

export function qualifyAttachmentUrls<T>(
  serverId: string,
  value: T,
  expectedSessionId?: string,
): T {
  const enforceMessageOwner = arguments.length >= 3;
  return mapAttachmentUrls(value, (url) => {
    const parts = attachmentUrlParts(url);
    if (!parts) return url;
    if (parseQualifiedSessionId(parts.sessionId)) {
      throw new TypeError('Upstream attachment URLs must not contain a qualified session id');
    }
    if (enforceMessageOwner && (
      typeof expectedSessionId !== 'string'
      || !expectedSessionId
      || parts.sessionId !== expectedSessionId
      || parts.encodedSessionId !== encodeURIComponent(expectedSessionId)
    )) {
      throw new TypeError('The attachment URL does not belong to the message session');
    }
    return `${parts.prefix}${encodeURIComponent(qualifySessionId(serverId, parts.sessionId))}${parts.suffix}`;
  });
}

/** Qualify the canonical capability returned by one successful upload. */
export function qualifyOwnedAttachment<T extends AttachmentDescriptor>(
  serverId: string,
  sessionId: string,
  value: T,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The attachment server returned an invalid descriptor');
  }
  if (
    typeof value.name !== 'string'
    || !value.name
    || typeof value.mime !== 'string'
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || typeof value.url !== 'string'
  ) {
    throw new TypeError('The attachment server returned an invalid descriptor');
  }
  const prefix = `/api/sessions/${encodeURIComponent(requireIdentifier(sessionId, 'Session id'))}/chat-attachments/`;
  if (!value.url.startsWith(prefix)) {
    throw new TypeError('The attachment URL does not belong to the uploaded session');
  }
  const encodedName = value.url.slice(prefix.length);
  if (!encodedName || encodedName.includes('/') || encodedName.includes('?') || encodedName.includes('#')) {
    throw new TypeError('The attachment URL is not canonical');
  }
  let storedName;
  try { storedName = decodeURIComponent(encodedName); } catch {
    throw new TypeError('The attachment URL is not canonical');
  }
  if (
    encodeURIComponent(storedName) !== encodedName
    || !/^[A-Za-z0-9._-]+$/.test(storedName)
    || storedName === '.'
    || storedName === '..'
  ) {
    throw new TypeError('The attachment URL is not canonical');
  }
  return {
    ...value,
    url: `/api/sessions/${encodeURIComponent(qualifySessionId(serverId, sessionId))}/chat-attachments/${encodedName}`,
  };
}

function resolveAttachmentUrls<T>(serverId: string, value: T): T {
  return mapAttachmentUrls(value, (url) => {
    const parts = attachmentUrlParts(url);
    const parsed = parts && parseQualifiedSessionId(parts.sessionId);
    if (!parts || !parsed) return url;
    if (parsed.serverId !== serverId) throw new TypeError('The attachment server does not own its session');
    return `${parts.prefix}${encodeURIComponent(parsed.sessionId)}${parts.suffix}`;
  });
}

export function qualifyServerMessage<T>(serverId: string, message: T): T | (T & { serverId: string }) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const source = message as Record<string, unknown>;
  const rawSessionId = typeof source.sessionId === 'string' && source.sessionId
    ? source.sessionId
    : undefined;
  const qualified: Record<string, unknown> = { ...source, serverId };
  if (rawSessionId) qualified.sessionId = qualifySessionId(serverId, rawSessionId);
  if (Array.isArray(source.sessionIds)) {
    qualified.sessionIds = source.sessionIds.map((sessionId) =>
      qualifySessionId(serverId, requireIdentifier(sessionId, 'Session id')));
  }
  return qualifyAttachmentUrls(serverId, qualified, rawSessionId) as T & { serverId: string };
}

/** Resolve a renderer message to exactly one owning upstream server. */
export function resolveClientMessage(
  message: unknown,
  fallbackServerId: string | null = null,
): ResolvedClientMessage {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('A WebSocket message must be an object');
  }
  const source = message as Record<string, unknown>;
  const resolved = { ...source };
  let serverId = typeof source.serverId === 'string' && source.serverId
    ? source.serverId
    : fallbackServerId;

  if (typeof source.sessionId === 'string' && source.sessionId) {
    const parsed = parseQualifiedSessionId(source.sessionId);
    if (!parsed) throw new TypeError('Controller WebSocket messages require a qualified session id');
    if (serverId && serverId !== parsed.serverId) {
      throw new TypeError('The message server does not own its session');
    }
    serverId = parsed.serverId;
    resolved.sessionId = parsed.sessionId;
  }

  if (Array.isArray(source.sessionIds)) {
    const parsedIds = source.sessionIds.map(parseQualifiedSessionId);
    if (parsedIds.some((entry) => !entry)) {
      throw new TypeError('Controller WebSocket messages require qualified session ids');
    }
    const validIds = parsedIds as QualifiedSessionId[];
    const owners = new Set(validIds.map((entry) => entry.serverId));
    if (owners.size > 1) throw new TypeError('One server cannot accept a cross-server session order');
    const owner = validIds[0]?.serverId;
    if (owner && serverId && serverId !== owner) {
      throw new TypeError('The message server does not own its sessions');
    }
    serverId = owner || serverId;
    resolved.sessionIds = validIds.map((entry) => entry.sessionId);
  }

  delete resolved.serverId;
  if (!serverId) throw new TypeError('A target server is required');
  return { serverId, message: resolveAttachmentUrls(serverId, resolved) };
}

export function qualifySessionList<T extends SessionDescriptor>(
  server: ControllerSessionOwner,
  sessions: readonly T[],
): Array<T & QualifiedSessionMetadata> {
  if (!server || typeof server.id !== 'string' || typeof server.name !== 'string') {
    throw new TypeError('A server identity is required');
  }
  if (!Array.isArray(sessions)) throw new TypeError('A session list is required');
  return sessions.map((session) => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string') {
      throw new TypeError('Every session requires an id');
    }
    return {
      ...session,
      id: qualifySessionId(server.id, session.id),
      serverId: server.id,
      serverName: server.name,
      serverStatus: server.status || 'unknown',
      serverInsecure: server.insecure === true,
      offline: server.status !== 'connected' && server.status !== 'ready',
    };
  });
}

export function splitSessionsByServer(qualifiedIds: unknown): Map<string, string[]> {
  if (!Array.isArray(qualifiedIds)) throw new TypeError('Session ids must be an array');
  const groups = new Map<string, string[]>();
  for (const value of qualifiedIds) {
    const parsed = parseQualifiedSessionId(value);
    if (!parsed) throw new TypeError('Controller session ids must be qualified');
    const ids = groups.get(parsed.serverId) || [];
    ids.push(parsed.sessionId);
    groups.set(parsed.serverId, ids);
  }
  return groups;
}
