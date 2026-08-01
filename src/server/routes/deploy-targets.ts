/**
 * Administration of deploy targets: the places this server runs containers.
 *
 * Installer-only throughout, reads included: a target names infrastructure —
 * that there is a Kubernetes cluster, that docker is reachable over TLS — and
 * that topology is not something every account needs to see. Writes are
 * additionally same-origin, the same reasoning as the profiles route.
 *
 * The one rule every response obeys: nothing stored in the secret columns
 * ever leaves this file. Lists and details carry `hasHost` /
 * `hasKubernetesConfig` flags instead of values, and the health check's error
 * text is scrubbed of connection material before it is persisted or returned.
 */

import { Request, Response, Router } from 'express';
import { requireUser } from './helpers.js';
import {
  DeployTarget,
  DeployTargetInput,
  DeployTargetStore,
  DockerHostSecret,
  KubernetesSecret,
  caveatsFor,
  mergeHostSecret,
  mergeKubernetesSecret,
} from '../services/deploy-targets.js';
import { ContainerConfig, ContainerEngineKind } from '../services/environments/types.js';
import { EnvironmentEngine } from '../services/environments/engine.js';
import { TARGET_LABEL, targetLabelValue } from '../services/environments/naming.js';
import {
  DEFAULT_RUN_LIMIT_PER_USER,
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_IDLE_RECLAIM_MINUTES,
} from '../services/projects/store.js';

export interface DeployTargetRoutesDeps {
  deployTargets: DeployTargetStore;
  /** Resolved data directory, needed to build a live engine config for checks. */
  deployTargetDataDir: string;
  /**
   * Build an engine from a config. A seam rather than a direct `createEngine`
   * call so tests can answer `available()` without a docker daemon.
   */
  createDeployEngine(config: ContainerConfig): EnvironmentEngine;
  /**
   * The engines the environment manager currently places work on, so a delete
   * can ask each of them whether containers for this target still exist.
   */
  enginesForDeployTargets(): Map<string, EnvironmentEngine>;
  /** Whether the startup flags configure containers, for the empty-state hint. */
  legacyContainersEnabled: boolean;
  /** Rebuild the manager's target set after every successful change. */
  reloadDeployTargets(): void;
  /** Durable project rows retain their recorded target even while stopped. */
  projectIdsForTarget(targetId: string): string[];
  getInstallerUserId(): number | null;
  /** Read and write deploy policy in durable app_settings. */
  getDeploySetting(key: string): string | null;
  setDeploySetting(key: string, value: string): void;
}

/**
 * Reject a cross-origin write. Copied from the profiles route: the auth
 * cookie is SameSite=Lax, which is site-scoped rather than origin-scoped, and
 * these endpoints decide where every future agent process runs.
 */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const VALID_ENGINES: ContainerEngineKind[] = ['docker', 'podman', 'kubernetes'];

/** The id path parameter as a plain string (Express types it as a union). */
function paramId(req: Request): string {
  return String(req.params.id);
}

