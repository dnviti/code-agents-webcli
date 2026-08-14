/** Partial class: composition review API and host credential synchronization. */

import { Project, CompositionInstallation } from '../store.js';
import {
  CompositionConfirmResult,
  CompositionCreateResult,
  CompositionReadResult,
  CompositionRetryResult,
  CompositionSaveResult,
  SimpleResult,
} from './manager-types.js';
import {
  compositionChoiceFrom,
  emptyInspection,
  installationIds,
  inspectionFrom,
  knownPublicForge,
  safeInspectionMessage,
  validateCompositionChoice,
} from './manager-helpers.js';
import { COMPOSITION_CATALOG_VERSION } from '../../composition/catalog.js';
import { RepositoryInspectionError, RepositoryInspectionResult } from '../../composition/repository-inspector.js';
import { ProjectManagerLifecycle } from './manager-lifecycle.js';

export abstract class ProjectManagerComposition extends ProjectManagerLifecycle {
  /**
   * Stage a project for composition review. Repository inspection is detached
   * from the request, but remains tracked for orderly shutdown. Crucially this
   * path does not ask an environment engine to create or start anything.
   */
  createForComposition(
    ownerUserId: number,
    input: { name: string; repoUrl?: string | null; local?: boolean },
  ): Promise<CompositionCreateResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', message: 'Project manager is shutting down' });
    }
    const task = this.createForCompositionActive(ownerUserId, input);
    this.trackCreation(task);
    return task;
  }

  protected async createForCompositionActive(
    ownerUserId: number,
    input: { name: string; repoUrl?: string | null; local?: boolean },
  ): Promise<CompositionCreateResult> {
    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'validation', message: 'Project name is required' };
    const repoUrl = input.repoUrl?.trim() || null;
    let targetId: string | null;
    let tierId: string | null;
    const placement = input.local
      ? { kind: 'host' as const }
      : this.deps.environments.newProjectPlacement();
    const executionKind = placement.kind;
    if (placement.kind === 'host') {
      targetId = null;
      tierId = null;
    } else {
      targetId = placement.target.key === 'legacy' ? null : placement.target.key;
      tierId = this.deps.environments.intendedTierOnTarget(ownerUserId, targetId)?.id || null;
    }

    let host: string | null = null;
    if (repoUrl) {
      if (!this.deps.repositoryInspector) {
        return { ok: false, reason: 'validation', message: 'Repository inspection is unavailable' };
      }
      if (!repoUrl.toLowerCase().startsWith('https://')) {
        return { ok: false, reason: 'validation', message: 'Repository inspection requires HTTPS' };
      }
      let access = await this.preflight(repoUrl);
      if (!access.ok && access.reason === 'credential_required' && access.host) {
        const credentialHost = access.host;
        access = await this.exclusiveCredentialFor(ownerUserId, credentialHost, async () => {
          const credential = this.connectedCredentialFor(ownerUserId, credentialHost);
          if (!credential) return access;
          const checked = await this.preflight(repoUrl, credential.token);
          if (!checked.ok && checked.reason === 'credential_required') {
            this.markCredentialRejected(ownerUserId, credentialHost, credential);
          }
          return checked;
        });
      }
      if (!access.ok) {
        if (access.reason === 'credential_required' && access.host) {
          return { ok: false, reason: 'credential_required', host: access.host };
        }
        if (access.reason === 'validation') {
          return { ok: false, reason: 'validation', message: access.message };
        }
        return { ok: false, reason: 'repo_unreachable', message: access.message };
      }
      host = access.host;
    }

    const project = this.deps.store.createProject({
      ownerUserId,
      name,
      repoUrl,
      repoHost: host,
      targetId,
      executionKind,
      tierId,
      initialState: repoUrl ? 'inspecting' : 'composition_pending',
    });
    this.deps.store.resetBuildLog(project.id);
    if (repoUrl) {
      this.event(project, {
        t: 'state', state: 'inspecting', percent: 0, message: 'Inspecting repository without executing its code',
      });
      this.trackInspection(ownerUserId, project.id);
    } else {
      const draft = this.saveDetectedDraft(project, null);
      if (!draft) {
        this.deps.store.setState(project.id, 'failed', 'Could not create the initial build recipe');
      } else {
        this.deps.store.setState(project.id, 'composition_pending', 'Choose the tools for this project');
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'state', state: 'composition_pending', percent: 100, message: 'Build recipe is ready for review',
        });
      }
    }
    return { ok: true, project: this.deps.store.getProject(project.id) || project };
  }

  getComposition(ownerUserId: number, projectId: string): CompositionReadResult {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    return { ok: true, project, composition: this.compositionView(project) };
  }

  saveComposition(
    ownerUserId: number,
    projectId: string,
    input: { expectedRevision: string | null; runtimes: Array<{ runtimeId: string; version: string }>; agents?: Array<{ runtimeId: string; version: string }>; forgeKind?: string | null },
  ): Promise<CompositionSaveResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'invalid_state', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor([projectId], async () => {
      const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (['inspecting', 'building', 'reclaiming', 'blocked'].includes(project.state)) {
        return { ok: false, reason: 'invalid_state', detail: 'Project composition cannot be edited in its current state' };
      }
      const previous = this.deps.store.getProjectComposition(project.id, ownerUserId);
      if ((previous?.id || null) !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', detail: 'The build recipe changed in another request' };
      }
      const chosen = validateCompositionChoice(input);
      if (!chosen.ok) return chosen;
      const detected = inspectionFrom(previous?.detected);
      const forgeHost = previous?.forgeHost || project.repoHost;
      if (forgeHost && !chosen.choice.forgeKind && !knownPublicForge(forgeHost)) {
        return { ok: false, reason: 'validation', detail: 'Choose the forge used by this repository host' };
      }
      const knownForge = knownPublicForge(forgeHost);
      if (knownForge && chosen.choice.forgeKind && chosen.choice.forgeKind !== knownForge) {
        return { ok: false, reason: 'validation', detail: `The forge for ${forgeHost} is ${knownForge}` };
      }
      const forgeKind = chosen.choice.forgeKind || knownForge;
      const draft = this.deps.store.saveCompositionDraft({
        projectId: project.id,
        userId: ownerUserId,
        catalogVersion: previous?.catalogVersion || COMPOSITION_CATALOG_VERSION,
        detected: detected || emptyInspection(),
        chosen: { ...chosen.choice, forgeKind },
        sourceOid: previous?.sourceOid,
        sourceRef: previous?.sourceRef,
        forgeKind,
        forgeHost,
        installations: installationIds(chosen.choice, forgeKind).map((itemId) => ({ itemId })),
      });
      if (!draft) return { ok: false, reason: 'not_found' };
      if (project.state === 'composition_pending') {
        this.deps.store.setState(project.id, 'composition_pending', 'Build recipe saved; confirm it to build');
      }
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true, composition: this.compositionView(this.deps.store.getProject(project.id) as Project) };
    });
  }

  confirmComposition(
    ownerUserId: number,
    projectId: string,
    input: { revision: string; expectedRevision: string | null; acknowledgeRebuild: boolean; stopProjectId?: string },
  ): Promise<CompositionConfirmResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor(
      [projectId, ...(input.stopProjectId ? [input.stopProjectId] : [])],
      () => this.confirmCompositionLocked(ownerUserId, projectId, input),
    );
  }

  protected async confirmCompositionLocked(
    ownerUserId: number,
    projectId: string,
    input: { revision: string; expectedRevision: string | null; acknowledgeRebuild: boolean; stopProjectId?: string },
  ): Promise<CompositionConfirmResult> {
    let project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (['inspecting', 'building', 'reclaiming'].includes(project.state)) {
      return { ok: false, reason: 'invalid_state', detail: 'Project lifecycle work is still in progress' };
    }
    if (project.state === 'blocked') {
      return { ok: false, reason: 'blocked', detail: project.stateDetail || undefined };
    }
    const revision = this.deps.store.getCompositionForUser(input.revision, ownerUserId);
    if (!revision || revision.projectId !== project.id) return { ok: false, reason: 'not_found' };
    if (project.compositionRevision !== input.expectedRevision) {
      return { ok: false, reason: 'conflict', detail: 'The active build recipe changed in another request' };
    }
    const latest = this.deps.store.getProjectComposition(project.id, ownerUserId);
    if (latest?.id !== revision.id) {
      return { ok: false, reason: 'conflict', detail: 'A newer build recipe is available' };
    }
    // Confirmation is idempotent once this exact recipe is already running.
    // In particular, never relabel an existing live runtime as stopped and
    // enqueue a second build around it.
    if (project.state === 'running'
      && project.compositionRevision === revision.id
      && project.appliedCompositionRevision === revision.id) {
      return { ok: true, state: 'running' };
    }
    if (this.hasActiveWork(project.id)) {
      return { ok: false, reason: 'invalid_state', detail: 'Project has active work; close it before rebuilding' };
    }
    const chosen = compositionChoiceFrom(revision.chosen);
    if (!chosen) return { ok: false, reason: 'invalid_state', detail: 'The saved build recipe is invalid' };
    const identity = this.resolvedIdentity(project);
    if (!identity.identity) {
      return { ok: false, reason: 'identity_required', detail: 'Set a valid Git name and email before building' };
    }

    if (project.repoUrl && revision.sourceOid) {
      if (!this.deps.repositoryInspector) {
        return { ok: false, reason: 'invalid_state', detail: 'Repository inspection is unavailable' };
      }
      let current: RepositoryInspectionResult;
      const inspectionProject = project;
      try {
        current = await this.exclusiveCredentialFor(ownerUserId, inspectionProject.repoHost, async () => {
          const credential = this.credentialRecordFor(inspectionProject);
          try {
            return await this.deps.repositoryInspector!.inspect({
              repoUrl: inspectionProject.repoUrl!,
              credential: credential?.token || null,
            });
          } catch (error) {
            if (error instanceof RepositoryInspectionError
              && error.code === 'credential_required'
              && inspectionProject.repoHost) {
              this.markCredentialRejected(ownerUserId, inspectionProject.repoHost, credential);
            }
            throw error;
          }
        });
      } catch (error) {
        return { ok: false, reason: 'invalid_state', detail: safeInspectionMessage(error) };
      }
      if (current.sourceOid !== revision.sourceOid) {
        this.saveDetectedDraft(project, current, chosen);
        if (project.state !== 'running') {
          this.deps.store.setState(project.id, 'composition_pending', 'Repository changed; review the refreshed build recipe');
        } else {
          this.deps.store.setState(project.id, 'running', 'Repository changed; the current container remains active until the refreshed recipe is confirmed');
        }
        project = this.deps.store.getProject(project.id) as Project;
        this.event(project, {
          t: 'state', state: project.state, message: 'Repository changed after inspection; review the refreshed build recipe',
        });
        return {
          ok: false,
          reason: 'source_changed',
          detail: 'Repository changed after inspection; review the refreshed build recipe',
          composition: this.compositionView(project),
        };
      }
    }

    const alreadyBuilt = project.state !== 'composition_pending';
    if (alreadyBuilt && revision.id !== project.appliedCompositionRevision && !input.acknowledgeRebuild) {
      return { ok: false, reason: 'invalid_state', detail: 'Confirm that changing this recipe rebuilds the project container' };
    }
    if (alreadyBuilt && revision.id !== project.appliedCompositionRevision) {
      const reclaimed = await this.reclaim(project, false);
      if (!reclaimed.ok) {
        return { ok: false, reason: reclaimed.reason, detail: reclaimed.detail };
      }
      // Reclaim has already preserved and removed the old workspace. The next
      // build should create directly around that empty root, not repeat it.
      this.deps.store.setRebuildRequired(project.id, false);
      project = this.deps.store.getProject(project.id) as Project;
    }
    const started = await this.startLocked(ownerUserId, project.id, {
      stopProjectId: input.stopProjectId,
      fromStates: project.state === 'composition_pending'
        ? ['composition_pending']
        : ['stopped', 'failed', 'unavailable'],
      activateComposition: {
        revision: revision.id,
        expectedCurrentRevision: input.expectedRevision,
      },
    });
    if (!started.ok) return started;
    return started;
  }

  async reinspectComposition(ownerUserId: number, projectId: string): Promise<CompositionReadResult> {
    if (this.shuttingDown) return { ok: false, reason: 'not_found' };
    const existingTask = this.inspections.get(projectId);
    if (existingTask) return { ok: false, reason: 'not_found' };

    // Admission, the state decision, and the final draft write all stay behind
    // the same lifecycle lock. A confirm/build queued on either side therefore
    // cannot be relabelled by a stale `keepRuntimeActive` snapshot.
    let resolveAdmission!: (admitted: boolean) => void;
    let admissionSettled = false;
    const admission = new Promise<boolean>((resolve) => { resolveAdmission = resolve; });
    const settleAdmission = (admitted: boolean): void => {
      if (admissionSettled) return;
      admissionSettled = true;
      resolveAdmission(admitted);
    };
    const task = this.exclusiveFor([projectId], async (): Promise<void> => {
      try {
        const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
        if (!project?.repoUrl || ['inspecting', 'building', 'reclaiming'].includes(project.state)) return;
        const keepRuntimeActive = project.state === 'running';
        if (keepRuntimeActive) {
          this.event(project, {
            t: 'step', state: 'running', step: 'inspection', percent: 0,
            message: 'Refreshing build recipe while the current container stays active',
          });
        } else {
          this.deps.store.setState(project.id, 'inspecting', 'Refreshing repository inspection');
          this.deps.store.resetBuildLog(project.id);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'state', state: 'inspecting', percent: 0, message: 'Refreshing build recipe',
          });
        }
        settleAdmission(true);
        await this.inspectProject(ownerUserId, project.id, keepRuntimeActive, true);
      } finally {
        settleAdmission(false);
      }
    });
    this.inspections.set(projectId, task);
    void task.finally(() => {
      if (this.inspections.get(projectId) === task) this.inspections.delete(projectId);
    }).catch(() => undefined);
    if (!(await admission)) return { ok: false, reason: 'not_found' };
    const refreshed = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!refreshed) return { ok: false, reason: 'not_found' };
    return { ok: true, project: refreshed, composition: this.compositionView(refreshed) };
  }

  retryComposition(ownerUserId: number, projectId: string): Promise<CompositionRetryResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor([projectId], async () => {
      const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running' || !project.compositionRevision || !this.deps.compositionRuntime) {
        return { ok: false, reason: 'invalid_state', detail: 'Only a running composed project can retry failed tools' };
      }
      const composition = this.deps.store.getProjectComposition(
        project.id,
        ownerUserId,
        project.compositionRevision,
      );
      const chosen = compositionChoiceFrom(composition?.chosen);
      if (!composition || !chosen) {
        return { ok: false, reason: 'invalid_state', detail: 'Active build recipe is unavailable' };
      }
      const failed = this.deps.store.listCompositionInstallations(composition.id, ownerUserId)
        .filter((item) => item.status === 'failed');
      if (!failed.length) return { ok: true, installations: [] };
      let result: { installations: CompositionInstallation[] };
      try {
        const prepared = await this.projects.existing(project, this.owner(ownerUserId));
        if (!prepared) {
          return { ok: false, reason: 'invalid_state', detail: 'The existing project container is unavailable; rebuild it instead' };
        }
        result = await this.exclusiveCredentialFor(
          ownerUserId,
          composition.forgeHost,
          () => this.deps.compositionRuntime!.retryFailed(
            this.runtimeContext(project, composition, chosen, prepared),
          ),
        );
      } catch {
        const detail = 'Failed setup could not be retried in the existing project container';
        this.deps.store.setState(project.id, 'running', detail);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'partial_install', state: 'running', message: detail,
        });
        return { ok: false, reason: 'invalid_state', detail };
      }
      const stillFailed = result.installations.filter((item) => item.status === 'failed');
      if (stillFailed.length) {
        this.event(project, {
          t: 'partial_install',
          state: 'running',
          message: `Some tools still need attention: ${stillFailed.map((item) => item.itemId).join(', ')}`,
        });
      } else {
        this.deps.store.setState(project.id, 'running');
        this.event(project, {
          t: 'progress', state: 'running', percent: 100, message: 'All selected tools are installed',
        });
      }
      return { ok: true, installations: result.installations };
    });
  }

  /**
   * Keep an encrypted credential replacement and every live tmpfs copy in one
   * generation-ordered critical section. Routes supply only the storage and
   * validation mutation; lifecycle ownership remains here.
   */
  synchronizeHostCredentialReplacement<T>(
    ownerUserId: number,
    hostInput: string,
    mutation: () => Promise<T> | T,
  ): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Project manager is shutting down'));
    }
    const host = hostInput.trim().toLowerCase();
    const projectIds = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host))
      .map((project) => project.id);
    return this.exclusiveFor(projectIds, () =>
      this.exclusiveCredentialFor(ownerUserId, host, async () => {
        const result = await mutation();
        await this.refreshHostCredentialsLocked(ownerUserId, host, true);
        return result;
      }));
  }

  /** Remove live tmpfs copies and their encrypted source as one host operation. */
  disconnectHostCredentials(ownerUserId: number, hostInput: string): Promise<SimpleResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    const host = hostInput.trim().toLowerCase();
    const projectIds = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host))
      .map((project) => project.id);
    return this.exclusiveFor(projectIds, () =>
      this.exclusiveCredentialFor(ownerUserId, host, async (): Promise<SimpleResult> => {
        if (!this.deps.store.listConnectedHosts(ownerUserId).some((entry) => entry.host === host)) {
          return { ok: false, reason: 'not_found' };
        }
        try {
          await this.refreshHostCredentialsLocked(ownerUserId, host, false);
        } catch {
          return {
            ok: false,
            reason: 'invalid_state',
            detail: 'Could not clear this live forge login; stop affected projects and try again',
          };
        }
        return this.deps.store.deleteConnectedHost(ownerUserId, host)
          ? { ok: true }
          : { ok: false, reason: 'not_found' };
      }));
  }
}
