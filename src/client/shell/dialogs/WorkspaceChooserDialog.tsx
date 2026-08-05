import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Switch } from '../../ui/relay/Switch';
import { Select } from '../../ui/relay/Select';
import { TOUCH_TARGET } from '../../ui/touch';
import {
  normalizeProjectAvailability,
  type ProjectAvailability,
  type ProjectSummary,
} from '../projects-types';
import { controllerFetch } from '../../controller/transport';
import type { ServerTarget } from '../../controller/types';
import { ServerTargetBadge, serverTargetAvailability } from '../ServerTargetBadge';

export interface WorkspaceChooserDialogProps {
  open: boolean;
  onProject(projectId: string, serverId?: string): void;
  onDirectory(serverId?: string): void;
  onClose(): void;
  serverTargets?: ServerTarget[];
  selectedServerId?: string | null;
}

/** First step for a new tab: an existing project or the normal host picker. */
export function WorkspaceChooserDialog({
  open,
  onProject,
  onDirectory,
  onClose,
  serverTargets,
  selectedServerId,
}: WorkspaceChooserDialogProps): React.JSX.Element | null {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [availability, setAvailability] = React.useState<ProjectAvailability>({ available: true });
  const [localProjects, setLocalProjects] = React.useState(false);
  const fellThrough = React.useRef(false);
  const [draftServerId, setDraftServerId] = React.useState(selectedServerId || '');

  React.useEffect(() => {
    if (open) setDraftServerId(selectedServerId || '');
  }, [open, selectedServerId]);

  React.useEffect(() => {
    if (!open) {
      fellThrough.current = false;
      setLocalProjects(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void controllerFetch('/api/projects', { credentials: 'same-origin', signal: controller.signal }, draftServerId || undefined)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { projects?: ProjectSummary[]; availability?: ProjectAvailability };
        const listed = Array.isArray(body.projects) ? body.projects : [];
        setProjects(listed);
        setAvailability(normalizeProjectAvailability(body.availability));
        if (listed.length === 0 && !serverTargets && !fellThrough.current) {
          fellThrough.current = true;
          onDirectory();
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(`Projects could not be loaded (${String(reason)}).`);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, draftServerId, serverTargets]);

  if (!open) return null;
  const selectedTarget = serverTargets?.find((target) => target.id === draftServerId);
  const serverUnavailable = serverTargets ? !selectedTarget || Boolean(serverTargetAvailability(selectedTarget)) : false;
  const hasPlacementToggle = availability.available && availability.defaultExecutionKind === 'container';
  const visibleProjects = hasPlacementToggle
    ? projects.filter((project) => (project.executionKind === 'host') === localProjects)
    : projects;
  return (
    <Dialog
      open={open}
      title="Open workspace"
      description="Choose a project for this tab, or open any directory on this machine."
      onClose={onClose}
      width={560}
      footer={
        <Button variant="secondary" iconLeft={<Icon name="folder" size={14} />} onClick={() => onDirectory(draftServerId || undefined)} disabled={serverUnavailable}>
          Choose directory…
        </Button>
      }
    >
      {serverTargets ? (
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          <label htmlFor="workspace-server" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
            Server for this session
          </label>
          <Select
            id="workspace-server"
            value={draftServerId}
            required
            aria-describedby="workspace-server-help"
            options={serverTargets.map((target) => {
              const unavailable = serverTargetAvailability(target);
              return {
                value: target.id,
                label: unavailable ? `${target.name} — ${unavailable}` : target.name,
                disabled: Boolean(unavailable),
              };
            })}
            onChange={(event) => setDraftServerId(event.target.value)}
            style={{ minHeight: TOUCH_TARGET }}
          />
          <span id="workspace-server-help" style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
            This choice applies only after you confirm a project or directory.
          </span>
          {selectedTarget ? (
            <ServerTargetBadge target={selectedTarget} />
          ) : (
            <p role="alert" style={{ margin: 0, color: 'var(--destructive)', fontSize: 'var(--text-sm)' }}>
              No server is ready. Reconnect or add one in Settings.
            </p>
          )}
        </div>
      ) : null}
      {hasPlacementToggle ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '10px 12px', marginBottom: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <span>
            <strong>Local Projects</strong>
            <span style={{ display: 'block', marginTop: 2, color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
              Show projects whose workspaces live on this machine.
            </span>
          </span>
          <Switch checked={localProjects} ariaLabel="Show local projects" onChange={setLocalProjects} />
        </div>
      ) : null}
      {loading ? <p style={{ color: 'var(--muted-foreground)' }}>Loading projects…</p> : null}
      {error ? <p role="alert" style={{ color: 'var(--destructive)' }}>{error}</p> : null}
      {!loading && projects.length > 0 && visibleProjects.length === 0 ? (
        <p style={{ color: 'var(--muted-foreground)' }}>
          {localProjects ? 'No local projects yet.' : 'No projects are assigned to the active deploy target.'}
        </p>
      ) : null}
      {!loading && visibleProjects.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              disabled={serverUnavailable}
              onClick={() => onProject(project.id, draftServerId || undefined)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px',
                color: 'var(--foreground)', background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', cursor: serverUnavailable ? 'not-allowed' : 'pointer', textAlign: 'left',
                opacity: serverUnavailable ? 0.5 : 1,
              }}
            >
              <Icon name="folder" size={16} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}>{project.name}</span>
                <span style={{ display: 'block', marginTop: 2, color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
                  {project.targetName || 'Local machine'} · {project.state}
                </span>
              </span>
              <Icon name="chevron-right" size={15} />
            </button>
          ))}
        </div>
      ) : null}
    </Dialog>
  );
}
