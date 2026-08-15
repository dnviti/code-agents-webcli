import path from 'node:path';
import { readDraft } from '../../../../chat/drafts.js';
import type { ChatDraft } from '../../../../../shared/chat-events.js';
import type { SessionRecord, SessionStorageScope } from '../../../../types.js';

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Read an untrusted portable draft without letting its JSON bypass wire limits. */
export function parseStoredDraft(value: string | null, sessionId: string): ChatDraft | undefined {
  const parsed = parseJson<Record<string, unknown> | null>(value, null);
  if (!parsed) return undefined;
  const input = readDraft(parsed.text, parsed.attachments, sessionId);
  if (!input) return undefined;
  const revision = Number(parsed.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { ...input, revision };
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function requireAbsoluteWorkspace(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('workspaceRoot must be absolute');
  return value;
}

export function requireOwnerKey(value: string | null): string {
  if (!value) throw new Error('ownerKey is required with workspaceRoot');
  return value;
}

export function scopeKey(scope: SessionStorageScope): string {
  return `${scope.workspaceRoot}\u0000${scope.ownerKey}`;
}

/** Freeze one autosave epoch before it waits behind an earlier disk mutation. */
export function cloneSessionMap(sessions: Map<string, SessionRecord>): Map<string, SessionRecord> {
  return new Map(Array.from(sessions, ([id, session]) => [id, {
    ...session,
    storageScope: session.storageScope ? { ...session.storageScope } : undefined,
    connections: new Set(session.connections),
    outputBuffer: [...(session.outputBuffer || [])],
    terminalOptions: session.terminalOptions ? { ...session.terminalOptions } : null,
    chatDraft: session.chatDraft ? {
      ...session.chatDraft,
      attachments: session.chatDraft.attachments.map((attachment) => ({ ...attachment })),
    } : undefined,
    sessionUsage: {
      ...session.sessionUsage,
      models: { ...(session.sessionUsage?.models || {}) },
    },
  }]));
}
