import * as React from 'react';

import { Badge } from '../../ui/relay/Badge';
import { Button } from '../../ui/relay/Button';
import { Checkbox } from '../../ui/relay/Checkbox';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { Select } from '../../ui/relay/Select';
import { usePhone } from '../../ui/touch';
import {
  ApiError,
  confirmProjectComposition,
  getGitIdentity,
  getProjectComposition,
  putGitIdentity,
  retryProjectComposition,
  saveProjectComposition,
  type CompositionInstallation,
  type AgentRuntimeCatalogItem,
  type AgentRuntimeChoice,
  type GitIdentity,
  type ProjectCompositionResponse,
  type RuntimeCatalogItem,
  type RuntimeChoice,
  type RuntimeDetection,
  type RuntimeVersionHint,
} from '../composition-api.js';
import type { ProjectSummary, RunningProjectInfo } from '../projects-types.js';

export interface ProjectCompositionPanelProps {
  project: ProjectSummary;
  onBack(): void;
  onChanged(): void;
}

const FORGES = [
  { value: '', label: 'No forge CLI' },
  { value: 'github', label: 'GitHub / GitHub Enterprise (gh)' },
  { value: 'gitlab', label: 'GitLab (glab)' },
  { value: 'gitea', label: 'Gitea (tea)' },
  { value: 'forgejo', label: 'Forgejo (tea)' },
];

const panel: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--card)',
  padding: 12,
};

const stageLabel: React.CSSProperties = {
  color: 'var(--muted-foreground)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-2xs)',
  fontWeight: 'var(--font-medium)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
};

export function initialRuntimeChoices(data: ProjectCompositionResponse): RuntimeChoice[] {
  if (data.composition.chosen) return data.composition.chosen.runtimes.map((choice) => ({ ...choice }));
  return data.composition.detected?.detectedRuntimes.map((runtime) => ({
    runtimeId: runtime.runtimeId,
    version: runtime.selectedVersion,
  })) || [];
}

export function initialAgentRuntimeChoices(data: ProjectCompositionResponse): AgentRuntimeChoice[] {
  return data.composition.chosen?.agents?.map((choice) => ({ ...choice })) || [];
}

function detectionFor(data: ProjectCompositionResponse, runtimeId: string): RuntimeDetection | undefined {
  return data.composition.detected?.detectedRuntimes.find((item) => item.runtimeId === runtimeId);
}

function installationFor(data: ProjectCompositionResponse, runtimeId: string): CompositionInstallation | undefined {
  return data.composition.installations.find((item) => (
    item.itemId === runtimeId || item.itemId === `runtime:${runtimeId}`
      || item.itemId === `agent-${runtimeId}` || item.itemId.endsWith(`:${runtimeId}`)
  ));
}

function installedStage(item: CompositionInstallation | undefined): React.ReactNode {
  if (!item) return <span style={{ color: 'var(--muted-foreground)' }}>Not built yet</span>;
  if (item.status === 'installed') return <Badge variant="success">✓ {item.installedVersion || 'Installed'}</Badge>;
  if (item.status === 'failed') return (
    <span>
      <Badge variant="destructive">Setup failed</Badge>
      <span style={{ display: 'block', color: 'var(--destructive)', marginTop: 4 }}>{item.errorMessage || item.errorCode || 'Installation failed'}</span>
    </span>
  );
  if (item.status === 'installing') return <Badge variant="warning">Installing</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

function identityIsComplete(identity: GitIdentity): boolean {
  return identity.name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email.trim());
}

/** Match the server's deliberately narrow version grammar exactly. */
export function isConservativeRuntimeVersion(value: string): boolean {
  return /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,3})){0,3}$/.test(value.trim());
}

/** Keep repository evidence readable while tolerating the pre-contract string shape. */
export function runtimeVersionHintLabel(hint: RuntimeVersionHint | string): string {
  return typeof hint === 'string' ? hint : `${hint.version} from ${hint.path}`;
}

function runtimeVersionSourceLabel(source: RuntimeDetection['versionSource']): string {
  return source === 'catalog_default' ? 'catalog default' : 'repository marker';
}

type ForgeHint = string | { kind: string; host: string } | null | undefined;

