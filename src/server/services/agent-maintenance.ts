import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UserEnvironment } from './environments/types.js';
import {
  agentCatalogEntry, agentSupported, AgentArchitecture, AgentCheckState, AgentInstallState,
  AgentMaintenanceCatalogEntry, AgentMaintenanceId, AgentMaintenanceOperation, AgentMaintenanceStatus,
  AgentPlatform,
} from '../../shared/agent-maintenance.js';

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5_000;
const COMPLETED_OUTCOME_RETENTION_MS = 10 * 60 * 1000;

export interface AgentMaintenanceTarget {
  /** Opaque, traversal-safe identity including server, execution environment and ownership scope. */
  key: string;
  platform: AgentPlatform;
  architecture: AgentArchitecture;
  scope: 'private' | 'shared';
  ownerUserId: number | null;
  projectManaged?: boolean;
  /** Version verified for the process already running in the opened session. */
  runningVersion?: string | null;
  runningAgentId?: AgentMaintenanceId;
}
export interface AgentMaintenanceStore {
  loadOperations(): AgentMaintenanceOperation[];
  saveOperation(operation: AgentMaintenanceOperation): void;
  loadCheck(targetKey: string, agentId: AgentMaintenanceId): AgentCheckRecord | null;
  saveCheck(record: AgentCheckRecord): void;
}
export interface AgentCheckRecord { targetKey: string; agentId: AgentMaintenanceId; latestVersion: string | null; state: Exclude<AgentCheckState, 'checking'>; checkedAt: number; }
export interface AgentProbe { locate(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry): Promise<{ state: AgentInstallState; version: string | null; managedVersion?: string | null }>; version(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, root: string): Promise<string | null>; }
export interface AgentReleaseSource { latest(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, signal: AbortSignal): Promise<{ version: string; prerelease?: boolean } | null>; }
export interface AgentInstaller {
  install(input: {
    target: AgentMaintenanceTarget;
    agent: AgentMaintenanceCatalogEntry;
    stagingRoot: string;
    version: string;
    environment: Record<string, string>;
    signal: AbortSignal;
    /** Called after downloads finish, immediately before local installation. */
    onInstalling?(): void;
  }): Promise<void>;
  activate(input: { target: AgentMaintenanceTarget; agent: AgentMaintenanceCatalogEntry; stagingRoot: string; version: string }): Promise<void>;
  /** Best-effort removal for cancelled or failed attempts. */
  discard?(input: { target: AgentMaintenanceTarget; agent: AgentMaintenanceCatalogEntry; stagingRoot: string }): Promise<void>;
}
export interface AgentMaintenanceOptions { store: AgentMaintenanceStore; probe: AgentProbe; releases: AgentReleaseSource; installer: AgentInstaller; rootFor(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, version: string): string; now?: () => number; /** Test seam; production is clamped to five seconds. */ checkTimeoutMs?: number; }

/** Derive opaque, app-owned paths; target keys and release values never become path segments. */
export function managedVersionRoot(appRoot: string, target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(version)) throw new Error('Unsafe official version identifier.');
  const identity = createHash('sha256').update(target.key).digest('hex');
  // Publisher installers create caches, package trees and atomic temp names
  // beneath this root. A full SHA-256 directory plus redundant layout segments
  // pushed ordinary Windows installs beyond legacy MAX_PATH consumers. A
  // 96-bit opaque identity remains collision-resistant while keeping all
  // publisher-visible paths comfortably shorter.
  return path.join(appRoot, 'agent-maintenance', identity.slice(0, 24), agent.id, version);
}
export function managedInstallEnvironment(stagingRoot: string): Record<string, string> {
  return { HOME: path.join(stagingRoot, 'home'), npm_config_prefix: path.join(stagingRoot, 'prefix') };
}

/** Exact execution identity used by caches, operations, and active pointers. */
export function agentMaintenanceExecutionKey(
  ownerUserId: number,
  environment: UserEnvironment,
): string {
  if (environment.kind === 'host') return 'host:shared';
  if (!environment.identity) {
    throw new Error('The private execution environment has no immutable identity.');
  }
  return `private:${ownerUserId}:${environment.identity}`;
}

function allowed(target: AgentMaintenanceTarget, userId: number, installerUserId: number | null): string | null {
  if (target.projectManaged) return 'This agent is managed by the project. Update it through that project’s rebuild flow.';
  if (target.scope === 'private' && target.ownerUserId === userId) return null;
  if (target.scope === 'shared' && installerUserId === userId) return null;
  return target.scope === 'shared' ? 'Only the installer account can change this shared host.' : 'This private environment belongs to another user.';
}

