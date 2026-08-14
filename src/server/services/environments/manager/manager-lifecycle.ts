import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AUTO_TIER,
  DEFAULT_AUTO_POLICY,
  INITIAL_AUTO_STATE,
  decideAutoTier,
  findTier,
} from '../tiers.js';
import { EnvironmentSummary, EnvironmentTier } from '../types.js';
import type { ResourceUsage } from '../engine.js';
import {
  LOGIN_LABEL,
  MANAGED_LABEL,
  TARGET_LABEL,
  USER_ID_LABEL,
} from './labels.js';
import { EnvironmentManagerProvision } from './manager-provision.js';

/**
 * Lifecycle operations for an environment manager: sweeping, listing, removing,
 * resizing and stopping the environments it owns.
 */
export abstract class EnvironmentManagerLifecycle extends EnvironmentManagerProvision {
  /**
   * Stop environments with no recorded activity inside the idle window.
   *
   * `isBusy` is not optional in spirit: "idle" here has to mean "nothing is
   * running in it", and this object only sees the moments an environment was
   * handed out. An agent that has been working for an hour without a new
   * session starting would otherwise look untouched, and stopping it would kill
   * the run — the one thing an idle sweep must never do.
   */
  async sweepIdle(isBusy?: (userId: number) => boolean): Promise<string[]> {
    if (!this.multiTarget && (!this.config.enabled || this.config.idleTimeoutMinutes <= 0)) {
      return [];
    }

    const stopped: string[] = [];

    for (const [userId, environment] of [...this.ready]) {
      // Each container answers to the idle policy of the target that placed
      // it, not of whichever target happens to be active now.
      const config = this.configForContainer(environment.name);
      const engine = this.engineForContainer(environment.name);
      const minutes = config.idleTimeoutMinutes;
      if (!config.enabled || minutes <= 0) {
        continue;
      }

      const cutoff = this.now() - minutes * 60_000;
      const seen = this.lastUsed.get(userId) ?? 0;
      if (seen > cutoff) {
        continue;
      }
      if (isBusy?.(userId)) {
        // Counts as activity, so the environment is not re-examined a minute
        // from now and stopped the instant the run happens to end.
        this.lastUsed.set(userId, this.now());
        continue;
      }
      try {
        const described = await this.readyDescription(userId, environment);
        if (described && described.status === 'running') {
          await engine.stopIdentity(described);
          stopped.push(environment.name);
        }
        // Dropped from `ready` but not from disk: the next `ensureFor` starts
        // the same container again and the user finds their home as they left
        // it.
        this.ready.delete(userId);
      } catch (error) {
        console.error(`Environment ${environment.name}: idle stop failed:`, error);
      }
    }

    return stopped;
  }

  /** Every environment this server manages, running or not, across every target. */
  async list(): Promise<EnvironmentSummary[]> {
    const summaries: EnvironmentSummary[] = [];
    const seen = new Set<string>();
    const engines = [...this.engines.entries()];

    for (const [engineKey, engine] of engines) {
      let names: string[];
      try {
        names = await engine.list(`${MANAGED_LABEL}=true`);
      } catch (error) {
        // With one engine there is nothing to fall back on, and the caller
        // should see the failure. With several, one unreachable target must
        // not hide the environments the others can still report.
        if (engines.length === 1) {
          throw error;
        }
        console.error(`Deploy target '${engineKey}': could not list environments:`, error);
        continue;
      }

      for (const name of names) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        const described = await engine.describe(name);
        const labels = described?.labels || {};
        // The label is useful display metadata, but one best-effort listing is
        // not enough proof to establish a route for later mutation. In
        // particular, a stale/malicious target label must not make remove()
        // delete a same-named object through a different engine.
        const targetKey = labels[TARGET_LABEL] || 'legacy';
        const userId = Number(labels[USER_ID_LABEL]);
        summaries.push({
          name,
          userId: Number.isFinite(userId) && labels[USER_ID_LABEL] ? userId : null,
          githubLogin: labels[LOGIN_LABEL] || null,
          status: described?.status || 'unknown',
          image: described?.image || '',
          homeDir: path.join(this.configForKey(targetKey).rootDir, name),
        });
      }
    }

