/**
 * Serializes mutations of account-owned tab-strip membership and order.
 *
 * The in-memory SessionRecord map is the live authority, while SQLite makes it
 * durable. Mutations therefore stage values in memory and await persistence;
 * this coordinator prevents another membership insertion/read from observing
 * that tentative state until it has committed or rolled back.
 */
export interface AccountTabCoordinatorLike {
  acquire(userId: number): Promise<() => void>;
}

export class AccountTabCoordinator implements AccountTabCoordinatorLike {
  // SessionStore persists the complete cross-user map in one transaction, so
  // two independently locked users would still be able to save each other's
  // tentative in-memory values. One short global tail protects that shared
  // snapshot; authorization and all emitted state remain strictly per-user.
  private tail: Promise<void> = Promise.resolve();

  async acquire(_userId: number): Promise<() => void> {
    const previous = this.tail;
    let finish!: () => void;
    const turn = new Promise<void>((resolve) => { finish = resolve; });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.tail = tail;
    await previous.catch(() => undefined);

    return () => {
      finish();
      if (this.tail === tail) this.tail = Promise.resolve();
    };
  }
}
