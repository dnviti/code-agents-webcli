import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { showConfirm } from '../../ui/confirm';
import {
  buildEventKey,
  mergeProjectBuildEvents,
  type BuildEvent,
  type CredentialRequiredPayload,
  type ProjectState,
  type ProjectSummary,
  type RunLimitPayload,
  type RunningProjectInfo,
} from '../projects-types.js';

export interface ProjectsDialogProps {
  open: boolean;
  onClose(): void;
  onOpenProject(projectId: string): void;
}

interface ConnectedHost { host: string; }
interface ProjectAvailability { available: boolean; message?: string; }
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

const terminalStates: ProjectState[] = ['running', 'stopped', 'failed', 'unavailable', 'blocked'];
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12 };

function projectLabel(project: ProjectSummary): string {
  return project.stateDetail || project.state;
}

function createdByAttempt(project: ProjectSummary, attempt: UnknownCreate): boolean {
  return !attempt.previousIds.includes(project.id)
    && project.name === attempt.name
    && (project.repoUrl || null) === attempt.repoUrl;
}

function projectEventLabel(event: BuildEvent): string {
  if (event.t === 'preserve' && event.branch) {
    return `Preserved work on ${event.branch}${event.commit ? ` at ${event.commit}` : ''}`;
  }
  return event.message || event.step || event.state || event.t;
}

