import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceSessionFileParentLease } from '../workspace-session-storage.js';
import { openWorkspaceCwdFileForRead, unlinkSessionEntry } from '../../artifacts/safe-session-file.js';
import {
  publishLargeWorkspaceCwdFile,
  recoverWorkspaceCwdPublication,
} from '../io/workspace-cwd-helper.js';
import {
  MARKER_FILE,
  MAX_MARKER_ARTIFACT_KEY_LENGTH,
  MAX_MARKER_BYTES,
  MAX_MIGRATION_MARKER_ARTIFACTS,
  READ_FLAGS,
  WRITE_FLAGS,
  artifactEntry,
  blockedArtifact,
  lstatOrNull,
  migrationReason,
  sameFileIdentity,
  sameFingerprint,
  stableFile,
} from './migrator-core.js';
import type {
  ArtifactPaths,
  Fingerprint,
  LegacyArtifactBlockReason,
  LegacyArtifactMigrationEntry,
  LegacySessionArtifact,
  MigrationMarker,
  MigrationMarkerArtifact,
  PreparedArtifact,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';
import {
  copyAndPublish,
  fingerprintBuffer,
  fingerprintHandle,
  fingerprintPublishedFile,
  leaseAwareFileStatOrNull,
  publishBuffer,
  readBoundedStableFile,
  removeTemporaryAndSync,
  syncDirectory,
} from './migrator-fs.js';
import { assertSafeDirectoryTree } from './migrator-leases.js';
import { recoverLegacyRetirement } from './migrator-recovery.js';

export async function prepareArtifact(
  definition: ArtifactPaths,
  previousMarker: MigrationMarker | null,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<PreparedArtifact> {
  try {
    const markerArtifact = previousMarker?.artifacts.find(
      (artifact) => (artifact.key ?? artifact.artifact) === definition.key,
    );
    const targetHelperLease = definition.targetLease
      ?? workspaceSessionFileParentLease(definition.target);
    if (targetHelperLease?.entryMutationPolicy === 'cwd-helper') {
      recoverWorkspaceCwdPublication(targetHelperLease, path.basename(definition.target));
    }

    if (definition.sourceIsTarget) {
      const targetStat = await leaseAwareFileStatOrNull(
        definition.target,
        definition.targetLease,
        'unsafe_target',
      );
      if (!targetStat) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
      }
      if (
        definition.maximumBytes !== undefined
        && targetStat.size > BigInt(definition.maximumBytes)
      ) {
        return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
      }
      const target = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      if (
        definition.targetContents
        && !sameFingerprint(target, fingerprintBuffer(definition.targetContents))
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        markerArtifact?.present
        && (markerArtifact.bytes !== target.bytes || markerArtifact.sha256 !== target.sha256)
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        definition.expectedSourceBytes !== undefined
        && target.bytes !== definition.expectedSourceBytes
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'already_migrated', target),
        sourceFingerprint: target,
        targetFingerprint: target,
      };
    }

    if (!definition.sourceDirectoryMissing) {
      definition.verifySourceDirectory?.();
      await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
      await recoverLegacyRetirement(definition, definition.source, hooks);
      await recoverLegacyRetirement(definition, definition.backup, hooks);
    }
    const sourceStat = definition.sourceDirectoryMissing
      ? null
      : await leaseAwareFileStatOrNull(
        definition.source,
        definition.sourceLease,
        'unsafe_source',
      );
    const targetStat = await leaseAwareFileStatOrNull(
      definition.target,
      definition.targetLease,
      'unsafe_target',
    );

    if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
    }
    if (
      targetStat
      && definition.maximumBytes !== undefined
      && targetStat.size > BigInt(definition.maximumBytes)
    ) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_target') };
    }
    if (!sourceStat) {
      if (!targetStat) {
        if (markerArtifact?.present) {
          return { definition, entry: blockedArtifact(definition, 'target_conflict') };
        }
        if (definition.required) {
          return { definition, entry: blockedArtifact(definition, 'source_changed') };
        }
        return { definition, entry: artifactEntry(definition, 'absent') };
      }
      const target = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      if (
        definition.targetContents
        && !sameFingerprint(target, fingerprintBuffer(definition.targetContents))
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        markerArtifact?.present
        && (markerArtifact.bytes !== target.bytes || markerArtifact.sha256 !== target.sha256)
      ) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      if (
        definition.expectedSourceBytes !== undefined
        && target.bytes !== definition.expectedSourceBytes
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'already_migrated', target),
        ...(markerArtifact?.sourceBytes !== undefined ? {
          sourceFingerprint: {
            bytes: markerArtifact.sourceBytes,
            sha256: markerArtifact.sourceSha256!,
          },
        } : {}),
        targetFingerprint: target,
      };
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1n) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_source') };
    }
    if (
      definition.maximumBytes !== undefined
      && sourceStat.size > BigInt(definition.maximumBytes)
    ) {
      return { definition, entry: blockedArtifact(definition, 'unsafe_source') };
    }

    const sourceHandle = definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
      ? openWorkspaceCwdFileForRead(definition.sourceLease, path.basename(definition.source))
      : await fs.promises.open(definition.source, READ_FLAGS).catch(
        (error: NodeJS.ErrnoException) => {
          throw Object.assign(error, { migrationReason: 'unsafe_source' });
        },
      );
    try {
      const sourceBefore = await sourceHandle.stat({ bigint: true });
      definition.verifySourceDirectory?.();
      if (
        !sourceBefore.isFile()
        || sourceBefore.nlink !== 1n
        || !stableFile(sourceStat, sourceBefore)
        || (definition.maximumBytes !== undefined
          && sourceBefore.size > BigInt(definition.maximumBytes))
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }

      const sourceFingerprint = await fingerprintHandle(sourceHandle, definition.maximumBytes);
      const sourceAfterFingerprint = await sourceHandle.stat({ bigint: true });
      if (
        !stableFile(sourceBefore, sourceAfterFingerprint)
        || sourceAfterFingerprint.nlink !== 1n
        || BigInt(sourceFingerprint.bytes) !== sourceAfterFingerprint.size
        || (
          definition.expectedSourceBytes !== undefined
          && sourceFingerprint.bytes !== definition.expectedSourceBytes
        )
      ) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      const desiredTarget = definition.targetContents
        ? fingerprintBuffer(definition.targetContents)
        : sourceFingerprint;

      if (targetStat) {
        const targetFingerprint = await fingerprintPublishedFile(
          definition.target,
          'unsafe_target',
          hooks,
          definition.maximumBytes,
          definition.targetLease,
        );
        if (!sameFingerprint(desiredTarget, targetFingerprint)) {
          return { definition, entry: blockedArtifact(definition, 'target_conflict') };
        }
      } else {
        try {
          if (definition.targetContents) {
            await publishBuffer(
              definition.targetContents,
              definition.target,
              'unsafe_target',
              hooks,
              definition.targetLease,
            );
          } else {
            await copyAndPublish(
              sourceHandle,
              sourceBefore,
              definition.target,
              'unsafe_target',
              hooks,
              definition.maximumBytes,
              definition.targetLease,
              definition.sourceLease,
              path.basename(definition.source),
            );
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // A concurrent migration may have published the same bytes. It is a
          // successful resume only after an independent target verification.
          const sourceAfter = await sourceHandle.stat({ bigint: true });
          if (!stableFile(sourceBefore, sourceAfter)) {
            return { definition, entry: blockedArtifact(definition, 'source_changed') };
          }
          const targetFingerprint = await fingerprintPublishedFile(
            definition.target,
            'unsafe_target',
            hooks,
            definition.maximumBytes,
            definition.targetLease,
          );
          if (!sameFingerprint(desiredTarget, targetFingerprint)) {
            return { definition, entry: blockedArtifact(definition, 'target_conflict') };
          }
        }
      }

      const targetFingerprint = await fingerprintPublishedFile(
        definition.target,
        'unsafe_target',
        hooks,
        definition.maximumBytes,
        definition.targetLease,
      );
      const sourceAfterPublish = await sourceHandle.stat({ bigint: true });
      definition.verifySourceDirectory?.();
      if (!stableFile(sourceBefore, sourceAfterPublish) || sourceAfterPublish.nlink !== 1n) {
        return { definition, entry: blockedArtifact(definition, 'source_changed') };
      }
      if (!sameFingerprint(desiredTarget, targetFingerprint)) {
        return { definition, entry: blockedArtifact(definition, 'target_conflict') };
      }
      return {
        definition,
        entry: artifactEntry(definition, 'migrated', targetFingerprint),
        sourceFingerprint,
        targetFingerprint,
      };
    } finally {
      await sourceHandle.close();
    }
  } catch (error) {
    return { definition, entry: blockedArtifact(definition, migrationReason(error)) };
  }
}

