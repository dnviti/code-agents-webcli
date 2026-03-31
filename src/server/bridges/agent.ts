import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

export class AgentBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      path.join(
        process.env.HOME || '/',
        '.cursor',
        'local',
        'cursor-agent',
      ),
      'cursor-agent',
      path.join(
        process.env.HOME || '/',
        '.local',
        'bin',
        'cursor-agent',
      ),
      '/usr/local/bin/cursor-agent',
      '/usr/bin/cursor-agent',
    ];
  }

  protected getDefaultCommand(): string {
    return 'cursor-agent';
  }

  protected getDisplayName(): string {
    return 'Agent';
  }

  protected getArgs(_options: StartSessionOptions): string[] {
    return [];
  }
}

export default AgentBridge;
