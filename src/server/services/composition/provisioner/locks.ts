import path from 'node:path';
import fsp from 'node:fs/promises';

export interface OwnerToolVersionLock {
  ownerHomeHost: string;
  /** Composition installation key (`node`, `gh`, `tea`), not a display label. */
  tool: string;
  version: string;
}

/**
 * Process-wide because one runtime application constructs a fresh provisioner.
 * The queue is deliberately narrower than a composition: projects sharing one
 * durable home serialize only the exact tool/version they would mutate.
 */
const sharedInstallationLocks = new Map<string, Promise<void>>();
/** Owner-wide mise mutations that enumerate or publish durable installs/shims. */
const sharedMiseMutationLocks = new Map<string, Promise<void>>();
/** Exact app-owned destination paths serialize their final atomic rename. */
export const sharedPublicationLocks = new Map<string, Promise<void>>();

/**
 * Coordinate install and cleanup for one durable tool version. Cleanup callers
 * must recheck their database reference set inside `operation` before deleting:
 * reaching the callback proves every earlier install/cleanup for this key ended.
 */
export async function withOwnerToolVersionLock<T>(
  input: OwnerToolVersionLock,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.tool)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input.version)) {
    throw new Error('owner tool version lock is invalid');
  }
  const ownerHome = await canonicalOwnerHome(input.ownerHomeHost);
  const key = JSON.stringify([ownerHome, input.tool, input.version]);
  return withSharedQueue(sharedInstallationLocks, key, operation);
}

/**
 * Serialize owner-wide mise mutation such as shared reshim and version cleanup.
 * When an exact version lock is also needed, callers must acquire that first.
 */
export async function withOwnerMiseMutationLock<T>(
  ownerHomeHost: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerHome = await canonicalOwnerHome(ownerHomeHost);
  return withSharedQueue(sharedMiseMutationLocks, ownerHome, operation);
}

async function canonicalOwnerHome(ownerHomeHost: string): Promise<string> {
  let ownerHome = path.resolve(ownerHomeHost);
  try {
    ownerHome = await fsp.realpath(ownerHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return ownerHome;
}

export async function withSharedQueue<T>(
  registry: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registry.get(key) || Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => slot);
  registry.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (registry.get(key) === tail) registry.delete(key);
  }
}
