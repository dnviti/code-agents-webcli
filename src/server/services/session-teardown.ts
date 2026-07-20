import { SessionRecord } from '../types.js';

/**
 * Cleanup work owed by one subsystem when a session goes away.
 *
 * Fire-and-forget by contract: the DELETE route answers the client before any
 * of these finish, so a disposer that rejects must never surface as an
 * unhandled rejection. The registry swallows and logs instead.
 */
export type SessionDisposer = (session: SessionRecord) => void | Promise<void>;

export interface SessionTeardownLike {
  dispose(session: SessionRecord): void;
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

  dispose(session: SessionRecord): void {
    for (const disposer of this.disposers) {
      // Each disposer is isolated: one store throwing must not stop the next
      // store from cleaning up.
      try {
        const result = disposer.run(session);
        if (result && typeof result.then === 'function') {
          result.then(undefined, (error: unknown) => {
            console.error(`Session teardown "${disposer.name}" failed:`, error);
          });
        }
      } catch (error) {
        console.error(`Session teardown "${disposer.name}" failed:`, error);
      }
    }
  }
}
