import fsp from 'node:fs/promises';
import {
  ContainerDescription,
  EnvironmentEngine,
} from '../engine.js';
import { targetLabelValue } from '../naming.js';
import { ContainerConfig, EnvironmentOwner, Mount, UserEnvironment } from '../types.js';
import { ContainerEnvironment } from './container-environment.js';
import {
  LOGIN_LABEL,
  MANAGED_LABEL,
  TARGET_LABEL,
  TIER_LABEL,
  USER_ID_LABEL,
} from './labels.js';
import { EnvironmentManagerTargets } from './manager-targets.js';
import {
  PlacementObservation,
  PlacementScanResult,
  ResolvedPlacement,
} from './types.js';

/**
 * Single-flight discovery, validation and provisioning for an environment
 * manager.
 *
 * This is the ensure path: prove an existing placement, or prove a name absent
 * across every reachable target before creating it, then bring the owner's
 * container up at the size their current choice implies.
 */
export abstract class EnvironmentManagerProvision extends EnvironmentManagerTargets {
  /**
   * The environment for this user, created if absent and started if stopped.
   *
   * Idempotent and safe to call on every request that needs one.
   */
  async ensureFor(owner: EnvironmentOwner): Promise<UserEnvironment> {
    const inFlight = this.pending.get(owner.id);
    if (inFlight) {
      return inFlight;
    }

    // Discovery is part of the single flight, not a prelude to it. Two tabs
    // signing in immediately after a restart must not both conclude that the
    // container is absent and create same-named copies on the active target.
    const work = this.ensureForOnce(owner).finally(() => {
      this.pending.delete(owner.id);
    });
    this.pending.set(owner.id, work);
    return work;
  }

  /** The single-flight body for one user, including restart-time discovery. */
  protected async ensureForOnce(owner: EnvironmentOwner): Promise<UserEnvironment> {
    const placement = await this.resolvePlacement(owner);
    if (!placement || !placement.config.enabled) {
      return this.hostEnvironment;
    }

    const name = this.ownerHomeForConfig(placement.config, owner).name;
    const priorTarget = this.containerTarget.get(name);
    const priorPlacement = this.containerPlacement.get(name);

    // Reserve the exact route before the first network await. A reload during
    // the availability probe can replace the target map, but it cannot change
    // which engine this in-flight ensure already chose.
    this.containerTarget.set(name, placement.key);
    this.containerPlacement.set(name, placement);

    try {
      if (this.multiTarget && !(await placement.engine.available())) {
        throw new Error(
          `deploy target '${placement.name || placement.key}' is unreachable: `
          + `the ${placement.config.engine} engine is not answering`,
        );
      }

      // Prove the exact name is either absent or still belongs to this user
      // before a deferred rebuild is allowed to stop anything already ready.
      await this.validateExistingPlacement(owner, name, placement);

      this.lastUsed.set(owner.id, this.now());

      // A size change that had to wait for the user to stop working: this is the
      // moment they are starting again, so it is applied before the new session
      // rather than after it, when it would have to interrupt them all over again.
      const deferred = this.pendingRebuild.get(owner.id);
      if (deferred) {
        const running = this.ready.get(owner.id);
        if (running) {
          try {
            await this.stopReadyEnvironment(owner.id, running);
          } catch (error) {
            const detail = error instanceof Error ? `: ${error.message}` : '';
            throw new Error(
              `Environment ${running.name}: could not replace for a size change${detail}`,
            );
          }
          this.ready.delete(owner.id);
        }
        this.pendingRebuild.delete(owner.id);
      }

      return await this.provision(owner, placement);
    } catch (error) {
      if (priorTarget === undefined) {
        this.containerTarget.delete(name);
      } else {
        this.containerTarget.set(name, priorTarget);
      }
      if (priorPlacement === undefined) {
        this.containerPlacement.delete(name);
      } else {
        this.containerPlacement.set(name, priorPlacement);
      }
      throw error;
    }
  }

