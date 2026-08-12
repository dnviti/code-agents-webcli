import type { ChatMessage } from '../../shared/chat-events.js';
import { activityEvents, type ActivityEvent, type ActivityOptions } from './activity.js';
import type { ChatTranscript } from './transcript.js';

/**
 * Incremental activity projection shared by every live surface for a transcript.
 *
 * The transcript mutates one message in place for the common streaming event.
 * Re-running `activityEvents` over the whole conversation for each token made a
 * long chat progressively more expensive while it was answering. This cache
 * derives only changed messages, preserves every untouched event object, and
 * lets the trace and ribbon reuse the same projection for the same settings.
 */
class ActivityProjection {
  private version = -1;
  /** Stable container; changed message segments are spliced into it in place. */
  private readonly events: ActivityEvent[] = [];
  private revision = 0;
  private snapshot: ActivityProjectionSnapshot = { events: this.events, revision: 0 };
  private segments: Segment[] = [];
  private byMessage = new Map<string, Segment>();

  read(transcript: ChatTranscript, options: ActivityOptions): ActivityProjectionSnapshot {
    const version = transcript.getContentVersion();
    if (version === this.version) return this.snapshot;

    const changes = this.version < 0
      ? null
      : transcript.contentChangesSince(this.version);
    if (changes === null || changes.some((change) => change.kind === 'reset')) {
      this.rebuild(transcript.messages, options);
      this.version = version;
      return this.snapshot;
    }

    const changedIds = new Set<string>();
    for (const change of changes) {
      if (change.kind === 'message') changedIds.add(change.messageId);
    }

    for (const id of changedIds) {
      const message = transcript.message(id);
      const segment = this.byMessage.get(id);
      // Message insertion/removal is normally accompanied by `reset`. Treat a
      // missing side defensively as a full reset so an unusual producer cannot
      // leave the selector with stale ordering.
      if (!message || !segment) {
        this.rebuild(transcript.messages, options);
        this.version = version;
        return this.snapshot;
      }

      const next = mergeEvents(segment.events, activityEvents([message], options));
      if (next === segment.events) continue;

      const beforeLength = segment.events.length;
      this.events.splice(segment.start, beforeLength, ...next);
      segment.events = next;
      this.bumpRevision();

      const shift = next.length - beforeLength;
      if (shift !== 0) {
        for (let i = segment.index + 1; i < this.segments.length; i += 1) {
          this.segments[i].start += shift;
        }
      }
    }

    this.version = version;
    return this.snapshot;
  }

  private rebuild(messages: ChatMessage[], options: ActivityOptions): void {
    this.events.length = 0;
    this.segments = [];
    this.byMessage.clear();

    for (const message of messages) {
      const events = activityEvents([message], options);
      const segment: Segment = {
        index: this.segments.length,
        start: this.events.length,
        events,
      };
      this.segments.push(segment);
      this.byMessage.set(message.id, segment);
      this.events.push(...events);
    }
    this.bumpRevision();
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.snapshot = { events: this.events, revision: this.revision };
  }
}

interface Segment {
  /** Index in transcript message order. */
  index: number;
  /** First event in the flattened projection. */
  start: number;
  events: ActivityEvent[];
}

/** Keep the old event object wherever its render-relevant snapshot is unchanged. */
function mergeEvents(
  previous: ActivityEvent[],
  next: ActivityEvent[],
): ActivityEvent[] {
  if (previous.length !== next.length) return next;

  let changed = false;
  const merged = next.map((event, index) => {
    const before = previous[index];
    if (sameEvent(before, event)) return before;
    changed = true;
    return event;
  });
  return changed ? merged : previous;
}

function sameEvent(a: ActivityEvent | undefined, b: ActivityEvent): boolean {
  return Boolean(
    a
    && a.id === b.id
    && a.messageId === b.messageId
    && a.blockIndex === b.blockIndex
    && a.kind === b.kind
    && a.name === b.name
    && a.toolKind === b.toolKind
    && a.target === b.target
    && a.status === b.status
    && a.durationMs === b.durationMs
    && a.tokens === b.tokens
    && a.diffs === b.diffs
    && a.touchesFiles === b.touchesFiles
    && a.block === b.block
    && a.ts === b.ts
  );
}

const PROJECTIONS = new WeakMap<ChatTranscript, Map<number, ActivityProjection>>();

export interface ActivityProjectionSnapshot {
  /** Stable array, updated by bounded segment splices. */
  events: ActivityEvent[];
  /** Changes only when projected event snapshots or ordering change. */
  revision: number;
}

/**
 * Read the live activity projection for one transcript and display setting.
 *
 * Exported for non-React consumers and focused selector tests; React surfaces
 * should normally use `useActivity` so subscription and projection stay paired.
 */
export function projectedActivityEvents(
  transcript: ChatTranscript,
  options: ActivityOptions = {},
): ActivityEvent[] {
  return projectedActivitySnapshot(transcript, options).events;
}

/** The projection plus the revision consumers use to invalidate derived windows. */
export function projectedActivitySnapshot(
  transcript: ChatTranscript,
  options: ActivityOptions = {},
): ActivityProjectionSnapshot {
  const reasoning = options.reasoning !== false;
  const tools = options.tools !== false;
  const key = (reasoning ? 2 : 0) | (tools ? 1 : 0);

  let optionsMap = PROJECTIONS.get(transcript);
  if (!optionsMap) {
    optionsMap = new Map<number, ActivityProjection>();
    PROJECTIONS.set(transcript, optionsMap);
  }
  let projection = optionsMap.get(key);
  if (!projection) {
    projection = new ActivityProjection();
    optionsMap.set(key, projection);
  }
  return projection.read(transcript, { reasoning, tools });
}
