import * as React from 'react';
import { activityEvents, type ActivityEvent } from '../../chat/activity.js';
import type { ChatTranscript } from '../../chat/transcript.js';

/**
 * The activity projection, on the transcript's live tier.
 *
 * Deliberately *not* derived in the chat root. The rail draws every tool call in
 * the conversation, so it has to see `block_start`, `block_delta` and `tool`
 * patches — none of which reach `transcript.subscribe`, which is the quiet tier
 * a streaming turn does not touch. Deriving it up in `ChatView` meant a
 * forty-second command left the timeline empty and the ribbon reading a bare
 * "Working" until something unrelated happened to fire.
 *
 * Putting the subscription here instead of coarsening `subscribe` is the whole
 * point: only the surfaces that are genuinely live pay for being live. The
 * header, the turn index and the composer stay on the quiet tier and are not
 * re-rendered per token.
 */
export function useActivity(
  transcript: ChatTranscript,
  reasoning: boolean,
  tools: boolean,
): ActivityEvent[] {
  const version = React.useSyncExternalStore(
    transcript.subscribeContent,
    transcript.getContentVersion,
    ZERO,
  );

  return React.useMemo(
    () => activityEvents(transcript.messages, { reasoning, tools }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version, reasoning, tools],
  );
}

const ZERO = (): number => 0;
