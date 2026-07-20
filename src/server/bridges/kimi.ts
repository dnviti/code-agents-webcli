import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * Kimi Code — Moonshot AI's coding CLI.
 *
 * Interactive by default. Its installer puts the binary in ~/.kimi-code/bin,
 * which is not always on a systemd --user PATH, so that location is tried
 * first — the same reason the Grok bridge leads with ~/.grok/bin.
 */
export class KimiBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      path.join(process.env.HOME || '/', '.kimi-code', 'bin', 'kimi'),
      'kimi',
      path.join(process.env.HOME || '/', '.local', 'bin', 'kimi'),
      '/usr/local/bin/kimi',
      '/usr/bin/kimi',
    ];
  }

  protected getDefaultCommand(): string {
    return 'kimi';
  }

  protected getDisplayName(): string {
    return 'Kimi';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    // `-y, --yolo  Automatically approve all actions.` — verified against Kimi
    // Code 0.27.0.
    //
    // Not --auto: that is "auto permission mode", a narrower setting that still
    // asks about the actions it does not cover. Wiring the Dangerous button to
    // it would promise a bypass the user does not actually get.
    return options.dangerouslySkipPermissions ? ['--yolo'] : [];
  }
}

export default KimiBridge;
