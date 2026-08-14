/** Partial class: forge credential bookkeeping and runtime git-identity context. */

import { Project, ConnectedCredential, ProjectStore, ProjectComposition } from '../store.js';
import { FORGE_SCRATCH, ProjectEnvironmentResult } from '../environment.js';
import { CompositionChoice, CompositionRuntimeContext } from './manager-types.js';
import { compositionChoiceFrom } from './manager-helpers.js';
import { ProjectManagerStorage } from './manager-storage.js';

export abstract class ProjectManagerCredentials extends ProjectManagerStorage {
  protected credentialRecordFor(project: Project): ConnectedCredential | null {
    if (!project.repoHost) return null;
    return this.connectedCredentialFor(project.ownerUserId, project.repoHost);
  }

  /**
   * Compatibility seam for pre-composition ProjectStore adapters. Production
   * always supplies the generation-aware accessor; older integrations expose
   * only the token accessor and therefore cannot participate in validation CAS.
   */
  protected connectedCredentialFor(ownerUserId: number, host: string): ConnectedCredential | null {
    const store = this.deps.store as Partial<ProjectStore>;
    if (typeof store.credentialRecordFor === 'function') {
      return store.credentialRecordFor.call(this.deps.store, ownerUserId, host);
    }
    if (typeof store.credentialFor !== 'function') return null;
    const token = store.credentialFor.call(this.deps.store, ownerUserId, host);
    return token ? { token, kind: 'token', revision: 0 } : null;
  }

  protected credentialFor(project: Project): string | null {
    return this.credentialRecordFor(project)?.token || null;
  }

  protected projectMayUseForgeHost(project: Project, ownerUserId: number, host: string): boolean {
    if (project.repoHost === host) return true;
    const revisionIds = new Set([
      project.compositionRevision,
      project.appliedCompositionRevision,
      this.deps.store.getProjectComposition(project.id, ownerUserId)?.id || null,
    ].filter((revision): revision is string => Boolean(revision)));
    for (const revisionId of revisionIds) {
      const composition = this.deps.store.getProjectComposition(project.id, ownerUserId, revisionId);
      if (composition?.forgeHost === host) return true;
    }
    return false;
  }

  protected markCredentialRejected(
    ownerUserId: number,
    host: string,
    credential: ConnectedCredential | null,
  ): void {
    if (!credential) return;
    const setValidation = (this.deps.store as Partial<ProjectStore>).setConnectedHostValidation;
    if (typeof setValidation !== 'function') return;
    setValidation.call(this.deps.store, {
      userId: ownerUserId,
      host,
      kind: credential.kind,
      expectedCredentialRevision: credential.revision,
      status: 'invalid',
      errorCode: 'credential_rejected',
      errorMessage: 'The repository host rejected this credential; replace it to continue',
    });
  }

  protected async scrubForgeCredential(prepared: ProjectEnvironmentResult): Promise<void> {
    await prepared.engine.exec(
      {
        name: prepared.containerName,
        identity: prepared.containerAccess.containerIdentity,
      },
      'rm',
      [
        '-rf', '--',
        `${FORGE_SCRATCH}/home`,
        `${FORGE_SCRATCH}/xdg`,
        `${FORGE_SCRATCH}/gh`,
        `${FORGE_SCRATCH}/glab`,
        `${FORGE_SCRATCH}/tea`,
      ],
    );
  }