function forgeHintKind(hint: ForgeHint): string {
  return typeof hint === 'string' ? hint : hint?.kind || '';
}

function forgeHintLabel(hint: ForgeHint): string {
  return typeof hint === 'string' ? hint : hint ? `${hint.kind} · ${hint.host}` : '';
}

function forgeToolId(kind: string): string {
  if (kind === 'github') return 'gh';
  if (kind === 'gitlab') return 'glab';
  if (kind === 'gitea' || kind === 'forgejo') return 'tea';
  return kind;
}

function repositoryHost(repoUrl: string | null): string {
  if (!repoUrl) return '';
  try { return new URL(repoUrl).host; } catch { return ''; }
}

export function compositionRequiresRebuild(
  project: Pick<ProjectSummary, 'state' | 'compositionRevision' | 'appliedCompositionRevision'>,
  composition: ProjectCompositionResponse['composition'],
): boolean {
  const appliedRevision = composition.appliedRevision !== undefined
    ? composition.appliedRevision
    : project.appliedCompositionRevision;
  if (appliedRevision) return composition.revision !== appliedRevision;
  const activeRevision = composition.activeRevision !== undefined
    ? composition.activeRevision
    : project.compositionRevision;
  return Boolean(activeRevision) || !['inspecting', 'composition_pending'].includes(project.state);
}

export function compositionIsFirstBuild(
  project: Pick<ProjectSummary, 'state' | 'compositionRevision' | 'appliedCompositionRevision'>,
  composition: ProjectCompositionResponse['composition'],
): boolean {
  const activeRevision = composition.activeRevision !== undefined
    ? composition.activeRevision
    : project.compositionRevision;
  const appliedRevision = composition.appliedRevision !== undefined
    ? composition.appliedRevision
    : project.appliedCompositionRevision;
  return project.state === 'composition_pending' && !activeRevision && !appliedRevision;
}

export function confirmationBaseRevision(
  project: Pick<ProjectSummary, 'state' | 'compositionRevision' | 'appliedCompositionRevision'>,
  composition: ProjectCompositionResponse['composition'],
): string | null {
  if (composition.activeRevision !== undefined) return composition.activeRevision;
  if (project.compositionRevision !== undefined) return project.compositionRevision;
  if (project.appliedCompositionRevision) return project.appliedCompositionRevision;
  return ['inspecting', 'composition_pending'].includes(project.state) ? null : composition.revision;
}