    return summaries;
  }

  /**
   * Remove an environment, and optionally the data behind it.
   *
   * Two steps rather than one because they answer different questions: the
   * container goes when a user should stop being able to run anything, the home
   * directory goes when their data should stop existing — which is what
   * revoking access is supposed to mean.
   */
  async remove(name: string, options: { purgeData?: boolean } = {}): Promise<void> {
    if (!name || path.basename(name) !== name) {
      throw new Error('Environment name must be one safe path component');
    }
    if (this.multiTarget && !this.containerPlacement.has(name)) {
      throw new Error(
        `cannot safely remove unknown environment '${name}': its deploy target has not been verified`,
      );
    }
    const targetKey = this.targetKeyForContainer(name);
    const engine = this.engineForContainer(name);
    const config = this.configForContainer(name);
    const ready = Array.from(this.ready.entries())
      .find(([, environment]) => environment.name === name);
    const described = ready
      ? await this.readyDescription(ready[0], ready[1])
      : await engine.describeStrict(name);
    if (described) {
      if (!ready) {
        const userId = Number(described.labels[USER_ID_LABEL]);
        if (!Number.isSafeInteger(userId)
          || userId <= 0
          || described.name !== name
          || !name.endsWith(`-${userId}`)
          || !this.ownsUserContainer(described, userId, targetKey)) {
          throw new Error(`Environment ${name}: refusing to remove a container not owned as a user environment`);
        }
      }
      await engine.removeIdentity(described);
    }
    this.containerTarget.delete(name);
    this.containerPlacement.delete(name);

    for (const [userId, environment] of [...this.ready]) {
      if (environment.name === name) {
        this.ready.delete(userId);
      }
    }

    if (options.purgeData) {
      const rootDir = config.rootDir;
      const home = path.join(rootDir, name);
      // Guarded against a name that would resolve outside the root — the only
      // caller is an operator command, but a `..` here would delete the wrong
      // tree.
      const resolved = path.resolve(home);
      if (resolved.startsWith(`${path.resolve(rootDir)}${path.sep}`)) {
        await fsp.rm(resolved, { recursive: true, force: true });
      }
    }
  }

  /**
   * What a user's environment is consuming right now.
   *
   * Null when it is not running, or when the engine cannot say — a cluster
   * without metrics-server is the ordinary case, not a fault.
   */
  async usageFor(userId: number): Promise<ResourceUsage | null> {
    const environment = this.ready.get(userId);
    if (!environment) {
      return null;
    }
    try {
      const described = await this.readyDescription(userId, environment);
      if (!described) return null;
      const engine = this.engineForContainer(environment.name);
      const target = engine.kind === 'kubernetes' ? environment.name : described.identity;
      const usage = await engine.usage(target);
      // Kubernetes metrics are name-addressed, so verify that the result still
      // belongs to the pod we queried before exposing it.
      if (engine.kind === 'kubernetes') {
        const after = await this.readyDescription(userId, environment);
        if (!after) return null;
      }
      return usage;
    } catch {
      return null;
    }
  }

  /**
   * Bring a user's running environment to a size.
   *
   * Live when the engine can — both container runtimes can change limits on a
   * running container, and Kubernetes can on a recent enough cluster — and
   * deferred to the next idle moment when it cannot. Never applied by
   * replacing an environment that has something running in it: the data would
   * survive, but the user's work would not.
   */
  async applyTier(
    userId: number,
    tier: EnvironmentTier,
    options: { busy?: boolean } = {},
  ): Promise<'applied' | 'deferred' | 'unchanged'> {
    const environment = this.ready.get(userId);
    const applied = this.appliedTier.get(userId);

    if (applied && applied.id === tier.id && !this.pendingRebuild.has(userId)) {
      return 'unchanged';
    }

    if (!environment) {
      // Nothing to resize: the next `ensureFor` reads the choice and builds at
      // the right size straight away.
      this.pendingRebuild.delete(userId);
      this.appliedTier.delete(userId);
      return 'applied';
    }

    const engine = this.engineForContainer(environment.name);
    try {
      const described = await this.readyDescription(userId, environment);
      // Docker and Podman accept their immutable container id everywhere a
      // name is accepted. Kubernetes' resize subresource is name-addressed;
      // defer there instead of risking a same-name replacement.
      const resizeTarget = engine.kind === 'kubernetes' ? null : described?.identity;
      if (resizeTarget && await engine.resize(resizeTarget, tier.cpus, tier.memory)) {
        const after = await this.readyDescription(userId, environment);
        if (!after) throw new Error(`Environment ${environment.name}: disappeared during resize`);
        this.appliedTier.set(userId, tier);
        this.pendingRebuild.delete(userId);
        return 'applied';
      }
    } catch (error) {
      console.error(`Environment ${environment.name}: live resize failed:`, error);
    }

    if (options.busy) {
      this.pendingRebuild.set(userId, tier);
      return 'deferred';
    }

    await this.stopReadyEnvironment(userId, environment);
    this.ready.delete(userId);
    this.appliedTier.delete(userId);
    this.pendingRebuild.delete(userId);
    return 'applied';
  }

  /**
   * One round of automatic sizing.
   *
   * Only for users who asked for `auto`; everybody else's size is their own
   * decision and is never overridden by load. Returns what changed, for the log.
   */
  async sampleAndScale(isBusy?: (userId: number) => boolean): Promise<Array<{
    userId: number;
    name: string;
    from: string;
    to: string;
    reason: string;
    outcome: string;
  }>> {
    if (!this.multiTarget && (!this.config.enabled || !this.config.tiers.length)) {
      return [];
    }

    const changes = [];

    for (const [userId, environment] of [...this.ready]) {
      if (this.getUserTier(userId) !== AUTO_TIER) {
        continue;
      }

      // The catalog of the target that placed the container, not of the
      // active one: a switch must not resize existing work to sizes it was
      // never built against.
      const config = this.configForContainer(environment.name);
      if (!config.enabled || !config.tiers.length) {
        continue;
      }
      const engine = this.engineForContainer(environment.name);

      const current = this.appliedTier.get(userId)
        || findTier(config.tiers, config.defaultTier)
        || config.tiers[0];

      let sample = null;
      try {
        sample = await engine.usage(environment.name);
      } catch {
        sample = null;
      }

      const decision = decideAutoTier({
        tiers: config.tiers,
        current,
        sample,
        state: this.autoState.get(userId) || INITIAL_AUTO_STATE,
        now: this.now(),
        policy: DEFAULT_AUTO_POLICY,
      });
      this.autoState.set(userId, decision.state);

      if (!decision.next) {
        continue;
      }

      this.autoTier.set(userId, decision.next.id);
      const outcome = await this.applyTier(userId, decision.next, { busy: isBusy?.(userId) });
      changes.push({
        userId,
        name: environment.name,
        from: current.id,
        to: decision.next.id,
        reason: decision.reason || '',
        outcome,
      });
    }

    return changes;
  }

  /**
   * Stop one user's environment, keeping their data.
   *
   * Used by the idle sweep and by a tier change that cannot be applied to a
   * running environment. Not destructive on any engine: the home is on a
   * volume, so the next `ensureFor` brings it back as it was.
   */
  async stopFor(userId: number): Promise<boolean> {
    const environment = this.ready.get(userId);
    if (!environment) {
      return false;
    }
    await this.stopReadyEnvironment(userId, environment);
    this.ready.delete(userId);
    return true;
  }

  /** Stop everything this server started, without touching any data. */
  async stopAll(): Promise<void> {
    for (const [userId, environment] of this.ready) {
      try {
        await this.stopReadyEnvironment(userId, environment);
      } catch {
        // A shutdown path: an environment that will not stop is the operator's
        // problem to see in `ps`, not a reason to hang the server's exit.
      }
    }
  }
}
