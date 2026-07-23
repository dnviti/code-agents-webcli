import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';

export interface RenameDialogProps {
  open: boolean;
  initialName: string;
  onRename(name: string): void;
  onClose(): void;
}

export function RenameDialog({
  open,
  initialName,
  onRename,
  onClose,
}: RenameDialogProps): React.JSX.Element | null {
  const [name, setName] = React.useState(initialName);
  const fieldId = React.useId();
  // Relay's Input is a plain function component, so it cannot receive a ref;
  // holding the wrapper and reaching for its input is how we still get focus
  // and selection without touching `document`.
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const wasOpen = React.useRef(open);

  // Re-seed during the closed→open render rather than in an effect: the field
  // must already hold `initialName` when the effect below selects it, or the
  // selection would land on the previous session's name and then be dropped by
  // the re-render.
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) setName(initialName);
  }

  React.useEffect(() => {
    if (!open) return;
    const input = wrapRef.current?.querySelector('input');
    if (!input) return;
    input.focus();
    input.select();
  }, [open]);

  if (!open) return null;

  const trimmed = name.trim();
  // A whitespace-only name would silently erase the tab label, so the dialog
  // stays open and the action stays disabled instead.
  const submit = (): void => {
    if (!trimmed) return;
    onRename(trimmed);
  };

  return (
    <Dialog
      open={open}
      title="Rename session"
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!trimmed} onClick={submit}>
            Rename
          </Button>
        </>
      }
    >
      <label
        htmlFor={fieldId}
        style={{
          display: 'block',
          marginBottom: 6,
          fontSize: 'var(--text-sm)',
          color: 'var(--muted-foreground)',
        }}
      >
        Session name
      </label>
      <div ref={wrapRef}>
        <Input
          id={fieldId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          // Escape is Dialog's; adding it here as well would close and then
          // close again once the outer handler fires.
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </Dialog>
  );
}
