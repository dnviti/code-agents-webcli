import { UserTurn } from '../../../../shared/chat-events.js';
import { AdapterChild } from '../../adapter.js';
import { withAttachments } from './helpers.js';
import { AntigravityBase } from './session.js';

/**
 * The second link of `AntigravityChatAdapter`: the spawn-per-turn lifecycle.
 * `send()` launches the child for one prompt, `interrupt()` kills it, and the
 * exit path decides how a finished turn is declared. The wire that turns the
 * child's stdout into conversation events is the next link; `closeTurn` lives
 * in the concrete leaf.
 */
export abstract class AntigravityTurn extends AntigravityBase {
  async send(turn: UserTurn): Promise<void> {
    if (this.stopped) throw new Error('antigravity chat adapter is stopped');
    if (
      this.turnInFlight
      || (this.child && !this.exited)
      || this.childNeedsVerifiedClose()
    ) {
      throw new Error('antigravity: a turn is already running on this session');
    }

    this.turnInFlight = true;
    this.turnInterrupted = false;
    this.sawResult = false;
    this.currentTurnId = `t${++this.turnCounter}`;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.thinkingBlock = null;
    this.textBlocks.clear();
    this.toolIds.clear();

    // The user's own message is not written here: `ChatSession.deliver` has
    // already put it in the transcript with the turn id it minted (#129).
    this.emit({ t: 'state', state: 'thinking' });

    // `--print` last so the prompt is the final pair on the line and a long one
    // does not bury the flags in a log.
    const args = [...this.buildArgs(), '--print', withAttachments(turn)];

    return new Promise<void>((resolve, reject) => {
      // Closed rather than piped: the prompt is in argv and nothing is ever
      // written here. Measured as safe — a run with stdin ignored completed in
      // 5.4s, the same as one with a terminal behind it.
      const child = this.launchChild(args, ['ignore', 'pipe', 'pipe']) as AdapterChild;

      this.child = child;
      this.exited = false;
      this.resetStdoutFraming();
      this.stderrTail = '';

      let settled = false;
      const accept = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => this.feedStdout(chunk, 'antigravity'));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      });

      // "Accepted" means the process started, which is what `send()` promises —
      // not that agy has replied.
      child.on('spawn', accept);

      child.on('error', (error: Error) => {
        void (async () => {
          try {
            await this.waitForVerifiedClose(child);
          } catch (verificationError: unknown) {
            const message = verificationError instanceof Error
              ? verificationError.message
              : String(verificationError);
            this.emit({ t: 'error', message: `antigravity: ${message}`, fatal: true });
            if (!settled) {
              settled = true;
              reject(verificationError);
            }
            return;
          }
          if (this.child !== child || this.exited) return;
          this.exited = true;
          this.emit({ t: 'error', message: `antigravity: ${error.message}` });
          this.closeTurn('error');
          if (!settled) {
            settled = true;
            reject(error);
          }
        })();
      });

      child.on('exit', (code, signal) => {
        void this.onTurnExit(child, code, signal);
      });
    });
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || !this.childNeedsVerifiedClose(child)) return;
    // A one-shot process has no cancel message. Killing it ends this turn and
    // nothing else: the conversation lives in agy's own store, and the next
    // `send()` resumes it with `--conversation`.
    this.turnInterrupted = true;
    await this.terminateChild(child, 'SIGTERM');
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // capabilities.permissions is false: nothing is ever pending to answer.
  }

  private async onTurnExit(
    child: AdapterChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    try {
      await this.waitForVerifiedClose(child);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ t: 'error', message: `antigravity: ${message}`, fatal: true });
      return;
    }
    if (this.child !== child || this.exited) return;
    this.exited = true;

    if (this.stopped) {
      this.turnInFlight = false;
      this.emit({ t: 'state', state: 'exited' });
      return;
    }

    if (this.turnInterrupted) {
      this.closeTurn('interrupted');
      return;
    }

    if (this.sawResult) {
      // `result` already closed the turn; the exit that follows it is ordinary.
      this.turnInFlight = false;
      return;
    }

    const detail = this.stderrTail.trim();
    const how = signal ? `signal ${signal}` : `code ${code}`;
    this.emit({
      t: 'error',
      message: detail ? `antigravity exited (${how}): ${detail}` : `antigravity exited (${how})`,
    });
    this.closeTurn('error');
  }
}
