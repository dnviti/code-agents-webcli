import * as React from 'react';
import type { PlanDocument } from '../../../shared/chat-events.js';
import { Button } from '../../ui/relay/Button.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { usePhone } from '../../ui/touch.js';
import { Markdown } from './Markdown.js';

export interface PlanDocDialogProps {
  plan: PlanDocument | null;
  planMode: boolean;
  disabled?: boolean;
  feedback?: string | null;
  retryAction?: 'accept' | 'reject' | null;
  onAccept: (revision: number) => void;
  onReject: (revision: number) => void;
  onClose: () => void;
}

export function PlanDocDialog({ plan, planMode, disabled = false, feedback, retryAction, onAccept, onReject, onClose }: PlanDocDialogProps): React.JSX.Element {
  const isPhone = usePhone();
  const revision = plan?.revision;
  const actionsDisabled = disabled || !planMode;
  return <Dialog open movable width="min(880px, 94vw)" height={isPhone ? undefined : 'min(78dvh, 860px)'} bodyFill placement={isPhone ? 'bottom' : 'center'} titleText="Plan" title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="list-todo" size={14} />Plan{revision ? <small>revision {revision}</small> : null}</span>} onClose={onClose} footer={revision ? <><Button variant="destructive" disabled={actionsDisabled} onClick={() => onReject(revision)}>{retryAction === 'reject' ? 'Retry reject' : 'Reject plan'}</Button><Button variant="primary" disabled={actionsDisabled} onClick={() => onAccept(revision)}>{retryAction === 'accept' ? 'Retry accept' : 'Accept plan'}</Button></> : <Button variant="secondary" onClick={onClose}>Close</Button>}>
    {feedback ? <p role="status" style={{ marginTop: 0, color: 'var(--muted-foreground)' }}>{feedback}</p> : null}
    {disabled ? <p style={{ marginTop: 0, color: 'var(--muted-foreground)' }}>Wait for the active turn to finish before accepting or rejecting this plan.</p> : null}
    {!disabled && !planMode ? <p style={{ marginTop: 0, color: 'var(--muted-foreground)' }}>Turn Plan mode on before accepting or rejecting this saved plan.</p> : null}
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{plan ? <Markdown text={plan.markdown} /> : <p style={{ margin: 0, color: 'var(--muted-foreground)' }}>{planMode ? 'The agent is preparing a plan. Closing this view does not change Plan mode.' : 'No plan has been submitted for this conversation.'}</p>}</div>
  </Dialog>;
}
