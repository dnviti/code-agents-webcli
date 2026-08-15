import fs from 'node:fs';
import path from 'node:path';
import type {
  WorkspaceEntryMutationPolicy,
  WorkspaceStorageIdentity,
} from './workspace-session-storage.js';
import {
  openWorkspaceSessionDirectoryOffThread,
  type WorkspaceSessionDirectoryOpenRef,
} from './workspace-session-directory-async.js';

export interface WorkspaceSessionFileParentLease {
  readonly canonicalPath: string;
  readonly accessPath: string;
  readonly fd: number;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceEntryMutationPolicy;
  /** Immutable identity captured when the verified descriptor was admitted. */
  readonly identity: Readonly<WorkspaceStorageIdentity>;
  verify(): void;
  /** Keep the descriptor open until the returned idempotent release runs. */
  retain(): () => void;
}

export interface SessionDirectoryLeaseRecord {
  readonly fd: number;
  readonly accessPath: string;
  readonly pathFallback: boolean;
  readonly entryMutationPolicy: WorkspaceEntryMutationPolicy;
  readonly identity: Readonly<WorkspaceStorageIdentity>;
  readonly verify: () => void;
  holds: number;
  closeRequested: boolean;
  closed: boolean;
}

const leases = new Map<string, SessionDirectoryLeaseRecord>();
interface OpeningSessionDirectoryLease {
  cancelled: boolean;
  promise: Promise<string>;
}
const openingLeases = new Map<string, OpeningSessionDirectoryLease>();
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const DIRECTORY = (fs.constants as unknown as Record<string, number>).O_DIRECTORY ?? 0;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW | DIRECTORY;

function unsafe(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE' });
}

function closeRetired(lease: SessionDirectoryLeaseRecord): void {
  if (lease.closed || !lease.closeRequested || lease.holds !== 0) return;
  lease.closed = true;
  try { fs.closeSync(lease.fd); } catch { /* Idempotent teardown. */ }
}

function retain(canonicalPath: string, lease: SessionDirectoryLeaseRecord): () => void {
  if (lease.closeRequested || lease.closed) {
    throw unsafe(`Workspace session directory lease is no longer available: ${canonicalPath}`);
  }
  lease.holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.holds -= 1;
    closeRetired(lease);
  };
}

export function cachedSessionDirectoryLease(
  canonicalPath: string,
): SessionDirectoryLeaseRecord | undefined {
  return leases.get(canonicalPath);
}

export function admitSessionDirectoryLease(
  canonicalPath: string,
  lease: Omit<SessionDirectoryLeaseRecord, 'identity' | 'holds' | 'closeRequested' | 'closed'>,
  expectedIdentity?: WorkspaceStorageIdentity,
): void {
  const admitted = fs.fstatSync(lease.fd, { bigint: true });
  if (!admitted.isDirectory() || admitted.ino === 0n
    || (expectedIdentity
      && (admitted.dev !== expectedIdentity.dev || admitted.ino !== expectedIdentity.ino))) {
    throw unsafe(`Workspace session descriptor has no stable directory identity: ${canonicalPath}`);
  }
  leases.set(canonicalPath, {
    ...lease,
    identity: Object.freeze({ dev: admitted.dev, ino: admitted.ino }),
    holds: 0,
    closeRequested: false,
    closed: false,
  });
}

/** Detach a worker-local record so its exact descriptor can be closed explicitly. */
export function detachSessionDirectoryLease(
  canonicalPath: string,
): SessionDirectoryLeaseRecord | null {
  const lease = leases.get(canonicalPath);
  if (!lease || lease.holds !== 0 || lease.closeRequested || lease.closed) return null;
  leases.delete(canonicalPath);
  return lease;
}

