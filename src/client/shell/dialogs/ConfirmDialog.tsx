import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import type { ConfirmRequest } from '../../ui/confirm';

export interface ConfirmDialogProps {
  request: ConfirmRequest | null;
  onAnswer(confirmed: boolean): void;
}

/**
 * The app's yes/no question, in the app's own chrome.
 *
 * Dismissing counts as declining — closing a question you did not answer must
 * never be read as agreement, least of all for the destructive tone. That makes
 * every exit from this dialog except the confirm button resolve `false`:
 * Escape, the close control, and the cancel button alike.
 */
export function ConfirmDialog({
  request,
  onAnswer,
}: ConfirmDialogProps): React.JSX.Element | null {
  if (!request) return null;

  const danger = request.tone === 'danger';

  return (
    <Dialog
      open
      title={request.title}
      description={request.description}
      onClose={() => onAnswer(false)}
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={() => onAnswer(false)}>
            {request.cancelLabel || 'Cancel'}
          </Button>
          {/*
            autoFocus is how Dialog's own focus effect lets a child claim focus
            on open. Withheld when the answer is destructive, so a dialog nobody
            read cannot be confirmed with a stray Return.
          */}
          <Button
            autoFocus={!danger}
            variant={danger ? 'destructive' : 'primary'}
            onClick={() => onAnswer(true)}
          >
            {request.confirmLabel || 'Confirm'}
          </Button>
        </>
      }
    />
  );
}
