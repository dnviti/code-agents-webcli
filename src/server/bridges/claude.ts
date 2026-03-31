import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

export class ClaudeBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      '/home/ec2-user/.claude/local/claude',
      'claude',
      'claude-code',
      path.join(process.env.HOME || '/', '.claude', 'local', 'claude'),
      path.join(process.env.HOME || '/', '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];
  }

  protected getDefaultCommand(): string {
    return 'claude';
  }

  protected getDisplayName(): string {
    return 'Claude';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    return options.dangerouslySkipPermissions
      ? ['--dangerously-skip-permissions']
      : [];
  }

  /**
   * Auto-accept the trust prompt when Claude asks
   * "Do you trust the files in this folder?"
   */
  protected onSessionData(
    sessionId: string,
    _data: string,
    dataBuffer: string,
  ): void {
    // Check once -- the flag is embedded in the closure inside startSession,
    // but since the base class manages the buffer we track via a session-level
    // marker on the session object itself.
    const session = this.getSession(sessionId);
    if (!session) return;

    // Use a dynamic property to track whether we already handled the prompt
    const s = session as unknown as Record<string, unknown>;
    if (s._trustPromptHandled) return;

    if (dataBuffer.includes('Do you trust the files in this folder?')) {
      s._trustPromptHandled = true;
      console.log(
        `Auto-accepting trust prompt for session ${sessionId}`,
      );
      setTimeout(() => {
        session.process.write('\r');
        console.log(
          `Sent Enter to accept trust prompt for session ${sessionId}`,
        );
      }, 500);
    }
  }
}

export default ClaudeBridge;
