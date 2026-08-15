import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDescriptorRoot } from '../workspace-session-storage.js';
import { openWorkspaceCwdFileForRead } from '../../artifacts/safe-session-file.js';
import { retireMigrationWorkspaceCwdEntry } from '../io/workspace-cwd-helper.js';
import {
  DIRECTORY,
  NO_FOLLOW,
  READ_FLAGS,
  lstatOrNull,
  migrationReason,
  sameDirectoryIdentity,
  sameFileIdentity,
  sameFingerprint,
  stableFile,
  stableFileAcrossRename,
} from './migrator-core.js';
import type {
  ArtifactPaths,
  Fingerprint,
  LegacyArtifactBlockReason,
  PreparedArtifact,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';
import {
  copyVerifiedFile,
  fingerprintFile,
  fingerprintHandle,
  fingerprintPublishedFile,
  leaseAwareFileStatOrNull,
  syncDirectory,
} from './migrator-fs.js';
import { assertSafeDirectoryTree } from './migrator-leases.js';

export async function recoverBackup(
  definition: ArtifactPaths,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  if (definition.sourceIsTarget) return;
  if (definition.sourceDirectoryMissing) return;
  definition.verifySourceDirectory?.();
  await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
  await recoverLegacyRetirement(definition, definition.source, hooks);
  await recoverLegacyRetirement(definition, definition.backup, hooks);
  const backupStat = await leaseAwareFileStatOrNull(
    definition.backup,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!backupStat) return;
  if (backupStat.isSymbolicLink() || !backupStat.isFile()) {
    throw Object.assign(new Error('Unsafe legacy migration backup'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && backupStat.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy migration backup exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  const backupFingerprint = await fingerprintPublishedFile(
    definition.backup,
    'unsafe_source',
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
  const sourceStat = await leaseAwareFileStatOrNull(
    definition.source,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!sourceStat) {
    const restored = await copyVerifiedFile(
      definition.backup,
      definition.source,
      hooks,
      definition.maximumBytes,
      definition.sourceLease,
    );
    if (!sameFingerprint(backupFingerprint, restored)) {
      throw Object.assign(new Error('Restored source differs from migration backup'), {
        migrationReason: 'source_changed',
      });
    }
    return;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1n) {
    throw Object.assign(new Error('Unsafe source beside migration backup'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && sourceStat.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy source exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  const sourceFingerprint = await fingerprintPublishedFile(
    definition.source,
    'unsafe_source',
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
  if (!sameFingerprint(sourceFingerprint, backupFingerprint)) {
    throw Object.assign(new Error('Source conflicts with migration backup'), {
      migrationReason: 'source_changed',
    });
  }
}

export async function ensureBackup(
  definition: ArtifactPaths,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<Fingerprint | null> {
  if (definition.sourceIsTarget) return null;
  if (definition.sourceDirectoryMissing) return null;
  definition.verifySourceDirectory?.();
  await assertSafeDirectoryTree(definition.sourceRoot, path.dirname(definition.source));
  await recoverLegacyRetirement(definition, definition.source, hooks);
  await recoverLegacyRetirement(definition, definition.backup, hooks);
  const source = await leaseAwareFileStatOrNull(
    definition.source,
    definition.sourceLease,
    'unsafe_source',
  );
  if (!source) return null;
  if (source.isSymbolicLink() || !source.isFile() || source.nlink !== 1n) {
    throw Object.assign(new Error('Unsafe legacy source before cutover'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (
    definition.maximumBytes !== undefined
    && source.size > BigInt(definition.maximumBytes)
  ) {
    throw Object.assign(new Error('Legacy source exceeds its per-file limit'), {
      migrationReason: 'unsafe_source',
    });
  }
  return copyVerifiedFile(
    definition.source,
    definition.backup,
    hooks,
    definition.maximumBytes,
    definition.sourceLease,
  );
}

export async function restorePreparedSources(
  prepared: PreparedArtifact[],
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  for (const item of prepared) {
    await recoverBackup(item.definition, hooks);
  }
}

export function legacyRetirementDirectory(legacyPath: string): string {
  const identity = createHash('sha256')
    .update(path.basename(legacyPath))
    .digest('hex')
    .slice(0, 32);
  return path.join(path.dirname(legacyPath), `.ccweb-retire-${identity}`);
}

export async function recoverLegacyRetirement(
  definition: ArtifactPaths,
  legacyPath: string,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  const directory = legacyRetirementDirectory(legacyPath);
  const visibleDirectory = await lstatOrNull(directory);
  if (!visibleDirectory) return;
  if (definition.sourceLease?.entryMutationPolicy === 'cwd-helper') {
    throw Object.assign(new Error('Portable legacy retirement state requires manual recovery'), {
      migrationReason: 'unsafe_source',
    });
  }
  if (visibleDirectory.isSymbolicLink() || !visibleDirectory.isDirectory()) {
    throw Object.assign(new Error('Legacy retirement path is not a private directory'), {
      migrationReason: 'unsafe_source',
    });
  }
  const directoryHandle = await fs.promises.open(
    directory,
    fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY,
  );
  let empty = false;
  try {
    const openedDirectory = await directoryHandle.stat({ bigint: true });
    if (!sameDirectoryIdentity(visibleDirectory, openedDirectory)) {
      throw Object.assign(new Error('Legacy retirement directory changed while opening'), {
        migrationReason: 'unsafe_source',
      });
    }
    const descriptorRoot = workspaceDescriptorRoot();
    const accessDirectory = descriptorRoot
      ? path.join(descriptorRoot, String(directoryHandle.fd))
      : directory;
    const entries = await fs.promises.readdir(accessDirectory);
    if (entries.length === 0) {
      empty = true;
      return;
    }
    if (entries.length !== 1 || entries[0] !== 'artifact') {
      throw Object.assign(new Error('Legacy retirement directory contains unexpected entries'), {
        migrationReason: 'unsafe_source',
      });
    }
    const quarantinedPath = path.join(accessDirectory, 'artifact');
    const quarantined = await lstatOrNull(quarantinedPath);
    if (
      !quarantined
      || quarantined.isSymbolicLink()
      || !quarantined.isFile()
      || (definition.maximumBytes !== undefined
        && quarantined.size > BigInt(definition.maximumBytes))
    ) {
      throw Object.assign(new Error('Legacy retirement entry is unsafe'), {
        migrationReason: 'unsafe_source',
      });
    }
    const current = await lstatOrNull(legacyPath);
    if (current) {
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || current.nlink !== 2n
        || quarantined.nlink !== 2n
        || !sameFileIdentity(current, quarantined)
      ) {
        throw Object.assign(new Error('Legacy retirement conflicts with the visible artifact'), {
          migrationReason: 'source_changed',
        });
      }
    } else {
      if (quarantined.nlink !== 1n) {
        throw Object.assign(new Error('Legacy retirement entry has an ambiguous link count'), {
          migrationReason: 'source_changed',
        });
      }
      await fs.promises.link(quarantinedPath, legacyPath);
      const restored = await lstatOrNull(legacyPath);
      const linked = await lstatOrNull(quarantinedPath);
      if (
        !restored
        || !linked
        || restored.nlink !== 2n
        || linked.nlink !== 2n
        || !sameFileIdentity(restored, linked)
      ) {
        throw Object.assign(new Error('Legacy retirement restore could not be verified'), {
          migrationReason: 'source_changed',
        });
      }
    }
    await fs.promises.unlink(quarantinedPath);
    await directoryHandle.sync();
    empty = true;
    const restoredAfter = await lstatOrNull(legacyPath);
    if (
      !restoredAfter
      || restoredAfter.isSymbolicLink()
      || !restoredAfter.isFile()
      || restoredAfter.nlink !== 1n
    ) {
      throw Object.assign(new Error('Recovered legacy artifact is not isolated'), {
        migrationReason: 'source_changed',
      });
    }
  } finally {
    await directoryHandle.close();
    if (empty) {
      await fs.promises.rmdir(directory);
      await syncDirectory(path.dirname(legacyPath), hooks, 'temporary_cleanup');
    }
  }
}

export async function unlinkVerifiedLegacyFile(
  definition: ArtifactPaths,
  legacyPath: string,
  kind: 'source' | 'backup',
  expected: Fingerprint,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  definition.verifySourceDirectory?.();
  await recoverLegacyRetirement(definition, legacyPath, hooks);
  const helperSourceLease = definition.sourceLease?.entryMutationPolicy === 'cwd-helper'
    && (path.dirname(legacyPath) === definition.sourceLease.accessPath
      || path.dirname(legacyPath) === definition.sourceLease.canonicalPath)
    ? definition.sourceLease
    : undefined;
  const handle = helperSourceLease
    ? openWorkspaceCwdFileForRead(helperSourceLease, path.basename(legacyPath))
    : await fs.promises.open(legacyPath, READ_FLAGS).catch((error: NodeJS.ErrnoException) => {
      throw Object.assign(error, { migrationReason: 'source_changed' });
    });
  const visible = helperSourceLease
    ? await handle.stat({ bigint: true })
    : await lstatOrNull(legacyPath);
  if (
    !visible
    || visible.isSymbolicLink()
    || !visible.isFile()
    || visible.nlink !== 1n
  ) {
    await handle.close().catch(() => undefined);
    throw Object.assign(new Error('Legacy artifact is not an isolated regular file'), {
      migrationReason: 'source_changed',
    });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.nlink !== 1n
      || !sameFileIdentity(visible, opened)
      || !stableFile(visible, opened)
    ) {
      throw Object.assign(new Error('Legacy artifact changed while it was opened'), {
        migrationReason: 'source_changed',
      });
    }
    const openedFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
    const afterFingerprint = await handle.stat({ bigint: true });
    if (
      afterFingerprint.nlink !== 1n
      || !stableFile(opened, afterFingerprint)
      || !sameFingerprint(openedFingerprint, expected)
    ) {
      throw Object.assign(new Error('Legacy artifact changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }

    await hooks?.beforeLegacyUnlink?.({
      artifact: definition.artifact,
      key: definition.key,
      kind,
    });
    definition.verifySourceDirectory?.();

    const finalVisible = helperSourceLease ? null : await lstatOrNull(legacyPath);
    const finalOpened = await handle.stat({ bigint: true });
    if (
      finalOpened.nlink !== 1n
      || (!helperSourceLease && (
        !finalVisible
        || finalVisible.isSymbolicLink()
        || !finalVisible.isFile()
        || finalVisible.nlink !== 1n
        || !sameFileIdentity(finalVisible, finalOpened)
      ))
      || !stableFile(afterFingerprint, finalOpened)
    ) {
      throw Object.assign(new Error('Legacy artifact name changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }
    const finalFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
    const immediatelyBeforeUnlink = await handle.stat({ bigint: true });
    if (
      immediatelyBeforeUnlink.nlink !== 1n
      || !stableFile(finalOpened, immediatelyBeforeUnlink)
      || !sameFingerprint(finalFingerprint, expected)
    ) {
      throw Object.assign(new Error('Legacy artifact bytes changed before unlink'), {
        migrationReason: 'source_changed',
      });
    }

    if (helperSourceLease) {
      const expectedParent = helperSourceLease;
      const basename = path.basename(legacyPath);
      if (path.dirname(legacyPath) !== expectedParent.accessPath
        && path.dirname(legacyPath) !== expectedParent.canonicalPath) {
        throw Object.assign(new Error('Portable legacy source is outside its pinned namespace'), {
          migrationReason: 'unsafe_source',
        });
      }
      retireMigrationWorkspaceCwdEntry(
        expectedParent,
        basename,
        { dev: immediatelyBeforeUnlink.dev, ino: immediatelyBeforeUnlink.ino },
      );
      await syncDirectory(path.dirname(legacyPath), hooks, 'temporary_cleanup');
      return;
    }

    // Node does not expose an unlink-by-file-descriptor primitive. Never
    // unlink the attacker-visible legacy name directly: move that directory
    // entry into a fresh private directory, verify that the moved name is the
    // still-open inode, and only then retire the quarantined name. If the
    // source is replaced inside the rename syscall seam, the replacement is
    // moved rather than deleted and is restored with a no-clobber hard link.
    const legacyDirectory = path.dirname(legacyPath);
    const quarantineDirectory = legacyRetirementDirectory(legacyPath);
    await fs.promises.mkdir(quarantineDirectory, { mode: 0o700 });
    const quarantineVisible = await fs.promises.lstat(quarantineDirectory, { bigint: true });
    const quarantineHandle = await fs.promises.open(
      quarantineDirectory,
      fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY,
    );
    let quarantineEmpty = false;
    try {
      const quarantineOpened = await quarantineHandle.stat({ bigint: true });
      if (!sameDirectoryIdentity(quarantineVisible, quarantineOpened)) {
        throw Object.assign(new Error('Legacy artifact quarantine changed while opening'), {
          migrationReason: 'source_changed',
        });
      }
      const descriptorRoot = workspaceDescriptorRoot();
      const quarantineAccessDirectory = descriptorRoot
        ? path.join(descriptorRoot, String(quarantineHandle.fd))
        : quarantineDirectory;
      const quarantinedPath = path.join(quarantineAccessDirectory, 'artifact');
      const restoreQuarantinedName = async (): Promise<boolean> => {
        const quarantined = await lstatOrNull(quarantinedPath);
        if (!quarantined) return false;
        if (quarantined.isSymbolicLink() || !quarantined.isFile()) return false;
        if (await lstatOrNull(legacyPath)) return false;
        try {
          // link(2) is the no-clobber primitive available in Node. It restores
          // whichever entry rename moved (including a concurrent replacement)
          // without overwriting a newer legacy name.
          await fs.promises.link(quarantinedPath, legacyPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        const restored = await lstatOrNull(legacyPath);
        const linked = await lstatOrNull(quarantinedPath);
        if (
          !restored
          || !linked
          || !sameFileIdentity(restored, linked)
          || restored.nlink < 2n
          || linked.nlink < 2n
        ) {
          throw Object.assign(new Error('Could not verify restored legacy artifact name'), {
            migrationReason: 'source_changed',
          });
        }
        await fs.promises.unlink(quarantinedPath);
        await quarantineHandle.sync();
        quarantineEmpty = true;
        const restoredAfter = await lstatOrNull(legacyPath);
        if (
          !restoredAfter
          || restoredAfter.isSymbolicLink()
          || !restoredAfter.isFile()
          || !sameFileIdentity(restored, restoredAfter)
        ) {
          throw Object.assign(new Error('Restored legacy artifact changed during quarantine cleanup'), {
            migrationReason: 'source_changed',
          });
        }
        return true;
      };

      if (await lstatOrNull(quarantinedPath)) {
        throw Object.assign(new Error('Legacy artifact quarantine was not empty'), {
          migrationReason: 'source_changed',
        });
      }
      // Persist the private directory before placing the only visible legacy
      // name inside it, then persist the rename itself. A cold process can
      // therefore deterministically restore either crash cutpoint.
      await syncDirectory(legacyDirectory, hooks, 'quarantine_publish');
      await fs.promises.rename(legacyPath, quarantinedPath);
      await syncDirectory(legacyDirectory, hooks, 'quarantine_publish');
      definition.verifySourceDirectory?.();

      try {
        const quarantined = await lstatOrNull(quarantinedPath);
        const movedOpened = await handle.stat({ bigint: true });
        if (
          !quarantined
          || quarantined.isSymbolicLink()
          || !quarantined.isFile()
          || quarantined.nlink !== 1n
          || movedOpened.nlink !== 1n
          || !sameFileIdentity(quarantined, movedOpened)
          || !stableFileAcrossRename(immediatelyBeforeUnlink, movedOpened)
        ) {
          throw Object.assign(new Error('Legacy artifact name changed during quarantine rename'), {
            migrationReason: 'source_changed',
          });
        }
        const quarantinedFingerprint = await fingerprintHandle(handle, definition.maximumBytes);
        const beforeQuarantineUnlink = await handle.stat({ bigint: true });
        if (
          beforeQuarantineUnlink.nlink !== 1n
          || !stableFile(movedOpened, beforeQuarantineUnlink)
          || !sameFingerprint(quarantinedFingerprint, expected)
          || await lstatOrNull(legacyPath)
        ) {
          throw Object.assign(new Error('Legacy artifact changed inside quarantine'), {
            migrationReason: 'source_changed',
          });
        }

        await fs.promises.unlink(quarantinedPath);
        await quarantineHandle.sync();
        quarantineEmpty = true;
        const afterUnlink = await handle.stat({ bigint: true });
        const visibleAfterUnlink = await lstatOrNull(quarantinedPath);
        if (afterUnlink.nlink !== 0n || visibleAfterUnlink || await lstatOrNull(legacyPath)) {
          throw Object.assign(new Error('Legacy artifact quarantine did not retire the opened inode'), {
            migrationReason: 'source_changed',
          });
        }
      } catch (error) {
        // A mismatching entry is still user data. Restore it to the source name
        // when that can be done without clobbering another concurrent entry;
        // otherwise leave the private quarantine intact and fail closed.
        await restoreQuarantinedName();
        throw error;
      }
    } finally {
      await quarantineHandle.close();
      if (quarantineEmpty) {
        await fs.promises.rmdir(quarantineDirectory);
        await syncDirectory(
          legacyDirectory,
          hooks,
          kind === 'source' ? 'source_unlink' : 'backup_unlink',
        );
      }
    }
  } finally {
    await handle.close();
  }
}

export async function commitPreparedSources(
  prepared: PreparedArtifact[],
  backups: Map<string, Fingerprint>,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<void> {
  for (const item of prepared) {
    const expectedSource = backups.get(item.definition.key);
    if (!expectedSource || item.definition.sourceIsTarget) continue;
    const expectedTarget = item.targetFingerprint;
    item.definition.verifySourceDirectory?.();
    const source = await fingerprintFile(
      item.definition.source,
      'unsafe_source',
      1n,
      item.definition.maximumBytes,
    );
    const backup = await fingerprintPublishedFile(
      item.definition.backup,
      'unsafe_source',
      hooks,
      item.definition.maximumBytes,
      item.definition.sourceLease,
    );
    const target = expectedTarget
      ? await fingerprintPublishedFile(
        item.definition.target,
        'unsafe_target',
        hooks,
        item.definition.maximumBytes,
        item.definition.targetLease,
      )
      : null;
    if (
      !sameFingerprint(source, expectedSource)
      || !sameFingerprint(backup, expectedSource)
      || !target
      || !expectedTarget
      || !sameFingerprint(target, expectedTarget)
    ) {
      throw Object.assign(new Error('Artifact changed before session cutover'), {
        migrationReason: 'source_changed',
        migrationArtifact: item.definition.artifact,
      });
    }
    try {
      await unlinkVerifiedLegacyFile(
        item.definition,
        item.definition.source,
        'source',
        expectedSource,
        hooks,
      );
      // Detect a link added in the narrow interval after the pre-cutover
      // verification. The caller still has a verified backup and will restore
      // the source if this postcondition fails.
      const committedTarget = await fingerprintPublishedFile(
        item.definition.target,
        'unsafe_target',
        hooks,
        item.definition.maximumBytes,
        item.definition.targetLease,
      );
      if (!sameFingerprint(committedTarget, expectedTarget)) {
        throw Object.assign(new Error('Workspace target changed during session cutover'), {
          migrationReason: 'target_conflict',
        });
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        migrationReason: migrationReason(error),
        migrationArtifact: item.definition.artifact,
      });
    }
  }
}
