/** Partial class: composition drafts, identity resolution and repository inspection. */

import { Project, ProjectComposition, ProjectStore, ProjectState } from '../store.js';
import { RepositoryInspectionResult, RepositoryInspectionError } from '../../composition/repository-inspector.js';
import { COMPOSITION_CATALOG_VERSION } from '../../composition/catalog.js';
import { CompositionChoice, CompositionView } from './manager-types.js';
import {
  compositionChoiceFrom,
  emptyInspection,
  installationIds,
  inspectionFrom,
  knownPublicForge,
  safeInspectionMessage,
} from './manager-helpers.js';
import { ProjectManagerCredentials } from './manager-credential.js';

export abstract class ProjectManagerCompositionCore extends ProjectManagerCredentials {
  protected resolvedIdentity(project: Project): ReturnType<ProjectStore['resolveGitIdentity']> {
    let providerDefault: { name: string; email: string } | null = null;
    try { providerDefault = this.deps.authorFor(project.ownerUserId); } catch { /* Deleted owners remain incomplete. */ }
    const resolveIdentity = (this.deps.store as Partial<ProjectStore>).resolveGitIdentity;
    if (typeof resolveIdentity === 'function') {
      return resolveIdentity.call(this.deps.store, {
        userId: project.ownerUserId,
        projectId: project.id,
        providerDefault,
      });
    }
    return providerDefault
      ? { identity: { ...providerDefault, source: 'provider' }, source: 'provider' }
      : { identity: null, source: 'incomplete' };
  }

  /** The same project-aware resolver feeds both runtime git and preservation. */
  protected preservationAuthor(project: Project): { name: string; email: string } {
    const resolved = this.resolvedIdentity(project);
    if (!resolved.identity) throw new Error('Git identity is incomplete');
    return { name: resolved.identity.name, email: resolved.identity.email };
  }

  protected compositionView(project: Project): CompositionView {
    const latest = this.deps.store.getProjectComposition(project.id, project.ownerUserId);
    const resolved = this.resolvedIdentity(project);
    const chosen = compositionChoiceFrom(latest?.chosen);
    const host = latest?.forgeHost || project.repoHost;
    const connectedHost = host
      ? this.deps.store.listConnectedHosts(project.ownerUserId).find((candidate) => candidate.host === host)
      : null;
    return {
      revision: latest?.id || null,
      activeRevision: project.compositionRevision,
      appliedRevision: project.appliedCompositionRevision,
      detected: inspectionFrom(latest?.detected),
      chosen,
      installations: latest
        ? this.deps.store.listCompositionInstallations(latest.id, project.ownerUserId)
        : [],
      identity: resolved.identity
        ? { name: resolved.identity.name, email: resolved.identity.email }
        : null,
      identitySource: resolved.source,
      forge: host && latest?.forgeKind
        ? {
            kind: latest.forgeKind,
            host,
            connected: Boolean(connectedHost)
              && connectedHost?.validationStatus !== 'invalid'
              && (!connectedHost?.expiresAt
                || (Number.isFinite(Date.parse(connectedHost.expiresAt))
                  && Date.parse(connectedHost.expiresAt) > this.now().getTime())),
            validationStatus: connectedHost?.validationStatus || null,
          }
        : null,
    };
  }

  protected saveDetectedDraft(
    project: Project,
    detected: RepositoryInspectionResult | null,
    rememberedChoice?: CompositionChoice,
  ): ProjectComposition | null {
    const runtimes = rememberedChoice?.runtimes || detected?.detectedRuntimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      version: runtime.selectedVersion,
    })) || [];
    const forgeKind = rememberedChoice?.forgeKind
      || detected?.forgeHint?.kind
      || knownPublicForge(project.repoHost);
    const choice: CompositionChoice = {
      runtimes: runtimes.map((runtime) => ({ ...runtime })),
      agents: rememberedChoice?.agents?.map((agent) => ({ ...agent })) || [],
      forgeKind,
    };
    return this.deps.store.saveCompositionDraft({
      projectId: project.id,
      userId: project.ownerUserId,
      catalogVersion: detected?.catalogVersion || COMPOSITION_CATALOG_VERSION,
      detected: detected || emptyInspection(),
      chosen: choice,
      sourceOid: detected?.sourceOid,
      sourceRef: detected?.sourceRef,
      forgeKind,
      forgeHost: detected?.forgeHint?.host || project.repoHost,
      installations: installationIds(choice, forgeKind).map((itemId) => ({ itemId })),
    });
  }

  /** Persist and surface the exact collision-resolved ref a user can recover. */
  protected recordPreservation(projectId: string, result: { branch: string; commit: string }): void {
    this.deps.store.recordPreservation(projectId, result.branch, result.commit);
    const project = this.deps.store.getProject(projectId);
    if (!project) return;
    this.event(project, {
      t: 'preserve',
      branch: result.branch,
      commit: result.commit,
      message: `Preserved work on ${result.branch}`,
    });
  }

  protected trackInspection(
    ownerUserId: number,
    projectId: string,
    keepRuntimeActive = false,
    preserveChoice = false,
  ): void {
    if (this.inspections.has(projectId)) return;
    const task = this.exclusiveFor(
      [projectId],
      () => this.inspectProject(ownerUserId, projectId, keepRuntimeActive, preserveChoice),
    );
    this.inspections.set(projectId, task);
    void task.finally(() => {
      if (this.inspections.get(projectId) === task) this.inspections.delete(projectId);
    }).catch(() => undefined);
  }

  protected async inspectProject(
    ownerUserId: number,
    projectId: string,
    keepRuntimeActive = false,
    preserveChoice = false,
  ): Promise<void> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project || !project.repoUrl) return;
    if (!this.deps.repositoryInspector) {
      this.deps.store.setState(project.id, 'failed', 'Repository inspection is unavailable');
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'error', state: 'failed', message: 'Repository inspection is unavailable',
      });
      return;
    }
    try {
      const result = await this.exclusiveCredentialFor(ownerUserId, project.repoHost, async () => {
        const credential = this.credentialRecordFor(project);
        try {
          return await this.deps.repositoryInspector!.inspect({
            repoUrl: project.repoUrl!,
            credential: credential?.token || null,
          });
        } catch (error) {
          if (error instanceof RepositoryInspectionError
            && error.code === 'credential_required'
            && project.repoHost) {
            this.markCredentialRejected(ownerUserId, project.repoHost, credential);
          }
          throw error;
        }
      });
      const previousChoice = preserveChoice
        ? compositionChoiceFrom(
            this.deps.store.getProjectComposition(project.id, ownerUserId)?.chosen,
          )
        : null;
      if (!this.saveDetectedDraft(project, result, previousChoice || undefined)) {
        throw new Error('Could not save the inspected build recipe');
      }
      const nextState: ProjectState = keepRuntimeActive ? 'running' : 'composition_pending';
      const detail = keepRuntimeActive
        ? 'A refreshed build recipe is ready; the current container remains active until you confirm it'
        : 'Review the detected build recipe';
      this.deps.store.setState(project.id, nextState, detail);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'state', state: nextState, percent: 100,
        message: keepRuntimeActive
          ? 'Refreshed build recipe is ready; the current container is unchanged'
          : 'Build recipe is ready for review',
      });
    } catch (error) {
      const message = safeInspectionMessage(error);
      const state: ProjectState = keepRuntimeActive
        ? 'running'
        : error instanceof RepositoryInspectionError
          && ['repository_unavailable', 'timed_out'].includes(error.code)
          ? 'unavailable'
          : 'failed';
      this.deps.store.setState(project.id, state, message);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'error', state, message,
      });
    }
  }
}