  protected async refreshHostCredentialsLocked(
    ownerUserId: number,
    host: string,
    rematerialize: boolean,
  ): Promise<void> {
    // The owner/host credential lock is the generation barrier. A project that
    // has not passed its credential section cannot materialize the old token;
    // one that passed it before this replacement may still be `building` and
    // must be included even if it was created after the lifecycle snapshot.
    // Exact-identity inspection/scrubbing fails closed if that runtime changes.
    const affected = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host));
    const running: Array<{ project: Project; prepared: ProjectEnvironmentResult }> = [];
    let scrubFailed = false;

    for (const project of affected) {
      try {
        // Only a physically executing runtime can consume its memory-backed
        // login. Stopped runtimes are scrubbed before any later authentication.
        if (await this.projects.status(project) !== 'running') continue;
        const prepared = await this.projects.existing(project, this.owner(ownerUserId));
        if (!prepared) throw new Error('running project ownership could not be verified');
        running.push({ project, prepared });
      } catch {
        // Keep inspecting the other lifecycle-locked projects. One unavailable
        // engine must not leave an otherwise reachable old token untouched.
        scrubFailed = true;
      }
    }

    // Scrub every verified runtime before attempting any login. If one scrub
    // fails, still try all the others, then fail closed without materializing a
    // mix of old and new credentials across the owner.
    for (const { prepared } of running) {
      try {
        await this.scrubForgeCredential(prepared);
      } catch {
        scrubFailed = true;
      }
    }
    if (scrubFailed) throw new Error('Could not clear every live forge credential');
    if (!rematerialize || !this.deps.compositionRuntime?.refreshForgeCredential) return;

    let refreshFailed = false;
    for (const { project, prepared } of running) {
      try {
        const revisionIds = [project.compositionRevision, project.appliedCompositionRevision]
          .filter((revision, index, all): revision is string => Boolean(revision) && all.indexOf(revision) === index);
        for (const revisionId of revisionIds) {
          const composition = this.deps.store.getProjectComposition(project.id, ownerUserId, revisionId);
          const chosen = compositionChoiceFrom(composition?.chosen);
          if (!composition || composition.forgeHost !== host || !chosen?.forgeKind) continue;
          await this.deps.compositionRuntime.refreshForgeCredential(
            this.runtimeContext(project, composition, chosen, prepared),
          );
          break;
        }
      } catch {
        // Old material is already gone everywhere. Continue so a failure in one
        // project does not unnecessarily leave another without the new login.
        refreshFailed = true;
      }
    }
    if (refreshFailed) throw new Error('Could not refresh every live forge credential');
  }

  protected runtimeContext(
    project: Project,
    composition: ProjectComposition,
    chosen: CompositionChoice,
    prepared: ProjectEnvironmentResult,
  ): CompositionRuntimeContext {
    let providerDefault: { name: string; email: string } | null = null;
    try { providerDefault = this.deps.authorFor(project.ownerUserId); } catch { /* Reported as incomplete below. */ }
    const global = this.deps.store.resolveGitIdentity({
      userId: project.ownerUserId,
      providerDefault,
    });
    const resolved = this.deps.store.resolveGitIdentity({
      userId: project.ownerUserId,
      projectId: project.id,
      providerDefault,
    });
    if (!global.identity || !resolved.identity) throw new Error('Git identity is incomplete');
    const projectIdentity = this.deps.store.getGitIdentity(project.ownerUserId, project.id);
    const connectedCredential = composition.forgeHost
      ? this.connectedCredentialFor(project.ownerUserId, composition.forgeHost)
      : null;
    return {
      project,
      composition,
      chosen,
      containerName: prepared.containerName,
      containerIdentity: prepared.containerAccess.containerIdentity,
      engine: prepared.engine,
      ownerHomeHost: prepared.environment.homeDir,
      ownerHomeContainer: prepared.environment.containerHome,
      projectOverlayHost: this.projects.overlayPath(project),
      checkoutContainerPath: this.projects.checkoutContainerPath(project),
      credential: connectedCredential?.token || null,
      credentialKind: connectedCredential?.kind || null,
      credentialRevision: connectedCredential?.revision ?? null,
      identity: { name: resolved.identity.name, email: resolved.identity.email },
      globalIdentity: { name: global.identity.name, email: global.identity.email },
      projectIdentity: projectIdentity
        ? { name: projectIdentity.name, email: projectIdentity.email }
        : null,
    };
  }
}
