import { SessionRecord } from '../types.js';

/**
 * Cleanup work owed by one subsystem when a session goes away.
 *
 * The DELETE path awaits these cleanups before it answers, while each failure
 * remains isolated and logged so one subsystem cannot strand all the others.
 */
export interface SessionTeardownContext {
  /** ProjectManager already owns this project's exclusive lifecycle operation. */
  projectLifecycleExclusive?: boolean;
}

export type SessionDisposer = (
  session: SessionRecord,
  context?: SessionTeardownContext,
) => void | Promise<void>;

export interface SessionTeardownLike {
  dispose(session: SessionRecord, context?: SessionTeardownContext): void | Promise<void>;
  /**
   * Rollback-only variant which still isolates every subsystem but reports
   * failures to the transaction coordinator instead of consuming them.
   */
  disposeStrict?(
    session: SessionRecord,
    context?: SessionTeardownContext,
  ): Promise<SessionTeardownResult>;
}

export interface SessionTeardownFailure {
  name: string;
  error: unknown;
}

export interface SessionTeardownResult {
  failures: SessionTeardownFailure[];
}

/**
 * Lets a subsystem register its own teardown instead of every new feature
 * appending another `void deps.someStore.deleteThing(session)` line to the
 * DELETE handler. Two features adding cleanup in the same release would
 * otherwise collide on that one line every time.
 */
export class SessionTeardownRegistry implements SessionTeardownLike {
  private readonly disposers: Array<{ name: string; run: SessionDisposer }> = [];

  register(name: string, run: SessionDisposer): void {
    this.disposers.push({ name, run });
  }

  async dispose(session: SessionRecord, context?: SessionTeardownContext): Promise<void> {
    const result = await this.runAll(session, context);
    for (const failure of result.failures) {
      console.error(`Session teardown "${failure.name}" failed:`, failure.error);
    }
  }

  async disposeStrict(
    session: SessionRecord,
    context?: SessionTeardownContext,
  ): Promise<SessionTeardownResult> {
    return this.runAll(session, context);
  }

  private async runAll(
    session: SessionRecord,
    context?: SessionTeardownContext,
  ): Promise<SessionTeardownResult> {
    const failures: SessionTeardownFailure[] = [];
    for (const disposer of this.disposers) {
      // Each disposer is isolated: one store throwing must not stop the next
      // store from cleaning up. Awaiting still guarantees a successful DELETE
      // does not leave workspace-local artefacts behind.
      try {
        await disposer.run(session, context);
      } catch (error) {
        failures.push({ name: disposer.name, error });
      }
    }
    return { failures };
  }
}