export function markerPath(targetDir: string): string {
  return path.join(targetDir, MARKER_FILE);
}

export function isMarkerArtifact(
  value: unknown,
  definitions?: ArtifactPaths[],
): value is MigrationMarkerArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Record<string, unknown>;
  const key = typeof artifact.key === 'string' ? artifact.key : artifact.artifact;
  if (
    typeof key !== 'string'
    || key.length > MAX_MARKER_ARTIFACT_KEY_LENGTH
    || !/^[A-Za-z0-9._:-]+$/.test(key)
  ) return false;
  if (definitions) {
    const definition = definitions.find((candidate) => candidate.key === key);
    if (!definition || definition.artifact !== artifact.artifact) return false;
  } else if (![
    'chat_log',
    'chat_index',
    'chat_snapshot',
    'chat_snapshot_json',
    'chat_opening_context',
    'chat_plan',
    'transcript',
    'history_log',
    'history_index',
    'paste_manifest',
    'attachment_file',
    'paste_file',
  ].includes(String(artifact.artifact))) {
    return false;
  }
  if (typeof artifact.present !== 'boolean') return false;
  if (!artifact.present) {
    return artifact.bytes === undefined
      && artifact.sha256 === undefined
      && artifact.sourceBytes === undefined
      && artifact.sourceSha256 === undefined;
  }
  const targetValid = Number.isSafeInteger(artifact.bytes)
    && Number(artifact.bytes) >= 0
    && typeof artifact.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.sha256);
  const sourceAbsent = artifact.sourceBytes === undefined && artifact.sourceSha256 === undefined;
  const sourceValid = Number.isSafeInteger(artifact.sourceBytes)
    && Number(artifact.sourceBytes) >= 0
    && typeof artifact.sourceSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(artifact.sourceSha256);
  return targetValid && (sourceAbsent || sourceValid);
}

