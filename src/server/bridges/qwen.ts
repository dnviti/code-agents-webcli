import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * Qwen Code — Alibaba's coding CLI, a Gemini CLI derivative.
 *
 * Interactive by default: the bare command launches the terminal UI, so it runs
 * in the PTY with no arguments. `-p/--prompt` is the one-shot mode and is
 * deliberately not passed.
 */
export class QwenBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    return [
      'qwen',
      path.join(process.env.HOME || '/', '.local', 'bin', 'qwen'),
      '/usr/local/bin/qwen',
      '/usr/bin/qwen',
    ];
  }

  protected getDefaultCommand(): string {
    return 'qwen';
  }

  protected getDisplayName(): string {
    return 'Qwen';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    // --yolo sets the approval mode to YOLO, which auto-accepts every action —
    // the same bargain as Claude's --dangerously-skip-permissions.
    //
    // It is absent from `qwen --help`, so it looks unsupported. It is not: the
    // shipped bundle registers it (`.option("yolo", { alias: "y", type:
    // "boolean" })`) and reads it (`else if (argv.yolo) approvalMode = "yolo"`).
    // Verified against @qwen-code/qwen-code 0.20.0. Do not "fix" this by
    // dropping the flag because the help text does not mention it.
    return options.dangerouslySkipPermissions ? ['--yolo'] : [];
  }
}

export default QwenBridge;