  /**
   * Resolve an existing placement, or prove the name absent before using the
   * current active target. Returns null only for the disabled legacy path.
   */
  protected async resolvePlacement(
    owner: EnvironmentOwner,
  ): Promise<ResolvedPlacement | null> {
    let active = this.resolveActiveTarget();
    if (!active) return null;

    while (true) {
      // Empty targets table plus disabled startup flags is the historical host
      // path. Check before resolving the durable owner home: that resolution
      // creates its identity mapping on disk, while disabled installations
      // must remain entirely side-effect free.
      if (!active.config.enabled) {
        return null;
      }

      const name = this.ownerHomeForConfig(active.config, owner).name;
      const known = this.containerPlacement.get(name);
      if (known) {
        return { ...known, config: this.configForContainer(name) };
      }

      if (!this.multiTarget) {
        return this.resolutionForActive(active);
      }

      const discovered = await this.discoverPlacement(name, owner.id);
      if (discovered) {
        return discovered;
      }

      // The active target may have switched while the all-target scan was in
      // flight. Resolve it again and verify that the exact name we proved
      // absent is still the one about to be provisioned.
      const current = this.resolveActiveTarget();
      if (!current) return null;
      if (!current.config.enabled) {
        return null;
      }
      if (this.ownerHomeForConfig(current.config, owner).name !== name) {
        active = current;
        continue;
      }
      return this.resolutionForActive(current);
    }
  }

  /**
   * Search every reachable target for one unknown deterministic name.
   *
   * `list` is deliberately the authoritative absence check: unlike
   * `describe`, engine implementations do not turn transport/authentication
   * failures into a misleading null. Any failed target therefore aborts new
   * placement; otherwise a restart during an outage could create a duplicate
   * on whichever target happens to be active.
   */
  protected async discoverPlacement(name: string, userId: number): Promise<ResolvedPlacement | null> {
    while (true) {
      const revision = this.targetRevision;
      const engines = new Map(this.engines);
      const configs = new Map(this.configs);
      const entries: Array<[string, EnvironmentEngine, ContainerConfig]> = [];
      const seenEngines = new Set<EnvironmentEngine>();

      for (const [key, engine] of engines) {
        const config = configs.get(key) || (key === 'legacy' ? this.config : null);
        if (!config || (key === 'legacy' && !config.enabled)) {
          continue;
        }
        entries.push([key, engine, config]);
        seenEngines.add(engine);
      }
      // A route retained from an earlier target revision may use an engine
      // object no longer present under its key (an endpoint edit can reuse the
      // id). Search those exact engines too so another unknown user's work on
      // the old endpoint is not silently duplicated.
      for (const placement of this.containerPlacement.values()) {
        if (!seenEngines.has(placement.engine)) {
          entries.push([
            placement.key,
            placement.engine,
            configs.get(placement.key) || placement.config,
          ]);
          seenEngines.add(placement.engine);
        }
      }

      const results: PlacementScanResult[] = await Promise.all(entries.map(
        async ([engineKey, engine, config]): Promise<PlacementScanResult> => {
          try {
            const names = await engine.list(`${MANAGED_LABEL}=true`);
            if (!names.includes(name)) {
              return { engineKey, observation: null, error: null };
            }

            const described = await engine.describeStrict(name);
            if (!described) {
              throw new Error('the engine listed it but could not describe it');
            }
            this.validateManagedOwner(name, userId, engineKey, described.labels);
            return {
              engineKey,
              observation: {
                engineKey,
                engine,
                config,
                targetLabel: described.labels[TARGET_LABEL] || null,
              },
              error: null,
            };
          } catch (error) {
            return { engineKey, observation: null, error };
          }
        },
      ));

      const failed = results.find((result) => result.error !== null);
      if (failed) {
        const detail = failed.error instanceof Error ? `: ${failed.error.message}` : '';
        throw new Error(
          `cannot safely place environment '${name}': deploy target '${failed.engineKey}' `
          + `could not be searched${detail}`,
        );
      }

      const observations = results
        .map((result) => result.observation)
        .filter((value): value is PlacementObservation => value !== null);
      if (observations.length) {
        // Observations belong to the engine snapshot that produced them. Even
        // if a reload landed meanwhile, committing that exact route is safer
        // than discarding proof of an existing container and creating anew.
        const placement = this.resolveObservedPlacement(name, observations, engines);
        this.containerTarget.set(name, placement.key);
        this.containerPlacement.set(name, placement);
        return placement;
      }

      if (revision !== this.targetRevision) {
        continue;
      }
      return null;
    }
  }