export async function readMarker(
  targetDir: string,
  ownerKey: string,
  sessionId: string,
  ownerUserId: number,
  definitions?: ArtifactPaths[],
): Promise<MigrationMarker | null> {
  const target = markerPath(targetDir);
  try {
    const markerBuffer = await readBoundedStableFile(
      target,
      MAX_MARKER_BYTES,
      'unsafe_target',
    );
    if (!markerBuffer) return null;
    const parsed = JSON.parse(markerBuffer.toString('utf8')) as Partial<MigrationMarker>;
    // Validate the collection shape and exact global bound before constructing
    // any derived Set/map from untrusted JSON.
    if (
      parsed.version !== 1
      || parsed.ownerKey !== ownerKey
      || parsed.ownerUserId !== ownerUserId
      || parsed.sessionId !== sessionId
      || (parsed.phase !== 'verified' && parsed.phase !== 'complete')
      || !Number.isSafeInteger(parsed.ownerUserId)
      || Number(parsed.ownerUserId) < 0
      || !Array.isArray(parsed.artifacts)
      || parsed.artifacts.length > MAX_MIGRATION_MARKER_ARTIFACTS
    ) {
      throw Object.assign(new Error('Invalid legacy migration marker'), {
        migrationReason: 'target_conflict',
      });
    }
    const uniqueArtifacts = new Set(parsed.artifacts.map(
      (artifact) => artifact?.key ?? artifact?.artifact,
    ));
    if (
      uniqueArtifacts.size !== parsed.artifacts.length
      || (definitions !== undefined && parsed.artifacts.length !== definitions.length)
      || !parsed.artifacts.every((artifact) => isMarkerArtifact(artifact, definitions))
    ) {
      throw Object.assign(new Error('Invalid legacy migration marker'), {
        migrationReason: 'target_conflict',
      });
    }
    return parsed as MigrationMarker;
  } catch (error) {
    if ((error as { migrationReason?: unknown }).migrationReason) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      migrationReason: 'target_conflict',
    });
  }
}

