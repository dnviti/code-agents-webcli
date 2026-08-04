import * as fs from 'fs';
import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * Oh My Pi (omp) — the community fork of pi, distributed as
 * `@oh-my-pi/pi-coding-agent`.
 *
 * A separate binary from pi, so both can be installed side by side; this bridge
 * never shadows the pi one. Interactive by default, so it runs in the PTY with
 * no arguments and `--print` is deliberately not passed.
 *
 * The binary is a self-contained ~180MB executable that its installer drops in
 * ~/.local/bin, which is not always on a systemd --user PATH — so that location
 * is tried first, the same reason the Grok and Kimi bridges lead with their own
 * install directories. The Bun global bin is checked too, since omp is also
 * distributed for `bun install -g`.
 */
export class OmpBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    const home = process.env.HOME || '/';
    return [
      path.join(home, '.local', 'bin', 'omp'),
      path.join(home, '.bun', 'bin', 'omp'),
      'omp',
      '/usr/local/bin/omp',
      '/usr/bin/omp',
    ];
  }

  protected getDefaultCommand(): string {
    return 'omp';
  }

  protected getDisplayName(): string {
    return 'Oh My Pi';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    const args: string[] = [];

    // `--auto-approve  Auto-approve all tool calls (skip approval prompts)` —
    // verified against omp 17.1.3. This is a true approval bypass, so unlike the
    // pi bridge it is safe to wire to the Dangerous button.
    //
    // Not --plan-yolo: despite the name that is a plan-mode workflow that
    // auto-approves *the plan* and then switches models to execute it, not a
    // blanket tool-approval bypass. --approval-mode=yolo is equivalent to
    // --auto-approve but is a per-session override of a config key, so the
    // dedicated flag is the clearer expression of intent.
    if (options.dangerouslySkipPermissions) {
      args.push('--auto-approve');
    }

    // omp is the only bridged CLI that overrides the directory it was spawned
    // in: started in $HOME it silently chdir()s to a temp directory, and the
    // session then runs against an empty /tmp instead of the folder the user
    // picked. Measured against omp 17.1.3 — /proc/<pid>/cwd reads `/tmp`
    // without this flag and `$HOME` with it — and the app's own default working
    // directory is the user's home, so without it the default launch is the
    // broken one.
    //
    // Which directory a session runs in is the app's decision: it is validated
    // against the browsing sandbox and is what the session record, the
    // transcript and the pasted-image paths all refer to. A CLI relocating
    // itself underneath that is a silent divergence, so it is switched off
    // rather than accommodated.
    //
    // Only for a session that actually starts in $HOME, and only once the flag
    // is known to exist: omp exits on an unrecognised flag ("Error: unknown
    // flag"), so passing it blind would turn "runs in the wrong directory" into
    // "does not start at all" on a build that predates it. Everywhere else argv
    // stays exactly as it was.
    if (this.isHomeDirectory(options) && this.supportsAllowHome()) {
      args.push('--allow-home');
    }

    return args;
  }

  protected getModelFlag(): string | null {
    // `--model <model>` — verified against the installed CLI's --help.
    return '--model';
  }

  /**
   * Whether this session starts in the very directory omp refuses to stay in.
   *
   * Compared through realpath because that is what the relocation is checked
   * against and what /proc reports: with a symlinked home, plain string
   * normalisation says "not home" and the flag would be dropped exactly when it
   * is needed.
   */
  private isHomeDirectory(options: StartSessionOptions): boolean {
    const workingDir = options.workingDir;
    if (
      options.cwdKind === 'container'
      && options.environment?.kind === 'container'
      && workingDir
    ) {
      return path.posix.normalize(workingDir)
        === path.posix.normalize(options.environment.containerHome);
    }
    const home = process.env.HOME;
    if (!home || !workingDir) {
      return false;
    }
    return this.canonical(workingDir) === this.canonical(home);
  }

  private canonical(target: string): string {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }

  /** Probed once per process, and only for a home-directory session. */
  private allowHomeSupported: boolean | null = null;

  private supportsAllowHome(): boolean {
    if (this.allowHomeSupported !== null) {
      return this.allowHomeSupported;
    }

    let supported = false;
    try {
      const help = this.resolvedCommandOutput(['--help'], {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      supported = help.includes('--allow-home');
    } catch {
      // No help, no binary, or a timeout: assume the flag is absent rather than
      // risk a launch that fails outright.
      supported = false;
    }

    if (!supported) {
      console.warn(
        `${this.getDisplayName()}: this build has no --allow-home, so a session started in ` +
          `${process.env.HOME} will run in a temporary directory of its own choosing ` +
          `instead. Update omp to keep the session in the folder you picked.`,
      );
    }

    this.allowHomeSupported = supported;
    return supported;
  }
}

export default OmpBridge;