  /** Managed/user labels are the immutable identity of a per-user environment. */
  protected validateManagedOwner(
    name: string,
    userId: number,
    engineKey: string,
    labels: Record<string, string>,
  ): void {
    if (labels[MANAGED_LABEL] !== 'true') {
      throw new Error(
        `same-name object '${name}' on deploy target '${engineKey}' is not managed by this server`,
      );
    }
    if (labels[USER_ID_LABEL] !== String(userId)) {
      throw new Error(
        `same-name object '${name}' on deploy target '${engineKey}' belongs to another user`,
      );
    }
  }

  /** Turn a non-legacy durable label into the one logical target key it names. */
  protected targetKeyForLabel(
    name: string,
    label: string,
    engines: Map<string, EnvironmentEngine>,
  ): string {
    const matches = [...engines.keys()].filter((key) => targetLabelValue(key) === label);
    if (matches.length === 0) {
      throw new Error(`environment '${name}' names unknown deploy target '${label}'`);
    }
    if (matches.length > 1) {
      throw new Error(`environment '${name}' has an ambiguous deploy target label '${label}'`);
    }
    return matches[0];
  }

  /**
   * Reconcile observations without mistaking a stale clone for an alias.
   *
   * A labeled container must be seen directly through the target named by its
   * label. The only allowed second view is `legacy`, because the one-time seed
   * and startup flags can address the same daemon. For pre-label/legacy-label
   * containers, prefer the sole persisted non-legacy observer: unlike today's
   * startup flags, that target still records the original endpoint.
   */
  protected resolveObservedPlacement(
    name: string,
    observations: PlacementObservation[],
    engines: Map<string, EnvironmentEngine>,
  ): ResolvedPlacement {
    // A target edit can replace an endpoint while retaining the same logical
    // key. If both the old and replacement engines contain this deterministic
    // name, the key/label alone cannot tell us which physical object is the
    // user's environment. Never collapse those two engine snapshots into one
    // observation and arbitrarily adopt whichever happened to finish first.
    const observationsByKey = new Map<string, PlacementObservation[]>();
    for (const observation of observations) {
      const forKey = observationsByKey.get(observation.engineKey) || [];
      forKey.push(observation);
      observationsByKey.set(observation.engineKey, forKey);
    }
    for (const [engineKey, forKey] of observationsByKey) {
      if (new Set(forKey.map((observation) => observation.engine)).size > 1) {
        throw new Error(
          `environment '${name}' exists on multiple engine endpoints for deploy target '${engineKey}'`,
        );
      }
    }

    const rawLabels = new Set(observations.map((observation) => observation.targetLabel || ''));
    if (rawLabels.size > 1) {
      throw new Error(`environment '${name}' exists on multiple deploy targets with conflicting labels`);
    }

    const label = observations[0].targetLabel;
    const legacyEra = !label || label === targetLabelValue('legacy');
    if (legacyEra) {
      const nonLegacyKeys = [...new Set(
        observations.map((observation) => observation.engineKey).filter((key) => key !== 'legacy'),
      )];
      if (nonLegacyKeys.length > 1) {
        throw new Error(
          `environment '${name}' exists on multiple deploy targets: ${nonLegacyKeys.join(', ')}`,
        );
      }
      const selected = nonLegacyKeys.length
        ? observations.find((observation) => observation.engineKey === nonLegacyKeys[0])
        : observations.find((observation) => observation.engineKey === 'legacy');
      if (!selected) {
        throw new Error(`environment '${name}' has no reachable owning deploy target`);
      }
      return {
        key: selected.engineKey,
        config: selected.config,
        engine: selected.engine,
        name: selected.engineKey,
      };
    }

    const targetKey = this.targetKeyForLabel(name, label, engines);
    const unexpected = observations.filter(
      (observation) => observation.engineKey !== targetKey && observation.engineKey !== 'legacy',
    );
    const direct = observations.find((observation) => observation.engineKey === targetKey);
    if (!direct || unexpected.length) {
      const seen = [...new Set(observations.map((observation) => observation.engineKey))];
      throw new Error(
        `environment '${name}' is labeled for deploy target '${targetKey}' but was found on ${seen.join(', ')}`,
      );
    }
    return {
      key: targetKey,
      config: direct.config,
      engine: direct.engine,
      name: targetKey,
    };
  }

