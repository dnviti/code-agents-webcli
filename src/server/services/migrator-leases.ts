import fs from 'node:fs';
import path from 'node:path';
import {
  openCanonicalDirectoryLeaseSync,
  workspaceDescriptorRoot,
  type WorkspaceStorageDirectoryLease,
} from './workspace-session-storage.js';
import { inspectWorkspaceCwdDirectory } from './workspace-cwd-helper.js';
import {
  DIRECTORY,
  NO_FOLLOW,
  backupPath,
  lstatOrNull,
  safeComponent,
  sameDirectoryIdentity,
} from './migrator-core.js';
import type {
  ArtifactPaths,
  BigFileStat,
  PinnedFixedArtifactPlan,
  PinnedLegacyDirectoryLease,
} from './migrator-core.js';

export function unsafePinnedLegacyDirectory(message: string): Error {
  return Object.assign(new Error(message), { migrationReason: 'unsafe_legacy_storage' });
}

export function openPinnedLegacyRoot(canonicalPath: string): PinnedLegacyDirectoryLease {
  try {
    return openCanonicalDirectoryLeaseSync(canonicalPath);
  } catch (error) {
    throw Object.assign(error as object, { migrationReason: 'unsafe_legacy_storage' });
  }
}

export function openPinnedLegacyChild(
  parent: PinnedLegacyDirectoryLease,
  component: string,
): PinnedLegacyDirectoryLease | null {
  parent.verify();
  safeComponent(component, 'legacy directory component');
  const canonicalPath = path.join(parent.canonicalPath, component);
  const lookupPath = path.join(parent.accessPath, component);
  let helperIdentity: { dev: bigint; ino: bigint } | undefined;
  let visible: BigFileStat | undefined;
  if (parent.entryMutationPolicy === 'cwd-helper') {
    try {
      helperIdentity = inspectWorkspaceCwdDirectory(parent, component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  } else {
    try {
      visible = fs.lstatSync(canonicalPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (visible.isSymbolicLink() || !visible.isDirectory()) {
      throw unsafePinnedLegacyDirectory('Legacy storage component is not a real directory');
    }
  }
  const fd = fs.openSync(lookupPath, fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY);
  const descriptorRoot = workspaceDescriptorRoot();
  const accessPath = descriptorRoot ? path.join(descriptorRoot, String(fd)) : canonicalPath;
  let closed = false;
  const verify = (): void => {
    if (closed) throw unsafePinnedLegacyDirectory('Legacy storage descriptor is closed');
    parent.verify();
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(canonicalPath, { bigint: true });
    if (
      current.isSymbolicLink()
      || fs.realpathSync(canonicalPath) !== canonicalPath
      || (helperIdentity
        ? opened.dev !== helperIdentity.dev || opened.ino !== helperIdentity.ino
        : !sameDirectoryIdentity(visible!, opened))
      || !sameDirectoryIdentity(opened, current)
      || (accessPath !== canonicalPath && fs.realpathSync(accessPath) !== canonicalPath)
    ) {
      throw unsafePinnedLegacyDirectory('Legacy storage component changed while pinned');
    }
  };
  try {
    verify();
    return {
      canonicalPath,
      accessPath,
      fd,
      pathFallback: accessPath === canonicalPath,
      entryMutationPolicy: parent.entryMutationPolicy,
      verify,
      close(): void {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    closed = true;
    fs.closeSync(fd);
    throw error;
  }
}

export function pinFixedArtifactDefinitions(
  legacyRoot: string,
  definitions: ArtifactPaths[],
): PinnedFixedArtifactPlan {
  const leases: PinnedLegacyDirectoryLease[] = [];
  const cache = new Map<string, PinnedLegacyDirectoryLease | null>();
  try {
    const root = openPinnedLegacyRoot(legacyRoot);
    leases.push(root);
    cache.set(legacyRoot, root);

    const openDirectory = (canonicalDirectory: string): PinnedLegacyDirectoryLease | null => {
      const cached = cache.get(canonicalDirectory);
      if (cached !== undefined || cache.has(canonicalDirectory)) return cached ?? null;
      const relative = path.relative(legacyRoot, canonicalDirectory);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw unsafePinnedLegacyDirectory('Legacy artifact parent leaves the pinned root');
      }
      let current: PinnedLegacyDirectoryLease | null = root;
      let canonicalCursor = legacyRoot;
      for (const component of relative.split(path.sep).filter(Boolean)) {
        canonicalCursor = path.join(canonicalCursor, component);
        const known = cache.get(canonicalCursor);
        if (known !== undefined || cache.has(canonicalCursor)) {
          current = known ?? null;
          if (!current) break;
          continue;
        }
        if (!current) {
          cache.set(canonicalCursor, null);
          continue;
        }
        const child = openPinnedLegacyChild(current, component);
        cache.set(canonicalCursor, child);
        if (child) leases.push(child);
        current = child;
      }
      return current;
    };

    return {
      definitions: definitions.map((definition) => {
        const canonicalParent = path.dirname(definition.source);
        const parent = openDirectory(canonicalParent);
        if (!parent) return { ...definition, sourceDirectoryMissing: true };
        const source = path.join(parent.accessPath, path.basename(definition.source));
        return {
          ...definition,
          source,
          sourceRoot: parent.accessPath,
          backup: backupPath(source),
          sourceLease: parent,
          verifySourceDirectory: parent.verify,
        };
      }),
      leases,
    };
  } catch (error) {
    for (const lease of leases.reverse()) lease.close();
    throw error;
  }
}

export async function assertSafeDirectoryTree(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Path leaves legacy storage'), {
      migrationReason: 'unsafe_source',
    });
  }

  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw Object.assign(new Error('Unsafe legacy storage component'), {
        migrationReason: 'unsafe_source',
      });
    }
  }
}

export async function assertCanonicalSourceRoot(root: string): Promise<'available' | 'absent'> {
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw Object.assign(new Error('Unsafe legacy workspace root'), {
      migrationReason: 'unsafe_source',
    });
  }
  let lease: WorkspaceStorageDirectoryLease;
  try {
    lease = openCanonicalDirectoryLeaseSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw Object.assign(error as object, { migrationReason: 'unsafe_source' });
  }
  try { lease.verify(); return 'available'; } finally { lease.close(); }
}

export async function validateLegacyRoot(legacyRoot: string): Promise<'available' | 'absent'> {
  if (legacyRoot === path.parse(legacyRoot).root) {
    throw Object.assign(new Error('Filesystem root cannot be legacy storage'), {
      migrationReason: 'unsafe_legacy_storage',
    });
  }
  let lease: WorkspaceStorageDirectoryLease;
  try {
    lease = openCanonicalDirectoryLeaseSync(legacyRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw Object.assign(error as object, { migrationReason: 'unsafe_legacy_storage' });
  }
  try { lease.verify(); return 'available'; } finally { lease.close(); }
}
