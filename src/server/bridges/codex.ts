import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

export class CodexBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      path.join(process.env.HOME || '/', '.codex', 'local', 'codex'),
      'codex',
      'codex-code',
      path.join(process.env.HOME || '/', '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ];
  }

  protected getDefaultCommand(): string {
    return 'codex';
  }

  protected getDisplayName(): string {
    return 'Codex';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    return options.dangerouslySkipPermissions
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : [];
  }
}

export default CodexBridge;