export function createDeployTargetRoutes(deps: DeployTargetRoutesDeps): Router {
  const router = Router();

  /** The one gate every handler passes: signed in, and the installer. */
  const gate = (req: Request, res: Response, write: boolean): boolean => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return false;
    }
    if (write && !isSameOrigin(req)) {
      res.status(403).json({ error: 'cross_origin' });
      return false;
    }
    const installerUserId = deps.getInstallerUserId();
    if (installerUserId === null || user.id !== installerUserId) {
      res.status(403).json({ error: 'not_installer' });
      return false;
    }
    return true;
  };

  router.get('/api/admin/deploy-targets', (req: Request, res: Response): void => {
    if (!gate(req, res, false)) return;
    res.json({
      targets: deps.deployTargets.listTargets(),
      activeTargetId: deps.deployTargets.getActiveTargetId(),
      canEdit: true,
      legacyContainersEnabled: deps.legacyContainersEnabled,
      // Per-engine caveats, so the form can state them before anything is
      // saved rather than after.
      engineCaveats: {
        docker: caveatsFor('docker'),
        podman: caveatsFor('podman'),
        kubernetes: caveatsFor('kubernetes'),
      },
    });
  });

  // Registered before /:id so the literal path wins over the parameter.
  router.get('/api/admin/deploy-targets/active', (req: Request, res: Response): void => {
    if (!gate(req, res, false)) return;
    res.json({ activeTargetId: deps.deployTargets.getActiveTargetId() });
  });

  router.put('/api/admin/deploy-targets/active', (req: Request, res: Response): void => {
    if (!gate(req, res, true)) return;

    const targetId = (req.body as { targetId?: unknown })?.targetId;
    if (targetId !== null && typeof targetId !== 'string') {
      res.status(400).json({
        error: 'invalid_target',
        message: 'targetId must be a target id, or null for no active target.',
      });
      return;
    }
    if (typeof targetId === 'string' && !deps.deployTargets.getTarget(targetId)) {
      // Named rather than a bare 400: a stale page holding a deleted id needs
      // to know the target is gone, not that its request was malformed.
      res.status(404).json({ error: 'unknown_target', message: `No deploy target "${targetId}".` });
      return;
    }

    deps.deployTargets.setActiveTargetId(targetId || null);
    deps.reloadDeployTargets();
    res.json({
      activeTargetId: deps.deployTargets.getActiveTargetId(),
      message:
        'Work already running stays on the target it started on; only new '
        + 'environments are placed on the newly active target.',
    });
  });

  router.get('/api/admin/deploy-settings', (req: Request, res: Response): void => {
    if (!gate(req, res, false)) return;

    res.json({
      runLimitPerUser: positiveIntSetting(deps.getDeploySetting('deploy.runLimitPerUser'), DEFAULT_RUN_LIMIT_PER_USER),
      idleStopMinutes: positiveIntSetting(deps.getDeploySetting('deploy.idleStopMinutes'), DEFAULT_IDLE_STOP_MINUTES),
      idleReclaimMinutes: positiveIntSetting(deps.getDeploySetting('deploy.idleReclaimMinutes'), DEFAULT_IDLE_RECLAIM_MINUTES),
    });
  });

  router.put('/api/admin/deploy-settings', (req: Request, res: Response): void => {
    if (!gate(req, res, true)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const runLimitPerUser = parsePositiveInt(body.runLimitPerUser);
    const idleStopMinutes = parsePositiveInt(body.idleStopMinutes);
    const idleReclaimMinutes = parsePositiveInt(body.idleReclaimMinutes);

    if (
      runLimitPerUser === null
      || idleStopMinutes === null
      || idleReclaimMinutes === null
      || idleReclaimMinutes <= idleStopMinutes
    ) {
      res.status(400).json({
        error: 'invalid_settings',
        message: 'Values must be positive integers, and reclaim must be later than stop.',
      });
      return;
    }

    deps.setDeploySetting('deploy.runLimitPerUser', String(runLimitPerUser));
    deps.setDeploySetting('deploy.idleStopMinutes', String(idleStopMinutes));
    deps.setDeploySetting('deploy.idleReclaimMinutes', String(idleReclaimMinutes));

    res.json({
      runLimitPerUser,
      idleStopMinutes,
      idleReclaimMinutes,
    });
  });

  router.post('/api/admin/deploy-targets', (req: Request, res: Response): void => {
    if (!gate(req, res, true)) return;
    const user = requireUser(res);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseTargetInput(body);
    if (typeof input === 'string') {
      res.status(400).json({ error: 'invalid_target', message: input });
      return;
    }
    if (!VALID_ENGINES.includes(input.engine)) {
      res.status(400).json({
        error: 'invalid_target',
        message: `engine must be one of ${VALID_ENGINES.join(', ')}.`,
      });
      return;
    }

    try {
      const { id } = deps.deployTargets.createTarget(input, user?.id);
      deps.reloadDeployTargets();
      res.status(201).json({ target: summaryFor(deps, id) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  router.post('/api/admin/deploy-targets/:id/check', async (req: Request, res: Response): Promise<void> => {
    if (!gate(req, res, true)) return;

    const id = paramId(req);
    const target = deps.deployTargets.getTarget(id);
    if (!target) {
      res.status(404).json({ error: 'not_found', message: `No deploy target "${id}".` });
      return;
    }

    let result: { ok: boolean; error?: string };
    try {
      // available() only: a check proves the engine answers, it never creates
      // anything on the target.
      const config = deps.deployTargets.configForTarget(target.id, deps.deployTargetDataDir);
      const engine = deps.createDeployEngine(config);
      const ok = await engine.available();
      result = ok
        ? { ok: true }
        : { ok: false, error: `the ${target.engine} engine is not answering` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, error: sanitizeError(message, target) };
    }

    try {
      deps.deployTargets.recordCheck(target.id, result);
    } catch {
      // A check whose outcome cannot be persisted is still reported: the admin
      // is looking at the answer right now.
    }
    res.json(result);
  });

  router.get('/api/admin/deploy-targets/:id', (req: Request, res: Response): void => {
    if (!gate(req, res, false)) return;
    const id = paramId(req);
    const summary = summaryFor(deps, id);
    if (!summary) {
      res.status(404).json({ error: 'not_found', message: `No deploy target "${id}".` });
      return;
    }
    res.json({ target: summary });
  });

  router.put('/api/admin/deploy-targets/:id', async (req: Request, res: Response): Promise<void> => {
    if (!gate(req, res, true)) return;

    const id = paramId(req);
    const existing = deps.deployTargets.getTarget(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: `No deploy target "${id}".` });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseTargetPatch(body);
    if (typeof input === 'string') {
      res.status(400).json({ error: 'invalid_target', message: input });
      return;
    }

    // Renaming or retuning a target is always safe; changing how the engine
    // is reached is not, while containers placed through the old connection
    // still stand — the edit would strand them on an engine nobody can now
    // reach. Same rule, and same answer, as the delete below.
    if (connectionFieldsChanged(existing, input)) {
      const projects = deps.projectIdsForTarget(id);
      if (projects.length > 0) {
        res.status(409).json({
          error: 'target_in_use',
          message: `This target is still recorded by ${projects.length} project(s). Remove those projects before changing how the target is reached.`,
          projects,
        });
        return;
      }
      const inspection = await inspectTargetContainers(deps, existing);
      if (!inspection.ok) {
        sendRuntimeUnknown(res, existing);
        return;
      }
      const inUse = inspection.containers;
      if (inUse.length > 0) {
        res.status(409).json({
          error: 'target_in_use',
          message: `This target still runs ${inUse.length} container(s): ${inUse.join(', ')}. Stop or remove them before changing how the target is reached.`,
          containers: inUse,
        });
        return;
      }
    }

    try {
      deps.deployTargets.updateTarget(id, input);
      deps.reloadDeployTargets();
      res.json({ target: summaryFor(deps, id) });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  router.delete('/api/admin/deploy-targets/:id', async (req: Request, res: Response): Promise<void> => {
    if (!gate(req, res, true)) return;

    const id = paramId(req);
    const existing = deps.deployTargets.getTarget(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: `No deploy target "${id}".` });
      return;
    }

    // A target with containers still standing is not deletable: deleting it
    // would orphan work nobody can then reach. Ask every engine the manager
    // can still reach — including ones retained for containers of edited
    // targets. Absence must be proved, not inferred from an unreachable
    // engine: otherwise deleting this row also deletes the credentials needed
    // to recover containers the failed inspection could not report.
    const inspection = await inspectTargetContainers(deps, existing);
    if (!inspection.ok) {
      sendRuntimeUnknown(res, existing);
      return;
    }
    const inUse = inspection.containers;
    if (inUse.length > 0) {
      res.status(409).json({
        error: 'target_in_use',
        message: `This target still runs ${inUse.length} container(s): ${inUse.join(', ')}. Stop or remove them first.`,
        containers: inUse,
      });
      return;
    }
    const projects = deps.projectIdsForTarget(id);
    if (projects.length > 0) {
      res.status(409).json({
        error: 'target_in_use',
        message: `This target is still recorded by ${projects.length} project(s). Remove those projects first.`,
        projects,
      });
      return;
    }

    try {
      deps.deployTargets.deleteTarget(id);
      // A dangling active id would make new work unplaceable with no hint as
      // to why; deleting the active target clears the activation instead.
      if (deps.deployTargets.getActiveTargetId() === id) {
        deps.deployTargets.setActiveTargetId(null);
      }
      deps.reloadDeployTargets();
      res.json({ deleted: true });
    } catch (error) {
      sendStoreError(res, error);
    }
  });

  return router;
}

type TargetContainerInspection =
  | { ok: true; containers: string[] }
  | { ok: false };

/**
 * Prove that no reachable or current target runtime has containers carrying
 * this target's label. A freshly built engine covers targets that the manager
 * could not retain (for example because its first connection attempt failed).
 * Any failed listing leaves the answer unknown: callers that would remove or
 * replace credentials must fail closed rather than orphaning that runtime.
 */
async function inspectTargetContainers(
  deps: DeployTargetRoutesDeps,
  target: DeployTarget,
): Promise<TargetContainerInspection> {
  const engines = deps.enginesForDeployTargets();
  const candidates = new Set(engines.values());

  // The manager owns all historic engines, but a target that failed to load
  // into it still needs its configured runtime queried before its credentials
  // may be removed.
  if (!engines.has(target.id)) {
    try {
      const config = deps.deployTargets.configForTarget(target.id, deps.deployTargetDataDir);
      candidates.add(deps.createDeployEngine(config));
    } catch {
      return { ok: false };
    }
  }

  const label = `${TARGET_LABEL}=${targetLabelValue(target.id)}`;
  const inUse = new Set<string>();
  for (const engine of candidates) {
    try {
      for (const name of await engine.list(label)) inUse.add(name);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, containers: [...inUse] };
}

/** Do not disclose connection errors, which can contain target credentials. */
function sendRuntimeUnknown(res: Response, target: DeployTarget): void {
  res.status(409).json({
    error: 'target_runtime_unknown',
    message: `Could not verify that the ${target.engine} target has no containers. Its connection and credentials were left unchanged.`,
  });
}

/**
 * Whether a patch changes how the target's engine is reached: the engine
 * itself, the docker/podman host, or any Kubernetes connection field. Secrets
 * are compared after the same merge the store applies, so re-sending the
 * stored values counts as no change. Values are never echoed — the answer is
 * a boolean, and the 409 message names containers, not connections.
 */
function connectionFieldsChanged(
  existing: DeployTarget,
  input: Partial<DeployTargetInput>,
): boolean {
  if (input.engine !== undefined && input.engine !== existing.engine) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'hostSecret')) {
    const merged = mergeHostSecret(existing.hostSecret, input.hostSecret);
    if (!sameSecret(merged, existing.hostSecret)) {
      return true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'kubernetesSecret')) {
    const merged = mergeKubernetesSecret(existing.kubernetesSecret, input.kubernetesSecret);
    if (!sameSecret(merged, existing.kubernetesSecret)) {
      return true;
    }
  }
  return false;
}

/** Order-insensitive structural equality for the small secret objects. */
function sameSecret(
  a: DockerHostSecret | KubernetesSecret | null,
  b: DockerHostSecret | KubernetesSecret | null,
): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value ?? null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(value[key]);
  }
  return out;
}

/** The summary for one id, read back fresh after a write. */
function summaryFor(deps: DeployTargetRoutesDeps, id: string) {
  return deps.deployTargets.listTargets().find((target) => target.id === id) ?? null;
}

/**
 * Map store failures onto statuses. The store's messages name the problem but
 * never quote secret values, so they are safe to hand back.
 */
function sendStoreError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/.test(message)) {
    res.status(404).json({ error: 'not_found', message });
  } else if (/already exists/.test(message)) {
    res.status(409).json({ error: 'name_exists', message });
  } else {
    res.status(400).json({ error: 'invalid_target', message });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return typeof value === 'string' ? value : undefined;
}

/** Pull a host secret out of a request body; absent = keep, null = clear. */
function parseHostSecret(body: Record<string, unknown>): DockerHostParse | 'invalid' | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'hostSecret')) return undefined;
  const value = body.hostSecret;
  if (value === null) return null;
  if (!isPlainObject(value) || typeof value.host !== 'string' || !value.host) return 'invalid';
  // Absent tls stays absent — the store merge reads that as "keep the stored
  // TLS"; only an explicit null clears it.
  const parsed: DockerHostSecret = { host: value.host };
  if (value.tls === null) {
    parsed.tls = null;
  } else if (value.tls !== undefined) {
    // TLS is all-or-nothing: a half-written triple would fail at the engine
    // with a message that says nothing about which field was dropped.
    if (!isPlainObject(value.tls)) return 'invalid';
    const { ca, cert, key } = value.tls;
    if (!ca || typeof ca !== 'string'
      || !cert || typeof cert !== 'string'
      || !key || typeof key !== 'string') {
      return 'invalid';
    }
    parsed.tls = { ca, cert, key };
  }
  return parsed;
}

