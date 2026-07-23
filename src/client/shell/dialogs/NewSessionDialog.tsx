import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';

export interface NewSessionDialogProps {
  open: boolean;
  /** Prefills the working-directory field; the folder browser has usually set it. */
  defaultWorkingDir: string | null;
  onCreate(name: string, workingDir: string): void;
  onClose(): void;
}

const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6 };

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--muted-foreground)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--destructive)',
};

export function NewSessionDialog({
  open,
  defaultWorkingDir,
  onCreate,
  onClose,
}: NewSessionDialogProps): React.JSX.Element | null {
  // Hooks run unconditionally, so the `open` bail-out comes after them.
  const baseId = React.useId();
  const nameId = `${baseId}-name`;
  const dirId = `${baseId}-dir`;
  const dirErrorId = `${baseId}-dir-error`;

  const [name, setName] = React.useState('');
  const [workingDir, setWorkingDir] = React.useState('');
  const [dirError, setDirError] = React.useState('');

  // Seeded on the closed->open edge only. Keying this on `defaultWorkingDir`
  // as well would overwrite a path the user is halfway through typing every
  // time the folder browser behind the dialog moved.
  React.useEffect(() => {
    if (!open) return;
    setName('');
    setWorkingDir(defaultWorkingDir ?? '');
    setDirError('');
  }, [open]);

  const submit = React.useCallback(() => {
    const dir = workingDir.trim();
    if (!dir) {
      // The old DOM modal refused the same way, via a toast; inline keeps the
      // message next to the field that has to change.
      setDirError('Please select a working directory first');
      return;
    }
    setDirError('');
    onCreate(name.trim(), dir);
  }, [name, workingDir, onCreate]);

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  };

  if (!open) return null;

  return (
    <Dialog
      open
      title="New session"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Create session
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={fieldStyle}>
          <label htmlFor={nameId} style={labelStyle}>
            Session name
          </label>
          <Input
            id={nameId}
            autoFocus
            value={name}
            placeholder="Optional — defaults to the folder name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
        </div>

        <div style={fieldStyle}>
          <label htmlFor={dirId} style={labelStyle}>
            Working directory
          </label>
          <Input
            id={dirId}
            mono
            value={workingDir}
            invalid={Boolean(dirError)}
            aria-invalid={Boolean(dirError)}
            aria-describedby={dirError ? dirErrorId : undefined}
            placeholder="Leave empty to use the selected directory"
            onChange={(event) => {
              setWorkingDir(event.target.value);
              if (dirError) setDirError('');
            }}
            onKeyDown={onFieldKeyDown}
          />
          {dirError ? (
            <p id={dirErrorId} role="alert" style={errorStyle}>
              {dirError}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
