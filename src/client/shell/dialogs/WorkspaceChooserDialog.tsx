import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Switch } from '../../ui/relay/Switch';
import {
  normalizeProjectAvailability,
  type ProjectAvailability,
  type ProjectSummary,
} from '../projects-types';

export interface WorkspaceChooserDialogProps {
  open: boolean;
  onProject(projectId: string): void;
  onDirectory(): void;
  onClose(): void;
}

/** First step for a new tab: an existing project or the normal host picker. */
export function WorkspaceChooserDialog({
  open,
  onProject,
  onDirectory,
  onClose,
}: WorkspaceChooserDialogProps): React.JSX.Element | null {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [availability, setAvailability] = React.useState<ProjectAvailability>({ available: true });
  const [localProjects, setLocalProjects] = React.useState(false);
  const fellThrough = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      fellThrough.current = false;
      setLocalProjects(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch('/api/projects', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { projects?: ProjectSummary[]; availability?: ProjectAvailability };
        const listed = Array.isArray(body.projects) ? body.projects : [];
        setProjects(listed);
        setAvailability(normalizeProjectAvailability(body.availability));
        if (listed.length === 0 && !fellThrough.current) {
          fellThrough.current = true;
          onDirectory();
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(`Projects could not be loaded (${String(reason)}).`);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, onDirectory]);

  if (!open) return null;
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
        <Button variant="secondary" iconLeft={<Icon name="folder" size={14} />} onClick={onDirectory}>
          Choose directory…
        </Button>
      }
    >
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
              onClick={() => onProject(project.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px',
                color: 'var(--foreground)', background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', cursor: 'pointer', textAlign: 'left',
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
