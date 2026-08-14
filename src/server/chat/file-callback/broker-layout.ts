import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  assertDirectory,
  childAccessPath,
  cleanupOpenedFlat,
  openChildDirectory,
  safeCleanupFlat,
  safeRmdir,
  safeUnlink,
  setDirectoryMode,
  withDirectory,
} from './fs.js';
import {
  BrokerLayout,
  CriticalDirectoryName,
  DirectoryRef,
  ENDPOINT_NAME,
  OpenDirectory,
} from './types.js';

export async function assertBrokerLayout(layout: BrokerLayout): Promise<void> {
  await assertDirectory(layout.base);
  await assertDirectory(layout.endpoint);
  await Promise.all([
    assertDirectory(layout.requests),
    assertDirectory(layout.replies),
    assertDirectory(layout.cancelled),
    assertDirectory(layout.pi),
    assertDirectory(layout.piCcweb),
  ]);
}

export async function removeKnownEndpoint(layout: BrokerLayout): Promise<void> {
  // A replaced critical directory makes the whole endpoint untrusted. Leave it
  // for a later non-following stale prune instead of touching an attacker path.
  await assertBrokerLayout(layout);
  await Promise.all([
    setDirectoryMode(layout.endpoint, 0o700),
    setDirectoryMode(layout.pi, 0o700),
    setDirectoryMode(layout.piCcweb, 0o700),
  ]);
  await Promise.all([
    safeCleanupFlat(layout.requests),
    safeCleanupFlat(layout.replies),
    safeCleanupFlat(layout.cancelled),
    safeCleanupFlat(layout.piCcweb),
  ]);
  await safeUnlink(layout.endpoint, path.join(layout.endpoint.path, 'ccweb-mcp.mjs'));
  await safeRmdir(layout.pi, 'ccweb', layout.piCcweb);
  await safeRmdir(layout.endpoint, '.pi', layout.pi);
  for (const folder of [layout.requests, layout.replies, layout.cancelled]) {
    await safeRmdir(layout.endpoint, path.basename(folder.path), folder);
  }
  await safeRmdir(layout.base, path.basename(layout.endpoint.path), layout.endpoint);
}

export async function cleanOpenedChildDirectory(parent: OpenDirectory, name: string): Promise<void> {
  const target = childAccessPath(parent, name);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await fsp.unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  const child = await openChildDirectory(parent, name, { dev: stat.dev, ino: stat.ino });
  try {
    await child.handle.chmod(0o700);
    await cleanupOpenedFlat(child);
    await fsp.rmdir(target).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code || '')) throw error;
    });
  } finally {
    await child.handle.close();
  }
}

export async function pruneOpenedStaleEndpoint(
  base: OpenDirectory,
  endpoint: OpenDirectory,
  endpointName: string,
): Promise<void> {
  await endpoint.handle.chmod(0o700);
  for (const folder of ['requests', 'replies', 'cancelled'] as CriticalDirectoryName[]) {
    await cleanOpenedChildDirectory(endpoint, folder);
  }
  const piTarget = childAccessPath(endpoint, '.pi');
  const piStat = await fsp.lstat(piTarget).catch(() => null);
  if (piStat?.isDirectory() && !piStat.isSymbolicLink()) {
    const pi = await openChildDirectory(endpoint, '.pi', { dev: piStat.dev, ino: piStat.ino });
    try {
      await pi.handle.chmod(0o700);
      await cleanOpenedChildDirectory(pi, 'ccweb');
      await cleanupOpenedFlat(pi);
      await fsp.rmdir(piTarget).catch(() => undefined);
    } finally {
      await pi.handle.close();
    }
  } else if (piStat) {
    await fsp.unlink(piTarget).catch(() => undefined);
  }
  const entries = await fsp.readdir(endpoint.accessPath);
  for (const entry of entries) {
    const child = childAccessPath(endpoint, entry);
    const stat = await fsp.lstat(child).catch(() => null);
    if (stat && !stat.isDirectory()) await fsp.unlink(child).catch(() => undefined);
  }
  await fsp.rmdir(childAccessPath(base, endpointName)).catch(() => undefined);
}

export async function pruneStaleEndpoints(base: DirectoryRef, before: number): Promise<void> {
  await withDirectory(base, 'cleanup', async (openedBase) => {
    const entries = await fsp.readdir(openedBase.accessPath);
    for (const entry of entries) {
      if (!ENDPOINT_NAME.test(entry)) continue;
      const target = childAccessPath(openedBase, entry);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        if (stat.mtimeMs < before) await fsp.unlink(target).catch(() => undefined);
        continue;
      }
      const endpoint = await openChildDirectory(openedBase, entry, { dev: stat.dev, ino: stat.ino })
        .catch(() => null);
      if (!endpoint) continue;
      try {
        let freshest = stat.mtimeMs;
        for (const folder of ['requests', 'replies', 'cancelled', '.pi']) {
          const child = await fsp.lstat(childAccessPath(endpoint, folder)).catch(() => null);
          if (child) freshest = Math.max(freshest, child.mtimeMs);
        }
        if (freshest < before) {
          await pruneOpenedStaleEndpoint(openedBase, endpoint, entry).catch(() => undefined);
        }
      } finally {
        await endpoint.handle.close();
      }
    }
  });
}
