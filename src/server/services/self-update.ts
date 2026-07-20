import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  UNIT_NAME,
  isSystemdUserAvailable,
  resolveLaunchTarget,
  unitPath,
} from '../setup/service-install.js';
import { INSTALL_SPEC } from './update-check.js';
import { stripAnsi } from './ansi.js';

/**
 * How this installation can be updated, or why it cannot be.
 *
 * Only 'systemd' and 'foreground' can be updated in place. Everything else is
 * a refusal with a specific reason, because a self-update that silently does
 * nothing — installing into a global prefix that is not the code actually
 * running — is worse than no button at all.
 */
export type { UpdateMode } from '../../shared/update.js';
import { UpdateMode } from '../../shared/update.js';

export type RunnerState = 'idle' | 'running' | 'restarting';

/** The argv is a frozen literal. Nothing from a request, a database row, or a
 *  GitHub response is ever appended to it, and there is deliberately no
 *  ref/repo/version parameter on the endpoint that would let one in. */
const INSTALL_ARGS = ['install', '-g', '--allow-git=all', INSTALL_SPEC] as const;

const PACKAGE_NAME = 'code-agents-webcli';
const MAX_LOG_LINES = 500;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 60 * 1000;
/** If SIGTERM never arrives after a restart request, stop claiming to be busy. */
const RESTART_WATCHDOG_MS = 60 * 1000;

const SETTING_IN_PROGRESS = 'update.inProgress';

export interface SelfUpdateDeps {
  spawn: typeof spawn;
  execFile: typeof execFile;
  execFileSync: typeof execFileSync;
  existsSync: (target: fs.PathLike) => boolean;
  accessSync: (target: fs.PathLike, mode?: number) => void;
  readFileSync: (target: fs.PathLike, encoding: 'utf8') => string;
  resolveLaunchTarget: typeof resolveLaunchTarget;
  isSystemdUserAvailable: typeof isSystemdUserAvailable;
  unitPath: typeof unitPath;
  platform: string;
  env: NodeJS.ProcessEnv;
}

export function defaultSelfUpdateDeps(): SelfUpdateDeps {
  return {
    spawn,
    execFile,
    execFileSync,
    existsSync: fs.existsSync,
    accessSync: fs.accessSync,
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    resolveLaunchTarget,
    isSystemdUserAvailable,
    unitPath,
    platform: process.platform,
    env: process.env,
  };
}

/**
 * Is this process inside a container?
 *
 * Checked several ways on purpose. The classic /proc/1/cgroup match fails on
 * cgroup v2, where the file is a bare "0::/" inside the container too, and
 * Podman writes /run/.containerenv rather than /.dockerenv. Getting this wrong
 * means offering an update that writes into an image layer, which `docker pull`
 * then discards.
 */
