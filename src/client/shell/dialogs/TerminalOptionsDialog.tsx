import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';

export interface TerminalOptionsDialogProps {
  open: boolean;
  shells: readonly string[];
  onShell(shell: string): void;
  onCommand(command: string): void;
  onClose(): void;
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--muted-foreground)',
};

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--muted-foreground)',
  lineHeight: 'var(--leading-normal)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--destructive)',
};

export function TerminalOptionsDialog({
  open,
  shells,
  onShell,
  onCommand,
  onClose,
}: TerminalOptionsDialogProps): React.JSX.Element | null {
  // Hooks run unconditionally, so the `open` bail-out comes after them.
  const baseId = React.useId();
  const commandId = `${baseId}-command`;
  const errorId = `${baseId}-command-error`;

  const [command, setCommand] = React.useState('');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setCommand('');
    setError('');
  }, [open]);

  const run = React.useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed) {
      setError('Enter a command to run.');
      return;
    }
    setError('');
    onCommand(trimmed);
  }, [command, onCommand]);

  const onCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
      return;
    }
    if (event.key === 'Escape') {
      // Dialog also closes on Escape from a document-level listener. Stopping
      // propagation here keeps that from firing too, so the close path runs
      // once whether or not the command field holds focus.
      event.stopPropagation();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open
      title="Start terminal"
      description="Open an interactive shell or run a single command in this session."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run}>
            Run Command
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {/* auto-fit rather than a media query: these components are styled
            inline, where `@media` has nowhere to live. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          {shells.map((shell) => (
            <Button
              key={shell}
              variant="primary"
              onClick={() => onShell(shell)}
              iconLeft={<Icon name="terminal" size={13} />}
            >
              {shell}
            </Button>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={commandId} style={labelStyle}>
            Custom command
          </label>
          <Input
            id={commandId}
            mono
            autoFocus
            value={command}
            invalid={Boolean(error)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            placeholder="Examples: btop, htop, watch podman ps"
            onChange={(event) => {
              setCommand(event.target.value);
              if (error) setError('');
            }}
            onKeyDown={onCommandKeyDown}
          />
          <p style={hintStyle}>
            Runs through a shell with the session working directory as the current directory.
          </p>
          {error ? (
            <p id={errorId} role="alert" style={errorStyle}>
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