  /** Strictly validate any object already occupying a resolved name. */
  protected async validateExistingPlacement(
    owner: EnvironmentOwner,
    name: string,
    placement: ResolvedPlacement,
  ): Promise<void> {
    const existing = await placement.engine.describeStrict(name);
    if (!existing) {
      return;
    }
    this.validateManagedOwner(name, owner.id, placement.key, existing.labels);
    const targetLabel = existing.labels[TARGET_LABEL];
    if (
      targetLabel
      && targetLabel !== targetLabelValue('legacy')
      && targetLabel !== targetLabelValue(placement.key)
    ) {
      throw new Error(
        `environment '${name}' is labeled for another deploy target '${targetLabel}'`,
      );
    }
  }

  /** The environment already prepared for this user, without preparing one. */
  existing(userId: number): UserEnvironment | null {
    // Disabled means the host, exactly as before this feature existed —
    // including on the multi-target path with an empty targets table, where
    // the legacy resolution is what decides.
    if (!this.enabled) {
      return this.hostEnvironment;
    }
    return this.ready.get(userId) || null;
  }

  /** Record activity, so an idle sweep does not stop an environment in use. */
  touch(userId: number): void {
    this.lastUsed.set(userId, this.now());
  }

  protected ownsUserContainer(
    description: ContainerDescription,
    userId: number,
    targetKey: string,
  ): boolean {
    const target = description.labels[TARGET_LABEL];
    return description.labels[MANAGED_LABEL] === 'true'
      && description.labels[USER_ID_LABEL] === String(userId)
      // The exact engine route has already been established by all-target
      // discovery. Pre-target containers may have no target label (or the
      // legacy one); a present modern label must still agree with that route.
      && (
        !target
        || target === targetLabelValue('legacy')
        || target === targetLabelValue(targetKey)
      );
  }

  /** Re-resolve a ready environment without trusting its reusable name. */
  protected async readyDescription(
    userId: number,
    environment: ContainerEnvironment,
  ): Promise<ContainerDescription | null> {
    if (!environment.identity) {
      throw new Error(`Environment ${environment.name}: immutable identity is unavailable`);
    }
    const targetKey = this.containerTarget.get(environment.name) || 'legacy';
    const described = await this.engineForContainer(environment.name)
      .describeStrict(environment.name);
    if (!described) return null;
    if (described.identity !== environment.identity) {
      throw new Error(`Environment ${environment.name}: same-name container was replaced`);
    }
    if (!this.ownsUserContainer(described, userId, targetKey)) {
      throw new Error(`Environment ${environment.name}: ownership labels changed`);
    }
    return described;
  }

  protected async stopReadyEnvironment(
    userId: number,
    environment: ContainerEnvironment,
  ): Promise<boolean> {
    const described = await this.readyDescription(userId, environment);
    if (!described) return false;
    await this.engineForContainer(environment.name).stopIdentity(described);
    return true;
  }

