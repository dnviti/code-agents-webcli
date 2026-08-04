import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { Badge } from '../../ui/relay/Badge';
import { Select } from '../../ui/relay/Select';
import { Switch } from '../../ui/relay/Switch';
import { Tabs } from '../../ui/relay/Tabs';
import { showConfirm } from '../../ui/confirm';
import { usePhone } from '../../ui/touch';
import { ProjectCompositionPanel } from './ProjectCompositionPanel';
import { WorkspaceDataPanel } from './WorkspaceDataPanel';
import {
  buildEventKey,
  mergeProjectBuildEvents,
  normalizeProjectAvailability,
  type BuildEvent,
  type CredentialRequiredPayload,
  type ProjectAvailability,
  type ProjectState,
  type ProjectSummary,
  type RunLimitPayload,
  type RunningProjectInfo,
} from '../projects-types.js';

export interface ProjectsDialogProps {
  open: boolean;
  repositoryInspectionSupported: boolean;
  onClose(): void;
  onOpenProject(projectId: string): void;
}

interface ConnectedHost {
  host: string;
  forgeKind: string | null;
  validationStatus: 'valid' | 'invalid' | 'unvalidated' | null;
  expiresAt: string | null;
  scopes: string[];
  validationErrorMessage: string | null;
}
interface Mutation { busy: boolean; error: string | null; notice: string | null; }
interface Swap { projectId: string; running: RunningProjectInfo[]; }
interface UnknownCreate {
  name: string;
  repoUrl: string | null;
  local: boolean;
  previousIds: string[];
}

export function notifyProjectsChanged(): void {
  window.dispatchEvent(new CustomEvent('cc-projects-changed'));
}

function message(result: { status: number; data: unknown }): string {
  const body = result.data as { message?: unknown; detail?: unknown; error?: unknown };
  return typeof body.message === 'string' ? body.message
    : typeof body.detail === 'string' ? body.detail
      : typeof body.error === 'string' ? body.error : `HTTP ${result.status}`;
}

async function request(url: string, method = 'GET', body?: unknown): Promise<{ ok: true; data: unknown } | { ok: false; status: number; data: unknown }> {
  const response = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return response.ok ? { ok: true, data } : { ok: false, status: response.status, data };
}

const terminalStates: ProjectState[] = ['composition_pending', 'running', 'stopped', 'failed', 'unavailable', 'blocked'];
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12 };
const HOST_FORGES = [
  { value: '', label: 'Choose repository host type' },
  { value: 'github', label: 'GitHub / GitHub Enterprise' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'gitea', label: 'Gitea' },
  { value: 'forgejo', label: 'Forgejo' },
];

function inferredForge(host: string): string {
  const normalized = host.toLowerCase().split(':')[0];
  if (normalized === 'github.com') return 'github';
  if (normalized === 'gitlab.com') return 'gitlab';
  return '';
}

function projectLabel(project: ProjectSummary): string {
  return project.stateDetail || project.state;
}

const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  inspecting: 'Inspecting',
  composition_pending: 'Recipe review',
  building: 'Building',
  running: 'Running',
  stopped: 'Stopped',
  reclaiming: 'Preserving',
  failed: 'Failed',
  unavailable: 'Unavailable',
  blocked: 'Recovery blocked',
};

function needsRepositoryInspection(project: ProjectSummary): boolean {
  return Boolean(project.repoUrl)
    && !project.compositionRevision
    && !project.appliedCompositionRevision
    && ['failed', 'unavailable'].includes(project.state);
}

function createdByAttempt(project: ProjectSummary, attempt: UnknownCreate): boolean {
  return !attempt.previousIds.includes(project.id)
    && project.name === attempt.name
    && (project.repoUrl || null) === attempt.repoUrl
    && (project.executionKind === 'host') === attempt.local;
}

function projectEventLabel(event: BuildEvent): string {
  if (event.t === 'preserve' && event.branch) {
    return `Preserved work on ${event.branch}${event.commit ? ` at ${event.commit}` : ''}`;
  }
  return event.message || event.step || event.state || event.t;
}