type DockerHostParse = DockerHostSecret | null;

function parseKubernetesSecret(
  body: Record<string, unknown>,
): Record<string, string | null> | null | 'invalid' | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'kubernetesSecret')) return undefined;
  const value = body.kubernetesSecret;
  if (value === null) return null;
  if (!isPlainObject(value)) return 'invalid';
  const secret: Record<string, string | null> = {};
  for (const key of ['kubeconfig', 'context', 'namespace', 'storageClaim', 'serviceAccount']) {
    const field = optionalString(value[key]);
    if (field !== undefined) secret[key] = field;
  }
  return secret;
}

/**
 * Read the common scalar fields of a create/update body. Returns an error
 * string when a field is present but unreadable; never echoes values, because
 * some of them are secrets.
 */
function parseCommon(
  body: Record<string, unknown>,
): { fields: Partial<DeployTargetInput> } | string {
  const fields: Partial<DeployTargetInput> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return 'name is required and must be text.';
    }
    fields.name = body.name.trim();
  }
  if (body.image !== undefined) fields.image = optionalString(body.image) ?? null;
  if (body.cpus !== undefined) fields.cpus = optionalString(body.cpus) ?? null;
  if (body.memory !== undefined) fields.memory = optionalString(body.memory) ?? null;
  if (body.setupCommand !== undefined) fields.setupCommand = optionalString(body.setupCommand) ?? null;
  if (body.defaultTier !== undefined) fields.defaultTier = typeof body.defaultTier === 'string' ? body.defaultTier : '';
  if (body.allowUserTierChoice !== undefined) fields.allowUserTierChoice = body.allowUserTierChoice === true;
  if (body.idleTimeoutMinutes !== undefined) {
    const minutes = Number(body.idleTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return 'idleTimeoutMinutes must be a non-negative number.';
    }
    fields.idleTimeoutMinutes = minutes;
  }
  if (body.tiers !== undefined) {
    if (!Array.isArray(body.tiers)) return 'tiers must be a list.';
    fields.tiers = body.tiers as DeployTargetInput['tiers'];
  }

  const hostSecret = parseHostSecret(body);
  if (hostSecret === 'invalid') {
    return 'hostSecret must be {host, tls?} or null, and every tls field must be non-empty.';
  }
  if (hostSecret !== undefined) fields.hostSecret = hostSecret;

  const kubernetesSecret = parseKubernetesSecret(body);
  if (kubernetesSecret === 'invalid') return 'kubernetesSecret must be an object or null.';
  if (kubernetesSecret !== undefined) fields.kubernetesSecret = kubernetesSecret;

  return { fields };
}