export class AgentMaintenanceService {
  private readonly now: () => number;
  private readonly operations = new Map<string, AgentMaintenanceOperation>();
  private readonly active = new Map<string, {
    operationId: string;
    promise: Promise<AgentMaintenanceOperation>;
  }>();
  private readonly checks = new Map<string, Promise<AgentCheckRecord>>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly deps: AgentMaintenanceOptions) {
    this.now = deps.now ?? (() => Date.now());
    for (const operation of deps.store.loadOperations()) {
      if (!['complete', 'failed', 'cancelled'].includes(operation.phase)) {
        const recovered = { ...operation, phase: 'failed' as const, error: 'Interrupted by server restart; retry the operation.', retryable: true, canCancel: false, cancelReason: 'The previous operation is no longer running.', updatedAt: this.now() };
        this.operations.set(recovered.id, recovered); deps.store.saveOperation(recovered);
      } else this.operations.set(operation.id, operation);
    }
  }
  private supported(target: AgentMaintenanceTarget, entry: AgentMaintenanceCatalogEntry): string | null { return agentSupported(entry, target.platform, target.architecture) ? null : entry.manualGuidance; }
  private platformGuidance(target: AgentMaintenanceTarget, entry: AgentMaintenanceCatalogEntry): string | null { return entry.platformSupport.find((support) => support.platform === target.platform && support.architectures.includes(target.architecture))?.guidance ?? null; }
  async status(target: AgentMaintenanceTarget, agentId: AgentMaintenanceId, userId: number, installerUserId: number | null): Promise<AgentMaintenanceStatus> {
    const agent = agentCatalogEntry(agentId); if (!agent) throw new Error('Unknown agent');
    const runningVersion = target.runningAgentId === agentId ? target.runningVersion : undefined;
    const located = target.projectManaged
      ? { state: 'project_managed' as const, version: runningVersion ?? null, managedVersion: null }
      : await this.deps.probe.locate(target, agent);
    const permission = allowed(target, userId, installerUserId); const unsupported = this.supported(target, agent);
    const check = this.deps.store.loadCheck(target.key, agentId);
    return { agentId, state: target.projectManaged ? 'project_managed' : located.state, version: runningVersion !== undefined ? runningVersion : located.version, managedVersion: located.managedVersion ?? null, check: target.projectManaged ? 'current' : this.checks.has(`${target.key}:${agentId}`) ? 'checking' : check?.state ?? 'unable_to_check', latestVersion: target.projectManaged ? null : check?.latestVersion ?? null, checkedAt: target.projectManaged ? null : check?.checkedAt ?? null, canInstall: !permission && !unsupported && !target.projectManaged && located.state !== 'external', canManageCopy: !permission && !unsupported && !target.projectManaged && located.state === 'external', requiresConfirmation: target.scope === 'shared' && !target.projectManaged, disabledReason: permission ?? unsupported, guidance: unsupported ?? (target.projectManaged ? allowed(target, userId, installerUserId) : this.platformGuidance(target, agent)) };
  }
  async check(target: AgentMaintenanceTarget, agentId: AgentMaintenanceId, force = false): Promise<AgentCheckRecord> {
    const agent = agentCatalogEntry(agentId); if (!agent) throw new Error('Unknown agent');
    const cached = this.deps.store.loadCheck(target.key, agentId); if (!force && cached && this.now() - cached.checkedAt < CHECK_TTL_MS) return cached;
    const key = `${target.key}:${agentId}`; const pending = this.checks.get(key); if (pending) return pending;
    const work = this.performCheck(target, agent).finally(() => this.checks.delete(key)); this.checks.set(key, work); return work;
  }
  private async performCheck(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry): Promise<AgentCheckRecord> {
    if (target.projectManaged) {
      return this.saveCheck({ targetKey: target.key, agentId: agent.id, latestVersion: null, state: 'current', checkedAt: this.now() });
    }
    const unsupported = this.supported(target, agent);
    if (unsupported) return this.saveCheck({ targetKey: target.key, agentId: agent.id, latestVersion: null, state: 'unable_to_check', checkedAt: this.now() });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(CHECK_TIMEOUT_MS, this.deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS));
    try {
      const work = (async (): Promise<Omit<AgentCheckRecord, 'checkedAt'>> => {
        const release = await this.deps.releases.latest(target, agent, controller.signal);
        if (!release || (release.prerelease && agent.channel === 'stable')) {
          return { targetKey: target.key, agentId: agent.id, latestVersion: null, state: 'unable_to_check' };
        }
        const installed = await this.deps.probe.locate(target, agent);
        const installedVersion = installed.version ?? installed.managedVersion ?? null;
        return {
          targetKey: target.key,
          agentId: agent.id,
          latestVersion: release.version,
          state: installed.state !== 'missing' && !installedVersion
            ? 'unable_to_check'
            : sameVersionOrNewer(installedVersion, release.version)
              ? 'current'
              : 'update_available',
        };
      })();
      const result = await Promise.race([
        work,
        new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
      return this.saveCheck(result
        ? { ...result, checkedAt: this.now() }
        : { targetKey: target.key, agentId: agent.id, latestVersion: null, state: 'unable_to_check', checkedAt: this.now() });
    }
    catch { return this.saveCheck({ targetKey: target.key, agentId: agent.id, latestVersion: null, state: 'unable_to_check', checkedAt: this.now() }); }
    finally { clearTimeout(timer); }
  }
  /** Starts a durable operation immediately; clients can restore it by id after navigation. */
  start(target: AgentMaintenanceTarget, agentId: AgentMaintenanceId, userId: number, installerUserId: number | null, kind: 'install' | 'update' = 'install'): AgentMaintenanceOperation {
    const agent = agentCatalogEntry(agentId); if (!agent) throw new Error('Unknown agent'); const reason = allowed(target, userId, installerUserId) ?? this.supported(target, agent); if (reason) throw new Error(reason);
    const key = `${target.key}:${agentId}`; const running = this.active.get(key); if (running) { const operation = this.operations.get(running.operationId); if (operation) return operation; throw new Error('An agent operation is still settling.'); }
    for (const [id, previous] of this.operations) {
      if (previous.targetKey === target.key && previous.agentId === agentId) this.operations.delete(id);
    }
    const op: AgentMaintenanceOperation = { id: randomUUID(), targetKey: target.key, ownerUserId: userId, agentId, kind, phase: 'queued', createdAt: this.now(), updatedAt: this.now(), version: null, error: null, retryable: false, canCancel: true, cancelReason: null }; this.persist(op);
    const promise = this.run(target, agent, op).finally(() => {
      if (this.active.get(key)?.operationId === op.id) this.active.delete(key);
    });
    this.active.set(key, { operationId: op.id, promise }); return op;
  }
  private saveCheck(record: AgentCheckRecord): AgentCheckRecord { this.deps.store.saveCheck(record); return record; }
  operation(id: string): AgentMaintenanceOperation | null { return this.operations.get(id) ?? null; }
  cancel(id: string): AgentMaintenanceOperation | null { const operation = this.operations.get(id); if (!operation) return null; if (!operation.canCancel) return operation; this.controllers.get(id)?.abort(); const next = { ...operation, phase: 'cancelled' as const, canCancel: false, cancelReason: 'Cancelled before activation.', updatedAt: this.now() }; this.persist(next); return next; }
  async install(target: AgentMaintenanceTarget, agentId: AgentMaintenanceId, userId: number, installerUserId: number | null, kind: 'install' | 'update' = 'install'): Promise<AgentMaintenanceOperation> {
    const operation = this.start(target, agentId, userId, installerUserId, kind);
    const active = this.active.get(`${target.key}:${agentId}`); return active?.promise ?? operation;
  }
  private async run(target: AgentMaintenanceTarget, agent: AgentMaintenanceCatalogEntry, initial: AgentMaintenanceOperation): Promise<AgentMaintenanceOperation> {
    let op = initial;
    let root: string | null = null;
    let preserveFailedRoot = false;
    const controller = new AbortController(); this.controllers.set(op.id, controller);
    try {
      const release = await this.deps.releases.latest(target, agent, controller.signal);
      const afterRelease = this.operation(op.id);
      if (afterRelease?.phase === 'cancelled') return afterRelease;
      if (!release || (release.prerelease && agent.channel === 'stable')) throw new Error('No eligible official stable release is available.');
      op = this.advance(op, 'downloading', release.version);
      root = path.join(this.deps.rootFor(target, agent, release.version), 'attempts', op.id.replace(/-/gu, ''));
      await this.deps.installer.install({
        target,
        agent,
        stagingRoot: root,
        version: release.version,
        environment: managedInstallEnvironment(root),
        signal: controller.signal,
        onInstalling: () => {
          const current = this.operation(op.id);
          if (current && current.phase !== 'cancelled') op = this.advance(current, 'installing');
        },
      });
      const afterInstall = this.operation(op.id);
      if (afterInstall?.phase === 'cancelled') return afterInstall;
      op = this.advance(op, 'verifying');
      const verified = normalizedVersion(await this.deps.probe.version(target, agent, root));
      const afterVerification = this.operation(op.id);
      if (afterVerification?.phase === 'cancelled') return afterVerification;
      if (!verified) {
        const guidance = this.platformGuidance(target, agent);
        throw new Error(`The managed copy did not provide a normalized version.${guidance ? ` ${guidance}` : ''}`);
      }
      if (!sameVersion(verified, release.version)) throw new Error(`The managed copy reported ${verified}, not the selected official release ${release.version}.`);
      op = this.advance(op, 'activating', verified);
      op = { ...op, canCancel: false, cancelReason: 'Activation begins only after a known-good copy is verified.' };
      this.persist(op);
      await this.deps.installer.activate({ target, agent, stagingRoot: root, version: verified });
      this.saveCheck({ targetKey: target.key, agentId: agent.id, latestVersion: verified, state: 'current', checkedAt: this.now() });
      op = this.advance(op, 'complete');
      const completedId = op.id;
      const expiry = setTimeout(() => {
        if (this.operations.get(completedId)?.phase === 'complete') this.operations.delete(completedId);
      }, COMPLETED_OUTCOME_RETENTION_MS);
      expiry.unref?.();
      return op;
    }
    catch (error) { preserveFailedRoot = (error as { preserveStaging?: unknown })?.preserveStaging === true; const cancelled = this.operation(op.id); if (cancelled?.phase === 'cancelled') { if (preserveFailedRoot) { const cleanupFailed = { ...cancelled, error: error instanceof Error ? error.message : 'Windows PATH cleanup failed after cancellation.', retryable: true, cancelReason: 'Cancellation finished, but managed PATH cleanup requires a retry.', updatedAt: this.now() }; this.persist(cleanupFailed); return cleanupFailed; } return cancelled; } op = { ...op, phase: 'failed', error: error instanceof Error ? error.message : 'Installation failed.', retryable: true, canCancel: false, cancelReason: 'The operation has finished.', updatedAt: this.now() }; this.persist(op); return op; }
    finally {
      this.controllers.delete(op.id);
      if (root && this.operation(op.id)?.phase !== 'complete' && !preserveFailedRoot) {
        try { await this.deps.installer.discard?.({ target, agent, stagingRoot: root }); } catch { /* best effort */ }
      }
    }
  }
  private advance(op: AgentMaintenanceOperation, phase: AgentMaintenanceOperation['phase'], version: string | null = op.version): AgentMaintenanceOperation { const next = { ...op, phase, version, updatedAt: this.now() }; this.persist(next); return next; }
  private persist(operation: AgentMaintenanceOperation): void { this.operations.set(operation.id, operation); this.deps.store.saveOperation(operation); }
}