function isContainer(deps: SelfUpdateDeps): boolean {
  if (deps.existsSync('/.dockerenv') || deps.existsSync('/run/.containerenv')) {
    return true;
  }
  if (deps.env.KUBERNETES_SERVICE_HOST) {
    return true;
  }
  try {
    return /docker|containerd|kubepods|libpod/.test(deps.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/** The npm executable next to this node binary, falling back to PATH. */
export function resolveNpm(deps: SelfUpdateDeps): string {
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of ['npm', 'npm.cmd']) {
    const full = path.join(nodeDir, candidate);
    if (deps.existsSync(full)) {
      return full;
    }
  }
  return 'npm';
}

function npmGlobalRoot(deps: SelfUpdateDeps): string | null {
  try {
    const out = deps.execFileSync(resolveNpm(deps), ['root', '-g'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const resolved = String(out).trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

function isWithin(child: string, parent: string): boolean {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

export interface UpdateModeResult {
  mode: UpdateMode;
  /** Where the installed package lives, when that is knowable. */
  packageDir: string | null;
}

export function detectUpdateMode(
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): UpdateModeResult {
  if (isContainer(deps)) {
    return { mode: 'container', packageDir: null };
  }

  const target = deps.resolveLaunchTarget();
  if (target.ephemeral) {
    // npx unpacks into a cache npm may delete at any moment; there is nothing
    // durable here to update, and the next npx run already fetches HEAD.
    return { mode: 'ephemeral', packageDir: null };
  }

  const globalRoot = npmGlobalRoot(deps);
  if (!globalRoot) {
    return { mode: 'npm_unavailable', packageDir: null };
  }

  const packageDir = path.join(globalRoot, PACKAGE_NAME);
  if (!isWithin(target.scriptPath, packageDir)) {
    // A git clone or `npm link`: installing globally would update a copy that
    // is not the one running, and the banner would never clear.
    return { mode: 'source', packageDir };
  }

  try {
    // A `sudo npm i -g` install lands in a root-owned prefix while the service
    // runs as the login user. Better to refuse up front than to fail with
    // EACCES after the user has confirmed a dialog about losing sessions.
    deps.accessSync(globalRoot, fs.constants.W_OK);
  } catch {
    return { mode: 'unwritable_prefix', packageDir };
  }

  if (deps.platform !== 'linux' || !deps.isSystemdUserAvailable()) {
    return { mode: 'foreground', packageDir };
  }
  if (!deps.existsSync(deps.unitPath())) {
    return { mode: 'foreground', packageDir };
  }

  try {
    const state = deps
      .execFileSync('systemctl', ['--user', 'is-active', UNIT_NAME], { encoding: 'utf8' })
      .trim();
    return { mode: state === 'active' ? 'systemd' : 'foreground', packageDir };
  } catch {
    // is-active exits non-zero for every inactive state.
    return { mode: 'foreground', packageDir };
  }
}

export function canTriggerUpdate(mode: UpdateMode): boolean {
  // Parenthesised deliberately: `a && b || c` would grant every user the
  // button in foreground mode.
  return mode === 'systemd' || mode === 'foreground';
}

export interface SelfUpdateOptions {
  deps?: SelfUpdateDeps;
  settings: {
    getSetting(key: string): string | null;
    setSetting(key: string, value: string): void;
    deleteSetting(key: string): void;
  };
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void;
  onDone: (result: SelfUpdateResult) => void;
  onRestarting: () => void;
  /** Flush sessions before the service is told to restart. */
  beforeRestart?: () => Promise<void>;
}

export interface SelfUpdateResult {
  ok: boolean;
  code: number | null;
  restarting: boolean;
  restartRequired: boolean;
  message: string;
}

export interface InterruptedUpdate {
  startedAt: number;
  targetSha: string | null;
}

export class SelfUpdateRunner {
  private readonly deps: SelfUpdateDeps;
  private readonly options: SelfUpdateOptions;
  private readonly log: string[] = [];
  private state: RunnerState = 'idle';

  constructor(options: SelfUpdateOptions) {
    this.options = options;
    this.deps = options.deps ?? defaultSelfUpdateDeps();
  }

  getState(): RunnerState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state !== 'idle';
  }

  getLogTail(): string[] {
    return [...this.log];
  }

  /**
   * An update that was cut short — host reboot, OOM, an outside restart —
   * leaves the global prefix half-written with nothing to say so. The marker is
   * written before the spawn and cleared on exit; finding one at boot means the
   * install never finished.
   */
  takeInterrupted(): InterruptedUpdate | null {
    const raw = this.options.settings.getSetting(SETTING_IN_PROGRESS);
    if (!raw) {
      return null;
    }
    this.options.settings.deleteSetting(SETTING_IN_PROGRESS);
    try {
      const parsed = JSON.parse(raw) as Partial<InterruptedUpdate>;
      return {
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        targetSha: typeof parsed.targetSha === 'string' ? parsed.targetSha : null,
      };
    } catch {
      return { startedAt: 0, targetSha: null };
    }
  }

  private emit(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const rawLine of chunk.split('\n')) {
      const line = stripAnsi(rawLine).replace(/\r/g, '').trimEnd();
      if (!line) {
        continue;
      }
      this.log.push(line);
      if (this.log.length > MAX_LOG_LINES) {
        this.log.shift();
      }
      this.options.onOutput(stream, line);
    }
  }

  private note(line: string): void {
    this.emit('stdout', line);
  }

  /** Run one child to completion, streaming its output. */
  private runStep(
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const env = { ...this.deps.env };
      // The install re-runs scripts/build.js, which prefers these over
      // `git rev-parse`. Inheriting them would bake the OLD commit into the NEW
      // build, so the banner would report the same "behind" forever.
      delete env.CODE_AGENTS_WEBCLI_BUILD_SHA;
      delete env.CODE_AGENTS_WEBCLI_BUILD_DATE;

      const child = this.deps.spawn(file, [...args], {
        // Never run an install inside a user's working directory.
        cwd: os.tmpdir(),
        shell: false,
        env: {
          ...env,
          NO_COLOR: '1',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          npm_config_progress: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        this.emit('stderr', `Step timed out after ${Math.round(timeoutMs / 1000)}s; killing it.`);
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on('data', (data: Buffer) => this.emit('stdout', data.toString('utf8')));
      child.stderr?.on('data', (data: Buffer) => this.emit('stderr', data.toString('utf8')));

      child.on('error', (error: Error) => {
        clearTimeout(timer);
        this.emit('stderr', `Failed to run ${file}: ${error.message}`);
        resolve(null);
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /** The commit the installed package reports, read fresh off disk. */
  private installedShaOnDisk(packageDir: string): string | null {
    try {
      const raw = this.deps.readFileSync(
        path.join(packageDir, 'dist', 'build-info.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as { sha?: unknown };
      return typeof parsed.sha === 'string' && /^[0-9a-f]{40}$/.test(parsed.sha)
        ? parsed.sha
        : null;
    } catch {
      return null;
    }
  }

  private finish(result: SelfUpdateResult): void {
    this.options.settings.deleteSetting(SETTING_IN_PROGRESS);
    if (!result.restarting) {
      this.state = 'idle';
    }
    this.options.onDone(result);
  }

  /**
   * Install, rebuild, verify, and only then restart.
   *
   * The rebuild step is not optional: npm >= 12 blocks dependency lifecycle
   * scripts, so node-pty and better-sqlite3 arrive uncompiled from a global
   * install. Restarting without it would put the service into a crash loop
   * whose only recovery is a shell — the one thing this feature exists to
   * avoid needing.
   */
  async apply(mode: UpdateMode, packageDir: string | null, targetSha: string | null): Promise<void> {
    if (this.state !== 'idle') {
      return;
    }
    // Set synchronously, before any await, so two simultaneous POSTs cannot
    // both get past the guard.
    this.state = 'running';
    this.log.length = 0;
    this.options.settings.setSetting(
      SETTING_IN_PROGRESS,
      JSON.stringify({ startedAt: Date.now(), targetSha }),
    );

    const npm = resolveNpm(this.deps);

    this.note(`$ ${npm} ${INSTALL_ARGS.join(' ')}`);
    const installCode = await this.runStep(npm, INSTALL_ARGS, INSTALL_TIMEOUT_MS);
    if (installCode !== 0) {
      this.finish({
        ok: false,
        code: installCode,
        restarting: false,
        restartRequired: false,
        message: `The install step failed (exit ${installCode ?? 'signal'}). Nothing was restarted.`,
      });
      return;
    }

    if (!packageDir) {
      this.finish({
        ok: false,
        code: 0,
        restarting: false,
        restartRequired: false,
        message: 'The install finished but the installed package could not be located.',
      });
      return;
    }

    this.note(`$ ${npm} rebuild --prefix ${packageDir}`);
    const rebuildCode = await this.runStep(
      npm,
      ['rebuild', '--prefix', packageDir],
      INSTALL_TIMEOUT_MS,
    );
    if (rebuildCode !== 0) {
      this.finish({
        ok: false,
        code: rebuildCode,
        restarting: false,
        restartRequired: false,
        message:
          'The native modules failed to rebuild, so the new build would not start. '
          + 'Nothing was restarted; the running version is unchanged.',
      });
      return;
    }

    // Prove the new tree actually loads before handing it the port. Requiring
    // the server entry pulls in node-pty and better-sqlite3, which is exactly
    // what an unbuilt install gets wrong.
    const entry = path.join(packageDir, 'dist', 'server', 'index.js');
    this.note(`$ node -e "require(...)" ${entry}`);
    const smokeCode = await this.runStep(
      process.execPath,
      ['-e', 'require(process.argv[1])', entry],
      SMOKE_TIMEOUT_MS,
    );
    if (smokeCode !== 0) {
      this.finish({
        ok: false,
        code: smokeCode,
        restarting: false,
        restartRequired: false,
        message:
          'The newly installed build failed to load, so it was not started. '
          + 'The running version is unchanged.',
      });
      return;
    }

    // npm can exit 0 having changed nothing. Restarting then would kill every
    // agent session to arrive back at exactly the same commit.
    const newSha = this.installedShaOnDisk(packageDir);
    if (targetSha && newSha && newSha !== targetSha) {
      this.note(`Installed commit is ${newSha.slice(0, 7)}, expected ${targetSha.slice(0, 7)}.`);
    }
    if (newSha && targetSha && newSha === targetSha && mode === 'foreground') {
      this.note('Installed the expected commit.');
    }

    if (mode !== 'systemd') {
      this.finish({
        ok: true,
        code: 0,
        restarting: false,
        restartRequired: true,
        message:
          'Update installed. Stop this process (Ctrl-C) and start it again to run the new build.',
      });
      return;
    }

    await this.restart();
  }

  private async restart(): Promise<void> {
    this.state = 'restarting';
    this.options.onRestarting();
    this.options.settings.deleteSetting(SETTING_IN_PROGRESS);

    try {
      await this.options.beforeRestart?.();
    } catch (error) {
      console.error('Failed to flush state before restarting:', error);
    }

    // --no-block is load-bearing: `systemctl restart` issued from inside the
    // unit's own cgroup would be killed mid-stop by KillMode=mixed. Queuing the
    // job lets it outlive the client that asked for it.
    this.deps.execFile(
      'systemctl',
      ['--user', 'restart', '--no-block', UNIT_NAME],
      (error) => {
        if (!error) {
          return;
        }
        // The restart never got queued, so the SIGTERM that would have ended
        // this process is not coming. Without this the runner would sit in
        // 'restarting' forever and every later update would 409.
        this.state = 'idle';
        this.emit('stderr', `Could not restart the service: ${error.message}`);
        this.options.onDone({
          ok: true,
          code: 0,
          restarting: false,
          restartRequired: true,
          message:
            'Update installed, but the service could not be restarted automatically. '
            + `Restart it with: systemctl --user restart ${UNIT_NAME}`,
        });
      },
    );

    const watchdog = setTimeout(() => {
      if (this.state !== 'restarting') {
        return;
      }
      this.state = 'idle';
      this.options.onDone({
        ok: true,
        code: 0,
        restarting: false,
        restartRequired: true,
        message:
          'Update installed, but the service did not restart. '
          + `Restart it with: systemctl --user restart ${UNIT_NAME}`,
      });
    }, RESTART_WATCHDOG_MS);
    watchdog.unref?.();
  }
}
