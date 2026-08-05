import * as React from 'react';

import type { ServerTarget } from '../../controller/types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Input } from '../../ui/relay/Input';
import { TOUCH_TARGET } from '../../ui/touch';
import { ServerTargetBadge, serverTargetAvailability } from '../ServerTargetBadge';

export interface NewSessionDialogProps {
  open: boolean;
  /** Prefills the working-directory field; the folder browser has usually set it. */
  defaultWorkingDir: string | null;
  onCreate(name: string, workingDir: string, serverId?: string): void;
  onClose(): void;
  /** Present in controller mode. Every new controller session must choose one. */
  serverTargets?: ServerTarget[];
  /** The target confirmed on the previous new-session action. */
  lastUsedServerId?: string | null;
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

function preferredServerId(targets: ServerTarget[] | undefined, lastUsed: string | null | undefined): string {
  if (!targets?.length) return '';
  if (lastUsed && targets.some((target) => target.id === lastUsed)) return lastUsed;
  return targets.find((target) => serverTargetAvailability(target) === null)?.id ?? targets[0].id;
}

export function NewSessionDialog({
  open,
  defaultWorkingDir,
  onCreate,
  onClose,
  serverTargets,
  lastUsedServerId,
}: NewSessionDialogProps): React.JSX.Element | null {
  // Hooks run unconditionally, so the `open` bail-out comes after them.
  const baseId = React.useId();
  const nameId = `${baseId}-name`;
  const dirId = `${baseId}-dir`;
  const dirErrorId = `${baseId}-dir-error`;
  const serverId = `${baseId}-server`;
  const serverStatusId = `${baseId}-server-status`;

  const [name, setName] = React.useState('');
  const [workingDir, setWorkingDir] = React.useState('');
  const [dirError, setDirError] = React.useState('');
  const [selectedServerId, setSelectedServerId] = React.useState(() => (
    preferredServerId(serverTargets, lastUsedServerId)
  ));

  // Seeded on the closed->open edge only. Changing props while the dialog is
  // open must not overwrite a choice or path the user is halfway through.
  React.useEffect(() => {
    if (!open) return;
    setName('');
    setWorkingDir(defaultWorkingDir ?? '');
    setDirError('');
    setSelectedServerId(preferredServerId(serverTargets, lastUsedServerId));
  }, [open]);

  const selectedServer = serverTargets?.find((target) => target.id === selectedServerId);
  const serverProblem = serverTargets === undefined
    ? null
    : selectedServer
      ? serverTargetAvailability(selectedServer)
      : 'Choose a server';
  const controllerWithoutTargets = serverTargets !== undefined && serverTargets.length === 0;

  const submit = React.useCallback(() => {
    const dir = workingDir.trim();
    if (!dir) {
      setDirError('Please select a working directory first');
      return;
    }
    if (serverTargets !== undefined && (!selectedServer || serverProblem)) return;
    setDirError('');
    onCreate(name.trim(), dir, serverTargets === undefined ? undefined : selectedServerId);
  }, [name, workingDir, onCreate, serverTargets, selectedServer, selectedServerId, serverProblem]);

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
          <Button
            variant="primary"
            onClick={submit}
            disabled={controllerWithoutTargets || Boolean(serverProblem)}
          >
            Create session
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {serverTargets !== undefined ? (
          <div style={fieldStyle}>
            <label htmlFor={serverId} style={labelStyle}>Server</label>
            {/* Native options are intentional here: unavailable targets must
                remain visible but individually disabled, which the shared
                Select's flat option API cannot currently express. */}
            <select
              id={serverId}
              value={selectedServerId}
              onChange={(event) => {
                if (event.target.value !== selectedServerId) {
                  // Paths belong to servers. Never carry a directory browsed
                  // on one machine into a create request for another.
                  setWorkingDir('');
                  setDirError('Choose a working directory on the selected server.');
                }
                setSelectedServerId(event.target.value);
              }}
              autoFocus
              required
              aria-describedby={serverStatusId}
              style={{
                width: '100%',
                minHeight: TOUCH_TARGET,
                padding: '0 10px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                background: 'var(--input)',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-ui)',
              }}
            >
              {serverTargets.length === 0 ? <option value="">No configured servers</option> : null}
              {serverTargets.map((target) => {
                const reason = serverTargetAvailability(target);
                return (
                  <option key={target.id} value={target.id} disabled={Boolean(reason)}>
                    {target.name}{reason ? ` — ${reason}` : ''}
                  </option>
                );
              })}
            </select>
            <div id={serverStatusId}>
              {selectedServer ? (
                <ServerTargetBadge target={selectedServer} />
              ) : (
                <p role="alert" style={errorStyle}>
                  No server is available. Add or reconnect a server before creating a session.
                </p>
              )}
            </div>
          </div>
        ) : null}

        <div style={fieldStyle}>
          <label htmlFor={nameId} style={labelStyle}>
            Session name
          </label>
          <Input
            id={nameId}
            autoFocus={serverTargets === undefined}
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
