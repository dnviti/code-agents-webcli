import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * pi — an AI coding assistant with read, bash, edit and write tools.
 *
 * Interactive by default, so it runs in the PTY with no arguments, the same
 * shape as the Cursor agent. `--print` exists for one-shot use and is
 * deliberately not passed: this is an interactive terminal.
 */
export class PiBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      'pi',
      path.join(process.env.HOME || '/', '.local', 'bin', 'pi'),
      '/usr/local/bin/pi',
      '/usr/bin/pi',
    ];
  }

  protected getDefaultCommand(): string {
    return 'pi';
  }

  protected getDisplayName(): string {
    return 'Pi';
  }

  protected getArgs(_options: StartSessionOptions): string[] {
    // No approval-bypass flag is passed. pi's --approve only trusts
    // project-local extension and skill files for the run; it is not the
    // tool-approval bypass that Claude's and Codex's flags are, so wiring it to
    // the "dangerous" button would mislabel what the user is agreeing to.
    return [];
  }
}

export default PiBridge;
