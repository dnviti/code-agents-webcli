import * as path from 'path';
import { BaseBridge, StartSessionOptions } from './base.js';

/**
 * Antigravity CLI (`agy`) — Google's coding CLI, the successor to Gemini CLI.
 *
 * Its installer drops a single ~190MB Go binary in ~/.local/bin, which is not
 * always on a systemd --user PATH, so that location is tried first — the same
 * reason the Grok, Kimi and omp bridges lead with their own install
 * directories. Interactive by default: run with no arguments it draws its TUI,
 * which is exactly what a PTY session wants.
 *
 * Verified against agy 1.1.8.
 */
export class AntigravityBridge extends BaseBridge {
  protected getCommandCandidates(): string[] {
    const home = process.env.HOME || '/';
    return [
      path.join(home, '.local', 'bin', 'agy'),
      'agy',
      path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/usr/bin/agy',
    ];
  }

  protected getDefaultCommand(): string {
    return 'agy';
  }

  protected getDisplayName(): string {
    return 'Antigravity';
  }

  protected getArgs(options: StartSessionOptions): string[] {
    // `--dangerously-skip-permissions  Auto-approve all tool permission requests
    // without prompting` — verified against agy 1.1.8's own --help, and watched
    // working: a headless run with the flag reports `permission_mode:
    // "always-proceed"` in its opening event and runs `pwd` without asking,
    // while the same run without it reports `request-review`.
    //
    // Not `--mode accept-edits` and not `--mode plan`. Both parse, and neither
    // does anything observable: three runs of the same "write this file" prompt
    // — no flag, `--mode accept-edits`, `--mode plan` — all reported
    // `request-review` and all three wrote the file. A control wired to a flag
    // that changes nothing would be worse than no control.
    return options.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [];
  }

  protected getModelFlag(): string | null {
    // `--model  Model for the current CLI session` — verified against the
    // installed CLI's --help, and against `agy models`, which prints the ids it
    // accepts one per line.
    return '--model';
  }

  /**
   * Answer the trust question a first launch in an unseen folder asks.
   *
   * Captured from a real PTY run of agy 1.1.8 in a directory it had never seen:
   * after signing in it clears the screen and draws
   *
   *   Accessing workspace:
   *   /tmp/agy-tui-2
   *   Do you trust the contents of this project?
   *   Antigravity CLI requires permission to read, edit, and execute files here.
   *   > Yes, I trust this folder
   *     No, exit
   *
   * and then does nothing at all until it is answered. "Yes" is already the
   * highlighted row, so a single Enter takes it — driven exactly that way, the
   * same session went straight on to the ordinary prompt and answered a
   * question about the folder.
   *
   * Answering it here rather than writing `~/.gemini/trustedFolders.json`
   * ourselves is deliberate: the folder was chosen in this app's own launcher
   * and validated against the browsing sandbox a moment ago, so the answer is
   * already known — but editing another program's credentials-adjacent config
   * behind its back would grant that trust permanently and for every future
   * launch, including ones this app had nothing to do with. Pressing the key is
   * the narrower act, and it is the same one the Claude bridge performs for the
   * same prompt.
   *
   * Matched on the question rather than on the option text so a build that
   * rewords the buttons still gets past it, and guarded by a per-session flag so
   * a later mention of the phrase — in a transcript the user scrolls, say —
   * cannot send a stray Enter into whatever is on screen then.
   */
  protected onSessionData(sessionId: string, _data: string, dataBuffer: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const state = session as unknown as Record<string, unknown>;
    if (state._trustPromptHandled) return;
    if (!dataBuffer.includes('Do you trust the contents of this project?')) return;

    state._trustPromptHandled = true;
    console.log(`Auto-accepting Antigravity trust prompt for session ${sessionId}`);
    // The same short delay the Claude bridge uses: the prompt is drawn in
    // several writes and a key sent into a half-painted list is dropped.
    setTimeout(() => {
      session.process.write('\r');
      console.log(`Sent Enter to accept Antigravity trust prompt for session ${sessionId}`);
    }, 500);
  }
}

export default AntigravityBridge;
