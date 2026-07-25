import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * Grok Build — xAI's coding TUI.
 *
 * Interactive by default. The installer puts it in ~/.grok/bin, which is not
 * always on a systemd --user PATH, so that location is tried first.
 */
export class GrokBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      path.join(process.env.HOME || '/', '.grok', 'bin', 'grok'),
      'grok',
      path.join(process.env.HOME || '/', '.local', 'bin', 'grok'),
      '/usr/local/bin/grok',
      '/usr/bin/grok',
    ];
  }

  protected getDefaultCommand(): string {
    return 'grok';
  }

  protected getDisplayName(): string {
    return 'Grok';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    // --always-approve auto-approves every tool execution, which is the direct
    // analogue of Claude's --dangerously-skip-permissions.
    return options.dangerouslySkipPermissions ? ['--always-approve'] : [];
  }

  protected getModelFlag(): string | null {
    // `--model <model>` — verified against the installed CLI's --help.
    return '--model';
  }
}

export default GrokBridge;