  protected async provision(
    owner: EnvironmentOwner,
    active: ResolvedPlacement,
  ): Promise<UserEnvironment> {
    const config = active.config;
    const engine = active.engine;
    const identity = this.ownerHomeForConfig(config, owner);
    const name = identity.name;
    const homeDir = identity.hostPath;
    const containerHome = identity.containerPath;

    // 0700: the isolation claim has to hold on the host too, not only inside
    // the container. Created before the container so the bind mount never
    // brings a root-owned directory into being.
    await fsp.mkdir(homeDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(homeDir, 0o700);

    const mounts: Mount[] = [
      { hostPath: homeDir, containerPath: containerHome },
      ...config.extraMounts,
    ];

    // The tier decides the limits; the flat `--container-cpus`/`--container-memory`
    // remain as the answer for an installation that wants one size for everyone
    // and has emptied the catalog.
    const tier = this.intendedTier(config, owner.id);

    const described = await engine.describeStrict(name);
    const ready = this.ready.get(owner.id);
    if (ready) {
      if (!ready.identity || ready.name !== name) {
        throw new Error(`Environment ${name}: ready environment identity is inconsistent`);
      }
      if (described && described.identity !== ready.identity) {
        throw new Error(`Environment ${name}: same-name container was replaced before ensure`);
      }
    }
    if (described && !this.ownsUserContainer(described, owner.id, active.key)) {
      throw new Error(`Environment ${name}: same-name container has mismatched ownership labels`);
    }

    const ensured = await engine.ensureIdentity({
      name,
      image: config.image,
      mounts,
      containerHome,
      cpus: tier ? tier.cpus : config.cpus,
      memory: tier ? tier.memory : config.memory,
      labels: {
        [MANAGED_LABEL]: 'true',
        [USER_ID_LABEL]: String(owner.id),
        [LOGIN_LABEL]: owner.githubLogin,
        // Which target placed this container, so a later switch of the active
        // target never makes existing work unreachable. Legacy containers read
        // as 'legacy', whether the label says so or is absent entirely.
        [TARGET_LABEL]: targetLabelValue(active.key),
        ...(tier ? { [TIER_LABEL]: tier.id } : {}),
      },
      identityLabels: [MANAGED_LABEL, USER_ID_LABEL],
      env: {
        HOME: containerHome,
        USER: owner.githubLogin,
        TERM: 'xterm-256color',
      },
    }, described);

    if (ensured.created && config.setupCommand) {
      // Per creation, not per user: a setup command installs into the image's
      // filesystem, which is exactly the half that a rebuild throws away.
      // Failure is reported and tolerated — an environment without the extras
      // is still a usable environment.
      try {
        await engine.exec(
          {
            name,
            identity: ensured.identity,
            cwd: containerHome,
            env: { HOME: containerHome },
          },
          'sh',
          ['-c', config.setupCommand],
        );
      } catch (error) {
        console.error(`Environment ${name}: setup command failed:`, error);
      }
    }

    // Probed after any setup command, because installing a nicer shell is one
    // of the things a setup command is for.
    const shells = await this.probeShells(name, ensured.identity, engine);
    // Setup and shell probing are deliberately tolerant, but replacement is
    // not. Re-inspect after them so their caught errors cannot conceal a pod or
    // container that changed underneath this provision.
    const verified = await engine.describeStrict(name);
    if (
      !verified
      || verified.identity !== ensured.identity
      || !this.ownsUserContainer(verified, owner.id, active.key)
    ) {
      throw new Error(`Environment ${name}: identity or ownership changed during provisioning`);
    }

    const environment = new ContainerEnvironment({
      name,
      identity: ensured.identity,
      homeDir,
      containerHome,
      engine,
      shells,
      mounts,
    });

    this.ready.set(owner.id, environment);
    if (tier) {
      this.appliedTier.set(owner.id, tier);
    }
    this.pendingRebuild.delete(owner.id);
    this.lastUsed.set(owner.id, this.now());
    return environment;
  }

  /**
   * Which of the shells this app supports actually exist in an image.
   *
   * One exec at creation rather than a probe per terminal start, and ordered by
   * preference so the caller can take the first. `sh` is appended unconditionally
   * as the last resort: a container without it could not have run the probe.
   */
  protected async probeShells(
    name: string,
    identity: string,
    engine: EnvironmentEngine = this.engine,
  ): Promise<string[]> {
    try {
      const { stdout } = await engine.exec({ name, identity }, 'sh', [
        '-c',
        'for s in zsh bash sh; do command -v "$s" >/dev/null 2>&1 && echo "$s"; done',
      ]);
      const found = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      return found.length ? found : ['sh'];
    } catch (error) {
      console.error(`Environment ${name}: shell probe failed:`, error);
      return ['sh'];
    }
  }
}
