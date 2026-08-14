import fs from 'node:fs';
import path from 'node:path';
import {
  closeWorkspaceSessionDirectoryLease,
  ensureWorkspaceSessionDirectory,
  workspaceSessionAccessDirectory,
  workspaceSessionDirectory,
  workspaceSessionFileParentLease,
  type WorkspaceSessionIdentity,
} from '../workspace-session-storage.js';
import { recoverMigrationWorkspaceCwdRetirement } from '../workspace-cwd-helper.js';
import {
  MARKER_FILE,
  MAX_MIGRATION_MARKER_ARTIFACTS,
  SAFE_COMPONENT,
  blockedArtifact,
  lstatOrNull,
  migrationReason,
  safeComponent,
  sameFingerprint,
} from './migrator-core.js';
import type {
  ArtifactPaths,
  BinaryArtifactPlan,
  Fingerprint,
  LegacyArtifactBlockReason,
  LegacySessionArtifact,
  LegacySessionArtifactMigrationResult,
  LegacySessionMigrationRef,
  MigrationMarker,
  PinnedFixedArtifactPlan,
  PreparedArtifact,
  WorkspaceSessionArtifactMigratorHooks,
  WorkspaceSessionArtifactMigratorOptions,
} from './migrator-core.js';
import {
  fingerprintFile,
  fingerprintPublishedFile,
  leaseAwareFileStatOrNull,
} from './migrator-fs.js';
import {
  assertSafeDirectoryTree,
  pinFixedArtifactDefinitions,
  validateLegacyRoot,
} from './migrator-leases.js';
import {
  commitPreparedSources,
  ensureBackup,
  recoverBackup,
  recoverLegacyRetirement,
  restorePreparedSources,
  unlinkVerifiedLegacyFile,
} from './migrator-recovery.js';
import {
  alignCompletedBinaryDefinitions,
  artifactDefinitions,
  buildBinaryArtifactPlan,
  overallStatus,
} from './migrator-binary.js';
import {
  blockedCutoverEntries,
  markerFromPrepared,
  markerPath,
  prepareArtifact,
  readMarker,
  removeMarker,
  writeMarker,
} from './migrator-plan.js';

/**
 * Per-session, restartable migration of legacy file artefacts.
 *
 * This service intentionally does not migrate SQLite rows and does not decide
 * a session's workspace. The caller must resolve and authorise that immutable
 * scope first, serialise live store activity for the session, and only mark its
 * database import complete when this result is `complete`.
 */
export class WorkspaceSessionArtifactMigrator {
  readonly legacyStorageDir: string;
  private readonly queues = new Map<string, Promise<LegacySessionArtifactMigrationResult>>();
  private readonly hooks?: WorkspaceSessionArtifactMigratorHooks;

  constructor(options: WorkspaceSessionArtifactMigratorOptions) {
    this.legacyStorageDir = path.resolve(options.legacyStorageDir);
    this.hooks = options.hooks;
  }