async function establishSessionDirectoryLease(
  canonicalPath: string,
  ref: WorkspaceSessionDirectoryOpenRef,
  openSynchronously: () => string,
  verify: (canonicalPath: string, fd: number, accessPath: string) => void,
  opening: OpeningSessionDirectoryLease,
): Promise<string> {
  if (process.platform !== 'win32') return openSynchronously();

  const opened = await openWorkspaceSessionDirectoryOffThread(ref);
  if (opening.cancelled) {
    throw unsafe(`Workspace session directory opening was retired: ${canonicalPath}`);
  }
  const raced = leases.get(canonicalPath);
  if (raced) {
    if (raced.entryMutationPolicy !== 'cwd-helper') raced.verify();
    return raced.accessPath;
  }

  let fd: number | null = null;
  let adopted = false;
  try {
    if (opened.canonicalPath !== canonicalPath
      || opened.accessPath !== canonicalPath
      || opened.pathFallback !== true
      || opened.entryMutationPolicy !== 'cwd-helper'
      || !/^\d{1,32}$/.test(opened.identity.dev)
      || !/^[1-9]\d{0,31}$/.test(opened.identity.ino)) {
      throw unsafe('Workspace session directory worker returned an invalid lease');
    }
    const identity = { dev: BigInt(opened.identity.dev), ino: BigInt(opened.identity.ino) };
    // The worker establishes the hierarchy and reports the exact inode. Open a
    // main-thread capability only after that slow work; an attacker replacing
    // the name in between is rejected by both the canonical binding proof and
    // the worker's immutable identity rather than silently rebound.
    fd = fs.openSync(canonicalPath, DIRECTORY_FLAGS);
    verify(canonicalPath, fd, opened.accessPath);
    admitSessionDirectoryLease(canonicalPath, {
      fd,
      accessPath: opened.accessPath,
      pathFallback: opened.pathFallback,
      entryMutationPolicy: opened.entryMutationPolicy,
      verify: () => verify(canonicalPath, fd!, opened.accessPath),
    }, identity);
    adopted = true;
    return opened.accessPath;
  } finally {
    if (!adopted && fd !== null) {
      try { fs.closeSync(fd); } catch { /* Failed adoption owns no reusable fd. */ }
    }
  }
}

/** Establish the cold Windows lease off-thread, or verify the cached capability. */
export async function ensureSessionDirectoryLease(
  canonicalPath: string,
  ref: WorkspaceSessionDirectoryOpenRef,
  openSynchronously: () => string,
  verify: (canonicalPath: string, fd: number, accessPath: string) => void,
): Promise<string> {
  const cached = leases.get(canonicalPath);
  if (cached) {
    if (cached.entryMutationPolicy !== 'cwd-helper') cached.verify();
    return cached.accessPath;
  }
  const pending = openingLeases.get(canonicalPath);
  if (pending) return pending.promise;

  const opening = { cancelled: false } as OpeningSessionDirectoryLease;
  opening.promise = establishSessionDirectoryLease(
    canonicalPath, ref, openSynchronously, verify, opening,
  ).finally(() => {
    if (openingLeases.get(canonicalPath) === opening) openingLeases.delete(canonicalPath);
  });
  openingLeases.set(canonicalPath, opening);
  return opening.promise;
}

export async function retireSessionDirectoryLease(canonicalPath: string): Promise<void> {
  const opening = openingLeases.get(canonicalPath);
  if (opening) opening.cancelled = true;
  const lease = leases.get(canonicalPath);
  if (lease) {
    leases.delete(canonicalPath);
    if (!lease.closeRequested) lease.closeRequested = true;
    closeRetired(lease);
  }
  // Cancellation prevents adoption; awaiting the same promise is the
  // quiescence barrier. A project/session lifecycle caller must not move or
  // remove the hierarchy while its worker can still create a child beneath it.
  if (opening) await opening.promise.catch(() => undefined);
}

export async function retireSessionDirectoryLeasesBelow(parentDirectory: string): Promise<void> {
  const prefix = `${parentDirectory}${path.sep}`;
  const retiring: Promise<void>[] = [];
  for (const [canonicalPath, opening] of openingLeases) {
    if (!canonicalPath.startsWith(prefix)) continue;
    opening.cancelled = true;
    retiring.push(opening.promise.then(() => undefined, () => undefined));
  }
  for (const canonicalPath of [...leases.keys()]) {
    if (canonicalPath.startsWith(prefix)) retiring.push(retireSessionDirectoryLease(canonicalPath));
  }
  await Promise.all(retiring);
}

export async function closeWorkspaceSessionDirectoryLeases(): Promise<void> {
  const retiring: Promise<void>[] = [];
  for (const opening of openingLeases.values()) {
    opening.cancelled = true;
    retiring.push(opening.promise.then(() => undefined, () => undefined));
  }
  for (const canonicalPath of [...leases.keys()]) {
    retiring.push(retireSessionDirectoryLease(canonicalPath));
  }
  await Promise.all(retiring);
}

/** Return a retained-parent capability only for an exact live session child. */
export function workspaceSessionFileParentLease(
  file: string,
): WorkspaceSessionFileParentLease | null {
  if (!path.isAbsolute(file)) return null;
  const parent = path.dirname(file);
  for (const [canonicalPath, lease] of leases) {
    if (parent !== canonicalPath && parent !== lease.accessPath) continue;
    return {
      canonicalPath,
      accessPath: lease.accessPath,
      fd: lease.fd,
      pathFallback: lease.pathFallback,
      entryMutationPolicy: lease.entryMutationPolicy,
      identity: lease.identity,
      verify: lease.verify,
      retain: () => retain(canonicalPath, lease),
    };
  }
  return null;
}