/** Project lifecycle UI. It owns no server state: websocket changes and writes both re-read the list. */
export function ProjectsDialog({ open, onClose, onOpenProject }: ProjectsDialogProps): React.JSX.Element | null {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [hosts, setHosts] = React.useState<ConnectedHost[]>([]);
  const [availability, setAvailability] = React.useState<ProjectAvailability>({ available: true });
  const [mutation, setMutation] = React.useState<Mutation>({ busy: false, error: null, notice: null });
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [acknowledgeDisposable, setAcknowledgeDisposable] = React.useState(false);
  const [credentialHost, setCredentialHost] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');
  const [swap, setSwap] = React.useState<Swap | null>(null);
  const [events, setEvents] = React.useState<Record<string, BuildEvent[]>>({});
  const [unknownCreate, setUnknownCreate] = React.useState<UnknownCreate | null>(null);
  const [editingRepo, setEditingRepo] = React.useState<{ projectId: string; repoUrl: string } | null>(null);
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
      availability: data.availability?.available === false
        ? data.availability
        : { available: true },
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
    setToken('');
    setEditingRepo(null);
    setSwap(null);
  }, [open]);
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
        credentialRetryRef.current = create;
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
      setCreating(false); setName(''); setRepoUrl(''); setAcknowledgeDisposable(false); finish('Project created and building.');
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
      const retry = credentialRetryRef.current;
      credentialRetryRef.current = null;
      setCredentialHost(null); setToken('');
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
      setEditingRepo(null);
      finish('Project rebuild queued.');
    } catch { fail('Could not retry this project.'); }
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
        setCredentialHost(body.host || new URL(normalized).host);
        setMutation({ busy: false, error: null, notice: null });
        return;
      }
      if (!result.ok) return fail(message(result));
      await retryProject(projectId);
    } catch { fail('Could not update this repository.'); }
  };

  const stop = async (project: ProjectSummary): Promise<void> => {
    if (project.hasActiveWork && !await showConfirm({ title: `Stop ${project.name}?`, description: 'An active session is working in this project. Stopping it can interrupt that work.', confirmLabel: 'Stop project', tone: 'danger' })) return;
    setMutation({ busy: true, error: null, notice: null });
    try { const result = await request(`/api/projects/${encodeURIComponent(project.id)}/stop`, 'POST'); if (!result.ok) return fail(message(result)); finish('Project stopping.'); } catch { fail('Could not stop project.'); }
  };
  const remove = async (project: ProjectSummary, force = false): Promise<void> => {
    if (!force && !await showConfirm({
      title: `Delete ${project.name}?`,
      description: project.repoUrl
        ? 'Its workspace will be removed after repository work is preserved.'
        : 'This project has no repository. Deleting it permanently removes its project workspace; only files in your persistent home survive.',
      confirmLabel: 'Delete project',
      tone: 'danger',
    })) return;
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
  const candidates = (swap?.running || []).filter((project) => !project.hasActiveWork && (!project.state || project.state === 'running'));
  return (
    <Dialog
      open={open}
      title="Projects"
      description="Projects with their own containers and resumable stopped worktrees."
      onClose={onClose}
      width={680}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" disabled={mutation.busy || unknownCreate !== null || !availability.available} onClick={() => setCreating(true)}>New project</Button></>}
    >
      {mutation.error ? <p role="alert" style={{ color: 'var(--destructive)' }}>{mutation.error}</p> : null}
      {mutation.notice ? <p style={{ color: 'var(--muted-foreground)' }}>{mutation.notice}</p> : null}
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
          <Input aria-label="Access token" type="password" value={token} onChange={(event) => setToken(event.currentTarget.value)} />
          <p><Button variant="secondary" onClick={() => { credentialRetryRef.current = null; setCredentialHost(null); setToken(''); }}>Cancel</Button>{' '}<Button variant="primary" disabled={mutation.busy || !token.trim()} onClick={() => void saveCredential()}>Save and retry</Button></p>
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
          <p><Input aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} /></p>
          <p><Input aria-label="Repository URL" placeholder="https://github.com/owner/repo (optional)" value={repoUrl} onChange={(event) => setRepoUrl(event.currentTarget.value)} /></p>
          {!repoUrl.trim() ? (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
              <input type="checkbox" checked={acknowledgeDisposable} onChange={(event) => setAcknowledgeDisposable(event.currentTarget.checked)} />
              <span>This project has no repository. A rebuild, long-idle reclaim, or deletion permanently discards its project workspace; only your persistent home survives.</span>
            </label>
          ) : (
            <p style={{ color: 'var(--muted-foreground)' }}>The repository working tree is disposable. Before an automatic rebuild, uncommitted work is pushed to a marked WIP branch; files elsewhere in the container are not preserved.</p>
          )}
          <Button variant="secondary" onClick={() => { setCreating(false); setAcknowledgeDisposable(false); }}>Cancel</Button>{' '}
          <Button variant="primary" disabled={mutation.busy || unknownCreate !== null || !name.trim() || (!repoUrl.trim() && !acknowledgeDisposable)} onClick={() => void create()}>Create project</Button>
        </div>
      ) : null}
      {hosts.length ? (
        <div style={{ ...card, marginTop: 10 }}>
          <strong>Connected hosts</strong>
          {hosts.map((host) => <div key={host.host} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}><span>{host.host}</span><Button variant="ghost" size="sm" onClick={() => void removeHost(host.host)}>Remove</Button></div>)}
        </div>
      ) : null}
      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
        {projects.length === 0 ? <p style={{ color: 'var(--muted-foreground)' }}>No projects yet. Create one to get its own container.</p> : projects.map((project) => (
          <div key={project.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{project.name}</strong><span>{project.state}</span></div>
            <p style={{ color: 'var(--muted-foreground)', margin: '6px 0' }}>{projectLabel(project)}{project.hasActiveWork ? ' · active work' : ''}</p>
            <p style={{ color: 'var(--muted-foreground)', margin: '6px 0', fontSize: 'var(--text-xs)' }}>{project.targetName || (project.targetId ? `Target ${project.targetId}` : 'Startup target')} · last used {new Date(project.lastActivityAt).toLocaleString()}</p>
            {project.repoUrl ? <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}>{project.repoUrl}</p> : <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)', color: 'var(--destructive)' }}>No repository — a rebuild, long-idle reclaim, or deletion permanently discards this project workspace.</p>}
            {project.lastPreservedBranch ? (
              <p style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}>
                Recovery branch: <code>{project.lastPreservedBranch}</code>{project.lastPreservedCommit ? <> · commit <code>{project.lastPreservedCommit}</code></> : null}
              </p>
            ) : null}
            {project.state === 'unavailable' ? (
              editingRepo?.projectId === project.id ? (
                <div style={{ ...card, margin: '8px 0' }}>
                  <Input aria-label={`Replacement repository for ${project.name}`} value={editingRepo.repoUrl} onChange={(event) => setEditingRepo({ projectId: project.id, repoUrl: event.currentTarget.value })} />
                  <p><Button size="sm" variant="secondary" onClick={() => setEditingRepo(null)}>Cancel</Button>{' '}<Button size="sm" variant="primary" disabled={mutation.busy || !editingRepo.repoUrl.trim()} onClick={() => void updateRepository(project.id, editingRepo.repoUrl)}>Save and retry</Button></p>
                </div>
              ) : (
                <p><Button size="sm" variant="secondary" disabled={mutation.busy} onClick={() => void retryProject(project.id)}>Retry current address</Button>{' '}<Button size="sm" variant="secondary" disabled={mutation.busy} onClick={() => setEditingRepo({ projectId: project.id, repoUrl: project.repoUrl || '' })}>Change repository</Button></p>
              )
            ) : null}
            {(events[project.id] || []).slice(-4).map((event, index) => <p key={`${event.at}-${index}`} style={{ margin: '6px 0', fontSize: 'var(--text-xs)' }}><Icon name="loader-circle" size={12} /> {projectEventLabel(event)}{event.percent !== undefined ? ` · ${event.percent}%` : ''}</p>)}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Button size="sm" variant="secondary" disabled={mutation.busy || project.state !== 'running'} onClick={() => onOpenProject(project.id)}>Open</Button>
              <Button size="sm" variant="secondary" disabled={mutation.busy || !['stopped', 'failed'].includes(project.state)} onClick={() => void start(project.id)}>Start</Button>
              <Button size="sm" variant="secondary" disabled={mutation.busy || project.state !== 'running' || project.hasActiveWork} onClick={() => void stop(project)}>Stop</Button>
              {['blocked', 'reclaiming'].includes(project.state) ? <><Button size="sm" variant="secondary" disabled={mutation.busy || project.hasActiveWork} onClick={() => void release(project, false)}>Retry recovery</Button><Button size="sm" variant="destructive" disabled={mutation.busy || project.hasActiveWork} onClick={() => void release(project, true)}>Discard</Button></> : null}
              <Button size="sm" variant="ghost" disabled={mutation.busy || project.hasActiveWork || project.state === 'building' || project.state === 'reclaiming'} onClick={() => void remove(project)}>Delete</Button>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