function parseTargetInput(body: Record<string, unknown>): DeployTargetInput | string {
  const parsed = parseCommon(body);
  if (typeof parsed === 'string') return parsed;
  if (!parsed.fields.name) return 'name is required.';
  if (typeof body.engine !== 'string') return 'engine is required.';
  return {
    ...parsed.fields,
    name: parsed.fields.name,
    engine: body.engine as ContainerEngineKind,
  };
}

function parseTargetPatch(body: Record<string, unknown>): Partial<DeployTargetInput> | string {
  const parsed = parseCommon(body);
  if (typeof parsed === 'string') return parsed;
  if (body.engine !== undefined) {
    if (!VALID_ENGINES.includes(body.engine as ContainerEngineKind)) {
      return `engine must be one of ${VALID_ENGINES.join(', ')}.`;
    }
    parsed.fields.engine = body.engine as ContainerEngineKind;
  }
  return parsed.fields;
}

/**
 * Scrub an engine error of anything that could carry credential material.
 * Engine errors love to quote the thing they were connecting to — and not
 * always verbatim: docker rewrites a stored `tcp://host:2376` into
 * `https://host:2376` in the URL it failed to POST to, and kubectl quotes the
 * cluster `server:` URL out of the kubeconfig rather than the file itself.
 * This text is persisted in `last_check_json` and shown to the browser.
 */