/** Project lifecycle UI. It owns no server state: websocket changes and writes both re-read the list. */
export function ProjectsDialog({ open, repositoryInspectionSupported, onClose, onOpenProject }: ProjectsDialogProps): React.JSX.Element | null {
  const isPhone = usePhone();
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [hosts, setHosts] = React.useState<ConnectedHost[]>([]);
  const [availability, setAvailability] = React.useState<ProjectAvailability>({ available: true });
  const [localProjects, setLocalProjects] = React.useState(false);
  const [mutation, setMutation] = React.useState<Mutation>({ busy: false, error: null, notice: null });
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [acknowledgeDisposable, setAcknowledgeDisposable] = React.useState(false);
  const [credentialHost, setCredentialHost] = React.useState<string | null>(null);
  const [credentialForgeKind, setCredentialForgeKind] = React.useState('');
  const [token, setToken] = React.useState('');
  const [swap, setSwap] = React.useState<Swap | null>(null);
  const [events, setEvents] = React.useState<Record<string, BuildEvent[]>>({});
  const [unknownCreate, setUnknownCreate] = React.useState<UnknownCreate | null>(null);
  const [editingRepo, setEditingRepo] = React.useState<{ projectId: string; repoUrl: string } | null>(null);
  const [view, setView] = React.useState<'projects' | 'data'>('projects');
  const [recipeProjectId, setRecipeProjectId] = React.useState<string | null>(null);
  const sourcesRef = React.useRef(new Map<string, EventSource>());
  const seenEventsRef = React.useRef(new Map<string, Set<string>>());
  const terminalBuildsRef = React.useRef(new Set<string>());
  const credentialRetryRef = React.useRef<(() => Promise<void>) | null>(null);

  const mergeListedEventLogs = React.useCallback((listed: ProjectSummary[]): void => {
    // Seed the SSE dedupe set as well as the rendered state. A reconnect can
    // replay the same ring-buffer event immediately after this list response;
    // without the shared key the durable recovery path would make it appear
    // twice.
    for (const project of listed) {
      const seen = seenEventsRef.current.get(project.id) || new Set<string>();
      for (const event of project.buildLog || []) seen.add(buildEventKey(event));
      seenEventsRef.current.set(project.id, seen);
    }
    setEvents((previous) => mergeProjectBuildEvents(previous, listed));
  }, []);

  const fetchProjectData = React.useCallback(async (): Promise<{ projects: ProjectSummary[]; availability: ProjectAvailability }> => {
    const result = await request('/api/projects');
    if (!result.ok) throw new Error(message(result));
    const data = result.data as { projects?: unknown; availability?: ProjectAvailability };
    const projects = Array.isArray(data.projects) ? data.projects as ProjectSummary[] : [];
    mergeListedEventLogs(projects);
    return {
      projects,
      availability: normalizeProjectAvailability(data.availability),
    };
  }, [mergeListedEventLogs]);

  const fetchProjects = React.useCallback(async (): Promise<ProjectSummary[]> => (
    await fetchProjectData()
  ).projects, [fetchProjectData]);

  const read = React.useCallback(async (): Promise<void> => {
    try {
      const [listed, hostList] = await Promise.all([fetchProjectData(), request('/api/connected-hosts')]);
      setProjects(listed.projects);
      setAvailability(listed.availability);
      if (hostList.ok) {
        const body = hostList.data as { hosts?: unknown };
        setHosts(Array.isArray(body.hosts) ? body.hosts as ConnectedHost[] : []);
      }
      setMutation((previous) => ({ ...previous, error: null }));
    } catch (error) {
      setMutation((previous) => ({ ...previous, error: error instanceof Error ? error.message : 'Could not load projects.' }));
    }
  }, [fetchProjectData]);

  React.useEffect(() => {
    if (!open) return;
    void read();
  }, [open, read]);
  React.useEffect(() => {
    if (open) return;
    // The dialog stays mounted in AppShell. Secrets and the action they would
    // replay must not survive closing it and reappear on the next open.
    credentialRetryRef.current = null;
    setCredentialHost(null);
    setCredentialForgeKind('');
    setToken('');
    setEditingRepo(null);
    setSwap(null);
    setRecipeProjectId(null);
    setView('projects');
    setLocalProjects(false);
  }, [open]);
  React.useEffect(() => {
    if (availability.defaultExecutionKind !== 'container') setLocalProjects(false);
  }, [availability.defaultExecutionKind]);
  React.useEffect(() => {
    if (!repositoryInspectionSupported) setRepoUrl('');
  }, [repositoryInspectionSupported]);
  React.useEffect(() => {
    const changed = (): void => { if (open) void read(); };
    window.addEventListener('cc-projects-changed', changed);
    return () => window.removeEventListener('cc-projects-changed', changed);
  }, [open, read]);

  // Keep the same stream while list polling and websocket refreshes replace the
  // project array. Recreating it on every refresh replays the ring buffer each
  // time and can starve live progress behind duplicated history.
  React.useEffect(() => {
    if (!open) {
      sourcesRef.current.forEach((source) => source.close());
      sourcesRef.current.clear();
      return;
    }
    const building = new Set(projects.filter((project) => ['inspecting', 'building'].includes(project.state)).map((project) => project.id));
    for (const [projectId, source] of sourcesRef.current) {
      if (building.has(projectId)) continue;
      source.close();
      sourcesRef.current.delete(projectId);
      terminalBuildsRef.current.delete(projectId);
    }
    for (const projectId of building) {
      if (sourcesRef.current.has(projectId) || terminalBuildsRef.current.has(projectId)) continue;
      const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/build`, { withCredentials: true });
      const receive = (raw: MessageEvent<string>): void => {
        try {
          const event = JSON.parse(raw.data) as BuildEvent;
          const key = buildEventKey(event);
          const seen = seenEventsRef.current.get(projectId) || new Set<string>();
          if (seen.has(key)) return;
          seen.add(key);
          seenEventsRef.current.set(projectId, seen);
          setEvents((previous) => ({ ...previous, [projectId]: [...(previous[projectId] || []), event] }));
          if (event.state && terminalStates.includes(event.state)) {
            terminalBuildsRef.current.add(projectId);
            source.close();
            sourcesRef.current.delete(projectId);
            // The event is progress, while the list is authoritative. Re-read
            // at the terminal edge so "Inspecting" becomes "Review recipe"
            // without requiring the dialog to be closed and opened again.
            void read();
          }
        } catch { /* A bad frame must not prevent EventSource reconnection. */ }
      };
      source.onmessage = receive;
      source.addEventListener('build', receive as EventListener);
      // Do not close on error: EventSource reconnects by design. A terminal SSE
      // close is expected after the final state and is not an error to show.
      source.onerror = () => {};
      sourcesRef.current.set(projectId, source);
    }
  }, [open, projects, read]);
  React.useEffect(() => () => {
    sourcesRef.current.forEach((source) => source.close());
    sourcesRef.current.clear();
  }, []);

  const finish = (notice: string): void => {
    setMutation({ busy: false, error: null, notice });
    notifyProjectsChanged();
    void read();
  };
  const fail = (error: string): void => setMutation({ busy: false, error, notice: null });

  const reconcileCreate = React.useCallback(async (attempt: UnknownCreate): Promise<boolean> => {
    try {
      const listed = await fetchProjects();
      setProjects(listed);
      const matches = listed.filter((project) => createdByAttempt(project, attempt));
      if (matches.length === 1) {
        setUnknownCreate(null);
        setCreating(false);
        setName('');
        setRepoUrl('');
        setAcknowledgeDisposable(false);
        setMutation({
          busy: false,
          error: null,
          notice: `The create response was lost, but ${matches[0].name} exists (${matches[0].id}). No retry was sent.`,
        });
        return true;
      }
      if (matches.length === 0) {
        // This list is served from the same durable store as create. A
        // successful reconciliation with no new matching row is the evidence
        // required before another create is allowed.
        setUnknownCreate(null);
        setMutation({
          busy: false,
          error: null,
          notice: 'No matching project exists. It is safe to submit this create again.',
        });
        return false;
      }
      setUnknownCreate(attempt);
      setMutation({
        busy: false,
        error: 'Project creation has an unknown outcome. No automatic retry was sent; check again before starting another create.',
        notice: 'More than one new matching project exists, so the client cannot choose one safely.',
      });
    } catch {
      setUnknownCreate(attempt);
      setMutation({
        busy: false,
        error: 'The create response and the reconciliation request were both lost. No retry was sent.',
        notice: 'Restore the connection, then check the project list before trying again.',
      });
    }
    return false;
  }, [fetchProjects]);

  const start = async (projectId: string, stopProjectId?: string): Promise<void> => {
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectId)}/start`, 'POST', stopProjectId ? { stopProjectId } : {});
      if (!result.ok && result.status === 409 && (result.data as { error?: string }).error === 'run_limit') {
        setMutation({ busy: false, error: null, notice: null });
        setSwap({ projectId, running: (result.data as RunLimitPayload).running });
        return;
      }
      if (!result.ok) return fail(message(result));
      setSwap(null);
      terminalBuildsRef.current.delete(projectId);
      finish('Project is starting.');
    } catch { fail('Could not start project.'); }
  };

  const create = async (): Promise<void> => {
    if (unknownCreate) return;
    const attempt: UnknownCreate = {
      name: name.trim(),
      repoUrl: repoUrl.trim() || null,
      local: localProjects && availability.defaultExecutionKind === 'container',
      previousIds: projects.map((project) => project.id),
    };
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request('/api/projects', 'POST', {
        name: attempt.name,
        repoUrl: attempt.repoUrl,
        local: attempt.local,
      });
      if (!result.ok && result.status === 428) {
        const body = result.data as CredentialRequiredPayload;
        credentialRetryRef.current = create;
        const host = body.host || new URL(repoUrl).host;
        setCredentialHost(host);
        setCredentialForgeKind(inferredForge(host));
        setMutation({ busy: false, error: null, notice: null });
        return;
      }
      if (!result.ok && result.status === 409 && (result.data as { error?: string }).error === 'run_limit') {
        const body = result.data as RunLimitPayload & { project?: ProjectSummary };
        if (!body.project) return fail('The server did not return the project to start.');
        setSwap({ projectId: body.project.id, running: body.running });
        setCreating(false);
        setMutation({ busy: false, error: null, notice: 'Project was created. Choose a safe project to stop before it starts.' });
        void read();
        return;
      }
      if (!result.ok) return fail(message(result));
      const created = (result.data as { project?: ProjectSummary }).project;
      if (created) {
        setProjects((previous) => [...previous.filter((project) => project.id !== created.id), created]);
      }
      setUnknownCreate(null);
      setCreating(false); setName(''); setRepoUrl(''); setAcknowledgeDisposable(false);
      finish(attempt.repoUrl
        ? 'Project created. Repository inspection started; choose its recipe when inspection finishes.'
        : 'Project created. Choose its recipe before the first build.');
    } catch {
      await reconcileCreate(attempt);
    }
  };

  const saveCredential = async (): Promise<void> => {
    if (!credentialHost || !credentialForgeKind || !token.trim()) return;
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request('/api/connected-hosts', 'POST', { host: credentialHost, token: token.trim(), forgeKind: credentialForgeKind });
      if (!result.ok) return fail(message(result));
      const retry = credentialRetryRef.current;
      credentialRetryRef.current = null;
      setCredentialHost(null); setCredentialForgeKind(''); setToken('');
      // A 428 create/update has not performed its mutation, so replaying that
      // exact pending action after the credential is stored is safe.
      if (retry) await retry(); else finish('Connected host saved.');
    } catch { fail('Could not save this host token.'); }
  };

  const retryProject = async (projectId: string): Promise<void> => {
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectId)}/retry`, 'POST', {});
      if (!result.ok && result.status === 409 && (result.data as { error?: string }).error === 'run_limit') {
        setSwap({ projectId, running: (result.data as RunLimitPayload).running });
        setMutation({ busy: false, error: null, notice: null });
        return;
      }
      if (!result.ok) return fail(message(result));
      terminalBuildsRef.current.delete(projectId);
      setEditingRepo(null);
      finish('Project build queued.');
    } catch { fail('Could not retry this project.'); }
  };

  const inspectProject = async (projectId: string): Promise<void> => {
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectId)}/composition/inspect`, 'POST', {});
      if (!result.ok) return fail(message(result));
      terminalBuildsRef.current.delete(projectId);
      setEditingRepo(null);
      finish('Repository inspection started. No repository code will be executed.');
    } catch { fail('Could not inspect this repository.'); }
  };

  const updateRepository = async (projectId: string, nextRepoUrl: string): Promise<void> => {
    const normalized = nextRepoUrl.trim();
    if (!normalized) return fail('A replacement repository URL is required.');
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(projectId)}`, 'PUT', { repoUrl: normalized });
      if (!result.ok && result.status === 428) {
        const body = result.data as CredentialRequiredPayload;
        credentialRetryRef.current = () => updateRepository(projectId, normalized);
        const host = body.host || new URL(normalized).host;
        setCredentialHost(host);
        setCredentialForgeKind(inferredForge(host));
        setMutation({ busy: false, error: null, notice: null });
        return;
      }
      if (!result.ok) return fail(message(result));
      terminalBuildsRef.current.delete(projectId);
      setEditingRepo(null);
      finish('Repository updated. Inspection started; review the refreshed recipe when it is ready.');
    } catch { fail('Could not update this repository.'); }
  };

  const stop = async (project: ProjectSummary): Promise<void> => {
    if (project.hasActiveWork && !await showConfirm({ title: `Stop ${project.name}?`, description: 'An active session is working in this project. Stopping it can interrupt that work.', confirmLabel: 'Stop project', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try { const result = await request(`/api/projects/${encodeURIComponent(project.id)}/stop`, 'POST', { stopActive: project.hasActiveWork }); if (!result.ok) return fail(message(result)); finish('Project stopped.'); } catch { fail('Could not stop project.'); }
  };
  const remove = async (project: ProjectSummary, force = false): Promise<void> => {
    if (!force && !await showConfirm({
      title: `Delete ${project.name}?`,
      description: `${project.hasActiveWork ? 'Active project sessions will be stopped and detached. ' : ''}${project.repoUrl
        ? 'Its workspace will be removed after repository work is preserved.'
        : 'This project has no repository. Deleting it permanently removes its project workspace; only files in your persistent home survive.'}`,
      confirmLabel: 'Delete project',
      tone: 'danger',
    })) return;
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(project.id)}`, 'DELETE', {
        ...(force ? { force: true } : {}),
        stopActive: project.hasActiveWork,
      });
      if (!result.ok && result.status === 409 && (result.data as { error?: string }).error === 'preserve_failed') {
        setMutation({ busy: false, error: null, notice: null });
        if (await showConfirm({ title: 'Preservation failed', description: `${message(result)} Deleting now discards unpreserved work permanently.`, confirmLabel: 'Discard and delete', tone: 'danger' })) await remove(project, true);
        return;
      }
      if (!result.ok) return fail(message(result));
      finish('Project deleted.');
    } catch { fail('Could not delete project.'); }
  };
  const release = async (project: ProjectSummary, discard: boolean): Promise<void> => {
    if (discard && !await showConfirm({ title: `Discard ${project.name}'s work?`, description: 'This bypasses preservation and permanently removes the workspace.', confirmLabel: 'Discard work', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try { const result = await request(`/api/projects/${encodeURIComponent(project.id)}/release`, 'POST', { discard }); if (!result.ok) return fail(message(result)); finish(discard ? 'Work discarded and project released.' : 'Retrying preservation.'); } catch { fail('Could not release project.'); }
  };
  const removeHost = async (host: string): Promise<void> => {
    if (!await showConfirm({ title: `Remove ${host}?`, description: 'Future private repository access on this host will require a token again.', confirmLabel: 'Remove token', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/connected-hosts/${encodeURIComponent(host)}`, 'DELETE');
      if (!result.ok) return fail(message(result));
      finish('Connected host removed.');
    } catch { fail('Could not remove this connected host.'); }
  };

  if (!open) return null;
  const candidates = (swap?.running || []).filter((project) => !project.hasActiveWork && (!project.state || project.state === 'running'));
  const hasPlacementToggle = availability.available && availability.defaultExecutionKind === 'container';
  const visibleProjects = hasPlacementToggle
    ? projects.filter((project) => (project.executionKind === 'host') === localProjects)
    : projects;
  const recipeProject = recipeProjectId ? projects.find((project) => project.id === recipeProjectId) : null;
  const closeRecipe = (): void => {
    const triggerId = recipeProjectId ? `project-recipe-${recipeProjectId}` : null;
    setRecipeProjectId(null);
    if (triggerId) window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  };
  return (
    <Dialog
      open={open}
      title="Projects"
      description="Projects with resumable workspaces, running locally or on a deploy target."
      onClose={onClose}
      width={760}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {!recipeProject && view === 'projects' ? <Button variant="primary" disabled={mutation.busy || unknownCreate !== null || !availability.available} onClick={() => setCreating(true)}>New project</Button> : null}
      </>}
    >
      {!recipeProject ? (
        <Tabs
          tabs={[{ value: 'projects', label: 'Projects' }, { value: 'data', label: 'Workspace data' }]}
          value={view}
          onChange={(next) => setView(next as 'projects' | 'data')}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {recipeProject ? (
        <ProjectCompositionPanel
          project={recipeProject}
          onBack={closeRecipe}
          onChanged={() => { terminalBuildsRef.current.delete(recipeProject.id); notifyProjectsChanged(); void read(); }}
        />
      ) : view === 'data' ? <WorkspaceDataPanel /> : <>
      {hasPlacementToggle ? (
        <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10 }}>
          <span>
            <strong>Local Projects</strong>
            <span style={{ display: 'block', marginTop: 3, color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
              {localProjects
                ? 'Showing projects on this machine. New projects will be local.'
                : 'Turn on to show and create projects on this machine instead of the active deploy target.'}
            </span>
          </span>
          <Switch
            checked={localProjects}
            disabled={credentialHost !== null || unknownCreate !== null}
            ariaLabel="Show and create local projects"
            onChange={setLocalProjects}
          />
        </div>
      ) : null}
      {mutation.error ? <p role="alert" style={{ color: 'var(--destructive)' }}>{mutation.error}</p> : null}
      {mutation.notice ? <p role="status" style={{ color: 'var(--muted-foreground)' }}>{mutation.notice}</p> : null}
      {!availability.available ? <div role="status" style={card}><strong>Projects need a deploy target</strong><p>{availability.message || 'Ask the installer to configure and activate a container deploy target in Settings.'}</p></div> : null}
      {unknownCreate ? (
        <div style={card}>
          <strong>Creation outcome unknown</strong>
          <p>The client will not repeat this create until the project list has been checked.</p>
          <Button variant="secondary" disabled={mutation.busy} onClick={() => void reconcileCreate(unknownCreate)}>Check again</Button>{' '}
        </div>
      ) : null}
      {credentialHost ? (
        <div style={card}>
          <p>Access to <strong>{credentialHost}</strong> requires a token. It is stored for clone and preservation pushes on this host.</p>
          <p><Select autoFocus={!credentialForgeKind} aria-label="Repository host type" value={credentialForgeKind} options={HOST_FORGES} onChange={(event) => setCredentialForgeKind(event.currentTarget.value)} /></p>
          <Input autoFocus={Boolean(credentialForgeKind)} aria-label="Access token" type="password" value={token} onChange={(event) => setToken(event.currentTarget.value)} />
          <p><Button variant="secondary" disabled={mutation.busy} onClick={() => { credentialRetryRef.current = null; setCredentialHost(null); setCredentialForgeKind(''); setToken(''); }}>Cancel</Button>{' '}<Button variant="primary" disabled={mutation.busy || !credentialForgeKind || !token.trim()} onClick={() => void saveCredential()}>{mutation.busy ? 'Saving and validating…' : 'Save and retry'}</Button></p>
        </div>
      ) : null}
      {swap ? (
        <div style={card}>
          <p>Choose a project to stop. Projects with active work cannot be selected.</p>
          {candidates.length ? candidates.map((project, index) => <p key={project.id}><Button variant="secondary" disabled={mutation.busy} onClick={() => void start(swap.projectId, project.id)}>{index === 0 ? 'Suggested: ' : ''}Stop {project.name} and start</Button></p>) : <p>No safe project is available to stop.</p>}
          <Button variant="secondary" onClick={() => setSwap(null)}>Cancel</Button>
        </div>
      ) : null}
      {creating && !credentialHost ? (
        <div style={card}>
          <p><Input autoFocus aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} /></p>
          <p><Input disabled={!repositoryInspectionSupported} aria-label="Repository URL" placeholder={repositoryInspectionSupported ? 'https://github.com/owner/repo (optional)' : 'Repository inspection is unavailable on Windows'} value={repoUrl} onChange={(event) => setRepoUrl(event.currentTarget.value)} /></p>
          {!repositoryInspectionSupported ? <p role="status" style={{ color: 'var(--muted-foreground)' }}>Windows can create projects without a repository. Use a Linux server for safely inspected repository projects.</p> : null}
          {!repoUrl.trim() ? (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
              <input type="checkbox" checked={acknowledgeDisposable} onChange={(event) => setAcknowledgeDisposable(event.currentTarget.checked)} />
              <span>This project has no repository. A rebuild, long-idle reclaim, or deletion permanently discards its project workspace; only your persistent home survives.</span>
            </label>
          ) : (
            <p style={{ color: 'var(--muted-foreground)' }}>The repository working tree is disposable. Before an automatic rebuild, uncommitted work is pushed to a marked WIP branch; files elsewhere in the container are not preserved.</p>
          )}
          <Button variant="secondary" onClick={() => { setCreating(false); setAcknowledgeDisposable(false); }}>Cancel</Button>{' '}
          <Button variant="primary" disabled={mutation.busy || unknownCreate !== null || !name.trim() || (!repoUrl.trim() && !acknowledgeDisposable)} onClick={() => void create()}>{repoUrl.trim() ? 'Inspect repository' : 'Choose setup'}</Button>
        </div>
      ) : null}
      <div style={{ ...card, marginTop: 10 }}>
          <strong>Connected hosts</strong>
          <p style={{ color: 'var(--muted-foreground)', margin: '5px 0', fontSize: 'var(--text-xs)' }}>Connection status is shown here; token values are never returned to this page.</p>
          {!hosts.length ? <p style={{ color: 'var(--muted-foreground)', margin: '6px 0 0' }}>No connected repository hosts.</p> : null}
          {hosts.map((host) => {
            const expired = host.expiresAt ? new Date(host.expiresAt).getTime() <= Date.now() : false;
            const needsAttention = host.validationStatus === 'invalid' || expired;
            const unvalidated = host.validationStatus === 'unvalidated' || host.validationStatus == null;
            return <div key={host.host} style={{ display: 'flex', flexDirection: isPhone ? 'column' : 'row', justifyContent: 'space-between', alignItems: isPhone ? 'stretch' : 'center', gap: 8, marginTop: 6 }}>
              <span>
                <strong>{host.host}</strong>{host.forgeKind ? <span style={{ color: 'var(--muted-foreground)' }}> · {host.forgeKind}</span> : null}
                {host.scopes?.length ? <span style={{ display: 'block', color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>Scopes: {host.scopes.join(', ')}</span> : null}
                {needsAttention && host.validationErrorMessage ? <span style={{ display: 'block', color: 'var(--destructive)', fontSize: 'var(--text-xs)' }}>{host.validationErrorMessage}</span> : null}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Badge variant={needsAttention ? 'destructive' : unvalidated ? 'warning' : 'success'}>{needsAttention ? 'Needs attention' : unvalidated ? 'Stored · not validated' : 'Validated'}</Badge>
                <Button variant="ghost" size="sm" disabled={mutation.busy} onClick={() => void removeHost(host.host)}>Remove</Button>
              </span>
            </div>;
          })}
        </div>
      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        {visibleProjects.length === 0 ? (
          <p style={{ color: 'var(--muted-foreground)' }}>
            {localProjects ? 'No local projects yet. Create one to keep its workspace on this machine.' : 'No deploy-target projects yet. Create one to get its own container.'}
          </p>
        ) : visibleProjects.map((project) => {
          const inspectionRequired = needsRepositoryInspection(project);
          return <div key={project.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{project.name}</strong><span>{PROJECT_STATE_LABELS[project.state]}</span></div>
            <p style={{ color: 'var(--muted-foreground)', margin: '6px 0' }}>{projectLabel(project)}{project.hasActiveWork ? ' · active work' : ''}</p>
            <p style={{ color: 'var(--muted-foreground)', margin: '6px 0', fontSize: 'var(--text-xs)' }}>{project.targetName || (project.executionKind === 'host' ? 'Local machine' : project.targetId ? `Target ${project.targetId}` : 'Startup target')} · last used {new Date(project.lastActivityAt).toLocaleString()}</p>
            {project.repoUrl ? <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}>{project.repoUrl}</p> : <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)', color: 'var(--destructive)' }}>No repository — a rebuild, long-idle reclaim, or deletion permanently discards this project workspace.</p>}
            {project.lastPreservedBranch ? (
              <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}>
                Recovery branch: <code>{project.lastPreservedBranch}</code>{project.lastPreservedCommit ? <> · commit <code>{project.lastPreservedCommit}</code></> : null}
              </p>
            ) : null}
            {['unavailable', 'failed'].includes(project.state) && project.repoUrl ? (
              editingRepo?.projectId === project.id ? (
                <div style={{ ...card, margin: '8px 0' }}>
                  <Input aria-label={`Replacement repository for ${project.name}`} value={editingRepo.repoUrl} onChange={(event) => setEditingRepo({ projectId: project.id, repoUrl: event.currentTarget.value })} />
                  <p><Button size="sm" variant="secondary" onClick={() => setEditingRepo(null)}>Cancel</Button>{' '}<Button size="sm" variant="primary" disabled={mutation.busy || !editingRepo.repoUrl.trim()} onClick={() => void updateRepository(project.id, editingRepo.repoUrl)}>Save and retry</Button></p>
                </div>
              ) : (
                <p><Button size="sm" variant="secondary" disabled={mutation.busy || (inspectionRequired && !repositoryInspectionSupported)} onClick={() => void (inspectionRequired ? inspectProject(project.id) : retryProject(project.id))}>{inspectionRequired ? 'Inspect repository again' : 'Retry build'}</Button>{' '}<Button size="sm" variant="secondary" disabled={mutation.busy || !repositoryInspectionSupported} onClick={() => setEditingRepo({ projectId: project.id, repoUrl: project.repoUrl || '' })}>Change repository</Button></p>
              )
            ) : null}
            {(events[project.id] || []).slice(-4).map((event, index) => <p key={`${event.at}-${index}`} style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}><Icon name="loader-circle" size={12} /> {projectEventLabel(event)}{event.percent !== undefined ? ` · ${event.percent}%` : ''}</p>)}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Button id={`project-recipe-${project.id}`} size="sm" variant={project.state === 'composition_pending' ? 'primary' : 'secondary'} disabled={mutation.busy || project.state === 'inspecting' || inspectionRequired} onClick={() => setRecipeProjectId(project.id)}>{project.state === 'composition_pending' ? 'Review recipe' : 'Recipe'}</Button>
              <Button size="sm" variant="secondary" disabled={mutation.busy || project.state !== 'running'} onClick={() => onOpenProject(project.id)}>Open</Button>
              <Button size="sm" variant="secondary" disabled={mutation.busy || !['stopped', 'failed'].includes(project.state) || inspectionRequired} onClick={() => void start(project.id)}>Start</Button>
              <Button size="sm" variant="secondary" disabled={mutation.busy || project.state !== 'running'} onClick={() => void stop(project)}>Stop</Button>
              {['blocked', 'reclaiming'].includes(project.state) ? <><Button size="sm" variant="secondary" disabled={mutation.busy || project.hasActiveWork} onClick={() => void release(project, false)}>Retry recovery</Button><Button size="sm" variant="destructive" disabled={mutation.busy || project.hasActiveWork} onClick={() => void release(project, true)}>Discard</Button></> : null}
              <Button size="sm" variant="ghost" disabled={mutation.busy || project.state === 'inspecting' || project.state === 'building' || project.state === 'reclaiming'} onClick={() => void remove(project)}>Delete</Button>
            </div>
          </div>
        })}
      </div>
      </>}
    </Dialog>
  );
}
