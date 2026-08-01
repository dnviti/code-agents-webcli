import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { showConfirm } from '../../ui/confirm';
import type { BuildEvent, CredentialRequiredPayload, ProjectState, ProjectSummary, RunLimitPayload, RunningProjectInfo } from '../projects-types.js';

export interface ProjectsDialogProps {
  open: boolean;
  onClose(): void;
  onOpenProject(projectId: string): void;
}

interface ConnectedHost { host: string; }
interface Mutation { busy: boolean; error: string | null; notice: string | null; }
interface Swap { projectId: string; running: RunningProjectInfo[]; }
interface UnknownCreate {
  name: string;
  repoUrl: string | null;
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

const terminalStates: ProjectState[] = ['stopped', 'failed', 'unavailable', 'blocked'];
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12 };

function projectLabel(project: ProjectSummary): string {
  return project.stateDetail || project.state;
}

function createdByAttempt(project: ProjectSummary, attempt: UnknownCreate): boolean {
  return !attempt.previousIds.includes(project.id)
    && project.name === attempt.name
    && (project.repoUrl || null) === attempt.repoUrl;
}

/** Project lifecycle UI. It owns no server state: websocket changes and writes both re-read the list. */
export function ProjectsDialog({ open, onClose, onOpenProject }: ProjectsDialogProps): React.JSX.Element | null {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [hosts, setHosts] = React.useState<ConnectedHost[]>([]);
  const [mutation, setMutation] = React.useState<Mutation>({ busy: false, error: null, notice: null });
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [credentialHost, setCredentialHost] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');
  const [swap, setSwap] = React.useState<Swap | null>(null);
  const [events, setEvents] = React.useState<Record<string, BuildEvent[]>>({});
  const [unknownCreate, setUnknownCreate] = React.useState<UnknownCreate | null>(null);
  const sourcesRef = React.useRef(new Map<string, EventSource>());
  const seenEventsRef = React.useRef(new Map<string, Set<string>>());
  const terminalBuildsRef = React.useRef(new Set<string>());

  const fetchProjects = React.useCallback(async (): Promise<ProjectSummary[]> => {
    const result = await request('/api/projects');
    if (!result.ok) throw new Error(message(result));
    const data = result.data as { projects?: unknown };
    return Array.isArray(data.projects) ? data.projects as ProjectSummary[] : [];
  }, []);

  const read = React.useCallback(async (): Promise<void> => {
    try {
      const [listed, hostList] = await Promise.all([fetchProjects(), request('/api/connected-hosts')]);
      setProjects(listed);
      if (hostList.ok) {
        const body = hostList.data as { hosts?: unknown };
        setHosts(Array.isArray(body.hosts) ? body.hosts as ConnectedHost[] : []);
      }
      setMutation((previous) => ({ ...previous, error: null }));
    } catch (error) {
      setMutation((previous) => ({ ...previous, error: error instanceof Error ? error.message : 'Could not load projects.' }));
    }
  }, [fetchProjects]);

  React.useEffect(() => {
    if (!open) return;
    void read();
  }, [open, read]);
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
    const building = new Set(projects.filter((project) => project.state === 'building').map((project) => project.id));
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
          const key = JSON.stringify(event);
          const seen = seenEventsRef.current.get(projectId) || new Set<string>();
          if (seen.has(key)) return;
          seen.add(key);
          seenEventsRef.current.set(projectId, seen);
          setEvents((previous) => ({ ...previous, [projectId]: [...(previous[projectId] || []), event] }));
          if (event.state && terminalStates.includes(event.state)) {
            terminalBuildsRef.current.add(projectId);
            source.close();
            sourcesRef.current.delete(projectId);
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
  }, [open, projects]);
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
        setMutation({
          busy: false,
          error: null,
          notice: `The create response was lost, but ${matches[0].name} exists (${matches[0].id}). No retry was sent.`,
        });
        return true;
      }
      setUnknownCreate(attempt);
      setMutation({
        busy: false,
        error: 'Project creation has an unknown outcome. No automatic retry was sent; check again before starting another create.',
        notice: matches.length > 1 ? 'More than one new matching project exists, so the client cannot choose one safely.' : null,
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
      finish('Project is starting.');
    } catch { fail('Could not start project.'); }
  };

  const create = async (): Promise<void> => {
    if (unknownCreate) return;
    const attempt: UnknownCreate = {
      name: name.trim(),
      repoUrl: repoUrl.trim() || null,
      previousIds: projects.map((project) => project.id),
    };
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request('/api/projects', 'POST', { name: attempt.name, repoUrl: attempt.repoUrl });
      if (!result.ok && result.status === 428) {
        const body = result.data as CredentialRequiredPayload;
        setCredentialHost(body.host || new URL(repoUrl).host);
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
      setCreating(false); setName(''); setRepoUrl(''); finish('Project created and building.');
    } catch {
      await reconcileCreate(attempt);
    }
  };

  const saveCredential = async (): Promise<void> => {
    if (!credentialHost || !token.trim()) return;
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request('/api/connected-hosts', 'POST', { host: credentialHost, token: token.trim() });
      if (!result.ok) return fail(message(result));
      setCredentialHost(null); setToken('');
      // A 428 create has not made a project, so retrying it is safe.
      await create();
    } catch { fail('Could not save this host token.'); }
  };

  const stop = async (project: ProjectSummary): Promise<void> => {
    if (project.hasActiveWork && !await showConfirm({ title: `Stop ${project.name}?`, description: 'An active session is working in this project. Stopping it can interrupt that work.', confirmLabel: 'Stop project', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try { const result = await request(`/api/projects/${encodeURIComponent(project.id)}/stop`, 'POST'); if (!result.ok) return fail(message(result)); finish('Project stopping.'); } catch { fail('Could not stop project.'); }
  };
  const remove = async (project: ProjectSummary, force = false): Promise<void> => {
    if (!force && !await showConfirm({ title: `Delete ${project.name}?`, description: 'Its workspace will be removed after work is preserved.', confirmLabel: 'Delete project', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try {
      const result = await request(`/api/projects/${encodeURIComponent(project.id)}`, 'DELETE', force ? { force: true } : {});
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
    const result = await request(`/api/connected-hosts/${encodeURIComponent(host)}`, 'DELETE');
    if (!result.ok) setMutation((previous) => ({ ...previous, error: message(result) })); else void read();
  };

  if (!open) return null;
  const candidates = (swap?.running || []).filter((project) => !project.hasActiveWork);
  return <Dialog open={open} title="Projects" description="Persistent workspaces with their own runtime." onClose={onClose} width={680} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" disabled={mutation.busy || unknownCreate !== null} onClick={() => setCreating(true)}>New project</Button></>}>
    {mutation.error ? <p role="alert" style={{ color: 'var(--destructive)' }}>{mutation.error}</p> : null}
    {mutation.notice ? <p style={{ color: 'var(--muted-foreground)' }}>{mutation.notice}</p> : null}
    {unknownCreate ? <div style={card}><strong>Creation outcome unknown</strong><p>The client will not repeat this create until the project list has been checked.</p><Button variant="secondary" disabled={mutation.busy} onClick={() => void reconcileCreate(unknownCreate)}>Check again</Button> <Button variant="secondary" disabled={mutation.busy} onClick={() => { setUnknownCreate(null); setMutation({ busy: false, error: null, notice: 'No matching project was selected. Review the list before submitting a new create.' }); }}>Clear without retrying</Button></div> : null}
    {credentialHost ? <div style={card}><p>Access to <strong>{credentialHost}</strong> requires a token.</p><Input aria-label="Access token" type="password" value={token} onChange={(event) => setToken(event.currentTarget.value)} /><p><Button variant="secondary" onClick={() => { setCredentialHost(null); setToken(''); }}>Cancel</Button> <Button variant="primary" disabled={mutation.busy || !token.trim()} onClick={() => void saveCredential()}>Save and retry</Button></p></div> : null}
    {swap ? <div style={card}><p>Choose a project to stop. Projects with active work cannot be selected.</p>{candidates.length ? candidates.map((project) => <p key={project.id}><Button variant="secondary" disabled={mutation.busy} onClick={() => void start(swap.projectId, project.id)}>Stop {project.name} and start</Button></p>) : <p>No safe project is available to stop.</p>}<Button variant="secondary" onClick={() => setSwap(null)}>Cancel</Button></div> : null}
    {creating && !credentialHost ? <div style={card}><p><Input aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} /></p><p><Input aria-label="Repository URL" placeholder="https://github.com/owner/repo (optional)" value={repoUrl} onChange={(event) => setRepoUrl(event.currentTarget.value)} /></p><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button> <Button variant="primary" disabled={mutation.busy || unknownCreate !== null || !name.trim()} onClick={() => void create()}>Create project</Button></div> : null}
    {hosts.length ? <div style={{ ...card, marginTop: 10 }}><strong>Connected hosts</strong>{hosts.map((host) => <div key={host.host} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}><span>{host.host}</span><Button variant="ghost" size="sm" onClick={() => void removeHost(host.host)}>Remove</Button></div>)}</div> : null}
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>{projects.length === 0 ? <p style={{ color: 'var(--muted-foreground)' }}>No projects yet. Create one to get a persistent workspace.</p> : projects.map((project) => <div key={project.id} style={card}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{project.name}</strong><span>{project.state}</span></div><p style={{ color: 'var(--muted-foreground)', margin: '6px 0' }}>{projectLabel(project)}{project.hasActiveWork ? ' · active work' : ''}</p>{project.repoUrl ? <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}>{project.repoUrl}</p> : null}{(events[project.id] || []).slice(-1).map((event, index) => <p key={index} style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}><Icon name="loader-circle" size={12} /> {event.message || event.step || event.state}</p>)}<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}><Button size="sm" variant="secondary" disabled={mutation.busy || project.state !== 'running'} onClick={() => onOpenProject(project.id)}>Open</Button><Button size="sm" variant="secondary" disabled={mutation.busy || project.state === 'running' || project.state === 'building'} onClick={() => void start(project.id)}>Start</Button><Button size="sm" variant="secondary" disabled={mutation.busy || project.state === 'stopped' || project.state === 'building'} onClick={() => void stop(project)}>Stop</Button>{project.state === 'blocked' ? <><Button size="sm" variant="secondary" onClick={() => void release(project, false)}>Retry preservation</Button><Button size="sm" variant="destructive" onClick={() => void release(project, true)}>Discard</Button></> : null}<Button size="sm" variant="ghost" disabled={mutation.busy} onClick={() => void remove(project)}>Delete</Button></div></div>)}</div>
  </Dialog>;
}