function sanitizeError(message: string, target: DeployTarget): string {
  let out = message;
  const sensitive: string[] = [];

  // One URL, every shape an engine might quote it in: the stored form, the
  // same authority under the other schemes docker/podman translate between,
  // and the bare host:port authority with no scheme at all.
  const addUrlVariants = (url: string | null | undefined): void => {
    if (!url) return;
    sensitive.push(url);
    const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(url);
    if (!match) return;
    const authority = match[1];
    for (const scheme of ['tcp', 'http', 'https']) {
      sensitive.push(`${scheme}://${authority}`);
    }
    sensitive.push(authority);
  };

  addUrlVariants(target.hostSecret?.host);
  for (const server of kubeconfigServerUrls(target.kubernetesSecret?.kubeconfig)) {
    addUrlVariants(server);
  }
  sensitive.push(
    target.hostSecret?.tls?.ca ?? '',
    target.hostSecret?.tls?.cert ?? '',
    target.hostSecret?.tls?.key ?? '',
    target.kubernetesSecret?.kubeconfig ?? '',
  );

  // Longest first: a whole URL must be redacted before the authority inside
  // it, or the shorter pattern leaves the longer one unmatchable.
  for (const secret of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  const limit = 300;
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

/** The `server:` URLs a kubeconfig carries — what kubectl quotes when it fails. */
function kubeconfigServerUrls(kubeconfig: string | null | undefined): string[] {
  if (!kubeconfig) {
    return [];
  }
  const urls: string[] = [];
  for (const line of kubeconfig.split('\n')) {
    const match = /^\s*server:\s*(\S+)\s*$/.exec(line);
    if (match) {
      urls.push(match[1]);
    }
  }
  return urls;
}

function positiveIntSetting(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}