export async function writeMarker(
  targetDir: string,
  marker: MigrationMarker,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const target = markerPath(targetDir);
  const existing = await lstatOrNull(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1n)) {
    throw Object.assign(new Error('Unsafe legacy migration marker target'), {
      migrationReason: 'unsafe_target',
    });
  }
  const temporary = path.join(
    targetDir,
    `.${MARKER_FILE}.${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    if (marker.artifacts.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
      throw Object.assign(new Error('Legacy migration marker exceeds its artifact bound'), {
        migrationReason: 'unsafe_target',
      });
    }
    const serialized = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (serialized.length > MAX_MARKER_BYTES) {
      throw Object.assign(new Error('Legacy migration marker exceeds its bounded size'), {
        migrationReason: 'unsafe_target',
      });
    }
    const helperLease = workspaceSessionFileParentLease(target);
    if (helperLease?.entryMutationPolicy === 'cwd-helper') {
      publishLargeWorkspaceCwdFile(helperLease, path.basename(target), serialized);
      await syncDirectory(targetDir, hooks, 'marker_publish');
      return;
    }
    handle = await fs.promises.open(temporary, WRITE_FLAGS, 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, target);
    await syncDirectory(targetDir, hooks, 'marker_publish');
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await removeTemporaryAndSync(temporary, hooks).catch(() => undefined);
  }
}

export async function removeMarker(
  targetDir: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  await unlinkSessionEntry(markerPath(targetDir));
  await syncDirectory(targetDir, hooks, 'marker_unlink');
}

export function markerFromPrepared(
  ownerKey: string,
  ownerUserId: number,
  sessionId: string,
  phase: MigrationMarker['phase'],
  prepared: PreparedArtifact[],
): MigrationMarker {
  if (prepared.length > MAX_MIGRATION_MARKER_ARTIFACTS) {
    throw Object.assign(new Error('Migration plan exceeds its marker artifact bound'), {
      migrationReason: 'unsafe_target',
    });
  }
  return {
    version: 1,
    ownerKey,
    ownerUserId,
    sessionId,
    phase,
    artifacts: prepared.map(({ definition, sourceFingerprint, targetFingerprint }) => {
      if (!targetFingerprint) {
        return {
          artifact: definition.artifact,
          ...(definition.key !== definition.artifact ? { key: definition.key } : {}),
          present: false,
        };
      }
      return {
        artifact: definition.artifact,
        ...(definition.key !== definition.artifact ? { key: definition.key } : {}),
        present: true,
        ...targetFingerprint,
        ...(sourceFingerprint && !definition.sourceIsTarget ? {
          sourceBytes: sourceFingerprint.bytes,
          sourceSha256: sourceFingerprint.sha256,
        } : {}),
      };
    }),
  };
}

export function blockedCutoverEntries(
  prepared: PreparedArtifact[],
  reason: LegacyArtifactBlockReason,
  artifact?: LegacySessionArtifact,
): LegacyArtifactMigrationEntry[] {
  return prepared.map((item) => {
    if (item.entry.state === 'absent') return item.entry;
    if (!artifact || item.definition.artifact === artifact) {
      return blockedArtifact(item.definition, reason);
    }
    return item.entry;
  });
}
