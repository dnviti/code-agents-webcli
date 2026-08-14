import path from 'node:path';
import {
  openWorkspaceAttachmentDirectorySync,
  openWorkspaceAttachmentRootDirectorySync,
  openWorkspacePasteDirectorySync,
  type WorkspaceStorageDirectoryLease,
} from '../workspace-session-storage.js';
import {
  listWorkspaceCwdEntries,
  migrationWorkspaceCwdRetirementPrefix,
} from '../workspace-cwd-helper.js';
import {
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
} from '../attachment-store.js';
import {
  DEFAULT_MAX_BYTES as DEFAULT_MAX_PASTE_BYTES,
} from '../paste-store.js';
import {
  MAX_ATTACHMENT_DIRECTORY_ENTRIES,
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_SOURCE_NAMESPACES_PER_ROOT,
  MAX_LEGACY_WORKSPACE_ROOTS,
  MAX_PASTE_MANIFEST_BYTES,
  MAX_PASTE_MANIFEST_ENTRIES,
  MAX_PASTE_ROOTS,
  PASTED_IMAGE_NAME,
  STORED_ATTACHMENT_NAME,
  backupPath,
  boundedMigrationFileBytes,
  dynamicArtifactKey,
  lstatOrNull,
} from './migrator-core.js';
import type {
  ArtifactPaths,
  BinaryArtifactPlan,
  Fingerprint,
  LegacyArtifactMigrationEntry,
  LegacySessionArtifact,
  LegacySessionArtifactMigrationResult,
  LegacySessionMigrationRef,
  MigrationMarker,
  PasteManifest,
  PasteManifestEntry,
  WorkspaceSessionArtifactMigratorHooks,
} from './migrator-core.js';
import {
  leaseAwareFileStatOrNull,
  readBoundedStableFile,
} from './migrator-fs.js';
import { assertCanonicalSourceRoot } from './migrator-leases.js';
import {
  legacyRetirementDirectory,
  recoverLegacyRetirement,
} from './migrator-recovery.js';
import {
  attachmentNameFromUrl,
  collectAttachmentReferencesFromFile,
  namespacedAttachmentNames,
  parsePasteManifest,
  sourceOrBackup,
} from './migrator-references.js';

export function artifactDefinitions(
  legacyRoot: string,
  owner: string,
  id: string,
  targetDir: string,
  canonicalTargetDir = targetDir,
): ArtifactPaths[] {
  const chatBase = path.join(legacyRoot, owner, id);
  const transcriptBase = path.join(legacyRoot, 'transcripts', owner, id);
  const historyBase = path.join(legacyRoot, 'history', owner, id);
  const pasteBase = path.join(legacyRoot, 'pastes', owner, id);
  const definitions: Array<Pick<ArtifactPaths, 'artifact' | 'source' | 'target' | 'canonicalTarget'>> = [
    { artifact: 'chat_log', source: `${chatBase}.jsonl`, target: path.join(targetDir, 'chat.jsonl'), canonicalTarget: path.join(canonicalTargetDir, 'chat.jsonl') },
    { artifact: 'chat_index', source: `${chatBase}.idx`, target: path.join(targetDir, 'chat.idx'), canonicalTarget: path.join(canonicalTargetDir, 'chat.idx') },
    { artifact: 'chat_snapshot', source: `${chatBase}.snapshot`, target: path.join(targetDir, 'chat.snapshot'), canonicalTarget: path.join(canonicalTargetDir, 'chat.snapshot') },
    { artifact: 'chat_snapshot_json', source: `${chatBase}.snapshot.json`, target: path.join(targetDir, 'chat.snapshot.json'), canonicalTarget: path.join(canonicalTargetDir, 'chat.snapshot.json') },
    { artifact: 'chat_opening_context', source: `${chatBase}.ctx`, target: path.join(targetDir, 'chat.ctx'), canonicalTarget: path.join(canonicalTargetDir, 'chat.ctx') },
    { artifact: 'chat_plan', source: `${chatBase}.plan`, target: path.join(targetDir, 'chat.plan'), canonicalTarget: path.join(canonicalTargetDir, 'chat.plan') },
    { artifact: 'transcript', source: `${transcriptBase}.md`, target: path.join(targetDir, 'transcript.md'), canonicalTarget: path.join(canonicalTargetDir, 'transcript.md') },
    { artifact: 'history_log', source: `${historyBase}.log`, target: path.join(targetDir, 'history.log'), canonicalTarget: path.join(canonicalTargetDir, 'history.log') },
    { artifact: 'history_index', source: `${historyBase}.idx`, target: path.join(targetDir, 'history.idx'), canonicalTarget: path.join(canonicalTargetDir, 'history.idx') },
    { artifact: 'paste_manifest', source: `${pasteBase}.json`, target: path.join(targetDir, 'paste-manifest.json'), canonicalTarget: path.join(canonicalTargetDir, 'paste-manifest.json') },
  ];
  return definitions.map((definition) => ({
    ...definition,
    key: definition.artifact,
    sourceRoot: legacyRoot,
    // A deterministic sibling backup makes an interrupted multi-file cleanup
    // recoverable even when the workspace target is temporarily unavailable.
    backup: path.join(
      path.dirname(definition.source),
      `.${path.basename(definition.source)}.ccweb-session-migration.bak`,
    ),
  }));
}