function normalizedVersion(value: string | null): string | null { if (!value) return null; const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').trim().replace(/^v/i, ''); return /^[0-9]+(?:\.[0-9A-Za-z.+-]+)+$/u.test(clean) ? clean : null; }
function sameVersion(left: string | null, right: string): boolean { return normalizedVersion(left) === normalizedVersion(right); }
function sameVersionOrNewer(left: string | null, right: string): boolean {
  const installed = normalizedVersion(left);
  const available = normalizedVersion(right);
  if (!installed || !available) return false;
  if (installed === available) return true;
  const parsedInstalled = comparableVersion(installed);
  const parsedAvailable = comparableVersion(available);
  if (!parsedInstalled || !parsedAvailable) return false;
  const coreLength = Math.max(parsedInstalled.core.length, parsedAvailable.core.length);
  for (let index = 0; index < coreLength; index++) {
    const comparison = (parsedInstalled.core[index] ?? 0) - (parsedAvailable.core[index] ?? 0);
    if (comparison !== 0) return comparison > 0;
  }
  if (!parsedInstalled.prerelease && parsedAvailable.prerelease) return true;
  if (parsedInstalled.prerelease && !parsedAvailable.prerelease) return false;
  if (!parsedInstalled.prerelease || !parsedAvailable.prerelease) return true;
  const prereleaseLength = Math.max(parsedInstalled.prerelease.length, parsedAvailable.prerelease.length);
  for (let index = 0; index < prereleaseLength; index++) {
    const installedPart = parsedInstalled.prerelease[index];
    const availablePart = parsedAvailable.prerelease[index];
    if (installedPart === undefined) return false;
    if (availablePart === undefined) return true;
    if (installedPart === availablePart) continue;
    const installedNumeric = /^\d+$/u.test(installedPart);
    const availableNumeric = /^\d+$/u.test(availablePart);
    if (installedNumeric && availableNumeric) return Number(installedPart) > Number(availablePart);
    if (installedNumeric !== availableNumeric) return !installedNumeric;
    return installedPart.localeCompare(availablePart, 'en') > 0;
  }
  return true;
}

function comparableVersion(value: string): { core: number[]; prerelease: string[] | null } | null {
  const match = value.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) return null;
  const core = match[1].split('.').map(Number);
  return core.every(Number.isSafeInteger)
    ? { core, prerelease: match[2] ? match[2].split('.') : null }
    : null;
}