  migrate(ref: LegacySessionMigrationRef): Promise<LegacySessionArtifactMigrationResult> {
    const queueKey = `${ref.storageRoot ?? ref.storageScope?.workspaceRoot ?? ''}\0${ref.ownerKey ?? ref.storageScope?.ownerKey ?? ''}\0${ref.id}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve(null);
    const run = async (): Promise<LegacySessionArtifactMigrationResult> => {
      try {
        return await this.migrateNow(ref);
      } finally {
        try { await closeWorkspaceSessionDirectoryLease(ref); } catch { /* Invalid refs were already blocked. */ }
      }
    };
    const next = previous.then(run, run);
    this.queues.set(queueKey, next);
    void next.finally(() => {
      if (this.queues.get(queueKey) === next) this.queues.delete(queueKey);
    }).catch(() => undefined);
    return next;
  }

  /**
   * Drop rollback copies only after the SQLite row/usage cutover succeeded.
   * Keeping them through that second verification is what makes migration
   * atomic across the file archive and the separate installation database.
   */
  async confirm(ref: LegacySessionMigrationRef): Promise<void> {
    const id = safeComponent(ref.id, 'session id');
    if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) {
      throw Object.assign(new Error('Unsafe owner id while confirming migration'), {
        migrationReason: 'unsafe_source',
      });
    }
    const ownerKey = safeComponent(
      ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
      'owner key',
    );
    const canonicalTarget = workspaceSessionDirectory(ref);
    if (!canonicalTarget) {
      throw Object.assign(new Error('Workspace target is unavailable while confirming migration'), {
        migrationReason: 'unsafe_workspace_storage',
      });
    }
    const targetDir = workspaceSessionAccessDirectory(ref);
    let binaryPlan: BinaryArtifactPlan | null = null;
    let fixedPlan: PinnedFixedArtifactPlan | null = null;
    try {
      const targetLease = targetDir
        ? workspaceSessionFileParentLease(path.join(targetDir, MARKER_FILE))
        : null;
      if (!targetDir || !targetLease || targetLease.canonicalPath !== canonicalTarget) {
        throw Object.assign(new Error('Workspace target is unavailable while confirming migration'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      targetLease.verify();
      const markerEnvelope = await readMarker(targetDir, ownerKey, id, ref.ownerUserId);
      if (!markerEnvelope || markerEnvelope.phase !== 'complete') return;

      const rawDefinitions = artifactDefinitions(
        this.legacyStorageDir,
        String(ref.ownerUserId),
        id,
        targetDir,
        canonicalTarget,
      );
      const legacyAvailability = await validateLegacyRoot(this.legacyStorageDir);
      fixedPlan = legacyAvailability === 'available'
        ? pinFixedArtifactDefinitions(this.legacyStorageDir, rawDefinitions)
        : {
          definitions: rawDefinitions.map((definition) => ({
            ...definition,
            sourceDirectoryMissing: true,
          })),
          leases: [],
        };
      const definitions = fixedPlan.definitions;
      binaryPlan = await buildBinaryArtifactPlan(
        ref,
        definitions,
        ref.storageRoot ?? ref.storageScope!.workspaceRoot,
        ownerKey,
        id,
        false,
        this.hooks,
      );
      definitions.push(...binaryPlan.definitions);
      const alignedDefinitions = alignCompletedBinaryDefinitions(definitions, markerEnvelope);
      definitions.splice(0, definitions.length, ...alignedDefinitions);
      const marker = await readMarker(
        targetDir,
        ownerKey,
        id,
        ref.ownerUserId,
        definitions,
      );
      if (!marker || marker.phase !== 'complete') return;

      const cleanupDefinitions = [...definitions].sort((left, right) => {
        const priority = (definition: ArtifactPaths): number => {
          if (definition.artifact === 'paste_file') return 0;
          if (definition.artifact === 'attachment_file') return 1;
          if (definition.artifact === 'paste_manifest') return 3;
          return 2;
        };
        return priority(left) - priority(right);
      });
      for (const definition of cleanupDefinitions) {
        const recorded = marker.artifacts.find(
          (item) => (item.key ?? item.artifact) === definition.key,
        )!;
        if (!recorded.present) continue;
        const expectedTarget = { bytes: recorded.bytes!, sha256: recorded.sha256! };
        const expectedSource = recorded.sourceBytes !== undefined
          ? { bytes: recorded.sourceBytes, sha256: recorded.sourceSha256! }
          : expectedTarget;
        // The marker was written only after every target matched. Require that
        // same verified target before discarding the last global rollback copy.
        const target = await fingerprintPublishedFile(
          definition.target,
          'unsafe_target',
          this.hooks,
          definition.maximumBytes,
          definition.targetLease,
        );
        if (!sameFingerprint(target, expectedTarget)) {
          throw Object.assign(new Error('Workspace artifact changed before migration confirmation'), {
            migrationReason: 'target_conflict',
          });
        }
        if (definition.sourceIsTarget) continue;
        if (definition.sourceDirectoryMissing) {
          throw Object.assign(new Error('Legacy artifact parent disappeared before confirmation'), {
            migrationReason: 'unsafe_source',
          });
        }
        definition.verifySourceDirectory?.();
        await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
        for (const [legacyPath, published, kind] of [
          [definition.source, false, 'source'],
          [definition.backup, true, 'backup'],
        ] as const) {
          if (definition.sourceLease?.entryMutationPolicy === 'cwd-helper') {
            recoverMigrationWorkspaceCwdRetirement(
              definition.sourceLease,
              path.basename(legacyPath),
              expectedSource,
            );
          }
          await recoverLegacyRetirement(definition, legacyPath, this.hooks);
          const stat = await leaseAwareFileStatOrNull(
            legacyPath,
            definition.sourceLease,
            'unsafe_source',
          );
          if (!stat) continue;
          const fingerprint = published || definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
            ? await fingerprintPublishedFile(
              legacyPath,
              'unsafe_source',
              this.hooks,
              definition.maximumBytes,
              definition.sourceLease,
            )
            : await fingerprintFile(
              legacyPath,
              'unsafe_source',
              1n,
              definition.maximumBytes,
            );
          if (!sameFingerprint(fingerprint, expectedSource)) {
            throw Object.assign(new Error('Legacy artifact changed before migration confirmation'), {
              migrationReason: 'source_changed',
            });
          }
          await unlinkVerifiedLegacyFile(
            definition,
            legacyPath,
            kind,
            expectedSource,
            this.hooks,
          );
        }
        await this.hooks?.afterConfirmArtifact?.({
          artifact: definition.artifact,
          key: definition.key,
        });
      }
      await removeMarker(targetDir, this.hooks);
    } finally {
      for (const lease of binaryPlan?.leases.reverse() ?? []) lease.close();
      for (const lease of fixedPlan?.leases.reverse() ?? []) lease.close();
      await closeWorkspaceSessionDirectoryLease(ref);
    }
  }

  /**
   * A completed/verified marker with a copied binary still references rollback
   * data outside the durable project archive. Lifecycle replacement must keep
   * the checkout intact until confirm has retired that authority.
   */
  async hasPendingBinaryCleanup(ref: LegacySessionMigrationRef): Promise<boolean> {
    let ownerKey: string;
    let id: string;
    let canonicalTarget: string | null;
    try {
      id = safeComponent(ref.id, 'session id');
      ownerKey = safeComponent(
        ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
        'owner key',
      );
      canonicalTarget = workspaceSessionDirectory(ref);
    } catch {
      return true;
    }
    if (!canonicalTarget) return true;
    try {
      const targetDir = workspaceSessionAccessDirectory(ref);
      if (!targetDir) return true;
      const markerLease = workspaceSessionFileParentLease(markerPath(targetDir));
      if (!markerLease || markerLease.canonicalPath !== canonicalTarget) return true;
      markerLease.verify();
      if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) return true;
      const marker = await readMarker(targetDir, ownerKey, id, ref.ownerUserId);
      if (!marker) return false;
      return marker.artifacts.some((artifact) => (
        (artifact.artifact === 'attachment_file' || artifact.artifact === 'paste_file')
        && artifact.present
        && artifact.sourceBytes !== undefined
      ));
    } catch {
      // A malformed or temporarily unreadable marker is not evidence that the
      // secondary checkout is disposable. Replacement retries after repair.
      return true;
    } finally {
      await closeWorkspaceSessionDirectoryLease(ref);
    }
  }

  private async migrateNow(ref: LegacySessionMigrationRef): Promise<LegacySessionArtifactMigrationResult> {
    let id: string;
    let owner: string;
    let ownerKey: string;
    try {
      id = safeComponent(ref.id, 'session id');
      if (!Number.isSafeInteger(ref.ownerUserId) || ref.ownerUserId < 0) {
        throw Object.assign(new Error('Unsafe owner id'), { migrationReason: 'unsafe_source' });
      }
      owner = String(ref.ownerUserId);
      ownerKey = safeComponent(
        ref.ownerKey ?? ref.storageScope?.ownerKey ?? ref.ownerUserId,
        'owner key',
      );
    } catch (error) {
      const entries = artifactDefinitions(
        this.legacyStorageDir,
        Number.isSafeInteger(ref.ownerUserId) ? String(ref.ownerUserId) : 'invalid',
        SAFE_COMPONENT.test(String(ref.id)) ? String(ref.id) : 'invalid',
        path.join(this.legacyStorageDir, '.invalid-target'),
      ).map((entry) => blockedArtifact(entry, 'unsafe_source'));
      return { status: 'blocked', artifacts: entries };
    }

    const recoveryDefinitions = artifactDefinitions(
      this.legacyStorageDir,
      owner,
      id,
      path.join(this.legacyStorageDir, '.unused-target'),
    );
    let legacyAvailability: 'available' | 'absent';
    try {
      legacyAvailability = await validateLegacyRoot(this.legacyStorageDir);
    } catch (error) {
      const reason = migrationReason(error);
      const entries = recoveryDefinitions.map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    }
    const recoverLegacy = async (): Promise<void> => {
      if (legacyAvailability !== 'available') return;
      const recoveryPlan = pinFixedArtifactDefinitions(
        this.legacyStorageDir,
        recoveryDefinitions,
      );
      try {
        for (const definition of recoveryPlan.definitions) {
          await recoverBackup(definition, this.hooks);
        }
      } finally {
        for (const lease of recoveryPlan.leases.reverse()) lease.close();
      }
    };

    let targetDir: string;
    let canonicalTarget: string;
    try {
      const resolvedTarget = workspaceSessionDirectory(ref);
      if (!resolvedTarget) {
        throw Object.assign(new Error('Workspace scope is required'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      canonicalTarget = resolvedTarget;
      await ensureWorkspaceSessionDirectory(ref);
      const accessTarget = workspaceSessionAccessDirectory(ref);
      if (!accessTarget) throw new Error('Workspace session access path is unavailable');
      targetDir = accessTarget;
      // `accessTarget` may intentionally be `/proc/self/fd/<n>`; validate the
      // canonical path while retaining the pinned descriptor path for I/O.
      const targetStat = await lstatOrNull(canonicalTarget);
      if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw Object.assign(new Error('Unsafe target session directory'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      if (await fs.promises.realpath(targetDir) !== canonicalTarget) {
        throw Object.assign(new Error('Target session directory is reached through a symlink'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
    } catch (error) {
      let reason: LegacyArtifactBlockReason = 'unsafe_workspace_storage';
      try {
        // If the workspace disappeared after a prior file cutover, restore
        // every original source from its retained rollback sibling before
        // reporting the blocked migration.
        await recoverLegacy();
      } catch (recoveryError) {
        reason = migrationReason(recoveryError);
      }
      const entries = artifactDefinitions(
        this.legacyStorageDir,
        owner,
        id,
        path.join(this.legacyStorageDir, '.invalid-target'),
      ).map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    }

    const rawDefinitions = artifactDefinitions(
      this.legacyStorageDir,
      owner,
      id,
      targetDir,
      canonicalTarget,
    );
    let definitions = rawDefinitions;
    let binaryPlan: BinaryArtifactPlan | null = null;
    let fixedPlan: PinnedFixedArtifactPlan | null = null;
    try {
      fixedPlan = legacyAvailability === 'available'
        ? pinFixedArtifactDefinitions(this.legacyStorageDir, rawDefinitions)
        : {
          definitions: rawDefinitions.map((definition) => ({
            ...definition,
            sourceDirectoryMissing: true,
          })),
          leases: [],
        };
      definitions = fixedPlan.definitions;
      const workspaceRoot = ref.storageRoot ?? ref.storageScope?.workspaceRoot;
      if (!workspaceRoot) {
        throw Object.assign(new Error('Workspace scope is required'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
      binaryPlan = await buildBinaryArtifactPlan(
        ref,
        definitions,
        workspaceRoot,
        ownerKey,
        id,
        true,
        this.hooks,
      );
      definitions.push(...binaryPlan.definitions);
      if (definitions.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
        throw Object.assign(new Error('Migration plan exceeds its marker artifact bound'), {
          migrationReason: 'unsafe_source',
        });
      }

      const recoverAll = async (): Promise<void> => {
        for (const definition of definitions) await recoverBackup(definition, this.hooks);
      };
      let previousMarker: MigrationMarker | null;
      try {
        previousMarker = await readMarker(
          targetDir,
          ownerKey,
          id,
          ref.ownerUserId,
          definitions,
        );
      } catch (error) {
        try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
        const reason = migrationReason(error);
        const entries = definitions.map((entry) => blockedArtifact(entry, reason));
        return { status: 'blocked', artifacts: entries };
      }

      let prepared: PreparedArtifact[] = [];
      // The preparation pass may publish verified targets, but never removes a
      // source. A later conflict therefore cannot leave a partially-cut legacy
      // session behind.
      for (const definition of definitions) {
        prepared.push(await prepareArtifact(definition, previousMarker, this.hooks));
      }
      let entries = prepared.map((item) => item.entry);
      if (entries.some((entry) => entry.state === 'blocked')) {
        try { await recoverAll(); } catch { /* The blocked entries remain authoritative. */ }
        return { status: overallStatus(entries), artifacts: entries };
      }

      const backups = new Map<string, Fingerprint>();
      for (const item of prepared) {
        if (item.entry.state !== 'migrated') continue;
        try {
          const backup = await ensureBackup(item.definition, this.hooks);
          if (!backup || !item.sourceFingerprint) {
            throw Object.assign(new Error('Legacy source disappeared before cutover'), {
              migrationReason: 'source_changed',
            });
          }
          if (!sameFingerprint(backup, item.sourceFingerprint)) {
            throw Object.assign(new Error('Legacy backup differs from its source'), {
              migrationReason: 'source_changed',
            });
          }
          backups.set(item.definition.key, backup);
        } catch (error) {
          try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
          entries = blockedCutoverEntries(prepared, migrationReason(error), item.definition.artifact);
          return { status: overallStatus(entries), artifacts: entries };
        }
      }

      // Verify the complete set once more after creating the rollback backups.
      // This closes the window in which a live legacy writer could mutate one
      // member between its initial copy and the session-wide commit.
      const reverified: PreparedArtifact[] = [];
      for (const definition of definitions) {
        reverified.push(await prepareArtifact(definition, previousMarker, this.hooks));
      }
      prepared = reverified;
      entries = prepared.map((item) => item.entry);
      if (entries.some((entry) => entry.state === 'blocked')) {
        try { await recoverAll(); } catch { /* The blocked entries remain authoritative. */ }
        return { status: overallStatus(entries), artifacts: entries };
      }
      for (const item of prepared) {
        const expectedSource = backups.get(item.definition.key);
        if (
          expectedSource
          && (
            !item.sourceFingerprint
            || !sameFingerprint(expectedSource, item.sourceFingerprint)
            || !item.targetFingerprint
          )
        ) {
          try { await recoverAll(); } catch { /* Report the verified mismatch below. */ }
          entries = blockedCutoverEntries(prepared, 'source_changed', item.definition.artifact);
          return { status: overallStatus(entries), artifacts: entries };
        }
      }

      const verifiedMarker = markerFromPrepared(ownerKey, ref.ownerUserId, id, 'verified', prepared);
      try {
        await writeMarker(targetDir, verifiedMarker, this.hooks);
      } catch (error) {
        try { await recoverAll(); } catch (recoveryError) { error = recoveryError; }
        entries = blockedCutoverEntries(prepared, migrationReason(error));
        return { status: overallStatus(entries), artifacts: entries };
      }

      try {
        await commitPreparedSources(prepared, backups, this.hooks);
        await writeMarker(targetDir, { ...verifiedMarker, phase: 'complete' }, this.hooks);
      } catch (error) {
        try {
          await restorePreparedSources(prepared, this.hooks);
        } catch (restoreError) {
          entries = blockedCutoverEntries(prepared, migrationReason(restoreError));
          return { status: overallStatus(entries), artifacts: entries };
        }
        entries = blockedCutoverEntries(
          prepared,
          migrationReason(error),
          (error as { migrationArtifact?: LegacySessionArtifact }).migrationArtifact,
        );
        return { status: overallStatus(entries), artifacts: entries };
      }

      // Backups intentionally survive until the caller confirms that the
      // workspace-local SQLite rows and usage were copied and their legacy rows
      // removed. `confirm()` then removes the final global artifacts.
      return { status: 'complete', artifacts: entries };
    } catch (error) {
      try {
        for (const definition of definitions) await recoverBackup(definition, this.hooks);
      } catch (recoveryError) {
        error = recoveryError;
      }
      const reason = migrationReason(error);
      const entries = definitions.map((entry) => blockedArtifact(entry, reason));
      return { status: 'blocked', artifacts: entries };
    } finally {
      for (const lease of binaryPlan?.leases.reverse() ?? []) lease.close();
      for (const lease of fixedPlan?.leases.reverse() ?? []) lease.close();
    }
  }
}

export default WorkspaceSessionArtifactMigrator;