function sameChoices(a: readonly RuntimeChoice[], b: readonly RuntimeChoice[]): boolean {
  const normalized = (values: readonly RuntimeChoice[]) => [...values]
    .map((value) => `${value.runtimeId}:${value.version.trim()}`).sort();
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ProjectCompositionPanel({ project, onBack, onChanged }: ProjectCompositionPanelProps): React.JSX.Element {
  const isPhone = usePhone();
  const [data, setData] = React.useState<ProjectCompositionResponse | null>(null);
  const [choices, setChoices] = React.useState<RuntimeChoice[]>([]);
  const [savedChoices, setSavedChoices] = React.useState<RuntimeChoice[]>([]);
  const [agentChoices, setAgentChoices] = React.useState<AgentRuntimeChoice[]>([]);
  const [savedAgentChoices, setSavedAgentChoices] = React.useState<AgentRuntimeChoice[]>([]);
  const [forgeKind, setForgeKind] = React.useState('');
  const [savedForgeKind, setSavedForgeKind] = React.useState('');
  const [activationBaseRevision, setActivationBaseRevision] = React.useState<string | null>(null);
  const [identity, setIdentity] = React.useState<GitIdentity>({ name: '', email: '' });
  const [savedIdentity, setSavedIdentity] = React.useState<GitIdentity>({ name: '', email: '' });
  const [busy, setBusy] = React.useState<'load' | 'save' | 'confirm' | 'retry' | 'identity' | null>('load');
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [acknowledgeReview, setAcknowledgeReview] = React.useState(false);
  const [acknowledgeRebuild, setAcknowledgeRebuild] = React.useState(false);
  const [runningChoices, setRunningChoices] = React.useState<RunningProjectInfo[]>([]);

  const load = React.useCallback(async (): Promise<void> => {
    setBusy('load');
    setError(null);
    try {
      const composition = await getProjectComposition(project.id);
      const selected = initialRuntimeChoices(composition);
      const selectedAgents = initialAgentRuntimeChoices(composition);
      const selectedForge = composition.composition.chosen?.forgeKind
        || forgeHintKind(composition.composition.detected?.forgeHint) || '';
      setData(composition);
      setChoices(selected);
      setSavedChoices(selected);
      setAgentChoices(selectedAgents);
      setSavedAgentChoices(selectedAgents);
      setForgeKind(selectedForge);
      setSavedForgeKind(selectedForge);
      setActivationBaseRevision(confirmationBaseRevision(project, composition.composition));
      setAcknowledgeReview(false);
      setAcknowledgeRebuild(false);
      const projectIdentity = await getGitIdentity(project.id).catch(() => null);
      const resolvedIdentity = projectIdentity || (composition.composition.identity
        ? { ...composition.composition.identity, source: composition.composition.identitySource }
        : { name: '', email: '', source: composition.composition.identitySource });
      setIdentity(resolvedIdentity);
      setSavedIdentity(resolvedIdentity);
    } catch (loadError) {
      setError(errorText(loadError, 'Could not load this project recipe.'));
    } finally {
      setBusy(null);
    }
  }, [project.id, project.appliedCompositionRevision, project.compositionRevision, project.state]);

  React.useEffect(() => { void load(); }, [load]);

  const setRuntime = (runtime: RuntimeCatalogItem, checked: boolean): void => {
    setAcknowledgeReview(false);
    if (!checked) {
      setChoices((current) => current.filter((choice) => choice.runtimeId !== runtime.id));
      return;
    }
    const detected = data ? detectionFor(data, runtime.id) : undefined;
    setChoices((current) => [...current, {
      runtimeId: runtime.id,
      version: detected?.selectedVersion || runtime.defaultVersion,
    }]);
  };

  const updateVersion = (runtimeId: string, version: string): void => {
    setAcknowledgeReview(false);
    setChoices((current) => current.map((choice) => choice.runtimeId === runtimeId ? { ...choice, version } : choice));
  };

  const setAgentRuntime = (runtime: AgentRuntimeCatalogItem, checked: boolean): void => {
    setAcknowledgeReview(false);
    if (!checked) {
      setAgentChoices((current) => current.filter((choice) => choice.runtimeId !== runtime.id));
      return;
    }
    setAgentChoices((current) => [...current, {
      runtimeId: runtime.id,
      version: runtime.defaultVersion,
    }]);
  };

  const dirty = !sameChoices(choices, savedChoices)
    || !sameChoices(agentChoices, savedAgentChoices)
    || forgeKind !== savedForgeKind;
  const recipeNeedsSave = dirty || data?.composition.revision == null;
  const invalidVersion = choices.some((choice) => !isConservativeRuntimeVersion(choice.version));
  const failedCount = data?.composition.installations.filter((item) => item.status === 'failed').length || 0;
  const installingCount = data?.composition.installations.filter((item) => item.status === 'installing').length || 0;
  const pendingCount = data?.composition.installations.filter((item) => item.status === 'pending').length || 0;
  const allInstalled = Boolean(data?.composition.installations.length)
    && data?.composition.installations.every((item) => item.status === 'installed') === true;
  const repoHost = repositoryHost(project.repoUrl);
  const missingForgeChoice = Boolean(repoHost && !forgeKind);
  const identityDirty = identity.name !== savedIdentity.name || identity.email !== savedIdentity.email;
  const isRebuild = data ? compositionRequiresRebuild(project, data.composition) : false;
  const isFirstBuild = data ? compositionIsFirstBuild(project, data.composition) : false;
  const appliedRevision = data?.composition.appliedRevision !== undefined
    ? data.composition.appliedRevision
    : project.appliedCompositionRevision;
  const currentRecipeRunning = project.state === 'running'
    && Boolean(data?.composition.revision && data.composition.revision === appliedRevision);
  const stoppableRunningChoices = runningChoices.filter((running) => (
    !running.hasActiveWork && (!running.state || running.state === 'running')
  ));
  const canEditRecipe = !['inspecting', 'building', 'reclaiming', 'blocked'].includes(project.state);
  const confirmationBlocked = busy !== null || !canEditRecipe || currentRecipeRunning || dirty
    || identityDirty || invalidVersion || missingForgeChoice || !data?.composition.revision
    || !identityIsComplete(identity)
    || (isRebuild ? !acknowledgeRebuild : isFirstBuild ? !acknowledgeReview : false);

  const save = async (): Promise<void> => {
    if (!data) return;
    setBusy('save'); setError(null); setNotice(null);
    try {
      const result = await saveProjectComposition(
        project.id,
        data.composition.revision,
        choices.map((choice) => ({ ...choice, version: choice.version.trim() })),
        agentChoices,
        forgeKind || null,
      );
      const next = { ...data, composition: result.composition };
      const selected = initialRuntimeChoices(next);
      setData(next);
      setChoices(selected);
      setSavedChoices(selected);
      const selectedAgents = initialAgentRuntimeChoices(next);
      setAgentChoices(selectedAgents);
      setSavedAgentChoices(selectedAgents);
      setSavedForgeKind(result.composition.chosen?.forgeKind || '');
      setAcknowledgeReview(false);
      setAcknowledgeRebuild(false);
      setNotice('Recipe saved. It will not change the current container until you confirm the build.');
    } catch (saveError) {
      setError(errorText(saveError, 'Could not save this recipe.'));
    } finally { setBusy(null); }
  };

  const confirm = async (stopProjectId?: string): Promise<void> => {
    if (!data?.composition.revision || confirmationBlocked) return;
    setBusy('confirm'); setError(null); setNotice(null);
    try {
      await confirmProjectComposition(
        project.id,
        data.composition.revision,
        activationBaseRevision,
        isRebuild ? acknowledgeRebuild : false,
        stopProjectId,
      );
      setRunningChoices([]);
      setNotice(isRebuild ? 'Rebuild queued after preservation.' : 'Project build queued.');
      onChanged();
    } catch (confirmError) {
      if (confirmError instanceof ApiError && confirmError.status === 409) {
        const body = confirmError.data as { error?: unknown; running?: unknown; composition?: unknown };
        if (body.error === 'run_limit' && Array.isArray(body.running)) {
          setRunningChoices(body.running as RunningProjectInfo[]);
          setError('The running-project limit has been reached. Choose an idle project to stop.');
          setBusy(null);
          return;
        }
        if (body.error === 'source_changed' && body.composition && typeof body.composition === 'object') {
          const refreshed = body.composition as ProjectCompositionResponse['composition'];
          const next = { ...data, composition: refreshed };
          const selected = initialRuntimeChoices(next);
          const selectedForge = refreshed.chosen?.forgeKind || forgeHintKind(refreshed.detected?.forgeHint) || '';
          setData(next);
          setChoices(selected);
          setSavedChoices(selected);
          const selectedAgents = initialAgentRuntimeChoices(next);
          setAgentChoices(selectedAgents);
          setSavedAgentChoices(selectedAgents);
          setForgeKind(selectedForge);
          setSavedForgeKind(selectedForge);
          setActivationBaseRevision(confirmationBaseRevision(project, refreshed));
          setAcknowledgeReview(false);
          setAcknowledgeRebuild(false);
          setError('The repository changed after inspection. Review the refreshed evidence and recipe before building.');
          onChanged();
          return;
        }
      }
      setError(errorText(confirmError, 'Could not start this build.'));
    } finally { setBusy(null); }
  };

  const retry = async (): Promise<void> => {
    if (!data) return;
    setBusy('retry'); setError(null); setNotice(null);
    try {
      const result = await retryProjectComposition(project.id);
      setData({ ...data, composition: { ...data.composition, installations: result.installations } });
      setNotice('Retry started for failed setup items. The project workspace was not rebuilt.');
    } catch (retryError) {
      setError(errorText(retryError, 'Could not retry failed setup.'));
    } finally { setBusy(null); }
  };

  const saveIdentity = async (): Promise<void> => {
    if (!identityIsComplete(identity)) return;
    setBusy('identity'); setError(null); setNotice(null);
    try {
      const saved = await putGitIdentity({ name: identity.name.trim(), email: identity.email.trim() }, project.id);
      setIdentity(saved);
      setSavedIdentity(saved);
      setNotice('Project Git identity saved. It overrides your global identity only here.');
      if (data) setData({ ...data, composition: { ...data.composition, identity: saved, identitySource: 'project' } });
    } catch (identityError) {
      setError(errorText(identityError, 'Could not save the project Git identity.'));
    } finally { setBusy(null); }
  };

  if (busy === 'load' && !data) return (
    <div role="status" style={{ ...panel, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon name="loader-circle" size={14} /> Loading the detected project recipe…
    </div>
  );
  if (!data) return (
    <div>
      <Button autoFocus variant="ghost" size="sm" onClick={onBack}>← Back to projects</Button>
      <p role="alert" style={{ color: 'var(--destructive)' }}>{error || 'This recipe is not available yet.'}</p>
      <Button variant="secondary" onClick={() => void load()}>Try again</Button>
    </div>
  );

  const sourceOid = data.composition.detected?.sourceOid;
  const forgeInstallation = forgeKind ? data.composition.installations.find((item) => (
    item.itemId === forgeToolId(forgeKind) || item.itemId === `forge:${forgeKind}` || item.itemId.endsWith(`:${forgeKind}`)
  )) : undefined;
  const selectedForgeStatus = data.composition.forge?.kind === forgeKind
    ? data.composition.forge
    : null;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <Button autoFocus variant="ghost" size="sm" onClick={onBack}>← Back to projects</Button>
          <h3 style={{ margin: '8px 0 2px', fontSize: 'var(--text-lg)' }}>{project.name} build recipe</h3>
          <span style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
            {sourceOid ? <>Repository snapshot <code>{sourceOid.slice(0, 10)}</code></> : 'No repository snapshot · choose from the same supported catalog'}
          </span>
        </div>
        <Badge variant={failedCount ? 'destructive' : allInstalled ? 'success' : installingCount || pendingCount ? 'warning' : 'outline'}>
          {failedCount
            ? `${failedCount} failed`
            : allInstalled
              ? 'Installed'
              : installingCount
                ? 'Installing'
                : pendingCount
                  ? 'Setup pending'
                  : 'Draft'}
        </Badge>
      </div>

      {error ? <div role="alert" style={{ color: 'var(--destructive)' }}>
        <p style={{ margin: '0 0 6px' }}>{error}</p>
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void load()}>Reload recipe</Button>
      </div> : null}
      {notice ? <p role="status" style={{ color: 'var(--muted-foreground)', margin: 0 }}>{notice}</p> : null}

      <section aria-labelledby="recipe-rail-title" style={{ ...panel, borderTop: '3px solid var(--primary)' }}>
        <h4 id="recipe-rail-title" style={{ margin: '0 0 4px' }}>Detected → Selected → Installed</h4>
        <p style={{ color: 'var(--muted-foreground)', margin: '0 0 12px', fontSize: 'var(--text-sm)' }}>
          Detection is repository evidence, selection is the saved recipe, and installed is what the current container actually has.
        </p>
        {!data.composition.detected?.detectedRuntimes.length ? (
          <p style={{ color: 'var(--muted-foreground)' }}>No runtime markers were found. The full supported catalog is available below.</p>
        ) : null}
        {!isPhone ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(190px, 1.2fr) minmax(0, .8fr)', gap: 16, padding: '0 8px 7px' }}>
            <span style={stageLabel}>Detected</span><span style={stageLabel}>Selected</span><span style={stageLabel}>Installed</span>
          </div>
        ) : null}
        <div style={{ display: 'grid', gap: 6 }}>
          {data.catalog.runtimes.map((runtime) => {
            const detected = detectionFor(data, runtime.id);
            const selected = choices.find((choice) => choice.runtimeId === runtime.id);
            const installed = installationFor(data, runtime.id);
            const cell: React.CSSProperties = { minWidth: 0, padding: isPhone ? '5px 0' : '9px 8px' };
            return (
              <div key={runtime.id} style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(0, 1fr) minmax(190px, 1.2fr) minmax(0, .8fr)', gap: isPhone ? 3 : 16, borderTop: '1px solid var(--border)' }}>
                <div style={cell}>
                  {isPhone ? <div style={stageLabel}>Detected</div> : null}
                  <strong>{runtime.label}</strong>
                  {detected ? (
                    <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 3, fontSize: 'var(--text-xs)' }}>
                      {detected.sources.join(' · ')}{detected.versionHints.length ? ` · ${detected.versionHints.map(runtimeVersionHintLabel).join(', ')}` : ''} · {runtimeVersionSourceLabel(detected.versionSource)}
                    </span>
                  ) : <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 3, fontSize: 'var(--text-xs)' }}>Not detected · default {runtime.defaultVersion}</span>}
                </div>
                <div style={cell}>
                  {isPhone ? <div style={stageLabel}>Selected</div> : null}
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(86px, .6fr)', gap: 8, alignItems: 'center' }}>
                    <Checkbox disabled={!canEditRecipe} checked={Boolean(selected)} onChange={(checked) => setRuntime(runtime, checked)} label={selected ? runtime.label : `Add ${runtime.label}`} />
                    <Input
                      aria-label={`${runtime.label} version`}
                      aria-describedby="runtime-version-help"
                      aria-invalid={Boolean(selected && !isConservativeRuntimeVersion(selected.version))}
                      invalid={Boolean(selected && !isConservativeRuntimeVersion(selected.version))}
                      value={selected?.version || ''}
                      disabled={!selected || !canEditRecipe}
                      placeholder={runtime.defaultVersion}
                      onChange={(event) => updateVersion(runtime.id, event.currentTarget.value)}
                    />
                  </div>
                </div>
                <div style={cell}>
                  {isPhone ? <div style={stageLabel}>Installed</div> : null}
                  {installedStage(installed)}
                </div>
              </div>
            );
          })}
          <div style={{ borderTop: '1px solid var(--border)', padding: '14px 8px 5px' }}>
            <strong>Agent runtimes</strong>
            <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 3, fontSize: 'var(--text-xs)' }}>
              Choose the agent CLIs this container must be able to launch. Their sign-ins, settings and skills live in your persistent home and survive every project rebuild.
            </span>
          </div>
          {(data.catalog.agents || []).map((runtime) => {
            const selected = agentChoices.find((choice) => choice.runtimeId === runtime.id);
            const installed = installationFor(data, runtime.id);
            return (
              <div key={`agent:${runtime.id}`} style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(0, 1fr) minmax(190px, 1.2fr) minmax(0, .8fr)', gap: isPhone ? 3 : 16, borderTop: '1px solid var(--border)' }}>
                <div style={{ minWidth: 0, padding: isPhone ? '5px 0' : '9px 8px' }}>
                  {isPhone ? <div style={stageLabel}>Available</div> : null}
                  <strong>{runtime.label}</strong>
                  <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 3, fontSize: 'var(--text-xs)' }}>
                    <code>{runtime.executable}</code> · pinned {runtime.defaultVersion}
                  </span>
                </div>
                <div style={{ minWidth: 0, padding: isPhone ? '5px 0' : '9px 8px' }}>
                  {isPhone ? <div style={stageLabel}>Selected</div> : null}
                  <Checkbox
                    disabled={!canEditRecipe}
                    checked={Boolean(selected)}
                    onChange={(checked) => setAgentRuntime(runtime, checked)}
                    label={selected ? runtime.label : `Install ${runtime.label}`}
                  />
                  <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 4, fontSize: 'var(--text-xs)' }}>
                    Includes its {runtime.requires === 'node' ? 'Node.js' : 'Python'} install foundation when the project does not already select one.
                  </span>
                </div>
                <div style={{ minWidth: 0, padding: isPhone ? '5px 0' : '9px 8px' }}>
                  {isPhone ? <div style={stageLabel}>Installed</div> : null}
                  {installedStage(installed)}
                </div>
              </div>
            );
          })}
          <p style={{ color: 'var(--muted-foreground)', margin: '7px 8px 12px', fontSize: 'var(--text-xs)' }}>
            Cursor Agent and Antigravity are not managed recipe entries because they do not publish a version-pinned package for this installer. A manual install in your persistent home remains available to every project.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'minmax(0, 1fr) minmax(190px, 1.2fr) minmax(0, .8fr)', gap: isPhone ? 3 : 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ padding: '9px 8px' }}>
              {isPhone ? <div style={stageLabel}>Detected</div> : null}
              <strong>Repository forge</strong>
              <span style={{ display: 'block', color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>{forgeHintLabel(data.composition.detected?.forgeHint) || data.composition.forge?.host || repoHost || 'No repository'}</span>
            </div>
            <div style={{ padding: '9px 8px' }}>
              {isPhone ? <div style={stageLabel}>Selected</div> : null}
              <Select
                aria-label="Forge CLI"
                aria-describedby="forge-choice-help"
                aria-invalid={missingForgeChoice}
                disabled={!canEditRecipe}
                style={missingForgeChoice ? { borderColor: 'var(--destructive)' } : undefined}
                value={forgeKind}
                options={FORGES}
                onChange={(event) => { setAcknowledgeReview(false); setForgeKind(event.currentTarget.value); }}
              />
              <span id="forge-choice-help" role={missingForgeChoice ? 'alert' : undefined} style={{ display: 'block', color: missingForgeChoice ? 'var(--destructive)' : 'var(--muted-foreground)', marginTop: 4, fontSize: 'var(--text-xs)' }}>
                {repoHost ? 'Every repository needs its matching forge choice.' : 'A forge CLI is optional for a project without a repository.'}
              </span>
            </div>
            <div style={{ padding: '9px 8px' }}>
              {isPhone ? <div style={stageLabel}>Installed</div> : null}
              {forgeKind ? <>
                {installedStage(forgeInstallation)}
                {selectedForgeStatus ? <span style={{ display: 'block', marginTop: 5 }}>
                  <Badge variant={!selectedForgeStatus.connected || selectedForgeStatus.validationStatus === 'invalid' ? 'destructive' : selectedForgeStatus.validationStatus === 'valid' ? 'success' : 'warning'}>
                    {!selectedForgeStatus.connected
                      ? `Not connected · ${selectedForgeStatus.host}`
                      : selectedForgeStatus.validationStatus === 'invalid'
                        ? `Credential rejected · ${selectedForgeStatus.host}`
                        : selectedForgeStatus.validationStatus === 'valid'
                          ? `Validated · ${selectedForgeStatus.host}`
                          : `Credential stored, not validated · ${selectedForgeStatus.host}`}
                  </Badge>
                </span> : dirty ? <span style={{ display: 'block', color: 'var(--muted-foreground)', marginTop: 5, fontSize: 'var(--text-xs)' }}>Connection status updates after the recipe is saved.</span> : null}
              </> : <span style={{ color: 'var(--muted-foreground)' }}>Not selected</span>}
            </div>
          </div>
        </div>
        <p id="runtime-version-help" role={invalidVersion ? 'alert' : undefined} style={{ color: invalidVersion ? 'var(--destructive)' : 'var(--muted-foreground)' }}>
          Use a conservative numeric version such as 22, 3.13, or 1.23.4. Tags, ranges, suffixes, and leading zeroes are not accepted.
        </p>
        {!canEditRecipe ? <p role="status" style={{ color: 'var(--muted-foreground)' }}>This recipe is read-only while project lifecycle work is in progress or recovery is blocked.</p> : null}
      </section>

      <section aria-labelledby="project-identity-title" style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <h4 id="project-identity-title" style={{ margin: 0 }}>Git identity for this project</h4>
          <Badge variant={identityIsComplete(identity) && !identityDirty ? 'outline' : 'warning'}>{identityDirty ? 'Unsaved' : data.composition.identitySource || identity.source || 'incomplete'}</Badge>
        </div>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>A project override wins over your global identity. A complete name and email are required for preservation commits.</p>
        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <label><span style={stageLabel}>Name</span><Input aria-label="Project Git name" value={identity.name} onChange={(event) => setIdentity({ ...identity, name: event.currentTarget.value })} /></label>
          <label><span style={stageLabel}>Email</span><Input aria-label="Project Git email" type="email" value={identity.email} onChange={(event) => setIdentity({ ...identity, email: event.currentTarget.value })} /></label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {identityDirty ? <Button variant="ghost" disabled={busy !== null} onClick={() => setIdentity(savedIdentity)}>Revert</Button> : null}
            <Button variant="secondary" disabled={busy !== null || !identityIsComplete(identity) || (!identityDirty && data.composition.identitySource === 'project')} onClick={() => void saveIdentity()}>{busy === 'identity' ? 'Saving override…' : 'Save override'}</Button>
          </div>
        </div>
        {identityDirty ? <p role="status" style={{ color: 'var(--warning)', marginBottom: 0 }}>Save or revert identity changes before building.</p> : null}
      </section>

      <div style={{ ...panel, background: 'var(--muted)' }}>
        <strong>What survives a rebuild</strong>
        <p style={{ margin: '5px 0 0', color: 'var(--muted-foreground)' }}>
          User home: kept · Project setup: kept · Workspace: {project.repoUrl ? 'preserved to Git when possible, then rebuilt' : 'discarded because this project has no repository'}
        </p>
      </div>

      {failedCount ? (
        <div style={{ ...panel, borderColor: 'var(--destructive)' }}>
          <strong>{failedCount} setup {failedCount === 1 ? 'item needs' : 'items need'} attention</strong>
          <p style={{ color: 'var(--muted-foreground)' }}>Retry touches failed items only. It does not preserve, recreate, wipe, or clone the project.</p>
          <Button variant="secondary" disabled={busy !== null || project.state !== 'running'} onClick={() => void retry()}>{busy === 'retry' ? 'Retrying failed setup…' : 'Retry failed setup'}</Button>
          {project.state !== 'running' ? <p style={{ color: 'var(--muted-foreground)', marginBottom: 0 }}>Failed setup can be retried only in the existing running container.</p> : null}
        </div>
      ) : null}

      {isFirstBuild ? (
        <div style={{ ...panel, borderColor: acknowledgeReview ? 'var(--primary)' : 'var(--border)' }}>
          <Checkbox
            checked={acknowledgeReview}
            onChange={setAcknowledgeReview}
            label="I reviewed the repository evidence, selected runtimes and versions, and forge choice for this first build, including the agent CLIs to install."
          />
        </div>
      ) : isRebuild ? (
        <div style={{ ...panel, borderColor: acknowledgeRebuild ? 'var(--warning)' : 'var(--border)' }}>
          <Checkbox
            checked={acknowledgeRebuild}
            onChange={setAcknowledgeRebuild}
            label={project.repoUrl
              ? 'I understand this preserves repository work, keeps user home and project setup, and rebuilds the workspace.'
              : 'I understand this keeps user home and project setup, but permanently discards this project workspace.'}
          />
        </div>
      ) : (
        <div role="status" style={{ ...panel, color: 'var(--muted-foreground)' }}>
          {currentRecipeRunning
            ? 'This exact recipe is already applied to the running project. Save a changed recipe before requesting a rebuild.'
            : 'This exact recipe is already applied. Starting it does not activate a new recipe.'}
        </div>
      )}

      {runningChoices.length ? (
        <div style={panel}>
          <strong>Choose an idle project to stop</strong>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {stoppableRunningChoices.map((running) => (
              <Button key={running.id} variant="secondary" disabled={confirmationBlocked} onClick={() => void confirm(running.id)}>
                Stop {running.name} and {isRebuild ? 'rebuild' : isFirstBuild ? 'build' : 'start'}
              </Button>
            ))}
          </div>
          {!stoppableRunningChoices.length ? <p style={{ color: 'var(--muted-foreground)' }}>No idle running project is available to stop. Close active work or wait for lifecycle work to finish.</p> : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
        <Button variant="secondary" disabled={busy !== null || !canEditRecipe || !recipeNeedsSave || invalidVersion || missingForgeChoice} onClick={() => void save()}>{busy === 'save' ? 'Saving recipe…' : 'Save recipe'}</Button>
        <Button
          variant="primary"
          disabled={confirmationBlocked}
          onClick={() => void confirm()}
        >
          {busy === 'confirm'
            ? (isRebuild ? 'Queuing rebuild…' : 'Queuing build…')
            : currentRecipeRunning
              ? 'Already applied'
              : isRebuild
                ? 'Preserve and rebuild'
                : isFirstBuild
                  ? 'Build project'
                  : 'Start project'}
        </Button>
      </div>
    </div>
  );
}
