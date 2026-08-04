'use strict';

const QUALIFIED_PREFIX = 'ccs1.';

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Session ids are only unique inside one server.  Keep the pair opaque to the
 * renderer so an id containing slashes, colons or an apparent prefix cannot
 * escape a route segment or alias another target.
 */
function qualifySessionId(serverId, sessionId) {
  const pair = [
    requireIdentifier(serverId, 'Server id'),
    requireIdentifier(sessionId, 'Session id'),
  ];
  return QUALIFIED_PREFIX + Buffer.from(JSON.stringify(pair), 'utf8').toString('base64url');
}

function parseQualifiedSessionId(value) {
  if (typeof value !== 'string' || !value.startsWith(QUALIFIED_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(QUALIFIED_PREFIX.length), 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== 'string'
      || !decoded[0]
      || typeof decoded[1] !== 'string'
      || !decoded[1]
    ) {
      return null;
    }
    // Reject non-canonical encodings.  Node's base64 decoder is intentionally
    // forgiving; accepting alternate spellings would make storage and route
    // equality subtly disagree.
    if (qualifySessionId(decoded[0], decoded[1]) !== value) return null;
    return { serverId: decoded[0], sessionId: decoded[1] };
  } catch {
    return null;
  }
}

function mapAttachmentUrls(value, mapUrl) {
  if (Array.isArray(value)) return value.map((entry) => mapAttachmentUrls(entry, mapUrl));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'url' && typeof entry === 'string'
      ? mapUrl(entry)
      : mapAttachmentUrls(entry, mapUrl),
  ]));
}

function attachmentUrlParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\/api\/sessions\/)([^/?#]+)(\/chat-attachments\/[^?#]+)([?#].*)?$/.exec(value);
  if (!match) return null;
  let sessionId;
  try { sessionId = decodeURIComponent(match[2]); } catch { return null; }
  return { prefix: match[1], sessionId, suffix: `${match[3]}${match[4] || ''}` };
}

function qualifyAttachmentUrls(serverId, value) {
  return mapAttachmentUrls(value, (url) => {
    const parts = attachmentUrlParts(url);
    if (!parts || parseQualifiedSessionId(parts.sessionId)) return url;
    return `${parts.prefix}${encodeURIComponent(qualifySessionId(serverId, parts.sessionId))}${parts.suffix}`;
  });
}

function resolveAttachmentUrls(serverId, value) {
  return mapAttachmentUrls(value, (url) => {
    const parts = attachmentUrlParts(url);
    const parsed = parts && parseQualifiedSessionId(parts.sessionId);
    if (!parts || !parsed) return url;
    if (parsed.serverId !== serverId) throw new TypeError('The attachment server does not own its session');
    return `${parts.prefix}${encodeURIComponent(parsed.sessionId)}${parts.suffix}`;
  });
}

function qualifyServerMessage(serverId, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const qualified = { ...message, serverId };
  if (typeof message.sessionId === 'string' && message.sessionId) {
    qualified.sessionId = qualifySessionId(serverId, message.sessionId);
  }
  if (Array.isArray(message.sessionIds)) {
    qualified.sessionIds = message.sessionIds.map((sessionId) =>
      qualifySessionId(serverId, requireIdentifier(sessionId, 'Session id')));
  }
  return qualifyAttachmentUrls(serverId, qualified);
}

/**
 * Resolve one renderer message to exactly one upstream server.  A message that
 * names several sessions may not cross server boundaries: tab order is a
 * server/account-owned value, so a combined visual order is never written to
 * any one remote installation.
 */
function resolveClientMessage(message, fallbackServerId = null) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('A WebSocket message must be an object');
  }
  const resolved = { ...message };
  let serverId = typeof message.serverId === 'string' && message.serverId
    ? message.serverId
    : fallbackServerId;

  if (typeof message.sessionId === 'string' && message.sessionId) {
    const parsed = parseQualifiedSessionId(message.sessionId);
    if (!parsed) throw new TypeError('Controller WebSocket messages require a qualified session id');
    if (serverId && serverId !== parsed.serverId) {
      throw new TypeError('The message server does not own its session');
    }
    serverId = parsed.serverId;
    resolved.sessionId = parsed.sessionId;
  }

  if (Array.isArray(message.sessionIds)) {
    const parsedIds = message.sessionIds.map((sessionId) => parseQualifiedSessionId(sessionId));
    if (parsedIds.some((entry) => !entry)) {
      throw new TypeError('Controller WebSocket messages require qualified session ids');
    }
    const owners = new Set(parsedIds.map((entry) => entry.serverId));
    if (owners.size > 1) throw new TypeError('One server cannot accept a cross-server session order');
    const owner = parsedIds[0]?.serverId;
    if (owner && serverId && serverId !== owner) {
      throw new TypeError('The message server does not own its sessions');
    }
    serverId = owner || serverId;
    resolved.sessionIds = parsedIds.map((entry) => entry.sessionId);
  }

  delete resolved.serverId;
  if (!serverId) throw new TypeError('A target server is required');
  return { serverId, message: resolveAttachmentUrls(serverId, resolved) };
}

function qualifySessionList(server, sessions) {
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

function splitSessionsByServer(qualifiedIds) {
  if (!Array.isArray(qualifiedIds)) throw new TypeError('Session ids must be an array');
  const groups = new Map();
  for (const value of qualifiedIds) {
    const parsed = parseQualifiedSessionId(value);
    if (!parsed) throw new TypeError('Controller session ids must be qualified');
    const ids = groups.get(parsed.serverId) || [];
    ids.push(parsed.sessionId);
    groups.set(parsed.serverId, ids);
  }
  return groups;
}

module.exports = {
  QUALIFIED_PREFIX,
  parseQualifiedSessionId,
  qualifyAttachmentUrls,
  qualifyServerMessage,
  qualifySessionId,
  qualifySessionList,
  resolveClientMessage,
  splitSessionsByServer,
};
