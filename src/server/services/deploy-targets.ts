/**
 * Deployment targets: persisted, encrypted places where containers run.
 *
 * A target records an engine (docker, podman or kubernetes), the connection
 * secrets needed to reach it, and the policy settings that apply to work
 * placed there. Secrets are encrypted at rest; the only place they are written
 * to disk in plaintext is `<dataDir>/deploy-targets/<id>/`, and only when they
 * are needed to drive an engine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppDatabase } from './database.js';
import { EncryptionKeyRing } from './encryption.js';
import { ContainerConfig, ContainerEngineKind, EnvironmentTier, Mount } from './environments/types.js';
import { DEFAULT_IMAGE } from './environments/config.js';

export interface DockerHostSecret {
  host: string;
  tls?: {
    ca: string;
    cert: string;
    key: string;
  } | null;
}

export interface KubernetesSecret {
  kubeconfig?: string | null;
  context?: string | null;
  namespace?: string | null;
  storageClaim?: string | null;
  serviceAccount?: string | null;
}

export interface DeployTargetInput {
  name: string;
  engine: ContainerEngineKind;
  image?: string | null;
  hostSecret?: DockerHostSecret | null;
  kubernetesSecret?: KubernetesSecret | null;
  tiers?: EnvironmentTier[];
  defaultTier?: string;
  allowUserTierChoice?: boolean;
  cpus?: string | null;
  memory?: string | null;
  setupCommand?: string | null;
  idleTimeoutMinutes?: number;
  caveats?: string[];
}

export interface DeployTarget {
  id: string;
  name: string;
  engine: ContainerEngineKind;
  image: string | null;
  hostSecret: DockerHostSecret | null;
  kubernetesSecret: KubernetesSecret | null;
  tiers: EnvironmentTier[];
  defaultTier: string;
  allowUserTierChoice: boolean;
  cpus: string | null;
  memory: string | null;
  setupCommand: string | null;
  idleTimeoutMinutes: number;
  caveats: string[];
  lastCheck: { ok: boolean; error?: string; at: string } | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeployTargetSummary {
  id: string;
  name: string;
  engine: ContainerEngineKind;
  image: string | null;
  hasHost: boolean;
  hasKubernetesConfig: boolean;
  /**
   * The non-secret Kubernetes fields, readable so the edit form can show
   * current values. Only ever these four — the kubeconfig itself is secret
   * and is never exposed.
   */
  kubernetesContext: string | null;
  kubernetesNamespace: string | null;
  kubernetesStorageClaim: string | null;
  kubernetesServiceAccount: string | null;
  tiers: EnvironmentTier[];
  defaultTier: string;
  allowUserTierChoice: boolean;
  cpus: string | null;
  memory: string | null;
  setupCommand: string | null;
  idleTimeoutMinutes: number;
  caveats: string[];
  lastCheck: { ok: boolean; error?: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeployTargetStoreOptions {
  database: AppDatabase;
  keyRing: EncryptionKeyRing;
  dataDir: string;
}

const VALID_ENGINES: ContainerEngineKind[] = ['docker', 'podman', 'kubernetes'];
export const ACTIVE_TARGET_KEY = 'deploy.targets.activeTargetId';
export const LEGACY_SEEDED_KEY = 'deploy.targets.legacySeeded';

export class DeployTargetStore {
  private readonly db: AppDatabase;
  private readonly keyRing: EncryptionKeyRing;
  private readonly dataDir: string;

  constructor(options: DeployTargetStoreOptions) {
    this.db = options.database;
    this.keyRing = options.keyRing;
    this.dataDir = options.dataDir;
  }

  /** Every target, with secret indicators but no secret values. */
  listTargets(): DeployTargetSummary[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM deploy_targets ORDER BY created_at ASC')
      .all() as DeployTargetRow[];
    return rows.map((row) => summarize(row, this.keyRing));
  }

  /** One target with secrets decrypted. */
  getTarget(id: string): DeployTarget | null {
    const row = this.db.raw
      .prepare('SELECT * FROM deploy_targets WHERE id = ?')
      .get(id) as DeployTargetRow | undefined;
    return row ? toDeployTarget(row, this.keyRing) : null;
  }

  createTarget(input: DeployTargetInput, createdBy?: number): { id: string } {
    validateTargetInput(input);
    if (this.nameExists(input.name)) {
      throw new Error(`deploy target name "${input.name}" already exists`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const caveats = input.caveats ?? caveatsFor(input.engine);
    const hostSecret = input.hostSecret ?? null;
    const kubernetesSecret = input.kubernetesSecret ?? null;

    this.db.raw
      .prepare(
        `INSERT INTO deploy_targets (
          id, name, engine, image, host_secret, kubernetes_secret,
          tiers_json, default_tier, allow_user_tier_choice, cpus, memory,
          setup_command, idle_timeout_minutes, caveats_json, last_check_json,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.engine,
        input.image ?? null,
        hostSecret ? this.keyRing.encrypt(JSON.stringify(hostSecret)) : null,
        kubernetesSecret ? this.keyRing.encrypt(JSON.stringify(kubernetesSecret)) : null,
        JSON.stringify(input.tiers ?? []),
        input.defaultTier ?? '',
        input.allowUserTierChoice ? 1 : 0,
        input.cpus ?? null,
        input.memory ?? null,
        input.setupCommand ?? null,
        input.idleTimeoutMinutes ?? 0,
        JSON.stringify(caveats),
        null,
        createdBy ?? null,
        now,
        now,
      );

    this.materializeSecrets(id);
    return { id };
  }

  updateTarget(id: string, input: Partial<DeployTargetInput>): void {
    const existing = this.getTarget(id);
    if (!existing) {
      throw new Error(`deploy target "${id}" not found`);
    }

    if (input.name !== undefined && !input.name.trim()) {
      throw new Error('deploy target name is required');
    }
    if (input.engine !== undefined && !VALID_ENGINES.includes(input.engine)) {
      throw new Error(`unsupported engine "${input.engine}"`);
    }
    if (input.name && input.name !== existing.name && this.nameExists(input.name, id)) {
      throw new Error(`deploy target name "${input.name}" already exists`);
    }

    const keepHost = !Object.prototype.hasOwnProperty.call(input, 'hostSecret');
    const keepKube = !Object.prototype.hasOwnProperty.call(input, 'kubernetesSecret');

    // A sent secret is merged into the stored one, not swapped over it: the
    // client only sends the subfields that changed, and a partial edit must
    // not wipe the companion material it never mentioned. Explicit null
    // still clears the whole secret.
    const hostSecret = keepHost
      ? existing.hostSecret
      : mergeHostSecret(existing.hostSecret, input.hostSecret);
    const kubernetesSecret = keepKube
      ? existing.kubernetesSecret
      : mergeKubernetesSecret(existing.kubernetesSecret, input.kubernetesSecret);

    const now = new Date().toISOString();
    this.db.raw
      .prepare(
        `UPDATE deploy_targets SET
          name = ?, engine = ?, image = ?, host_secret = ?, kubernetes_secret = ?,
          tiers_json = ?, default_tier = ?, allow_user_tier_choice = ?, cpus = ?,
          memory = ?, setup_command = ?, idle_timeout_minutes = ?, caveats_json = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.engine ?? existing.engine,
        input.image !== undefined ? input.image : existing.image,
        hostSecret ? this.keyRing.encrypt(JSON.stringify(hostSecret)) : null,
        kubernetesSecret ? this.keyRing.encrypt(JSON.stringify(kubernetesSecret)) : null,
        JSON.stringify(input.tiers ?? existing.tiers),
        input.defaultTier ?? existing.defaultTier,
        input.allowUserTierChoice !== undefined
          ? (input.allowUserTierChoice ? 1 : 0)
          : (existing.allowUserTierChoice ? 1 : 0),
        input.cpus !== undefined ? input.cpus : existing.cpus,
        input.memory !== undefined ? input.memory : existing.memory,
        input.setupCommand !== undefined ? input.setupCommand : existing.setupCommand,
        input.idleTimeoutMinutes !== undefined ? input.idleTimeoutMinutes : existing.idleTimeoutMinutes,
        JSON.stringify(input.caveats ?? existing.caveats),
        now,
        id,
      );

    this.materializeSecrets(id);
  }

  deleteTarget(id: string): void {
    const result = this.db.raw.prepare('DELETE FROM deploy_targets WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new Error(`deploy target "${id}" not found`);
    }
    // The plaintext materialization exists only to drive the engine; it must
    // not outlive the target it belonged to.
    fs.rmSync(secretsPathFor(id, this.dataDir), { recursive: true, force: true });
  }

  /** Build the live ContainerConfig that an engine consumes for a target. */
  configForTarget(
    target: DeployTarget | string,
    dataDir: string,
    extraMounts: Mount[] = [],
  ): ContainerConfig {
    if (!dataDir) {
      throw new Error('deploy target config requires a dataDir');
    }
    const resolved = typeof target === 'string' ? this.getTarget(target) : target;
    if (!resolved) {
      throw new Error(`deploy target "${target}" not found`);
    }
    target = resolved;
    this.writeSecretsToDisk(target, dataDir);

    const hostArgs = buildHostArgs(target, dataDir);
    const kubeconfigPath = target.kubernetesSecret?.kubeconfig
      ? kubeconfigPathFor(target.id, dataDir)
      : undefined;

    const kubernetesSecret = target.kubernetesSecret;

    return {
      enabled: true,
      engine: target.engine,
      image: target.image || DEFAULT_IMAGE,
      cpus: target.cpus,
      memory: target.memory,
      idleTimeoutMinutes: target.idleTimeoutMinutes,
      rootDir: path.join(dataDir, 'environments'),
      namePrefix: 'cawc',
      setupCommand: target.setupCommand,
      extraMounts,
      tiers: target.tiers,
      defaultTier: target.defaultTier,
      allowUserTierChoice: target.allowUserTierChoice,
      hostArgs,
      kubeconfigPath,
      kubernetes: {
        context: kubernetesSecret?.context ?? null,
        namespace: kubernetesSecret?.namespace ?? 'default',
        storageClaim: kubernetesSecret?.storageClaim ?? 'cawc-environments',
        serviceAccount: kubernetesSecret?.serviceAccount ?? null,
      },
    };
  }

  /** Materialize secrets for every target; safe to call repeatedly. */
  materializeAllSecrets(dataDir?: string): void {
    const dir = dataDir || this.dataDir;
    for (const target of this.listTargets()) {
      const full = this.getTarget(target.id);
      if (full) {
        this.writeSecretsToDisk(full, dir);
      }
    }
  }

  /** Write any secrets this target carries onto disk under the data directory. */
  materializeSecrets(id: string, dataDir?: string): void {
    const target = this.getTarget(id);
    if (target) {
      this.writeSecretsToDisk(target, dataDir || this.dataDir);
    }
  }

  /** Persist the outcome of a health check; never carries secret material. */
  recordCheck(id: string, result: { ok: boolean; error?: string }): void {
    const exists = this.db.raw.prepare('SELECT 1 FROM deploy_targets WHERE id = ?').get(id);
    if (!exists) {
      throw new Error(`deploy target "${id}" not found`);
    }
    this.db.raw
      .prepare('UPDATE deploy_targets SET last_check_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ ok: result.ok, error: result.error ?? null, at: new Date().toISOString() }),
        id,
      );
  }

  getActiveTargetId(): string | null {
    return this.db.getSetting(ACTIVE_TARGET_KEY);
  }

  setActiveTargetId(id: string | null): void {
    if (id === null) {
      this.db.deleteSetting(ACTIVE_TARGET_KEY);
      return;
    }
    const exists = this.db.raw.prepare('SELECT 1 FROM deploy_targets WHERE id = ?').get(id);
    if (!exists) {
      throw new Error(`deploy target "${id}" does not exist`);
    }
    this.db.setSetting(ACTIVE_TARGET_KEY, id);
  }

  /**
   * Seed a single 'default' target from legacy startup config, once only.
   *
   * Runs only when the table is empty and the legacy configuration is
   * enabled. A disabled legacy configuration seeds nothing and — just as
   * importantly — writes nothing: the flag stays unset so that an
   * installation which turns containers on later still gets its config
   * captured on that boot.
   */
  seedLegacyTarget(config: ContainerConfig, createdBy?: number): { id: string } | null {
    if (this.db.getSetting(LEGACY_SEEDED_KEY) === 'true') {
      return null;
    }
    if (!config.enabled) {
      return null;
    }
    if (this.listTargets().length > 0) {
      this.db.setSetting(LEGACY_SEEDED_KEY, 'true');
      return null;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    let hostSecret: DockerHostSecret | null = null;
    let kubernetesSecret: KubernetesSecret | null = null;

    if (config.hostArgs && config.hostArgs.length > 0 && config.engine !== 'kubernetes') {
      const { host, tls } = parseHostArgs(config.hostArgs);
      if (host) {
        hostSecret = { host, tls: tls || null };
      }
    }

    if (config.engine === 'kubernetes') {
      // A kubeconfig handed in by path becomes content in the table: the
      // target model owns its secrets, and a path that only exists on this
      // boot's filesystem would silently break the target later.
      let kubeconfig: string | null = null;
      if (config.kubeconfigPath) {
        try {
          kubeconfig = fs.readFileSync(config.kubeconfigPath, 'utf8');
        } catch {
          kubeconfig = null;
        }
      }
      kubernetesSecret = {
        kubeconfig,
        context: config.kubernetes.context,
        namespace: config.kubernetes.namespace,
        storageClaim: config.kubernetes.storageClaim,
        serviceAccount: config.kubernetes.serviceAccount,
      };
    }

    // One transaction for the row, the activation and the seeded flag: a
    // partial seed — a target without its active pointer, or a seeded flag
    // without its target — is a state no later boot can reason about.
    const seed = this.db.raw.transaction(() => {
      this.db.raw
        .prepare(
          `INSERT INTO deploy_targets (
            id, name, engine, image, host_secret, kubernetes_secret,
            tiers_json, default_tier, allow_user_tier_choice, cpus, memory,
            setup_command, idle_timeout_minutes, caveats_json, last_check_json,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          'default',
          config.engine,
          config.image,
          hostSecret ? this.keyRing.encrypt(JSON.stringify(hostSecret)) : null,
          kubernetesSecret ? this.keyRing.encrypt(JSON.stringify(kubernetesSecret)) : null,
          JSON.stringify(config.tiers),
          config.defaultTier,
          config.allowUserTierChoice ? 1 : 0,
          config.cpus,
          config.memory,
          config.setupCommand,
          config.idleTimeoutMinutes,
          JSON.stringify(caveatsFor(config.engine)),
          null,
          createdBy ?? null,
          now,
          now,
        );

      this.db.setSetting(ACTIVE_TARGET_KEY, id);
      this.db.setSetting(LEGACY_SEEDED_KEY, 'true');
    });
    seed();
    this.materializeSecrets(id);
    return { id };
  }

  private writeSecretsToDisk(target: DeployTarget, dataDir: string): void {
    const base = secretsPathFor(target.id, dataDir);
    // Rewrite from empty every time: material belonging to a secret that has
    // since been cleared or replaced must not linger on disk next to — or
    // instead of — its successor.
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(base, 0o700);
    } catch {
      // best-effort
    }

    if (target.hostSecret?.tls) {
      writeSecretFile(path.join(base, 'ca.pem'), target.hostSecret.tls.ca);
      writeSecretFile(path.join(base, 'cert.pem'), target.hostSecret.tls.cert);
      writeSecretFile(path.join(base, 'key.pem'), target.hostSecret.tls.key);
    }

    if (target.kubernetesSecret?.kubeconfig) {
      writeSecretFile(path.join(base, 'kubeconfig'), target.kubernetesSecret.kubeconfig);
    }
  }

  private nameExists(name: string, excludeId?: string): boolean {
    const sql = excludeId
      ? 'SELECT 1 FROM deploy_targets WHERE name = ? AND id != ?'
      : 'SELECT 1 FROM deploy_targets WHERE name = ?';
    const params = excludeId ? [name, excludeId] : [name];
    return Boolean(this.db.raw.prepare(sql).get(...params));
  }
}

function buildHostArgs(target: DeployTarget, dataDir: string): string[] | undefined {
  if (!target.hostSecret) {
    return undefined;
  }
  const args: string[] = [];
  if (target.hostSecret.host) {
    args.push('-H', target.hostSecret.host);
  }
  if (target.hostSecret.tls) {
    const base = secretsPathFor(target.id, dataDir);
    args.push('--tlscacert', path.join(base, 'ca.pem'));
    args.push('--tlscert', path.join(base, 'cert.pem'));
    args.push('--tlskey', path.join(base, 'key.pem'));
    args.push('--tlsverify');
  }
  return args.length > 0 ? args : undefined;
}

export function caveatsFor(engine: ContainerEngineKind): string[] {
  if (engine === 'kubernetes') {
    return [
      'Approval prompts and agent questions from inside the pod do not reach the browser; only bypassPermissions mode is supported there.',
      'The automatic size tier needs metrics-server.',
    ];
  }
  return [];
}

/**
 * Merge a partial host-secret edit into the stored secret. Absent subfields
 * keep their stored values — the client sends only what changed — while an
 * explicit null patch clears the whole secret and a null `tls` clears just
 * the TLS material.
 */
export function mergeHostSecret(
  existing: DockerHostSecret | null,
  patch: DockerHostSecret | null | undefined,
): DockerHostSecret | null {
  if (patch === null || patch === undefined) {
    return null;
  }
  return { ...(existing ?? { host: '' }), ...patch };
}

/** The same merge for the Kubernetes secret, per subfield. */
export function mergeKubernetesSecret(
  existing: KubernetesSecret | null,
  patch: KubernetesSecret | null | undefined,
): KubernetesSecret | null {
  if (patch === null || patch === undefined) {
    return null;
  }
  return { ...(existing ?? {}), ...patch };
}

function writeSecretFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function secretsPathFor(targetId: string, dataDir: string): string {
  return path.join(dataDir, 'deploy-targets', targetId);
}

export function kubeconfigPathFor(targetId: string, dataDir: string): string {
  return path.join(secretsPathFor(targetId, dataDir), 'kubeconfig');
}

function validateTargetInput(input: DeployTargetInput): void {
  if (!input.name || typeof input.name !== 'string') {
    throw new Error('deploy target name is required');
  }
  if (!VALID_ENGINES.includes(input.engine)) {
    throw new Error(`unsupported engine "${input.engine}"`);
  }
}

function summarize(row: DeployTargetRow, keyRing: EncryptionKeyRing): DeployTargetSummary {
  // The non-secret Kubernetes fields ride along so the edit form can show
  // current values. A secret that no longer decrypts yields nulls here — the
  // target is skipped by the engine maps in that state anyway.
  let kubernetes: KubernetesSecret | null = null;
  if (row.kubernetes_secret) {
    try {
      kubernetes = JSON.parse(keyRing.decrypt(row.kubernetes_secret)) as KubernetesSecret;
    } catch {
      kubernetes = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as ContainerEngineKind,
    image: row.image ?? null,
    hasHost: Boolean(row.host_secret),
    hasKubernetesConfig: Boolean(row.kubernetes_secret),
    kubernetesContext: kubernetes?.context ?? null,
    kubernetesNamespace: kubernetes?.namespace ?? null,
    kubernetesStorageClaim: kubernetes?.storageClaim ?? null,
    kubernetesServiceAccount: kubernetes?.serviceAccount ?? null,
    tiers: parseJson(row.tiers_json, []),
    defaultTier: row.default_tier ?? '',
    allowUserTierChoice: Boolean(row.allow_user_tier_choice),
    cpus: row.cpus ?? null,
    memory: row.memory ?? null,
    setupCommand: row.setup_command ?? null,
    idleTimeoutMinutes: row.idle_timeout_minutes ?? 0,
    caveats: parseJson(row.caveats_json, []),
    lastCheck: parseJson(row.last_check_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeployTarget(row: DeployTargetRow, keyRing: EncryptionKeyRing): DeployTarget {
  const decryptSecret = (value: string | null) => {
    if (!value) {
      return null;
    }
    try {
      return JSON.parse(keyRing.decrypt(value));
    } catch {
      throw new Error(`encryption: could not decrypt secret for target ${row.id}`);
    }
  };

  return {
    id: row.id,
    name: row.name,
    engine: row.engine as ContainerEngineKind,
    image: row.image ?? null,
    hostSecret: decryptSecret(row.host_secret) as DockerHostSecret | null,
    kubernetesSecret: decryptSecret(row.kubernetes_secret) as KubernetesSecret | null,
    tiers: parseJson(row.tiers_json, []),
    defaultTier: row.default_tier ?? '',
    allowUserTierChoice: Boolean(row.allow_user_tier_choice),
    cpus: row.cpus ?? null,
    memory: row.memory ?? null,
    setupCommand: row.setup_command ?? null,
    idleTimeoutMinutes: row.idle_timeout_minutes ?? 0,
    caveats: parseJson(row.caveats_json, []),
    lastCheck: parseJson(row.last_check_json, null),
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface DeployTargetRow {
  id: string;
  name: string;
  engine: string;
  image: string | null;
  host_secret: string | null;
  kubernetes_secret: string | null;
  tiers_json: string | null;
  default_tier: string | null;
  allow_user_tier_choice: number | null;
  cpus: string | null;
  memory: string | null;
  setup_command: string | null;
  idle_timeout_minutes: number | null;
  caveats_json: string;
  last_check_json: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

function parseHostArgs(hostArgs: string[]): { host?: string; tls?: { ca: string; cert: string; key: string } } {
  // We expect the canonical form produced by buildHostArgs. The store only
  // needs to reverse its own output for the legacy-seed path; real TLS files
  // are not re-parsable from argv alone, so a target configured through the
  // UI stores the secret directly.
  const result: { host?: string; tls?: { ca: string; cert: string; key: string } } = {};
  for (let i = 0; i < hostArgs.length; i += 1) {
    const arg = hostArgs[i];
    if (arg === '-H' || arg === '--host') {
      result.host = hostArgs[i + 1];
      i += 1;
    }
  }
  return result;
}
