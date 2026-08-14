import {
  ChatAttachment,
  ChatDraft,
  ChatModelDefault,
  ChatModelOrigin,
  PlanDocument,
} from '../../../shared/chat-events.js';
import { ModelTier, isModelTier } from '../../../shared/runtime-profiles.js';

export function readPlanDocument(raw: unknown): PlanDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.markdown !== 'string' || !value.markdown.trim()) return null;
  return {
    markdown: value.markdown,
    revision: typeof value.revision === 'number' && value.revision > 0 ? value.revision : 1,
    ts: typeof value.ts === 'number' ? value.ts : 0,
  };
}

export function createQuestionAnswerSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `answer-${crypto.randomUUID()}`;
  }
  return `answer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createBuiltInWorkflowRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `workflow-${crypto.randomUUID()}`;
  }
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Read a `modelDefault` off the wire, or nothing.
 *
 * Field-by-field rather than a cast, like every other payload this file reads.
 * A server that predates #135 sends nothing at all, and a partial one has to
 * read as nothing too: the picker's whole job here is to say *why* a model is
 * in force, and half an answer to that is worse than admitting it does not
 * know.
 */
export function readModelDefault(raw: unknown): ChatModelDefault | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const source = value.source;
  if (source !== 'personal' && source !== 'profile' && source !== 'ladder' && source !== 'runtime') {
    return null;
  }
  return {
    model: typeof value.model === 'string' && value.model ? value.model : null,
    source,
    ...(typeof value.profileName === 'string' && value.profileName
      ? { profileName: value.profileName }
      : {}),
    ...readTiers(value),
  };
}

/** The rung fields, shared by a default and by a conversation's own origin. */
export function readTiers(value: Record<string, unknown>): { tier?: ModelTier; requestedTier?: ModelTier } {
  const tier = isModelTier(value.tier) ? value.tier : undefined;
  const requestedTier = isModelTier(value.requestedTier) ? value.requestedTier : undefined;
  return { ...(tier ? { tier } : {}), ...(requestedTier ? { requestedTier } : {}) };
}

/**
 * Read the origin of the model *this* conversation is on.
 *
 * The same shape as a default plus `override`, which no default can be: the
 * person in this conversation picked it. Read field by field for the same
 * reason — a server that predates #171 says nothing, and half an answer to
 * "where did this model come from" is worse than admitting it does not know.
 */
export function readModelOrigin(raw: unknown): ChatModelOrigin | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const source = value.source;
  if (
    source !== 'override' && source !== 'personal' && source !== 'profile'
    && source !== 'ladder' && source !== 'runtime'
  ) {
    return null;
  }
  return {
    model: typeof value.model === 'string' && value.model ? value.model : null,
    source,
    ...(typeof value.profileName === 'string' && value.profileName
      ? { profileName: value.profileName }
      : {}),
    ...readTiers(value),
  };
}

/**
 * How long a page request may go unanswered before the control comes back.
 *
 * Not a latency budget — a page is a positioned read of a local file and comes
 * back in milliseconds. It is the point past which the only explanation is that
 * no reply is coming, and leaving a spinner up for that forever is worse than
 * offering the button again.
 */
export const PAGE_TIMEOUT_MS = 15000;

export const PAGE_SIZE = 200;

/**
 * How much a page fetched for an explicit destination asks for.
 *
 * The server's own per-read ceiling, and it is worth asking for all of it here:
 * a jump four thousand events back is eight round trips at this size and twenty
 * at the scrolling one, while the read itself is a positioned file read either
 * way. Scrolling keeps the smaller page, because there the point is to arrive
 * with the least the reader can already use.
 */
export const SEEK_PAGE_SIZE = 500;

/**
 * How often a composer being typed into tells the other screens.
 *
 * A quarter of a second, and every keystroke inside one is folded into a single
 * frame carrying the latest text. Fast enough that a phone watching a laptop
 * reads as live rather than as a page that refreshes; slow enough that a
 * hundred-word paragraph is a few dozen small frames instead of six hundred.
 *
 * The first keystroke after a pause goes at once — see `publishDraft`. Waiting
 * out the interval before saying anything would make the *start* of typing the
 * slowest part of it, which is the part being watched.
 */
export const DRAFT_PUBLISH_MS = 250;

/** A composer's contents, before the server has numbered them. */
export interface DraftPayload {
  text: string;
  attachments: ChatAttachment[];
}

export const NO_DRAFT: ChatDraft = { text: '', attachments: [], revision: 0 };

/**
 * Whether two composers hold the same thing.
 *
 * Attachments are compared by url, which is the server's own name for the
 * stored file and the only field of the four that is generated rather than
 * copied from what the browser guessed about it.
 */
export function sameDraft(a: DraftPayload, b: DraftPayload): boolean {
  if (a.text !== b.text) return false;
  if (a.attachments.length !== b.attachments.length) return false;
  return a.attachments.every((attachment, index) => attachment.url === b.attachments[index].url);
}

/**
 * Read a draft off the wire, or nothing.
 *
 * Field by field like every other payload this file reads. A server that
 * predates this sends no draft at all, which has to come back as `null` — the
 * surface then keeps whatever it has rather than being cleared by a server that
 * simply has nothing to say about composers.
 */
export function readDraft(raw: unknown): ChatDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== 'string') return null;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision)) return null;
  const attachments = Array.isArray(value.attachments)
    ? (value.attachments.filter(
        (item) => item && typeof item === 'object' && typeof (item as ChatAttachment).url === 'string',
      ) as ChatAttachment[])
    : [];
  return { text: value.text, attachments, revision: value.revision };
}