export function distinctLegacyWorkspaceRoots(
  ref: LegacySessionMigrationRef,
  canonicalRoot: string,
): string[] {
  const roots = new Set([canonicalRoot]);
  if (
    ref.projectWorkingDirKind !== 'container'
    && typeof ref.workingDir === 'string'
    && path.isAbsolute(ref.workingDir)
  ) {
    const workingDir = path.resolve(ref.workingDir);
    const relative = path.relative(canonicalRoot, workingDir);
    const secondaryIsConfined = !path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`);
    if (workingDir !== path.parse(workingDir).root && secondaryIsConfined) {
      roots.add(workingDir);
    }
  }
  const result = [...roots];
  if (result.length > MAX_LEGACY_WORKSPACE_ROOTS) {
    throw Object.assign(new Error('Legacy session names too many authorised workspace roots'), {
      migrationReason: 'unsafe_source',
    });
  }
  return result;
}

export async function buildBinaryArtifactPlan(
  ref: LegacySessionMigrationRef,
  fixed: ArtifactPaths[],
  canonicalRoot: string,
  ownerKey: string,
  sessionId: string,
  createTargets: boolean,
  hooks?: WorkspaceSessionArtifactMigratorHooks,
): Promise<BinaryArtifactPlan> {
  const leases: WorkspaceStorageDirectoryLease[] = [];
  try {
    const roots = distinctLegacyWorkspaceRoots(ref, canonicalRoot);
    for (const root of roots) {
      const state = await assertCanonicalSourceRoot(root);
      if (state === 'absent' && root === canonicalRoot) {
        throw Object.assign(new Error('Canonical workspace disappeared during migration'), {
          migrationReason: 'unsafe_workspace_storage',
        });
      }
    }

    const attachmentNames = new Set<string>();
    const draftAttachments = ref.chatDraft?.attachments ?? [];
    if (draftAttachments.length > MAX_ATTACHMENT_FILES) {
      throw Object.assign(new Error('Legacy draft attachment count exceeds its bound'), {
        migrationReason: 'unsafe_source',
      });
    }
    for (const attachment of draftAttachments) {
      const name = attachmentNameFromUrl(attachment.url, sessionId);
      if (name) attachmentNames.add(name);
    }
    if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
      throw Object.assign(new Error('Legacy attachment reference count exceeds its bound'), {
        migrationReason: 'unsafe_source',
      });
    }
    const referenceArtifacts = new Set<LegacySessionArtifact>([
      'chat_log',
      'chat_snapshot',
      'chat_snapshot_json',
      'chat_opening_context',
      'chat_plan',
      'transcript',
    ]);
    for (const definition of fixed) {
      if (!referenceArtifacts.has(definition.artifact)) continue;
      const legacyReference = await sourceOrBackup(definition);
      if (legacyReference) {
        await collectAttachmentReferencesFromFile(
          legacyReference,
          sessionId,
          attachmentNames,
          'unsafe_source',
          hooks,
          definition.sourceLease,
        );
      }
      await collectAttachmentReferencesFromFile(
        definition.target,
        sessionId,
        attachmentNames,
        'unsafe_target',
        hooks,
        definition.targetLease,
      );
      if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
        throw Object.assign(new Error('Legacy attachment reference count exceeds its bound'), {
          migrationReason: 'unsafe_source',
        });
      }
    }

    for (const root of roots) {
      if (await assertCanonicalSourceRoot(root) === 'absent') continue;
      for (const namespace of new Set([ownerKey, String(ref.ownerUserId)])) {
        for (const name of await namespacedAttachmentNames(root, namespace, sessionId)) {
          attachmentNames.add(name);
          if (attachmentNames.size > MAX_ATTACHMENT_FILES) {
            throw Object.assign(new Error('Legacy attachment namespace exceeds its bound'), {
              migrationReason: 'unsafe_source',
            });
          }
        }
      }
    }

    const definitions: ArtifactPaths[] = [];
    let attachmentLease: WorkspaceStorageDirectoryLease | null = null;
    if (attachmentNames.size > 0) {
      attachmentLease = openWorkspaceAttachmentDirectorySync(
        canonicalRoot,
        ownerKey,
        sessionId,
        { createIfMissing: createTargets },
      );
      leases.push(attachmentLease);
    }
    const sourceAttachmentLeases = new Map<string, WorkspaceStorageDirectoryLease>();
    let attachmentSessionBytes = 0;

    for (const name of [...attachmentNames].sort()) {
      const canonicalTarget = path.join(
        canonicalRoot,
        '.cc-web',
        'attachments',
        ownerKey,
        sessionId,
        name,
      );
      const target = path.join(attachmentLease!.accessPath, name);
      const candidates = new Map<string, {
        canonical: string;
        root: string;
        namespace: string | null;
      }>();
      for (const root of roots) {
        const flat = path.join(root, '.cc-web', 'attachments', name);
        candidates.set(flat, { canonical: flat, root, namespace: null });
        for (const namespace of new Set([String(ref.ownerUserId), ownerKey])) {
          const canonical = path.join(
            root,
            '.cc-web',
            'attachments',
            namespace,
            sessionId,
            name,
          );
          candidates.set(canonical, { canonical, root, namespace });
        }
      }
      candidates.delete(canonicalTarget);
      const existingSources: Array<{
        canonical: string;
        source: string;
        sourceRoot: string;
        backup: string;
        lease: WorkspaceStorageDirectoryLease;
        verifySourceDirectory: () => void;
      }> = [];
      for (const candidate of [...candidates.values()].sort(
        (left, right) => left.canonical.localeCompare(right.canonical),
      )) {
        const canonicalDirectory = path.dirname(candidate.canonical);
        let sourceLease = sourceAttachmentLeases.get(canonicalDirectory);
        if (!sourceLease) {
          try {
            sourceLease = candidate.namespace === null
              ? openWorkspaceAttachmentRootDirectorySync(candidate.root, { createIfMissing: false })
              : openWorkspaceAttachmentDirectorySync(
                candidate.root,
                candidate.namespace,
                sessionId,
                { createIfMissing: false },
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (sourceLease.canonicalPath !== canonicalDirectory) {
            sourceLease.close();
            throw Object.assign(new Error('Legacy attachment source did not match its pinned namespace'), {
              migrationReason: 'unsafe_source',
            });
          }
          sourceAttachmentLeases.set(canonicalDirectory, sourceLease);
          leases.push(sourceLease);
        }
        const source = path.join(sourceLease.accessPath, name);
        const backup = backupPath(source);
        const hasAuthority = sourceLease.entryMutationPolicy === 'cwd-helper'
          ? (() => {
            const entries = new Set(listWorkspaceCwdEntries(sourceLease!).map((entry) => entry.name));
            const exactNames = [
              source,
              backup,
              legacyRetirementDirectory(source),
              legacyRetirementDirectory(backup),
            ].map((entry) => path.basename(entry));
            const taggedPrefixes = [path.basename(source), path.basename(backup)]
              .map((entry) => migrationWorkspaceCwdRetirementPrefix(entry));
            return exactNames.some((entry) => entries.has(entry))
              || [...entries].some((entry) => taggedPrefixes.some((prefix) => entry.startsWith(prefix)));
          })()
          : (await lstatOrNull(source)) !== null
            || (await lstatOrNull(backup)) !== null
            || (await lstatOrNull(legacyRetirementDirectory(source))) !== null
            || (await lstatOrNull(legacyRetirementDirectory(backup))) !== null;
        if (!hasAuthority) continue;
        existingSources.push({
          canonical: candidate.canonical,
          source,
          sourceRoot: sourceLease.accessPath,
          backup,
          lease: sourceLease,
          verifySourceDirectory: sourceLease.verify,
        });
      }

      // Quota is defined over logical attachment names. A legacy file may be
      // duplicated across flat/numeric/owner-key layouts, but those aliases
      // must neither multiply quota nor bypass the per-file bound. Inspect all
      // candidate authorities before any of them is hashed or copied, then
      // account the largest candidate exactly once for this name.
      let logicalBytes = 0;
      const targetStat = await leaseAwareFileStatOrNull(target, attachmentLease!, 'unsafe_target');
      if (targetStat) {
        logicalBytes = Math.max(logicalBytes, boundedMigrationFileBytes(
          targetStat,
          DEFAULT_MAX_ATTACHMENT_BYTES,
          'unsafe_target',
        ));
      }
      for (const existing of existingSources) {
        existing.verifySourceDirectory();
        const retirementDefinition: ArtifactPaths = {
          artifact: 'attachment_file',
          key: dynamicArtifactKey('attachment_file', existing.canonical),
          source: existing.source,
          sourceRoot: existing.sourceRoot,
          target,
          canonicalTarget,
          targetLease: attachmentLease!,
          sourceLease: existing.lease,
          backup: existing.backup,
          verifySourceDirectory: existing.verifySourceDirectory,
          required: true,
          maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        };
        // A cold crash may have durably moved the only source or backup into
        // its deterministic retirement directory. Restore that descriptor-
        // pinned authority before quota accounting so it cannot count as zero.
        await recoverLegacyRetirement(retirementDefinition, existing.source, hooks);
        await recoverLegacyRetirement(retirementDefinition, existing.backup, hooks);
        const sourceStat = await leaseAwareFileStatOrNull(
          existing.source,
          existing.lease,
          'unsafe_source',
        );
        const authorityPath = sourceStat ? existing.source : existing.backup;
        const authorityStat = sourceStat ?? await leaseAwareFileStatOrNull(
          authorityPath,
          existing.lease,
          'unsafe_source',
        );
        if (!authorityStat) continue;
        logicalBytes = Math.max(logicalBytes, boundedMigrationFileBytes(
          authorityStat,
          DEFAULT_MAX_ATTACHMENT_BYTES,
          'unsafe_source',
        ));
      }
      if (logicalBytes > DEFAULT_ATTACHMENT_QUOTA_BYTES - attachmentSessionBytes) {
        throw Object.assign(new Error('Legacy attachments exceed the session quota'), {
          migrationReason: 'unsafe_source',
        });
      }
      attachmentSessionBytes += logicalBytes;

      if (existingSources.length === 0) {
        if (await leaseAwareFileStatOrNull(target, attachmentLease!, 'unsafe_target')) {
          definitions.push({
            artifact: 'attachment_file',
            key: dynamicArtifactKey('attachment_file', canonicalTarget),
            source: target,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: attachmentLease!,
            sourceLease: attachmentLease!,
            backup: backupPath(canonicalTarget),
            sourceIsTarget: true,
            required: true,
            maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
          });
        } else {
          const source = path.join(canonicalRoot, '.cc-web', 'attachments', name);
          definitions.push({
            artifact: 'attachment_file',
            key: dynamicArtifactKey('attachment_file', source),
            source,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: attachmentLease!,
            backup: backupPath(source),
            required: true,
            maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
          });
        }
        continue;
      }
      for (const existing of existingSources) {
        definitions.push({
          artifact: 'attachment_file',
          key: dynamicArtifactKey('attachment_file', existing.canonical),
          source: existing.source,
          sourceRoot: existing.sourceRoot,
          target,
          canonicalTarget,
          targetLease: attachmentLease!,
          sourceLease: existing.lease,
          backup: existing.backup,
          verifySourceDirectory: existing.verifySourceDirectory,
          required: true,
          maximumBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
        });
      }
    }

    const pasteManifestDefinition = fixed.find((definition) => definition.artifact === 'paste_manifest')!;
    const manifestSource = await sourceOrBackup(pasteManifestDefinition);
    const manifestReadPath = manifestSource
      ?? (await leaseAwareFileStatOrNull(
        pasteManifestDefinition.target,
        pasteManifestDefinition.targetLease,
        'unsafe_target',
      ) ? pasteManifestDefinition.target : null);
    if (manifestReadPath) {
      const manifestIsTarget = manifestReadPath === pasteManifestDefinition.target;
      const manifestBuffer = await readBoundedStableFile(
        manifestReadPath,
        MAX_PASTE_MANIFEST_BYTES,
        manifestIsTarget ? 'unsafe_target' : 'unsafe_source',
        hooks,
        manifestIsTarget
          ? pasteManifestDefinition.targetLease
          : pasteManifestDefinition.sourceLease,
      );
      const manifest = parsePasteManifest(manifestBuffer!);
      let pasteLease: WorkspaceStorageDirectoryLease | null = null;
      if (manifest.entries.length > 0) {
        pasteLease = openWorkspacePasteDirectorySync(canonicalRoot, {
          createIfMissing: createTargets,
        });
        leases.push(pasteLease);
      }
      const canonicalPasteRoot = path.join(canonicalRoot, '.cc-web', 'pasted');
      const normalized: PasteManifest = { version: 1, entries: [] };
      const sourcePasteLeases = new Map<string, WorkspaceStorageDirectoryLease>();
      const seenPasteSources = new Set<string>();
      const seenPasteTargets = new Set<string>();
      for (const entry of manifest.entries) {
        const name = path.basename(entry.path);
        const canonicalTarget = path.join(canonicalPasteRoot, name);
        if (seenPasteSources.has(entry.path) || seenPasteTargets.has(canonicalTarget)) {
          throw Object.assign(new Error('Legacy paste manifest contains a duplicate binary'), {
            migrationReason: 'unsafe_source',
          });
        }
        seenPasteSources.add(entry.path);
        seenPasteTargets.add(canonicalTarget);
        const target = path.join(pasteLease!.accessPath, name);
        normalized.entries.push({ path: canonicalTarget, root: canonicalPasteRoot, bytes: entry.bytes });
        if (entry.path === canonicalTarget) {
          definitions.push({
            artifact: 'paste_file',
            key: dynamicArtifactKey('paste_file', canonicalTarget),
            source: target,
            sourceRoot: canonicalRoot,
            target,
            canonicalTarget,
            targetLease: pasteLease!,
            sourceLease: pasteLease!,
            backup: backupPath(canonicalTarget),
            sourceIsTarget: true,
            required: true,
            expectedSourceBytes: entry.bytes,
            maximumBytes: DEFAULT_MAX_PASTE_BYTES,
          });
          continue;
        }
        const sourceRoot = path.dirname(path.dirname(entry.root));
        if (!roots.includes(sourceRoot)) {
          throw Object.assign(new Error('Paste manifest names an unauthorised workspace root'), {
            migrationReason: 'unsafe_source',
          });
        }
        const sourceAvailability = await assertCanonicalSourceRoot(sourceRoot);
        let source = entry.path;
        let safeSourceRoot = sourceRoot;
        let backup = backupPath(entry.path);
        if (sourceAvailability === 'available') {
          let sourceLease = sourcePasteLeases.get(sourceRoot);
          if (!sourceLease) {
            if (sourcePasteLeases.size >= MAX_PASTE_ROOTS) {
              throw Object.assign(new Error('Legacy paste manifest spans too many workspace roots'), {
                migrationReason: 'unsafe_source',
              });
            }
            sourceLease = openWorkspacePasteDirectorySync(sourceRoot, {
              createIfMissing: false,
            });
            if (sourceLease.canonicalPath !== entry.root) {
              sourceLease.close();
              throw Object.assign(new Error('Manifest paste root does not match its pinned directory'), {
                migrationReason: 'unsafe_source',
              });
            }
            sourcePasteLeases.set(sourceRoot, sourceLease);
            leases.push(sourceLease);
          }
          source = path.join(sourceLease.accessPath, name);
          safeSourceRoot = sourceLease.accessPath;
          backup = backupPath(source);
        }
        definitions.push({
          artifact: 'paste_file',
          key: dynamicArtifactKey('paste_file', entry.path),
          source,
          sourceRoot: safeSourceRoot,
          target,
          canonicalTarget,
          targetLease: pasteLease!,
          backup,
          ...(sourceAvailability === 'available' ? {
            sourceLease: sourcePasteLeases.get(sourceRoot)!,
            verifySourceDirectory: sourcePasteLeases.get(sourceRoot)!.verify,
          } : {}),
          required: true,
          expectedSourceBytes: entry.bytes,
          maximumBytes: DEFAULT_MAX_PASTE_BYTES,
        });
      }
      pasteManifestDefinition.targetContents = Buffer.from(JSON.stringify(normalized), 'utf8');
    }

    return { definitions, leases };
  } catch (error) {
    for (const lease of leases.reverse()) lease.close();
    throw error;
  }
}


/**
 * After a rebuild the secondary cwd (and its rollback siblings) may no longer
 * exist, while the verified canonical binaries intentionally survive.  The
 * completed marker still carries one key per original source. Rebind only
 * those recorded keys to the same already-enumerated canonical target; never
 * invent a path or accept a target absent from the current archive.
 */
export function alignCompletedBinaryDefinitions(
  definitions: ArtifactPaths[],
  marker: MigrationMarker,
): ArtifactPaths[] {
  const fixed = definitions.filter((definition) => (
    definition.artifact !== 'attachment_file' && definition.artifact !== 'paste_file'
  ));
  const dynamic = definitions.filter((definition) => (
    definition.artifact === 'attachment_file' || definition.artifact === 'paste_file'
  ));
  const aligned: ArtifactPaths[] = [];

  for (const artifact of ['attachment_file', 'paste_file'] as const) {
    const markerEntries = marker.artifacts.filter((entry) => entry.artifact === artifact);
    const candidates = dynamic.filter((definition) => definition.artifact === artifact);
    const markerTargets = new Set<string>();
    for (const entry of markerEntries) {
      const key = entry.key ?? entry.artifact;
      const name = key.slice(key.lastIndexOf(':') + 1);
      const validName = artifact === 'attachment_file'
        ? STORED_ATTACHMENT_NAME.test(name)
        : PASTED_IMAGE_NAME.test(name);
      if (!validName) return definitions;
      const exact = candidates.find((candidate) => candidate.key === key);
      if (exact) {
        aligned.push(exact);
        markerTargets.add(exact.canonicalTarget);
        continue;
      }
      const canonical = candidates.find(
        (candidate) => path.basename(candidate.canonicalTarget) === name,
      );
      if (!canonical || !canonical.sourceIsTarget) return definitions;
      aligned.push({ ...canonical, key, source: canonical.target });
      markerTargets.add(canonical.canonicalTarget);
    }

    // A real legacy source which appeared after the marker remains a conflict.
    // Only discard the synthetic target-only entry used to rediscover a marker
    // key whose secondary source disappeared during rebuild.
    for (const candidate of candidates) {
      if (markerEntries.some((entry) => (entry.key ?? entry.artifact) === candidate.key)) continue;
      if (candidate.sourceIsTarget && markerTargets.has(candidate.canonicalTarget)) continue;
      aligned.push(candidate);
    }
  }
  return [...fixed, ...aligned];
}

export function overallStatus(entries: LegacyArtifactMigrationEntry[]): LegacySessionArtifactMigrationResult['status'] {
  const failures = entries.filter((entry) => entry.state === 'blocked').length;
  if (failures === 0) return 'complete';
  const progress = entries.some(
    (entry) => entry.state === 'migrated' || entry.state === 'already_migrated',
  );
  return progress ? 'partial' : 'blocked';
}
