import * as React from 'react';
import { FileDiff, PlanItem } from '../../../shared/chat-events.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import type { ActivityFilterId } from '../../chat/view-settings.js';
import { ActivityTimeline } from './ActivityTimeline.js';
import { PlanPanel } from './PlanPanel.js';
import { useActivity } from './use-activity.js';

/**
 * The rail's first tab: the plan on top, everything the agent did underneath.
 *
 * One tab rather than two because they answer the same question at two scales —
 * "what is it trying to do" and "what has it done about it" — and splitting them
 * meant checking whether a stalled plan step had a failed tool call behind it
 * cost a tab switch.
 *
 * The plan is `flex: 0 0 auto` with its own scroll ceiling and the timeline is
 * `flex: 1`: a twenty-step plan must not push the live tool call off the bottom
 * of the rail.
 */

export interface TracePanelProps {
  plan: PlanItem[];
  showPlan: boolean;
  /**
   * The transcript itself, not a derived list.
   *
   * The rail subscribes to the live tier and projects the events here, so a
   * running command appears and updates without re-rendering the chat root
   * around it. See use-activity.ts.
   */
  transcript: ChatTranscript;
  showThinking: boolean;
  showToolCalls: boolean;
  filter: ActivityFilterId;
  onFilter(next: ActivityFilterId): void;
  onReveal?: (messageId: string) => void;
  focusId?: string;
  /** Bumped per request, so asking for the same row twice scrolls twice. */
  focusNonce?: number;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
}

export function TracePanel({
  plan,
  showPlan,
  transcript,
  showThinking,
  showToolCalls,
  filter,
  onFilter,
  onReveal,
  focusId,
  focusNonce,
  onApplyHunk,
  onRevertHunk,
}: TracePanelProps): React.JSX.Element {
  const activity = useActivity(transcript, showThinking, showToolCalls);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {showPlan ? <PlanPanel items={plan} variant="rail" /> : null}
      <ActivityTimeline
        events={activity.events}
        revision={activity.revision}
        filter={filter}
        onFilter={onFilter}
        onReveal={onReveal}
        focusId={focusId}
        focusNonce={focusNonce}
        onApplyHunk={onApplyHunk}
        onRevertHunk={onRevertHunk}
      />
    </div>
  );
}
